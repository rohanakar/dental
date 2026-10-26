import { implantBasis, implantToWorld, placeAtImplantPose, type ImplantLibraryEntry, type ImplantPose } from './implantLibrary';
import { buildIntaglio, type Intaglio } from './intaglio';
import type { IndexedMesh } from './mesh';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh } from './raycast';
import { distanceToLoop } from './thickness';

/**
 * The fitting surface of a restoration on a library Ti-base: the Ti-base at
 * the implant pose, offset outward by the bonding gap, is the "prep", and the
 * existing `buildIntaglio` (radial profiles under the insertion axis) builds
 * the intaglio on it with the shoulder loop as the rim. A Ti-base is
 * star-shaped around its axis, as a posterior prep is.
 *
 * The rim is the shoulder loop lifted by the gap along the implant axis, so
 * the cement film is uniform, on the shoulder too.
 */

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Angle-weighted vertex normals (each face adds its unit normal times its
 * corner angle): unlike area weighting, a crease between a large and a small
 * face gets the bisector, so an offset along them keeps both faces at the
 * offset distance (to within cos(half the crease angle)).
 */
export function angleWeightedNormals(mesh: Pick<IndexedMesh, 'positions' | 'indices'>): Float32Array {
  const p = mesh.positions;
  const idx = mesh.indices;
  const out = new Float64Array(p.length);
  const corner = (o: number, a: number, b: number) => {
    const ux = p[a]! - p[o]!, uy = p[a + 1]! - p[o + 1]!, uz = p[a + 2]! - p[o + 2]!;
    const vx = p[b]! - p[o]!, vy = p[b + 1]! - p[o + 1]!, vz = p[b + 2]! - p[o + 2]!;
    const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
    return lu > 0 && lv > 0 ? Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy + uz * vz) / (lu * lv)))) : 0;
  };
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f]! * 3, b = idx[f + 1]! * 3, c = idx[f + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const [o, x, y] of [
      [a, b, c],
      [b, c, a],
      [c, a, b],
    ] as const) {
      const w = corner(o, x, y);
      out[o] = out[o]! + w * nx;
      out[o + 1] = out[o + 1]! + w * ny;
      out[o + 2] = out[o + 2]! + w * nz;
    }
  }
  const normals = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const l = Math.hypot(out[i]!, out[i + 1]!, out[i + 2]!) || 1;
    normals[i] = out[i]! / l;
    normals[i + 1] = out[i + 1]! / l;
    normals[i + 2] = out[i + 2]! / l;
  }
  return normals;
}

/** Every vertex moved along its angle-weighted normal by `distanceMm` (outward for a closed, outward-oriented mesh). */
export function offsetMesh(mesh: IndexedMesh, distanceMm: number): IndexedMesh {
  const n = angleWeightedNormals(mesh);
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = mesh.positions[i]! + distanceMm * n[i]!;
  return { positions, indices: mesh.indices.slice() };
}

/**
 * The shoulder loop at the pose, lifted by `liftMm` along the implant axis:
 * CCW seen from +axis. With `samples`, resampled by arc length from point 0
 * (e.g. to pair it with a template's cervical ring).
 */
