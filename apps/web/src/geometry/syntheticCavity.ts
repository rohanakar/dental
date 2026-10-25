/**
 * Analytic inlay and onlay cavities for the synthetic arch (no patient data).
 * Pure 2D shape functions over a tooth's footprint in millimetres:
 * u mesio-distal (positive distal), w bucco-lingual (positive buccal), both
 * from the footprint centre; heights are tooth heights above the gum curve.
 * synthetic.ts carves them (tooth height = min(natural, cavity surface)) and
 * maps the margin contour to xyz.
 *
 * Shapes (clinical numbers for inlay-retained bridges: occlusal depth 2.5 mm,
 * isthmus width 3 mm, proximal box depth 2 mm):
 * - The occlusal isthmus: a flat pulpal floor 2.5 mm below the central fossa,
 *   2.6 mm wide at the floor; its walls flare at 8° to about 3.3 mm at the
 *   occlusal outline.
 * - Proximal boxes: a flat gingival floor 2 mm below the pulpal floor,
 *   reaching 1.5 mm into the tooth from its proximal contour, 3.8 mm wide;
 *   the box opens through the proximal surface.
 * - Every internal line angle between a floor and its walls is a 0.4 mm
 *   fillet; isthmus and boxes are joined by a smooth minimum (rounded
 *   axio-pulpal line angle). Outline corners are rounded in plan view.
 * - The cavosurface edge is where the cavity surface meets the natural one
 *   (a convex crease, a butt joint).
 * - Onlay: the occlusal surface reduced by 2 mm, following the cusps, inside
 *   a rounded rectangle over the cusps, with the same walls and fillets.
 *
 * Every shape is a height field over (u, w), so no cavity has an undercut
 * along the occlusal direction.
 */

export type SyntheticCavityKind = 'mod' | 'mo' | 'do' | 'onlay';

export interface SyntheticCavity {
  fdi: number;
  kind: SyntheticCavityKind;
}

export const CAVITY_DIMENSIONS = {
  /** Pulpal floor below the natural central fossa. */
  occlusalDepthMm: 2.5,
  /** Half width of the isthmus floor (the walls flare beyond it). */
  isthmusHalfWidthMm: 1.3,
  /** Half width of a proximal box floor. */
  boxHalfWidthMm: 1.9,
  /** How far a box reaches into the tooth from its proximal contour (the axial wall's position). */
  boxReachMm: 1.5,
  /** Gingival floor of a box below the pulpal floor. */
  boxDepthMm: 2.0,
  /** Wall taper from the occlusal direction. */
  wallTaperDeg: 8,
  /** Fillet radius of the internal line angles (floor to wall). */
  internalRadiusMm: 0.4,
  /** Plan-view corner radius of the outlines. */
  outlineCornerMm: 0.5,
  /** Smooth-minimum width joining the isthmus and the boxes (rounded axio-pulpal line angle). */
  joinMm: 0.25,
  /** MO and DO: the isthmus ends this fraction of the half width past the centre, toward the closed side. */
  isthmusEndFraction: 0.3,
  /** Onlay: occlusal reduction, following the natural surface. */
  onlayReductionMm: 2.0,
  /** Onlay floor rectangle as fractions of the footprint half widths, and its corner radius. */
  onlayMdFraction: 0.65,
  onlayBlFraction: 0.62,
  onlayCornerMm: 1.2,
};

export type CavityDimensions = typeof CAVITY_DIMENSIONS;

/** A cavity fitted to one tooth: its kind, footprint half widths and floor heights. */
export interface CavityShape {
  kind: SyntheticCavityKind;
  /** Footprint half widths, mm (mesio-distal along the arch, bucco-lingual). */
  halfMd: number;
  halfBl: number;
  /** Pulpal floor and gingival box floor, tooth height above the gum curve. */
  pulpalFloor: number;
  boxFloor: number;
  dims: CavityDimensions;
  /** Wall slope (rise per mm) and fillet constants of wallRise. */
  slope: number;
  filletStart: number;
  filletEnd: number;
}

/**
 * The cavity for one tooth. `centreHeight` is the natural tooth height at the
 * footprint centre (the central fossa); the pulpal floor sits occlusalDepthMm
 * below it.
 */
export function cavityShape(kind: SyntheticCavityKind, halfMd: number, halfBl: number, centreHeight: number, dims: CavityDimensions = CAVITY_DIMENSIONS): CavityShape {
  const slope = 1 / Math.tan((dims.wallTaperDeg * Math.PI) / 180);
  const rho = dims.internalRadiusMm;
  const root = Math.sqrt(1 + slope * slope);
  // Fillet circle centred at (filletStart, rho), tangent to the floor and to the wall line z = slope·d.
  const filletStart = (rho * (1 - root)) / slope;
  const filletEnd = filletStart + (rho * slope) / root;
  const pulpalFloor = centreHeight - dims.occlusalDepthMm;
  return { kind, halfMd, halfBl, pulpalFloor, boxFloor: pulpalFloor - dims.boxDepthMm, dims, slope, filletStart, filletEnd };
}

