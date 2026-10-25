import type { Pose } from '@dcad/shared';
import { Matrix4, Quaternion } from 'three';
import { crownAxes, type CrownFrame } from './crown';
import { closeCervix, type CrownTemplate } from './crownTemplate';
import type { IndexedMesh } from './mesh';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh, type RayCaster } from './raycast';
import { evaluateRbfFields, solveRbfFields } from './rbf';

/**
 * A library tooth fitted to the natural surface around a partial
 * restoration (the collar around an inlay or onlay cavity), for the
 * restoration's outer surface when there is no pre-op scan:
 *
 * 1. Pose and scale: the template placed in the tooth frame, then a
 *    least-squares fit of position, rotation and per-axis scale to the collar
 *    points (ICP: closest points on the posed template, point-to-plane plus a
 *    little point-to-point, Levenberg–Marquardt steps). Correspondences
 *    farther than 2.5× the median, on the template's cervical rim, or facing
 *    the other way (gingiva, a neighbouring tooth) are dropped.
 * 2. RBF pin: sampled collar points (one per 0.6 mm cell) pull their
 *    template points onto the scan exactly; template vertices more than 2 mm
 *    from every pin stay where the pose put them (zero anchors), so the
 *    anatomy away from the collar (the cusps over an onlay) keeps the
 *    template's shape.
 * 3. The fitted shell is closed with closeCervix.
 *
 * With a stored pose the least-squares step is skipped (the user or agent
 * moved the tooth); the pin still lands the collar on the scan.
 */

export interface AnatomyFitInput {
  template: CrownTemplate;
  frame: CrownFrame;
  /**
   * Collar points on the natural tooth (xyz) and their unit normals (smoothed scan normals, pointing out of the
   * tooth). Earlier points win when sampling: put the margin first.
   */
  points: Float32Array;
  normals: Float32Array;
  /** The margin (xyz per point): its centroid seeds the lateral position, its mesio-distal extent the scale. */
  margin: Float32Array;
  /** Stored pose: skip the least-squares fit. */
  pose?: Pose;
  maxIterations?: number;
}

export interface AnatomyResidual {
  /** Collar points measured (inliers of the final correspondence test). */
  samples: number;
  /** Fraction of the collar points that are inliers (the rest are gingiva, neighbours, outliers). */
  inlierFraction: number;
  meanMm: number;
  rmsMm: number;
  p95Mm: number;
  maxMm: number;
}

