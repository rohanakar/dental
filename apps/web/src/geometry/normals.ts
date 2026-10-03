import type { IndexedMesh } from './mesh';

/**
 * Area-weighted vertex normals: each face contributes its unnormalized
 * cross product (length = 2 × area) to its three vertices.
 */
export function computeVertexNormals(mesh: IndexedMesh): Float32Array {
  const p = mesh.positions;
  const idx = mesh.indices;
  const normals = new Float32Array(p.length);
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f]! * 3, b = idx[f + 1]! * 3, c = idx[f + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      normals[v] = normals[v]! + nx;
      normals[v + 1] = normals[v + 1]! + ny;
      normals[v + 2] = normals[v + 2]! + nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
    if (len > 0) {
      normals[i] = normals[i]! / len;
      normals[i + 1] = normals[i + 1]! / len;
      normals[i + 2] = normals[i + 2]! / len;
    }
  }
  return normals;
}
