import { symmetricEigen3, type V3 } from './pca';
import { mesialFromBuccal } from './toothFrame';

/**
 * Dental arch curve from a jaw scan, for placing bridge units along the arch.
 *
 * Fit:
 * 1. Vertices in the top 40% of the height along `occlusal` (the teeth, not
 *    the gingiva or palate) are projected on the occlusal plane.
 * 2. In their 2D PCA frame a parabola y = a0 + a1·x + a2·x² is fitted by
 *    least squares (both PCA axes are tried as x; the smaller residual wins,
 *    so deep V-shaped arches work too).
 * 3. If the parabola is nearly straight over the span (depth < 1.5 mm: a
 *    short segment or a straight quadrant), the curve falls back to a line
 *    along the PCA long axis. Otherwise the parabola only places a centre O
 *    inside the arch (its centre of curvature at mid-span), and the curve is
 *    a polar regression around O: the radius r(ψ) of the points against
 *    their angle ψ, smoothed by Gaussian-weighted local linear regression at
 *    stations 1 mm apart (kernel 4 mm). Unlike a parabola y(x) this follows
 *    U-shaped arches whose molar segments turn past 90°, and unlike a global
 *    polynomial or a projection-based principal curve it does not swing at
 *    the ends or across a gap.
 * 4. The midline (between the central incisors) is the curve's most anterior
 *    point along the parabola's axis. It is reported only when the scan is
 *    clearly a full arch: the curve turns by at least 120° and that point
 *    lies in the middle half. A quadrant or sextant scan has no midline
 *    (null); FDI handedness (mesialAt) still gives mesial for any tooth.
 *
 * Frame conventions (all mm):
 * - The curve lies in the plane ⊥ occlusal at the mean height of the tooth
 *   points; pointAt returns points in that plane.
 * - s is arc length; s ∈ [0, lengthMm] spans the tooth points. Beyond the
 *   ends the curve continues straight along the end tangents.
 * - normalAt(s): outward (buccal/labial) unit normal in the plane, away from
 *   the inside of the arch (the tongue side).
 * - tangentAt(s): unit tangent toward increasing s, with
 *   tangent = normal × occlusal, so (tangent, normal, occlusal) is
 *   right-handed. With the FDI rule of toothFrame.mesialFromBuccal, s then
 *   grows toward mesial in quadrants 1 and 3 and toward distal in quadrants 2
 *   and 4, in either jaw; mesialAt(s, fdi) applies that rule.
 */

export interface ArchCurveInput {
  /** Jaw scan vertex positions, xyz packed (mm). */
  positions: Float32Array;
  /** Unit direction from the jaw toward the antagonist (the tooth tips are highest along it). */
  occlusal: V3;
  /**
   * A direction known to point buccally somewhere on the arch (e.g. an
   * abutment frame's buccal axis). Only used for the straight-line fallback,
   * whose inside cannot be told from its shape.
   */
  buccalHint?: V3;
}

export interface ArchCurve {
  /** 'curve': smooth fitted curve; 'line': straight fallback for a nearly straight (short) scan. */
  kind: 'curve' | 'line';
  /** Unit occlusal direction; the curve's plane is perpendicular to it. */
  occlusal: V3;
  /** Arc length (mm) covered by the tooth points. */
  lengthMm: number;
  /** Arc length of the midline, or null when the scan is not clearly a full arch. */
  midlineS: number | null;
  pointAt(s: number): V3;
  /** Unit tangent toward increasing s. */
  tangentAt(s: number): V3;
  /** Unit outward (buccal) normal, ⊥ tangent and occlusal. */
  normalAt(s: number): V3;
  /** Arc length of the curve point closest to p (p is projected on the curve's plane; may be < 0 or > lengthMm). */
  project(p: V3): number;
  /** Unit tangent pointing toward the midline at s; null without a midline. */
  towardMidline(s: number): V3 | null;
  /** Unit mesial direction for tooth `fdi` at s, from FDI handedness (± tangent). */
  mesialAt(s: number, fdi: number): V3;
  /** RMS distance (mm) of the tooth points from the curve, in the plane (dominated by the teeth's bucco-lingual width). */
  rmsMm: number;
  warnings: string[];
}

