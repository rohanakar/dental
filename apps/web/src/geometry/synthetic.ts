import type { IndexedMesh } from './mesh';

/**
 * Synthetic dental-arch-like surface for tests and demos (no patient data).
 * An open U-shaped band with tooth-shaped domes; optionally the lower-left
 * first molar (FDI 36) is replaced by a crown prep (tapered stump, chamfer
 * and a convex margin edge). Units are mm, occlusal direction is +z for the lower jaw.
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
/** Tooth type index of the first molar (FDI 36 when on the lower left). */
const PREP_TYPE = 5;
export const SYNTHETIC_PREP_FDI = 36;

/**
 * Prep profile as tooth height (mm above the gum) over the normalized
 * superellipse footprint radius r: flat top, tapered axial wall (convex
 * occlusal line angle at r = 0.5), a concave chamfer floor, a short ledge,
 * then the convex margin edge at PREP_MARGIN_R where the root surface drops
 * into the sulcus.
 */
export const PREP_MARGIN_R = 0.88;
const PREP_TOP = 4.0;
const WALL_START_R = 0.5;
const WALL_END_R = 0.72;
const WALL_END_H = 2.0;
const FLOOR_END_R = 0.8;
const LEDGE_SLOPE = 1.5;
const ROOT_END_R = 0.97;

function prepHeight(r: number): number {
  const topEdge = PREP_TOP - 0.4 * WALL_START_R * WALL_START_R;
  if (r <= WALL_START_R) return PREP_TOP - 0.4 * r * r;
  const wallSlope = (topEdge - WALL_END_H) / (WALL_END_R - WALL_START_R);
  if (r <= WALL_END_R) return topEdge - wallSlope * (r - WALL_START_R);
  // Concave chamfer floor: quadratic blend from the wall slope to the ledge slope.
  const span = FLOOR_END_R - WALL_END_R;
  const k = (wallSlope - LEDGE_SLOPE) / (2 * span);
  const floorEnd = WALL_END_H - wallSlope * span + k * span * span;
  if (r <= FLOOR_END_R) {
    const t = r - WALL_END_R;
    return WALL_END_H - wallSlope * t + k * t * t;
  }
  const marginH = floorEnd - LEDGE_SLOPE * (PREP_MARGIN_R - FLOOR_END_R);
  if (r <= PREP_MARGIN_R) return floorEnd - LEDGE_SLOPE * (r - FLOOR_END_R);
  if (r <= ROOT_END_R) return marginH * (1 - (r - PREP_MARGIN_R) / (ROOT_END_R - PREP_MARGIN_R));
  return 0;
}

function archPoint(theta: number): [number, number] {
  return [RX * Math.sin(theta), RY * Math.cos(theta)];
}

const footprintR = (m: number, b: number) => Math.pow(Math.pow(Math.abs(m), 4) + Math.pow(Math.abs(b), 4), 0.25);

function toothHeight(m: number, b: number, type: number, prep: boolean): number {
  // Superellipse footprint.
  const r = footprintR(m, b);
  if (r >= 1) return 0;
  if (prep) return prepHeight(r);
  const h = TOOTH_HEIGHT[type]!;
  let z = h * Math.sqrt(1 - Math.pow(r, 4));
  if (type >= 3) {
    // Cusps for premolars and molars.
    const cuspsMd = type >= 5 ? 2 : 1;
    z -= 0.7 * Math.pow(Math.max(0, 1 - r), 0.5) * (0.5 - 0.5 * Math.cos(Math.PI * (m * cuspsMd + 1))) * (0.5 + 0.5 * Math.cos(Math.PI * b * 1.6));
  }
  return z;
}

const gumHeight = (s: number) => 1.5 * (1 - s * s) - 1.5;

/** Arc-length layout of the arch at a grid resolution (the mesh and the analytic helpers share it). */
interface ArchLayout {
  thetas: Float64Array;
  arc: Float64Array;
  mid: number;
  starts: number[];
  scale: number;
}

function archLayout(along: number): ArchLayout {
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
  return { thetas, arc, mid, starts, scale };
}

