import { describe, expect, it } from 'vitest';
import { type EdgeWeight, liveWireWeight, marginFromAnchors, polylineLength } from './livewire';
import type { V3 } from './pca';
import { analyzeSurface } from './surface';
import { syntheticArch, syntheticPrepMargin } from './synthetic';
import { distanceToClosedPolyline, prepareMesh } from './testUtils';

const ALONG = 600;
const ACROSS = 160;

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
    const { mean, max } = deviation(trace.points);
    expect(mean).toBeLessThan(0.15);
    expect(max).toBeLessThan(0.5);
    expect(Math.abs(trace.lengthMm - polylineLength(ring)) / polylineLength(ring)).toBeLessThan(0.1);
    // With only 4 anchors, plain geodesics cut across the ledge; the curvature term is what keeps the ridge.
    const sparse = deviation(traceWith(liveWireWeight(analysis.curvature), 4).points);
    const geodesic = deviation(traceWith((_u, _v, l) => l, 4).points);
    expect(sparse.mean).toBeLessThan(0.15);
    expect(geodesic.mean).toBeGreaterThan(2 * sparse.mean);
  });
});
