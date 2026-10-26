import type { DesignParams } from '@dcad/shared';

/** Defaults of the inlay parameters (DesignParams leaves them optional; geometry/inlay.ts INLAY_DEFAULTS applies the same). */
export const INLAY_PARAM_DEFAULTS: Partial<Record<keyof DesignParams, number>> = { retainerMinThicknessMm: 1.5 };

/** The Parameters step's group for an inlay or onlay. */
export const INLAY_PARAM_GROUP: { title: string; fields: Array<{ key: keyof DesignParams; label: string; hint: string }> } = {
  title: 'Inlay / onlay',
  fields: [{ key: 'retainerMinThicknessMm', label: 'Thickness over the cavity floor', hint: 'The isthmus minimum, from the fitting surface to the outer surface along the axis.' }],
};
