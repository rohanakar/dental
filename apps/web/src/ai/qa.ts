import type { DesignParams, QaCheck } from '@dcad/shared';
import { MARGIN_LENGTH_MM, MARGIN_MAX_TURN_DEG, MARGIN_MAX_WANDER, sharpestTurnDeg } from '../geometry/marginShape';
import type { BridgeChecks } from '../geometry/bridgeUnion';
import type { ConnectorFailure } from '../geometry/connectors';
import type { ScrewChannelReport } from '../geometry/implantCrown';
import type { AxisAnalysis, CrownResult } from '../workers/analysisTypes';
import type { FrameworkView } from '../workers/frameworkTypes';

type V3 = readonly [number, number, number];

/** The walker's and the watershed's gum lines agree within this mean distance (mm) on a trustworthy line. */
export const GUM_LINE_MAX_DISAGREEMENT_MM = 0.3;
/**
 * A gum line shorter than this share of the tooth's nominal cervical ellipse has collapsed onto the crown. (Real gum
 * lines run 1.2–2.4× the ellipse, scalloped round the papillae; smooth synthetic teeth about 1.0.)
 */
export const GUM_LINE_MIN_PERIMETER = 0.8;

/**
 * Gate for a natural tooth's gum line (geometry/naturalMargin.ts; specs/2026-10-27-natural-margin.md). The line is
 * doubtful when the two methods that find it (the random walker and the watershed) disagree, or when it is too short
 * to go round the tooth. On the development set (115 real cases, with the click moved 1.5 mm) this flags 7 of the 12
 * wrong lines and 6 of the 103 right ones. The 120° kink rule of a prep's finish line is left out: a gum line turns
 * sharply at the papillae.
 */
export function gumLineGate(input: { lengthMm: number; prepClosed?: boolean; agreementMm: number; perimeterRatio: number }): QaCheck[] {
  const checks = [
    check('margin.length', input.lengthMm >= MARGIN_LENGTH_MM[0] && input.lengthMm <= MARGIN_LENGTH_MM[1], 'Margin length within 8–60 mm', input.lengthMm, undefined, { unit: 'mm' }),
    check('margin.agree', input.agreementMm <= GUM_LINE_MAX_DISAGREEMENT_MM, 'Clear gum line: two ways of tracing it agree (mean distance apart)', input.agreementMm, GUM_LINE_MAX_DISAGREEMENT_MM, { unit: 'mm', bound: 'max' }),
    check('margin.round', input.perimeterRatio >= GUM_LINE_MIN_PERIMETER, 'Goes round the whole tooth: length over the tooth’s usual outline', input.perimeterRatio, GUM_LINE_MIN_PERIMETER, { bound: 'min' }),
  ];
  if (input.prepClosed !== undefined) checks.unshift(check('margin.closed', input.prepClosed, 'The margin is closed all the way round the tooth'));
  return checks;
}

/** Gates for the auto-design orchestrator: deterministic checks, not "confidence". */

const round = (n: number, d = 3) => Number(n.toFixed(d));
/** How a value reads (`qaValueText`): its unit, which side of the threshold passes, a measuring tolerance. */
type Reading = Pick<QaCheck, 'unit' | 'bound' | 'tolerance'> & { digits?: number };
const check = (id: string, passed: boolean, message: string, value?: number, threshold?: number, { digits = 3, ...reading }: Reading = {}): QaCheck => ({
  id,
  passed,
  message,
  ...(value !== undefined && Number.isFinite(value) ? { value: round(value, digits) } : {}),
  ...(threshold !== undefined ? { threshold } : {}),
  ...reading,
});

/** Thickness is measured on the mesh: a wall this much under the material minimum still passes. */
export const THICKNESS_TOLERANCE_MM = 0.02;

export { sharpestTurnDeg };

/**
 * Margin: traced and closed, plausible length, no kinks. `points` is the
 * dense resampled margin (~0.2 mm); a turn sharper than 120° over a ~0.6 mm
 * stride means the live-wire doubled back.
 */
