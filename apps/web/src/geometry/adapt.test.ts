import { describe, expect, it } from 'vitest';
import { adaptContacts, adaptOcclusion, findConflict, measureClearances, occlusalSelect, proximalSelect } from './adapt';
import type { IndexedMesh } from './mesh';
import { computeVertexNormals } from './normals';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh, type RayCaster } from './raycast';
import { buildVertexAdjacency } from './surface';
import { revolutionMesh } from './testUtils';

const R = 4;

/** Open hemispherical shell of radius R (apex up, rim at z = 0), heightFraction = z / R, rim fixed. */
function dome() {
  const profile: Array<[number, number]> = [];
  const rings = 48;
  for (let i = 0; i <= rings; i++) {
    const th = (Math.PI / 2) * (i / rings);
    profile.push([R * Math.sin(th), R * Math.cos(th)]);
  }
  const { mesh } = revolutionMesh(profile, 96);
  const n = mesh.positions.length / 3;
  const normals = computeVertexNormals(mesh);
  // Outward normals: the apex normal points up.
  if (normals[2]! < 0) {
    for (let f = 0; f < mesh.indices.length; f += 3) [mesh.indices[f + 1], mesh.indices[f + 2]] = [mesh.indices[f + 2]!, mesh.indices[f + 1]!];
  }
  const heightFraction = new Float32Array(n);
  const fixed = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    heightFraction[v] = mesh.positions[v * 3 + 2]! / R;
    if (mesh.positions[v * 3 + 2]! < 1e-6) fixed[v] = 1;
  }
  return { mesh, normals: computeVertexNormals(mesh), heightFraction, fixed, graph: buildVertexAdjacency(mesh.indices, n) };
}

