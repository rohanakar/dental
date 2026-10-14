import type { ScanRef } from '@dcad/shared';
import { strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { LOCAL_CASE_ID, newDocument } from '../design/document';
import { exportProject, importProject } from './projectZip';

async function sha(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function fixture() {
  const lower = strToU8('solid lower\nendsolid lower\n'.repeat(50));
  const upper = new Uint8Array(1000).map((_, i) => i % 251);
  const scans: Array<{ ref: ScanRef; bytes: Uint8Array }> = [
    { ref: { role: 'lower', name: 'Lower Jaw.STL', mesh: { sha256: await sha(lower), fileId: 'srv-1', units: 'mm', frame: 'scan', triangleCount: 0 } }, bytes: lower },
    { ref: { role: 'upper', name: 'upper', mesh: { sha256: await sha(upper), fileId: 'srv-2', units: 'mm', frame: 'scan' } }, bytes: upper },
  ];
  const doc = { ...newDocument('case-on-server'), scans: scans.map((s) => s.ref) };
  return { doc, scans };
}

describe('project zip', () => {
  it('round-trips the document and the scan bytes as a local project', async () => {
    const { doc, scans } = await fixture();
    const zip = exportProject({ doc, scans, appVersion: '0.5.0', createdAt: '2026-10-11T00:00:00.000Z' });
    const entries = Object.keys(unzipSync(zip)).sort();
    expect(entries).toEqual(['design.json', 'manifest.json', 'scans/lower.stl', 'scans/upper.bin']);
    const back = await importProject(zip);
    expect(back.doc).toEqual({
      ...doc,
      caseId: LOCAL_CASE_ID,
      scans: doc.scans.map((s) => {
        const { fileId: _f, ...mesh } = s.mesh;
        return { ...s, mesh };
      }),
    });
    expect(back.doc.scans.every((s) => s.mesh.fileId === undefined)).toBe(true);
    expect(back.scans.map((s) => s.ref.role)).toEqual(['lower', 'upper']);
    expect(back.scans[0]!.bytes).toEqual(scans[0]!.bytes);
    expect(back.scans[1]!.bytes).toEqual(scans[1]!.bytes);
  });

  it('rejects a scan whose bytes do not match the checksum', async () => {
    const { doc, scans } = await fixture();
    const tampered = scans.map((s, i) => (i === 0 ? { ...s, bytes: strToU8('something else') } : s));
    await expect(importProject(exportProject({ doc, scans: tampered, appVersion: 'x' }))).rejects.toThrow(/checksum/);
  });
});
