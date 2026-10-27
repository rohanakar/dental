import { beforeAll, describe, expect, it } from 'vitest';
import { gumLineGate, passed } from '../ai/qa';
import { dijkstraTree, liveWireWeight, pathFromTree, traceOpenPath } from './livewire';
import { DOUBT_OFF, marginDoubt } from './marginDoubt';
import { insertAnchor, offsetOnSurface, redrawSection, replaceArc } from './marginEdit';
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

  it('its doubt test leaves the found line clear, and points first at a section pushed up the tooth', () => {
    const points = line36().points;
    const scan = { positions: mesh.positions, indices: mesh.indices, normals: mesh.normals, ray: mesh.ray, up: frameOf(36, syntheticPrepSeed({ fdi: 36, along: ALONG })).occlusal };
    const offShare = (levels: Uint8Array, from: number, to: number) => levels.slice(from, to).filter((l) => l === DOUBT_OFF).length / Math.max(1, to - from);
    const clean = marginDoubt({ ...scan, points, line: 'gum' });
    expect(offShare(clean.levels, 0, points.length)).toBeLessThan(0.05);
    const n = points.length;
    const [i0, i1] = [Math.floor(0.4 * n), Math.floor(0.6 * n)];
    const pushed = points.map((p, i): V3 => {
      if (i < i0 || i > i1) return p;
      const hit = mesh.ray.closestPoint([p[0], p[1], p[2] + 1], 2);
      return hit ? [hit.point[0], hit.point[1], hit.point[2]] : p;
    });
    const d = marginDoubt({ ...scan, points: pushed, line: 'gum' });
    expect(offShare(d.levels, i0, i1)).toBeGreaterThan(0.6);
    // The first stop of "Next doubtful part" is in the pushed section.
    const middle = pushed[Math.floor((i0 + i1) / 2)]!;
    expect(Math.hypot(d.parts[0]!.at[0] - middle[0], d.parts[0]!.at[1] - middle[1], d.parts[0]!.at[2] - middle[2])).toBeLessThan(3);
  });

  it('edits: an added point leaves the line as it is, a dragged one changes it only between its neighbours, Raise moves it up the tooth', () => {
    const points = line36().points;
    const anchors = anchorsAlong(points);
    expect(insertAnchor({ anchors, points }, points[Math.floor(0.37 * points.length)]!)).toHaveLength(anchors.length + 1);
    // Drag anchor 3 up 0.8 mm: the gum live-wire through its neighbours and the moved point, spliced in.
    const k = 3;
    const moved = mesh.ray.closestPoint([anchors[k]![0], anchors[k]![1], anchors[k]![2] + 0.8], 2)!.point;
    const waypoints: V3[] = [anchors[k - 1]!, [moved[0], moved[1], moved[2]], anchors[k + 1]!];
    const path = traceOpenPath(mesh.positions, surface.graph, liveWireWeight(surface.curvature, 1, 'gum'), waypoints.map(nearestVertex)).map(at);
    const edited = replaceArc(points, anchors[k - 1]!, anchors[k + 1]!, anchors[k]!, path);
    const kept = new Set(edited.map((p) => p.join()));
    const index = (p: V3) => points.findIndex((q) => q === p);
    const [lo, hi] = [index(anchors[k - 1]!), index(anchors[k + 1]!)];
    expect(points.filter((_, i) => i < lo || i > hi).every((p) => kept.has(p.join()))).toBe(true);
    // Raise 0.3 mm: up the tooth along the scan.
    const frame = frameOf(36, syntheticPrepSeed({ fdi: 36, along: ALONG }));
    const normalAt = (p: V3): V3 => {
      const v = nearestVertex(p);
      return [mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!];
    };
    const project = (p: V3): V3 => {
      const hit = mesh.ray.closestPoint(p, 2);
      return hit ? [hit.point[0], hit.point[1], hit.point[2]] : p;
    };
    const sample = points.filter((_, i) => i % 10 === 0);
    const raised = offsetOnSurface(sample, { project, normalAt }, { origin: frame.origin, up: frame.occlusal }, 0.3);
    const height = (p: V3) => p[0] * frame.occlusal[0] + p[1] * frame.occlusal[1] + p[2] * frame.occlusal[2];
    const rise = raised.reduce((s, p, i) => s + height(p) - height(sample[i]!), 0) / sample.length;
    expect(rise).toBeGreaterThan(0.15);
  });

  it('marks on the gum just outside one stretch pull the gum line out there, and nowhere else', () => {
    const frame = frameOf(36, syntheticPrepSeed({ fdi: 36, along: ALONG }));
    const base = line36().points;
    const n = base.length;
    const [i0, i1] = [Math.floor(0.1 * n), Math.floor(0.2 * n)];
    // "Mark tooth" on the gum 0.8 mm outside the line along that stretch.
    const outward = (p: V3): V3 => {
      const r: V3 = [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]];
      const h = r[0] * frame.occlusal[0] + r[1] * frame.occlusal[1] + r[2] * frame.occlusal[2];
      const flat: V3 = [r[0] - h * frame.occlusal[0], r[1] - h * frame.occlusal[1], r[2] - h * frame.occlusal[2]];
      const len = Math.hypot(...flat);
      return [flat[0] / len, flat[1] / len, flat[2] / len];
    };
    const marks = base.slice(i0, i1).map((p): V3 => {
      const o = outward(p);
      const hit = mesh.ray.closestPoint([p[0] + 0.8 * o[0], p[1] + 0.8 * o[1], p[2] + 0.8 * o[2]], 2)!;
      return [hit.point[0], hit.point[1], hit.point[2]];
    });
    const marked = naturalMargin({ ...mesh, graph: surface.graph, curvature: surface.curvature, frame, fdi: 36, marks: { tooth: marks, gum: [] } }).points;
    const moved = (from: number, to: number) => meanDeviation(base.slice(from, to), marked);
    expect(moved(i0 + 5, i1 - 5)).toBeGreaterThan(0.4);
    expect(moved(Math.floor(0.45 * n), Math.floor(0.85 * n))).toBeLessThan(0.1);
  });
});
