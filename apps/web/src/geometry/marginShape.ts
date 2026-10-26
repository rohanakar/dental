/** A point as any 3-tuple (the gate's readonly V3 and pca's V3 alike). */
type P3 = ReadonlyArray<number>;

/** A margin outside this length (mm) is not a single prep's margin (the margin gate, ai/qa.ts). */
export const MARGIN_LENGTH_MM: readonly [number, number] = [8, 60];
/** A turn sharper than this (degrees, over a ~0.6 mm stride) means the margin doubles back: the crown would fold. */
export const MARGIN_MAX_TURN_DEG = 120;
/**
 * Traced length over the perimeter of its anchor ring above which the margin made a detour (an excursion onto a false
 * edge on a noisy scan, or the gum line of a natural tooth), even when its bends pass (marginRefine.ts).
 */
export const MARGIN_MAX_WANDER = 1.15;

/**
 * Sharpest turn (degrees) between chords spanning about `strideMm` before
 * and after each point of a closed curve. Measuring over a stride (not
 * between adjacent 0.2 mm segments) ignores sub-stride jitter from snapping
 * to scan vertices, while a live-wire that doubles back (a millimetre-scale
 * reversal) still shows up as a turn near 180°.
 */
export function sharpestTurnDeg(points: ReadonlyArray<P3>, strideMm = 0.6): number {
  return turnsDeg(points, strideMm).reduce((worst, t) => Math.max(worst, t), 0);
}

/** The turn (degrees) at every point of a closed curve, over chords of about `strideMm` (see sharpestTurnDeg). */
export function turnsDeg(points: ReadonlyArray<P3>, strideMm = 0.6): number[] {
  const n = points.length;
  if (n < 3) return new Array<number>(n).fill(0);
  let length = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    length += Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
  }
  const k = Math.max(1, Math.min(Math.floor(n / 4), Math.round(strideMm / (length / n))));
  const turns = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = points[(i - k + n) % n]!, b = points[i]!, c = points[(i + k) % n]!;
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const v = [c[0]! - b[0]!, c[1]! - b[1]!, c[2]! - b[2]!];
    const lu = Math.hypot(u[0]!, u[1]!, u[2]!), lv = Math.hypot(v[0]!, v[1]!, v[2]!);
    if (lu < 1e-9 || lv < 1e-9) continue;
    const cos = (u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!) / (lu * lv);
    turns[i] = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  }
  return turns;
}

/** Whether a margin's shape passes the gate's shape checks: a plausible length and no kink. */
export function marginShapePasses(points: ReadonlyArray<P3>, lengthMm: number): boolean {
  return lengthMm >= MARGIN_LENGTH_MM[0] && lengthMm <= MARGIN_LENGTH_MM[1] && sharpestTurnDeg(points) <= MARGIN_MAX_TURN_DEG;
}
