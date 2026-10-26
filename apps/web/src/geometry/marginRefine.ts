import { proposeMarginAnchors, type AutoMarginProfile } from './autoMargin';
import { marginFromAnchors, type EdgeWeight } from './livewire';
import { MARGIN_LENGTH_MM, MARGIN_MAX_TURN_DEG, MARGIN_MAX_WANDER, sharpestTurnDeg } from './marginShape';
import type { V3 } from './pca';
import type { RayCaster } from './raycast';
import type { SurfaceGraph } from './surface';

/**
 * Margin refiner (specs/2026-10-26-margin-ai.md): repairs an automatic margin on a noisy prep without a model.
 *
 * On a scan with noise a few radial profiles pick a false edge 1–2 mm off the finish line, and the live-wire then
 * has to pass through those anchors: the margin makes an excursion and often doubles back (a kink). Between good
 * anchors the live-wire also follows the noise, which reads as a kink over the gate's 0.6 mm stride. So the refiner:
 * 1. rejects anchors that leave the smooth ring their neighbours make (radius and drop along the profiles);
 * 2. traces through the rest with the live-wire;
 * 3. smooths the traced line over a few tenths of a millimetre and puts it back on the scan.
 * It tries a few profile counts and keeps the best candidate: one that passes the gate's shape checks without
 * wandering from its anchors, then the least wander, then the gentlest sharpest turn. It never makes a natural tooth pass:
 * with no finish line there is no consistent ring to keep.
 */

export interface RefineInput {
  positions: Float32Array;
  /** BVH-ordered triangle index (as for proposeMarginAnchors). */
  indices: Uint32Array;
  ray: RayCaster;
  graph: SurfaceGraph;
  weight: EdgeWeight;
  frame: { origin: V3; occlusal: V3; mesial: V3 };
}

export interface RefineCandidate {
  name: string;
  anchors: V3[];
  /** Mesh vertex each anchor snapped to (as marginFromAnchors gives them, for editing the anchors). */
  anchorVertices: number[];
  points: Float32Array;
  lengthMm: number;
  /** Profiles that found an edge over profiles run (0..1): the margin edge's share of the way round. */
  confidence: number;
  /** Anchors kept on the ring over profiles run (0..1). */
  kept: number;
  turnDeg: number;
  /**
   * Traced length over the perimeter of the anchor ring: a detour away from the anchors (an excursion onto a false
   * edge, a doubling back) adds length, a margin that follows its anchors stays near 1.
   */
  wander: number;
  passes: boolean;
}

export interface RefineResult extends RefineCandidate {
  /** Every candidate traced, best first. */
  candidates: Array<Omit<RefineCandidate, 'points' | 'anchors' | 'anchorVertices'>>;
}

/** An anchor this far (mm) from its neighbours' median radius, or drop, leaves the ring. */
const RING_RADIUS_MM = 0.6;
const RING_DROP_MM = 0.5;
/** Neighbours on each side for the ring median. */
const RING_HALF = 2;
/** Moving-average window (mm of arc) for the traced line. */
const SMOOTH_MM = 0.4;
/** At least this share of the profiles must stay on the ring. */
const MIN_KEPT = 0.5;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** Keep the anchors whose radius and drop agree with their neighbours along the ring. */
export function ringConsistentAnchors(anchors: V3[], profiles: AutoMarginProfile[]): V3[] {
  const found = profiles.filter((p) => p.found);
  if (found.length !== anchors.length || found.length < 5) return anchors;
  const n = found.length;
  return anchors.filter((_, i) => {
    const near = [];
    for (let k = -RING_HALF; k <= RING_HALF; k++) if (k !== 0) near.push(found[(i + k + n) % n]!);
    const p = found[i]!;
    return Math.abs(p.radiusMm! - median(near.map((q) => q.radiusMm!))) <= RING_RADIUS_MM && Math.abs(p.dropMm! - median(near.map((q) => q.dropMm!))) <= RING_DROP_MM;
  });
}

const at = (a: Float32Array, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];

