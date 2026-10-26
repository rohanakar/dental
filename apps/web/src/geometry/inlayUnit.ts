import type { DesignParams, Pose } from '@dcad/shared';
import type { AnatomyResidual } from './anatomyFit';
import type { CrownDesign, CrownFrame } from './crown';
import { clearanceMap, thicknessMap, type CrownMapName } from './crownMaps';
import type { CrownTemplate } from './crownTemplate';
import { designInlay, INLAY_DEFAULTS, measureCavitySeating, type InlayFailure, type InlayType, type OuterSource, type PreopScan } from './inlay';
import { computeVertexNormals } from './normals';
import type { FittingPatch, PatchBlockout, PatchJaw } from './patchRetainer';
import { fittingSurfaceOf } from './patchRetainer';
import type { V3 } from './pca';
import type { RayCaster } from './raycast';

/**
 * Inlays and onlays as units (a single restoration, or a bridge retainer):
 * the retainer of inlay.ts in the shape of a crown result, so designBridge,
 * the connectors, the union checks, the worker and the editor treat it like
 * any other unit. The pre-op source has no pose (its crown record is a
 * placeholder, INLAY_PREOP_TEMPLATE_ID); the library source stores the
 * fitted pose, which move, rotate and scale then adjust (the collar is
 * pinned onto the scan again).
 */

/** Template id of a pre-op inlay's crown record (its pose is only the restoration's centre). */
export const INLAY_PREOP_TEMPLATE_ID = 'inlay-preop';

/** What an inlay unit reports besides the crown-shaped fields (plain data: it crosses the worker boundary). */
export interface InlayUnitReport {
  type: InlayType;
  source: OuterSource;
  marginFit: { samples: number; meanMm: number; maxMm: number; crossingMaxMm: number; limitMm: number; ok: boolean };
  isthmus: { samples: number; minMm: number; meanMm: number; at: V3; thresholdMm: number; ok: boolean };
  /** The fitting surface against the tooth (the cement gap each vertex was given). */
  fit: { samples: number; meanErrorMm: number; maxErrorMm: number };
  blockout: PatchBlockout;
  /** Library source: the fitted pose, its template and the residual on the collar (fails above limitMm). */
  library?: { templateId: string; pose: Pose; residual: AnatomyResidual; limitMm: number; ok: boolean };
  coronalHeightMm: number;
  droppedPieces: number;
  /** The mesh's first this many faces are the fitting surface (fittingSurfaceOf). */
  fittingFaces: number;
  failures: InlayFailure[];
}

/** A crown-shaped inlay unit; `inlayPatch` (large arrays) stays in the worker, for the seating on a bridge union. */
export type InlayUnitDesign = CrownDesign & { inlay: InlayUnitReport; inlayPatch: FittingPatch };

export interface InlayUnitInput {
  fdi: number;
  type: InlayType;
  jaw: PatchJaw;
  antagonist?: RayCaster;
  region: { vertexMask: Uint8Array; faceMask: Uint8Array; loopVertices: ArrayLike<number> };
  /** Dense cavity margin, xyz packed. */
  margin: Float32Array;
  axis: V3;
  params: DesignParams;
  frame: CrownFrame;
  source: OuterSource;
  /** Pre-op source: the pre-op scan. */
  preop?: PreopScan;
  /** Library source: the stored (fitted or moved) pose; omitted = fitted to the collar. */
  pose?: Pose;
  template?: CrownTemplate;
  role?: 'single' | 'retainer';
  maps?: CrownMapName[];
}

/**
 * Design an inlay or onlay unit (await initMeshBoolean() first). Throws when
 * the pre-op source has no pre-op scan, or the anatomy does not rise above the
 * cavity.
 */
export function designInlayUnit(input: InlayUnitInput): InlayUnitDesign {
  if (input.source === 'preop' && !input.preop) throw new Error(`Inlay ${input.fdi}: the case has no pre-op scan; load one or use the library tooth`);
  const d = designInlay({
    fdi: input.fdi,
    type: input.type,
    role: input.role ?? 'single',
    jaw: input.jaw,
    region: input.region,
    margin: input.margin,
    axis: input.axis,
    params: { ...input.params, retainerMinThicknessMm: input.params.retainerMinThicknessMm ?? INLAY_DEFAULTS.retainerMinThicknessMm },
    outer:
      input.source === 'preop'
        ? { source: 'preop', preop: input.preop! }
        : { source: 'library', frame: input.frame, ...(input.template ? { template: input.template } : {}), ...(input.pose ? { pose: input.pose } : {}) },
  });
  const nf = d.fittingVertices;
  const total = d.mesh.positions.length / 3;
  const lib = d.outer.library;
  const pose: Pose = lib ? lib.pose : { position: d.centre, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] };

  let maps: CrownDesign['maps'];
  if (input.maps?.length) {
    maps = {};
    if (input.maps.includes('thickness')) maps.thickness = thicknessMap(d.mesh.positions, nf, total, fittingSurfaceOf(d.mesh, nf, d.fittingFaces));
    if (input.maps.includes('occlusion') && input.antagonist) {
      maps.occlusion = clearanceMap({ positions: d.mesh.positions, normals: computeVertexNormals(d.mesh), vertexStart: nf, vertexEnd: total, target: input.antagonist });
    }
  }
  const thickness = d.isthmus.minMm;
  return {
    mesh: d.mesh,
    pose,
    templateId: lib ? lib.templateId : INLAY_PREOP_TEMPLATE_ID,
    validation: d.validation,
    minAxialThicknessMm: thickness,
    // Seating: from the tooth along the gap directions to the restoration (the same measure runs on a bridge union).
    gapCheck: d.seating,
    intaglioVertices: nf,
    shellStart: nf,
    moveWeights: new Float32Array(total),
    thickness: { minMm: thickness, minSlackMm: thickness - d.isthmus.thresholdMm, pushedVertices: 0, maxPushMm: 0 },
    ...(maps ? { maps } : {}),
    warnings: [...d.failures.map((f) => f.message), ...d.warnings],
    timingsMs: d.timingsMs,
    inlay: {
      type: d.type,
      source: d.outer.source,
      marginFit: { samples: d.marginFit.samples, meanMm: d.marginFit.meanMm, maxMm: d.marginFit.maxMm, crossingMaxMm: d.marginFit.crossingMaxMm, limitMm: INLAY_DEFAULTS.marginFitMm, ok: d.marginFit.ok },
      isthmus: d.isthmus,
      fit: { samples: d.gapCheck.samples, meanErrorMm: d.gapCheck.meanErrorMm, maxErrorMm: d.gapCheck.maxErrorMm },
      blockout: d.patch.blockout,
      ...(lib ? { library: { templateId: lib.templateId, pose: lib.pose, residual: lib.residual, limitMm: INLAY_DEFAULTS.libraryResidualMaxMm, ok: lib.ok } } : {}),
      coronalHeightMm: d.coronalHeightMm,
      droppedPieces: d.pieces.dropped.length,
      fittingFaces: d.fittingFaces,
      failures: d.failures,
    },
    inlayPatch: d.patch,
  };
}

/** Seating of an inlay unit against a surface that contains its fitting surface (the unit itself, or a bridge union). */
export const inlaySeating = (design: Pick<InlayUnitDesign, 'inlayPatch'>, surface: RayCaster) => measureCavitySeating(design.inlayPatch, surface);