export function marginGate(input: { points: ReadonlyArray<V3>; lengthMm: number; prepClosed?: boolean; confidence?: number; wander?: number }): QaCheck[] {
  const turn = sharpestTurnDeg(input.points);
  const checks = [
    check('margin.length', input.lengthMm >= MARGIN_LENGTH_MM[0] && input.lengthMm <= MARGIN_LENGTH_MM[1], 'Margin length within 8–60 mm', input.lengthMm, undefined, { unit: 'mm' }),
    check('margin.smooth', turn <= MARGIN_MAX_TURN_DEG, 'No kinks: sharpest bend in the margin line', turn, MARGIN_MAX_TURN_DEG, { unit: 'deg', bound: 'max' }),
  ];
  if (input.prepClosed !== undefined) checks.unshift(check('margin.closed', input.prepClosed, 'The margin is closed all the way round the prep'));
  if (input.wander !== undefined) {
    checks.push(check('margin.wander', input.wander <= MARGIN_MAX_WANDER, 'No detours: traced length over the length round its anchors', input.wander, MARGIN_MAX_WANDER, { bound: 'max' }));
  }
  if (input.confidence !== undefined) checks.push(check('margin.ridge', input.confidence >= 0.75, 'The margin edge shows clearly around the prep: share of the way round', input.confidence, 0.75, { unit: 'fraction', bound: 'min' }));
  return checks;
}

/** Axis: the margin is fully visible along the axis and the axis is not tilted wildly. */
export function axisGate(axis: Pick<AxisAnalysis, 'marginUndercutCount' | 'angleFromOcclusalDeg' | 'prepClosed'>): QaCheck[] {
  return [
    check('axis.marginUndercut', axis.marginUndercutCount === 0, 'Margin points in an undercut along the insertion axis', axis.marginUndercutCount, 0),
    check('axis.angle', axis.angleFromOcclusalDeg <= 25, 'Insertion axis tilt from the biting direction', axis.angleFromOcclusalDeg, 25, { unit: 'deg', bound: 'max' }),
    check('axis.prepClosed', axis.prepClosed, 'The margin is closed all the way round the prep'),
  ];
}

/**
 * Crown: a valid, printable solid that respects the material minimum (shown as the limit, passing within
 * THICKNESS_TOLERANCE_MM).
 */
export function crownGate(result: Pick<CrownResult, 'validation' | 'thickness' | 'minAxialThicknessMm'>, params: Pick<DesignParams, 'minThicknessMm'>): QaCheck[] {
  const min = result.thickness?.minMm ?? result.minAxialThicknessMm;
  const limit = round(params.minThicknessMm - THICKNESS_TOLERANCE_MM);
  return [
    check('crown.valid', result.validation.ok, 'Closed, watertight solid'),
    check('crown.printable', result.validation.printable === true, 'Places where the surface crosses itself', result.validation.selfIntersections, 0),
    check('crown.thickness', min >= limit, 'Thinnest material away from the margin', min, params.minThicknessMm, { unit: 'mm', bound: 'min', tolerance: THICKNESS_TOLERANCE_MM }),
  ];
}

/** Adapt: every requested target was reached, without a conflict and without leaving it open. */
export function adaptGate(result: Pick<CrownResult, 'adapt'>): QaCheck[] {
  const reports = Object.entries(result.adapt ?? {});
  if (reports.length === 0) return [check('adapt.applied', false, 'No adaptation was applied')];
  return reports.map(([kind, r]) => {
    const label = kind === 'occlusion' ? 'Occlusion' : `${kind[0]!.toUpperCase()}${kind.slice(1)} contact`;
    if (r?.conflict) return check(`adapt.${kind}`, false, `${label}: ${r.conflict.kind} at ${r.conflict.vertices} points, closest distance`, r.conflict.minClearanceMm, undefined, { unit: 'mm' });
    if (r?.open) {
      const gap = Number.isFinite(r.open.clearanceMm) ? `${r.open.clearanceMm.toFixed(2)} mm to the ${kind === 'occlusion' ? 'antagonist' : 'neighbour'}` : 'nothing within reach';
      return check(`adapt.${kind}`, false, `${label} open: ${gap}`, r.open.clearanceMm, r.targetMm, { unit: 'mm', bound: 'max' });
    }
    return check(`adapt.${kind}`, true, `${label}: target reached, closest distance`, r?.minClearanceMm, undefined, { unit: 'mm' });
  });
}

/**
 * Tolerances of the bridge checks, as in `geometry/bridgeUnion.ts` (not imported from there: that module would pull
 * the union checks into the main bundle).
 */
export const SEATING_TOLERANCE_MM = 0.005;
export const PONTIC_BASE_TOLERANCE_MM = 0.02;
export const PONTIC_BASE_MAX_EXCESS_MM = 0.05;

