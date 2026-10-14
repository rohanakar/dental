import { describe, expect, it } from 'vitest';
import { clearanceMap } from './crownMaps';
import type { IndexedMesh } from './mesh';
import { computeVertexNormals } from './normals';
import { bvhRayCaster, createBvh } from './raycast';

/** Height-field surface z = h(x, y) over [-s, s]², n×n quads; faces point down when facesDown. */
function heightField(h: (x: number, y: number) => number, s: number, n: number, facesDown: boolean): IndexedMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -s + (2 * s * i) / n;
      const y = -s + (2 * s * j) / n;
      positions.push(x, y, h(x, y));
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      if (facesDown) indices.push(a, d, b, a, c, d);
      else indices.push(a, b, d, a, d, c);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const rayOf = (m: IndexedMesh) => bvhRayCaster(createBvh({ positions: m.positions, indices: m.indices.slice() }));

describe('clearanceMap', () => {
  it('is positive for a gap, negative where the surface penetrates the target, NaN when out of range', () => {
    // "Crown" top: a grid in z = 0 facing +z, with a bump reaching 0.6 mm in the middle.
    const crown = heightField((x, y) => 0.6 * Math.exp(-(x * x + y * y)), 3, 30, false);
    const normals = computeVertexNormals(crown);
    // Antagonist: plane z = 0.5 facing down (toward the crown).
    const antagonist = heightField(() => 0.5, 10, 4, true);
    const n = crown.positions.length / 3;
    const clearance = clearanceMap({ positions: crown.positions, normals, vertexStart: 0, vertexEnd: n, target: rayOf(antagonist), maxMm: 2 });
    const centre = clearance[(15 * 31 + 15)]!; // x = y = 0, z = 0.6: 0.1 above the plane
    expect(centre).toBeLessThan(-0.05);
    expect(centre).toBeGreaterThan(-0.15);
    const corner = clearance[0]!; // far from the bump: 0.5 below the plane
    expect(corner).toBeGreaterThan(0.45);
    expect(corner).toBeLessThan(0.55);
    const far = clearanceMap({ positions: crown.positions, normals, vertexStart: 0, vertexEnd: n, target: rayOf(antagonist), maxMm: 0.2 });
    expect(Number.isNaN(far[0]!)).toBe(true);
  });
});
