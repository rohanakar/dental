import type { Pose } from '@dcad/shared';
import { fitAnatomy, type AnatomyResidual } from './anatomyFit';
import { CONNECTOR_EMBRASURE_MM, CONNECTOR_HYGIENE_MM, type ConnectorUnit } from './connectors';
import type { CrownFrame } from './crown';
import { templateForTooth, type CrownTemplate } from './crownTemplate';
import { cementGap, type GapParams } from './intaglio';
import { MinHeap } from './livewire';
import type { IndexedMesh } from './mesh';
import { differenceMeshes, meshBooleanReady } from './meshBoolean';
import { buildFittingPatch, fittingSurfaceOf, measurePatchGap, validatePatchSolid, type FittingPatch, type PatchGapCheck, type PatchJaw, type PatchRegionInput, type PatchValidation } from './patchRetainer';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh, type RayCaster } from './raycast';
import { extentAlong, extractFaces, fillHoles, fixPinches, largestComponent, PolylineIndex, removeEars, slabDirection, slabSolid, type OpenSurface } from './faceSets';

/**
 * Inlay and onlay restorations (single, or retainers of an inlay bridge):
 * the missing part of a tooth in a cavity prep. See
 * specs/2026-10-25-inlay-bridges.md, "Outer surface: snap and subtract".
 *
 * 1. Fitting patch: the cavity surface inside the margin, with the
 *    cementGap(d) ramp plus spacer, blocked out along the insertion axis
 *    (buildFittingPatch, patchRetainer.ts). It needs no star-shaped margin,
 *    so dumbbell-shaped MOD cavities work.
 * 2. Remaining tooth S: the fitting patch plus the natural surface within
 *    3 mm (geodesic) of the margin, closed as a slab: the surface, its copy
 *    moved along −up and walls between them. `up` is the direction within
 *    15° of the axis in which that surface is a height field
 *    (slabDirection), so the slab never intersects itself.
 * 3. Anatomy A, on the scan's own resolution over the cavity and a 2 mm
 *    collar: the pre-op scan (cropped by where it lies over the cavity and
 *    collar), or the library tooth fitted to the collar (anatomyFit.ts:
 *    least-squares pose and scale, RBF pin of the collar onto the scan)
 *    sampled straight above every cavity vertex. Closed as a slab like S.
 * 4. Snap (shapeAnatomy): A's vertices on the natural surface outside the
 *    margin go 0.1 mm inside S, and 1 mm right next to the margin, so A
 *    drops through S on the margin; vertices on the margin stay on it;
 *    vertices next to the cavity floor are kept just above the fitting
 *    surface. Every move is along `up`, which keeps A a height field.
 * 5. Subtract: restoration = A − S (manifold-3d). The component with the
 *    most fitting surface is kept; other pieces are dropped and reported.
 * 6. Relax: the restoration's boundary (where A crosses S) moves onto the
 *    drawn margin, the vertices around it following a smooth field; the
 *    move is undone if it would add a self-intersection.
 *
 * Checks: closed and printable; margin fit (boundary within 0.05 mm of the
 * drawn margin); isthmus thickness (fitting surface → outer surface along
 * the axis on the cavity floors at least 1 mm from the margin) ≥
 * retainerMinThicknessMm; seating (the fitting gap); the library fit's
 * residual on the collar (fails above 0.15 mm); for bridge retainers a
 * coronal height under 5 mm is a warning (inlayBridgeIndications adds the
 * gap). inlayConnectorLimit gives the connector height the proximal box
 * leaves.
 *
 * Local types until phase B moves them into the shared schemas: the
 * restoration types `inlay` and `onlay` (InlayType), ToothDesign.outerSource
 * (OuterSource) and DesignParams.retainerMinThicknessMm (InlayParams).
 */

/** Restoration types (phase B: RestorationType 'inlay' | 'onlay', role abutment). They share the geometry. */
export type InlayType = 'inlay' | 'onlay';
/** Where the outer surface comes from (phase B: ToothDesign.outerSource). */
export type OuterSource = 'preop' | 'library';

/** The design parameters an inlay uses: the cement gap ramp, plus the minimum isthmus thickness (phase B: DesignParams.retainerMinThicknessMm). */
export type InlayParams = GapParams & { retainerMinThicknessMm?: number };

export const INLAY_DEFAULTS = {
  /** Minimum isthmus thickness of a retainer (spec placeholder, to confirm in domain QA). */
  retainerMinThicknessMm: 1.5,
  /** Collar of natural surface around the margin in the remaining tooth S. */
  collarMm: 3,
  /** Collar of the anatomy A (inside S's, so their side walls never meet). */
  anatomyCollarMm: 2,
  /** The anatomy's vertices this close to the scan are shaped (on it, for the pre-op scan and the sampled library tooth). */
  snapReachMm: 0.05,
  /** Outside the margin the anatomy goes this far below the scan (inside S)... */
  snapDepthMm: 0.1,
  /** ... at most this far along the slab direction on steep faces (plus nearDepthMm next to the margin). */
  snapMaxMoveMm: 0.4,
  /** Outside the margin and this close to it, the anatomy is lowered whatever its height (no overhang)... */
  overhangMm: 0.5,
  /** ... and this deep, so it drops through S within one of its edges of the margin. */
  nearDepthMm: 1.0,
  /** Anatomy vertices straight above the margin (within this) go just under it... */
  marginColumnMm: 0.03,
  /** ... this far (a vertex touching a face of S upsets the boolean; one on a vertex of S does not). */
  marginPinDepthMm: 0.005,
  /** Inside the margin, anatomy next to the scan is kept this far above the fitting surface (feather edge). */
  liftMm: 0.02,
  /** Dropped pieces thicker than this are reported (the anatomy stood out of the remaining tooth outside the margin). */
  sliverMm: 0.05,
  /** Margin fit tolerance: the restoration's boundary within this distance of the drawn margin. */
  marginFitMm: 0.05,
  /** Boundary vertices farther than this from the margin are not relaxed onto it (and fail the margin fit). */
  relaxReachMm: 0.3,
  /** Isthmus thickness is measured on floors (normal within 30° of the axis) at least this far from the margin. */
  isthmusCoreMm: 1.0,
  /** The library fit fails when the collar residual (95th percentile) is above this. */
  libraryResidualMaxMm: 0.15,
  /** Indications (spec): warn over this gap (bridges, inlayIndications) and under this coronal height. */
  maxGapMm: 12,
  minCoronalHeightMm: 5,
};

export type InlayOptions = typeof INLAY_DEFAULTS;

/** The pre-op scan (aligned with the jaw scan): arrays plus a ray caster built on them (indices in BVH order). */
export interface PreopScan {
  positions: Float32Array;
  indices: Uint32Array;
  ray: RayCaster;
}

export type OuterInput =
  | { source: 'preop'; preop: PreopScan }
  | {
      source: 'library';
      /** The tooth frame (template axes; contacts help the scale). */
      frame: CrownFrame;
      template?: CrownTemplate;
      /** Stored pose (the user or agent moved the tooth): skips the least-squares fit. */
      pose?: Pose;
    };

export interface InlayInput {
  fdi: number;
  type?: InlayType;
  /** A bridge retainer gets the inlay-bridge indication warnings (coronal height); default single. */
  role?: 'single' | 'retainer';
  /** The jaw scan with the cavity (BVH-ordered index, adjacency, smoothed normals, ray caster). */
  jaw: PatchJaw;
  /** The cavity region: prepRegion from a seed on the cavity floor, plus the traced margin loop. */
  region: PatchRegionInput;
  /** The drawn margin: dense points on the scan (marginFromAnchors(...).points), closed. */
  margin: Float32Array;
  /** Insertion axis toward the antagonist (the bridge's common axis). */
  axis: V3;
  params: InlayParams;
  outer: OuterInput;
  options?: Partial<InlayOptions>;
}

export interface InlayMarginFit {
  /** Restoration boundary vertices (where the fitting surface meets the outer surface). */
  samples: number;
  /** Distance to the drawn margin, after relaxing. */
  meanMm: number;
  maxMm: number;
  /** Before relaxing (where A crossed S). */
  crossingMeanMm: number;
  crossingMaxMm: number;
  /** Boundary vertices moved onto the margin, and the largest move. */
  relaxedVertices: number;
  maxRelaxMm: number;
  ok: boolean;
}

