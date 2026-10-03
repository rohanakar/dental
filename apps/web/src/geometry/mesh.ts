/**
 * Indexed triangle mesh in millimetres. Plain typed arrays so it can be
 * transferred between workers without copying.
 */
export interface IndexedMesh {
  /** xyz per vertex. */
  positions: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
  /** Optional rgb per vertex (0-255). */
  colors?: Uint8Array;
  /** Optional unit normal per vertex. */
  normals?: Float32Array;
}

/** Unindexed triangles: 9 floats per triangle (as read from STL). */
export interface TriangleSoup {
  positions: Float32Array;
}

export const vertexCount = (m: IndexedMesh): number => m.positions.length / 3;
export const triangleCount = (m: IndexedMesh): number => m.indices.length / 3;

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function computeBounds(positions: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return { min, max };
}

export function boundsSize(b: Bounds): [number, number, number] {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

/** Drop vertices not referenced by any triangle and remap indices. */
export function compactVertices(mesh: IndexedMesh): IndexedMesh {
  const n = vertexCount(mesh);
  const remap = new Int32Array(n).fill(-1);
  let next = 0;
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i]!;
    if (remap[v] === -1) remap[v] = next++;
  }
  if (next === n) return mesh;
  const positions = new Float32Array(next * 3);
  const colors = mesh.colors ? new Uint8Array(next * 3) : undefined;
  const normals = mesh.normals ? new Float32Array(next * 3) : undefined;
  for (let v = 0; v < n; v++) {
    const r = remap[v]!;
    if (r < 0) continue;
    positions[r * 3] = mesh.positions[v * 3]!;
    positions[r * 3 + 1] = mesh.positions[v * 3 + 1]!;
    positions[r * 3 + 2] = mesh.positions[v * 3 + 2]!;
    if (colors && mesh.colors) {
      colors[r * 3] = mesh.colors[v * 3]!;
      colors[r * 3 + 1] = mesh.colors[v * 3 + 1]!;
      colors[r * 3 + 2] = mesh.colors[v * 3 + 2]!;
    }
    if (normals && mesh.normals) {
      normals[r * 3] = mesh.normals[v * 3]!;
      normals[r * 3 + 1] = mesh.normals[v * 3 + 1]!;
      normals[r * 3 + 2] = mesh.normals[v * 3 + 2]!;
    }
  }
  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = remap[mesh.indices[i]!]!;
  return { positions, indices, colors, normals };
}
