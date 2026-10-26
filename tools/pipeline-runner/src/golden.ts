import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cutback, Fdi, FdiPair, jawOf, Material, OuterSource, RestorationType, Vec3 } from '@dcad/shared';
import {
  bvhRayCaster,
  createBvh,
  syntheticArch,
  syntheticCavityMargin,
  syntheticCavitySeed,
  syntheticPreop,
  syntheticPrepMargin,
  syntheticPrepSeed,
  syntheticWingOutline,
  writeBinaryStl,
} from '@dcad/web/geometry';
import { z } from 'zod';

/** One unit of a golden bridge. Abutments carry the scripted clicks; pontics need none (they are laid out on the arch). */
export const GoldenBridgeUnit = z.object({
  fdi: Fdi,
  /** The restoration type; its role (RESTORATION_ROLE) makes the unit an abutment or a pontic. */
  restoration: RestorationType,
  /** Abutments: "click the prep" (a Maryland wing: the click on the lingual surface, inside the outline). */
  seed: Vec3.optional(),
  /** Abutments: margin anchor clicks, in order around the prep (a Maryland wing: the wing outline). */
  marginAnchors: z.array(Vec3).min(3).optional(),
  /** Abutments: reference margin (closed polyline). */
  marginRing: z.array(Vec3).min(3).optional(),
  /** Inlays and onlays: where the outer surface comes from (omitted = the pre-op scan when the case has one). */
  outerSource: OuterSource.optional(),
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
  scans: z.object({ upper: z.string().optional(), lower: z.string().optional(), /** Inlays: the pre-op scan of the prep jaw. */ preop: z.string().optional() }),
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
      /** Reduced units (reduced-crown, reduced-pontic): their cutback; omitted = CUTBACK_DEFAULTS. */
      cutback: Cutback.optional(),
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

/** The synthetic Maryland bridge: upper 11w–[12], a single-retainer cantilever with the wing on 11's palatal surface. */
export const SYNTHETIC_MARYLAND = {
  id: 'synthetic-maryland-11-12',
  wing: 11,
  pontic: 12,
  scan: 'upper-maryland.stl',
  antagonistScan: 'lower.stl',
} as const;

/** The jaw of the synthetic Maryland bridge: the upper arch with 12 missing and every other tooth unprepared. */
export const syntheticMarylandScan = (options: { along?: number; across?: number } = {}) =>
  syntheticArch({ jaw: 'upper', along: options.along ?? 1000, across: options.across ?? 500, preps: [], missing: [SYNTHETIC_MARYLAND.pontic] });

/**
 * Write the synthetic Maryland golden case (no patient data) into `dir`: the
 * upper jaw with 12 missing, the natural lower arch as the antagonist, and
 * case.json with the scripted wing outline on 11's palatal surface
 * (syntheticWingOutline) and the click inside it.
 */
export function writeSyntheticMarylandCase(dir: string, options: { along?: number; across?: number } = {}): GoldenCase {
  const along = options.along ?? 1000;
  const m = SYNTHETIC_MARYLAND;
  mkdirSync(dir, { recursive: true });
  const jaw = syntheticMarylandScan(options);
  writeFileSync(join(dir, m.scan), writeBinaryStl(jaw));
  writeFileSync(join(dir, m.antagonistScan), writeBinaryStl(syntheticArch({ jaw: 'lower', along: 600, across: 250, preps: [] })));
  const ray = bvhRayCaster(createBvh({ positions: jaw.positions, indices: jaw.indices.slice() }));
  const outline = syntheticWingOutline({ fdi: m.wing, ray, toward: 'distal', along });
  const wing = { fdi: m.wing, restoration: 'maryland-wing' as const, seed: outline.seed, marginAnchors: outline.anchors };
  const spec: GoldenCaseInput = {
    id: m.id,
    fdi: m.wing,
    material: 'zirconia',
    scans: { upper: m.scan, lower: m.antagonistScan },
    seed: wing.seed,
    marginAnchors: wing.marginAnchors,
    bridge: { units: [wing, { fdi: m.pontic, restoration: 'pontic' }], connections: [[m.wing, m.pontic]] },
  };
  writeFileSync(join(dir, 'case.json'), `${JSON.stringify(spec, null, 2)}\n`);
  return GoldenCase.parse(spec);
}

/**
 * The synthetic inlay bridge: lower 35–[36]–37 with MOD cavities on 35 and 37 and 36 missing, designed once with the
 * pre-op scan and once with the library tooth as the outer surface. The scan is 2000 × 250 (1M triangles, about
 * 0.06 × 0.05 mm cells). On the 1000 × 500 grid (0.12 mm rows) the margins still fit exactly, but 37's restoration
 * intersects itself and the 35–36 connector has less than 3 mm of height.
 */
export const SYNTHETIC_INLAY = {
  id: 'synthetic-inlay-bridge-35-37',
  libraryId: 'synthetic-inlay-bridge-35-37-library',
  cavities: [
    { fdi: 35, kind: 'mod' },
    { fdi: 37, kind: 'mod' },
  ] as Array<{ fdi: number; kind: 'mod' }>,
  missing: [36],
  scan: 'lower-inlay.stl',
  preopScan: 'lower-inlay-preop.stl',
  antagonistScan: 'upper.stl',
  along: 2000,
  across: 250,
} as const;

/** The jaw of the synthetic inlay bridge (with the cavities) and its pre-op scan (the same arch without them). */
export function syntheticInlayScans(options: { along?: number; across?: number } = {}) {
  const i = SYNTHETIC_INLAY;
  const base = { jaw: 'lower' as const, along: options.along ?? i.along, across: options.across ?? i.across, preps: [], missing: [...i.missing], cavities: i.cavities };
  return { jaw: syntheticArch(base), preop: syntheticPreop(base) };
}

/**
 * Write the synthetic inlay bridge (no patient data) into `dir`: the lower jaw with the MOD cavities on 35 and 37 and
 * 36 missing, its pre-op scan, the natural upper arch as the antagonist, and case.json with scripted cavity-margin
 * anchors (16 analytic samples) and the click on each cavity floor; `source` picks the outer surface.
 */
export function writeSyntheticInlayCase(dir: string, source: 'preop' | 'library', options: { along?: number; across?: number } = {}): GoldenCase {
  const i = SYNTHETIC_INLAY;
  const along = options.along ?? i.along;
  mkdirSync(dir, { recursive: true });
  const { jaw, preop } = syntheticInlayScans(options);
  writeFileSync(join(dir, i.scan), writeBinaryStl(jaw));
  writeFileSync(join(dir, i.preopScan), writeBinaryStl(preop));
  writeFileSync(join(dir, i.antagonistScan), writeBinaryStl(syntheticArch({ jaw: 'upper', along: 600, across: 250, preps: [] })));
  const retainers = i.cavities.map((c) => ({
    fdi: c.fdi,
    restoration: 'inlay' as const,
    seed: syntheticCavitySeed({ ...c, along }),
    marginAnchors: toVec3s(syntheticCavityMargin({ ...c, along, samples: 16 })),
    marginRing: toVec3s(syntheticCavityMargin({ ...c, along, samples: 512 })),
    outerSource: source,
  }));
  const spec: GoldenCaseInput = {
    id: source === 'preop' ? i.id : i.libraryId,
    fdi: retainers[0]!.fdi,
    material: 'zirconia',
    scans: { lower: i.scan, upper: i.antagonistScan, preop: i.preopScan },
    seed: retainers[0]!.seed,
    marginAnchors: retainers[0]!.marginAnchors,
    bridge: {
      units: [retainers[0]!, { fdi: 36, restoration: 'pontic' as const }, retainers[1]!],
      connections: [
        [35, 36],
        [36, 37],
      ],
    },
  };
  writeFileSync(join(dir, 'case.json'), `${JSON.stringify(spec, null, 2)}\n`);
  return GoldenCase.parse(spec);
}
