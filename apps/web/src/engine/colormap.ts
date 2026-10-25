import { Color, DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';

/** Colour stops: position in [0, 1] and an sRGB hex colour. */
export type ColorStops = ReadonlyArray<readonly [number, string]>;

export type ColorMapName = 'undercut' | 'diverging' | 'sequential';

export interface ColorMapSpec {
  stops: ColorStops;
  /** Shown in the legend. */
  label: string;
  unit: string;
}

/**
 * Colour maps for scalar overlays (undercut depth, later thickness, occlusal
 * clearance, contacts). The same stops drive the shader LUT and the CSS
 * gradient in the legend, so the two always match.
 */
export const COLOR_MAPS: Record<ColorMapName, ColorStops> = {
  // 0 = visible from the insertion direction (fine), rising = deeper blockout.
  undercut: [
    [0, '#3d9a5b'],
    [0.08, '#a7c94a'],
    [0.3, '#f2c94c'],
    [0.6, '#f08a3c'],
    [1, '#d64545'],
  ],
  // Negative = penetration, the neutral middle = contact, positive = gap. Re-centre with centerStops() when the
  // range is not symmetric about the neutral value.
  diverging: [
    [0, '#c0392b'],
    [0.25, '#f39c6b'],
    [0.5, '#f4f1ea'],
    [0.75, '#7fb3e0'],
    [1, '#2e6bb5'],
  ],
  // Low (just enough) warm to high (ample) cool; see thresholdStops() for "below the limit".
  sequential: [
    [0, '#f2e394'],
    [0.5, '#7fd1c4'],
    [1, '#2e6bb5'],
  ],
};

/** Position of `value` within `range`, as t ∈ [0, 1]. */
export const rangeT = (range: readonly [number, number], value: number): number =>
  Math.min(1, Math.max(0, (value - range[0]) / (range[1] - range[0])));

/**
 * Re-space diverging stops so their neutral middle (t = 0.5) falls on `value`
 * within `range`; each half keeps its own stops, compressed or stretched.
 * Without this an asymmetric range (−0.2…0.5 mm) puts the neutral colour at
 * +0.15 mm instead of at contact.
 */
export function centerStops(stops: ColorStops, range: readonly [number, number], value: number): ColorStops {
  const c = rangeT(range, value);
  return stops.map(([t, color]) => [t <= 0.5 ? (t / 0.5) * c : c + ((t - 0.5) / 0.5) * (1 - c), color] as const);
}

/**
 * Everything below `value` in `color` (a hard edge), the given stops spread
 * over the rest of `range`; e.g. material thinner than the minimum.
 */
export function thresholdStops(stops: ColorStops, range: readonly [number, number], value: number, color: string): ColorStops {
  const c = rangeT(range, value);
  return [[0, color], [c, color], ...stops.map(([t, s]) => [c + t * (1 - c), s] as const)];
}

/** Linear interpolation of sRGB stops at t ∈ [0, 1]. */
export function sampleStops(stops: ColorStops, t: number): Color {
  const x = Math.min(1, Math.max(0, t));
  let i = 0;
  while (i < stops.length - 2 && stops[i + 1]![0] < x) i++;
  const [t0, c0] = stops[i]!;
  const [t1, c1] = stops[Math.min(i + 1, stops.length - 1)]!;
  const f = t1 > t0 ? (x - t0) / (t1 - t0) : 0;
  return new Color(c0).lerp(new Color(c1), Math.min(1, Math.max(0, f)));
}

/** 256×1 lookup texture for the surface shader. */
export function createLutTexture(stops: ColorStops): DataTexture {
  const size = 256;
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    // Color stores linear components; convert back to sRGB bytes for an sRGB texture.
    const c = sampleStops(stops, i / (size - 1)).convertLinearToSRGB();
    data[i * 4] = Math.round(c.r * 255);
    data[i * 4 + 1] = Math.round(c.g * 255);
    data[i * 4 + 2] = Math.round(c.b * 255);
    data[i * 4 + 3] = 255;
  }
  const texture = new DataTexture(data, size, 1, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** CSS linear-gradient for the legend. */
export function cssGradient(stops: ColorStops, direction = 'to right'): string {
  return `linear-gradient(${direction}, ${stops.map(([t, c]) => `${c} ${(t * 100).toFixed(1)}%`).join(', ')})`;
}

/**
 * Pack per-vertex scalars for the shader: (value, hasValue) pairs. NaN means
 * "no value" and leaves the surface untinted; the mask is interpolated, so
 * the boundary of a mapped region falls mid-triangle instead of smearing.
 */
export function packScalars(values: Float32Array): Float32Array {
  const out = new Float32Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const has = Number.isFinite(v);
    out[i * 2] = has ? v : 0;
    out[i * 2 + 1] = has ? 1 : 0;
  }
  return out;
}
