import { type DesignParams, stepsFor, type UnitKind } from '@dcad/shared';
import { adaptGate, axisGate, crownGate, marginGate } from '../../ai/qa';
import type { AxisReport, CrownStatus } from '../../tools/toolStore';

type V3 = readonly [number, number, number];

export type ReadinessStatus = 'pass' | 'fail' | 'unknown';

export interface ReadinessItem {
  id: string;
  label: string;
  status: ReadinessStatus;
  /** The measured value against its limit, or what is wrong. */
  detail: string;
}

export interface ReadinessInput {
  /** Dense margin points (closed loop). */
  margin?: ReadonlyArray<V3> | null;
  /** The insertion-axis analysis; null when it has not run this session. */
  axis?: AxisReport | null;
  crown?: Pick<CrownStatus, 'validation' | 'thickness' | 'minAxialThicknessMm' | 'adapt'> | null;
  params: Pick<DesignParams, 'minThicknessMm'>;
  /** Material name for the thickness row, e.g. "Zirconia". */
  material: string;
  /** Adaptation targets exist but a later edit switched them off. */
  adaptationStale: boolean;
  /** Neighbours found in the tooth frame; contacts are checked only where there is one. */
  neighbours: { mesial: boolean; distal: boolean };
  /** Steps this unit has (a pontic has no margin or axis); rows it does not need are left out. */
  needs?: { margin: boolean; axis: boolean };
}

/** The rows a unit needs, from its design steps: a pontic has no margin or insertion axis. */
export function readinessNeeds(kind: UnitKind): NonNullable<ReadinessInput['needs']> {
  const steps = stepsFor(kind);
  return { margin: steps.includes('margin'), axis: steps.includes('axis') };
}

const loopLength = (points: ReadonlyArray<V3>) =>
  points.reduce((sum, a, i) => {
    const b = points[(i + 1) % points.length]!;
    return sum + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }, 0);

const mm = (v: number) => `${v.toFixed(2)} mm`;

const ADAPT_ROWS = [
  { kind: 'occlusion', label: 'Occlusion adapted', what: 'the antagonist' },
  { kind: 'mesial', label: 'Mesial contact adapted', what: 'the mesial neighbour' },
  { kind: 'distal', label: 'Distal contact adapted', what: 'the distal neighbour' },
] as const;

/**
 * Whether the crown is ready to mill: the orchestrator's QA gates (margin,
 * axis, solid, thickness, adaptation) evaluated on the current design and
 * phrased as rows with their measured values. "unknown" means not measured
 * yet, which is not ready either.
 */
export function millReadiness(input: ReadinessInput): ReadinessItem[] {
  const { crown, axis, params, needs = { margin: true, axis: true } } = input;
  const items: ReadinessItem[] = [];

  if (needs.margin) {
    const points = input.margin ?? [];
    if (points.length < 3) items.push({ id: 'margin', label: 'Margin closed', status: 'fail', detail: 'No margin drawn' });
    else {
      const lengthMm = loopLength(points);
      const failed = marginGate({ points, lengthMm, prepClosed: axis?.prepClosed }).find((c) => !c.passed);
      items.push({ id: 'margin', label: 'Margin closed', status: failed ? 'fail' : 'pass', detail: failed ? failed.message : `Closed loop, ${lengthMm.toFixed(1)} mm` });
    }
  }

  if (needs.axis) {
    if (!axis) items.push({ id: 'axis', label: 'Margin seats along the axis', status: 'unknown', detail: 'Not measured yet: open Insertion axis' });
    else {
      const failed = axisGate(axis).find((c) => !c.passed);
      items.push({
        id: 'axis',
        label: 'Margin seats along the axis',
        status: failed ? 'fail' : 'pass',
        detail: `${axis.marginUndercutCount} of ${axis.marginPointCount} margin points in undercut, ${axis.angleFromOcclusalDeg.toFixed(1)}° from occlusal`,
      });
    }
  }

  const v = crown?.validation;
  const min = crown?.thickness?.minMm ?? crown?.minAxialThicknessMm;
  if (!crown || !v || min === undefined || !Number.isFinite(min)) {
    items.push({ id: 'solid', label: 'Watertight solid', status: 'unknown', detail: 'The crown has not been computed yet' });
    items.push({ id: 'thickness', label: 'Thick enough', status: 'unknown', detail: `${input.material} minimum ${mm(params.minThicknessMm)}` });
  } else {
    const gate = crownGate({ validation: v, thickness: crown.thickness, minAxialThicknessMm: min }, params);
    const solidOk = gate.find((c) => c.id === 'crown.valid')!.passed && gate.find((c) => c.id === 'crown.printable')!.passed;
    items.push({
      id: 'solid',
      label: 'Watertight solid',
      status: solidOk ? 'pass' : 'fail',
      detail: !v.ok ? 'Not a closed solid: open or flipped edges' : v.printable === false ? `${v.selfIntersections} self-intersecting triangle pairs` : 'Closed, no self-intersections',
    });
    items.push({
      id: 'thickness',
      label: 'Thick enough',
      status: gate.find((c) => c.id === 'crown.thickness')!.passed ? 'pass' : 'fail',
      detail: `Thinnest ${mm(min)}, ${input.material} minimum ${mm(params.minThicknessMm)}`,
    });
  }

  for (const row of ADAPT_ROWS) {
    if (row.kind !== 'occlusion' && !input.neighbours[row.kind]) continue;
    const report = crown?.adapt?.[row.kind];
    if (input.adaptationStale) items.push({ id: row.kind, label: row.label, status: 'fail', detail: 'Off since the last change: re-adapt' });
    else if (!report) items.push({ id: row.kind, label: row.label, status: 'fail', detail: `Not adapted to ${row.what}` });
    else {
      const check = adaptGate({ adapt: { [row.kind]: report } })[0]!;
      const target = report.targetMm !== undefined ? `, target ${mm(report.targetMm)}` : '';
      items.push({ id: row.kind, label: row.label, status: check.passed ? 'pass' : 'fail', detail: check.passed ? `Closest ${mm(report.minClearanceMm)}${target}` : check.message });
    }
  }
  return items;
}

export const isReady = (items: readonly ReadinessItem[]): boolean => items.every((i) => i.status === 'pass');
