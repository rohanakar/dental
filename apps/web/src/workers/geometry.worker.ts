/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { processScan } from '../geometry/processScan';
import { writePly } from '../geometry/ply';
import { syntheticArch } from '../geometry/synthetic';
import { buildScanPayload, type ScanPayload } from './scanPayload';

const api = {
  /** Import a scan file. `bytes` is transferred in; buffers are transferred back. */
  async importScan(bytes: ArrayBuffer, fileName: string): Promise<ScanPayload> {
    const processed = await processScan(new Uint8Array(bytes), fileName);
    const { payload, transfer } = buildScanPayload(processed);
    return Comlink.transfer(payload, transfer);
  },

  /** Synthetic demo arch (~1M triangles for the lower jaw), run through the full import pipeline. */
  async demoScan(jaw: 'lower' | 'upper'): Promise<ScanPayload> {
    const mesh = syntheticArch({ jaw, along: jaw === 'lower' ? 1000 : 600, across: jaw === 'lower' ? 500 : 250, colors: true });
    const bytes = writePly(mesh);
    const processed = await processScan(bytes, `demo-${jaw}.ply`);
    const { payload, transfer } = buildScanPayload(processed);
    return Comlink.transfer(payload, transfer);
  },
};

export type GeometryWorkerApi = typeof api;

Comlink.expose(api);
