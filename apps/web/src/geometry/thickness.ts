import type { DesignParams } from '@dcad/shared';
import type { V3 } from './pca';
import type { RayCaster } from './raycast';
import type { SurfaceGraph } from './surface';

/** Distance from the margin over which the thickness ramps from the margin value to the minimum. */
export const THICKNESS_RAMP_MM = 1;

export type ThicknessParams = Pick<DesignParams, 'marginThicknessMm' | 'minThicknessMm'>;

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Required material thickness at `distMm` from the margin: margin thickness → minimum within 1 mm. */
export function thicknessProfile(distMm: number, params: ThicknessParams): number {
  return params.marginThicknessMm + (params.minThicknessMm - params.marginThicknessMm) * smoothstep(0, THICKNESS_RAMP_MM, distMm);
}

/** Distance from p to a closed polyline (xyz per point). */
export function distanceToLoop(p: V3, loop: Float32Array): number {
  const n = loop.length / 3;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = loop[i * 3]!, ay = loop[i * 3 + 1]!, az = loop[i * 3 + 2]!;
    const bx = loop[j * 3]! - ax, by = loop[j * 3 + 1]! - ay, bz = loop[j * 3 + 2]! - az;
    const px = p[0] - ax, py = p[1] - ay, pz = p[2] - az;
    const len2 = bx * bx + by * by + bz * bz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / len2)) : 0;
    const d = Math.hypot(px - t * bx, py - t * by, pz - t * bz);
    if (d < best) best = d;
  }
  return best;
}

/** The intaglio surface: its ray caster plus the mesh it was built on (BVH-ordered index, so face ids match). */
export interface IntaglioSurface {
  ray: RayCaster;
  positions: Float32Array;
  indices: Uint32Array;
}

/** Signed distance of p from the intaglio: positive on the crown-material side (against the intaglio's face normals). */
export function signedIntaglioDistance(p: V3, intaglio: IntaglioSurface, maxMm: number): { distance: number; point: V3; normal: V3 } | null {
  const cp = intaglio.ray.closestPoint(p, maxMm);
  if (!cp || cp.faceIndex < 0) return null;
  const P = intaglio.positions;
  const f = cp.faceIndex * 3;
  const a = intaglio.indices[f]! * 3, b = intaglio.indices[f + 1]! * 3, c = intaglio.indices[f + 2]! * 3;
  const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
  const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  // Intaglio faces point toward the prep (out of the crown solid); material lies against the normal.
  const side = (p[0] - cp.point[0]) * nx + (p[1] - cp.point[1]) * ny + (p[2] - cp.point[2]) * nz;
  return { distance: side <= 0 ? cp.distance : -cp.distance, point: cp.point, normal: [nx, ny, nz] };
}

export interface ThicknessResult {
  /** Vertices that were pushed at least once. */
  pushedVertices: number;
  maxPushMm: number;
  /** Smallest signed thickness minus requirement before and after (≥ 0 = satisfied). */
  minSlackBeforeMm: number;
  minSlackAfterMm: number;
  /** Final signed thickness per shell vertex (index i = vertexStart + i); NaN for fixed vertices or beyond reach. */
  thicknessMm: Float32Array;
}

/**
 * Enforce the thickness profile on the outer shell (vertices
 * [vertexStart, vertexEnd) of `positions`, moved **in place**): each vertex
 * closer to the intaglio than thicknessProfile(distance to the margin loop)
 * is pushed away from its closest intaglio point by the deficit (vertices that
 * crossed below the intaglio are pushed out along the intaglio normal).
 * The push field is smoothed over the shell graph (local vertex ids) so the
 * surface stays fair; smoothing spreads pushes to neighbours but never
 * shrinks a violator's own push.
 * `fixed` (local ids) never move, e.g. the cervical ring.
 */
