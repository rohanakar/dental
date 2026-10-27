import type { V3 } from './pca';

/**
 * Redraw one section of a closed margin (the Margin step's two-click "Redraw a section",
 * specs/2026-10-27-natural-margin.md). `path` is the live-wire path between the two clicks. It replaces whichever of
 * the line's two arcs between the clicks lies closer to it, so the rest of the line is kept as it was. Anchors on the
 * replaced arc are dropped, and the path's ends become anchors.
 */
export function redrawSection(margin: { anchors: V3[]; points: V3[] }, path: V3[]): { anchors: V3[]; points: V3[] } {
  const { points } = margin;
  const n = points.length;
  if (path.length < 2 || n < 4) throw new Error('Click two places on the margin line');
  const a = path[0]!, b = path.at(-1)!;
  const ia = nearestIndex(points, a);
  const ib = nearestIndex(points, b);
  if (ia === ib) throw new Error('Click two different places on the margin line');

  // The two arcs between the clicks, each without its ends: forward from ia to ib, and from ib on round to ia.
  const forward = arc(n, ia, ib);
  const backward = arc(n, ib, ia);
  const replaceForward = meanDistance(forward.map((i) => points[i]!), path) <= meanDistance(backward.map((i) => points[i]!), path);
  const kept = replaceForward ? backward : forward;
  // Forward replaced: the path (a → b), then the kept arc round to a. Backward replaced: the kept arc from a to b,
  // then the path back (b → a).
  const newPoints = replaceForward ? [...path, ...kept.map((i) => points[i]!)] : [...kept.map((i) => points[i]!), ...[...path].reverse()];

  // Anchors: those on the kept arc, in its order (away from the clicks), plus the path's ends.
  const keptOrder = new Map(kept.map((i, k) => [i, k]));
  const near = (p: V3, q: V3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.5;
  const keptAnchors = margin.anchors
    .map((p) => ({ p, at: keptOrder.get(nearestIndex(points, p)) }))
    .filter((x): x is { p: V3; at: number } => x.at !== undefined && !near(x.p, a) && !near(x.p, b))
    .sort((x, y) => x.at - y.at)
    .map((x) => x.p);
  const anchors = replaceForward ? [a, b, ...keptAnchors] : [...keptAnchors, b, a];
  return { anchors, points: newPoints };
}

/** Indices strictly between `from` and `to`, going forward round a closed line of `n` points. */
function arc(n: number, from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = (from + 1) % n; i !== to; i = (i + 1) % n) out.push(i);
  return out;
}

function nearestIndex(points: V3[], p: V3): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < points.length; i++) {
    const q = points[i]!;
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function meanDistance(a: V3[], b: V3[]): number {
  if (a.length === 0) return 0;
  let sum = 0;
  for (const p of a) {
    let best = Infinity;
    for (const q of b) best = Math.min(best, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);
    sum += Math.sqrt(best);
  }
  return sum / a.length;
}
