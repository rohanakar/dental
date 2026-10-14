import type { V3 } from './pca';
import type { RayCaster } from './raycast';
import type { SurfaceGraph } from './surface';

const pointAt = (a: Float32Array, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** When nothing is in contact yet, the surface is lifted into contact if the closest point is within this distance beyond the target. */
export const ADAPT_RAISE_WITHIN_MM = 0.5;
/** Clearances below target − this after thickness enforcement are conflicts. */
export const ADAPT_TOLERANCE_MM = 0.02;
/** Clearances above target + this after adaptation are open (the lift only reaches ADAPT_RAISE_WITHIN_MM). */
export const ADAPT_OPEN_TOLERANCE_MM = 0.05;
/** Damped Jacobi passes that carry the displacement from constrained vertices into their surroundings. */
const FILL_PASSES = 60;
/** Per-pass damping of the filled displacement, so it fades out over a few millimetres instead of spreading over the shell. */
const FILL_DAMPING = 0.99;
/** The lift fades from full at the closest point to zero for active vertices this much farther from the target. */
const LIFT_FALLOFF_MM = 1;

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** Final smoothing passes over the constrained vertices (capped at the desired value: a reduction never gets smaller, a lift never overshoots). */
const SMOOTH_PASSES = 4;

/** Which shell vertices an adaptation acts on. */
export type AdaptSelect = (normal: V3, heightFraction: number) => boolean;

/** Occlusal adaptation acts on occlusal-facing vertices in the upper half of the crown. */
export const occlusalSelect =
  (direction: V3): AdaptSelect =>
  (n, h) =>
    h >= 0.5 && dot(n, direction) > 0.2;

/** Contact adaptation acts on vertices facing the neighbour, 30–90% up the crown. */
export const proximalSelect =
  (direction: V3): AdaptSelect =>
  (n, h) =>
    h >= 0.3 && h <= 0.9 && dot(n, direction) > 0.5;

export interface AdaptInput {
  /** Whole crown mesh positions; the shell range is modified in place. */
  positions: Float32Array;
  /** Vertex normals of the whole crown (current positions). */
  normals: Float32Array;
  /** Shell vertices are [shellStart, shellStart + heightFraction.length). */
  shellStart: number;
  /** Shell adjacency in local ids (vertex − shellStart). */
  shellGraph: SurfaceGraph;
  /** Per shell vertex (local id): 0 at the cervix → 1 at the apex. */
  heightFraction: Float32Array;
  /** Per shell vertex (local id): 1 = never moves (cervical ring). */
  fixed: Uint8Array;
  /** Surface to adapt to (antagonist, or the prep jaw for contacts). */
  target: RayCaster;
  /** Target faces to skip (e.g. the prep and its 1 mm band for contacts). */
  ignoreFaces?: Uint8Array;
  /** Unit clinical direction toward the target (occlusal, or ±mesial). */
  direction: V3;
  /** Target clearance (negative = intentional overlap). */
  targetMm: number;
  select: AdaptSelect;
  raiseWithinMm?: number;
}

export interface AdaptReport {
  /** Shell vertices moved by more than 1 µm. */
  movedVertices: number;
  maxMoveMm: number;
  /** Smallest clearance over the active vertices before and after (Infinity = nothing found). */
  minClearanceBeforeMm: number;
  minClearanceMm: number;
}

export interface AdaptConflict {
  kind: 'insufficient reduction' | 'contact too tight';
  /** Active vertices still closer than target − tolerance. */
  vertices: number;
  minClearanceMm: number;
  /** Centroid of the conflicting vertices. */
  at: V3;
}

/**
 * Signed clearance from p to the target along `direction`: positive = gap to
 * the first front-facing hit ahead; negative = p is behind the target surface
 * (penetration depth, measured back along −direction). NaN if nothing is found
 * within maxMm. Same convention as crownMaps.clearanceMap, but along a fixed
 * clinical direction instead of the vertex normal.
 */
export function clearanceAlong(p: V3, direction: V3, target: RayCaster, ignoreFaces: Uint8Array | undefined, maxMm: number): number {
  const first = (d: V3) => target.all(p, d, maxMm).find((h) => !ignoreFaces?.[h.faceIndex]);
  const fwd = first(direction);
  if (fwd && dot(fwd.normal, direction) < 0) return fwd.distance;
  const bwd = first([-direction[0], -direction[1], -direction[2]]);
  if (bwd && dot(bwd.normal, direction) < 0) return -bwd.distance;
  if (fwd) return -fwd.distance;
  return Number.NaN;
}

/**
 * Clearances of the active shell vertices (selected by normal and height),
 * per local id; NaN for inactive vertices or when nothing is in range.
 */
export function measureClearances(input: Omit<AdaptInput, 'shellGraph' | 'fixed'>, maxMm: number): Float32Array {
  const n = input.heightFraction.length;
  const out = new Float32Array(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    const v = input.shellStart + i;
    const normal = pointAt(input.normals, v);
    if (!input.select(normal, input.heightFraction[i]!)) continue;
    out[i] = clearanceAlong(pointAt(input.positions, v), input.direction, input.target, input.ignoreFaces, maxMm);
  }
  return out;
}

/**
 * Adapt the crown to a target surface along a clinical direction. Active
 * vertices closer than `targetMm` are reduced to it; if none is that close
 * but the closest is within `raiseWithinMm` beyond it, the surface around
 * the closest point is lifted into contact. The displacement (a
 * scalar along `direction`) is pinned on those vertices and filled
 * harmonically into the rest of the shell, so the surrounding anatomy follows
 * smoothly (the field is smoothed, never the positions). Fixed vertices stay
 * put. Moves `positions` in place.
 */
export function adaptToTarget(input: AdaptInput): AdaptReport {
  const { positions, shellStart, shellGraph, fixed, direction, targetMm } = input;
  const n = input.heightFraction.length;
  const raise = input.raiseWithinMm ?? ADAPT_RAISE_WITHIN_MM;
  const range = Math.max(3, targetMm + raise + 1);
  const clearance = measureClearances(input, range);

  // Desired displacement along `direction` (negative = away from the target).
  // Penetrating / too-close vertices are reduced to the target locally. If nothing is within the target yet but the
  // closest point is within `raise`, active vertices are lifted by lift·(1 − smoothstep(min, min + 1 mm, c)): exactly
  // into contact at the closest point, fading with distance, never past the target (lift·w ≤ c − target for c ≥ min).
  // A per-vertex raise to the target would flatten the anatomy onto it.
  const desired = new Float64Array(n).fill(Number.NaN);
  let minBefore = Infinity;
  for (let i = 0; i < n; i++) {
    const c = clearance[i]!;
    if (!Number.isNaN(c) && !fixed[i]) minBefore = Math.min(minBefore, c);
  }
  const lift = minBefore > targetMm && minBefore <= targetMm + raise ? minBefore - targetMm : 0;
  for (let i = 0; i < n; i++) {
    const c = clearance[i]!;
    if (Number.isNaN(c) || fixed[i]) continue;
    if (c < targetMm) desired[i] = c - targetMm;
    else if (lift > 0) desired[i] = lift * (1 - smoothstep(minBefore, minBefore + LIFT_FALLOFF_MM, c));
  }

  const field = new Float64Array(n);
  for (let i = 0; i < n; i++) if (!Number.isNaN(desired[i]!)) field[i] = desired[i]!;
  const avg = (i: number) => {
    let sum = 0;
    let count = 0;
    for (let k = shellGraph.offsets[i]!; k < shellGraph.offsets[i + 1]!; k++) {
      sum += field[shellGraph.neighbors[k]!]!;
      count++;
    }
    return count ? sum / count : field[i]!;
  };
  // Damped harmonic fill of the unconstrained vertices (Jacobi: one ring per pass); constrained and fixed vertices
  // are boundary values.
  const next = new Float64Array(n);
  for (let pass = 0; pass < FILL_PASSES; pass++) {
    for (let i = 0; i < n; i++) next[i] = fixed[i] || !Number.isNaN(desired[i]!) ? field[i]! : FILL_DAMPING * avg(i);
    field.set(next);
  }
  // Light smoothing of the constrained values, capped at the desired value: a reduction never gets smaller and a lift
  // never overshoots (the closest point's neighbours carry nearly the full lift, so contact is kept).
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    for (let i = 0; i < n; i++) {
      const d = desired[i]!;
      // The contact core (≈ full lift) stays pinned so the closest point lands on the target.
      if (fixed[i] || Number.isNaN(d) || (lift > 0 && d >= 0.98 * lift)) continue;
      field[i] = Math.min(0.5 * (field[i]! + avg(i)), d);
    }
  }

  let moved = 0;
  let maxMove = 0;
  for (let i = 0; i < n; i++) {
    if (fixed[i]) continue;
    const f = field[i]!;
    if (Math.abs(f) > 1e-6) moved++;
    maxMove = Math.max(maxMove, Math.abs(f));
    const o = (shellStart + i) * 3;
    positions[o] = positions[o]! + f * direction[0];
    positions[o + 1] = positions[o + 1]! + f * direction[1];
    positions[o + 2] = positions[o + 2]! + f * direction[2];
  }

  // Re-measure at the moved positions (normals are kept: the selection must not change underneath us).
  const after = measureClearances(input, range);
  let minAfter = Infinity;
  for (let i = 0; i < n; i++) if (!Number.isNaN(after[i]!) && !fixed[i]) minAfter = Math.min(minAfter, after[i]!);
  return { movedVertices: moved, maxMoveMm: maxMove, minClearanceBeforeMm: minBefore, minClearanceMm: minAfter };
}

