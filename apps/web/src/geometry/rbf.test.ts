import { describe, expect, it } from 'vitest';
import type { V3 } from './pca';
import { applyRbf, evaluateRbf, evaluateRbfFields, solveRbf, solveRbfFields } from './rbf';

function randomPoints(n: number, seed = 1): Float64Array {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 10 - 5;
  const out = new Float64Array(n * 3);
  for (let i = 0; i < out.length; i++) out[i] = rnd();
  return out;
}

describe('RBF displacement field', () => {
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

  it('reproduces an affine displacement everywhere (no kernel weight needed)', () => {
    const centers = randomPoints(40, 3);
    const affine = (p: V3): V3 => [0.1 + 0.02 * p[0] - 0.01 * p[2], -0.3 + 0.05 * p[1], 0.2 * p[0] + 0.1 * p[1] - 0.04 * p[2]];
    const values = new Float64Array(40 * 3);
    for (let i = 0; i < 40; i++) values.set(affine([centers[i * 3]!, centers[i * 3 + 1]!, centers[i * 3 + 2]!]), i * 3);
    const field = solveRbf(centers, values);
    for (const p of [[0, 0, 0], [12, -7, 3], [-20, 4, 9]] as V3[]) {
      const d = evaluateRbf(field, p);
      const e = affine(p);
      for (let k = 0; k < 3; k++) expect(d[k]).toBeCloseTo(e[k]!, 6);
    }
  });

  it('is smooth between centres and applies in place with weights', () => {
    // Ring of centres displaced outward by 1, anchors above with zero displacement.
    const n = 64;
    const centers = new Float64Array((n + 8) * 3);
    const values = new Float64Array((n + 8) * 3);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      centers.set([5 * Math.cos(a), 5 * Math.sin(a), 0], i * 3);
      values.set([Math.cos(a), Math.sin(a), 0], i * 3);
    }
    for (let k = 0; k < 8; k++) {
      const a = (2 * Math.PI * k) / 8;
      centers.set([2 * Math.cos(a), 2 * Math.sin(a), 6], (n + k) * 3);
    }
    const field = solveRbf(centers, values);
    // Halfway up, the displacement magnitude lies between the ring (1) and the anchors (0).
    const mid = Math.hypot(...evaluateRbf(field, [3.5, 0, 3]));
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(1.2);
    // Between two ring centres the value stays close to the neighbours'.
    const between = evaluateRbf(field, [5 * Math.cos(Math.PI / n), 5 * Math.sin(Math.PI / n), 0]);
    expect(Math.hypot(...between)).toBeCloseTo(1, 1);
    const pts = new Float32Array([5, 0, 0, 0, 5, 0]);
    applyRbf(field, pts, [1, 0]);
    expect(pts[0]).toBeCloseTo(6, 5);
    expect(pts[4]).toBe(5);
  });

  it('rejects singular systems (duplicate centres)', () => {
    const c = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]);
    expect(() => solveRbf(c, new Float64Array(15))).toThrow(/singular/);
  });
});
