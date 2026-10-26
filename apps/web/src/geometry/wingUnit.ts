import type { DesignParams, QaCheck } from '@dcad/shared';
import type { CrownAdaptReport, CrownDesign } from './crown';
import type { CrownMapName } from './crownMaps';
import type { GapCheck } from './intaglio';
import { snapToVertex, traceClosedLoop, type EdgeWeight } from './livewire';
import type { V3 } from './pca';
import type { PatchBlockout, PatchJaw } from './patchRetainer';
import { prepRegion, type PrepRegion } from './prepRegion';
import { bvhRayCaster, createBvh, type RayCaster } from './raycast';
import type { SurfaceGraph } from './surface';
import { designWing, WING_DEFAULTS, WING_EDGE_RAMP_MM, type WingParams, type WingSpaceReport, type WingThicknessStats } from './wing';

/**
 * Maryland wings as bridge units: the wing (wing.ts) in the shape of a crown
 * result, so designBridge, the connectors, the union checks, the worker and
 * the editor treat it like any retainer. A wing has no template pose: its
 * geometry follows from the outline, the axis and the parameters.
 */

/** Template id of a wing unit (a crown record with this id stores the proposal; its pose is not used). */
export const WING_TEMPLATE_ID = 'maryland-wing';
/** Fitting vertices whose surface is farther than gap + this from the tooth are blocked out (not seated). */
const SEATED_TOLERANCE_MM = 0.01;
/** Distance searched for the fitting surface along each tooth normal. */
const SEATING_SEARCH_MM = 1;

/** The wing parameters of a unit: its DesignParams with the wing defaults. */
export function wingParamsOf(params: Pick<DesignParams, 'cementGapMm' | 'occlusalClearanceMm' | 'wingThicknessMm' | 'wingEdgeThicknessMm'>): WingParams {
  const wingThicknessMm = params.wingThicknessMm ?? WING_DEFAULTS.wingThicknessMm;
  return {
    wingThicknessMm,
    wingEdgeThicknessMm: Math.min(params.wingEdgeThicknessMm ?? WING_DEFAULTS.wingEdgeThicknessMm, wingThicknessMm),
    wingMinThicknessMm: Math.min(WING_DEFAULTS.wingMinThicknessMm, wingThicknessMm),
    cementGapMm: params.cementGapMm,
    occlusalClearanceMm: params.occlusalClearanceMm,
  };
}

/**
 * The region inside a wing outline: the dense outline snapped to vertices and
 * closed by the live-wire, flood-filled from the seed (the frame click on the
 * lingual surface). The crown's prepSeedVertex (straight down through the
 * outline's centre) can land outside a crescent-shaped outline.
 */
export function wingRegion(input: {
  positions: Float32Array;
  indices: Uint32Array;
  graph: SurfaceGraph;
  weight: EdgeWeight;
  ray: RayCaster;
  /** Dense outline, xyz packed (MarginLine.points). */
  outline: Float32Array;
  seed: V3;
}): PrepRegion & { loopVertices: Uint32Array } {
  const { positions, indices, graph, ray, outline } = input;
  const snapped: number[] = [];
  for (let i = 0; i < outline.length; i += 3) {
    const v = snapToVertex(positions, indices, ray, [outline[i]!, outline[i + 1]!, outline[i + 2]!]);
    if (v !== null && snapped.at(-1) !== v) snapped.push(v);
  }
  if (snapped.length > 1 && snapped[0] === snapped.at(-1)) snapped.pop();
  const loopVertices = Uint32Array.from(traceClosedLoop(positions, graph, input.weight, snapped));
  const seedVertex = snapToVertex(positions, indices, ray, input.seed);
  if (seedVertex === null) throw new Error('The wing seed is not on the scan');
  return { ...prepRegion({ positions, indices, graph, loopVertices, seedVertex }), loopVertices };
}

/**
 * Seating of a wing: from each tooth vertex inside the outline (not on it),
 * along its smoothed normal to `surface` (the wing, or the merged bridge),
 * against the uniform cement gap. Vertices that are blocked out (no surface
 * within gap + 0.01 mm) are not samples, so the same rule on the union only
 * changes when material moved into the cement space or the blockout.
 */
