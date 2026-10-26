import { symmetricEigen3, type V3 } from './pca';

/**
 * The prep stump around a click and its own axis, from the scan's triangles alone (no margin needed). Used by the
 * tooth frame of front teeth (toothFrame.ts) and by the Margin step's view (tools/marginView.ts). See
 * specs/2026-10-26-anterior-margin-and-export-all.md and specs/2026-10-26-anterior-tooth-frame.md.
 */

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const normalize = (a: readonly number[]): V3 => {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!);
  return l > 0 ? [a[0]! / l, a[1]! / l, a[2]! / l] : [0, 0, 1];
};
const DEG = Math.PI / 180;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** A wall counts as clear only when it faces the axis by at least this angle, so the optimum sits on the walls' axis. */
const WALL_CLEARANCE = Math.sin(20 * DEG);
/** Window (mm, frame coordinates from the origin) that holds the prep. */
const WINDOW_MM = 6;
/** The faces within this depth below the prep top (mm) give the axis: the axial walls, above the chamfer and the gum. */
const STUMP_DEPTH_MM = 2;
/** The band below the top (mm) whose points score a view: the foot of the walls, toward the margin. */
const RIM_DEPTH_MM = [2.5, 3.5] as const;
const RIM_SAMPLES = 96;

export interface PrepStumpInput {
  /** Jaw scan, xyz per vertex. */
  positions: ArrayLike<number>;
  /** Triangle indices (any order, e.g. the BVH's). */
  indices: ArrayLike<number>;
  /** Where to look: the frame origin (the prep top under the click) and its mesial and buccal axes. */
  frame: { origin: readonly number[]; mesial: readonly number[]; buccal: readonly number[] };
  /** Heights are measured along this unit direction (the frame's occlusal). */
  occlusal: V3;
}

/** The prep stump: the scan connected to the prep top down to RIM_DEPTH_MM[1] below it. */
export interface PrepStump {
  /** Centre of the prep top: the stump vertices within 1 mm of the highest, averaged. */
  top: V3;
  /** Area-weighted face normals (xyz per face) of the stump's faces within STUMP_DEPTH_MM of the top (the walls). */
  normals: Float64Array;
  /** Points of the band 2.5–3.5 mm below the top (the foot of the walls, toward the margin), subsampled. */
  rim: V3[];
}

/**
 * The prep stump, found by connectivity so that a click anywhere on the prep gives the same result:
 * - Window: the vertices within ±6 mm of the frame origin along mesial-distal and bucco-lingually, and from 8 mm
 *   below to 6 mm above it along occlusal, with the edges of the faces that lie inside it.
 * - The prep top: the highest point of the surface connected to the vertex at the origin through vertices no lower
 *   than 0.5 mm below the origin (a neighbouring tooth is separated from the prep by a lower valley).
 * - The stump: the surface connected to that top through vertices no lower than 3.5 mm below it.
 * Null when the window holds no surface or the stump is too small to tell.
 */
