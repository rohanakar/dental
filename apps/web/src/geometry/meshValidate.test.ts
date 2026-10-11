import { describe, expect, it } from 'vitest';
import { boundaryLoops, validateClosedMesh } from './meshValidate';
import { cube } from './testMeshes';

describe('validateClosedMesh', () => {
  it('accepts a closed, outward cube', () => {
    const v = validateClosedMesh(cube(1));
    expect(v).toMatchObject({ triangles: 12, vertices: 8, boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, closed: true, oriented: true, ok: true });
    expect(v.signedVolumeMm3).toBeCloseTo(1, 9);
  });

  it('reports an open face as 4 boundary edges and one boundary loop', () => {
    const m = cube(1);
    const open = { positions: m.positions, indices: m.indices.slice(6) }; // drop the bottom face
    const v = validateClosedMesh(open);
    expect(v.boundaryEdges).toBe(4);
    expect(v.closed).toBe(false);
    expect(v.ok).toBe(false);
    const loops = boundaryLoops(open);
    expect(loops).toHaveLength(1);
    expect(new Set(loops[0])).toEqual(new Set([0, 1, 2, 3]));
  });

  it('detects a flipped triangle as inconsistent orientation', () => {
    const m = cube(1);
    const indices = m.indices.slice();
    [indices[1], indices[2]] = [indices[2]!, indices[1]!];
    const v = validateClosedMesh({ positions: m.positions, indices });
    expect(v.inconsistentEdges).toBeGreaterThan(0);
    expect(v.oriented).toBe(false);
    expect(v.ok).toBe(false);
  });

  it('detects inside-out meshes by negative volume', () => {
    const m = cube(1);
    const indices = m.indices.slice();
    for (let f = 0; f < indices.length; f += 3) [indices[f + 1], indices[f + 2]] = [indices[f + 2]!, indices[f + 1]!];
    const v = validateClosedMesh({ positions: m.positions, indices });
    expect(v.closed && v.oriented).toBe(true);
    expect(v.signedVolumeMm3).toBeCloseTo(-1, 9);
    expect(v.ok).toBe(false);
  });

  it('detects non-manifold edges and degenerate triangles', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 2, 0, 0]);
    // Three triangles share edge 0-1; the last triangle is degenerate (collinear).
    const indices = new Uint32Array([0, 1, 2, 1, 0, 3, 0, 1, 4, 0, 1, 5]);
    const v = validateClosedMesh({ positions, indices });
    expect(v.nonManifoldEdges).toBe(1);
    expect(v.degenerateTriangles).toBe(1);
    expect(v.closed).toBe(false);
  });

  it('is fast enough for crown-sized meshes', () => {
    const n = 100;
    // A closed 100×100 grid-of-cubes style test: many cubes merged (no shared vertices).
    const cubes = Array.from({ length: n * 20 }, (_, i) => cube(1, [i * 2, 0, 0]));
    const positions = new Float32Array(cubes.length * 24);
    const indices = new Uint32Array(cubes.length * 36);
    cubes.forEach((c, i) => {
      positions.set(c.positions, i * 24);
      for (let k = 0; k < 36; k++) indices[i * 36 + k] = c.indices[k]! + i * 8;
    });
    const t0 = performance.now();
    const v = validateClosedMesh({ positions, indices });
    expect(v.ok).toBe(true);
    expect(v.triangles).toBe(24_000);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
