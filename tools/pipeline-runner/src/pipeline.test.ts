import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minConnectorAreaMm2 } from '@dcad/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { runBridgeCase } from './bridgePipeline';
import { writeSyntheticBridgeCase, writeSyntheticCase } from './golden';
import { runCase } from './pipeline';

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
    }
    // The union leaves every retainer's seating unchanged.
    expect(metrics.seating.length).toBe(2);
    for (const s of metrics.seating) {
      expect(s.deltaMeanMm).toBeLessThanOrEqual(0.005);
      expect(s.deltaMaxMm).toBeLessThanOrEqual(0.005);
    }
    // Pontic bases rest on the ridge at the target gap, and pontic frames follow FDI handedness: mesial points toward
    // the mesial neighbour (35 for 36; 11 and 21, across the midline, for 12 and 22).
    const pontics = metrics.units.filter((u) => u.kind === 'pontic');
    expect(metrics.ponticBase.map((p) => p.fdi)).toEqual(pontics.map((p) => p.fdi));
    for (const p of metrics.ponticBase) expect(p.minGapMm).toBeGreaterThanOrEqual(p.targetMm - 0.02);
    for (const p of pontics) {
      const neighbour = metrics.units.find((u) => u.fdi === p.fdi - 1)!;
      const d = neighbour.frame.origin.map((x, i) => x - p.frame.origin[i]!);
      const toward = (p.frame.mesial[0] * d[0]! + p.frame.mesial[1] * d[1]! + p.frame.mesial[2] * d[2]!) / Math.hypot(...d);
      expect(toward).toBeGreaterThan(0.5);
    }
    expect(bridgeStl.byteLength).toBe(84 + 50 * metrics.union!.triangles);
  });
});
