import type { CrownAdapt, DesignParams, Pose } from '@dcad/shared';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { ADAPT_OPEN_TOLERANCE_MM, adaptContacts, adaptOcclusion, findConflict, type AdaptConflict, type AdaptInput, type AdaptReport } from './adapt';
import { clearanceMap, thicknessMap, unmillableMap, type CrownMapName } from './crownMaps';
import { templateForTooth, type CrownTemplate } from './crownTemplate';
import { buildIntaglio, distanceFromMargin, measureIntaglioGap, offsetPrep, planeBasis, type GapCheck, type Intaglio } from './intaglio';
import type { IndexedMesh } from './mesh';
import { validateClosedMesh, type MeshValidation } from './meshValidate';
import { countSelfIntersections } from './selfIntersect';
import { computeVertexNormals } from './normals';
import { MinHeap } from './livewire';
import { evaluateRbfFields, solveRbfFields } from './rbf';
import { buildVertexAdjacency, type SurfaceGraph } from './surface';
import { distanceToLoop, enforceThickness, THICKNESS_RAMP_MM, type IntaglioSurface } from './thickness';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh, type RayCaster } from './raycast';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const pointAt = (a: Float32Array, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];

/** Shell vertices at or above this height fraction (cusps, occlusal third) anchor the RBF fit. */
const RBF_ANCHOR_HEIGHT = 0.7;
/** Number of zero-displacement anchors. */
const RBF_ANCHORS = 56;
/** The margin band (crown edge) is never thinner than this, so it never degenerates. */
const MIN_BAND_MM = 0.02;

export interface CrownFrame {
  origin: V3;
  occlusal: V3;
  mesial: V3;
  buccal: V3;
  mesialContact?: V3;
  distalContact?: V3;
}

/**
 * Template-local → world: x → mesial, y → buccal, z → occlusal. `epsilon`
 * is −1 when (mesial, buccal, occlusal) is left-handed (quadrants 2 and 4);
 * the rotation stays proper and the mirror goes into scale.x.
 */
export interface CrownAxes {
  x: V3;
  y: V3;
  z: V3;
  epsilon: 1 | -1;
}

export function crownAxes(frame: CrownFrame): CrownAxes {
  const z = normalize(frame.occlusal);
  const x = normalize(sub(frame.mesial, scale(z, dot(frame.mesial, z))));
  let y = sub(frame.buccal, add(scale(z, dot(frame.buccal, z)), scale(x, dot(frame.buccal, x))));
  y = normalize(y);
  const epsilon = dot(cross(x, y), z) >= 0 ? 1 : -1;
  return { x, y, z, epsilon };
}

/** Rotation of a template pose from the crown axes (the mirror, if any, goes into scale.x). */
export function poseRotation(axes: CrownAxes): Quaternion {
  const m = new Matrix4().makeBasis(
    new Vector3(...scale(axes.x, axes.epsilon)),
    new Vector3(...axes.y),
    new Vector3(...axes.z),
  );
  return new Quaternion().setFromRotationMatrix(m);
}

/** Apply a pose to a template-local point. */
export function poseTransform(pose: Pose): (p: V3) => V3 {
  const m = new Matrix4().compose(new Vector3(...pose.position), new Quaternion(...pose.quaternion), new Vector3(...pose.scale));
  const e = m.elements;
  return (p) => [
    e[0]! * p[0] + e[4]! * p[1] + e[8]! * p[2] + e[12]!,
    e[1]! * p[0] + e[5]! * p[1] + e[9]! * p[2] + e[13]!,
    e[2]! * p[0] + e[6]! * p[1] + e[10]! * p[2] + e[14]!,
  ];
}

/**
 * Initial template pose: at the margin centroid in the tooth frame, scaled
 * to the gap between the neighbour contacts (MD), the margin's width (BL) and
 * the space up to the antagonist (height, never lower than the prep plus the
 * minimum material thickness).
 */
