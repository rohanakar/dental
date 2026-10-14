import { describe, expect, it } from 'vitest';
import { countSelfIntersections } from './selfIntersect';
import { cube, merge } from './testMeshes';

describe('countSelfIntersections', () => {
  it('finds none on a closed cube, and the overlap of two interpenetrating cubes', () => {
    expect(countSelfIntersections(cube(2)).count).toBe(0);
    const r = countSelfIntersections(merge(cube(1), cube(1, [0.5, 0.5, 0.5])));
    expect(r.count).toBeGreaterThan(0);
    // One face from each cube (cube faces are 0..11, the second cube's 12..23).
    for (const [a, b] of r.pairs) expect(a < 12 && b >= 12).toBe(true);
  });
});
