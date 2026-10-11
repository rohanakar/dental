import { create } from 'zustand';
import type { ColorMapName } from '../engine/colormap';
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
}

const initial = {
  framePick: 'seed' as FramePick,
  frameWarnings: [] as string[],
  marginAnchors: [] as MarginAnchor[],
  surface: 'idle' as const,
  axisReport: null,
  legend: null,
  crown: null,
  crownVisible: true,
  crownMap: 'none' as CrownMapName | 'none',
  crownOpacity: 1,
  busy: null,
  message: null,
};

export const useToolStore = create<ToolState>()((set) => ({
  ...initial,
  set: (patch) => set(patch),
  reset: () => set(initial),
}));
