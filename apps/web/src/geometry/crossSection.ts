import type { V3 } from './pca';

/**
 * The scan's profile through one point, across the margin (specs/2026-10-27-margin-review-ux.md): the plane through
 * `centre` spanned by the tooth axis (`up`) and the outward direction (`across`) cuts the mesh, and the cut is
 * returned as 2D segments (s along `across`, h along `up`, mm from `centre`). It is how a technician judges where a
 * finish line or a gum line really is (exocad's margin cross-section). A coarse grid of triangles keeps a hover cheap.
 */

export interface TriangleGrid {
  cellMm: number;
  min: V3;
  dims: [number, number, number];
  /** CSR: triangles of cell c are tris[offsets[c] .. offsets[c + 1]). */
  offsets: Uint32Array;
  tris: Uint32Array;
}

/** Bucket every triangle by the cell of its centroid (triangles are much smaller than a cell). */
export function buildTriangleGrid(positions: Float32Array, indices: Uint32Array, cellMm = 2): TriangleGrid {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, positions[i + k]!);
      max[k] = Math.max(max[k]!, positions[i + k]!);
    }
  }
  const dims: [number, number, number] = [0, 1, 2].map((k) => Math.max(1, Math.ceil((max[k]! - min[k]!) / cellMm) + 1)) as [number, number, number];
  const triangles = indices.length / 3;
  const cellOf = new Uint32Array(triangles);
  const counts = new Uint32Array(dims[0] * dims[1] * dims[2] + 1);
  for (let t = 0; t < triangles; t++) {
    const c: number[] = [0, 1, 2].map((k) => {
      const centroid = (positions[indices[t * 3]! * 3 + k]! + positions[indices[t * 3 + 1]! * 3 + k]! + positions[indices[t * 3 + 2]! * 3 + k]!) / 3;
      return Math.min(dims[k]! - 1, Math.floor((centroid - min[k]!) / cellMm));
    });
    const cell = c[0]! + dims[0] * (c[1]! + dims[1] * c[2]!);
    cellOf[t] = cell;
    counts[cell + 1]!++;
  }
  const offsets = new Uint32Array(counts.length);
  for (let c = 1; c < counts.length; c++) offsets[c] = offsets[c - 1]! + counts[c]!;
  const fill = offsets.slice(0, -1);
  const tris = new Uint32Array(triangles);
  for (let t = 0; t < triangles; t++) tris[fill[cellOf[t]!]!++] = t;
  return { cellMm, min, dims, offsets, tris };
}

export function crossSection(
  positions: Float32Array,
  indices: Uint32Array,
  grid: TriangleGrid,
  centre: V3,
  up: V3,
  across: V3,
  halfMm: number,
): Float32Array {
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a: V3) => Math.hypot(a[0], a[1], a[2]) || 1;
  const u: V3 = [up[0] / len(up), up[1] / len(up), up[2] / len(up)];
  const a0: V3 = [across[0] - dot(across, u) * u[0], across[1] - dot(across, u) * u[1], across[2] - dot(across, u) * u[2]];
  const a: V3 = [a0[0] / len(a0), a0[1] / len(a0), a0[2] / len(a0)];
  const normal: V3 = [u[1] * a[2] - u[2] * a[1], u[2] * a[0] - u[0] * a[2], u[0] * a[1] - u[1] * a[0]];
  const out: number[] = [];
  const reach = halfMm + grid.cellMm;
  const lo = [0, 1, 2].map((k) => Math.max(0, Math.floor((centre[k]! - reach - grid.min[k]!) / grid.cellMm)));
  const hi = [0, 1, 2].map((k) => Math.min(grid.dims[k]! - 1, Math.floor((centre[k]! + reach - grid.min[k]!) / grid.cellMm)));
  const vertex = (v: number): V3 => [positions[v * 3]! - centre[0], positions[v * 3 + 1]! - centre[1], positions[v * 3 + 2]! - centre[2]];
  for (let z = lo[2]!; z <= hi[2]!; z++) {
    for (let y = lo[1]!; y <= hi[1]!; y++) {
      for (let x = lo[0]!; x <= hi[0]!; x++) {
        const cell = x + grid.dims[0] * (y + grid.dims[1] * z);
        for (let k = grid.offsets[cell]!; k < grid.offsets[cell + 1]!; k++) {
          const t = grid.tris[k]!;
          const p = [vertex(indices[t * 3]!), vertex(indices[t * 3 + 1]!), vertex(indices[t * 3 + 2]!)] as const;
          const d = p.map((q) => dot(q, normal));
          const cut: Array<[number, number]> = [];
          for (let e = 0; e < 3; e++) {
            const i = e, j = (e + 1) % 3;
            if (d[i]! > 0 === d[j]! > 0) continue;
            const s = d[i]! / (d[i]! - d[j]!);
            const q: V3 = [p[i]![0] + s * (p[j]![0] - p[i]![0]), p[i]![1] + s * (p[j]![1] - p[i]![1]), p[i]![2] + s * (p[j]![2] - p[i]![2])];
            cut.push([dot(q, a), dot(q, u)]);
          }
          if (cut.length !== 2) continue;
          if (cut.some(([s, h]) => Math.abs(s) > halfMm || Math.abs(h) > halfMm)) continue;
          out.push(cut[0]![0], cut[0]![1], cut[1]![0], cut[1]![1]);
        }
      }
    }
  }
  return Float32Array.from(out);
}
