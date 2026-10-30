import { MATERIAL_PRESETS } from '@dcad/shared';
import { describe, expect, it } from 'vitest';
import { marginUndercut, searchInsertionAxis } from './axis';
import { designCrown } from './crown';
import { liveWireWeight, marginFromAnchors } from './livewire';
import type { V3 } from './pca';
import { prepRegion, prepSeedVertex } from './prepRegion';
import { analyzeSurface, smoothVertexNormals } from './surface';
import { mesialFromBuccal, estimateToothFrame } from './toothFrame';
import { syntheticArch, syntheticPrepMargin, syntheticPrepSeed } from './synthetic';
import { prepareMesh } from './testUtils';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const at = (p: Float32Array, i: number): V3 => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];

describe('tooth frame', () => {
  it('follows FDI quadrant handedness', () => {
    const z: V3 = [0, 0, 1];
    // Right-handed patient frame: +x = patient's right, +y = anterior, +z = up. Mesial of a posterior tooth = anterior.
    expect(mesialFromBuccal(36, z, [-1, 0, 0])[1]).toBeCloseTo(1); // lower left: buccal = −x
    expect(mesialFromBuccal(46, z, [1, 0, 0])[1]).toBeCloseTo(1); // lower right
    expect(mesialFromBuccal(26, [0, 0, -1], [-1, 0, 0])[1]).toBeCloseTo(1); // upper left
    expect(mesialFromBuccal(16, [0, 0, -1], [1, 0, 0])[1]).toBeCloseTo(1); // upper right
  });

  it('estimates occlusal, mesial, buccal and both contacts on the synthetic prep', () => {
    const along = 400;
    const lower = prepareMesh(syntheticArch({ jaw: 'lower', along, across: 120 }));
    const upper = syntheticArch({ jaw: 'upper', along: 200, across: 60 });
    const frame = estimateToothFrame({
      jaw: lower,
      antagonist: upper,
      seed: syntheticPrepSeed({ along }),
      fdi: 36,
      ray: lower.ray,
    });
    const ring = syntheticPrepMargin({ along, samples: 64 });
    // Ring sample 0 is m = +R (distal), 32 is m = −R (mesial); 16 is b = +R (buccal), 48 is lingual.
    const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], 0];
    const expectedMesial = unit(sub(at(ring, 32), at(ring, 0)));
    const expectedBuccal = unit(sub(at(ring, 16), at(ring, 48)));
    expect(frame.occlusal[2]).toBeGreaterThan(0.95);
    expect(dot(frame.mesial, expectedMesial)).toBeGreaterThan(0.95);
    expect(dot(frame.buccal, expectedBuccal)).toBeGreaterThan(0.95);
    expect(frame.origin[2]).toBeGreaterThan(3.5); // prep top
    expect(frame.mesialContact).toBeDefined();
    expect(frame.distalContact).toBeDefined();
    const m = dot(sub(frame.mesialContact!, frame.origin), frame.mesial);
    const d = -dot(sub(frame.distalContact!, frame.origin), frame.mesial);
    expect(m).toBeGreaterThan(1.5);
    expect(m).toBeLessThan(6);
    expect(d).toBeGreaterThan(1.5);
    expect(d).toBeLessThan(6);
    expect(frame.warnings).toEqual([]);
    // Right-handed or not, the axes are orthonormal.
    expect(Math.abs(dot(frame.occlusal, frame.mesial))).toBeLessThan(1e-6);
    expect(Math.abs(dot(frame.occlusal, frame.buccal))).toBeLessThan(1e-6);
    expect(Math.abs(dot(frame.mesial, frame.buccal))).toBeLessThan(1e-6);
  });

  it('follows the prep axis on leaning front teeth (the crown on it is printable), and faces the antagonist from a tilted click; upright ones keep the jaw frame', () => {
    // 600 × 300: below that the small incisor prep's crown can fold at its rounded line angle, leaning or not.
    const along = 600;
    const LEAN = 25;
    const deg = (a: V3, b: V3) => (Math.acos(Math.min(1, Math.max(-1, dot(unit(a), unit(b))))) * 180) / Math.PI;
    const upper = prepareMesh(syntheticArch({ jaw: 'upper', along, across: 300, preps: [11, 21], anteriorLeanDeg: LEAN }));
    const frames = [11, 21].map((fdi) => {
      const seed = syntheticPrepSeed({ fdi, along, anteriorLeanDeg: LEAN });
      // The sheared tooth's centre line: tan(lean) labially per mm toward the antagonist (−z for the upper jaw).
      const upright = syntheticPrepSeed({ fdi, along });
      const labial = unit([seed[0] - upright[0], seed[1] - upright[1], 0]);
      const t = Math.tan((LEAN * Math.PI) / 180);
      const truth = unit([t * labial[0], t * labial[1], -1]);
      const input = { jaw: upper, seed, fdi, ray: upper.ray };
      const frame = estimateToothFrame({ ...input, prep: true });
      expect(deg(frame.occlusal, truth)).toBeLessThan(4);
      expect(deg(estimateToothFrame(input).occlusal, truth)).toBeGreaterThan(20); // the jaw-level frame stands upright
      // FDI handedness: mesial toward the midline (11 sits at +x, 21 at −x), buccal labial; orthonormal.
      expect(frame.mesial[0] * Math.sign(seed[0])).toBeLessThan(-0.9);
      expect(dot(frame.buccal, labial)).toBeGreaterThan(0.85);
      expect(Math.abs(dot(frame.occlusal, frame.mesial)) + Math.abs(dot(frame.occlusal, frame.buccal)) + Math.abs(dot(frame.mesial, frame.buccal))).toBeLessThan(1e-6);
      expect(frame.warnings).toEqual([]);
      return frame;
    });

    // Real front teeth (specs/2026-10-30-front-tooth-frame-side.md): the normals near a click on the tooth's slope tilt
    // 25–32° labially, and the antagonist's centroid lies only a few mm past the incisal edges but 15–25 mm behind
    // them. The side toward the antagonist is the jaw's, so the frame does not flip.
    const tilt = (30 * Math.PI) / 180;
    const normals = upper.normals.slice();
    for (let i = 0; i < normals.length; i += 3) {
      const [y, z] = [normals[i + 1]!, normals[i + 2]!];
      [normals[i + 1], normals[i + 2]] = [y * Math.cos(tilt) - z * Math.sin(tilt), y * Math.sin(tilt) + z * Math.cos(tilt)];
    }
    const top = syntheticPrepSeed({ fdi: 11, along, anteriorLeanDeg: LEAN });
    const behind = unit([-top[0], -top[1], 0]);
    const antagonist = Float32Array.from(Array.from({ length: 8 }, (_, k) => [top[0] + 20 * behind[0] + Math.cos(k), top[1] + 20 * behind[1] + Math.sin(k), top[2] - 4]).flat());
    const tilted = estimateToothFrame({ jaw: { ...upper, normals }, antagonist: { positions: antagonist }, seed: top, fdi: 11, ray: upper.ray, prep: true });
    expect(tilted.occlusal[2]).toBeLessThan(-0.7);
    expect(tilted.warnings.some((w) => w.includes('antagonist'))).toBe(false);

    // The crown on 21 along the least-undercut axis from its frame: no margin point in undercut, a printable solid.
    const frame = frames[1]!;
    const surface = analyzeSurface(upper);
    const ring = syntheticPrepMargin({ fdi: 21, along, samples: 8, anteriorLeanDeg: LEAN });
    const anchors = Array.from({ length: 8 }, (_, i): V3 => [ring[i * 3]!, ring[i * 3 + 1]!, ring[i * 3 + 2]!]);
    const trace = marginFromAnchors({ ...upper, graph: surface.graph, weight: liveWireWeight(surface.curvature), anchors });
    const seedVertex = prepSeedVertex({ ...upper, loopVertices: trace.loopVertices, occlusal: frame.occlusal })!;
    const region = prepRegion({ ...upper, graph: surface.graph, loopVertices: trace.loopVertices, seedVertex });
    expect(region.closed).toBe(true);
    const axis = searchInsertionAxis({ ...upper, faceMask: region.faceMask, center: frame.occlusal });
    expect(axis.angleFromCenterDeg).toBeLessThan(2); // the jaw-level frame needs 6.9° here
    expect(marginUndercut({ points: trace.points, axis: axis.direction, ray: upper.ray, faceMask: region.faceMask }).count).toBe(0);
    const crown = designCrown({
      fdi: 21,
      jaw: { ...upper, graph: surface.graph, smoothNormals: smoothVertexNormals(upper.normals, surface.graph, 3) },
      region: { ...region, loopVertices: trace.loopVertices },
      frame,
      margin: trace.points,
      axis: axis.direction,
      params: MATERIAL_PRESETS.zirconia,
    });
    expect(crown.validation).toMatchObject({ closed: true, ok: true, selfIntersections: 0, printable: true });

    // Gate: on the upright arch the front-tooth rule leaves the jaw-level frame exactly as it was.
    const straight = prepareMesh(syntheticArch({ jaw: 'upper', along, across: 300, preps: [11] }));
    const input = { jaw: straight, seed: syntheticPrepSeed({ fdi: 11, along }), fdi: 11, ray: straight.ray };
    expect(estimateToothFrame({ ...input, prep: true })).toEqual(estimateToothFrame(input));
  });
});
