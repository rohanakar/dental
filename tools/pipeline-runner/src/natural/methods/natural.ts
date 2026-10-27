import { naturalMargin, sharpestTurnDeg } from '@dcad/web/geometry';
import type { NaturalMethod } from '../bench';

/** The shipped natural-tooth margin (apps/web/src/geometry/naturalMargin.ts): probe-centred crease walker. */
export const method: NaturalMethod = (c) => {
  const r = naturalMargin({ positions: c.positions, indices: c.indices, graph: c.surface.graph, curvature: c.surface.curvature, ray: c.ray, frame: c.frame, fdi: c.fdi });
  return {
    points: r.points,
    note: `loops ${r.loops}, winding ${r.winding}, probe ${r.probeShiftMm.toFixed(2)}, recentre ${r.recentreShiftMm.toFixed(2)}, agree ${r.agreementMm.toFixed(2)}, perim ${r.perimeterRatio.toFixed(2)}, turn ${Math.round(sharpestTurnDeg(r.points))}, length ${r.lengthMm.toFixed(1)}`,
  };
};
