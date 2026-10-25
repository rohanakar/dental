import type { ImplantLibraryEntry, ImplantPose } from './implantLibrary';
import type { IndexedMesh } from './mesh';
import { computeVertexNormals } from './normals';
import { symmetricEigen3, type V3 } from './pca';
import { bvhRayCaster, createBvh, type RayCaster } from './raycast';
import { buildVertexAdjacency, smoothVertexNormals } from './surface';

/**
 * Scan-body registration: find the implant pose by matching the library scan
 * body to the scanned one, from one click on its top.
 *
 * 1. Initial axis: the top face around the click (scan points whose normals
 *    agree with the click's, within the top's radius of the current centre),
 *    plane-fitted by PCA and re-centred on each fit (a mean shift, so an
 *    off-centre click does not reach a neighbour's cusps); the normal of the
 *    top is the cylinder's long axis.
 * 2. Initial position: the top's centre minus the scan body height along the
 *    axis (the platform).
 * 3. Coarse rotation: 12 angles about the axis, scored by the truncated
 *    distance of the scan points to the posed scan body; the best three are
 *    refined (step 4) and the lowest truncated cost wins, unless the first
 *    is clearly good.
 * 4. Point-to-plane ICP of the library scan body onto the scan surface
 *    within 6 mm of the top, sampled uniformly by area (20 points/mm², so the
 *    result does not depend on the scan's tessellation), restricted to the
 *    scan body's scan region (its top `scanRegionHeightMm`, out to its radius
 *    + 0.5 mm). Pairs farther than 0.3 mm (annealed from 1 mm over the first
 *    iterations) or whose normals differ by more than 60° are rejected.
 *
 * Fit quality (over the samples): RMS and max of the inlier distances, the
 * inlier fraction of the scan region (surfaces facing the scan body across a
 * gap, i.e. neighbours, are not counted), and the coverage (the share of the
 * library scan region's area with scan surface within 0.3 mm).
 * Gate: RMS ≤ 0.05 mm, inliers ≥ 0.9, coverage ≥ 0.6.
 */

export const SCAN_BODY_GATE = { maxRmsMm: 0.05, minInlierFraction: 0.9, minCoverage: 0.6 } as const;

export interface ScanBodyRegistrationInput {
  /** The jaw scan (mm). */
  positions: Float32Array;
  indices: Uint32Array;
  /** The picked point on the scan body's top (a surface point). */
  click: V3;
  entry: Pick<ImplantLibraryEntry, 'scanBody' | 'scanBodyTopZ' | 'scanBodyRadiusMm' | 'scanRegionHeightMm'>;
  /** Scan points within this distance of the top centre take part (default 6 mm). */
  neighbourhoodMm?: number;
  /** Pairs farther apart are outliers (default 0.3 mm). */
  outlierMm?: number;
  /** Coarse rotation steps over 360° (default 12). */
  rotationSteps?: number;
  /** ICP iteration cap (default 60). */
  maxIterations?: number;
  /** Scan surface samples per mm² (default 20). */
  samplesPerMm2?: number;
}

export interface ScanBodyRegistration {
  pose: ImplantPose;
  /** RMS of the inlier point-to-surface distances (over the area-uniform samples). */
  rmsMm: number;
  /** Largest inlier distance. */
  maxMm: number;
  /** Share of the scan region's surface (samples) that are inliers. */
  inlierFraction: number;
  /** Share of the library scan region's area with scan surface within the outlier distance. */
  coverage: number;
  /** Samples in the scan region (candidates) and inliers among them. */
  candidates: number;
  inliers: number;
  iterations: number;
  /** RMS ≤ 0.05 mm, inliers ≥ 0.9 and coverage ≥ 0.6 (SCAN_BODY_GATE). */
  passed: boolean;
  /** Why the gate failed (empty when it passed). */
  failures: string[];
  initial: { axis: V3; topCentre: V3; rotationDeg: number };
  timingsMs: Record<string, number>;
}

interface ScanBodyModel {
  ray: RayCaster;
  /** Unit face normals in the BVH face order of `ray`. */
  faceNormals: Float32Array;
  /** Radius of the flat top. */
  topRadius: number;
  /** Library scan-region faces: centroid xyz and area, for the coverage. */
  regionCentroids: Float32Array;
  regionAreas: Float32Array;
}

const models = new WeakMap<IndexedMesh, Map<number, ScanBodyModel>>();

