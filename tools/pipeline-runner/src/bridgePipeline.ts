import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveBridges,
  jawOf,
  MATERIAL_PRESETS,
  RESTORATION_ROLE,
  validateBridges,
  type CaseSetup,
  type ConnectorDesign,
  type QaCheck,
  type UnitKind,
} from '@dcad/shared';
import {
  analyzeSurface,
  archAlignedFrame,
  archFitDirections,
  bvhRayCaster,
  createBvh,
  designBridge,
  estimateToothFrame,
  fitArchCurve,
  initMeshBoolean,
  liveWireWeight,
  marginFromAnchors,
  prepRegion,
  prepSeedVertex,
  processScan,
  proposeMarginAnchors,
  searchCommonAxis,
  smoothVertexNormals,
  writeBinaryStl,
  type BridgeUnitInput,
  type ProcessedScan,
  type V3,
} from '@dcad/web/geometry';
import { caseCutback, frameworkChecks, type FrameworkMetrics } from './frameworkPipeline';
import type { GoldenCase } from './golden';
import {
  ADAPT_TOLERANCE_MM,
  distanceToClosedPolyline,
  mapStats,
  MAX_GAP_ERROR_MM,
  round,
  roundV,
  THICKNESS_TOLERANCE_MM,
  type RunOptions,
} from './pipeline';

export interface BridgeUnitMetrics {
  fdi: number;
  kind: UnitKind;
  /** alignedDeg: abutments only, the change of the mesial direction when aligned to the arch curve. */
  frame: { origin: V3; occlusal: V3; mesial: V3; buccal: V3; mesialContact?: V3; distalContact?: V3; alignedDeg?: number; warnings: string[] };
  /** Mesial neighbour in the bridge and dot(frame mesial, direction to it) (> 0 = FDI handedness holds). */
  handedness?: { toward: number; dot: number };
  margin?: {
    source: 'scripted' | 'auto';
    confidence?: number;
    lengthMm: number;
    points: number;
    closed: boolean;
    meanDeviationMm?: number;
    maxDeviationMm?: number;
  };
  layout?: { mdMm: number; span: [number, number]; cantilever: boolean };
  proposed: boolean;
  templateId: string;
  pose: { position: V3; scale: V3 };
  triangles: number;
  volumeMm3: number;
  watertight: boolean;
  printable: boolean;
  selfIntersections: number;
  minAxialThicknessMm: number;
  gap?: { samples: number; meanErrorMm: number; maxErrorMm: number };
  base?: { samples: number; minGapMm: number; meanGapMm: number; targetMm: number };
  thickness: { minMm: number; pushedVertices: number; maxPushMm: number };
  adapt?: unknown;
  maps: Record<string, { min: number; max: number; mean: number; count: number } | undefined>;
  warnings: string[];
}

export interface BridgeCaseMetrics {
  id: string;
  kind: 'bridge';
  teeth: number[];
  material: string;
  ok: boolean;
  timingsMs: Record<string, number>;
  scans: Record<string, { triangles: number; vertices: number; sha256: string; warnings: string[] }>;
  setup: { connections: Array<[number, number]>; warnings: string[] };
  curve: { kind: string; lengthMm: number; midlineS: number | null; rmsMm: number };
  axis: {
    direction: V3;
    angleFromCenterDeg: number;
    undercutAreaMm2: number;
    divergenceDeg: number;
    marginUndercutTotal: number;
    abutments: Array<{ fdi: number; individualAxis: V3; angleToCommonDeg: number; blockoutAreaMm2: number; marginUndercutCount: number }>;
    warnings: string[];
  };
  units: BridgeUnitMetrics[];
  connectors: Array<{
    between: [number, number];
    settings: ConnectorDesign;
    minAreaMm2: number;
    minHeightMm: number;
    designed: {
      areaMm2: number;
      heightMm: number;
      widthMm: number;
      availableHeightMm: number;
      centre: V3;
      lengthMm: number;
      /** Per end (between[0], between[1]): depth in the unit, and the signed clearance to its fitting surface. */
      sinkMm: [number, number];
      fitClearanceMm: [number, number];
    };
    measured?: { minAreaMm2: number; heightMm: number; widthMm: number; at: V3 };
    failures: string[];
  }>;
  union?: {
    triangles: number;
    vertices: number;
    volumeMm3: number;
    closed: boolean;
    printable: boolean;
    selfIntersections: number;
    components: number;
    genus: number;
  };
  seating: Array<{
    fdi: number;
    /** Gap samples on the union, and on the retainer alone (they must match). */
    samples: number;
    ownSamples: number;
    ownMeanMm: number;
    ownMaxMm: number;
    unionMeanMm: number;
    unionMaxMm: number;
    deltaMeanMm: number;
    deltaMaxMm: number;
  }>;
  ponticBase: Array<{ fdi: number; samples: number; minGapMm: number; meanGapMm: number; targetMm: number }>;
  /** Reduced units: framework, veneer space, shortfall, overpress and reassembly (frameworkPipeline.ts). */
  framework?: FrameworkMetrics;
  warnings: string[];
  checks: QaCheck[];
}

