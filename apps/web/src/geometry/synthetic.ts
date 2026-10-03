import type { IndexedMesh } from './mesh';

/**
 * Synthetic dental-arch-like surface for tests and demos (no patient data).
 * An open U-shaped band with tooth-shaped domes; optionally the lower-left
 * first molar (FDI 36) is replaced by a crown prep (tapered stump with a
 * margin shoulder). Units are mm, occlusal direction is +z for the lower jaw.
 */
export interface ArchOptions {
  jaw?: 'lower' | 'upper';
  /** Grid segments along the arch. Triangles = 2 × along × across. */
  along?: number;
  across?: number;
  withPrep?: boolean;
  colors?: boolean;
}

const RX = 24;
const RY = 26;
const THETA_MAX = 1.65;
const HALF_WIDTH = 6;
/** Mesio-distal widths from the midline back: central, lateral, canine, PM1, PM2, M1, M2. */
const TOOTH_WIDTHS = [8.5, 6.5, 7, 7, 7, 11, 10];
const TOOTH_HEIGHT = [6, 5.5, 7, 6.5, 6.5, 6, 5.5];
const BL_HALF = [3, 3, 3.6, 4, 4.2, 5, 4.8];
/** Occlusal gap between the synthetic upper and lower arches. */
const OCCLUSAL_GAP = 0.3;

function archPoint(theta: number): [number, number] {
  return [RX * Math.sin(theta), RY * Math.cos(theta)];
}

function toothHeight(m: number, b: number, type: number, prep: boolean): number {
  // Superellipse footprint.
  const r = Math.pow(Math.pow(Math.abs(m), 4) + Math.pow(Math.abs(b), 4), 0.25);
  if (r >= 1) return 0;
  if (prep) {
    // Tapered stump: flat-ish top, steep walls, shoulder at r≈0.92.
    if (r < 0.7) return 4.2 - 0.6 * r * r;
    if (r < 0.9) return 3.9 - ((r - 0.7) / 0.2) * 3.2;
    return 0.7 * (1 - (r - 0.9) / 0.1);
  }
  const h = TOOTH_HEIGHT[type]!;
  let z = h * Math.sqrt(1 - Math.pow(r, 4));
  if (type >= 3) {
    // Cusps for premolars and molars.
    const cuspsMd = type >= 5 ? 2 : 1;
    z -= 0.7 * Math.pow(Math.max(0, 1 - r), 0.5) * (0.5 - 0.5 * Math.cos(Math.PI * (m * cuspsMd + 1))) * (0.5 + 0.5 * Math.cos(Math.PI * b * 1.6));
  }
  return z;
}

export function syntheticArch(options: ArchOptions = {}): IndexedMesh {
  const along = options.along ?? 400;
  const across = options.across ?? 120;
  const jaw = options.jaw ?? 'lower';
  const withPrep = options.withPrep ?? jaw === 'lower';

  // Arc length table along theta for placing teeth by mesio-distal width.
  const thetas = new Float64Array(along + 1);
  const arc = new Float64Array(along + 1);
  for (let i = 0; i <= along; i++) thetas[i] = -THETA_MAX + (2 * THETA_MAX * i) / along;
  for (let i = 1; i <= along; i++) {
    const [x0, y0] = archPoint(thetas[i - 1]!);
    const [x1, y1] = archPoint(thetas[i]!);
    arc[i] = arc[i - 1]! + Math.hypot(x1 - x0, y1 - y0);
  }
  const mid = arc[along]! / 2;
  const totalWidth = TOOTH_WIDTHS.reduce((a, b) => a + b, 0);
  const scale = (mid * 0.97) / totalWidth;
  const starts: number[] = [];
  let acc = 0;
  for (const w of TOOTH_WIDTHS) {
    starts.push(acc * scale);
    acc += w;
  }

  const nv = (along + 1) * (across + 1);
  const positions = new Float32Array(nv * 3);
  const colors = options.colors ? new Uint8Array(nv * 3) : undefined;
  for (let i = 0; i <= along; i++) {
    const theta = thetas[i]!;
    const [cx, cy] = archPoint(theta);
    const tx = RX * Math.cos(theta);
    const ty = -RY * Math.sin(theta);
    const tl = Math.hypot(tx, ty);
    const nx = -ty / tl;
    const ny = tx / tl;
    // Signed distance from the midline along the arch; negative = patient's right in this layout.
    const d = arc[i]! - mid;
    const side = d < 0 ? 'right' : 'left';
    const dist = Math.abs(d);
    let type = -1;
    for (let k = 0; k < starts.length; k++) {
      if (dist >= starts[k]! && dist < starts[k]! + TOOTH_WIDTHS[k]! * scale) type = k;
    }
    for (let j = 0; j <= across; j++) {
      const s = -1 + (2 * j) / across; // -1 lingual, +1 buccal
      const gum = 1.5 * (1 - s * s) - 1.5;
      let tooth = 0;
      if (type >= 0) {
        const half = (TOOTH_WIDTHS[type]! * scale) / 2;
        const m = (dist - (starts[type]! + half)) / half;
        const b = (s * HALF_WIDTH) / BL_HALF[type]!;
        const prep = withPrep && type === 5 && side === 'left';
        tooth = toothHeight(m, b, type, prep);
      }
      const z = gum + Math.max(0, tooth);
      const v = i * (across + 1) + j;
      positions[v * 3] = cx + nx * s * HALF_WIDTH;
      positions[v * 3 + 1] = cy + ny * s * HALF_WIDTH;
      positions[v * 3 + 2] = jaw === 'lower' ? z : 2 * 7 + OCCLUSAL_GAP - z;
      if (colors) {
        const t = Math.min(1, Math.max(0, tooth / 1.0));
        colors[v * 3] = Math.round(205 + (238 - 205) * t);
        colors[v * 3 + 1] = Math.round(118 + (232 - 118) * t);
        colors[v * 3 + 2] = Math.round(124 + (214 - 124) * t);
      }
    }
  }

  const indices = new Uint32Array(along * across * 6);
  let o = 0;
  const flip = jaw === 'upper';
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * (across + 1) + j;
      const b = a + across + 1;
      const c = a + 1;
      const e = b + 1;
      // Mirroring z for the upper jaw reverses orientation, so flip winding to keep normals outward.
      indices[o++] = a;
      indices[o++] = flip ? c : b;
      indices[o++] = flip ? b : c;
      indices[o++] = c;
      indices[o++] = flip ? e : b;
      indices[o++] = flip ? b : e;
    }
  }
  return { positions, indices, colors };
}

/** Expand an indexed mesh into an STL-like triangle soup. */
export function toSoup(mesh: IndexedMesh): Float32Array {
  const out = new Float32Array(mesh.indices.length * 3);
  for (let k = 0; k < mesh.indices.length; k++) {
    const v = mesh.indices[k]! * 3;
    out[k * 3] = mesh.positions[v]!;
    out[k * 3 + 1] = mesh.positions[v + 1]!;
    out[k * 3 + 2] = mesh.positions[v + 2]!;
  }
  return out;
}
