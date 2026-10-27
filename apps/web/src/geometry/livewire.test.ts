import { describe, expect, it } from 'vitest';
import { type EdgeWeight, liveWireWeight, marginFromAnchors, polylineLength } from './livewire';
import { sharpestTurnDeg } from './marginShape';
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
    const traceWith = (weight: EdgeWeight, anchorCount = 7, anchors = anchorsOnRing(anchorCount), snap = false) =>
      marginFromAnchors({
        positions: prepared.positions,
        indices: prepared.indices,
        graph: analysis.graph,
        weight,
        ray: prepared.ray,
        anchors,
        ...(snap ? { ridge: { curvature: analysis.curvature, line: 'finish' as const } } : {}),
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

    // A click 0.15 mm down the chamfer (specs/2026-10-27-margin-click-snap.md): snapped back onto the ridge it traces
    // as a click on the ridge does; kept where it landed, the line bends down to it.
    const weight = liveWireWeight(analysis.curvature);
    const off = anchorsOnRing(7).map((a, k): V3 => (k === 3 ? [a[0], a[1], a[2] - 0.15] : a));
    const turn = (t: ReturnType<typeof traceWith>) => sharpestTurnDeg(Array.from({ length: t.points.length / 3 }, (_, i): V3 => [t.points[i * 3]!, t.points[i * 3 + 1]!, t.points[i * 3 + 2]!]));
    const anchorToRing = (t: ReturnType<typeof traceWith>) => distanceToClosedPolyline([t.anchorPoints![9]!, t.anchorPoints![10]!, t.anchorPoints![11]!], ring);
    const kept = traceWith(weight, 7, off);
    const snapped = traceWith(weight, 7, off, true);
    expect(anchorToRing(kept)).toBeGreaterThan(0.15);
    expect(anchorToRing(snapped)).toBeLessThan(0.1);
    expect(turn(snapped)).toBeLessThan(turn(kept) - 5);
    expect(Math.abs(turn(snapped) - turn(traceWith(weight, 7, anchorsOnRing(7), true)))).toBeLessThan(1);
  });
});