// ---- implants, wings and frameworks ------------------------------------------------------------------------

/** The scan-body match gate, as `geometry/scanBody.ts` SCAN_BODY_GATE (not imported: the registration stays in the worker). */
export const SCAN_BODY_GATE = { maxRmsMm: 0.05, minInlierFraction: 0.9, minCoverage: 0.6 } as const;

/**
 * Implant position (classical.scan-body-match): the library scan body fits the scanned one. RMS of the fit, the
 * fraction of scan points within the outlier distance (inliers), and the share of the scan body's surface the scan
 * covers.
 */
export function scanBodyGate(fit: { rmsMm: number; inlierFraction: number; coverage: number }): QaCheck[] {
  const g = SCAN_BODY_GATE;
  return [
    // In µm: the fit is a few µm on a clean scan, which reads as 0 in mm.
    check('implant.fit.rms', fit.rmsMm <= g.maxRmsMm, 'Scan body match: average distance to the scan', fit.rmsMm * 1000, g.maxRmsMm * 1000, { digits: 1, unit: 'um', bound: 'max' }),
    check('implant.fit.inliers', fit.inlierFraction >= g.minInlierFraction, 'Share of the scan points that lie on the matched scan body', fit.inlierFraction, g.minInlierFraction, { unit: 'fraction', bound: 'min' }),
    check('implant.fit.coverage', fit.coverage >= g.minCoverage, "Share of the scan body's surface captured in the scan", fit.coverage, g.minCoverage, { unit: 'fraction', bound: 'min' }),
  ];
}

/** An implant crown seats on its Ti-base along the insertion axis: no shoulder point is hidden under the Ti-base. */
export function implantSeatGate(implant: { rimUndercutCount: number }): QaCheck[] {
  return [check('implant.seat', implant.rimUndercutCount === 0, 'Seats on its Ti-base along the insertion axis: shoulder points in an undercut', implant.rimUndercutCount, 0)];
}

/** Implant bridge path: the implants diverge no more than their Ti-base library allows, so the bridge seats on one path. */
export function implantPathGate(path: { divergenceDeg: number; maxDivergenceDeg: number }): QaCheck[] {
  return [
    check('implant.divergence', path.divergenceDeg <= path.maxDivergenceDeg + 1e-9, 'Largest angle between two implants', path.divergenceDeg, path.maxDivergenceDeg, { digits: 2, unit: 'deg', bound: 'max' }),
  ];
}

type ChannelView = Pick<ScrewChannelReport, 'exitOk' | 'wallOk' | 'minWallMm' | 'requiredWallMm'>;

/** Exit, wall and (when the restoration was cut) the cut of one screw channel, as `<prefix>.exit` etc. */
function channelChecks(prefix: string, label: string, channel: ChannelView, cut?: { ok: boolean }): QaCheck[] {
  return [
    check(`${prefix}.exit`, channel.exitOk, `${label} opens on the occlusal surface (lingual on front teeth)`),
    check(`${prefix}.wall`, channel.wallOk, `${label}: thinnest material around it`, channel.minWallMm, round(channel.requiredWallMm), { unit: 'mm', bound: 'min' }),
    ...(cut ? [check(`${prefix}.cut`, cut.ok, `${label} is cut through, leaving one clean piece`)] : []),
  ];
}

/**
 * Screw channel (classical.screw-channel): straight or angled within the library maximum, it exits occlusally
 * (lingually on anterior teeth) with at least the minimum wall. `null` = no angle in the ASC cone passes. With
 * `cut`, the restoration with the channel subtracted is one solid of genus 1.
 */
export function screwChannelGate(channel: ChannelView | null, cut?: { ok: boolean }): QaCheck[] {
  if (!channel) {
    return [check('implant.channel.exit', false, 'No screw channel angle the Ti-base allows opens occlusally with enough material around it')];
  }
  return channelChecks('implant.channel', 'The screw channel', channel, cut);
}

/**
 * Wing outline (classical.wing-outline): a closed loop on the tooth (at least 3 anchors, the dense outline closes),
 * whose region does not leak when flood-filled from the frame origin, with a bonded area inside it.
 */
