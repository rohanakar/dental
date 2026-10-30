import type { V3 } from './pca';
import type { RayCaster } from './raycast';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};
const DEG = Math.PI / 180;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface AxisSearchResult {
  /** Unit insertion direction (the crown seats moving along −direction). */
  direction: V3;
  /** Projected undercut area Σ area·max(0, −n·d) over the prep faces, mm². */
  undercutAreaMm2: number;
  /** Same measure for the cone centre (occlusal direction). */
  centerUndercutAreaMm2: number;
  angleFromCenterDeg: number;
}

/** Orthonormal basis (u, v) perpendicular to unit n. */
function basis(n: V3): [V3, V3] {
  const u = normalize(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  return [u, cross(n, u)];
}

/** Direction at polar angle theta (rad) and azimuth phi around unit c. */
function onCap(c: V3, u: V3, v: V3, theta: number, phi: number): V3 {
  const s = Math.sin(theta);
  const k = Math.cos(theta);
  return normalize([
    c[0] * k + s * (Math.cos(phi) * u[0] + Math.sin(phi) * v[0]),
    c[1] * k + s * (Math.cos(phi) * u[1] + Math.sin(phi) * v[1]),
    c[2] * k + s * (Math.cos(phi) * u[2] + Math.sin(phi) * v[2]),
  ]);
}

/**
 * Least-undercut insertion axis within a cone around `center` (the occlusal
 * direction). Cost = Σ area·max(0, −n_f·d) over masked faces plus a small
 * tie-break toward the centre, so a well-tapered prep keeps the occlusal
 * direction. Fibonacci samples on the cap, then a 0.25° local refinement.
 */
export function searchInsertionAxis(input: {
  positions: Float32Array;
  indices: Uint32Array;
  faceMask: Uint8Array;
  center: V3;
  coneDeg?: number;
  samples?: number;
  /**
   * Directions that must pass (searchVisibleAxis: every margin point visible), checked lazily in cost order: the
   * least-cost direction that passes wins, or the least-cost one when none does.
   */
  accept?: (d: V3) => boolean;
}): AxisSearchResult {
  const { positions: P, indices, faceMask, accept } = input;
  const center = normalize(input.center);
  const cone = (input.coneDeg ?? 25) * DEG;
  // Area-weighted face normals (|cross| / 2 = area).
  const an: number[] = [];
  let totalArea = 0;
  for (let f = 0; f < faceMask.length; f++) {
    if (!faceMask[f]) continue;
    const a = indices[f * 3]! * 3, b = indices[f * 3 + 1]! * 3, c = indices[f * 3 + 2]! * 3;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
    const nx = 0.5 * (uy * vz - uz * vy), ny = 0.5 * (uz * vx - ux * vz), nz = 0.5 * (ux * vy - uy * vx);
    an.push(nx, ny, nz);
    totalArea += Math.hypot(nx, ny, nz);
  }
  const weighted = new Float64Array(an);
  const undercut = (d: V3) => {
    let sum = 0;
    for (let i = 0; i < weighted.length; i += 3) {
      const x = weighted[i]! * d[0] + weighted[i + 1]! * d[1] + weighted[i + 2]! * d[2];
      if (x < 0) sum -= x;
    }
    return sum;
  };
  // Tie-break: 0.1% of the prep area per 10°.
  const lambda = (1e-3 * totalArea) / (10 * DEG);
  const angleTo = (d: V3) => Math.acos(Math.min(1, Math.max(-1, dot(d, center))));
  const cost = (d: V3) => undercut(d) + lambda * angleTo(d);

  const [u, v] = basis(center);
  const samples = input.samples ?? 400;
  const cosCone = Math.cos(cone);
  const candidates: Array<{ d: V3; c: number }> = [{ d: center, c: cost(center) }];
  for (let i = 1; i < samples; i++) {
    const cosT = 1 - ((1 - cosCone) * i) / (samples - 1);
    const d = onCap(center, u, v, Math.acos(cosT), i * GOLDEN_ANGLE);
    candidates.push({ d, c: cost(d) });
  }
  // Stable: among equal costs the earlier sample (the centre first) wins.
  candidates.sort((a, b) => a.c - b.c);
  const passed = accept ? candidates.find((x) => accept(x.d)) : undefined;
  const constrained = passed !== undefined;
  let { d: best, c: bestCost } = passed ?? candidates[0]!;
  // Local refinement: ±1.5° grid at 0.25° around the best sample, kept inside the cone.
  const [bu, bv] = basis(best);
  const coarse = best;
  for (let i = -6; i <= 6; i++) {
    for (let j = -6; j <= 6; j++) {
      if (i === 0 && j === 0) continue;
      const t = Math.hypot(i, j) * 0.25 * DEG;
      const d = onCap(coarse, bu, bv, t, Math.atan2(j, i));
      if (angleTo(d) > cone) continue;
      const c = cost(d);
      if (c < bestCost && (!constrained || accept!(d))) {
        bestCost = c;
        best = d;
      }
    }
  }
  return {
    direction: best,
    undercutAreaMm2: undercut(best),
    centerUndercutAreaMm2: undercut(center),
    angleFromCenterDeg: angleTo(best) / DEG,
  };
}

/** True if face f has vertex v as a corner. */
const hasCorner = (indices: Uint32Array, f: number, v: number) =>
  indices[f * 3] === v || indices[f * 3 + 1] === v || indices[f * 3 + 2] === v;

/**
 * Blockout depth per vertex for an insertion axis: a ray from each masked
 * vertex along +axis; the distance to the first prep face it hits is the
 * depth (0 = visible from the insertion direction). NaN outside the mask.
 */
export function undercutDepths(input: {
  positions: Float32Array;
  indices: Uint32Array;
  vertexMask: Uint8Array;
  faceMask: Uint8Array;
  axis: V3;
  ray: RayCaster;
  maxDepthMm?: number;
}): Float32Array {
  const { positions: P, indices, vertexMask, faceMask, ray } = input;
  const d = normalize(input.axis);
  const far = input.maxDepthMm ?? 15;
  const out = new Float32Array(P.length / 3).fill(NaN);
  const eps = 0.01;
  for (let v = 0; v < out.length; v++) {
    if (!vertexMask[v]) continue;
    const o: V3 = [P[v * 3]! + eps * d[0], P[v * 3 + 1]! + eps * d[1], P[v * 3 + 2]! + eps * d[2]];
    let depth = 0;
    for (const hit of ray.all(o, d, far)) {
      if (hit.distance < 0.01 || !faceMask[hit.faceIndex] || hasCorner(indices, hit.faceIndex, v)) continue;
      depth = hit.distance + eps;
      break;
    }
    out[v] = depth;
  }
  return out;
}

/**
 * Margin points in an undercut: a ray from each point (packed xyz) along
 * +axis that hits a prep face means the prep overhangs the margin there.
 * An overhang of at most `toleranceMm` (default
 * MARGIN_UNDERCUT_TOLERANCE_MM) does not count: the ray is cast again from
 * the point moved that far outward (perpendicular to the axis, away from the
 * margin's centre) and must still hit.
 */
export function marginUndercut(input: { points: Float32Array; axis: V3; ray: RayCaster; faceMask: Uint8Array; toleranceMm?: number }): {
  flags: Uint8Array;
  count: number;
} {
  const d = normalize(input.axis);
  const p = input.points;
  const n = p.length / 3;
  const flags = new Uint8Array(n);
  const tol = input.toleranceMm ?? MARGIN_UNDERCUT_TOLERANCE_MM;
  let count = 0;
  const eps = 0.02;
  const hidden = (x: number, y: number, z: number) => {
    for (const hit of input.ray.all([x + eps * d[0], y + eps * d[1], z + eps * d[2]], d, 15)) {
      if (hit.distance >= 0.02 && input.faceMask[hit.faceIndex]) return true;
    }
    return false;
  };
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += p[i * 3]! / n;
    cy += p[i * 3 + 1]! / n;
    cz += p[i * 3 + 2]! / n;
  }
  for (let i = 0; i < n; i++) {
    const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!;
    if (!hidden(x, y, z)) continue;
    if (tol > 0) {
      const r: V3 = [x - cx, y - cy, z - cz];
      const along = dot(r, d);
      const out: V3 = [r[0] - along * d[0], r[1] - along * d[1], r[2] - along * d[2]];
      const l = Math.hypot(out[0], out[1], out[2]);
      if (l > 0 && !hidden(x + (tol * out[0]) / l, y + (tol * out[1]) / l, z + (tol * out[2]) / l)) continue;
    }
    flags[i] = 1;
    count++;
  }
  return { flags, count };
}