export function shoulderRim(entry: Pick<ImplantLibraryEntry, 'shoulderLoop'>, pose: ImplantPose, liftMm = 0, samples?: number): Float32Array {
  const toWorld = implantToWorld(pose);
  const loop = entry.shoulderLoop;
  const n = loop.length / 3;
  const pts: V3[] = [];
  for (let i = 0; i < n; i++) pts.push(toWorld([loop[i * 3]!, loop[i * 3 + 1]!, loop[i * 3 + 2]! + liftMm]));
  const count = samples ?? n;
  const out = new Float32Array(count * 3);
  if (count === n && samples === undefined) {
    pts.forEach((p, i) => out.set(p, i * 3));
    return out;
  }
  const cum = [0];
  for (let i = 1; i <= n; i++) {
    const a = pts[i - 1]!, b = pts[i % n]!;
    cum.push(cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = cum[n]!;
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / count;
    while (seg < n - 1 && cum[seg + 1]! <= target) seg++;
    const f = (target - cum[seg]!) / (cum[seg + 1]! - cum[seg]! || 1);
    const a = pts[seg]!, b = pts[(seg + 1) % n]!;
    out.set([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], k * 3);
  }
  return out;
}

export interface TiBaseGapCheck {
  gapMm: number;
  /** Ti-base surface samples (vertices and face centroids on the bonding surface, ≥ excludeMm from the rim) → intaglio. */
  tiBaseSamples: number;
  meanErrorMm: number;
  maxErrorMm: number;
  /** Smallest and largest Ti-base → intaglio distance. */
  minGapMm: number;
  maxGapMm: number;
  /** Intaglio vertices (≥ excludeMm from the rim) → Ti-base, signed (negative = inside the Ti-base). */
  intaglioSamples: number;
  intaglioMeanErrorMm: number;
  intaglioMaxErrorMm: number;
  intaglioMinGapMm: number;
}

/**
 * Bonding-gap check: the distance between the placed Ti-base and the
 * intaglio must equal the gap. Measured both ways: from the Ti-base's
 * bonding surface (above the shoulder, away from the rim) to the intaglio,
 * which catches the intaglio cutting corners between its vertices, and from
 * the intaglio's vertices to the Ti-base (signed by ray parity: inside the
 * closed Ti-base is negative), which catches penetration. With an insertion
 * axis other than the implant axis (a bridge's common path), Ti-base samples
 * hidden from that direction (undercut, or under an overhang) are blocked
 * out, not bonded, and are skipped.
 */
export function measureTiBaseGap(input: {
  /** The Ti-base at the pose (world). */
  tiBase: IndexedMesh;
  intaglio: IndexedMesh;
  rim: Float32Array;
  pose: ImplantPose;
  gapMm: number;
  /** Samples closer than this to the rim are skipped (default 0.3 mm). */
  excludeMm?: number;
  /** Also skip samples where this is true (e.g. around a screw channel). */
  exclude?: (p: V3) => boolean;
  /** Also measure from the intaglio's vertices to the Ti-base (default true; off for a whole restoration or a union). */
  intaglioSide?: boolean;
  /** The insertion axis the intaglio was built along; samples hidden from it are skipped (blockout). */
  insertionAxis?: V3;
}): TiBaseGapCheck {
  const { tiBase, intaglio, rim, gapMm } = input;
  const exclude = input.excludeMm ?? 0.3;
  const axis = implantBasis(input.pose).z;
  const o = input.pose.origin;
  const height = (p: V3) => dot([p[0] - o[0], p[1] - o[1], p[2] - o[2]], axis);
  let rimLow = Infinity;
  for (let i = 0; i < rim.length / 3; i++) rimLow = Math.min(rimLow, height([rim[i * 3]!, rim[i * 3 + 1]!, rim[i * 3 + 2]!]));
  // The rim is the shoulder lifted by the gap: the bonding surface starts at the shoulder.
  const shoulderLow = rimLow - gapMm - 1e-3;

  const intaglioRay = bvhRayCaster(createBvh({ positions: intaglio.positions, indices: intaglio.indices.slice() }));
  const T = tiBase.positions;
  const ti = tiBase.indices;
  const tiIndices = ti.slice();
  const tiRay = bvhRayCaster(createBvh({ positions: T, indices: tiIndices }));
  const path = input.insertionAxis ? normalize(input.insertionAxis) : null;
  const vertexNormals = path ? angleWeightedNormals(tiBase) : null;
  /** Hidden from the insertion direction: a ray from just off the surface along the path hits the Ti-base. */
  const hidden = (p: V3, n: V3) => Boolean(path && tiRay.first([p[0] + 2e-3 * n[0], p[1] + 2e-3 * n[1], p[2] + 2e-3 * n[2]], path, 20));
  let samples = 0, sum = 0, maxErr = 0, minGap = Infinity, maxGap = 0;
  const skip = input.exclude;
  const measure = (p: V3, n: V3 | null) => {
    if (height(p) < shoulderLow || distanceToLoop(p, rim) < exclude || skip?.(p) || (n && hidden(p, n))) return;
    const hit = intaglioRay.closestPoint(p, gapMm + 1);
    if (!hit) return;
    const err = Math.abs(hit.distance - gapMm);
    samples++;
    sum += err;
    maxErr = Math.max(maxErr, err);
    minGap = Math.min(minGap, hit.distance);
    maxGap = Math.max(maxGap, hit.distance);
  };
  for (let i = 0; i < T.length; i += 3) measure([T[i]!, T[i + 1]!, T[i + 2]!], vertexNormals ? [vertexNormals[i]!, vertexNormals[i + 1]!, vertexNormals[i + 2]!] : null);
  for (let f = 0; f < ti.length; f += 3) {
    const a = ti[f]! * 3, b = ti[f + 1]! * 3, c = ti[f + 2]! * 3;
    const n = path
      ? normalize([
          (T[b + 1]! - T[a + 1]!) * (T[c + 2]! - T[a + 2]!) - (T[b + 2]! - T[a + 2]!) * (T[c + 1]! - T[a + 1]!),
          (T[b + 2]! - T[a + 2]!) * (T[c]! - T[a]!) - (T[b]! - T[a]!) * (T[c + 2]! - T[a + 2]!),
          (T[b]! - T[a]!) * (T[c + 1]! - T[a + 1]!) - (T[b + 1]! - T[a + 1]!) * (T[c]! - T[a]!),
        ])
      : null;
    measure([(T[a]! + T[b]! + T[c]!) / 3, (T[a + 1]! + T[b + 1]! + T[c + 1]!) / 3, (T[a + 2]! + T[b + 2]! + T[c + 2]!) / 3], n);
  }

  // Intaglio → Ti-base: the distance, negative inside the Ti-base (ray parity over three directions, majority).
  const PARITY: V3[] = [normalize([0.21, 0.37, 0.9]), normalize([-0.53, 0.29, 0.79]), normalize([0.11, -0.61, 0.78])];
  const inside = (p: V3) => PARITY.filter((d) => tiRay.all(p, d, 40).length % 2 === 1).length >= 2;
  const Q = intaglio.positions;
  let iSamples = 0, iSum = 0, iMax = 0, iMin = Infinity;
  for (let i = 0; input.intaglioSide !== false && i < Q.length; i += 3) {
    const p: V3 = [Q[i]!, Q[i + 1]!, Q[i + 2]!];
    if (distanceToLoop(p, rim) < exclude) continue;
    const hit = tiRay.closestPoint(p, gapMm + 1);
    if (!hit) continue;
    const d = inside(p) ? -hit.distance : hit.distance;
    iSamples++;
    iSum += Math.abs(d - gapMm);
    iMax = Math.max(iMax, Math.abs(d - gapMm));
    iMin = Math.min(iMin, d);
  }
  return {
    gapMm,
    tiBaseSamples: samples,
    meanErrorMm: samples ? sum / samples : 0,
    maxErrorMm: maxErr,
    minGapMm: minGap,
    maxGapMm: maxGap,
    intaglioSamples: iSamples,
    intaglioMeanErrorMm: iSamples ? iSum / iSamples : 0,
    intaglioMaxErrorMm: iMax,
    intaglioMinGapMm: iMin,
  };
}

export interface TiBaseFit {
  /** Rim vertices first (one per rim point), faces toward the Ti-base, as buildIntaglio returns it. */
  intaglio: Intaglio;
  /** The rim used (world, CCW seen from +axis). */
  rim: Float32Array;
  /** The insertion axis used. */
  axis: V3;
  gapMm: number;
  /** The Ti-base at the pose (world). */
  tiBase: IndexedMesh;
  /** The Ti-base offset by the gap (world): the surface the intaglio rests on. */
  offset: IndexedMesh;
  gap: TiBaseGapCheck;
  warnings: string[];
}

/**
 * Fitting surface of a restoration on a Ti-base at an implant pose: the
 * Ti-base offset by the bonding gap, then `buildIntaglio` with the shoulder
 * rim and the insertion axis (default the implant axis; a bridge passes its
 * common path, and undercuts against it are blocked out as for preps).
 */
export function tiBaseFittingSurface(input: {
  entry: Pick<ImplantLibraryEntry, 'tiBase' | 'shoulderLoop' | 'bondingGapMm'>;
  pose: ImplantPose;
  /** Default: the entry's bondingGapMm. */
  gapMm?: number;
  /** Default: the implant axis. */
  axis?: V3;
  /** Default: the shoulder loop lifted by the gap. */
  rim?: Float32Array;
  /** Points per radial profile (default 64: the Ti-base's tall walls need more than a prep's 32). */
  profilePoints?: number;
  /** Envelope samples per profile (default 200). */
  samples?: number;
}): TiBaseFit {
  const gapMm = input.gapMm ?? input.entry.bondingGapMm;
  const axis = normalize(input.axis ?? implantBasis(input.pose).z);
  const tiBase = placeAtImplantPose(input.entry.tiBase, input.pose);
  const offset = offsetMesh(tiBase, gapMm);
  const ray = bvhRayCaster(createBvh({ positions: offset.positions, indices: offset.indices.slice() }));
  const rim = input.rim ?? shoulderRim(input.entry, input.pose, gapMm);
  const intaglio = buildIntaglio({ offset: ray, rim, axis, profilePoints: input.profilePoints ?? 64, samples: input.samples ?? 200 });
  const gap = measureTiBaseGap({ tiBase, intaglio: intaglio.mesh, rim, pose: input.pose, gapMm, insertionAxis: axis });
  return { intaglio, rim, axis, gapMm, tiBase, offset, gap, warnings: [...intaglio.warnings] };
}
