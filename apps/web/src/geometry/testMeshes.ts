import type { IndexedMesh } from './mesh';

/** Unit cube as an indexed mesh (8 vertices, 12 outward-facing triangles). */
export function cube(size = 1, offset: [number, number, number] = [0, 0, 0]): IndexedMesh {
  const s = size;
  const [ox, oy, oz] = offset;
  const positions = new Float32Array([
    0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, 0, 0, s, s, 0, s, s, s, s, 0, s, s,
  ]);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! + ox;
    positions[i + 1] = positions[i + 1]! + oy;
    positions[i + 2] = positions[i + 2]! + oz;
  }
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom (-z)
    4, 5, 6, 4, 6, 7, // top (+z)
    0, 1, 5, 0, 5, 4, // front (-y)
    2, 3, 7, 2, 7, 6, // back (+y)
    1, 2, 6, 1, 6, 5, // right (+x)
    3, 0, 4, 3, 4, 7, // left (-x)
  ]);
  return { positions, indices };
}

/** Flat n×n grid in the z=0 plane, normals +z. */
export function grid(n: number, size = 10): IndexedMesh {
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const v = j * (n + 1) + i;
      positions[v * 3] = (i / n) * size;
      positions[v * 3 + 1] = (j / n) * size;
    }
  }
  const indices = new Uint32Array(n * n * 6);
  let o = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      indices.set([a, b, d, a, d, c], o);
      o += 6;
    }
  }
  return { positions, indices };
}

/** Concatenate meshes (no welding). */
export function merge(...meshes: IndexedMesh[]): IndexedMesh {
  const vtotal = meshes.reduce((n, m) => n + m.positions.length, 0);
  const itotal = meshes.reduce((n, m) => n + m.indices.length, 0);
  const positions = new Float32Array(vtotal);
  const indices = new Uint32Array(itotal);
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i]! + vo / 3;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}
