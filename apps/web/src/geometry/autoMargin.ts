import { buildTriangleGrid, type TriangleGrid } from './crossSection';
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
  stop: 'neighbour' | 'edge' | 'radius';
}

export interface AutoMarginResult {
  /** Margin anchors in angular order around the occlusal axis (CCW seen from occlusal). */
  anchors: V3[];
  profiles: AutoMarginProfile[];
  /** Fraction of profiles that found a ridge (0..1). */
  confidence: number;
  /**
   * Section profiles: the median, over the profiles, of the median turn along each before smoothing (degrees). Real
   * scans measure 1–6°; above QUIET_TURN_DEG the scan is rough.
   */
  roughnessDeg?: number;
}

/** Convexity unit: a turn of this many degrees scores 1. */
const TURN_UNIT_DEG = 30;
/** The section reaches this far above the prep top and below it (mm). */
const SECTION_ABOVE_MM = 3;
const SECTION_BELOW_MM = 10;
/** The walk starts at most this far from the prep top (the frame origin must be on the scan). */
const START_MM = 1;
/** Longest profile walked (mm of arc). */
const MAX_ARC_MM = 25;
/** Triangles are assumed smaller than this (mm): a crossing one's centroid lies within it of the section plane. */
const TRIANGLE_REACH_MM = 0.5;
/** Closer than this to the section plane, a vertex lies on it (mm). */
const ON_PLANE_MM = 1e-7;
/**
 * A profile is smoothed (Gaussian, these sigmas in mm, the least that does it) until the median turn along it is at
 * most this: real scans measure 1–6°, so they are left as they are, while a rough scan's noise would fill the wall
 * with false corners.
 */
export const QUIET_TURN_DEG = 6;
const SMOOTH_SIGMAS_MM = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4];

/** A profile: the scan's section in one half-plane, walked outward from the prep top. */
interface SectionProfile {
  /** Outward distance from the occlusal axis and height above the prep top, per point. */
  s: number[];
  h: number[];
  stop: AutoMarginProfile['stop'];
}

/**
 * The mesh's cut by the plane through the prep top spanned by `o` and `dir`, walked from the crossing nearest the top
 * toward +dir. Crossings are keyed by their mesh edge, so neighbouring triangles share them exactly; only triangles in
 * grid cells near the half-plane are visited.
 */
function sectionProfile(
  positions: Float32Array,
  indices: Uint32Array,
  grid: TriangleGrid,
  origin: V3,
  o: V3,
  dir: V3,
  maxR: number,
  minDrop: number,
  riseStop: number,
): SectionProfile {
  const n = cross(o, dir);
  const sMin = -1, sMax = maxR + 1;
  // Grid cells whose centre lies within reach of the half-plane's rectangle: the cell's half-diagonal plus the
  // farthest a crossing triangle's centroid (its bucket) can lie from the plane.
  const corners: V3[] = [];
  for (const sv of [sMin, sMax]) for (const hv of [SECTION_ABOVE_MM, -SECTION_BELOW_MM]) corners.push([origin[0] + sv * dir[0] + hv * o[0], origin[1] + sv * dir[1] + hv * o[1], origin[2] + sv * dir[2] + hv * o[2]]);
  const lo = [0, 1, 2].map((k) => Math.max(0, Math.floor((Math.min(...corners.map((c) => c[k]!)) - grid.cellMm - grid.min[k]!) / grid.cellMm)));
  const hi = [0, 1, 2].map((k) => Math.min(grid.dims[k]! - 1, Math.floor((Math.max(...corners.map((c) => c[k]!)) + grid.cellMm - grid.min[k]!) / grid.cellMm)));
  const reach = (grid.cellMm * Math.sqrt(3)) / 2 + TRIANGLE_REACH_MM;
  const nv = positions.length / 3;
  const nodes = new Map<number, { s: number; h: number; next: number[] }>();
  const node = (a: number, b: number, t: number) => {
    // A crossing at a vertex (the plane through it) is keyed by the vertex, so every edge from it shares the node.
    const key = t <= 0 ? nv * nv + a : t >= 1 ? nv * nv + b : Math.min(a, b) * nv + Math.max(a, b);
    let x = nodes.get(key);
    if (!x) {
      const q: V3 = [0, 1, 2].map((k) => positions[a * 3 + k]! + t * (positions[b * 3 + k]! - positions[a * 3 + k]!) - origin[k]!) as V3;
      x = { s: dot(q, dir), h: dot(q, o), next: [] };
      nodes.set(key, x);
    }
    return key;
  };
  for (let z = lo[2]!; z <= hi[2]!; z++) {
    for (let y = lo[1]!; y <= hi[1]!; y++) {
      for (let x = lo[0]!; x <= hi[0]!; x++) {
        const c: V3 = [grid.min[0] + (x + 0.5) * grid.cellMm - origin[0], grid.min[1] + (y + 0.5) * grid.cellMm - origin[1], grid.min[2] + (z + 0.5) * grid.cellMm - origin[2]];
        if (Math.abs(dot(c, n)) > reach) continue;
        const cs = dot(c, dir), ch = dot(c, o);
        if (cs < sMin - reach || cs > sMax + reach || ch > SECTION_ABOVE_MM + reach || ch < -SECTION_BELOW_MM - reach) continue;
        const cell = x + grid.dims[0] * (y + grid.dims[1] * z);
        for (let k = grid.offsets[cell]!; k < grid.offsets[cell + 1]!; k++) {
          const tri = grid.tris[k]!;
          const v = [indices[tri * 3]!, indices[tri * 3 + 1]!, indices[tri * 3 + 2]!];
          // A vertex within ON_PLANE_MM of the plane is on it (its crossings then share the vertex's node).
          const d = v.map((i) => {
            const x = (positions[i * 3]! - origin[0]) * n[0] + (positions[i * 3 + 1]! - origin[1]) * n[1] + (positions[i * 3 + 2]! - origin[2]) * n[2];
            return Math.abs(x) < ON_PLANE_MM ? 0 : x;
          });
          const cut: number[] = [];
          for (let e = 0; e < 3; e++) {
            const i = e, j = (e + 1) % 3;
            if (d[i]! > 0 === d[j]! > 0) continue;
            cut.push(node(v[i]!, v[j]!, d[i]! / (d[i]! - d[j]!)));
          }
          if (cut.length !== 2 || cut[0] === cut[1]) continue;
          nodes.get(cut[0]!)!.next.push(cut[1]!);
          nodes.get(cut[1]!)!.next.push(cut[0]!);
        }
      }
    }
  }
  // Start at the crossing nearest the prep top, heading outward.
  let start = -1, best = START_MM;
  for (const [key, x] of nodes) {
    const r = Math.hypot(x.s, x.h);
    if (r < best) [best, start] = [r, key];
  }
  const out: SectionProfile = { s: [], h: [], stop: 'edge' };
  if (start < 0) return out;
  const first = nodes.get(start)!;
  let prev = start;
  let cur = first.next.reduce((a, b) => (a < 0 || nodes.get(b)!.s > nodes.get(a)!.s ? b : a), -1);
  out.s.push(first.s);
  out.h.push(first.h);
  if (cur < 0 || nodes.get(cur)!.s <= first.s) return out;
  const seen = new Set([start]);
  let minH = first.h, arc = 0;
  while (cur >= 0 && !seen.has(cur)) {
    seen.add(cur);
    const p = nodes.get(cur)!;
    const q = nodes.get(prev)!;
    arc += Math.hypot(p.s - q.s, p.h - q.h);
    if (p.s > maxR || p.h < -SECTION_BELOW_MM || arc > MAX_ARC_MM) {
      out.stop = 'radius';
      break;
    }
    if (p.s < sMin) break;
    if (minH < -minDrop && p.h > minH + riseStop) {
      out.stop = 'neighbour';
      break;
    }
    minH = Math.min(minH, p.h);
    out.s.push(p.s);
    out.h.push(p.h);
    const next = p.next.find((k) => k !== prev && !seen.has(k)) ?? -1;
    prev = cur;
    cur = next;
  }
  return out;
}

