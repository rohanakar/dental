import type { IndexedMesh } from './mesh';
import type { V3 } from './pca';

/**
 * Plane sections of closed meshes and their enclosed area (mm²), e.g. the
 * cross-section of a bridge connector measured on the merged solid.
 *
 * Method: every vertex is classified strictly above (signed distance ≥ 0) or
 * below (< 0) the plane, so a vertex lying exactly on the plane counts as
 * above and each triangle is cut in zero or two edges, never in a vertex.
 * This is the section of a plane shifted infinitesimally toward −normal: a
 * plane lying exactly on a flat face gives the section just behind it
 * (empty when the solid is on the +normal side).
 * Each cut triangle gives one segment between the crossing points of its two
 * cut edges, oriented by the triangle's winding. Segments are chained
 * through the shared cut edges (by vertex ids, exact), so a closed, welded,
 * consistently oriented mesh gives closed loops without any tolerance. Chains
 * left open by an unwelded mesh are joined end to start within `weldTolMm`.
 *
 * Loop areas are signed in the plane basis (u, v) with u × v = normal: on an
 * outward-oriented mesh outer boundaries are counter-clockwise (positive) and
 * holes clockwise (negative), so the enclosed area is their sum.
 */

export interface SectionPlane {
  point: V3;
  /** Plane normal (normalized internally). */
  normal: V3;
}

/** Keep only the loops near a point (a plane through one connector of a curved arch also cuts the far side). */
export interface SectionWithin {
  centre: V3;
  radiusMm: number;
}

export interface SectionOptions {
  /**
   * Keep loops that come within radiusMm of the centre's projection on the
   * plane, or that enclose it. A hole is kept or dropped with the loops
   * around it only if it qualifies itself, so use a radius that covers the
   * whole section of interest.
   */
  within?: SectionWithin;
  /** Endpoint tolerance for joining open chains (unwelded meshes); default 1e-4 mm. */
  weldTolMm?: number;
}

export interface SectionLoop {
  /** Closed polyline in 3D, xyz packed (first point not repeated). */
  points: Float32Array;
  /** Signed area in the plane basis: > 0 outer boundary, < 0 hole. */
  signedAreaMm2: number;
  /** Area centroid (3D, on the plane). */
  centroid: V3;
}

export interface MeshSection {
  /** Enclosed area of the kept loops: outer loops minus holes. */
  areaMm2: number;
  loops: SectionLoop[];
  /** Loops dropped by `within`. */
  droppedLoops: number;
  /** Chains that could not be closed (0 on a closed, welded mesh); excluded from the area. */
  openChains: number;
  /** Plane basis: origin = plane point, u × v = normal. */
  basis: { origin: V3; u: V3; v: V3; normal: V3 };
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (!(l > 0)) throw new Error('Section plane normal is zero');
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Orthonormal in-plane basis with u × v = n. */
export function sectionBasis(normal: V3): { u: V3; v: V3; normal: V3 } {
  const n = normalize(normal);
  const helper: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(helper, n));
  return { u, v: cross(n, u), normal: n };
}

