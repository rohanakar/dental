import type { V3 } from './pca';
import type { RayCaster } from './raycast';
import type { SurfaceGraph } from './surface';

/** Cost of traversing the edge u–v of the given length. */
export type EdgeWeight = (u: number, v: number, lengthMm: number) => number;

/**
 * Live-wire edge cost = length × f(κ̄), κ̄ = mean endpoint curvature.
 * Convex ridges (the margin) are cheap: f = max(0.02, 1 / (1 + (κ̄/κ0)²)).
 * Concave chamfer floors and the sulcus cost extra: f = 1 + min(2, −κ̄/κ0).
 */
export function liveWireWeight(curvature: Float32Array, kappa0 = 1): EdgeWeight {
  return (u, v, length) => {
    const k = 0.5 * (curvature[u]! + curvature[v]!);
    const f = k > 0 ? Math.max(0.02, 1 / (1 + (k / kappa0) ** 2)) : 1 + Math.min(2, -k / kappa0);
    return length * f;
  };
}

export interface DijkstraTree {
  source: number;
  /** Predecessor toward the source; pred[source] = source; -1 = not reached. */
  pred: Int32Array;
  /** Accumulated cost; Infinity = not reached. */
  dist: Float32Array;
}

/** Binary min-heap of (key, vertex) with lazy deletion. */
export class MinHeap {
  private keys = new Float64Array(1024);
  private items = new Int32Array(1024);
  size = 0;

  push(key: number, item: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const it = new Int32Array(this.size * 2);
      it.set(this.items);
      this.items = it;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= key) break;
      this.keys[i] = this.keys[p]!;
      this.items[i] = this.items[p]!;
      i = p;
    }
    this.keys[i] = key;
    this.items[i] = item;
  }

  /** Pops the minimum; returns [key, item] via the out array. */
  pop(out: [number, number]): void {
    out[0] = this.keys[0]!;
    out[1] = this.items[0]!;
    const lastKey = this.keys[--this.size]!;
    const lastItem = this.items[this.size]!;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= this.size) break;
      const r = l + 1;
      const c = r < this.size && this.keys[r]! < this.keys[l]! ? r : l;
      if (this.keys[c]! >= lastKey) break;
      this.keys[i] = this.keys[c]!;
      this.items[i] = this.items[c]!;
      i = c;
    }
    this.keys[i] = lastKey;
    this.items[i] = lastItem;
  }
}

/**
 * Single-source shortest paths over the vertex graph, bounded to vertices
 * within `radiusMm` (Euclidean) of the source. Stops early once `target`
 * is settled, if given.
 */
export function dijkstraTree(
  positions: Float32Array,
  graph: SurfaceGraph,
  weight: EdgeWeight,
  source: number,
  radiusMm: number,
  target?: number,
): DijkstraTree {
  const n = positions.length / 3;
  const pred = new Int32Array(n).fill(-1);
  const dist = new Float32Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const sx = positions[source * 3]!, sy = positions[source * 3 + 1]!, sz = positions[source * 3 + 2]!;
  const r2 = radiusMm * radiusMm;
  const heap = new MinHeap();
  const top: [number, number] = [0, 0];
  pred[source] = source;
  dist[source] = 0;
  heap.push(0, source);
  while (heap.size > 0) {
    heap.pop(top);
    const u = top[1];
    if (done[u]) continue;
    done[u] = 1;
    if (u === target) break;
    const du = dist[u]!;
    const ux = positions[u * 3]!, uy = positions[u * 3 + 1]!, uz = positions[u * 3 + 2]!;
    for (let k = graph.offsets[u]!; k < graph.offsets[u + 1]!; k++) {
      const v = graph.neighbors[k]!;
      if (done[v]) continue;
      const vx = positions[v * 3]!, vy = positions[v * 3 + 1]!, vz = positions[v * 3 + 2]!;
      const ox = vx - sx, oy = vy - sy, oz = vz - sz;
      if (ox * ox + oy * oy + oz * oz > r2) continue;
      const nd = du + weight(u, v, Math.hypot(vx - ux, vy - uy, vz - uz));
      if (nd < dist[v]!) {
        dist[v] = nd;
        pred[v] = u;
        heap.push(nd, v);
      }
    }
  }
  return { source, pred, dist };
}

/** Vertex ids from the tree's source to `target`, or null if the target was not reached. */
export function pathFromTree(pred: Int32Array, target: number): number[] | null {
  if (target < 0 || target >= pred.length || pred[target] === -1) return null;
  const path = [target];
  let v = target;
  while (pred[v] !== v) {
    v = pred[v]!;
    if (v < 0 || path.length > pred.length) return null;
    path.push(v);
  }
  return path.reverse();
}

const vdist = (positions: Float32Array, a: number, b: number) =>
  Math.hypot(
    positions[a * 3]! - positions[b * 3]!,
    positions[a * 3 + 1]! - positions[b * 3 + 1]!,
    positions[a * 3 + 2]! - positions[b * 3 + 2]!,
  );

/**
 * Closed vertex chain through the anchors in order (last back to first),
 * each segment the cheapest live-wire path. The closing vertex is not
 * repeated. Throws if two consecutive anchors are not connected.
 */
