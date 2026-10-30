import { beforeAll, describe, expect, it } from 'vitest';
import { fitArchCurve } from './arch';
import { archFitDirections, layoutPontics } from './bridge';
import { initMeshBoolean } from './meshBoolean';
import type { V3 } from './pca';
import { findPreps, prepFor, scanBodyFor, type PrepFinding } from './prepFinder';
import { syntheticArch, syntheticPrepSeed, type ArchOptions } from './synthetic';
import { syntheticImplantScan, type SyntheticImplantScan } from './syntheticImplant';
import { prepareMesh, type PreparedMesh } from './testUtils';

// 0.3M triangles: on the 400 × 120 grid the premolar's 0.2 mm chamfer ledge is about one mesh row.
const ALONG = 600;
const arch = (options: ArchOptions): PreparedMesh => prepareMesh(syntheticArch({ jaw: 'lower', along: ALONG, across: 250, ...options }));
const distance = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('prep finder', () => {
  let bridgeArch: PreparedMesh;
  let bridge: PrepFinding;
  let cavities: PrepFinding;
  let implantScan: SyntheticImplantScan;
  let implants: PrepFinding;
  beforeAll(async () => {
    // The 35–[36]–37 bridge arch, and the same teeth with a MOD inlay cavity and an onlay instead of crown preps.
    bridgeArch = arch({ preps: [35, 37], missing: [36] });
    bridge = findPreps(bridgeArch);
    cavities = findPreps(arch({ preps: [], missing: [36], cavities: [{ fdi: 35, kind: 'mod' }, { fdi: 37, kind: 'onlay' }] }));
    // Scan bodies on 35 and 37, tilted and turned as in the implant fixture (tools/fixtures/implant-library.mts).
    await initMeshBoolean();
    implantScan = syntheticImplantScan({ jaw: 'lower', missing: [35, 36, 37], scanBodies: [{ fdi: 35, mesialTiltDeg: 5 }, { fdi: 37, mesialTiltDeg: -4, rotationDeg: 40 }] });
    implants = findPreps(prepareMesh(implantScan.mesh));
  });

  it('finds the crown preps and pairs each tooth with its own, in arch order', () => {
    expect(bridge.preps).toHaveLength(2);
    for (const fdi of [35, 37]) expect(distance(prepFor(bridge, fdi, [35, 37])!.top, syntheticPrepSeed({ fdi, along: ALONG }))).toBeLessThan(1);
    // Counts that disagree on the tooth's side of the midline pair nothing, so a ring never shifts onto a neighbour.
    expect(prepFor(bridge, 35, [35])).toBeNull();
    expect(prepFor(bridge, 45, [45, 35, 37])).toBeNull();
  });

  it('rings no inlay or onlay cavity and no natural tooth', () => {
    expect(cavities.preps).toEqual([]);
  });

  it('finds every scan body on an implant scan, paired in arch order, and none on crown preps or cavities', () => {
    expect(implants.scanBodies).toHaveLength(2);
    for (const { fdi, topCentre } of implantScan.implants) expect(distance(scanBodyFor(implants, fdi, [35, 37])!.top, topCentre)).toBeLessThan(0.3);
    expect(implants.preps).toEqual([]);
    expect(bridge.scanBodies).toEqual([]);
    expect(cavities.scanBodies).toEqual([]);
  });

  it('reports bridge frames off the case teeth: in the wrong order, or far too far apart', () => {
    const curve = fitArchCurve({ positions: bridgeArch.positions, occlusal: [0, 0, 1] });
    const on = (fdi: number) => ({ origin: syntheticPrepSeed({ fdi, along: ALONG }), occlusal: [0, 0, 1] as V3, buccal: [0, 1, 0] as V3 });
    const check = (at35: number, at37: number) =>
      layoutPontics({ curve, jaw: bridgeArch.ray, units: [{ fdi: 35, kind: 'abutment', frame: on(at35) }, { fdi: 36, kind: 'pontic' }, { fdi: 37, kind: 'abutment', frame: on(at37) }] })[0]!.frameCheck;
    expect(check(35, 37)).toBeUndefined();
    expect(check(37, 35)).toMatch(/wrong order/);
    expect(check(31, 37)).toMatch(/apart/);
  });

  it("follows the abutments' order on a segment scan whose curve bends the wrong way", () => {
    // A 24 mm segment of lower-left teeth whose top bends toward the cheek at both ends, as a real scan does with the
    // ramus behind the molar: the fitted curve's inside is buccal. The frames' own buccal is guessed wrong too. 35 lies
    // mesial of 37 (+y), so buccal is −x (FDI handedness).
    const bend = (y: number) => -0.0174 * y * y;
    const points: number[] = [];
    for (let y = -12; y <= 12; y += 0.25) for (let w = -4; w <= 4; w += 0.5) for (const z of [0, 2, 4, 6, 8]) points.push(bend(y) + w, y, z);
    const frame = (fdi: number, y: number) => ({ fdi, origin: [bend(y), y, 8] as V3, occlusal: [0, 0, 1] as V3, buccal: [1, 0, 0] as V3 });
    const frames = [frame(35, 6), frame(37, -6)];
    const curve = fitArchCurve({ positions: Float32Array.from(points), ...archFitDirections(frames) });
    expect(curve.kind).toBe('curve');
    expect(curve.midlineS).toBeNull();
    const s = curve.project(frames[1]!.origin);
    expect(curve.normalAt(s)[0]).toBeLessThan(-0.9);
    expect(curve.mesialAt(s, 37)[1]).toBeGreaterThan(0.9);
  });
});
