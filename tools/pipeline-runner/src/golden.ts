import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Fdi, FdiPair, jawOf, Material, RestorationType, Vec3 } from '@dcad/shared';
import { syntheticArch, syntheticPrepMargin, syntheticPrepSeed, writeBinaryStl } from '@dcad/web/geometry';
import { z } from 'zod';

/** One unit of a golden bridge. Abutments carry the scripted clicks; pontics need none (they are laid out on the arch). */
export const GoldenBridgeUnit = z.object({
  fdi: Fdi,
  /** The restoration type; its role (RESTORATION_ROLE) makes the unit an abutment or a pontic. */
  restoration: RestorationType,
  /** Abutments: "click the prep". */
  seed: Vec3.optional(),
  /** Abutments: margin anchor clicks, in order around the prep. */
  marginAnchors: z.array(Vec3).min(3).optional(),
  /** Abutments: reference margin (closed polyline). */
  marginRing: z.array(Vec3).min(3).optional(),
});
export type GoldenBridgeUnit = z.infer<typeof GoldenBridgeUnit>;

/**
 * A golden case: de-identified scans plus scripted user input (the click on
 * the prep and the margin anchor clicks) and optional expectations.
 * Stored as data/golden/<id>/case.json next to the scan files.
 */
export const GoldenCase = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  fdi: Fdi,
  material: Material.default('zirconia'),
  /** Scan file names relative to the case directory (STL or PLY). The prep jaw must be present. */
  scans: z.object({ upper: z.string().optional(), lower: z.string().optional() }),
  /** "Click the prep" point for the tooth frame. */
  seed: Vec3,
  /** Margin anchor clicks, in order around the prep. */
  marginAnchors: z.array(Vec3).min(3),
  expect: z
    .object({
      /** Reference margin (closed polyline) to measure the traced margin against. */
      marginRing: z.array(Vec3).min(3).optional(),
      maxMeanMarginDeviationMm: z.number().positive().default(0.15),
      maxMaxMarginDeviationMm: z.number().positive().default(0.5),
      /** Expected occlusal direction (approximate); checked with minOcclusalDot. */
      occlusal: Vec3.optional(),
      minOcclusalDot: z.number().min(-1).max(1).default(0.9),
      contacts: z.object({ mesial: z.boolean(), distal: z.boolean() }).optional(),
      maxAxisAngleDeg: z.number().positive().optional(),
      maxUndercutAreaMm2: z.number().nonnegative().optional(),
      maxMarginUndercutPoints: z.number().int().nonnegative().default(0),
    })
    .prefault({}),
  /**
   * A bridge case: its units (in any order) and connections, as in CaseSetup. The single-crown fields above then
   * describe the first abutment, and the runner designs the whole bridge (runBridgeCase).
   */
  bridge: z
    .object({
      units: z.array(GoldenBridgeUnit).min(2),
      connections: z.array(FdiPair).min(1),
    })
    .optional(),
});
export type GoldenCase = z.infer<typeof GoldenCase>;
export type GoldenCaseInput = z.input<typeof GoldenCase>;

const toVec3s = (packed: Float32Array): Array<[number, number, number]> =>
  Array.from({ length: packed.length / 3 }, (_, i) => [packed[i * 3]!, packed[i * 3 + 1]!, packed[i * 3 + 2]!]);

/**
 * Write the synthetic FDI 36 golden case (no patient data) into `dir`:
 * lower.stl (with the prep), upper.stl, and case.json with the analytic
 * margin ring as the reference. Default resolution matches the in-app demo
 * (~1M triangles for the lower jaw).
 */
export function writeSyntheticCase(dir: string, options: { along?: number; across?: number } = {}): GoldenCase {
  const along = options.along ?? 1000;
  const across = options.across ?? 500;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'lower.stl'), writeBinaryStl(syntheticArch({ jaw: 'lower', along, across })));
  writeFileSync(join(dir, 'upper.stl'), writeBinaryStl(syntheticArch({ jaw: 'upper', along: 600, across: 250 })));
  const anchors = toVec3s(syntheticPrepMargin({ along, samples: 8 }));
  const spec: GoldenCaseInput = {
    id: 'synthetic-36',
    fdi: 36,
    material: 'zirconia',
    scans: { lower: 'lower.stl', upper: 'upper.stl' },
    seed: syntheticPrepSeed({ along }),
    marginAnchors: anchors,
    expect: {
      marginRing: toVec3s(syntheticPrepMargin({ along, samples: 512 })),
      occlusal: [0, 0, 1],
      contacts: { mesial: true, distal: true },
      maxAxisAngleDeg: 5,
      maxUndercutAreaMm2: 0.05,
    },
  };
  writeFileSync(join(dir, 'case.json'), `${JSON.stringify(spec, null, 2)}\n`);
  return GoldenCase.parse(spec);
}

