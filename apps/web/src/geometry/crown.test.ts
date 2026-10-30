import { MATERIAL_PRESETS } from '@dcad/shared';
import { describe, expect, it } from 'vitest';
import { designCrown, type CrownDesign, type CrownInput } from './crown';
import { templateForTooth } from './crownTemplate';
import { distanceToLoop, signedIntaglioDistance, thicknessProfile } from './thickness';
import { distanceFromMargin, measureIntaglioGap, planeBasis } from './intaglio';
import { marginFromAnchors, liveWireWeight } from './livewire';
import type { IndexedMesh } from './mesh';
import type { V3 } from './pca';
import { prepRegion, prepSeedVertex } from './prepRegion';
import { bvhRayCaster, createBvh } from './raycast';
import { analyzeSurface, smoothVertexNormals } from './surface';
import { syntheticArch, syntheticPrepMargin, syntheticPrepSeed } from './synthetic';
import { prepareMesh } from './testUtils';
import { estimateToothFrame } from './toothFrame';
import { directionVector, movePose } from '../design/clinical';
import { adaptGate, passed } from '../ai/qa';

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

function runSynthetic(mirror: boolean): { design: CrownDesign; axis: V3; input: CrownInput } {
  const flip = (p: V3): V3 => (mirror ? [-p[0], p[1], p[2]] : p);
  const lowerMesh = syntheticArch({ jaw: 'lower', along: ALONG, across: ACROSS });
  const upperMesh = syntheticArch({ jaw: 'upper', along: ALONG, across: ACROSS });
  const lower = prepareMesh(mirror ? mirrorX(lowerMesh) : lowerMesh);
  const upper = prepareMesh(mirror ? mirrorX(upperMesh) : upperMesh);
  const fdi = mirror ? 46 : 36;
  const surface = analyzeSurface(lower);
  const frame = estimateToothFrame({ jaw: lower, antagonist: upper, seed: flip(syntheticPrepSeed({ along: ALONG })), fdi, ray: lower.ray });
  const ring = syntheticPrepMargin({ along: ALONG, samples: 8 });
  const anchors: V3[] = [];
  for (let i = 0; i < ring.length; i += 3) anchors.push(flip([ring[i]!, ring[i + 1]!, ring[i + 2]!]));
  const trace = marginFromAnchors({
    positions: lower.positions,
    indices: lower.indices,
    graph: surface.graph,
    weight: liveWireWeight(surface.curvature),
    ray: lower.ray,
    anchors,
  });
  const seedVertex = prepSeedVertex({ positions: lower.positions, indices: lower.indices, ray: lower.ray, loopVertices: trace.loopVertices, occlusal: frame.occlusal })!;
  const region = prepRegion({ positions: lower.positions, indices: lower.indices, graph: surface.graph, loopVertices: trace.loopVertices, seedVertex });
  expect(region.closed).toBe(true);
  const input: CrownInput = {
    fdi,
    jaw: { positions: lower.positions, indices: lower.indices, graph: surface.graph, smoothNormals: smoothVertexNormals(lower.normals, surface.graph, 3), ray: lower.ray },
    antagonist: upper.ray,
    region: { ...region, loopVertices: trace.loopVertices },
    frame,
    margin: trace.points,
    axis: frame.occlusal,
    params: MATERIAL_PRESETS.zirconia,
  };
  return { design: designCrown(input), axis: frame.occlusal, input };
}

/** Triangles whose corners are all intaglio vertices (they come first in the crown mesh). */
function intaglioPart(design: CrownDesign): IndexedMesh {
  const tris: number[] = [];
  const idx = design.mesh.indices;
  for (let f = 0; f < idx.length; f += 3) {
    if (idx[f]! < design.intaglioVertices && idx[f + 1]! < design.intaglioVertices && idx[f + 2]! < design.intaglioVertices) {
      tris.push(idx[f]!, idx[f + 1]!, idx[f + 2]!);
    }
  }
  return { positions: design.mesh.positions.slice(0, design.intaglioVertices * 3), indices: Uint32Array.from(tris) };
}