/**
 * Rise of a pocket's surface above its floor at signed distance d (mm) from
 * the floor rectangle (positive outside): flat, a fillet of the internal
 * radius, then the tapered wall (the wall line meets the floor plane at d = 0).
 */
function wallRise(shape: CavityShape, d: number): number {
  if (d <= shape.filletStart) return 0;
  if (d <= shape.filletEnd) {
    const rho = shape.dims.internalRadiusMm;
    const t = d - shape.filletStart;
    return rho - Math.sqrt(Math.max(0, rho * rho - t * t));
  }
  return shape.slope * d;
}

/** Signed distance to a rectangle centred at (cu, cw) with half extents (hu, hw) and plan-view corner radius r. */
function sdRoundRect(u: number, w: number, cu: number, cw: number, hu: number, hw: number, r: number): number {
  const qu = Math.abs(u - cu) - hu + r;
  const qw = Math.abs(w - cw) - hw + r;
  return Math.hypot(Math.max(qu, 0), Math.max(qw, 0)) + Math.min(Math.max(qu, qw), 0) - r;
}

/** Polynomial smooth minimum: min(a, b) with the corner rounded where |a − b| < k. */
function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

/** A box that runs from `reach` mm inside the proximal contour out past the tooth, toward +u (distal) or −u (mesial). */
const BOX_LENGTH_MM = 40;

function boxDistance(shape: CavityShape, u: number, w: number, side: 1 | -1): number {
  const inner = shape.halfMd - shape.dims.boxReachMm;
  return sdRoundRect(side * u, w, inner + BOX_LENGTH_MM / 2, 0, BOX_LENGTH_MM / 2, shape.dims.boxHalfWidthMm, shape.dims.outlineCornerMm);
}

/** Isthmus: a strip |w| ≤ half width; MO and DO end with a round end past the centre on the closed side. */
function isthmusDistance(shape: CavityShape, u: number, w: number): number {
  const hw = shape.dims.isthmusHalfWidthMm;
  const closed = shape.kind === 'mo' ? 1 : shape.kind === 'do' ? -1 : 0;
  if (closed === 0) return Math.abs(w) - hw;
  const end = shape.dims.isthmusEndFraction * shape.halfMd;
  const along = closed * u;
  if (along <= end - hw) return Math.abs(w) - hw;
  return Math.hypot(along - (end - hw), w) - hw;
}

/**
 * The cavity surface at (u, w): the tooth height it is carved down to. The
 * carved tooth is min(natural, cavitySurface); `natural` is the natural tooth
 * height there (the onlay floor follows it).
 */
export function cavitySurface(shape: CavityShape, u: number, w: number, natural: number): number {
  const dims = shape.dims;
  if (shape.kind === 'onlay') {
    const d = sdRoundRect(u, w, 0, 0, dims.onlayMdFraction * shape.halfMd, dims.onlayBlFraction * shape.halfBl, dims.onlayCornerMm);
    return natural - dims.onlayReductionMm + wallRise(shape, d);
  }
  let c = shape.pulpalFloor + wallRise(shape, isthmusDistance(shape, u, w));
  if (shape.kind === 'mod' || shape.kind === 'do') c = smoothMin(c, shape.boxFloor + wallRise(shape, boxDistance(shape, u, w, 1)), dims.joinMm);
  if (shape.kind === 'mod' || shape.kind === 'mo') c = smoothMin(c, shape.boxFloor + wallRise(shape, boxDistance(shape, u, w, -1)), dims.joinMm);
  return c;
}

/** The carved tooth height: the natural height, lowered to the cavity surface inside the cavity. */
export function carveTooth(shape: CavityShape, u: number, w: number, natural: number): number {
  return Math.min(natural, cavitySurface(shape, u, w, natural));
}

/**
 * The cavosurface margin as a closed (u, w) contour: the zero set of
 * cavitySurface − natural, traced with marching squares on a `stepMm` grid
 * over the footprint, every crossing refined by bisection on its grid edge
 * (to 1e-9 mm). Counter-clockwise in (u, w) (distal → buccal → mesial →
 * lingual), starting at the distal crossing of w = 0.
 */