/**
 * A margin hidden by no more than this (mm) counts as visible: about a scanner's accuracy, below a crown's cement gap
 * (0.03–0.05 mm), and real scans are rough on that scale. On the exocad bridges every margin point the plain ray test
 * flagged was hidden by at most 0.1 mm, most by 0.02 mm or less (specs/2026-10-30-bridge-frames-on-segment-scans.md).
 */
export const MARGIN_UNDERCUT_TOLERANCE_MM = 0.05;

/**
 * The least-undercut insertion axis that keeps the margin visible: searchInsertionAxis, and when its direction hides
 * margin points (marginUndercut), the least-undercut direction in the cone that hides none, if there is one. Seating
 * along an axis that hides the margin leaves the crown short of it; blocked-out walls only cost cement.
 */
export function searchVisibleAxis(input: {
  positions: Float32Array;
  indices: Uint32Array;
  faceMask: Uint8Array;
  center: V3;
  ray: RayCaster;
  /** Every margin that must stay visible, with its prep region (one per abutment). */
  margins: Array<{ points: Float32Array; faceMask: Uint8Array }>;
  coneDeg?: number;
  samples?: number;
}): AxisSearchResult {
  const { ray, margins, ...search } = input;
  const visible = (d: V3) => margins.every((m) => marginUndercut({ points: m.points, axis: d, ray, faceMask: m.faceMask }).count === 0);
  const found = searchInsertionAxis(search);
  return visible(found.direction) ? found : searchInsertionAxis({ ...search, accept: visible });
}

