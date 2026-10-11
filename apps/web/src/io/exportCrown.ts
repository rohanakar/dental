import type { DesignDocument, Pose, ToothDesign } from '@dcad/shared';
import type { IndexedMesh } from '../geometry/mesh';
import type { MeshValidation } from '../geometry/meshValidate';
import { writeBinaryStl } from '../geometry/stl';

export const CONSTRUCTION_FORMAT = 'dcad.construction@1';

/** Binary STL of the finished crown (mm). */
export function crownStl(mesh: IndexedMesh): Uint8Array {
  return writeBinaryStl(mesh, 'dcad crown');
}

export interface ConstructionInfoInput {
  doc: DesignDocument;
  tooth: ToothDesign;
  appVersion: string;
  result: {
    templateId: string;
    pose: Pose;
    validation: MeshValidation;
    minAxialThicknessMm?: number;
    gapCheck?: unknown;
  };
  /** ISO timestamp; defaults to now. */
  createdAt?: string;
}

/**
 * JSON sidecar for an exported crown (like exocad's .constructionInfo): the
 * inputs that produced the STL and its validation, so a lab or a later
 * model-training job can trace every export.
 */
export function constructionInfo(input: ConstructionInfoInput) {
  const { doc, tooth, result } = input;
  const order = doc.setup.teeth.find((t) => t.fdi === tooth.fdi);
  return {
    format: CONSTRUCTION_FORMAT,
    createdAt: input.createdAt ?? new Date().toISOString(),
    appVersion: input.appVersion,
    caseId: doc.caseId,
    patientRef: doc.setup.patientRef,
    fdi: tooth.fdi,
    material: order?.material ?? null,
    params: tooth.params,
    frame: tooth.frame ?? null,
    margin: tooth.margin ? { anchors: tooth.margin.anchors, points: tooth.margin.points } : null,
    axis: tooth.axis ?? null,
    crown: { kind: 'template' as const, templateId: result.templateId, pose: result.pose },
    validation: result.validation,
    metrics: {
      minAxialThicknessMm: result.minAxialThicknessMm,
      gapCheck: result.gapCheck,
    },
    units: 'mm' as const,
  };
}

export type ConstructionInfo = ReturnType<typeof constructionInfo>;

/** Save bytes or text as a file in the browser (no-op outside a DOM). */
export function downloadBytes(data: Uint8Array | string, fileName: string, mime = 'application/octet-stream'): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
