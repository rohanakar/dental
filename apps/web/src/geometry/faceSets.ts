import type { IndexedMesh } from './mesh';
import { boundaryLoops } from './meshValidate';
import { planeBasis } from './intaglio';
import type { V3 } from './pca';

/**
 * Face sets on a scan and the solids closed from them (used by the inlay
 * retainer, inlay.ts, to build the remaining tooth and the anatomy):
 * - face-set clean-up: the largest component, filled holes, peeled ears
 *   (faces sticking out of the boundary), grown pinches (two boundary fans
 *   at one vertex), so the set is a surface with manifold boundary loops;
 * - extractFaces: a face set as a compact mesh;
 * - slabSolid / slabDirection: an open height-field surface closed into a
 *   slab along the direction in which it is a height field;
 * - PolylineIndex: distances to a closed polyline (a margin), on a grid.
 */

/** An open surface: positions and triangles (outward faces). */
export interface OpenSurface {
  positions: Float32Array;
  indices: Uint32Array;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const pointAt = (a: ArrayLike<number>, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];

/** Faces of a scan as a compact mesh (positions copied), with the scan vertex id of every local vertex. */
export function extractFaces(positions: Float32Array, indices: Uint32Array, faces: ArrayLike<number>, override?: Map<number, V3>): OpenSurface & { source: Uint32Array } {
  const remap = new Map<number, number>();
  const source: number[] = [];
  const tris = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    for (let k = 0; k < 3; k++) {
      const v = indices[faces[i]! * 3 + k]!;
      let l = remap.get(v);
      if (l === undefined) {
        l = source.length;
        remap.set(v, l);
        source.push(v);
      }
      tris[i * 3 + k] = l;
    }
  }
  const out = new Float32Array(source.length * 3);
  source.forEach((v, i) => out.set(override?.get(v) ?? pointAt(positions, v), i * 3));
  return { positions: out, indices: tris, source: Uint32Array.from(source) };
}

/** Per-vertex count of boundary edges of a face set (on the full scan's vertex ids). */
function boundaryEdgeCounts(indices: Uint32Array, faces: number[], nv: number): Map<number, number> {
  const edges = new Map<number, number>();
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const a = indices[f * 3 + k]!, b = indices[f * 3 + ((k + 1) % 3)]!;
      const key = a < b ? a * nv + b : b * nv + a;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const counts = new Map<number, number>();
  for (const [key, uses] of edges) {
    if (uses !== 1) continue;
    const a = Math.floor(key / nv), b = key - a * nv;
    counts.set(a, (counts.get(a) ?? 0) + 1);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return counts;
}

/**
 * Grow a face set until its boundary is manifold: a vertex where two
 * boundary fans meet (a pinch, or a face hanging on one corner) gets all its
 * faces. `allowed` faces may be added (all, when omitted).
 */
export function fixPinches(indices: Uint32Array, nv: number, faces: number[], allowed?: (f: number) => boolean): { faces: number[]; added: number } {
  const set = new Set(faces);
  let added = 0;
  for (let round = 0; round < 6; round++) {
    const pinch = new Set<number>();
    for (const [v, c] of boundaryEdgeCounts(indices, [...set], nv)) if (c > 2) pinch.add(v);
    if (pinch.size === 0) break;
    for (let f = 0; f < indices.length / 3; f++) {
      if (set.has(f) || (allowed && !allowed(f))) continue;
      if (pinch.has(indices[f * 3]!) || pinch.has(indices[f * 3 + 1]!) || pinch.has(indices[f * 3 + 2]!)) {
        set.add(f);
        added++;
      }
    }
  }
  return { faces: [...set], added };
}

/**
 * Peel faces that stick out of a face set's boundary (two or three boundary
 * edges): their tips are spikes in the boundary, and the slab walls hanging
 * from a spike nearly touch each other. `allowed` faces may be removed.
 */
export function removeEars(indices: Uint32Array, nv: number, faces: number[], allowed: (f: number) => boolean, rounds = 4): number[] {
  let set = new Set(faces);
  for (let round = 0; round < rounds; round++) {
    const uses = new Map<number, number>();
    const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
    for (const f of set) for (let k = 0; k < 3; k++) {
      const e = key(indices[f * 3 + k]!, indices[f * 3 + ((k + 1) % 3)]!);
      uses.set(e, (uses.get(e) ?? 0) + 1);
    }
    const ears: number[] = [];
    for (const f of set) {
      if (!allowed(f)) continue;
      let open = 0;
      for (let k = 0; k < 3; k++) if (uses.get(key(indices[f * 3 + k]!, indices[f * 3 + ((k + 1) % 3)]!)) === 1) open++;
      if (open >= 2) ears.push(f);
    }
    if (ears.length === 0) break;
    for (const f of ears) set.delete(f);
    set = new Set(set);
  }
  return [...set];
}

/** Keep the largest edge-connected component of a face set. */
export function largestComponent(indices: Uint32Array, faces: number[], nv: number): number[] {
  const edgeFaces = new Map<number, number[]>();
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const a = indices[f * 3 + k]!, b = indices[f * 3 + ((k + 1) % 3)]!;
      const key = a < b ? a * nv + b : b * nv + a;
      const list = edgeFaces.get(key);
      if (list) list.push(f);
      else edgeFaces.set(key, [f]);
    }
  }
  const seen = new Set<number>();
  let best: number[] = [];
  for (const start of faces) {
    if (seen.has(start)) continue;
    const comp: number[] = [start];
    seen.add(start);
    for (let h = 0; h < comp.length; h++) {
      const f = comp[h]!;
      for (let k = 0; k < 3; k++) {
        const a = indices[f * 3 + k]!, b = indices[f * 3 + ((k + 1) % 3)]!;
        for (const g of edgeFaces.get(a < b ? a * nv + b : b * nv + a) ?? []) {
          if (seen.has(g)) continue;
          seen.add(g);
          comp.push(g);
        }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}

/**
 * Close an open surface (outward faces) into a slab: the surface, its copy
 * moved `depth` along −axis (faces reversed), and walls along every boundary
 * loop. For a surface that is a height field along the axis the slab never
 * intersects itself, and it is the region between the surface and its copy.
 */
export function slabSolid(top: OpenSurface, axis: V3, depth: number): IndexedMesh {
  const n = top.positions.length / 3;
  const positions = new Float32Array(n * 6);
  positions.set(top.positions, 0);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) positions[(n + i) * 3 + k] = top.positions[i * 3 + k]! - depth * axis[k]!;
  const loops = boundaryLoops(top);
  const wallEdges = loops.reduce((s, l) => s + l.length, 0);
  const fi = top.indices;
  const indices = new Uint32Array(fi.length * 2 + wallEdges * 6);
  for (let f = 0; f < fi.length; f += 3) {
    indices[f] = fi[f]!;
    indices[f + 1] = fi[f + 1]!;
    indices[f + 2] = fi[f + 2]!;
    indices[fi.length + f] = fi[f]! + n;
    indices[fi.length + f + 1] = fi[f + 2]! + n;
    indices[fi.length + f + 2] = fi[f + 1]! + n;
  }
  let o = fi.length * 2;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      // The top uses the boundary edge a→b; the wall uses b→a on top and a'→b' on the bottom copy.
      const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
      indices.set([b, a, a + n, b, a + n, b + n], o);
      o += 6;
    }
  }
  return { positions, indices };
}

