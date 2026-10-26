import { bridgeOf, type DesignDocument, type ProximalSide, type ToothDesign, type UnitKind } from '@dcad/shared';
import { activeAdapt, adaptationStale } from '../design/adaptation';
import { crownCentre, templateHeight } from '../design/clinical';
import { useDesignStore } from '../design/store';
import { bridgeTool } from '../tools/bridgeTool';
import { crownTool } from '../tools/crownTool';
import type { BridgeResultView, CrownResult } from '../workers/analysisTypes';

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
  /** Adaptation problems: conflicts ("occlusion: insufficient reduction (421 vertices, 0.31 mm)") and open contacts. */
  conflicts: string[];
  /**
   * Stored adaptation: applied, or stale (a later move or edit switched it
   * off until it is re-applied), or none.
   */
  adaptation: 'applied' | 'stale' | 'none';
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

/** Stored adaptation of a tooth: applied, stale (a later edit switched it off) or none. */
const adaptationOf = (tooth: ToothDesign | undefined): DesignMetrics['adaptation'] =>
  tooth?.crown ? (activeAdapt(tooth) ? 'applied' : adaptationStale(tooth) ? 'stale' : 'none') : 'none';

/** Adaptation problems of an evaluated crown or bridge unit: conflicts and open contacts. */
function adaptProblems(adapt: CrownResult['adapt']): string[] {
  return Object.entries(adapt ?? {}).flatMap(([kind, r]) => {
    if (r?.conflict) return [`${kind}: ${r.conflict.kind} (${r.conflict.vertices} vertices, ${r.conflict.minClearanceMm.toFixed(2)} mm)`];
    if (r?.open) return [`${kind}: open (${Number.isFinite(r.open.clearanceMm) ? `${r.open.clearanceMm.toFixed(2)} mm` : 'nothing within reach'})`];
    return [];
  });
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
    adaptation: adaptationOf(tooth),
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
  return {
    ...base,
    ...reduced,
    minThicknessMm: round(result.thickness?.minMm ?? result.minAxialThicknessMm),
    printable: result.validation.printable ?? result.validation.ok,
    conflicts: adaptProblems(result.adapt),
  };
}

/** Agent-facing metrics of one bridge unit, in mm. null = not applicable / not measured. */
export interface BridgeUnitMetrics {
  fdi: number;
  /** abutment = a crown on a prep (retainer); pontic = replaces a missing tooth. */
  kind: UnitKind;
  /** The unit has a stored crown (otherwise its pose is only a proposal). */
  crownProposed: boolean;
  /** Smallest clearance to the antagonist (negative = penetration). */
  minOcclusalClearanceMm: number | null;
  /** Free sides only: a side facing a connected unit has a connector, not a contact (null there). */
  mesialContactMm: number | null;
  distalContactMm: number | null;
  connectedSides: ProximalSide[];
  /** Retainers only (a pontic is solid). */
  minThicknessMm: number | null;
  /** Pontics only: the smallest gap from the base to the ridge (measured on the union when merged), and its target. */
  ponticBaseGapMm: number | null;
  ponticBaseTargetMm: number | null;
  printable: boolean | null;
  conflicts: string[];
  adaptation: DesignMetrics['adaptation'];
}

/** Agent-facing metrics of one connector: what set_connector changes, and what the union measured. */
export interface ConnectorMetrics {
  between: [number, number];
  /** Stored settings: the designed cross-section, and the offsets from the automatic position. */
  designedAreaMm2: number;
  buccalMm: number;
  occlusalMm: number;
  /** Smallest cross-section measured across the gap on the merged bridge (null until merged). */
  measuredAreaMm2: number | null;
  /** Designed height, and the height measured on the union (null until merged). */
  heightMm: number;
  measuredHeightMm: number | null;
  /** Height available between the gingiva (hygiene clearance) and the occlusal embrasure. */
  availableHeightMm: number;
  /** The material minimum cross-section and the minimum height. */
  minAreaMm2: number;
  minHeightMm: number;
  /** Design failures (insufficient height, too wide) and measured shortfalls. */
  failures: string[];
}

export interface BridgeMetrics {
  /** Units in arch order. */
  teeth: number[];
  units: BridgeUnitMetrics[];
  connectors: ConnectorMetrics[];
  /** The merged solid (null until merged). */
  union: { printable: boolean; components: number; genus: number; seatingUnchanged: boolean } | null;
  /** Why the units could not be merged into one solid. */
  unionError: string | null;
}

/**
 * Reduce a designed bridge to agent-facing metrics (pure). Design it with the maps 'occlusion', 'proximal' and
 * 'thickness', and with `union: true` for the measured values. `teeth` are the document's tooth designs (for the
 * stored crown and adaptation state).
 */
