import { MATERIAL_PRESETS } from '@dcad/shared';
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { countSelfIntersections } from './selfIntersect';
import { designCrown, type CrownDesign, type CrownInput } from './crown';
import { templateForTooth } from './crownTemplate';
import { distanceToLoop, signedIntaglioDistance, thicknessProfile } from './thickness';
import { cementGap, GAP_RAMP_MM, planeBasis } from './intaglio';
import { marginFromAnchors, liveWireWeight } from './livewire';
import type { IndexedMesh } from './mesh';
import { validateClosedMesh } from './meshValidate';
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

/** Numbers for the Day 5 report (set CROWN_TEST_NOTES to a file path to collect them). */
const note = (x: unknown) => {
  if (process.env.CROWN_TEST_NOTES) appendFileSync(process.env.CROWN_TEST_NOTES, `${JSON.stringify(x)}\n`);
};
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

describe('cement gap profile', () => {
  const p = MATERIAL_PRESETS.zirconia;
  it('is zero at the margin, the cement gap after the ramp, and adds the spacer further in', () => {
    expect(cementGap(0, p)).toBe(0);
    expect(cementGap(GAP_RAMP_MM, p)).toBeCloseTo(p.cementGapMm, 9);
    expect(cementGap(p.distanceToMarginMm - 0.01, p)).toBeCloseTo(p.cementGapMm, 9);
    expect(cementGap(p.distanceToMarginMm + GAP_RAMP_MM, p)).toBeCloseTo(p.cementGapMm + p.extraSpacerMm, 9);
    expect(cementGap(GAP_RAMP_MM / 2, p)).toBeGreaterThan(0);
    expect(cementGap(GAP_RAMP_MM / 2, p)).toBeLessThan(p.cementGapMm);
  });
});