/** Occlusal adaptation: `direction` = occlusal, active on occlusal-facing vertices in the upper half. */
export function adaptOcclusion(input: Omit<AdaptInput, 'select'>): AdaptReport {
  return adaptToTarget({ ...input, select: occlusalSelect(input.direction) });
}

/** Contact adaptation toward one neighbour: `direction` = mesial (or distal = −mesial). */
export function adaptContacts(input: Omit<AdaptInput, 'select'>): AdaptReport {
  return adaptToTarget({ ...input, select: proximalSelect(input.direction) });
}

/**
 * After thickness enforcement: active vertices still closer to the target than
 * target − ADAPT_TOLERANCE_MM. Returns the conflict (and the current minimum
 * clearance), or just the minimum when there is none.
 */
export function findConflict(
  input: Omit<AdaptInput, 'shellGraph'>,
  kind: AdaptConflict['kind'],
): { minClearanceMm: number; conflict?: AdaptConflict } {
  const raise = input.raiseWithinMm ?? ADAPT_RAISE_WITHIN_MM;
  const clearance = measureClearances(input, Math.max(3, input.targetMm + raise + 1));
  let min = Infinity;
  let count = 0;
  let worst = Infinity;
  const at: V3 = [0, 0, 0];
  for (let i = 0; i < clearance.length; i++) {
    const c = clearance[i]!;
    if (Number.isNaN(c) || input.fixed[i]) continue;
    min = Math.min(min, c);
    if (c < input.targetMm - ADAPT_TOLERANCE_MM) {
      count++;
      worst = Math.min(worst, c);
      const p = pointAt(input.positions, input.shellStart + i);
      at[0] += p[0];
      at[1] += p[1];
      at[2] += p[2];
    }
  }
  if (count === 0) return { minClearanceMm: min };
  return {
    minClearanceMm: min,
    conflict: { kind, vertices: count, minClearanceMm: worst, at: [at[0] / count, at[1] / count, at[2] / count] },
  };
}