export interface InlayIsthmus {
  /** Fitting vertices measured (floors at least isthmusCoreMm from the margin, not blocked out). */
  samples: number;
  minMm: number;
  meanMm: number;
  /** Where the minimum is (on the fitting surface). */
  at: V3;
  thresholdMm: number;
  ok: boolean;
}

export interface InlayPiece {
  triangles: number;
  volumeMm3: number;
  areaMm2: number;
  /** 2·volume/area: the thickness of a thin sheet. */
  thicknessMm: number;
}

export type InlayFailureCode = 'not-printable' | 'margin-fit' | 'isthmus-thin' | 'library-fit';

export interface InlayFailure {
  code: InlayFailureCode;
  message: string;
  value?: number;
  limit?: number;
}

export interface InlayDesign {
  fdi: number;
  type: InlayType;
  /**
   * Closed restoration. Fitting vertices come first, [0, fittingVertices): every vertex of a fitting face,
   * including the boundary; outer-only vertices follow. Fitting faces come first in indices.
   */
  mesh: IndexedMesh;
  fittingVertices: number;
  fittingFaces: number;
  /** First outer-only vertex (= fittingVertices), as CrownDesign.shellStart for the connectors' facing area. */
  shellStart: number;
  /** As CrownDesign.intaglioVertices (bridge code reads the fitting surface from the first vertices). */
  intaglioVertices: number;
  /** The margin centroid (as a crown's pose position: the unit centre for the connector line). */
  centre: V3;
  patch: FittingPatch;
  validation: PatchValidation;
  /** The fitting surface against the scan (the gap each vertex was given). */
  gapCheck: PatchGapCheck;
  /** The same seen from the tooth, against the restoration: compare with measureCavitySeating on a bridge union. */
  seating: CavitySeating;
  marginFit: InlayMarginFit;
  isthmus: InlayIsthmus;
  outer: {
    source: OuterSource;
    /** Library source: the fitted pose (store with setCrown), the collar residual and whether it passes. */
    library?: { pose: Pose; templateId: string; residual: AnatomyResidual; poseRmsMm: number; iterations: number; pins: number; anchors: number; ok: boolean };
    /** A's vertices moved inside S (outside the margin), and lifted above it (inside, next to the scan). */
    snappedVertices: number;
    liftedVertices: number;
  };
  /** Kept and dropped pieces of A − S. */
  pieces: { kept: InlayPiece; dropped: InlayPiece[] };
  /** Restored tooth height above the gingiva along the axis (indication: ≥ minCoronalHeightMm). */
  coronalHeightMm: number;
  failures: InlayFailure[];
  warnings: string[];
  timingsMs: Record<string, number>;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const pointAt = (a: ArrayLike<number>, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];

// ---- The remaining tooth -------------------------------------------------------------

interface RemainingTooth {
  /** S's top surface: the fitting patch (vertices [0, patch vertices)) and the collar. */
  top: OpenSurface;
  /** Scan vertex of each top vertex. */
  topSource: Uint32Array;
  /** Per scan vertex: geodesic distance from the margin outside the cavity (0 on the margin; Infinity beyond the collar or inside). */
  collarDistance: Float32Array;
  /** Per scan vertex: 1 = a vertex of the fitting patch (inside the margin or on it). */
  cavityVertex: Uint8Array;
  /** Per scan face: 1 = a face of the fitting patch. */
  cavityFace: Uint8Array;
  /** Scan vertices of the collar (outside the margin, within the collar), margin excluded. */
  collarVertices: number[];
  /** Scan faces of the collar (outside the margin). */
  collarFaces: number[];
  /** Scan vertices of the fitting patch. */
  cavityVertices: Uint32Array;
  /** The cement gap at each scan vertex of the fitting patch. */
  cavityGap: Map<number, number>;
  /** The margin loop as traced on the scan (its vertices, in order), xyz. */
  marginChain: Float32Array;
  pinchFacesAdded: number;
}

/** Geodesic distance from the margin loop over scan vertices outside the cavity, up to maxMm. */
function collarDistances(jaw: PatchJaw, cavityVertex: Uint8Array, onLoop: Uint8Array, loop: ArrayLike<number>, maxMm: number): Float32Array {
  const P = jaw.positions;
  const dist = new Float32Array(P.length / 3).fill(Infinity);
  const heap = new MinHeap();
  const top: [number, number] = [0, 0];
  for (let i = 0; i < loop.length; i++) {
    dist[loop[i]!] = 0;
    heap.push(0, loop[i]!);
  }
  while (heap.size > 0) {
    heap.pop(top);
    const [d, u] = top;
    if (d > dist[u]!) continue;
    for (let k = jaw.graph.offsets[u]!; k < jaw.graph.offsets[u + 1]!; k++) {
      const v = jaw.graph.neighbors[k]!;
      if (cavityVertex[v] && !onLoop[v]) continue;
      const nd = d + Math.hypot(P[v * 3]! - P[u * 3]!, P[v * 3 + 1]! - P[u * 3 + 1]!, P[v * 3 + 2]! - P[u * 3 + 2]!);
      if (nd <= maxMm && nd < dist[v]!) {
        dist[v] = nd;
        heap.push(nd, v);
      }
    }
  }
  return dist;
}

/** S's top surface: the fitting patch plus the natural collar around the margin, joined at the margin vertices. */
function remainingTooth(jaw: PatchJaw, patch: FittingPatch, collarMm: number): RemainingTooth {
  const P = jaw.positions;
  const nv = P.length / 3;
  const nf = jaw.indices.length / 3;
  const cavityVertex = new Uint8Array(nv);
  for (const v of patch.sourceVertex) cavityVertex[v] = 1;
  const onLoop = new Uint8Array(nv);
  const loop = Array.from(patch.boundary, (l) => patch.sourceVertex[l]!);
  for (const v of loop) onLoop[v] = 1;
  // Scan faces of the patch: the patch's triangles mapped back to scan ids.
  const key = (a: number, b: number, c: number) => {
    const s = [a, b, c].sort((x, y) => x - y);
    return `${s[0]},${s[1]},${s[2]}`;
  };
  const patchTris = new Set<string>();
  const pi = patch.mesh.indices;
  for (let f = 0; f < pi.length; f += 3) patchTris.add(key(patch.sourceVertex[pi[f]!]!, patch.sourceVertex[pi[f + 1]!]!, patch.sourceVertex[pi[f + 2]!]!));
  const cavityFace = new Uint8Array(nf);
  const collarDistance = collarDistances(jaw, cavityVertex, onLoop, loop, collarMm);
  const inCollar = (v: number) => onLoop[v] === 1 || (!cavityVertex[v] && Number.isFinite(collarDistance[v]!));
  const collarFaces: number[] = [];
  for (let f = 0; f < nf; f++) {
    const a = jaw.indices[f * 3]!, b = jaw.indices[f * 3 + 1]!, c = jaw.indices[f * 3 + 2]!;
    if (cavityVertex[a] && cavityVertex[b] && cavityVertex[c] && patchTris.has(key(a, b, c))) {
      cavityFace[f] = 1;
      continue;
    }
    if (inCollar(a) && inCollar(b) && inCollar(c)) collarFaces.push(f);
  }
  // The collar's outer boundary must be manifold (slab walls); faces of the patch are never added.
  const notCavity = (f: number) => !cavityFace[f];
  // Faces touching the margin are never peeled (the collar must surround it).
  const peelable = (f: number) => notCavity(f) && !onLoop[jaw.indices[f * 3]!] && !onLoop[jaw.indices[f * 3 + 1]!] && !onLoop[jaw.indices[f * 3 + 2]!];
  const filled = fillHoles(P, jaw.indices, collarFaces, notCavity);
  const fixed = fixPinches(jaw.indices, nv, removeEars(jaw.indices, nv, filled, peelable), notCavity);
  // S's top: patch vertices first (fitting positions), then the collar's own vertices.
  const n = patch.mesh.positions.length / 3;
  const local = new Map<number, number>();
  patch.sourceVertex.forEach((v, i) => local.set(v, i));
  const extra: number[] = [];
  for (const f of fixed.faces) {
    for (let k = 0; k < 3; k++) {
      const v = jaw.indices[f * 3 + k]!;
      if (!local.has(v)) {
        local.set(v, n + extra.length);
        extra.push(v);
      }
    }
  }
  const positions = new Float32Array((n + extra.length) * 3);
  positions.set(patch.mesh.positions, 0);
  extra.forEach((v, i) => positions.set(P.subarray(v * 3, v * 3 + 3), (n + i) * 3));
  const indices = new Uint32Array(patch.mesh.indices.length + fixed.faces.length * 3);
  indices.set(patch.mesh.indices, 0);
  let o = patch.mesh.indices.length;
  for (const f of fixed.faces) {
    for (let k = 0; k < 3; k++) indices[o++] = local.get(jaw.indices[f * 3 + k]!)!;
  }
  const collarVertices: number[] = [];
  for (const v of extra) if (!onLoop[v] && Number.isFinite(collarDistance[v]!)) collarVertices.push(v);
  const marginChain = new Float32Array(loop.length * 3);
  loop.forEach((v, i) => marginChain.set(P.subarray(v * 3, v * 3 + 3), i * 3));
  return {
    top: { positions, indices },
    topSource: Uint32Array.from([...patch.sourceVertex, ...extra]),
    collarDistance,
    cavityVertex,
    cavityFace,
    collarVertices,
    collarFaces: fixed.faces,
    cavityVertices: patch.sourceVertex,
    cavityGap: new Map(Array.from(patch.sourceVertex, (v, i) => [v, patch.gap[i]!] as [number, number])),
    marginChain,
    pinchFacesAdded: fixed.added,
  };
}

// ---- The anatomy ---------------------------------------------------------------------

/** A vertex this close to the scan is on it (the pre-op scan where it was not cut); this close to the margin loop, on the margin. */
const ON_SURFACE_MM = 1e-4;
const ON_MARGIN_MM = 1e-3;
/** A point straight below a vertex this close to a margin vertex is that vertex. */
const ON_MARGIN_VERTEX_MM = 1e-6;

interface ShapeOptions {
  /** Vertices this close to the scan are moved. */
  reach: number;
  /** Outside the margin: this far below the scan (inside S). */
  depth: number;
  /** Inside the margin: at least this far above the fitting surface (S). */
  lift: number;
  /** Outside the margin and this close to it, vertices are lowered whatever their height (no overhang past the margin)... */
  overhangMm: number;
  /** ... and this far below the scan. */
  nearDepth: number;
  /** A vertex whose scan point straight below is this close to the margin goes just under that point... */
  marginColumnMm: number;
  /** ... this far under it (exactly onto it when it is a margin vertex). */
  marginPinDepth: number;
  /** The slab direction: every move is along it. */
  up: V3;
  /** The largest move (plus nearDepth next to the margin). */
  maxMoveMm: number;
}

/** A surface with face lookups (BVH-ordered index copy) for closest points and face normals. */
interface FaceSurface {
  positions: Float32Array;
  indices: Uint32Array;
  ray: RayCaster;
}

function faceSurface(positions: Float32Array, indices: Uint32Array): FaceSurface {
  const idx = indices.slice();
  return { positions, indices: idx, ray: bvhRayCaster(createBvh({ positions, indices: idx })) };
}

function faceNormal(s: Pick<FaceSurface, 'positions' | 'indices'>, f: number): V3 {
  const a = pointAt(s.positions, s.indices[f * 3]!), b = pointAt(s.positions, s.indices[f * 3 + 1]!), c = pointAt(s.positions, s.indices[f * 3 + 2]!);
  return normalize(cross(sub(b, a), sub(c, a)));
}

/**
 * Shape the anatomy around the margin so that it crosses the remaining
 * tooth S on the drawn margin, and only rises above S inside it. Per vertex
 * of the anatomy surface (on the scan's own vertices: the pre-op scan, or the
 * library tooth sampled onto the scan):
 * - exactly on the margin loop: left on S;
 * - straight above the margin (the scan point below along −up within
 *   marginColumnMm of it, e.g. the pre-op over a cut margin vertex): put just
 *   under that point (onto it when it is a margin vertex; a vertex touching a
 *   face of S upsets the boolean, one on a vertex of S does not);
 * - on the natural-surface side (the closest scan point outside the margin,
 *   or for a vertex beside the scan, the scan straight below it): within
 *   `reach` of the scan, `depth` below it (the snap); within `overhangMm` of
 *   the margin, `nearDepth` below it whatever its height, so the anatomy
 *   drops through S within one of its edges of the margin and never
 *   overhangs it;
 * - on the cavity side, within `reach` of the scan and over the fitting
 *   surface: lifted to `lift` above it, so the restoration reaches the margin
 *   (a feather edge where the margin was drawn on uncut tooth).
 * Heights are measured against the local face (scan or fitting surface) and
 * every move is along `up`, which keeps a height field a height field (the
 * slab stays valid where the scan has near-vertical faces).
 */
function shapeAnatomy(positions: Float32Array, jaw: PatchJaw, fitting: FaceSurface, s: RemainingTooth, opts: ShapeOptions): { lowered: number; lifted: number } {
  const { up } = opts;
  const down = scale(up, -1);
  const margin = new PolylineIndex(s.marginChain, Math.max(opts.overhangMm, opts.marginColumnMm));
  const jawFaces = { positions: jaw.positions, indices: jaw.indices };
  let lowered = 0, lifted = 0;
  /** Move along up so the height over a face of normal n changes by −amount. */
  const moveBy = (i: number, p: V3, amount: number, n: V3, cap: number) => {
    const along = dot(n, up);
    if (along <= 1e-3) return false;
    positions.set(sub(p, scale(up, Math.max(-cap, Math.min(cap, amount / along)))), i * 3);
    return true;
  };
  const search = Math.max(opts.reach, opts.overhangMm);
  for (let i = 0; i < positions.length / 3; i++) {
    const p = pointAt(positions, i);
    const cp = jaw.ray.closestPoint(p, search);
    if (!cp || cp.faceIndex < 0) continue;
    const onSurface = cp.distance <= ON_SURFACE_MM;
    const toMargin = margin.distance(cp.point);
    if (onSurface && toMargin <= ON_MARGIN_MM) continue;
    let inside: boolean;
    if (onSurface) inside = s.cavityFace[cp.faceIndex] === 1;
    else {
      const below = jaw.ray.first(add(p, scale(up, 1e-3)), down, 20);
      const belowToMargin = below ? margin.distance(below.point) : Infinity;
      if (below && belowToMargin <= opts.marginColumnMm) {
        positions.set(belowToMargin <= ON_MARGIN_VERTEX_MM ? below.point : sub(below.point, scale(up, opts.marginPinDepth)), i * 3);
        lowered++;
        continue;
      }
      inside = s.cavityFace[(below && below.faceIndex >= 0 ? below : cp).faceIndex] === 1;
    }
    if (inside) {
      if (cp.distance > opts.reach) continue;
      const cf = fitting.ray.closestPoint(p, opts.reach + 1);
      if (!cf || cf.faceIndex < 0) continue;
      const n = faceNormal(fitting, cf.faceIndex);
      const offset = sub(p, cf.point);
      const height = dot(offset, n);
      if (height >= opts.lift) continue;
      // Only over the surface (the closest point is the foot of the normal), not beside a crease of it.
      if (Math.hypot(...cross(offset, n)) > 1e-3 + 0.2 * Math.abs(height)) continue;
      if (moveBy(i, p, height - opts.lift, n, opts.maxMoveMm)) lifted++;
      continue;
    }
    const near = toMargin <= opts.overhangMm;
    if (!near && cp.distance > opts.reach) continue;
    const n = faceNormal(jawFaces, cp.faceIndex);
    const height = dot(sub(p, cp.point), n);
    if (moveBy(i, p, height + (near ? opts.nearDepth : opts.depth), n, near ? opts.nearDepth + opts.maxMoveMm : opts.maxMoveMm)) lowered++;
  }
  return { lowered, lifted };
}

/**
 * The pre-op scan's surface over the cavity and the anatomy collar. A pre-op
 * vertex on the natural surface (within `onSurfaceMm` of the jaw scan) is in
 * when its closest scan point is in the cavity or the collar; a vertex above
 * the cavity is in when its closest scan point is there, or the scan
 * straight under it along −axis is (next to a neighbouring tooth the closest
 * point can be on the neighbour). Holes are filled, the largest component
 * kept and pinches removed.
 */
function cropPreop(preop: PreopScan, jaw: PatchJaw, s: RemainingTooth, axis: V3, collarMm: number, onSurfaceMm: number, bounds: [V3, V3]): OpenSurface {
  const P = preop.positions;
  const nv = P.length / 3;
  const inside = new Uint8Array(nv);
  const [lo, hi] = bounds;
  const faceIn = (face: number) => {
    let worst = 0;
    for (let k = 0; k < 3; k++) {
      const jv = jaw.indices[face * 3 + k]!;
      worst = Math.max(worst, s.cavityVertex[jv] ? 0 : s.collarDistance[jv]!);
    }
    return worst <= collarMm;
  };
  const down = scale(axis, -1);
  for (let v = 0; v < nv; v++) {
    const p = pointAt(P, v);
    if (p[0] < lo[0] || p[1] < lo[1] || p[2] < lo[2] || p[0] > hi[0] || p[1] > hi[1] || p[2] > hi[2]) continue;
    const cp = jaw.ray.closestPoint(p, 8);
    if (!cp || cp.faceIndex < 0) continue;
    if (faceIn(cp.faceIndex)) inside[v] = 1;
    else if (cp.distance > onSurfaceMm) {
      const hit = jaw.ray.first(add(p, scale(axis, 1e-3)), down, 20);
      if (hit && hit.faceIndex >= 0 && faceIn(hit.faceIndex)) inside[v] = 1;
    }
  }
  let faces: number[] = [];
  for (let f = 0; f < preop.indices.length / 3; f++) {
    if (inside[preop.indices[f * 3]!] && inside[preop.indices[f * 3 + 1]!] && inside[preop.indices[f * 3 + 2]!]) faces.push(f);
  }
  faces = largestComponent(preop.indices, faces, nv);
  faces = fillHoles(P, preop.indices, faces);
  faces = removeEars(preop.indices, nv, faces, () => true);
  faces = fixPinches(preop.indices, nv, faces).faces;
  const { positions, indices } = extractFaces(P, preop.indices, faces);
  return { positions, indices };
}

/**
 * The library tooth as a "pre-op scan": S's top surface (the scan's own
 * vertices) over the cavity and the anatomy collar, with every cavity vertex
 * except the margin raised to the fitted tooth's surface straight above it
 * (along the axis). The collar and the margin stay on the scan, so the
 * library anatomy is shaped and closed exactly like a pre-op scan, at the
 * scan's resolution. Cavity vertices with no tooth surface above them (or
 * the tooth below them) are filled harmonically between the covered ones and
 * the margin.
 */
function libraryTop(solid: IndexedMesh, s: RemainingTooth, patch: FittingPatch, axis: V3, collarMm: number): OpenSurface {
  const ray = bvhRayCaster(createBvh({ positions: solid.positions, indices: solid.indices.slice() }));
  const n = patch.mesh.positions.length / 3;
  const positions = s.top.positions.slice();
  const onBoundary = new Uint8Array(n);
  for (const v of patch.boundary) onBoundary[v] = 1;
  const down = scale(axis, -1);
  // Height along the axis per patch vertex: the tooth surface above it, or (none above) filled in below.
  const height = new Float64Array(n);
  const known = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const tooth = pointAt(patch.tooth, i);
    height[i] = dot(tooth, axis);
    if (onBoundary[i]) {
      known[i] = 1;
      continue;
    }
    const hit = ray.first(add(tooth, scale(axis, 30)), down, 60);
    if (hit && dot(sub(hit.point, tooth), axis) > 0) {
      height[i] = dot(hit.point, axis);
      known[i] = 1;
    }
  }
  // Cavity vertices beyond the library tooth (e.g. the corners of a box floor when the tooth is shorter than the
  // natural one): a harmonic fill between the covered anatomy and the margin, never below the cavity.
  const unknown: number[] = [];
  for (let i = 0; i < n; i++) if (!known[i]) unknown.push(i);
  if (unknown.length > 0) {
    const g = patch.graph;
    for (let it = 0; it < 400; it++) {
      let change = 0;
      for (const i of unknown) {
        let sum = 0, count = 0;
        for (let k = g.offsets[i]!; k < g.offsets[i + 1]!; k++) {
          sum += height[g.neighbors[k]!]!;
          count++;
        }
        if (count === 0) continue;
        const h = Math.max(sum / count, dot(pointAt(patch.tooth, i), axis));
        change = Math.max(change, Math.abs(h - height[i]!));
        height[i] = h;
      }
      if (change < 1e-5) break;
    }
  }
  for (let i = 0; i < n; i++) {
    const tooth = pointAt(patch.tooth, i);
    positions.set(add(tooth, scale(axis, height[i]! - dot(tooth, axis))), i * 3);
  }
  const nTop = positions.length / 3;
  const keep = new Uint8Array(nTop);
  for (let i = 0; i < nTop; i++) keep[i] = i < n || s.collarDistance[s.topSource[i]!]! <= collarMm ? 1 : 0;
  const I = s.top.indices;
  let faces: number[] = [];
  for (let f = 0; f < I.length / 3; f++) if (keep[I[f * 3]!] && keep[I[f * 3 + 1]!] && keep[I[f * 3 + 2]!]) faces.push(f);
  faces = removeEars(I, nTop, faces, (f) => I[f * 3]! >= n || I[f * 3 + 1]! >= n || I[f * 3 + 2]! >= n);
  faces = fixPinches(I, nTop, faces).faces;
  const { positions: p, indices } = extractFaces(positions, I, faces);
  return { positions: p, indices };
}

