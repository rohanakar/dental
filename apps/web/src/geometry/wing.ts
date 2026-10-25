import { ADAPT_TOLERANCE_MM, adaptToTarget, clearanceAlong, type AdaptReport } from './adapt';
import { searchInsertionAxis, type AxisSearchResult } from './axis';
import { clearanceMap } from './crownMaps';
import type { IndexedMesh } from './mesh';
import { computeVertexNormals } from './normals';
import type { V3 } from './pca';
import {
  fittingSurfaceOf,
  measurePatchGap,
  offsetOuter,
  patchRetainer,
  validatePatchSolid,
  type FittingPatch,
  type PatchGapCheck,
  type PatchJaw,
  type PatchRegionInput,
  type PatchValidation,
} from './patchRetainer';
import type { RayCaster } from './raycast';
import type { SurfaceGraph } from './surface';
import { enforceThickness, signedIntaglioDistance, THICKNESS_RAMP_MM } from './thickness';

/**
 * Resin-bonded (Maryland) wing retainer: the surface-patch retainer with a
 * uniform resin-cement gap and an outer surface offset by the wing thickness,
 * feathered to the edge thickness within WING_EDGE_RAMP_MM of the outline.
 * Checks: antagonist space along the insertion axis (thinning toward the
 * minimum, then "insufficient space for the wing"), bonded and blocked-out
 * area, thickness and seating.
 *
 * Local types: the `maryland-wing` restoration type and the wing parameters
 * land in the shared schemas in phase B (DesignParams.wingThicknessMm and
 * wingEdgeThicknessMm).
 */

/** Width of the edge ramp (mm from the outline): the same 1 mm ramp as the crown's thickness profile. */
export const WING_EDGE_RAMP_MM = THICKNESS_RAMP_MM;

export interface WingParams {
  /** Target wing thickness (Kern: 0.7 mm). */
  wingThicknessMm: number;
  /** Thickness at the outline (feathered edge). */
  wingEdgeThicknessMm: number;
  /**
   * The wing is never thinned below this (Kern: 0.5 mm) to make room for the antagonist. Within the edge ramp the
   * floor ramps the same way (thicknessProfile from the edge thickness to this minimum).
   */
  wingMinThicknessMm: number;
  /** Uniform resin-cement gap (no spacer ramp). */
  cementGapMm: number;
  /** Clearance to the antagonist along the insertion axis. */
  occlusalClearanceMm: number;
}

/** Spec defaults (placeholders until domain QA); occlusal clearance as the zirconia preset. */
export const WING_DEFAULTS: WingParams = {
  wingThicknessMm: 0.7,
  wingEdgeThicknessMm: 0.2,
  wingMinThicknessMm: 0.5,
  cementGapMm: 0.03,
  occlusalClearanceMm: 0.05,
};

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const pointAt = (a: Float32Array, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];

/** Wing thickness at distance d from the outline: edge thickness → full thickness within the edge ramp. */
export function wingThicknessProfile(d: number, p: Pick<WingParams, 'wingThicknessMm' | 'wingEdgeThicknessMm'>): number {
  return p.wingEdgeThicknessMm + (p.wingThicknessMm - p.wingEdgeThicknessMm) * smoothstep(0, WING_EDGE_RAMP_MM, d);
}

/** Laplacian passes over a per-vertex scalar, holding `fixed` vertices. */
function smoothField(values: Float32Array, graph: SurfaceGraph, fixed: Uint8Array, passes: number): Float32Array {
  let src = values;
  for (let pass = 0; pass < passes; pass++) {
    const dst = src.slice();
    for (let i = 0; i < src.length; i++) {
      if (fixed[i]) continue;
      const s = graph.offsets[i]!, e = graph.offsets[i + 1]!;
      if (e === s) continue;
      let sum = 0;
      for (let k = s; k < e; k++) sum += src[graph.neighbors[k]!]!;
      dst[i] = 0.5 * src[i]! + (0.5 * sum) / (e - s);
    }
    src = dst;
  }
  return src;
}

/**
 * Wing thickness per patch vertex: the profile over the geodesic distance to
 * the outline, smoothed first (Dijkstra distances kink where the nearest
 * outline point switches), so the offset surface stays fair. Beyond the ramp
 * the thickness is exactly wingThicknessMm.
 */
