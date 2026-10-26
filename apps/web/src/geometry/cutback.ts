// The veneer tolerance (larger protection pushes are shortfalls) and the unsupported-porcelain limit live in shared.
import { MAX_UNSUPPORTED_VENEER_MM, VENEER_TOLERANCE_MM } from '@dcad/shared';
import { crownAxes, type CrownDesign, type CrownFrame, type CrownValidation } from './crown';
import type { CrownTemplate } from './crownTemplate';
import { MinHeap } from './livewire';
import type { IndexedMesh } from './mesh';
import { validateClosedMesh } from './meshValidate';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh } from './raycast';
import { countSelfIntersections } from './selfIntersect';
import { buildVertexAdjacency, type SurfaceGraph } from './surface';
import { distanceToLoop, enforceThickness, signedIntaglioDistance, thicknessProfile, type IntaglioSurface, type ThicknessParams } from './thickness';

/**
 * Cutback: the reduced unit (framework part) of a layered or pressed
 * restoration, made from the finished anatomic unit by moving its outer
 * surface inward by the veneering space S. See
 * specs/2026-10-25-framework-bridges.md.
 *
 * The reduced surface is the boundary of F = (A ⊖ B(S + ρ)) ⊕ B(ρ): the
 * anatomy eroded by S + ρ, then rounded by ρ (half the framework minimum), so
 * no framework part is thinner than 2ρ. It is mapped vertex by vertex, so the
 * framework keeps the anatomy's vertices and faces (intaglio, margin band and
 * collar untouched) and stays fold-free:
 * - Mask: the mode's region minus the collar, feathered, scales each vertex's
 *   displacement (cutbackMask).
 * - Placement (at the full S): where the inner ball of radius S + ρ fits under
 *   a vertex, or a convex tip is between S and S + ρ in radius, the vertex is
 *   offset along its smoothed normal to exactly S from the outer surface: an
 *   anatomically reduced framework with an even veneer. Where the unit is
 *   thinner than 2(S + ρ) or sharper than S (incisal edges, sharp ridges,
 *   pointed cusps), the offset would fold or cross the other side, so the
 *   vertex goes to its closest point on F, the nearest fitting balls shrunk by
 *   S. The framework there is reduced further (an incisal edge is shortened)
 *   and the veneer is thicker, never thinner.
 * - Protection: where the framework is closer to the fitting surface than the
 *   framework minimum, each vertex is retracted along its own cut, then
 *   enforceThickness guarantees the profile. That is the "insufficient
 *   veneering space" report.
 * - Repair: where the result still intersects itself, the displacement field
 *   (never the anatomy) is smoothed locally and protected again; a fold that
 *   survives (an offset that compresses tiny triangles, e.g. at a saddle whose
 *   convex radius is close to S) has its framework positions relaxed instead.
 * The veneer is then measured, not assumed: anatomy vertex → framework surface.
 */

export type CutbackMode = 'full' | 'facial' | 'occlusal';

export interface CutbackSettings {
  /** full: every outer surface but the collar; facial: buccal/labial plus the occlusal third; occlusal: the occlusal third. */
  mode: CutbackMode;
  /** Veneering space: how far the cut-back surface moves inward (mm). */
  thicknessMm: number;
  /** Cervical collar kept at full contour, measured geodesically from the cervical loop (mm). */
  collarMm: number;
}

/** Spec defaults (placeholders, to confirm in domain QA). */
export const CUTBACK_DEFAULTS: CutbackSettings = { mode: 'full', thicknessMm: 1.0, collarMm: 0.8 };
/** The mask ramps from 0 to 1 over this geodesic width, so the cutback edge is a smooth shoulder. */
export const CUTBACK_FEATHER_MM = 0.5;
/** facial mode: vertices whose smoothed normal has n·buccal above this. */
export const CUTBACK_FACIAL_MIN_DOT = 0.3;
/** facial and occlusal modes: the occlusal (incisal) third, template height fraction at or above this (feathered outward). */
export const CUTBACK_OCCLUSAL_HEIGHT = 0.7;

/** Smoothing passes of the outer normals that give the cut direction. */
const NORMAL_SMOOTHING = 4;
/** The inner ball fits when nothing on the outer surface is closer to its centre than its radius minus this (mm). */
const BALL_TOLERANCE_MM = 0.01;
/** A convex tip or ridge is offset (not projected) when a ball of radius S plus this fits under it. */
const CURVATURE_MARGIN_MM = 0.05;
/** Rings around a projected vertex within which a tip (offset without a ball of its own) is projected too. */
const TIP_ABSORB_RINGS = 2;
/** Jacobi passes smoothing the projected vertices' positions (the offset ones fixed). */
const PROJECTED_SMOOTHING = 3;
/** Soft-minimum width (mm of surface gap) over which a projected vertex blends the nearest fitting balls. */
const BALL_BLEND_MM = 0.02;
/** Repair: rounds of local displacement-field smoothing around self-intersecting faces, and the rings around them. */
const FOLD_REPAIR_ROUNDS = 8;
const FOLD_REPAIR_RINGS = 3;
/** Repair rounds that smooth the displacement field before the rest relax the framework positions. */
const FOLD_REPAIR_FIELD_ROUNDS = 4;
/** Projected or relaxed vertices closer than their veneer minus this (mm) are moved back out to it. */
const CLEARANCE_TOLERANCE_MM = 0.005;
/** Passes moving framework triangles that cut a concave crease away from the anatomy. */
const VENEER_CLEARANCE_PASSES = 3;
/** Bisection steps of the protection's retraction along the cut (1/2^n of the cut depth). */
const RETRACT_STEPS = 8;
/** Mask values below this count as not cut back. */
const MASK_EPSILON = 1e-3;

/**
 * The surface to cut back: a closed anatomic unit (crown or pontic) whose
 * outer surface is the vertex range [outerStart, outerEnd). Faces with all
 * three corners in that range form the outer surface; everything else (a
 * crown's intaglio and margin band, a pontic's ridge base) never moves.
 */
