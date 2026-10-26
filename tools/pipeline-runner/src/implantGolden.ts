import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DesignParams, Fdi, FdiPair, Material, ScrewChannel, Vec3 } from '@dcad/shared';
import {
  initMeshBoolean,
  syntheticArch,
  syntheticImplantLibrary,
  syntheticImplantScan,
  writeBinaryStl,
  type SyntheticScanBodyPlacement,
} from '@dcad/web/geometry';
import { z } from 'zod';

/** One unit of a golden implant bridge: implant crowns carry the scan-body click, pontics need nothing. */
export const GoldenImplantUnit = z.object({
  fdi: Fdi,
  restoration: z.enum(['implant-crown', 'pontic']),
  /** Implant crowns: "click the scan body's top" (the frame and the implant position). */
  click: Vec3.optional(),
  /** Implant crowns: the library entry key, e.g. 'synthetic-generic@1/rp-non-engaging'. */
  library: z.string().optional(),
  /** Implant crowns, synthetic cases: the true implant pose, to measure the registration against. */
  truePose: z.object({ origin: Vec3, axis: Vec3, xAxis: Vec3 }).optional(),
  /** Implant crowns: the screw channel; omitted = straight. */
  channel: ScrewChannel.optional(),
});
export type GoldenImplantUnit = z.infer<typeof GoldenImplantUnit>;

/**
 * A golden implant case (case.json with kind 'implant-bridge'): scans with scan bodies, the scripted clicks on them,
 * the connections, and the expected registration accuracy. Implant units have no margin, so it is its own format.
 */
export const GoldenImplantCase = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.literal('implant-bridge'),
  material: Material.default('zirconia'),
  scans: z.object({ upper: z.string().optional(), lower: z.string().optional() }),
  units: z.array(GoldenImplantUnit).min(1),
  connections: z.array(FdiPair).default([]),
  /** Overrides of the material preset's design parameters for every unit. */
  params: DesignParams.partial().optional(),
  expect: z
    .object({
      maxRegistrationErrorMm: z.number().positive().default(0.02),
      maxRegistrationAngleDeg: z.number().positive().default(0.2),
      maxFitRmsMm: z.number().positive().default(0.05),
      /** Expected divergence between the implant axes, ± divergenceToleranceDeg. */
      divergenceDeg: z.number().nonnegative().optional(),
      divergenceToleranceDeg: z.number().positive().default(0.3),
    })
    .prefault({}),
});
export type GoldenImplantCase = z.infer<typeof GoldenImplantCase>;
export type GoldenImplantCaseInput = z.input<typeof GoldenImplantCase>;

/** The synthetic implant bridge 35i–[36]–37i: scan bodies at 35 (5° mesial tilt) and 37 (4° distal, flat at 40°). */
export const SYNTHETIC_IMPLANT_BRIDGE = {
  id: 'synthetic-implant-bridge-35-37',
  scan: 'lower-implants.stl',
  antagonistScan: 'upper.stl',
  library: 'synthetic-generic@1/rp-non-engaging',
  placements: [
    { fdi: 35, mesialTiltDeg: 5, rotationDeg: 0 },
    { fdi: 37, mesialTiltDeg: -4, rotationDeg: 40 },
  ] satisfies SyntheticScanBodyPlacement[],
  pontics: [36],
  connections: [
    [35, 36],
    [36, 37],
  ] as Array<[number, number]>,
} as const;

/**
 * Write the synthetic implant bridge (no patient data) into `dir`: the lower jaw with the two scan bodies merged in
 * (36 missing), a natural antagonist, and case.json with the clicks on the scan-body tops and the true poses.
 * Needs the boolean engine (awaited here).
 */
export async function writeSyntheticImplantCase(dir: string, options: { along?: number; across?: number } = {}): Promise<GoldenImplantCase> {
  await initMeshBoolean();
  const c = SYNTHETIC_IMPLANT_BRIDGE;
  const scan = syntheticImplantScan({
    jaw: 'lower',
    along: options.along ?? 1000,
    across: options.across ?? 500,
    missing: [35, 36, 37],
    scanBodies: [...c.placements],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, c.scan), writeBinaryStl(scan.mesh));
  writeFileSync(join(dir, c.antagonistScan), writeBinaryStl(syntheticArch({ jaw: 'upper', along: 600, across: 250, preps: [] })));
  const entry = syntheticImplantLibrary().entries.find((e) => e.key === c.library)!;
  const units: GoldenImplantUnit[] = [
    ...scan.implants.map(({ fdi, pose, topCentre }) => ({
      fdi,
      restoration: 'implant-crown' as const,
      // A click on the top, as a user would make it (the top centre lies on the scan body's flat top).
      click: [topCentre[0], topCentre[1], topCentre[2]] as [number, number, number],
      library: entry.key,
      truePose: { origin: pose.origin, axis: pose.axis, xAxis: pose.xAxis },
    })),
    ...c.pontics.map((fdi) => ({ fdi, restoration: 'pontic' as const })),
  ].sort((a, b) => a.fdi - b.fdi);
  const [a, b] = scan.implants.map((i) => i.pose.axis);
  const divergenceDeg = (Math.acos(Math.min(1, a![0] * b![0] + a![1] * b![1] + a![2] * b![2])) * 180) / Math.PI;
  const spec: GoldenImplantCaseInput = {
    id: c.id,
    kind: 'implant-bridge',
    material: 'zirconia',
    scans: { lower: c.scan, upper: c.antagonistScan },
    units,
    connections: c.connections,
    // The synthetic arch's teeth are about 0.7× natural size (35 is 4.8 mm wide): the 0.8 mm channel wall is scaled
    // with them. A Ø2.2 channel cannot keep 0.8 mm in a 4.8 mm premolar at any angle (best 0.59 mm at 7.5°).
    params: { channelWallMm: 0.55 },
    expect: { divergenceDeg: Math.round(divergenceDeg * 1000) / 1000 },
  };
  writeFileSync(join(dir, 'case.json'), `${JSON.stringify(spec, null, 2)}\n`);
  return GoldenImplantCase.parse(spec);
}
