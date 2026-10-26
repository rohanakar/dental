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
  return { occlusal: o, midlineS: curve.midlineS, preps: sites, examined: peaks.length, ms: performance.now() - t0 };
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