export function proposeCrownPose(input: {
  template: CrownTemplate;
  frame: CrownFrame;
  margin: Float32Array;
  /** Height of the prep top above the margin centroid along occlusal. */
  prepHeightMm: number;
  antagonist?: RayCaster;
  params: Pick<DesignParams, 'occlusalClearanceMm' | 'minThicknessMm'>;
}): { pose: Pose; warnings: string[] } {
  const { template, frame, margin, params } = input;
  const warnings: string[] = [];
  const axes = crownAxes(frame);
  const n = margin.length / 3;
  let centroid: V3 = [0, 0, 0];
  for (let i = 0; i < n; i++) centroid = add(centroid, scale(pointAt(margin, i), 1 / n));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = sub(pointAt(margin, i), centroid);
    minX = Math.min(minX, dot(d, axes.x));
    maxX = Math.max(maxX, dot(d, axes.x));
    minY = Math.min(minY, dot(d, axes.y));
    maxY = Math.max(maxY, dot(d, axes.y));
  }
  const marginMd = maxX - minX;
  const marginBl = maxY - minY;
  let md = marginMd * 1.2;
  if (frame.mesialContact && frame.distalContact) {
    const gap = dot(sub(frame.mesialContact, frame.distalContact), axes.x);
    if (gap > marginMd * 0.8 && gap < marginMd * 2) md = gap;
    else warnings.push('The neighbour contacts do not match the margin width; sized from the margin instead.');
  }
  const bl = marginBl * 1.15;
  let height = template.size.height;
  const up = input.antagonist?.first(centroid, axes.z, 25);
  if (up) height = up.distance - params.occlusalClearanceMm;
  else warnings.push('No antagonist above the prep; using the template height.');
  const minHeight = input.prepHeightMm + params.minThicknessMm + 0.5;
  if (height < minHeight) {
    warnings.push('Little occlusal space: the crown is taller than the antagonist allows (check the reduction).');
    height = minHeight;
  }
  height = Math.min(Math.max(height, 4), Math.max(10, minHeight));
  const q = poseRotation(axes);
  return {
    pose: {
      position: centroid,
      quaternion: [q.x, q.y, q.z, q.w],
      scale: [(axes.epsilon * md) / template.size.md, bl / template.size.bl, height / template.size.height],
    },
    warnings,
  };
}

