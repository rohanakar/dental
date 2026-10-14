import { describe, expect, it } from 'vitest';
import { processScan, unitWarnings } from './processScan';
import { writeBinaryStl } from './stl';
import { syntheticArch } from './synthetic';

describe('processScan', () => {
  it('imports a synthetic arch STL without warnings', async () => {
    const arch = syntheticArch({ along: 120, across: 30 });
    const result = await processScan(writeBinaryStl(arch), 'lower.stl');
    expect(result.stats.format).toBe('stl-binary');
    expect(result.stats.triangles).toBe(arch.indices.length / 3);
    expect(result.stats.vertices).toBe(arch.positions.length / 3);
    expect(result.warnings).toEqual([]);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('warns when units look wrong', async () => {
    const arch = syntheticArch({ along: 60, across: 20 });
    const micro = { ...arch, positions: arch.positions.map((v) => v * 1000) };
    const metres = { ...arch, positions: arch.positions.map((v) => v / 1000) };
    expect((await processScan(writeBinaryStl(micro), 'a.stl')).warnings).toHaveLength(1);
    expect((await processScan(writeBinaryStl(metres), 'a.stl')).warnings).toHaveLength(1);
    expect(unitWarnings([50, 40, 15])).toEqual([]);
  });
});