export interface CutbackSurface {
  /** The finished anatomic unit, a closed solid. Never modified. */
  mesh: IndexedMesh;
  outerStart: number;
  outerEnd: number;
  /** Per outer vertex (local id = vertex − outerStart): 0 at the cervix → 1 at the cusp tips or incisal edge. */
  heightFraction: Float32Array;
  /**
   * Local ids of the loop the collar is measured from (a crown's outer margin
   * loop, the rim where a pontic's shell meets its base). They never move.
   */
  cervicalLoop: ArrayLike<number>;
  /** Per outer vertex (local id): 1 = never cut back, e.g. a pontic's ridge base when it lies in the outer range. */
  keep?: Uint8Array;
  /**
   * Also kept at full contour (feathered): the outer surface facing one of these directions (smoothed normal ·
   * direction ≥ minDot) within a height-fraction band, e.g. a bridge unit's proximal side where a connector joins it.
   */
  keepFacing?: Array<{ direction: V3; minDot: number; heightFraction: [number, number] }>;
  /** Unit buccal (labial) direction of the tooth frame, for the facial mode. */
  buccal: V3;
  /** Fitting surface for the thickness protection (crowns). Omitted for pontics: they are solid. */
  fitting?: { intaglio: IntaglioSurface; marginLoop: Float32Array };
}

/** Framework material: its minimum thickness (protection, and twice the rounding radius of reduced edges). */
export type FrameworkParams = ThicknessParams;

export interface VeneerShortfall {
  /**
   * Cut-back outer vertices that the thickness protection moved back by more
   * than VENEER_TOLERANCE_MM, or whose measured veneer it left more than that
   * thinner than requested (and than before the protection).
   */
  vertices: number;
  /** Their area on the anatomy (one third of each incident outer face). */
  areaMm2: number;
  /** Smallest measured veneer space among them. */
  minVeneerMm: number;
  /** Largest requested − measured veneer among them. */
  maxDeficitMm: number;
  /** Area-weighted centroid on the anatomy, to focus the view. */
  at: V3;
}

/**
 * Measured veneer space (anatomy → framework outer surface) on the interior of
 * the full cutback (no partly cut vertex within the thickness, straight
 * line), outside the shortfall.
 */
export interface VeneerStats {
  vertices: number;
  minMm: number;
  meanMm: number;
  maxMm: number;
  /** Fraction of those vertices within the requested thickness ± VENEER_TOLERANCE_MM. */
  withinTolerance: number;
  /** Vertices below the requested thickness − tolerance (expected 0). */
  thinVertices: number;
  /**
   * Vertices above the requested thickness + tolerance: features thinner or
   * sharper than the cutback (incisal edges, sharp ridges), where the
   * framework is reduced further and the veneer is thicker.
   */
  thickVertices: number;
  thickAreaMm2: number;
  /** Of those, the vertices offset (not projected): the regular region, where the veneer is S by construction. */
  offsetVertices: number;
  /** Fraction of the offset vertices within the requested thickness ± VENEER_TOLERANCE_MM. */
  offsetWithinTolerance: number;
  /** Largest veneer anywhere on the cutback (incisal porcelain). */
  maxAnywhereMm: number;
}

export interface CutbackResult {
  /** The reduced unit: the anatomy's vertices and faces, with the outer surface moved inward. A closed solid. */
  mesh: IndexedMesh;
  settings: CutbackSettings;
  /** Per outer vertex: feathered cutback weight 0…1. */
  mask: Float32Array;
  /** Per outer vertex: requested inward displacement, thicknessMm × mask. */
  requestedMm: Float32Array;
  /** Per outer vertex: measured veneer space (anatomy vertex → framework outer surface); 0 where nothing is cut back. */
  veneerMm: Float32Array;
  /**
   * Per outer vertex: 1 where the veneer statistics or the shortfall count it (the full cutback away from the
   * shoulder), 0 at the collar and over the taper to it (the feather and the veneer measured to the shoulder).
   */
  veneerCounted: Uint8Array;
  veneer: VeneerStats;
  /** Present when the framework minimum leaves less than the requested veneer somewhere ("insufficient veneering space"). */
  shortfall?: VeneerShortfall;
  /**
   * Thickness protection: vertices retracted along their cut to the framework
   * profile, vertices enforceThickness still pushed, the largest total move
   * back (mm), and the smallest thickness − profile after (≥ 0 = satisfied).
   */
  protection?: { retractedVertices: number; pushedVertices: number; maxPushMm: number; minSlackMm: number };
  /**
   * Vertices on features thinner or sharper than the cutback (the inner ball
   * of radius thickness + ρ does not fit under them), projected onto the
   * nearest fitting ball instead of offset.
   */
  projectedVertices: number;
  /** Self-intersecting faces repaired by smoothing the displacement field around them (summed over rounds). */
  repairedFaces: number;
  validation: CrownValidation;
  warnings: string[];
  timingsMs: Record<string, number>;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Outer faces (local vertex ids): the faces with all corners in [outerStart, outerEnd). */
export function outerFaces(surface: Pick<CutbackSurface, 'mesh' | 'outerStart' | 'outerEnd'>): Uint32Array {
  const { outerStart: s, outerEnd: e } = surface;
  const idx = surface.mesh.indices;
  const out: number[] = [];
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f]!, b = idx[f + 1]!, c = idx[f + 2]!;
    if (a >= s && a < e && b >= s && b < e && c >= s && c < e) out.push(a - s, b - s, c - s);
  }
  return Uint32Array.from(out);
}

/** Geodesic (edge-path) distance over the outer graph from the source vertices (local ids). */
function geodesicFrom(sources: Iterable<number>, graph: SurfaceGraph, P: Float32Array, start: number, n: number, limit = Infinity): Float64Array {
  const dist = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap();
  for (const v of sources) {
    dist[v] = 0;
    heap.push(0, v);
  }
  const top: [number, number] = [0, 0];
  while (heap.size > 0) {
    heap.pop(top);
    const [d, u] = top;
    if (d > dist[u]!) continue;
    const pu = (start + u) * 3;
    for (let k = graph.offsets[u]!; k < graph.offsets[u + 1]!; k++) {
      const v = graph.neighbors[k]!;
      const pv = (start + v) * 3;
      const nd = d + Math.hypot(P[pv]! - P[pu]!, P[pv + 1]! - P[pu + 1]!, P[pv + 2]! - P[pu + 2]!);
      if (nd < dist[v]! && nd <= limit) {
        dist[v] = nd;
        heap.push(nd, v);
      }
    }
  }
  return dist;
}