export function wingGapCheck(input: {
  jaw: Pick<PatchJaw, 'positions' | 'smoothNormals'>;
  region: { vertexMask: Uint8Array; loopVertices: ArrayLike<number> };
  gapMm: number;
  surface: RayCaster;
}): GapCheck {
  const { jaw, region, gapMm, surface } = input;
  const onLoop = new Set(Array.from(region.loopVertices));
  let samples = 0, sum = 0, max = 0;
  for (let v = 0; v < region.vertexMask.length; v++) {
    if (!region.vertexMask[v] || onLoop.has(v)) continue;
    const p: V3 = [jaw.positions[v * 3]!, jaw.positions[v * 3 + 1]!, jaw.positions[v * 3 + 2]!];
    const n: V3 = [jaw.smoothNormals[v * 3]!, jaw.smoothNormals[v * 3 + 1]!, jaw.smoothNormals[v * 3 + 2]!];
    const hit = surface.first(p, n, gapMm + SEATING_SEARCH_MM);
    if (!hit || hit.distance > gapMm + SEATED_TOLERANCE_MM) continue;
    const err = Math.abs(hit.distance - gapMm);
    samples++;
    sum += err;
    max = Math.max(max, err);
  }
  return { samples, meanErrorMm: samples ? sum / samples : 0, maxErrorMm: max };
}

/** What a wing unit reports besides the crown-shaped fields (plain numbers: it crosses the worker boundary). */
export interface WingUnitReport {
  params: WingParams;
  area: { patchMm2: number; bondedMm2: number; blockedOutMm2: number; blockedOutFraction: number };
  blockout: PatchBlockout;
  thickness: WingThicknessStats;
  space?: WingSpaceReport;
  /** The fitting surface against the tooth (closest-point distance vs the cement gap, seated vertices). */
  fit: { samples: number; meanMm: number; maxErrorMm: number };
  /** Vertices of the traced outline dropped because the trace touched itself. */
  outlineDroppedVertices: number;
}

export type WingUnitDesign = CrownDesign & { wing: WingUnitReport };

/**
 * A wing unit for designBridge: designWing on the outline region, returned
 * as a crown-shaped result (fitting surface first, so intaglioVertices and
 * shellStart are the outer surface's start; no move weights; the space check
 * as the occlusion "adaptation", with "insufficient space for the wing" as
 * its conflict) plus the wing report.
 */
