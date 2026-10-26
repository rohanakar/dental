/// <reference lib="webworker" />
import * as Comlink from 'comlink';
// Vite emits manifold.wasm as a separate asset; the boolean engine (manifold-3d) itself is a lazy chunk.
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';
import { fitArchCurve, orientArchCurve, type ArchCurve } from '../geometry/arch';
import { searchCommonAxis, searchInsertionAxis, marginUndercut, undercutDepths } from '../geometry/axis';
import { archAlignedFrame, archFitDirections, BridgeCache, designBridge, layoutPontics, type BridgeUnitInput } from '../geometry/bridge';
import {
  dijkstraTree,
  liveWireWeight,
  marginFromAnchors,
  smoothClosedPolyline,
  snapToVertex,
  traceClosedLoop,
  type EdgeWeight,
} from '../geometry/livewire';
import type { V3 } from '../geometry/pca';
import { writePly } from '../geometry/ply';
import { prepRegion, prepSeedVertex, type PrepRegion } from '../geometry/prepRegion';
import { wingRegion } from '../geometry/wingUnit';
import { processScan } from '../geometry/processScan';
import { bvhRayCaster, type RayCaster } from '../geometry/raycast';
import { analyzeSurface, smoothVertexNormals, type SurfaceAnalysis } from '../geometry/surface';
import { proposeMarginAnchors } from '../geometry/autoMargin';
import { designCrown } from '../geometry/crown';
import { initMeshBoolean } from '../geometry/meshBoolean';
import { syntheticArch } from '../geometry/synthetic';
import { estimateToothFrame } from '../geometry/toothFrame';
import type {
  AutoMarginRequest,
  AutoMarginResult,
  AxisAnalysis,
  AxisRequest,
  BridgeAxisRequest,
  BridgeAxisResult,
  BridgeConnectorView,
  BridgeFramesRequest,
  BridgeFramesResult,
  BridgeRequest,
  BridgeResultView,
  BridgeUnitView,
  CrownRequest,
  CrownResult,
  FocusFacesRequest,
  FrameEstimate,
  FrameRequest,
  MarginTrace,
  SurfaceInfo,
} from './analysisTypes';
import { frameworkView, overpressViews, singleFramework } from './frameworkView';
import { buildScanPayload, type ScanPayload } from './scanPayload';
import { createImplantApi } from './implantApi';
import { ScanRegistry, type RetainedScan } from './scanRegistry';

/** Live-wire search radius (mm) for the interactive tree; farther clicks need an intermediate anchor. */
const LIVEWIRE_RADIUS_MM = 12;

const registry = new ScanRegistry();

const rayOf = (scan: RetainedScan): RayCaster => registry.cached(scan, 'ray', () => bvhRayCaster(scan.bvh));
const surfaceOf = (scan: RetainedScan): SurfaceAnalysis =>
  registry.cached(scan, 'surface', () => analyzeSurface({ positions: scan.positions, indices: scan.indices, normals: scan.normals }));
const smoothNormalsOf = (scan: RetainedScan): Float32Array =>
  registry.cached(scan, 'smoothNormals', () => smoothVertexNormals(scan.normals, surfaceOf(scan).graph, 3));
const weightOf = (scan: RetainedScan): EdgeWeight => registry.cached(scan, 'weight', () => liveWireWeight(surfaceOf(scan).curvature));

const DEG = 180 / Math.PI;
const angleDeg = (a: V3, b: V3) => Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * DEG;

/** Cheap content key for a margin polyline, used to cache its prep region. */
function marginKey(points: Float32Array): string {
  let h = 0;
  for (let i = 0; i < points.length; i++) h = (h * 31 + Math.round(points[i]! * 1000)) | 0;
  return `${points.length}:${h}`;
}

/**
 * Prep region inside a (dense) margin: snap to vertices, close the chain, flood fill from the prep top. A Maryland
 * wing's outline is flood-filled from a seed inside it instead (wingRegion).
 */
