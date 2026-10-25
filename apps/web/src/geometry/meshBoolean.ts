import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { IndexedMesh } from './mesh';
import { validateClosedMesh } from './meshValidate';

/**
 * Mesh booleans (union, difference) on closed solids, backed by manifold-3d
 * (WASM). The engine loads once, asynchronously and lazily:
 *
 * - Node (vitest, pipeline runner): `await initMeshBoolean()`; the package
 *   finds `manifold.wasm` next to its own module.
 * - Geometry Web Worker: `await initMeshBoolean({ wasmUrl })` with the
 *   Vite-resolved asset URL (`import wasmUrl from 'manifold-3d/manifold.wasm?url'`),
 *   see `workers/geometry.worker.ts`.
 *
 * Only this module touches manifold-3d, through a dynamic import, so the
 * library and its WASM never enter the main bundle. After init the boolean
 * calls are synchronous. Inputs and outputs are this repo's IndexedMesh (mm,
 * counter-clockwise triangles seen from outside, positive signed volume).
 */

export interface MeshBooleanInit {
  /** URL of manifold.wasm (browser/worker). Omit in Node. */
  wasmUrl?: string;
}

/**
 * After a boolean the result is simplified within this distance (mm): the
 * float32 output rounds new vertices by ~2–4e-6 mm at arch coordinates, the
 * same order as manifold's own tolerance, which can leave micron-sized
 * slivers that cross a neighbour (a false self-intersection for the
 * printability check). 0.1 µm is far below scan accuracy and the 0.005 mm
 * seating tolerance.
 */
const SIMPLIFY_MM = 1e-4;

let engine: ManifoldToplevel | null = null;
let loading: Promise<ManifoldToplevel> | null = null;

/** Load and set up the WASM engine once. Safe to call repeatedly or concurrently; a failed load can be retried. */
export async function initMeshBoolean(opts: MeshBooleanInit = {}): Promise<void> {
  if (engine) return;
  loading ??= (async () => {
    const { default: Module } = await import('manifold-3d');
    const wasmUrl = opts.wasmUrl;
    const wasm = await Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
    wasm.setup();
    return wasm;
  })();
  try {
    engine = await loading;
  } catch (error) {
    loading = null;
    throw error;
  }
}

/** True once initMeshBoolean has finished. */
export const meshBooleanReady = (): boolean => engine !== null;

function requireEngine(): ManifoldToplevel {
  if (!engine) throw new Error('Mesh booleans are not initialized: await initMeshBoolean() first');
  return engine;
}

/** Throws a readable error unless the mesh is a closed, consistently oriented solid with positive volume. */
function assertClosedSolid(mesh: IndexedMesh, label: string): void {
  const v = validateClosedMesh(mesh);
  if (v.triangles === 0) throw new Error(`${label} is empty`);
  if (!v.closed || !v.oriented) {
    throw new Error(
      `${label} is not a closed solid (${v.boundaryEdges} boundary, ${v.nonManifoldEdges} non-manifold, ` +
        `${v.inconsistentEdges} inconsistently wound edges)`,
    );
  }
  if (!(v.signedVolumeMm3 > 0)) throw new Error(`${label} is inside out (signed volume ${v.signedVolumeMm3.toFixed(3)} mm³)`);
}

/** Run `op` on Manifold copies of the meshes, delete every WASM object it created, and return the result as an IndexedMesh. */
function withManifolds(meshes: IndexedMesh[], labels: string[], op: (wasm: ManifoldToplevel, solids: Manifold[]) => Manifold): IndexedMesh {
  const wasm = requireEngine();
  meshes.forEach((mesh, i) => assertClosedSolid(mesh, labels[i]!));
  const owned: Manifold[] = [];
  try {
    const solids = meshes.map((mesh, i) => {
      const input = new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices });
      try {
        const solid = new wasm.Manifold(input);
        owned.push(solid);
        return solid;
      } catch (error) {
        throw new Error(`${labels[i]} was rejected by the boolean engine: ${(error as Error).message}`);
      }
    });
    const raw = op(wasm, solids);
    owned.push(raw);
    const status = raw.status();
    if (status !== 'NoError') throw new Error(`Mesh boolean failed: ${status}`);
    const result = raw.simplify(SIMPLIFY_MM);
    owned.push(result);
    return fromManifoldMesh(result.getMesh());
  } finally {
    for (const m of new Set(owned)) m.delete();
  }
}

/** Positions-only manifold-3d mesh → welded IndexedMesh (copies out of WASM-owned arrays). */
function fromManifoldMesh(mesh: { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array; mergeFromVert?: Uint32Array; mergeToVert?: Uint32Array }): IndexedMesh {
  const np = mesh.numProp;
  const nv = mesh.vertProperties.length / np;
  // Property vertices split along property seams share a position; with positions only there are none, but honour the merge vectors anyway.
  const target = new Uint32Array(nv);
  for (let v = 0; v < nv; v++) target[v] = v;
  const from = mesh.mergeFromVert, to = mesh.mergeToVert;
  if (from && to) for (let k = 0; k < from.length; k++) target[from[k]!] = to[k]!;
  const remap = new Int32Array(nv).fill(-1);
  let count = 0;
  for (let v = 0; v < nv; v++) if (target[v] === v) remap[v] = count++;
  const positions = new Float32Array(count * 3);
  for (let v = 0; v < nv; v++) {
    const r = remap[v]!;
    if (r < 0) continue;
    positions[r * 3] = mesh.vertProperties[v * np]!;
    positions[r * 3 + 1] = mesh.vertProperties[v * np + 1]!;
    positions[r * 3 + 2] = mesh.vertProperties[v * np + 2]!;
  }
  const indices = new Uint32Array(mesh.triVerts.length);
  for (let i = 0; i < indices.length; i++) indices[i] = remap[target[mesh.triVerts[i]!]!]!;
  return { positions, indices };
}

/**
 * Boolean union of closed solids (e.g. a bridge's retainers, pontics and
 * connectors) into one closed, welded, outward-oriented mesh. Throws if an
 * input is not a closed oriented solid (validateClosedMesh) or the engine
 * fails. Disjoint inputs stay separate shells: check meshTopology(result).
 */
export function unionMeshes(meshes: IndexedMesh[]): IndexedMesh {
  if (meshes.length === 0) throw new Error('unionMeshes needs at least one mesh');
  const labels = meshes.map((_, i) => `Union input ${i + 1} of ${meshes.length}`);
  return withManifolds(meshes, labels, (wasm, solids) => (solids.length === 1 ? solids[0]! : wasm.Manifold.union(solids)));
}

/** Boolean difference a − b of two closed solids; same guarantees and errors as unionMeshes. */
export function differenceMeshes(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  return withManifolds([a, b], ['Difference operand A', 'Difference operand B'], (wasm, [sa, sb]) => wasm.Manifold.difference(sa!, sb!));
}