export function designWingUnit(input: {
  jaw: PatchJaw;
  antagonist?: RayCaster;
  region: { vertexMask: Uint8Array; faceMask: Uint8Array; loopVertices: ArrayLike<number> };
  axis: V3;
  params: DesignParams;
  maps?: CrownMapName[];
}): WingUnitDesign {
  const params = wingParamsOf(input.params);
  const wantMaps = Boolean(input.maps?.some((m) => m === 'thickness' || m === 'occlusion'));
  const w = designWing({ jaw: input.jaw, region: input.region, axis: input.axis, antagonist: input.antagonist, params, maps: wantMaps });
  const n = w.outerStart;
  const P = w.mesh.positions;
  const centre: V3 = [0, 0, 0];
  for (let i = n; i < 2 * n; i++) {
    centre[0] += P[i * 3]! / n;
    centre[1] += P[i * 3 + 1]! / n;
    centre[2] += P[i * 3 + 2]! / n;
  }
  const solid = solidRay(w.mesh.positions, w.mesh.indices);
  const gapCheck = wingGapCheck({ jaw: input.jaw, region: input.region, gapMm: params.cementGapMm, surface: solid });

  let occlusion: CrownAdaptReport | undefined;
  if (w.space) {
    const s = w.space;
    occlusion = {
      movedVertices: s.thinning?.adapt.movedVertices ?? 0,
      maxMoveMm: s.thinning?.maxMm ?? 0,
      minClearanceBeforeMm: s.minClearanceBeforeMm,
      minClearanceMm: s.minClearanceMm,
      targetMm: s.targetMm,
      ...(s.conflict ? { conflict: { kind: s.conflict.kind, vertices: s.conflict.vertices, minClearanceMm: s.conflict.minClearanceMm, at: s.conflict.at } } : {}),
    };
  }

  let maps: CrownDesign['maps'];
  if (wantMaps && w.maps) {
    maps = {};
    if (input.maps!.includes('thickness')) maps.thickness = w.maps.thickness;
    if (input.maps!.includes('occlusion') && w.maps.occlusion) maps.occlusion = w.maps.occlusion;
  }

  const thicknessMin = Number.isFinite(w.thickness.minMm) ? w.thickness.minMm : Number.NaN;
  return {
    mesh: w.mesh,
    pose: { position: centre, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    templateId: WING_TEMPLATE_ID,
    validation: w.validation,
    ...(occlusion ? { adapt: { occlusion } } : {}),
    minAxialThicknessMm: thicknessMin,
    gapCheck,
    intaglioVertices: n,
    shellStart: n,
    moveWeights: new Float32Array(2 * n),
    thickness: {
      minMm: thicknessMin,
      minSlackMm: thicknessMin - params.wingMinThicknessMm,
      pushedVertices: w.space?.thinning?.floorPushedVertices ?? 0,
      maxPushMm: w.space?.thinning?.maxMm ?? 0,
    },
    ...(maps ? { maps } : {}),
    warnings: w.warnings,
    timingsMs: w.timingsMs,
    wing: {
      params,
      area: w.area,
      blockout: w.patch.blockout,
      thickness: w.thickness,
      ...(w.space ? { space: w.space } : {}),
      fit: { samples: w.gapCheck.samples, meanMm: w.gapCheck.meanMm, maxErrorMm: w.gapCheck.maxErrorMm },
      outlineDroppedVertices: w.patch.outlineDroppedVertices,
    },
  };
}

const round = (x: number, d = 3) => Number(x.toFixed(d));
const check = (id: string, passed: boolean, message: string, value?: number, threshold?: number): QaCheck => ({
  id,
  passed,
  message,
  ...(value !== undefined && Number.isFinite(value) ? { value: round(value) } : {}),
  ...(threshold !== undefined ? { threshold } : {}),
});

/**
 * The wing gate (classical.wing checks): the outline seats along the axis and
 * nothing inside it is undercut (until a side-wall blockout exists, an
 * undercut folds the wing), the wing is at least its minimum thickness away
 * from the edge ramp (0.02 mm tolerance), and there is space for it against
 * the antagonist. Bonded and blocked-out area are reported, not gated.
 */
export function wingChecks(fdi: number, wing: Pick<WingUnitReport, 'params' | 'blockout' | 'thickness' | 'space'>): QaCheck[] {
  const id = `wing.${fdi}`;
  const minLimit = round(wing.params.wingMinThicknessMm - 0.02);
  const t = wing.thickness;
  return [
    check(`${id}.outlineUndercut`, wing.blockout.outlineUndercutPoints === 0, `Wing ${fdi}: no outline points in an undercut along the axis`, wing.blockout.outlineUndercutPoints, 0),
    check(`${id}.undercut`, wing.blockout.undercutFaces === 0, `Wing ${fdi}: no undercut surface inside the outline (mm²)`, wing.blockout.undercutAreaMm2, 0),
    check(
      `${id}.thickness`,
      t.samples > 0 && t.minMm >= minLimit,
      t.samples > 0 ? `Wing ${fdi}: thinnest ${WING_EDGE_RAMP_MM} mm or more from the edge (mm)` : `Wing ${fdi}: narrower than twice the edge ramp; it never reaches full thickness`,
      t.minMm,
      minLimit,
    ),
    check(`${id}.space`, !wing.space?.conflict, wing.space?.conflict ? `Wing ${fdi}: insufficient space for the wing (mm)` : `Wing ${fdi}: space against the antagonist`, wing.space?.conflict?.minClearanceMm ?? wing.space?.minClearanceMm),
  ];
}

/** A ray caster over a closed mesh (copies: the BVH reorders the index). */
const solidRay = (positions: Float32Array, indices: Uint32Array): RayCaster => bvhRayCaster(createBvh({ positions: positions.slice(), indices: indices.slice() }));
