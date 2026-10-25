import type { ConnectorDesign, CrownAdapt, DesignParams, Material, Pose, ProximalSide, UnitKind } from '@dcad/shared';
import type { BridgeChecks } from '../geometry/bridgeUnion';
import type { ConnectorEnd, ConnectorFailure } from '../geometry/connectors';
import type { GapCheck } from '../geometry/intaglio';
import type { MeshValidation } from '../geometry/meshValidate';
import type { PonticBaseGap } from '../geometry/pontic';

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
  targetMm?: number;
  conflict?: AdaptConflict;
  /** Still farther than the target after adaptation (Infinity = nothing within reach). */
  open?: { clearanceMm: number };
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
  /** First outer-shell vertex (= intaglioVertices). */
  shellStart: number;
  /** Per vertex: how far it follows a translation of the pose (0 = pinned, 1 = moves with it). */
  moveWeights: Float32Array;
  thickness?: { minMm: number; pushedVertices: number; maxPushMm: number };
  maps?: Partial<Record<CrownMapName, Float32Array>>;
  adapt?: { occlusion?: AdaptReportView; mesial?: AdaptReportView; distal?: AdaptReportView };
  warnings: string[];
  timingsMs: Record<string, number>;
  ms: number;
}

/** Jaw faces to draw in focus while the crown is adjusted: the prep region inside the margin. */
export interface FocusFacesRequest {
  jawSha: string;
  /** Dense margin, xyz per point. */
  margin: Float32Array;
  occlusal: V3;
}

export interface AutoMarginRequest {
  jawSha: string;
  frame: { origin: V3; occlusal: V3; mesial: V3 };
}

/** Automatic margin (classical.margin-ridge): anchors from radial profiles, closed by the live-wire. */
export interface AutoMarginResult extends MarginTrace {
  anchors: V3[];
  /** Fraction of radial profiles that found the ridge (0..1). */
  confidence: number;
  ms: number;
}

// ---- Bridges (geometry/bridge.ts) ------------------------------------------------------

/** A tooth frame as stored (ToothFrame without source). */
export type FrameView = CrownRequest['frame'];

/** Common insertion axis of a bridge's abutments (searchCommonAxis). */
export interface BridgeAxisRequest {
  jawSha: string;
  abutments: Array<{ fdi: number; /** Dense margin, xyz per point. */ margin: Float32Array; occlusal: V3 }>;
  /** Search cone around the mean occlusal direction (default 25°). */
  coneDeg?: number;
}

export interface BridgeAxisResult {
  direction: V3;
  /** Mean of the abutments' occlusal directions (the cone centre). */
  center: V3;
  angleFromCenterDeg: number;
  /** Projected undercut area over all abutment preps at the common axis, mm². */
  undercutAreaMm2: number;
  /** Largest angle between two abutments' own best axes (a warning above 12°). */
  divergenceDeg: number;
  /** Must be 0: margin points in an undercut over all abutments. */
  marginUndercutTotal: number;
  abutments: Array<{
    fdi: number;
    individualAxis: V3;
    angleToCommonDeg: number;
    blockoutAreaMm2: number;
    marginUndercutCount: number;
    /** Per margin point: 1 = in an undercut at the common axis. */
    marginFlags: Uint8Array;
  }>;
  warnings: string[];
  ms: number;
}

/** A pontic laid out on the arch curve (layoutPontics). */
export interface PonticLayoutView {
  fdi: number;
  /** Origin on the ridge under the centre, FDI handedness; contacts at the neighbouring units or natural teeth. */
  frame: FrameView;
  /** Arc length of the centre on the arch curve, and of its span ends (toward the lower, then higher arch index). */
  s: number;
  span: [number, number];
  /** Mesio-distal width the arch gives it, mm. */
  mdMm: number;
  cantilever: boolean;
  warnings: string[];
}

export interface ArchCurveView {
  kind: 'curve' | 'line';
  lengthMm: number;
  midlineS: number | null;
  rmsMm: number;
}

