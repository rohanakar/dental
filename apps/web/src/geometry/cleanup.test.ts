import { describe, expect, it } from 'vitest';
import { cleanupMesh } from './cleanup';
import { cube, grid, merge } from './testMeshes';

describe('cleanup', () => {
  it('drops small disconnected debris and the vertices it used', () => {
    const mesh = merge(grid(40), cube(0.5, [50, 50, 50]));
    const { mesh: out, stats } = cleanupMesh(mesh);
    expect(stats.removedSmallComponentFaces).toBe(12);
    expect(out.positions.length / 3).toBe(41 * 41);
    expect(Math.max(...out.indices)).toBe(41 * 41 - 1);
  });
});