export type SyntheticBridgeKind = 'posterior' | 'anterior';

/** The synthetic bridges: posterior 35–[36]–37 (lower) and anterior [12]–11–21–[22] (upper: midline, two cantilevers). */
export const SYNTHETIC_BRIDGES: Record<
  SyntheticBridgeKind,
  { id: string; preps: number[]; missing: number[]; scan: string; antagonistScan: string; connections: Array<[number, number]> }
> = {
  posterior: {
    id: 'synthetic-bridge-35-37',
    preps: [35, 37],
    missing: [36],
    scan: 'lower-bridge.stl',
    antagonistScan: 'upper.stl',
    connections: [
      [35, 36],
      [36, 37],
    ],
  },
  anterior: {
    id: 'synthetic-bridge-12-22',
    preps: [11, 21],
    missing: [12, 22],
    scan: 'upper-anterior-bridge.stl',
    antagonistScan: 'lower.stl',
    connections: [
      [11, 12],
      [11, 21],
      [21, 22],
    ],
  },
};

/** The prep jaw of a synthetic bridge (also written by tools/fixtures as a demo scan). */
export function syntheticBridgeScan(kind: SyntheticBridgeKind, options: { along?: number; across?: number } = {}) {
  const { preps, missing } = SYNTHETIC_BRIDGES[kind];
  return syntheticArch({ jaw: jawOf(preps[0]!), along: options.along ?? 1000, across: options.across ?? 500, preps, missing });
}

/**
 * Write a synthetic bridge golden case (no patient data) into `dir`: the prep
 * jaw with its preps and edentulous ridge, a natural antagonist, and
 * case.json with the scripted clicks and analytic margin rings per abutment.
 * Default resolution matches the in-app demo (~1M triangles for the prep jaw).
 */
export function writeSyntheticBridgeCase(dir: string, kind: SyntheticBridgeKind, options: { along?: number; across?: number } = {}): GoldenCase {
  const along = options.along ?? 1000;
  const bridge = SYNTHETIC_BRIDGES[kind];
  const jaw = jawOf(bridge.preps[0]!);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, bridge.scan), writeBinaryStl(syntheticBridgeScan(kind, options)));
  const antagonist = syntheticArch({ jaw: jaw === 'lower' ? 'upper' : 'lower', along: 600, across: 250, preps: [] });
  writeFileSync(join(dir, bridge.antagonistScan), writeBinaryStl(antagonist));
  const units = [...bridge.preps, ...bridge.missing]
    .sort((a, b) => a - b)
    .map((fdi) =>
      bridge.preps.includes(fdi)
        ? {
            fdi,
            restoration: 'anatomic-crown' as const,
            seed: syntheticPrepSeed({ fdi, along }),
            marginAnchors: toVec3s(syntheticPrepMargin({ fdi, along, samples: 8 })),
            marginRing: toVec3s(syntheticPrepMargin({ fdi, along, samples: 512 })),
          }
        : { fdi, restoration: 'pontic' as const },
    );
  const first = units.find((u) => u.restoration === 'anatomic-crown')!;
  const spec: GoldenCaseInput = {
    id: bridge.id,
    fdi: first.fdi,
    material: 'zirconia',
    scans: jaw === 'lower' ? { lower: bridge.scan, upper: bridge.antagonistScan } : { upper: bridge.scan, lower: bridge.antagonistScan },
    seed: first.seed!,
    marginAnchors: first.marginAnchors!,
    bridge: { units, connections: bridge.connections },
  };
  writeFileSync(join(dir, 'case.json'), `${JSON.stringify(spec, null, 2)}\n`);
  return GoldenCase.parse(spec);
}