/** The profile resampled every `step` mm of arc. */
function resample(profile: SectionProfile, step: number): { s: number[]; h: number[] } {
  const s: number[] = [], h: number[] = [];
  const { s: ps, h: ph } = profile;
  if (ps.length === 0) return { s, h };
  s.push(ps[0]!);
  h.push(ph[0]!);
  let carry = 0;
  for (let i = 1; i < ps.length; i++) {
    const ds = ps[i]! - ps[i - 1]!, dh = ph[i]! - ph[i - 1]!;
    const len = Math.hypot(ds, dh);
    let t = step - carry;
    while (t <= len) {
      s.push(ps[i - 1]! + (t / len) * ds);
      h.push(ph[i - 1]! + (t / len) * dh);
      t += step;
    }
    carry = len - (t - step);
  }
  return { s, h };
}

/** Gaussian smoothing of a sampled profile coordinate (sigma in samples; the ends clamp). */
function gaussian(x: number[], sigma: number): number[] {
  if (sigma <= 0) return x;
  const half = Math.ceil(3 * sigma);
  const w = Array.from({ length: 2 * half + 1 }, (_, k) => Math.exp(-((k - half) ** 2) / (2 * sigma * sigma)));
  const total = w.reduce((a, b) => a + b, 0);
  return x.map((_, i) => {
    let sum = 0;
    for (let k = -half; k <= half; k++) sum += w[k + half]! * x[Math.min(x.length - 1, Math.max(0, i + k))]!;
    return sum / total;
  });
}

/** Clockwise turn (degrees) between the chord arriving at each sample and the chord leaving it (NaN at the ends). */
function turnsDeg(s: number[], h: number[], window: number): number[] {
  const out = new Array<number>(s.length).fill(NaN);
  for (let i = window; i + window < s.length; i++) {
    const before = Math.atan2(h[i]! - h[i - window]!, s[i]! - s[i - window]!);
    const after = Math.atan2(h[i + window]! - h[i]!, s[i + window]! - s[i]!);
    let turn = before - after;
    if (turn > Math.PI) turn -= 2 * Math.PI;
    if (turn <= -Math.PI) turn += 2 * Math.PI;
    out[i] = (turn * 180) / Math.PI;
  }
  return out;
}

const medianAbs = (xs: number[]): number => {
  const a = xs.filter(Number.isFinite).map(Math.abs).sort((p, q) => p - q);
  return a.length ? a[Math.floor(a.length / 2)]! : 0;
};

/** The profile's turns after the least smoothing (SMOOTH_SIGMAS_MM) that makes it quiet, and its median turn before. */
function quietTurns(s: number[], h: number[], window: number, step: number): { turns: number[]; roughDeg: number } {
  let turns: number[] = [];
  let roughDeg = 0;
  for (const sigma of SMOOTH_SIGMAS_MM) {
    turns = turnsDeg(gaussian(s, sigma / step), gaussian(h, sigma / step), window);
    const median = medianAbs(turns);
    if (sigma === 0) roughDeg = median;
    if (median <= QUIET_TURN_DEG) break;
  }
  return { turns, roughDeg };
}

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
