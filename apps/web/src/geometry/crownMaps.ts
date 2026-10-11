import { planeBasis } from './intaglio';
import type { V3 } from './pca';
import type { RayCaster } from './raycast';
import { signedIntaglioDistance, type IntaglioSurface } from './thickness';

export type CrownMapName = 'thickness' | 'occlusion' | 'proximal' | 'unmillable';

const pointAt = (a: Float32Array, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];

/**
 * Material thickness: signed distance from each vertex in [vertexStart,
 * vertexEnd) to the intaglio (negative = the outer surface dips below the
 * intaglio). NaN for other vertices and beyond `maxMm`.
 */
export function thicknessMap(positions: Float32Array, vertexStart: number, vertexEnd: number, intaglio: IntaglioSurface, maxMm = 5): Float32Array {
  const out = new Float32Array(positions.length / 3).fill(Number.NaN);
  for (let v = vertexStart; v < vertexEnd; v++) {
    const s = signedIntaglioDistance(pointAt(positions, v), intaglio, maxMm);
    if (s) out[v] = s.distance;
  }
  return out;
}

/**
 * Signed clearance from the crown's outer surface to a target surface
 * (antagonist for occlusion, neighbouring teeth for proximal contacts), per
 * vertex in [vertexStart, vertexEnd). Targets are open scan surfaces, so
 * "inside" means behind the surface (on its back side):
 * - positive: distance along the outer normal to the first front-facing hit
 *   (a gap);
 * - negative: the vertex is behind the target surface (the first hit along
 *   −normal is seen from its back side, or the first hit along +normal is a
 *   back face); the value is minus the distance along −normal back to the
 *   surface (penetration depth), or minus the forward hit distance if nothing
 *   is found backward;
 * - NaN: nothing within `maxMm`.
 * Hits on faces flagged in `ignoreFaces` (e.g. the prep region) are skipped.
 */
export function clearanceMap(input: {
  positions: Float32Array;
  normals: Float32Array;
  vertexStart: number;
  vertexEnd: number;
  target: RayCaster;
  ignoreFaces?: Uint8Array;
  maxMm?: number;
}): Float32Array {
  const { positions, normals, vertexStart, vertexEnd, target, ignoreFaces } = input;
  const maxMm = input.maxMm ?? 2;
  const out = new Float32Array(positions.length / 3).fill(Number.NaN);
  const firstHit = (p: V3, d: V3) => target.all(p, d, maxMm).find((h) => !ignoreFaces?.[h.faceIndex]);
  const facing = (normal: V3, d: V3) => normal[0] * d[0] + normal[1] * d[1] + normal[2] * d[2];
  for (let v = vertexStart; v < vertexEnd; v++) {
    const p = pointAt(positions, v);
    const n = pointAt(normals, v);
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue;
    const fwd = firstHit(p, n);
    if (fwd && facing(fwd.normal, n) < 0) {
      out[v] = fwd.distance;
      continue;
    }
    // No gap ahead: are we behind the target surface (penetrating)?
    const bwd = firstHit(p, [-n[0], -n[1], -n[2]]);
    if (bwd && facing(bwd.normal, n) < 0) out[v] = -bwd.distance;
    else if (fwd) out[v] = -fwd.distance;
  }
  return out;
}

/**
 * Intaglio areas a ball-end tool of radius `toolRadiusMm` cannot reach when
 * milling the cavity from its open side (along +axis). The intaglio seen
 * from below is a heightfield H over the plane ⊥ axis (blockout guarantees a
 * single hit per ray). Ball centres can rise to
 *   zMax(x) = min_{|y−x|≤R} H(y) − √(R² − |y−x|²),
 * the tool then reaches reached(x) = max_{|x'−x|≤R} zMax(x') + √(R² − |x−x'|²),
 * and depth = H − reached (≥ 0) is the unmillable material, sampled back
 * (max of the 4 surrounding cells) to the intaglio vertices [vertexStart, vertexEnd) (NaN elsewhere). `intaglio`
 * must cast against the intaglio only.
 */
