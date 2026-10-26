import type { ToothDesign } from '@dcad/shared';
import type { ImplantResultView } from '../../workers/analysisTypes';
import type { ReadinessInput, ReadinessItem } from './readiness';

/** Largest bonding-gap error on a Ti-base that still reads as seated (the runner's MAX_TI_BASE_GAP_ERROR_MM). */
const MAX_GAP_ERROR_MM = 0.025;

/** An implant crown has no margin to close: its implant position and channel rows replace the margin and axis rows. */
export const IMPLANT_NEEDS: NonNullable<ReadinessInput['needs']> = { margin: false, axis: false };

/**
 * Readiness rows of an implant crown (specs/2026-10-25-implant-bridges.md checks): the scan-body match, the seating
 * on the Ti-base, the screw channel's exit and walls, and the restoration with its channel being one solid.
 */
export function implantReadiness(tooth: ToothDesign, view: ImplantResultView | null | undefined, computing = false): ReadinessItem[] {
  const id = (s: string) => `implant-${s}`;
  const implant = tooth.implant;
  if (!implant) return [{ id: id('position'), label: 'Scan body matched', status: 'fail', detail: 'No implant position: match the scan body' }];
  const fit = implant.fit;
  const fitOk = fit.rmsMm <= 0.05 && fit.inlierFraction >= 0.9;
  const items: ReadinessItem[] = [
    {
      id: id('position'),
      label: 'Scan body matched',
      status: fitOk ? 'pass' : 'fail',
      detail: `RMS ${fit.rmsMm.toFixed(3)} mm (max 0.05), ${Math.round(fit.inlierFraction * 100)}% inliers (min 90%)`,
    },
  ];
  if (!view || computing) {
    items.push({ id: id('channel'), label: 'Screw channel and Ti-base', status: 'unknown', detail: computing ? 'Measuring…' : 'Not designed yet' });
    return items;
  }
  const seated = view.rimUndercutCount === 0 && view.tiBaseGap.intaglioMinGapMm > 0 && view.tiBaseGap.maxErrorMm <= MAX_GAP_ERROR_MM;
  items.push({
    id: id('seat'),
    label: 'Seats on the Ti-base',
    status: seated ? 'pass' : 'fail',
    detail:
      view.rimUndercutCount > 0
        ? `${view.rimUndercutCount} shoulder points are hidden under the Ti-base from the insertion path`
        : `bonding gap ${view.tiBaseGap.gapMm} mm ± ${view.tiBaseGap.maxErrorMm.toFixed(3)} mm`,
  });
  const c = view.channel;
  items.push({
    id: id('exit'),
    label: 'Screw channel exits occlusally or lingually',
    status: c.exitOk ? 'pass' : 'fail',
    detail: c.exitOk ? (c.angleDeg ? `angled ${c.angleDeg.toFixed(1)}°` : 'straight') : c.failures.join(' ') || 'No exit found',
  });
  items.push({
    id: id('wall'),
    label: 'Material around the screw channel',
    status: c.wallOk ? 'pass' : 'fail',
    detail: Number.isFinite(c.minWallMm) ? `${c.minWallMm.toFixed(2)} mm (min ${c.requiredWallMm} mm)` : 'Not measured',
  });
  items.push({
    id: id('cut'),
    label: 'Restoration with the channel is one solid',
    status: view.cutOk ? 'pass' : view.cut ? 'fail' : 'unknown',
    detail: view.cutOk ? 'closed, one through-hole' : view.cut ? 'The channel left more than one part or a defect' : 'Not cut yet',
  });
  return items;
}
