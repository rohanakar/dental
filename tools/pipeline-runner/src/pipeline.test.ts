import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minConnectorAreaMm2 } from '@dcad/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { runBridgeCase } from './bridgePipeline';
import { writeSyntheticFrameworkCase } from './frameworkGolden';
import { SYNTHETIC_BRIDGES, writeSyntheticBridgeCase, writeSyntheticCase, writeSyntheticInlayCase, writeSyntheticMarylandCase } from './golden';
import { syntheticPrepSeed } from '@dcad/web/geometry';
import { runCase } from './pipeline';
import { writeSyntheticImplantCase } from './implantGolden';
import { runImplantBridgeCase } from './implantPipeline';

describe('pipeline runner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcad-golden-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('passes every check on the synthetic FDI 36 case with the automatic margin', async () => {
    const spec = writeSyntheticCase(join(dir, 'synthetic-36'), { along: 600, across: 160 });
    const { metrics, crownStl } = await runCase(spec, join(dir, 'synthetic-36'), { auto: true });
    expect(metrics.checks.filter((c) => !c.passed)).toEqual([]);
    expect(metrics.ok).toBe(true);
    expect(metrics.margin.source).toBe('auto');
    expect(metrics.margin.meanDeviationMm).toBeLessThan(0.15);
    expect(metrics.contacts.mesial).toBeDefined();
    expect(metrics.contacts.distal).toBeDefined();
    expect(metrics.crown.watertight).toBe(true);
    expect(crownStl.byteLength).toBe(84 + 50 * metrics.crown.triangles);
  });

  // Posterior 35–[36]–37, and anterior [12]–11–21–[22]: anterior templates, the midline connector, two cantilevers
  // and an upper-jaw prep.
  it.each(['posterior', 'anterior'] as const)('passes every check on the synthetic bridges (%s)', async (kind) => {
    const spec = writeSyntheticBridgeCase(join(dir, kind), kind, { along: 600, across: 160 });
    const { metrics, bridgeStl } = await runBridgeCase(spec, join(dir, kind));
    expect(metrics.checks.filter((c) => !c.passed)).toEqual([]);
    // One common axis with no margin undercut on any abutment.
    expect(metrics.axis.abutments.map((a) => a.marginUndercutCount)).toEqual(metrics.axis.abutments.map(() => 0));
    // One closed, printable solid.
    expect(metrics.union).toMatchObject({ closed: true, printable: true, selfIntersections: 0, components: 1, genus: 0 });
    // Connectors, measured on the union: at least the material minimum, and 3 mm high.
    expect(metrics.connectors.length).toBe(kind === 'posterior' ? 2 : 3);
    for (const c of metrics.connectors) {
      expect(c.measured!.minAreaMm2).toBeGreaterThanOrEqual(minConnectorAreaMm2('zirconia', c.between[0], c.between[1]));
      expect(c.measured!.heightMm).toBeGreaterThanOrEqual(3);
      expect(c.designed.heightMm).toBeGreaterThanOrEqual(3);
      // Both ends stay clear of their units' fitting surfaces.
      for (const f of c.designed.fitClearanceMm) expect(f).toBeGreaterThanOrEqual(0.2 - 1e-4);
    }
    // The union leaves every retainer's seating unchanged.
    expect(metrics.seating.length).toBe(2);
    for (const s of metrics.seating) {
      expect(s.samples).toBe(s.ownSamples);
      expect(s.deltaMeanMm).toBeLessThanOrEqual(0.005);
      expect(s.deltaMaxMm).toBeLessThanOrEqual(0.005);
    }
    // Pontic bases rest on the ridge at the target gap, and pontic frames follow FDI handedness: mesial points toward
    // the mesial neighbour (35 for 36; 11 and 21, across the midline, for 12 and 22).
    const pontics = metrics.units.filter((u) => u.kind === 'pontic');
    expect(metrics.ponticBase.map((p) => p.fdi)).toEqual(pontics.map((p) => p.fdi));
    for (const p of metrics.ponticBase) {
      expect(p.minGapMm).toBeGreaterThanOrEqual(p.targetMm - 0.02);
      expect(p.minGapMm).toBeLessThanOrEqual(p.targetMm + 0.05);
    }
    for (const p of pontics) {
      const neighbour = metrics.units.find((u) => u.fdi === p.fdi - 1)!;
      const d = neighbour.frame.origin.map((x, i) => x - p.frame.origin[i]!);
      const toward = (p.frame.mesial[0] * d[0]! + p.frame.mesial[1] * d[1]! + p.frame.mesial[2] * d[2]!) / Math.hypot(...d);
      expect(toward).toBeGreaterThan(0.5);
    }
    expect(bridgeStl.byteLength).toBe(84 + 50 * metrics.union!.triangles);

    // A saw cut across the ridge under the pontic (a sectioned model; specs/2026-10-30-pontic-partial-ridge.md): the
    // base spans the hole and still rests on the ridge at the target gap.
    if (kind === 'posterior') {
      const scan = join(dir, kind, SYNTHETIC_BRIDGES.posterior.scan);
      const bytes = readFileSync(scan);
      const n = bytes.readUInt32LE(80);
      const a = syntheticPrepSeed({ fdi: 35, along: 600 }), b = syntheticPrepSeed({ fdi: 37, along: 600 });
      const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const t = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const kept: Buffer[] = [];
      for (let i = 0; i < n; i++) {
        const tri = bytes.subarray(84 + 50 * i, 84 + 50 * (i + 1));
        const x = (tri.readFloatLE(12) + tri.readFloatLE(24) + tri.readFloatLE(36)) / 3, y = (tri.readFloatLE(16) + tri.readFloatLE(28) + tri.readFloatLE(40)) / 3;
        if (Math.abs((x - c[0]!) * t[0]! + (y - c[1]!) * t[1]!) > 0.25) kept.push(tri);
      }
      const head = Buffer.alloc(84);
      head.writeUInt32LE(kept.length, 80);
      writeFileSync(scan, Buffer.concat([head, ...kept]));
      const cut = (await runBridgeCase(spec, join(dir, kind))).metrics;
      for (const p of cut.ponticBase) {
        expect(p.minGapMm).toBeGreaterThanOrEqual(p.targetMm - 0.02);
        expect(p.minGapMm).toBeLessThanOrEqual(p.targetMm + 0.05);
      }
    }
  });

  // Maryland 11w–[12]: a single-retainer cantilever on a wing bonded to 11's palatal surface (wings are the point).
  it('passes every check on the synthetic Maryland bridge, and fails a connector that clashes with the tooth', async () => {
    const caseDir = join(dir, 'maryland');
    const spec = writeSyntheticMarylandCase(caseDir, { along: 600, across: 160 });
    const { metrics, bridgeStl } = await runBridgeCase(spec, caseDir);
    expect(metrics.checks.filter((c) => !c.passed)).toEqual([]);
    expect(metrics.union).toMatchObject({ closed: true, printable: true, selfIntersections: 0, components: 1, genus: 0 });
    // The wing: 0.7 ± 0.02 mm beyond the edge ramp (so never below 0.5 there), on a 0.03 ± 0.01 mm fitting gap, with
    // room against the antagonist in the default synthetic occlusion.
    const [wing] = metrics.wings!;
    expect(wing!.thickness.samples).toBeGreaterThan(0);
    expect(Math.abs(wing!.thickness.minMm - 0.7)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(wing!.thickness.maxMm - 0.7)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(wing!.fit.meanMm - 0.03)).toBeLessThanOrEqual(0.01);
    expect(wing!.fit.maxErrorMm).toBeLessThanOrEqual(0.01);
    expect(wing!.space?.conflict).toBeUndefined();
    expect(wing!.area.bondedMm2).toBeGreaterThan(0);
    // The connector: at least 3 mm high and 2 mm wide on the union, sunk at most 0.5 mm (wing thickness − 0.2) without
    // reaching the fitting surface, and clear of the tooth.
    const [c] = metrics.connectors;
    expect(c!.measured!.heightMm).toBeGreaterThanOrEqual(3);
    expect(c!.measured!.widthMm).toBeGreaterThanOrEqual(2);
    expect(c!.designed.sinkMm[0]).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(c!.designed.fitClearanceMm[0]).toBeGreaterThan(0);
    expect(c!.designed.toothClearance!.clashSamples).toBe(0);
    expect(bridgeStl.byteLength).toBe(84 + 50 * metrics.union!.triangles);
    // Moved 1 mm buccally, past the wing onto the tooth: a tooth clash.
    const moved = await runBridgeCase(spec, caseDir, { connectors: { '11-12': { buccalMm: 1 } } });
    expect(moved.metrics.checks.find((x) => x.id === 'connector.toothClearance.11-12')?.passed).toBe(false);
  });

  // 35i–[36]–37i: MOD inlays as retainers, with the pre-op scan as the outer surface (an exact reference), on the
  // golden case's 2000 × 250 grid.
  it('passes every check on the synthetic inlay bridge, and fails a connector moved out of the proximal box', async () => {
    const caseDir = join(dir, 'inlay');
    const spec = writeSyntheticInlayCase(caseDir, 'preop');
    const { metrics, bridgeStl } = await runBridgeCase(spec, caseDir);
    expect(metrics.checks.filter((c) => !c.passed)).toEqual([]);
    expect(metrics.union).toMatchObject({ closed: true, printable: true, selfIntersections: 0, components: 1, genus: 0 });
    // Each inlay meets the cavity margin within 0.05 mm, is at least 1.5 mm thick over the cavity floor, and its outer
    // surface is the pre-op tooth (mean distance both ways ≤ 0.05 mm).
    expect(metrics.inlays!.map((i) => i.fdi)).toEqual([35, 37]);
    for (const { report, preop } of metrics.inlays!) {
      expect(report.marginFit.maxMm).toBeLessThanOrEqual(0.05);
      expect(report.isthmus.minMm).toBeGreaterThanOrEqual(1.5);
      expect(Math.max(preop!.outerToPreopMm, preop!.preopToOuterMm)).toBeLessThanOrEqual(0.05);
    }
    // Connectors of at least 3 × 3 mm on the union; the inlays still seat on the merged solid.
    for (const c of metrics.connectors) {
      expect(c.measured!.heightMm).toBeGreaterThanOrEqual(3);
      expect(c.measured!.widthMm).toBeGreaterThanOrEqual(3);
    }
    for (const s of metrics.seating) expect(s.ownSamples).toBe(s.samples);
    expect(bridgeStl.byteLength).toBe(84 + 50 * metrics.union!.triangles);
    // Moved 1 mm buccally, the connector leaves 35's proximal box through its wall.
    const moved = await runBridgeCase(spec, caseDir, { connectors: { '35-36': { buccalMm: 1 } } });
    expect(moved.metrics.checks.find((x) => x.id === 'connector.design.35-36')?.passed).toBe(false);
  });

  // The framework variant of 35–[36]–37: reduced crowns and a reduced pontic in CoCr, cut back 1.0 mm, with overpress.
  it('passes every check on the synthetic framework bridge (CoCr)', async () => {
    const spec = writeSyntheticFrameworkCase(join(dir, 'framework'), { along: 600, across: 160 });
    const { metrics, overpressStls } = await runBridgeCase(spec, join(dir, 'framework'));
    expect(metrics.checks.filter((c) => !c.passed)).toEqual([]);
    // The framework bridge is one closed, printable solid; its connectors meet the CoCr minimum.
    expect(metrics.union).toMatchObject({ closed: true, printable: true, components: 1, genus: 0 });
    for (const c of metrics.connectors) expect(c.measured!.minAreaMm2).toBeGreaterThanOrEqual(minConnectorAreaMm2('cocr', c.between[0], c.between[1]));
    // Every unit is reduced: a printable framework at least 0.3 mm thick, veneer never thinner than requested outside
    // the reported shortfall and 1.0 ± 0.05 mm where offset, and a printable overpress part.
    const units = metrics.framework!.units;
    expect(units.map((u) => u.fdi)).toEqual([35, 36, 37]);
    for (const u of units) {
      expect(u.framework.printable).toBe(true);
      expect(u.protection?.minSlackMm ?? 0).toBeGreaterThanOrEqual(-0.02);
      expect(u.veneer.thinVertices).toBe(0);
      expect(u.veneer.offsetWithinTolerance).toBeGreaterThanOrEqual(0.99);
      expect(u.overpress).toMatchObject({ printable: true, components: 1 });
    }
    // Framework ∪ overpress gives the anatomy back.
    expect(metrics.framework!.reassembly!.hausdorffMm).toBeLessThanOrEqual(0.05);
    expect(overpressStls!.length).toBe(3);
  });

  // 35i–[36]–37i on Ti-bases: scan-body registration against the true poses, the common path over 8.7° of divergence,
  // screw channels (35 auto-angled), seating on each Ti-base, one merged solid with a through-hole per channel.
  it('passes every check on the synthetic implant bridge', async () => {
    const spec = await writeSyntheticImplantCase(join(dir, 'implant'), { along: 600, across: 160 });
    const { metrics, bridgeStl } = await runImplantBridgeCase(spec, join(dir, 'implant'));
    expect(metrics.checks.filter((c) => !c.passed)).toEqual([]);
    const implants = metrics.units.filter((u) => u.registration);
    expect(implants.map((u) => u.fdi)).toEqual([35, 37]);
    for (const u of implants) {
      expect(u.registration!.errorMm).toBeLessThanOrEqual(0.02);
      expect(u.registration!.axisErrorDeg).toBeLessThanOrEqual(0.2);
      expect(u.registration!.rmsMm).toBeLessThanOrEqual(0.05);
      expect(u.channel).toMatchObject({ exitOk: true, wallOk: true, cut: true, cutGenus: 1 });
      expect(u.tiBaseGap!.minGapMm).toBeGreaterThan(0);
    }
    expect(Math.abs(metrics.path.divergenceDeg - spec.expect.divergenceDeg!)).toBeLessThanOrEqual(0.3);
    expect(metrics.path.divergenceDeg).toBeLessThan(metrics.path.maxDivergenceDeg);
    expect(metrics.union).toMatchObject({ closed: true, printable: true, components: 1, genus: 2 });
    for (const s of metrics.seating) expect(s.samples).toBe(s.ownSamples);
    expect(metrics.seating.map((s) => s.fdi)).toEqual([35, 37]);
    for (const c of metrics.connectors) expect(c.measuredAreaMm2).toBeGreaterThanOrEqual(minConnectorAreaMm2('zirconia', c.between[0], c.between[1]));
    expect(bridgeStl.byteLength).toBe(84 + 50 * metrics.union!.triangles);
  });
});
