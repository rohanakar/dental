import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minConnectorAreaMm2 } from '@dcad/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { runBridgeCase } from './bridgePipeline';
import { writeSyntheticFrameworkCase } from './frameworkGolden';
import { writeSyntheticBridgeCase, writeSyntheticCase } from './golden';
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
