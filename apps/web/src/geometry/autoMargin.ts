import { buildTriangleGrid, type TriangleGrid } from './crossSection';
import { QUIET_TURN_DEG, quietTurns, resample, sectionProfile, type SectionStop } from './sectionProfile';
import type { V3 } from './pca';
import type { RayCaster } from './raycast';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface AutoMarginInput {
  positions: Float32Array;
  /** Triangle index (any order; `grid` must have been built from the same one). */
  indices: Uint32Array;
  /** Casts the height profiles (`sampler: 'height'`). */
  ray: RayCaster;
  /**
   * 'section' (default): the scan's cross-sections, walked outward from the prep top. 'height': height profiles cast
   * from above, the sampler before the sections, which copes better with a very rough scan.
   */
  sampler?: 'section' | 'height';
  /** Triangles bucketed for the section (built from positions and indices when omitted: pass one when calling often). */
  grid?: TriangleGrid;
  /** Tooth frame; `origin` is the prep top (on the scan). */
  frame: { origin: V3; occlusal: V3; mesial: V3 };
  /** Radial profiles (= anchors when every profile finds the ridge). */
  count?: number;
  /** How far from the prep top a profile may search. */
  maxRadiusMm?: number;
  /** Resampling step along the profile. */
  stepMm?: number;
  /** The margin is at least this far below the prep top (past the line angle). */
  minDropMm?: number;
  /** Stop a profile when the surface rises this much above its lowest point (a neighbour tooth). */
  riseStopMm?: number;
  /** Half-width of the chords (section, default 0.15 mm) or slope windows (height, 0.2 mm) across an edge. */
  windowMm?: number;
  /** Minimum convexity for an edge: turn ÷ 30° on a section (default 0.4), slope change on a height profile (0.5). */
  minConvexity?: number;
  /** Also return every convex corner of each profile (AutoMarginProfile.candidates). */
  withCandidates?: boolean;
}

/** One convex edge on a profile: a possible margin point (the first is what the profile picked). */
export interface ProfileCandidate {
  point: V3;
  radiusMm: number;
  dropMm: number;
  convexity: number;
}

export interface AutoMarginProfile {
  angleDeg: number;
  found: boolean;
  /**
   * Every convex corner below the minimum drop, outward order (with `withCandidates`): on a noisy scan the first one
   * can be a false edge, and the margin refiner picks one per profile so the ring round the prep stays smooth.
   */
  candidates?: ProfileCandidate[];
  radiusMm?: number;
  dropMm?: number;
  /** Turn of the profile across the anchor ÷ 30° (larger = sharper convex corner). */
  convexity?: number;
  /** Why a profile stopped: 'neighbour', 'edge' (ran off the scan) or 'radius'. */
  stop: SectionStop;
}

export interface AutoMarginResult {
  /** Margin anchors in angular order around the occlusal axis (CCW seen from occlusal). */
  anchors: V3[];
  profiles: AutoMarginProfile[];
  /** Fraction of profiles that found a ridge (0..1). */
  confidence: number;
  /**
   * Section profiles: the median, over the profiles, of the median turn along each before smoothing (degrees). Real
   * scans measure 1–6°; above QUIET_TURN_DEG (sectionProfile.ts) the scan is rough.
   */
  roughnessDeg?: number;
}

export { QUIET_TURN_DEG };

/** Convexity unit: a turn of this many degrees scores 1. */
const TURN_UNIT_DEG = 30;
/** What one profile found: its convex edges in outward order, the one it picked, and why it stopped. */
interface ProfileEdges {
  candidates: ProfileCandidate[];
  pick?: ProfileCandidate;
  stop: AutoMarginProfile['stop'];
  /** Section profiles: the median turn before any smoothing (degrees). */
  roughDeg?: number;
}

interface ProfileSettings {
  origin: V3;
  o: V3;
  dir: V3;
  maxR: number;
  step: number;
  minDrop: number;
  riseStop: number;
  minConvexity: number;
  window: number;
}

