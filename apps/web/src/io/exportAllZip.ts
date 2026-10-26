import { strToU8, zipSync, type Zippable } from 'fflate';

export const EXPORT_ALL_FORMAT = 'dcad.export-all@1';

/** A readiness check that has not passed, with its measured value or what is wrong. */
export interface OpenCheck {
  label: string;
  detail: string;
}

/** One restoration of the case, designed for the export. */
export interface RestorationExport {
  kind: 'crown' | 'bridge';
  /** How the lab reads it: "11 crown", "14 implant crown", "framework bridge 35–37". */
  name: string;
  /** Its teeth in arch order (one for a single crown). */
  teeth: number[];
  /** File name of the construction sidecar without extension, as the single export names it. */
  base: string;
  /**
   * Binary STL files in mm: the restoration (an implant crown with its screw channel, a reduced unit's framework, a
   * bridge as one merged solid), then any overpress parts. Empty when it could not be designed (see `skipped`).
   */
  stls: Array<{ file: string; bytes: Uint8Array }>;
  /** The construction sidecar (dcad.construction@1), with its implant and framework sections. */
  info?: unknown;
  /** The ready-to-mill checks it has not passed; empty = ready to mill. */
  open: OpenCheck[];
  /** Why it has no files: not proposed yet, an input missing, the union failed. */
  skipped?: string;
}

export interface ExportAllInput {
  /** Case reference used in file names (already safe for file names). */
  caseRef: string;
  caseId: string;
  patientRef: string;
  appVersion: string;
  restorations: RestorationExport[];
  /** ISO timestamp; defaults to now. */
  createdAt?: string;
}

const filesOf = (r: RestorationExport): string[] =>
  r.stls.length > 0 ? [...r.stls.map((s) => s.file), ...(r.info ? [`${r.base}.construction.json`] : [])] : [];

/**
 * Every restoration of a case in one zip, so one click gives one download (browsers block several downloads started
 * by one click): per restoration its STL files and construction sidecar, plus `manifest.json` (machine-readable) and
 * `README.txt` (for the lab), which list each restoration's open checks and why any was left out.
 */
export function exportAllZip(input: ExportAllInput): { bytes: Uint8Array; fileName: string } {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const files: Zippable = {};
  for (const r of input.restorations) {
    if (r.stls.length === 0) continue;
    // STL compresses well; level 1 keeps the zip fast to build in the browser.
    for (const s of r.stls) files[s.file] = [s.bytes, { level: 1 }];
    if (r.info) files[`${r.base}.construction.json`] = strToU8(JSON.stringify(r.info, null, 2));
  }
  const manifest = {
    format: EXPORT_ALL_FORMAT,
    createdAt,
    appVersion: input.appVersion,
    caseId: input.caseId,
    patientRef: input.patientRef,
    lengthUnit: 'mm' as const,
    restorations: input.restorations.map((r) => ({
      kind: r.kind,
      name: r.name,
      teeth: r.teeth,
      files: filesOf(r),
      ready: !r.skipped && r.open.length === 0,
      openChecks: r.open,
      ...(r.skipped ? { skipped: r.skipped } : {}),
    })),
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files['README.txt'] = strToU8(readme(input, createdAt));
  return { bytes: zipSync(files), fileName: `${input.caseRef}-restorations.zip` };
}

function readme(input: ExportAllInput, createdAt: string): string {
  const exported = input.restorations.filter((r) => r.stls.length > 0).length;
  const lines = [
    `DentalCAD export, case ${input.patientRef || input.caseRef}, ${createdAt}`,
    `${exported} of ${input.restorations.length} restorations exported as binary STL in millimetres, each with a`,
    'construction sidecar (.construction.json). manifest.json lists the same in machine-readable form.',
    '',
  ];
  for (const r of input.restorations) {
    if (r.skipped) lines.push(`${r.name}: not exported. ${r.skipped}`);
    else if (r.open.length === 0) lines.push(`${r.name}: ready to mill. ${filesOf(r).join(', ')}`);
    else lines.push(`${r.name}: exported with ${r.open.length} open ${r.open.length === 1 ? 'check' : 'checks'}. ${filesOf(r).join(', ')}`);
    for (const c of r.open) lines.push(`  - ${c.label}: ${c.detail}`);
  }
  return `${lines.join('\n')}\n`;
}
