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

/**
 * Replace the stretch of a closed line between the points nearest `from` and `to` that passes the point nearest `via`
 * with `path` (from → to), keeping the rest. Dragging or deleting a margin point re-traces only between its two
 * neighbours (specs/2026-10-27-margin-review-ux.md): `via` is the old point, so the right stretch goes.
 */
export function replaceArc(points: V3[], from: V3, to: V3, via: V3, path: V3[]): V3[] {
  const n = points.length;
  const ia = nearestIndex(points, from), ib = nearestIndex(points, to), iv = nearestIndex(points, via);
  if (ia === ib) throw new Error('The two neighbouring points are at the same place on the line');
  const forward = arc(n, ia, ib);
  const backward = arc(n, ib, ia);
  // The stretch through `via` goes; when `via` is one of the ends, the shorter one.
  const replaceForward = forward.includes(iv) || (!backward.includes(iv) && forward.length <= backward.length);
  // Forward replaced: the path (a → b), then the kept stretch round to a. Otherwise the kept stretch from a to b, then
  // the path back (b → a).
  return replaceForward ? [...path, ...backward.map((i) => points[i]!)] : [...forward.map((i) => points[i]!), ...[...path].reverse()];
}

/**
 * One offset for the whole margin (specs/2026-10-27-margin-review-ux.md): every point moves `mm` up the tooth along
 * the scan (− down toward the gum), then back onto it. "Up the scan" is the surface's own uphill direction where it
 * slopes; on a flat ledge (a prep's shoulder) it is toward the tooth axis. A plain move along the axis would barely
 * move a line on a ledge.
 */
export function offsetOnSurface(
  points: V3[],
  scan: { project(p: V3): V3; normalAt(p: V3): V3 },
  frame: { origin: V3; up: V3 },
  mm: number,
): V3[] {
  const { up, origin } = frame;
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return points.map((p) => {
    const n = scan.normalAt(p);
    const uphill: V3 = [up[0] - dot(up, n) * n[0], up[1] - dot(up, n) * n[1], up[2] - dot(up, n) * n[2]];
    let len = Math.hypot(...uphill);
    let dir = uphill;
    if (len < 0.3) {
      // Flat: toward the axis (raising a line on a shoulder moves it in, toward the walls).
      const r: V3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
      const along = dot(r, up);
      dir = [-(r[0] - along * up[0]), -(r[1] - along * up[1]), -(r[2] - along * up[2])];
      len = Math.hypot(...dir);
    }
    if (len < 1e-9) return p;
    return scan.project([p[0] + (dir[0] / len) * mm, p[1] + (dir[1] / len) * mm, p[2] + (dir[2] / len) * mm]);
  });
}

/** Add an anchor at `p` (a point on the line) between the anchors it falls between along the line. The line is unchanged. */
export function insertAnchor(margin: { anchors: V3[]; points: V3[] }, p: V3): V3[] {
  const { anchors, points } = margin;
  const at = (q: V3) => nearestIndex(points, q);
  const ip = at(p);
  const order = anchors.map((a, k) => ({ k, i: at(a) }));
  // The first anchor after p along the line (cyclically): insert before it.
  const ahead = (i: number) => (i - ip + points.length) % points.length;
  const next = order.reduce((best, x) => (ahead(x.i) > 0 && (best === null || ahead(x.i) < ahead(best.i)) ? x : best), null as { k: number; i: number } | null);
  const k = next ? next.k : 0;
  return [...anchors.slice(0, k), p, ...anchors.slice(k)];
}
