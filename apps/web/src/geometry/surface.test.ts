import { describe, expect, it } from 'vitest';
import { computeVertexNormals } from './normals';
import { analyzeSurface, buildVertexAdjacency } from './surface';
import { grid, cube } from './testMeshes';
import { uvSphere } from './testUtils';

describe('surface analysis', () => {
  it('builds unique sorted 1-ring adjacency', () => {
    const g = buildVertexAdjacency(cube().indices, 8);
    for (let v = 0; v < 8; v++) {
      const ring = [...g.neighbors.subarray(g.offsets[v]!, g.offsets[v + 1]!)];
      expect(ring).toEqual([...new Set(ring)].sort((a, b) => a - b));
      expect(ring).not.toContain(v);
    }
    // Interior vertex of a grid: 6 neighbours with this triangulation.
    const gg = buildVertexAdjacency(grid(4).indices, 25);
    expect(gg.offsets[13]! - gg.offsets[12]!).toBe(6);
  });

  it('has positive curvature on a sphere and negative inside a bowl', () => {
    for (const inverted of [false, true]) {
      const mesh = uvSphere(2, 40, 80, inverted);
      const { curvature } = analyzeSurface({ ...mesh, normals: computeVertexNormals(mesh) });
      // Ignore the poles (degenerate fans).
      const vals = [...curvature.subarray(80 * 5, 80 * 35)].sort((a, b) => a - b);
      const median = vals[Math.floor(vals.length / 2)]!;
      if (inverted) expect(median).toBeCloseTo(-0.5, 1);
      else expect(median).toBeCloseTo(0.5, 1);
    }
  });

  it('has zero curvature on a plane', () => {
    const mesh = grid(10);
    const { curvature } = analyzeSurface({ ...mesh, normals: computeVertexNormals(mesh) });
    expect(Math.max(...curvature.map(Math.abs))).toBeLessThan(1e-6);
  });
});