const TOP_FRACTION = 0.4;
/** Points used for the height quantiles and the parabola. */
const MAX_SAMPLES = 60_000;
/** Points used for the smooth curve. */
const MAX_CURVE_SAMPLES = 6_000;
/** Depth of the parabola over the span below which the scan counts as straight, mm. */
const MIN_SAGITTA_MM = 1.5;
/** Smooth curve: station spacing and Gaussian kernel width along the arch (about half a tooth), mm. */
const STATION_MM = 1;
const KERNEL_MM = 4;
/** A full arch turns by at least this much between its ends. */
const FULL_ARCH_TURN_DEG = 120;

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** Solve a small dense system (Gaussian elimination, partial pivoting); null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const m = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const d = M[col]![col]!;
    if (Math.abs(d) < 1e-12) return null;
    for (let r = col + 1; r < m; r++) {
      const f = M[r]![col]! / d;
      for (let c = col; c <= m; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(m).fill(0);
  for (let r = m - 1; r >= 0; r--) {
    let s = M[r]![m]!;
    for (let c = r + 1; c < m; c++) s -= M[r]![c]! * x[c]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

/**
 * A plane polyline in 2D frame coordinates with smooth unit tangents per
 * vertex and cumulative arc length.
 */
interface Polyline2 {
  xs: Float64Array;
  ys: Float64Array;
  tx: Float64Array;
  ty: Float64Array;
  ss: Float64Array;
}

function polyline(xs: Float64Array, ys: Float64Array, tx: Float64Array, ty: Float64Array): Polyline2 {
  const n = xs.length;
  const ss = new Float64Array(n);
  for (let k = 1; k < n; k++) ss[k] = ss[k - 1]! + Math.hypot(xs[k]! - xs[k - 1]!, ys[k]! - ys[k - 1]!);
  for (let k = 0; k < n; k++) {
    const l = Math.hypot(tx[k]!, ty[k]!) || 1;
    tx[k] = tx[k]! / l;
    ty[k] = ty[k]! / l;
  }
  return { xs, ys, tx, ty, ss };
}

/** Arc length of the closest polyline point to (qx, qy); beyond an end it continues along that end's tangent (s < 0 or > length). */
function projectPolyline(pl: Polyline2, qx: number, qy: number): number {
  const n = pl.xs.length;
  let best = Infinity, bestS = 0;
  for (let k = 0; k < n - 1; k++) {
    const ax = pl.xs[k]!, ay = pl.ys[k]!;
    const ex = pl.xs[k + 1]! - ax, ey = pl.ys[k + 1]! - ay;
    const len2 = ex * ex + ey * ey;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((qx - ax) * ex + (qy - ay) * ey) / len2)) : 0;
    const d = (qx - ax - t * ex) ** 2 + (qy - ay - t * ey) ** 2;
    if (d < best) {
      best = d;
      bestS = pl.ss[k]! + t * Math.sqrt(len2);
    }
  }
  const L = pl.ss[n - 1]!;
  if (bestS <= 0) {
    const along = (qx - pl.xs[0]!) * pl.tx[0]! + (qy - pl.ys[0]!) * pl.ty[0]!;
    if (along < 0) return along;
  } else if (bestS >= L) {
    const along = (qx - pl.xs[n - 1]!) * pl.tx[n - 1]! + (qy - pl.ys[n - 1]!) * pl.ty[n - 1]!;
    if (along > 0) return L + along;
  }
  return bestS;
}

/** Index k of the polyline segment containing arc length s (clamped), and the fraction along it. */
function locate(pl: Polyline2, s: number): { k: number; f: number } {
  const n = pl.xs.length;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pl.ss[mid]! <= s) lo = mid;
    else hi = mid;
  }
  const len = pl.ss[hi]! - pl.ss[lo]!;
  return { k: lo, f: len > 0 ? Math.min(1, Math.max(0, (s - pl.ss[lo]!) / len)) : 0 };
}