/** Square plane through `point` facing `normal` (as a 2-triangle mesh scaled up). */
function plane(point: V3, normal: V3, size = 40): RayCaster {
  const [nx, ny, nz] = normal;
  const u: V3 = Math.abs(nz) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  // v = n × u, u' = v × n (right-handed so (u', v) winds CCW around n).
  const v: V3 = [ny * u[2] - nz * u[1], nz * u[0] - nx * u[2], nx * u[1] - ny * u[0]];
  const uu: V3 = [v[1] * nz - v[2] * ny, v[2] * nx - v[0] * nz, v[0] * ny - v[1] * nx];
  const c = (a: number, b: number) => [0, 1, 2].map((k) => point[k]! + a * size * uu[k]! + b * size * v[k]!);
  const mesh: IndexedMesh = {
    positions: new Float32Array([...c(-1, -1), ...c(1, -1), ...c(1, 1), ...c(-1, 1)]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const normalsCheck = computeVertexNormals(mesh);
  if (normalsCheck[0]! * nx + normalsCheck[1]! * ny + normalsCheck[2]! * nz < 0) mesh.indices.set([0, 2, 1, 0, 3, 2]);
  return bvhRayCaster(createBvh(mesh));
}

const UP: V3 = [0, 0, 1];
const X: V3 = [1, 0, 0];

function displacementsAlong(before: Float32Array, after: Float32Array, d: V3): Float64Array {
  const out = new Float64Array(before.length / 3);
  for (let v = 0; v < out.length; v++) {
    out[v] = (after[v * 3]! - before[v * 3]!) * d[0] + (after[v * 3 + 1]! - before[v * 3 + 1]!) * d[1] + (after[v * 3 + 2]! - before[v * 3 + 2]!) * d[2];
  }
  return out;
}

function maxEdgeJump(field: Float64Array, graph: ReturnType<typeof buildVertexAdjacency>): number {
  let worst = 0;
  for (let v = 0; v < field.length; v++) {
    for (let k = graph.offsets[v]!; k < graph.offsets[v + 1]!; k++) worst = Math.max(worst, Math.abs(field[v]! - field[graph.neighbors[k]!]!));
  }
  return worst;
}

describe('occlusal adaptation against a flat antagonist', () => {
  it('reduces a penetrating dome to the target clearance, smoothly', () => {
    const d = dome();
    const before = d.mesh.positions.slice();
    const target = plane([0, 0, R - 0.2], [0, 0, -1]); // 0.2 mm into the apex
    const input = { positions: d.mesh.positions, normals: d.normals, shellStart: 0, shellGraph: d.graph, heightFraction: d.heightFraction, fixed: d.fixed, target, direction: UP, targetMm: 0.05 };
    const report = adaptOcclusion(input);
    expect(report.minClearanceBeforeMm).toBeCloseTo(-0.2, 2);
    expect(report.minClearanceMm).toBeGreaterThanOrEqual(0.05 - 0.02);
    expect(report.movedVertices).toBeGreaterThan(10);
    // Never moves more than the largest deficit, and the displacement field is smooth.
    expect(report.maxMoveMm).toBeLessThanOrEqual(0.25 + 1e-3);
    const disp = displacementsAlong(before, d.mesh.positions, UP);
    expect(maxEdgeJump(disp, d.graph)).toBeLessThan(0.08);
    for (let v = 0; v < d.fixed.length; v++) if (d.fixed[v]) expect(disp[v]).toBe(0);
    const after = measureClearances({ ...input, select: occlusalSelect(UP) }, 3);
    for (const c of after) if (!Number.isNaN(c)) expect(c).toBeGreaterThanOrEqual(0.03);
  });

  it('raises the dome into contact when the antagonist is within 0.5 mm', () => {
    const d = dome();
    const target = plane([0, 0, R + 0.3], [0, 0, -1]);
    const report = adaptOcclusion({ positions: d.mesh.positions, normals: d.normals, shellStart: 0, shellGraph: d.graph, heightFraction: d.heightFraction, fixed: d.fixed, target, direction: UP, targetMm: 0.05 });
    expect(report.minClearanceBeforeMm).toBeCloseTo(0.3, 2);
    expect(Math.abs(report.minClearanceMm - 0.05)).toBeLessThan(0.03);
  });

  it('reports a conflict when something pushes the surface back toward the antagonist', () => {
    const d = dome();
    const target = plane([0, 0, R - 0.2], [0, 0, -1]);
    const input = { positions: d.mesh.positions, normals: d.normals, shellStart: 0, shellGraph: d.graph, heightFraction: d.heightFraction, fixed: d.fixed, target, direction: UP, targetMm: 0.05 };
    adaptOcclusion(input);
    expect(findConflict({ ...input, select: occlusalSelect(UP) }, 'insufficient reduction').conflict).toBeUndefined();
    // Stand-in for thickness enforcement winning: lift the top back up by 0.15 mm.
    for (let v = 0; v < d.fixed.length; v++) if (d.heightFraction[v]! > 0.8) d.mesh.positions[v * 3 + 2] = d.mesh.positions[v * 3 + 2]! + 0.15;
    const { conflict } = findConflict({ ...input, select: occlusalSelect(UP) }, 'insufficient reduction');
    expect(conflict?.kind).toBe('insufficient reduction');
    expect(conflict!.vertices).toBeGreaterThan(0);
    expect(conflict!.minClearanceMm).toBeLessThan(0.03);
    expect(conflict!.at[2]).toBeGreaterThan(R - 1);
  });
});

describe('contact adaptation against a vertical neighbour', () => {
  it('moves the proximal surface to the target gap (raise and reduce)', () => {
    for (const wall of [R + 0.3, R - 0.15]) {
      const d = dome();
      const target = plane([wall, 0, 0], [-1, 0, 0]);
      const before = d.mesh.positions.slice();
      const input = { positions: d.mesh.positions, normals: d.normals, shellStart: 0, shellGraph: d.graph, heightFraction: d.heightFraction, fixed: d.fixed, target, direction: X, targetMm: 0.02 };
      const report = adaptContacts(input);
      expect(report.movedVertices).toBeGreaterThan(5);
      expect(report.minClearanceMm).toBeGreaterThanOrEqual(0.02 - 0.02);
      if (wall > R) expect(report.minClearanceMm).toBeLessThan(0.02 + 0.03);
      const disp = displacementsAlong(before, d.mesh.positions, X);
      // The largest per-edge change sits where the selection (normal and height thresholds) ends: bounded relative to the move.
      expect(maxEdgeJump(disp, d.graph)).toBeLessThan(0.25 * report.maxMoveMm + 0.01);
      // Only the side facing the neighbour moves noticeably.
      for (let v = 0; v < d.fixed.length; v++) if (before[v * 3]! < -1) expect(Math.abs(disp[v]!)).toBeLessThan(0.02);
      const after = measureClearances({ ...input, select: proximalSelect(X) }, 3);
      for (const c of after) if (!Number.isNaN(c)) expect(c).toBeGreaterThanOrEqual(0);
    }
  });
});