export function enforceThickness(input: {
  positions: Float32Array;
  vertexStart: number;
  vertexEnd: number;
  intaglio: IntaglioSurface;
  marginLoop: Float32Array;
  params: ThicknessParams;
  shellGraph?: SurfaceGraph;
  fixed?: Uint8Array;
  iterations?: number;
}): ThicknessResult {
  const { positions, vertexStart, vertexEnd, intaglio, marginLoop, params, shellGraph, fixed } = input;
  const count = vertexEnd - vertexStart;
  const point = (i: number): V3 => {
    const v = vertexStart + i;
    return [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
  };
  // The requirement depends on the distance to the margin, which changes as vertices move.
  const required = (p: V3) => thicknessProfile(distanceToLoop(p, marginLoop), params);
  const reach = params.minThicknessMm + 2;
  const thicknessMm = new Float32Array(count).fill(Number.NaN);
  /** Measure every free vertex; returns the smallest slack and fills thicknessMm. */
  const measure = (): number => {
    let min = Infinity;
    for (let i = 0; i < count; i++) {
      if (fixed?.[i]) continue;
      const p = point(i);
      const s = signedIntaglioDistance(p, intaglio, reach);
      if (!s) continue;
      thicknessMm[i] = s.distance;
      min = Math.min(min, s.distance - required(p));
    }
    return min;
  };
  const minSlackBefore = measure();
  if (minSlackBefore >= 0) {
    return { pushedVertices: 0, maxPushMm: 0, minSlackBeforeMm: minSlackBefore, minSlackAfterMm: minSlackBefore, thicknessMm };
  }

  const pushed = new Uint8Array(count);
  let maxPush = 0;
  const push = new Float32Array(count * 3);
  // Vertices near the margin chase a requirement that grows as they move away from it, so allow a few rounds.
  const iterations = input.iterations ?? 6;
  for (let it = 0; it < iterations; it++) {
    push.fill(0);
    let any = false;
    const need = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      if (fixed?.[i]) continue;
      const p = point(i);
      const s = signedIntaglioDistance(p, intaglio, reach);
      if (!s) continue;
      // Small overshoot so the next measurement clears the profile despite smoothing.
      const deficit = required(p) - s.distance + 0.005;
      if (deficit <= 0.005) continue;
      let dir: V3;
      if (s.distance > 1e-4) {
        dir = [(p[0] - s.point[0]) / s.distance, (p[1] - s.point[1]) / s.distance, (p[2] - s.point[2]) / s.distance];
      } else {
        // On or below the intaglio: out along the material side.
        dir = [-s.normal[0], -s.normal[1], -s.normal[2]];
      }
      push[i * 3] = dir[0] * deficit;
      push[i * 3 + 1] = dir[1] * deficit;
      push[i * 3 + 2] = dir[2] * deficit;
      need[i] = deficit;
      any = true;
    }
    if (!any) break;
    if (shellGraph) {
      for (let pass = 0; pass < 2; pass++) {
        const next = push.slice();
        for (let i = 0; i < count; i++) {
          if (fixed?.[i]) continue;
          const s0 = shellGraph.offsets[i]!, s1 = shellGraph.offsets[i + 1]!;
          if (s1 === s0) continue;
          let ax = 0, ay = 0, az = 0;
          for (let k = s0; k < s1; k++) {
            const j = shellGraph.neighbors[k]!;
            ax += push[j * 3]!;
            ay += push[j * 3 + 1]!;
            az += push[j * 3 + 2]!;
          }
          const deg = s1 - s0;
          let nx = 0.5 * push[i * 3]! + (0.5 * ax) / deg;
          let ny = 0.5 * push[i * 3 + 1]! + (0.5 * ay) / deg;
          let nz = 0.5 * push[i * 3 + 2]! + (0.5 * az) / deg;
          const len = Math.hypot(nx, ny, nz);
          if (need[i]! > 0 && len < need[i]!) {
            // Smoothing spreads pushes to neighbours but never shrinks a violator's own push.
            const own = Math.hypot(push[i * 3]!, push[i * 3 + 1]!, push[i * 3 + 2]!) || 1;
            nx = (push[i * 3]! / own) * need[i]!;
            ny = (push[i * 3 + 1]! / own) * need[i]!;
            nz = (push[i * 3 + 2]! / own) * need[i]!;
          }
          next[i * 3] = nx;
          next[i * 3 + 1] = ny;
          next[i * 3 + 2] = nz;
        }
        push.set(next);
      }
    }
    for (let i = 0; i < count; i++) {
      if (fixed?.[i]) continue;
      const len = Math.hypot(push[i * 3]!, push[i * 3 + 1]!, push[i * 3 + 2]!);
      if (len < 1e-7) continue;
      const v = vertexStart + i;
      for (let k = 0; k < 3; k++) positions[v * 3 + k] = positions[v * 3 + k]! + push[i * 3 + k]!;
      pushed[i] = 1;
      maxPush = Math.max(maxPush, len);
    }
  }
  let pushedVertices = 0;
  for (let i = 0; i < count; i++) pushedVertices += pushed[i]!;
  thicknessMm.fill(Number.NaN);
  const minSlackAfter = measure();
  return { pushedVertices, maxPushMm: maxPush, minSlackBeforeMm: minSlackBefore, minSlackAfterMm: minSlackAfter, thicknessMm };
}
