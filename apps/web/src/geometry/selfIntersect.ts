import { Matrix4 } from 'three';
import { ExtendedTriangle } from 'three-mesh-bvh';
import type { IndexedMesh } from './mesh';
import { createBvh } from './raycast';

export interface SelfIntersections {
  /** Intersecting triangle pairs (triangles that share a vertex are not tested). */
  count: number;
  /** Up to maxPairs pairs of face ids in the input's triangle order. */
  pairs: Array<[number, number]>;
}

const IDENTITY = new Matrix4();

/**
 * Triangle–triangle self-intersections of a mesh: the BVH is cast against
 * itself; within each pair of overlapping leaves, triangle pairs are filtered
 * by index order, shared vertices and bounding boxes before the exact test
 * (three-mesh-bvh's Möller test, degenerate and coplanar cases handled).
 * A crown that is safe to mill or print has none.
 */
export function countSelfIntersections(mesh: Pick<IndexedMesh, 'positions' | 'indices'>, opts: { maxPairs?: number } = {}): SelfIntersections {
  const maxPairs = opts.maxPairs ?? 32;
  const P = mesh.positions;
  // createBvh reorders the index in place: work on a copy; `idx` is the BVH (leaf) triangle order.
  const idx = mesh.indices.slice();
  const bvh = createBvh({ positions: P, indices: idx });
  const nt = idx.length / 3;

  // Per-triangle bounding boxes in BVH order.
  const box = new Float32Array(nt * 6);
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
    for (let k = 0; k < 3; k++) {
      box[t * 6 + k] = Math.min(P[a + k]!, P[b + k]!, P[c + k]!);
      box[t * 6 + 3 + k] = Math.max(P[a + k]!, P[b + k]!, P[c + k]!);
    }
  }
  const overlaps = (i: number, j: number) =>
    box[i * 6]! <= box[j * 6 + 3]! &&
    box[j * 6]! <= box[i * 6 + 3]! &&
    box[i * 6 + 1]! <= box[j * 6 + 4]! &&
    box[j * 6 + 1]! <= box[i * 6 + 4]! &&
    box[i * 6 + 2]! <= box[j * 6 + 5]! &&
    box[j * 6 + 2]! <= box[i * 6 + 5]!;
  const shares = (i: number, j: number) => {
    const a0 = idx[i * 3]!, a1 = idx[i * 3 + 1]!, a2 = idx[i * 3 + 2]!;
    for (let k = 0; k < 3; k++) {
      const b = idx[j * 3 + k]!;
      if (b === a0 || b === a1 || b === a2) return true;
    }
    return false;
  };
  const t1 = new ExtendedTriangle();
  const t2 = new ExtendedTriangle();
  const set = (tri: ExtendedTriangle, t: number) => {
    tri.a.fromArray(P, idx[t * 3]! * 3);
    tri.b.fromArray(P, idx[t * 3 + 1]! * 3);
    tri.c.fromArray(P, idx[t * 3 + 2]! * 3);
    tri.needsUpdate = true;
  };
  // The third argument (suppressLog) is missing from the typings; it silences degenerate-triangle warnings.
  const intersects = t1.intersectsTriangle as unknown as (this: ExtendedTriangle, o: ExtendedTriangle, target: null, quiet: boolean) => boolean;

  // Original face id of a BVH-ordered triangle (only needed for the few reported pairs).
  let original: Map<string, number> | null = null;
  const key = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(',');
  const originalFace = (t: number) => {
    if (!original) {
      original = new Map();
      for (let f = 0; f < mesh.indices.length / 3; f++) original.set(key(mesh.indices[f * 3]!, mesh.indices[f * 3 + 1]!, mesh.indices[f * 3 + 2]!), f);
    }
    return original.get(key(idx[t * 3]!, idx[t * 3 + 1]!, idx[t * 3 + 2]!)) ?? t;
  };

  let count = 0;
  const pairs: Array<[number, number]> = [];
  bvh.bvhcast(bvh, IDENTITY, {
    intersectsRanges(offset1: number, count1: number, offset2: number, count2: number) {
      for (let i = offset1; i < offset1 + count1; i++) {
        for (let j = offset2; j < offset2 + count2; j++) {
          // Every unordered pair is visited twice (and leaves against themselves): keep i < j only.
          if (i >= j || !overlaps(i, j) || shares(i, j)) continue;
          set(t1, i);
          set(t2, j);
          if (!intersects.call(t1, t2, null, true)) continue;
          count++;
          if (pairs.length < maxPairs) {
            const f1 = originalFace(i), f2 = originalFace(j);
            pairs.push([Math.min(f1, f2), Math.max(f1, f2)]);
          }
        }
      }
      return false;
    },
  });
  return { count, pairs };
}
