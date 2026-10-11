import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Fdi, Material, Vec3 } from '@dcad/shared';
import { syntheticArch, syntheticPrepMargin, syntheticPrepSeed, writeBinaryStl } from '@dcad/web/geometry';
import { z } from 'zod';

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
