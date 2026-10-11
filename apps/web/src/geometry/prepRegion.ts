import type { V3 } from './pca';
import type { RayCaster } from './raycast';
import type { SurfaceGraph } from './surface';

export interface PrepRegion {
  /** 1 = inside the margin or on the margin loop. */
  vertexMask: Uint8Array;
  /** 1 = all three corners in vertexMask (BVH-ordered face ids). */
  faceMask: Uint8Array;
  vertexCount: number;
  faceCount: number;
  /** False if the flood fill escaped (margin not closed on the surface); the masks are then partial. */
  closed: boolean;
}

/**
 * Prep region = flood fill (BFS over edges) from a vertex inside the margin.
 * On a 2-manifold a closed vertex chain cannot be crossed, so the fill stops
 * at the loop. If it reaches farther than maxRadiusMm from the loop centroid
 * (default 1.5 × the loop radius + 3 mm, so a
 * tall prep whose top is far above the margin plane still fits) the margin leaks and `closed` is false.
 */
export function prepRegion(input: {
  positions: Float32Array;
  indices: Uint32Array;
  graph: SurfaceGraph;
  loopVertices: ArrayLike<number>;
  seedVertex: number;
  maxRadiusMm?: number;
}): PrepRegion {
  const { positions, indices, graph, loopVertices, seedVertex } = input;
  const nv = positions.length / 3;
  const mask = new Uint8Array(nv);
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < loopVertices.length; i++) {
    const v = loopVertices[i]!;
    mask[v] = 1;
    cx += positions[v * 3]!;
    cy += positions[v * 3 + 1]!;
    cz += positions[v * 3 + 2]!;
  }
  const nl = Math.max(1, loopVertices.length);
  cx /= nl;
  cy /= nl;
  cz /= nl;
  let loopRadius = 0;
  for (let i = 0; i < loopVertices.length; i++) {
    const v = loopVertices[i]!;
    loopRadius = Math.max(loopRadius, Math.hypot(positions[v * 3]! - cx, positions[v * 3 + 1]! - cy, positions[v * 3 + 2]! - cz));
  }
  const maxR = input.maxRadiusMm ?? 1.5 * loopRadius + 3;
  const maxR2 = maxR * maxR;

  let closed = true;
  let vertexCount = loopVertices.length;
  if (!mask[seedVertex]) {
    const queue = new Uint32Array(nv);
    let head = 0;
    let tail = 0;
    queue[tail++] = seedVertex;
    mask[seedVertex] = 1;
    vertexCount++;
    while (head < tail) {
      const u = queue[head++]!;
      const dx = positions[u * 3]! - cx, dy = positions[u * 3 + 1]! - cy, dz = positions[u * 3 + 2]! - cz;
      if (dx * dx + dy * dy + dz * dz > maxR2) {
        closed = false;
        break;
      }
      for (let k = graph.offsets[u]!; k < graph.offsets[u + 1]!; k++) {
        const v = graph.neighbors[k]!;
        if (mask[v]) continue;
        mask[v] = 1;
        vertexCount++;
        queue[tail++] = v;
      }
    }
  }
  const faceMask = new Uint8Array(indices.length / 3);
  let faceCount = 0;
  for (let f = 0; f < faceMask.length; f++) {
    if (mask[indices[f * 3]!] && mask[indices[f * 3 + 1]!] && mask[indices[f * 3 + 2]!]) {
      faceMask[f] = 1;
      faceCount++;
    }
  }
  return { vertexMask: mask, faceMask, vertexCount, faceCount, closed };
}

/** Grow a vertex mask by `rings` 1-rings (e.g. the 1–2 rings beyond the margin the intaglio needs). */
export function dilateMask(mask: Uint8Array, graph: SurfaceGraph, rings: number): Uint8Array {
  let src = mask;
  for (let r = 0; r < rings; r++) {
    const dst = src.slice();
    for (let v = 0; v < src.length; v++) {
      if (!src[v]) continue;
      for (let k = graph.offsets[v]!; k < graph.offsets[v + 1]!; k++) dst[graph.neighbors[k]!] = 1;
    }
    src = dst;
  }
  return src === mask ? mask.slice() : src;
}

/**
 * A vertex inside the margin to seed prepRegion: cast from the loop
 * centroid + 15 mm along occlusal back down; the first hit is the prep top.
 * Returns the hit triangle's nearest corner, or null on a miss.
 */
export function prepSeedVertex(input: {
  positions: Float32Array;
  indices: Uint32Array;
  ray: RayCaster;
  loopVertices: ArrayLike<number>;
  occlusal: V3;
}): number | null {
  const { positions, indices, ray, loopVertices, occlusal } = input;
  if (loopVertices.length === 0) return null;
  const c: V3 = [0, 0, 0];
  for (let i = 0; i < loopVertices.length; i++) {
    const v = loopVertices[i]!;
    c[0] += positions[v * 3]!;
    c[1] += positions[v * 3 + 1]!;
    c[2] += positions[v * 3 + 2]!;
  }
  for (let k = 0; k < 3; k++) c[k] = c[k]! / loopVertices.length;
  const start: V3 = [c[0] + 15 * occlusal[0], c[1] + 15 * occlusal[1], c[2] + 15 * occlusal[2]];
  const hit = ray.first(start, [-occlusal[0], -occlusal[1], -occlusal[2]], 40);
  if (!hit) return null;
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < 3; k++) {
    const v = indices[hit.faceIndex * 3 + k]!;
    const d = Math.hypot(positions[v * 3]! - hit.point[0], positions[v * 3 + 1]! - hit.point[1], positions[v * 3 + 2]! - hit.point[2]);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}