/** Area-weighted normals of the outer faces (local ids), smoothed `passes` times over the outer graph. */
function outerNormals(P: Float32Array, start: number, n: number, faces: Uint32Array, graph: SurfaceGraph, passes: number): Float32Array {
  let N = new Float32Array(n * 3);
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f]!, b = faces[f + 1]!, c = faces[f + 2]!;
    const pa = (start + a) * 3, pb = (start + b) * 3, pc = (start + c) * 3;
    const ux = P[pb]! - P[pa]!, uy = P[pb + 1]! - P[pa + 1]!, uz = P[pb + 2]! - P[pa + 2]!;
    const vx = P[pc]! - P[pa]!, vy = P[pc + 1]! - P[pa + 1]!, vz = P[pc + 2]! - P[pa + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      N[v * 3] = N[v * 3]! + nx;
      N[v * 3 + 1] = N[v * 3 + 1]! + ny;
      N[v * 3 + 2] = N[v * 3 + 2]! + nz;
    }
  }
  const normalizeAll = (A: Float32Array) => {
    for (let v = 0; v < n; v++) {
      const l = Math.hypot(A[v * 3]!, A[v * 3 + 1]!, A[v * 3 + 2]!) || 1;
      A[v * 3] = A[v * 3]! / l;
      A[v * 3 + 1] = A[v * 3 + 1]! / l;
      A[v * 3 + 2] = A[v * 3 + 2]! / l;
    }
  };
  normalizeAll(N);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) {
      let x = N[v * 3]!, y = N[v * 3 + 1]!, z = N[v * 3 + 2]!;
      for (let k = graph.offsets[v]!; k < graph.offsets[v + 1]!; k++) {
        const u = graph.neighbors[k]! * 3;
        x += N[u]!;
        y += N[u + 1]!;
        z += N[u + 2]!;
      }
      next[v * 3] = x;
      next[v * 3 + 1] = y;
      next[v * 3 + 2] = z;
    }
    normalizeAll(next);
    N = next;
  }
  return N;
}

/** Per outer vertex: one third of the area of each incident outer face. */
function vertexAreas(P: Float32Array, start: number, n: number, faces: Uint32Array): Float64Array {
  const area = new Float64Array(n);
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f]!, b = faces[f + 1]!, c = faces[f + 2]!;
    const pa = (start + a) * 3, pb = (start + b) * 3, pc = (start + c) * 3;
    const ux = P[pb]! - P[pa]!, uy = P[pb + 1]! - P[pa + 1]!, uz = P[pb + 2]! - P[pa + 2]!;
    const vx = P[pc]! - P[pa]!, vy = P[pc + 1]! - P[pa + 1]!, vz = P[pc + 2]! - P[pa + 2]!;
    const third = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6;
    area[a] = area[a]! + third;
    area[b] = area[b]! + third;
    area[c] = area[c]! + third;
  }
  return area;
}

export interface CutbackMask {
  /** Per outer vertex: 0 (full contour) … 1 (cut back by the full thickness), feathered over CUTBACK_FEATHER_MM. */
  mask: Float32Array;
  /** Per outer vertex: geodesic distance from the cervical loop (mm). */
  collarDistanceMm: Float64Array;
}

/**
 * Cutback weight per outer vertex. The mode selects a region (full: all;
 * facial: n·buccal > 0.3 on the smoothed normals, plus the occlusal third;
 * occlusal: height fraction ≥ 0.7). The region's edge is feathered outward
 * over CUTBACK_FEATHER_MM (smoothstep of the geodesic distance from the
 * region); the collar (within collarMm of the cervical loop, geodesic),
 * `keep` and `keepFacing` are excluded, feathered inward. So the reduced
 * surface meets the full contour in a smooth shoulder. (Outward, because a
 * library tooth may be coarse just inside the occlusal third: the synthetic
 * posterior template has a 0.6 mm edge from its table rim to the first
 * occlusal ring, longer than the feather.)
 */
export function cutbackMask(
  surface: CutbackSurface,
  settings: Pick<CutbackSettings, 'mode' | 'collarMm'>,
  prepared?: { graph: SurfaceGraph; normals: Float32Array },
): CutbackMask {
  const { mesh, outerStart: start } = surface;
  const n = surface.outerEnd - start;
  const P = mesh.positions;
  const graph = prepared?.graph ?? buildVertexAdjacency(outerFaces(surface), n);
  const normals = prepared?.normals ?? outerNormals(P, start, n, outerFaces(surface), graph, NORMAL_SMOOTHING);
  const collarDistanceMm = geodesicFrom(Array.from(surface.cervicalLoop), graph, P, start, n);

  // The mode's region (the threshold is inclusive: template heights are float32), and the distance from it.
  const occlusalThird = (h: number) => h >= CUTBACK_OCCLUSAL_HEIGHT - 1e-6;
  const inRegion: number[] = [];
  for (let v = 0; v < n; v++) {
    const h = surface.heightFraction[v]!;
    let inside = settings.mode === 'full';
    if (settings.mode === 'occlusal') inside = occlusalThird(h);
    if (settings.mode === 'facial') {
      const nb = normals[v * 3]! * surface.buccal[0] + normals[v * 3 + 1]! * surface.buccal[1] + normals[v * 3 + 2]! * surface.buccal[2];
      inside = occlusalThird(h) || nb > CUTBACK_FACIAL_MIN_DOT;
    }
    if (inside) inRegion.push(v);
  }
  const regionDistance = geodesicFrom(inRegion, graph, P, start, n, CUTBACK_FEATHER_MM * 2);

  // Kept at full contour: `keep`, and the surfaces facing a keepFacing direction within its height band; feathered
  // inward like the collar.
  const kept: number[] = [];
  for (let v = 0; v < n; v++) {
    const h = surface.heightFraction[v]!;
    const facing = (surface.keepFacing ?? []).some(
      (k) =>
        h >= k.heightFraction[0] &&
        h <= k.heightFraction[1] &&
        normals[v * 3]! * k.direction[0] + normals[v * 3 + 1]! * k.direction[1] + normals[v * 3 + 2]! * k.direction[2] >= k.minDot,
    );
    if (surface.keep?.[v] || facing) kept.push(v);
  }
  const keptDistance = kept.length > 0 ? geodesicFrom(kept, graph, P, start, n, CUTBACK_FEATHER_MM * 2) : null;

  const mask = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    if (surface.keep?.[v]) continue;
    const collar = smoothstep(settings.collarMm, settings.collarMm + CUTBACK_FEATHER_MM, collarDistanceMm[v]!);
    const region = 1 - smoothstep(0, CUTBACK_FEATHER_MM, regionDistance[v]!);
    const keep = keptDistance ? smoothstep(0, CUTBACK_FEATHER_MM, keptDistance[v]!) : 1;
    mask[v] = collar * region * keep;
  }
  return { mask, collarDistanceMm };
}

