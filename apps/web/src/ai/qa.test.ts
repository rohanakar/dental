import { describe, expect, it } from 'vitest';
import { adaptGate, axisGate, crownGate, marginGate, passed, sharpestTurnDeg } from './qa';

type V3 = [number, number, number];
const circle = (r: number, n: number, jitter = 0): V3[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    const j = jitter * (i % 2 === 0 ? 1 : -1);
    return [(r + j) * Math.cos(t), (r + j) * Math.sin(t), 0];
  });
const validation = { triangles: 1, vertices: 1, boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, degenerateTriangles: 0, signedVolumeMm3: 300, closed: true, oriented: true, ok: true };

describe('QA gates', () => {
  it('margin: passes a smooth closed loop, fails a kink, a short loop, a leak and low confidence', () => {
    const smooth = circle(4, 120);
    expect(passed(marginGate({ points: smooth, lengthMm: 25, prepClosed: true, confidence: 1 }))).toBe(true);
    const kinked = [...smooth];
    kinked.splice(60, 0, [0, 0, 0], kinked[59]!); // doubles back
    expect(passed(marginGate({ points: kinked, lengthMm: 25 }))).toBe(false);
    expect(passed(marginGate({ points: smooth, lengthMm: 5 }))).toBe(false);
    expect(passed(marginGate({ points: smooth, lengthMm: 25, prepClosed: false }))).toBe(false);
    expect(passed(marginGate({ points: smooth, lengthMm: 25, confidence: 0.5 }))).toBe(false);
  });

  it('measures turns over a stride: ignores vertex-snapping jitter, catches a doubled-back spike', () => {
    // 28 mm circumference at 0.2 mm spacing with ±0.05 mm zigzag: adjacent segments turn sharply, the curve does not.
    const jittered = circle(28 / (2 * Math.PI), 140, 0.05);
    expect(sharpestTurnDeg(jittered, 0)).toBeGreaterThan(40);
    expect(sharpestTurnDeg(jittered)).toBeLessThan(45); // far below the 120° gate
    // A 1 mm out-and-back spike, as a live-wire doubling back would make.
    const spiked = circle(28 / (2 * Math.PI), 140);
    const p = spiked[40]!;
    spiked.splice(41, 0, [p[0] * 1.05, p[1] * 1.05, 0], [p[0] * 1.1, p[1] * 1.1, 0], [p[0] * 1.15, p[1] * 1.15, 0], [p[0] * 1.1, p[1] * 1.1, 0], [p[0] * 1.05, p[1] * 1.05, 0]);
    expect(sharpestTurnDeg(spiked)).toBeGreaterThan(120);
  });

  it('axis, crown and adapt: fail on undercut or tilt, an unprintable or thin crown, a conflict or an open contact', () => {
    expect(passed(axisGate({ marginUndercutCount: 0, angleFromOcclusalDeg: 3, prepClosed: true }))).toBe(true);
    expect(passed(axisGate({ marginUndercutCount: 4, angleFromOcclusalDeg: 3, prepClosed: true }))).toBe(false);
    expect(passed(axisGate({ marginUndercutCount: 0, angleFromOcclusalDeg: 30, prepClosed: true }))).toBe(false);

    const ok = { validation: { ...validation, selfIntersections: 0, printable: true }, thickness: { minMm: 0.5, pushedVertices: 0, maxPushMm: 0 }, minAxialThicknessMm: 3 };
    expect(passed(crownGate(ok, { minThicknessMm: 0.5 }))).toBe(true);
    expect(passed(crownGate({ ...ok, validation: { ...ok.validation, printable: false, selfIntersections: 3 } }, { minThicknessMm: 0.5 }))).toBe(false);
    expect(passed(crownGate({ ...ok, thickness: { minMm: 0.4, pushedVertices: 0, maxPushMm: 0 } }, { minThicknessMm: 0.5 }))).toBe(false);

    const reached = { movedVertices: 10, maxMoveMm: 0.2, minClearanceMm: 0.02, targetMm: 0.02 };
    expect(passed(adaptGate({ adapt: { occlusion: reached, mesial: reached } }))).toBe(true);
    const conflict = { ...reached, conflict: { kind: 'insufficient reduction', vertices: 12, minClearanceMm: -0.1, at: [0, 0, 0] as V3 } };
    expect(passed(adaptGate({ adapt: { occlusion: conflict } }))).toBe(false);
    const open = { ...reached, minClearanceMm: 0.91, open: { clearanceMm: 0.91 } };
    expect(passed(adaptGate({ adapt: { mesial: reached, distal: open } }))).toBe(false);
  });
});
