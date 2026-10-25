import { describe, expect, it } from 'vitest';
import type { V3 } from './pca';
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
});
