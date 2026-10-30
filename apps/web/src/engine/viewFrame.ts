import { principalAxes, type V3 } from '../geometry/pca';

/**
 * Orientation used for the standard views. Defaults to world axes; later
 * set from the tooth frame (Day 2).
 */
export interface ViewFrame {
  /** Turntable/screen up: from the lower jaw toward the upper jaw. */
  up: V3;
  /** Direction the camera looks *from* in the occlusal view (= up for lower-jaw work, -up for upper). */
  occlusal: V3;
  /** Toward the cheek / front of the arch. */
  buccal: V3;
  /** Toward the midline along the arch (for a whole arch: a side direction). */
  mesial: V3;
}

export const WORLD_VIEW_FRAME: ViewFrame = {
  up: [0, 0, 1],
  occlusal: [0, 0, 1],
  buccal: [0, 1, 0],
  mesial: [1, 0, 0],
};

export type StandardView = 'occlusal' | 'buccal' | 'lingual' | 'mesial' | 'distal';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export interface JawSample {
  role: 'upper' | 'lower' | 'preop';
  positions: Float32Array;
  normals: Float32Array;
}

/**
 * Estimate a whole-arch view frame from loaded scans:
 * - up: least-variance PCA axis (≈ occlusal-plane normal), oriented from the
 *   lower jaw to the upper jaw (or by the mean surface normal for one jaw);
 * - buccal: second axis, oriented toward the arch front (the end where the
 *   arch is narrow, i.e. the incisors, rather than the two molar arms);
 * - mesial: completes a right-handed frame.
 */
export function estimateViewFrame(jaws: JawSample[]): ViewFrame | null {
  const primary = jaws.find((j) => j.role === 'lower') ?? jaws.find((j) => j.role === 'upper') ?? jaws[0];
  if (!primary || primary.positions.length < 9) return null;
  const pca = principalAxes(primary.positions);
  let up = pca.axes[2];
  const lower = jaws.find((j) => j.role === 'lower');
  const upper = jaws.find((j) => j.role === 'upper');
  if (lower && upper) {
    const cl = principalAxes(lower.positions, 20_000).centroid;
    const cu = principalAxes(upper.positions, 20_000).centroid;
    if (dot(up, [cu[0] - cl[0], cu[1] - cl[1], cu[2] - cl[2]]) < 0) up = scale(up, -1);
  } else {
    // An open scan's surface normals point out of the teeth on average: toward
    // occlusal for a lower jaw (= up) and away from up for an upper jaw.
    const n = meanNormal(primary.normals);
    const jawOcclusalIsUp = primary.role !== 'upper';
    if ((dot(up, n) < 0) === jawOcclusalIsUp) up = scale(up, -1);
  }

  const lateral = pca.axes[0];
  let buccal = pca.axes[1];
  // The arch front is the end along `buccal` with the smaller lateral spread.
  const spreadPos = endSpread(primary.positions, pca.centroid, buccal, lateral, 1);
  const spreadNeg = endSpread(primary.positions, pca.centroid, buccal, lateral, -1);
  if (spreadNeg < spreadPos) buccal = scale(buccal, -1);
  const mesial = cross(up, buccal);
  const focusUpper = !lower && Boolean(upper);
  return { up, occlusal: focusUpper ? scale(up, -1) : up, buccal, mesial };
}

function meanNormal(normals: Float32Array): V3 {
  let x = 0, y = 0, z = 0;
  const step = Math.max(1, Math.floor(normals.length / 3 / 100_000));
  for (let i = 0; i < normals.length / 3; i += step) {
    x += normals[i * 3]!;
    y += normals[i * 3 + 1]!;
    z += normals[i * 3 + 2]!;
  }
  return [x, y, z];
}

/** Mean |lateral offset| of the 10% of points furthest along ±axis. */
function endSpread(positions: Float32Array, c: V3, axis: V3, lateral: V3, sign: 1 | -1): number {
  const n = positions.length / 3;
  const step = Math.max(1, Math.floor(n / 50_000));
  const along: number[] = [];
  const side: number[] = [];
  for (let i = 0; i < n; i += step) {
    const p: V3 = [positions[i * 3]! - c[0], positions[i * 3 + 1]! - c[1], positions[i * 3 + 2]! - c[2]];
    along.push(sign * dot(p, axis));
    side.push(Math.abs(dot(p, lateral)));
  }
  const order = along.map((_, i) => i).sort((a, b) => along[b]! - along[a]!);
  const k = Math.max(1, Math.floor(order.length * 0.1));
  let sum = 0;
  for (let i = 0; i < k; i++) sum += side[order[i]!]!;
  return sum / k;
}

/** Unit direction from the target toward the camera for a standard view. */
export function viewDirection(frame: ViewFrame, view: StandardView, jaw?: 'upper' | 'lower'): V3 {
  switch (view) {
    case 'occlusal':
      // Onto the working jaw's biting surfaces: from below an upper tooth, from above a lower one, whichever jaw the
      // arch frame faces (with both jaws loaded it faces the lower one).
      return jaw ? (jaw === 'upper' ? scale(frame.up, -1) : frame.up) : frame.occlusal;
    case 'buccal':
      return frame.buccal;
    case 'lingual':
      return scale(frame.buccal, -1);
    case 'mesial':
      return frame.mesial;
    case 'distal':
      return scale(frame.mesial, -1);
  }
}