// ---- Restoration assembly ------------------------------------------------------------

interface Classified {
  mesh: IndexedMesh;
  fittingVertices: number;
  fittingFaces: number;
  kept: InlayPiece;
  dropped: InlayPiece[];
}

function pieceOf(positions: Float32Array, indices: Uint32Array, faces: number[]): InlayPiece {
  let volume = 0, area = 0;
  for (const f of faces) {
    const a = pointAt(positions, indices[f * 3]!), b = pointAt(positions, indices[f * 3 + 1]!), c = pointAt(positions, indices[f * 3 + 2]!);
    volume += dot(a, cross(b, c)) / 6;
    const n = cross(sub(b, a), sub(c, a));
    area += 0.5 * Math.hypot(n[0], n[1], n[2]);
  }
  return { triangles: faces.length, volumeMm3: volume, areaMm2: area, thicknessMm: area > 0 ? (2 * Math.abs(volume)) / area : 0 };
}

/**
 * Split A − S into components, keep the one with the most fitting surface
 * (faces lying on the fitting patch, not on A), and reorder it: fitting
 * vertices and faces first.
 */
function classify(raw: IndexedMesh, fitting: RayCaster, anatomy: RayCaster): Classified | null {
  const P = raw.positions, I = raw.indices;
  const nv = P.length / 3, nf = I.length / 3;
  const isFit = new Uint8Array(nf);
  const faceArea = new Float64Array(nf);
  for (let f = 0; f < nf; f++) {
    const a = pointAt(P, I[f * 3]!), b = pointAt(P, I[f * 3 + 1]!), c = pointAt(P, I[f * 3 + 2]!);
    const n = cross(sub(b, a), sub(c, a));
    faceArea[f] = 0.5 * Math.hypot(n[0], n[1], n[2]);
    const centroid: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const dS = fitting.closestPoint(centroid, 1e-3)?.distance;
    if (dS === undefined) continue;
    const dA = anatomy.closestPoint(centroid, dS)?.distance;
    if (dA === undefined || dS <= dA) isFit[f] = 1;
  }
  // Components over shared vertices.
  const parent = new Int32Array(nv);
  for (let v = 0; v < nv; v++) parent[v] = v;
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]!]!;
      v = parent[v]!;
    }
    return v;
  };
  for (let f = 0; f < nf; f++) {
    const a = find(I[f * 3]!), b = find(I[f * 3 + 1]!), c = find(I[f * 3 + 2]!);
    parent[b] = a;
    parent[find(c)] = a;
  }
  const comps = new Map<number, number[]>();
  const fitArea = new Map<number, number>();
  for (let f = 0; f < nf; f++) {
    const r = find(I[f * 3]!);
    const list = comps.get(r);
    if (list) list.push(f);
    else comps.set(r, [f]);
    if (isFit[f]) fitArea.set(r, (fitArea.get(r) ?? 0) + faceArea[f]!);
  }
  let best = -1, bestArea = 0;
  for (const [r, a] of fitArea) if (a > bestArea) [best, bestArea] = [r, a];
  if (best < 0) return null;
  const dropped: InlayPiece[] = [];
  for (const [r, faces] of comps) if (r !== best) dropped.push(pieceOf(P, I, faces));
  const keptFaces = comps.get(best)!;
  const fitFaces = keptFaces.filter((f) => isFit[f]);
  const outerFaces = keptFaces.filter((f) => !isFit[f]);
  const remap = new Int32Array(nv).fill(-1);
  let count = 0;
  for (const f of fitFaces) for (let k = 0; k < 3; k++) if (remap[I[f * 3 + k]!] === -1) remap[I[f * 3 + k]!] = count++;
  const fittingVertices = count;
  for (const f of outerFaces) for (let k = 0; k < 3; k++) if (remap[I[f * 3 + k]!] === -1) remap[I[f * 3 + k]!] = count++;
  const positions = new Float32Array(count * 3);
  for (let v = 0; v < nv; v++) if (remap[v]! >= 0) positions.set(P.subarray(v * 3, v * 3 + 3), remap[v]! * 3);
  const indices = new Uint32Array(keptFaces.length * 3);
  let o = 0;
  for (const f of [...fitFaces, ...outerFaces]) for (let k = 0; k < 3; k++) indices[o++] = remap[I[f * 3 + k]!]!;
  return { mesh: { positions, indices }, fittingVertices, fittingFaces: fitFaces.length, kept: pieceOf(P, I, keptFaces), dropped };
}

