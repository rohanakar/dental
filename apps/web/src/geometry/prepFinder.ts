import { fitArchCurve } from './arch';
import { principalAxes, type V3 } from './pca';
import { findPrepStump, stumpWallAxis } from './prepAxis';
import type { RayCaster } from './raycast';

/**
 * Crown preps on a jaw scan, from its surface alone: where a first-time user has to click on a real scan
 * (specs/2026-10-26-prep-finder.md). Precision first: a wrong ring is worse than none.
 *
 * 1. Occlusal: the jaw's least-variance axis, toward the antagonist (else where the normals face: out of the teeth).
 * 2. The arch curve (fitArchCurve) and its crest: the highest surface point across the band, every 0.25 mm along it.
 * 3. Candidates: the crest's peaks, highest first, at least 3 mm apart.
 * 4. The finish line all round: on at least 75% of 24 radial height profiles from the candidate's top, a wall (at
 *    least 1 mm of drop) eases into a ledge (the chamfer or shoulder) that drops again (the root below the margin).
 *    A natural tooth's profiles run into its neighbours, or down its crown onto the gum, where the ease never ends
 *    in a drop; a scan body has no ledge; a cavity keeps the tooth's natural cusps and walls. Measured: every
 *    non-prep at 0.29 or below, every prep at 0.75 or above.
 * 5. Profiles are cast along the occlusal direction. A front tooth that leans hides its lingual ledge, so a candidate
 *    with 40–75% is profiled again along its stump's own axis (stumpWallAxis).
 * 6. The ring's centre: the centroid of the ledge points, cast onto the top.
 * 7. Scan bodies (implant crowns; specs/2026-10-26-auto-frames-jaws-implants.md), from the same peaks: a flat top (a
 *    plane fitted around the peak and re-centred, RMS ≤ 0.05 mm within 1.2 mm, within 30° of the occlusal), its edge
 *    on a circle of 1.4–3.5 mm radius, a wall that drops 3.5 mm within 0.6 mm past the edge on at least 80% of the
 *    profiles (cast along the top's normal), and no ledge. Measured: every scan body at 1.00 wall, every other peak
 *    at 0.67 or below, and none of those with a flat round top above 0.13.
 */

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const scale = (a: readonly number[], s: number): V3 => [a[0]! * s, a[1]! * s, a[2]! * s];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const normalize = (a: readonly number[]): V3 => {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!);
  return l > 0 ? [a[0]! / l, a[1]! / l, a[2]! / l] : [0, 0, 1];
};

export interface PrepFinderInput {
  /** Jaw scan, xyz per vertex. */
  positions: Float32Array;
  /** Vertex normals (outward), for the occlusal direction. */
  normals: Float32Array;
  /** Triangle indices (any order), for the stump axis of a leaning tooth. */
  indices: ArrayLike<number>;
  ray: RayCaster;
  /** The antagonist's centroid, when it is loaded: the occlusal direction faces it (step 1). */
  antagonistCentroid?: V3;
}

export interface PrepSite {
  /** Centre of the prep top: under the centroid of its ledge points. */
  top: V3;
  /** Arc length of the top on the arch curve (increases toward quadrants 4 and 2: ArchCurve.tangentAt). */
  s: number;
  /** Fraction of the radial profiles with a ledge (0.75–1). */
  ring: number;
}

export interface PrepFinding {
  occlusal: V3;
  /** Arc length of the midline, or null when the scan is not clearly a full arch (ArchCurve.midlineS). */
  midlineS: number | null;
  /** The preps, in arch order (increasing s). */
  preps: PrepSite[];
  /** The scan bodies, in arch order: `top` is the centre of the flat top, `ring` the fraction of its tall wall. */
  scanBodies: PrepSite[];
  /** Peaks whose finish line was looked for. */
  examined: number;
  ms: number;
}