export function findPrepStump(input: PrepStumpInput): PrepStump | null {
  const P = input.positions;
  const I = input.indices;
  const { frame, occlusal } = input;
  const o = frame.origin;
  const mesial = normalize(frame.mesial);
  const buccal = normalize(frame.buccal);
  const n = P.length / 3;

  // Window vertices, their heights along occlusal, and the one nearest the origin.
  const local = new Int32Array(n).fill(-1);
  const ids: number[] = [];
  const heights: number[] = [];
  let start = -1;
  let nearest = Infinity;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3]! - o[0]!, y = P[i * 3 + 1]! - o[1]!, z = P[i * 3 + 2]! - o[2]!;
    const h = x * occlusal[0] + y * occlusal[1] + z * occlusal[2];
    if (h < -8 || h > 6) continue;
    if (Math.abs(x * mesial[0] + y * mesial[1] + z * mesial[2]) > WINDOW_MM) continue;
    if (Math.abs(x * buccal[0] + y * buccal[1] + z * buccal[2]) > WINDOW_MM) continue;
    local[i] = ids.length;
    ids.push(i);
    heights.push(h);
    const d = x * x + y * y + z * z;
    if (d < nearest) {
      nearest = d;
      start = ids.length - 1;
    }
  }
  if (start < 0) return null;

  // Edges of the faces inside the window, as adjacency lists (CSR).
  const faces: number[] = [];
  for (let f = 0; f + 2 < I.length; f += 3) {
    const a = local[I[f]!]!, b = local[I[f + 1]!]!, c = local[I[f + 2]!]!;
    if (a >= 0 && b >= 0 && c >= 0) faces.push(a, b, c, f);
  }
  const m = ids.length;
  const degree = new Int32Array(m + 1);
  for (let k = 0; k < faces.length; k += 4) for (let j = 0; j < 3; j++) degree[faces[k + j]! + 1]! += 2;
  for (let i = 0; i < m; i++) degree[i + 1]! += degree[i]!;
  const adjacency = new Int32Array(degree[m]!);
  const fill = degree.slice(0, m);
  for (let k = 0; k < faces.length; k += 4) {
    for (let j = 0; j < 3; j++) {
      const a = faces[k + j]!, b = faces[k + ((j + 1) % 3)]!;
      adjacency[fill[a]!++] = b;
      adjacency[fill[b]!++] = a;
    }
  }
  /** Vertices connected to `from` through vertices at least `floor` high. */
  const flood = (from: number, floor: number): Uint8Array => {
    const seen = new Uint8Array(m);
    const queue = [from];
    seen[from] = 1;
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q]!;
      for (let k = degree[u]!; k < degree[u + 1]!; k++) {
        const v = adjacency[k]!;
        if (seen[v] || heights[v]! < floor) continue;
        seen[v] = 1;
        queue.push(v);
      }
    }
    return seen;
  };

  const around = flood(start, heights[start]! - 0.5);
  let topVertex = start;
  for (let i = 0; i < m; i++) if (around[i] && heights[i]! > heights[topVertex]!) topVertex = i;
  const topHeight = heights[topVertex]!;
  const stump = flood(topVertex, topHeight - RIM_DEPTH_MM[1]);

  const top: V3 = [0, 0, 0];
  let count = 0;
  const rim: V3[] = [];
  for (let i = 0; i < m; i++) {
    if (!stump[i]) continue;
    const below = topHeight - heights[i]!;
    const v = ids[i]! * 3;
    if (below <= 1) {
      for (let k = 0; k < 3; k++) top[k] = top[k]! + P[v + k]!;
      count++;
    }
    if (below >= RIM_DEPTH_MM[0]) rim.push([P[v]!, P[v + 1]!, P[v + 2]!]);
  }
  const normals: number[] = [];
  for (let k = 0; k < faces.length; k += 4) {
    const [a0, b0, c0] = [faces[k]!, faces[k + 1]!, faces[k + 2]!];
    if (!stump[a0] || !stump[b0] || !stump[c0]) continue;
    if (Math.min(heights[a0]!, heights[b0]!, heights[c0]!) < topHeight - STUMP_DEPTH_MM) continue;
    const f = faces[k + 3]!;
    const a = I[f]! * 3, b = I[f + 1]! * 3, c = I[f + 2]! * 3;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
    normals.push(0.5 * (uy * vz - uz * vy), 0.5 * (uz * vx - ux * vz), 0.5 * (ux * vy - uy * vx));
  }
  if (count === 0 || normals.length < 3 * 50) return null;
  // An even subsample of the rim, enough to score a view.
  const stride = Math.max(1, Math.floor(rim.length / RIM_SAMPLES));
  return {
    top: [top[0] / count, top[1] / count, top[2] / count],
    normals: Float64Array.from(normals),
    rim: rim.filter((_, i) => i % stride === 0),
  };
}

/**
 * The prep's own axis: the least-undercut direction of the stump's faces with a clearance (cost = Σ area ·
 * max(0, sin 20° − n·d)), on Fibonacci samples in a cone (default 35°) around `occlusal`, then a 0.5° refinement. A
 * small tie-break keeps `occlusal` when the cost is flat (an upright prep).
 */
export function prepStumpAxis(stump: PrepStump, occlusal: V3, coneDeg = 35): V3 {
  const an = stump.normals;
  const areas = new Float64Array(an.length / 3);
  let totalArea = 0;
  for (let i = 0; i < areas.length; i++) {
    areas[i] = Math.hypot(an[i * 3]!, an[i * 3 + 1]!, an[i * 3 + 2]!);
    totalArea += areas[i]!;
  }
  // Tie-break toward the frame's occlusal direction: 0.1% of the stump's area per 10°.
  const lambda = (1e-3 * totalArea) / (10 * DEG);
  const cost = (d: V3) => {
    let sum = 0;
    for (let i = 0; i < areas.length; i++) {
      const x = WALL_CLEARANCE * areas[i]! - (an[i * 3]! * d[0] + an[i * 3 + 1]! * d[1] + an[i * 3 + 2]! * d[2]);
      if (x > 0) sum += x;
    }
    return sum + lambda * Math.acos(Math.min(1, Math.max(-1, dot(d, occlusal))));
  };

  const [u, v] = capBasis(occlusal);
  const cosCone = Math.cos(coneDeg * DEG);
  let best = occlusal;
  let bestCost = cost(occlusal);
  const samples = 240;
  for (let i = 1; i < samples; i++) {
    const cosT = 1 - ((1 - cosCone) * i) / (samples - 1);
    const d = onCap(occlusal, u, v, Math.acos(cosT), i * GOLDEN_ANGLE);
    const c = cost(d);
    if (c < bestCost) {
      bestCost = c;
      best = d;
    }
  }
  const [bu, bv] = capBasis(best);
  const coarse = best;
  for (let i = -5; i <= 5; i++) {
    for (let j = -5; j <= 5; j++) {
      if (i === 0 && j === 0) continue;
      const d = onCap(coarse, bu, bv, Math.hypot(i, j) * 0.5 * DEG, Math.atan2(j, i));
      if (dot(d, occlusal) < cosCone) continue;
      const c = cost(d);
      if (c < bestCost) {
        bestCost = c;
        best = d;
      }
    }
  }
  return best;
}

