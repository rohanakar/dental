import { DesignDocument, type ScanRef } from '@dcad/shared';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import { LOCAL_CASE_ID } from '../design/document';

export const PROJECT_FORMAT = 'dcad.project@1';

const Manifest = z.object({
  format: z.literal(PROJECT_FORMAT),
  appVersion: z.string(),
  createdAt: z.string(),
  scans: z.array(z.object({ role: z.string(), file: z.string(), sha256: z.string() })),
});
export type ProjectManifest = z.infer<typeof Manifest>;

export interface ProjectScan {
  ref: ScanRef;
  bytes: Uint8Array;
}

/** File extension from the scan's original name (".stl", ".ply"), else ".bin". */
function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? `.${m[1]!.toLowerCase()}` : '.bin';
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A self-contained local project: manifest.json, design.json (the
 * DesignDocument) and the original scan bytes under scans/<role>.<ext>.
 * Scans use deflate level 1: STL/PLY compress well and the zip stays fast to
 * build in the browser.
 */
export function exportProject(input: { doc: DesignDocument; scans: ProjectScan[]; appVersion: string; createdAt?: string }): Uint8Array {
  const files: Zippable = {};
  const manifest: ProjectManifest = {
    format: PROJECT_FORMAT,
    appVersion: input.appVersion,
    createdAt: input.createdAt ?? new Date().toISOString(),
    scans: [],
  };
  for (const { ref, bytes } of input.scans) {
    const file = `scans/${ref.role}${extensionOf(ref.name)}`;
    files[file] = [bytes, { level: 1 }];
    manifest.scans.push({ role: ref.role, file, sha256: ref.mesh.sha256 });
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files['design.json'] = strToU8(JSON.stringify(input.doc, null, 2));
  return zipSync(files);
}

/**
 * Read a project zip. Every scan in the document must be present and match
 * its recorded sha256. The document is returned as a local (offline) one:
 * backend file ids belong to another server, so they are dropped.
 */
export async function importProject(bytes: Uint8Array): Promise<{ doc: DesignDocument; scans: ProjectScan[]; manifest: ProjectManifest }> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('Not a project file (the zip could not be read)');
  }
  const manifestBytes = entries['manifest.json'];
  const designBytes = entries['design.json'];
  if (!manifestBytes || !designBytes) throw new Error('Not a project file (manifest.json or design.json is missing)');
  const manifest = Manifest.safeParse(JSON.parse(strFromU8(manifestBytes)));
  if (!manifest.success) throw new Error(`Unsupported project format (expected ${PROJECT_FORMAT})`);
  const parsed = DesignDocument.safeParse(JSON.parse(strFromU8(designBytes)));
  if (!parsed.success) throw new Error(`The project's design is invalid: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);

  const doc: DesignDocument = {
    ...parsed.data,
    caseId: LOCAL_CASE_ID,
    scans: parsed.data.scans.map((s) => {
      const { fileId: _fileId, ...mesh } = s.mesh;
      return { ...s, mesh };
    }),
  };
  const scans: ProjectScan[] = [];
  for (const ref of doc.scans) {
    const entry = manifest.data.scans.find((s) => s.role === ref.role);
    const data = entry ? entries[entry.file] : undefined;
    if (!entry || !data) throw new Error(`The ${ref.role} scan (${ref.name}) is missing from the project file`);
    const actual = await sha256Hex(data);
    if (actual !== ref.mesh.sha256) throw new Error(`The ${ref.role} scan (${ref.name}) does not match its checksum; the file is damaged`);
    scans.push({ ref, bytes: data });
  }
  return { doc, scans, manifest: manifest.data };
}
