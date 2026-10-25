import { jawOf } from '@dcad/shared';
import type { IndexedMesh } from './mesh';
import type { V3 } from './pca';

/** One template per tooth type and jaw; templateTypeOf maps the 8 positions of a quadrant onto them. */
export type TemplateType = 'central' | 'lateral' | 'canine' | 'premolar' | 'molar';
export type TemplateJaw = 'upper' | 'lower';

/**
 * Library crown: an open outer shell (no intaglio) in a template-local frame
 * (x mesial, y buccal or labial, z occlusal or incisal; cervical loop in
 * z = 0, centred on the origin). Procedural "synthetic" templates stand in
 * until real annotated crowns are converted to the same format by
 * tools/library-builder.
 */
export interface CrownTemplate {
  /** e.g. 'synthetic.lower-molar@1' */
  id: string;
  type: TemplateType;
  jaw: TemplateJaw;
  /** Nominal size in mm: mesio-distal, bucco-lingual, cervix-to-cusp (or incisal edge) height. */
  size: { md: number; bl: number; height: number };
  /** Open outer shell, template-local mm, outward normals. */
  mesh: IndexedMesh;
  /** Ring 0 vertex ids, CCW seen from +z, starting at the most mesial vertex. */
  cervicalLoop: Uint32Array;
  /** Per vertex: index into cervicalLoop of its column (apex: 0). */
  column: Uint32Array;
  /** Per vertex: 0 at the cervix, rising monotonically along each column to 1 at the apex. */
  heightFraction: Float32Array;
  cuspTips: Array<{ name: string; p: V3 }>;
}

type PosteriorType = 'premolar' | 'molar';
type AnteriorType = 'central' | 'lateral' | 'canine';
const isAnteriorType = (type: TemplateType): type is AnteriorType => type === 'central' || type === 'lateral' || type === 'canine';

/** Nominal crown sizes (standard crown dimensions; anterior: MD at the contacts, BL at the cingulum). */
const NOMINAL: Record<TemplateJaw, Record<TemplateType, CrownTemplate['size']>> = {
  lower: {
    molar: { md: 11, bl: 10.5, height: 7.5 },
    premolar: { md: 7, bl: 8, height: 8 },
    central: { md: 5, bl: 6, height: 9 },
    lateral: { md: 5.5, bl: 6, height: 9.5 },
    canine: { md: 7, bl: 7.5, height: 11 },
  },
  upper: {
    molar: { md: 10, bl: 11, height: 7 },
    premolar: { md: 7, bl: 9, height: 8 },
    central: { md: 8.5, bl: 7, height: 10.5 },
    lateral: { md: 6.5, bl: 6, height: 9 },
    canine: { md: 7.5, bl: 8, height: 10 },
  },
};

/** Superellipse exponent of the footprint (2 = ellipse, larger = boxier). */
const FOOTPRINT_EXPONENT = 3;
/** Height fraction of the occlusal table rim (top of the axial wall). */
const RIM = 0.7;
/** Height fraction of the height of contour (widest footprint). */
const CONTOUR = 0.38;
const CERVICAL_WIDTH = 0.8;
const TABLE_WIDTH = 0.75;

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Footprint width factor at height fraction t ∈ [0, RIM]: cervical waist → height of contour → occlusal table. */
function widthFactor(t: number): number {
  if (t <= CONTOUR) return CERVICAL_WIDTH + (1 - CERVICAL_WIDTH) * Math.sin((Math.PI / 2) * (t / CONTOUR));
  return 1 - (1 - TABLE_WIDTH) * smoothstep(CONTOUR, RIM, t);
}

/** Radius of a superellipse with half-widths (a, b) in direction θ. */
function superellipseRadius(a: number, b: number, theta: number): number {
  const n = FOOTPRINT_EXPONENT;
  return 1 / Math.pow(Math.pow(Math.abs(Math.cos(theta) / a), n) + Math.pow(Math.abs(Math.sin(theta) / b), n), 1 / n);
}

interface Cusp {
  name: string;
  x: number;
  y: number;
}