describe.each([
  ['36 (right-handed frame)', false],
  ['46 (mirrored, left-handed frame)', true],
])('crown on the synthetic prep: %s', (_name, mirror) => {
  const { design, axis, input } = runSynthetic(mirror);
  const template = templateForTooth(input.fdi);
  const T = template.cervicalLoop.length;
  const ringIds = Array.from(template.cervicalLoop, (v) => design.shellStart + v);
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
    return worst;
  };

  it('is a closed, consistently oriented solid with positive volume', () => {
    expect(design.validation).toMatchObject({ boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, degenerateTriangles: 0, closed: true, oriented: true, ok: true });
    expect(design.validation.signedVolumeMm3).toBeGreaterThan(50);
    expect(design.pose.scale[0] < 0).toBe(!mirror); // quadrant 3 frames are left-handed → mirrored template
  });

  it('keeps the intended gap on the axial walls (±0.01 mm)', () => {
    expect(design.gapCheck.samples).toBeGreaterThan(50);
    expect(design.gapCheck.maxErrorMm).toBeLessThan(0.01);
  });

  it('has no undercut on the intaglio: one hit per ray along the axis inside the margin', () => {
    const inner = intaglioPart(design);
    const ray = bvhRayCaster(createBvh({ positions: inner.positions, indices: inner.indices.slice() }));
    const [u, v] = planeBasis(axis);
    const n = design.intaglioVertices;
    let cu = 0, cv = 0;
    for (let i = 0; i < n; i++) {
      cu += (inner.positions[i * 3]! * u[0] + inner.positions[i * 3 + 1]! * u[1] + inner.positions[i * 3 + 2]! * u[2]) / n;
      cv += (inner.positions[i * 3]! * v[0] + inner.positions[i * 3 + 1]! * v[1] + inner.positions[i * 3 + 2]! * v[2]) / n;
    }
    // A disc well inside the margin (the synthetic margin is ~4 mm from the centre).
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
  });

  it('leaves material above the intaglio', () => {
    expect(design.minAxialThicknessMm).toBeGreaterThan(0);
    expect(validateClosedMesh(design.mesh).ok).toBe(true);
  });

  it('pins the fitted cervical ring to the margin, offset by the margin thickness', () => {
    // Each ring vertex sits exactly `band` from its paired rim (margin) vertex, and every rim vertex has its ring
    // vertex; nearest-point distances can be smaller where rim samples bunch up, so check the pairing both ways.
    const band = input.params.marginThicknessMm;
    const rimPts = Array.from({ length: T }, (_, i) => pt(design.mesh, i));
    const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const ringPts = ringIds.map((v) => pt(design.mesh, v));
    for (const r of ringPts) expect(rimPts.some((m) => Math.abs(dist(r, m) - band) < 1e-4)).toBe(true);
    for (const m of rimPts) expect(ringPts.some((r) => Math.abs(dist(r, m) - band) < 1e-4)).toBe(true);
  });

  it('meets the thickness profile everywhere on the outer shell', () => {
    expectThickness(design);
    expect(design.thickness.minSlackMm).toBeGreaterThan(-0.02);
    expect(design.thickness.minMm).toBeGreaterThan(input.params.minThicknessMm - 0.02);
  });

  it('enforces thickness on a crown shrunk into the prep and stays a valid solid', () => {
    // 30% narrower and half as tall: the shell cuts into the prep before enforcement.
    const [sx, sy, sz] = design.pose.scale;
    const shrunk = designCrown({ ...input, pose: { ...design.pose, scale: [sx * 0.7, sy * 0.7, sz * 0.5] } });
    expect(shrunk.thickness.pushedVertices).toBeGreaterThan(100);
    expectThickness(shrunk);
    expect(shrunk.validation).toMatchObject({ closed: true, oriented: true, ok: true });
  });

  it('returns colour maps with the expected layout and plausible ranges', () => {
    const t0 = performance.now();
    const withMaps = designCrown({ ...input, pose: design.pose, maps: ['thickness', 'occlusion', 'proximal', 'unmillable'] });
    const ms = performance.now() - t0;
    const maps = withMaps.maps!;
    const n = withMaps.mesh.positions.length / 3;
    const s0 = withMaps.shellStart;
    const finite = (a: Float32Array, from: number, to: number) => {
      const out: number[] = [];
      for (let v = from; v < to; v++) if (Number.isFinite(a[v]!)) out.push(a[v]!);
      return out;
    };
    for (const name of ['thickness', 'occlusion', 'proximal', 'unmillable'] as const) expect(maps[name]!.length).toBe(n);
    // Shell maps are NaN on the intaglio; the unmillable map is NaN on the shell.
    for (const name of ['thickness', 'occlusion', 'proximal'] as const) expect(finite(maps[name]!, 0, s0)).toEqual([]);
    expect(finite(maps.unmillable!, s0, n)).toEqual([]);
    const thick = finite(maps.thickness!, s0, n);
    expect(thick.length).toBeGreaterThan((n - s0) * 0.9);
    expect(Math.min(...thick)).toBeGreaterThan(-0.02);
    // The crown is sized up to the antagonist (minus 0.05 mm clearance): small clearances on top.
    const occ = finite(maps.occlusion!, s0, n);
    expect(occ.length).toBeGreaterThan(50);
    expect(Math.min(...occ)).toBeLessThan(0.5);
    // Sized to the contact points: some outer vertices are close to the neighbours.
    const prox = finite(maps.proximal!, s0, n);
    expect(prox.length).toBeGreaterThan(20);
    expect(Math.min(...prox)).toBeLessThan(0.5);
    const mill = finite(maps.unmillable!, 0, s0);
    expect(mill.length).toBe(s0);
    expect(Math.min(...mill)).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(10_000);
  });

  it('has no self-intersections and is printable', () => {
    const t0 = performance.now();
    const r = countSelfIntersections(design.mesh);
    const ms = performance.now() - t0;
    expect(r.count).toBe(0);
    expect(design.validation.selfIntersections).toBe(0);
    expect(design.validation.printable).toBe(true);
    note({ case: input.fdi, triangles: design.validation.triangles, selfIntersectMs: Math.round(ms) });
  });

  it('adapts to the antagonist and the neighbours (crown stays printable)', () => {
    const t0 = performance.now();
    const adapted = designCrown({
      ...input,
      pose: design.pose,
      adapt: { occlusion: { clearanceMm: 0.05 }, mesial: { targetMm: 0.02 }, distal: { targetMm: 0.02 } },
      maps: ['occlusion', 'proximal'],
    });
    const ms = performance.now() - t0;
    expect(adapted.validation.ok).toBe(true);
    expect(adapted.validation.printable).toBe(true);
    const occ = adapted.adapt!.occlusion!;
    // Either the target clearance is reached, or the thickness won and a conflict is reported.
    if (!occ.conflict) expect(occ.minClearanceMm).toBeGreaterThanOrEqual(0.03);
    else expect(occ.conflict.vertices).toBeGreaterThan(0);
    for (const side of ['mesial', 'distal'] as const) {
      const r = adapted.adapt![side]!;
      if (!r.conflict && Number.isFinite(r.minClearanceMm)) expect(r.minClearanceMm).toBeGreaterThanOrEqual(0);
    }
    // The occlusion map (computed after adaptation) shows no deep penetration left.
    const occMap = adapted.maps!.occlusion!;
    let minOcc = Infinity;
    for (let v = adapted.shellStart; v < occMap.length; v++) if (Number.isFinite(occMap[v]!)) minOcc = Math.min(minOcc, occMap[v]!);
    if (!occ.conflict) expect(minOcc).toBeGreaterThan(-0.05);
    note({
      case: input.fdi,
      adapt: Object.fromEntries(
        Object.entries(adapted.adapt!).map(([k, r]) => [k, { before: r.minClearanceBeforeMm, after: r.minClearanceMm, moved: r.movedVertices, maxMove: r.maxMoveMm, conflict: r.conflict ?? null }]),
      ),
      occlusionMapMin: minOcc,
      ms: Math.round(ms),
      adaptMs: Math.round(adapted.timingsMs.adapt ?? 0),
    });
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
    const u = planeBasis(z)[0];
    const v2 = planeBasis(z)[1];
    const S = 20;
    const corner = (a: number, b: number) => [0, 1, 2].map((k) => centre[k]! + a * S * u[k]! + b * S * v2[k]!);
    // Wound so the plane faces −occlusal (toward the crown).
    const plane = { positions: new Float32Array([...corner(-1, -1), ...corner(-1, 1), ...corner(1, 1), ...corner(1, -1)]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
    const adapted = designCrown({ ...input, pose: design.pose, antagonist: bvhRayCaster(createBvh(plane)), adapt: { occlusion: { clearanceMm: 0.05 } } });
    const conflict = adapted.adapt!.occlusion!.conflict;
    expect(conflict?.kind).toBe('insufficient reduction');
    expect(conflict!.vertices).toBeGreaterThan(0);
    expect(conflict!.minClearanceMm).toBeLessThan(0.03);
    expect(adapted.warnings.some((w) => w.startsWith('Insufficient reduction'))).toBe(true);
    expect(adapted.validation.ok).toBe(true);
    note({ case: input.fdi, conflict });
  });
});

describe('moving a proposed crown (synthetic 36)', () => {
  const { design, input } = runSynthetic(false);
  const hf = templateForTooth(36).heightFraction;
  const frame = input.frame as { mesial: V3; buccal: V3; occlusal: V3 };
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

  it('moves the cusps with the pose while the margin stays on the prep', () => {
    const up = directionVector(frame, 'occlusal');
    const moved = designCrown({ ...input, pose: movePose(design.pose, up, 1) });
    expect(meanAlong(design, moved, up, (h) => h >= 0.7)).toBeCloseTo(1, 1);
    expect(Math.abs(meanAlong(design, moved, up, (h) => h >= 0.7) - 1)).toBeLessThan(0.02);
    expect(Math.abs(meanAlong(design, moved, up, (h) => h > 0.3 && h < 0.7) - 0.76)).toBeLessThan(0.05);
    expect(Math.abs(meanAlong(design, moved, up, (h) => h <= 0.05))).toBeLessThan(0.1);
    expect(moved.validation.printable).toBe(true);
  });

  it('predicts a move from the move weights (instant preview = recompute)', () => {
    const w = design.moveWeights;
    expect(w.length).toBe(design.mesh.positions.length / 3);
    for (let v = 0; v < design.intaglioVertices; v++) expect(w[v]).toBe(0);
    const d = directionVector(frame, 'buccal');
    const moved = designCrown({ ...input, pose: movePose(design.pose, d, 1) });
    let sum = 0;
    let max = 0;
    for (let v = design.shellStart; v < w.length; v++) {
      const p = at(design, v);
      const q = at(moved, v);
      const err = Math.hypot(p[0] + w[v]! * d[0] - q[0], p[1] + w[v]! * d[1] - q[1], p[2] + w[v]! * d[2] - q[2]);
      sum += err;
      max = Math.max(max, err);
    }
    const mean = sum / (w.length - design.shellStart);
    expect(mean).toBeLessThan(0.01);
    expect(max).toBeLessThan(0.05);
    note({ case: 36, previewErrorMm: { mean, max }, fitMs: Math.round(design.timingsMs.fit ?? 0) });
  });

  it('reports a contact left open by adaptation, and the adapt gate fails', () => {
    const adapt = { occlusion: { clearanceMm: 0.05 }, mesial: { targetMm: 0.02 }, distal: { targetMm: 0.02 } };
    const adapted = designCrown({ ...input, pose: design.pose, adapt });
    expect(adapted.adapt!.mesial!.open).toBeUndefined();
    expect(adapted.adapt!.distal!.open).toBeUndefined();
    const moved = designCrown({ ...input, pose: movePose(design.pose, directionVector(frame, 'mesial'), 1), adapt });
    const distal = moved.adapt!.distal!;
    expect(distal.conflict).toBeUndefined();
    expect(distal.open!.clearanceMm).toBeGreaterThan(0.5);
    expect(moved.warnings.some((x) => x.startsWith('Distal contact open'))).toBe(true);
    expect(passed(adaptGate(moved))).toBe(false);
    expect(adaptGate(moved).find((c) => c.id === 'adapt.distal')).toMatchObject({ passed: false, message: expect.stringContaining('contact open') });
    note({ case: 36, openAfterMesial1mm: distal.open });
  });
});
