import { describe, expect, it } from 'vitest';
import { proposeMarginAnchors } from './autoMargin';
import { liveWireWeight, marginFromAnchors } from './livewire';
import type { IndexedMesh } from './mesh';
import type { V3 } from './pca';
import { analyzeSurface } from './surface';
import { syntheticArch, syntheticPrepMargin, syntheticPrepSeed } from './synthetic';
import { distanceToClosedPolyline, prepareMesh } from './testUtils';
import { estimateToothFrame } from './toothFrame';

const ACROSS = 160;

/** Mirror a mesh in x (and flip winding so normals stay outward): turns the 36 prep into a 46 prep. */
function mirrorX(mesh: IndexedMesh): IndexedMesh {
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i += 3) positions[i] = -positions[i]!;
  const indices = mesh.indices.slice();
  for (let f = 0; f < indices.length; f += 3) [indices[f + 1], indices[f + 2]] = [indices[f + 2]!, indices[f + 1]!];
  return { positions, indices };
}

// Two resolutions: at along=600 an early version picked the interdental gum on a diagonal profile.
describe.each([
  ['36, along 400', false, 400],
  ['46 (mirrored), along 400', true, 400],
  ['36, along 600', false, 600],
])('automatic margin on the synthetic prep: %s', (_name, mirror, ALONG) => {
  it('finds the margin ridge within 0.15 mm (mean) of the analytic margin', () => {
    const flip = (p: V3): V3 => (mirror ? [-p[0], p[1], p[2]] : p);
    const mesh = syntheticArch({ jaw: 'lower', along: ALONG, across: ACROSS });
    const upper = syntheticArch({ jaw: 'upper', along: ALONG, across: ACROSS });
    const jaw = prepareMesh(mirror ? mirrorX(mesh) : mesh);
    const antagonist = prepareMesh(mirror ? mirrorX(upper) : upper);
    const surface = analyzeSurface(jaw);
    const frame = estimateToothFrame({ jaw, antagonist, seed: flip(syntheticPrepSeed({ along: ALONG })), fdi: mirror ? 46 : 36, ray: jaw.ray });

    const t0 = performance.now();
    const proposal = proposeMarginAnchors({ positions: jaw.positions, indices: jaw.indices, ray: jaw.ray, frame });
    const tAnchors = performance.now() - t0;
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
    if (mirror) for (let i = 0; i < ring.length; i += 3) ring[i] = -ring[i]!;
    let sum = 0, max = 0;
    const n = trace.points.length / 3;
    for (let i = 0; i < n; i++) {
      const d = distanceToClosedPolyline([trace.points[i * 3]!, trace.points[i * 3 + 1]!, trace.points[i * 3 + 2]!], ring);
      sum += d;
      max = Math.max(max, d);
    }
    const mean = sum / n;
    expect({ mean: mean < 0.15, max: max < 0.5 }).toEqual({ mean: true, max: true });
    expect(trace.lengthMm).toBeGreaterThan(20);
    expect(tAnchors).toBeLessThan(2000);
  });
});