const S_STEP_MM = 0.25;
const BAND_HALF_MM = 6;
const BAND_STEP_MM = 0.5;
const PEAK_SPACING_MM = 3;
const PROFILES = 24;
const PROFILE_STEP_MM = 0.05;
const PROFILE_RADIUS_MM = 8;
const MIN_RING = 0.75;
/** A ring this partial is profiled again along the stump's own axis (a leaning front tooth). */
const RETRY_RING = 0.4;
/** Slopes are taken over ±this many profile samples (±0.1 mm). */
const SLOPE_HALF = 2;
const LIFT_MM = 30;

/** Crown preps on a jaw scan (see the module comment). */
export function findPreps(input: PrepFinderInput): PrepFinding {
  const t0 = performance.now();
  const { positions: P, ray } = input;
  const o = jawOcclusal(P, input.normals, input.antagonistCentroid);
  const curve = fitArchCurve({ positions: P, occlusal: o });
  const heightAt = (p: readonly number[], axis: V3 = o): number | null => {
    const hit = ray.first(add(p, scale(axis, LIFT_MM)), scale(axis, -1), 2 * LIFT_MM);
    return hit ? dot(hit.point, axis) : null;
  };

  // 2. The crest along the arch.
  const ns = Math.floor(curve.lengthMm / S_STEP_MM) + 1;
  const crest = new Float64Array(ns).fill(-Infinity);
  const crestPoint: V3[] = new Array(ns);
  for (let i = 0; i < ns; i++) {
    const s = i * S_STEP_MM;
    const c = curve.pointAt(s);
    const n = curve.normalAt(s);
    for (let t = -BAND_HALF_MM; t <= BAND_HALF_MM + 1e-9; t += BAND_STEP_MM) {
      const p = add(c, scale(n, t));
      const h = heightAt(p);
      if (h !== null && h > crest[i]!) {
        crest[i] = h;
        crestPoint[i] = add(p, scale(o, h - dot(p, o)));
      }
    }
  }
  // 3. Peaks, highest first, at least PEAK_SPACING_MM apart.
  const order = Array.from({ length: ns }, (_, i) => i)
    .filter((i) => Number.isFinite(crest[i]!))
    .sort((a, b) => crest[b]! - crest[a]!);
  const taken = new Uint8Array(ns);
  const spacing = Math.round(PEAK_SPACING_MM / S_STEP_MM);
  const peaks: number[] = [];
  for (const i of order) {
    if (taken[i]) continue;
    for (let k = Math.max(0, i - spacing); k <= Math.min(ns - 1, i + spacing); k++) taken[k] = 1;
    peaks.push(i);
  }
  // 4. The finish line around each peak.
  const sites: PrepSite[] = [];
  for (const i of peaks) {
    const s = i * S_STEP_MM;
    const frame = { mesial: curve.tangentAt(s), buccal: curve.normalAt(s) };
    let ring = finishLine(ray, crestPoint[i]!, o, frame.mesial);
    if (ring.fraction >= RETRY_RING && ring.fraction < MIN_RING) {
      // A leaning front tooth: its lingual ledge is hidden from the occlusal direction.
      const stump = findPrepStump({ positions: P, indices: input.indices, frame: { origin: crestPoint[i]!, ...frame }, occlusal: o });
      const own = stump && stumpWallAxis(stump, o);
      if (own && dot(own, o) > Math.cos((40 * Math.PI) / 180)) {
        const along = finishLine(ray, stump.top, own, frame.mesial);
        if (along.fraction > ring.fraction) ring = along;
      }
    }
    if (ring.fraction < MIN_RING) continue;
    // The ring's centre: the centroid of the ledge points, in the plane across the profiles' axis.
    const c = ring.ledges.reduce<V3>((acc, p) => add(acc, scale(p, 1 / ring.ledges.length)), [0, 0, 0]);
    const h = heightAt(c, ring.axis);
    if (h === null) continue;
    const top = add(c, scale(ring.axis, h - dot(c, ring.axis)));
    if (sites.some((x) => Math.hypot(x.top[0] - top[0], x.top[1] - top[1], x.top[2] - top[2]) < PEAK_SPACING_MM)) continue;
    sites.push({ top, s: curve.project(top), ring: ring.fraction });
  }
  sites.sort((a, b) => a.s - b.s);
  // 7. Scan bodies: a flat round top on a tall wall, and no ledge.
  const bodies: PrepSite[] = [];
  for (const i of peaks) {
    const top = scanBodyTop(ray, crestPoint[i]!, o);
    if (!top || bodies.some((x) => Math.hypot(x.top[0] - top.top[0], x.top[1] - top.top[1], x.top[2] - top.top[2]) < PEAK_SPACING_MM)) continue;
    bodies.push({ top: top.top, s: curve.project(top.top), ring: top.wall });
  }
  bodies.sort((a, b) => a.s - b.s);
  return { occlusal: o, midlineS: curve.midlineS, preps: sites, scanBodies: bodies, examined: peaks.length, ms: performance.now() - t0 };
}