describe.each([
  ['36 (right-handed frame)', false],
  ['46 (mirrored, left-handed frame)', true],
])('crown on the synthetic prep: %s', (_name, mirror) => {
  const { design, axis, input } = runSynthetic(mirror);
  const template = templateForTooth(input.fdi);
  const T = template.cervicalLoop.length;
  const pt = (m: IndexedMesh, v: number): V3 => [m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]!];

  /** Every outer-shell vertex (except the pinned ring) meets the thickness profile within 0.02 mm. */
  const expectThickness = (d: CrownDesign) => {
    const inner = intaglioPart(d);
    const indices = inner.indices.slice();
    const surface = { ray: bvhRayCaster(createBvh({ positions: inner.positions, indices })), positions: inner.positions, indices };
    const loop = new Float32Array(T * 3);
    template.cervicalLoop.forEach((v, i) => loop.set(pt(d.mesh, d.shellStart + v), i * 3));
    const ring = new Set(Array.from(template.cervicalLoop, (v) => d.shellStart + v));
    let worst = Infinity;
    for (let v = d.shellStart; v < d.mesh.positions.length / 3; v++) {
      if (ring.has(v)) continue;
      const p = pt(d.mesh, v);
      const s = signedIntaglioDistance(p, surface, 5);
      if (s) worst = Math.min(worst, s.distance - thicknessProfile(distanceToLoop(p, loop), input.params));
    }
    expect(worst).toBeGreaterThan(-0.02);
  };

  it('is a closed, printable solid', () => {
    expect(design.validation).toMatchObject({
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      inconsistentEdges: 0,
      degenerateTriangles: 0,
      closed: true,
      oriented: true,
      ok: true,
      selfIntersections: 0,
      printable: true,
    });
    expect(design.validation.signedVolumeMm3).toBeGreaterThan(50);
    expect(design.pose.scale[0] < 0).toBe(mirror); // quadrant 4 frames are left-handed → mirrored template

    // A margin a drag doubled back on (specs/2026-10-30-crown-rim-guard.md): a 1 mm spike out and back along the scan.
    // The crown leaves the spike out and stays printable.
    if (!mirror) {
      const pts = Array.from({ length: input.margin.length / 3 }, (_, i): V3 => [input.margin[i * 3]!, input.margin[i * 3 + 1]!, input.margin[i * 3 + 2]!]);
      const k = Math.floor(pts.length / 3);
      const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length] as V3, [0, 0, 0] as V3);
      const out = (t: number): V3 => {
        const p = pts[k]!, d = [p[0] - c[0], p[1] - c[1], 0], l = Math.hypot(d[0]!, d[1]!);
        const q: V3 = [p[0] + (d[0]! / l) * t, p[1] + (d[1]! / l) * t, p[2]];
        return input.jaw.ray.closestPoint(q, 2)!.point as V3;
      };
      const spike = [0.2, 0.4, 0.6, 0.8, 1, 0.8, 0.6, 0.4, 0.2].map(out);
      const spiked = [...pts.slice(0, k + 1), ...spike, ...pts.slice(k)];
      const kinked = designCrown({ ...input, margin: new Float32Array(spiked.flat()) });
      expect(kinked.validation.printable).toBe(true);
    }
  });

  it('seats on the prep: ring on the margin, intended cement gap, no undercut in the intaglio', () => {
    // Each ring vertex sits exactly `band` from its paired rim (margin) vertex, and every rim vertex has its ring
    // vertex; nearest-point distances can be smaller where rim samples bunch up, so check the pairing both ways.
    const band = input.params.marginThicknessMm;
    const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const rimPts = Array.from({ length: T }, (_, i) => pt(design.mesh, i));
    const ringPts = Array.from(template.cervicalLoop, (v) => pt(design.mesh, design.shellStart + v));
    for (const r of ringPts) expect(rimPts.some((m) => Math.abs(dist(r, m) - band) < 1e-4)).toBe(true);
    for (const m of rimPts) expect(ringPts.some((r) => Math.abs(dist(r, m) - band) < 1e-4)).toBe(true);

    expect(design.gapCheck.samples).toBeGreaterThan(50);
    expect(design.gapCheck.maxErrorMm).toBeLessThan(0.01);

    // One hit per ray along the axis, over a disc well inside the margin (~4 mm from the centre).
    const inner = intaglioPart(design);
    const ray = bvhRayCaster(createBvh({ positions: inner.positions, indices: inner.indices.slice() }));
    const [u, v] = planeBasis(axis);
    const n = design.intaglioVertices;
    let cu = 0, cv = 0;
    for (let i = 0; i < n; i++) {
      cu += (inner.positions[i * 3]! * u[0] + inner.positions[i * 3 + 1]! * u[1] + inner.positions[i * 3 + 2]! * u[2]) / n;
      cv += (inner.positions[i * 3]! * v[0] + inner.positions[i * 3 + 1]! * v[1] + inner.positions[i * 3 + 2]! * v[2]) / n;
    }
    let rays = 0;
    for (let a = -3; a <= 3; a += 0.25) {
      for (let b = -3; b <= 3; b += 0.25) {
        if (a * a + b * b > 9) continue;
        const o: V3 = [0, 1, 2].map((k) => (cu + a) * u[k]! + (cv + b) * v[k]! + 60 * axis[k]!) as V3;
        expect(ray.all(o, [-axis[0], -axis[1], -axis[2]], 120).length).toBe(1);
        rays++;
      }
    }
    expect(rays).toBeGreaterThan(400);

    // An intaglio pulled 0.15 mm into the prep's walls is a collision: the gap check measures it instead of skipping it.
    if (mirror) return;
    const pulled = inner.positions.slice();
    for (let i = 0; i < n; i++) {
      const p = pt(inner, i);
      const du = p[0] * u[0] + p[1] * u[1] + p[2] * u[2] - cu, dv = p[0] * v[0] + p[1] * v[1] + p[2] * v[2] - cv;
      const r = Math.hypot(du, dv);
      const k = r > 0.15 ? -0.15 / r : 0;
      for (let c = 0; c < 3; c++) pulled[i * 3 + c] = p[c]! + k * (du * u[c]! + dv * v[c]!);
    }
    const { jaw, region, params } = input;
    const pulledGap = measureIntaglioGap({
      positions: jaw.positions,
      normals: jaw.smoothNormals,
      vertexMask: region.vertexMask,
      distance: distanceFromMargin(jaw.positions, jaw.graph, region.vertexMask, region.loopVertices),
      axis,
      params,
      intaglio: bvhRayCaster(createBvh({ positions: pulled, indices: inner.indices.slice() })),
    });
    expect(pulledGap.maxErrorMm).toBeGreaterThan(0.1);
  });

  it('meets the thickness profile on the outer shell, also when shrunk into the prep', () => {
    expectThickness(design);
    expect(design.thickness.minMm).toBeGreaterThan(input.params.minThicknessMm - 0.02);
    // 30% narrower and half as tall: the shell cuts into the prep before enforcement.
    const [sx, sy, sz] = design.pose.scale;
    const shrunk = designCrown({ ...input, pose: { ...design.pose, scale: [sx * 0.7, sy * 0.7, sz * 0.5] } });
    expect(shrunk.thickness.pushedVertices).toBeGreaterThan(100);
    expectThickness(shrunk);
    expect(shrunk.validation).toMatchObject({ closed: true, oriented: true, ok: true });
  });
});