function modelOf(entry: ScanBodyRegistrationInput['entry']): ScanBodyModel {
  let byRegion = models.get(entry.scanBody);
  if (!byRegion) models.set(entry.scanBody, (byRegion = new Map()));
  const cached = byRegion.get(entry.scanRegionHeightMm);
  if (cached) return cached;
  const positions = entry.scanBody.positions;
  const indices = entry.scanBody.indices.slice();
  const ray = bvhRayCaster(createBvh({ positions, indices }));
  const nf = indices.length / 3;
  const faceNormals = new Float32Array(nf * 3);
  const centroids: number[] = [];
  const areas: number[] = [];
  const minZ = entry.scanBodyTopZ - entry.scanRegionHeightMm;
  for (let f = 0; f < nf; f++) {
    const a = indices[f * 3]! * 3, b = indices[f * 3 + 1]! * 3, c = indices[f * 3 + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) faceNormals.set([nx / len, ny / len, nz / len], f * 3);
    const cz = (positions[a + 2]! + positions[b + 2]! + positions[c + 2]!) / 3;
    if (cz >= minZ) {
      centroids.push((positions[a]! + positions[b]! + positions[c]!) / 3, (positions[a + 1]! + positions[b + 1]! + positions[c + 1]!) / 3, cz);
      areas.push(len / 2);
    }
  }
  let topRadius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2]! >= entry.scanBodyTopZ - 1e-3) topRadius = Math.max(topRadius, Math.hypot(positions[i]!, positions[i + 1]!));
  }
  const model = { ray, faceNormals, topRadius, regionCentroids: Float32Array.from(centroids), regionAreas: Float32Array.from(areas) };
  byRegion.set(entry.scanRegionHeightMm, model);
  return model;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Rotation as its columns (the library x, y, z axes in the scan). */
interface Frame {
  x: V3;
  y: V3;
  z: V3;
  t: V3;
}

const toModel = (F: Frame, p: V3): V3 => {
  const d: V3 = [p[0] - F.t[0], p[1] - F.t[1], p[2] - F.t[2]];
  return [dot(d, F.x), dot(d, F.y), dot(d, F.z)];
};
const toWorld = (F: Frame, q: V3): V3 => [
  F.t[0] + q[0] * F.x[0] + q[1] * F.y[0] + q[2] * F.z[0],
  F.t[1] + q[0] * F.x[1] + q[1] * F.y[1] + q[2] * F.z[1],
  F.t[2] + q[0] * F.x[2] + q[1] * F.y[2] + q[2] * F.z[2],
];

/** Rodrigues rotation matrix (rows) of the rotation vector w. */
function rotation(w: V3): [V3, V3, V3] {
  const angle = Math.hypot(w[0], w[1], w[2]);
  if (angle < 1e-15) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [kx, ky, kz] = [w[0] / angle, w[1] / angle, w[2] / angle];
  const c = Math.cos(angle), s = Math.sin(angle), C = 1 - c;
  return [
    [c + kx * kx * C, kx * ky * C - kz * s, kx * kz * C + ky * s],
    [ky * kx * C + kz * s, c + ky * ky * C, ky * kz * C - kx * s],
    [kz * kx * C - ky * s, kz * ky * C + kx * s, c + kz * kz * C],
  ];
}

/** Solve the 6×6 system A x = b (Gaussian elimination, partial pivoting); A is row-major. */
function solve6(A: Float64Array, b: Float64Array): Float64Array | null {
  const n = 6;
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j]!;
    M[i * (n + 1) + n] = b[i]!;
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r * (n + 1) + col]!) > Math.abs(M[piv * (n + 1) + col]!)) piv = r;
    if (Math.abs(M[piv * (n + 1) + col]!) < 1e-14) return null;
    if (piv !== col) {
      for (let j = 0; j <= n; j++) {
        const tmp = M[col * (n + 1) + j]!;
        M[col * (n + 1) + j] = M[piv * (n + 1) + j]!;
        M[piv * (n + 1) + j] = tmp;
      }
    }
    for (let r = col + 1; r < n; r++) {
      const f = M[r * (n + 1) + col]! / M[col * (n + 1) + col]!;
      for (let j = col; j <= n; j++) M[r * (n + 1) + j] = M[r * (n + 1) + j]! - f * M[col * (n + 1) + j]!;
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i * (n + 1) + n]!;
    for (let j = i + 1; j < n; j++) s -= M[i * (n + 1) + j]! * x[j]!;
    x[i] = s / M[i * (n + 1) + i]!;
  }
  return x;
}