const SB_GRID_MM = 0.25;
const SB_WINDOW_MM = 2.5;
const SB_FLAT_R_MM = 1.2;
const SB_MAX_RMS_MM = 0.05;
const SB_MAX_TILT_DEG = 30;
const SB_EDGE_DROP_MM = 0.5;
const SB_EDGE_R_MM = [1.4, 3.5] as const;
const SB_MAX_SPREAD_MM = 0.8;
const SB_WALL_DROP_MM = 3.5;
const SB_WALL_PAST_MM = 0.6;
const SB_MIN_WALL = 0.8;

/**
 * The scan body standing on a crest peak, or null (step 7 of the module comment): its flat top's centre and the
 * fraction of its profiles with the tall wall.
 */
function scanBodyTop(ray: RayCaster, peak: V3, o: V3): { top: V3; wall: number } | null {
  const castAt = (p: readonly number[], axis: V3): V3 | null => ray.first(add(p, scale(axis, LIFT_MM)), scale(axis, -1), 2 * LIFT_MM)?.point ?? null;
  const across = (n: V3): [V3, V3] => {
    const u = normalize(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
    return [u, cross(n, u)];
  };
  // Surface points on a grid within `radius` of c, cast along n.
  const discAround = (c: V3, n: V3, radius: number): V3[] => {
    const [u, v] = across(n);
    const out: V3[] = [];
    for (let a = -radius; a <= radius + 1e-9; a += SB_GRID_MM) {
      for (let b = -radius; b <= radius + 1e-9; b += SB_GRID_MM) {
        if (a * a + b * b > radius * radius) continue;
        const hit = castAt(add(c, add(scale(u, a), scale(v, b))), n);
        if (hit) out.push(hit);
      }
    }
    return out;
  };
  const fit = (pts: V3[]) => {
    const plane = principalAxes(Float32Array.from(pts.flat()));
    return { centroid: plane.centroid, n: dot(plane.axes[2], o) < 0 ? scale(plane.axes[2], -1) : plane.axes[2] };
  };
  // The top: the points level with the peak near it, then three times the points on the plane fitted to them within
  // the window, re-centred on each fit (the plane follows a tilted top).
  const peakH = dot(peak, o);
  const level = discAround(peak, o, 1.5).filter((p) => Math.abs(dot(p, o) - peakH) <= SB_EDGE_DROP_MM);
  if (level.length < 8) return null;
  let t = fit(level);
  for (let it = 0; it < 3; it++) {
    const { centroid, n } = t;
    const onPlane = discAround(centroid, n, SB_WINDOW_MM).filter((p) => Math.abs(dot(p, n) - dot(centroid, n)) <= 0.25);
    if (onPlane.length < 8) return null;
    t = fit(onPlane);
  }
  // Flat: the plane through every sample within 1.2 mm of the centre.
  const disc = discAround(t.centroid, t.n, SB_FLAT_R_MM);
  if (disc.length < 8) return null;
  const { centroid: centre, n } = fit(disc);
  const rms = Math.sqrt(disc.reduce((sq, p) => sq + dot([p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]], n) ** 2, 0) / disc.length);
  if (rms > SB_MAX_RMS_MM || dot(n, o) < Math.cos((SB_MAX_TILT_DEG * Math.PI) / 180)) return null;
  // A tall round wall: on radial profiles along the top's normal, the edge (0.5 mm below the top) on a circle, and a
  // drop of 3.5 mm within 0.6 mm past it.
  const topH = dot(centre, n);
  const [u, v] = across(n);
  const edges: number[] = [];
  let walls = 0;
  for (let k = 0; k < PROFILES; k++) {
    const th = (2 * Math.PI * k) / PROFILES;
    const dir = add(scale(u, Math.cos(th)), scale(v, Math.sin(th)));
    const h = (r: number) => {
      const hit = castAt(add(centre, scale(dir, r)), n);
      return hit ? dot(hit, n) - topH : -Infinity;
    };
    let edge = 0.5;
    while (edge <= SB_EDGE_R_MM[1] + SB_WALL_PAST_MM && h(edge) >= -SB_EDGE_DROP_MM) edge += PROFILE_STEP_MM;
    if (edge > SB_EDGE_R_MM[1] + SB_WALL_PAST_MM) continue;
    edges.push(edge);
    let lowest = Infinity;
    for (let r = edge; r <= edge + SB_WALL_PAST_MM + 1e-9; r += PROFILE_STEP_MM) lowest = Math.min(lowest, h(r));
    if (lowest <= -SB_WALL_DROP_MM) walls++;
  }
  const wall = walls / PROFILES;
  if (wall < SB_MIN_WALL) return null;
  edges.sort((a, b) => a - b);
  const median = edges[Math.floor(edges.length / 2)]!;
  const spread = edges[Math.floor(edges.length * 0.9)]! - edges[Math.floor(edges.length * 0.1)]!;
  if (median < SB_EDGE_R_MM[0] || median > SB_EDGE_R_MM[1] || spread > SB_MAX_SPREAD_MM) return null;
  // No ledge: a narrow prep with steep walls has its finish line.
  if (finishLine(ray, centre, n, u).fraction >= RETRY_RING) return null;
  return { top: centre, wall };
}

