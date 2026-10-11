import { describe, expect, it } from 'vitest';
import { crownCentre, quatFromAxisAngle, quatMultiply, quatRotate, rotatePose, scalePose } from './clinical';

const close = (a: readonly number[], b: readonly number[], eps = 1e-9) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, -Math.log10(eps)));

describe('pose math', () => {
  it('rotates vectors with the right-hand rule', () => {
    close(quatRotate(quatFromAxisAngle([0, 0, 1], 90), [1, 0, 0]), [0, 1, 0]);
    close(quatRotate(quatFromAxisAngle([1, 0, 0], 90), [0, 1, 0]), [0, 0, 1]);
    close(quatRotate(quatFromAxisAngle([0, 0, 2], 0), [1, 2, 3]), [1, 2, 3]); // axis need not be unit
  });

  it('composes a ⊗ b as "b first, then a"', () => {
    const a = quatFromAxisAngle([0, 0, 1], 90);
    const b = quatFromAxisAngle([1, 0, 0], 90);
    const v = [0, 1, 0];
    close(quatRotate(quatMultiply(a, b), v), quatRotate(a, quatRotate(b, v)));
  });

  it('rotates a pose about a centre: the centre stays put', () => {
    const pose = { position: [1, 2, 3] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [-1, 1, 1] as [number, number, number] };
    const c = crownCentre(pose, 8);
    close(c, [1, 2, 7]);
    const rotated = rotatePose(pose, [1, 0, 0], 30, c);
    close(crownCentre(rotated, 8), c);
    expect(Math.hypot(...rotated.quaternion)).toBeCloseTo(1, 12);
  });

  it('scales one component and keeps the mirror sign', () => {
    const pose = { position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [-1.2, 1, 1] as [number, number, number] };
    expect(scalePose(pose, 0, 10).scale[0]).toBeCloseTo(-1.32, 12);
    expect(scalePose(pose, 2, -5).scale).toEqual([-1.2, 1, 0.95]);
  });
});
