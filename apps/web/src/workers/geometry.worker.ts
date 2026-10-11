/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { searchInsertionAxis, marginUndercut, undercutDepths } from '../geometry/axis';
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
import { processScan } from '../geometry/processScan';
import { bvhRayCaster, type RayCaster } from '../geometry/raycast';
import { analyzeSurface, smoothVertexNormals, type SurfaceAnalysis } from '../geometry/surface';
import { proposeMarginAnchors } from '../geometry/autoMargin';
import { designCrown } from '../geometry/crown';
import { syntheticArch } from '../geometry/synthetic';
import { estimateToothFrame } from '../geometry/toothFrame';
import type {
  AutoMarginRequest,
  AutoMarginResult,
  AxisAnalysis,
  AxisRequest,
  CrownRequest,
  CrownResult,
  FrameEstimate,
  FrameRequest,
  MarginTrace,
  SurfaceInfo,
} from './analysisTypes';
import { buildScanPayload, type ScanPayload } from './scanPayload';
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

/** Prep region inside a (dense) margin: snap to vertices, close the chain, flood fill from the prep top. */
function regionFor(scan: RetainedScan, margin: Float32Array, occlusal: V3): PrepRegion & { loopVertices: Uint32Array } {
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

  releaseScan(sha256: string): void {
    registry.release(sha256);
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
    const region = regionFor(scan, request.margin, request.occlusal);
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
  designCrown(request: CrownRequest): CrownResult {
    const t0 = performance.now();
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
    const { mesh, ...rest } = design;
    const result: CrownResult = { ...rest, positions: mesh.positions, indices: mesh.indices, ms: performance.now() - t0 };
    const mapBuffers = Object.values(design.maps ?? {}).map((m) => (m as Float32Array).buffer as ArrayBuffer);
    return Comlink.transfer(result, [mesh.positions.buffer as ArrayBuffer, mesh.indices.buffer as ArrayBuffer, ...mapBuffers]);
  },
};

export type GeometryWorkerApi = typeof api;
Comlink.expose(api);
