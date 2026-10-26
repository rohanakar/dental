import type { RestorationType } from '@dcad/shared';
import { capBasis, findPrepStump, onCap, prepStumpAxis, type PrepStump } from '../geometry/prepAxis';
import type { RayCaster } from '../geometry/raycast';

type V3 = [number, number, number];

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const normalize = (a: readonly number[]): V3 => {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!);
  return l > 0 ? [a[0]! / l, a[1]! / l, a[2]! / l] : [0, 0, 1];
};
const DEG = Math.PI / 180;

/**
 * Restorations on a prepared stump (the Margin step traces its finish line): their Margin view follows the prep's own
 * axis, and on front teeth so does their tooth frame (geometry/toothFrame.ts). Others keep the frame's occlusal view
 * and the jaw-level frame: an implant crown's click is on the scan body, and types without a stump (wings, cavities)
 * have their own outline.
 */
export const PREP_MARGIN: readonly RestorationType[] = ['anatomic-crown', 'reduced-crown'];

/** Camera distance of the Margin step's view (mm), as before this module. */
export const MARGIN_VIEW_DISTANCE_MM = 32;
/** The prep axis is searched within this cone around the frame's occlusal direction. */
const CONE_DEG = 35;
/** A margin point counts as hidden when the camera ray lands farther than this from it. */
const HIDDEN_TOLERANCE_MM = 0.3;

export interface MarginViewInput {
  /** Jaw scan, xyz per vertex. */
  positions: ArrayLike<number>;
  /** Triangle indices (any order, e.g. the BVH's). */
  indices: ArrayLike<number>;
  ray: RayCaster;
  frame: {
    origin: readonly number[];
    occlusal: readonly number[];
    mesial: readonly number[];
    buccal: readonly number[];
    mesialContact?: readonly number[];
    distalContact?: readonly number[];
  };
  /** The current margin (dense points), when one exists. */
  margin?: ReadonlyArray<readonly number[]>;
  /** The stored insertion axis, when one exists. */
  axis?: readonly number[];
}

export interface MarginView {
  /** Where the camera looks: the centre of the prep top (the frame origin when it cannot be found). */
  target: V3;
  /** Unit direction from the target toward the camera. */
  direction: V3;
  /** Which candidate won: the prep's own axis, the stored insertion axis, or the frame's occlusal direction. */
  source: 'prep' | 'axis' | 'occlusal';
  /** Margin points a click cannot reach from this view (0 without a margin: nothing to test). */
  hidden: number;
}

/**
 * The Margin step's view: from where the whole margin of the prep can be seen and clicked.
 *
 * The frame's occlusal direction is the jaw's occlusal-plane normal for posterior teeth, and the prep's wall axis for
 * front-tooth preps (geometry/toothFrame.ts). On proclined front teeth (an upper incisor leans 15–30° labially) looking
 * along the plane normal puts the labial margin edge-on or behind the tooth, and frames stored before the front-tooth
 * frame still have it. So the view follows the prep's own axis:
 * - The prep stump is found first by connectivity (findPrepStump in geometry/prepAxis.ts), so a click anywhere on the
 *   prep gives the same view.
 * - The axis is the least-undercut direction of the stump's walls with a 20° clearance (prepStumpAxis). Each wall has
 *   to face the camera by at least that much, which puts the optimum on the axis of the walls rather than at the edge
 *   of the visible cone. It is searched within 35° of the frame's occlusal direction, with a small tie-break toward
 *   it, so an upright posterior prep keeps the occlusal view.
 * - Then it is checked against what a click can reach at the foot of the walls (bestView).
 *
 * With a margin, the candidates (prep axis, stored insertion axis, frame occlusal) are ray tested from the camera
 * position against the margin points, and the one that hides the fewest wins (ties: in that order).
 *
 * Measured on the synthetic arch (specs/2026-10-26-anterior-margin-and-export-all.md): every margin point of 11
 * reachable with the incisors proclined up to 25°, against 39–45 of 64 from the occlusal view; 36 keeps the occlusal
 * view. 20–70 ms for a 1M-triangle scan.
 */