/**
 * Smooth arch polyline by polar regression around an inside point O: each
 * point gets its angle ψ around O (measured from +y toward −x) and its
 * radius r, and r(ψ) is fitted at stations about STATION_MM apart by
 * Gaussian-weighted local linear regression (kernel KERNEL_MM along the
 * arch; a local quadratic swings at the ends). Stations with little support
 * (inside a gap much wider than the kernel) are skipped, so the polyline
 * bridges the gap. Every point keeps its own angle, so unlike a
 * projection-based principal curve nothing feeds back at the ends. Stations
 * run from the largest ψ to the smallest, i.e. clockwise around O seen from
 * +occlusal, so s grows along +x at the front and occlusal × tangent points
 * away from O (outward).
 */
function polarCurve(qx: Float64Array, qy: Float64Array, ox: number, oy: number): Polyline2 | null {
  const m = qx.length;
  const psi = new Float64Array(m), rad = new Float64Array(m);
  let pMin = Infinity, pMax = -Infinity;
  const radii: number[] = [];
  for (let i = 0; i < m; i++) {
    const X = qx[i]! - ox, Y = qy[i]! - oy;
    psi[i] = Math.atan2(-X, Y);
    rad[i] = Math.hypot(X, Y);
    pMin = Math.min(pMin, psi[i]!);
    pMax = Math.max(pMax, psi[i]!);
    if (i % 8 === 0) radii.push(rad[i]!);
  }
  radii.sort((a, b) => a - b);
  const rMed = radii[radii.length >> 1]!;
  const sigma = KERNEL_MM / rMed;
  const inv2s2 = 1 / (2 * sigma * sigma);
  const reach = 3 * sigma;
  const K = Math.max(2, Math.ceil(((pMax - pMin) * rMed) / STATION_MM) + 1);
  const fits: Array<{ pk: number; support: number; b: number[] | null }> = [];
  let maxSupport = 0;
  for (let k = 0; k < K; k++) {
    const pk = pMax - ((pMax - pMin) * k) / (K - 1);
    // Local linear fit r ≈ b0 + b1·(ψ − ψk).
    let s0 = 0, s1 = 0, s2 = 0, t0 = 0, t1 = 0;
    for (let i = 0; i < m; i++) {
      const d = psi[i]! - pk;
      if (d > reach || d < -reach) continue;
      const w = Math.exp(-d * d * inv2s2);
      s0 += w;
      s1 += w * d;
      s2 += w * d * d;
      t0 += w * rad[i]!;
      t1 += w * d * rad[i]!;
    }
    fits.push({ pk, support: s0, b: s0 > 0 ? solve([[s0, s1], [s1, s2]], [t0, t1]) : null });
    maxSupport = Math.max(maxSupport, s0);
  }
  const xs: number[] = [], ys: number[] = [], tx: number[] = [], ty: number[] = [];
  for (const { pk, support, b } of fits) {
    if (!b || support < 0.02 * maxSupport) continue;
    const r = b[0]!, dr = b[1]!;
    // Direction u(ψ) = (−sin ψ, cos ψ); P = O + r·u; dP/dψ = r'·u + r·u'(ψ), u' = (−cos ψ, −sin ψ).
    const ux = -Math.sin(pk), uy = Math.cos(pk);
    xs.push(ox + r * ux);
    ys.push(oy + r * uy);
    // s grows with decreasing ψ: tangent = −dP/dψ.
    tx.push(-(dr * ux - r * uy));
    ty.push(-(dr * uy + r * ux));
  }
  if (xs.length < 2) return null;
  return polyline(Float64Array.from(xs), Float64Array.from(ys), Float64Array.from(tx), Float64Array.from(ty));
}

interface ParabolaFit {
  /** In-plane x axis, 2D in the (e1, e2) basis; y runs along occlusal × x = (−ex₂, ex₁). */
  ex: [number, number];
  a0: number;
  a1: number;
  a2: number;
  xmin: number;
  xmax: number;
  rms: number;
}

