import type { DesignParams } from '@dcad/shared';
import { MARGIN_UNDERCUT_TOLERANCE_MM } from './axis';
import { MinHeap } from './livewire';
import type { IndexedMesh } from './mesh';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh, type RayCaster } from './raycast';
import type { SurfaceGraph } from './surface';

/** Width (mm, along the surface) over which the cement gap and the extra spacer fade in. */
export const GAP_RAMP_MM = 0.15;

export type GapParams = Pick<DesignParams, 'cementGapMm' | 'extraSpacerMm' | 'distanceToMarginMm'>;

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Gap between the prep and the intaglio at geodesic distance `d` from the
 * margin: 0 at the margin (tight seal), the cement gap after a short ramp,
 * plus the extra spacer from `distanceToMarginMm` on.
 */
export function cementGap(d: number, p: GapParams): number {
  return p.cementGapMm * smoothstep(0, GAP_RAMP_MM, d) + p.extraSpacerMm * smoothstep(p.distanceToMarginMm, p.distanceToMarginMm + GAP_RAMP_MM, d);
}

/** Geodesic (edge-length) distance from the margin loop to every vertex of the prep region; Infinity outside. */
export function distanceFromMargin(
  positions: Float32Array,
  graph: SurfaceGraph,
  vertexMask: Uint8Array,
  loopVertices: ArrayLike<number>,
): Float32Array {
  const n = positions.length / 3;
  const dist = new Float32Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const heap = new MinHeap();
  const top: [number, number] = [0, 0];
  for (let i = 0; i < loopVertices.length; i++) {
    const v = loopVertices[i]!;
    dist[v] = 0;
    heap.push(0, v);
  }
  while (heap.size > 0) {
    heap.pop(top);
    const u = top[1];
    if (done[u]) continue;
    done[u] = 1;
    const du = dist[u]!;
    for (let k = graph.offsets[u]!; k < graph.offsets[u + 1]!; k++) {
      const v = graph.neighbors[k]!;
      if (done[v] || !vertexMask[v]) continue;
      const nd =
        du +
        Math.hypot(positions[v * 3]! - positions[u * 3]!, positions[v * 3 + 1]! - positions[u * 3 + 1]!, positions[v * 3 + 2]! - positions[u * 3 + 2]!);
      if (nd < dist[v]!) {
        dist[v] = nd;
        heap.push(nd, v);
      }
    }
  }
  return dist;
}

export interface OffsetPrep {
  /** Prep-region faces as a compact mesh, vertices moved out by the gap (BVH-ordered index). */
  mesh: IndexedMesh;
  ray: RayCaster;
  /** Scan vertex id of each offset-mesh vertex. */
  sourceVertex: Uint32Array;
}

/**
 * The surface the intaglio rests on: each prep-region vertex moved along its
 * smoothed normal by cementGap(distance from the margin).
 */
export function offsetPrep(input: {
  positions: Float32Array;
  indices: Uint32Array;
  /** Smoothed unit vertex normals (raw scan normals are too noisy to offset along). */
  normals: Float32Array;
  faceMask: Uint8Array;
  distance: Float32Array;
  params: GapParams;
}): OffsetPrep {
  const { positions, indices, normals, faceMask, distance, params } = input;
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const source: number[] = [];
  const tris: number[] = [];
  for (let f = 0; f < faceMask.length; f++) {
    if (!faceMask[f]) continue;
    for (let k = 0; k < 3; k++) {
      const v = indices[f * 3 + k]!;
      if (remap[v] === -1) {
        remap[v] = source.length;
        source.push(v);
      }
      tris.push(remap[v]!);
    }
  }
  const out = new Float32Array(source.length * 3);
  source.forEach((v, i) => {
    const d = distance[v]!;
    const g = Number.isFinite(d) ? cementGap(d, params) : 0;
    for (let k = 0; k < 3; k++) out[i * 3 + k] = positions[v * 3 + k]! + g * normals[v * 3 + k]!;
  });
  const mesh: IndexedMesh = { positions: out, indices: Uint32Array.from(tris) };
  const ray = bvhRayCaster(createBvh(mesh));
  return { mesh, ray, sourceVertex: Uint32Array.from(source) };
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * The intaglio's envelope samples (buildIntaglio) are refined where neighbours lie farther apart than this (mm), up to
 * this many halvings: on a near-vertical wall a radial step of 0.02 mm moves 0.4 mm down.
 */
const ENVELOPE_GAP_MM = 0.05;
const ENVELOPE_SPLITS = 6;

/** Orthonormal (u, v) with u × v = axis. */
export function planeBasis(axis: V3): [V3, V3] {
  const u = normalize(cross(Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], axis));
  return [u, cross(axis, u)];
}

