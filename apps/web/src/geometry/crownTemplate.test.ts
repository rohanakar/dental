import { describe, expect, it } from 'vitest';
import { closeCervix, syntheticTemplate, templateForTooth } from './crownTemplate';
import { boundaryLoops, validateClosedMesh } from './meshValidate';

describe('synthetic crown templates', () => {
  it('are open only at the cervix, close into a valid outward solid and have the nominal size', () => {
    for (const type of ['central', 'lateral', 'canine', 'premolar', 'molar'] as const) {
      for (const jaw of ['lower', 'upper'] as const) {
        const t = syntheticTemplate(type, jaw);
        const loops = boundaryLoops(t.mesh);
        expect(loops).toHaveLength(1);
        expect(new Set(loops[0])).toEqual(new Set(t.cervicalLoop));
        const closed = validateClosedMesh(closeCervix(t));
        expect(closed.ok).toBe(true);
        expect(closed.signedVolumeMm3).toBeGreaterThan(100);
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        t.mesh.positions.forEach((v, i) => {
          lo[i % 3] = Math.min(lo[i % 3]!, v);
          hi[i % 3] = Math.max(hi[i % 3]!, v);
        });
        expect(hi[0]! - lo[0]!).toBeCloseTo(t.size.md, 1);
        expect(hi[1]! - lo[1]!).toBeCloseTo(t.size.bl, 1);
        expect(hi[2]! / t.size.height).toBeGreaterThan(0.95);
        expect(hi[2]! / t.size.height).toBeLessThan(1.02);
      }
    }
    expect([11, 12, 13, 14, 15, 16, 17, 18].map((fdi) => templateForTooth(fdi).type)).toEqual([
      'central',
      'lateral',
      'canine',
      'premolar',
      'premolar',
      'molar',
      'molar',
      'molar',
    ]);
  });
});