export function unmillableMap(input: {
  positions: Float32Array;
  vertexStart: number;
  vertexEnd: number;
  intaglio: RayCaster;
  axis: V3;
  toolRadiusMm: number;
  cellMm?: number;
}): Float32Array {
  const { positions, vertexStart, vertexEnd, intaglio, toolRadiusMm: R } = input;
  const out = new Float32Array(positions.length / 3).fill(Number.NaN);
  const axisLen = Math.hypot(...input.axis) || 1;
  const axis: V3 = [input.axis[0] / axisLen, input.axis[1] / axisLen, input.axis[2] / axisLen];
  const [u, w] = planeBasis(axis);
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (R <= 0) {
    for (let v = vertexStart; v < vertexEnd; v++) out[v] = 0;
    return out;
  }
  // 0.08 mm keeps the ball kernel small (~110 cells at R = 0.5 mm); fine enough for a display map.
  const cell = input.cellMm ?? 0.08;
  let minU = Infinity, maxU = -Infinity, minW = Infinity, maxW = -Infinity, minH = Infinity;
  for (let v = vertexStart; v < vertexEnd; v++) {
    const p = pointAt(positions, v);
    const pu = dot(p, u), pw = dot(p, w), ph = dot(p, axis);
    minU = Math.min(minU, pu);
    maxU = Math.max(maxU, pu);
    minW = Math.min(minW, pw);
    maxW = Math.max(maxW, pw);
    minH = Math.min(minH, ph);
  }
  const pad = R + cell;
  minU -= pad;
  minW -= pad;
  const nu = Math.ceil((maxU + pad - minU) / cell) + 1;
  const nw = Math.ceil((maxW + pad - minW) / cell) + 1;
  const start = minH - 10;
  const H = new Float64Array(nu * nw).fill(Number.NaN);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nw; j++) {
      const a = minU + i * cell, b = minW + j * cell;
      const o: V3 = [a * u[0] + b * w[0] + start * axis[0], a * u[1] + b * w[1] + start * axis[1], a * u[2] + b * w[2] + start * axis[2]];
      const hit = intaglio.first(o, axis, 60);
      if (hit) H[i * nw + j] = start + hit.distance;
    }
  }
  // Disk kernel offsets with their spherical cap heights.
  const r = Math.floor(R / cell);
  const kernel: Array<[number, number, number]> = [];
  for (let di = -r; di <= r; di++) {
    for (let dj = -r; dj <= r; dj++) {
      const d2 = (di * cell) ** 2 + (dj * cell) ** 2;
      if (d2 <= R * R) kernel.push([di, dj, Math.sqrt(R * R - d2)]);
    }
  }
  // Ball centre limits; cells without material nearby are unconstrained (Infinity).
  const zMax = new Float64Array(nu * nw).fill(Infinity);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nw; j++) {
      let z = Infinity;
      for (const [di, dj, cap] of kernel) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nu || jj >= nw) continue;
        const h = H[ii * nw + jj]!;
        if (!Number.isNaN(h) && h - cap < z) z = h - cap;
      }
      zMax[i * nw + j] = z;
    }
  }
  const depth = new Float64Array(nu * nw);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nw; j++) {
      const h = H[i * nw + j]!;
      if (Number.isNaN(h)) continue;
      let reached = -Infinity;
      for (const [di, dj, cap] of kernel) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nu || jj >= nw) continue;
        const z = zMax[ii * nw + jj]!;
        if (Number.isFinite(z) && z + cap > reached) reached = z + cap;
      }
      depth[i * nw + j] = Number.isFinite(reached) ? Math.max(0, h - reached) : 0;
    }
  }
  // Sample back to the vertices: max of the 4 surrounding cells, so a vertex on a sharp corner sees the corner's depth.
  const at = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= nu || j >= nw) return 0;
    return depth[i * nw + j]!;
  };
  for (let v = vertexStart; v < vertexEnd; v++) {
    const p = pointAt(positions, v);
    const fu = (dot(p, u) - minU) / cell;
    const fw = (dot(p, w) - minW) / cell;
    const i0 = Math.floor(fu), j0 = Math.floor(fw);
    out[v] = Math.max(at(i0, j0), at(i0 + 1, j0), at(i0, j0 + 1), at(i0 + 1, j0 + 1));
  }
  return out;
}
