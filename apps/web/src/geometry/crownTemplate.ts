import { isPosterior, jawOf } from '@dcad/shared';
import type { IndexedMesh } from './mesh';
import type { V3 } from './pca';

/**
 * Library crown: an open outer shell (no intaglio) in a template-local frame
 * (x mesial, y buccal, z occlusal; cervical loop in z = 0, centred on the
 * origin). Procedural "synthetic" templates stand in until real annotated
 * crowns are converted to the same format by tools/library-builder.
 */
export interface CrownTemplate {
  /** e.g. 'synthetic.lower-molar@1' */
  id: string;
  type: 'premolar' | 'molar';
  jaw: 'upper' | 'lower';
  /** Nominal size in mm: mesio-distal, bucco-lingual, cervix-to-cusp height. */
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

export type TemplateType = CrownTemplate['type'];
export type TemplateJaw = CrownTemplate['jaw'];

const NOMINAL: Record<TemplateJaw, Record<TemplateType, CrownTemplate['size']>> = {
  lower: { molar: { md: 11, bl: 10.5, height: 7.5 }, premolar: { md: 7, bl: 8, height: 8 } },
  upper: { molar: { md: 10, bl: 11, height: 7 }, premolar: { md: 7, bl: 9, height: 8 } },
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

function cuspsFor(type: TemplateType, size: CrownTemplate['size']): Cusp[] {
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

  const indices = new Uint32Array((rings * C * 2 + C) * 3);
  let o = 0;
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < C; i++) {
      const a = j * C + i;
      const b = j * C + ((i + 1) % C);
      const c = (j + 1) * C + ((i + 1) % C);
      const d = (j + 1) * C + i;
      // θ runs CCW (x → y) and j runs toward the apex, so (a, b, c) faces outward.
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

  const cervicalLoop = new Uint32Array(C);
  for (let i = 0; i < C; i++) cervicalLoop[i] = i;

  return {
    id: `synthetic.${jaw}-${type}@1`,
    type,
    jaw,
    size,
    mesh: { positions, indices },
    cervicalLoop,
    column,
    heightFraction,
    cuspTips: cusps.map((c) => ({ name: c.name, p: [c.x, c.y, occlusalZ(c.x, c.y)] as V3 })),
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

/** Library template for a posterior tooth: positions 4–5 premolar, 6–8 molar; jaw from the FDI quadrant. */
export function templateForTooth(fdi: number): CrownTemplate {
  if (!isPosterior(fdi)) throw new Error(`Tooth ${fdi} is not a premolar or molar; no crown template`);
  const type: TemplateType = fdi % 10 >= 6 ? 'molar' : 'premolar';
  const jaw = jawOf(fdi);
  const id = `synthetic.${jaw}-${type}@1`;
  let t = cache.get(id);
  if (!t) {
    t = syntheticTemplate(type, jaw);
    cache.set(id, t);
  }
  return t;
}
