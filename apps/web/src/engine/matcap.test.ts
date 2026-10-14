import { describe, expect, it } from 'vitest';
import { MATCAP_PRESETS } from './matcap';

/** sRGB (0–1) → CIELAB (D65). */
function lab([r, g, b]: readonly number[]): [number, number, number] {
  const lin = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r!), lin(g!), lin(b!)];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

describe('matcap colours', () => {
  it('keeps the crown clearly apart from the scans (ΔE76 ≥ 30)', () => {
    const a = lab(MATCAP_PRESETS.restoration);
    const b = lab(MATCAP_PRESETS.stone);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThanOrEqual(30);
  });
});
