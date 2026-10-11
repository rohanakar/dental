import { describe, expect, it } from 'vitest';
import { countSelfIntersections } from './selfIntersect';
import { cube, merge } from './testMeshes';

describe('countSelfIntersections', () => {
  it('finds none on a closed cube', () => {
    expect(countSelfIntersections(cube(2)).count).toBe(0);
  });

  it('finds the overlap of two interpenetrating cubes merged into one mesh', () => {
    const r = countSelfIntersections(merge(cube(1), cube(1, [0.5, 0.5, 0.5])));
    expect(r.count).toBeGreaterThan(0);
    expect(r.pairs.length).toBeGreaterThan(0);
    for (const [a, b] of r.pairs) {
      // One face from each cube (cube faces are 0..11, the second cube's 12..23).
      expect(a < 12 && b >= 12).toBe(true);
    }
  });

  it('ignores cubes that only sit side by side', () => {
    expect(countSelfIntersections(merge(cube(1), cube(1, [3, 0, 0]))).count).toBe(0);
  });
});
