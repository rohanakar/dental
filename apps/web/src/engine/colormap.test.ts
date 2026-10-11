import { describe, expect, it } from 'vitest';
import { COLOR_MAPS, cssGradient, packScalars, sampleStops } from './colormap';

describe('colour maps', () => {
  it('packs NaN as "no value" and keeps finite values', () => {
    const packed = packScalars(new Float32Array([0.25, Number.NaN, 0]));
    expect([...packed]).toEqual([0.25, 1, 0, 0, 0, 1]);
  });

  it('interpolates stops and clamps outside [0, 1]', () => {
    const stops = [
      [0, '#000000'],
      [1, '#ffffff'],
    ] as const;
    expect(sampleStops(stops, -1).getHexString()).toBe('000000');
    expect(sampleStops(stops, 2).getHexString()).toBe('ffffff');
    const mid = sampleStops(stops, 0.5);
    expect(mid.r).toBeGreaterThan(0.1);
    expect(mid.r).toBeLessThan(0.9);
  });

  it('builds a legend gradient from the same stops as the LUT', () => {
    const css = cssGradient(COLOR_MAPS.undercut);
    expect(css.startsWith('linear-gradient(to right, #3d9a5b 0.0%')).toBe(true);
    expect(css.endsWith('#d64545 100.0%)')).toBe(true);
  });
});