export interface BridgeCaseResult {
  metrics: BridgeCaseMetrics;
  /** Binary STL of the merged bridge (with reduced units: the framework bridge). */
  bridgeStl: Uint8Array;
  /** Reduced units with overpress: one binary STL each. */
  overpressStls?: Array<{ fdi: number; stl: Uint8Array }>;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The tooth next to `fdi` on its mesial side (the other central across the midline). */
const mesialNeighbour = (fdi: number): number => {
  const q = Math.floor(fdi / 10);
  if (fdi % 10 !== 1) return fdi - 1;
  return ({ 1: 21, 2: 11, 3: 41, 4: 31 } as Record<number, number>)[q]!;
};

/**
 * Run a bridge golden case headlessly: import → per abutment the tooth frame,
 * margin and prep region → common axis → designBridge (retainers, pontics
 * laid out on the arch, connectors, union) → the bridge checks, as QA checks.
 */
export async function runBridgeCase(spec: GoldenCase, baseDir: string, options: RunOptions = {}): Promise<BridgeCaseResult> {
  const bridgeSpec = spec.bridge;
  if (!bridgeSpec) throw new Error(`Case ${spec.id} is not a bridge case`);
  const timings: Record<string, number> = {};
  const time = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const out = await fn();
    timings[name] = round(performance.now() - t0, 1);
    return out;
  };

  const setup: CaseSetup = {
    patientRef: spec.id,
    notes: '',
    teeth: bridgeSpec.units.map((u) => ({ fdi: u.fdi, restoration: u.restoration, material: spec.material })),
    connections: bridgeSpec.connections,
  };
  const validation = validateBridges(setup);
  if (validation.errors.length) throw new Error(`Case ${spec.id}: ${validation.errors.map((e) => e.message).join('; ')}`);
  const bridges = deriveBridges(setup);
  if (bridges.length !== 1) throw new Error(`Case ${spec.id}: expected one bridge, found ${bridges.length}`);
  const bridge = bridges[0]!;
  const kindOf = (fdi: number): UnitKind => RESTORATION_ROLE[bridgeSpec.units.find((u) => u.fdi === fdi)!.restoration].role;

  const prepJaw = jawOf(bridge.teeth[0]!);
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
  const ray = bvhRayCaster(await time('bvh', () => createBvh({ positions, indices })));
  const analysis = await time('analyzeSurface', () => analyzeSurface({ positions, indices, normals }));
  const smoothNormals = await time('smoothNormals', () => smoothVertexNormals(normals, analysis.graph, 3));
  const antagonist = scans[antagonistJaw];
  const antagonistRay = antagonist ? bvhRayCaster(createBvh({ positions: antagonist.mesh.positions, indices: antagonist.mesh.indices })) : undefined;

  // Abutment frames from the clicks, then aligned to the arch curve (fit once for the jaw).
  const params = MATERIAL_PRESETS[spec.material];
  const estimates = await time('frames', () =>
    bridgeSpec.units
      .filter((u) => kindOf(u.fdi) === 'abutment')
      .map((u) => {
        if (!u.seed || !u.marginAnchors) throw new Error(`Case ${spec.id}: abutment ${u.fdi} needs a seed and margin anchors`);
        const frame = estimateToothFrame({
          jaw: { positions, normals },
          antagonist: antagonist ? { positions: antagonist.mesh.positions } : undefined,
          seed: u.seed,
          fdi: u.fdi,
          ray,
        });
        return { u, marginAnchors: u.marginAnchors, frame };
      }),
  );
  const curve = await time('archCurve', () => fitArchCurve({ positions, ...archFitDirections(estimates.map((e) => e.frame)) }));