export interface Intaglio {
  /** Rim = vertices 0..N-1 (one per margin sample, in order); centre vertex last. */
  mesh: IndexedMesh;
  rimCount: number;
  profilePoints: number;
  centre: V3;
  /** Envelope rays that missed the offset surface (skipped samples). */
  misses: number;
  warnings: string[];
}

/**
 * Intaglio from radial profiles. For each rim (margin) point, sample the
 * straight line toward the projected centre; at each sample cast a ray from
 * above along −axis onto the offset prep. The first hit is the upper
 * envelope, so undercuts are blocked out (the crown can slide on along the
 * axis). Each profile is resampled by 3D arc length, so steep axial walls get
 * as many points as flat areas. Faces point toward the prep (−axis side).
 *
 * The rim must run CCW seen from +axis; the projected margin must be
 * star-shaped around its centroid (normal for posterior preps).
 */
export function buildIntaglio(input: {
  offset: RayCaster;
  rim: Float32Array;
  axis: V3;
  samples?: number;
  profilePoints?: number;
  /** Profiles per rim interval (default 1): more round tight corners, where the triangles between profiles cut in. */
  between?: number;
}): Intaglio {
  const axis = normalize(input.axis);
  const [u, v] = planeBasis(axis);
  const N = input.rim.length / 3;
  const S = input.samples ?? 200;
  const P = input.profilePoints ?? 32;
  const between = Math.max(1, Math.round(input.between ?? 1));
  const warnings: string[] = [];
  const rim: V3[] = [];
  for (let k = 0; k < N; k++) rim.push([input.rim[k * 3]!, input.rim[k * 3 + 1]!, input.rim[k * 3 + 2]!]);

  // Projected centre and a ray start height above everything.
  let ca = 0, cb = 0, hMax = -Infinity;
  for (const p of rim) {
    ca += dot(p, u) / N;
    cb += dot(p, v) / N;
    hMax = Math.max(hMax, dot(p, axis));
  }
  const top = hMax + 40;
  const down: V3 = [-axis[0], -axis[1], -axis[2]];
  const at = (a: number, b: number): V3 => [
    a * u[0] + b * v[0] + top * axis[0],
    a * u[1] + b * v[1] + top * axis[1],
    a * u[2] + b * v[2] + top * axis[2],
  ];
  const centreHit = input.offset.first(at(ca, cb), down, 80);
  if (!centreHit) throw new Error('The insertion axis through the margin centre misses the prep');
  const centre = centreHit.point;

  // Star-shapedness: angles around the centre must increase monotonically.
  let reversals = 0;
  let prevAngle = Math.atan2(dot(rim[N - 1]!, v) - cb, dot(rim[N - 1]!, u) - ca);
  for (const p of rim) {
    const angle = Math.atan2(dot(p, v) - cb, dot(p, u) - ca);
    let d = angle - prevAngle;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    if (d < 0) reversals++;
    prevAngle = angle;
  }
  if (reversals > 0) warnings.push(`The margin is not star-shaped seen along the insertion axis (${reversals} reversals); the inner surface may fold.`);

  // Profiles: `between` per rim interval, the first on the rim point and the others from points along the rim's chord
  // (only their inner rows become vertices; a fan joins them to the rim). Ids: rim k → k (callers stitch to the rim
  // by margin order), profile q's row j ≥ 1 → N + q·(P − 1) + j − 1, the centre last.
  const M = N * between;
  const inner = (q: number, j: number) => N + (q % M) * (P - 1) + j - 1;
  const c = N + M * (P - 1);
  const positions = new Float32Array((c + 1) * 3);
  rim.forEach((p, k) => positions.set(p, k * 3));
  let misses = 0;
  const poly: V3[] = [];
  const cum: number[] = [];
  for (let q = 0; q < M; q++) {
    const k = Math.floor(q / between), f = (q % between) / between;
    const r0 = rim[k]!, r1 = rim[(k + 1) % N]!;
    const p: V3 = [r0[0] + (r1[0] - r0[0]) * f, r0[1] + (r1[1] - r0[1]) * f, r0[2] + (r1[2] - r0[2]) * f];
    const pa = dot(p, u), pb = dot(p, v);
    poly.length = 0;
    poly.push(p);
    // Where two neighbouring samples lie farther apart than ENVELOPE_GAP_MM (a steep wall: a step across moves far
    // down), sample between them, halving up to ENVELOPE_SPLITS times; a blocked-out undercut stays a vertical drop.
    const cast = (t: number) => input.offset.first(at(pa + t * (ca - pa), pb + t * (cb - pb)), down, 80)?.point ?? null;
    const refine = (t0: number, a: V3, t1: number, b: V3, depth: number) => {
      if (depth >= ENVELOPE_SPLITS || Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) <= ENVELOPE_GAP_MM) return;
      const tm = (t0 + t1) / 2;
      const m = cast(tm);
      if (!m) return;
      refine(t0, a, tm, m, depth + 1);
      poly.push(m);
      refine(tm, m, t1, b, depth + 1);
    };
    let prevT = 0;
    for (let s = 1; s < S; s++) {
      const t = s / S;
      const hit = cast(t);
      if (!hit) {
        misses++;
        continue;
      }
      refine(prevT, poly[poly.length - 1]!, t, hit, 0);
      poly.push(hit);
      prevT = t;
    }
    poly.push(centre);
    // Resample by 3D arc length to P points (j = 0 is the rim point, not stored; the centre is shared).
    cum.length = 0;
    cum.push(0);
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1]!, b = poly[i]!;
      cum.push(cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    const total = cum[cum.length - 1]!;
    let seg = 1;
    for (let j = 1; j < P; j++) {
      const target = (total * j) / P;
      while (seg < poly.length - 1 && cum[seg]! < target) seg++;
      const a = poly[seg - 1]!, b = poly[seg]!;
      const span = cum[seg]! - cum[seg - 1]!;
      const f2 = span <= 0 ? 1 : (target - cum[seg - 1]!) / span;
      positions.set([a[0] + (b[0] - a[0]) * f2, a[1] + (b[1] - a[1]) * f2, a[2] + (b[2] - a[2]) * f2], inner(q, j) * 3);
    }
  }
  positions.set(centre, c * 3);
  if (misses > M * S * 0.2) warnings.push('Many envelope rays missed the prep; check the margin and the axis.');

  // Faces point toward the prep: a quad (a, b, cc, d) going round and inward is (a, cc, b) and (a, d, cc).
  const indices = new Uint32Array((M * (P - 2) * 2 + M + M + N) * 3);
  let o = 0;
  for (let q = 0; q < M; q++) {
    for (let j = 1; j < P - 1; j++) {
      const a = inner(q, j), b = inner(q + 1, j), cc = inner(q + 1, j + 1), d = inner(q, j + 1);
      indices.set([a, cc, b, a, d, cc], o);
      o += 6;
    }
    indices.set([inner(q, P - 1), c, inner(q + 1, P - 1)], o);
    o += 3;
  }
  // The rim band: each rim point fans over its interval's first inner row, then closes on the next rim point.
  for (let k = 0; k < N; k++) {
    for (let i = 0; i < between; i++) {
      const q = k * between + i;
      indices.set([k, inner(q, 1), inner(q + 1, 1)], o);
      o += 3;
    }
    indices.set([k, inner((k + 1) * between, 1), (k + 1) % N], o);
    o += 3;
  }
  return { mesh: { positions, indices }, rimCount: N, profilePoints: P, centre, misses, warnings };
}

