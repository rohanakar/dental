import type { DesignParams } from '@dcad/shared';
import { COLOR_MAPS, centerStops, thresholdStops } from '../engine/colormap';
import type { CrownMapName } from '../workers/analysisTypes';
import type { LegendSpec } from './toolStore';

/** Below the material minimum, and penetration: the one warning colour of the crown maps. */
export const WARNING_COLOR = '#c0392b';

/** How each crown map is shown: title, range and end labels (the stops and ticks depend on the tooth). */
export const CROWN_MAPS: Record<CrownMapName, LegendSpec> = {
  thickness: { title: 'Material thickness', map: 'sequential', range: [0, 2], unit: 'mm', lowLabel: 'thin', highLabel: 'thick' },
  occlusion: { title: 'Occlusal clearance', map: 'diverging', range: [-0.2, 0.5], unit: 'mm', lowLabel: 'penetration', highLabel: 'gap' },
  proximal: { title: 'Proximal clearance', map: 'diverging', range: [-0.2, 0.5], unit: 'mm', lowLabel: 'penetration', highLabel: 'gap' },
  unmillable: { title: 'Unmillable (tool radius)', map: 'undercut', range: [0, 0.2], unit: 'mm', lowLabel: 'millable', highLabel: 'unreachable' },
};

const mm = (v: number) => `${Number(v.toFixed(2))} mm`;

/**
 * The legend (and the stops the viewer draws) of a crown map for this tooth:
 * clearance maps are neutral at contact (0 mm) with the adaptation target
 * marked; the thickness map shows anything thinner than the material minimum
 * in the warning colour.
 */
export function crownMapLegend(
  map: CrownMapName,
  params: Pick<DesignParams, 'minThicknessMm' | 'occlusalClearanceMm' | 'proximalContactMm'>,
  targets: { occlusion?: number; contact?: number } = {},
): LegendSpec {
  const spec = CROWN_MAPS[map];
  switch (map) {
    case 'occlusion':
    case 'proximal': {
      const target = map === 'occlusion' ? (targets.occlusion ?? params.occlusalClearanceMm) : (targets.contact ?? params.proximalContactMm);
      return {
        ...spec,
        stops: centerStops(COLOR_MAPS.diverging, spec.range, 0),
        ticks: [{ value: 0, label: `${mm(0)} contact` }, ...(target !== 0 ? [{ value: target, label: `${mm(target)} target`, dashed: true }] : [])],
      };
    }
    case 'thickness':
      return {
        ...spec,
        stops: thresholdStops(COLOR_MAPS.sequential, spec.range, params.minThicknessMm, WARNING_COLOR),
        // The margin band is thinner by design (margin thickness); the minimum applies away from it.
        ticks: [{ value: params.minThicknessMm, label: `${mm(params.minThicknessMm)} minimum, margin band exempt` }],
      };
    default:
      return spec;
  }
}
