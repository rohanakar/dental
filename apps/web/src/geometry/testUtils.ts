import type { IndexedMesh } from './mesh';
import { computeVertexNormals } from './normals';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh, type RayCaster } from './raycast';

/** Test-only: a mesh with normals, a BVH-ordered index and a RayCaster (like the worker's retained scan). */
export interface PreparedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  ray: RayCaster;
}

export function prepareMesh(mesh: IndexedMesh): PreparedMesh {
  const normals = computeVertexNormals(mesh);
  const indices = mesh.indices.slice();
  const bvh = createBvh({ positions: mesh.positions, indices });
  return { positions: mesh.positions, indices, normals, ray: bvhRayCaster(bvh) };
}

/** Distance from p to a closed polyline (packed xyz). */
export function distanceToClosedPolyline(p: V3, poly: Float32Array): number {
  const n = poly.length / 3;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 3]!, ay = poly[i * 3 + 1]!, az = poly[i * 3 + 2]!;
    const bx = poly[j * 3]! - ax, by = poly[j * 3 + 1]! - ay, bz = poly[j * 3 + 2]! - az;
    const px = p[0] - ax, py = p[1] - ay, pz = p[2] - az;
    const len2 = bx * bx + by * by + bz * bz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / len2)) : 0;
    best = Math.min(best, Math.hypot(px - t * bx, py - t * by, pz - t * bz));
  }
  return best;
}

/** UV sphere (outward normals unless inverted). */
export function uvSphere(radius: number, rings = 40, segments = 80, inverted = false): IndexedMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const th = (Math.PI * i) / rings;
    for (let j = 0; j < segments; j++) {
      const ph = (2 * Math.PI * j) / segments;
      positions.push(radius * Math.sin(th) * Math.cos(ph), radius * Math.sin(th) * Math.sin(ph), radius * Math.cos(th));
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * segments + j;
      const b = i * segments + ((j + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      if (inverted) indices.push(a, b, c, b, d, c);
      else indices.push(a, c, b, b, c, d);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * Surface of revolution around +z: a stump on a flat ground plane, from the
 * profile (radius, height) pairs listed from the top centre outward. Returns
 * the mesh plus the profile ring index of each vertex (ring 0 = apex).
 */
export function revolutionMesh(profile: Array<[number, number]>, segments = 96): { mesh: IndexedMesh; ringOf: Int32Array } {
  const positions: number[] = [];
  const ringOf: number[] = [];
  // Apex.
  positions.push(0, 0, profile[0]![1]);
  ringOf.push(0);
  for (let r = 1; r < profile.length; r++) {
    const [rad, h] = profile[r]!;
    for (let j = 0; j < segments; j++) {
      const ph = (2 * Math.PI * j) / segments;
      positions.push(rad * Math.cos(ph), rad * Math.sin(ph), h);
      ringOf.push(r);
    }
  }
  const indices: number[] = [];
  const vid = (r: number, j: number) => (r === 0 ? 0 : 1 + (r - 1) * segments + (j % segments));
  for (let j = 0; j < segments; j++) indices.push(0, vid(1, j), vid(1, j + 1));
  for (let r = 1; r < profile.length - 1; r++) {
    for (let j = 0; j < segments; j++) {
      const a = vid(r, j), b = vid(r, j + 1), c = vid(r + 1, j), d = vid(r + 1, j + 1);
      indices.push(a, c, b, b, c, d);
    }
  }
  return { mesh: { positions: new Float32Array(positions), indices: new Uint32Array(indices) }, ringOf: new Int32Array(ringOf) };
}
