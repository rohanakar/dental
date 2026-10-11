import type { DesignParams } from '@dcad/shared';
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
}): Intaglio {
  const axis = normalize(input.axis);
  const [u, v] = planeBasis(axis);
  const N = input.rim.length / 3;
  const S = input.samples ?? 200;
  const P = input.profilePoints ?? 32;
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

  const positions = new Float32Array((N * P + 1) * 3);
  let misses = 0;
  const poly: V3[] = [];
  const cum: number[] = [];
  for (let k = 0; k < N; k++) {
    const p = rim[k]!;
    const pa = dot(p, u), pb = dot(p, v);
    poly.length = 0;
    poly.push(p);
    for (let s = 1; s < S; s++) {
      const t = s / S;
      const hit = input.offset.first(at(pa + t * (ca - pa), pb + t * (cb - pb)), down, 80);
      if (hit) poly.push(hit.point);
      else misses++;
    }
    poly.push(centre);
    // Resample by 3D arc length to P points (j = 0 is the rim; the centre is shared).
    cum.length = 0;
    cum.push(0);
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1]!, b = poly[i]!;
      cum.push(cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    const total = cum[cum.length - 1]!;
    let seg = 1;
    for (let j = 0; j < P; j++) {
      const target = (total * j) / P;
      while (seg < poly.length - 1 && cum[seg]! < target) seg++;
      const a = poly[seg - 1]!, b = poly[seg]!;
      const span = cum[seg]! - cum[seg - 1]!;
      const f = j === 0 || span <= 0 ? (j === 0 ? 0 : 1) : (target - cum[seg - 1]!) / span;
      const o = (k * P + j) * 3;
      positions[o] = a[0] + (b[0] - a[0]) * f;
      positions[o + 1] = a[1] + (b[1] - a[1]) * f;
      positions[o + 2] = a[2] + (b[2] - a[2]) * f;
    }
  }
  positions.set(centre, N * P * 3);
  if (misses > N * S * 0.2) warnings.push('Many envelope rays missed the prep; check the margin and the axis.');

  // Vertex (k, j) → id k*P + j; rows 0..N-1 are the rim when ordered by k for j = 0.
  const id = (k: number, j: number) => (k % N) * P + j;
  const c = N * P;
  const indices = new Uint32Array(N * ((P - 1) * 6 + 3));
  let o = 0;
  for (let k = 0; k < N; k++) {
    for (let j = 0; j < P - 1; j++) {
      const a = id(k, j), b = id(k + 1, j), cc = id(k + 1, j + 1), d = id(k, j + 1);
      // CCW-from-above order (a, b, cc) would face +axis; reverse it so the intaglio faces the prep.
      indices.set([a, cc, b, a, d, cc], o);
      o += 6;
    }
    indices.set([id(k, P - 1), c, id(k + 1, P - 1)], o);
    o += 3;
  }
  // Re-number so rim vertices are 0..N-1 (callers stitch to them by margin order).
  const order = new Uint32Array(N * P + 1);
  const inverse = new Uint32Array(N * P + 1);
  let next = 0;
  for (let k = 0; k < N; k++) order[next++] = id(k, 0);
  for (let k = 0; k < N; k++) for (let j = 1; j < P; j++) order[next++] = id(k, j);
  order[next++] = c;
  order.forEach((old, i) => (inverse[old] = i));
  const renumbered = new Float32Array(positions.length);
  order.forEach((old, i) => renumbered.set(positions.subarray(old * 3, old * 3 + 3), i * 3));
  for (let i = 0; i < indices.length; i++) indices[i] = inverse[indices[i]!]!;
  return { mesh: { positions: renumbered, indices }, rimCount: N, profilePoints: P, centre, misses, warnings };
}

export interface GapCheck {
  /** Axial-wall vertices measured. */
  samples: number;
  meanErrorMm: number;
  maxErrorMm: number;
}

/**
 * Verification: on axial walls (away from the margin ramp), the distance from
 * the prep to the intaglio along the prep normal must equal the intended gap.
 * Measured from scan vertices along their (smoothed) normals to `intaglio`.
 */
export function measureIntaglioGap(input: {
  positions: Float32Array;
  normals: Float32Array;
  vertexMask: Uint8Array;
  distance: Float32Array;
  axis: V3;
  params: GapParams;
  intaglio: RayCaster;
  /** Only walls whose normal is at most this far from horizontal (|n·axis| ≤ maxAxial). */
  maxAxial?: number;
}): GapCheck {
  const { positions, normals, vertexMask, distance, params } = input;
  const axis = normalize(input.axis);
  const maxAxial = input.maxAxial ?? 0.5;
  const start = params.distanceToMarginMm + GAP_RAMP_MM + 0.3;
  let samples = 0, sum = 0, max = 0;
  for (let i = 0; i < vertexMask.length; i++) {
    if (!vertexMask[i] || !(distance[i]! > start)) continue;
    const n: V3 = [normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!];
    if (Math.abs(dot(n, axis)) > maxAxial || dot(n, axis) < -0.05) continue; // walls only, not undercut faces
    const p: V3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    const hit = input.intaglio.first(p, n, 1);
    if (!hit) continue;
    const err = Math.abs(hit.distance - cementGap(distance[i]!, params));
    samples++;
    sum += err;
    max = Math.max(max, err);
  }
  return { samples, meanErrorMm: samples ? sum / samples : 0, maxErrorMm: max };
}
