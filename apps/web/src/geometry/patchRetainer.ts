import { marginUndercut } from './axis';
import { distanceFromMargin } from './intaglio';
import type { IndexedMesh } from './mesh';
import { boundaryLoops, validateClosedMesh, type MeshValidation } from './meshValidate';
import { computeVertexNormals } from './normals';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh, type RayCaster } from './raycast';
import { countSelfIntersections } from './selfIntersect';
import { buildVertexAdjacency, smoothVertexNormals, type SurfaceGraph } from './surface';
import type { IntaglioSurface } from './thickness';

/**
 * Surface-patch retainer: a restoration bonded to (or seated on) the tooth
 * surface inside a closed outline, built on the scan's own triangles.
 * Maryland wings use it with a uniform gap and an offset outer surface;
 * inlays and onlays use the same fitting surface with the cementGap(d) ramp
 * and plug in their own outer surface.
 *
 * Pipeline (buildFittingPatch, then patchRetainer):
 * 1. Region: the faces inside the outline loop (the prepRegion flood fill,
 *    cleaned so the loop is exactly the patch boundary).
 * 2. Patch copy: those faces as a new mesh at scan resolution; the outline
 *    loop is its only boundary loop.
 * 3. Gap: every vertex moves along the smoothed jaw normal by gap(d), d =
 *    geodesic distance to the outline.
 * 4. Blockout: every vertex is lifted along +axis to the upper envelope of
 *    the gap-offset patch (a ray from above along −axis, first hit), so the
 *    restoration can slide on along the axis. Lifted area is reported.
 * 5. Outer surface: a pluggable strategy returns one outer position per
 *    patch vertex (same topology).
 * 6. Band: a strip between the two boundary loops closes the solid.
 *
 * Unlike the crown intaglio (radial profiles) this needs no star-shaped
 * outline, so crescent-shaped wings and dumbbell-shaped MOD cavities work.
 */

/** Lifts above this count as blocked out (the fitting surface stands off the tooth there). */
export const BLOCKOUT_REPORT_MM = 0.01;
/** Lifts below this are rounding noise and are not applied. */
const LIFT_EPS_MM = 1e-4;
/** The band (restoration edge) is never thinner than this, so it never degenerates. */
export const PATCH_MIN_EDGE_MM = 0.02;

/** The jaw the patch is cut from: scan arrays (BVH-ordered index), adjacency, smoothed normals and a ray caster. */
export interface PatchJaw {
  positions: Float32Array;
  indices: Uint32Array;
  graph: SurfaceGraph;
  /** Smoothed unit vertex normals; the gap is applied along them (raw scan normals are too noisy). */
  smoothNormals: Float32Array;
  ray: RayCaster;
}

/** The region inside the outline, as prepRegion returns it, plus the outline loop. */
export interface PatchRegionInput {
  /** 1 = inside the outline or on it. */
  vertexMask: Uint8Array;
  /** 1 = all three corners in vertexMask (may include faces just outside the loop; they are dropped). */
  faceMask: Uint8Array;
  /** The outline: a closed, simple vertex loop on the jaw surface (live-wire), in order. */
  loopVertices: ArrayLike<number>;
}

/**
 * Gap between the tooth and the fitting surface (mm) at geodesic distance
 * `distanceMm` from the outline. Wings: a constant (the resin cement gap).
 * Inlays: `(d) => cementGap(d, params)` (0 at the margin, ramping in).
 */
export type PatchGap = (distanceMm: number) => number;

