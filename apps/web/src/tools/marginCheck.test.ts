import { describe, expect, it } from 'vitest';
import { marginProblems } from './marginCheck';

type V3 = [number, number, number];
/** A closed loop at 0.2 mm spacing (28 mm long), like a resampled margin. */
const loop = (): V3[] =>
  Array.from({ length: 140 }, (_, i) => {
    const t = (2 * Math.PI * i) / 140;
    const r = 28 / (2 * Math.PI);
    return [r * Math.cos(t), r * Math.sin(t), 0];
  });

describe('margin problems', () => {
  it('finds the kink of a margin that doubles back and names its side; none on a smooth margin', () => {
    // Frame of an upper central: mesial +x, labial +y.
    const tooth = { fdi: 11, frame: { mesial: [1, 0, 0], buccal: [0, 1, 0] } };
    const smooth = marginProblems(loop(), tooth);
    expect(smooth.failed).toEqual([]);
    expect(smooth.kinks).toEqual([]);

    // A 1 mm out-and-back spike on the labial side (+y), as a live-wire that strayed onto the labial face makes.
    const spiked = loop();
    const at = 35; // t = 90°: the +y side
    const p = spiked[at]!;
    spiked.splice(at + 1, 0, [p[0], p[1] + 0.35, 0], [p[0], p[1] + 0.7, 0], [p[0], p[1] + 1, 0], [p[0], p[1] + 0.7, 0], [p[0], p[1] + 0.35, 0]);
    const kinked = marginProblems(spiked, tooth);
    expect(kinked.failed.map((c) => c.id)).toContain('margin.smooth');
    expect(kinked.kinks).toHaveLength(1);
    const k = kinked.kinks[0]!;
    expect(Math.hypot(k.point[0] - p[0], k.point[1] - (p[1] + 1), k.point[2])).toBeLessThan(0.5);
    expect(k.turnDeg).toBeGreaterThan(120);
    expect(k.side).toBe('labial');
  });
});
