import { describe, expect, it, vi } from 'vitest';

vi.mock('../workers/geometryClient', () => ({ analysis: {} }));

const { tiltToward } = await import('./axisTool');

const angle = (a: number[], b: number[]) =>
  (Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)) * 180) / Math.PI;

describe('tiltToward', () => {
  it('leans the axis toward the target by the given angle', () => {
    const tilted = tiltToward([0, 0, 1], [0, 1, 0], 5);
    expect(angle(tilted, [0, 0, 1])).toBeCloseTo(5, 6);
    expect(tilted[1]).toBeGreaterThan(0);
    expect(tilted[0]).toBeCloseTo(0, 9);
  });

  it('only uses the target component perpendicular to the axis', () => {
    const tilted = tiltToward([0, 0, 1], [0, 1, 1], 3);
    expect(angle(tilted, [0, 0, 1])).toBeCloseTo(3, 6);
  });
});