/** Vertices on edges shared by a fitting face and an outer face (the restoration's margin), and the outer-only neighbours of each. */
function restorationBoundary(mesh: IndexedMesh, fittingFaces: number): { boundary: number[]; ring: Map<number, Set<number>> } {
  const I = mesh.indices;
  const nv = mesh.positions.length / 3;
  const edgeKind = new Map<number, number>();
  for (let f = 0; f < I.length / 3; f++) {
    const bit = f < fittingFaces ? 1 : 2;
    for (let k = 0; k < 3; k++) {
      const a = I[f * 3 + k]!, b = I[f * 3 + ((k + 1) % 3)]!;
      const key = a < b ? a * nv + b : b * nv + a;
      edgeKind.set(key, (edgeKind.get(key) ?? 0) | bit);
    }
  }
  const onBoundary = new Uint8Array(nv);
  for (const [key, kind] of edgeKind) {
    if (kind !== 3) continue;
    const a = Math.floor(key / nv);
    onBoundary[a] = 1;
    onBoundary[key - a * nv] = 1;
  }
  const boundary: number[] = [];
  for (let v = 0; v < nv; v++) if (onBoundary[v]) boundary.push(v);
  // Neighbour sets of every vertex (for the one-ring smoothing).
  const ring = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    let s = ring.get(a);
    if (!s) ring.set(a, (s = new Set()));
    s.add(b);
  };
  for (let f = 0; f < I.length / 3; f++) {
    for (let k = 0; k < 3; k++) {
      const a = I[f * 3 + k]!, b = I[f * 3 + ((k + 1) % 3)]!;
      link(a, b);
      link(b, a);
    }
  }
  return { boundary, ring };
}

