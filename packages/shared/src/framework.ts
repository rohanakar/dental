import { z } from 'zod';
import { RESTORATION_ROLE, type RestorationType } from './case';

/**
 * Framework restorations (specs/2026-10-25-framework-bridges.md): a reduced
 * crown or pontic is designed as the full anatomy, then cut back by the
 * veneering space, leaving a framework for layered or pressed ceramic. The
 * overpress part is the anatomy minus the framework.
 */

export const CutbackMode = z.enum(['full', 'facial', 'occlusal']);
export type CutbackMode = z.infer<typeof CutbackMode>;

/** Veneering space limits (mm). */
export const CutbackThickness = z.number().min(0.3).max(2);
/** Cervical collar kept at full contour (mm). */
export const CutbackCollar = z.number().min(0).max(2);

/** How a reduced unit is cut back. Stored on the tooth; a reduced unit without it uses CUTBACK_DEFAULTS. */
export const Cutback = z.object({
  /** full: every outer surface but the collar; facial: buccal/labial and the occlusal third; occlusal: the occlusal third. */
  mode: CutbackMode,
  /** Veneering space: how far the outer surface is moved inward. */
  thicknessMm: CutbackThickness,
  /** Collar above the margin kept at full contour. */
  collarMm: CutbackCollar,
  /** Export the overpress part (anatomy minus framework) for pressing; a pressed pontic is a reduced pontic with it. */
  overpress: z.boolean(),
});
export type Cutback = z.infer<typeof Cutback>;

/** Defaults (placeholders, to confirm in domain QA). */
export const CUTBACK_DEFAULTS: Cutback = { mode: 'full', thicknessMm: 1.0, collarMm: 0.8, overpress: false };

/** The veneer space is checked against the requested thickness within this tolerance (mm). */
export const VENEER_TOLERANCE_MM = 0.05;
/** Veneer thicker than this is unsupported porcelain, a fracture risk (mm): reported as a warning. */
export const MAX_UNSUPPORTED_VENEER_MM = 2;

/** A reduced (cut-back) restoration type: designed as the anatomy, delivered as a framework. */
export const isReduced = (type: RestorationType): boolean => Boolean(RESTORATION_ROLE[type].reduced);

/** The anatomic type for a reduced one and the reduced type for an anatomic one (same role); undefined if none. */
export const REDUCED_COUNTERPART: Partial<Record<RestorationType, RestorationType>> = {
  'anatomic-crown': 'reduced-crown',
  'reduced-crown': 'anatomic-crown',
  pontic: 'reduced-pontic',
  'reduced-pontic': 'pontic',
};

/** The restoration type with the given reducedness (same role), or the type itself when it has no counterpart. */
export function withReduced(type: RestorationType, reduced: boolean): RestorationType {
  if (isReduced(type) === reduced) return type;
  return REDUCED_COUNTERPART[type] ?? type;
}

/** The cutback a tooth is designed with: undefined for an anatomic unit, the stored one or the defaults for a reduced unit. */
export function cutbackOf(setup: { teeth: ReadonlyArray<{ fdi: number; restoration: RestorationType }> }, tooth: { fdi: number; cutback?: Cutback }): Cutback | undefined {
  const order = setup.teeth.find((t) => t.fdi === tooth.fdi);
  if (!order || !isReduced(order.restoration)) return undefined;
  return tooth.cutback ?? CUTBACK_DEFAULTS;
}
