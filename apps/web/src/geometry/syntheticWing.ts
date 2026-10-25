import type { V3 } from './pca';
import type { RayCaster } from './raycast';
import { PREP_MARGIN_R, syntheticPrepMargin, syntheticPrepSeed, syntheticTooth } from './synthetic';

/**
 * Scripted wing outlines on the synthetic arch (no patient data), the
 * reference for the Maryland golden case (`synthetic-maryland-11-12`: upper
 * jaw, 12 missing, a wing on the palatal surface of 11).
 *
 * The outline is a crescent on the lingual (palatal) half of the tooth's
 * superellipse footprint: the cervical border runs at footprint radius
 * `cervicalR`, the incisal/occlusal border at about 0.4–0.75, and the end
 * facing the pontic wraps onto that proximal surface. Footprint points are
 * mapped to xy from the tooth's analytic margin ring (syntheticPrepMargin,
 * which gives the footprint axes at any tooth) and dropped onto the scan
 * surface with a ray along −occlusal, so the anchors lie on the mesh they
 * are traced on.
 */
export interface SyntheticWingOutline {
  fdi: number;
  jaw: 'upper' | 'lower';
  /** Unit occlusal direction of the synthetic jaw (−z upper, +z lower). */
  occlusal: V3;
  /** Live-wire anchors on the lingual surface, in order around the closed outline. */
  anchors: V3[];
  /** A surface point inside the outline: the frame click and the flood-fill seed. */
  seed: V3;
}

/**
 * Outline in footprint polar coordinates (angle φ, radius r), for an outline
 * extending distally. φ = 3π/2 is the lingual midpoint and φ → 2π the distal
 * surface; r = 1 is where the tooth meets the gum. Cervical border first,
 * then the incisal border back.
 */
const CERVICAL_PHI = [3.75, 4.05, 4.4, 4.71, 5.0, 5.35, 5.7, 6.05];
const INCISAL: Array<[number, number]> = [
  [6.05, 0.75],
  [5.6, 0.5],
  [5.0, 0.4],
  [4.4, 0.42],
  [3.8, 0.65],
];
const SEED: [number, number] = [3 * Math.PI / 2 + 0.3, 0.65];

/** Superellipse footprint coordinates (m: + distal, b: + buccal) at polar angle φ and radius r. */
const footprint = (phi: number, r: number): [number, number] => {
  const c = Math.cos(phi), s = Math.sin(phi);
  return [r * Math.sign(c) * Math.sqrt(Math.abs(c)), r * Math.sign(s) * Math.sqrt(Math.abs(s))];
};

/**
 * Scripted wing outline on a synthetic tooth. `ray` casts against the
 * syntheticArch it is traced on, generated with the same `along`; the tooth
 * must be present (natural). `toward` is the side of the pontic: the
 * outline wraps onto that proximal surface.
 */
export function syntheticWingOutline(input: {
  fdi: number;
  ray: RayCaster;
  toward: 'mesial' | 'distal';
  along?: number;
  /**
   * Footprint radius of the cervical border (default 0.9; 1 = the gum line). The synthetic dome turns vertical
   * toward r = 1, where the grid's triangles grow to millimetres tall; above ~0.92 the outline lands in that band.
   */
  cervicalR?: number;
}): SyntheticWingOutline {
  const tooth = syntheticTooth(input.fdi);
  const along = input.along ?? 400;
  const occlusal: V3 = tooth.jaw === 'upper' ? [0, 0, -1] : [0, 0, 1];
  const c = syntheticPrepSeed({ fdi: input.fdi, along });
  // Margin ring samples at φ = 0, π/2, π, 3π/2: distal, buccal, mesial, lingual ends of the footprint at radius PREP_MARGIN_R.
  const ring = syntheticPrepMargin({ fdi: input.fdi, along, samples: 4 });
  const end = (k: number): [number, number] => [(ring[k * 3]! - c[0]) / PREP_MARGIN_R, (ring[k * 3 + 1]! - c[1]) / PREP_MARGIN_R];
  const [distal, buccal, mesial, lingual] = [end(0), end(1), end(2), end(3)];
  const mirror = input.toward === 'mesial';
  const onSurface = (phi: number, r: number): V3 => {
    let [m, b] = footprint(phi, r);
    if (mirror) m = -m;
    const mx = m >= 0 ? distal : mesial;
    const bx = b >= 0 ? buccal : lingual;
    const x = c[0] + Math.abs(m) * mx[0] + Math.abs(b) * bx[0];
    const y = c[1] + Math.abs(m) * mx[1] + Math.abs(b) * bx[1];
    const start: V3 = [x, y, 60 * occlusal[2]];
    const hit = input.ray.first(start, [0, 0, -occlusal[2]], 120);
    if (!hit) throw new Error(`Tooth ${input.fdi}: no surface under the wing outline point (φ ${phi.toFixed(2)}, r ${r})`);
    return hit.point;
  };
  const rc = input.cervicalR ?? 0.9;
  const anchors: V3[] = [...CERVICAL_PHI.map((phi) => onSurface(phi, rc)), ...INCISAL.map(([phi, r]) => onSurface(phi, r))];
  return { fdi: input.fdi, jaw: tooth.jaw, occlusal, anchors, seed: onSurface(SEED[0], SEED[1]) };
}