function regionFor(scan: RetainedScan, margin: Float32Array, occlusal: V3, seed?: V3): PrepRegion & { loopVertices: Uint32Array } {
  if (seed) {
    const key = `wing-region:${marginKey(margin)}:${seed.map((x) => x.toFixed(4)).join(',')}`;
    return registry.cached(scan, key, () =>
      wingRegion({ positions: scan.positions, indices: scan.indices, graph: surfaceOf(scan).graph, weight: weightOf(scan), ray: rayOf(scan), outline: margin, seed }),
    );
  }
  return registry.cached(scan, `region:${marginKey(margin)}:${occlusal.map((x) => x.toFixed(4)).join(',')}`, () => {
    const ray = rayOf(scan);
    const { graph } = surfaceOf(scan);
    const snapped: number[] = [];
    for (let i = 0; i < margin.length; i += 3) {
      const v = snapToVertex(scan.positions, scan.indices, ray, [margin[i]!, margin[i + 1]!, margin[i + 2]!]);
      if (v !== null && snapped.at(-1) !== v) snapped.push(v);
    }
    if (snapped.length > 1 && snapped[0] === snapped.at(-1)) snapped.pop();
    const loopVertices = Uint32Array.from(traceClosedLoop(scan.positions, graph, weightOf(scan), snapped));
    const seedVertex = prepSeedVertex({ positions: scan.positions, indices: scan.indices, ray, loopVertices, occlusal });
    if (seedVertex === null) throw new Error('Could not find the prep inside the margin');
    return { ...prepRegion({ positions: scan.positions, indices: scan.indices, graph, loopVertices, seedVertex }), loopVertices };
  });
}

/** Implant crowns, the scan-body match and the synthetic implant library (implantApi.ts). */
const implants = createImplantApi({ registry, rayOf, initBooleans: () => initMeshBoolean({ wasmUrl: manifoldWasmUrl }) });

/** Bridge units and connectors by input hash, across calls: moving one unit recomputes only it and its connectors. */
const bridgeCache = new BridgeCache(64);

/**
 * The jaw's arch curve: fitted once per scan and occlusal direction (the mean of its abutments' occlusal) without a
 * buccal hint, then oriented per call by the abutments' buccal directions. The hint is not part of the cached fit, so
 * a flipped frame never gets a stale orientation.
 */
function archCurveOf(scan: RetainedScan, frames: Array<{ occlusal: V3; buccal: V3 }>): ArchCurve {
  const { occlusal, buccalHint } = archFitDirections(frames);
  const fit = registry.cached(scan, `arch:${occlusal.map((x) => x.toFixed(2)).join(',')}`, () => fitArchCurve({ positions: scan.positions, occlusal }));
  return orientArchCurve(fit, buccalHint);
}

/** Copies of a cached typed array (cached results stay intact; the copies are transferred). */
function copyOut<T extends Float32Array | Uint32Array>(array: T, transfer: ArrayBuffer[]): T {
  const copy = array.slice() as T;
  transfer.push(copy.buffer as ArrayBuffer);
  return copy;
}

function importPayload(processed: Awaited<ReturnType<typeof processScan>>) {
  const { payload, transfer } = buildScanPayload(processed);
  // Keep a worker-side copy (and BVH) before the buffers are transferred away.
  registry.retain(payload);
  return { payload, transfer };
}

