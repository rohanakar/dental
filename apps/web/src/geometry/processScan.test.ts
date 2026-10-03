import { describe, expect, it } from 'vitest';
import { principalAxes, symmetricEigen3 } from './pca';
import { processScan, sha256Hex, unitWarnings } from './processScan';
import { writePly } from './ply';
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
    const maxExtent = Math.max(...result.stats.sizeMm);
    expect(maxExtent).toBeGreaterThan(30);
    expect(maxExtent).toBeLessThan(80);
  });

  it('keeps PLY colors', async () => {
    const arch = syntheticArch({ along: 60, across: 20, colors: true });
    const result = await processScan(writePly(arch), 'scan.ply');
    expect(result.stats.format).toBe('ply');
    expect(result.stats.hasColors).toBe(true);
    expect(result.mesh.colors!.length).toBe(result.mesh.positions.length);
  });

  it('warns when units look wrong', async () => {
    const arch = syntheticArch({ along: 60, across: 20 });
    const micro = { ...arch, positions: arch.positions.map((v) => v * 1000) };
    const metres = { ...arch, positions: arch.positions.map((v) => v / 1000) };
    expect((await processScan(writeBinaryStl(micro), 'a.stl')).warnings.join()).toMatch(/too large/);
    expect((await processScan(writeBinaryStl(metres), 'a.stl')).warnings.join()).toMatch(/too small/);
    expect(unitWarnings([50, 40, 15])).toEqual([]);
  });

  it('hashes the original bytes', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('pca', () => {
  it('diagonalizes a symmetric matrix', () => {
    const { values, vectors } = symmetricEigen3([
      [2, 1, 0],
      [1, 2, 0],
      [0, 0, 5],
    ]);
    expect([...values].sort((a, b) => a - b).map((v) => Number(v.toFixed(6)))).toEqual([1, 3, 5]);
    // A·v = λ·v for each column.
    for (let k = 0; k < 3; k++) {
      const v = [vectors[0]![k]!, vectors[1]![k]!, vectors[2]![k]!];
      const av = [2 * v[0]! + v[1]!, v[0]! + 2 * v[1]!, 5 * v[2]!];
      for (let i = 0; i < 3; i++) expect(av[i]).toBeCloseTo(values[k]! * v[i]!, 6);
    }
  });

  it('finds the occlusal-plane normal of an arch as the least-variance axis', () => {
    const arch = syntheticArch({ along: 200, across: 40 });
    const { axes } = principalAxes(arch.positions);
    expect(Math.abs(axes[2][2])).toBeGreaterThan(0.95);
  });
});
