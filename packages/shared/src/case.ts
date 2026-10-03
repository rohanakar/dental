import { z } from 'zod';

/** FDI two-digit tooth number: quadrant 1-4, position 1-8. */
export const Fdi = z
  .number()
  .int()
  .min(11)
  .max(48)
  .refine((n) => {
    const q = Math.floor(n / 10);
    const p = n % 10;
    return q >= 1 && q <= 4 && p >= 1 && p <= 8;
  }, 'FDI tooth number (11-18, 21-28, 31-38, 41-48)');
export type Fdi = z.infer<typeof Fdi>;

export type Jaw = 'upper' | 'lower';
export const jawOf = (fdi: number): Jaw => (Math.floor(fdi / 10) <= 2 ? 'upper' : 'lower');
/** MVP scope: premolars and molars (positions 4-8). */
export const isPosterior = (fdi: number): boolean => fdi % 10 >= 4;

export const RestorationType = z.enum(['anatomic-crown']);
export type RestorationType = z.infer<typeof RestorationType>;

export const Material = z.enum(['zirconia', 'lithium-disilicate', 'pmma']);
export type Material = z.infer<typeof Material>;

export const DesignParams = z.object({
  /** Cement gap applied beyond the margin ramp. */
  cementGapMm: z.number().min(0).max(0.3),
  /** Additional spacer applied beyond distanceToMarginMm. */
  extraSpacerMm: z.number().min(0).max(0.3),
  /** Distance from the margin where the extra spacer starts. */
  distanceToMarginMm: z.number().min(0).max(3),
  /** Restoration thickness at the margin. */
  marginThicknessMm: z.number().min(0).max(1),
  /** Minimum restoration thickness away from the margin. */
  minThicknessMm: z.number().min(0.2).max(3),
  /** Milling tool radius; used only for the "unmillable" map, not for compensation. */
  toolRadiusMm: z.number().min(0).max(1.5),
  /** Target occlusal clearance to the antagonist (negative = intentional contact). */
  occlusalClearanceMm: z.number().min(-0.2).max(1),
  /** Target proximal contact distance to neighbours (negative = tighter contact). */
  proximalContactMm: z.number().min(-0.2).max(0.5),
});
export type DesignParams = z.infer<typeof DesignParams>;

export const MATERIAL_PRESETS: Record<Material, DesignParams> = {
  zirconia: {
    cementGapMm: 0.03,
    extraSpacerMm: 0.04,
    distanceToMarginMm: 1.0,
    marginThicknessMm: 0.1,
    minThicknessMm: 0.5,
    toolRadiusMm: 0.5,
    occlusalClearanceMm: 0.05,
    proximalContactMm: 0.02,
  },
  'lithium-disilicate': {
    cementGapMm: 0.04,
    extraSpacerMm: 0.05,
    distanceToMarginMm: 1.0,
    marginThicknessMm: 0.15,
    minThicknessMm: 1.0,
    toolRadiusMm: 0.5,
    occlusalClearanceMm: 0.05,
    proximalContactMm: 0.02,
  },
  pmma: {
    cementGapMm: 0.05,
    extraSpacerMm: 0.05,
    distanceToMarginMm: 1.0,
    marginThicknessMm: 0.2,
    minThicknessMm: 1.0,
    toolRadiusMm: 0.5,
    occlusalClearanceMm: 0.05,
    proximalContactMm: 0.02,
  },
};

export const ToothOrder = z.object({
  fdi: Fdi,
  restoration: RestorationType,
  material: Material,
  shade: z.string().max(32).optional(),
});
export type ToothOrder = z.infer<typeof ToothOrder>;

/**
 * Case setup as entered by the user or extracted from an Rx by the LLM.
 * patientRef is a pseudonymous reference; never a patient name.
 */
export const CaseSetup = z.object({
  patientRef: z.string().max(64),
  teeth: z.array(ToothOrder).min(1),
  notes: z.string().max(4000).default(''),
});
export type CaseSetup = z.infer<typeof CaseSetup>;
