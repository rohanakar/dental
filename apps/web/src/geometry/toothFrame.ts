import { principalAxes, symmetricEigen3, type V3 } from './pca';
import { findPrepStump, stumpWallAxis } from './prepAxis';
import type { RayCaster } from './raycast';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: V3): V3 => {
  const l = norm(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
};
/** Component of a perpendicular to unit n. */
const reject = (a: V3, n: V3): V3 => sub(a, scale(n, dot(a, n)));

export interface ToothFrameEstimate {
  /** Prep top under the seed. */
  origin: V3;
  /** Unit, from the prep toward the antagonist. */
  occlusal: V3;
  /** Unit, toward the mesial neighbour (along the arch toward the midline). */
  mesial: V3;
  /** Unit, toward the cheek. */
  buccal: V3;
  mesialContact?: V3;
  distalContact?: V3;
  warnings: string[];
}

export interface NeighbourContact {
  point: V3;
  /** Distance from the prep-top ray origin to the contact along the ray (mm). */
  distanceMm: number;
}

/**
 * FDI quadrant handedness (scans are never mirrored): in quadrants 1 and 3
 * mesial = buccal × occlusal, in quadrants 2 and 4 mesial = occlusal × buccal.
 * Derivation in a right-handed frame (x = patient's right, y = anterior,
 * z = up): lower left 36 has buccal −x, occlusal +z, and (−x) × z = +y, which
 * is mesial. See specs/2026-10-25-fdi-handedness-fix.md.
 */
export function mesialFromBuccal(fdi: number, occlusal: V3, buccal: V3): V3 {
  const q = Math.floor(fdi / 10);
  return normalize(q === 1 || q === 3 ? cross(buccal, occlusal) : cross(occlusal, buccal));
}

const DEG = Math.PI / 180;
const COS_25 = Math.cos(25 * DEG);

/** Front teeth (FDI positions 1–3: incisors and canines) lean; their prep's frame follows the prep's own axis. */
export const isFrontTooth = (fdi: number) => fdi % 10 >= 1 && fdi % 10 <= 3;

/**
 * The front-tooth rule: how far the frame's occlusal turns from the jaw's occlusal toward the prep's wall axis, for a
 * tilt of `tiltDeg` between them. Up to 5° none (an upright prep keeps the jaw frame; the estimate spreads 2–2.5° on
 * upright synthetic incisors), from 10° to 40° the whole tilt, a continuous ramp θ·(θ − 5°)/5° in between, and none
 * beyond 40° (no front tooth leans that far: the estimate is wrong).
 */
export function frontToothTiltDeg(tiltDeg: number): number {
  if (tiltDeg <= 5 || tiltDeg > 40) return 0;
  return tiltDeg >= 10 ? tiltDeg : (tiltDeg * (tiltDeg - 5)) / 5;
}

/** Rotate v about unit axis k by angle a (Rodrigues). */
function rotate(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/**
 * Tooth-local frame from a click on the prep.
 * - occlusal: whole-jaw PCA least-variance axis if within 25° of the mean
 *   vertex normal near the seed (normals of an open scan point out of the
 *   teeth, toward the antagonist), else that local mean normal; flipped
 *   toward the antagonist centroid when one is given.
 * - origin: the prep top under the seed (ray cast down along −occlusal).
 * - mesial-distal line: major axis of crown points (within 12 mm, no lower
 *   than 1.5 mm below the prep top) projected on the occlusal plane.
 * - buccal: away from the arch centroid; mesial from FDI handedness.
 * - front-tooth preps (`prep` with the jaw's triangles, FDI positions 1–3):
 *   the occlusal then turns toward the prep's own axis (the axis of its
 *   walls, stumpWallAxis), gated by frontToothTiltDeg, by one rotation of the
 *   whole frame; the origin is cast again along the new occlusal. Front teeth
 *   lean 15–30° labially, and a crown posed along the jaw's occlusal stands
 *   upright on a leaning prep (specs/2026-10-26-anterior-tooth-frame.md).
 * - contacts: see findNeighbourContacts.
 */
export function estimateToothFrame(input: {
  /** The jaw scan; `indices` (triangles, any order) are needed for the front-tooth rule. */
  jaw: { positions: Float32Array; normals: Float32Array; indices?: ArrayLike<number> };
  antagonist?: { positions: Float32Array };
  seed: V3;
  fdi: number;
  ray: RayCaster;
  /**
   * The click is on a crown prep (not a scan body, a natural tooth for a wing, a cavity or a ridge): on a front tooth
   * the occlusal follows the prep's own axis. Default false (the jaw-level frame).
   */
  prep?: boolean;
}): ToothFrameEstimate {
  const { jaw, seed, fdi, ray } = input;
  const warnings: string[] = [];
  const P = jaw.positions;
  const N = jaw.normals;
  const nv = P.length / 3;

  // Occlusal direction.
  let local: V3 = [0, 0, 0];
  for (let i = 0; i < nv; i++) {
    const dx = P[i * 3]! - seed[0], dy = P[i * 3 + 1]! - seed[1], dz = P[i * 3 + 2]! - seed[2];
    if (dx * dx + dy * dy + dz * dz > 100) continue;
    local = add(local, [N[i * 3]!, N[i * 3 + 1]!, N[i * 3 + 2]!]);
  }
  local = normalize(local);
  const pca = principalAxes(P, 50_000);
  let occlusal: V3 = norm(local) > 0 ? local : pca.axes[2];
  const align = dot(pca.axes[2], local);
  if (Math.abs(align) >= COS_25) occlusal = align >= 0 ? pca.axes[2] : scale(pca.axes[2], -1);
  if (input.antagonist && input.antagonist.positions.length >= 3) {
    const ca = principalAxes(input.antagonist.positions, 20_000).centroid;
    if (dot(occlusal, sub(ca, seed)) < 0) {
      occlusal = scale(occlusal, -1);
      warnings.push('Surface normals point away from the antagonist; check that the scans are assigned to the right jaws.');
    }
  }

  // Prep top under the seed.
  const down = scale(occlusal, -1);
  const topHit = ray.first(add(seed, scale(occlusal, 15)), down, 30);
  let origin: V3 = topHit ? topHit.point : seed;

  // Mesial-distal line from crown points around the prep.
  const e1 = normalize(cross(occlusal, Math.abs(occlusal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const e2 = cross(occlusal, e1);
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, count = 0;
  const step = Math.max(1, Math.floor(nv / 400_000));
  for (let i = 0; i < nv; i += step) {
    const d: V3 = [P[i * 3]! - origin[0], P[i * 3 + 1]! - origin[1], P[i * 3 + 2]! - origin[2]];
    const h = dot(d, occlusal);
    if (h < -1.5) continue;
    const x = dot(d, e1), y = dot(d, e2);
    if (x * x + y * y > 144) continue;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    count++;
  }
  let mdLine: V3 = e1;
  if (count >= 10) {
    const mx = sx / count, my = sy / count;
    const cxx = sxx / count - mx * mx, cxy = sxy / count - mx * my, cyy = syy / count - my * my;
    const { values, vectors } = symmetricEigen3([
      [cxx, cxy, 0],
      [cxy, cyy, 0],
      [0, 0, 0],
    ]);
    const k = values[0]! >= values[1]! ? 0 : 1;
    const ratio = Math.max(values[0]!, values[1]!) / Math.max(1e-9, Math.min(values[0]!, values[1]!));
    if (ratio < 1.5) warnings.push('Mesial-distal direction is uncertain (crowns around the prep are not elongated along the arch); check the frame.');
    mdLine = normalize(add(scale(e1, vectors[0]![k]!), scale(e2, vectors[1]![k]!)));
  } else {
    warnings.push('Too few surface points around the prep to estimate the mesial-distal direction.');
  }

  // Buccal: away from the arch centroid; mesial from handedness.
  const bLine = normalize(cross(mdLine, occlusal));
  const outward = reject(reject(sub(origin, pca.centroid), occlusal), mdLine);
  if (norm(outward) < 1) warnings.push('Could not tell buccal from lingual (prep is near the scan centre); check the frame or flip it.');
  let buccal = dot(bLine, outward) >= 0 ? bLine : scale(bLine, -1);
  let mesial = mesialFromBuccal(fdi, occlusal, buccal);

  // Front-tooth prep: turn the frame toward the prep's own axis.
  if (input.prep && jaw.indices && isFrontTooth(fdi)) {
    const stump = findPrepStump({ positions: P, indices: jaw.indices, frame: { origin, mesial, buccal }, occlusal });
    const axis = stump && stumpWallAxis(stump, occlusal);
    const tiltDeg = axis ? Math.acos(Math.min(1, Math.max(-1, dot(axis, occlusal)))) / DEG : 0;
    const applied = frontToothTiltDeg(tiltDeg);
    if (!axis || tiltDeg > 40) {
      warnings.push(`Could not find the axis of the prep${axis ? ` (${tiltDeg.toFixed(0)}° from the occlusal plane normal)` : ''}: the frame follows the occlusal plane. Check that the click is on the prep.`);
    } else if (applied > 0) {
      const k = normalize(cross(occlusal, axis));
      occlusal = normalize(rotate(occlusal, k, applied * DEG));
      buccal = normalize(reject(rotate(buccal, k, applied * DEG), occlusal));
      mesial = mesialFromBuccal(fdi, occlusal, buccal);
      const hit = ray.first(add(seed, scale(occlusal, 15)), scale(occlusal, -1), 30);
      if (hit) origin = hit.point;
    }
  }

  const contacts = findNeighbourContacts({ origin, occlusal, mesial, buccal, ray });
  if (!contacts.mesial) warnings.push('No mesial neighbour found within 10 mm.');
  if (!contacts.distal) warnings.push('No distal neighbour found within 10 mm.');
  return {
    origin,
    occlusal,
    mesial,
    buccal,
    mesialContact: contacts.mesial?.point,
    distalContact: contacts.distal?.point,
    warnings,
  };
}

/**
 * Neighbour contacts: a fan of rays (heights −2…+2 mm, buccal offsets
 * ±1.5 mm) from the prep top along ±mesial. Per ray, the first front-facing
 * hit at least 0.3 mm away counts if it is no more than 2.5 mm below the
 * prep top (lower means papilla/gingiva, and the ray is discarded). The
 * nearest qualifying hit per side is the contact.
 */
export function findNeighbourContacts(input: {
  origin: V3;
  occlusal: V3;
  mesial: V3;
  buccal: V3;
  ray: RayCaster;
  maxDistanceMm?: number;
}): { mesial?: NeighbourContact; distal?: NeighbourContact } {
  const { origin, occlusal, mesial, buccal, ray } = input;
  const maxDistance = input.maxDistanceMm ?? 10;
  const search = (dir: V3): NeighbourContact | undefined => {
    let best: NeighbourContact | undefined;
    for (let h = -2; h <= 2 + 1e-9; h += 0.5) {
      for (let t = -1.5; t <= 1.5 + 1e-9; t += 0.75) {
        const start = add(add(origin, scale(occlusal, h)), scale(buccal, t));
        for (const hit of ray.all(start, dir, maxDistance)) {
          if (hit.distance < 0.3 || dot(hit.normal, dir) >= 0) continue;
          if (dot(sub(hit.point, origin), occlusal) >= -2.5 && (!best || hit.distance < best.distanceMm)) {
            best = { point: hit.point, distanceMm: hit.distance };
          }
          break;
        }
      }
    }
    return best;
  };
  return { mesial: search(mesial), distal: search(scale(mesial, -1)) };
}
