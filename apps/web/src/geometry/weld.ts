import type { IndexedMesh, TriangleSoup } from './mesh';

/**
 * Exact vertex welding: vertices are merged only when their float32 bit
 * patterns match (with -0 treated as +0). STL files repeat each shared vertex
 * bit-identically, so this is enough and avoids tolerance-based false merges.
 *
 * Uses an open-addressing hash table over the raw bits; no string keys, so
 * it handles millions of vertices quickly.
 */
export interface WeldResult {
  /** For each input vertex, its index in the welded vertex array. */
  remap: Uint32Array;
  /** For each welded vertex, the first input vertex it came from. */
  firstSource: Uint32Array;
  count: number;
}

const NEG_ZERO_BITS = 0x80000000;

export function weldPositions(positions: Float32Array): WeldResult {
  const n = positions.length / 3;
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  let size = 1;
  while (size < n * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1); // stores welded index
  const remap = new Uint32Array(n);
  const firstSource = new Uint32Array(n);
  let count = 0;

  for (let v = 0; v < n; v++) {
    let x = bits[v * 3]!;
    let y = bits[v * 3 + 1]!;
    let z = bits[v * 3 + 2]!;
    if (x === NEG_ZERO_BITS) x = 0;
    if (y === NEG_ZERO_BITS) y = 0;
    if (z === NEG_ZERO_BITS) z = 0;
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
    h = (h ^ (h >>> 16)) & mask;
    for (;;) {
      const slot = table[h]!;
      if (slot === -1) {
        table[h] = count;
        firstSource[count] = v;
        remap[v] = count++;
        break;
      }
      const s = firstSource[slot]! * 3;
      let sx = bits[s]!, sy = bits[s + 1]!, sz = bits[s + 2]!;
      if (sx === NEG_ZERO_BITS) sx = 0;
      if (sy === NEG_ZERO_BITS) sy = 0;
      if (sz === NEG_ZERO_BITS) sz = 0;
      if (sx === x && sy === y && sz === z) {
        remap[v] = slot;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return { remap, firstSource: firstSource.slice(0, count), count };
}

/** Weld an STL triangle soup into an indexed mesh. */
export function weldSoup(soup: TriangleSoup): IndexedMesh {
  const { remap, firstSource, count } = weldPositions(soup.positions);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const s = firstSource[i]! * 3;
    positions[i * 3] = soup.positions[s]!;
    positions[i * 3 + 1] = soup.positions[s + 1]!;
    positions[i * 3 + 2] = soup.positions[s + 2]!;
  }
  // Soup vertex k belongs to triangle floor(k/3), so remap is the index buffer.
  return { positions, indices: remap };
}

/** Merge bit-identical duplicate vertices of an already indexed mesh (keeps the first color). */
export function weldIndexed(mesh: IndexedMesh): IndexedMesh {
  const { remap, firstSource, count } = weldPositions(mesh.positions);
  if (count === mesh.positions.length / 3) return mesh;
  const positions = new Float32Array(count * 3);
  const colors = mesh.colors ? new Uint8Array(count * 3) : undefined;
  for (let i = 0; i < count; i++) {
    const s = firstSource[i]! * 3;
    positions[i * 3] = mesh.positions[s]!;
    positions[i * 3 + 1] = mesh.positions[s + 1]!;
    positions[i * 3 + 2] = mesh.positions[s + 2]!;
    if (colors && mesh.colors) {
      colors[i * 3] = mesh.colors[s]!;
      colors[i * 3 + 1] = mesh.colors[s + 1]!;
      colors[i * 3 + 2] = mesh.colors[s + 2]!;
    }
  }
  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = remap[mesh.indices[i]!]!;
  return { positions, indices, colors };
}