const api = {
  /** Import a scan file. `bytes` is transferred in; buffers are transferred back. */
  async importScan(bytes: ArrayBuffer, fileName: string): Promise<ScanPayload> {
    const { payload, transfer } = importPayload(await processScan(new Uint8Array(bytes), fileName));
    return Comlink.transfer(payload, transfer);
  },

  /**
   * Synthetic demo arch (~1M triangles for the lower jaw), run through the
   * full import pipeline. Also returns the generated PLY bytes so the demo can
   * be uploaded to a case like any other scan.
   */
  async demoScan(jaw: 'lower' | 'upper'): Promise<{ payload: ScanPayload; source: Uint8Array }> {
    const mesh = syntheticArch({ jaw, along: jaw === 'lower' ? 1000 : 600, across: jaw === 'lower' ? 500 : 250, colors: true });
    const bytes = writePly(mesh);
    // Copy before processing: parsed arrays may be views into `bytes`, and a buffer can only be transferred once.
    const source = bytes.slice();
    const { payload, transfer } = importPayload(await processScan(bytes, `demo-${jaw}.ply`));
    return Comlink.transfer({ payload, source }, [...transfer, source.buffer as ArrayBuffer]);
  },

  /**
   * Load the mesh-boolean engine once (fetches the manifold-3d chunk and its
   * WASM). Worker code that merges solids awaits this before calling
   * unionMeshes/differenceMeshes; calling it early hides the load time.
   */
  async initBooleans(): Promise<{ ms: number }> {
    const t0 = performance.now();
    await initMeshBoolean({ wasmUrl: manifoldWasmUrl });
    return { ms: performance.now() - t0 };
  },

  releaseScan(sha256: string): void {
    registry.release(sha256);
    bridgeCache.clear();
  },

  /** Adjacency + signed curvature (cached); warms the live-wire. */
  analyzeSurface(sha256: string): SurfaceInfo {
    const scan = registry.get(sha256);
    const t0 = performance.now();
    surfaceOf(scan);
    return { vertices: scan.positions.length / 3, ms: performance.now() - t0 };
  },

  estimateFrame(request: FrameRequest): FrameEstimate {
    const jaw = registry.get(request.jawSha);
    const antagonist = request.antagonistSha && registry.has(request.antagonistSha) ? registry.get(request.antagonistSha) : null;
    return estimateToothFrame({
      jaw: { positions: jaw.positions, normals: jaw.normals },
      antagonist: antagonist ? { positions: antagonist.positions } : undefined,
      seed: request.seed,
      fdi: request.fdi,
      ray: rayOf(jaw),
    }) as FrameEstimate;
  },

  /** Bounded live-wire tree from one vertex; the main thread looks up paths to the cursor in it. */
  liveWireTree(sha256: string, source: number): Int32Array {
    const scan = registry.get(sha256);
    const { graph } = surfaceOf(scan);
    const { pred } = dijkstraTree(scan.positions, graph, weightOf(scan), source, LIVEWIRE_RADIUS_MM);
    return Comlink.transfer(pred, [pred.buffer as ArrayBuffer]);
  },

  traceMargin(sha256: string, anchors: V3[]): MarginTrace {
    const scan = registry.get(sha256);
    const trace = marginFromAnchors({
      positions: scan.positions,
      indices: scan.indices,
      graph: surfaceOf(scan).graph,
      weight: weightOf(scan),
      ray: rayOf(scan),
      anchors,
    });
    const result: MarginTrace = { points: trace.points, anchorVertices: trace.anchorVertices, lengthMm: trace.lengthMm };
    return Comlink.transfer(result, [trace.points.buffer as ArrayBuffer]);
  },

  /** Automatic margin: ridge anchors on radial profiles from the prep top, closed by the live-wire. */
  autoMargin(request: AutoMarginRequest): AutoMarginResult {
    const t0 = performance.now();
    const scan = registry.get(request.jawSha);
    const ray = rayOf(scan);
    const proposal = proposeMarginAnchors({ positions: scan.positions, indices: scan.indices, ray, frame: request.frame });
    if (proposal.anchors.length < 3) throw new Error('No margin ridge found around the prep (check the tooth frame)');
    const trace = marginFromAnchors({
      positions: scan.positions,
      indices: scan.indices,
      graph: surfaceOf(scan).graph,
      weight: weightOf(scan),
      ray,
      anchors: proposal.anchors,
    });
    const result: AutoMarginResult = {
      points: trace.points,
      anchorVertices: trace.anchorVertices,
      lengthMm: trace.lengthMm,
      anchors: proposal.anchors,
      confidence: proposal.confidence,
      ms: performance.now() - t0,
    };
    return Comlink.transfer(result, [trace.points.buffer as ArrayBuffer]);
  },

  smoothMargin(sha256: string, points: Float32Array, iterations: number): Float32Array {
    const ray = rayOf(registry.get(sha256));
    const smoothed = smoothClosedPolyline(points, iterations, (p) => ray.closestPoint(p, 1)?.point ?? p);
    return Comlink.transfer(smoothed, [smoothed.buffer as ArrayBuffer]);
  },

  /** Least-undercut axis (when no direction is given), undercut map and margin-undercut flags. */
  axisAnalysis(request: AxisRequest): AxisAnalysis {
    const t0 = performance.now();
    const scan = registry.get(request.jawSha);
    const ray = rayOf(scan);
    const region = regionFor(scan, request.margin, request.occlusal, request.seed);
    const base = { positions: scan.positions, indices: scan.indices, faceMask: region.faceMask };
    let direction: V3;
    let undercutAreaMm2: number;
    if (request.direction) {
      direction = request.direction;
      // A zero cone evaluates the cost at exactly this direction.
      undercutAreaMm2 = searchInsertionAxis({ ...base, center: direction, coneDeg: 0, samples: 1 }).centerUndercutAreaMm2;
    } else {
      const found = searchInsertionAxis({ ...base, center: request.occlusal });
      direction = found.direction;
      undercutAreaMm2 = found.undercutAreaMm2;
    }
    const depths = undercutDepths({ ...base, vertexMask: region.vertexMask, axis: direction, ray });
    let maxDepthMm = 0;
    for (const d of depths) if (d > maxDepthMm) maxDepthMm = d;
    const { flags, count } = marginUndercut({ points: request.margin, axis: direction, ray, faceMask: region.faceMask });
    const result: AxisAnalysis = {
      direction,
      angleFromOcclusalDeg: angleDeg(direction, request.occlusal),
      undercutAreaMm2,
      depths,
      maxDepthMm,
      marginFlags: flags,
      marginUndercutCount: count,
      prepClosed: region.closed,
      ms: performance.now() - t0,
    };
    return Comlink.transfer(result, [depths.buffer as ArrayBuffer, flags.buffer as ArrayBuffer]);
  },

  /** Crown for the current design inputs (intaglio + placed template + margin band), validated. */
  async designCrown(request: CrownRequest): Promise<CrownResult> {
    const t0 = performance.now();
    if (request.cutback?.overpress && request.overpress) await initMeshBoolean({ wasmUrl: manifoldWasmUrl });
    const scan = registry.get(request.jawSha);
    const antagonist = request.antagonistSha && registry.has(request.antagonistSha) ? registry.get(request.antagonistSha) : null;
    const region = regionFor(scan, request.margin, request.frame.occlusal);
    if (!region.closed) throw new Error('The prep region is not closed by the margin; fix the margin first');
    const design = designCrown({
      fdi: request.fdi,
      jaw: { positions: scan.positions, indices: scan.indices, graph: surfaceOf(scan).graph, smoothNormals: smoothNormalsOf(scan), ray: rayOf(scan) },
      antagonist: antagonist ? rayOf(antagonist) : undefined,
      region,
      frame: request.frame,
      margin: request.margin,
      axis: request.axis,
      params: request.params,
      pose: request.pose,
      maps: request.maps,
      adapt: request.adapt,
    });
    // A reduced crown: its framework (and overpress part), before the crown's buffers are transferred.
    const frameworkBuffers: ArrayBuffer[] = [];
    const framework = request.cutback
      ? singleFramework({ fdi: request.fdi, design, frame: request.frame, cutback: request.cutback, params: request.params, overpress: Boolean(request.overpress), transfer: frameworkBuffers })
      : undefined;
    const { mesh, ...rest } = design;
    const result: CrownResult = { ...rest, positions: mesh.positions, indices: mesh.indices, ms: performance.now() - t0, ...(framework ? { framework } : {}) };
    const mapBuffers = Object.values(design.maps ?? {}).map((m) => (m as Float32Array).buffer as ArrayBuffer);
    return Comlink.transfer(result, [
      mesh.positions.buffer as ArrayBuffer,
      mesh.indices.buffer as ArrayBuffer,
      design.moveWeights.buffer as ArrayBuffer,
      ...mapBuffers,
      ...frameworkBuffers,
    ]);
  },

  /** Face ids (BVH order) of the prep region inside the margin, for the focus view. */
  focusFaces(request: FocusFacesRequest): Uint32Array {
    const { faceMask, faceCount } = regionFor(registry.get(request.jawSha), request.margin, request.occlusal, request.seed);
    const ids = new Uint32Array(faceCount);
    for (let f = 0, k = 0; f < faceMask.length; f++) if (faceMask[f]) ids[k++] = f;
    return Comlink.transfer(ids, [ids.buffer as ArrayBuffer]);
  },

  /** Bridge: one insertion axis over all abutment preps, with per-abutment blockout, margin undercut and divergence. */
  bridgeAxis(request: BridgeAxisRequest): BridgeAxisResult {
    const t0 = performance.now();
    const scan = registry.get(request.jawSha);
    const regions = request.abutments.map((a) => regionFor(scan, a.margin, a.occlusal, a.seed));
    const abutments = request.abutments.map((a, i) => ({ fdi: a.fdi, faceMask: regions[i]!.faceMask, margin: a.margin, occlusal: a.occlusal }));
    const found = searchCommonAxis({ positions: scan.positions, indices: scan.indices, ray: rayOf(scan), abutments, coneDeg: request.coneDeg });
    // A margin that does not close on the surface lets its prep region leak onto the neighbours: the axis is then
    // searched over the wrong faces. Reported per abutment, as axisAnalysis does for one prep.
    const open = request.abutments.filter((_, i) => !regions[i]!.closed).map((a) => a.fdi);
    const result: BridgeAxisResult = {
      direction: found.direction,
      center: found.center,
      angleFromCenterDeg: found.angleFromCenterDeg,
      undercutAreaMm2: found.undercutAreaMm2,
      divergenceDeg: found.divergenceDeg,
      marginUndercutTotal: found.marginUndercutTotal,
      prepClosed: open.length === 0,
      abutments: found.abutments.map((a, i) => ({ ...a, prepClosed: regions[i]!.closed })),
      warnings: [
        ...(open.length ? [`The margin of ${open.join(', ')} is not closed on the surface: the common axis is not reliable. Fix the margin first.`] : []),
        ...found.warnings,
      ],
      ms: performance.now() - t0,
    };
    return Comlink.transfer(result, found.abutments.map((a) => a.marginFlags.buffer as ArrayBuffer));
  },

  /** Bridge Frame step: pontic frames laid out on the arch (from the abutment margins), abutment frames aligned to it. */
  bridgeFrames(request: BridgeFramesRequest): BridgeFramesResult {
    const t0 = performance.now();
    const scan = registry.get(request.jawSha);
    const ray = rayOf(scan);
    const frames = request.units.flatMap((u) => (u.kind !== 'pontic' && u.frame ? [u.frame] : []));
    const curve = archCurveOf(scan, frames);
    const abutments = request.units.flatMap((u) => {
      if (u.kind === 'pontic' || !u.frame) return [];
      const aligned = archAlignedFrame({ frame: u.frame, fdi: u.fdi, curve, ray });
      return [{ fdi: u.fdi, frame: aligned.frame, changeDeg: aligned.changeDeg }];
    });
    const pontics = layoutPontics({
      curve,
      jaw: ray,
      units: request.units.map((u) => (u.kind === 'pontic' ? { fdi: u.fdi, kind: u.kind, centre: u.centre } : { fdi: u.fdi, kind: u.kind, frame: u.frame, outline: u.margin })),
    });
    return {
      abutments,
      pontics,
      curve: { kind: curve.kind, lengthMm: curve.lengthMm, midlineS: curve.midlineS, rmsMm: curve.rmsMm, warnings: curve.warnings },
      ms: performance.now() - t0,
    };
  },

  /**
   * Every unit (retainers via designCrown, pontics via designPontic) and
   * connector of one bridge, and with `union` the merged solid and its checks.
   * Units and connectors are cached by input hash across calls.
   */
  async designBridge(request: BridgeRequest): Promise<BridgeResultView> {
    const t0 = performance.now();
    // Implant crowns cut their screw channels with the boolean engine too.
    if (request.union || request.units.some((u) => u.implant)) await initMeshBoolean({ wasmUrl: manifoldWasmUrl });
    const scan = registry.get(request.jawSha);
    const antagonist = request.antagonistSha && registry.has(request.antagonistSha) ? registry.get(request.antagonistSha) : null;
    const units: BridgeUnitInput[] = request.units.map(({ implant, ...u }) => {
      if (u.kind === 'pontic') return u;
      if (implant) return { ...u, implant: implants.unitOf(implant) };
      if (!u.frame || !u.margin) throw new Error(`Abutment ${u.fdi} needs a frame and a margin`);
      const region = regionFor(scan, u.margin, u.frame.occlusal, u.wing ? u.frame.origin : undefined);
      if (!region.closed) throw new Error(`Abutment ${u.fdi}: the ${u.wing ? 'wing outline does not close a region' : 'prep region is not closed by the margin'}; fix the ${u.wing ? 'outline' : 'margin'} first`);
      return { ...u, region };
    });
    const design = designBridge({
      jaw: { positions: scan.positions, indices: scan.indices, graph: surfaceOf(scan).graph, smoothNormals: smoothNormalsOf(scan), ray: rayOf(scan) },
      antagonist: antagonist ? rayOf(antagonist) : undefined,
      axis: request.axis,
      units,
      connectors: request.connectors,
      material: request.material,
      curve: archCurveOf(scan, request.units.flatMap((u) => (u.kind !== 'pontic' && u.frame ? [u.frame] : []))),
      maps: request.maps,
      union: request.union,
      cache: bridgeCache,
      scanKey: `${request.jawSha}:${antagonist ? antagonist.sha256 : ''}`,
    });
    // Unit and connector results live on in the cache: send copies of their buffers.
    const transfer: ArrayBuffer[] = [];
    const unitViews = design.units.map((r): BridgeUnitView => {
      const { mesh, maps, moveWeights, ...rest } = r.design;
      const implant = implants.viewOf(r.design, transfer);
      return {
        ...rest,
        ...(implant ? { implant } : {}),
        positions: copyOut(mesh.positions, transfer),
        indices: copyOut(mesh.indices, transfer),
        moveWeights: copyOut(moveWeights, transfer),
        ...(maps ? { maps: Object.fromEntries(Object.entries(maps).map(([k, v]) => [k, copyOut(v as Float32Array, transfer)])) } : {}),
        fdi: r.fdi,
        kind: r.kind,
        frame: r.frame,
        proposed: r.proposed,
        connectedSides: r.connectedSides,
        ...(r.layout ? { layout: r.layout } : {}),
        cached: r.cached,
        ms: r.ms,
        ...(r.framework ? { framework: frameworkView(r.framework, transfer, true) } : {}),
      };
    });
    const connectorViews = design.connectors.map((c): BridgeConnectorView => {
      const { mesh, ...rest } = c;
      return { ...rest, positions: copyOut(mesh.positions, transfer), indices: copyOut(mesh.indices, transfer) };
    });
    const union = design.union && { positions: design.union.mesh.positions, indices: design.union.mesh.indices, checks: design.union.checks };
    if (union) transfer.push(union.positions.buffer as ArrayBuffer, union.indices.buffer as ArrayBuffer);
    const result: BridgeResultView = {
      units: unitViews,
      connectors: connectorViews,
      ...(union ? { union } : {}),
      ...(design.unionError ? { unionError: design.unionError } : {}),
      ...(design.overpress ? { overpress: overpressViews(design.overpress, transfer) } : {}),
      curve: design.curve,
      warnings: design.warnings,
      timingsMs: design.timingsMs,
      ms: performance.now() - t0,
    };
    return Comlink.transfer(result, transfer);
  },

  ...implants.api,
};

export type GeometryWorkerApi = typeof api;
Comlink.expose(api);
