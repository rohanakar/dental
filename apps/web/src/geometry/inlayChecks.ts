import type { QaCheck } from '@dcad/shared';
import type { InlayUnitReport } from './inlayUnit';

/**
 * The inlay gate as its own module (types only from inlayUnit.ts): the bridge union checks run it in the worker, and
 * the auto-design gate on the main thread, without loading the inlay geometry there.
 */

const round = (x: number, d = 3) => Number(x.toFixed(d));
const check = (id: string, passed: boolean, message: string, value?: number, threshold?: number): QaCheck => ({
  id,
  passed,
  message,
  ...(value !== undefined && Number.isFinite(value) ? { value: round(value) } : {}),
  ...(threshold !== undefined ? { threshold } : {}),
});

/**
 * The inlay gate (classical.inlay checks): the restoration meets the drawn margin within the tolerance, it is at
 * least the minimum thickness over the cavity floor, the cavity seats along the axis, and the library tooth fits the
 * natural surface around the cavity.
 */
export function inlayChecks(fdi: number, inlay: Pick<InlayUnitReport, 'marginFit' | 'isthmus' | 'blockout' | 'library' | 'type'>): QaCheck[] {
  const id = `inlay.${fdi}`;
  const name = `${inlay.type === 'onlay' ? 'Onlay' : 'Inlay'} ${fdi}`;
  const out = [
    check(`${id}.marginFit`, inlay.marginFit.ok, `${name}: edge within ${inlay.marginFit.limitMm} mm of the cavity margin (mm)`, inlay.marginFit.maxMm, inlay.marginFit.limitMm),
    check(`${id}.isthmus`, inlay.isthmus.ok, `${name}: thickness over the cavity floor (mm)`, inlay.isthmus.minMm, inlay.isthmus.thresholdMm),
    check(`${id}.marginUndercut`, inlay.blockout.outlineUndercutPoints === 0, `${name}: no margin points in an undercut along the axis`, inlay.blockout.outlineUndercutPoints, 0),
  ];
  if (inlay.library) {
    out.push(check(`${id}.libraryFit`, inlay.library.ok, `${name}: library tooth fits the natural surface around the cavity (95th percentile, mm)`, inlay.library.residual.p95Mm, inlay.library.limitMm));
  }
  return out;
}