/**
 * The direction to close the slabs along: within `coneDeg` of `around` (the
 * insertion axis), the one in which the surface is a height field. Scored
 * by the undercut area (faces turned away from the direction), then by the
 * smallest n·d over the faces, then by the closeness to `around`. Near-
 * vertical scan faces (the sides of a box, the proximal surface under it)
 * turn into overhangs for an axis a degree or two off; a slab closed along
 * an overhang intersects itself.
 */
export function slabDirection(surface: { positions: Float32Array; indices: Uint32Array }, around: V3, coneDeg = 15, samples = 400): V3 {
  const centre = normalize(around);
  const nf = surface.indices.length / 3;
  const unit = new Float32Array(nf * 3);
  const area = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    const a = pointAt(surface.positions, surface.indices[f * 3]!), b = pointAt(surface.positions, surface.indices[f * 3 + 1]!), c = pointAt(surface.positions, surface.indices[f * 3 + 2]!);
    const n = cross(sub(b, a), sub(c, a));
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-10) continue;
    unit.set([n[0] / len, n[1] / len, n[2] / len], f * 3);
    area[f] = len / 2;
  }
  const [u, v] = planeBasis(centre);
  const cone = (coneDeg * Math.PI) / 180;
  let best = centre;
  let bestScore: [number, number, number] = [Infinity, -Infinity, Infinity];
  for (let i = 0; i < samples; i++) {
    // Fibonacci points on the spherical cap (sample 0 is the centre).
    const t = samples > 1 ? i / (samples - 1) : 0;
    const theta = Math.acos(1 - t * (1 - Math.cos(cone)));
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    const d = normalize(add(scale(centre, Math.cos(theta)), add(scale(u, Math.sin(theta) * Math.cos(phi)), scale(v, Math.sin(theta) * Math.sin(phi)))));
    let undercut = 0, minDot = Infinity;
    for (let f = 0; f < nf; f++) {
      if (area[f] === 0) continue;
      const c = unit[f * 3]! * d[0] + unit[f * 3 + 1]! * d[1] + unit[f * 3 + 2]! * d[2];
      if (c < 0) undercut -= c * area[f]!;
      if (c < minDot) minDot = c;
    }
    const score: [number, number, number] = [undercut, minDot, theta];
    const better =
      score[0] < bestScore[0] - 1e-9 ||
      (Math.abs(score[0] - bestScore[0]) <= 1e-9 && (score[1] > bestScore[1] + 1e-6 || (Math.abs(score[1] - bestScore[1]) <= 1e-6 && score[2] < bestScore[2])));
    if (better) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Extent of point sets (xyz packed) along a direction: [min, max] of p·dir. */
export function extentAlong(arrays: Float32Array[], axis: V3): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const a of arrays) {
    for (let i = 0; i < a.length / 3; i++) {
      const h = dot(pointAt(a, i), axis);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  }
  return [lo, hi];
}

