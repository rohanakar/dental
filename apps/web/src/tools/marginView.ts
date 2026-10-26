import type { RayCaster } from '../geometry/raycast';

type V3 = [number, number, number];

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const normalize = (a: readonly number[]): V3 => {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!);
  return l > 0 ? [a[0]! / l, a[1]! / l, a[2]! / l] : [0, 0, 1];
};
const DEG = Math.PI / 180;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Camera distance of the Margin step's view (mm), as before this module. */
export const MARGIN_VIEW_DISTANCE_MM = 32;
/** A wall counts as seen only when it faces the camera by at least this angle, so the view sits on the stump's axis. */
const WALL_CLEARANCE = Math.sin(20 * DEG);
/** The prep axis is searched within this cone around the frame's occlusal direction. */
const CONE_DEG = 35;
/** A margin point counts as hidden when the camera ray lands farther than this from it. */
const HIDDEN_TOLERANCE_MM = 0.3;

export interface MarginViewInput {
  /** Jaw scan, xyz per vertex. */
  positions: ArrayLike<number>;
  /** Triangle indices (any order, e.g. the BVH's). */
  indices: ArrayLike<number>;
  ray: RayCaster;
  frame: {
    origin: readonly number[];
    occlusal: readonly number[];
    mesial: readonly number[];
    buccal: readonly number[];
    mesialContact?: readonly number[];
    distalContact?: readonly number[];
  };
  /** The current margin (dense points), when one exists. */
  margin?: ReadonlyArray<readonly number[]>;
  /** The stored insertion axis, when one exists. */
  axis?: readonly number[];
}

export interface MarginView {
  /** Where the camera looks: the centre of the prep top (the frame origin when it cannot be found). */
  target: V3;
  /** Unit direction from the target toward the camera. */
  direction: V3;
  /** Which candidate won: the prep's own axis, the stored insertion axis, or the frame's occlusal direction. */
  source: 'prep' | 'axis' | 'occlusal';
  /** Margin points a click cannot reach from this view (0 without a margin: nothing to test). */
  hidden: number;
}

/**
 * The Margin step's view: from where the whole margin of the prep can be seen and clicked.
 *
 * The frame's occlusal direction is the jaw's occlusal-plane normal. On proclined front teeth (an upper incisor leans
 * 15–30° labially) looking along it puts the labial margin edge-on or behind the tooth. So the view follows the prep's
 * own axis:
 * - The prep stump is found first by connectivity (findStump), so a click anywhere on the prep gives the same view.
 * - The axis is the least-undercut direction of the stump's walls with a 20° clearance (prepAxis). Each wall has to
 *   face the camera by at least that much, which puts the optimum on the axis of the walls rather than at the edge
 *   of the visible cone. It is searched within 35° of the frame's occlusal direction, with a small tie-break toward
 *   it, so an upright posterior prep keeps the occlusal view.
 * - Then it is checked against what a click can reach at the foot of the walls (bestView).
 *
 * With a margin, the candidates (prep axis, stored insertion axis, frame occlusal) are ray tested from the camera
 * position against the margin points, and the one that hides the fewest wins (ties: in that order).
 *
 * Measured on the synthetic arch (specs/2026-10-26-anterior-margin-and-export-all.md): every margin point of 11
 * reachable with the incisors proclined up to 25°, against 39–45 of 64 from the occlusal view; 36 keeps the occlusal
 * view. 20–70 ms for a 1M-triangle scan.
 */
export function marginView(input: MarginViewInput, distanceMm = MARGIN_VIEW_DISTANCE_MM): MarginView {
  const occlusal = normalize(input.frame.occlusal);
  const stump = findStump(input, occlusal);
  const o = input.frame.origin;
  const target: V3 = stump?.top ?? [o[0]!, o[1]!, o[2]!];
  const prep = stump ? bestView(input.ray, target, stump, prepAxis(stump, occlusal), occlusal, distanceMm) : null;
  const margin = input.margin && input.margin.length >= 3 ? input.margin : null;
  if (!margin) return { target, direction: prep ?? occlusal, source: prep ? 'prep' : 'occlusal', hidden: 0 };

  const candidates: Array<{ direction: V3; source: MarginView['source'] }> = [];
  if (prep) candidates.push({ direction: prep, source: 'prep' });
  if (input.axis) candidates.push({ direction: normalize(input.axis), source: 'axis' });
  candidates.push({ direction: occlusal, source: 'occlusal' });
  let best: MarginView | null = null;
  for (const c of candidates) {
    const hidden = hiddenPoints(input.ray, target, c.direction, distanceMm, margin);
    if (!best || hidden < best.hidden) best = { target, direction: c.direction, source: c.source, hidden };
    if (hidden === 0) break;
  }
  return best!;
}

/**
 * Margin points a click cannot reach from a perspective camera at target + distance × direction: the camera ray to
 * the point lands more than 0.3 mm away from it, either on something in front of it or, past a margin seen edge-on,
 * on the root surface or gum behind it.
 */
