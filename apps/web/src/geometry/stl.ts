import type { IndexedMesh, TriangleSoup } from './mesh';

const BINARY_HEADER = 80;
const BINARY_FACE = 50;

/**
 * Binary STL is detected by size: header + count + 50 bytes per face must
 * match exactly. Some binary files start with "solid" in the header, so the
 * text prefix alone is not reliable.
 */
export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength < BINARY_HEADER + 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const faces = view.getUint32(BINARY_HEADER, true);
  if (BINARY_HEADER + 4 + faces * BINARY_FACE === bytes.byteLength) return true;
  const head = new TextDecoder().decode(bytes.subarray(0, 5)).toLowerCase();
  return head !== 'solid';
}

export function parseStl(bytes: Uint8Array): TriangleSoup {
  return isBinaryStl(bytes) ? parseBinaryStl(bytes) : parseAsciiStl(bytes);
}

function parseBinaryStl(bytes: Uint8Array): TriangleSoup {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(BINARY_HEADER, true);
  const available = Math.floor((bytes.byteLength - BINARY_HEADER - 4) / BINARY_FACE);
  const faces = Math.min(declared, available);
  const positions = new Float32Array(faces * 9);
  let o = BINARY_HEADER + 4;
  for (let f = 0; f < faces; f++) {
    o += 12; // skip facet normal; recomputed from geometry
    for (let k = 0; k < 9; k++) {
      positions[f * 9 + k] = view.getFloat32(o, true);
      o += 4;
    }
    o += 2; // attribute byte count
  }
  return { positions };
}

function parseAsciiStl(bytes: Uint8Array): TriangleSoup {
  const text = new TextDecoder().decode(bytes);
  const out: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const usable = out.length - (out.length % 9);
  return { positions: new Float32Array(out.slice(0, usable)) };
}

/** Binary STL writer (facet normals computed per triangle). */
export function writeBinaryStl(mesh: IndexedMesh, header = 'dcad'): Uint8Array {
  const faces = mesh.indices.length / 3;
  const bytes = new Uint8Array(BINARY_HEADER + 4 + faces * BINARY_FACE);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(header.slice(0, BINARY_HEADER)));
  view.setUint32(BINARY_HEADER, faces, true);
  const p = mesh.positions;
  let o = BINARY_HEADER + 4;
  for (let f = 0; f < faces; f++) {
    const a = mesh.indices[f * 3]! * 3;
    const b = mesh.indices[f * 3 + 1]! * 3;
    const c = mesh.indices[f * 3 + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const value of [nx, ny, nz, p[a]!, p[a + 1]!, p[a + 2]!, p[b]!, p[b + 1]!, p[b + 2]!, p[c]!, p[c + 1]!, p[c + 2]!]) {
      view.setFloat32(o, value, true);
      o += 4;
    }
    o += 2;
  }
  return bytes;
}
