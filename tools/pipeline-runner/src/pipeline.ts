import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jawOf, MATERIAL_PRESETS, type QaCheck } from '@dcad/shared';
import {
  analyzeSurface,
  bvhRayCaster,
  createBvh,
  designCrown,
  estimateToothFrame,
  liveWireWeight,
  marginFromAnchors,
  proposeMarginAnchors,
  marginUndercut,
  prepRegion,
  prepSeedVertex,
  processScan,
  searchInsertionAxis,
  smoothVertexNormals,
  undercutDepths,
  writeBinaryStl,
  type ProcessedScan,
  type V3,
} from '@dcad/web/geometry';
import type { GoldenCase } from './golden';

export interface CaseMetrics {
  id: string;
  fdi: number;
  ok: boolean;
  timingsMs: Record<string, number>;
  scans: Record<string, { triangles: number; vertices: number; sha256: string; warnings: string[] }>;
  frame: {
    origin: V3;
    occlusal: V3;
    mesial: V3;
    buccal: V3;
    warnings: string[];
  };
  contacts: {
    mesial?: { point: V3; distanceMm: number };
    distal?: { point: V3; distanceMm: number };
  };
  margin: {
    /** 'scripted' = the case's anchors; 'auto' = classical.margin-ridge. */
    source: 'scripted' | 'auto';
    /** Auto mode: fraction of radial profiles that found the ridge. */
    confidence?: number;
    anchors: V3[];
    lengthMm: number;
    points: number;
    closed: boolean;
    meanDeviationMm?: number;
    maxDeviationMm?: number;
  };
  prepRegion: { vertices: number; faces: number };
  axis: {
    direction: V3;
    angleFromOcclusalDeg: number;
    undercutAreaMm2: number;
    occlusalUndercutAreaMm2: number;
    maxBlockoutDepthMm: number;
  };
  marginUndercutCount: number;
  crown: {
    templateId: string;
    triangles: number;
    volumeMm3: number;
    watertight: boolean;
    minAxialThicknessMm: number;
    gap: { samples: number; meanErrorMm: number; maxErrorMm: number };
    scale: V3;
    thickness?: { minMm: number; pushedVertices: number; maxPushMm: number };
    selfIntersections?: number;
    adapt?: unknown;
    maps: Record<string, { min: number; max: number; mean: number; count: number } | undefined>;
    warnings: string[];
  };
  checks: QaCheck[];
}

export interface CaseResult {
  metrics: CaseMetrics;
  /** Binary STL of the crown. */
  crownStl: Uint8Array;
}

/** Gap accuracy required on the axial walls (spec: ±0.01 mm). */
export const MAX_GAP_ERROR_MM = 0.01;
/** Adaptation may undershoot its clearance target by this much. */
export const ADAPT_TOLERANCE_MM = 0.02;
/** Thickness enforcement may undershoot the profile by this much. */
export const THICKNESS_TOLERANCE_MM = 0.02;

/** min / max / mean of the finite values of a per-vertex map. */
export function mapStats(values: Float32Array | undefined): { min: number; max: number; mean: number; count: number } | undefined {
  if (!values) return undefined;
  let min = Infinity, max = -Infinity, sum = 0, count = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    count++;
  }
  return count ? { min: round(min), max: round(max), mean: round(sum / count), count } : { min: NaN, max: NaN, mean: NaN, count: 0 };
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const round = (n: number, digits = 4) => Number(n.toFixed(digits));
export const roundV = (v: V3): V3 => [round(v[0]), round(v[1]), round(v[2])];

/** Distance from p to a closed polyline (packed xyz). */
export function distanceToClosedPolyline(p: V3, poly: Float32Array): number {
  const n = poly.length / 3;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a: V3 = [poly[i * 3]!, poly[i * 3 + 1]!, poly[i * 3 + 2]!];
    const ab = sub([poly[j * 3]!, poly[j * 3 + 1]!, poly[j * 3 + 2]!], a);
    const ap = sub(p, a);
    const len2 = dot(ab, ab);
    const t = len2 > 0 ? Math.min(1, Math.max(0, dot(ap, ab) / len2)) : 0;
    best = Math.min(best, Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]));
  }
  return best;
}

/**
 * Run the Day 2 pipeline headlessly on a golden case: import → tooth frame
 * → margin from the scripted anchors → prep region → insertion axis →
 * undercut map, then evaluate QA checks. `baseDir` holds the scan files.
 */