/**
 * Cut back an anatomic unit. Returns the reduced unit (same topology, a
 * closed solid when the anatomy is), the measured veneer space, and the
 * shortfall where the framework minimum wins over the requested veneer.
 */
export function cutBack(surface: CutbackSurface, settings: CutbackSettings, framework: FrameworkParams): CutbackResult {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = now - t;
    t = now;
  };
  const warnings: string[] = [];
  const { mesh, outerStart: start } = surface;
  const n = surface.outerEnd - start;
  const A = mesh.positions;
  const faces = outerFaces(surface);
  const graph = buildVertexAdjacency(faces, n);
  const normals = outerNormals(A, start, n, faces, graph, NORMAL_SMOOTHING);
  const { mask } = cutbackMask(surface, settings, { graph, normals });
  const fixed = new Uint8Array(n);
  for (let i = 0; i < surface.cervicalLoop.length; i++) fixed[surface.cervicalLoop[i]!] = 1;
  const requestedMm = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    if (fixed[v] || surface.keep?.[v] || mask[v]! < MASK_EPSILON) mask[v] = 0;
    requestedMm[v] = settings.thicknessMm * mask[v]!;
  }
  lap('mask');

  // Placement, at the full thickness S; each vertex then moves by its mask times that (the feather). The reduced
  // surface is the boundary of F = (A ⊖ B(S + ρ)) ⊕ B(ρ): the union of the inner balls of radius R = S + ρ that fit
  // under the outer surface, shrunk by S.
  // - A vertex whose own ball fits (one closest-point query from the ball centre) is offset by S along its normal.
  // - So is a convex tip or ridge whose radius lies between S and R (the ball pokes out on the same side, but one of
  //   radius S + ε fits and the unit is at least 2R thick there): the rounding ρ is only needed where the unit is thin.
  // - Anywhere else (an incisal edge thinner than 2R, a ridge sharper than S) the plain offset would fold or cross
  //   the other side, so the vertex goes to its closest point on F: the nearest fitting balls' shrunk spheres. Vertices
  //   that share a ball spread over its sphere in the order they had: the feature is reduced further (an incisal edge
  //   is shortened to where the framework is at least 2ρ thick) and the veneer there is thicker, never thinner.
  const rho = Math.max(0.05, framework.minThicknessMm / 2);
  const S = settings.thicknessMm;
  const R = S + rho;
  let maxRequested = 0;
  for (let v = 0; v < n; v++) maxRequested = Math.max(maxRequested, requestedMm[v]!);
  const outerIndices = new Uint32Array(faces.length);
  for (let i = 0; i < faces.length; i++) outerIndices[i] = faces[i]! + start;
  const outerBvhIndices = outerIndices.slice();
  const outerRay = bvhRayCaster(createBvh({ positions: A, indices: outerBvhIndices }));
  /** Outward normal of an outer face as the BVH numbers it. */
  const faceNormal = (f: number): V3 => {
    const ia = outerBvhIndices[f * 3]! * 3, ib = outerBvhIndices[f * 3 + 1]! * 3, ic = outerBvhIndices[f * 3 + 2]! * 3;
    return triNormal(A[ia]!, A[ia + 1]!, A[ia + 2]!, A[ib]!, A[ib + 1]!, A[ib + 2]!, A[ic]!, A[ic + 1]!, A[ic + 2]!);
  };
  /** q moved out to `depth` from the outer surface (away from its closest point), or null when it is that deep. */
  const clearance = (q: V3, depth: number): V3 | null => {
    const cp = outerRay.closestPoint(q, depth);
    if (!cp || cp.distance >= depth - CLEARANCE_TOLERANCE_MM || cp.distance < 1e-6) return null;
    const f = depth / cp.distance;
    return [cp.point[0] + (q[0] - cp.point[0]) * f, cp.point[1] + (q[1] - cp.point[1]) * f, cp.point[2] + (q[2] - cp.point[2]) * f];
  };
  lap('prepare');

  /** Per outer vertex: the full-thickness displacement (mask 1). */
  const full = new Float64Array(n * 3);
  const centre = new Float64Array(n * 3);
  const fits = new Uint8Array(n);
  /** Offset although the ball pokes out (a convex tip or ridge): no ball of its own in F. */
  const tip = new Uint8Array(n);
  const thinMask = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    if (requestedMm[v]! <= 0) continue;
    const o = (start + v) * 3;
    const nx = normals[v * 3]!, ny = normals[v * 3 + 1]!, nz = normals[v * 3 + 2]!;
    const x: V3 = [A[o]! - nx * R, A[o + 1]! - ny * R, A[o + 2]! - nz * R];
    const cp = outerRay.closestPoint(x, R + 1);
    if (cp && cp.distance < R - BALL_TOLERANCE_MM) {
      const fn = faceNormal(cp.faceIndex);
      let offset = false;
      if (fn[0] * nx + fn[1] * ny + fn[2] * nz > 0) {
        const r = S + CURVATURE_MARGIN_MM;
        const near = outerRay.closestPoint([A[o]! - nx * r, A[o + 1]! - ny * r, A[o + 2]! - nz * r], r);
        if (!near || near.distance >= r - BALL_TOLERANCE_MM) {
          offset = !outerRay.first([A[o]! - nx * 1e-3, A[o + 1]! - ny * 1e-3, A[o + 2]! - nz * 1e-3], [-nx, -ny, -nz], 2 * R);
        }
      }
      if (!offset) {
        thinMask[v] = 1;
        continue;
      }
      tip[v] = 1;
    } else {
      fits[v] = 1;
      centre.set(x, v * 3);
    }
    // Offset along the (smoothed) normal, as deep as it takes to be exactly S from the outer surface: next to a sharp
    // feature the smoothed normal is tilted and S along it would leave only S·cos(tilt). Moving each vertex along its
    // own direction keeps the vertex order (snapping to the closest surface point would pile vertices up on the
    // feature). Secant steps on t ↦ distance(p − t·n), between S and the depth of the ball that fits.
    const cap = fits[v] ? R : S + CURVATURE_MARGIN_MM;
    const depthAt = (t: number) => outerRay.closestPoint([A[o]! - nx * t, A[o + 1]! - ny * t, A[o + 2]! - nz * t], S + 1)?.distance ?? S + 1;
    let t = S;
    let d = depthAt(t);
    for (let it = 0; it < 3 && Math.abs(d - S) > 0.002; it++) {
      t = Math.min(cap, Math.max(S, (t * S) / Math.max(d, 1e-3)));
      d = depthAt(t);
    }
    full[v * 3] = -nx * t;
    full[v * 3 + 1] = -ny * t;
    full[v * 3 + 2] = -nz * t;
  }
  // A tip next to a projected vertex is projected too: it has no ball, so projected vertices beside it would jump
  // past it to the balls beyond.
  for (let ring = 0; ring < TIP_ABSORB_RINGS; ring++) {
    const grow = thinMask.slice();
    for (let v = 0; v < n; v++) {
      if (!thinMask[v]) continue;
      for (let k = graph.offsets[v]!; k < graph.offsets[v + 1]!; k++) if (tip[graph.neighbors[k]!]) grow[graph.neighbors[k]!] = 1;
    }
    thinMask.set(grow);
  }
  const thin: number[] = [];
  for (let v = 0; v < n; v++) if (thinMask[v]) thin.push(v);
  if (thin.length > 0) {
    const balls = new BallIndex(centre, fits, R);
    for (const v of thin) {
      const o = (start + v) * 3;
      const p: V3 = [A[o]!, A[o + 1]!, A[o + 2]!];
      // The closest points on the near-best balls' shrunk spheres (radius ρ), blended by a soft minimum of the gap,
      // so neighbours never jump between two balls.
      const near = balls.near(p, BALL_BLEND_MM * 4);
      if (near.length === 0) continue; // nothing fits anywhere: the vertex keeps the full contour
      const best = near[1]!;
      let wsum = 0;
      const q: V3 = [0, 0, 0];
      for (let k = 0; k < near.length; k += 2) {
        const u = near[k]!;
        const w = Math.exp(-(near[k + 1]! - best) / BALL_BLEND_MM);
        const dx = p[0] - centre[u * 3]!, dy = p[1] - centre[u * 3 + 1]!, dz = p[2] - centre[u * 3 + 2]!;
        const d = Math.hypot(dx, dy, dz) || 1;
        q[0] += w * (centre[u * 3]! + (dx * rho) / d);
        q[1] += w * (centre[u * 3 + 1]! + (dy * rho) / d);
        q[2] += w * (centre[u * 3 + 2]! + (dz * rho) / d);
        wsum += w;
      }
      for (let k = 0; k < 3; k++) full[v * 3 + k] = q[k]! / wsum - p[k]!;
    }
    // A light smoothing of the projected vertices' displacement (the offset ones are its boundary) evens out the
    // blend along a ridge; on the convex rounded ridge it can only move the surface inward (a thicker veneer).
    for (let pass = 0; pass < PROJECTED_SMOOTHING; pass++) {
      const next = full.slice();
      for (const v of thin) {
        const s0 = graph.offsets[v]!, s1 = graph.offsets[v + 1]!;
        if (s1 === s0) continue;
        for (let k = 0; k < 3; k++) {
          let sum = 0;
          for (let j = s0; j < s1; j++) {
            const u = graph.neighbors[j]!;
            // Neighbours positions, not displacements: the projected surface is a new shape, not the anatomy moved.
            sum += A[(start + u) * 3 + k]! + full[u * 3 + k]!;
          }
          next[v * 3 + k] = 0.5 * full[v * 3 + k]! + 0.5 * (sum / (s1 - s0) - A[(start + v) * 3 + k]!);
        }
      }
      full.set(next);
    }
    // The smoothing rounds the eroded body's concave creases (a fissure) toward the anatomy: move any projected vertex
    // left closer than S back out to it, away from its closest anatomic point.
    for (const v of thin) {
      const o = (start + v) * 3;
      const q: V3 = [A[o]! + full[v * 3]!, A[o + 1]! + full[v * 3 + 1]!, A[o + 2]! + full[v * 3 + 2]!];
      const cleared = clearance(q, S);
      if (cleared) for (let k = 0; k < 3; k++) full[v * 3 + k] = cleared[k]! - A[o + k]!;
    }
  }
  const Q = new Float64Array(n * 3);
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) Q[v * 3 + k] = A[(start + v) * 3 + k]! + mask[v]! * full[v * 3 + k]!;
  lap('place');

  const free = (v: number) => !fixed[v] && requestedMm[v]! > 0;
  const positions = A.slice();
  for (let v = 0; v < n; v++) {
    if (!free(v)) continue;
    for (let k = 0; k < 3; k++) positions[(start + v) * 3 + k] = Q[v * 3 + k]!;
  }

  // Veneer space, measured: anatomic outer vertex → the framework's outer surface (the outer faces at `at`).
  // `onShoulder` (optional): set to 1 where the closest framework face has a partly cut corner, i.e. the veneer is
  // measured to the feathered shoulder, which slopes up to the full contour by design.
  const measureVeneer = (at: Float32Array, onShoulder?: Uint8Array): Float32Array => {
    const index = outerIndices.slice();
    const ray = bvhRayCaster(createBvh({ positions: at, indices: index }));
    const out = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      if (requestedMm[v]! <= 0) continue;
      const p: V3 = [A[(start + v) * 3]!, A[(start + v) * 3 + 1]!, A[(start + v) * 3 + 2]!];
      const cp = ray.closestPoint(p, 2 * maxRequested + 2 * rho + 1);
      out[v] = cp ? cp.distance : Number.NaN;
      if (onShoulder && cp && cp.faceIndex >= 0) {
        for (let k = 0; k < 3; k++) if (mask[index[cp.faceIndex * 3 + k]! - start]! < 0.999) onShoulder[v] = 1;
      }
    }
    return out;
  };

  // Veneer clearance: across a sharp concave crease of the eroded body (a fissure) the framework's flat triangles cut
  // the corner, nearer the anatomy than S although their vertices are S deep. Where a fully cut anatomic vertex is
  // nearer the framework than its veneer, the closest framework triangle moves away from it by the deficit.
  for (let pass = 0; pass < VENEER_CLEARANCE_PASSES; pass++) {
    const index = outerIndices.slice();
    const ray = bvhRayCaster(createBvh({ positions: positions.slice(), indices: index }));
    const moves = new Map<number, V3>();
    for (let v = 0; v < n; v++) {
      const want = requestedMm[v]!;
      if (mask[v]! < 0.999 || want <= 0) continue;
      const o = (start + v) * 3;
      const p: V3 = [A[o]!, A[o + 1]!, A[o + 2]!];
      const cp = ray.closestPoint(p, want);
      if (!cp || cp.faceIndex < 0 || cp.distance >= want - CLEARANCE_TOLERANCE_MM || cp.distance < 1e-6) continue;
      const deficit = want - cp.distance;
      const dir: V3 = [(cp.point[0] - p[0]) / cp.distance, (cp.point[1] - p[1]) / cp.distance, (cp.point[2] - p[2]) / cp.distance];
      for (let k = 0; k < 3; k++) {
        const u = index[cp.faceIndex * 3 + k]! - start;
        if (!free(u) || mask[u]! < 0.999) continue;
        const m = moves.get(u);
        if (!m || deficit > Math.hypot(m[0], m[1], m[2])) moves.set(u, [dir[0] * deficit, dir[1] * deficit, dir[2] * deficit]);
      }
    }
    if (moves.size === 0) break;
    for (const [u, m] of moves) for (let k = 0; k < 3; k++) positions[(start + u) * 3 + k] = positions[(start + u) * 3 + k]! + m[k]!;
  }
  lap('clearance');
  // Measured to the shoulder before or after the protection (the statistics leave these out; see below).
  const onShoulder = new Uint8Array(n);
  const unprotectedVeneer = surface.fitting ? measureVeneer(positions.slice(), onShoulder) : undefined;

  // Thickness protection: the framework minimum above the fitting surface wins over the veneer. Each vertex that is
  // too close to the fitting surface is first retracted along its own cut to where the framework profile holds
  // (bisection), so the framework there follows the anatomy at the framework minimum and neighbours move together;
  // enforceThickness then guarantees the profile (small pushes, if any). `only` limits it to a repaired region.
  const still = new Uint8Array(n);
  for (let v = 0; v < n; v++) still[v] = free(v) ? 0 : 1;
  const retractedMask = new Uint8Array(n);
  let enforced: ReturnType<typeof enforceThickness> | undefined;
  /** Per outer vertex: the largest move back made by the protection (mm). */
  const push = new Float32Array(n);
  const protect = (only?: Uint8Array) => {
    if (!surface.fitting) return;
    const before = positions.slice(start * 3, surface.outerEnd * 3);
    const { intaglio, marginLoop } = surface.fitting;
    const reach = framework.minThicknessMm + 2;
    const slack = (x: V3): number => {
      const sd = signedIntaglioDistance(x, intaglio, reach);
      return sd ? sd.distance - thicknessProfile(distanceToLoop(x, marginLoop), framework) : Infinity;
    };
    for (let v = 0; v < n; v++) {
      if (!free(v) || (only && !only[v])) continue;
      const o = (start + v) * 3;
      const p: V3 = [A[o]!, A[o + 1]!, A[o + 2]!];
      const d: V3 = [positions[o]! - p[0], positions[o + 1]! - p[1], positions[o + 2]! - p[2]];
      const at = (t: number): V3 => [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
      if (slack(at(1)) >= 0) continue;
      let lo = 0, hi = 1;
      if (slack(at(0)) < 0) hi = 0;
      for (let it = 0; it < RETRACT_STEPS && hi > 0; it++) {
        const mid = (lo + hi) / 2;
        if (slack(at(mid)) >= 0) lo = mid;
        else hi = mid;
      }
      const q = at(lo);
      positions[o] = q[0];
      positions[o + 1] = q[1];
      positions[o + 2] = q[2];
      retractedMask[v] = 1;
    }
    enforced = enforceThickness({
      positions,
      vertexStart: start,
      vertexEnd: surface.outerEnd,
      intaglio,
      marginLoop,
      params: framework,
      shellGraph: graph,
      fixed: still,
    });
    for (let v = 0; v < n; v++) {
      const o = (start + v) * 3;
      const moved = Math.hypot(positions[o]! - before[v * 3]!, positions[o + 1]! - before[v * 3 + 1]!, positions[o + 2]! - before[v * 3 + 2]!);
      push[v] = Math.max(push[v]!, moved);
    }
  };
  protect();
  lap('protect');

  // Repair: where the reduced surface intersects itself (a fold where projected and offset vertices meet, or where
  // the protection retracted neighbours by different amounts), smooth the displacement field (never the anatomy)
  // over the faces involved and a few rings around them, protect that region again, and re-check.
  const reduced: IndexedMesh = { positions, indices: mesh.indices };
  let intersections = countSelfIntersections(reduced, { maxPairs: 4096 });
  let repairedFaces = 0;
  for (let round = 0; round < FOLD_REPAIR_ROUNDS && intersections.count > 0; round++) {
    let region = new Uint8Array(n);
    for (const pair of intersections.pairs) {
      for (const f of pair) {
        repairedFaces++;
        for (let k = 0; k < 3; k++) {
          const v = mesh.indices[f * 3 + k]! - start;
          if (v >= 0 && v < n) region[v] = 1;
        }
      }
    }
    for (let ring = 0; ring < FOLD_REPAIR_RINGS; ring++) {
      const grow = region.slice();
      for (let v = 0; v < n; v++) {
        if (!region[v]) continue;
        for (let k = graph.offsets[v]!; k < graph.offsets[v + 1]!; k++) grow[graph.neighbors[k]!] = 1;
      }
      region = grow;
    }
    // The first rounds smooth the displacement field (keeping the anatomy's shape); a fold that survives them sits
    // where the offset compresses tiny triangles (a saddle whose convex radius is close to the cutback), and the
    // later rounds relax the framework positions there tangentially (the move toward the neighbours' centroid
    // without its component along the surface normal), which untangles it without moving the surface itself.
    const tangential = round >= FOLD_REPAIR_FIELD_ROUNDS;
    for (let pass = 0; pass < 4; pass++) {
      const next = positions.slice(start * 3, surface.outerEnd * 3);
      for (let v = 0; v < n; v++) {
        if (!region[v] || !free(v)) continue;
        const s0 = graph.offsets[v]!, s1 = graph.offsets[v + 1]!;
        const move: V3 = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          let sum = 0;
          for (let j = s0; j < s1; j++) {
            const u = graph.neighbors[j]!;
            sum += positions[(start + u) * 3 + k]! - (tangential ? 0 : A[(start + u) * 3 + k]!);
          }
          const own = positions[(start + v) * 3 + k]! - (tangential ? 0 : A[(start + v) * 3 + k]!);
          move[k] = 0.5 * (sum / Math.max(1, s1 - s0) - own);
        }
        if (tangential) {
          const along = move[0] * normals[v * 3]! + move[1] * normals[v * 3 + 1]! + move[2] * normals[v * 3 + 2]!;
          for (let k = 0; k < 3; k++) move[k] = move[k]! - along * normals[v * 3 + k]!;
        }
        for (let k = 0; k < 3; k++) next[v * 3 + k] = positions[(start + v) * 3 + k]! + move[k]!;
      }
      positions.set(next, start * 3);
    }
    {
      // Smoothing a displacement field whose directions vary shortens it, and relaxation keeps the surface only to
      // first order: where a fully cut vertex came closer than its veneer, it moves back out (not where the protection
      // moved it back: the framework minimum wins there).
      for (let v = 0; v < n; v++) {
        if (!region[v] || !free(v) || mask[v]! < 0.999 || push[v]! > VENEER_TOLERANCE_MM) continue;
        const o = (start + v) * 3;
        const cleared = clearance([positions[o]!, positions[o + 1]!, positions[o + 2]!], requestedMm[v]!);
        if (cleared) for (let k = 0; k < 3; k++) positions[o + k] = cleared[k]!;
      }
    }
    protect(region);
    intersections = countSelfIntersections(reduced, { maxPairs: 4096 });
  }
  lap('repair');

  let maxPush = 0;
  for (let v = 0; v < n; v++) maxPush = Math.max(maxPush, push[v]!);
  let protection: CutbackResult['protection'];
  if (enforced) {
    let retracted = 0;
    for (let v = 0; v < n; v++) retracted += retractedMask[v]!;
    protection = { retractedVertices: retracted, pushedVertices: enforced.pushedVertices, maxPushMm: maxPush, minSlackMm: enforced.minSlackAfterMm };
    if (enforced.minSlackAfterMm < -0.02) {
      warnings.push(`The framework is ${(-enforced.minSlackAfterMm).toFixed(2)} mm thinner than its minimum in places after protection.`);
    }
  }

  const closed = validateClosedMesh(reduced);
  const selfIntersections = intersections.count;
  const validation: CrownValidation = { ...closed, selfIntersections, printable: closed.ok && selfIntersections === 0 };
  if (!closed.ok) warnings.push('The framework mesh is not a valid closed solid; see the validation report.');
  else if (selfIntersections > 0) warnings.push(`The framework surface intersects itself (${selfIntersections} triangle pairs).`);
  lap('validate');

  // The statistics cover the interior of the full cutback: fully cut vertices whose closest framework face is fully
  // cut too, before and after the protection. Next to the feathered edge the veneer is measured to the shoulder,
  // which slopes up to the full contour, so it is nearer than the requested thickness by construction (and where the
  // protection then moved the faces beside the shoulder, the closest face can change to one of those).
  const veneerMm = measureVeneer(positions, onShoulder);
  const areas = vertexAreas(A, start, n, faces);
  const interior = (v: number) => mask[v]! >= 0.999 && !onShoulder[v];
  const veneerCounted = new Uint8Array(n);
  const short = { vertices: 0, areaMm2: 0, minVeneerMm: Infinity, maxDeficitMm: 0, at: [0, 0, 0] as V3 };
  const stats = { vertices: 0, sum: 0, min: Infinity, max: -Infinity, within: 0, thin: 0, thick: 0, thickArea: 0, maxAnywhere: 0, offset: 0, offsetWithin: 0 };
  for (let v = 0; v < n; v++) {
    const want = requestedMm[v]!;
    if (want <= 0) continue;
    const got = veneerMm[v]!;
    if (Number.isFinite(got)) stats.maxAnywhere = Math.max(stats.maxAnywhere, got);
    // A shortfall: the protection moved the vertex back, or a neighbour's move left its veneer thinner than requested
    // and than before the protection (in the feather it was already below the request: the shoulder slopes).
    const reference = unprotectedVeneer ? Math.min(want, unprotectedVeneer[v]!) : want;
    if (unprotectedVeneer && (push[v]! > VENEER_TOLERANCE_MM || got < reference - VENEER_TOLERANCE_MM)) {
      short.vertices++;
      short.areaMm2 += areas[v]!;
      short.minVeneerMm = Math.min(short.minVeneerMm, got);
      short.maxDeficitMm = Math.max(short.maxDeficitMm, push[v]!, want - got);
      for (let k = 0; k < 3; k++) short.at[k] = short.at[k]! + areas[v]! * A[(start + v) * 3 + k]!;
      veneerCounted[v] = 1;
      continue;
    }
    if (!Number.isFinite(got) || !interior(v)) continue;
    veneerCounted[v] = 1;
    stats.vertices++;
    stats.sum += got;
    stats.min = Math.min(stats.min, got);
    stats.max = Math.max(stats.max, got);
    const within = Math.abs(got - want) <= VENEER_TOLERANCE_MM;
    if (got < want - VENEER_TOLERANCE_MM) stats.thin++;
    else if (got > want + VENEER_TOLERANCE_MM) {
      stats.thick++;
      stats.thickArea += areas[v]!;
    } else stats.within++;
    if (!thinMask[v]) {
      stats.offset++;
      if (within) stats.offsetWithin++;
    }
  }
  const veneer: VeneerStats = {
    vertices: stats.vertices,
    minMm: stats.vertices ? stats.min : Number.NaN,
    meanMm: stats.vertices ? stats.sum / stats.vertices : Number.NaN,
    maxMm: stats.vertices ? stats.max : Number.NaN,
    withinTolerance: stats.vertices ? stats.within / stats.vertices : Number.NaN,
    thinVertices: stats.thin,
    thickVertices: stats.thick,
    thickAreaMm2: stats.thickArea,
    offsetVertices: stats.offset,
    offsetWithinTolerance: stats.offset ? stats.offsetWithin / stats.offset : Number.NaN,
    maxAnywhereMm: stats.maxAnywhere,
  };
  let shortfall: VeneerShortfall | undefined;
  if (short.vertices > 0) {
    shortfall = { ...short, at: [short.at[0] / short.areaMm2, short.at[1] / short.areaMm2, short.at[2] / short.areaMm2] };
    warnings.push(
      `Insufficient veneering space: ${short.areaMm2.toFixed(1)} mm² where the framework minimum (${framework.minThicknessMm} mm) ` +
        `leaves less than ${settings.thicknessMm} mm of veneer (smallest ${short.minVeneerMm.toFixed(2)} mm).`,
    );
  }
  if (veneer.maxAnywhereMm > MAX_UNSUPPORTED_VENEER_MM) {
    warnings.push(`The veneer reaches ${veneer.maxAnywhereMm.toFixed(1)} mm (unsupported porcelain above ${MAX_UNSUPPORTED_VENEER_MM} mm).`);
  }
  lap('measure');

  return {
    mesh: reduced,
    settings,
    mask,
    requestedMm,
    veneerMm,
    veneerCounted,
    veneer,
    ...(shortfall ? { shortfall } : {}),
    ...(protection ? { protection } : {}),
    projectedVertices: thin.length,
    repairedFaces,
    validation,
    warnings,
    timingsMs: timings,
  };
}

