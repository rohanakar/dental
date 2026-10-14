import { describe, expect, it } from 'vitest';
import { proposeMarginAnchors } from './autoMargin';
import { liveWireWeight, marginFromAnchors } from './livewire';
import type { IndexedMesh } from './mesh';
import type { V3 } from './pca';
import { analyzeSurface } from './surface';
import { syntheticArch, syntheticPrepMargin, syntheticPrepSeed } from './synthetic';
import { distanceToClosedPolyline, prepareMesh } from './testUtils';
import { estimateToothFrame } from './toothFrame';

const ALONG = 400;
const ACROSS = 160;

/** Mirror a mesh in x (and flip winding so normals stay outward): turns the 36 prep into a 46 prep. */
function mirrorX(mesh: IndexedMesh): IndexedMesh {
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i += 3) positions[i] = -positions[i]!;
  const indices = mesh.indices.slice();
  for (let f = 0; f < indices.length; f += 3) [indices[f + 1], indices[f + 2]] = [indices[f + 2]!, indices[f + 1]!];
  return { positions, indices };
}

// The pipeline runner test covers 36; this one covers the mirrored quadrant.
describe('automatic margin on the synthetic prep: 46 (mirrored)', () => {
  it('finds the margin ridge within 0.15 mm (mean) of the analytic margin', () => {
    const jaw = prepareMesh(mirrorX(syntheticArch({ jaw: 'lower', along: ALONG, across: ACROSS })));
    const antagonist = prepareMesh(mirrorX(syntheticArch({ jaw: 'upper', along: ALONG, across: ACROSS })));
    const surface = analyzeSurface(jaw);
    const seed: V3 = syntheticPrepSeed({ along: ALONG });
    const frame = estimateToothFrame({ jaw, antagonist, seed: [-seed[0], seed[1], seed[2]], fdi: 46, ray: jaw.ray });

    const proposal = proposeMarginAnchors({ positions: jaw.positions, indices: jaw.indices, ray: jaw.ray, frame });
    expect(proposal.confidence).toBe(1);

    const trace = marginFromAnchors({
      positions: jaw.positions,
      indices: jaw.indices,
      graph: surface.graph,
      weight: liveWireWeight(surface.curvature),
      ray: jaw.ray,
      anchors: proposal.anchors,
    });
    const ring = syntheticPrepMargin({ along: ALONG, samples: 720 });
    for (let i = 0; i < ring.length; i += 3) ring[i] = -ring[i]!;
    let sum = 0, max = 0;
    const n = trace.points.length / 3;
    for (let i = 0; i < n; i++) {
      const d = distanceToClosedPolyline([trace.points[i * 3]!, trace.points[i * 3 + 1]!, trace.points[i * 3 + 2]!], ring);
      sum += d;
      max = Math.max(max, d);
    }
    expect(sum / n).toBeLessThan(0.15);
    expect(max).toBeLessThan(0.5);
    expect(trace.lengthMm).toBeGreaterThan(20);
  });
});
