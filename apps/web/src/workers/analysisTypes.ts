import type { ConnectorDesign, CrownAdapt, Cutback, DesignParams, Material, Pose, ProximalSide, UnitKind } from '@dcad/shared';
import type { FrameworkView, OverpressView } from './frameworkTypes';
import type { BridgeChecks } from '../geometry/bridgeUnion';
import type { ConnectorEnd, ConnectorFailure } from '../geometry/connectors';
import type { GapCheck } from '../geometry/intaglio';
import type { MeshValidation } from '../geometry/meshValidate';
import type { PonticBaseGap } from '../geometry/pontic';
import type { ToothClearance } from '../geometry/connectors';
import type { WingUnitReport } from '../geometry/wingUnit';
import type { ScrewChannelReport } from '../geometry/implantCrown';
import type { TiBaseGapCheck } from '../geometry/tiBase';

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
  /** Maryland wings: a point inside the outline (the frame origin); the region is flood-filled from it. */
  seed?: V3;
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
  /** Implant crowns: the Ti-base and the scan-body pose (the margin is then unused). */
  implant?: ImplantUnitRequest;
  /** A reduced crown: its cutback (the result adds `framework`). */
  cutback?: Cutback;
  /** With a cutback that has overpress: also make the overpress part (loads the boolean engine). */
  overpress?: boolean;
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
  /** Implant crowns: the screw channel, the Ti-base fit and the restoration with the channel. */
  implant?: ImplantResultView;
  /** A reduced unit: its framework (positions with the same indices) and the cutback report. */
  framework?: FrameworkView;
}

/** Jaw faces to draw in focus while the crown is adjusted: the prep region inside the margin. */
export interface FocusFacesRequest {
  jawSha: string;
  /** Dense margin, xyz per point. */
  margin: Float32Array;
  occlusal: V3;
  /** Maryland wings: a point inside the outline (the frame origin). */
  seed?: V3;
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
  abutments: Array<{
    fdi: number;
    /** Dense margin, xyz per point. */
    margin: Float32Array;
    occlusal: V3;
    /** Maryland wings: a point inside the outline (the frame origin); the region is flood-filled from it. */
    seed?: V3;
  }>;
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
  /** Every abutment's margin closes on the surface; false = the axis was searched over a leaked region (unreliable). */
  prepClosed: boolean;
  abutments: Array<{
    fdi: number;
    /** This abutment's margin closes on the surface (its prep region did not leak). */
    prepClosed: boolean;
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
  /**
   * Abutments: required. Pontics: the stored frame (its axes); omitted = laid out on the arch. A proposed pontic pose
   * is centred by the layout on the retainer shells either way.
   */
  frame?: FrameView;
  /** Abutments: dense margin, xyz per point. */
  margin?: Float32Array;
  /** Stored pose; omitted = proposed (BridgeUnitView.proposed). */
  pose?: Pose;
  /** Adaptation targets; sides facing a connected unit are ignored (they have a connector). */
  adapt?: CrownAdapt;
  /** Pontics: centre override (a click on the ridge); places the proposed pose. Pass it again with a stored frame. */
  centre?: V3;
  /** Abutments: a Maryland wing on the outline, flood-filled from the frame origin (no pose; designWingUnit). */
  wing?: boolean;
  /** Implant crowns: the Ti-base and the scan-body pose, instead of a margin. */
  implant?: ImplantUnitRequest;
  /** Reduced units: the cutback; their frameworks join the connectors and the union. */
  cutback?: Cutback;
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
  /** Maryland wings: thickness, space against the antagonist, bonded and blocked-out area. */
  wing?: WingUnitReport;
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
  /** Connectors to a Maryland wing: clearance to the natural tooth. */
  toothClearance?: ToothClearance;
  /** 'insufficient-height', 'too-wide', 'fit-clearance' or 'tooth-clash'. */
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
  /** With union: true — the overpress part of each reduced unit with overpress. */
  overpress?: OverpressView[];
  curve: ArchCurveView;
  warnings: string[];
  timingsMs: Record<string, number>;
  ms: number;
}

// ---- Implants (geometry/scanBody.ts, implantCrown.ts, implantBridge.ts) ------------------------------------------

/** An implant unit as the document stores it (ToothDesign.implant and screwChannel). */
export interface ImplantUnitRequest {
  /** Library entry key, e.g. 'synthetic-generic@1/rp-non-engaging'. */
  libraryId: string;
  /** The registered scan-body pose (the library frame in the scan). */
  pose: Pose;
  channel?: { angleDeg: number; azimuthDeg: number };
}

/** A library entry, for the setup and the implant position step. */
export interface ImplantEntryView {
  key: string;
  libraryId: string;
  system: string;
  platform: string;
  engaging: boolean;
  channelDiameterMm: number;
  ascMaxDeg: number;
  maxDivergenceDeg: number;
  bondingGapMm: number;
  scanBodyTopZ: number;
  scanBodyRadiusMm: number;
}

/** The implant position step: register the library scan body from a click on the scanned one's top. */
export interface ScanBodyRequest {
  jawSha: string;
  fdi: number;
  click: V3;
  libraryId: string;
  /** The tooth frame (from the frame step): returned moved onto the gingival opening, with its contacts searched again. */
  frame?: FrameView;
}

export interface ScanBodyResult {
  /** The library frame in the scan, as the document stores it. */
  pose: Pose;
  origin: V3;
  axis: V3;
  rmsMm: number;
  maxMm: number;
  inlierFraction: number;
  coverage: number;
  /** RMS ≤ 0.05 mm, inliers ≥ 0.9, coverage ≥ 0.6. */
  passed: boolean;
  failures: string[];
  /** The tooth frame on the gingival opening (when a frame was given and the match passed). */
  frame?: FrameView;
  opening?: { centre: V3; meanHeightMm: number; coverage: number };
  /** The library scan body at the pose, for the ghost display. */
  scanBody: { positions: Float32Array; indices: Uint32Array };
  ms: number;
}

/** The common path over a bridge's implant axes (searchImplantPath). */
export interface ImplantPathRequest {
  implants: Array<{ fdi: number; pose: Pose; libraryId: string }>;
}

export interface ImplantPathView {
  direction: V3;
  divergenceDeg: number;
  maxDivergenceDeg: number;
  ok: boolean;
  implants: Array<{ fdi: number; angleToPathDeg: number }>;
  failures: string[];
}

/** An implant crown's extras on a CrownResult (geometry/implantCrown.ts ImplantCrownExtras). */
export interface ImplantResultView {
  libraryId: string;
  engaging: boolean;
  channel: ScrewChannelReport;
  tiBaseGap: TiBaseGapCheck;
  /** Shoulder points hidden under the Ti-base from the insertion path: > 0 = cannot be seated. */
  rimUndercutCount: number;
  opening: { centre: V3; meanHeightMm: number; coverage: number };
  /** The restoration with the screw channel: what is exported. */
  cut?: { positions: Float32Array; indices: Uint32Array };
  cutOk?: boolean;
}

/** The auto-angled screw channel (classical.screw-channel), or null when no angle in the ASC cone passes. */
export type ScrewChannelProposal = { angleDeg: number; azimuthDeg: number; exitOk: boolean; minWallMm: number } | null;