/** Moving average over about `windowMm` of arc on a closed line, then each point back onto the scan. */
export function smoothOnSurface(points: Float32Array, ray: RayCaster, windowMm = SMOOTH_MM): Float32Array {
  const n = points.length / 3;
  if (n < 5) return points;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const a = at(points, i), b = at(points, (i + 1) % n);
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const half = Math.max(1, Math.round(windowMm / 2 / (length / n)));
  const out = new Float32Array(points.length);
  for (let i = 0; i < n; i++) {
    const m: V3 = [0, 0, 0];
    for (let k = -half; k <= half; k++) {
      const p = at(points, (i + k + n) % n);
      m[0] += p[0];
      m[1] += p[1];
      m[2] += p[2];
    }
    const c: V3 = [m[0] / (2 * half + 1), m[1] / (2 * half + 1), m[2] / (2 * half + 1)];
    const hit = ray.closestPoint(c, 1);
    out.set(hit ? [hit.point[0], hit.point[1], hit.point[2]] : c, i * 3);
  }
  return out;
}

function polylineLength(points: Float32Array): number {
  const n = points.length / 3;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const a = at(points, i), b = at(points, (i + 1) % n);
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return length;
}

/** Perimeter of the closed polyline through `ring`. */
function ringPerimeter(ring: V3[]): number {
  let length = 0;
  for (let j = 0; j < ring.length; j++) {
    const a = ring[j]!, b = ring[(j + 1) % ring.length]!;
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return length;
}

function candidate(name: string, input: RefineInput, anchors: V3[], found: number, profilesRun: number, smooth: boolean): RefineCandidate | null {
  if (anchors.length < 3) return null;
  const trace = marginFromAnchors({ positions: input.positions, indices: input.indices, graph: input.graph, weight: input.weight, ray: input.ray, anchors });
  const points = smooth ? smoothOnSurface(trace.points, input.ray) : trace.points;
  const lengthMm = smooth ? polylineLength(points) : trace.lengthMm;
  const list: V3[] = [];
  for (let i = 0; i < points.length / 3; i++) list.push(at(points, i));
  const turnDeg = sharpestTurnDeg(list);
  const confidence = found / profilesRun;
  const kept = anchors.length / profilesRun;
  const wander = lengthMm / Math.max(ringPerimeter(anchors), 1e-6);
  const passes =
    lengthMm >= MARGIN_LENGTH_MM[0] && lengthMm <= MARGIN_LENGTH_MM[1] && turnDeg <= MARGIN_MAX_TURN_DEG && confidence >= 0.75 && kept >= MIN_KEPT && wander <= MARGIN_MAX_WANDER;
  return { name, anchors, anchorVertices: trace.anchorVertices, points, lengthMm, confidence, kept, turnDeg, wander, passes };
}

/** Best first: passing, then the least wander, then the gentlest sharpest turn. */
const better = (a: RefineCandidate, b: RefineCandidate): number => Number(b.passes) - Number(a.passes) || a.wander - b.wander || a.turnDeg - b.turnDeg;

export function refineMargin(input: RefineInput): RefineResult | null {
  const candidates: RefineCandidate[] = [];
  for (const count of [16, 24, 32, 48]) {
    const proposal = proposeMarginAnchors({ positions: input.positions, indices: input.indices, ray: input.ray, frame: input.frame, count });
    const found = proposal.anchors.length;
    const ring = ringConsistentAnchors(proposal.anchors, proposal.profiles);
    for (const smooth of [false, true]) {
      if (count === 16) {
        const plain = candidate(`${count} profiles${smooth ? ', smoothed' : ''}`, input, proposal.anchors, found, count, smooth);
        if (plain) candidates.push(plain);
      }
      const kept = candidate(`${count} profiles, ring-consistent anchors${smooth ? ', smoothed' : ''}`, input, ring, found, count, smooth);
      if (kept) candidates.push(kept);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort(better);
  const best = candidates[0]!;
  return { ...best, candidates: candidates.map(({ points: _p, anchors: _a, anchorVertices: _v, ...c }) => c) };
}
