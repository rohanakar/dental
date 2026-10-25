import type { CrownAdapt, DesignParams, Pose } from '@dcad/shared';
import { crownAxes, fitAndFinishShell, placeShell, poseRotation, type CrownDesign, type CrownFrame } from './crown';
import type { CrownMapName } from './crownMaps';
import { templateForTooth, type CrownTemplate } from './crownTemplate';
import { buildIntaglio } from './intaglio';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh, type RayCaster } from './raycast';

/**
 * Pontic: a library tooth over the edentulous ridge, with no prep. Same
 * result shape as a crown (CrownDesign), so maps, adaptation, move weights
 * and the gizmo work unchanged:
 * - rim: the posed template's cervical footprint, narrowed to
 *   PONTIC_RIM_SCALE (a smaller tissue-contact area), projected along −axis
 *   onto the ridge and raised by ponticRidgeGapMm;
 * - base: the ridge's upper envelope inside the rim (buildIntaglio's radial
 *   profiles on the ridge raised by the gap), faces toward the ridge;
 * - shell: the template RBF-fitted with its cervical ring pinned just outside
 *   the rim, the occlusal third anchored, as a crown is pinned to its margin.
 * The pontic is solid: thickness is measured, never enforced.
 */

/** The base rim is the posed cervical footprint narrowed to this fraction. */
export const PONTIC_RIM_SCALE = 0.7;
/** Band between the base rim and the shell's cervical ring (the pontic's "margin thickness"). */
const PONTIC_BAND_MM = 0.1;
/** The ridge patch under the base reaches this far beyond the rim (mm, ⊥ axis). */
const RIDGE_PATCH_MARGIN_MM = 1.5;
/** Jaw faces this close to the rim (mm, ⊥ axis) are the ridge under the pontic, not neighbours (proximal map and contacts). */
const RIDGE_IGNORE_MARGIN_MM = 0.5;
const MIN_PONTIC_HEIGHT_MM = 4;
/**
 * An antagonist farther than this multiple of the template height is not above the pontic (overjet, or the ray
 * passed between the antagonist teeth): the template height is used instead.
 */
const MAX_PONTIC_HEIGHT_SCALE = 1.3;

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const pointAt = (a: Float32Array, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];
/** Component of a perpendicular to unit n. */
const reject = (a: V3, n: V3): V3 => sub(a, scale(n, dot(a, n)));

/**
 * Initial pontic pose: the template's cervix on the ridge (frame origin)
 * raised by the gap; mesio-distal width = the span the arch gives it; bucco-
 * lingual = the template width scaled by the neighbouring retainers' mean
 * ratio; height = from there up to the antagonist minus the occlusal
 * clearance (the template height without an antagonist).
 */
export function proposePonticPose(input: {
  template: CrownTemplate;
  frame: CrownFrame;
  ridgeGapMm: number;
  /** Mesio-distal span along the arch (mm); default the template's nominal width. */
  spanMm?: number;
  /** Bucco-lingual ratio of the neighbouring retainers (their |scale.y|); default 1. */
  blRatio?: number;
  antagonist?: RayCaster;
  params: Pick<DesignParams, 'occlusalClearanceMm'>;
}): { pose: Pose; warnings: string[] } {
  const { template, frame } = input;
  const warnings: string[] = [];
  const axes = crownAxes(frame);
  const position = add(frame.origin, scale(axes.z, input.ridgeGapMm));
  const md = input.spanMm ?? template.size.md;
  const bl = template.size.bl * (input.blRatio ?? 1);
  let height = template.size.height;
  const up = input.antagonist?.first(position, axes.z, 30);
  const toAntagonist = up ? up.distance - input.params.occlusalClearanceMm : Infinity;
  if (toAntagonist <= MAX_PONTIC_HEIGHT_SCALE * template.size.height) height = toAntagonist;
  else warnings.push(up ? 'The antagonist is not above the pontic (overjet?); using the template height.' : 'No antagonist above the pontic; using the template height.');
  height = Math.max(height, MIN_PONTIC_HEIGHT_MM);
  const q = poseRotation(axes);
  return {
    pose: {
      position,
      quaternion: [q.x, q.y, q.z, q.w],
      scale: [(axes.epsilon * md) / template.size.md, bl / template.size.bl, height / template.size.height],
    },
    warnings,
  };
}

export interface PonticInput {
  fdi: number;
  /** The jaw scan with the edentulous ridge. */
  jaw: { positions: Float32Array; indices: Uint32Array; ray: RayCaster };
  antagonist?: RayCaster;
  /** Pontic frame (see bridge.ts layoutPontics): origin on the ridge, FDI handedness, contacts on free sides. */
  frame: CrownFrame;
  /** Base axis: the bridge's insertion axis, so the base never catches the ridge on insertion. Default: frame occlusal. */
  axis?: V3;
  params: DesignParams;
  /** Stored pose; omitted = propose one (proposePonticPose with spanMm and blRatio). */
  pose?: Pose;
  spanMm?: number;
  blRatio?: number;
  template?: CrownTemplate;
  maps?: CrownMapName[];
  /** Occlusion and free sides only: a side facing a connected unit has a connector, not a contact. */
  adapt?: CrownAdapt;
  neighbours?: { ray: RayCaster; faceMask?: Uint8Array };
}

/** Gap from the base to the ridge along −axis, at every base vertex. */
export interface PonticBaseGap {
  samples: number;
  minGapMm: number;
  meanGapMm: number;
  /** ponticRidgeGapMm. */
  targetMm: number;
}

export interface PonticDesign extends CrownDesign {
  base: PonticBaseGap;
}

