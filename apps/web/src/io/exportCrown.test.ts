import { describe, expect, it } from 'vitest';
import { newDocument } from '../design/document';
import { closeCervix, syntheticTemplate } from '../geometry/crownTemplate';
import { validateClosedMesh } from '../geometry/meshValidate';
import { parseStl } from '../geometry/stl';
import { weldSoup } from '../geometry/weld';
import { CONSTRUCTION_FORMAT, constructionInfo, crownStl } from './exportCrown';

describe('crown export', () => {
  it('round-trips a closed crown through binary STL', () => {
    const mesh = closeCervix(syntheticTemplate('molar', 'lower'));
    const bytes = crownStl(mesh);
    expect(bytes.byteLength).toBe(84 + 50 * (mesh.indices.length / 3));
    const welded = weldSoup(parseStl(bytes));
    expect(welded.indices.length).toBe(mesh.indices.length);
    expect(validateClosedMesh(welded).ok).toBe(true);
  });

  it('writes a JSON-serializable construction sidecar', () => {
    const doc = newDocument('case-1');
    const tooth = doc.teeth[0]!;
    const validation = validateClosedMesh(closeCervix(syntheticTemplate('molar', 'lower')));
    const info = constructionInfo({
      doc,
      tooth,
      appVersion: '0.1.0',
      createdAt: '2026-10-11T00:00:00.000Z',
      result: {
        templateId: 'synthetic.lower-molar@1',
        pose: { position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [-1, 1, 1] },
        validation,
        minAxialThicknessMm: 0.6,
      },
    });
    const parsed = JSON.parse(JSON.stringify(info));
    expect(parsed).toMatchObject({
      format: CONSTRUCTION_FORMAT,
      appVersion: '0.1.0',
      caseId: 'case-1',
      fdi: 36,
      material: 'zirconia',
      units: 'mm',
      crown: { kind: 'template', templateId: 'synthetic.lower-molar@1' },
      validation: { ok: true },
      metrics: { minAxialThicknessMm: 0.6 },
    });
    expect(parsed.margin).toBeNull();
  });
});