/** Closest point on a closed polyline. */
function closestOnLoop(p: V3, loop: Float32Array): { point: V3; distance: number } {
  const n = loop.length / 3;
  let best = Infinity;
  let point: V3 = p;
  for (let i = 0; i < n; i++) {
    const a = pointAt(loop, i), b = pointAt(loop, (i + 1) % n);
    const ab = sub(b, a);
    const len2 = dot(ab, ab);
    const t = len2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2)) : 0;
    const q = add(a, scale(ab, t));
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d < best) {
      best = d;
      point = q;
    }
  }
  return { point, distance: best };
}

/**
 * Move the restoration's boundary onto the drawn margin. Every boundary
 * vertex within `reach` of the margin goes to its closest margin point; the
 * vertices around it follow a smooth displacement field (the boundary moves
 * averaged with a Gaussian of `sigma`, faded out over a band of geodesic
 * width `band` from the boundary), so the boolean's sliver faces next to the
 * boundary are carried along instead of folded. Fitting-side vertices are
 * put back on the remaining tooth's surface (seating is kept). Faces that
 * would flip are restored by halving the field around them (three tries).
 */
function relaxBoundary(mesh: IndexedMesh, fittingVertices: number, fittingFaces: number, margin: Float32Array, reach: number, remaining: RayCaster) {
  const P = mesh.positions;
  const I = mesh.indices;
  const nv = P.length / 3;
  const { boundary, ring } = restorationBoundary(mesh, fittingFaces);
  const original = P.slice();
  const before = boundary.map((v) => closestOnLoop(pointAt(P, v), margin));
  const moves = new Map<number, V3>();
  let maxMove = 0;
  boundary.forEach((v, i) => {
    if (before[i]!.distance > reach) return;
    moves.set(v, sub(before[i]!.point, pointAt(P, v)));
    maxMove = Math.max(maxMove, before[i]!.distance);
  });
  if (moves.size === 0) return { boundary, before: before.map((b) => b.distance), after: before.map((b) => b.distance), relaxed: 0, maxMove };
  const band = Math.max(0.3, 3 * maxMove);
  const sigma = Math.max(0.05, maxMove);

  // Geodesic distance from the boundary along the mesh edges, within the band.
  const dist = new Float32Array(nv).fill(Infinity);
  const heap = new MinHeap();
  const top: [number, number] = [0, 0];
  for (const v of boundary) {
    dist[v] = 0;
    heap.push(0, v);
  }
  while (heap.size > 0) {
    heap.pop(top);
    const [d, u] = top;
    if (d > dist[u]!) continue;
    for (const w of ring.get(u) ?? []) {
      const nd = d + Math.hypot(P[w * 3]! - P[u * 3]!, P[w * 3 + 1]! - P[u * 3 + 1]!, P[w * 3 + 2]! - P[u * 3 + 2]!);
      if (nd < band && nd < dist[w]!) {
        dist[w] = nd;
        heap.push(nd, w);
      }
    }
  }
  // Gaussian average of the boundary moves (spatial hash over the moved boundary vertices).
  const cell = 3 * sigma;
  const grid = new Map<string, number[]>();
  const keyOf = (p: V3) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  for (const v of moves.keys()) {
    const k = keyOf(pointAt(P, v));
    const list = grid.get(k);
    if (list) list.push(v);
    else grid.set(k, [v]);
  }
  const field = new Map<number, V3>();
  for (let v = 0; v < nv; v++) {
    if (!Number.isFinite(dist[v]!)) continue;
    const own = moves.get(v);
    if (own) {
      field.set(v, own);
      continue;
    }
    if (dist[v] === 0) continue; // a boundary vertex out of reach stays
    const p = pointAt(P, v);
    const [cx, cy, cz] = [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)];
    let sum: V3 = [0, 0, 0];
    let wsum = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const b of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        const q = pointAt(P, b);
        const w = Math.exp(-((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2) / (2 * sigma * sigma));
        sum = add(sum, scale(moves.get(b)!, w));
        wsum += w;
      }
    }
    if (wsum < 1e-12) continue;
    const t = 1 - dist[v]! / band;
    field.set(v, scale(sum, (t * t * (3 - 2 * t)) / wsum));
  }

  const apply = (factor: Map<number, number>) => {
    for (const [v, d] of field) {
      const f = factor.get(v) ?? 1;
      let q = add(pointAt(original, v), scale(d, f));
      // Fitting-side vertices stay on the remaining tooth (boundary vertices land exactly on the margin).
      if (v < fittingVertices && !moves.has(v)) q = remaining.closestPoint(q, 1)?.point ?? q;
      P.set(q, v * 3);
    }
  };
  // Faces touching moved vertices, and their normals before.
  const touched: number[] = [];
  for (let f = 0; f < I.length / 3; f++) if (field.has(I[f * 3]!) || field.has(I[f * 3 + 1]!) || field.has(I[f * 3 + 2]!)) touched.push(f);
  const normalOf = (src: Float32Array, f: number) => cross(sub(pointAt(src, I[f * 3 + 1]!), pointAt(src, I[f * 3]!)), sub(pointAt(src, I[f * 3 + 2]!), pointAt(src, I[f * 3]!)));
  const factor = new Map<number, number>();
  for (let attempt = 0; attempt < 4; attempt++) {
    apply(factor);
    const bad = touched.filter((f) => {
      const n0 = normalOf(original, f), n1 = normalOf(P, f);
      return dot(n0, n1) <= 0 || Math.hypot(...n1) < 1e-12;
    });
    if (bad.length === 0) break;
    for (const f of bad) {
      for (let k = 0; k < 3; k++) {
        const v = I[f * 3 + k]!;
        for (const u of [v, ...(ring.get(v) ?? [])]) factor.set(u, attempt === 2 ? 0 : (factor.get(u) ?? 1) / 2);
      }
    }
  }
  let relaxed = 0;
  for (const v of moves.keys()) if ((factor.get(v) ?? 1) === 1) relaxed++;
  const after = boundary.map((v) => closestOnLoop(pointAt(P, v), margin).distance);
  return { boundary, before: before.map((b) => b.distance), after, relaxed, maxMove };
}