/**
 * Fill the holes of a face set: complement faces inside its bounding box
 * (grown by 1 mm) that form components touching nothing but the set.
 */
export function fillHoles(positions: Float32Array, indices: Uint32Array, faces: number[], allowed?: (f: number) => boolean): number[] {
  const nv = positions.length / 3;
  const set = new Set(faces);
  let lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const p = pointAt(positions, indices[f * 3 + k]!);
      lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
      hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
    }
  }
  const inBox = (v: number) => {
    const p = pointAt(positions, v);
    return p[0] >= lo[0] - 1 && p[1] >= lo[1] - 1 && p[2] >= lo[2] - 1 && p[0] <= hi[0] + 1 && p[1] <= hi[1] + 1 && p[2] <= hi[2] + 1;
  };
  const candidate = new Set<number>();
  const edgeFaces = new Map<number, number[]>();
  for (let f = 0; f < indices.length / 3; f++) {
    const a = indices[f * 3]!, b = indices[f * 3 + 1]!, c = indices[f * 3 + 2]!;
    if (!inBox(a) || !inBox(b) || !inBox(c)) continue;
    if (!set.has(f)) candidate.add(f);
    for (const [x, y] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const key = x < y ? x * nv + y : y * nv + x;
      const list = edgeFaces.get(key);
      if (list) list.push(f);
      else edgeFaces.set(key, [f]);
    }
  }
  const seen = new Set<number>();
  const out = [...faces];
  for (const start of candidate) {
    if (seen.has(start)) continue;
    const comp = [start];
    seen.add(start);
    let open = false;
    for (let h = 0; h < comp.length; h++) {
      const f = comp[h]!;
      for (let k = 0; k < 3; k++) {
        const x = indices[f * 3 + k]!, y = indices[f * 3 + ((k + 1) % 3)]!;
        const list = edgeFaces.get(x < y ? x * nv + y : y * nv + x)!;
        if (list.length < 2) open = true; // a scan border or the box edge: not a hole
        for (const g of list) {
          if (g === f || set.has(g) || seen.has(g)) continue;
          seen.add(g);
          comp.push(g);
        }
      }
    }
    if (!open && comp.every((f) => !allowed || allowed(f))) out.push(...comp);
  }
  return out;
}


/**
 * Distances to a closed polyline (xyz packed) within a reach: its segments
 * binned on a grid of that size, so a query looks at the segments in the
 * 27 cells around the point. Beyond the reach the distance is Infinity.
 */
export class PolylineIndex {
  private readonly grid = new Map<string, number[]>();

  constructor(
    readonly points: Float32Array,
    readonly reachMm: number,
  ) {
    const n = points.length / 3;
    const cell = reachMm;
    for (let i = 0; i < n; i++) {
      const a = pointAt(points, i), b = pointAt(points, (i + 1) % n);
      const lo = [0, 1, 2].map((k) => Math.floor(Math.min(a[k]!, b[k]!) / cell));
      const hi = [0, 1, 2].map((k) => Math.floor(Math.max(a[k]!, b[k]!) / cell));
      for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (let z = lo[2]!; z <= hi[2]!; z++) {
        const key = `${x},${y},${z}`;
        const list = this.grid.get(key);
        if (list) list.push(i);
        else this.grid.set(key, [i]);
      }
    }
  }

  /** Distance from p to the polyline, or Infinity beyond the reach. */
  distance(p: V3): number {
    const n = this.points.length / 3;
    const cell = this.reachMm;
    const [cx, cy, cz] = [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)];
    let best = Infinity;
    const seen = new Set<number>();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of this.grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const a = pointAt(this.points, i);
        const ab = sub(pointAt(this.points, (i + 1) % n), a);
        const len2 = dot(ab, ab);
        const t = len2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2)) : 0;
        const q = add(a, scale(ab, t));
        best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
      }
    }
    return best <= this.reachMm ? best : Infinity;
  }
}