/** Surface point at arch angle theta and across-band coordinate s (-1 lingual … +1 buccal), before adding height. */
function bandPoint(theta: number, s: number): [number, number] {
  const [cx, cy] = archPoint(theta);
  const tx = RX * Math.cos(theta);
  const ty = -RY * Math.sin(theta);
  const tl = Math.hypot(tx, ty);
  const nx = -ty / tl;
  const ny = tx / tl;
  return [cx + nx * s * HALF_WIDTH, cy + ny * s * HALF_WIDTH];
}

export function syntheticArch(options: ArchOptions = {}): IndexedMesh {
  const along = options.along ?? 400;
  const across = options.across ?? 120;
  const jaw = options.jaw ?? 'lower';
  const withPrep = options.withPrep ?? jaw === 'lower';
  const { thetas, arc, mid, starts, scale } = archLayout(along);

  const nv = (along + 1) * (across + 1);
  const positions = new Float32Array(nv * 3);
  const colors = options.colors ? new Uint8Array(nv * 3) : undefined;

  for (let i = 0; i <= along; i++) {
    const theta = thetas[i]!;
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
      const gum = gumHeight(s);
      let tooth = 0;
      if (type >= 0) {
        const half = (TOOTH_WIDTHS[type]! * scale) / 2;
        const m = (dist - (starts[type]! + half)) / half;
        const b = (s * HALF_WIDTH) / BL_HALF[type]!;
        const prep = withPrep && type === PREP_TYPE && side === 'left';
        tooth = toothHeight(m, b, type, prep);
      }
      const z = gum + Math.max(0, tooth);
      const v = i * (across + 1) + j;
      const [x, y] = bandPoint(theta, s);
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
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

/**
 * Lower-jaw surface point at prep footprint coordinates (m mesio-distal,
 * b bucco-lingual, both -1…1) of the FDI 36 prep, matching syntheticArch
 * generated with the same `along`.
 */
function prepPoint(layout: ArchLayout, m: number, b: number, height: (r: number) => number): [number, number, number] {
  const { thetas, arc, mid, starts, scale } = layout;
  const half = (TOOTH_WIDTHS[PREP_TYPE]! * scale) / 2;
  const target = mid + starts[PREP_TYPE]! + half + m * half; // left side: arc beyond the midline
  // Invert arc length → theta, linear between grid rows like the mesh.
  let lo = 0;
  let hi = arc.length - 1;
  while (hi - lo > 1) {
    const k = (lo + hi) >> 1;
    if (arc[k]! <= target) lo = k;
    else hi = k;
  }
  const t = (target - arc[lo]!) / (arc[hi]! - arc[lo]!);
  const theta = thetas[lo]! + t * (thetas[hi]! - thetas[lo]!);
  const s = (b * BL_HALF[PREP_TYPE]!) / HALF_WIDTH;
  const [x, y] = bandPoint(theta, s);
  return [x, y, gumHeight(s) + height(footprintR(m, b))];
}

/**
 * Analytic margin ring of the synthetic FDI 36 prep (lower jaw), as
 * `samples` xyz points in order around the prep. Pass the same `along` as
 * the syntheticArch it is compared against.
 */
export function syntheticPrepMargin(options: { along?: number; samples?: number } = {}): Float32Array {
  const layout = archLayout(options.along ?? 400);
  const n = options.samples ?? 64;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const phi = (2 * Math.PI * i) / n;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    // Superellipse |m|^4 + |b|^4 = R^4.
    const m = PREP_MARGIN_R * Math.sign(c) * Math.sqrt(Math.abs(c));
    const b = PREP_MARGIN_R * Math.sign(s) * Math.sqrt(Math.abs(s));
    out.set(prepPoint(layout, m, b, prepHeight), i * 3);
  }
  return out;
}

/** A point on the occlusal top of the synthetic FDI 36 prep (lower jaw), e.g. the user's "click the prep". */
export function syntheticPrepSeed(options: { along?: number } = {}): [number, number, number] {
  return prepPoint(archLayout(options.along ?? 400), 0, 0, prepHeight);
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