/** Thickness from the fitting surface up to the outer surface along the axis, on the cavity floors away from the margin. */
function measureIsthmus(patch: FittingPatch, restoration: RayCaster, axis: V3, coreMm: number, threshold: number): InlayIsthmus {
  const fit = patch.mesh.positions;
  const cosFloor = Math.cos((30 * Math.PI) / 180);
  let samples = 0, min = Infinity, sum = 0;
  let at: V3 = [0, 0, 0];
  for (let i = 0; i < patch.distance.length; i++) {
    if (patch.distance[i]! < coreMm || patch.lift[i]! > 0) continue;
    if (dot(pointAt(patch.normals, i), axis) < cosFloor) continue;
    const p = add(pointAt(fit, i), scale(axis, 1e-3));
    const hit = restoration.first(p, axis, 30);
    if (!hit) continue;
    const t = hit.distance + 1e-3;
    samples++;
    sum += t;
    if (t < min) {
      min = t;
      at = pointAt(fit, i);
    }
  }
  return { samples, minMm: samples ? min : Number.NaN, meanMm: samples ? sum / samples : Number.NaN, at, thresholdMm: threshold, ok: samples > 0 && min >= threshold };
}

/**
 * Coronal height of the restored tooth: its highest point (restoration or
 * collar) above the gingiva along the axis. The gingiva is the lowest scan
 * point under a ring 3 mm outside the margin (ray cast along −axis).
 */
function coronalHeight(jaw: PatchJaw, margin: Float32Array, highest: number, axis: V3): number {
  const n = margin.length / 3;
  let c: V3 = [0, 0, 0];
  for (let i = 0; i < n; i++) c = add(c, scale(pointAt(margin, i), 1 / n));
  let gingiva = Infinity;
  const step = Math.max(1, Math.floor(n / 48));
  for (let i = 0; i < n; i += step) {
    const p = pointAt(margin, i);
    let out = sub(p, c);
    out = normalize(sub(out, scale(axis, dot(out, axis))));
    const q = add(add(p, scale(out, 3)), scale(axis, 10));
    const hit = jaw.ray.first(q, scale(axis, -1), 40);
    if (hit) gingiva = Math.min(gingiva, dot(hit.point, axis));
  }
  return Number.isFinite(gingiva) ? highest - gingiva : Number.NaN;
}

// ---- The design ----------------------------------------------------------------------

/**
 * Design an inlay or onlay: fitting patch, remaining tooth S, anatomy A
 * (pre-op scan or fitted library tooth), snap, A − S, relax, checks. Await
 * initMeshBoolean() first.
 */
