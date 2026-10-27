import * as Comlink from 'comlink';
import type { BufferGeometry } from 'three';
import type { MarginLineKind } from '../geometry/livewire';
import type { PrepFinding } from '../geometry/prepFinder';
import type { GeometryWorkerApi } from './geometry.worker';
import type {
  AutoMarginRequest,
  AutoMarginResult,
  AxisAnalysis,
  AxisRequest,
  BridgeAxisRequest,
  BridgeAxisResult,
  BridgeFramesRequest,
  BridgeFramesResult,
  BridgeRequest,
  BridgeResultView,
  CrownRequest,
  CrownResult,
  FocusFacesRequest,
  FrameEstimate,
  FrameRequest,
  MarginDoubtView,
  NaturalMarginRequest,
  NaturalMarginView,
  ImplantEntryView,
  ImplantPathRequest,
  ImplantPathView,
  MarginTrace,
  ScanBodyRequest,
  ScanBodyResult,
  ScrewChannelProposal,
  SurfaceInfo,
  V3,
  WingOutlineRequest,
  WingOutlineView,
} from './analysisTypes';
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
  /** Crown preps on a jaw scan, computed once per scan in the worker (never superseded). */
  findPreps: (jawSha: string, antagonistSha?: string): Promise<PrepFinding> => geometryWorker().findPreps(jawSha, antagonistSha),
  estimateFrame: (request: FrameRequest): Promise<FrameEstimate> => latest.run('frame', () => geometryWorker().estimateFrame(request)),
  /** Live-wire shortest-path tree from one vertex: predecessor per vertex (-1 = none). */
  liveWireTree: (sha: string, source: number, line: MarginLineKind = 'finish'): Promise<Int32Array> =>
    latest.run('livewire', () => geometryWorker().liveWireTree(sha, source, line)),
  traceMargin: (sha: string, anchors: V3[], line: MarginLineKind = 'finish'): Promise<MarginTrace> =>
    latest.run('margin', () => geometryWorker().traceMargin(sha, anchors, line)),
  smoothMargin: (sha: string, points: Float32Array, iterations: number): Promise<Float32Array> =>
    latest.run('margin', () => geometryWorker().smoothMargin(sha, points, iterations)),
  axis: (request: AxisRequest): Promise<AxisAnalysis> => latest.run('axis', () => geometryWorker().axisAnalysis(request)),
  releaseScan: (sha: string): Promise<void> => geometryWorker().releaseScan(sha),
  designCrown: (request: CrownRequest): Promise<CrownResult> =>
    latest.run('crown', () => (request.implant ? geometryWorker().designImplantCrown(request) : geometryWorker().designCrown(request))),
  /** Automatic margin (never superseded: used by the auto-design orchestrator). */
  autoMargin: (request: AutoMarginRequest): Promise<AutoMarginResult> => geometryWorker().autoMargin(request),
  /** The open live-wire path through waypoints, for a local margin edit (never superseded: each edit waits for it). */
  traceOpen: (sha: string, waypoints: V3[], line: MarginLineKind = 'finish'): Promise<Float32Array> => geometryWorker().traceOpen(sha, waypoints, line),
  /** The scan's profile under the cursor, across the margin (latest wins: the cursor moves on). */
  crossSection: (sha: string, centre: V3, up: V3, across: V3, halfMm: number): Promise<Float32Array> =>
    latest.run('section', () => geometryWorker().crossSection(sha, centre, up, across, halfMm)),
  /** Where a margin is doubtful (latest wins: only the current line matters). */
  marginDoubt: (sha: string, points: Float32Array, up: V3, line: MarginLineKind): Promise<MarginDoubtView> =>
    latest.run('doubt', () => geometryWorker().marginDoubt(sha, points, up, line)),
  /** Points moved up (or down) the tooth along the scan: the margin's offset. */
  offsetPoints: (sha: string, points: Float32Array, frame: { origin: V3; up: V3 }, mm: number): Promise<Float32Array> =>
    geometryWorker().offsetPoints(sha, points, frame, mm),
  /** A natural tooth's gum line (never superseded: used by the margin proposer and the Margin step's Find). */
  naturalMargin: (request: NaturalMarginRequest): Promise<NaturalMarginView> => geometryWorker().naturalMargin(request),
  /** Automatic Maryland wing outline (classical.wing-outline; never superseded). */
  wingOutline: (request: WingOutlineRequest): Promise<WingOutlineView> => geometryWorker().wingOutline(request),
  /** Frame/axis without "latest wins", so interactive tools cannot cancel an orchestrator run. */
  estimateFrameUnlatched: (request: FrameRequest): Promise<FrameEstimate> => geometryWorker().estimateFrame(request),
  axisUnlatched: (request: AxisRequest): Promise<AxisAnalysis> => geometryWorker().axisAnalysis(request),
  /** Like designCrown but never superseded (independent evaluations, e.g. metrics). */
  designCrownUnlatched: (request: CrownRequest): Promise<CrownResult> =>
    request.implant ? geometryWorker().designImplantCrown(request) : geometryWorker().designCrown(request),
  /** Load the mesh-boolean engine in the worker (once). */
  initBooleans: (): Promise<{ ms: number }> => geometryWorker().initBooleans(),
  /** Prep faces drawn in focus while the crown is adjusted. */
  focusFaces: (request: FocusFacesRequest): Promise<Uint32Array> => latest.run('focus', () => geometryWorker().focusFaces(request)),
  /** Bridge: the common insertion axis over the abutments (store it on every abutment with setAxis). */
  bridgeAxis: (request: BridgeAxisRequest): Promise<BridgeAxisResult> => latest.run('bridgeAxis', () => geometryWorker().bridgeAxis(request)),
  /** Bridge Frame step: pontic frames on the arch curve, and the abutment frames aligned to it. */
  bridgeFrames: (request: BridgeFramesRequest): Promise<BridgeFramesResult> => latest.run('bridgeFrames', () => geometryWorker().bridgeFrames(request)),
  /** One bridge: every unit and connector (cached per unit), plus the union and its checks with `union: true`. */
  designBridge: (request: BridgeRequest): Promise<BridgeResultView> => latest.run('bridge', () => geometryWorker().designBridge(request)),
  /** Like designBridge but never superseded (proposals, QA, export). */
  designBridgeUnlatched: (request: BridgeRequest): Promise<BridgeResultView> => geometryWorker().designBridge(request),
  bridgeAxisUnlatched: (request: BridgeAxisRequest): Promise<BridgeAxisResult> => geometryWorker().bridgeAxis(request),
  bridgeFramesUnlatched: (request: BridgeFramesRequest): Promise<BridgeFramesResult> => geometryWorker().bridgeFrames(request),
  /** Implants: the library entries (synthetic generic library). */
  implantLibrary: (): Promise<ImplantEntryView[]> => geometryWorker().implantLibrary(),
  /** Implant position step: match the library scan body from a click on the scanned one's top. */
  registerScanBody: (request: ScanBodyRequest): Promise<ScanBodyResult> => latest.run('scanBody', () => geometryWorker().registerScanBody(request)),
  /** Like registerScanBody but never superseded (classical.scan-body-match in auto-design). */
  registerScanBodyUnlatched: (request: ScanBodyRequest): Promise<ScanBodyResult> => geometryWorker().registerScanBody(request),
  /** Implant bridges: the common path over the implant axes, with the divergence check. */
  implantPath: (request: ImplantPathRequest): Promise<ImplantPathView> => geometryWorker().implantPath(request),
  /** classical.screw-channel: straight, or the smallest ASC angle with an occlusal (lingual) exit and enough wall. */
  screwChannelAuto: (request: CrownRequest): Promise<ScrewChannelProposal> => geometryWorker().screwChannelAuto(request),
};