/** First pass of stumpWallAxis: wall faces have their normal more than this from the reference direction. */
const WALL_FROM_REFERENCE_DEG = 35;
/** Refit: wall faces have their normal more than this from the first estimate. */
const WALL_FROM_ESTIMATE_DEG = 45;

/**
 * The axis of the stump's axial walls: the direction their normals are most nearly perpendicular to. A tapered stump's
 * wall normals lie on a cone around its axis, so it is the least-variance eigenvector of their area-weighted unit
 * normals. Walls are the faces whose normal is more than 35° from `reference` (the jaw's occlusal direction); a refit
 * keeps the faces more than 45° from that first estimate, so a prep top drops out whether it stays parallel to the
 * occlusal plane or tilts with the tooth. Oriented along `reference`.
 *
 * Unlike the least-undercut direction (prepStumpAxis), which stops where the larger wall reaches its clearance, this
 * is symmetric in the walls: on the synthetic incisors leaning 15–30° it is within 2.4° of the true axis, against
 * 2.9–6.6° (specs/2026-10-26-anterior-tooth-frame.md). Null when the fit is ambiguous: the walls hold less than a
 * fifth of the stump's area, or the smallest eigenvalue is more than half the middle one (normals not on a cone).
 */
export function stumpWallAxis(stump: PrepStump, reference: V3): V3 | null {
  const first = wallFit(stump.normals, reference, WALL_FROM_REFERENCE_DEG);
  return first && wallFit(stump.normals, first, WALL_FROM_ESTIMATE_DEG);
}

function wallFit(normals: Float64Array, reference: V3, minDeg: number): V3 | null {
  const cosMin = Math.cos(minDeg * DEG);
  let total = 0;
  let wall = 0;
  const mean = [0, 0, 0];
  for (let i = 0; i < normals.length; i += 3) {
    const area = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
    total += area;
    if (area === 0 || (normals[i]! * reference[0] + normals[i + 1]! * reference[1] + normals[i + 2]! * reference[2]) / area > cosMin) continue;
    wall += area;
    for (let k = 0; k < 3; k++) mean[k] = mean[k]! + normals[i + k]!;
  }
  if (wall === 0 || wall < 0.2 * total) return null;
  for (let k = 0; k < 3; k++) mean[k] = mean[k]! / wall;
  // Area-weighted covariance of the unit wall normals.
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < normals.length; i += 3) {
    const area = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
    if (area === 0 || (normals[i]! * reference[0] + normals[i + 1]! * reference[1] + normals[i + 2]! * reference[2]) / area > cosMin) continue;
    const x = normals[i]! / area - mean[0]!, y = normals[i + 1]! / area - mean[1]!, z = normals[i + 2]! / area - mean[2]!;
    xx += area * x * x;
    xy += area * x * y;
    xz += area * x * z;
    yy += area * y * y;
    yz += area * y * z;
    zz += area * z * z;
  }
  const { values, vectors } = symmetricEigen3([
    [xx / wall, xy / wall, xz / wall],
    [xy / wall, yy / wall, yz / wall],
    [xz / wall, yz / wall, zz / wall],
  ]);
  const order = [0, 1, 2].sort((a, b) => values[a]! - values[b]!);
  if (values[order[0]!]! > 0.5 * values[order[1]!]!) return null;
  const k = order[0]!;
  const axis = normalize([vectors[0]![k]!, vectors[1]![k]!, vectors[2]![k]!]);
  return dot(axis, reference) >= 0 ? axis : [-axis[0], -axis[1], -axis[2]];
}

/** Orthonormal basis (u, v) perpendicular to unit n. */
export function capBasis(n: V3): [V3, V3] {
  const u = normalize(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  return [u, cross(n, u)];
}

/** Direction at polar angle theta and azimuth phi around unit c. */
export function onCap(c: V3, u: V3, v: V3, theta: number, phi: number): V3 {
  const s = Math.sin(theta);
  const k = Math.cos(theta);
  return normalize([0, 1, 2].map((i) => c[i]! * k + s * (Math.cos(phi) * u[i]! + Math.sin(phi) * v[i]!)));
}
