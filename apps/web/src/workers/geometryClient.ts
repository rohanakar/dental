import * as Comlink from 'comlink';
import type { BufferGeometry } from 'three';
import type { GeometryWorkerApi } from './geometry.worker';
import type { AutoMarginRequest, AutoMarginResult, AxisAnalysis, AxisRequest, CrownRequest, CrownResult, FrameEstimate, FrameRequest, MarginTrace, SurfaceInfo, V3 } from './analysisTypes';
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

/** Import already-fetched bytes (e.g. a scan downloaded from the backend). */
export async function importScanBytes(bytes: ArrayBuffer, name: string, key: string): Promise<LoadedScan> {
  const payload = await latest.run(key, () => geometryWorker().importScan(Comlink.transfer(bytes, [bytes]), name));
  return toLoaded(payload);
}

/** Synthetic demo arch. `source` holds the generated PLY bytes (for upload). */
export async function importDemoScan(jaw: 'lower' | 'upper', key: string): Promise<LoadedScan & { source: Uint8Array }> {
  const { payload, source } = await latest.run(key, () => geometryWorker().demoScan(jaw));
  return { ...toLoaded(payload), source };
}

export const cancelImport = (key: string): void => latest.cancel(key);

/**
 * Analysis on scans retained by the worker (see scanRegistry.ts). Calls that
 * run per pointer action use "latest wins" keys, so only the newest result
 * is applied.
 */
export const analysis = {
  analyzeSurface: (sha: string): Promise<SurfaceInfo> => geometryWorker().analyzeSurface(sha),
  estimateFrame: (request: FrameRequest): Promise<FrameEstimate> => latest.run('frame', () => geometryWorker().estimateFrame(request)),
  /** Live-wire shortest-path tree from one vertex: predecessor per vertex (-1 = none). */
  liveWireTree: (sha: string, source: number): Promise<Int32Array> => latest.run('livewire', () => geometryWorker().liveWireTree(sha, source)),
  traceMargin: (sha: string, anchors: V3[]): Promise<MarginTrace> => latest.run('margin', () => geometryWorker().traceMargin(sha, anchors)),
  smoothMargin: (sha: string, points: Float32Array, iterations: number): Promise<Float32Array> =>
    latest.run('margin', () => geometryWorker().smoothMargin(sha, points, iterations)),
  axis: (request: AxisRequest): Promise<AxisAnalysis> => latest.run('axis', () => geometryWorker().axisAnalysis(request)),
  releaseScan: (sha: string): Promise<void> => geometryWorker().releaseScan(sha),
  designCrown: (request: CrownRequest): Promise<CrownResult> => latest.run('crown', () => geometryWorker().designCrown(request)),
  /** Automatic margin (never superseded: used by the auto-design orchestrator). */
  autoMargin: (request: AutoMarginRequest): Promise<AutoMarginResult> => geometryWorker().autoMargin(request),
  /** Frame/axis without "latest wins", so interactive tools cannot cancel an orchestrator run. */
  estimateFrameUnlatched: (request: FrameRequest): Promise<FrameEstimate> => geometryWorker().estimateFrame(request),
  axisUnlatched: (request: AxisRequest): Promise<AxisAnalysis> => geometryWorker().axisAnalysis(request),
  /** Like designCrown but never superseded (independent evaluations, e.g. metrics). */
  designCrownUnlatched: (request: CrownRequest): Promise<CrownResult> => geometryWorker().designCrown(request),
};