/** The jaw's occlusal direction: the least-variance axis, toward the antagonist, else toward where the normals face. */
function jawOcclusal(P: Float32Array, N: Float32Array, antagonist?: V3): V3 {
  const { axes, centroid } = principalAxes(P, 50_000);
  const axis = axes[2];
  if (antagonist) return dot(axis, [antagonist[0] - centroid[0], antagonist[1] - centroid[1], antagonist[2] - centroid[2]]) >= 0 ? axis : scale(axis, -1);
  const n = N.length / 3;
  const step = Math.max(1, Math.floor(n / 50_000));
  let sum = 0;
  for (let i = 0; i < n; i += step) sum += N[i * 3]! * axis[0] + N[i * 3 + 1]! * axis[1] + N[i * 3 + 2]! * axis[2];
  return sum >= 0 ? axis : scale(axis, -1);
}

/** The finish line around a top: radial height profiles along −axis, and the ledge points they found. */
function finishLine(ray: RayCaster, top: V3, axis: V3, mesial: V3): { fraction: number; ledges: V3[]; axis: V3 } {
  const u = normalize(add(mesial, scale(axis, -dot(mesial, axis))));
  const v = cross(axis, u);
  const topH = dot(top, axis);
  const down = scale(axis, -1);
  const ledges: V3[] = [];
  for (let k = 0; k < PROFILES; k++) {
    const th = (2 * Math.PI * k) / PROFILES;
    const dir = add(scale(u, Math.cos(th)), scale(v, Math.sin(th)));
    const rs: number[] = [];
    const hs: number[] = [];
    const points: V3[] = [];
    let lowest = Infinity;
    for (let r = PROFILE_STEP_MM; r <= PROFILE_RADIUS_MM; r += PROFILE_STEP_MM) {
      const hit = ray.first(add(add(top, scale(dir, r)), scale(axis, LIFT_MM)), down, 2 * LIFT_MM);
      if (!hit) break;
      const h = dot(hit.point, axis) - topH;
      // Past the first 1.5 mm of drop, a rise of 0.5 mm is the neighbouring tooth.
      if (lowest < -1.5 && h > lowest + 0.5) break;
      lowest = Math.min(lowest, h);
      rs.push(r);
      hs.push(h);
      points.push(hit.point);
    }
    const i = ledgeIndex(rs, hs);
    if (i >= 0) ledges.push(points[i]!);
  }
  return { fraction: ledges.length / PROFILES, ledges, axis };
}

