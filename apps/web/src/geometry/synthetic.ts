import type { IndexedMesh } from './mesh';
import { computeVertexNormals } from './normals';
import { carveTooth, cavityContour, cavityShape, resampleContour, type CavityShape, type SyntheticCavity } from './syntheticCavity';

/**
 * Synthetic dental-arch-like surface for tests and demos (no patient data).
 * An open U-shaped band with tooth-shaped domes (positions 1–7 per quadrant,
 * no third molars). Any tooth can be replaced by a crown prep (tapered stump,
 * chamfer and a convex margin edge), given an inlay or onlay cavity
 * (syntheticCavity.ts), or left out (the convex gum band is then the
 * edentulous ridge). By default the lower-left first molar (FDI 36) is a
 * prep. Units are mm, occlusal direction is +z for the lower jaw. The upper
 * jaw mirrors the same xy layout in z, so 26 sits above 36. Anatomically
 * correct in a right-handed frame (x = patient's right, y = anterior, z = up
 * for the lower jaw): patient left (quadrants 2 and 3) is −x.
 */
export interface ArchOptions {
  jaw?: 'lower' | 'upper';
  /** Grid segments along the arch. Triangles = 2 × along × across. */
  along?: number;
  across?: number;
  /** Prepared teeth (FDI, in this jaw, positions 1–7). Default: [36] for the lower jaw, [] for the upper jaw. */
  preps?: number[];
  /** Missing teeth (FDI, in this jaw, positions 1–7): only the gum band (the edentulous ridge) is left. */
  missing?: number[];
  /** Legacy switch, used when `preps` is not given: true = the first molar on the patient's left (36 or 26). */
  withPrep?: boolean;
  /**
   * Inlay and onlay cavities carved into natural teeth (syntheticCavity.ts); their margins and seeds come from
   * syntheticCavityMargin and syntheticCavitySeed. A cavity tooth must not be prepared or missing: pass `preps: []`
   * for the lower jaw when it would otherwise default to the 36 prep.
   */
  cavities?: SyntheticCavity[];
  /**
   * Lean the front teeth (incisors and canines, FDI positions 1–3) labially by this many degrees, as real front teeth
   * lean 15–30° from the occlusal-plane normal (anteriorLean). Default 0: upright, as before. Pass the same value to
   * syntheticPrepMargin and syntheticPrepSeed.
   */
  anteriorLeanDeg?: number;
  colors?: boolean;
  /**
   * Gum over the tooth's base, as on a real scan (specs/2026-10-27-natural-margin-research.md): the gingiva covers the
   * bottom `coverMm` of every tooth and rises `papillaMm` higher between teeth (the papillae), so the tooth/gum line is
   * scalloped. Default: none (the tooth meets the bare gum band, as before).
   */
  gingiva?: { coverMm: number; papillaMm: number };
  /** Per-vertex labels: the FDI number of the tooth a vertex lies on, 0 on the gum (ground truth for segmentation). */
  labels?: boolean;
}