export function wingOutlineGate(outline: { anchors: number; points: Float32Array; regionClosed: boolean; areaMm2: number }): QaCheck[] {
  const n = outline.points.length / 3;
  const gap = n >= 3 ? Math.hypot(outline.points[0]! - outline.points[(n - 1) * 3]!, outline.points[1]! - outline.points[(n - 1) * 3 + 1]!, outline.points[2]! - outline.points[(n - 1) * 3 + 2]!) : Infinity;
  return [
    check('wing.outline.closed', outline.anchors >= 3 && gap < 1, 'The wing outline is a closed loop on the tooth'),
    check('wing.outline.region', outline.regionClosed, 'The outline fully encloses the area to bond'),
    check('wing.outline.area', outline.areaMm2 > 0, 'Bonding area inside the outline', outline.areaMm2, 0, { digits: 1, unit: 'mm2' }),
  ];
}

/** Largest veneer deficit tolerated by the cutback gate (mm). */
export const CUTBACK_MAX_DEFICIT_MM = 0.1;

/**
 * Cutback (classical.cutback): the framework is a valid, printable solid and nowhere leaves the veneer more than
 * CUTBACK_MAX_DEFICIT_MM thinner than requested ("insufficient veneering space": the framework minimum won there).
 */
export function cutbackGate(framework: Pick<FrameworkView, 'shortfall' | 'validation'> | undefined): QaCheck[] {
  if (!framework) return [check('cutback.framework', false, 'The reduced unit has no framework (no cutback was applied)')];
  const deficit = framework.shortfall?.maxDeficitMm ?? 0;
  return [
    check('cutback.valid', framework.validation.ok && framework.validation.printable, 'The framework is a closed, printable solid'),
    check(
      'cutback.shortfall',
      deficit <= CUTBACK_MAX_DEFICIT_MM,
      framework.shortfall
        ? `Insufficient veneering space on ${framework.shortfall.areaMm2.toFixed(1)} mm²: largest shortfall`
        : 'Full veneering space everywhere: largest shortfall',
      deficit,
      CUTBACK_MAX_DEFICIT_MM,
      { unit: 'mm', bound: 'max' },
    ),
  ];
}

/** An implant unit of a designed bridge: its screw channel, and whether the restoration was cut with it. */
interface ImplantUnitGateView {
  channel: ChannelView;
  cut?: unknown;
  cutOk?: boolean;
}

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
  /** The units as designed: implant crowns add their screw channels (and one through-hole each to the union). */
  units?: ReadonlyArray<{ fdi: number; implant?: ImplantUnitGateView }>;
}

/**
 * Bridge: the merged solid and its connectors, measured on the union (classical.connectors@1):
 * - the union is closed, printable, and one component whose genus is the number of screw channels (one through-hole
 *   per implant crown, 0 without implants); a failed or missing union fails with the reason;
 * - per connector (`bridge.connector.35-36.*`): the smallest measured section is at least the designed area and the
 *   material minimum, its height at least the minimum height, and the design reported no failure
 *   ('insufficient-height', 'too-wide', 'fit-clearance', 'tooth-clash');
 * - per retainer: the seating (the cement gap; on an implant crown the bonding gap on its Ti-base) is unchanged on
 *   the union, within SEATING_TOLERANCE_MM and on the same number of samples;
 * - per pontic: the smallest base gap to the ridge is within ponticRidgeGapMm − PONTIC_BASE_TOLERANCE_MM …
 *   + PONTIC_BASE_MAX_EXCESS_MM (shown as the minimum ponticRidgeGapMm with the tolerance named);
 * - per implant crown (`bridge.channel.35.*`): its screw channel exits occlusally (lingually on anterior teeth) with
 *   at least the minimum wall, and was cut;
 * - per Maryland wing: the wing checks measured with the union (outline and surface undercut, thickness, space);
 * - per inlay or onlay: the inlay checks (margin fit, isthmus thickness, margin undercut, library fit).
 * The per-unit crown and adapt gates run separately.
 */