export interface RunOptions {
  /**
   * Auto mode: the margin comes from the classical.margin-ridge proposer
   * (radial-profile anchors + live-wire) instead of the case's scripted
   * anchors. Checks are the same (deviation vs expect.marginRing) plus the
   * proposer's ridge confidence.
   */
  auto?: boolean;
}

export async function runCase(spec: GoldenCase, baseDir: string, options: RunOptions = {}): Promise<CaseResult> {
  const timings: Record<string, number> = {};
  const time = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const out = await fn();
    timings[name] = round(performance.now() - t0, 1);
    return out;
  };

  const prepJaw = jawOf(spec.fdi);
  const antagonistJaw = prepJaw === 'lower' ? 'upper' : 'lower';
  const scans: Partial<Record<'upper' | 'lower', ProcessedScan>> = {};
  for (const role of ['upper', 'lower'] as const) {
    const file = spec.scans[role];
    if (!file) continue;
    scans[role] = await time(`import.${role}`, () => processScan(new Uint8Array(readFileSync(join(baseDir, file))), file));
  }
  const prep = scans[prepJaw];
  if (!prep) throw new Error(`Case ${spec.id}: the prep jaw (${prepJaw}) scan is missing`);
  const { positions, normals } = prep.mesh;
  const indices = prep.mesh.indices; // reordered in place by the BVH build; canonical afterwards
  const bvh = await time('bvh', () => createBvh({ positions, indices }));
  const ray = bvhRayCaster(bvh);
  const analysis = await time('analyzeSurface', () => analyzeSurface({ positions, indices, normals }));

  const frame = await time('frame', () =>
    estimateToothFrame({
      jaw: { positions, normals },
      antagonist: scans[antagonistJaw] ? { positions: scans[antagonistJaw].mesh.positions } : undefined,
      seed: spec.seed,
      fdi: spec.fdi,
      ray,
    }),
  );

  const autoAnchors = options.auto ? await time('autoMarginAnchors', () => proposeMarginAnchors({ positions, indices, ray, frame })) : null;
  const trace = await time('margin', () =>
    marginFromAnchors({
      positions,
      indices,
      graph: analysis.graph,
      weight: liveWireWeight(analysis.curvature),
      ray,
      anchors: autoAnchors ? autoAnchors.anchors : spec.marginAnchors,
    }),
  );

  const region = await time('prepRegion', () => {
    const seedVertex = prepSeedVertex({ positions, indices, ray, loopVertices: trace.loopVertices, occlusal: frame.occlusal });
    if (seedVertex === null) throw new Error(`Case ${spec.id}: could not find the prep top inside the margin`);
    return prepRegion({ positions, indices, graph: analysis.graph, loopVertices: trace.loopVertices, seedVertex });
  });

  const axis = await time('axisSearch', () =>
    searchInsertionAxis({ positions, indices, faceMask: region.faceMask, center: frame.occlusal }),
  );
  const depths = await time('undercutMap', () =>
    undercutDepths({ positions, indices, vertexMask: region.vertexMask, faceMask: region.faceMask, axis: axis.direction, ray }),
  );
  let maxDepth = 0;
  for (const d of depths) if (d > maxDepth) maxDepth = d;
  const marginUc = await time('marginUndercut', () =>
    marginUndercut({ points: trace.points, axis: axis.direction, ray, faceMask: region.faceMask }),
  );

  const antagonist = scans[antagonistJaw];
  const antagonistRay = antagonist
    ? bvhRayCaster(createBvh({ positions: antagonist.mesh.positions, indices: antagonist.mesh.indices }))
    : undefined;
  const crown = await time('crown', () =>
    designCrown({
      fdi: spec.fdi,
      jaw: { positions, indices, graph: analysis.graph, smoothNormals: smoothVertexNormals(normals, analysis.graph, 3), ray },
      antagonist: antagonistRay,
      region: { ...region, loopVertices: trace.loopVertices },
      frame,
      margin: trace.points,
      axis: axis.direction,
      params: MATERIAL_PRESETS[spec.material],
      maps: ['thickness', 'occlusion', 'proximal', 'unmillable'],
      adapt: {
        occlusion: { clearanceMm: MATERIAL_PRESETS[spec.material].occlusalClearanceMm },
        ...(frame.mesialContact ? { mesial: { targetMm: MATERIAL_PRESETS[spec.material].proximalContactMm } } : {}),
        ...(frame.distalContact ? { distal: { targetMm: MATERIAL_PRESETS[spec.material].proximalContactMm } } : {}),
      },
    }),
  );
  const crownStl = await time('crownStl', () => writeBinaryStl(crown.mesh));

  // Margin deviation against the reference ring, if any.
  let meanDev: number | undefined;
  let maxDev: number | undefined;
  if (spec.expect.marginRing) {
    const ring = new Float32Array(spec.expect.marginRing.flat());
    let sum = 0;
    let max = 0;
    const n = trace.points.length / 3;
    for (let i = 0; i < n; i++) {
      const d = distanceToClosedPolyline([trace.points[i * 3]!, trace.points[i * 3 + 1]!, trace.points[i * 3 + 2]!], ring);
      sum += d;
      max = Math.max(max, d);
    }
    meanDev = sum / n;
    maxDev = max;
  }

  const checks: QaCheck[] = [];
  const check = (id: string, passed: boolean, message: string, value?: number, threshold?: number) =>
    checks.push({ id, passed, message, ...(value !== undefined ? { value: round(value) } : {}), ...(threshold !== undefined ? { threshold } : {}) });

  const ortho = Math.max(Math.abs(dot(frame.occlusal, frame.mesial)), Math.abs(dot(frame.occlusal, frame.buccal)), Math.abs(dot(frame.mesial, frame.buccal)));
  check('frame.orthonormal', ortho < 1e-4, 'Tooth frame axes are orthonormal', ortho, 1e-4);
  if (spec.expect.occlusal) {
    const d = dot(frame.occlusal, normalize(spec.expect.occlusal));
    check('frame.occlusal', d >= spec.expect.minOcclusalDot, 'Occlusal direction matches the expected one', d, spec.expect.minOcclusalDot);
  }
  if (spec.expect.contacts) {
    for (const side of ['mesial', 'distal'] as const) {
      const found = Boolean(side === 'mesial' ? frame.mesialContact : frame.distalContact);
      check(`contacts.${side}`, found === spec.expect.contacts[side], `${side} contact ${spec.expect.contacts[side] ? 'found' : 'absent'}`);
    }
  }
  if (autoAnchors) {
    check('margin.autoConfidence', autoAnchors.confidence >= 0.75, 'Auto margin: the ridge was found on most radial profiles', autoAnchors.confidence, 0.75);
  }
  check('margin.closed', region.closed, 'Margin is closed on the surface (prep region does not leak)');
  check('margin.length', trace.lengthMm > 8 && trace.lengthMm < 60, 'Margin length is plausible for a posterior tooth (8–60 mm)', trace.lengthMm);
  if (meanDev !== undefined && maxDev !== undefined) {
    check('margin.meanDeviation', meanDev <= spec.expect.maxMeanMarginDeviationMm, 'Mean distance to the reference margin', meanDev, spec.expect.maxMeanMarginDeviationMm);
    check('margin.maxDeviation', maxDev <= spec.expect.maxMaxMarginDeviationMm, 'Max distance to the reference margin', maxDev, spec.expect.maxMaxMarginDeviationMm);
  }
  if (spec.expect.maxAxisAngleDeg !== undefined) {
    check('axis.angle', axis.angleFromCenterDeg <= spec.expect.maxAxisAngleDeg, 'Insertion axis angle from occlusal', axis.angleFromCenterDeg, spec.expect.maxAxisAngleDeg);
  }
  if (spec.expect.maxUndercutAreaMm2 !== undefined) {
    check('axis.undercutArea', axis.undercutAreaMm2 <= spec.expect.maxUndercutAreaMm2, 'Projected undercut area at the chosen axis (mm²)', axis.undercutAreaMm2, spec.expect.maxUndercutAreaMm2);
  }
  check(
    'margin.undercut',
    marginUc.count <= spec.expect.maxMarginUndercutPoints,
    'Margin points in an undercut for the chosen axis',
    marginUc.count,
    spec.expect.maxMarginUndercutPoints,
  );

  check('crown.watertight', crown.validation.ok, 'Crown is a closed, consistently oriented solid with positive volume');
  check('crown.gap', crown.gapCheck.samples > 0 && crown.gapCheck.maxErrorMm <= MAX_GAP_ERROR_MM, 'Max cement-gap error on the axial walls (mm)', crown.gapCheck.maxErrorMm, MAX_GAP_ERROR_MM);
  const params = MATERIAL_PRESETS[spec.material];
  check('crown.printable', Boolean(crown.validation.printable), 'Crown has no self-intersections', crown.validation.selfIntersections, 0);
  const targets = { occlusion: params.occlusalClearanceMm, mesial: params.proximalContactMm, distal: params.proximalContactMm };
  for (const [kind, report] of Object.entries(crown.adapt ?? {})) {
    if (!report) continue;
    const target = targets[kind as keyof typeof targets];
    const reached = report.minClearanceMm >= target - ADAPT_TOLERANCE_MM && !report.open;
    check(
      `crown.adapt.${kind}`,
      reached || Boolean(report.conflict),
      reached
        ? `Adapted ${kind} clearance reaches the target`
        : report.open
          ? `Adapted ${kind}: still open after adaptation`
          : `Adapted ${kind}: target not reached, conflict reported (${report.conflict?.kind})`,
      report.minClearanceMm,
      round(target - ADAPT_TOLERANCE_MM),
    );
  }
  const minThickness = crown.thickness?.minMm ?? crown.minAxialThicknessMm;
  check(
    'crown.thickness',
    minThickness >= params.minThicknessMm - THICKNESS_TOLERANCE_MM,
    'Minimum material thickness away from the margin band (mm)',
    minThickness,
    round(params.minThicknessMm - THICKNESS_TOLERANCE_MM),
  );

  const anglesFromOcclusal = (Math.acos(Math.min(1, dot(axis.direction, frame.occlusal))) * 180) / Math.PI;
  const metrics: CaseMetrics = {
    id: spec.id,
    fdi: spec.fdi,
    ok: checks.every((c) => c.passed),
    timingsMs: timings,
    scans: Object.fromEntries(
      Object.entries(scans).map(([role, s]) => [
        role,
        { triangles: s.stats.triangles, vertices: s.stats.vertices, sha256: s.sha256, warnings: s.warnings },
      ]),
    ),
    frame: {
      origin: roundV(frame.origin),
      occlusal: roundV(frame.occlusal),
      mesial: roundV(frame.mesial),
      buccal: roundV(frame.buccal),
      warnings: frame.warnings,
    },
    contacts: {
      ...(frame.mesialContact
        ? { mesial: { point: roundV(frame.mesialContact), distanceMm: round(dot(sub(frame.mesialContact, frame.origin), frame.mesial)) } }
        : {}),
      ...(frame.distalContact
        ? { distal: { point: roundV(frame.distalContact), distanceMm: round(-dot(sub(frame.distalContact, frame.origin), frame.mesial)) } }
        : {}),
    },
    margin: {
      source: autoAnchors ? 'auto' : 'scripted',
      ...(autoAnchors ? { confidence: round(autoAnchors.confidence) } : {}),
      anchors: trace.anchorVertices.map((v) => roundV([positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!])),
      lengthMm: round(trace.lengthMm),
      points: trace.points.length / 3,
      closed: region.closed,
      ...(meanDev !== undefined ? { meanDeviationMm: round(meanDev) } : {}),
      ...(maxDev !== undefined ? { maxDeviationMm: round(maxDev) } : {}),
    },
    prepRegion: { vertices: region.vertexCount, faces: region.faceCount },
    axis: {
      direction: roundV(axis.direction),
      angleFromOcclusalDeg: round(anglesFromOcclusal, 2),
      undercutAreaMm2: round(axis.undercutAreaMm2),
      occlusalUndercutAreaMm2: round(axis.centerUndercutAreaMm2),
      maxBlockoutDepthMm: round(maxDepth),
    },
    marginUndercutCount: marginUc.count,
    crown: {
      templateId: crown.templateId,
      triangles: crown.validation.triangles,
      volumeMm3: round(crown.validation.signedVolumeMm3, 2),
      watertight: crown.validation.ok,
      minAxialThicknessMm: round(crown.minAxialThicknessMm),
      gap: { samples: crown.gapCheck.samples, meanErrorMm: round(crown.gapCheck.meanErrorMm, 5), maxErrorMm: round(crown.gapCheck.maxErrorMm, 5) },
      scale: roundV(crown.pose.scale),
      thickness: crown.thickness && {
        minMm: round(crown.thickness.minMm),
        pushedVertices: crown.thickness.pushedVertices,
        maxPushMm: round(crown.thickness.maxPushMm),
      },
      selfIntersections: crown.validation.selfIntersections,
      adapt: crown.adapt,
      maps: Object.fromEntries(Object.entries(crown.maps ?? {}).map(([name, values]) => [name, mapStats(values as Float32Array)])),
      warnings: crown.warnings,
    },
    checks,
  };
  return { metrics, crownStl };
}