/** A synthetic arch, with per-vertex labels when asked for. */
export interface SyntheticArch extends IndexedMesh {
  labels?: Uint8Array;
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
/** The default prep (the lower-left first molar). */
export const SYNTHETIC_PREP_FDI = 36;

/** Grid resolution of the editor's demo scans (lower jaw ~1M triangles, with the prep of SYNTHETIC_PREP_FDI). */
export const DEMO_SCAN = { lower: { along: 1000, across: 500 }, upper: { along: 600, across: 250 } } as const;

/** Where an FDI tooth sits in the synthetic layout. */
export interface SyntheticTooth {
  jaw: 'lower' | 'upper';
  /** Patient side: left = quadrants 2 and 3 (−x), right = quadrants 1 and 4 (+x). */
  side: 'left' | 'right';
  /** Tooth type index from the midline back (0 central … 6 second molar) = FDI position − 1. */
  type: number;
}

/** FDI tooth → synthetic layout slot. Throws for third molars (not in the layout) and non-FDI numbers. */
export function syntheticTooth(fdi: number): SyntheticTooth {
  const quadrant = Math.floor(fdi / 10);
  const position = fdi % 10;
  if (quadrant < 1 || quadrant > 4 || position < 1 || position > 8) throw new Error(`${fdi} is not an FDI tooth number`);
  if (position > TOOTH_WIDTHS.length) throw new Error(`Tooth ${fdi}: the synthetic arch has no third molars`);
  return { jaw: quadrant <= 2 ? 'upper' : 'lower', side: quadrant === 2 || quadrant === 3 ? 'left' : 'right', type: position - 1 };
}

const NATURAL = 0;
const PREP = 1;
const MISSING = 2;

/**
 * Prep profile as tooth height (mm above the gum) over the normalized
 * superellipse footprint radius r: flat top, tapered axial wall (convex
 * occlusal line angle at r = 0.5), a concave chamfer floor, a short ledge,
 * then the convex margin edge at PREP_MARGIN_R where the root surface drops
 * into the sulcus. The profile is normalized, so narrower teeth get steeper
 * walls and a harsher line angle: preps up to the second premolar
 * (`roundedTop`) round it, as preps are cut, so the intaglio's radial
 * profiles stay within the cement-gap accuracy. Molar preps keep the sharp
 * edge of the original FDI 36 prep (the regression baseline).
 */
export const PREP_MARGIN_R = 0.88;
const PREP_TOP = 4.0;
const WALL_START_R = 0.5;
const WALL_END_R = 0.72;
const WALL_END_H = 2.0;
const FLOOR_END_R = 0.8;
const LEDGE_SLOPE = 1.5;
const ROOT_END_R = 0.97;
/** Last tooth type (second premolar) whose prep gets the rounded line angle. */
const LAST_ROUNDED_TYPE = 4;
/** Height band (mm) over which the rounded line angle blends the top into the wall (smooth minimum). */
const LINE_ANGLE_ROUNDING_MM = 0.8;

/** Polynomial smooth minimum: min(a, b) with the corner rounded where |a − b| < k. */
function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

function prepHeight(r: number, roundedTop = false): number {
  const topEdge = PREP_TOP - 0.4 * WALL_START_R * WALL_START_R;
  const wallSlope = (topEdge - WALL_END_H) / (WALL_END_R - WALL_START_R);
  if (roundedTop && r <= WALL_END_R) {
    return smoothMin(PREP_TOP - 0.4 * r * r, topEdge - wallSlope * (r - WALL_START_R), LINE_ANGLE_ROUNDING_MM);
  }
  if (r <= WALL_START_R) return PREP_TOP - 0.4 * r * r;
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
  if (prep) return prepHeight(r, type <= LAST_ROUNDED_TYPE);
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

/** Last tooth type (canine) that leans with ArchOptions.anteriorLeanDeg. */
const LAST_LEANING_TYPE = 2;

/**
 * The across-band coordinate of a front-tooth point leaned labially: a point z mm above the gum line (z > 0 only on
 * the tooth) moves tan(lean)·z outward along the arch's normal. So each front tooth is sheared: its centre line tilts
 * by the lean, the gum and the tooth's foot stay put (z ≤ 0 there), and the prep top stays parallel to the occlusal
 * plane. Other teeth, and lean 0, keep s exactly.
 */
function anteriorLean(s: number, z: number, type: number, leanDeg: number): number {
  if (!leanDeg || type < 0 || type > LAST_LEANING_TYPE || z <= 0) return s;
  return s + (Math.tan((leanDeg * Math.PI) / 180) * z) / HALF_WIDTH;
}

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

/** Per side, per tooth type: NATURAL, PREP or MISSING. */
function toothStates(jaw: 'lower' | 'upper', options: ArchOptions): Record<'left' | 'right', Uint8Array> {
  const states = { left: new Uint8Array(TOOTH_WIDTHS.length), right: new Uint8Array(TOOTH_WIDTHS.length) };
  const preps = options.preps ?? ((options.withPrep ?? jaw === 'lower') ? [jaw === 'lower' ? SYNTHETIC_PREP_FDI : 26] : []);
  const mark = (fdis: readonly number[], state: number) => {
    for (const fdi of fdis) {
      const t = syntheticTooth(fdi);
      if (t.jaw !== jaw) throw new Error(`Tooth ${fdi} is not in the ${jaw} jaw`);
      if (states[t.side][t.type] !== NATURAL && states[t.side][t.type] !== state) throw new Error(`Tooth ${fdi} cannot be both prepared and missing`);
      states[t.side][t.type] = state;
    }
  };
  mark(preps, PREP);
  mark(options.missing ?? [], MISSING);
  for (const c of options.cavities ?? []) {
    const t = syntheticTooth(c.fdi);
    if (t.jaw !== jaw) throw new Error(`Tooth ${c.fdi} is not in the ${jaw} jaw`);
    if (states[t.side][t.type] !== NATURAL) throw new Error(`Tooth ${c.fdi} has a cavity, so it must be a natural tooth (not prepared or missing)`);
  }
  return states;
}

/** Natural tooth height above the gum curve at footprint offsets (u, w) in mm (u: + distal, w: + buccal). */
function naturalAt(layout: ArchLayout, type: number, u: number, w: number): number {
  const half = (TOOTH_WIDTHS[type]! * layout.scale) / 2;
  return Math.max(0, toothHeight(u / half, w / BL_HALF[type]!, type, false));
}

/** The cavity of one tooth fitted to the layout (footprint half widths, the central fossa height). */
function shapeFor(layout: ArchLayout, type: number, kind: SyntheticCavity['kind']): CavityShape {
  return cavityShape(kind, (TOOTH_WIDTHS[type]! * layout.scale) / 2, BL_HALF[type]!, naturalAt(layout, type, 0, 0));
}

/** Per side, per tooth type: the cavity carved into it, if any. */
function cavityShapes(layout: ArchLayout, options: ArchOptions): Record<'left' | 'right', Array<CavityShape | undefined>> {
  const out: Record<'left' | 'right', Array<CavityShape | undefined>> = { left: [], right: [] };
  for (const c of options.cavities ?? []) {
    const t = syntheticTooth(c.fdi);
    out[t.side][t.type] = shapeFor(layout, t.type, c.kind);
  }
  return out;
}

export function syntheticArch(options: ArchOptions = {}): SyntheticArch {
  const along = options.along ?? 400;
  const across = options.across ?? 120;
  const jaw = options.jaw ?? 'lower';
  const states = toothStates(jaw, options);
  const layout = archLayout(along);
  const { thetas, arc, mid, starts, scale } = layout;
  const cavities = cavityShapes(layout, options);

  const nv = (along + 1) * (across + 1);
  const positions = new Float32Array(nv * 3);
  const colors = options.colors ? new Uint8Array(nv * 3) : undefined;
  const labels = options.labels ? new Uint8Array(nv) : undefined;
  const gingiva = options.gingiva;
  // Tooth junctions along the arch (distance from the midline): the papillae peak there.
  const junctions = [0, ...starts.slice(1), starts.at(-1)! + TOOTH_WIDTHS.at(-1)! * scale];

  for (let i = 0; i <= along; i++) {
    const theta = thetas[i]!;
    // Signed distance from the midline along the arch; negative (x < 0) = patient's left.
    const d = arc[i]! - mid;
    const side = d < 0 ? 'left' : 'right';
    const dist = Math.abs(d);
    let type = -1;
    for (let k = 0; k < starts.length; k++) {
      if (dist >= starts[k]! && dist < starts[k]! + TOOTH_WIDTHS[k]! * scale) type = k;
    }
    const toJunction = Math.min(...junctions.map((x) => Math.abs(dist - x)));
    for (let j = 0; j <= across; j++) {
      const s = -1 + (2 * j) / across; // -1 lingual, +1 buccal
      const gum = gumHeight(s);
      const cover = gingiva ? gingiva.coverMm + gingiva.papillaMm * Math.exp(-((toJunction / 1.6) ** 2)) * Math.max(0, 1 - s * s) : 0;
      let tooth = 0;
      const state = type >= 0 ? states[side][type]! : MISSING;
      if (state !== MISSING) {
        const half = (TOOTH_WIDTHS[type]! * scale) / 2;
        const m = (dist - (starts[type]! + half)) / half;
        const b = (s * HALF_WIDTH) / BL_HALF[type]!;
        tooth = toothHeight(m, b, type, state === PREP);
        const cavity = cavities[side][type];
        if (cavity) tooth = carveTooth(cavity, m * half, s * HALF_WIDTH, Math.max(0, tooth));
      }
      const z = gum + Math.max(cover, tooth);
      const v = i * (across + 1) + j;
      if (labels && type >= 0 && tooth > cover) labels[v] = (side === 'left' ? (jaw === 'upper' ? 20 : 30) : jaw === 'upper' ? 10 : 40) + type + 1;
      const [x, y] = bandPoint(theta, anteriorLean(s, z, type, options.anteriorLeanDeg ?? 0));
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = jaw === 'lower' ? z : 2 * 7 + OCCLUSAL_GAP - z;
      if (colors) {
        const t = Math.min(1, Math.max(0, (tooth - cover) / 1.0));
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

  return { positions, indices, colors, ...(labels ? { labels } : {}) };
}

/**
 * Surface point of a synthetic tooth at footprint offsets u (mesio-distal,
 * positive distal) and w (bucco-lingual, positive buccal), in mm from the
 * footprint centre, at `height` above the gum curve; matches syntheticArch
 * generated with the same `along`.
 */
function toothPoint(layout: ArchLayout, tooth: SyntheticTooth, u: number, w: number, height: number, leanDeg = 0): [number, number, number] {
  const { thetas, arc, mid, starts, scale } = layout;
  const type = tooth.type;
  const half = (TOOTH_WIDTHS[type]! * scale) / 2;
  // Left side: arc before the midline (x < 0); right side: beyond it.
  const target = tooth.side === 'left' ? mid - (starts[type]! + half + u) : mid + starts[type]! + half + u;
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
  const s = w / HALF_WIDTH;
  const z = gumHeight(s) + height;
  const [x, y] = bandPoint(theta, anteriorLean(s, z, type, leanDeg));
  return [x, y, tooth.jaw === 'lower' ? z : 2 * 7 + OCCLUSAL_GAP - z];
}

/**
 * Prep surface point at footprint coordinates (m mesio-distal, positive
 * distal; b bucco-lingual, positive buccal; both -1…1) of a synthetic tooth,
 * matching syntheticArch generated with the same `along` and the tooth in `preps`.
 */
function prepPoint(layout: ArchLayout, tooth: SyntheticTooth, m: number, b: number, leanDeg = 0): [number, number, number] {
  const half = (TOOTH_WIDTHS[tooth.type]! * layout.scale) / 2;
  return toothPoint(layout, tooth, m * half, b * BL_HALF[tooth.type]!, prepHeight(footprintR(m, b), tooth.type <= LAST_ROUNDED_TYPE), leanDeg);
}

/**
 * Analytic margin ring of a synthetic prep (default FDI 36), as `samples`
 * xyz points in order around the prep; sample 0 is the distal end. Pass the
 * same `along` as the syntheticArch it is compared against, generated with
 * this tooth in `preps`.
 */
export function syntheticPrepMargin(options: { fdi?: number; along?: number; samples?: number; anteriorLeanDeg?: number } = {}): Float32Array {
  const tooth = syntheticTooth(options.fdi ?? SYNTHETIC_PREP_FDI);
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
    out.set(prepPoint(layout, tooth, m, b, options.anteriorLeanDeg), i * 3);
  }
  return out;
}

/** A point on the occlusal top of a synthetic prep (default FDI 36), e.g. the user's "click the prep". */
export function syntheticPrepSeed(options: { fdi?: number; along?: number; anteriorLeanDeg?: number } = {}): [number, number, number] {
  return prepPoint(archLayout(options.along ?? 400), syntheticTooth(options.fdi ?? SYNTHETIC_PREP_FDI), 0, 0, options.anteriorLeanDeg);
}

/** The cavity of a synthetic tooth (its kind and analytic shape) at a grid resolution. */
function cavityOf(options: { fdi: number; kind: SyntheticCavity['kind']; along?: number }) {
  const tooth = syntheticTooth(options.fdi);
  const layout = archLayout(options.along ?? 400);
  return { tooth, layout, shape: shapeFor(layout, tooth.type, options.kind) };
}

/**
 * Analytic cavosurface margin of a synthetic cavity, as `samples` xyz points
 * at uniform arc length (in the footprint plane) around the cavity, in the
 * order distal → buccal → mesial → lingual; sample 0 is the distal end. The contour is exact to
 * 1e-9 mm at its 0.02 mm trace points (bisection), so the chords between
 * samples are the only approximation. Pass the same `along` as the
 * syntheticArch it is compared against, generated with this cavity.
 */
export function syntheticCavityMargin(options: { fdi: number; kind: SyntheticCavity['kind']; along?: number; samples?: number }): Float32Array {
  const { tooth, layout, shape } = cavityOf(options);
  const natural = (u: number, w: number) => naturalAt(layout, tooth.type, u, w);
  const contour = resampleContour(cavityContour(shape, natural), options.samples ?? 64);
  const out = new Float32Array(contour.length * 3);
  contour.forEach(([u, w], i) => out.set(toothPoint(layout, tooth, u, w, natural(u, w)), i * 3));
  return out;
}

/** A point on the floor of a synthetic cavity (the centre of the isthmus or of the onlay table): the flood-fill seed. */
export function syntheticCavitySeed(options: { fdi: number; kind: SyntheticCavity['kind']; along?: number }): [number, number, number] {
  const { tooth, layout, shape } = cavityOf(options);
  const natural = naturalAt(layout, tooth.type, 0, 0);
  return toothPoint(layout, tooth, 0, 0, carveTooth(shape, 0, 0, natural));
}

/**
 * The pre-op scan of a synthetic case: the same arch without its cavities
 * (an exact reference for restorations designed from it; every vertex outside
 * the cavities is identical to the cavity arch's).
 */
export function syntheticPreop(options: ArchOptions = {}): IndexedMesh {
  return syntheticArch({ ...options, cavities: [] });
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

/**
 * A copy of `mesh` with scanner-like noise: every vertex moved along its normal by a Gaussian of `sigmaMm`
 * (deterministic for a `seed`). Intraoral scans carry a few hundredths of a millimetre; at 0.04–0.05 mm the
 * automatic margin's radial profiles start picking false edges (specs/2026-10-26-margin-ai.md).
 */
export function withScanNoise(mesh: IndexedMesh, sigmaMm: number, seed: number): IndexedMesh {
  const normals = computeVertexNormals(mesh);
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i += 3) {
    const d = Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform()) * sigmaMm;
    for (let k = 0; k < 3; k++) positions[i + k] = positions[i + k]! + normals[i + k]! * d;
  }
  return { ...mesh, positions };
}
