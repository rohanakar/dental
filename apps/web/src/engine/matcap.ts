import { DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';

/** Base colors (sRGB 0-1) for the procedural matcaps. */
export const MATCAP_PRESETS = {
  /** Dental stone / plaster for jaw scans. */
  stone: [0.86, 0.82, 0.74],
  /**
   * Design blue for restorations: clearly apart from the stone-coloured scans
   * in hue and lightness (ΔE76 ≈ 40; the old tooth white was 11), so the crown
   * never reads as part of the prep.
   */
  restoration: [0.62, 0.76, 0.95],
  /** Neutral, used when showing scanner vertex colors. */
  neutral: [0.95, 0.95, 0.95],
} as const satisfies Record<string, readonly [number, number, number]>;

export type MatcapPreset = keyof typeof MATCAP_PRESETS;

const norm = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Procedural matcap: a lit sphere rendered into a texture. Lighting is
 * baked in, so shading is fast and identical from every camera angle, which
 * keeps scan detail (margins, cusps) easy to read. No binary assets.
 */
export function createMatcap(base: readonly [number, number, number], size = 256): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const key = norm([-0.45, 0.6, 0.75]);
  const fill = norm([0.6, -0.25, 0.6]);
  const half = norm([key[0], key[1], key[2] + 1]);
  const ambient = 0.28;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let x = ((i + 0.5) / size) * 2 - 1;
      let y = ((j + 0.5) / size) * 2 - 1;
      const r2 = x * x + y * y;
      if (r2 > 1) {
        const r = Math.sqrt(r2);
        x /= r;
        y /= r;
      }
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      const diffKey = Math.max(0, x * key[0] + y * key[1] + z * key[2]);
      const diffFill = Math.max(0, x * fill[0] + y * fill[1] + z * fill[2]);
      const spec = Math.pow(Math.max(0, x * half[0] + y * half[1] + z * half[2]), 48) * 0.28;
      const rim = Math.pow(1 - z, 3) * 0.12;
      const light = ambient + (1 - ambient) * (0.78 * diffKey + 0.3 * diffFill);
      const o = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) {
        const v = base[c]! * light + spec + rim;
        data[o + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
      data[o + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