/** Normalized cumulative arc length of a closed loop (first point = 0). */
function arcFractions(points: V3[]): number[] {
  const n = points.length;
  const cum = [0];
  for (let i = 1; i <= n; i++) {
    const a = points[i - 1]!, b = points[i % n]!;
    cum.push(cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = cum[n]!;
  return cum.slice(0, n).map((c) => c / total);
}

/** Signed area of a loop projected on the plane ⊥ axis (positive = CCW seen from +axis). */
function signedArea(points: V3[], axis: V3): number {
  const [u, v] = planeBasis(axis);
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!, q = points[(i + 1) % points.length]!;
    a += dot(p, u) * dot(q, v) - dot(q, u) * dot(p, v);
  }
  return a / 2;
}

/** Order a closed loop CCW around `axis`, starting at the point furthest along `start`. */
function orderLoop(points: V3[], axis: V3, start: V3): number[] {
  const n = points.length;
  const ccw = signedArea(points, axis) >= 0;
  let first = 0;
  for (let i = 1; i < n; i++) if (dot(points[i]!, start) > dot(points[first]!, start)) first = i;
  return Array.from({ length: n }, (_, k) => (ccw ? (first + k) % n : (first - k + n) % n));
}

/** Point at normalized arc fraction f along a closed loop (fractions from arcFractions). */
function sampleLoop(points: V3[], fractions: number[], f: number): V3 {
  const n = points.length;
  let i = 0;
  while (i < n - 1 && fractions[i + 1]! <= f) i++;
  const f0 = fractions[i]!;
  const f1 = i + 1 < n ? fractions[i + 1]! : 1;
  const t = f1 > f0 ? (f - f0) / (f1 - f0) : 0;
  const a = points[i]!, b = points[(i + 1) % n]!;
  return add(a, scale(sub(b, a), t));
}

/** Closed-mesh validation plus the self-intersection test. */
export type CrownValidation = MeshValidation & {
  /** Intersecting triangle pairs (not sharing a vertex). */
  selfIntersections: number;
  /** ok and free of self-intersections: safe to mill or print. */
  printable: boolean;
};

/**
 * One adaptation's outcome: `conflict` when thickness won over the clearance
 * target, `open` when the surface is still farther than the target (the
 * contact or the occlusion is open; Infinity = nothing within reach).
 */
export type CrownAdaptReport = AdaptReport & { targetMm: number; conflict?: AdaptConflict; open?: { clearanceMm: number } };

export interface CrownDesign {
  /** Closed crown: intaglio (rim first), template shell, margin band. */
  mesh: IndexedMesh;
  pose: Pose;
  templateId: string;
  validation: CrownValidation;
  /** Adaptation results, for the targets set in input.adapt. */
  adapt?: { occlusion?: CrownAdaptReport; mesial?: CrownAdaptReport; distal?: CrownAdaptReport };
  /** Smallest material thickness along the insertion axis (intaglio → outer surface). */
  minAxialThicknessMm: number;
  gapCheck: GapCheck;
  intaglioVertices: number;
  /** First outer-shell vertex (= intaglioVertices); shell vertices run to the end of the mesh. */
  shellStart: number;
  /**
   * Per crown vertex: how far it follows a translation of the pose (0 =
   * pinned, 1 = moves with the pose). The fit is linear in the pose position,
   * so a move by d shifts vertex v by moveWeights[v]·d, up to thickness
   * enforcement and adaptation. Intaglio vertices are 0, the cervical ring 0,
   * the cusps 1. Used for instant move previews.
   */
  moveWeights: Float32Array;
  thickness: {
    /** Smallest material thickness (closest point to the intaglio) at least 1 mm from the margin. */
    minMm: number;
    /** Smallest (thickness − profile) over the shell; ≥ 0 means the profile holds everywhere. */
    minSlackMm: number;
    pushedVertices: number;
    /** Largest single push applied by the enforcement. */
    maxPushMm: number;
  };
  /** Per-vertex colour-map scalars (NaN = not applicable), when requested. */
  maps?: Partial<Record<CrownMapName, Float32Array>>;
  warnings: string[];
  timingsMs: Record<string, number>;
}

export interface CrownInput {
  fdi: number;
  /** The prep jaw: scan arrays plus its surface graph, smoothed normals and ray caster. */
  jaw: { positions: Float32Array; indices: Uint32Array; graph: SurfaceGraph; smoothNormals: Float32Array; ray: RayCaster };
  antagonist?: RayCaster;
  region: { vertexMask: Uint8Array; faceMask: Uint8Array; loopVertices: ArrayLike<number> };
  frame: CrownFrame;
  /** Dense closed margin, xyz per point. */
  margin: Float32Array;
  axis: V3;
  params: DesignParams;
  /** Stored pose; omitted = propose one. */
  pose?: Pose;
  template?: CrownTemplate;
  /** Colour maps to compute (after adaptation, so they show its result). */
  maps?: CrownMapName[];
  /** Adaptation targets (antagonist clearance, neighbour contacts). */
  adapt?: CrownAdapt;
  /**
   * Neighbouring teeth for the proximal map. Default: the prep jaw with the
   * prep region grown by 1 mm (geodesic) ignored.
   */
  neighbours?: { ray: RayCaster; faceMask?: Uint8Array };
}

const shellGraphs = new WeakMap<CrownTemplate, SurfaceGraph>();
/** Vertex adjacency of a template shell (local ids), cached per template. */
function shellGraphOf(template: CrownTemplate): SurfaceGraph {
  let g = shellGraphs.get(template);
  if (!g) {
    g = buildVertexAdjacency(template.mesh.indices, template.mesh.positions.length / 3);
    shellGraphs.set(template, g);
  }
  return g;
}

/** Ray caster over a mesh, keeping the BVH-ordered index so closest-point face ids match. */
export function meshSurface(mesh: IndexedMesh): IntaglioSurface {
  const positions = mesh.positions.slice();
  const indices = mesh.indices.slice();
  return { ray: bvhRayCaster(createBvh({ positions, indices })), positions, indices };
}

/** Proximal map: only vertices whose normal is within ~45° of horizontal (|n·occlusal| ≤ this). */
const PROXIMAL_MAX_AXIAL = 0.7;
/** Geodesic width of the band around the prep that the proximal map ignores (gingiva and prep shoulder). */
const PROXIMAL_IGNORE_MM = 1;

/**
 * Prep-jaw faces to ignore for proximal contacts: the prep region grown by
 * PROXIMAL_IGNORE_MM of geodesic distance. (Growing by graph rings is wrong on
 * anisotropic scan meshes: rings sized for short edges cover millimetres along
 * long ones and swallow the neighbours.)
 */
function ignoredPrepFaces(
  jaw: { positions: Float32Array; indices: Uint32Array; graph: SurfaceGraph },
  region: { vertexMask: Uint8Array; loopVertices: ArrayLike<number> },
): Uint8Array {
  const P = jaw.positions;
  const n = P.length / 3;
  const grown = region.vertexMask.slice();
  const dist = new Float32Array(n).fill(Infinity);
  const heap = new MinHeap();
  const top: [number, number] = [0, 0];
  for (let i = 0; i < region.loopVertices.length; i++) {
    const v = region.loopVertices[i]!;
    dist[v] = 0;
    heap.push(0, v);
  }
  while (heap.size > 0) {
    heap.pop(top);
    const [d, u] = top;
    if (d > dist[u]!) continue;
    grown[u] = 1;
    for (let k = jaw.graph.offsets[u]!; k < jaw.graph.offsets[u + 1]!; k++) {
      const v = jaw.graph.neighbors[k]!;
      if (region.vertexMask[v]) continue;
      const nd = d + Math.hypot(P[v * 3]! - P[u * 3]!, P[v * 3 + 1]! - P[u * 3 + 1]!, P[v * 3 + 2]! - P[u * 3 + 2]!);
      if (nd <= PROXIMAL_IGNORE_MM && nd < dist[v]!) {
        dist[v] = nd;
        heap.push(nd, v);
      }
    }
  }
  const faces = new Uint8Array(jaw.indices.length / 3);
  for (let f = 0; f < faces.length; f++) {
    if (grown[jaw.indices[f * 3]!] || grown[jaw.indices[f * 3 + 1]!] || grown[jaw.indices[f * 3 + 2]!]) faces[f] = 1;
  }
  return faces;
}

/** A library template placed by a pose, with its cervical ring ordered around an axis. */
export interface PlacedShell {
  template: CrownTemplate;
  /** World positions of the template vertices; the fit moves them in place. */
  shell: Float32Array;
  /** The pose mirrors the template (quadrants 2 and 4): faces are flipped when assembled. */
  mirrored: boolean;
  /** Cervical ring vertex ids (template-local), CCW seen from +axis, starting at the most mesial one. */
  ring: number[];
  /** Placed ring positions, in ring order. */
  ringPoints: V3[];
  /** Normalized arc-length fraction of each ring point. */
  fractions: number[];
}

/** Place a template by its pose and order its cervical ring CCW around `axis`, starting at the most `mesial` point. */
export function placeShell(template: CrownTemplate, pose: Pose, axis: V3, mesial: V3): PlacedShell {
  const toWorld = poseTransform(pose);
  const mirrored = pose.scale[0] * pose.scale[1] * pose.scale[2] < 0;
  const tv = template.mesh.positions.length / 3;
  const shell = new Float32Array(tv * 3);
  for (let i = 0; i < tv; i++) shell.set(toWorld(pointAt(template.mesh.positions, i)), i * 3);
  const loopPoints = Array.from(template.cervicalLoop, (v) => pointAt(shell, v));
  const order = orderLoop(loopPoints, axis, mesial);
  const ringPoints = order.map((i) => loopPoints[i]!);
  return { template, shell, mirrored, ring: order.map((i) => template.cervicalLoop[i]!), ringPoints, fractions: arcFractions(ringPoints) };
}

/**
 * Everything after the inner surface, shared by crowns and pontics: the band
 * (outer cervical loop), the RBF fit of the shell, assembly into one closed
 * mesh, thickness, adaptation, validation and the colour maps.
 */
export interface ShellFinishInput {
  placed: PlacedShell;
  pose: Pose;
  axes: CrownAxes;
  /** The inner surface's axis (insertion axis): the band lies ⊥ to it and the axial thickness is measured along it. */
  axis: V3;
  /** Inner surface (crown intaglio, pontic base): its first ring.length vertices are the rim, in ring order, CCW from +axis. */
  inner: Intaglio;
  /** The rim, xyz per ring point. */
  rim: Float32Array;
  /** Width of the band that joins the rim to the shell's cervical ring. */
  bandMm: number;
  params: DesignParams;
  /** 'enforce': push the shell out to the thickness profile (crowns); 'measure': report only (solid pontics). */
  thickness: 'enforce' | 'measure';
  /** The jaw scan: neighbours for the proximal adaptation and map. */
  jawRay: RayCaster;
  /** Jaw faces that are not neighbours (the prep and its band); computed once, on first use. */
  ignoredFaces: () => Uint8Array | undefined;
  antagonist?: RayCaster;
  adapt?: CrownAdapt;
  maps?: CrownMapName[];
  neighbours?: { ray: RayCaster; faceMask?: Uint8Array };
  /** Fit check of the inner surface (crowns: the cement gap on the axial walls). */
  gapCheck: (inner: IntaglioSurface) => GapCheck;
  /**
   * Implant crowns (implantCrown.ts): the cervical ring is pinned to `ringTargets` (xyz per ring point, on the
   * gingiva) instead of the band's outer loop, and `rows` builds the emergence profile between them: rows of
   * ring.length points from just above the outer loop up to just below the fitted ring, given the outer loop and the
   * fitted shell. Their vertices (the outer loop, then the rows) follow the template shell, with move weight 0.
   */
  emergence?: { ringTargets: Float32Array; rows: (outer: Float32Array, shell: Float32Array) => Float32Array[] };
  warnings: string[];
  timings: Record<string, number>;
  lap: (name: string) => void;
}

export interface FinishedShell {
  design: CrownDesign;
  /** The inner surface with its BVH (closest points and rays). */
  inner: IntaglioSurface;
  /** The shell's pinned cervical loop, xyz per point. */
  outerLoop: Float32Array;
}

/** Fit, assemble, check and adapt a placed shell over its inner surface (see ShellFinishInput). */
export function fitAndFinishShell(input: ShellFinishInput): FinishedShell {
  const { placed, pose, axes, axis, inner: intaglio, rim, params, warnings, timings, lap } = input;
  const { template, shell, ring, mirrored } = placed;
  const tv = template.mesh.positions.length / 3;
  const T = ring.length;

  // Outer margin loop: the margin offset outward (in the plane ⊥ axis) by the margin thickness.
  const band = input.bandMm;
  const outer: V3[] = [];
  for (let i = 0; i < T; i++) {
    const prev = pointAt(rim, (i - 1 + T) % T);
    const next = pointAt(rim, (i + 1) % T);
    let tangent = sub(next, prev);
    tangent = sub(tangent, scale(axis, dot(tangent, axis)));
    outer.push(add(pointAt(rim, i), scale(normalize(cross(tangent, axis)), band)));
  }

  // RBF fit: the placed cervical ring moves onto the outer loop; anchors on the occlusal third stay put.
  const anchorIds: number[] = [];
  for (let v = 0; v < tv; v++) if (template.heightFraction[v]! >= RBF_ANCHOR_HEIGHT) anchorIds.push(v);
  const stride = Math.max(1, Math.floor(anchorIds.length / RBF_ANCHORS));
  const anchors = anchorIds.filter((_, k) => k % stride === 0);
  const centers = new Float64Array((T + anchors.length) * 3);
  const values = new Float64Array((T + anchors.length) * 3);
  const emergence = input.emergence;
  const ringTarget = (i: number): V3 => (emergence ? pointAt(emergence.ringTargets, i) : outer[i]!);
  ring.forEach((v, i) => {
    const c = pointAt(shell, v);
    centers.set(c, i * 3);
    values.set(sub(ringTarget(i), c), i * 3);
  });
  anchors.forEach((v, k) => centers.set(pointAt(shell, v), (T + k) * 3));
  // Solved together with the move response: the same fit with a unit displacement on the ring and none on the
  // anchors. Translating the pose by d changes the ring values by −d and leaves the anchors at 0, so (by linearity) a
  // vertex moves by (1 − response)·d.
  const unit = new Float64Array(values.length);
  for (let i = 0; i < T; i++) unit[i * 3] = 1;
  const fields = solveRbfFields(centers, [values, unit], { kernel: 'cubic' });
  const shellMoveWeights = new Float32Array(tv);
  const out = new Float64Array(6);
  for (let v = 0; v < tv; v++) {
    evaluateRbfFields(fields, pointAt(shell, v), out);
    shell[v * 3] = shell[v * 3]! + out[0]!;
    shell[v * 3 + 1] = shell[v * 3 + 1]! + out[1]!;
    shell[v * 3 + 2] = shell[v * 3 + 2]! + out[2]!;
    shellMoveWeights[v] = 1 - out[3]!;
  }
  // Ring vertices land exactly on the outer loop (and are pinned).
  ring.forEach((v, i) => {
    shell.set(ringTarget(i), v * 3);
    shellMoveWeights[v] = 0;
  });
  lap('fit');

  // Implant crowns: the emergence vertices (outer loop, then each row) go after the shell.
  let emergenceRows: Float32Array[] = [];
  if (emergence) {
    const outerRow = new Float32Array(T * 3);
    outer.forEach((p, i) => outerRow.set(p, i * 3));
    emergenceRows = [outerRow, ...emergence.rows(outerRow, shell)];
  }
  const ne = emergenceRows.length * T;

  // Assemble: intaglio | shell | band.
  const ni = intaglio.mesh.positions.length / 3;
  const positions = new Float32Array((ni + tv + ne) * 3);
  positions.set(intaglio.mesh.positions, 0);
  positions.set(shell, ni * 3);
  emergenceRows.forEach((row, k) => positions.set(row, (ni + tv + k * T) * 3));
  const moveWeights = new Float32Array(ni + tv + ne);
  moveWeights.set(shellMoveWeights, ni);

  const ti = template.mesh.indices;
  const indices = new Uint32Array(intaglio.mesh.indices.length + ti.length + T * 6 * (emergenceRows.length + 1));
  indices.set(intaglio.mesh.indices, 0);
  let o = intaglio.mesh.indices.length;
  for (let f = 0; f < ti.length; f += 3) {
    const a = ti[f]! + ni, b = ti[f + 1]! + ni, c = ti[f + 2]! + ni;
    indices.set(mirrored ? [a, c, b] : [a, b, c], o);
    o += 3;
  }
  // Strips from the rim (inner, lower) out and up to the ring: one band, or the band then the emergence rows.
  const strips = [...emergenceRows.map((_, k) => (i: number) => ni + tv + k * T + i), (i: number) => ring[i]! + ni];
  let lower = (i: number) => i;
  for (const upper of strips) {
    for (let i = 0; i < T; i++) {
      const j = (i + 1) % T;
      const mi = lower(i), mj = lower(j), oi = upper(i), oj = upper(j);
      // Rim and ring run CCW seen from +axis with the ring outside: this order faces −axis (the crown's underside).
      indices.set([mi, mj, oj, mi, oj, oi], o);
      o += 6;
    }
    lower = upper;
  }
  const mesh: IndexedMesh = { positions, indices };

  // Thickness: push the outer shell to the profile (the cervical ring is pinned); a pontic only measures it.
  const intaglioSurface = meshSurface(intaglio.mesh);
  const fixed = new Uint8Array(tv);
  for (const v of ring) fixed[v] = 1;
  const outerLoop = new Float32Array(T * 3);
  outer.forEach((p, i) => outerLoop.set(p, i * 3));
  const enforce = () =>
    enforceThickness({
      positions,
      vertexStart: ni,
      vertexEnd: ni + tv,
      intaglio: intaglioSurface,
      marginLoop: outerLoop,
      params,
      shellGraph: shellGraphOf(template),
      fixed,
      ...(input.thickness === 'measure' ? { iterations: 0 } : {}),
    });
  let enforced = enforce();
  lap('thickness');

  // Adaptation to the antagonist and the neighbours, then thickness again (it wins), then conflicts.
  let ignored: { faces: Uint8Array | undefined } | undefined;
  const ignoredFaces = () => (ignored ??= { faces: input.ignoredFaces() }).faces;
  const adaptReports: NonNullable<CrownDesign['adapt']> = {};
  const checks: Array<{ key: 'occlusion' | 'mesial' | 'distal'; input: Omit<AdaptInput, 'shellGraph'>; kind: AdaptConflict['kind'] }> = [];
  const adaptBase = (target: RayCaster, direction: V3, targetMm: number, ignoreFaces?: Uint8Array) => ({
    positions,
    normals: computeVertexNormals(mesh),
    shellStart: ni,
    shellGraph: shellGraphOf(template),
    heightFraction: template.heightFraction,
    fixed,
    target,
    ignoreFaces,
    direction,
    targetMm,
  });
  const adapt = input.adapt;
  if (adapt?.occlusion) {
    if (!input.antagonist) {
      warnings.push('No antagonist scan: occlusal adaptation skipped.');
    } else {
      const base = adaptBase(input.antagonist, axes.z, adapt.occlusion.clearanceMm);
      adaptReports.occlusion = { ...adaptOcclusion(base), targetMm: adapt.occlusion.clearanceMm };
      checks.push({ key: 'occlusion', input: { ...base, select: (n, h) => h >= 0.5 && dot(n, axes.z) > 0.2 }, kind: 'insufficient reduction' });
    }
  }
  for (const side of ['mesial', 'distal'] as const) {
    const target = adapt?.[side];
    if (!target) continue;
    const direction = side === 'mesial' ? axes.x : scale(axes.x, -1);
    const base = adaptBase(input.jawRay, direction, target.targetMm, ignoredFaces());
    adaptReports[side] = { ...adaptContacts(base), targetMm: target.targetMm };
    checks.push({ key: side, input: { ...base, select: (n, h) => h >= 0.3 && h <= 0.9 && dot(n, direction) > 0.5 }, kind: 'contact too tight' });
  }
  if (checks.length > 0) {
    const first = enforced;
    enforced = enforce();
    enforced.pushedVertices = Math.max(enforced.pushedVertices, first.pushedVertices);
    enforced.maxPushMm = Math.max(enforced.maxPushMm, first.maxPushMm);
    for (const c of checks) {
      const { minClearanceMm, conflict } = findConflict(c.input, c.kind);
      const report = adaptReports[c.key]!;
      report.minClearanceMm = minClearanceMm;
      if (!conflict && !(minClearanceMm <= report.targetMm + ADAPT_OPEN_TOLERANCE_MM)) {
        report.open = { clearanceMm: minClearanceMm };
        const what = c.key === 'occlusion' ? 'Occlusion open' : `${c.key === 'mesial' ? 'Mesial' : 'Distal'} contact open`;
        const toward = c.key === 'occlusion' ? 'occlusally' : c.key === 'mesial' ? 'mesially' : 'distally';
        const gap = Number.isFinite(minClearanceMm) ? `${minClearanceMm.toFixed(2)} mm` : 'nothing within 3 mm';
        warnings.push(`${what}: ${gap} (target ${report.targetMm} mm). Move the crown ${toward} and re-adapt.`);
      }
      if (conflict) {
        report.conflict = conflict;
        warnings.push(
          c.key === 'occlusion'
            ? `Insufficient reduction: ${conflict.vertices} points stay ${conflict.minClearanceMm.toFixed(2)} mm from the antagonist (target ${report.targetMm} mm) because of the minimum thickness.`
            : `Contact too tight (${c.key}): ${conflict.vertices} points at ${conflict.minClearanceMm.toFixed(2)} mm (target ${report.targetMm} mm) because of the minimum thickness.`,
        );
      }
    }
    lap('adapt');
  }

  lap('assemble');

  const closed = validateClosedMesh(mesh);
  const selfIntersections = countSelfIntersections(mesh).count;
  const validation: CrownValidation = { ...closed, selfIntersections, printable: closed.ok && selfIntersections === 0 };
  if (!closed.ok) warnings.push('The crown mesh is not a valid closed solid; see the validation report.');
  else if (selfIntersections > 0) warnings.push(`The crown surface intersects itself (${selfIntersections} triangle pairs); it cannot be milled as is.`);
  lap('validate');

  // Axial thickness: from each inner intaglio vertex up to the outer surface.
  const crownRay = bvhRayCaster(createBvh({ positions: positions.slice(), indices: indices.slice() }));
  let minAxial = Infinity;
  for (let v = intaglio.rimCount; v < ni; v++) {
    const p = add(pointAt(positions, v), scale(axis, 1e-3));
    const hit = crownRay.first(p, axis, 30);
    if (hit) minAxial = Math.min(minAxial, hit.distance + 1e-3);
  }
  // Thickness away from the margin ramp (comparable to minThicknessMm), from the enforcement's final measurement.
  let minFar = Infinity;
  for (let v = 0; v < tv; v++) {
    const t = enforced.thicknessMm[v]!;
    if (Number.isNaN(t) || t >= minFar) continue;
    if (distanceToLoop(pointAt(positions, ni + v), outerLoop) >= THICKNESS_RAMP_MM) minFar = t;
  }
  if (input.thickness === 'enforce' && enforced.minSlackAfterMm < -0.02) {
    warnings.push(`Material is ${(-enforced.minSlackAfterMm).toFixed(2)} mm thinner than required in places after enforcement.`);
  }
  lap('thicknessCheck');

  const gapCheck = input.gapCheck(intaglioSurface);
  lap('gapCheck');

  let maps: Partial<Record<CrownMapName, Float32Array>> | undefined;
  if (input.maps?.length) {
    maps = {};
    const normals = computeVertexNormals(mesh);
    for (const name of input.maps) {
      if (name === 'thickness') maps.thickness = thicknessMap(positions, ni, ni + tv, intaglioSurface);
      if (name === 'occlusion' && input.antagonist) {
        maps.occlusion = clearanceMap({ positions, normals, vertexStart: ni, vertexEnd: ni + tv, target: input.antagonist });
      }
      if (name === 'proximal') {
        const neighbours = input.neighbours ?? { ray: input.jawRay, faceMask: ignoredFaces() };
        const proximal = clearanceMap({ positions, normals, vertexStart: ni, vertexEnd: ni + tv, target: neighbours.ray, ignoreFaces: neighbours.faceMask });
        // Proximal contacts are on the sides: drop vertices facing mostly occlusal or cervical.
        for (let v = ni; v < ni + tv; v++) {
          if (Math.abs(dot(pointAt(normals, v), axes.z)) > PROXIMAL_MAX_AXIAL) proximal[v] = Number.NaN;
        }
        maps.proximal = proximal;
      }
      if (name === 'unmillable') {
        maps.unmillable = unmillableMap({ positions, vertexStart: 0, vertexEnd: ni, intaglio: intaglioSurface.ray, axis, toolRadiusMm: params.toolRadiusMm });
      }
    }
    lap('maps');
  }

  const design: CrownDesign = {
    mesh,
    pose,
    templateId: template.id,
    validation,
    minAxialThicknessMm: minAxial,
    gapCheck,
    intaglioVertices: ni,
    shellStart: ni,
    moveWeights,
    thickness: {
      minMm: minFar,
      minSlackMm: enforced.minSlackAfterMm,
      pushedVertices: enforced.pushedVertices,
      maxPushMm: enforced.maxPushMm,
    },
    ...(maps ? { maps } : {}),
    ...(checks.length > 0 ? { adapt: adaptReports } : {}),
    warnings,
    timingsMs: timings,
  };
  return { design, inner: intaglioSurface, outerLoop };
}

/** The pose designCrown proposes when none is stored: proposeCrownPose with the prep height over the margin centroid. */
export function proposeCrownPoseFor(
  input: Pick<CrownInput, 'fdi' | 'jaw' | 'region' | 'frame' | 'margin' | 'antagonist' | 'params' | 'template'>,
): { pose: Pose; warnings: string[] } {
  const { jaw, region, frame } = input;
  const template = input.template ?? templateForTooth(input.fdi);
  const axes = crownAxes(frame);
  // Prep height above the margin centroid (for the minimum crown height).
  const nm = input.margin.length / 3;
  let centroid: V3 = [0, 0, 0];
  for (let i = 0; i < nm; i++) centroid = add(centroid, scale(pointAt(input.margin, i), 1 / nm));
  let prepHeight = 0;
  for (let v = 0; v < region.vertexMask.length; v++) {
    if (region.vertexMask[v]) prepHeight = Math.max(prepHeight, dot(sub(pointAt(jaw.positions, v), centroid), axes.z));
  }
  return proposeCrownPose({ template, frame, margin: input.margin, prepHeightMm: prepHeight, antagonist: input.antagonist, params: input.params });
}

/**
 * Crown: intaglio (gap + blockout) + library template placed in the tooth
 * frame, fitted with an RBF displacement field that pins its cervical ring to
 * the margin (offset by the margin thickness) while the cusps stay put, pushed
 * out to the thickness profile, and joined to the intaglio by the margin band
 * into one closed, outward-oriented mesh.
 */
export function designCrown(input: CrownInput): CrownDesign {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = now - t;
    t = now;
  };
  const { jaw, region, params, frame } = input;
  const warnings: string[] = [];
  const template = input.template ?? templateForTooth(input.fdi);
  const axis = normalize(input.axis);
  const axes = crownAxes(frame);
  const nm = input.margin.length / 3;

  let pose = input.pose;
  if (!pose) {
    const proposal = proposeCrownPoseFor(input);
    pose = proposal.pose;
    warnings.push(...proposal.warnings);
  }
  lap('pose');

  // Place the template; pair its cervical ring with the margin by arc length, both CCW around the axis from the mesial end.
  const placed = placeShell(template, pose, axis, axes.x);
  const marginPoints = Array.from({ length: nm }, (_, i) => pointAt(input.margin, i));
  const marginOrdered = orderLoop(marginPoints, axis, axes.x).map((i) => marginPoints[i]!);
  const marginFractions = arcFractions(marginOrdered);
  const T = placed.ring.length;
  const rim = new Float32Array(T * 3);
  for (let i = 0; i < T; i++) rim.set(sampleLoop(marginOrdered, marginFractions, placed.fractions[i]!), i * 3);
  lap('pairing');

  // Intaglio on the gap-offset prep.
  const distance = distanceFromMargin(jaw.positions, jaw.graph, region.vertexMask, region.loopVertices);
  const offset = offsetPrep({ positions: jaw.positions, indices: jaw.indices, normals: jaw.smoothNormals, faceMask: region.faceMask, distance, params });
  lap('offset');
  const intaglio = buildIntaglio({ offset: offset.ray, rim, axis });
  warnings.push(...intaglio.warnings);
  lap('intaglio');

  return fitAndFinishShell({
    placed,
    pose,
    axes,
    axis,
    inner: intaglio,
    rim,
    bandMm: Math.max(params.marginThicknessMm, MIN_BAND_MM),
    params,
    thickness: 'enforce',
    jawRay: jaw.ray,
    ignoredFaces: () => ignoredPrepFaces(jaw, region),
    antagonist: input.antagonist,
    adapt: input.adapt,
    maps: input.maps,
    neighbours: input.neighbours,
    gapCheck: (inner) =>
      measureIntaglioGap({
        positions: jaw.positions,
        normals: jaw.smoothNormals,
        vertexMask: region.vertexMask,
        distance,
        axis,
        params,
        intaglio: inner.ray,
      }),
    warnings,
    timings,
    lap,
  }).design;
}
