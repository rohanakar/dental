import type { V3 } from './pca';
import type { RayCaster } from './raycast';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface AutoMarginInput {
  positions: Float32Array;
  /** BVH-ordered triangle index (faces from `ray` hits index into it). */
  indices: Uint32Array;
  /**
   * Optional signed vertex curvature (1/mm, convex > 0), blended into the
   * profile convexity with `curvatureWeight` (default 0: on anisotropic or
   * noisy meshes the 1-ring estimate is unreliable across a ridge).
   */
  curvature?: Float32Array;
  curvatureWeight?: number;
  ray: RayCaster;
  /** Tooth frame; `origin` is the prep top. */
  frame: { origin: V3; occlusal: V3; mesial: V3 };
  /** Radial profiles (= anchors when every profile finds the ridge). */
  count?: number;
  /** How far from the prep top a profile may search. */
  maxRadiusMm?: number;
  stepMm?: number;
  /** The margin is at least this far below the prep top (past the axial wall). */
  minDropMm?: number;
  /** Stop a profile when the surface rises this much above its lowest point (a neighbour tooth). */
  riseStopMm?: number;
  /** Half-width of the slope window used for the convexity score. */
  windowMm?: number;
  /** Minimum slope change (dimensionless) for a profile to count as finding the margin. */
  minConvexity?: number;
}

export interface AutoMarginProfile {
  angleDeg: number;
  found: boolean;
  radiusMm?: number;
  dropMm?: number;
  /** Slope change across the anchor (dimensionless; larger = sharper convex edge). */
  convexity?: number;
  /** Why a profile stopped: 'neighbour', 'edge' (ran off the scan) or 'radius'. */
  stop: 'neighbour' | 'edge' | 'radius';
}

export interface AutoMarginResult {
  /** Margin anchors in angular order around the occlusal axis (CCW seen from occlusal). */
  anchors: V3[];
  profiles: AutoMarginProfile[];
  /** Fraction of profiles that found a ridge (0..1). */
  confidence: number;
}

/**
 * Automatic margin anchors (classical.margin-ridge): radial height profiles
 * around the prep top, sampled by casting rays from above along −occlusal.
 * On each profile, past the axial wall (≥ minDropMm below the prep top) and
 * before the surface rises onto a neighbour, the anchor is the first strong
 * convexity peak (largest drop in slope across ±windowMm, at least half the
 * profile's maximum): the margin
 * is the convex edge where the ledge/chamfer meets the root, while the
 * chamfer floor and sulcus are concave. Purely geometric along the profile,
 * so it does not depend on mesh resolution. The caller closes the loop with
 * the live-wire (marginFromAnchors).
 */
export function proposeMarginAnchors(input: AutoMarginInput): AutoMarginResult {
  const { positions, indices, curvature, ray } = input;
  const curvatureWeight = input.curvatureWeight ?? 0;
  const curvatureAt = (k: Float32Array, p: V3): number => {
    // Nearest scan vertex to p via the ray's closest face; cheap enough for one sample per profile step.
    const hit = ray.closestPoint(p, 0.5);
    if (!hit) return 0;
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < 3; c++) {
      const vtx = indices[hit.faceIndex * 3 + c]!;
      const d = Math.hypot(positions[vtx * 3]! - p[0], positions[vtx * 3 + 1]! - p[1], positions[vtx * 3 + 2]! - p[2]);
      if (d < bestD) {
        bestD = d;
        best = k[vtx]!;
      }
    }
    return best;
  };
  const count = input.count ?? 16;
  const maxR = input.maxRadiusMm ?? 8;
  const step = input.stepMm ?? 0.05;
  const minDrop = input.minDropMm ?? 1.5;
  const riseStop = input.riseStopMm ?? 0.5;
  const o = normalize(input.frame.occlusal);
  const m = input.frame.mesial;
  const u = normalize([m[0] - dot(m, o) * o[0], m[1] - dot(m, o) * o[1], m[2] - dot(m, o) * o[2]]);
  const v = cross(o, u);
  const origin = input.frame.origin;
  const topH = dot(origin, o);
  const down: V3 = [-o[0], -o[1], -o[2]];
  const lift = 20;

  const window = Math.max(2, Math.round((input.windowMm ?? 0.2) / step));
  const anchors: V3[] = [];
  const profiles: AutoMarginProfile[] = [];
  for (let k = 0; k < count; k++) {
    const theta = (2 * Math.PI * k) / count;
    const dir: V3 = [
      Math.cos(theta) * u[0] + Math.sin(theta) * v[0],
      Math.cos(theta) * u[1] + Math.sin(theta) * v[1],
      Math.cos(theta) * u[2] + Math.sin(theta) * v[2],
    ];
    // 1. The height profile (heights relative to the prep top, ≤ 0 going down).
    const rs: number[] = [];
    const hs: number[] = [];
    const points: V3[] = [];
    let minH = Infinity;
    let misses = 0;
    let stop: AutoMarginProfile['stop'] = 'radius';
    for (let r = step; r <= maxR; r += step) {
      const start: V3 = [
        origin[0] + r * dir[0] + lift * o[0],
        origin[1] + r * dir[1] + lift * o[1],
        origin[2] + r * dir[2] + lift * o[2],
      ];
      const hit = ray.first(start, down, 2 * lift);
      if (!hit) {
        if (++misses > 10) {
          stop = 'edge';
          break;
        }
        continue;
      }
      misses = 0;
      const h = dot(hit.point, o) - topH;
      if (minH < -minDrop && h > minH + riseStop) {
        stop = 'neighbour';
        break;
      }
      minH = Math.min(minH, h);
      rs.push(r);
      hs.push(h);
      points.push(hit.point);
    }
    // 2. Convexity = how much steeper the profile gets across a sample
    //    (slope before − slope after over ±window samples): the margin is the
    //    convex edge where the ledge/chamfer meets the root; the chamfer floor
    //    and the sulcus are concave (negative).
    const scores: number[] = new Array<number>(hs.length).fill(-Infinity);
    let maxScore = -Infinity;
    for (let i = window; i + window < hs.length; i++) {
      if (-hs[i]! < minDrop) continue;
      const before = (hs[i]! - hs[i - window]!) / (rs[i]! - rs[i - window]!);
      const after = (hs[i + window]! - hs[i]!) / (rs[i + window]! - rs[i]!);
      let score = before - after;
      if (curvature && curvatureWeight) score += curvatureWeight * curvatureAt(curvature, points[i]!);
      scores[i] = score;
      maxScore = Math.max(maxScore, score);
    }
    // The margin is the FIRST strong convex edge going outward: further out,
    // the interdental gum or the scan border can look as convex (or more).
    // Take the first local peak reaching half the profile's maximum.
    let best: { i: number; score: number } | null = null;
    const threshold = Math.max(input.minConvexity ?? 0.5, 0.5 * maxScore);
    for (let i = 0; i < scores.length; i++) {
      if (scores[i]! < threshold) continue;
      let j = i;
      while (j + 1 < scores.length && scores[j + 1]! >= scores[j]!) j++;
      best = { i: j, score: scores[j]! };
      break;
    }
    const found = Boolean(best && best.score > (input.minConvexity ?? 0.5));
    if (found) anchors.push(points[best!.i]!);
    profiles.push({
      angleDeg: (theta * 180) / Math.PI,
      found,
      stop,
      ...(best ? { radiusMm: rs[best.i]!, dropMm: -hs[best.i]!, convexity: best.score } : {}),
    });
  }
  return { anchors, profiles, confidence: anchors.length / count };
}
