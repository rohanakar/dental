import * as Comlink from 'comlink';
import type { BufferGeometry } from 'three';
import type { GeometryWorkerApi } from './geometry.worker';
import { LatestWins } from './latestWins';
import { geometryFromPayload, type ScanPayload } from './scanPayload';

export interface LoadedScan {
  geometry: BufferGeometry;
  payload: Omit<ScanPayload, 'positions' | 'normals' | 'colors' | 'bvh'>;
}

let remote: Comlink.Remote<GeometryWorkerApi> | null = null;

function geometryWorker(): Comlink.Remote<GeometryWorkerApi> {
  if (!remote) {
    const worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module', name: 'geometry' });
    remote = Comlink.wrap<GeometryWorkerApi>(worker);
  }
  return remote;
}

const latest = new LatestWins();

function toLoaded(payload: ScanPayload): LoadedScan {
  const geometry = geometryFromPayload(payload);
  const { positions: _p, normals: _n, colors: _c, bvh: _b, ...rest } = payload;
  return { geometry, payload: rest };
}

/**
 * Import a scan file in the geometry worker. Calls with the same key are
 * "latest wins": a superseded import rejects with StaleResultError.
 */
export async function importScanFile(file: File, key: string): Promise<LoadedScan> {
  const bytes = await file.arrayBuffer();
  const payload = await latest.run(key, () => geometryWorker().importScan(Comlink.transfer(bytes, [bytes]), file.name));
  return toLoaded(payload);
}

export async function importDemoScan(jaw: 'lower' | 'upper', key: string): Promise<LoadedScan> {
  const payload = await latest.run(key, () => geometryWorker().demoScan(jaw));
  return toLoaded(payload);
}

export const cancelImport = (key: string): void => latest.cancel(key);
