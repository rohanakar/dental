import { describe, expect, it } from 'vitest';
import { adaptGate, axisGate, crownGate, marginGate, passed, sharpestTurnDeg } from './qa';

type V3 = [number, number, number];
const circle = (r: number, n: number): V3[] => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), 0]);
const validation = { triangles: 1, vertices: 1, boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, degenerateTriangles: 0, signedVolumeMm3: 300, closed: true, oriented: true, ok: true };

describe('QA gates', () => {
  it('margin: passes a smooth closed loop, fails a kink, a short loop and a leak', () => {
    const smooth = circle(4, 120);
    expect(sharpestTurnDeg(smooth)).toBeLessThan(15); // chords over ~0.6 mm on a small loop
    expect(passed(marginGate({ points: smooth, lengthMm: 25, prepClosed: true, confidence: 1 }))).toBe(true);
    const kinked = [...smooth];
    kinked.splice(60, 0, [0, 0, 0], kinked[59]!); // doubles back
    expect(sharpestTurnDeg(kinked)).toBeGreaterThan(120);
    expect(marginGate({ points: kinked, lengthMm: 25 }).find((c) => c.id === 'margin.smooth')!.passed).toBe(false);
    expect(passed(marginGate({ points: smooth, lengthMm: 5 }))).toBe(false);
    expect(passed(marginGate({ points: smooth, lengthMm: 25, prepClosed: false }))).toBe(false);
    expect(passed(marginGate({ points: smooth, lengthMm: 25, confidence: 0.5 }))).toBe(false);
  });

  it('axis: fails on margin undercut or a large tilt', () => {
    expect(passed(axisGate({ marginUndercutCount: 0, angleFromOcclusalDeg: 3, prepClosed: true }))).toBe(true);
    expect(passed(axisGate({ marginUndercutCount: 4, angleFromOcclusalDeg: 3, prepClosed: true }))).toBe(false);
    expect(passed(axisGate({ marginUndercutCount: 0, angleFromOcclusalDeg: 30, prepClosed: true }))).toBe(false);
  });

  it('crown: needs a valid printable solid and the minimum thickness', () => {
    const ok = { validation: { ...validation, selfIntersections: 0, printable: true }, thickness: { minMm: 0.5, pushedVertices: 0, maxPushMm: 0 }, minAxialThicknessMm: 3 };
    expect(passed(crownGate(ok, { minThicknessMm: 0.5 }))).toBe(true);
    expect(passed(crownGate({ ...ok, validation: { ...ok.validation, printable: false, selfIntersections: 3 } }, { minThicknessMm: 0.5 }))).toBe(false);
    expect(passed(crownGate({ ...ok, thickness: { minMm: 0.4, pushedVertices: 0, maxPushMm: 0 } }, { minThicknessMm: 0.5 }))).toBe(false);
  });

  it('adapt: fails on a conflict', () => {
    const report = { movedVertices: 10, maxMoveMm: 0.2, minClearanceMm: 0.05 };
    expect(passed(adaptGate({ adapt: { occlusion: report } }))).toBe(true);
    const conflict = { ...report, conflict: { kind: 'insufficient reduction', vertices: 12, minClearanceMm: -0.1, at: [0, 0, 0] as V3 } };
    expect(passed(adaptGate({ adapt: { occlusion: conflict } }))).toBe(false);
  });
});

describe('sharpestTurnDeg (stride-based)', () => {
  const circle = (n: number, r: number, jitter = 0): V3[] =>
    Array.from({ length: n }, (_, i) => {
      const t = (2 * Math.PI * i) / n;
      const j = jitter * (i % 2 === 0 ? 1 : -1);
      return [(r + j) * Math.cos(t), (r + j) * Math.sin(t), 0] as V3;
    });

  it('ignores sub-stride jitter from vertex snapping', () => {
    // 28 mm circumference at 0.2 mm spacing with ±0.05 mm zigzag: adjacent segments turn sharply, the curve does not.
    const pts = circle(140, 28 / (2 * Math.PI), 0.05);
    expect(sharpestTurnDeg(pts, 0)).toBeGreaterThan(40); // adjacent segments zigzag
    expect(sharpestTurnDeg(pts)).toBeLessThan(45); // far below the 120° gate
  });

  it('still catches a doubled-back spike', () => {
    const pts = circle(140, 28 / (2 * Math.PI));
    // A 1 mm out-and-back spike, as a live-wire doubling back would make.
    const p = pts[40]!;
    pts.splice(41, 0, [p[0] * 1.05, p[1] * 1.05, 0], [p[0] * 1.1, p[1] * 1.1, 0], [p[0] * 1.15, p[1] * 1.15, 0], [p[0] * 1.1, p[1] * 1.1, 0], [p[0] * 1.05, p[1] * 1.05, 0]);
    expect(sharpestTurnDeg(pts)).toBeGreaterThan(120);
  });
});