describe('adapting and moving a proposed crown (synthetic 36)', () => {
  const { design, input } = runSynthetic(false);
  const hf = templateForTooth(36).heightFraction;
  const frame = input.frame as { mesial: V3; buccal: V3; occlusal: V3 };
  const adapt = { occlusion: { clearanceMm: 0.05 }, mesial: { targetMm: 0.02 }, distal: { targetMm: 0.02 } };
  const at = (d: CrownDesign, v: number): V3 => [d.mesh.positions[v * 3]!, d.mesh.positions[v * 3 + 1]!, d.mesh.positions[v * 3 + 2]!];
  /** Mean shell-vertex displacement along `u` between two designs, over vertices whose height fraction passes `band`. */
  const meanAlong = (a: CrownDesign, b: CrownDesign, u: V3, band: (h: number) => boolean) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < hf.length; i++) {
      if (!band(hf[i]!)) continue;
      const p = at(a, a.shellStart + i);
      const q = at(b, b.shellStart + i);
      sum += (q[0] - p[0]) * u[0] + (q[1] - p[1]) * u[1] + (q[2] - p[2]) * u[2];
      n++;
    }
    return sum / n;
  };

  it('adapts to the antagonist and the neighbours and stays printable', () => {
    const adapted = designCrown({ ...input, pose: design.pose, adapt, maps: ['occlusion'] });
    expect(adapted.validation.ok).toBe(true);
    expect(adapted.validation.printable).toBe(true);
    const occ = adapted.adapt!.occlusion!;
    // Either the target clearance is reached, or the thickness won and a conflict is reported.
    if (!occ.conflict) expect(occ.minClearanceMm).toBeGreaterThanOrEqual(0.03);
    else expect(occ.conflict.vertices).toBeGreaterThan(0);
    for (const side of ['mesial', 'distal'] as const) {
      const r = adapted.adapt![side]!;
      expect(r.open).toBeUndefined();
      if (!r.conflict && Number.isFinite(r.minClearanceMm)) expect(r.minClearanceMm).toBeGreaterThanOrEqual(0);
    }
    // The occlusion map (computed after adaptation) shows no deep penetration left.
    const occMap = adapted.maps!.occlusion!;
    let minOcc = Infinity;
    for (let v = adapted.shellStart; v < occMap.length; v++) if (Number.isFinite(occMap[v]!)) minOcc = Math.min(minOcc, occMap[v]!);
    if (!occ.conflict) expect(minOcc).toBeGreaterThan(-0.05);
  });

  it('reports insufficient reduction when the antagonist is closer than the minimum thickness allows', () => {
    // A flat antagonist 0.3 mm above the prep top: with 0.5 mm minimum thickness, 0.05 mm clearance is impossible.
    const z = input.frame.occlusal as V3;
    let top = -Infinity;
    const P = input.jaw.positions;
    for (let v = 0; v < input.region.vertexMask.length; v++) {
      if (input.region.vertexMask[v]) top = Math.max(top, P[v * 3]! * z[0] + P[v * 3 + 1]! * z[1] + P[v * 3 + 2]! * z[2]);
    }
    const c = input.frame.origin as V3;
    const h = top + 0.3 - (c[0] * z[0] + c[1] * z[1] + c[2] * z[2]);
    const centre: V3 = [c[0] + z[0] * h, c[1] + z[1] * h, c[2] + z[2] * h];
    const [u, v] = planeBasis(z);
    const S = 20;
    const corner = (a: number, b: number) => [0, 1, 2].map((k) => centre[k]! + a * S * u[k]! + b * S * v[k]!);
    // Wound so the plane faces −occlusal (toward the crown).
    const plane = { positions: new Float32Array([...corner(-1, -1), ...corner(-1, 1), ...corner(1, 1), ...corner(1, -1)]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
    const adapted = designCrown({ ...input, pose: design.pose, antagonist: bvhRayCaster(createBvh(plane)), adapt: { occlusion: { clearanceMm: 0.05 } } });
    const conflict = adapted.adapt!.occlusion!.conflict;
    expect(conflict?.kind).toBe('insufficient reduction');
    expect(conflict!.vertices).toBeGreaterThan(0);
    expect(conflict!.minClearanceMm).toBeLessThan(0.03);
    expect(adapted.validation.ok).toBe(true);
  });

  it('moves the cusps with the pose while the margin stays on the prep', () => {
    const up = directionVector(frame, 'occlusal');
    const moved = designCrown({ ...input, pose: movePose(design.pose, up, 1) });
    expect(Math.abs(meanAlong(design, moved, up, (h) => h >= 0.7) - 1)).toBeLessThan(0.02);
    expect(Math.abs(meanAlong(design, moved, up, (h) => h > 0.3 && h < 0.7) - 0.76)).toBeLessThan(0.05);
    expect(Math.abs(meanAlong(design, moved, up, (h) => h <= 0.05))).toBeLessThan(0.1);
    expect(moved.validation.printable).toBe(true);
  });

  it('reports a contact left open after a move, and the adapt gate fails', () => {
    const moved = designCrown({ ...input, pose: movePose(design.pose, directionVector(frame, 'mesial'), 1), adapt });
    const distal = moved.adapt!.distal!;
    expect(distal.conflict).toBeUndefined();
    expect(distal.open!.clearanceMm).toBeGreaterThan(0.5);
    expect(passed(adaptGate(moved))).toBe(false);
  });
});