export interface PatchBlockout {
  /** Fitting vertices lifted by more than BLOCKOUT_REPORT_MM. */
  liftedVertices: number;
  maxLiftMm: number;
  /** Tooth-surface area (vertex areas) under the lifted vertices, mm²: not bonded / not seated. */
  areaMm2: number;
  /** areaMm2 / the patch area. */
  fraction: number;
  /**
   * Faces that face away from the insertion direction (undercuts along the
   * axis). Lifting cannot fix them: lifted, they fold back onto the envelope;
   * not lifted, they lock the restoration. Expect self-intersections or a
   * restoration that cannot seat when this is not 0.
   */
  undercutFaces: number;
  undercutAreaMm2: number;
  /** Outline points with tooth structure above them along +axis: the edge cannot seat there. */
  outlineUndercutPoints: number;
}

/** The fitting surface of a patch retainer, in local vertex ids shared by every per-vertex array. */
export interface FittingPatch {
  /** Fitting surface (gap applied, blocked out). Scan winding: faces point away from the tooth. */
  mesh: IndexedMesh;
  /** The copied tooth surface (scan positions), same ids and topology as `mesh`. */
  tooth: Float32Array;
  /** Scan vertex id of each local vertex. */
  sourceVertex: Uint32Array;
  /** The outline as the patch's boundary loop (local ids), following the scan winding. */
  boundary: Uint32Array;
  /** Local vertex adjacency. */
  graph: SurfaceGraph;
  /**
   * Unit offset directions of the fitting surface, pointing away from the tooth: the smoothed jaw normals, and
   * the lifted surface's own smoothed normals where blockout lifted it.
   */
  normals: Float32Array;
  /** Geodesic distance to the outline along patch edges (0 on the boundary). */
  distance: Float32Array;
  /** Gap applied per vertex. */
  gap: Float32Array;
  /** Blockout lift per vertex along +axis (mm, ≥ 0). */
  lift: Float32Array;
  /** Tooth-surface area per vertex (a third of each incident face). */
  vertexArea: Float32Array;
  /** Tooth-surface area inside the outline, mm². */
  areaMm2: number;
  axis: V3;
  /** Vertices of the traced outline dropped because the trace touched itself (simplifyOutlineLoop). */
  outlineDroppedVertices: number;
  blockout: PatchBlockout;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Area of each face and a third of it per corner. */
function faceAndVertexAreas(positions: Float32Array, indices: Uint32Array): { faceArea: Float32Array; vertexArea: Float32Array } {
  const faceArea = new Float32Array(indices.length / 3);
  const vertexArea = new Float32Array(positions.length / 3);
  for (let f = 0; f < faceArea.length; f++) {
    const a = indices[f * 3]! * 3, b = indices[f * 3 + 1]! * 3, c = indices[f * 3 + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    faceArea[f] = area;
    for (const v of [a, b, c]) vertexArea[v / 3] = vertexArea[v / 3]! + area / 3;
  }
  return { faceArea, vertexArea };
}

/**
 * Make a closed vertex loop simple. A live-wire trace can touch itself where
 * two segments share vertices (a spur back and forth to an anchor, or a small
 * lasso); at each repeated vertex the loop splits in two and the shorter part
 * is dropped. Consecutive vertices stay mesh edges.
 */
export function simplifyOutlineLoop(loop: ArrayLike<number>): { loop: number[]; removed: number } {
  let l = Array.from(loop);
  const original = l.length;
  for (;;) {
    const firstAt = new Map<number, number>();
    let i = -1, j = -1;
    for (let k = 0; k < l.length; k++) {
      const seen = firstAt.get(l[k]!);
      if (seen !== undefined) {
        i = seen;
        j = k;
        break;
      }
      firstAt.set(l[k]!, k);
    }
    if (j < 0) break;
    // l[i..j) and l[j..] + l[..i) are the two loops through the repeated vertex.
    l = j - i <= l.length - (j - i) ? [...l.slice(0, i), ...l.slice(j)] : l.slice(i, j);
  }
  return { loop: l, removed: original - l.length };
}

/**
 * Faces inside the outline: the masked faces reachable from the interior
 * (faces with a corner off the flood-fill barrier) without crossing a loop
 * edge. This drops masked faces just outside the loop whose three corners all
 * lie on it.
 */
function insideFaces(indices: Uint32Array, faceMask: Uint8Array, onLoop: Uint8Array, loopEdge: (a: number, b: number) => boolean, nv: number): Uint8Array {
  const nf = faceMask.length;
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const edgeFaces = new Map<number, number[]>();
  for (let f = 0; f < nf; f++) {
    if (!faceMask[f]) continue;
    for (let k = 0; k < 3; k++) {
      const a = indices[f * 3 + k]!, b = indices[f * 3 + ((k + 1) % 3)]!;
      const e = key(a, b);
      const list = edgeFaces.get(e);
      if (list) list.push(f);
      else edgeFaces.set(e, [f]);
    }
  }
  const inside = new Uint8Array(nf);
  const queue: number[] = [];
  for (let f = 0; f < nf; f++) {
    if (!faceMask[f]) continue;
    if (!onLoop[indices[f * 3]!] || !onLoop[indices[f * 3 + 1]!] || !onLoop[indices[f * 3 + 2]!]) {
      inside[f] = 1;
      queue.push(f);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const f = queue[head]!;
    for (let k = 0; k < 3; k++) {
      const a = indices[f * 3 + k]!, b = indices[f * 3 + ((k + 1) % 3)]!;
      if (loopEdge(a, b)) continue;
      for (const g of edgeFaces.get(key(a, b)) ?? []) {
        if (inside[g]) continue;
        inside[g] = 1;
        queue.push(g);
      }
    }
  }
  return inside;
}

/**
 * Steps 1–4: copy the tooth surface inside the outline, apply the gap along
 * the smoothed normals and block out along the insertion axis. A trace that
 * touches itself is simplified first. Throws when the outline does not bound
 * one disk-like region (a leaking flood fill or a hole in the scan inside it).
 */
export function buildFittingPatch(input: {
  jaw: PatchJaw;
  region: PatchRegionInput;
  /** Unit insertion axis, pointing from the tooth toward where the restoration comes from (the antagonist side). */
  axis: V3;
  gap: PatchGap;
  /** Default true. False keeps the gap-offset surface as is (the blockout is still measured). */
  blockout?: boolean;
  /** Smoothing passes over the patch for the normals of lifted (blocked-out) areas (default 3, as the jaw normals in the runner). */
  normalSmoothing?: number;
}): FittingPatch {
  const { jaw, region } = input;
  const axis = normalize(input.axis);
  const P = jaw.positions;
  const nv = P.length / 3;
  // The flood fill stopped at every vertex of the traced loop; the patch boundary is the simplified loop.
  const barrier = new Uint8Array(nv);
  for (let i = 0; i < region.loopVertices.length; i++) barrier[region.loopVertices[i]!] = 1;
  const { loop, removed: outlineVerticesDropped } = simplifyOutlineLoop(region.loopVertices);
  if (loop.length < 3) throw new Error('The outline needs at least 3 vertices');
  const onLoop = new Uint8Array(nv);
  for (const v of loop) onLoop[v] = 1;
  const loopNext = new Map<number, number>();
  loop.forEach((v, i) => loopNext.set(v, loop[(i + 1) % loop.length]!));
  const loopEdge = (a: number, b: number) => onLoop[a] === 1 && onLoop[b] === 1 && (loopNext.get(a) === b || loopNext.get(b) === a);

  // 1–2. Inside faces → compact local mesh.
  const inside = insideFaces(jaw.indices, region.faceMask, barrier, loopEdge, nv);
  const remap = new Int32Array(nv).fill(-1);
  const source: number[] = [];
  const tris: number[] = [];
  for (let f = 0; f < inside.length; f++) {
    if (!inside[f]) continue;
    for (let k = 0; k < 3; k++) {
      const v = jaw.indices[f * 3 + k]!;
      if (remap[v] === -1) {
        remap[v] = source.length;
        source.push(v);
      }
      tris.push(remap[v]!);
    }
  }
  const n = source.length;
  if (tris.length === 0) throw new Error('No surface inside the outline');
  const indices = Uint32Array.from(tris);
  const tooth = new Float32Array(n * 3);
  source.forEach((v, i) => tooth.set(P.subarray(v * 3, v * 3 + 3), i * 3));
  const loops = boundaryLoops({ positions: tooth, indices });
  if (loops.length !== 1 || loops[0]!.length !== loop.length) {
    throw new Error(
      `The outline does not bound one region (${loops.length} boundary loops, ${loops.map((l) => l.length).join('/')} vertices vs ${loop.length} on the outline): check that it is closed and the scan has no hole inside it`,
    );
  }
  const boundary = loops[0]!;
  for (const v of boundary) if (!onLoop[source[v]!]) throw new Error('The patch boundary leaves the outline');
  const graph = buildVertexAdjacency(indices, n);
  const { faceArea, vertexArea } = faceAndVertexAreas(tooth, indices);
  let areaMm2 = 0;
  for (const a of faceArea) areaMm2 += a;

  // 3. Gap along the smoothed jaw normals.
  const distance = distanceFromMargin(tooth, graph, new Uint8Array(n).fill(1), boundary);
  const gap = new Float32Array(n);
  const fit = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const g = input.gap(distance[i]!);
    gap[i] = g;
    const s = source[i]! * 3;
    for (let k = 0; k < 3; k++) fit[i * 3 + k] = tooth[i * 3 + k]! + g * jaw.smoothNormals[s + k]!;
  }

  // 4. Blockout: lift to the upper envelope of the gap-offset patch along +axis.
  const lift = new Float32Array(n);
  let top = -Infinity;
  for (let i = 0; i < n; i++) top = Math.max(top, fit[i * 3]! * axis[0] + fit[i * 3 + 1]! * axis[1] + fit[i * 3 + 2]! * axis[2]);
  top += 1;
  const envelope = bvhRayCaster(createBvh({ positions: fit.slice(), indices: indices.slice() }));
  const down: V3 = [-axis[0], -axis[1], -axis[2]];
  for (let i = 0; i < n; i++) {
    const p: V3 = [fit[i * 3]!, fit[i * 3 + 1]!, fit[i * 3 + 2]!];
    const above = top - dot(p, axis);
    const hit = envelope.first([p[0] + above * axis[0], p[1] + above * axis[1], p[2] + above * axis[2]], down, above + 1);
    if (hit) {
      const l = above - hit.distance;
      if (l > LIFT_EPS_MM) lift[i] = l;
    }
  }
  if (input.blockout ?? true) {
    for (let i = 0; i < n; i++) {
      const l = lift[i]!;
      if (l > 0) for (let k = 0; k < 3; k++) fit[i * 3 + k] = fit[i * 3 + k]! + l * axis[k]!;
    }
  }
  let liftedVertices = 0, maxLiftMm = 0, blockedArea = 0;
  for (let i = 0; i < n; i++) {
    maxLiftMm = Math.max(maxLiftMm, lift[i]!);
    if (lift[i]! > BLOCKOUT_REPORT_MM) {
      liftedVertices++;
      blockedArea += vertexArea[i]!;
    }
  }
  // Undercut faces: projected on the plane ⊥ axis they are reversed (lifting along the axis cannot change that).
  let undercutFaces = 0, undercutArea = 0;
  for (let f = 0; f < indices.length / 3; f++) {
    const a = indices[f * 3]! * 3, b = indices[f * 3 + 1]! * 3, c = indices[f * 3 + 2]! * 3;
    const ux = tooth[b]! - tooth[a]!, uy = tooth[b + 1]! - tooth[a + 1]!, uz = tooth[b + 2]! - tooth[a + 2]!;
    const vx = tooth[c]! - tooth[a]!, vy = tooth[c + 1]! - tooth[a + 1]!, vz = tooth[c + 2]! - tooth[a + 2]!;
    const projected = 0.5 * ((uy * vz - uz * vy) * axis[0] + (uz * vx - ux * vz) * axis[1] + (ux * vy - uy * vx) * axis[2]);
    if (projected < -1e-6 * Math.max(faceArea[f]!, 1e-9) - 1e-9) {
      undercutFaces++;
      undercutArea += faceArea[f]!;
    }
  }
  const outlinePoints = new Float32Array(boundary.length * 3);
  boundary.forEach((v, i) => outlinePoints.set(tooth.subarray(v * 3, v * 3 + 3), i * 3));
  const outlineUndercut = marginUndercut({ points: outlinePoints, axis, ray: jaw.ray, faceMask: new Uint8Array(jaw.indices.length / 3).fill(1) });

  const mesh: IndexedMesh = { positions: fit, indices };
  // Offset directions: the smoothed jaw normal (two-sided at the outline, and the fitting surface is parallel to the
  // tooth there); where blockout lifted the surface, the lifted surface's own smoothed normal, blended in over 0.05 mm.
  const normals = new Float32Array(n * 3);
  const lifted = (input.blockout ?? true) && lift.some((l) => l > 0);
  const own = lifted ? smoothVertexNormals(computeVertexNormals(mesh), graph, input.normalSmoothing ?? 3) : undefined;
  for (let i = 0; i < n; i++) {
    const s = source[i]! * 3;
    const w = own ? Math.min(1, lift[i]! / 0.05) : 0;
    let x = (1 - w) * jaw.smoothNormals[s]!, y = (1 - w) * jaw.smoothNormals[s + 1]!, z = (1 - w) * jaw.smoothNormals[s + 2]!;
    if (own && w > 0) {
      x += w * own[i * 3]!;
      y += w * own[i * 3 + 1]!;
      z += w * own[i * 3 + 2]!;
    }
    const l = Math.hypot(x, y, z) || 1;
    normals[i * 3] = x / l;
    normals[i * 3 + 1] = y / l;
    normals[i * 3 + 2] = z / l;
  }
  return {
    mesh,
    tooth,
    sourceVertex: Uint32Array.from(source),
    boundary,
    graph,
    normals,
    distance,
    gap,
    lift,
    vertexArea,
    areaMm2,
    axis,
    outlineDroppedVertices: outlineVerticesDropped,
    blockout: {
      liftedVertices,
      maxLiftMm,
      areaMm2: blockedArea,
      fraction: areaMm2 > 0 ? blockedArea / areaMm2 : 0,
      undercutFaces,
      undercutAreaMm2: undercutArea,
      outlineUndercutPoints: outlineUndercut.count,
    },
  };
}

/** An outer surface: one position per fitting-patch vertex (same local ids and topology). */
export interface PatchOuterSurface {
  positions: Float32Array;
}

/**
 * Outer-surface strategy (step 5). Wings offset the fitting surface by the
 * wing thickness (wingOuter); an inlay or veneer returns its anatomic outer
 * surface on the same vertices. Extra fields on the result (reports) are
 * passed through to PatchRetainer.outer.
 */
export type PatchOuter<T extends PatchOuterSurface = PatchOuterSurface> = (patch: FittingPatch) => T;

/** Outer = fitting surface + thickness[i] along the fitting normal (the boundary is kept ≥ PATCH_MIN_EDGE_MM thick). */
export function offsetOuter(patch: FittingPatch, thickness: Float32Array): Float32Array {
  const n = patch.normals.length / 3;
  const out = new Float32Array(n * 3);
  const fit = patch.mesh.positions;
  const onBoundary = new Uint8Array(n);
  for (const v of patch.boundary) onBoundary[v] = 1;
  for (let i = 0; i < n; i++) {
    const t = onBoundary[i] ? Math.max(thickness[i]!, PATCH_MIN_EDGE_MM) : thickness[i]!;
    for (let k = 0; k < 3; k++) out[i * 3 + k] = fit[i * 3 + k]! + t * patch.normals[i * 3 + k]!;
  }
  return out;
}

/**
 * Step 6: the closed solid. Vertices [0, n) are the fitting surface (faces
 * reversed, so they point toward the tooth, out of the solid), [n, 2n) the
 * outer surface (scan winding), then the band between the two boundary loops.
 */
export function closePatch(patch: FittingPatch, outer: Float32Array): IndexedMesh {
  const n = patch.mesh.positions.length / 3;
  if (outer.length !== n * 3) throw new Error('The outer surface must have one position per fitting vertex');
  const positions = new Float32Array(n * 6);
  positions.set(patch.mesh.positions, 0);
  positions.set(outer, n * 3);
  const fi = patch.mesh.indices;
  const B = patch.boundary.length;
  const indices = new Uint32Array(fi.length * 2 + B * 6);
  for (let f = 0; f < fi.length; f += 3) {
    indices[f] = fi[f]!;
    indices[f + 1] = fi[f + 2]!;
    indices[f + 2] = fi[f + 1]!;
    indices[fi.length + f] = fi[f]! + n;
    indices[fi.length + f + 1] = fi[f + 1]! + n;
    indices[fi.length + f + 2] = fi[f + 2]! + n;
  }
  let o = fi.length * 2;
  for (let i = 0; i < B; i++) {
    // The outer surface uses the boundary edge a→b, the reversed fitting surface b→a: the band uses the opposites.
    const a = patch.boundary[i]!, b = patch.boundary[(i + 1) % B]!;
    indices.set([a, b, b + n, a, b + n, a + n], o);
    o += 6;
  }
  return { positions, indices };
}

/** Closed-mesh validation plus the self-intersection test (same shape as CrownValidation). */
export type PatchValidation = MeshValidation & {
  selfIntersections: number;
  /** ok and free of self-intersections: safe to mill or print. */
  printable: boolean;
};

export function validatePatchSolid(mesh: IndexedMesh): PatchValidation {
  const closed = validateClosedMesh(mesh);
  const selfIntersections = countSelfIntersections(mesh).count;
  return { ...closed, selfIntersections, printable: closed.ok && selfIntersections === 0 };
}

/**
 * The fitting surface of a closed patch solid as an IntaglioSurface (faces
 * toward the tooth, BVH-ordered copy), for signedIntaglioDistance,
 * thicknessMap and enforceThickness.
 */
export function fittingSurfaceOf(mesh: IndexedMesh, fittingVertices: number, fittingFaces: number): IntaglioSurface {
  const positions = mesh.positions.slice(0, fittingVertices * 3);
  const indices = mesh.indices.slice(0, fittingFaces * 3);
  return { ray: bvhRayCaster(createBvh({ positions, indices })), positions, indices };
}

export interface PatchRetainer<T extends PatchOuterSurface = PatchOuterSurface> {
  /** Closed solid: fitting [0, outerStart), outer [outerStart, 2·outerStart), band. */
  mesh: IndexedMesh;
  patch: FittingPatch;
  outer: T;
  /** First outer vertex (= the fitting vertex count). */
  outerStart: number;
  /** Fitting faces come first in mesh.indices; this many. */
  fittingFaces: number;
  /** Omitted when validate is false. */
  validation?: PatchValidation;
  warnings: string[];
  timingsMs: Record<string, number>;
}

/** Warnings for a fitting patch's blockout. */
export function blockoutWarnings(b: PatchBlockout): string[] {
  const out: string[] = [];
  if (b.outlineUndercutPoints > 0) {
    out.push(`${b.outlineUndercutPoints} outline points lie in an undercut along the insertion axis: the edge cannot seat there. Move the outline or change the axis.`);
  }
  if (b.undercutFaces > 0) {
    out.push(`${b.undercutAreaMm2.toFixed(2)} mm² of the surface inside the outline is undercut along the insertion axis; the fitting surface folds there.`);
  }
  if (b.areaMm2 > 0) out.push(`Blockout lifts the fitting surface off ${b.areaMm2.toFixed(1)} mm² (${(100 * b.fraction).toFixed(0)}%) of the tooth surface.`);
  return out;
}

/**
 * Surface-patch retainer: the fitting patch (gap + blockout), an outer
 * surface from `outer`, closed by the band, validated (closed, oriented,
 * positive volume, no self-intersections) unless `validate` is false.
 */
export function patchRetainer<T extends PatchOuterSurface>(input: {
  jaw: PatchJaw;
  region: PatchRegionInput;
  axis: V3;
  gap: PatchGap;
  outer: PatchOuter<T>;
  blockout?: boolean;
  normalSmoothing?: number;
  validate?: boolean;
}): PatchRetainer<T> {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = now - t;
    t = now;
  };
  const patch = buildFittingPatch(input);
  lap('patch');
  const outer = input.outer(patch);
  lap('outer');
  const mesh = closePatch(patch, outer.positions);
  lap('close');
  const validation = input.validate === false ? undefined : validatePatchSolid(mesh);
  if (validation) lap('validate');
  const warnings = blockoutWarnings(patch.blockout);
  if (patch.outlineDroppedVertices > 0) warnings.push(`The traced outline touched itself; ${patch.outlineDroppedVertices} vertices of a spur were dropped.`);
  if (validation && !validation.ok) warnings.push('The restoration is not a valid closed solid; see the validation report.');
  else if (validation && validation.selfIntersections > 0) {
    warnings.push(`The restoration surface intersects itself (${validation.selfIntersections} triangle pairs); it cannot be milled as is.`);
  }
  const outerStart = patch.mesh.positions.length / 3;
  return {
    mesh,
    patch,
    outer,
    outerStart,
    fittingFaces: patch.mesh.indices.length / 3,
    ...(validation ? { validation } : {}),
    warnings,
    timingsMs: timings,
  };
}

export interface PatchGapCheck {
  /** Fitting vertices measured (not blocked out). */
  samples: number;
  meanMm: number;
  minMm: number;
  maxMm: number;
  /** |measured − intended gap|. */
  meanErrorMm: number;
  maxErrorMm: number;
}

/**
 * Seating check: the distance from each fitting vertex that was not blocked
 * out to the closest point of the jaw scan, against the gap it was given.
 * `minDistanceMm` skips vertices near the outline (e.g. an inlay's ramp).
 */
export function measurePatchGap(patch: FittingPatch, jaw: RayCaster, options: { minDistanceMm?: number; positions?: Float32Array } = {}): PatchGapCheck {
  const fit = options.positions ?? patch.mesh.positions;
  const minD = options.minDistanceMm ?? 0;
  let samples = 0, sum = 0, min = Infinity, max = 0, errSum = 0, errMax = 0;
  for (let i = 0; i < patch.lift.length; i++) {
    if (patch.lift[i]! > 0 || patch.distance[i]! < minD) continue;
    const cp = jaw.closestPoint([fit[i * 3]!, fit[i * 3 + 1]!, fit[i * 3 + 2]!], 1);
    if (!cp) continue;
    const err = Math.abs(cp.distance - patch.gap[i]!);
    samples++;
    sum += cp.distance;
    min = Math.min(min, cp.distance);
    max = Math.max(max, cp.distance);
    errSum += err;
    errMax = Math.max(errMax, err);
  }
  return {
    samples,
    meanMm: samples ? sum / samples : 0,
    minMm: samples ? min : 0,
    maxMm: max,
    meanErrorMm: samples ? errSum / samples : 0,
    maxErrorMm: errMax,
  };
}