export function designInlay(input: InlayInput): InlayDesign {
  if (!meshBooleanReady()) throw new Error('Mesh booleans are not initialized: await initMeshBoolean() before designing an inlay');
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = (timings[name] ?? 0) + now - t;
    t = now;
  };
  const source = input.outer.source;
  const opts: InlayOptions = { ...INLAY_DEFAULTS, ...input.options };
  const minThickness = input.params.retainerMinThicknessMm ?? opts.retainerMinThicknessMm;
  const axis = normalize(input.axis);
  const { jaw } = input;
  const warnings: string[] = [];
  const failures: InlayFailure[] = [];

  // 1. Fitting patch.
  const patch = buildFittingPatch({ jaw, region: input.region, axis, gap: (d) => cementGap(d, input.params) });
  lap('patch');

  // 2. Remaining tooth: patch + collar. The slabs are closed along `up`, the direction near the axis in which its
  // surface is a height field (the anatomy is shaped and sampled along it too).
  const s = remainingTooth(jaw, patch, opts.collarMm);
  const fitting = faceSurface(patch.mesh.positions, patch.mesh.indices);
  const up = slabDirection(s.top, axis);
  lap('remaining');

  // 3. Anatomy (a scan-like surface over the cavity and its collar), shaped around the margin and closed as a slab.
  let shaped = { lowered: 0, lifted: 0 };
  let library: InlayDesign['outer']['library'];
  const [sLo] = extentAlong([s.top.positions], up);
  let top: OpenSurface;
  if (input.outer.source === 'preop') {
    let lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < s.top.positions.length / 3; i++) {
      const p = pointAt(s.top.positions, i);
      lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
      hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
    }
    // The pre-op surface over the cavity rises above the cavity: allow the restored height along the axis.
    const pad = 8;
    const bounds: [V3, V3] = [sub(lo, [1, 1, 1]), add(hi, [1, 1, 1])];
    for (let k = 0; k < 3; k++) {
      if (up[k]! > 0) bounds[1][k] = bounds[1][k]! + pad * up[k]!;
      else bounds[0][k] = bounds[0][k]! + pad * up[k]!;
    }
    top = cropPreop(input.outer.preop, jaw, s, up, opts.anatomyCollarMm, opts.snapReachMm, bounds);
    lap('anatomy.crop');
  } else {
    const template = input.outer.template ?? templateForTooth(input.fdi);
    // The margin first (sampling keeps the first point per cell), then the collar nearest the margin first.
    const ids = [...Array.from(patch.boundary, (l) => patch.sourceVertex[l]!), ...[...s.collarVertices].sort((a, b) => s.collarDistance[a]! - s.collarDistance[b]!)];
    const points = new Float32Array(ids.length * 3);
    const normals = new Float32Array(points.length);
    ids.forEach((v, i) => {
      points.set(jaw.positions.subarray(v * 3, v * 3 + 3), i * 3);
      normals.set(jaw.smoothNormals.subarray(v * 3, v * 3 + 3), i * 3);
    });
    const fit = fitAnatomy({ template, frame: input.outer.frame, points, normals, margin: input.margin, ...(input.outer.pose ? { pose: input.outer.pose } : {}) });
    lap('anatomy.fit');
    const ok = fit.residual.p95Mm <= opts.libraryResidualMaxMm;
    library = { pose: fit.pose, templateId: template.id, residual: fit.residual, poseRmsMm: fit.poseRmsMm, iterations: fit.iterations, pins: fit.pins, anchors: fit.anchors, ok };
    if (!ok) {
      failures.push({
        code: 'library-fit',
        message: `The library tooth fits the natural surface around the cavity to ${fit.residual.p95Mm.toFixed(2)} mm (95th percentile; limit ${opts.libraryResidualMaxMm} mm): the restoration may not meet the tooth at the margin. Use the pre-op scan or adjust the tooth.`,
        value: fit.residual.p95Mm,
        limit: opts.libraryResidualMaxMm,
      });
    }
    top = libraryTop(fit.solid, s, patch, up, opts.anatomyCollarMm);
    lap('anatomy.sample');
  }
  shaped = shapeAnatomy(top.positions, jaw, fitting, s, {
    reach: opts.snapReachMm,
    depth: opts.snapDepthMm,
    lift: opts.liftMm,
    overhangMm: opts.overhangMm,
    nearDepth: opts.nearDepthMm,
    marginColumnMm: opts.marginColumnMm,
    marginPinDepth: opts.marginPinDepthMm,
    up,
    maxMoveMm: opts.snapMaxMoveMm,
  });
  lap('anatomy.snap');
  // A's slab reaches below every point of S's top surface; S's slab reaches a millimetre further.
  const [, topHi] = extentAlong([top.positions], up);
  const anatomy = slabSolid(top, up, topHi - sLo + 1);
  const [aLo, aHi] = extentAlong([anatomy.positions], up);
  const solidS = slabSolid(s.top, up, Math.max(aHi, extentAlong([s.top.positions], up)[1]) - Math.min(aLo, sLo) + 2);
  lap('remaining.close');

  // 4–5. Subtract and keep the piece over the cavity.
  const raw = differenceMeshes(anatomy, solidS);
  lap('subtract');
  const anatomyRay = bvhRayCaster(createBvh({ positions: anatomy.positions, indices: anatomy.indices.slice() }));
  const classified = classify(raw, fitting.ray, anatomyRay);
  lap('classify');
  if (!classified) throw new Error(`Tooth ${input.fdi}: the anatomy does not rise above the cavity (nothing to restore); check the margin and the outer source`);
  const { mesh, fittingVertices, fittingFaces } = classified;

  // 6. Relax the boundary onto the margin (fitting-side vertices stay on the remaining tooth's surface). Kept only
  // when it adds no self-intersection: the crossing is usually within the tolerance already.
  let validation = validatePatchSolid(mesh);
  lap('validate');
  const unrelaxed = mesh.positions.slice();
  const remainingRay = bvhRayCaster(createBvh({ positions: s.top.positions, indices: s.top.indices.slice() }));
  let relax = relaxBoundary(mesh, fittingVertices, fittingFaces, input.margin, opts.relaxReachMm, remainingRay);
  lap('relax');
  if (relax.relaxed > 0) {
    const relaxed = validatePatchSolid(mesh);
    if (relaxed.selfIntersections > validation.selfIntersections || (validation.ok && !relaxed.ok)) {
      mesh.positions.set(unrelaxed);
      relax = { ...relax, after: relax.before, relaxed: 0 };
      if (Math.max(...relax.before) > opts.marginFitMm) warnings.push(`Relaxing the restoration's edge onto the margin would fold it (${relaxed.selfIntersections} intersecting pairs); the edge is left where the anatomy meets the tooth.`);
    } else validation = relaxed;
    lap('validate');
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : Number.NaN);
  const marginFit: InlayMarginFit = {
    samples: relax.boundary.length,
    meanMm: mean(relax.after),
    maxMm: relax.after.length ? Math.max(...relax.after) : Number.NaN,
    crossingMeanMm: mean(relax.before),
    crossingMaxMm: relax.before.length ? Math.max(...relax.before) : Number.NaN,
    relaxedVertices: relax.relaxed,
    maxRelaxMm: relax.maxMove,
    ok: relax.boundary.length > 0 && Math.max(...relax.after) <= opts.marginFitMm,
  };
  if (!marginFit.ok) {
    failures.push({
      code: 'margin-fit',
      message: `The restoration's edge is up to ${marginFit.maxMm.toFixed(3)} mm from the margin (limit ${opts.marginFitMm} mm).`,
      value: marginFit.maxMm,
      limit: opts.marginFitMm,
    });
  }

  // Checks.
  if (!validation.printable) {
    failures.push({
      code: 'not-printable',
      message: validation.ok ? `The restoration surface intersects itself (${validation.selfIntersections} triangle pairs).` : 'The restoration is not a valid closed solid.',
      value: validation.selfIntersections,
    });
  }
  const restorationRay = bvhRayCaster(createBvh({ positions: mesh.positions, indices: mesh.indices.slice() }));
  const isthmus = measureIsthmus(patch, restorationRay, axis, opts.isthmusCoreMm, minThickness);
  if (!isthmus.ok) {
    failures.push({
      code: 'isthmus-thin',
      message: `The restoration is ${Number.isFinite(isthmus.minMm) ? isthmus.minMm.toFixed(2) : '—'} mm thick over the cavity floor (minimum ${minThickness} mm): deepen the cavity.`,
      value: isthmus.minMm,
      limit: minThickness,
    });
  }
  const gapCheck = measurePatchGap(patch, jaw.ray);
  const seating = measureCavitySeating(patch, restorationRay);
  lap('checks');
  for (const d of classified.dropped) {
    if (d.thicknessMm > opts.sliverMm && Math.abs(d.volumeMm3) > 1e-3) {
      warnings.push(`A piece of the anatomy outside the margin was dropped (${Math.abs(d.volumeMm3).toFixed(3)} mm³, ${d.thicknessMm.toFixed(2)} mm thick).`);
    }
  }
  if (patch.blockout.outlineUndercutPoints > 0) warnings.push(`${patch.blockout.outlineUndercutPoints} margin points lie in an undercut along the insertion axis.`);

  // Centre, width and coronal height.
  const nm = input.margin.length / 3;
  let centre: V3 = [0, 0, 0];
  for (let i = 0; i < nm; i++) centre = add(centre, scale(pointAt(input.margin, i), 1 / nm));
  const highest = Math.max(extentAlong([mesh.positions], axis)[1], extentAlong([s.top.positions], axis)[1]);
  const coronalHeightMm = coronalHeight(jaw, input.margin, highest, axis);
  if (input.role === 'retainer' && coronalHeightMm < opts.minCoronalHeightMm) {
    warnings.push(`The abutment's coronal height is ${coronalHeightMm.toFixed(1)} mm (inlay-retained bridges need at least ${opts.minCoronalHeightMm} mm).`);
  }
  lap('measure');

  return {
    fdi: input.fdi,
    type: input.type ?? 'inlay',
    mesh,
    fittingVertices,
    fittingFaces,
    shellStart: fittingVertices,
    intaglioVertices: fittingVertices,
    centre,
    patch,
    validation,
    gapCheck,
    seating,
    marginFit,
    isthmus,
    outer: { source, ...(library ? { library } : {}), snappedVertices: shaped.lowered, liftedVertices: shaped.lifted },
    pieces: { kept: classified.kept, dropped: classified.dropped },
    coronalHeightMm,
    failures,
    warnings,
    timingsMs: timings,
  };
}


// ---- Inlay bridges: connectors limited by the proximal box, seating ---------------------

/** Inlay-bridge connector limits (spec placeholders, to confirm in domain QA). */
export const INLAY_CONNECTOR_DEFAULTS = {
  /** The connector's bottom stays this far above the box's gingival floor. */
  boxFloorClearanceMm: 0.5,
  /** As bridge mode: at least this far above the gingiva or ridge, and this far below the marginal ridge. */
  hygieneMm: CONNECTOR_HYGIENE_MM,
  embrasureMm: CONNECTOR_EMBRASURE_MM,
  /** Inlay-retained bridges: at least 3 × 3 mm. */
  minHeightMm: 3,
  minWidthMm: 3,
  /** The box is the fitting surface within this distance of the retainer's side facing the pontic. */
  boxBandMm: 2,
  /** The marginal ridge is the highest outer point within this distance of the facing side (as connectors.ts). */
  ridgeBandMm: 1.5,
};

export interface BoxConnectorLimit {
  fdi: number;
  /** Lowest point of the fitting surface in the proximal box facing the pontic (the gingival floor), and its height. */
  boxFloor: V3;
  boxFloorMm: number;
  /** Highest outer point near the facing side (the restored marginal ridge). */
  marginalRidgeMm: number;
  /** Gingiva or ridge under the connector (null: not found). */
  gingivaMm: number | null;
  /** Heights along the axis: the connector fits between bottom and top. */
  bottomMm: number;
  topMm: number;
  availableMm: number;
  /** Marginal ridge above the box floor. */
  boxDepthMm: number;
  /** Which rule sets the bottom. */
  limitedBy: 'box' | 'gingiva';
  minHeightMm: number;
  failure?: { code: 'insufficient-height'; message: string; valueMm: number; limitMm: number };
}