/** The bridge's Frame step: pontic frames on the arch, and the abutment frames aligned to it. */
export interface BridgeFramesRequest {
  jawSha: string;
  /** One bridge's units, in arch order. Abutments need their frame and margin (the margin's extremes are their edges). */
  units: Array<{ fdi: number; kind: UnitKind; frame?: FrameView; margin?: Float32Array; /** Pontics: a click on the ridge. */ centre?: V3 }>;
}

export interface BridgeFramesResult {
  /** Each abutment frame with its mesial-distal line from the arch curve (archAlignedFrame); offered, not applied. */
  abutments: Array<{ fdi: number; frame: FrameView; /** Change of the mesial direction, degrees. */ changeDeg: number }>;
  pontics: PonticLayoutView[];
  curve: ArchCurveView & { warnings: string[] };
  ms: number;
}

export interface BridgeUnitRequest {
  fdi: number;
  /** The unit's role (RESTORATION_ROLE[restoration].role): the worker dispatches on it. */
  kind: UnitKind;
  params: DesignParams;
  /** Abutments: required. Pontics: the stored frame; omitted = laid out on the arch. */
  frame?: FrameView;
  /** Abutments: dense margin, xyz per point. */
  margin?: Float32Array;
  /** Stored pose; omitted = proposed (BridgeUnitView.proposed). */
  pose?: Pose;
  /** Adaptation targets; sides facing a connected unit are ignored (they have a connector). */
  adapt?: CrownAdapt;
  /** Pontics: centre override (a click on the ridge), used when no frame is stored. */
  centre?: V3;
}

/** One bridge, designed in the worker. Units are cached by input hash: moving one unit recomputes it and its connectors. */
export interface BridgeRequest {
  jawSha: string;
  antagonistSha?: string;
  material: Material;
  /** The common insertion axis (all abutments store the same one). */
  axis: V3;
  /** BridgeDesign.teeth with each unit's inputs, in arch order. */
  units: BridgeUnitRequest[];
  /** BridgeDesign.connectors. */
  connectors: ConnectorDesign[];
  maps?: CrownMapName[];
  /** Merge into one solid and run the bridge checks (QA and export; not on every move). */
  union?: boolean;
}

/** A designed unit: the same fields as a single crown, plus its bridge context. */
export interface BridgeUnitView extends CrownResult {
  fdi: number;
  kind: UnitKind;
  /** The frame it was designed in (abutment: contacts toward connected units dropped; pontic: stored or laid out). */
  frame: FrameView;
  /** No stored pose: `pose` is the proposal; store it with setCrown (one batch for the bridge). */
  proposed: boolean;
  connectedSides: ProximalSide[];
  /** Pontics: gap from the base to the ridge, and the layout on the arch. */
  base?: PonticBaseGap;
  layout?: PonticLayoutView;
  cached: boolean;
}

export interface BridgeConnectorView {
  between: [number, number];
  settings: ConnectorDesign;
  /** Material minimum area and minimum height. */
  minAreaMm2: number;
  minHeightMm: number;
  /** Closed tube mesh. */
  positions: Float32Array;
  indices: Uint32Array;
  centre: V3;
  /** Connector line (between[0] → between[1]) and the cross-section axes (height along the insertion axis, width buccal). */
  direction: V3;
  heightDir: V3;
  widthDir: V3;
  areaMm2: number;
  heightMm: number;
  widthMm: number;
  available: { heightMm: number; bottom: V3; top: V3 };
  span: [number, number];
  ends: [ConnectorEnd, ConnectorEnd];
  /** 'insufficient-height' or 'too-wide'. */
  failures: ConnectorFailure[];
  warnings: string[];
  cached: boolean;
}

export interface BridgeResultView {
  units: BridgeUnitView[];
  connectors: BridgeConnectorView[];
  /** With union: true — the merged solid (export it) and the checks measured on it. */
  union?: { positions: Float32Array; indices: Uint32Array; checks: BridgeChecks };
  /** With union: true, when the boolean engine refused the inputs: why (no `union`, nothing to export). */
  unionError?: string;
  curve: ArchCurveView;
  warnings: string[];
  timingsMs: Record<string, number>;
  ms: number;
}