/**
 * The section profile's edges: the corners (local maxima of the turn over ±window samples, at least minConvexity)
 * below the minimum drop, and the first of them going outward. The line angle lies above the minimum drop, and
 * further out the gum or the scan's border can turn as sharply.
 */
function sectionEdges(positions: Float32Array, indices: Uint32Array, grid: TriangleGrid, c: ProfileSettings): ProfileEdges {
  const { origin, o, dir, window } = c;
  const section = sectionProfile(positions, indices, grid, origin, o, dir, c.maxR, c.minDrop, c.riseStop);
  const { s, h } = resample(section, c.step);
  // Convexity: the clockwise turn (outward to the right, occlusal up) at each sample, in units of TURN_UNIT_DEG, on
  // the profile smoothed as much as its noise needs (quietTurns). Anchors stay on the unsmoothed section.
  const { turns, roughDeg } = quietTurns(s, h, window, c.step);
  const scores = turns.map((t, i) => (Number.isFinite(t) && -h[i]! >= c.minDrop ? t / TURN_UNIT_DEG : -Infinity));
  const candidates: ProfileCandidate[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (!(scores[i]! >= c.minConvexity)) continue;
    let peak = true;
    for (let j = Math.max(0, i - window); j <= Math.min(scores.length - 1, i + window) && peak; j++) {
      if (j !== i && (scores[j]! > scores[i]! || (scores[j] === scores[i] && j < i))) peak = false;
    }
    if (!peak) continue;
    const point: V3 = [origin[0] + s[i]! * dir[0] + h[i]! * o[0], origin[1] + s[i]! * dir[1] + h[i]! * o[1], origin[2] + s[i]! * dir[2] + h[i]! * o[2]];
    candidates.push({ point, radiusMm: s[i]!, dropMm: -h[i]!, convexity: scores[i]! });
  }
  return { candidates, ...(candidates[0] ? { pick: candidates[0] } : {}), stop: section.stop, roughDeg };
}

/**
 * The height profile's edges (the sampler before the sections, kept for rough scans): heights from rays cast down
 * along −occlusal at `step` intervals outward; convexity = slope before − slope after over ±window samples. The
 * pick is the first local peak reaching half the profile's maximum; candidates are the peaks reaching a third.
 */
function heightEdges(ray: RayCaster, c: ProfileSettings): ProfileEdges {
  const { origin, o, dir, step, window } = c;
  const lift = 20;
  const topH = dot(origin, o);
  const down: V3 = [-o[0], -o[1], -o[2]];
  const rs: number[] = [], hs: number[] = [];
  const points: V3[] = [];
  let minH = Infinity, misses = 0;
  let stop: AutoMarginProfile['stop'] = 'radius';
  for (let r = step; r <= c.maxR; r += step) {
    const hit = ray.first([origin[0] + r * dir[0] + lift * o[0], origin[1] + r * dir[1] + lift * o[1], origin[2] + r * dir[2] + lift * o[2]], down, 2 * lift);
    if (!hit) {
      if (++misses > 10) {
        stop = 'edge';
        break;
      }
      continue;
    }
    misses = 0;
    const h = dot(hit.point, o) - topH;
    if (minH < -c.minDrop && h > minH + c.riseStop) {
      stop = 'neighbour';
      break;
    }
    minH = Math.min(minH, h);
    rs.push(r);
    hs.push(h);
    points.push(hit.point);
  }
  const scores = new Array<number>(hs.length).fill(-Infinity);
  let maxScore = -Infinity;
  for (let i = window; i + window < hs.length; i++) {
    if (-hs[i]! < c.minDrop) continue;
    scores[i] = (hs[i]! - hs[i - window]!) / (rs[i]! - rs[i - window]!) - (hs[i + window]! - hs[i]!) / (rs[i + window]! - rs[i]!);
    maxScore = Math.max(maxScore, scores[i]!);
  }
  const edge = (i: number): ProfileCandidate => ({ point: points[i]!, radiusMm: rs[i]!, dropMm: -hs[i]!, convexity: scores[i]! });
  let pick: ProfileCandidate | undefined;
  const threshold = Math.max(c.minConvexity, 0.5 * maxScore);
  for (let i = 0; i < scores.length; i++) {
    if (scores[i]! < threshold) continue;
    let j = i;
    while (j + 1 < scores.length && scores[j + 1]! >= scores[j]!) j++;
    if (scores[j]! > c.minConvexity) pick = edge(j);
    break;
  }
  const candidates: ProfileCandidate[] = [];
  const floor = Math.max(c.minConvexity, maxScore / 3);
  for (let i = 1; i + 1 < scores.length; i++) {
    if (scores[i]! >= floor && scores[i]! >= scores[i - 1]! && scores[i]! > scores[i + 1]!) candidates.push(edge(i));
  }
  return { candidates, ...(pick ? { pick } : {}), stop };
}

