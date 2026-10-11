import { MATERIAL_PRESETS } from '@dcad/shared';
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from './mesh';
import { bvhRayCaster, createBvh } from './raycast';
import { buildVertexAdjacency } from './surface';
import { distanceToLoop, enforceThickness, signedIntaglioDistance, thicknessProfile, type IntaglioSurface } from './thickness';

const params = MATERIAL_PRESETS['lithium-disilicate']; // margin 0.15 → min 1.0

/** Height-field dome over the disk r ≤ R, as a polar grid (centre vertex + rings). */
function dome(height: (r: number) => number, R: number, rings = 30, segments = 64, facesDown = false): IndexedMesh & { rim: number[] } {
  const positions: number[] = [0, 0, height(0)];
  const indices: number[] = [];
  for (let i = 1; i <= rings; i++) {
    const r = (R * i) / rings;
    for (let j = 0; j < segments; j++) {
      const a = (2 * Math.PI * j) / segments;
      positions.push(r * Math.cos(a), r * Math.sin(a), height(r));
    }
  }
  const id = (i: number, j: number) => (i === 0 ? 0 : 1 + (i - 1) * segments + (j % segments));
  const tri = (a: number, b: number, c: number) => (facesDown ? indices.push(a, c, b) : indices.push(a, b, c));
  for (let j = 0; j < segments; j++) tri(0, id(1, j), id(1, j + 1));
  for (let i = 1; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      tri(id(i, j), id(i + 1, j), id(i + 1, j + 1));
      tri(id(i, j), id(i + 1, j + 1), id(i, j + 1));
    }
  }
  const rim = Array.from({ length: segments }, (_, j) => id(rings, j));
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), rim };
}

function surface(mesh: IndexedMesh): IntaglioSurface {
  const positions = mesh.positions.slice();
  const indices = mesh.indices.slice();
  return { ray: bvhRayCaster(createBvh({ positions, indices })), positions, indices };
}

describe('thickness profile', () => {
  it('ramps from the margin thickness to the minimum within 1 mm', () => {
    expect(thicknessProfile(0, params)).toBeCloseTo(0.15, 9);
    expect(thicknessProfile(1, params)).toBeCloseTo(1, 9);
    expect(thicknessProfile(5, params)).toBeCloseTo(1, 9);
    const half = thicknessProfile(0.5, params);
    expect(half).toBeGreaterThan(0.15);
    expect(half).toBeLessThan(1);
  });
});

describe('enforceThickness', () => {
  it('pushes a shell that is too close to (or below) the intaglio out to the profile', () => {
    // Intaglio: a dome of radius 4, faces pointing down (toward the "prep"), as in a crown.
    const inner = dome((r) => 3 * (1 - (r / 4) ** 2), 4, 30, 64, true);
    const intaglio = surface(inner);
    // Shell: the same dome only 0.3 mm higher in the middle and dipping below the intaglio near r = 2.
    const shell = dome((r) => 3 * (1 - (r / 4) ** 2) + 0.3 - 0.5 * Math.exp(-((r - 2) ** 2) / 0.3), 4.1, 30, 64);
    const marginLoop = new Float32Array(inner.rim.length * 3);
    inner.rim.forEach((v, i) => marginLoop.set(inner.positions.subarray(v * 3, v * 3 + 3), i * 3));
    const fixed = new Uint8Array(shell.positions.length / 3);
    for (const v of shell.rim) fixed[v] = 1;
    const positions = shell.positions.slice();
    const result = enforceThickness({
      positions,
      vertexStart: 0,
      vertexEnd: positions.length / 3,
      intaglio,
      marginLoop,
      params,
      shellGraph: buildVertexAdjacency(shell.indices, positions.length / 3),
      fixed,
    });
    expect(result.minSlackBeforeMm).toBeLessThan(-0.5);
    expect(result.pushedVertices).toBeGreaterThan(100);
    expect(result.minSlackAfterMm).toBeGreaterThan(-0.02);
    // Independent re-measurement on the moved vertices.
    for (let v = 0; v < positions.length / 3; v++) {
      if (fixed[v]) continue;
      const p: [number, number, number] = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
      const s = signedIntaglioDistance(p, intaglio, 5);
      if (!s) continue;
      expect(s.distance).toBeGreaterThan(thicknessProfile(distanceToLoop(p, marginLoop), params) - 0.02);
    }
    // Pinned vertices never move.
    for (const v of shell.rim) expect(positions[v * 3 + 2]).toBe(shell.positions[v * 3 + 2]);
  });

  it('leaves a shell that already satisfies the profile untouched', () => {
    const inner = dome((r) => 2 * (1 - (r / 4) ** 2), 4, 20, 48, true);
    const shell = dome((r) => 2 * (1 - (r / 4) ** 2) + 1.5, 4, 20, 48);
    const marginLoop = new Float32Array([10, 0, 0, 0, 10, 0, -10, 0, 0, 0, -10, 0]); // far away: full min thickness everywhere
    const positions = shell.positions.slice();
    const result = enforceThickness({ positions, vertexStart: 0, vertexEnd: positions.length / 3, intaglio: surface(inner), marginLoop, params });
    expect(result.pushedVertices).toBe(0);
    expect([...positions]).toEqual([...shell.positions]);
  });
});