function cuspsFor(type: PosteriorType, size: CrownTemplate['size']): Cusp[] {
  const cx = 0.22 * size.md;
  const cy = 0.22 * size.bl;
  if (type === 'molar') {
    return [
      { name: 'MB', x: cx, y: cy },
      { name: 'ML', x: cx, y: -cy },
      { name: 'DB', x: -cx, y: cy },
      { name: 'DL', x: -cx, y: -cy },
    ];
  }
  return [
    { name: 'B', x: 0, y: cy },
    { name: 'L', x: 0, y: -cy },
  ];
}

/**
 * Procedural anatomic outer shell. The axial wall is lofted over a
 * superellipse footprint; the occlusal surface (parameterized by ρ from the
 * table rim to the centre) has cusp bumps, marginal ridges near the rim and
 * a central fossa, closed by an apex fan. Columns share the θ sampling, so
 * displacements can be blended per column.
 */
export function syntheticTemplate(type: TemplateType, jaw: TemplateJaw, options: { columns?: number; rings?: number } = {}): CrownTemplate {
  if (isAnteriorType(type)) return anteriorTemplate(type, jaw, options);
  const C = options.columns ?? 128;
  const rings = Math.max(4, options.rings ?? 48); // ring 0 (cervix) .. ring `rings` (last occlusal ring), plus the apex
  const size = NOMINAL[jaw][type];
  const H = size.height;
  const wallRings = Math.round(rings * 0.58); // ring index of the occlusal table rim
  const occlusalRings = rings - wallRings;
  const cusps = cuspsFor(type, size);
  const sigma = 0.18 * size.md;
  const fossaSigma = 0.15 * size.md;

  const rimA = (size.md / 2) * TABLE_WIDTH;
  const rimB = (size.bl / 2) * TABLE_WIDTH;
  /** Occlusal relief above the rim plane at (x, y), with ρ the radial fraction of the table (1 = rim). */
  const relief = (x: number, y: number, rho: number): number => {
    let cuspField = 0.08 * H;
    for (const c of cusps) cuspField += 0.22 * H * Math.exp(-((x - c.x) ** 2 + (y - c.y) ** 2) / (2 * sigma * sigma));
    cuspField -= 0.08 * H * Math.exp(-(x * x + y * y) / (2 * fossaSigma * fossaSigma));
    // Rises steeply from the rim (marginal ridges), so the relief is 0 exactly at the rim: no crack with the wall.
    return (1 - Math.pow(Math.min(1, rho), 8)) * cuspField;
  };
  const occlusalZ = (x: number, y: number): number => {
    const theta = Math.atan2(y, x);
    const rim = superellipseRadius(rimA, rimB, theta);
    return RIM * H + relief(x, y, Math.hypot(x, y) / rim);
  };

  const nv = (rings + 1) * C + 1;
  const positions = new Float32Array(nv * 3);
  const column = new Uint32Array(nv);
  const heightFraction = new Float32Array(nv);
  const apex = nv - 1;

  for (let j = 0; j <= rings; j++) {
    for (let i = 0; i < C; i++) {
      const theta = (2 * Math.PI * i) / C;
      const v = j * C + i;
      let x: number, y: number, z: number, s: number;
      if (j <= wallRings) {
        const t = (RIM * j) / wallRings;
        const w = widthFactor(t);
        const r = superellipseRadius((size.md / 2) * w, (size.bl / 2) * w, theta);
        x = r * Math.cos(theta);
        y = r * Math.sin(theta);
        z = t * H;
        s = t;
      } else {
        const k = j - wallRings; // 1..occlusalRings
        const rho = 1 - k / (occlusalRings + 1);
        const r = superellipseRadius(rimA, rimB, theta) * rho;
        x = r * Math.cos(theta);
        y = r * Math.sin(theta);
        z = RIM * H + relief(x, y, rho);
        s = RIM + (1 - RIM) * (k / (occlusalRings + 1));
      }
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      column[v] = i;
      heightFraction[v] = s;
    }
  }
  positions[apex * 3 + 2] = occlusalZ(0, 0);
  heightFraction[apex] = 1;

  return {
    id: `synthetic.${jaw}-${type}@1`,
    type,
    jaw,
    size,
    mesh: { positions, indices: loftIndices(rings, C) },
    cervicalLoop: identityLoop(C),
    column,
    heightFraction,
    cuspTips: cusps.map((c) => ({ name: c.name, p: [c.x, c.y, occlusalZ(c.x, c.y)] as V3 })),
  };
}