/** Even-odd test of (x, y) against a closed polygon. */
function insidePolygon(poly: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The rim moved off the walls it would cut: where the prep hides a rim point along the axis (it overhangs the margin
 * by at most `maxMm`, MARGIN_UNDERCUT_TOLERANCE_MM; a deeper overhang fails the margin check), the point moves
 * outward, perpendicular to the axis and away from the rim's centre, by the least amount that clears it. The crown's
 * rim then slides past the wall instead of into it. In place; returns how many points moved and the largest move.
 */
export function clearRim(rim: Float32Array, axis: V3, prep: { ray: RayCaster; faceMask: Uint8Array }, maxMm = MARGIN_UNDERCUT_TOLERANCE_MM): { moved: number; maxMoveMm: number } {
  const d = normalize(axis);
  const n = rim.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += rim[i * 3]! / n;
    cy += rim[i * 3 + 1]! / n;
    cz += rim[i * 3 + 2]! / n;
  }
  const hidden = (q: V3) => {
    for (const hit of prep.ray.all([q[0] + 0.02 * d[0], q[1] + 0.02 * d[1], q[2] + 0.02 * d[2]], d, 15)) {
      if (hit.distance >= 0.02 && prep.faceMask[hit.faceIndex]) return true;
    }
    return false;
  };
  let moved = 0, maxMoveMm = 0;
  for (let i = 0; i < n; i++) {
    const p: V3 = [rim[i * 3]!, rim[i * 3 + 1]!, rim[i * 3 + 2]!];
    if (!hidden(p)) continue;
    const r: V3 = [p[0] - cx, p[1] - cy, p[2] - cz];
    const out = normalize([r[0] - dot(r, d) * d[0], r[1] - dot(r, d) * d[1], r[2] - dot(r, d) * d[2]]);
    for (let s = 1; s <= RIM_CLEAR_STEPS; s++) {
      const m = (maxMm * s) / RIM_CLEAR_STEPS;
      const q: V3 = [p[0] + m * out[0], p[1] + m * out[1], p[2] + m * out[2]];
      if (hidden(q)) continue;
      rim.set(q, i * 3);
      moved++;
      maxMoveMm = Math.max(maxMoveMm, m);
      break;
    }
  }
  return { moved, maxMoveMm };
}
const RIM_CLEAR_STEPS = 10;