function hiddenPoints(ray: RayCaster, target: V3, direction: V3, distanceMm: number, points: ReadonlyArray<readonly number[]>): number {
  const camera: V3 = [target[0] + direction[0] * distanceMm, target[1] + direction[1] * distanceMm, target[2] + direction[2] * distanceMm];
  // 128 samples are plenty for a margin of a few hundred points.
  const step = Math.max(1, Math.floor(points.length / 128));
  let hidden = 0;
  for (let i = 0; i < points.length; i += step) {
    const p = points[i]!;
    const toPoint = sub(p, camera);
    const length = Math.hypot(...toPoint);
    const hit = ray.first(camera, normalize(toPoint), length + 5);
    if (!hit || Math.hypot(...sub(hit.point, p)) > HIDDEN_TOLERANCE_MM) hidden++;
  }
  return hidden;
}

/** The prep stump: the scan connected to the prep top down to RIM_DEPTH_MM[1] below it. */
interface Stump {
  /** Centre of the prep top: the stump vertices within 1 mm of the highest, averaged. */
  top: V3;
  /** Area-weighted face normals (xyz per face) of the stump's faces within STUMP_DEPTH_MM of the top (the walls). */
  normals: Float64Array;
  /** Points of the band 2.5–3.5 mm below the top (the foot of the walls, toward the margin), subsampled. */
  rim: V3[];
}

/** Window (mm, frame coordinates from the origin) that holds the prep. */
const WINDOW_MM = 6;
/** The faces within this depth below the prep top (mm) give the axis: the axial walls, above the chamfer and the gum. */
const STUMP_DEPTH_MM = 2;
/** The band below the top (mm) whose points score a view: the foot of the walls, toward the margin. */
const RIM_DEPTH_MM = [2.5, 3.5] as const;
const RIM_SAMPLES = 96;

/**
 * The prep stump, found by connectivity so that a click anywhere on the prep gives the same result:
 * - Window: the vertices within ±6 mm of the frame origin along mesial-distal and bucco-lingually, and from 8 mm
 *   below to 6 mm above it along occlusal, with the edges of the faces that lie inside it.
 * - The prep top: the highest point of the surface connected to the vertex at the origin through vertices no lower
 *   than 0.5 mm below the origin (a neighbouring tooth is separated from the prep by a lower valley).
 * - The stump: the surface connected to that top through vertices no lower than 3.5 mm below it.
 * Null when the window holds no surface or the stump is too small to tell.
 */
function findStump(input: MarginViewInput, occlusal: V3): Stump | null {
  const P = input.positions;
  const I = input.indices;
  const { frame } = input;
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
 * max(0, sin 20° − n·d)), on Fibonacci samples in a 35° cone around the frame's occlusal direction, then a 0.5°
 * refinement. A small tie-break keeps the occlusal direction when the cost is flat (an upright prep).
 */
function prepAxis(stump: Stump, occlusal: V3): V3 {
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

  const [u, v] = basis(occlusal);
  const cosCone = Math.cos(CONE_DEG * DEG);
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
  const [bu, bv] = basis(best);
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

/**
 * The walls' axis can fall short of a strongly leaning prep, so it is checked against what a click can reach: the
 * axis and directions tilted 4°, 8° and 12° from it (8 azimuths each, inside the cone) are scored by how many rim
 * points they hide; the fewest wins, the smaller tilt on a tie.
 */
function bestView(ray: RayCaster, target: V3, stump: Stump, axis: V3, occlusal: V3, distanceMm: number): V3 {
  if (stump.rim.length === 0) return axis;
  const cosCone = Math.cos(CONE_DEG * DEG);
  const [u, v] = basis(axis);
  let best = axis;
  let bestHidden = hiddenPoints(ray, target, axis, distanceMm, stump.rim);
  for (const tilt of [4, 8, 12]) {
    if (bestHidden === 0) break;
    for (let k = 0; k < 8; k++) {
      const d = onCap(axis, u, v, tilt * DEG, (k * Math.PI) / 4);
      if (dot(d, occlusal) < cosCone) continue;
      const hidden = hiddenPoints(ray, target, d, distanceMm, stump.rim);
      if (hidden < bestHidden) {
        bestHidden = hidden;
        best = d;
      }
    }
  }
  return best;
}

/** Orthonormal basis (u, v) perpendicular to unit n. */
function basis(n: V3): [V3, V3] {
  const u = normalize(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  return [u, cross(n, u)];
}

/** Direction at polar angle theta and azimuth phi around unit c. */
function onCap(c: V3, u: V3, v: V3, theta: number, phi: number): V3 {
  const s = Math.sin(theta);
  const k = Math.cos(theta);
  return normalize([0, 1, 2].map((i) => c[i]! * k + s * (Math.cos(phi) * u[i]! + Math.sin(phi) * v[i]!)));
}
