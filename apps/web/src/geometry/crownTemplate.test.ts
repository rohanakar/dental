import { describe, expect, it } from 'vitest';
import { closeCervix, syntheticTemplate } from './crownTemplate';
import { boundaryLoops, validateClosedMesh } from './meshValidate';

describe('synthetic crown templates', () => {
  it('are open only at the cervix and close into a valid outward solid', () => {
    for (const type of ['molar', 'premolar'] as const) {
      for (const jaw of ['lower', 'upper'] as const) {
        const t = syntheticTemplate(type, jaw);
        const loops = boundaryLoops(t.mesh);
        expect(loops).toHaveLength(1);
        expect(new Set(loops[0])).toEqual(new Set(t.cervicalLoop));
        const closed = validateClosedMesh(closeCervix(t));
        expect(closed.ok).toBe(true);
        expect(closed.signedVolumeMm3).toBeGreaterThan(100);
      }
    }
  });
});