export function cavityContour(shape: CavityShape, natural: (u: number, w: number) => number, stepMm = 0.02): Array<[number, number]> {
  const F = (u: number, w: number) => cavitySurface(shape, u, w, natural(u, w)) - natural(u, w);
  const u0 = -shape.halfMd - stepMm, w0 = -shape.halfBl - stepMm;
  const nu = Math.ceil((2 * shape.halfMd + 2 * stepMm) / stepMm) + 1;
  const nw = Math.ceil((2 * shape.halfBl + 2 * stepMm) / stepMm) + 1;
  const U = (i: number) => u0 + i * stepMm;
  const W = (j: number) => w0 + j * stepMm;
  const field = new Float64Array(nu * nw);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nw; j++) field[i * nw + j] = F(U(i), W(j));
  const inside = (i: number, j: number) => field[i * nw + j]! < 0;

  // Crossing on a grid edge, keyed by the edge; bisection on F along it.
  const points = new Map<string, [number, number]>();
  const crossing = (i0: number, j0: number, i1: number, j1: number): string => {
    const key = `${Math.min(i0, i1)},${Math.min(j0, j1)},${i0 === i1 ? 'w' : 'u'}`;
    if (!points.has(key)) {
      let a: [number, number] = [U(i0), W(j0)];
      let b: [number, number] = [U(i1), W(j1)];
      let fa = field[i0 * nw + j0]!;
      for (let it = 0; it < 60; it++) {
        const m: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const fm = F(m[0], m[1]);
        if (fm < 0 === fa < 0) {
          a = m;
          fa = fm;
        } else b = m;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) break;
      }
      points.set(key, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    return key;
  };

  // Marching squares: segments oriented with the inside on the left (counter-clockwise loops).
  const next = new Map<string, string>();
  for (let i = 0; i < nu - 1; i++) {
    for (let j = 0; j < nw - 1; j++) {
      // Corners counter-clockwise: (i,j), (i+1,j), (i+1,j+1), (i,j+1).
      const c: Array<[number, number]> = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      const s = c.map(([a, b]) => inside(a, b));
      if (s.every((x) => x) || s.every((x) => !x)) continue;
      // Crossing per cell edge k (c_k → c_k+1); a segment runs from a "leaving" crossing (inside → outside going
      // CCW around the cell) to an "entering" one, which keeps the inside on its left.
      const edge: Array<string | null> = [0, 1, 2, 3].map((k) => {
        if (s[k] === s[(k + 1) % 4]) return null;
        const [a, b] = c[k]!, [p, q] = c[(k + 1) % 4]!;
        return crossing(a, b, p, q);
      });
      const leavingEdges = [0, 1, 2, 3].filter((k) => edge[k] && s[k]);
      if (leavingEdges.length === 1) {
        const k = leavingEdges[0]!;
        const e = [1, 2, 3].map((o) => (k + o) % 4).find((m) => edge[m] && !s[m])!;
        next.set(edge[k]!, edge[e]!);
      } else {
        // Saddle: when the centre is inside the two inside corners are joined (pair with the entering crossing on the
        // next edge, CCW); otherwise they are separate (the previous edge).
        const centreInside = F(U(i) + stepMm / 2, W(j) + stepMm / 2) < 0;
        for (const k of leavingEdges) next.set(edge[k]!, edge[(k + (centreInside ? 1 : 3)) % 4]!);
      }
    }
  }

  // Link into loops; keep the longest.
  const seen = new Set<string>();
  let best: Array<[number, number]> = [];
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: Array<[number, number]> = [];
    let k: string | undefined = start;
    while (k !== undefined && !seen.has(k)) {
      seen.add(k);
      loop.push(points.get(k)!);
      k = next.get(k);
    }
    if (loop.length > best.length) best = loop;
  }
  if (best.length < 3) throw new Error('The cavity has no margin on this tooth');
  // Orientation: counter-clockwise in (u, w).
  let area = 0;
  for (let i = 0; i < best.length; i++) {
    const [a, b] = best[i]!, [c, d] = best[(i + 1) % best.length]!;
    area += a * d - c * b;
  }
  if (area < 0) best.reverse();
  // Start at the distal crossing of w = 0.
  let start = 0, bestU = -Infinity;
  for (let i = 0; i < best.length; i++) {
    const [a, b] = best[i]!, [c, d] = best[(i + 1) % best.length]!;
    if ((b <= 0 && d > 0) || (b > 0 && d <= 0)) {
      const t = b === d ? 0 : -b / (d - b);
      const uc = a + t * (c - a);
      if (uc > bestU) {
        bestU = uc;
        start = i + 1;
      }
    }
  }
  return [...best.slice(start % best.length), ...best.slice(0, start % best.length)];
}

/** Resample a closed (u, w) contour to `samples` points at uniform arc length, from its first point. */
export function resampleContour(contour: Array<[number, number]>, samples: number): Array<[number, number]> {
  const n = contour.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const [a, b] = contour[i]!, [c, d] = contour[(i + 1) % n]!;
    cum[i + 1] = cum[i]! + Math.hypot(c - a, d - b);
  }
  const total = cum[n]!;
  const out: Array<[number, number]> = [];
  let seg = 0;
  for (let k = 0; k < samples; k++) {
    const s = (total * k) / samples;
    while (seg < n - 1 && cum[seg + 1]! < s) seg++;
    const len = cum[seg + 1]! - cum[seg]!;
    const t = len > 0 ? (s - cum[seg]!) / len : 0;
    const [a, b] = contour[seg]!, [c, d] = contour[(seg + 1) % n]!;
    out.push([a + t * (c - a), b + t * (d - b)]);
  }
  return out;
}