/**
 * The ledge of one profile (heights ≤ 0 below the top), or −1: going outward, past a wall (a slope of at least 1.2
 * and at least 1 mm of drop), the first stretch of at least 0.1 mm where the slope eases to less than half the
 * wall's, followed by a drop of at least 0.4 mm below it (the root under the margin). A stretch that runs out
 * without the drop (a natural tooth's foot on the gum, an edentulous ridge) does not count.
 */
function ledgeIndex(rs: number[], hs: number[]): number {
  const n = hs.length;
  const w = SLOPE_HALF;
  const fall = (i: number) => (hs[i - w]! - hs[i + w]!) / (rs[i + w]! - rs[i - w]!);
  let wall = 0;
  for (let i = w; i + w < n; i++) {
    const g = fall(i);
    if (g > wall && hs[i]! < -0.3) wall = g;
    if (wall < 1.2 || hs[i]! > -1 || g > 0.5 * wall) continue;
    let j = i;
    while (j + 1 + w < n && fall(j + 1) <= 0.5 * wall) j++;
    if (rs[j]! - rs[i]! < 0.1) continue;
    let lowest = hs[j]!;
    for (let k = j; k < n; k++) lowest = Math.min(lowest, hs[k]!);
    return hs[j]! - lowest >= 0.4 ? i : -1;
  }
  return -1;
}

/**
 * Where an FDI tooth comes in its jaw's arch order, which grows with the arch curve's s: 37…31 41…47 in the lower
 * jaw, 17…11 21…27 in the upper (the curve's tangent is normal × occlusal; see ArchCurve).
 */
export const archOrdinal = (fdi: number): number => {
  const q = Math.floor(fdi / 10);
  return q === 1 || q === 3 ? -(fdi % 10) : fdi % 10;
};

/**
 * The prep of tooth `fdi`: the case's crown-prep teeth on this jaw (`teeth`, with `fdi`) and the preps found are
 * paired in arch order, on fdi's side of the midline when the scan is a full arch. Null unless both counts agree on
 * that side, so a missed or an extra prep never shifts the pairing onto the wrong tooth.
 */
export function prepFor(finding: Pick<PrepFinding, 'preps' | 'midlineS'>, fdi: number, teeth: readonly number[]): PrepSite | null {
  const right = archOrdinal(fdi) > 0;
  const mid = finding.midlineS;
  const mine = [...new Set([...teeth, fdi])].filter((f) => mid === null || archOrdinal(f) > 0 === right).sort((a, b) => archOrdinal(a) - archOrdinal(b));
  const preps = finding.preps.filter((p) => mid === null || p.s > mid === right);
  return preps.length === mine.length ? preps[mine.indexOf(fdi)]! : null;
}

/** The scan body of implant tooth `fdi`, paired with the case's implant teeth on this jaw (`teeth`) as prepFor does. */
export const scanBodyFor = (finding: Pick<PrepFinding, 'scanBodies' | 'midlineS'>, fdi: number, teeth: readonly number[]): PrepSite | null =>
  prepFor({ preps: finding.scanBodies, midlineS: finding.midlineS }, fdi, teeth);