export function wingThicknessField(patch: FittingPatch, p: Pick<WingParams, 'wingThicknessMm' | 'wingEdgeThicknessMm'>, smoothingPasses = 3): Float32Array {
  const n = patch.distance.length;
  // The outline and everything beyond the ramp keep their distance: only the ramp is smoothed.
  const fixed = new Uint8Array(n);
  for (const v of patch.boundary) fixed[v] = 1;
  for (let i = 0; i < n; i++) if (patch.distance[i]! >= WING_EDGE_RAMP_MM) fixed[i] = 1;
  const d = smoothField(patch.distance, patch.graph, fixed, smoothingPasses);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = wingThicknessProfile(d[i]!, p);
  return out;
}

/** Insertion axis for wings: the least-undercut search over the union of the wing regions (one region, or all wings of a bridge). */
export function wingInsertionAxis(input: {
  positions: Float32Array;
  indices: Uint32Array;
  /** Face masks of the wing regions (BVH-ordered face ids), OR-ed together for a common axis. */
  faceMasks: Uint8Array[];
  /** Cone centre: the occlusal direction (or the mean over the abutments). */
  occlusal: V3;
  coneDeg?: number;
}): AxisSearchResult {
  const faceMask = new Uint8Array(input.indices.length / 3);
  for (const m of input.faceMasks) for (let f = 0; f < faceMask.length; f++) if (m[f]) faceMask[f] = 1;
  return searchInsertionAxis({ positions: input.positions, indices: input.indices, faceMask, center: input.occlusal, coneDeg: input.coneDeg });
}

export interface WingSpaceConflict {
  kind: 'insufficient space for the wing';
  /** Outer vertices still closer to the antagonist than the target (minus tolerance) with the wing at its minimum. */
  vertices: number;
  areaMm2: number;
  minClearanceMm: number;
  /** Centroid of the conflicting vertices. */
  at: V3;
}

export interface WingSpaceReport {
  targetMm: number;
  /** Smallest clearance along the axis over the outer vertices facing the antagonist, before thinning (Infinity = nothing within reach). */
  minClearanceBeforeMm: number;
  /** After thinning and the minimum-thickness floor. */
  minClearanceMm: number;
  /** Local thinning toward the minimum, when the target was not met at full thickness. */
  thinning?: {
    adapt: AdaptReport;
    /** Outer vertices whose thickness dropped by more than 0.01 mm. */
    vertices: number;
    areaMm2: number;
    /** Largest thickness reduction. */
    maxMm: number;
    /** Vertices pushed back out to the floor. */
    floorPushedVertices: number;
  };
  conflict?: WingSpaceConflict;
}

export interface WingThicknessStats {
  /** Outer vertices at least WING_EDGE_RAMP_MM from the outline (geodesic, on the tooth). */
  samples: number;
  minMm: number;
  maxMm: number;
  meanMm: number;
  /** Smallest thickness inside the edge ramp (for information; the ramp feathers to the edge thickness). */
  rampMinMm: number;
}

export interface WingDesign {
  /** Closed wing: fitting [0, outerStart), outer [outerStart, 2·outerStart), band. */
  mesh: IndexedMesh;
  patch: FittingPatch;
  outerStart: number;
  validation: PatchValidation;
  params: WingParams;
  /** Bonded area = patch area − blocked-out area. */
  area: { patchMm2: number; bondedMm2: number; blockedOutMm2: number; blockedOutFraction: number };
  thickness: WingThicknessStats;
  /** Measured thickness per outer vertex (index i = outer vertex outerStart + i); NaN beyond reach. */
  thicknessMm: Float32Array;
  gapCheck: PatchGapCheck;
  space?: WingSpaceReport;
  /** Per-vertex scalars over the whole mesh (NaN where not applicable), when maps is set. */
  maps?: { thickness: Float32Array; occlusion?: Float32Array };
  warnings: string[];
  timingsMs: Record<string, number>;
}

export interface WingInput {
  jaw: PatchJaw;
  /** Region inside the wing outline (prepRegion from the frame click) plus the outline loop. */
  region: PatchRegionInput;
  /** Insertion axis (common to the bridge), pointing toward the antagonist. */
  axis: V3;
  antagonist?: RayCaster;
  params?: Partial<WingParams>;
  /** Compute the thickness and occlusion maps. */
  maps?: boolean;
}

