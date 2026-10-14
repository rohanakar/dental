import { describe, expect, it } from 'vitest';
import type { V3 } from './pca';
import { evaluateRbf, evaluateRbfFields, solveRbf, solveRbfFields } from './rbf';

function randomPoints(n: number, seed = 1): Float64Array {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 10 - 5;
  const out = new Float64Array(n * 3);
  for (let i = 0; i < out.length; i++) out[i] = rnd();
  return out;
}

describe('RBF displacement field', () => {
  it('interpolates its centres exactly (cubic and linear kernels)', () => {
    const centers = randomPoints(150);
    const values = randomPoints(150, 7).map((x) => x * 0.1);
    for (const kernel of ['cubic', 'linear'] as const) {
      const field = solveRbf(centers, values, { kernel });
      for (let i = 0; i < 150; i++) {
        const d = evaluateRbf(field, [centers[i * 3]!, centers[i * 3 + 1]!, centers[i * 3 + 2]!]);
        for (let k = 0; k < 3; k++) expect(Math.abs(d[k]! - values[i * 3 + k]!)).toBeLessThan(1e-6);
      }
    }
  });

  it('solves several fields with one factorization, equal to solving each alone', () => {
    const centers = randomPoints(60, 5);
    const a = randomPoints(60, 9).map((x) => x * 0.1);
    const b = randomPoints(60, 11).map((x) => x * 0.2);
    const fields = solveRbfFields(centers, [a, b]);
    const out = new Float64Array(6);
    for (const p of [[0.3, -1, 2], [4, 4, -4], [0, 0, 0]] as V3[]) {
      evaluateRbfFields(fields, p, out);
      const da = evaluateRbf(solveRbf(centers, a), p);
      const db = evaluateRbf(solveRbf(centers, b), p);
      for (let k = 0; k < 3; k++) {
        expect(out[k]).toBeCloseTo(da[k]!, 9);
        expect(out[3 + k]).toBeCloseTo(db[k]!, 9);
      }
    }
  });
});