export function marginView(input: MarginViewInput, distanceMm = MARGIN_VIEW_DISTANCE_MM): MarginView {
  const occlusal = normalize(input.frame.occlusal);
  const stump = findPrepStump({ positions: input.positions, indices: input.indices, frame: input.frame, occlusal });
  const o = input.frame.origin;
  const target: V3 = stump?.top ?? [o[0]!, o[1]!, o[2]!];
  const prep = stump ? bestView(input.ray, target, stump, prepStumpAxis(stump, occlusal, CONE_DEG), occlusal, distanceMm) : null;
  const margin = input.margin && input.margin.length >= 3 ? input.margin : null;
  if (!margin) return { target, direction: prep ?? occlusal, source: prep ? 'prep' : 'occlusal', hidden: 0 };

  const candidates: Array<{ direction: V3; source: MarginView['source'] }> = [];
  if (prep) candidates.push({ direction: prep, source: 'prep' });
  if (input.axis) candidates.push({ direction: normalize(input.axis), source: 'axis' });
  candidates.push({ direction: occlusal, source: 'occlusal' });
  let best: MarginView | null = null;
  for (const c of candidates) {
    const hidden = hiddenPoints(input.ray, target, c.direction, distanceMm, margin);
    if (!best || hidden < best.hidden) best = { target, direction: c.direction, source: c.source, hidden };
    if (hidden === 0) break;
  }
  return best!;
}

/**
 * Margin points a click cannot reach from a perspective camera at target + distance × direction: the camera ray to
 * the point lands more than 0.3 mm away from it, either on something in front of it or, past a margin seen edge-on,
 * on the root surface or gum behind it.
 */
function hiddenPoints(ray: RayCaster, target: V3, direction: V3, distanceMm: number, points: ReadonlyArray<readonly number[]>): number {
  const camera: V3 = [target[0] + direction[0] * distanceMm, target[1] + direction[1] * distanceMm, target[2] + direction[2] * distanceMm];
  // 128 samples are plenty for a margin of a few hundred points.
  const step = Math.max(1, Math.floor(points.length / 128));
  let hidden = 0;
  for (let i = 0; i < points.length; i += step) {
    const p = points[i]!;
    const toPoint = sub(p, camera);
    const length = Math.hypot(...toPoint);
    const hit = ray.first(camera, normalize(toPoint), length + 5);
    if (!hit || Math.hypot(...sub(hit.point, p)) > HIDDEN_TOLERANCE_MM) hidden++;
  }
  return hidden;
}

/**
 * The walls' axis can fall short of a strongly leaning prep, so it is checked against what a click can reach: the
 * axis and directions tilted 4°, 8° and 12° from it (8 azimuths each, inside the cone) are scored by how many rim
 * points they hide; the fewest wins, the smaller tilt on a tie.
 */
function bestView(ray: RayCaster, target: V3, stump: PrepStump, axis: V3, occlusal: V3, distanceMm: number): V3 {
  if (stump.rim.length === 0) return axis;
  const cosCone = Math.cos(CONE_DEG * DEG);
  const [u, v] = capBasis(axis);
  let best = axis;
  let bestHidden = hiddenPoints(ray, target, axis, distanceMm, stump.rim);
  for (const tilt of [4, 8, 12]) {
    if (bestHidden === 0) break;
    for (let k = 0; k < 8; k++) {
      const d = onCap(axis, u, v, tilt * DEG, (k * Math.PI) / 4);
      if (dot(d, occlusal) < cosCone) continue;
      const hidden = hiddenPoints(ray, target, d, distanceMm, stump.rim);
      if (hidden < bestHidden) {
        bestHidden = hidden;
        best = d;
      }
    }
  }
  return best;
}