/** Signed clearance along the axis for each outer vertex facing the antagonist (NaN otherwise or beyond maxMm). */
function axialClearances(positions: Float32Array, normals: Float32Array, start: number, n: number, axis: V3, target: RayCaster, maxMm: number): Float32Array {
  const out = new Float32Array(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    if (dot(pointAt(normals, start + i), axis) <= 0) continue;
    out[i] = clearanceAlong(pointAt(positions, start + i), axis, target, undefined, maxMm);
  }
  return out;
}

/**
 * Design a Maryland wing on the tooth surface inside the outline: fitting
 * surface (uniform cement gap, blockout), outer surface at the wing
 * thickness, band; then the antagonist space check with local thinning
 * toward the minimum, measurements and validation.
 */
export function designWing(input: WingInput): WingDesign {
  const params: WingParams = { ...WING_DEFAULTS, ...input.params };
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = now - t;
    t = now;
  };
  const retainer = patchRetainer({
    jaw: input.jaw,
    region: input.region,
    axis: input.axis,
    gap: () => params.cementGapMm,
    outer: (patch) => ({ positions: offsetOuter(patch, wingThicknessField(patch, params)) }),
    validate: false,
  });
  Object.assign(timings, retainer.timingsMs);
  lap('retainer');
  const { mesh, patch, outerStart: n, fittingFaces } = retainer;
  const axis = patch.axis;
  const warnings = [...retainer.warnings];
  const fixed = new Uint8Array(n);
  for (const v of patch.boundary) fixed[v] = 1;
  const fitting = fittingSurfaceOf(mesh, n, fittingFaces);
  const measureThickness = () => {
    const out = new Float32Array(n).fill(Number.NaN);
    for (let i = 0; i < n; i++) {
      const s = signedIntaglioDistance(pointAt(mesh.positions, n + i), fitting, params.wingThicknessMm + 2);
      if (s) out[i] = s.distance;
    }
    return out;
  };
  const thicknessBefore = measureThickness();
  lap('thickness');

  // Antagonist space: clearance along the axis; thin toward the minimum where it is short, then report what is left.
  let space: WingSpaceReport | undefined;
  let thicknessMm = thicknessBefore;
  if (input.antagonist) {
    const target = params.occlusalClearanceMm;
    const reach = Math.max(5, target + 3);
    const normals = computeVertexNormals(mesh);
    // The edge (band) vertices are measured too; they are never moved.
    const before = axialClearances(mesh.positions, normals, n, n, axis, input.antagonist, reach);
    let minBefore = Infinity;
    for (const c of before) if (!Number.isNaN(c)) minBefore = Math.min(minBefore, c);
    space = { targetMm: target, minClearanceBeforeMm: minBefore, minClearanceMm: minBefore };
    if (minBefore < target) {
      // Reduce along −axis (the crown's occlusal adaptation, without the lift into contact), then push back to the floor.
      const adapt = adaptToTarget({
        positions: mesh.positions,
        normals,
        shellStart: n,
        shellGraph: patch.graph,
        heightFraction: new Float32Array(n),
        fixed,
        target: input.antagonist,
        direction: axis,
        targetMm: target,
        select: (nrm) => dot(nrm, axis) > 0,
        raiseWithinMm: 0,
      });
      const outerLoop = new Float32Array(patch.boundary.length * 3);
      patch.boundary.forEach((v, i) => outerLoop.set(mesh.positions.subarray((n + v) * 3, (n + v) * 3 + 3), i * 3));
      const floor = enforceThickness({
        positions: mesh.positions,
        vertexStart: n,
        vertexEnd: 2 * n,
        intaglio: fitting,
        marginLoop: outerLoop,
        params: { marginThicknessMm: params.wingEdgeThicknessMm, minThicknessMm: params.wingMinThicknessMm },
        shellGraph: patch.graph,
        fixed,
      });
      thicknessMm = measureThickness();
      let thinned = 0, thinnedArea = 0, maxThin = 0;
      for (let i = 0; i < n; i++) {
        const d = thicknessBefore[i]! - thicknessMm[i]!;
        if (!(d > 0.01)) continue;
        thinned++;
        thinnedArea += patch.vertexArea[i]!;
        maxThin = Math.max(maxThin, d);
      }
      space.thinning = { adapt, vertices: thinned, areaMm2: thinnedArea, maxMm: maxThin, floorPushedVertices: floor.pushedVertices };
      const after = axialClearances(mesh.positions, computeVertexNormals(mesh), n, n, axis, input.antagonist, reach);
      let minAfter = Infinity, count = 0, area = 0, worst = Infinity;
      const at: V3 = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const c = after[i]!;
        if (Number.isNaN(c)) continue;
        minAfter = Math.min(minAfter, c);
        if (c >= target - ADAPT_TOLERANCE_MM) continue;
        count++;
        area += patch.vertexArea[i]!;
        worst = Math.min(worst, c);
        const p = pointAt(mesh.positions, n + i);
        at[0] += p[0];
        at[1] += p[1];
        at[2] += p[2];
      }
      space.minClearanceMm = minAfter;
      if (count > 0) {
        space.conflict = { kind: 'insufficient space for the wing', vertices: count, areaMm2: area, minClearanceMm: worst, at: [at[0] / count, at[1] / count, at[2] / count] };
        warnings.push(
          `Insufficient space for the wing: ${area.toFixed(2)} mm² stays ${worst.toFixed(2)} mm from the antagonist (target ${target} mm) with the wing at its minimum thickness (${params.wingMinThicknessMm} mm, less within ${WING_EDGE_RAMP_MM} mm of the edge). A minimal prep or an occlusal adjustment is needed.`,
        );
      } else {
        warnings.push(`The wing was thinned locally (up to ${maxThin.toFixed(2)} mm over ${thinnedArea.toFixed(2)} mm²) to keep ${target} mm from the antagonist.`);
      }
    }
    lap('space');
  }

  // Thickness statistics: beyond the edge ramp the wing must be at full thickness (or ≥ the minimum where thinned).
  let samples = 0, min = Infinity, max = -Infinity, sum = 0, rampMin = Infinity;
  for (let i = 0; i < n; i++) {
    const th = thicknessMm[i]!;
    if (Number.isNaN(th) || fixed[i]) continue;
    if (patch.distance[i]! >= WING_EDGE_RAMP_MM) {
      samples++;
      min = Math.min(min, th);
      max = Math.max(max, th);
      sum += th;
    } else rampMin = Math.min(rampMin, th);
  }
  const thickness: WingThicknessStats = { samples, minMm: min, maxMm: max, meanMm: samples ? sum / samples : Number.NaN, rampMinMm: rampMin };
  if (samples === 0) warnings.push(`The wing is narrower than twice the ${WING_EDGE_RAMP_MM} mm edge ramp: it never reaches full thickness.`);
  else if (min < params.wingMinThicknessMm - ADAPT_TOLERANCE_MM) warnings.push(`The wing is ${min.toFixed(2)} mm thin in places (minimum ${params.wingMinThicknessMm} mm).`);

  const gapCheck = measurePatchGap(patch, input.jaw.ray, { positions: mesh.positions.subarray(0, n * 3) });
  lap('gapCheck');
  const validation = validatePatchSolid(mesh);
  if (!validation.ok) warnings.push('The wing is not a valid closed solid; see the validation report.');
  else if (validation.selfIntersections > 0) warnings.push(`The wing surface intersects itself (${validation.selfIntersections} triangle pairs); it cannot be milled as is.`);
  lap('validate');

  let maps: WingDesign['maps'];
  if (input.maps) {
    const total = mesh.positions.length / 3;
    const thicknessMap = new Float32Array(total).fill(Number.NaN);
    thicknessMap.set(thicknessMm, n);
    maps = { thickness: thicknessMap };
    if (input.antagonist) {
      maps.occlusion = clearanceMap({ positions: mesh.positions, normals: computeVertexNormals(mesh), vertexStart: n, vertexEnd: 2 * n, target: input.antagonist });
    }
    lap('maps');
  }

  const blocked = patch.blockout.areaMm2;
  return {
    mesh,
    patch,
    outerStart: n,
    validation,
    params,
    area: { patchMm2: patch.areaMm2, bondedMm2: patch.areaMm2 - blocked, blockedOutMm2: blocked, blockedOutFraction: patch.blockout.fraction },
    thickness,
    thicknessMm,
    gapCheck,
    ...(space ? { space } : {}),
    ...(maps ? { maps } : {}),
    warnings,
    timingsMs: timings,
  };
}