/** Least-squares y = a0 + a1·x + a2·x² in the frame (ex, occlusal × ex). */
function fitParabola(px: Float64Array, py: Float64Array, ex: [number, number]): ParabolaFit {
  const n = px.length;
  let xmin = Infinity, xmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = px[i]! * ex[0] + py[i]! * ex[1];
    xmin = Math.min(xmin, x);
    xmax = Math.max(xmax, x);
  }
  const h = Math.max(1e-6, (xmax - xmin) / 2);
  const S = [0, 0, 0, 0, 0], T = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const X = (px[i]! * ex[0] + py[i]! * ex[1]) / h;
    const y = -px[i]! * ex[1] + py[i]! * ex[0];
    const X2 = X * X;
    S[0]! += 1;
    S[1]! += X;
    S[2]! += X2;
    S[3]! += X2 * X;
    S[4]! += X2 * X2;
    T[0]! += y;
    T[1]! += X * y;
    T[2]! += X2 * y;
  }
  const b = solve(
    [
      [S[0]!, S[1]!, S[2]!],
      [S[1]!, S[2]!, S[3]!],
      [S[2]!, S[3]!, S[4]!],
    ],
    T,
  ) ?? [T[0]! / n, 0, 0];
  const a0 = b[0]!, a1 = b[1]! / h, a2 = b[2]! / (h * h);
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const x = px[i]! * ex[0] + py[i]! * ex[1];
    const y = -px[i]! * ex[1] + py[i]! * ex[0];
    r2 += (y - (a0 + a1 * x + a2 * x * x)) ** 2;
  }
  return { ex, a0, a1, a2, xmin, xmax, rms: Math.sqrt(r2 / Math.max(1, n)) };
}

