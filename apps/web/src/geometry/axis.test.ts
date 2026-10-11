import { describe, expect, it } from 'vitest';
import { marginUndercut, searchInsertionAxis, undercutDepths } from './axis';
import { liveWireWeight, marginFromAnchors } from './livewire';
import type { V3 } from './pca';
import { prepRegion, prepSeedVertex } from './prepRegion';
import { analyzeSurface, buildVertexAdjacency } from './surface';
import { syntheticArch, syntheticPrepMargin, syntheticPrepSeed } from './synthetic';
import { prepareMesh, revolutionMesh } from './testUtils';

const angleDeg = (a: V3, b: V3) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;

/** Stump on a ground plane; returns prepared mesh + prep masks (rings up to the margin ring). */
function stump(profile: Array<[number, number]>, marginRing: number, tiltDeg = 0) {
  const { mesh, ringOf } = revolutionMesh(profile, 96);
  if (tiltDeg) {
    const t = (tiltDeg * Math.PI) / 180;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i + 1]!, z = mesh.positions[i + 2]!;
      mesh.positions[i + 1] = y * Math.cos(t) - z * Math.sin(t);
      mesh.positions[i + 2] = y * Math.sin(t) + z * Math.cos(t);
    }
  }
  const prepared = prepareMesh(mesh);
  const graph = buildVertexAdjacency(prepared.indices, ringOf.length);
  const loop = [...ringOf.keys()].filter((v) => ringOf[v] === marginRing);
  const region = prepRegion({ positions: prepared.positions, indices: prepared.indices, graph, loopVertices: loop, seedVertex: 0 });
  const points = new Float32Array(loop.flatMap((v) => [...prepared.positions.subarray(v * 3, v * 3 + 3)]));
  return { prepared, region, points };
}

describe('prep region and insertion axis', () => {
  it('finds a closed prep region and a near-occlusal axis on the synthetic prep', () => {
    const along = 400;
    const prepared = prepareMesh(syntheticArch({ jaw: 'lower', along, across: 120 }));
    const analysis = analyzeSurface(prepared);
    const ring = syntheticPrepMargin({ along, samples: 64 });
    const anchors: V3[] = [0, 9, 18, 27, 36, 45, 54].map((i) => [ring[i * 3]!, ring[i * 3 + 1]!, ring[i * 3 + 2]!]);
    const trace = marginFromAnchors({ ...prepared, graph: analysis.graph, weight: liveWireWeight(analysis.curvature), anchors });
    const occlusal: V3 = [0, 0, 1];
    const seed = prepSeedVertex({ ...prepared, loopVertices: trace.loopVertices, occlusal })!;
    expect(seed).not.toBeNull();
    const region = prepRegion({ ...prepared, graph: analysis.graph, loopVertices: trace.loopVertices, seedVertex: seed });
    expect(region.closed).toBe(true);
    // The prep top (seed of the frame) is inside; a point well outside the ring is not.
    const top = syntheticPrepSeed({ along });
    const inside = prepared.ray.closestPoint(top)!;
    expect(region.vertexMask[prepared.indices[inside.faceIndex * 3]!]).toBe(1);
    expect(region.faceCount).toBeGreaterThan(1000);
    // A margin with a gap leaks onto the jaw.
    const open = trace.loopVertices.slice(0, trace.loopVertices.length - 20);
    expect(prepRegion({ ...prepared, graph: analysis.graph, loopVertices: open, seedVertex: seed }).closed).toBe(false);

    const t0 = performance.now();
    const axis = searchInsertionAxis({ ...prepared, faceMask: region.faceMask, center: occlusal });
    const tAxis = performance.now() - t0;
    expect(angleDeg(axis.direction, occlusal)).toBeLessThan(5);
    const t1 = performance.now();
    const depths = undercutDepths({ ...prepared, vertexMask: region.vertexMask, faceMask: region.faceMask, axis: axis.direction });
    const tMap = performance.now() - t1;
    let maxDepth = 0;
    let nan = 0;
    for (const d of depths) {
      if (Number.isNaN(d)) nan++;
      else maxDepth = Math.max(maxDepth, d);
    }
    expect(nan).toBe(depths.length - region.vertexCount);
    expect(maxDepth).toBeLessThan(0.05);
    expect(marginUndercut({ points: trace.points, axis: axis.direction, ray: prepared.ray, faceMask: region.faceMask }).count).toBe(0);
    console.info(`[axis] ${region.faceCount} prep faces: search ${tAxis.toFixed(0)} ms, undercut map ${tMap.toFixed(0)} ms, angle ${axis.angleFromCenterDeg.toFixed(2)}°`);
  });

  it('reports undercut and a margin in undercut for a bulbous prep', () => {
    const profile: Array<[number, number]> = [
      [0, 4], [1, 4], [2, 3.9], [2.6, 3.2], [3.0, 2.2], [3.1, 1.4], [2.9, 0.8], [2.6, 0.5], // margin ring 7
      [3.2, 0], [5, 0], [8, 0],
    ];
    const { prepared, region, points } = stump(profile, 7);
    expect(region.closed).toBe(true);
    const axis = searchInsertionAxis({ ...prepared, faceMask: region.faceMask, center: [0, 0, 1] });
    expect(axis.centerUndercutAreaMm2).toBeGreaterThan(1);
    expect(axis.undercutAreaMm2).toBeGreaterThan(0); // no direction removes a bulge on all sides
    const margin = marginUndercut({ points, axis: [0, 0, 1], ray: prepared.ray, faceMask: region.faceMask });
    expect(margin.count).toBe(points.length / 3);
    const depths = undercutDepths({ ...prepared, vertexMask: region.vertexMask, faceMask: region.faceMask, axis: [0, 0, 1] });
    expect(Math.max(...[...depths].filter((d) => !Number.isNaN(d)))).toBeGreaterThan(2);
  });

  it('tilts the axis toward a tilted tapered prep, stopping at the first undercut-free direction', () => {
    // 12° taper, stump tilted 20° about x → the zero-undercut cone starts 8° from +z.
    const taper = Math.tan((12 * Math.PI) / 180);
    const profile: Array<[number, number]> = [
      [0, 4], [1.5, 4], [2.0, 3.8], [2.0 + 2.8 * taper, 1.0], [2.0 + 3.2 * taper, 0.6], // margin ring 4
      [3.5, 0], [6, 0], [9, 0],
    ];
    const { prepared, region } = stump(profile, 4, 20);
    const axis = searchInsertionAxis({ ...prepared, faceMask: region.faceMask, center: [0, 0, 1] });
    expect(axis.centerUndercutAreaMm2).toBeGreaterThan(0.5);
    expect(axis.undercutAreaMm2).toBeLessThan(0.05 * axis.centerUndercutAreaMm2);
    expect(axis.angleFromCenterDeg).toBeGreaterThan(6);
    expect(axis.angleFromCenterDeg).toBeLessThan(12);
    // It tilts the same way as the stump (toward −y for a rotation about +x).
    expect(axis.direction[1]).toBeLessThan(0);
  });
});