/** Abutments whose individual best axes diverge by more than this get a warning (long or curved spans). */
export const AXIS_DIVERGENCE_WARN_DEG = 12;

export interface CommonAxisAbutment {
  fdi: number;
  /** This abutment's prep region (faces inside its margin). */
  faceMask: Uint8Array;
  /** Dense margin, xyz per point. */
  margin: Float32Array;
  /** The abutment frame's occlusal direction. */
  occlusal: V3;
}

export interface CommonAxisAbutmentResult {
  fdi: number;
  /** This abutment's own least-undercut axis (cone around its occlusal). */
  individualAxis: V3;
  /** Angle from its own axis to the common one. */
  angleToCommonDeg: number;
  /** Projected undercut area of this prep at the common axis (the blockout it needs), mm². */
  blockoutAreaMm2: number;
  /** Margin points in an undercut at the common axis; must be 0 for the bridge to seat. */
  marginUndercutCount: number;
  /** Per margin point: 1 = in an undercut. */
  marginFlags: Uint8Array;
}

export interface CommonAxisResult extends AxisSearchResult {
  /** Cone centre: the mean of the abutment occlusal directions. */
  center: V3;
  abutments: CommonAxisAbutmentResult[];
  /** Largest angle between two abutments' individual axes. */
  divergenceDeg: number;
  /** Σ marginUndercutCount over the abutments. */
  marginUndercutTotal: number;
  warnings: string[];
}

const angleBetweenDeg = (a: V3, b: V3) => Math.acos(Math.min(1, Math.max(-1, dot(normalize(a), normalize(b))))) / DEG;

/**
 * One insertion axis for every abutment of a bridge: the least-undercut
 * search over the union of the abutments' prep regions, in a cone around the
 * mean of their occlusal directions. Per abutment it reports the blockout
 * area and the margin undercut at that axis (the bridge seats only if no
 * margin point is in an undercut), and how far its own best axis lies from
 * the others' (a divergence above AXIS_DIVERGENCE_WARN_DEG is a warning).
 */
export function searchCommonAxis(input: {
  positions: Float32Array;
  indices: Uint32Array;
  ray: RayCaster;
  abutments: CommonAxisAbutment[];
  coneDeg?: number;
  samples?: number;
}): CommonAxisResult {
  const { positions, indices, ray, abutments } = input;
  if (abutments.length === 0) throw new Error('A common axis needs at least one abutment');
  const union = new Uint8Array(indices.length / 3);
  const mean: V3 = [0, 0, 0];
  for (const a of abutments) {
    for (let f = 0; f < union.length; f++) if (a.faceMask[f]) union[f] = 1;
    const o = normalize(a.occlusal);
    mean[0] += o[0];
    mean[1] += o[1];
    mean[2] += o[2];
  }
  const center = normalize(mean);
  const cone = { coneDeg: input.coneDeg, samples: input.samples };
  const common = searchVisibleAxis({ positions, indices, faceMask: union, center, ray, margins: abutments.map((a) => ({ points: a.margin, faceMask: a.faceMask })), ...cone });
  const results = abutments.map((a): CommonAxisAbutmentResult => {
    const own = abutments.length === 1 ? common : searchInsertionAxis({ positions, indices, faceMask: a.faceMask, center: a.occlusal, ...cone });
    // A zero cone evaluates the undercut cost at exactly the common direction.
    const at = searchInsertionAxis({ positions, indices, faceMask: a.faceMask, center: common.direction, coneDeg: 0, samples: 1 });
    const { flags, count } = marginUndercut({ points: a.margin, axis: common.direction, ray, faceMask: a.faceMask });
    return {
      fdi: a.fdi,
      individualAxis: own.direction,
      angleToCommonDeg: angleBetweenDeg(own.direction, common.direction),
      blockoutAreaMm2: at.centerUndercutAreaMm2,
      marginUndercutCount: count,
      marginFlags: flags,
    };
  });
  let divergenceDeg = 0;
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      divergenceDeg = Math.max(divergenceDeg, angleBetweenDeg(results[i]!.individualAxis, results[j]!.individualAxis));
    }
  }
  const warnings: string[] = [];
  if (divergenceDeg > AXIS_DIVERGENCE_WARN_DEG) {
    warnings.push(`The abutments diverge by ${divergenceDeg.toFixed(1)}° (over ${AXIS_DIVERGENCE_WARN_DEG}°): the common axis needs large blockouts; check each abutment.`);
  }
  for (const r of results) {
    if (r.marginUndercutCount > 0) warnings.push(`Abutment ${r.fdi}: ${r.marginUndercutCount} margin points are in an undercut for the common axis; the bridge cannot seat.`);
  }
  const marginUndercutTotal = results.reduce((s, r) => s + r.marginUndercutCount, 0);
  return { ...common, center, abutments: results, divergenceDeg, marginUndercutTotal, warnings };
}
