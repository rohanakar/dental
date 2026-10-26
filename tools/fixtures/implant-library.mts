/**
 * Writes the synthetic generic implant library (no vendor geometry) into
 * data/implant-libraries/synthetic-generic@1/, then loads it back and
 * validates it:
 *
 *   pnpm --filter @dcad/web fixtures:implant      (the library and the demo scan)
 *   pnpm --filter @dcad/pipeline-runner exec tsx ../fixtures/implant-library.mts [--out <dir>] [--scan]
 *
 * --scan also writes a demo lower-jaw scan with scan bodies at 35 and 37
 * (36 missing) to data/synthetic/lower-implants-35-37.stl, with the true
 * implant poses next to it (.poses.json).
 *
 * Runs under tsx (not plain Node type stripping): the geometry modules import
 * each other without file extensions.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { implantPoseToPose } from '../../apps/web/src/geometry/implantLibrary.ts';
import { loadImplantLibraryDir, writeImplantLibraryDir } from '../../apps/web/src/geometry/implantLibraryNode.ts';
import { initMeshBoolean } from '../../apps/web/src/geometry/meshBoolean.ts';
import { writeBinaryStl } from '../../apps/web/src/geometry/stl.ts';
import { syntheticImplantLibrary, syntheticImplantScan } from '../../apps/web/src/geometry/syntheticImplant.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outIndex = process.argv.indexOf('--out');
const library = syntheticImplantLibrary();
const outDir = outIndex > 0 ? resolve(process.argv[outIndex + 1]!) : join(root, 'data', 'implant-libraries', library.id);

rmSync(outDir, { recursive: true, force: true });
for (const path of await writeImplantLibraryDir(library, outDir)) console.log(path);

// Round trip: the loader validates the manifest and every mesh (closed, oriented, shoulder loop on the Ti-base).
const loaded = await loadImplantLibraryDir(outDir);
for (const entry of loaded.entries) {
  const original = library.entries.find((e) => e.id === entry.id)!;
  const same =
    entry.scanBody.indices.length === original.scanBody.indices.length &&
    entry.tiBase.indices.length === original.tiBase.indices.length &&
    entry.shoulderLoop.length === original.shoulderLoop.length;
  if (!same) throw new Error(`Round trip changed entry ${entry.id}`);
  console.log(
    `${entry.key}: ${entry.engaging ? 'engaging' : 'non-engaging'}, scan body ${entry.scanBody.indices.length / 3} triangles ` +
      `(top ${entry.scanBodyTopZ.toFixed(2)} mm, radius ${entry.scanBodyRadiusMm.toFixed(2)} mm), ` +
      `Ti-base ${entry.tiBase.indices.length / 3} triangles (top ${entry.tiBaseTopZ.toFixed(2)} mm), loaded and valid`,
  );
}

if (process.argv.includes('--scan')) {
  await initMeshBoolean();
  const scan = syntheticImplantScan({
    jaw: 'lower',
    missing: [35, 36, 37],
    scanBodies: [
      { fdi: 35, mesialTiltDeg: 5, rotationDeg: 0 },
      { fdi: 37, mesialTiltDeg: -4, rotationDeg: 40 },
    ],
  });
  const scanDir = join(root, 'data', 'synthetic');
  mkdirSync(scanDir, { recursive: true });
  const stl = join(scanDir, 'lower-implants-35-37.stl');
  writeFileSync(stl, writeBinaryStl(scan.mesh, 'dcad synthetic lower jaw, scan bodies at 35 and 37'));
  const poses = scan.implants.map(({ fdi, pose, topCentre }) => ({ fdi, library: library.id, pose: implantPoseToPose(pose), topCentre }));
  writeFileSync(join(scanDir, 'lower-implants-35-37.poses.json'), `${JSON.stringify(poses, null, 2)}\n`);
  console.log(`${stl}  ${scan.mesh.indices.length / 3} triangles`);
}
