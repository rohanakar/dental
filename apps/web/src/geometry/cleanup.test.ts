import { describe, expect, it } from 'vitest';
import { cleanupMesh, removeDegenerateFaces, removeDuplicateFaces, removeSmallComponents } from './cleanup';
import { computeVertexNormals } from './normals';
import { cube, grid, merge } from './testMeshes';

describe('cleanup', () => {
  it('removes faces with repeated indices and zero area', () => {
    const mesh = cube(1);
    // Append: repeated index, and a collinear (zero-area) triangle.
    const indices = new Uint32Array([...mesh.indices, 0, 0, 1, 0, 1, 1]);
    const collinear = new Float32Array([...mesh.positions, 2, 0, 0, 3, 0, 0, 4, 0, 0]);
    const withCollinear = new Uint32Array([...indices, 8, 9, 10]);
    const { mesh: out, removed } = removeDegenerateFaces({ positions: collinear, indices: withCollinear }, 1e-10);
    expect(removed).toBe(3);
    expect(out.indices.length / 3).toBe(12);
  });

  it('removes duplicate faces regardless of winding', () => {
    const mesh = cube(1);
    const indices = new Uint32Array([...mesh.indices, 0, 2, 1, 1, 0, 2, 4, 5, 6]);
    const { mesh: out, removed } = removeDuplicateFaces({ positions: mesh.positions, indices });
    expect(removed).toBe(3);
    expect(out.indices.length / 3).toBe(12);
  });

  it('removes small disconnected components', () => {
    const big = grid(40); // 3200 faces → threshold 32
    const debris = cube(0.5, [50, 50, 50]); // 12 faces < 1% of 3200
    const medium = grid(5, 3); // 50 faces >= 1%
    const mesh = merge(big, debris, merge(medium));
    const res = removeSmallComponents(mesh, 0.01);
    expect(res.removedFaces).toBe(12);
    expect(res.removedComponents).toBe(1);
    expect(res.keptComponents).toBe(2);
  });

  it('full cleanup drops unused vertices', () => {
    const mesh = merge(grid(40), cube(0.5, [50, 50, 50]));
    const { mesh: out, stats } = cleanupMesh(mesh);
    expect(stats.removedSmallComponentFaces).toBe(12);
    expect(out.positions.length / 3).toBe(41 * 41);
    expect(Math.max(...out.indices)).toBe(41 * 41 - 1);
  });
});

describe('normals', () => {
  it('computes +z normals for a flat grid', () => {
    const n = computeVertexNormals(grid(4));
    for (let i = 0; i < n.length; i += 3) {
      expect(n[i]).toBeCloseTo(0);
      expect(n[i + 1]).toBeCloseTo(0);
      expect(n[i + 2]).toBeCloseTo(1);
    }
  });

  it('weights by face area', () => {
    // Vertex 0 shared by a large +z triangle and a small +x triangle.
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 1, 0, 0, 0, 1]);
    const indices = new Uint32Array([0, 1, 2, 0, 3, 4]);
    const n = computeVertexNormals({ positions, indices });
    expect(n[2]!).toBeGreaterThan(0.99); // dominated by the big triangle
    expect(n[0]!).toBeGreaterThan(0);
    expect(n[0]!).toBeLessThan(0.05);
  });
});