/**
 * Automatic margin anchors (classical.margin-ridge; specs/2026-10-29-margin-on-real-preps.md): radial profiles
 * round the prep top. By default each is the scan's own cross-section in a half-plane through the occlusal axis,
 * walked outward. Down a prep's profile come the occlusal surface, the convex line angle, the axial wall
 * (near-vertical on a real prep, often slightly undercut), then the finish line: the convex corner at the outer lip of
 * the chamfer or shoulder, or at the top of a die's ditch. The anchor is the first convex corner (the largest turn of
 * the profile's direction within a few tenths of a millimetre) at least minDropMm below the prep top and before the
 * surface rises onto a neighbour. Measuring the turn of the contour, not a slope, keeps vertical walls and undercuts
 * readable. `sampler: 'height'` uses height profiles cast from above instead (heightEdges). The caller closes the loop
 * with the live-wire (marginFromAnchors).
 */
export function proposeMarginAnchors(input: AutoMarginInput): AutoMarginResult {
  const { positions, indices } = input;
  const height = input.sampler === 'height';
  const grid = height ? null : (input.grid ?? buildTriangleGrid(positions, indices));
  const count = input.count ?? 16;
  const step = input.stepMm ?? 0.05;
  const o = normalize(input.frame.occlusal);
  const m = input.frame.mesial;
  const u = normalize([m[0] - dot(m, o) * o[0], m[1] - dot(m, o) * o[1], m[2] - dot(m, o) * o[2]]);
  const v = cross(o, u);
  const settings = {
    origin: input.frame.origin,
    o,
    maxR: input.maxRadiusMm ?? 8,
    step,
    minDrop: input.minDropMm ?? 1.5,
    riseStop: input.riseStopMm ?? 0.5,
    minConvexity: input.minConvexity ?? (height ? 0.5 : 0.4),
    window: Math.max(2, Math.round((input.windowMm ?? (height ? 0.2 : 0.15)) / step)),
  };

  const anchors: V3[] = [];
  const profiles: AutoMarginProfile[] = [];
  const rough: number[] = [];
  for (let k = 0; k < count; k++) {
    const theta = (2 * Math.PI * k) / count;
    const dir: V3 = [
      Math.cos(theta) * u[0] + Math.sin(theta) * v[0],
      Math.cos(theta) * u[1] + Math.sin(theta) * v[1],
      Math.cos(theta) * u[2] + Math.sin(theta) * v[2],
    ];
    const edges = grid ? sectionEdges(positions, indices, grid, { ...settings, dir }) : heightEdges(input.ray, { ...settings, dir });
    if (edges.roughDeg !== undefined) rough.push(edges.roughDeg);
    const { pick } = edges;
    if (pick) anchors.push(pick.point);
    profiles.push({
      angleDeg: (theta * 180) / Math.PI,
      found: Boolean(pick),
      stop: edges.stop,
      ...(pick ? { radiusMm: pick.radiusMm, dropMm: pick.dropMm, convexity: pick.convexity } : {}),
      ...(input.withCandidates ? { candidates: edges.candidates } : {}),
    });
  }
  rough.sort((a, b) => a - b);
  return { anchors, profiles, confidence: anchors.length / count, ...(rough.length ? { roughnessDeg: rough[Math.floor(rough.length / 2)]! } : {}) };
}
