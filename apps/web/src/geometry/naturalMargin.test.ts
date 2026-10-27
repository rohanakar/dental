import { beforeAll, describe, expect, it } from 'vitest';
import { gumLineGate, passed } from '../ai/qa';
import { dijkstraTree, liveWireWeight, pathFromTree } from './livewire';
import { redrawSection } from './marginEdit';
import { anchorsAlong, naturalMargin } from './naturalMargin';
import type { V3 } from './pca';
import { analyzeSurface, type SurfaceAnalysis } from './surface';
import { syntheticArch, syntheticPrepSeed } from './synthetic';
import { prepareMesh, type PreparedMesh } from './testUtils';
import { estimateToothFrame } from './toothFrame';

/** Mean distance from each point of `line` to the nearest point of `truth`. */
const meanDeviation = (line: V3[], truth: V3[]) =>
  line.reduce((sum, p) => sum + Math.sqrt(Math.min(...truth.map((q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2))), 0) / line.length;

describe('natural-tooth margin (the gum line)', () => {
  let mesh: PreparedMesh;
  let surface: SurfaceAnalysis;
  let truth: V3[];
  const ALONG = 600;
  const frameOf = (fdi: number, seed: V3) => {
    const est = estimateToothFrame({ jaw: mesh, seed, fdi, ray: mesh.ray });
    return { origin: est.origin, occlusal: est.occlusal, mesial: est.mesial, buccal: est.buccal };
  };
  const nearestVertex = (p: V3) => {
    let best = 0, bd = Infinity;
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const d = (mesh.positions[v * 3]! - p[0]) ** 2 + (mesh.positions[v * 3 + 1]! - p[1]) ** 2 + (mesh.positions[v * 3 + 2]! - p[2]) ** 2;
      if (d < bd) [bd, best] = [d, v];
    }
    return best;
  };
  const at = (v: number): V3 => [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];

  beforeAll(() => {
    // A lower arch of natural teeth with gum over the tooth bases and papillae between them; 46 is missing.
    const arch = syntheticArch({ jaw: 'lower', along: ALONG, across: 250, preps: [], missing: [46], gingiva: { coverMm: 0.6, papillaMm: 1.8 }, labels: true });
    mesh = prepareMesh(arch);
    surface = analyzeSurface({ positions: mesh.positions, indices: mesh.indices, normals: mesh.normals });
    // The labelled gum line of 36: the gum-side vertex of every edge between 36 and anything else.
    const labels = arch.labels!;
    const gumSide = new Set<number>();
    for (let f = 0; f < mesh.indices.length; f += 3) {
      for (let e = 0; e < 3; e++) {
        const a = mesh.indices[f + e]!, b = mesh.indices[f + ((e + 1) % 3)]!;
        if ((labels[a] === 36) !== (labels[b] === 36)) gumSide.add(labels[a] === 36 ? b : a);
      }
    }
    truth = [...gumSide].map(at);
  });

  const line36 = () => naturalMargin({ ...mesh, graph: surface.graph, curvature: surface.curvature, frame: frameOf(36, syntheticPrepSeed({ fdi: 36, along: ALONG })), fdi: 36 });

  it('finds the gum line of a natural tooth, and its gate flags a click on a missing tooth', () => {
    const r = line36();
    expect(meanDeviation(r.points, truth)).toBeLessThan(0.15);
    expect(passed(gumLineGate(r))).toBe(true);
    // On the bare ridge where 46 is missing there is no tooth to go round: the line is doubtful.
    const ridge = naturalMargin({ ...mesh, graph: surface.graph, curvature: surface.curvature, frame: frameOf(46, syntheticPrepSeed({ fdi: 46, along: ALONG })), fdi: 46 });
    expect(passed(gumLineGate(ridge))).toBe(false);
  });

  it('puts a section dragged off the gum line back with a two-click redraw along the gum live-wire', () => {
    const points = line36().points;
    const n = points.length;
    const [i0, i1] = [Math.floor(0.1 * n), Math.floor(0.25 * n)];
    // A section pushed 1.2 mm up the tooth, back onto the scan.
    const off = points.map((p, i): V3 => {
      if (i < i0 || i > i1) return p;
      const hit = mesh.ray.closestPoint([p[0], p[1], p[2] + 1.2], 2);
      return hit ? [hit.point[0], hit.point[1], hit.point[2]] : p;
    });
    expect(meanDeviation(off.slice(i0, i1), truth)).toBeGreaterThan(0.5);
    // Two clicks on the line either side of it; the live-wire between them, for a gum line and for a finish line.
    const from = nearestVertex(points[i0 - 3]!), to = nearestVertex(points[i1 + 3]!);
    const path = (line: 'finish' | 'gum') => pathFromTree(dijkstraTree(mesh.positions, surface.graph, liveWireWeight(surface.curvature, 1, line), from, 12).pred, to)!.map(at);
    const fixed = redrawSection({ anchors: anchorsAlong(off), points: off }, path('gum'));
    expect(meanDeviation(fixed.points, truth)).toBeLessThan(0.15);
    // The finish line's live-wire avoids the concave crease, so it does not follow the gum line there.
    expect(meanDeviation(path('finish'), truth)).toBeGreaterThan(meanDeviation(path('gum'), truth) + 0.1);
  });
});
