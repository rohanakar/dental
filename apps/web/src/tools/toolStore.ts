import { create } from 'zustand';
import type { ColorMapName, ColorStops } from '../engine/colormap';
import type { GapCheck } from '../geometry/intaglio';
import type { MeshValidation } from '../geometry/meshValidate';
import type { CrownMapName, CrownResult } from '../workers/analysisTypes';

export type V3 = [number, number, number];

export type FramePick = 'seed' | 'mesialContact' | 'distalContact';

export interface MarginAnchor {
  p: V3;
  vertex: number;
}

/** Transient tool state: in-progress input that is not (yet) part of the document. */
export interface ToolState {
  /** What a click in the viewport does in the frame step. */
  framePick: FramePick;
  /** One-click crown armed: the next click on the prep runs the whole auto-design. */
  autoArmed: boolean;
  frameWarnings: string[];
  /** Live-wire anchors placed so far (open path until the margin is closed). */
  marginAnchors: MarginAnchor[];
  /** Surface analysis (adjacency + curvature) status for the prep jaw. */
  surface: 'idle' | 'analysing' | 'ready' | 'error';
  axisReport: AxisReport | null;
  /** Colour-map legend for whatever scalar overlay is shown. */
  legend: LegendSpec | null;
  /** Status of the derived crown mesh for the active tooth. */
  crown: CrownStatus | null;
  crownVisible: boolean;
  /** Colour map shown on the crown. */
  crownMap: CrownMapName | 'none';
  crownOpacity: number;
  /** Focus view while adjusting the crown: the prep at full strength, the surroundings dimmed. */
  focusPrep: boolean;
  /** Opacity factor for the surroundings (gums, neighbours, antagonist) in the focus view. */
  surroundings: number;
  busy: string | null;
  message: { kind: 'info' | 'warning' | 'error'; text: string } | null;
  set(patch: Partial<Omit<ToolState, 'set' | 'reset'>>): void;
  reset(): void;
}

export interface LegendSpec {
  title: string;
  map: ColorMapName;
  range: [number, number];
  unit: string;
  /** Labels for the low and high ends, e.g. "visible" / "deep undercut". */
  lowLabel?: string;
  highLabel?: string;
  /** Explicit stops (instead of the named map's), e.g. re-centred on contact for this tooth. */
  stops?: ColorStops;
  /** Marked values on the bar: contact, the target, the material minimum. */
  ticks?: LegendTick[];
}

export interface LegendTick {
  value: number;
  label: string;
  /** Dotted mark: a target rather than a physical boundary. */
  dashed?: boolean;
}

export interface CrownStatus {
  computing: boolean;
  error?: string;
  templateId?: string;
  triangles?: number;
  validation?: CrownResult['validation'];
  minAxialThicknessMm?: number;
  gapCheck?: GapCheck;
  thickness?: { minMm: number; pushedVertices: number; maxPushMm: number };
  adapt?: CrownResult['adapt'];
  /** Inlays and onlays: margin fit, isthmus, library fit (the Adapt panel and the Finalize rows). */
  inlay?: CrownResult['inlay'];
  warnings: string[];
  ms?: number;
}

export interface AxisReport {
  undercutAreaMm2: number;
  angleFromOcclusalDeg: number;
  maxDepthMm: number;
  marginUndercutCount: number;
  marginPointCount: number;
  prepClosed: boolean;
  /** A bridge: the common axis evaluated on every abutment (the fields above are then totals over them). */
  bridge?: BridgeAxisReport;
}

export interface BridgeAxisReport {
  abutments: Array<{
    fdi: number;
    marginUndercutCount: number;
    marginPointCount: number;
    /** Projected undercut area of this prep at the common axis: what its intaglio blocks out. */
    blockoutAreaMm2: number;
    maxDepthMm: number;
    prepClosed: boolean;
    /** Angle from this abutment's own least-undercut axis to the common axis (null until searched). */
    angleToOwnDeg: number | null;
  }>;
  /** Largest angle between two abutments' own least-undercut axes (null until searched). */
  divergenceDeg: number | null;
  warnings: string[];
}

const initial = {
  framePick: 'seed' as FramePick,
  autoArmed: false,
  frameWarnings: [] as string[],
  marginAnchors: [] as MarginAnchor[],
  surface: 'idle' as const,
  axisReport: null,
  legend: null,
  crown: null,
  crownVisible: true,
  crownMap: 'none' as CrownMapName | 'none',
  crownOpacity: 1,
  focusPrep: true,
  surroundings: 0.4,
  busy: null,
  message: null,
};

export const useToolStore = create<ToolState>()((set) => ({
  ...initial,
  set: (patch) => set(patch),
  reset: () => set(initial),
}));
