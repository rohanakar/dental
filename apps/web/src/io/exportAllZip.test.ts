import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseStl } from '../geometry/stl';
import { uvSphere } from '../geometry/testUtils';
import { exportAllZip, type RestorationExport } from './exportAllZip';
import { bridgeStl, crownStl } from './exportCrown';
import { frameworkStl, overpressStl } from './exportFramework';

describe('export all', () => {
  it('writes every restoration in one zip with a manifest of open checks', () => {
    const crown = uvSphere(4, 8, 16);
    const bridge = uvSphere(9, 12, 24);
    const restorations: RestorationExport[] = [
      { kind: 'crown', name: '11 crown', teeth: [11], base: 'LAB-7-11', stls: [{ file: 'LAB-7-11.stl', bytes: crownStl(crown) }], info: { fdi: 11 }, open: [] },
      {
        kind: 'crown',
        name: '21 reduced crown',
        teeth: [21],
        base: 'LAB-7-21',
        stls: [
          { file: 'LAB-7-21-framework.stl', bytes: frameworkStl(crown) },
          { file: 'LAB-7-21-overpress.stl', bytes: overpressStl(crown) },
        ],
        info: { fdi: 21 },
        open: [{ label: 'Margin closed', detail: 'No kinks' }],
      },
      { kind: 'bridge', name: 'bridge 33–35', teeth: [33, 34, 35], base: 'LAB-7-33-35-bridge', stls: [{ file: 'LAB-7-33-35-bridge.stl', bytes: bridgeStl(bridge) }], info: { kind: 'bridge' }, open: [] },
      { kind: 'crown', name: '46 crown', teeth: [46], base: 'LAB-7-46', stls: [], open: [], skipped: 'No crown proposed yet.' },
    ];
    const { bytes, fileName } = exportAllZip({ caseRef: 'LAB-7', caseId: 'c-1', patientRef: 'LAB-7', appVersion: '0.3.0', restorations });
    expect(fileName).toBe('LAB-7-restorations.zip');

    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual([
      'LAB-7-11.construction.json',
      'LAB-7-11.stl',
      'LAB-7-21-framework.stl',
      'LAB-7-21-overpress.stl',
      'LAB-7-21.construction.json',
      'LAB-7-33-35-bridge.construction.json',
      'LAB-7-33-35-bridge.stl',
      'README.txt',
      'manifest.json',
    ]);
    // The meshes and sidecars come out as they went in.
    expect(parseStl(files['LAB-7-11.stl']!).positions.length / 9).toBe(crown.indices.length / 3);
    expect(parseStl(files['LAB-7-33-35-bridge.stl']!).positions.length / 9).toBe(bridge.indices.length / 3);
    expect(JSON.parse(strFromU8(files['LAB-7-21.construction.json']!))).toEqual({ fdi: 21 });

    // Readiness per restoration: ready, open checks, left out with the reason.
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(manifest.restorations.map((r: { teeth: number[]; ready: boolean; files: string[] }) => [r.teeth, r.ready, r.files.length])).toEqual([
      [[11], true, 2],
      [[21], false, 3],
      [[33, 34, 35], true, 2],
      [[46], false, 0],
    ]);
    expect(manifest.restorations[1].openChecks).toEqual(restorations[1]!.open);
    expect(manifest.restorations[3].skipped).toBe('No crown proposed yet.');
  });
});
