import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { implantLibraryFiles, loadImplantLibrary, type ImplantLibrary } from './implantLibrary';

/**
 * Node-only implant library I/O (tools, the pipeline runner, tests). Kept out
 * of geometry/index.ts so node:fs never reaches the browser bundle; the
 * browser uses implantLibraryFromBuffers or loadImplantLibrary with fetch.
 */

/** Load and validate a library directory (library.json plus the STL files it names). */
export async function loadImplantLibraryDir(dir: string): Promise<ImplantLibrary> {
  return loadImplantLibrary(async (path) => new Uint8Array(await readFile(join(dir, path))));
}

/** Write a library as a directory; returns the written paths. */
export async function writeImplantLibraryDir(library: ImplantLibrary, dir: string): Promise<string[]> {
  const written: string[] = [];
  for (const [path, bytes] of Object.entries(implantLibraryFiles(library))) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    written.push(target);
  }
  return written;
}