/**
 * Faces of a lofted shell: rings 0..`rings` of C vertices each (vertex
 * j·C + i), closed by a fan to the apex (the last vertex).
 */
function loftIndices(rings: number, C: number): Uint32Array {
  const apex = (rings + 1) * C;
  const indices = new Uint32Array((rings * C * 2 + C) * 3);
  let o = 0;
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < C; i++) {
      const a = j * C + i;
      const b = j * C + ((i + 1) % C);
      const c = (j + 1) * C + ((i + 1) % C);
      const d = (j + 1) * C + i;
      // Columns run CCW (x → y) and j runs toward the apex, so (a, b, c) faces outward.
      indices[o++] = a;
      indices[o++] = b;
      indices[o++] = c;
      indices[o++] = a;
      indices[o++] = c;
      indices[o++] = d;
    }
  }
  for (let i = 0; i < C; i++) {
    indices[o++] = rings * C + i;
    indices[o++] = rings * C + ((i + 1) % C);
    indices[o++] = apex;
  }
  return indices;
}

/** Ring 0 of a lofted shell: column i's cervical vertex is i; column 0 is the most mesial. */
function identityLoop(C: number): Uint32Array {
  const loop = new Uint32Array(C);
  for (let i = 0; i < C; i++) loop[i] = i;
  return loop;
}

/** Shape of a procedural incisor or canine (fractions of the nominal size unless stated). */
interface AnteriorShape {
  /** Mesio-distal and labio-lingual width at the cervix. */
  cervicalMd: number;
  cervicalBl: number;
  /** Wall height fraction of the widest mesio-distal section (the contact areas). */
  contourMd: number;
  /** Wall height fraction of the widest labio-lingual section (cingulum, labial height of contour). */
  contourBl: number;
  /** Mesio-distal width of the top wall ring: rounds the incisal angles, or starts a canine's cusp ridges. */
  topMd: number;
  /** Labio-lingual half-thickness of the top wall ring (the incisal edge, or the base of the cusp tip), mm. */
  edgeHalfMm: number;
  /** Height of the cap above the top wall ring. */
  cap: number;
  /** Cap profile exponent: 2 = a round bead (incisal edge), below 2 = pointed (cusp tip). */
  capExponent: number;
  /** Depth of the lingual fossa between the marginal ridges, as a fraction of the lingual half-width. */
  fossa: number;
}

const ANTERIOR: Record<AnteriorType, AnteriorShape> = {
  central: { cervicalMd: 0.82, cervicalBl: 0.86, contourMd: 0.75, contourBl: 0.2, topMd: 0.94, edgeHalfMm: 0.55, cap: 0.055, capExponent: 2, fossa: 0.35 },
  lateral: { cervicalMd: 0.82, cervicalBl: 0.86, contourMd: 0.72, contourBl: 0.2, topMd: 0.88, edgeHalfMm: 0.5, cap: 0.06, capExponent: 2, fossa: 0.3 },
  canine: { cervicalMd: 0.8, cervicalBl: 0.86, contourMd: 0.62, contourBl: 0.22, topMd: 0.7, edgeHalfMm: 1.6, cap: 0.2, capExponent: 1.5, fossa: 0.05 },
};
/** Superellipse exponent of the anterior sections (rounder than the posterior footprint). */
const ANTERIOR_EXPONENT = 2.5;

/** sign(v)·|v|^p */
const signedPow = (v: number, p: number) => Math.sign(v) * Math.pow(Math.abs(v), p);

/**
 * C parameter values φ ∈ [0, 2π), starting at 0, that split the closed curve
 * φ ↦ curve(φ) into arcs of equal length.
 */
