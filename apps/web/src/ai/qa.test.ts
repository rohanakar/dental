import type { QaCheck } from '@dcad/shared';
import { describe, expect, it } from 'vitest';
import type { BridgeChecks, ConnectorCheck } from '../geometry/bridgeUnion';
import type { ConnectorFailure } from '../geometry/connectors';
import { adaptGate, axisGate, bridgeGate, crownGate, marginGate, passed, sharpestTurnDeg } from './qa';

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

  it('axis, crown, adapt and bridge: fail on undercut or tilt, an unprintable or thin crown, a conflict or an open contact, a weak connector, a split union or moved seating', () => {
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

    // Bridge 35–[36]–37: connectors measured on the union, one solid, seating unchanged, pontic base on the ridge.
    const failedIds = (qa: QaCheck[]) => qa.filter((c) => !c.passed).map((c) => c.id);
    const measured = { minAreaMm2: 9.004, heightMm: 3.39, widthMm: 3.38, at: [0, 0, 0] as V3, planes: 25 };
    const connector = (between: [number, number]): ConnectorCheck => ({ between, targetAreaMm2: 9, minAreaMm2: 9, designedHeightMm: 3.39, minHeightMm: 3, measured, failures: [], areaOk: true, heightOk: true, ok: true });
    const gap = { samples: 120, meanErrorMm: 0.002, maxErrorMm: 0.009 };
    const checks: BridgeChecks = {
      union: { triangles: 9000, vertices: 4502, volumeMm3: 820, closed: true, oriented: true, degenerateTriangles: 0, selfIntersections: 0, printable: true, components: 1, genus: 0, euler: 2, ok: true },
      connectors: [connector([35, 36]), connector([36, 37])],
      seating: [35, 37].map((fdi) => ({ fdi, own: gap, onUnion: gap, deltaMeanMm: 0, deltaMaxMm: 0, ok: true })),
      ponticBase: [{ fdi: 36, samples: 80, minGapMm: -0.0002, meanGapMm: 0.01, targetMm: 0, ok: true }],
      failures: [],
      ok: true,
    };
    const bridge = { connectors: checks.connectors.map((c) => ({ between: c.between, failures: [] as ConnectorFailure[] })), union: { checks } };
    expect(passed(bridgeGate(bridge))).toBe(true);
    const withConnector = (c: ConnectorCheck) => ({ ...bridge, union: { checks: { ...checks, connectors: [c, checks.connectors[1]!] } } });
    expect(failedIds(bridgeGate(withConnector({ ...connector([35, 36]), measured: { ...measured, minAreaMm2: 8.2 } })))).toEqual(['bridge.connector.35-36.area']);
    expect(failedIds(bridgeGate(withConnector({ ...connector([35, 36]), measured: { ...measured, heightMm: 2.6 } })))).toEqual(['bridge.connector.35-36.height']);
    const tooLow: ConnectorFailure = { code: 'insufficient-height', message: 'insufficient connector height', valueMm: 2.4, limitMm: 3 };
    expect(failedIds(bridgeGate({ ...bridge, connectors: [{ between: [35, 36], failures: [tooLow] }, bridge.connectors[1]!] }))).toEqual(['bridge.connector.35-36.insufficient-height']);
    expect(failedIds(bridgeGate({ ...bridge, union: { checks: { ...checks, union: { ...checks.union, components: 2 } } } }))).toEqual(['bridge.union.components']);
    const moved = { ...checks.seating[1]!, deltaMaxMm: 0.03 };
    expect(failedIds(bridgeGate({ ...bridge, union: { checks: { ...checks, seating: [checks.seating[0]!, moved] } } }))).toEqual(['bridge.seating.37']);
    expect(failedIds(bridgeGate({ connectors: bridge.connectors, unionError: 'not manifold' }))).toEqual(['bridge.union']);
  });
});
