import type { DesignParams, QaCheck } from '@dcad/shared';
import type { BridgeChecks } from '../geometry/bridgeUnion';
import type { ConnectorFailure } from '../geometry/connectors';
import type { ScrewChannelReport } from '../geometry/implantCrown';
import type { AxisAnalysis, CrownResult } from '../workers/analysisTypes';
import type { FrameworkView } from '../workers/frameworkTypes';

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
    check('implant.fit.rms', fit.rmsMm <= g.maxRmsMm, 'Scan-body fit RMS (µm)', fit.rmsMm * 1000, g.maxRmsMm * 1000, 1),
    check('implant.fit.inliers', fit.inlierFraction >= g.minInlierFraction, 'Scan points that fit the matched scan body (fraction)', fit.inlierFraction, g.minInlierFraction),
    check('implant.fit.coverage', fit.coverage >= g.minCoverage, 'Scan-body surface covered by the scan (fraction)', fit.coverage, g.minCoverage),
  ];
}

/** An implant crown seats on its Ti-base along the insertion axis: no shoulder point is hidden under the Ti-base. */
export function implantSeatGate(implant: { rimUndercutCount: number }): QaCheck[] {
  return [check('implant.seat', implant.rimUndercutCount === 0, 'Seats on its Ti-base along the insertion axis (shoulder points in an undercut)', implant.rimUndercutCount, 0)];
}

/** Implant bridge path: the implants diverge no more than their Ti-base library allows, so the bridge seats on one path. */
export function implantPathGate(path: { divergenceDeg: number; maxDivergenceDeg: number }): QaCheck[] {
  return [
    check('implant.divergence', path.divergenceDeg <= path.maxDivergenceDeg + 1e-9, 'Largest angle between two implant axes ≤ the Ti-base library maximum (°)', path.divergenceDeg, path.maxDivergenceDeg, 2),
  ];
}

type ChannelView = Pick<ScrewChannelReport, 'exitOk' | 'wallOk' | 'minWallMm' | 'requiredWallMm'>;

/** Exit, wall and (when the restoration was cut) the cut of one screw channel, as `<prefix>.exit` etc. */
function channelChecks(prefix: string, label: string, channel: ChannelView, cut?: { ok: boolean }): QaCheck[] {
  return [
    check(`${prefix}.exit`, channel.exitOk, `${label} exits on the occlusal (posterior) or lingual (anterior) surface`),
    check(`${prefix}.wall`, channel.wallOk, `${label}: thinnest wall around it (mm)`, channel.minWallMm, round(channel.requiredWallMm)),
    ...(cut ? [check(`${prefix}.cut`, cut.ok, `${label} is cut, leaving one clean solid with a through-hole`)] : []),
  ];
}

/**
 * Screw channel (classical.screw-channel): straight or angled within the library maximum, it exits occlusally
 * (lingually on anterior teeth) with at least the minimum wall. `null` = no angle in the ASC cone passes. With
 * `cut`, the restoration with the channel subtracted is one solid of genus 1.
 */
export function screwChannelGate(channel: ChannelView | null, cut?: { ok: boolean }): QaCheck[] {
  if (!channel) {
    return [check('implant.channel.exit', false, 'No screw channel angle within the Ti-base library maximum exits occlusally with enough wall')];
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
    check('wing.outline.region', outline.regionClosed, 'The outline closes the bonded region (no leak)'),
    check('wing.outline.area', outline.areaMm2 > 0, 'Bonded area inside the outline (mm²)', outline.areaMm2, 0, 1),
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
        ? `Insufficient veneering space on ${framework.shortfall.areaMm2.toFixed(1)} mm²: largest veneer deficit (mm)`
        : 'Veneering space as requested everywhere: largest veneer deficit (mm)',
      deficit,
      CUTBACK_MAX_DEFICIT_MM,
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
 *   + PONTIC_BASE_MAX_EXCESS_MM;
 * - per implant crown (`bridge.channel.35.*`): its screw channel exits occlusally (lingually on anterior teeth) with
 *   at least the minimum wall, and was cut;
 * - per Maryland wing: the wing checks measured with the union (outline and surface undercut, thickness, space).
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
      check('bridge.union.valid', u.closed && u.oriented && u.volumeMm3 > 0 && u.degenerateTriangles === 0, 'The merged bridge is a closed, consistently oriented solid with positive volume'),
      check('bridge.union.printable', u.printable && u.selfIntersections === 0, 'The merged bridge has no self-intersections', u.selfIntersections, 0),
      check('bridge.union.components', u.components === 1, 'The merged bridge is one connected solid', u.components, 1),
      check(
        'bridge.union.genus',
        u.genus === channels,
        channels ? `The merged bridge has one through-hole per screw channel (genus ${channels})` : 'The merged bridge has no through-holes (genus 0)',
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
          check(`${id}.area`, c.measured.minAreaMm2 >= areaLimit, `Connector ${a}–${b}: smallest measured section ≥ the designed area and the material minimum (mm²)`, c.measured.minAreaMm2, round(areaLimit)),
          check(`${id}.height`, height >= c.minHeightMm, `Connector ${a}–${b}: height ≥ the minimum (mm)`, height, c.minHeightMm),
        );
      }
    }
    for (const f of connector.failures) qa.push(check(`${id}.${f.code}`, false, f.message, f.valueMm, round(f.limitMm)));
  }

  for (const s of checks?.seating ?? []) {
    const change = Math.max(s.deltaMeanMm, s.deltaMaxMm);
    const ok = s.onUnion.samples > 0 && s.onUnion.samples === s.own.samples && s.deltaMeanMm <= SEATING_TOLERANCE_MM && s.deltaMaxMm <= SEATING_TOLERANCE_MM;
    const message = implants.some((i) => i.fdi === s.fdi)
      ? `Implant crown ${s.fdi}: seating on its Ti-base unchanged in the merged bridge (largest change of the bonding gap, mm)`
      : `Retainer ${s.fdi}: seating unchanged in the merged bridge (largest change of the cement gap, mm)`;
    qa.push(check(`bridge.seating.${s.fdi}`, ok, message, change, SEATING_TOLERANCE_MM, 4));
  }
  for (const p of checks?.ponticBase ?? []) {
    const limit = p.targetMm - PONTIC_BASE_TOLERANCE_MM;
    const ok = p.samples > 0 && p.minGapMm >= limit && p.minGapMm <= p.targetMm + PONTIC_BASE_MAX_EXCESS_MM && p.meanGapMm >= limit;
    qa.push(check(`bridge.ponticBase.${p.fdi}`, ok, `Pontic ${p.fdi}: smallest gap from the base to the ridge (mm)`, p.minGapMm, round(limit)));
  }
  for (const { fdi, implant } of implants) {
    const cut = { ok: Boolean(implant.cut) && implant.cutOk !== false };
    qa.push(...channelChecks(`bridge.channel.${fdi}`, `Implant crown ${fdi}: the screw channel`, implant.channel, cut));
  }
  for (const w of checks?.wings ?? []) qa.push(...w.checks);
  return qa;
}

export const passed = (qa: readonly QaCheck[]): boolean => qa.every((c) => c.passed);
