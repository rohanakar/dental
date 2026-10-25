import { describe, expect, it } from 'vitest';
import type { AxisReport, CrownStatus } from '../../tools/toolStore';
import { isReady, millReadiness, type ReadinessInput } from './readiness';

// A smooth 4 mm-radius margin loop, a seated axis and an adapted crown that is thick enough.
const margin = Array.from({ length: 120 }, (_, i) => {
  const a = (i / 120) * 2 * Math.PI;
  return [4 * Math.cos(a), 4 * Math.sin(a), 0] as const;
});
const axis: AxisReport = { undercutAreaMm2: 0, angleFromOcclusalDeg: 2, maxDepthMm: 0, marginUndercutCount: 0, marginPointCount: 64, prepClosed: true };
const crown = {
  validation: { ok: true, printable: true, selfIntersections: 0 } as NonNullable<CrownStatus['validation']>,
  thickness: { minMm: 0.9, pushedVertices: 0, maxPushMm: 0 },
  minAxialThicknessMm: 0.9,
  adapt: {
    occlusion: { movedVertices: 10, maxMoveMm: 0.1, minClearanceMm: 0.05, targetMm: 0.05 },
    mesial: { movedVertices: 4, maxMoveMm: 0.05, minClearanceMm: 0.02, targetMm: 0.02 },
  },
};
const ready: ReadinessInput = {
  margin,
  axis,
  crown,
  params: { minThicknessMm: 0.5 },
  material: 'Zirconia',
  adaptationStale: false,
  neighbours: { mesial: true, distal: false },
};

describe('mill readiness', () => {
  it('passes a finished design and fails a thin, stale, undercut one; an unmeasured axis is not ready', () => {
    expect(isReady(millReadiness(ready))).toBe(true);
    expect(millReadiness(ready).map((i) => i.id)).toEqual(['margin', 'axis', 'solid', 'thickness', 'occlusion', 'mesial']);

    const failing = millReadiness({
      ...ready,
      axis: { ...axis, marginUndercutCount: 3 },
      crown: { ...crown, thickness: { minMm: 0.3, pushedVertices: 0, maxPushMm: 0 } },
      adaptationStale: true,
    });
    const failed = failing.filter((i) => i.status === 'fail').map((i) => i.id);
    expect(failed).toEqual(['axis', 'thickness', 'occlusion', 'mesial']);

    const unmeasured = millReadiness({ ...ready, axis: null });
    expect(unmeasured.find((i) => i.id === 'axis')?.status).toBe('unknown');
    expect(isReady(unmeasured)).toBe(false);
  });
});
