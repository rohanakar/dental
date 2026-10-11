import { describe, expect, it } from 'vitest';
import {
  dijkstraTree,
  type EdgeWeight,
  liveWireWeight,
  marginFromAnchors,
  pathFromTree,
  polylineLength,
  resampleClosedPolyline,
  smoothClosedPolyline,
} from './livewire';
import type { V3 } from './pca';
import { analyzeSurface, buildVertexAdjacency } from './surface';
import { syntheticArch, syntheticPrepMargin } from './synthetic';
import { grid } from './testMeshes';
import { distanceToClosedPolyline, prepareMesh } from './testUtils';

const ALONG = 600;
const ACROSS = 160;

describe('dijkstra', () => {
  it('returns a continuous edge path on a grid', () => {
    const mesh = grid(20, 10);
    const graph = buildVertexAdjacency(mesh.indices, mesh.positions.length / 3);
    const tree = dijkstraTree(mesh.positions, graph, (_u, _v, l) => l, 0, 100);
    const target = 21 * 21 - 1;
    const path = pathFromTree(tree.pred, target)!;
    expect(path[0]).toBe(0);
    expect(path[path.length - 1]).toBe(target);
    for (let i = 1; i < path.length; i++) {
      const ring = [...graph.neighbors.subarray(graph.offsets[path[i - 1]!]!, graph.offsets[path[i - 1]! + 1]!)];
      expect(ring).toContain(path[i]);
    }
    // Diagonal edges exist in this triangulation, so the corner-to-corner path is the straight diagonal.
    expect(tree.dist[target]).toBeCloseTo(Math.SQRT2 * 10, 3);
  });

  it('respects the radius bound', () => {
    const mesh = grid(20, 10);
    const graph = buildVertexAdjacency(mesh.indices, mesh.positions.length / 3);
    const tree = dijkstraTree(mesh.positions, graph, (_u, _v, l) => l, 0, 3);
    expect(pathFromTree(tree.pred, 21 * 21 - 1)).toBeNull();
    expect(pathFromTree(tree.pred, 0)).toEqual([0]);
  });
});

describe('polylines', () => {
  it('resamples a closed square uniformly and smooths it inward', () => {
    const square = new Float32Array([0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0]);
    expect(polylineLength(square)).toBeCloseTo(16);
    const dense = resampleClosedPolyline(square, 0.5);
    expect(dense.length / 3).toBe(32);
    expect(polylineLength(dense)).toBeCloseTo(16, 4);
    expect(polylineLength(smoothClosedPolyline(dense, 5))).toBeLessThan(16);
  });
});

describe('live-wire margin on the synthetic prep', () => {
  it('follows the convex margin ridge from a few anchors', () => {
    const prepared = prepareMesh(syntheticArch({ jaw: 'lower', along: ALONG, across: ACROSS }));
    const analysis = analyzeSurface(prepared);
    const ring = syntheticPrepMargin({ along: ALONG, samples: 720 });
    const anchorsOnRing = (count: number): V3[] =>
      Array.from({ length: count }, (_, k) => {
        const i = Math.floor((k * 720) / count) + 13;
        return [ring[i * 3]!, ring[i * 3 + 1]!, ring[i * 3 + 2]!];
      });
    const traceWith = (weight: EdgeWeight, anchorCount = 7) =>
      marginFromAnchors({
        positions: prepared.positions,
        indices: prepared.indices,
        graph: analysis.graph,
        weight,
        ray: prepared.ray,
        anchors: anchorsOnRing(anchorCount),
      });
    const deviation = (points: Float32Array) => {
      let sum = 0;
      let max = 0;
      for (let i = 0; i < points.length / 3; i++) {
        const d = distanceToClosedPolyline([points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!], ring);
        sum += d;
        max = Math.max(max, d);
      }
      return { mean: (sum / points.length) * 3, max };
    };
    const trace = traceWith(liveWireWeight(analysis.curvature));
    const n = trace.points.length / 3;
    const { mean, max } = deviation(trace.points);
    // With only 4 anchors, plain geodesics cut across the ledge; the curvature term is what keeps the ridge.
    const sparse = deviation(traceWith(liveWireWeight(analysis.curvature), 4).points);
    const geodesic = deviation(traceWith((_u, _v, l) => l, 4).points);
    expect(sparse.mean).toBeLessThan(0.15);
    expect(geodesic.mean).toBeGreaterThan(2 * sparse.mean);
    console.info(`[livewire] ${n} points, length ${trace.lengthMm.toFixed(2)} mm (ring ${polylineLength(ring).toFixed(2)}), mean dev ${mean.toFixed(3)} mm, max ${max.toFixed(3)} mm 4 anchors: ${sparse.mean.toFixed(3)} (plain geodesic ${geodesic.mean.toFixed(3)})`);
    expect(mean).toBeLessThan(0.15);
    expect(max).toBeLessThan(0.5);
    expect(Math.abs(trace.lengthMm - polylineLength(ring)) / polylineLength(ring)).toBeLessThan(0.1);
  });
});