/** The shadow test starts this far off the wall (mm) and looks this far up the axis for the prep above it. */
const SHADOW_LIFT_MM = 0.01;
const SHADOW_REACH_MM = 15;
/**
 * The gap ray starts this far inside the prep wall (mm), so an intaglio that dips into the prep is measured (a
 * negative gap) instead of missed. Prep walls are millimetres thick.
 */
const GAP_BEHIND_MM = 0.2;

export interface GapCheck {
  /** Axial-wall vertices measured. */
  samples: number;
  meanErrorMm: number;
  maxErrorMm: number;
}

/**
 * Verification: on axial walls (away from the margin ramp), the distance from
 * the prep to the intaglio along the prep normal must equal the intended gap.
 * Measured from scan vertices along their (smoothed) normals to `intaglio`,
 * signed: an intaglio inside the prep (up to GAP_BEHIND_MM) is a negative gap,
 * so the crown would sit on the wall there.
 * With `loop` (the margin loop's vertices), a wall whose gap-offset point lies
 * outside the margin seen along the axis can't get more gap than the rim
 * leaves as it slides past (a wall parallel to the axis, or leaning over the
 * margin by less than MARGIN_UNDERCUT_TOLERANCE_MM): there only a collision
 * (a negative gap) counts (specs/2026-10-30-bridge-frames-on-segment-scans.md).
 * With `prep`, a wall shadowed along the axis by the prep itself (under an
 * overhang) is skipped: the intaglio is blocked out there by design, and its
 * gap grows (specs/2026-10-30-cement-gap-real-scans.md).
 */
export function measureIntaglioGap(input: {
  positions: Float32Array;
  normals: Float32Array;
  vertexMask: Uint8Array;
  distance: Float32Array;
  axis: V3;
  params: GapParams;
  intaglio: RayCaster;
  /** The jaw's ray caster and the prep region's faces, for the shadow test. */
  prep?: { ray: RayCaster; faceMask: Uint8Array };
  /** Only walls whose normal is at most this far from horizontal (|n·axis| ≤ maxAxial). */
  maxAxial?: number;
  /** The margin loop's vertices (in order): seen along the axis, the intaglio's footprint. */
  loop?: ArrayLike<number>;
}): GapCheck {
  const { positions, normals, vertexMask, distance, params } = input;
  const axis = normalize(input.axis);
  const maxAxial = input.maxAxial ?? 0.5;
  const start = params.distanceToMarginMm + GAP_RAMP_MM + 0.3;
  const [pu, pv] = planeBasis(axis);
  const footprint = input.loop
    ? Array.from(input.loop, (v): [number, number] => {
        const q: V3 = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
        return [dot(q, pu), dot(q, pv)];
      })
    : null;
  let samples = 0, sum = 0, max = 0;
  for (let i = 0; i < vertexMask.length; i++) {
    if (!vertexMask[i] || !(distance[i]! > start)) continue;
    const n: V3 = [normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!];
    if (Math.abs(dot(n, axis)) > maxAxial || dot(n, axis) < -0.05) continue; // walls only, not undercut faces
    const p: V3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    if (input.prep) {
      const lift: V3 = [p[0] + SHADOW_LIFT_MM * n[0], p[1] + SHADOW_LIFT_MM * n[1], p[2] + SHADOW_LIFT_MM * n[2]];
      const over = input.prep.ray.first(lift, axis, SHADOW_REACH_MM);
      if (over && over.faceIndex >= 0 && input.prep.faceMask[over.faceIndex]) continue;
    }
    const hit = input.intaglio.first([p[0] - GAP_BEHIND_MM * n[0], p[1] - GAP_BEHIND_MM * n[1], p[2] - GAP_BEHIND_MM * n[2]], n, 1 + GAP_BEHIND_MM);
    if (!hit) continue;
    const gap = hit.distance - GAP_BEHIND_MM;
    const want = cementGap(distance[i]!, params);
    const off: V3 = [p[0] + want * n[0], p[1] + want * n[1], p[2] + want * n[2]];
    const err = footprint && !insidePolygon(footprint, dot(off, pu), dot(off, pv)) ? Math.max(0, -gap) : Math.abs(gap - want);
    samples++;
    sum += err;
    max = Math.max(max, err);
  }
  return { samples, meanErrorMm: samples ? sum / samples : 0, maxErrorMm: max };
}
