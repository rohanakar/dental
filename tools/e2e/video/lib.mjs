// Checks on the files an episode downloads, read in Node with the repo's own geometry code (run with type stripping:
// the package script passes --experimental-strip-types).
import { readFileSync } from 'node:fs';

/** The synthetic fixtures' resolution (tools/fixtures/generate.mts). */
export const ALONG = 1000;

/** A binary STL's triangle count, or 0 when the file is not one. */
export function stlTriangles(path) {
  const buf = readFileSync(path);
  if (buf.length < 84) return 0;
  const n = buf.readUInt32LE(80);
  return buf.length === 84 + 50 * n ? n : 0;
}

/** An STL as a solid: welded, then validated (closed, oriented) and its topology counted (as in bridge.mjs). */
export async function stlSolid(path) {
  const { parseStl } = await import('../../../apps/web/src/geometry/stl.ts');
  const { validateClosedMesh, meshTopology } = await import('../../../apps/web/src/geometry/meshValidate.ts');
  const soup = parseStl(new Uint8Array(readFileSync(path)));
  const ids = new Map();
  const positions = [];
  const indices = new Uint32Array(soup.positions.length / 3);
  for (let i = 0; i < indices.length; i++) {
    const key = `${soup.positions[i * 3]},${soup.positions[i * 3 + 1]},${soup.positions[i * 3 + 2]}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      ids.set(key, id);
      positions.push(soup.positions[i * 3], soup.positions[i * 3 + 1], soup.positions[i * 3 + 2]);
    }
    indices[i] = id;
  }
  const mesh = { positions: new Float32Array(positions), indices };
  const v = validateClosedMesh(mesh);
  const topo = meshTopology(mesh);
  return { triangles: v.triangles, ok: v.ok, closed: v.closed, volumeMm3: Math.round(v.signedVolumeMm3 * 10) / 10, components: topo.components, genus: topo.genus };
}
