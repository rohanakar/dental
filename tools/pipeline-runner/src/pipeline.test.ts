import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeSyntheticCase } from './golden';
import { runCase } from './pipeline';

describe('pipeline runner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcad-golden-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('passes every check on the synthetic FDI 36 case with the automatic margin', async () => {
    const spec = writeSyntheticCase(join(dir, 'synthetic-36'), { along: 600, across: 160 });
    const { metrics, crownStl } = await runCase(spec, join(dir, 'synthetic-36'), { auto: true });
    expect(metrics.checks.filter((c) => !c.passed)).toEqual([]);
    expect(metrics.ok).toBe(true);
    expect(metrics.margin.source).toBe('auto');
    expect(metrics.margin.meanDeviationMm).toBeLessThan(0.15);
    expect(metrics.contacts.mesial).toBeDefined();
    expect(metrics.contacts.distal).toBeDefined();
    expect(metrics.crown.watertight).toBe(true);
    expect(crownStl.byteLength).toBe(84 + 50 * metrics.crown.triangles);
  });
});