/** Weighted plane fit: centroid and the least-variance direction. */
function planeFit(points: V3[], weights: number[]): { centroid: V3; normal: V3 } {
  let W = 0;
  const c: V3 = [0, 0, 0];
  points.forEach((p, i) => {
    const w = weights[i]!;
    W += w;
    c[0] += w * p[0];
    c[1] += w * p[1];
    c[2] += w * p[2];
  });
  c[0] /= W;
  c[1] /= W;
  c[2] /= W;
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  points.forEach((p, i) => {
    const w = weights[i]!;
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) m[r]![k] = m[r]![k]! + w * d[r]! * d[k]!;
  });
  const { values, vectors } = symmetricEigen3(m);
  let k = 0;
  if (values[1]! < values[k]!) k = 1;
  if (values[2]! < values[k]!) k = 2;
  return { centroid: c, normal: normalize([vectors[0]![k]!, vectors[1]![k]!, vectors[2]![k]!]) };
}

/** Register the library scan body to the scan from a click on its top; see the module comment. */
export function registerScanBody(input: ScanBodyRegistrationInput): ScanBodyRegistration {
  const timings: Record<string, number> = {};
  let t0 = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = now - t0;
    t0 = now;
  };
  const { positions: P, indices: I, click, entry } = input;
  const outlier = input.outlierMm ?? 0.3;
  const neighbourhood = input.neighbourhoodMm ?? 6;
  const steps = input.rotationSteps ?? 12;
  const maxIterations = input.maxIterations ?? 60;
  const model = modelOf(entry);
  const R = entry.scanBodyRadiusMm;
  const topZ = entry.scanBodyTopZ;
  const regionMinZ = topZ - entry.scanRegionHeightMm;
  const PAD = 0.5;
  const density = input.samplesPerMm2 ?? 20;

  // Gather the faces near the click (and their vertices), with smoothed vertex normals.
  const gatherR = neighbourhood + model.topRadius + 0.5;
  const nv = P.length / 3;
  const local = new Int32Array(nv).fill(-1);
  const verts: number[] = [];
  const near = (v: number) => {
    const dx = P[v * 3]! - click[0], dy = P[v * 3 + 1]! - click[1], dz = P[v * 3 + 2]! - click[2];
    return dx * dx + dy * dy + dz * dz <= gatherR * gatherR;
  };
  const localOf = (v: number) => {
    if (local[v]! < 0) {
      local[v] = verts.length;
      verts.push(v);
    }
    return local[v]!;
  };
  const subFaces: number[] = [];
  for (let f = 0; f < I.length; f += 3) {
    const a = I[f]!, b = I[f + 1]!, c = I[f + 2]!;
    if (near(a) || near(b) || near(c)) subFaces.push(localOf(a), localOf(b), localOf(c));
  }
  const subPositions = new Float32Array(verts.length * 3);
  verts.forEach((id, k) => subPositions.set(P.subarray(id * 3, id * 3 + 3), k * 3));
  // Smoothed like the crown pipeline's normals: raw normals of a noisy, finely tessellated scan scatter by tens of
  // degrees and would fail the normal-compatibility test below.
  const subIndices = Uint32Array.from(subFaces);
  const subNormals = smoothVertexNormals(
    computeVertexNormals({ positions: subPositions, indices: subIndices }),
    buildVertexAdjacency(subIndices, verts.length),
    3,
  );

  // Sample the gathered surface uniformly by area (R2 low-discrepancy points per triangle), so the data do not
  // depend on the scan's tessellation (decimated scans have long triangles on flat and ruled surfaces).
  const sp: number[] = [];
  const sn: number[] = [];
  let carry = 0, counter = 0;
  const S = subPositions, Nn = subNormals;
  for (let f = 0; f < subFaces.length; f += 3) {
    const a = subFaces[f]! * 3, b = subFaces[f + 1]! * 3, c = subFaces[f + 2]! * 3;
    const ux = S[b]! - S[a]!, uy = S[b + 1]! - S[a + 1]!, uz = S[b + 2]! - S[a + 2]!;
    const vx = S[c]! - S[a]!, vy = S[c + 1]! - S[a + 1]!, vz = S[c + 2]! - S[a + 2]!;
    const expected = (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2) * density + carry;
    const k = Math.floor(expected);
    carry = expected - k;
    for (let i = 0; i < k; i++, counter++) {
      let s1 = (0.5 + counter * 0.7548776662466927) % 1;
      let s2 = (0.5 + counter * 0.5698402909980532) % 1;
      if (s1 + s2 > 1) [s1, s2] = [1 - s1, 1 - s2];
      const s0 = 1 - s1 - s2;
      for (let d = 0; d < 3; d++) {
        sp.push(s0 * S[a + d]! + s1 * S[b + d]! + s2 * S[c + d]!);
        sn.push(s0 * Nn[a + d]! + s1 * Nn[b + d]! + s2 * Nn[c + d]!);
      }
    }
  }
  const count = sp.length / 3;
  const area = new Float64Array(count).fill(1 / density);
  const point = (k: number): V3 => [sp[k * 3]!, sp[k * 3 + 1]!, sp[k * 3 + 2]!];
  const normal = (k: number): V3 => normalize([sn[k * 3]!, sn[k * 3 + 1]!, sn[k * 3 + 2]!]);
  lap('gather');

  // 1–2. The top face around the click → axis and top centre. The selection is re-centred on each fit (a
  // mean shift with the top's radius), so an off-centre click does not reach over to a neighbour's cusps.
  let seed: V3 = [0, 0, 0];
  let nearest = -1, nearestD = Infinity;
  for (let k = 0; k < count; k++) {
    const p = point(k);
    const d = Math.hypot(p[0] - click[0], p[1] - click[1], p[2] - click[2]);
    if (d < nearestD) [nearest, nearestD] = [k, d];
    if (d <= 0.5) {
      const n = normal(k);
      seed = [seed[0] + area[k]! * n[0], seed[1] + area[k]! * n[1], seed[2] + area[k]! * n[2]];
    }
  }
  if (nearest < 0) return failed(input, 'No scan points near the click', timings);
  if (Math.hypot(...seed) === 0) seed = normal(nearest);
  let axis = normalize(seed);
  let topCentre: V3 = click;
  const capReach = model.topRadius + 0.2;
  const cos20 = Math.cos((20 * Math.PI) / 180), cos10 = Math.cos((10 * Math.PI) / 180);
  for (const [cosMin, planeTol] of [[cos20, 0.5], [cos10, 0.15], [cos10, 0.05], [cos10, 0.05], [cos10, 0.05], [cos10, 0.05]] as const) {
    const pts: V3[] = [];
    const ws: number[] = [];
    for (let k = 0; k < count; k++) {
      const p = point(k);
      const d: V3 = [p[0] - topCentre[0], p[1] - topCentre[1], p[2] - topCentre[2]];
      const h = dot(d, axis);
      if (Math.abs(h) > planeTol || Math.hypot(d[0] - h * axis[0], d[1] - h * axis[1], d[2] - h * axis[2]) > capReach) continue;
      if (dot(normal(k), axis) < cosMin) continue;
      pts.push(p);
      ws.push(area[k]!);
    }
    if (pts.length < 6) return failed(input, 'No flat top found at the click', timings);
    const fit = planeFit(pts, ws);
    axis = dot(fit.normal, axis) < 0 ? [-fit.normal[0], -fit.normal[1], -fit.normal[2]] : fit.normal;
    topCentre = fit.centroid;
  }
  const initialAxis = axis;
  const initialTop = topCentre;
  lap('initial');

  // The registration points: within the neighbourhood of the top.
  const data: number[] = [];
  for (let k = 0; k < count; k++) {
    const p = point(k);
    if (Math.hypot(p[0] - topCentre[0], p[1] - topCentre[1], p[2] - topCentre[2]) <= neighbourhood) data.push(k);
  }
  const inRegion = (q: V3) => q[2] >= regionMinZ && q[2] <= topZ + PAD && Math.hypot(q[0], q[1]) <= R + PAD;

  // A scan point pairs with the model only when its normal agrees with the model's (within 60°): a neighbouring
  // tooth facing the scan body across a narrow gap is near the model but faces it, and must not pull the fit.
  const modelNormal = (faceIndex: number): V3 => [model.faceNormals[faceIndex * 3]!, model.faceNormals[faceIndex * 3 + 1]!, model.faceNormals[faceIndex * 3 + 2]!];
  const facing = (Fr: Frame, k: number, faceIndex: number) => {
    const n = normal(k);
    return dot([dot(n, Fr.x), dot(n, Fr.y), dot(n, Fr.z)], modelNormal(faceIndex));
  };
  const COMPATIBLE = 0.5;

  // 3. Coarse rotation about the axis (the scan region is rotation-invariant, so the candidates are fixed).
  const u = normalize(cross(Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], axis));
  const v = cross(axis, u);
  const origin: V3 = [topCentre[0] - topZ * axis[0], topCentre[1] - topZ * axis[1], topCentre[2] - topZ * axis[2]];
  const frameAt = (theta: number): Frame => {
    const x: V3 = [Math.cos(theta) * u[0] + Math.sin(theta) * v[0], Math.cos(theta) * u[1] + Math.sin(theta) * v[1], Math.cos(theta) * u[2] + Math.sin(theta) * v[2]];
    return { x, y: cross(axis, x), z: axis, t: origin };
  };
  const candidates0 = data.filter((k) => inRegion(toModel(frameAt(0), point(k))));
  const COARSE_MM = 0.5;
  const coarse: Array<{ step: number; score: number }> = [];
  for (let s = 0; s < steps; s++) {
    const F = frameAt((2 * Math.PI * s) / steps);
    let score = 0;
    for (const k of candidates0) {
      const hit = model.ray.closestPoint(toModel(F, point(k)), COARSE_MM);
      const d = hit && facing(F, k, hit.faceIndex) >= COMPATIBLE ? hit.distance : COARSE_MM;
      score += area[k]! * d * d;
    }
    coarse.push({ step: s, score });
  }
  coarse.sort((a, b) => a.score - b.score);
  lap('coarse');

  // 4. Point-to-plane ICP (the model moves; residuals in the model frame).
  const A = new Float64Array(36);
  const b = new Float64Array(6);
  const icp = (start: Frame): { F: Frame; iterations: number } => {
    let F = start;
    let iterations = 0;
    for (let it = 0; it < maxIterations; it++) {
      iterations = it + 1;
      const tau = it < 4 ? 1 : it < 8 ? 0.6 : outlier;
      A.fill(0);
      b.fill(0);
      let pairs = 0;
      for (const k of data) {
        const q = toModel(F, point(k));
        if (!inRegion(q)) continue;
        const hit = model.ray.closestPoint(q, tau);
        if (!hit || facing(F, k, hit.faceIndex) < COMPATIBLE) continue;
        const c = hit.point;
        const n = modelNormal(hit.faceIndex);
        const r = (q[0] - c[0]) * n[0] + (q[1] - c[1]) * n[1] + (q[2] - c[2]) * n[2];
        const cn = cross(c, n);
        const J = [cn[0], cn[1], cn[2], n[0], n[1], n[2]];
        const w = area[k]!;
        for (let i = 0; i < 6; i++) {
          b[i] = b[i]! + w * J[i]! * r;
          for (let j = 0; j < 6; j++) A[i * 6 + j] = A[i * 6 + j]! + w * J[i]! * J[j]!;
        }
        pairs++;
      }
      if (pairs < 6) break;
      // A touch of damping keeps the weakly constrained spin about the axis stable.
      for (let i = 0; i < 6; i++) A[i * 7] = A[i * 7]! * (1 + 1e-9) + 1e-12;
      const x = solve6(A, b);
      if (!x) break;
      const w: V3 = [x[0]!, x[1]!, x[2]!];
      const tv: V3 = [x[3]!, x[4]!, x[5]!];
      // Model points m → Rot(w)·m + tv in the model frame: R ← R·Rot(w), t ← t + R·tv.
      const Rw = rotation(w);
      const col = (i: 0 | 1 | 2): V3 => [Rw[0]![i]!, Rw[1]![i]!, Rw[2]![i]!];
      const Fc = F;
      const apply = (m: V3): V3 => [
        m[0] * Fc.x[0] + m[1] * Fc.y[0] + m[2] * Fc.z[0],
        m[0] * Fc.x[1] + m[1] * Fc.y[1] + m[2] * Fc.z[1],
        m[0] * Fc.x[2] + m[1] * Fc.y[2] + m[2] * Fc.z[2],
      ];
      const t = toWorld(F, tv);
      const z = normalize(apply(col(2)));
      let xAxis = apply(col(0));
      xAxis = normalize([xAxis[0] - dot(xAxis, z) * z[0], xAxis[1] - dot(xAxis, z) * z[1], xAxis[2] - dot(xAxis, z) * z[2]]);
      F = { x: xAxis, y: cross(z, xAxis), z, t };
      // Converged: steps far below the registration accuracy (1e-5 rad ≈ 0.0006°, 0.1 µm).
      if (tau === outlier && Math.hypot(...w) < 1e-5 && Math.hypot(...tv) < 1e-4) break;
    }
    return { F, iterations };
  };

  // Fit quality at the outlier distance.
  const quality = (F: Frame) => {
    let wCand = 0, wIn = 0, sum2 = 0, max = 0, candidates = 0, inliers = 0;
    for (const k of data) {
      const q = toModel(F, point(k));
      if (!inRegion(q)) continue;
      // Surfaces facing the scan body across a gap (a neighbour) are not part of it: not candidates.
      const near = model.ray.closestPoint(q, PAD);
      if (near && facing(F, k, near.faceIndex) < -COMPATIBLE) continue;
      candidates++;
      wCand += area[k]!;
      // Inliers need only to face the same way: the 60° pairing rule would count normal scatter on noisy scans.
      const hit = near && near.distance <= outlier && facing(F, k, near.faceIndex) >= 0 ? near : null;
      if (!hit) continue;
      inliers++;
      wIn += area[k]!;
      sum2 += area[k]! * hit.distance * hit.distance;
      max = Math.max(max, hit.distance);
    }
    return {
      rmsMm: wIn > 0 ? Math.sqrt(sum2 / wIn) : Infinity,
      maxMm: max,
      inlierFraction: wCand > 0 ? wIn / wCand : 0,
      candidates,
      inliers,
      /** Truncated least squares over the candidates (outliers count as the outlier distance). */
      cost: wCand > 0 ? (sum2 + (wCand - wIn) * outlier * outlier) / wCand : Infinity,
    };
  };

  // Refine the best coarse angles (up to 3); a clearly good first fit is taken as is.
  let best: { F: Frame; iterations: number; step: number; q: ReturnType<typeof quality> } | null = null;
  for (const { step } of coarse.slice(0, Math.min(3, steps))) {
    const run = icp(frameAt((2 * Math.PI * step) / steps));
    const q = quality(run.F);
    if (!best || q.cost < best.q.cost) best = { ...run, step, q };
    if (q.rmsMm <= SCAN_BODY_GATE.maxRmsMm / 2 && q.inlierFraction >= 0.98) break;
  }
  const { F, q: fit } = best!;
  lap('icp');

  let coverage = 0;
  if (subFaces.length > 0) {
    const scanRay = bvhRayCaster(createBvh({ positions: subPositions, indices: subIndices.slice() }));
    let covered = 0, total = 0;
    for (let i = 0; i < model.regionAreas.length; i++) {
      const c: V3 = [model.regionCentroids[i * 3]!, model.regionCentroids[i * 3 + 1]!, model.regionCentroids[i * 3 + 2]!];
      total += model.regionAreas[i]!;
      if (scanRay.closestPoint(toWorld(F, c), outlier)) covered += model.regionAreas[i]!;
    }
    coverage = total > 0 ? covered / total : 0;
  }
  lap('quality');

  const failures: string[] = [];
  if (!(fit.rmsMm <= SCAN_BODY_GATE.maxRmsMm)) failures.push(`fit RMS ${fit.rmsMm.toFixed(3)} mm > ${SCAN_BODY_GATE.maxRmsMm} mm`);
  if (!(fit.inlierFraction >= SCAN_BODY_GATE.minInlierFraction)) failures.push(`inliers ${(fit.inlierFraction * 100).toFixed(0)}% < ${SCAN_BODY_GATE.minInlierFraction * 100}%`);
  if (!(coverage >= SCAN_BODY_GATE.minCoverage)) failures.push(`coverage ${(coverage * 100).toFixed(0)}% < ${SCAN_BODY_GATE.minCoverage * 100}%`);
  return {
    pose: { origin: F.t, axis: F.z, xAxis: F.x },
    rmsMm: fit.rmsMm,
    maxMm: fit.maxMm,
    inlierFraction: fit.inlierFraction,
    coverage,
    candidates: fit.candidates,
    inliers: fit.inliers,
    iterations: best!.iterations,
    passed: failures.length === 0,
    failures,
    initial: { axis: initialAxis, topCentre: initialTop, rotationDeg: (360 * best!.step) / steps },
    timingsMs: timings,
  };
}

function failed(input: ScanBodyRegistrationInput, reason: string, timings: Record<string, number>): ScanBodyRegistration {
  return {
    pose: { origin: input.click, axis: [0, 0, 1], xAxis: [1, 0, 0] },
    rmsMm: Infinity,
    maxMm: Infinity,
    inlierFraction: 0,
    coverage: 0,
    candidates: 0,
    inliers: 0,
    iterations: 0,
    passed: false,
    failures: [reason],
    initial: { axis: [0, 0, 1], topCentre: input.click, rotationDeg: 0 },
    timingsMs: timings,
  };
}