/** Fit the arch curve of a jaw scan. Throws if the scan has too few points. */
export function fitArchCurve(input: ArchCurveInput): ArchCurve {
  const P = input.positions;
  const occlusal = normalize(input.occlusal);
  const nv = P.length / 3;
  const warnings: string[] = [];

  // Height range along occlusal (robust: 0.5% / 99.5% quantiles of a subsample); keep the top 40%.
  const step = Math.max(1, Math.floor(nv / MAX_SAMPLES));
  const heights: number[] = [];
  for (let i = 0; i < nv; i += step) heights.push(P[i * 3]! * occlusal[0] + P[i * 3 + 1]! * occlusal[1] + P[i * 3 + 2]! * occlusal[2]);
  if (heights.length < 10) throw new Error('Too few scan points to fit an arch curve');
  const sorted = Float64Array.from(heights).sort();
  const lo = sorted[Math.floor(0.005 * (sorted.length - 1))]!;
  const hi = sorted[Math.ceil(0.995 * (sorted.length - 1))]!;
  const cut = hi - TOP_FRACTION * (hi - lo);
  const sel: number[] = [];
  for (let k = 0, i = 0; i < nv; i += step, k++) if (heights[k]! >= cut) sel.push(i);
  if (sel.length < 10) throw new Error('Too few tooth points to fit an arch curve');

  // 2D coordinates in an occlusal-plane basis (e1, e2, occlusal right-handed), around the centroid.
  const e1 = normalize(cross(occlusal, Math.abs(occlusal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const e2 = cross(occlusal, e1);
  let cx = 0, cy = 0, cz = 0;
  for (const i of sel) {
    cx += P[i * 3]!;
    cy += P[i * 3 + 1]!;
    cz += P[i * 3 + 2]!;
  }
  const n = sel.length;
  const centre: V3 = [cx / n, cy / n, cz / n];
  const px = new Float64Array(n), py = new Float64Array(n);
  let sxx = 0, sxy = 0, syy = 0;
  for (let k = 0; k < n; k++) {
    const i = sel[k]!;
    const d: V3 = [P[i * 3]! - centre[0], P[i * 3 + 1]! - centre[1], P[i * 3 + 2]! - centre[2]];
    px[k] = dot(d, e1);
    py[k] = dot(d, e2);
    sxx += px[k]! * px[k]!;
    sxy += px[k]! * py[k]!;
    syy += py[k]! * py[k]!;
  }
  const { values, vectors } = symmetricEigen3([
    [sxx / n, sxy / n, 0],
    [sxy / n, syy / n, 0],
    [0, 0, 0],
  ]);
  const major = values[0]! >= values[1]! ? 0 : 1;
  const axis2 = (k: number): [number, number] => {
    const l = Math.hypot(vectors[0]![k]!, vectors[1]![k]!);
    return [vectors[0]![k]! / l, vectors[1]![k]! / l];
  };
  // 2D frame axis → 3D.
  const to3 = (a: [number, number]): V3 => normalize([a[0] * e1[0] + a[1] * e2[0], a[0] * e1[1] + a[1] * e2[1], a[0] * e1[2] + a[1] * e2[2]]);

  // Parabola on each PCA axis, opening toward −y (so +y is outward at the apex); the smaller residual wins.
  const fits = [major, 1 - major].map((k) => {
    const fit = fitParabola(px, py, axis2(k));
    return fit.a2 > 0 ? fitParabola(px, py, [-fit.ex[0], -fit.ex[1]]) : fit;
  });
  fits.sort((a, b) => a.rms - b.rms);
  const para = fits[0]!;
  const sagitta = -para.a2 * ((para.xmax - para.xmin) / 2) ** 2;

  if (sagitta < MIN_SAGITTA_MM) {
    // Nearly straight: a line along the PCA long axis; outward from the hint, else from the slight concavity.
    let ex = axis2(major);
    let outward = fitParabola(px, py, ex).a2 <= 0 ? 1 : -1;
    if (input.buccalHint) outward = dot(normalize(input.buccalHint), to3([-ex[1], ex[0]])) >= 0 ? 1 : -1;
    else warnings.push('The scan is nearly straight: the arch curve is a line and buccal was guessed; pass a buccal hint.');
    if (outward < 0) ex = [-ex[0], -ex[1]];
    const line = fitParabola(px, py, ex);
    let r2 = 0;
    for (let i = 0; i < n; i++) r2 += (-px[i]! * ex[1] + py[i]! * ex[0]) ** 2;
    warnings.push('No midline: the scan is not a full arch.');
    const pl = polyline(Float64Array.of(line.xmin, line.xmax), Float64Array.of(0, 0), Float64Array.of(1, 1), Float64Array.of(0, 0));
    return buildCurve({ kind: 'line', occlusal, centre, ex: to3(ex), ey: to3([-ex[1], ex[0]]), pl, midlineS: null, rms: Math.sqrt(r2 / n), warnings });
  }

  // Smooth curve by polar regression around the parabola's centre of curvature at the middle of the span
  // (inside the arch, about one radius of curvature from the teeth), in the parabola's frame.
  const ex = para.ex;
  const sub = Math.max(1, Math.floor(n / MAX_CURVE_SAMPLES));
  const m = Math.ceil(n / sub);
  const qx = new Float64Array(m), qy = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const i = k * sub;
    qx[k] = px[i]! * ex[0] + py[i]! * ex[1];
    qy[k] = -px[i]! * ex[1] + py[i]! * ex[0];
  }
  const xMid = (para.xmin + para.xmax) / 2;
  const slope = para.a1 + 2 * para.a2 * xMid;
  const radius = (1 + slope * slope) ** 1.5 / (-2 * para.a2);
  const nl = Math.hypot(slope, 1);
  // Inward normal of y = f(x) opening toward −y: (slope, −1)/|·|.
  const ox = xMid + (radius * slope) / nl;
  const oy = para.a0 + para.a1 * xMid + para.a2 * xMid * xMid - radius / nl;
  const pl = polarCurve(qx, qy, ox, oy);
  if (!pl) throw new Error('Could not fit an arch curve to the tooth points');

  // Residual over all tooth points.
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const x = px[i]! * ex[0] + py[i]! * ex[1];
    const y = -px[i]! * ex[1] + py[i]! * ex[0];
    const { k, f } = locate(pl, projectPolyline(pl, x, y));
    const k1 = Math.min(pl.xs.length - 1, k + 1);
    r2 += (pl.xs[k]! + f * (pl.xs[k1]! - pl.xs[k]!) - x) ** 2 + (pl.ys[k]! + f * (pl.ys[k1]! - pl.ys[k]!) - y) ** 2;
  }

  // Midline: the most anterior station (largest y), refined by a parabola through its neighbours;
  // only for a full arch (turns ≥ 120° between its ends, apex in the middle half).
  const K = pl.xs.length;
  let kb = 0;
  for (let k = 1; k < K; k++) if (pl.ys[k]! > pl.ys[kb]!) kb = k;
  let apexS = pl.ss[kb]!;
  if (kb > 0 && kb < K - 1) {
    const y0 = pl.ys[kb - 1]!, y1 = pl.ys[kb]!, y2 = pl.ys[kb + 1]!;
    const den = y0 - 2 * y1 + y2;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    apexS = off >= 0 ? pl.ss[kb]! + off * (pl.ss[kb + 1]! - pl.ss[kb]!) : pl.ss[kb]! + off * (pl.ss[kb]! - pl.ss[kb - 1]!);
  }
  const turnDeg = (Math.acos(Math.max(-1, Math.min(1, pl.tx[0]! * pl.tx[K - 1]! + pl.ty[0]! * pl.ty[K - 1]!))) * 180) / Math.PI;
  const L = pl.ss[K - 1]!;
  const fullArch = turnDeg >= FULL_ARCH_TURN_DEG && apexS >= 0.25 * L && apexS <= 0.75 * L;
  if (!fullArch) warnings.push('No midline: the scan is not a full arch.');
  return buildCurve({
    kind: 'curve',
    occlusal,
    centre,
    ex: to3(ex),
    ey: to3([-ex[1], ex[0]]),
    pl,
    midlineS: fullArch ? apexS : null,
    rms: Math.sqrt(r2 / n),
    warnings,
  });
}

interface CurveSpec {
  kind: 'curve' | 'line';
  occlusal: V3;
  centre: V3;
  /** 3D unit axes of the 2D frame (ey = occlusal × ex). */
  ex: V3;
  ey: V3;
  pl: Polyline2;
  midlineS: number | null;
  rms: number;
  warnings: string[];
}

/** 3D arc-length curve over a 2D polyline (stations 1 mm apart, interpolated tangents), straight beyond its ends. */
function buildCurve(spec: CurveSpec): ArchCurve {
  const { ex, ey, centre, pl, occlusal, midlineS } = spec;
  const n = pl.xs.length;
  const L = pl.ss[n - 1]!;
  const to3 = (x: number, y: number): V3 => [centre[0] + x * ex[0] + y * ey[0], centre[1] + x * ex[1] + y * ey[1], centre[2] + x * ex[2] + y * ey[2]];
  const tangentAt = (s: number): V3 => {
    const { k, f } = locate(pl, s);
    const k1 = Math.min(n - 1, k + 1);
    const tx = pl.tx[k]! + f * (pl.tx[k1]! - pl.tx[k]!);
    const ty = pl.ty[k]! + f * (pl.ty[k1]! - pl.ty[k]!);
    return normalize([tx * ex[0] + ty * ey[0], tx * ex[1] + ty * ey[1], tx * ex[2] + ty * ey[2]]);
  };
  const pointAt = (s: number): V3 => {
    const sc = Math.min(L, Math.max(0, s));
    const { k, f } = locate(pl, sc);
    const k1 = Math.min(n - 1, k + 1);
    const p = to3(pl.xs[k]! + f * (pl.xs[k1]! - pl.xs[k]!), pl.ys[k]! + f * (pl.ys[k1]! - pl.ys[k]!));
    if (sc === s) return p;
    const t = tangentAt(sc);
    return [p[0] + (s - sc) * t[0], p[1] + (s - sc) * t[1], p[2] + (s - sc) * t[2]];
  };
  // tangent = normal × occlusal  ⇔  normal = occlusal × tangent.
  const normalAt = (s: number): V3 => normalize(cross(occlusal, tangentAt(s)));
  const project = (p: V3): number => {
    const d: V3 = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    return projectPolyline(pl, dot(d, ex), dot(d, ey));
  };
  return {
    kind: spec.kind,
    occlusal,
    lengthMm: L,
    midlineS,
    pointAt,
    tangentAt,
    normalAt,
    project,
    towardMidline: (s: number) => {
      if (midlineS === null) return null;
      const t = tangentAt(s);
      return s <= midlineS ? t : [-t[0], -t[1], -t[2]];
    },
    mesialAt: (s: number, fdi: number) => mesialFromBuccal(fdi, occlusal, normalAt(s)),
    rmsMm: spec.rms,
    warnings: spec.warnings,
  };
}