function equalArcAngles(C: number, curve: (phi: number) => [number, number]): Float64Array {
  const fine = C * 32;
  const cum = new Float64Array(fine + 1);
  let prev = curve(0);
  for (let k = 1; k <= fine; k++) {
    const p = curve((2 * Math.PI * k) / fine);
    cum[k] = cum[k - 1]! + Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    prev = p;
  }
  const out = new Float64Array(C);
  let k = 0;
  for (let i = 1; i < C; i++) {
    const target = (cum[fine]! * i) / C;
    while (cum[k + 1]! < target) k++;
    const f = (target - cum[k]!) / (cum[k + 1]! - cum[k]!);
    out[i] = ((2 * Math.PI) / fine) * (k + f);
  }
  return out;
}

/**
 * Procedural incisor or canine. The wall is lofted over superellipse
 * sections whose labio-lingual width peaks at the cingulum and tapers to the
 * incisal edge: the labial outline is convex, the lingual one S-shaped (the
 * cingulum, then the hollow incisal half with a fossa between the marginal
 * ridges). The mesio-distal width peaks at the contact areas. A cap closes
 * the top: a round bead along the incisal edge, or a pointed cusp tip for a
 * canine. Each column keeps one parametric superellipse angle φ (not a polar
 * one, so the long thin sections near the edge are sampled evenly); the
 * angles split the cervical ring into equal arcs, so the margin paired with
 * it by arc length is sampled evenly too. heightFraction is z / height, so
 * the RBF anchors (≥ 0.7) are the incisal third.
 */
function anteriorTemplate(type: AnteriorType, jaw: TemplateJaw, options: { columns?: number; rings?: number }): CrownTemplate {
  const C = options.columns ?? 128;
  const rings = Math.max(4, options.rings ?? 48);
  const size = NOMINAL[jaw][type];
  const shape = ANTERIOR[type];
  const H = size.height;
  const A = size.md / 2;
  const B = size.bl / 2;
  const e = shape.edgeHalfMm;
  const capH = shape.cap * H;
  const zTop = H - capH;
  const wallRings = Math.round(rings * 0.7); // ring index of the top wall ring
  const capRings = rings - wallRings;
  const pw = 2 / ANTERIOR_EXPONENT;
  const q = shape.capExponent;

  // Mesio-distal half-width: flares fast from the cervix (emergence profile; a straight proximal wall needs large
  // thickness pushes right above the margin, which fold the shell), then grows slowly up to the contact areas.
  const mdHalf = (t: number): number =>
    t <= shape.contourMd
      ? A * (shape.cervicalMd + (1 - shape.cervicalMd) * (1 - Math.pow(1 - t / shape.contourMd, 3)))
      : A * (1 - (1 - shape.topMd) * smoothstep(shape.contourMd, 1, t));
  /** Labial or lingual half-width at wall height t (before the fossa). */
  const blHalf = (t: number, labial: boolean): number => {
    if (t <= shape.contourBl) return B * (shape.cervicalBl + (1 - shape.cervicalBl) * Math.sin((Math.PI / 2) * (t / shape.contourBl)));
    const u = (t - shape.contourBl) / (1 - shape.contourBl);
    // Labial: convex down to the edge. Lingual: smoothstep, so the cingulum bulges and the incisal half is hollow.
    const f = labial ? 1 - u * u * (1.5 - 0.5 * u) : 1 - u * u * (3 - 2 * u);
    return e + (B - e) * f;
  };
  const fossaDepth = (t: number): number =>
    t <= shape.contourBl ? 0 : shape.fossa * Math.sin(Math.PI * ((t - shape.contourBl) / (1 - shape.contourBl)));
  /** Wall point at height fraction t and parametric angle φ (0 = mesial, π/2 = labial). */
  const wallPoint = (t: number, phi: number): [number, number] => {
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const b = s >= 0 ? blHalf(t, true) : blHalf(t, false) * (1 - fossaDepth(t) * s * s * s * s);
    return [mdHalf(t) * signedPow(c, pw), b * signedPow(s, pw)];
  };

  const phis = equalArcAngles(C, (phi) => wallPoint(0, phi));
  const nv = (rings + 1) * C + 1;
  const positions = new Float32Array(nv * 3);
  const column = new Uint32Array(nv);
  const heightFraction = new Float32Array(nv);
  const apex = nv - 1;
  for (let i = 0; i < C; i++) {
    const phi = phis[i]!;
    const [xt, yt] = wallPoint(1, phi);
    for (let j = 0; j <= rings; j++) {
      let x: number, y: number, z: number;
      if (j <= wallRings) {
        const t = j / wallRings;
        [x, y] = wallPoint(t, phi);
        z = t * zTop;
      } else {
        // Cap: the top ring shrunk toward the axis along a superellipse profile (vertical where it meets the wall).
        const psi = (Math.PI / 2) * ((j - wallRings) / (capRings + 1));
        const rho = Math.pow(Math.cos(psi), 2 / q);
        x = rho * xt;
        y = rho * yt;
        z = zTop + capH * Math.pow(Math.sin(psi), 2 / q);
      }
      const v = j * C + i;
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      column[v] = i;
      heightFraction[v] = z / H;
    }
  }
  positions[apex * 3 + 2] = H;
  heightFraction[apex] = 1;

  /** Point on the incisal crest 80% of the way out toward the mesial (+1) or distal (−1) angle. */
  const crest = (side: 1 | -1): V3 => [side * 0.8 * mdHalf(1), 0, zTop + capH * Math.pow(1 - Math.pow(0.8, q), 1 / q)];
  const cuspTips =
    type === 'canine'
      ? [{ name: 'C', p: [0, 0, H] as V3 }]
      : [
          { name: 'MI', p: crest(1) },
          { name: 'I', p: [0, 0, H] as V3 },
          { name: 'DI', p: crest(-1) },
        ];

  return {
    id: `synthetic.${jaw}-${type}@1`,
    type,
    jaw,
    size,
    mesh: { positions, indices: loftIndices(rings, C) },
    cervicalLoop: identityLoop(C),
    column,
    heightFraction,
    cuspTips,
  };
}