  // Abutments: margin and prep region, as for a single crown.
  const abutments = await time('abutments', () =>
    estimates.map(({ u, marginAnchors, frame: estimate }) => {
        const aligned = archAlignedFrame({ frame: estimate, fdi: u.fdi, curve, ray });
        const frame = { ...aligned.frame, warnings: estimate.warnings };
        const auto = options.auto ? proposeMarginAnchors({ positions, indices, ray, frame }) : null;
        const trace = marginFromAnchors({
          positions,
          indices,
          graph: analysis.graph,
          weight: liveWireWeight(analysis.curvature),
          ray,
          anchors: auto ? auto.anchors : marginAnchors,
        });
        const seedVertex = prepSeedVertex({ positions, indices, ray, loopVertices: trace.loopVertices, occlusal: frame.occlusal });
        if (seedVertex === null) throw new Error(`Case ${spec.id}: could not find the ${u.fdi} prep top inside the margin`);
        const region = prepRegion({ positions, indices, graph: analysis.graph, loopVertices: trace.loopVertices, seedVertex });
        let meanDev: number | undefined, maxDev: number | undefined;
        if (u.marginRing) {
          const ring = new Float32Array(u.marginRing.flat());
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
        return { fdi: u.fdi, frame, alignedDeg: aligned.changeDeg, trace, region, auto, meanDev, maxDev };
      }),
  );

  const axis = await time('commonAxis', () =>
    searchCommonAxis({
      positions,
      indices,
      ray,
      abutments: abutments.map((a) => ({ fdi: a.fdi, faceMask: a.region.faceMask, margin: a.trace.points, occlusal: a.frame.occlusal })),
    }),
  );
  await time('initBooleans', () => initMeshBoolean());

  const contactTarget = { targetMm: params.proximalContactMm };
  const units: BridgeUnitInput[] = bridge.teeth.map((fdi) => {
    const a = abutments.find((x) => x.fdi === fdi);
    if (!a) {
      return { fdi, kind: kindOf(fdi), params, adapt: { occlusion: { clearanceMm: params.occlusalClearanceMm }, mesial: contactTarget, distal: contactTarget } };
    }
    return {
      fdi,
      kind: kindOf(fdi),
      params,
      frame: a.frame,
      margin: a.trace.points,
      region: { ...a.region, loopVertices: a.trace.loopVertices },
      adapt: {
        occlusion: { clearanceMm: params.occlusalClearanceMm },
        ...(a.frame.mesialContact ? { mesial: contactTarget } : {}),
        ...(a.frame.distalContact ? { distal: contactTarget } : {}),
      },
    };
  }).map((unit) => {
    const cutback = caseCutback(spec, bridgeSpec.units.find((u) => u.fdi === unit.fdi)!.restoration);
    return cutback ? { ...unit, cutback } : unit;
  });
  const result = await time('designBridge', () =>
    designBridge({
      jaw: { positions, indices, graph: analysis.graph, smoothNormals, ray },
      antagonist: antagonistRay,
      axis: axis.direction,
      units,
      connectors: bridge.connectors,
      material: spec.material,
      curve,
      maps: ['thickness', 'occlusion', 'proximal', 'unmillable'],
      union: true,
    }),
  );
  for (const [k, v] of Object.entries(result.timingsMs)) timings[`designBridge.${k}`] = round(v, 1);
  if (!result.union) throw new Error(`Case ${spec.id}: ${result.unionError ?? 'no union'}`);
  const union = result.union;
  const bridgeStl = await time('bridgeStl', () => writeBinaryStl(union.mesh));

  // Checks.
  const checks: QaCheck[] = [];
  const check = (id: string, passed: boolean, message: string, value?: number, threshold?: number) =>
    checks.push({ id, passed, message, ...(value !== undefined ? { value: round(value) } : {}), ...(threshold !== undefined ? { threshold } : {}) });

  const unitMetrics: BridgeUnitMetrics[] = result.units.map((r) => {
    const f = r.frame;
    const ortho = Math.max(Math.abs(dot(f.occlusal, f.mesial)), Math.abs(dot(f.occlusal, f.buccal)), Math.abs(dot(f.mesial, f.buccal)));
    check(`frame.orthonormal.${r.fdi}`, ortho < 1e-4, `${r.fdi}: frame axes are orthonormal`, ortho, 1e-4);
    const toward = mesialNeighbour(r.fdi);
    const neighbour = result.units.find((u) => u.fdi === toward);
    let handedness: BridgeUnitMetrics['handedness'];
    if (neighbour) {
      const d = dot(f.mesial, normalize(sub(neighbour.design.pose.position, r.design.pose.position)));
      handedness = { toward, dot: round(d) };
      check(`frame.handedness.${r.fdi}`, d > 0.5, `${r.fdi}: mesial points toward ${toward} (FDI handedness)`, d, 0.5);
    }
    const a = abutments.find((x) => x.fdi === r.fdi);
    const d = r.design;
    check(`unit.watertight.${r.fdi}`, d.validation.ok, `${r.fdi}: closed, consistently oriented solid with positive volume`);
    check(`unit.printable.${r.fdi}`, Boolean(d.validation.printable), `${r.fdi}: no self-intersections`, d.validation.selfIntersections, 0);
    if (a) {
      check(`margin.closed.${r.fdi}`, a.region.closed, `${r.fdi}: margin is closed on the surface`);
      if (a.auto) check(`margin.autoConfidence.${r.fdi}`, a.auto.confidence >= 0.75, `${r.fdi}: auto margin found the ridge on most profiles`, a.auto.confidence, 0.75);
      if (a.meanDev !== undefined && a.maxDev !== undefined) {
        check(`margin.meanDeviation.${r.fdi}`, a.meanDev <= spec.expect.maxMeanMarginDeviationMm, `${r.fdi}: mean distance to the reference margin`, a.meanDev, spec.expect.maxMeanMarginDeviationMm);
        check(`margin.maxDeviation.${r.fdi}`, a.maxDev <= spec.expect.maxMaxMarginDeviationMm, `${r.fdi}: max distance to the reference margin`, a.maxDev, spec.expect.maxMaxMarginDeviationMm);
      }
      check(`retainer.gap.${r.fdi}`, d.gapCheck.samples > 0 && d.gapCheck.maxErrorMm <= MAX_GAP_ERROR_MM, `${r.fdi}: max cement-gap error on the axial walls (mm)`, d.gapCheck.maxErrorMm, MAX_GAP_ERROR_MM);
      const minThickness = d.thickness.minMm;
      check(`retainer.thickness.${r.fdi}`, minThickness >= params.minThicknessMm - THICKNESS_TOLERANCE_MM, `${r.fdi}: minimum material thickness away from the margin (mm)`, minThickness, round(params.minThicknessMm - THICKNESS_TOLERANCE_MM));
    }
    const targets = { occlusion: params.occlusalClearanceMm, mesial: params.proximalContactMm, distal: params.proximalContactMm };
    for (const [kind, report] of Object.entries(d.adapt ?? {})) {
      if (!report) continue;
      const target = targets[kind as keyof typeof targets];
      const reached = report.minClearanceMm >= target - ADAPT_TOLERANCE_MM && !report.open;
      check(`unit.adapt.${kind}.${r.fdi}`, reached || Boolean(report.conflict), `${r.fdi}: adapted ${kind} clearance reaches the target or reports its conflict`, report.minClearanceMm, round(target - ADAPT_TOLERANCE_MM));
    }
    return {
      fdi: r.fdi,
      kind: r.kind,
      frame: {
        origin: roundV(f.origin),
        occlusal: roundV(f.occlusal),
        mesial: roundV(f.mesial),
        buccal: roundV(f.buccal),
        ...(f.mesialContact ? { mesialContact: roundV(f.mesialContact) } : {}),
        ...(f.distalContact ? { distalContact: roundV(f.distalContact) } : {}),
        ...(a ? { alignedDeg: round(a.alignedDeg, 2) } : {}),
        warnings: a ? a.frame.warnings : (r.layout?.warnings ?? []),
      },
      ...(handedness ? { handedness } : {}),
      ...(a
        ? {
            margin: {
              source: a.auto ? ('auto' as const) : ('scripted' as const),
              ...(a.auto ? { confidence: round(a.auto.confidence) } : {}),
              lengthMm: round(a.trace.lengthMm),
              points: a.trace.points.length / 3,
              closed: a.region.closed,
              ...(a.meanDev !== undefined ? { meanDeviationMm: round(a.meanDev) } : {}),
              ...(a.maxDev !== undefined ? { maxDeviationMm: round(a.maxDev) } : {}),
            },
          }
        : {}),
      ...(r.layout ? { layout: { mdMm: round(r.layout.mdMm), span: [round(r.layout.span[0]), round(r.layout.span[1])] as [number, number], cantilever: r.layout.cantilever } } : {}),
      proposed: r.proposed,
      templateId: d.templateId,
      pose: { position: roundV(d.pose.position), scale: roundV(d.pose.scale) },
      triangles: d.validation.triangles,
      volumeMm3: round(d.validation.signedVolumeMm3, 2),
      watertight: d.validation.ok,
      printable: Boolean(d.validation.printable),
      selfIntersections: d.validation.selfIntersections,
      minAxialThicknessMm: round(d.minAxialThicknessMm),
      ...(r.kind === 'abutment' ? { gap: { samples: d.gapCheck.samples, meanErrorMm: round(d.gapCheck.meanErrorMm, 5), maxErrorMm: round(d.gapCheck.maxErrorMm, 5) } } : {}),
      ...(d.base ? { base: { samples: d.base.samples, minGapMm: round(d.base.minGapMm, 5), meanGapMm: round(d.base.meanGapMm, 5), targetMm: d.base.targetMm } } : {}),
      thickness: { minMm: round(d.thickness.minMm), pushedVertices: d.thickness.pushedVertices, maxPushMm: round(d.thickness.maxPushMm) },
      adapt: d.adapt,
      maps: Object.fromEntries(Object.entries(d.maps ?? {}).map(([name, values]) => [name, mapStats(values as Float32Array)])),
      warnings: d.warnings,
    };
  });

  check('axis.marginUndercut', axis.marginUndercutTotal === 0, 'Margin points in an undercut for the common axis (all abutments)', axis.marginUndercutTotal, 0);
  const u = union.checks.union;
  check('union.watertight', u.closed && u.oriented && u.degenerateTriangles === 0, 'The merged bridge is a closed, consistently oriented solid');
  check('union.printable', u.printable, 'The merged bridge has no self-intersections', u.selfIntersections, 0);
  check('union.oneSolid', u.components === 1 && u.genus === 0, 'The merged bridge is one connected solid of genus 0', u.components, 1);
  for (const c of union.checks.connectors) {
    const label = `${c.between[0]}-${c.between[1]}`;
    check(`connector.area.${label}`, c.areaOk && c.targetAreaMm2 >= c.minAreaMm2, `Connector ${label}: smallest measured section ≥ the designed area (mm²)`, c.measured.minAreaMm2, c.targetAreaMm2);
    check(`connector.height.${label}`, c.heightOk, `Connector ${label}: height ≥ the minimum (mm)`, Math.min(c.measured.heightMm, c.designedHeightMm), c.minHeightMm);
    check(`connector.design.${label}`, c.failures.length === 0, c.failures.length ? c.failures.map((f) => f.message).join(' ') : `Connector ${label}: fits the embrasures and the units`);
  }
  for (const s of union.checks.seating) {
    check(`seating.${s.fdi}`, s.ok, `Retainer ${s.fdi}: seating unchanged in the union (max change, mm)`, Math.max(s.deltaMeanMm, s.deltaMaxMm), 0.005);
  }
  for (const p of union.checks.ponticBase) {
    check(`ponticBase.${p.fdi}`, p.ok, `Pontic ${p.fdi}: smallest base gap to the ridge, within the target −0.02/+0.05 mm (mm)`, p.minGapMm, round(p.targetMm - 0.02));
  }
  const framework = await time('framework', () => frameworkChecks(result, check));

  const metrics: BridgeCaseMetrics = {
    id: spec.id,
    kind: 'bridge',
    teeth: bridge.teeth,
    material: spec.material,
    ok: checks.every((c) => c.passed),
    timingsMs: timings,
    scans: Object.fromEntries(
      Object.entries(scans).map(([role, s]) => [role, { triangles: s.stats.triangles, vertices: s.stats.vertices, sha256: s.sha256, warnings: s.warnings }]),
    ),
    setup: { connections: setup.connections, warnings: validation.warnings.map((w) => w.message) },
    curve: { kind: result.curve.kind, lengthMm: round(result.curve.lengthMm), midlineS: result.curve.midlineS === null ? null : round(result.curve.midlineS), rmsMm: round(result.curve.rmsMm) },
    axis: {
      direction: roundV(axis.direction),
      angleFromCenterDeg: round(axis.angleFromCenterDeg, 2),
      undercutAreaMm2: round(axis.undercutAreaMm2),
      divergenceDeg: round(axis.divergenceDeg, 2),
      marginUndercutTotal: axis.marginUndercutTotal,
      abutments: axis.abutments.map((a) => ({
        fdi: a.fdi,
        individualAxis: roundV(a.individualAxis),
        angleToCommonDeg: round(a.angleToCommonDeg, 2),
        blockoutAreaMm2: round(a.blockoutAreaMm2),
        marginUndercutCount: a.marginUndercutCount,
      })),
      warnings: axis.warnings,
    },
    units: unitMetrics,
    connectors: result.connectors.map((c) => {
      const measured = union.checks.connectors.find((m) => m.between[0] === c.between[0] && m.between[1] === c.between[1])?.measured;
      return {
        between: c.between,
        settings: c.settings,
        minAreaMm2: c.minAreaMm2,
        minHeightMm: c.minHeightMm,
        designed: {
          areaMm2: c.areaMm2,
          heightMm: round(c.heightMm),
          widthMm: round(c.widthMm),
          availableHeightMm: round(c.available.heightMm),
          centre: roundV(c.centre),
          lengthMm: round(c.span[1] - c.span[0]),
          sinkMm: [round(c.ends[0].sinkMm), round(c.ends[1].sinkMm)] as [number, number],
          fitClearanceMm: [round(c.ends[0].fitClearanceMm), round(c.ends[1].fitClearanceMm)] as [number, number],
        },
        ...(measured ? { measured: { minAreaMm2: round(measured.minAreaMm2), heightMm: round(measured.heightMm), widthMm: round(measured.widthMm), at: roundV(measured.at) } } : {}),
        failures: c.failures.map((f) => f.message),
      };
    }),
    union: {
      triangles: u.triangles,
      vertices: u.vertices,
      volumeMm3: round(u.volumeMm3, 2),
      closed: u.closed,
      printable: u.printable,
      selfIntersections: u.selfIntersections,
      components: u.components,
      genus: u.genus,
    },
    seating: union.checks.seating.map((s) => ({
      fdi: s.fdi,
      samples: s.onUnion.samples,
      ownSamples: s.own.samples,
      ownMeanMm: round(s.own.meanErrorMm, 5),
      ownMaxMm: round(s.own.maxErrorMm, 5),
      unionMeanMm: round(s.onUnion.meanErrorMm, 5),
      unionMaxMm: round(s.onUnion.maxErrorMm, 5),
      deltaMeanMm: round(s.deltaMeanMm, 6),
      deltaMaxMm: round(s.deltaMaxMm, 6),
    })),
    ponticBase: union.checks.ponticBase.map((p) => ({ fdi: p.fdi, samples: p.samples, minGapMm: round(p.minGapMm, 5), meanGapMm: round(p.meanGapMm, 5), targetMm: p.targetMm })),
    ...(framework ? { framework: framework.metrics } : {}),
    warnings: result.warnings,
    checks,
  };
  return { metrics, bridgeStl, ...(framework ? { overpressStls: framework.overpressStls } : {}) };
}
