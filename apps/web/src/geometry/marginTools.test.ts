import { beforeAll, describe, expect, it } from 'vitest';
import { liveWireWeight } from './livewire';
import { addAnchor, marginReport, removeAnchor, rerunAutoMargin, retrace, type MarginScan } from './marginTools';
import { analyzeSurface } from './surface';
import { syntheticArch, syntheticPrepSeed } from './synthetic';
import { prepareMesh } from './testUtils';
import { estimateToothFrame } from './toothFrame';

describe('margin tools', () => {
  let scan: MarginScan;
  beforeAll(() => {
    const mesh = prepareMesh(syntheticArch({ jaw: 'lower', along: 600, across: 250, preps: [36] }));
    const { graph, curvature } = analyzeSurface({ positions: mesh.positions, indices: mesh.indices, normals: mesh.normals });
    const frame = estimateToothFrame({ jaw: mesh, seed: syntheticPrepSeed({ along: 600 }), fdi: 36, ray: mesh.ray, prep: true });
    scan = { positions: mesh.positions, indices: mesh.indices, ray: mesh.ray, graph, weight: liveWireWeight(curvature), frame };
  });

  it('edit a passing margin without breaking it, and name the side of a kink they cause', () => {
    const work = rerunAutoMargin(scan, { profiles: 16, ringFilter: true, smooth: false });
    expect(marginReport(scan, work).passes).toBe(true);
    // Dropping one anchor and adding one back on the finish line keeps a clean margin passing.
    const edited = addAnchor(scan, removeAnchor(scan, work, 3), 2);
    expect(marginReport(scan, edited).passes).toBe(true);
    // An anchor dragged 1.5 mm up the axial wall makes the line double back there: the report says where.
    const report = marginReport(scan, retrace(scan, { ...work, anchors: work.anchors.map((a, i) => (i === 5 ? ([a[0], a[1], a[2] + 1.5] as typeof a) : a)) }));
    expect(report.passes).toBe(false);
    expect(report.kinks.some((k) => k.nearestAnchor === 5 || report.anchors[k.nearestAnchor]?.side === report.anchors[5]!.side)).toBe(true);
  });
});