/** Section of a closed mesh by a plane; see the module comment for the method and orientation rules. */
export function sectionMesh(mesh: Pick<IndexedMesh, 'positions' | 'indices'>, plane: SectionPlane, opts: SectionOptions = {}): MeshSection {
  const P = mesh.positions;
  const idx = mesh.indices;
  const nv = P.length / 3;
  const { u, v, normal: n } = sectionBasis(plane.normal);
  const o = plane.point;
  const weldTol = opts.weldTolMm ?? 1e-4;

  // Signed distances (float64).
  const dist = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    dist[i] = (P[i * 3]! - o[0]) * n[0] + (P[i * 3 + 1]! - o[1]) * n[1] + (P[i * 3 + 2]! - o[2]) * n[2];
  }
  const above = (i: number) => dist[i]! >= 0;

  // In-plane (u, v) coordinates of the crossing point on edge a–b (a above, b below or vice versa).
  const crossing = (a: number, b: number): [number, number] => {
    const da = dist[a]!, db = dist[b]!;
    const t = da / (da - db);
    const x = P[a * 3]! + t * (P[b * 3]! - P[a * 3]!) - o[0];
    const y = P[a * 3 + 1]! + t * (P[b * 3 + 1]! - P[a * 3 + 1]!) - o[1];
    const z = P[a * 3 + 2]! + t * (P[b * 3 + 2]! - P[a * 3 + 2]!) - o[2];
    return [x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]];
  };
  const edgeKey = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);

  // One segment per cut triangle: from the crossing on the edge where the winding goes above → below,
  // to the crossing on the edge where it goes below → above (counter-clockwise around an outward solid, seen from +normal).
  const segStartKey: number[] = [];
  const segEndKey: number[] = [];
  const segXY: number[] = []; // start (u, v), end (u, v) per segment
  const tri = [0, 0, 0];
  const side = [false, false, false];
  for (let f = 0; f < idx.length; f += 3) {
    tri[0] = idx[f]!;
    tri[1] = idx[f + 1]!;
    tri[2] = idx[f + 2]!;
    side[0] = above(tri[0]);
    side[1] = above(tri[1]);
    side[2] = above(tri[2]);
    if (side[0] === side[1] && side[1] === side[2]) continue;
    let inKey = -1, outKey = -1;
    let inXY: [number, number] = [0, 0], outXY: [number, number] = [0, 0];
    for (let k = 0; k < 3; k++) {
      const a = tri[k]!, b = tri[(k + 1) % 3]!;
      if (side[k] === side[(k + 1) % 3]) continue;
      if (side[k]) {
        inKey = edgeKey(a, b);
        inXY = crossing(a, b);
      } else {
        outKey = edgeKey(a, b);
        outXY = crossing(a, b);
      }
    }
    segStartKey.push(inKey);
    segEndKey.push(outKey);
    segXY.push(inXY[0], inXY[1], outXY[0], outXY[1]);
  }

  // Chain: a segment's end edge is the next segment's start edge (the neighbouring triangle across that edge).
  const nseg = segStartKey.length;
  const byStart = new Map<number, number>();
  const byEnd = new Map<number, number>();
  for (let s = 0; s < nseg; s++) {
    byStart.set(segStartKey[s]!, s);
    byEnd.set(segEndKey[s]!, s);
  }
  const used = new Uint8Array(nseg);
  const closed: number[][] = []; // loops as flat (u, v) lists, first point not repeated
  const open: number[][] = []; // chains as flat (u, v) lists including their end point
  for (let s0 = 0; s0 < nseg; s0++) {
    if (used[s0]) continue;
    // Walk back to the start of an open chain (or around a closed loop back to s0).
    let first = s0;
    for (let guard = 0; guard < nseg; guard++) {
      const prev = byEnd.get(segStartKey[first]!);
      if (prev === undefined || prev === s0 || used[prev]) break;
      first = prev;
    }
    const pts: number[] = [];
    let s = first;
    let isClosed = false;
    for (;;) {
      used[s] = 1;
      pts.push(segXY[s * 4]!, segXY[s * 4 + 1]!);
      const next = byStart.get(segEndKey[s]!);
      if (next === first) {
        isClosed = true;
        break;
      }
      if (next === undefined || used[next]) break;
      s = next;
    }
    if (isClosed) closed.push(pts);
    else open.push([...pts, segXY[s * 4 + 2]!, segXY[s * 4 + 3]!]);
  }

  // Join open chains end → start within the weld tolerance (unwelded meshes).
  let openChains = 0;
  if (open.length > 0) {
    const tol2 = weldTol * weldTol;
    const near = (c: number[], x: number, y: number) => (c[c.length - 2]! - x) ** 2 + (c[c.length - 1]! - y) ** 2 <= tol2;
    const closes = (c: number[]) => c.length >= 8 && near(c, c[0]!, c[1]!);
    const done = new Uint8Array(open.length);
    for (let i = 0; i < open.length; i++) {
      if (done[i]) continue;
      done[i] = 1;
      let chain = open[i]!;
      while (!closes(chain)) {
        const j = open.findIndex((c, k) => !done[k] && near(chain, c[0]!, c[1]!));
        if (j < 0) break;
        done[j] = 1;
        chain = chain.concat(open[j]!.slice(2)); // drop the shared joint point
      }
      if (closes(chain)) closed.push(chain.slice(0, -2));
      else openChains++;
    }
  }

  // Loops: signed area and centroid in (u, v); `within` filter.
  const within = opts.within;
  let cu = 0, cv = 0;
  if (within) {
    const d: V3 = [within.centre[0] - o[0], within.centre[1] - o[1], within.centre[2] - o[2]];
    cu = dot(d, u);
    cv = dot(d, v);
  }
  const loops: SectionLoop[] = [];
  let droppedLoops = 0;
  let areaMm2 = 0;
  for (const pts of closed) {
    const m = pts.length / 2;
    if (m < 3) continue;
    let a2 = 0, gx = 0, gy = 0;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const x0 = pts[i * 2]!, y0 = pts[i * 2 + 1]!, x1 = pts[j * 2]!, y1 = pts[j * 2 + 1]!;
      const c = x0 * y1 - x1 * y0;
      a2 += c;
      gx += (x0 + x1) * c;
      gy += (y0 + y1) * c;
    }
    if (within && !loopNear(pts, cu, cv, within.radiusMm)) {
      droppedLoops++;
      continue;
    }
    const area = a2 / 2;
    const ccx = a2 !== 0 ? gx / (3 * a2) : pts[0]!;
    const ccy = a2 !== 0 ? gy / (3 * a2) : pts[1]!;
    const points = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) {
      const x = pts[i * 2]!, y = pts[i * 2 + 1]!;
      points[i * 3] = o[0] + x * u[0] + y * v[0];
      points[i * 3 + 1] = o[1] + x * u[1] + y * v[1];
      points[i * 3 + 2] = o[2] + x * u[2] + y * v[2];
    }
    loops.push({
      points,
      signedAreaMm2: area,
      centroid: [o[0] + ccx * u[0] + ccy * v[0], o[1] + ccx * u[1] + ccy * v[1], o[2] + ccx * u[2] + ccy * v[2]],
    });
    areaMm2 += area;
  }
  return { areaMm2, loops, droppedLoops, openChains, basis: { origin: o, u, v, normal: n } };
}