/**
 * The fitting inner balls (all of radius R) in a uniform grid, for the query
 * "which ball surfaces are closest to p": |p − c_u| − R.
 */
class BallIndex {
  private readonly cellStart: Uint32Array;
  private readonly ids: Uint32Array;
  private readonly min: V3 = [Infinity, Infinity, Infinity];
  private readonly dims: [number, number, number];
  private readonly cell = 0.5;
  constructor(
    private readonly centre: Float64Array,
    fits: Uint8Array,
    private readonly radius: number,
  ) {
    const members: number[] = [];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < fits.length; v++) {
      if (!fits[v]) continue;
      members.push(v);
      for (let k = 0; k < 3; k++) {
        this.min[k] = Math.min(this.min[k]!, centre[v * 3 + k]!);
        max[k] = Math.max(max[k]!, centre[v * 3 + k]!);
      }
    }
    this.dims = [0, 1, 2].map((k) => (members.length ? Math.floor((max[k]! - this.min[k]!) / this.cell) + 1 : 1)) as [number, number, number];
    const cells = this.dims[0] * this.dims[1] * this.dims[2];
    const counts = new Uint32Array(cells + 1);
    const cellOf = members.map((v) => this.cellIndex(this.coord(centre[v * 3]!, 0), this.coord(centre[v * 3 + 1]!, 1), this.coord(centre[v * 3 + 2]!, 2)));
    for (const c of cellOf) counts[c + 1]!++;
    for (let c = 0; c < cells; c++) counts[c + 1] = counts[c + 1]! + counts[c]!;
    this.cellStart = counts;
    const fill = counts.slice(0, cells);
    this.ids = new Uint32Array(members.length);
    members.forEach((v, i) => (this.ids[fill[cellOf[i]!]!++] = v));
  }
  private coord(x: number, k: 0 | 1 | 2): number {
    return Math.floor((x - this.min[k]) / this.cell);
  }
  private cellIndex(x: number, y: number, z: number): number {
    return (x * this.dims[1] + y) * this.dims[2] + z;
  }
  /**
   * The balls whose surface gap |p − c_u| − R is within `window` of the
   * smallest, as [id, gap] pairs, the best first (empty if none fits).
   */
  near(p: V3, window: number): number[] {
    if (this.ids.length === 0) return [];
    const c = [this.coord(p[0], 0), this.coord(p[1], 1), this.coord(p[2], 2)] as const;
    let best = Infinity;
    const found: number[] = [];
    let maxShell = 0;
    for (let k = 0; k < 3; k++) maxShell = Math.max(maxShell, c[k]!, this.dims[k as 0 | 1 | 2] - 1 - c[k]!);
    for (let shell = 0; shell <= maxShell; shell++) {
      for (let x = Math.max(0, c[0] - shell); x <= Math.min(this.dims[0] - 1, c[0] + shell); x++) {
        for (let y = Math.max(0, c[1] - shell); y <= Math.min(this.dims[1] - 1, c[1] + shell); y++) {
          for (let z = Math.max(0, c[2] - shell); z <= Math.min(this.dims[2] - 1, c[2] + shell); z++) {
            if (Math.max(Math.abs(x - c[0]), Math.abs(y - c[1]), Math.abs(z - c[2])) !== shell) continue;
            const cell = this.cellIndex(x, y, z);
            for (let k = this.cellStart[cell]!; k < this.cellStart[cell + 1]!; k++) {
              const u = this.ids[k]!;
              const gap = Math.hypot(p[0] - this.centre[u * 3]!, p[1] - this.centre[u * 3 + 1]!, p[2] - this.centre[u * 3 + 2]!) - this.radius;
              if (gap <= best + window) found.push(u, gap);
              best = Math.min(best, gap);
            }
          }
        }
      }
      // Every centre in a farther shell is at least shell · cell away.
      if (shell * this.cell - this.radius >= best + window) break;
    }
    const out: Array<[number, number]> = [];
    for (let k = 0; k < found.length; k += 2) if (found[k + 1]! <= best + window) out.push([found[k]!, found[k + 1]!]);
    out.sort((a, b) => a[1] - b[1]);
    return out.flat();
  }
}

