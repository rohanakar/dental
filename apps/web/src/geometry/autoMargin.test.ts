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

/**
 * A prep as real model scans show it (specs/2026-10-29-margin-on-real-preps.md), revolved about +z: a flat top, a
 * line angle, a 4.3 mm axial wall undercut by 2° (a height map cannot see it), a chamfer and its convex lip (the
 * margin: radius 3.35 mm, 5.2 mm below the top), then the root flaring out.
 */
function revolvedPrep(): IndexedMesh {
  const knots: Array<[number, number]> = [[0.05, 0], [2.4, 0], [2.8, -0.4], [2.65, -4.7], [3.35, -5.2], [4.45, -7], [4.85, -8]];
  const profile: Array<[number, number]> = [];
  for (let k = 0; k + 1 < knots.length; k++) {
    const [r0, z0] = knots[k]!, [r1, z1] = knots[k + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(r1 - r0, z1 - z0) / 0.05));
    for (let i = 0; i < n; i++) profile.push([r0 + ((r1 - r0) * i) / n, z0 + ((z1 - z0) * i) / n]);
  }
  profile.push(knots[knots.length - 1]!);
  const segments = 180;
  // Vertex 0 is the centre of the top; ring i (profile point i) starts at 1 + i * segments.
  const positions = new Float32Array((1 + profile.length * segments) * 3);
  profile.forEach(([r, z], i) => {
    for (let j = 0; j < segments; j++) positions.set([r * Math.cos((2 * Math.PI * j) / segments), r * Math.sin((2 * Math.PI * j) / segments), z], (1 + i * segments + j) * 3);
  });
  const indices: number[] = [];
  for (let j = 0; j < segments; j++) indices.push(0, 1 + j, 1 + ((j + 1) % segments));
  for (let i = 0; i + 1 < profile.length; i++) {
    for (let j = 0; j < segments; j++) {
      const a = 1 + i * segments + j, b = 1 + i * segments + ((j + 1) % segments), c = a + segments, d = b + segments;
      indices.push(a, c, b, b, c, d);
    }
  }
  return { positions, indices: Uint32Array.from(indices) };
}

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

  it('finds the margin below a tall undercut wall, at the lip of the chamfer', () => {
    const prep = prepareMesh(revolvedPrep());
    const frame = { origin: [0, 0, 0] as V3, occlusal: [0, 0, 1] as V3, mesial: [1, 0, 0] as V3 };
    const proposal = proposeMarginAnchors({ positions: prep.positions, indices: prep.indices, ray: prep.ray, frame, count: 24 });
    expect(proposal.confidence).toBe(1);
    for (const a of proposal.anchors) expect(Math.hypot(Math.hypot(a[0], a[1]) - 3.35, a[2] + 5.2)).toBeLessThan(0.1);
  });
});
