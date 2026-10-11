import { describe, expect, it } from 'vitest';
import { clearanceMap, thicknessMap, unmillableMap } from './crownMaps';
import type { IndexedMesh } from './mesh';
import { computeVertexNormals } from './normals';
import { bvhRayCaster, createBvh } from './raycast';
import { grid } from './testMeshes';

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

describe('unmillableMap', () => {
  it('flags the inside corners of a sharp step in the cavity ceiling', () => {
    // Ceiling seen from below: 1 mm higher in the middle band, with near-vertical walls.
    const ceiling = heightField((x) => (Math.abs(x) < 1 ? 1 : Math.abs(x) < 1.02 ? 1 - (Math.abs(x) - 1) * 50 : 0), 3, 300, true);
    const n = ceiling.positions.length / 3;
    const depth = unmillableMap({ positions: ceiling.positions, vertexStart: 0, vertexEnd: n, intaglio: rayOf(ceiling), axis: [0, 0, 1], toolRadiusMm: 0.5 });
    let maxNearCorner = 0, maxFar = 0;
    for (let v = 0; v < n; v++) {
      const x = Math.abs(ceiling.positions[v * 3]!);
      const y = Math.abs(ceiling.positions[v * 3 + 1]!);
      if (y > 2) continue; // stay away from the grid border
      if (x > 0.7 && x < 1.0) maxNearCorner = Math.max(maxNearCorner, depth[v]!);
      if (x < 0.3) maxFar = Math.max(maxFar, depth[v]!);
    }
    expect(maxNearCorner).toBeGreaterThan(0.05);
    expect(maxFar).toBeLessThan(0.01);
  });

  it('does not flag a smooth dome wider than the tool', () => {
    const dome = heightField((x, y) => Math.sqrt(Math.max(0, 25 - x * x - y * y)) - 4, 2.5, 120, true);
    const n = dome.positions.length / 3;
    const depth = unmillableMap({ positions: dome.positions, vertexStart: 0, vertexEnd: n, intaglio: rayOf(dome), axis: [0, 0, 1], toolRadiusMm: 0.5 });
    let max = 0;
    for (let v = 0; v < n; v++) {
      if (Math.hypot(dome.positions[v * 3]!, dome.positions[v * 3 + 1]!) < 2) max = Math.max(max, depth[v]!);
    }
    expect(max).toBeLessThan(0.01);
  });

  it('is zero for a zero tool radius and NaN outside the range', () => {
    const g = grid(4, 4);
    const depth = unmillableMap({ positions: g.positions, vertexStart: 0, vertexEnd: 5, intaglio: rayOf(g), axis: [0, 0, 1], toolRadiusMm: 0 });
    expect(depth[0]).toBe(0);
    expect(Number.isNaN(depth[10]!)).toBe(true);
  });
});

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

  it('ignores flagged faces', () => {
    const crown = heightField(() => 0, 1, 4, false);
    const normals = computeVertexNormals(crown);
    const target = heightField(() => 0.3, 5, 2, true);
    const targetMesh = { positions: target.positions, indices: target.indices.slice() };
    const ray = bvhRayCaster(createBvh(targetMesh));
    const all = new Uint8Array(targetMesh.indices.length / 3).fill(1);
    const out = clearanceMap({ positions: crown.positions, normals, vertexStart: 0, vertexEnd: 25, target: ray, ignoreFaces: all });
    expect(out.every((x) => Number.isNaN(x))).toBe(true);
  });
});

describe('thicknessMap', () => {
  it('measures the signed distance to the intaglio for the shell range only', () => {
    const inner = heightField(() => 0, 2, 10, true);
    const outerTop = heightField(() => 1.2, 2, 10, false);
    const positions = new Float32Array([...inner.positions, ...outerTop.positions]);
    const ni = inner.positions.length / 3;
    const indices = inner.indices.slice();
    const map = thicknessMap(positions, ni, positions.length / 3, { ray: bvhRayCaster(createBvh({ positions: inner.positions, indices })), positions: inner.positions, indices });
    expect(Number.isNaN(map[0]!)).toBe(true);
    const centre = map[ni + 5 * 11 + 5]!;
    expect(centre).toBeCloseTo(1.2, 4);
  });
});