export function bridgeGate(result: BridgeGateInput): QaCheck[] {
  const qa: QaCheck[] = [];
  const checks = result.union?.checks;
  const implants = (result.units ?? []).flatMap((u) => (u.implant ? [{ fdi: u.fdi, implant: u.implant }] : []));
  const channels = implants.length;
  if (!checks) {
    const reason = result.unionError ? `The units could not be merged into one solid: ${result.unionError}` : 'The bridge was not merged into one solid';
    qa.push(check('bridge.union', false, reason));
  } else {
    const u = checks.union;
    qa.push(
      check('bridge.union.valid', u.closed && u.oriented && u.volumeMm3 > 0 && u.degenerateTriangles === 0, 'The merged bridge is a closed, watertight solid'),
      check('bridge.union.printable', u.printable && u.selfIntersections === 0, "Places where the merged bridge's surface crosses itself", u.selfIntersections, 0),
      check('bridge.union.components', u.components === 1, 'The merged bridge is one piece: number of pieces', u.components, 1),
      check(
        'bridge.union.genus',
        u.genus === channels,
        channels ? 'Holes through the merged bridge: one per screw channel' : 'Holes through the merged bridge: none expected',
        u.genus,
        channels,
      ),
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
          check(`${id}.area`, c.measured.minAreaMm2 >= areaLimit, `Connector ${a}–${b}: smallest cross-section`, c.measured.minAreaMm2, round(areaLimit), { unit: 'mm2', bound: 'min' }),
          check(`${id}.height`, height >= c.minHeightMm, `Connector ${a}–${b}: height`, height, c.minHeightMm, { unit: 'mm', bound: 'min' }),
        );
      }
    }
    for (const f of connector.failures) qa.push(check(`${id}.${f.code}`, false, f.message, f.valueMm, round(f.limitMm), { unit: 'mm' }));
  }

  for (const s of checks?.seating ?? []) {
    const change = Math.max(s.deltaMeanMm, s.deltaMaxMm);
    const ok = s.onUnion.samples > 0 && s.onUnion.samples === s.own.samples && s.deltaMeanMm <= SEATING_TOLERANCE_MM && s.deltaMaxMm <= SEATING_TOLERANCE_MM;
    const message = implants.some((i) => i.fdi === s.fdi)
      ? `Implant crown ${s.fdi}: fit on its Ti-base unchanged after merging, largest change of the bonding gap`
      : `Retainer ${s.fdi}: fit unchanged after merging, largest change of the cement gap`;
    qa.push(check(`bridge.seating.${s.fdi}`, ok, message, change, SEATING_TOLERANCE_MM, { digits: 4, unit: 'mm', bound: 'max' }));
  }
  for (const p of checks?.ponticBase ?? []) {
    const limit = p.targetMm - PONTIC_BASE_TOLERANCE_MM;
    const ok = p.samples > 0 && p.minGapMm >= limit && p.minGapMm <= p.targetMm + PONTIC_BASE_MAX_EXCESS_MM && p.meanGapMm >= limit;
    const message = `Pontic ${p.fdi}: smallest gap from the base to the ridge, at most ${PONTIC_BASE_MAX_EXCESS_MM} mm above the minimum`;
    qa.push(check(`bridge.ponticBase.${p.fdi}`, ok, message, p.minGapMm, p.targetMm, { unit: 'mm', bound: 'min', tolerance: PONTIC_BASE_TOLERANCE_MM }));
  }
  for (const { fdi, implant } of implants) {
    const cut = { ok: Boolean(implant.cut) && implant.cutOk !== false };
    qa.push(...channelChecks(`bridge.channel.${fdi}`, `Implant crown ${fdi}: the screw channel`, implant.channel, cut));
  }
  for (const w of checks?.wings ?? []) qa.push(...w.checks);
  for (const i of checks?.inlays ?? []) qa.push(...i.checks);
  return qa;
}

export const passed = (qa: readonly QaCheck[]): boolean => qa.every((c) => c.passed);

/** Checks that measure what another id measures: the axis gate re-checks the closure the margin gate checked. */
const SAME_AS: Record<string, string> = { 'axis.prepClosed': 'margin.closed' };

/**
 * The rows of a run with each check counted once: a check that a later row measures again (the crown's validity and
 * thickness after adaptation, the margin's closure on the axis) stays only on that last row, so the review shows the
 * final numbers. Rows of different teeth (a bridge's per-abutment rows) never repeat each other.
 */
export function latestChecks<R extends { fdi?: number; qa: readonly QaCheck[] }>(rows: readonly R[]): R[] {
  const key = (row: R, c: QaCheck) => `${row.fdi ?? ''}|${SAME_AS[c.id] ?? c.id}`;
  const last = new Map<string, number>();
  rows.forEach((row, i) => row.qa.forEach((c) => last.set(key(row, c), i)));
  return rows.map((row, i) => ({ ...row, qa: row.qa.filter((c) => last.get(key(row, c)) === i) }));
}
