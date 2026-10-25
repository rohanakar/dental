/**
 * Writes synthetic (non-patient) test scans into data/synthetic/ so the
 * viewer can be tried without real scans:
 *
 *   node --experimental-strip-types tools/fixtures/generate.mts [--triangles 1000000]
 *
 * Reuses the web app's generator and writers directly (type-only imports, so
 * Node's type stripping is enough; no build step).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePly } from '../../apps/web/src/geometry/ply.ts';
import { writeBinaryStl } from '../../apps/web/src/geometry/stl.ts';
import { syntheticArch } from '../../apps/web/src/geometry/synthetic.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(root, 'data', 'synthetic');
mkdirSync(outDir, { recursive: true });

const argIndex = process.argv.indexOf('--triangles');
const targetTriangles = argIndex > 0 ? Number(process.argv[argIndex + 1]) : 1_000_000;
// Triangles = 2 × along × across with along = 2 × across.
const across = Math.max(10, Math.round(Math.sqrt(targetTriangles / 4)));
const along = across * 2;

const outputs: Array<[string, Uint8Array]> = [
  ['lower.stl', writeBinaryStl(syntheticArch({ jaw: 'lower', along, across }))],
  ['upper.stl', writeBinaryStl(syntheticArch({ jaw: 'upper', along: 600, across: 250 }))],
  // Bridge demos (antagonists: upper.stl and lower.stl): 35–[36]–37, and [12]–11–21–[22] across the midline.
  ['lower-bridge.stl', writeBinaryStl(syntheticArch({ jaw: 'lower', along, across, preps: [35, 37], missing: [36] }))],
  ['upper-anterior-bridge.stl', writeBinaryStl(syntheticArch({ jaw: 'upper', along, across, preps: [11, 21], missing: [12, 22] }))],
  ['lower-colored.ply', writePly(syntheticArch({ jaw: 'lower', along: 600, across: 250, colors: true }))],
  ['upper-colored.ply', writePly(syntheticArch({ jaw: 'upper', along: 600, across: 250, colors: true }))],
];

for (const [name, bytes] of outputs) {
  const path = join(outDir, name);
  writeFileSync(path, bytes);
  console.log(`${path}  ${(bytes.byteLength / 1e6).toFixed(1)} MB`);
}