export function bridgeMetricsFrom(
  result: Pick<BridgeResultView, 'units' | 'connectors' | 'unionError'> & { union?: Pick<NonNullable<BridgeResultView['union']>, 'checks'> },
  teeth: readonly ToothDesign[],
): BridgeMetrics {
  const checks = result.union?.checks;
  const units = result.units.map((u): BridgeUnitMetrics => {
    const tooth = teeth.find((t) => t.fdi === u.fdi);
    const reduced = reduceCrownMaps({
      positions: u.positions,
      shellStart: u.shellStart ?? u.intaglioVertices,
      occlusion: u.maps?.occlusion,
      proximal: u.maps?.proximal,
      centre: crownCentre(u.pose, templateHeight(u.fdi)),
      mesial: u.frame.mesial,
    });
    const base = u.kind === 'pontic' ? (checks?.ponticBase.find((p) => p.fdi === u.fdi) ?? u.base) : undefined;
    return {
      fdi: u.fdi,
      kind: u.kind,
      crownProposed: Boolean(tooth?.crown),
      minOcclusalClearanceMm: reduced.minOcclusalClearanceMm,
      mesialContactMm: u.connectedSides.includes('mesial') ? null : reduced.mesialContactMm,
      distalContactMm: u.connectedSides.includes('distal') ? null : reduced.distalContactMm,
      connectedSides: u.connectedSides,
      minThicknessMm: u.kind === 'abutment' ? round(u.thickness?.minMm ?? u.minAxialThicknessMm) : null,
      ponticBaseGapMm: base ? round(base.minGapMm) : null,
      ponticBaseTargetMm: base ? base.targetMm : null,
      printable: u.validation.printable ?? u.validation.ok,
      conflicts: adaptProblems(u.adapt),
      adaptation: adaptationOf(tooth),
    };
  });
  const connectors = result.connectors.map((c): ConnectorMetrics => {
    const [a, b] = c.between;
    const m = checks?.connectors.find((x) => x.between[0] === a && x.between[1] === b);
    const failures = c.failures.map((f) => f.message);
    if (m && !m.areaOk) failures.push(`smallest section ${m.measured.minAreaMm2.toFixed(2)} mm² is below ${m.targetAreaMm2} mm²`);
    if (m && !m.heightOk) failures.push(`height ${Math.min(m.measured.heightMm, m.designedHeightMm).toFixed(2)} mm is below ${m.minHeightMm} mm`);
    return {
      between: [a, b],
      designedAreaMm2: c.settings.areaMm2,
      buccalMm: c.settings.buccalMm,
      occlusalMm: c.settings.occlusalMm,
      measuredAreaMm2: m ? round(m.measured.minAreaMm2) : null,
      heightMm: round(c.heightMm) ?? 0,
      measuredHeightMm: m ? round(m.measured.heightMm) : null,
      availableHeightMm: round(c.available.heightMm) ?? 0,
      minAreaMm2: c.minAreaMm2,
      minHeightMm: c.minHeightMm,
      failures,
    };
  });
  return {
    teeth: result.units.map((u) => u.fdi),
    units,
    connectors,
    union: checks
      ? { printable: checks.union.printable, components: checks.union.components, genus: checks.union.genus, seatingUnchanged: checks.seating.every((s) => s.ok) }
      : null,
    unionError: result.unionError ?? null,
  };
}

/** A tooth's metrics; for a bridge unit also the whole bridge (every unit, the connectors and the merged solid). */
export type AgentMetrics = DesignMetrics & {
  bridge?: BridgeMetrics;
  /** Why the bridge could not be designed (a missing input), when it could not. */
  bridgeError?: string;
};

/**
 * Metrics for the active tooth of a document (evaluates the crown in the worker). In a bridge, `fdi` may name any
 * unit of the active tooth's bridge: the whole bridge is designed and merged (bridgeTool.evaluate with `union`), so
 * the connectors are measured too, and the tooth's own values follow from its unit (contacts on free sides only).
 */
export async function designMetrics(doc: DesignDocument = useDesignStore.getState().doc, fdi?: number): Promise<AgentMetrics | null> {
  const activeFdi = useDesignStore.getState().activeFdi;
  const bridge = bridgeOf(doc, activeFdi);
  const target = bridge && fdi !== undefined && bridge.teeth.includes(fdi) ? fdi : activeFdi;
  const tooth = doc.teeth.find((t) => t.fdi === target);
  if (!tooth) return null;
  if (!bridge) {
    const result = tooth.crown ? await crownTool.evaluate(['occlusion', 'proximal', 'thickness']) : null;
    return metricsFrom(tooth, result);
  }
  const base = metricsFrom(tooth, null);
  if (!bridge.teeth.some((t) => doc.teeth.find((x) => x.fdi === t)?.crown)) return base;
  let result: BridgeResultView | null;
  try {
    result = await bridgeTool.evaluate({ union: true, maps: ['occlusion', 'proximal', 'thickness'] });
  } catch (e) {
    return { ...base, bridgeError: e instanceof Error ? e.message : String(e) };
  }
  if (!result) return base;
  const metrics = bridgeMetricsFrom(result, doc.teeth);
  const unit = metrics.units.find((u) => u.fdi === target);
  if (!unit) return { ...base, bridge: metrics };
  return {
    ...base,
    minOcclusalClearanceMm: unit.minOcclusalClearanceMm,
    mesialContactMm: unit.mesialContactMm,
    distalContactMm: unit.distalContactMm,
    minThicknessMm: unit.minThicknessMm,
    printable: unit.printable,
    conflicts: unit.conflicts,
    bridge: metrics,
  };
}