export interface AnatomyFit {
  /** The least-squares pose (or the stored one): template-local → world, mirror in scale.x. */
  pose: Pose;
  /** Fitted shell, template topology, world mm. */
  shell: Float32Array;
  /** The pose mirrors the template (quadrants 2 and 4). */
  mirrored: boolean;
  /** The fitted shell closed at the cervix: a closed, outward-oriented solid. */
  solid: IndexedMesh;
  /** Distance from the collar inliers to the fitted surface (after the pin). */
  residual: AnatomyResidual;
  /** RMS point-to-surface distance of the inliers after the pose fit, before the pin. */
  poseRmsMm: number;
  iterations: number;
  pins: number;
  anchors: number;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const pointAt = (a: ArrayLike<number>, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];

/** Collar points sampled for the least-squares fit: one per cell of this size. */
const FIT_CELL_MM = 0.4;
/** Pins of the RBF: one per cell of this size. */
const PIN_CELL_MM = 0.6;
/** Pins closer than this to an accepted pin (on the template) are skipped (near-duplicate RBF centres). */
const PIN_MIN_SPACING_MM = 0.15;
/** Template vertices this far from every pin are zero-displacement anchors. */
const ANCHOR_DISTANCE_MM = 2;
const MAX_ANCHORS = 80;
/** Residual sample: one collar point per cell of this size. */
const RESIDUAL_CELL_MM = 0.2;
/** Correspondences on the template's cervical rim (height fraction below this) are gingiva or root, not crown. */
const MIN_HEIGHT_FRACTION = 0.05;
/** Scan and template normals must agree this much (rejects neighbouring teeth facing the other way). */
const MIN_NORMAL_AGREEMENT = 0.3;
const POINT_TO_POINT_WEIGHT = 0.1;

/** One point per occupied grid cell (the first seen, in `order` when given), as indices into the packed points. */
function gridSample(points: Float32Array, cellMm: number, order?: number[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (const i of order ?? Array.from({ length: points.length / 3 }, (_, k) => k)) {
    const key = `${Math.floor(points[i * 3]! / cellMm)},${Math.floor(points[i * 3 + 1]! / cellMm)},${Math.floor(points[i * 3 + 2]! / cellMm)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

/** Rotation matrix (columns) of a template pose: rotation R and signed scales S, world = R·(S∘a) + t. */
interface PoseState {
  /** Row-major 3×3 rotation. */
  r: Float64Array;
  s: V3;
  t: V3;
}

const apply = (p: PoseState, a: V3): V3 => {
  const x = p.s[0] * a[0], y = p.s[1] * a[1], z = p.s[2] * a[2];
  const r = p.r;
  return [r[0]! * x + r[1]! * y + r[2]! * z + p.t[0], r[3]! * x + r[4]! * y + r[5]! * z + p.t[1], r[6]! * x + r[7]! * y + r[8]! * z + p.t[2]];
};

function poseOf(p: PoseState): Pose {
  const r = p.r;
  const m = new Matrix4().set(r[0]!, r[1]!, r[2]!, 0, r[3]!, r[4]!, r[5]!, 0, r[6]!, r[7]!, r[8]!, 0, 0, 0, 0, 1);
  const q = new Quaternion().setFromRotationMatrix(m).normalize();
  return { position: [...p.t], quaternion: [q.x, q.y, q.z, q.w], scale: [...p.s] };
}

function stateOf(pose: Pose): PoseState {
  const m = new Matrix4().makeRotationFromQuaternion(new Quaternion(...pose.quaternion).normalize());
  const e = m.elements; // column-major
  return { r: Float64Array.from([e[0]!, e[4]!, e[8]!, e[1]!, e[5]!, e[9]!, e[2]!, e[6]!, e[10]!]), s: [...pose.scale], t: [...pose.position] };
}

/** Rodrigues rotation of angle |w| about w, as a row-major 3×3. */
function rotation(w: V3): Float64Array {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const [x, y, z] = [w[0] / th, w[1] / th, w[2] / th];
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return Float64Array.from([c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C]);
}

function matMul(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return out;
}

/** Re-orthonormalize a row-major rotation (Gram–Schmidt on the columns). */
function orthonormalize(r: Float64Array): Float64Array {
  const c0 = normalize([r[0]!, r[3]!, r[6]!]);
  let c1: V3 = [r[1]!, r[4]!, r[7]!];
  c1 = normalize(sub(c1, [c0[0] * dot(c0, c1), c0[1] * dot(c0, c1), c0[2] * dot(c0, c1)]));
  const c2 = cross(c0, c1);
  return Float64Array.from([c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]]);
}

/** Solve the n×n system a·x = b (row-major, Gaussian elimination with partial pivoting); null if singular. */
function solveDense(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const m = a.slice();
  const x = b.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r * n + col]!) > Math.abs(m[piv * n + col]!)) piv = r;
    if (Math.abs(m[piv * n + col]!) < 1e-14) return null;
    if (piv !== col) {
      for (let c = 0; c < n; c++) [m[col * n + c], m[piv * n + c]] = [m[piv * n + c]!, m[col * n + c]!];
      [x[col], x[piv]] = [x[piv]!, x[col]!];
    }
    for (let r = col + 1; r < n; r++) {
      const f = m[r * n + col]! / m[col * n + col]!;
      if (f === 0) continue;
      for (let c = col; c < n; c++) m[r * n + c] = m[r * n + c]! - f * m[col * n + c]!;
      x[r] = x[r]! - f * x[col]!;
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r]!;
    for (let c = r + 1; c < n; c++) s -= m[r * n + c]! * x[c]!;
    x[r] = s / m[r * n + r]!;
  }
  return x;
}

/** A surface with face lookups: BVH-ordered index copy plus its ray caster. */
interface Surface {
  positions: Float32Array;
  indices: Uint32Array;
  ray: RayCaster;
}

function surfaceOf(positions: Float32Array, indices: Uint32Array): Surface {
  const idx = indices.slice();
  return { positions, indices: idx, ray: bvhRayCaster(createBvh({ positions, indices: idx })) };
}

/** Barycentric coordinates of p (on or near) triangle abc. */
function barycentric(p: V3, a: V3, b: V3, c: V3): V3 {
  const v0 = sub(b, a), v1 = sub(c, a), v2 = sub(p, a);
  const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01 || 1e-30;
  const v = (d11 * d20 - d01 * d21) / den;
  const w = (d00 * d21 - d01 * d20) / den;
  return [1 - v - w, v, w];
}

interface Correspondence {
  /** Index of the collar point. */
  k: number;
  /** Template-local point and world point on the posed template. */
  local: V3;
  world: V3;
  distance: number;
  heightFraction: number;
  /** Outward unit normal of the posed template face. */
  normal: V3;
}

/** Closest points on the posed template for the given collar points. */
function correspond(template: CrownTemplate, posed: Float32Array, mirrored: boolean, points: Float32Array, ids: number[], maxMm: number): Correspondence[] {
  const surface = surfaceOf(posed, template.mesh.indices);
  const L = template.mesh.positions;
  const out: Correspondence[] = [];
  for (const k of ids) {
    const p = pointAt(points, k);
    const cp = surface.ray.closestPoint(p, maxMm);
    if (!cp || cp.faceIndex < 0) continue;
    const f = cp.faceIndex * 3;
    const ia = surface.indices[f]!, ib = surface.indices[f + 1]!, ic = surface.indices[f + 2]!;
    const a = pointAt(posed, ia), b = pointAt(posed, ib), c = pointAt(posed, ic);
    const [u, v, w] = barycentric(cp.point, a, b, c);
    const la = pointAt(L, ia), lb = pointAt(L, ib), lc = pointAt(L, ic);
    const local: V3 = [u * la[0] + v * lb[0] + w * lc[0], u * la[1] + v * lb[1] + w * lc[1], u * la[2] + v * lb[2] + w * lc[2]];
    const hf = u * template.heightFraction[ia]! + v * template.heightFraction[ib]! + w * template.heightFraction[ic]!;
    let n = normalize(cross(sub(b, a), sub(c, a)));
    if (mirrored) n = [-n[0], -n[1], -n[2]];
    out.push({ k, local, world: cp.point, distance: cp.distance, heightFraction: hf, normal: n });
  }
  return out;
}

/** Keep correspondences on the crown, facing the same way, within 2.5× the median distance. */
function inliers(cs: Correspondence[], normals: Float32Array): Correspondence[] {
  const usable = cs.filter((c) => c.heightFraction >= MIN_HEIGHT_FRACTION && dot(c.normal, pointAt(normals, c.k)) >= MIN_NORMAL_AGREEMENT);
  if (usable.length === 0) return [];
  const d = usable.map((c) => c.distance).sort((a, b) => a - b);
  const median = d[Math.floor(d.length / 2)]!;
  const limit = Math.max(0.3, 2.5 * median);
  return usable.filter((c) => c.distance <= limit);
}

function posedShell(template: CrownTemplate, p: PoseState): Float32Array {
  const L = template.mesh.positions;
  const out = new Float32Array(L.length);
  for (let i = 0; i < L.length / 3; i++) out.set(apply(p, pointAt(L, i)), i * 3);
  return out;
}

/** Initial pose: template axes from the frame, scaled from the margin's mesio-distal extent, cusps at the collar's top. */
function initialPose(template: CrownTemplate, frame: CrownFrame, points: Float32Array, margin: Float32Array): PoseState {
  const axes = crownAxes(frame);
  const ex: V3 = [axes.x[0] * axes.epsilon, axes.x[1] * axes.epsilon, axes.x[2] * axes.epsilon];
  const r = Float64Array.from([ex[0], axes.y[0], axes.z[0], ex[1], axes.y[1], axes.z[1], ex[2], axes.y[2], axes.z[2]]);
  const nm = margin.length / 3;
  let c: V3 = [0, 0, 0];
  for (let i = 0; i < nm; i++) c = [c[0] + margin[i * 3]! / nm, c[1] + margin[i * 3 + 1]! / nm, c[2] + margin[i * 3 + 2]! / nm];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < nm; i++) {
    const x = dot(sub(pointAt(margin, i), c), axes.x);
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  let md = hi - lo;
  if (frame.mesialContact && frame.distalContact) md = Math.max(md, dot(sub(frame.mesialContact, frame.distalContact), axes.x));
  const k = Math.min(1.3, Math.max(0.6, md / template.size.md));
  let top = -Infinity;
  for (let i = 0; i < points.length / 3; i++) top = Math.max(top, dot(pointAt(points, i), axes.z));
  let templateTop = 0;
  for (let i = 0; i < template.mesh.positions.length / 3; i++) templateTop = Math.max(templateTop, template.mesh.positions[i * 3 + 2]!);
  // Lateral position at the margin centroid; along the occlusal axis, the template's top at the collar's top.
  const along = top - templateTop * k;
  const lateral = sub(c, [axes.z[0] * dot(c, axes.z), axes.z[1] * dot(c, axes.z), axes.z[2] * dot(c, axes.z)]);
  const t: V3 = [lateral[0] + axes.z[0] * along, lateral[1] + axes.z[1] * along, lateral[2] + axes.z[2] * along];
  return { r, s: [axes.epsilon * k, k, k], t };
}

/**
 * Least-squares pose and scale of the template on the collar: Levenberg–
 * Marquardt on (translation, rotation, log scale per axis), point-to-plane
 * with a small point-to-point term, correspondences re-found every step.
 */
function fitPose(input: AnatomyFitInput, start: PoseState, ids: number[], maxIterations: number): { pose: PoseState; iterations: number } {
  const { template, points, normals } = input;
  let p = start;
  let lambda = 1e-3;
  let iterations = 0;
  const mirrored = start.s[0] * start.s[1] * start.s[2] < 0;
  for (; iterations < maxIterations; iterations++) {
    const cs = inliers(correspond(template, posedShell(template, p), mirrored, points, ids, 3), normals);
    if (cs.length < 12) break;
    const JtJ = new Float64Array(81);
    const Jtr = new Float64Array(9);
    const add = (row: number[], r: number, w: number) => {
      for (let i = 0; i < 9; i++) {
        Jtr[i] = Jtr[i]! + w * row[i]! * r;
        for (let j = 0; j < 9; j++) JtJ[i * 9 + j] = JtJ[i * 9 + j]! + w * row[i]! * row[j]!;
      }
    };
    for (const c of cs) {
      const q = pointAt(points, c.k);
      const n = pointAt(normals, c.k);
      const world = apply(p, c.local);
      const y = sub(world, p.t);
      const res = sub(world, q);
      // d world / d(scale_j) = column j of R · s_j · a_j (log-scale parameters).
      const ds = [0, 1, 2].map((j): V3 => [p.r[j]! * p.s[j]! * c.local[j]!, p.r[3 + j]! * p.s[j]! * c.local[j]!, p.r[6 + j]! * p.s[j]! * c.local[j]!]);
      // d world / d(omega) = −[y]× (a small rotation about the pose position).
      const dw: V3[] = [
        [0, y[2], -y[1]],
        [-y[2], 0, y[0]],
        [y[1], -y[0], 0],
      ];
      const rowFor = (dir: V3) => [dir[0], dir[1], dir[2], dot(dir, [dw[0]![0], dw[1]![0], dw[2]![0]]), dot(dir, [dw[0]![1], dw[1]![1], dw[2]![1]]), dot(dir, [dw[0]![2], dw[1]![2], dw[2]![2]]), dot(dir, ds[0]!), dot(dir, ds[1]!), dot(dir, ds[2]!)];
      add(rowFor(n), dot(n, res), 1);
      for (const e of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as V3[]) add(rowFor(e), dot(e, res), POINT_TO_POINT_WEIGHT);
    }
    const A = JtJ.slice();
    for (let i = 0; i < 9; i++) A[i * 9 + i] = A[i * 9 + i]! * (1 + lambda) + 1e-9;
    const neg = Jtr.map((v) => -v);
    const d = solveDense(A, neg, 9);
    if (!d) break;
    const next: PoseState = {
      t: [p.t[0] + d[0]!, p.t[1] + d[1]!, p.t[2] + d[2]!],
      r: orthonormalize(matMul(rotation([d[3]!, d[4]!, d[5]!]), p.r)),
      s: [p.s[0] * Math.exp(d[6]!), p.s[1] * Math.exp(d[7]!), p.s[2] * Math.exp(d[8]!)],
    };
    p = next;
    const step = Math.hypot(d[0]!, d[1]!, d[2]!) + 10 * Math.hypot(d[3]!, d[4]!, d[5]!) + 10 * Math.hypot(d[6]!, d[7]!, d[8]!);
    if (step < 1e-4) {
      iterations++;
      break;
    }
  }
  return { pose: p, iterations };
}

/** Fit the library template to the collar; see the module comment. */
export function fitAnatomy(input: AnatomyFitInput): AnatomyFit {
  const { template, points, normals } = input;
  const fitIds = gridSample(points, FIT_CELL_MM);
  let state: PoseState;
  let iterations = 0;
  if (input.pose) state = stateOf(input.pose);
  else {
    const fit = fitPose(input, initialPose(template, input.frame, points, input.margin), fitIds, input.maxIterations ?? 40);
    state = fit.pose;
    iterations = fit.iterations;
  }
  const mirrored = state.s[0] * state.s[1] * state.s[2] < 0;
  const posed = posedShell(template, state);

  // Pose residual (before the pin), on the fit sample.
  const before = inliers(correspond(template, posed, mirrored, points, fitIds, 3), normals);
  const poseRmsMm = before.length ? Math.sqrt(before.reduce((s, c) => s + c.distance * c.distance, 0) / before.length) : Number.NaN;

  // RBF pin: inlier collar points, one per cell (the margin first, so it is pinned densely), pull their template
  // points onto the scan.
  const all = inliers(correspond(template, posed, mirrored, points, Array.from({ length: points.length / 3 }, (_, k) => k), 3), normals);
  const pinIds = new Set(gridSample(points, PIN_CELL_MM, all.map((c) => c.k)));
  const pins = all.filter((c) => pinIds.has(c.k));
  const centres: V3[] = [];
  const values: V3[] = [];
  for (const c of pins) {
    if (centres.some((q) => Math.hypot(q[0] - c.world[0], q[1] - c.world[1], q[2] - c.world[2]) < PIN_MIN_SPACING_MM)) continue;
    centres.push(c.world);
    values.push(sub(pointAt(points, c.k), c.world));
  }
  const pinCount = centres.length;
  const tv = posed.length / 3;
  const far: number[] = [];
  for (let v = 0; v < tv; v++) {
    const p = pointAt(posed, v);
    let near = Infinity;
    for (let i = 0; i < pinCount && near >= ANCHOR_DISTANCE_MM; i++) near = Math.min(near, Math.hypot(p[0] - centres[i]![0], p[1] - centres[i]![1], p[2] - centres[i]![2]));
    if (near >= ANCHOR_DISTANCE_MM) far.push(v);
  }
  const stride = Math.max(1, Math.ceil(far.length / MAX_ANCHORS));
  let anchors = 0;
  for (let i = 0; i < far.length; i += stride) {
    centres.push(pointAt(posed, far[i]!));
    values.push([0, 0, 0]);
    anchors++;
  }
  const shell = posed.slice();
  if (pinCount >= 4) {
    const cflat = new Float64Array(centres.length * 3);
    const vflat = new Float64Array(centres.length * 3);
    centres.forEach((c, i) => cflat.set(c, i * 3));
    values.forEach((v, i) => vflat.set(v, i * 3));
    const fields = solveRbfFields(cflat, [vflat], { kernel: 'cubic' });
    const out = new Float64Array(3);
    for (let v = 0; v < tv; v++) {
      evaluateRbfFields(fields, pointAt(posed, v), out);
      shell[v * 3] = shell[v * 3]! + out[0]!;
      shell[v * 3 + 1] = shell[v * 3 + 1]! + out[1]!;
      shell[v * 3 + 2] = shell[v * 3 + 2]! + out[2]!;
    }
  }

  // Residual after the pin, on a denser sample of the collar inliers.
  const residualIds = gridSample(points, RESIDUAL_CELL_MM);
  const after = inliers(correspond(template, shell, mirrored, points, residualIds, 3), normals);
  const d = after.map((c) => c.distance).sort((a, b) => a - b);
  const residual: AnatomyResidual = {
    samples: d.length,
    inlierFraction: residualIds.length ? d.length / residualIds.length : 0,
    meanMm: d.length ? d.reduce((s, x) => s + x, 0) / d.length : Number.NaN,
    rmsMm: d.length ? Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length) : Number.NaN,
    p95Mm: d.length ? d[Math.min(d.length - 1, Math.floor(0.95 * d.length))]! : Number.NaN,
    maxMm: d.length ? d[d.length - 1]! : Number.NaN,
  };

  const closed = closeCervix({ ...template, mesh: { positions: shell, indices: template.mesh.indices } });
  if (mirrored) {
    const idx = closed.indices;
    for (let f = 0; f < idx.length; f += 3) [idx[f + 1], idx[f + 2]] = [idx[f + 2]!, idx[f + 1]!];
  }
  return { pose: poseOf(state), shell, mirrored, solid: closed, residual, poseRmsMm, iterations, pins: pinCount, anchors };
}
