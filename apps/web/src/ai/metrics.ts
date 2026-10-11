import type { DesignDocument, ToothDesign } from '@dcad/shared';
import { crownCentre, templateHeight } from '../design/clinical';
import { useDesignStore } from '../design/store';
import { crownTool } from '../tools/crownTool';
import type { CrownResult } from '../workers/analysisTypes';

type V3 = readonly [number, number, number];

/** What the agent (and the UI) can ask about a design, all in mm. null = not applicable / not measured. */
export interface DesignMetrics {
  fdi: number;
  crownProposed: boolean;
  /** Smallest clearance to the antagonist (negative = penetration). */
  minOcclusalClearanceMm: number | null;
  /** Smallest clearance to the mesial / distal neighbour (negative = penetration). */
  mesialContactMm: number | null;
  distalContactMm: number | null;
  minThicknessMm: number | null;
  marginLengthMm: number | null;
  printable: boolean | null;
  /** Adaptation conflicts, e.g. "occlusion: insufficient reduction (421 vertices, 0.31 mm)". */
  conflicts: string[];
}

const round = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

function closedLength(points: ReadonlyArray<{ p: readonly number[] }>): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!.p;
    const b = points[(i + 1) % points.length]!.p;
    sum += Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  }
  return sum;
}

/**
 * Pure reduction of per-vertex crown maps to metrics. Only shell (outer)
 * vertices from `shellStart` count. Proximal values are split by side: a
 * vertex is mesial when (p − centre)·mesial > 0.
 */
export function reduceCrownMaps(input: {
  positions: Float32Array;
  shellStart: number;
  occlusion?: Float32Array;
  proximal?: Float32Array;
  centre: V3;
  mesial: V3;
}): { minOcclusalClearanceMm: number | null; mesialContactMm: number | null; distalContactMm: number | null } {
  const { positions, shellStart, occlusion, proximal, centre, mesial } = input;
  let occl = Infinity;
  let mes = Infinity;
  let dis = Infinity;
  const n = positions.length / 3;
  for (let v = shellStart; v < n; v++) {
    const o = occlusion?.[v];
    if (o !== undefined && Number.isFinite(o) && o < occl) occl = o;
    const p = proximal?.[v];
    if (p === undefined || !Number.isFinite(p)) continue;
    const side =
      (positions[v * 3]! - centre[0]) * mesial[0] + (positions[v * 3 + 1]! - centre[1]) * mesial[1] + (positions[v * 3 + 2]! - centre[2]) * mesial[2];
    if (side > 0) mes = Math.min(mes, p);
    else dis = Math.min(dis, p);
  }
  const fin = (x: number) => (Number.isFinite(x) ? round(x) : null);
  return { minOcclusalClearanceMm: fin(occl), mesialContactMm: fin(mes), distalContactMm: fin(dis) };
}

/** Assemble metrics from the document and an evaluated crown (pure). */
export function metricsFrom(tooth: ToothDesign, result: CrownResult | null): DesignMetrics {
  const marginLengthMm = tooth.margin ? round(closedLength(tooth.margin.points)) : null;
  const base: DesignMetrics = {
    fdi: tooth.fdi,
    crownProposed: Boolean(tooth.crown),
    minOcclusalClearanceMm: null,
    mesialContactMm: null,
    distalContactMm: null,
    minThicknessMm: null,
    marginLengthMm,
    printable: null,
    conflicts: [],
  };
  if (!result || !tooth.frame) return base;
  const shellStart = (result as CrownResult & { shellStart?: number }).shellStart ?? result.intaglioVertices;
  const centre = crownCentre(result.pose, templateHeight(tooth.fdi));
  const reduced = reduceCrownMaps({
    positions: result.positions,
    shellStart,
    occlusion: result.maps?.occlusion,
    proximal: result.maps?.proximal,
    centre,
    mesial: tooth.frame.mesial,
  });
  const conflicts = Object.entries(result.adapt ?? {}).flatMap(([kind, r]) =>
    r?.conflict ? [`${kind}: ${r.conflict.kind} (${r.conflict.vertices} vertices, ${r.conflict.minClearanceMm.toFixed(2)} mm)`] : [],
  );
  return {
    ...base,
    ...reduced,
    minThicknessMm: round(result.thickness?.minMm ?? result.minAxialThicknessMm),
    printable: result.validation.printable ?? result.validation.ok,
    conflicts,
  };
}

/** Metrics for the active tooth of a document (evaluates the crown in the worker). */
export async function designMetrics(doc: DesignDocument = useDesignStore.getState().doc): Promise<DesignMetrics | null> {
  const fdi = useDesignStore.getState().activeFdi;
  const tooth = doc.teeth.find((t) => t.fdi === fdi);
  if (!tooth) return null;
  const result = tooth.crown ? await crownTool.evaluate(['occlusion', 'proximal', 'thickness']) : null;
  return metricsFrom(tooth, result);
}
