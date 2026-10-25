import { describe, expect, it } from 'vitest';
import { rangeT, sampleStops } from '../engine/colormap';
import type { LegendSpec } from './toolStore';
import { crownMapLegend, WARNING_COLOR } from './crownLegend';

const params = { minThicknessMm: 0.5, occlusalClearanceMm: 0.05, proximalContactMm: 0.02 };
const NEUTRAL = 'f4f1ea';
const colourAt = (legend: LegendSpec, value: number) => sampleStops(legend.stops!, rangeT(legend.range, value)).getHexString();

describe('crown colour maps', () => {
  it('draw contact (0 mm) in the neutral colour and material thinner than the minimum in the warning colour', () => {
    const occlusion = crownMapLegend('occlusion', params);
    expect(colourAt(occlusion, 0)).toBe(NEUTRAL);
    expect(colourAt(occlusion, -0.1)).not.toBe(NEUTRAL);
    expect(occlusion.ticks?.map((t) => t.value)).toEqual([0, 0.05]);

    const thickness = crownMapLegend('thickness', params);
    expect(colourAt(thickness, 0.45)).toBe(WARNING_COLOR.slice(1));
    expect(colourAt(thickness, 0.6)).not.toBe(WARNING_COLOR.slice(1));
  });
});
