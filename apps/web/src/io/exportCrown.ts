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

/** Binary STL of a merged bridge (mm): one solid of retainers, pontics and connectors. */
export function bridgeStl(mesh: IndexedMesh): Uint8Array {
  return writeBinaryStl(mesh, 'dcad bridge');
}

export interface BridgeConstructionInput {
  doc: DesignDocument;
  /** The bridge's units, in arch order (BridgeDesign.teeth). */
  teeth: readonly number[];
  appVersion: string;
  /** The merged design (designBridge with union: true). */
  result: {
    units: ReadonlyArray<{
      fdi: number;
      kind: string;
      templateId: string;
      pose: Pose;
      /** The frame the unit was designed in (a pontic's laid-out frame when none is stored). */
      frame: unknown;
      validation: MeshValidation;
      minAxialThicknessMm?: number;
      gapCheck?: unknown;
      base?: unknown;
    }>;
    connectors: ReadonlyArray<{
      between: [number, number];
      settings: unknown;
      minAreaMm2: number;
      minHeightMm: number;
      areaMm2: number;
      heightMm: number;
      widthMm: number;
      available: { heightMm: number };
      failures: ReadonlyArray<{ code: string; message: string }>;
    }>;
    union?: {
      checks: {
        union: unknown;
        connectors: ReadonlyArray<{ between: [number, number]; measured: { minAreaMm2: number; heightMm: number; widthMm: number }; ok: boolean }>;
        seating: unknown;
        ponticBase: unknown;
        failures: readonly string[];
        ok: boolean;
      };
    };
    warnings: readonly string[];
  };
  createdAt?: string;
}

/**
 * JSON sidecar for an exported bridge: per unit its kind, frame, margin and
 * pose; the common insertion axis; each connector as designed and as
 * measured on the merged solid; the warnings and the checks of the union.
 */
export function bridgeConstructionInfo(input: BridgeConstructionInput) {
  const { doc, teeth, result } = input;
  const tooth = (fdi: number) => doc.teeth.find((t) => t.fdi === fdi);
  const material = doc.setup.teeth.find((t) => t.fdi === teeth[0])?.material ?? null;
  const axis = teeth.map((fdi) => tooth(fdi)?.axis).find(Boolean) ?? null;
  const checks = result.union?.checks;
  return {
    format: CONSTRUCTION_FORMAT,
    kind: 'bridge' as const,
    createdAt: input.createdAt ?? new Date().toISOString(),
    appVersion: input.appVersion,
    caseId: doc.caseId,
    patientRef: doc.setup.patientRef,
    teeth: [...teeth],
    material,
    axis,
    units: result.units.map((u) => {
      const t = tooth(u.fdi);
      return {
        fdi: u.fdi,
        kind: u.kind,
        params: t?.params ?? null,
        frame: t?.frame ?? u.frame,
        margin: t?.margin ? { anchors: t.margin.anchors, points: t.margin.points } : null,
        crown: { kind: 'template' as const, templateId: u.templateId, pose: u.pose },
        validation: u.validation,
        metrics: { minAxialThicknessMm: u.minAxialThicknessMm, gapCheck: u.gapCheck, ...(u.base ? { ponticBase: u.base } : {}) },
      };
    }),
    connectors: result.connectors.map((c) => {
      const measured = checks?.connectors.find((m) => m.between[0] === c.between[0] && m.between[1] === c.between[1]);
      return {
        between: c.between,
        settings: c.settings,
        minAreaMm2: c.minAreaMm2,
        minHeightMm: c.minHeightMm,
        designed: { areaMm2: c.areaMm2, heightMm: c.heightMm, widthMm: c.widthMm, availableHeightMm: c.available.heightMm },
        measured: measured ? { minAreaMm2: measured.measured.minAreaMm2, heightMm: measured.measured.heightMm, widthMm: measured.measured.widthMm, ok: measured.ok } : null,
        failures: c.failures.map((f) => f.message),
      };
    }),
    warnings: [...result.warnings],
    validation: checks
      ? { ok: checks.ok, union: checks.union, seating: checks.seating, ponticBase: checks.ponticBase, failures: [...checks.failures] }
      : null,
    /** Length unit of every value (`units` lists the bridge's units). */
    lengthUnit: 'mm' as const,
  };
}

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
