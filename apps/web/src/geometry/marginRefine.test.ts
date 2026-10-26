import { beforeAll, describe, expect, it } from 'vitest';
import { proposeMarginAnchors } from './autoMargin';
import { liveWireWeight, marginFromAnchors } from './livewire';
import { refineMargin, type RefineInput } from './marginRefine';
import { marginShapePasses } from './marginShape';
import type { V3 } from './pca';
import { analyzeSurface } from './surface';
import { syntheticArch, syntheticPrepMargin, syntheticPrepSeed, withScanNoise } from './synthetic';
import { distanceToClosedPolyline, prepareMesh } from './testUtils';
import { estimateToothFrame } from './toothFrame';

// The demo's resolution: the noise level at which the plain profiles pick false edges depends on it.
const ALONG = 1000;

function refineInput(jaw: 'upper' | 'lower', fdi: number, preps: number[], noiseMm: number): RefineInput {
  const arch = syntheticArch({ jaw, along: ALONG, across: 500, preps });
  // The noise seed of the evaluation harness's case (tools/pipeline-runner/src/marginEval.ts), where the plain margin fails.
  const mesh = prepareMesh(noiseMm ? withScanNoise(arch, noiseMm, fdi * 1000 + Math.round(noiseMm * 1000)) : arch);
  const { graph, curvature } = analyzeSurface({ positions: mesh.positions, indices: mesh.indices, normals: mesh.normals });
  const frame = estimateToothFrame({ jaw: mesh, seed: syntheticPrepSeed({ fdi, along: ALONG }), fdi, ray: mesh.ray, prep: true });
  return { positions: mesh.positions, indices: mesh.indices, ray: mesh.ray, graph, weight: liveWireWeight(curvature), frame };
}

const points = (flat: Float32Array): V3[] => Array.from({ length: flat.length / 3 }, (_, i) => [flat[i * 3]!, flat[i * 3 + 1]!, flat[i * 3 + 2]!]);

describe('margin refiner', () => {
  let noisyPrep: RefineInput;
  let naturalTooth: RefineInput;
  beforeAll(() => {
    // 45 prepared, on a scan with 0.05 mm of noise; and upper 11 with no prep at all.
    noisyPrep = refineInput('lower', 45, [45], 0.05);
    naturalTooth = refineInput('upper', 11, [], 0);
  });

  it('repairs a noisy prep the plain automatic margin fails on, and passes no natural tooth', () => {
    const plain = proposeMarginAnchors({ ...noisyPrep, count: 16 });
    const plainTrace = marginFromAnchors({ ...noisyPrep, anchors: plain.anchors });
    expect(marginShapePasses(points(plainTrace.points), plainTrace.lengthMm)).toBe(false);

    const refined = refineMargin(noisyPrep)!;
    expect(refined.passes).toBe(true);
    const truth = syntheticPrepMargin({ fdi: 45, along: ALONG, samples: 256 });
    const off = points(refined.points).map((p) => distanceToClosedPolyline(p, truth));
    expect(off.reduce((a, b) => a + b, 0) / off.length).toBeLessThan(0.15);

    expect(refineMargin(naturalTooth)?.passes ?? false).toBe(false);
  });
});