function triNormal(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): V3 {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/**
 * The cutback surface of a designed crown (or, with `fitting: false`, of a
 * pontic in the same CrownDesign shape): the outer shell is the template
 * shell [shellStart, end), its cervical ring is the outer margin loop, and
 * the intaglio (the faces whose corners are all intaglio vertices) is the
 * fitting surface for the thickness protection.
 */
export function unitCutbackSurface(input: {
  design: Pick<CrownDesign, 'mesh' | 'shellStart' | 'intaglioVertices'>;
  template: CrownTemplate;
  frame: CrownFrame;
  /** false for pontics (no thickness protection). Default true. */
  fitting?: boolean;
}): CutbackSurface {
  const { design, template } = input;
  const axes = crownAxes(input.frame);
  const P = design.mesh.positions;
  const start = design.shellStart;
  const end = start + template.heightFraction.length;
  if (end !== P.length / 3) throw new Error(`The unit mesh has ${P.length / 3} vertices; expected shellStart + template vertices = ${end}`);
  const ring = template.cervicalLoop;
  const marginLoop = new Float32Array(ring.length * 3);
  for (let i = 0; i < ring.length; i++) for (let k = 0; k < 3; k++) marginLoop[i * 3 + k] = P[(start + ring[i]!) * 3 + k]!;
  let fitting: CutbackSurface['fitting'];
  if (input.fitting !== false) {
    const ni = design.intaglioVertices;
    const idx = design.mesh.indices;
    const tris: number[] = [];
    for (let f = 0; f < idx.length; f += 3) {
      if (idx[f]! < ni && idx[f + 1]! < ni && idx[f + 2]! < ni) tris.push(idx[f]!, idx[f + 1]!, idx[f + 2]!);
    }
    const positions = P.slice(0, ni * 3);
    const indices = Uint32Array.from(tris);
    fitting = { intaglio: { ray: bvhRayCaster(createBvh({ positions, indices })), positions, indices }, marginLoop };
  }
  return {
    mesh: design.mesh,
    outerStart: start,
    outerEnd: end,
    heightFraction: template.heightFraction,
    cervicalLoop: ring,
    buccal: axes.y,
    ...(fitting ? { fitting } : {}),
  };
}
