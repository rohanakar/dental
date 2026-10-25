import type { DesignParams, QaCheck } from '@dcad/shared';
import type { BridgeChecks } from '../geometry/bridgeUnion';
import type { ConnectorFailure } from '../geometry/connectors';
import type { AxisAnalysis, CrownResult } from '../workers/analysisTypes';

type V3 = readonly [number, number, number];

/** Gates for the auto-design orchestrator: deterministic checks, not "confidence". */

const round = (n: number, d = 3) => Number(n.toFixed(d));
const check = (id: string, passed: boolean, message: string, value?: number, threshold?: number, digits = 3): QaCheck => ({
  id,
  passed,
  message,
  ...(value !== undefined && Number.isFinite(value) ? { value: round(value, digits) } : {}),
  ...(threshold !== undefined ? { threshold } : {}),
});

/** Sharpest turn (degrees) between consecutive segments of a closed polyline. */
/**
 * Sharpest turn (degrees) between chords spanning about `strideMm` before
 * and after each point of a closed curve. Measuring over a stride (not
 * between adjacent 0.2 mm segments) ignores sub-stride jitter from snapping
 * to scan vertices, while a live-wire that doubles back (a millimetre-scale
 * reversal) still shows up as a turn near 180°.
 */
export function sharpestTurnDeg(points: ReadonlyArray<V3>, strideMm = 0.6): number {
  const n = points.length;
  if (n < 3) return 0;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const k = Math.max(1, Math.min(Math.floor(n / 4), Math.round(strideMm / (length / n))));
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const a = points[(i - k + n) % n]!, b = points[i]!, c = points[(i + k) % n]!;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const lu = Math.hypot(u[0]!, u[1]!, u[2]!), lv = Math.hypot(v[0]!, v[1]!, v[2]!);
    if (lu < 1e-9 || lv < 1e-9) continue;
    const cos = (u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!) / (lu * lv);
    worst = Math.max(worst, (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
  }
  return worst;
}

/**
 * Margin: traced and closed, plausible length, no kinks. `points` is the
 * dense resampled margin (~0.2 mm); a turn sharper than 120° over a ~0.6 mm
 * stride means the live-wire doubled back.
 */
export function marginGate(input: { points: ReadonlyArray<V3>; lengthMm: number; prepClosed?: boolean; confidence?: number }): QaCheck[] {
  const turn = sharpestTurnDeg(input.points);
  const checks = [
    check('margin.length', input.lengthMm >= 8 && input.lengthMm <= 60, 'Margin length is plausible for a posterior tooth (8–60 mm)', input.lengthMm),
    check('margin.smooth', turn <= 120, 'No kinks (sharpest turn over 0.6 mm ≤ 120°)', turn, 120),
  ];
  if (input.prepClosed !== undefined) checks.unshift(check('margin.closed', input.prepClosed, 'The margin closes the prep region (no leak)'));
  if (input.confidence !== undefined) checks.push(check('margin.ridge', input.confidence >= 0.75, 'The margin ridge was found on most radial profiles', input.confidence, 0.75));
  return checks;
}

/** Axis: the margin is fully visible along the axis and the axis is not tilted wildly. */
export function axisGate(axis: Pick<AxisAnalysis, 'marginUndercutCount' | 'angleFromOcclusalDeg' | 'prepClosed'>): QaCheck[] {
  return [
    check('axis.marginUndercut', axis.marginUndercutCount === 0, 'No margin points in an undercut along the axis', axis.marginUndercutCount, 0),
    check('axis.angle', axis.angleFromOcclusalDeg <= 25, 'Axis within 25° of the occlusal direction', axis.angleFromOcclusalDeg, 25),
    check('axis.prepClosed', axis.prepClosed, 'The prep region is closed by the margin'),
  ];
}

/** Crown: a valid, printable solid that respects the minimum thickness. */
export function crownGate(result: Pick<CrownResult, 'validation' | 'thickness' | 'minAxialThicknessMm'>, params: Pick<DesignParams, 'minThicknessMm'>): QaCheck[] {
  const min = result.thickness?.minMm ?? result.minAxialThicknessMm;
  const limit = round(params.minThicknessMm - 0.02);
  return [
    check('crown.valid', result.validation.ok, 'Closed, consistently oriented solid with positive volume'),
    check('crown.printable', result.validation.printable === true, 'No self-intersections', result.validation.selfIntersections, 0),
    check('crown.thickness', min >= limit, 'Minimum material thickness away from the margin band (mm)', min, limit),
  ];
}

/** Adapt: every requested target was reached, without a conflict and without leaving it open. */
export function adaptGate(result: Pick<CrownResult, 'adapt'>): QaCheck[] {
  const reports = Object.entries(result.adapt ?? {});
  if (reports.length === 0) return [check('adapt.applied', false, 'No adaptation was applied')];
  return reports.map(([kind, r]) => {
    if (r?.conflict) return check(`adapt.${kind}`, false, `${kind}: ${r.conflict.kind} at ${r.conflict.vertices} vertices`, r.conflict.minClearanceMm);
    if (r?.open) {
      const gap = Number.isFinite(r.open.clearanceMm) ? `${r.open.clearanceMm.toFixed(2)} mm` : 'nothing within reach';
      return check(`adapt.${kind}`, false, `${kind}: ${kind === 'occlusion' ? 'occlusion' : 'contact'} open (${gap})`, r.open.clearanceMm, r.targetMm);
    }
    return check(`adapt.${kind}`, true, `${kind}: target reached`, r?.minClearanceMm);
  });
}

/**
 * Tolerances of the bridge checks, as in `geometry/bridgeUnion.ts` (not imported from there: that module would pull
 * the union checks into the main bundle).
 */
export const SEATING_TOLERANCE_MM = 0.005;
export const PONTIC_BASE_TOLERANCE_MM = 0.02;

/**
 * A designed bridge for the bridge gate: the worker's `BridgeResultView` or the geometry's `BridgeResult`, both
 * designed with `union: true`.
 */
export interface BridgeGateInput {
  /** The connectors as designed, with the failures their design reported. */
  connectors: ReadonlyArray<{ between: readonly [number, number]; failures: readonly ConnectorFailure[] }>;
  /** The checks measured on the merged solid. */
  union?: { checks: BridgeChecks };
  /** Why the boolean engine refused to merge the units (there is then no `union`). */
  unionError?: string;
}

/**
 * Bridge: the merged solid and its connectors, measured on the union (classical.connectors@1):
 * - the union is closed, printable, and one component of genus 0; a failed or missing union fails with the reason;
 * - per connector (`bridge.connector.35-36.*`): the smallest measured section is at least the designed area and the
 *   material minimum, its height at least the minimum height, and the design reported no failure
 *   ('insufficient-height', 'too-wide');
 * - per retainer: the seating (cement gap) is unchanged on the union, within SEATING_TOLERANCE_MM;
 * - per pontic: the base gap to the ridge is at least ponticRidgeGapMm − PONTIC_BASE_TOLERANCE_MM.
 * The per-unit crown and adapt gates run separately.
 */
export function bridgeGate(result: BridgeGateInput): QaCheck[] {
  const qa: QaCheck[] = [];
  const checks = result.union?.checks;
  if (!checks) {
    const reason = result.unionError ? `The units could not be merged into one solid: ${result.unionError}` : 'The bridge was not merged into one solid';
    qa.push(check('bridge.union', false, reason));
  } else {
    const u = checks.union;
    qa.push(
      check('bridge.union.valid', u.closed && u.oriented && u.volumeMm3 > 0 && u.degenerateTriangles === 0, 'The merged bridge is a closed, consistently oriented solid with positive volume'),
      check('bridge.union.printable', u.printable && u.selfIntersections === 0, 'The merged bridge has no self-intersections', u.selfIntersections, 0),
      check('bridge.union.components', u.components === 1, 'The merged bridge is one connected solid', u.components, 1),
      check('bridge.union.genus', u.genus === 0, 'The merged bridge has no through-holes (genus 0)', u.genus, 0),
    );
  }

  for (const connector of result.connectors) {
    const [a, b] = connector.between;
    const id = `bridge.connector.${a}-${b}`;
    if (checks) {
      const c = checks.connectors.find((m) => m.between[0] === a && m.between[1] === b);
      if (!c) {
        qa.push(check(`${id}.measured`, false, `Connector ${a}–${b} was not measured on the merged bridge`));
      } else {
        const areaLimit = Math.max(c.targetAreaMm2, c.minAreaMm2);
        const height = Math.min(c.measured.heightMm, c.designedHeightMm);
        qa.push(
          check(`${id}.area`, c.measured.minAreaMm2 >= areaLimit, `Connector ${a}–${b}: smallest measured section ≥ the designed area and the material minimum (mm²)`, c.measured.minAreaMm2, round(areaLimit)),
          check(`${id}.height`, height >= c.minHeightMm, `Connector ${a}–${b}: height ≥ the minimum (mm)`, height, c.minHeightMm),
        );
      }
    }
    for (const f of connector.failures) qa.push(check(`${id}.${f.code}`, false, f.message, f.valueMm, round(f.limitMm)));
  }

  for (const s of checks?.seating ?? []) {
    const change = Math.max(s.deltaMeanMm, s.deltaMaxMm);
    const ok = s.onUnion.samples > 0 && s.deltaMeanMm <= SEATING_TOLERANCE_MM && s.deltaMaxMm <= SEATING_TOLERANCE_MM;
    qa.push(check(`bridge.seating.${s.fdi}`, ok, `Retainer ${s.fdi}: seating unchanged in the merged bridge (largest change of the cement gap, mm)`, change, SEATING_TOLERANCE_MM, 4));
  }
  for (const p of checks?.ponticBase ?? []) {
    const limit = p.targetMm - PONTIC_BASE_TOLERANCE_MM;
    const ok = p.samples > 0 && p.minGapMm >= limit && p.meanGapMm >= limit;
    qa.push(check(`bridge.ponticBase.${p.fdi}`, ok, `Pontic ${p.fdi}: smallest gap from the base to the ridge (mm)`, p.minGapMm, round(limit)));
  }
  return qa;
}

export const passed = (qa: readonly QaCheck[]): boolean => qa.every((c) => c.passed);