/** The shell closed by a fan from the cervical loop to its centroid (previews, tests). */
export function closeCervix(t: CrownTemplate): IndexedMesh {
  const { positions, indices } = t.mesh;
  const nv = positions.length / 3;
  const c: V3 = [0, 0, 0];
  for (const v of t.cervicalLoop) for (let k = 0; k < 3; k++) c[k] = c[k]! + positions[v * 3 + k]! / t.cervicalLoop.length;
  const p = new Float32Array(positions.length + 3);
  p.set(positions);
  p.set(c, nv * 3);
  const n = t.cervicalLoop.length;
  const idx = new Uint32Array(indices.length + n * 3);
  idx.set(indices);
  for (let i = 0; i < n; i++) {
    // The loop runs CCW seen from +z; the cap faces −z, so it is wound clockwise.
    idx.set([t.cervicalLoop[(i + 1) % n]!, t.cervicalLoop[i]!, nv], indices.length + i * 3);
  }
  return { positions: p, indices: idx };
}

const cache = new Map<string, CrownTemplate>();

/** Template type of an FDI tooth: position 1 central, 2 lateral, 3 canine, 4–5 premolar, 6–8 molar. */
export function templateTypeOf(fdi: number): TemplateType {
  const quadrant = Math.floor(fdi / 10);
  const position = fdi % 10;
  if (quadrant < 1 || quadrant > 4 || position < 1 || position > 8) throw new Error(`${fdi} is not an FDI tooth number`);
  if (position === 1) return 'central';
  if (position === 2) return 'lateral';
  if (position === 3) return 'canine';
  return position <= 5 ? 'premolar' : 'molar';
}

/** Library template for any tooth (type from templateTypeOf, jaw from the FDI quadrant), cached. */
export function templateForTooth(fdi: number): CrownTemplate {
  const type = templateTypeOf(fdi);
  const jaw = jawOf(fdi);
  const id = `synthetic.${jaw}-${type}@1`;
  let t = cache.get(id);
  if (!t) {
    t = syntheticTemplate(type, jaw);
    cache.set(id, t);
  }
  return t;
}
