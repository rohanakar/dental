import type { CrownAdapt, DesignParams, Pose } from '@dcad/shared';
import type { GapCheck } from '../geometry/intaglio';
import type { MeshValidation } from '../geometry/meshValidate';

/** Messages between the main thread and the geometry worker's analysis API. */
export type V3 = [number, number, number];

export interface FrameEstimate {
  origin: V3;
  occlusal: V3;
  mesial: V3;
  buccal: V3;
  mesialContact?: V3;
  distalContact?: V3;
  warnings: string[];
}

export interface FrameRequest {
  jawSha: string;
  antagonistSha?: string;
  seed: V3;
  fdi: number;
}

export interface SurfaceInfo {
  vertices: number;
  ms: number;
}

export interface MarginTrace {
  /** Dense closed curve on the surface, xyz per point (no repeated closing point). */
  points: Float32Array;
  /** Mesh vertex each anchor snapped to. */
  anchorVertices: number[];
  lengthMm: number;
}

export interface AxisRequest {
  jawSha: string;
  /** Dense margin, xyz per point. */
  margin: Float32Array;
  occlusal: V3;
  /** Fixed axis to evaluate; omitted = search for the least-undercut axis. */
  direction?: V3;
}

export interface AxisAnalysis {
  direction: V3;
  angleFromOcclusalDeg: number;
  undercutAreaMm2: number;
  /** Blockout depth per vertex in mm (0 = visible, NaN = outside the prep region). */
  depths: Float32Array;
  maxDepthMm: number;
  /** Per margin point: 1 = in an undercut. */
  marginFlags: Uint8Array;
  marginUndercutCount: number;
  prepClosed: boolean;
  ms: number;
}

export type CrownMapName = 'thickness' | 'occlusion' | 'proximal' | 'unmillable';

export interface CrownRequest {
  jawSha: string;
  antagonistSha?: string;
  fdi: number;
  frame: { origin: V3; occlusal: V3; mesial: V3; buccal: V3; mesialContact?: V3; distalContact?: V3 };
  /** Dense margin, xyz per point. */
  margin: Float32Array;
  axis: V3;
  params: DesignParams;
  /** Stored template pose; omitted = propose one. */
  pose?: Pose;
  /** Colour maps to compute on the crown (per crown vertex, NaN = not applicable). */
  maps?: CrownMapName[];
  /** Adaptation targets stored on the crown. */
  adapt?: CrownAdapt;
}

export interface AdaptConflict {
  kind: string;
  vertices: number;
  minClearanceMm: number;
  at: V3;
}

export interface AdaptReportView {
  movedVertices: number;
  maxMoveMm: number;
  minClearanceMm: number;
  conflict?: AdaptConflict;
}

export interface CrownResult {
  positions: Float32Array;
  indices: Uint32Array;
  pose: Pose;
  templateId: string;
  validation: MeshValidation & { selfIntersections?: number; printable?: boolean };
  minAxialThicknessMm: number;
  gapCheck: GapCheck;
  intaglioVertices: number;
  thickness?: { minMm: number; pushedVertices: number; maxPushMm: number };
  maps?: Partial<Record<CrownMapName, Float32Array>>;
  adapt?: { occlusion?: AdaptReportView; mesial?: AdaptReportView; distal?: AdaptReportView };
  warnings: string[];
  timingsMs: Record<string, number>;
  ms: number;
}