/** Does the closed (u, v) polyline come within r of (cx, cy), or enclose it (even–odd rule)? */
function loopNear(pts: number[], cx: number, cy: number, r: number): boolean {
  const m = pts.length / 2;
  const r2 = r * r;
  let inside = false;
  for (let i = 0, j = m - 1; i < m; j = i++) {
    const xi = pts[i * 2]!, yi = pts[i * 2 + 1]!, xj = pts[j * 2]!, yj = pts[j * 2 + 1]!;
    const ex = xi - xj, ey = yi - yj;
    const len2 = ex * ex + ey * ey;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((cx - xj) * ex + (cy - yj) * ey) / len2)) : 0;
    const dx = cx - (xj + t * ex), dy = cy - (yj + t * ey);
    if (dx * dx + dy * dy <= r2) return true;
    if (yi > cy !== yj > cy && cx < xj + ((cy - yj) * ex) / ey) inside = !inside;
  }
  return inside;
}

export interface SectionScanOptions {
  /** The scanned planes are ⊥ to (to − from) and pass through points on the segment from → to. */
  from: V3;
  to: V3;
  /** Number of planes, evenly spaced from t = 0 to t = 1 inclusive (1 → the midpoint only); default 21. */
  steps?: number;
  /** Keep only loops near each plane's own point on the segment (see SectionOptions.within). */
  radiusMm?: number;
}

export interface SectionSample {
  /** Fraction along from → to. */
  t: number;
  point: V3;
  areaMm2: number;
}

export interface SectionScan {
  /** Smallest enclosed area over the scanned planes (0 if some plane cuts nothing near its point). */
  minAreaMm2: number;
  /** The plane with the smallest section. */
  at: SectionSample;
  /** That plane's full section (loops, basis). */
  section: MeshSection;
  samples: SectionSample[];
}

/**
 * Smallest section of a closed mesh over planes ⊥ a segment, e.g. a
 * connector's weakest cross-section across the interproximal gap (exocad's
 * moving cross-section plane, as a measurement).
 */
export function scanSections(mesh: Pick<IndexedMesh, 'positions' | 'indices'>, opts: SectionScanOptions): SectionScan {
  const steps = Math.max(1, Math.floor(opts.steps ?? 21));
  const { from, to } = opts;
  const normal: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const samples: SectionSample[] = [];
  let best: { sample: SectionSample; section: MeshSection } | null = null;
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0.5 : i / (steps - 1);
    const point: V3 = [from[0] + t * normal[0], from[1] + t * normal[1], from[2] + t * normal[2]];
    const within = opts.radiusMm === undefined ? undefined : { centre: point, radiusMm: opts.radiusMm };
    const section = sectionMesh(mesh, { point, normal }, { within });
    const sample = { t, point, areaMm2: section.areaMm2 };
    samples.push(sample);
    if (!best || sample.areaMm2 < best.sample.areaMm2) best = { sample, section };
  }
  return { minAreaMm2: best!.sample.areaMm2, at: best!.sample, section: best!.section, samples };
}
