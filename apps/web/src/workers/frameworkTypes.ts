import type { Cutback } from '@dcad/shared';
import type { CrownValidation } from '../geometry/crown';
import type { VeneerShortfall, VeneerStats } from '../geometry/cutback';

/** Messages for framework (reduced) units between the main thread and the geometry worker (geometry/framework.ts). */

/** An overpress part: the unit's anatomy minus its framework (in a bridge, minus the connectors too). */
export interface OverpressView {
  fdi: number;
  positions: Float32Array;
  indices: Uint32Array;
  validation: CrownValidation;
  volumeMm3: number;
  components: number;
  /** Sliver pieces below 0.05 mm that were dropped. */
  dropped: { components: number; volumeMm3: number };
}

/** A reduced unit's framework: the unit's vertices (same indices) with the outer surface cut back, and its report. */
export interface FrameworkView {
  cutback: Cutback;
  /** Framework positions; the unit's indices apply. */
  positions: Float32Array;
  /** Veneer space per unit vertex (mm): measured on the cut-back surface, NaN elsewhere (the veneer colour map). */
  veneer: Float32Array;
  stats: VeneerStats;
  /** "Insufficient veneering space": where the framework minimum leaves less veneer than requested. */
  shortfall?: VeneerShortfall;
  protection?: { retractedVertices: number; pushedVertices: number; maxPushMm: number; minSlackMm: number };
  validation: CrownValidation;
  projectedVertices: number;
  repairedFaces: number;
  warnings: string[];
  /** A single crown designed with `overpress: true`: its overpress part. */
  overpress?: OverpressView;
}
