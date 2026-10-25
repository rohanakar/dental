import {
  type CaseSetup,
  deriveBridges,
  type DesignDocument,
  initialSteps,
  jawOf,
  MATERIAL_PRESETS,
  SCHEMA_VERSION,
  type ScanRef,
  type ToothDesign,
  type ToothOrder,
} from '@dcad/shared';

/** Default setup: one zirconia crown on 36, which matches the synthetic demo prep. */
export const DEFAULT_SETUP: CaseSetup = {
  patientRef: '',
  teeth: [{ fdi: 36, restoration: 'anatomic-crown', material: 'zirconia' }],
  notes: '',
  connections: [],
};

/** caseId for documents that only live in the browser (offline mode). */
export const LOCAL_CASE_ID = 'local';

export function newTooth(order: ToothOrder, scans: readonly ScanRef[]): ToothDesign {
  const steps = initialSteps();
  steps.setup = 'done';
  if (scans.some((s) => s.role === jawOf(order.fdi))) steps.scans = 'done';
  return { fdi: order.fdi, params: { ...MATERIAL_PRESETS[order.material] }, steps };
}

export function newDocument(caseId: string = LOCAL_CASE_ID, setup: CaseSetup = DEFAULT_SETUP): DesignDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    caseId,
    setup,
    scans: [],
    teeth: setup.teeth.map((t) => newTooth(t, [])),
    bridges: deriveBridges(setup),
  };
}

export const findTooth = (doc: DesignDocument, fdi: number): ToothDesign | undefined =>
  doc.teeth.find((t) => t.fdi === fdi);

export const scanForRole = (doc: DesignDocument, role: ScanRef['role']): ScanRef | undefined =>
  doc.scans.find((s) => s.role === role);