/** Gap from the first `count` vertices of `positions` down to the ridge along −axis. */
export function measureBaseGap(positions: Float32Array, count: number, axis: V3, ridge: RayCaster, targetMm: number): PonticBaseGap {
  const down = scale(axis, -1);
  let samples = 0, sum = 0, min = Infinity;
  for (let v = 0; v < count; v++) {
    const p = pointAt(positions, v);
    const hit = ridge.first(add(p, scale(axis, 3)), down, 10);
    if (!hit) continue;
    const gap = dot(sub(p, hit.point), axis);
    samples++;
    sum += gap;
    min = Math.min(min, gap);
  }
  return { samples, minGapMm: samples ? min : Number.NaN, meanGapMm: samples ? sum / samples : Number.NaN, targetMm };
}

/** Pontic over the ridge; see the module comment. Throws if the ridge under the pontic is not in the scan. */
export function designPontic(input: PonticInput): PonticDesign {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = now - t;
    t = now;
  };
  const { jaw, frame, params } = input;
  const warnings: string[] = [];
  const template = input.template ?? templateForTooth(input.fdi);
  const axes = crownAxes(frame);
  const axis = normalize(input.axis ?? frame.occlusal);
  const gap = params.ponticRidgeGapMm;

  let pose = input.pose;
  if (!pose) {
    const proposal = proposePonticPose({
      template,
      frame,
      ridgeGapMm: gap,
      spanMm: input.spanMm,
      blRatio: input.blRatio,
      antagonist: input.antagonist,
      params,
    });
    pose = proposal.pose;
    warnings.push(...proposal.warnings);
  }
  lap('pose');

  const placed = placeShell(template, pose, axis, axes.x);
  const T = placed.ring.length;
  let centre: V3 = [0, 0, 0];
  for (const p of placed.ringPoints) centre = add(centre, scale(p, 1 / T));
  // Rim footprint: the cervical ring narrowed toward its centre in the plane ⊥ axis.
  const narrowed = placed.ringPoints.map((p) => sub(p, scale(reject(sub(p, centre), axis), 1 - PONTIC_RIM_SCALE)));
  let rimRadius = 0;
  for (const q of narrowed) rimRadius = Math.max(rimRadius, Math.hypot(...reject(sub(q, centre), axis)));

  // The ridge under the pontic, raised by the gap: jaw faces near the rim, translated along the axis.
  const P = jaw.positions;
  const nv = P.length / 3;
  const near = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const dx = P[v * 3]! - centre[0], dy = P[v * 3 + 1]! - centre[1], dz = P[v * 3 + 2]! - centre[2];
    const along = dx * axis[0] + dy * axis[1] + dz * axis[2];
    near[v] = dx * dx + dy * dy + dz * dz - along * along;
  }
  const patchR2 = (rimRadius + RIDGE_PATCH_MARGIN_MM) ** 2;
  const ignoreR2 = (rimRadius + RIDGE_IGNORE_MARGIN_MM) ** 2;
  const remap = new Int32Array(nv).fill(-1);
  const source: number[] = [];
  const tris: number[] = [];
  const nf = jaw.indices.length / 3;
  const under = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) {
    const a = jaw.indices[f * 3]!, b = jaw.indices[f * 3 + 1]!, c = jaw.indices[f * 3 + 2]!;
    const far = Math.max(near[a]!, near[b]!, near[c]!);
    if (far > patchR2) continue;
    if (far <= ignoreR2) under[f] = 1;
    for (const v of [a, b, c]) {
      if (remap[v] === -1) {
        remap[v] = source.length;
        source.push(v);
      }
      tris.push(remap[v]!);
    }
  }
  if (tris.length === 0) throw new Error(`Pontic ${input.fdi}: the ridge under it is not in the scan`);
  const ridgePositions = new Float32Array(source.length * 3);
  source.forEach((v, i) => ridgePositions.set(add(pointAt(P, v), scale(axis, gap)), i * 3));
  const ridge = bvhRayCaster(createBvh({ positions: ridgePositions, indices: Uint32Array.from(tris) }));
  lap('ridge');

  // Rim on the raised ridge, then the base inside it.
  const down = scale(axis, -1);
  const rim = new Float32Array(T * 3);
  let misses = 0;
  narrowed.forEach((q, i) => {
    const hit = ridge.first(add(q, scale(axis, 20)), down, 60);
    if (hit) rim.set(hit.point, i * 3);
    else {
      misses++;
      rim.set(q, i * 3);
    }
  });
  if (misses > 0) throw new Error(`Pontic ${input.fdi}: ${misses} rim points are not over the scanned ridge`);
  const base = buildIntaglio({ offset: ridge, rim, axis });
  warnings.push(...base.warnings);
  lap('base');

  const finished = fitAndFinishShell({
    placed,
    pose,
    axes,
    axis,
    inner: base,
    rim,
    bandMm: PONTIC_BAND_MM,
    params,
    thickness: 'measure',
    jawRay: jaw.ray,
    ignoredFaces: () => under,
    antagonist: input.antagonist,
    adapt: input.adapt,
    maps: input.maps,
    neighbours: input.neighbours,
    gapCheck: () => ({ samples: 0, meanErrorMm: 0, maxErrorMm: 0 }),
    warnings,
    timings,
    lap,
  });
  const design = finished.design;
  const baseGap = measureBaseGap(design.mesh.positions, design.intaglioVertices, axis, jaw.ray, gap);
  if (baseGap.samples === 0) warnings.push('The pontic base is not over the scanned ridge.');
  else if (baseGap.minGapMm < gap - 0.02) {
    warnings.push(`The pontic base is ${(gap - baseGap.minGapMm).toFixed(2)} mm closer to the ridge than the target gap of ${gap} mm.`);
  }
  lap('baseGap');
  return { ...design, base: baseGap };
}