/**
 * Connector height an inlay retainer leaves for the connector toward a
 * pontic: the connector sits in the proximal box facing it, so its
 * available height is the box depth plus the marginal ridge:
 * - bottom: at least boxFloorClearanceMm above the box's gingival floor and
 *   hygieneMm above the gingiva or ridge under the connector;
 * - top: embrasureMm below the restored marginal ridge.
 * Fails with "insufficient connector height: box too shallow" when the box
 * floor sets the bottom and the height is under the minimum.
 */
export function inlayConnectorLimit(input: {
  design: Pick<InlayDesign, 'fdi' | 'mesh' | 'fittingVertices'>;
  /** From this retainer toward the pontic (projected ⊥ axis). */
  toward: V3;
  axis: V3;
  /** The jaw scan (the gingiva or ridge under the connector). */
  jaw: RayCaster;
  /** Where the connector is (its centre); default 1 mm beyond the retainer's facing side. */
  at?: V3;
  options?: Partial<typeof INLAY_CONNECTOR_DEFAULTS>;
}): BoxConnectorLimit {
  const o = { ...INLAY_CONNECTOR_DEFAULTS, ...input.options };
  const axis = normalize(input.axis);
  const dir = normalize(sub(input.toward, scale(axis, dot(input.toward, axis))));
  const { mesh, fittingVertices: nf } = input.design;
  const P = mesh.positions;
  const nv = P.length / 3;
  let outerMax = -Infinity, fitMax = -Infinity;
  for (let v = 0; v < nv; v++) {
    const a = dot(pointAt(P, v), dir);
    if (v < nf) fitMax = Math.max(fitMax, a);
    else outerMax = Math.max(outerMax, a);
  }
  let ridge = -Infinity;
  let facing: V3 = [0, 0, 0];
  let facingCount = 0;
  for (let v = nf; v < nv; v++) {
    const p = pointAt(P, v);
    const a = dot(p, dir);
    if (a >= outerMax - o.ridgeBandMm) ridge = Math.max(ridge, dot(p, axis));
    if (a >= outerMax - 0.3) {
      facing = add(facing, p);
      facingCount++;
    }
  }
  facing = scale(facing, 1 / Math.max(1, facingCount));
  let floorMm = Infinity;
  let floor: V3 = [0, 0, 0];
  for (let v = 0; v < nf; v++) {
    const p = pointAt(P, v);
    if (dot(p, dir) < fitMax - o.boxBandMm) continue;
    const h = dot(p, axis);
    if (h < floorMm) [floorMm, floor] = [h, p];
  }
  const at = input.at ?? add(facing, scale(dir, 1));
  const hit = input.jaw.first(add(at, scale(axis, 15)), scale(axis, -1), 40);
  const gingivaMm = hit ? dot(hit.point, axis) : null;
  const boxBottom = floorMm + o.boxFloorClearanceMm;
  const gumBottom = gingivaMm === null ? -Infinity : gingivaMm + o.hygieneMm;
  const bottomMm = Math.max(boxBottom, gumBottom);
  const topMm = ridge - o.embrasureMm;
  const availableMm = topMm - bottomMm;
  const limitedBy = boxBottom >= gumBottom ? 'box' : 'gingiva';
  const out: BoxConnectorLimit = {
    fdi: input.design.fdi,
    boxFloor: floor,
    boxFloorMm: floorMm,
    marginalRidgeMm: ridge,
    gingivaMm,
    bottomMm,
    topMm,
    availableMm,
    boxDepthMm: ridge - floorMm,
    limitedBy,
    minHeightMm: o.minHeightMm,
  };
  if (availableMm < o.minHeightMm) {
    out.failure = {
      code: 'insufficient-height',
      message:
        limitedBy === 'box'
          ? `Insufficient connector height: box too shallow (${input.design.fdi}: ${Math.max(0, availableMm).toFixed(2)} mm between the box floor and the marginal ridge, ${o.minHeightMm} mm required).`
          : `Insufficient connector height (${input.design.fdi}: ${Math.max(0, availableMm).toFixed(2)} mm above the gingiva, ${o.minHeightMm} mm required).`,
      valueMm: availableMm,
      limitMm: o.minHeightMm,
    };
  }
  return out;
}

/**
 * An inlay retainer as one end of a bridge connector (connectors.ts): its
 * mesh, the outer vertices for the facing area, a ray caster over the whole
 * solid, its fitting surface (for the signed fit clearance), the margin centroid as the unit centre, and
 * its bucco-lingual width along `buccal`.
 */
export function inlayConnectorUnit(design: InlayDesign, buccal: V3): ConnectorUnit {
  const { mesh, fittingVertices: nf, fittingFaces } = design;
  const b = normalize(buccal);
  let lo = Infinity, hi = -Infinity;
  for (let v = nf; v < mesh.positions.length / 3; v++) {
    const x = dot(pointAt(mesh.positions, v), b);
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return {
    fdi: design.fdi,
    mesh,
    shellStart: nf,
    solid: bvhRayCaster(createBvh({ positions: mesh.positions.slice(), indices: mesh.indices.slice() })),
    inner: fittingSurfaceOf(mesh, nf, fittingFaces),
    centre: design.centre,
    buccal: b,
    blMm: Number.isFinite(hi - lo) ? hi - lo : 0,
  };
}

export interface CavitySeating {
  /** Cavity vertices measured (not blocked out, at least minDistanceMm from the margin). */
  samples: number;
  /** |measured − intended gap|, from the tooth along the gap direction to `surface`. */
  meanErrorMm: number;
  maxErrorMm: number;
}

/**
 * Seating of an inlay against any surface that contains its fitting surface
 * (the retainer itself, or the merged bridge): from each cavity vertex along
 * its gap direction to the first hit, against the gap it was given. Equal
 * results for the retainer and the union mean the union left the fitting
 * surface untouched.
 */
export function measureCavitySeating(patch: FittingPatch, surface: RayCaster, options: { minDistanceMm?: number } = {}): CavitySeating {
  const minD = options.minDistanceMm ?? 0.2;
  let samples = 0, sum = 0, max = 0;
  for (let i = 0; i < patch.gap.length; i++) {
    if (patch.lift[i]! > 0 || patch.distance[i]! < minD) continue;
    const n = pointAt(patch.normals, i);
    const from = sub(pointAt(patch.tooth, i), scale(n, 1e-3));
    const hit = surface.first(from, n, patch.gap[i]! + 1);
    if (!hit) continue;
    const err = Math.abs(hit.distance - 1e-3 - patch.gap[i]!);
    samples++;
    sum += err;
    max = Math.max(max, err);
  }
  return { samples, meanErrorMm: samples ? sum / samples : Number.NaN, maxErrorMm: max };
}

/** Inlay-bridge indications (spec): warnings for a gap over maxGapMm and an abutment coronal height under minCoronalHeightMm. */
export function inlayBridgeIndications(input: {
  /** Edentulous gap between the retainers' facing sides along the arch (e.g. the pontics' spans). */
  gapMm: number;
  retainers: Array<Pick<InlayDesign, 'fdi' | 'coronalHeightMm'>>;
  options?: Partial<Pick<InlayOptions, 'maxGapMm' | 'minCoronalHeightMm'>>;
}): string[] {
  const o = { ...INLAY_DEFAULTS, ...input.options };
  const out: string[] = [];
  if (input.gapMm > o.maxGapMm) out.push(`The gap is ${input.gapMm.toFixed(1)} mm (inlay-retained bridges: at most ${o.maxGapMm} mm).`);
  for (const r of input.retainers) {
    if (r.coronalHeightMm < o.minCoronalHeightMm) out.push(`Abutment ${r.fdi}: coronal height ${r.coronalHeightMm.toFixed(1)} mm (inlay-retained bridges need at least ${o.minCoronalHeightMm} mm).`);
  }
  return out;
}