export function traceClosedLoop(
  positions: Float32Array,
  graph: SurfaceGraph,
  weight: EdgeWeight,
  anchorVertices: readonly number[],
): number[] {
  if (anchorVertices.length < 2) throw new Error('A closed margin needs at least 2 anchors');
  const loop: number[] = [];
  for (let i = 0; i < anchorVertices.length; i++) {
    const a = anchorVertices[i]!;
    const b = anchorVertices[(i + 1) % anchorVertices.length]!;
    if (a === b) continue;
    const radius = Math.max(12, 1.5 * vdist(positions, a, b) + 2);
    const tree = dijkstraTree(positions, graph, weight, a, radius, b);
    const path = pathFromTree(tree.pred, b);
    if (!path) throw new Error(`Margin anchors ${i + 1} and ${((i + 1) % anchorVertices.length) + 1} are not connected on the surface`);
    for (let k = 0; k < path.length - 1; k++) loop.push(path[k]!);
  }
  return loop;
}

/** Length of a polyline given as packed xyz (closed adds the last→first segment). */
export function polylineLength(points: Float32Array, closed = true): number {
  const n = points.length / 3;
  let len = 0;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    len += Math.hypot(points[j * 3]! - points[i * 3]!, points[j * 3 + 1]! - points[i * 3 + 1]!, points[j * 3 + 2]! - points[i * 3 + 2]!);
  }
  return len;
}

/** Resample a closed polyline (packed xyz) at uniform arc length, ~spacingMm apart (at least 3 points). */
export function resampleClosedPolyline(points: Float32Array, spacingMm: number): Float32Array {
  const n = points.length / 3;
  if (n < 2) return points.slice();
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cum[i + 1] = cum[i]! + Math.hypot(points[j * 3]! - points[i * 3]!, points[j * 3 + 1]! - points[i * 3 + 1]!, points[j * 3 + 2]! - points[i * 3 + 2]!);
  }
  const total = cum[n]!;
  const count = Math.max(3, Math.round(total / spacingMm));
  const out = new Float32Array(count * 3);
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const s = (total * k) / count;
    while (seg < n - 1 && cum[seg + 1]! < s) seg++;
    const len = cum[seg + 1]! - cum[seg]!;
    const t = len > 0 ? (s - cum[seg]!) / len : 0;
    const j = (seg + 1) % n;
    for (let c = 0; c < 3; c++) out[k * 3 + c] = points[seg * 3 + c]! + t * (points[j * 3 + c]! - points[seg * 3 + c]!);
  }
  return out;
}

/**
 * Laplacian smoothing of a closed polyline (packed xyz), optionally
 * projecting each point back onto a surface after every pass.
 */
export function smoothClosedPolyline(points: Float32Array, iterations: number, project?: (p: V3) => V3): Float32Array {
  const n = points.length / 3;
  let src = points.slice();
  for (let it = 0; it < iterations; it++) {
    const dst = new Float32Array(src.length);
    for (let i = 0; i < n; i++) {
      const a = ((i + n - 1) % n) * 3, b = i * 3, c = ((i + 1) % n) * 3;
      let p: V3 = [
        0.5 * src[b]! + 0.25 * (src[a]! + src[c]!),
        0.5 * src[b + 1]! + 0.25 * (src[a + 1]! + src[c + 1]!),
        0.5 * src[b + 2]! + 0.25 * (src[a + 2]! + src[c + 2]!),
      ];
      if (project) p = project(p);
      dst.set(p, b);
    }
    src = dst;
  }
  return src;
}

/** Nearest mesh vertex to p: closest surface point, then its triangle's nearest corner. */
export function snapToVertex(positions: Float32Array, indices: Uint32Array, ray: RayCaster, p: V3): number | null {
  const hit = ray.closestPoint(p);
  if (!hit || hit.faceIndex < 0) return null;
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < 3; k++) {
    const v = indices[hit.faceIndex * 3 + k]!;
    const d = Math.hypot(positions[v * 3]! - p[0], positions[v * 3 + 1]! - p[1], positions[v * 3 + 2]! - p[2]);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

export interface MarginTrace {
  anchorVertices: number[];
  /** Closed vertex chain (the prep-region barrier). */
  loopVertices: Uint32Array;
  /** Dense closed curve, resampled to ~spacingMm and projected onto the surface (packed xyz). */
  points: Float32Array;
  lengthMm: number;
}

/**
 * Margin from 3D anchor points (user clicks or a golden case's scripted
 * anchors): snap to vertices, trace the closed live-wire loop, resample and
 * project onto the surface.
 */
export function marginFromAnchors(input: {
  positions: Float32Array;
  indices: Uint32Array;
  graph: SurfaceGraph;
  weight: EdgeWeight;
  ray: RayCaster;
  anchors: readonly V3[];
  spacingMm?: number;
}): MarginTrace {
  const { positions, indices, graph, weight, ray } = input;
  const anchorVertices: number[] = [];
  for (const a of input.anchors) {
    const v = snapToVertex(positions, indices, ray, a);
    if (v === null) throw new Error('Margin anchor is not near the surface');
    if (anchorVertices[anchorVertices.length - 1] !== v) anchorVertices.push(v);
  }
  if (anchorVertices.length > 1 && anchorVertices[0] === anchorVertices[anchorVertices.length - 1]) anchorVertices.pop();
  if (anchorVertices.length < 3) throw new Error('A closed margin needs at least 3 distinct anchors');
  const loop = traceClosedLoop(positions, graph, weight, anchorVertices);
  const chain = new Float32Array(loop.length * 3);
  loop.forEach((v, i) => chain.set(positions.subarray(v * 3, v * 3 + 3), i * 3));
  const points = resampleClosedPolyline(chain, input.spacingMm ?? 0.2);
  for (let i = 0; i < points.length; i += 3) {
    const hit = ray.closestPoint([points[i]!, points[i + 1]!, points[i + 2]!], 1);
    if (hit) points.set(hit.point, i);
  }
  return { anchorVertices, loopVertices: Uint32Array.from(loop), points, lengthMm: polylineLength(points) };
}
