import type { IndexedMesh } from './mesh';

export interface MeshValidation {
  triangles: number;
  vertices: number;
  /** Undirected edges used by exactly one triangle. */
  boundaryEdges: number;
  /** Undirected edges used by more than two triangles. */
  nonManifoldEdges: number;
  /** Edges whose directed form is used more than once (neighbouring triangles wound inconsistently). */
  inconsistentEdges: number;
  /** Triangles with a repeated vertex or area < 1e-12 mm². */
  degenerateTriangles: number;
  /** Σ a·(b×c)/6; positive for a closed mesh with outward normals. */
  signedVolumeMm3: number;
  closed: boolean;
  oriented: boolean;
  /** closed && oriented && volume > 0 && no degenerate triangles. */
  ok: boolean;
}

interface EdgeUse {
  /** Uses as (lo → hi). */
  forward: number;
  /** Uses as (hi → lo). */
  backward: number;
}

function edgeUses(mesh: Pick<IndexedMesh, 'positions' | 'indices'>): Map<number, EdgeUse> {
  const nv = mesh.positions.length / 3;
  const idx = mesh.indices;
  const edges = new Map<number, EdgeUse>();
  for (let f = 0; f < idx.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[f + k]!;
      const b = idx[f + ((k + 1) % 3)]!;
      if (a === b) continue;
      const key = a < b ? a * nv + b : b * nv + a;
      let e = edges.get(key);
      if (!e) {
        e = { forward: 0, backward: 0 };
        edges.set(key, e);
      }
      if (a < b) e.forward++;
      else e.backward++;
    }
  }
  return edges;
}

/**
 * Topology and orientation checks for an exported restoration: a valid
 * crown is closed (every edge shared by exactly two triangles), consistently
 * oriented (each directed edge used once) and encloses positive volume.
 * Self-intersection is not checked here.
 */
export function validateClosedMesh(mesh: Pick<IndexedMesh, 'positions' | 'indices'>): MeshValidation {
  const p = mesh.positions;
  const idx = mesh.indices;
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (const e of edgeUses(mesh).values()) {
    const n = e.forward + e.backward;
    if (n === 1) boundaryEdges++;
    else if (n > 2) nonManifoldEdges++;
    if (e.forward > 1 || e.backward > 1) inconsistentEdges++;
  }
  let degenerateTriangles = 0;
  let volume = 0;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f]!, b = idx[f + 1]!, c = idx[f + 2]!;
    const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!;
    const bx = p[b * 3]!, by = p[b * 3 + 1]!, bz = p[b * 3 + 2]!;
    const cx = p[c * 3]!, cy = p[c * 3 + 1]!, cz = p[c * 3 + 2]!;
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (a === b || b === c || a === c || area < 1e-12) degenerateTriangles++;
  }
  const closed = boundaryEdges === 0 && nonManifoldEdges === 0;
  const oriented = inconsistentEdges === 0;
  return {
    triangles: idx.length / 3,
    vertices: p.length / 3,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    degenerateTriangles,
    signedVolumeMm3: volume,
    closed,
    oriented,
    ok: closed && oriented && volume > 0 && degenerateTriangles === 0,
  };
}

/**
 * Ordered boundary loops (vertex ids), following each boundary edge in its
 * triangle's direction. Assumes a manifold boundary (one outgoing boundary
 * edge per boundary vertex).
 */
export function boundaryLoops(mesh: Pick<IndexedMesh, 'positions' | 'indices'>): Uint32Array[] {
  const idx = mesh.indices;
  const edges = edgeUses(mesh);
  const nv = mesh.positions.length / 3;
  const next = new Map<number, number>();
  for (let f = 0; f < idx.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[f + k]!;
      const b = idx[f + ((k + 1) % 3)]!;
      const e = edges.get(a < b ? a * nv + b : b * nv + a);
      if (e && e.forward + e.backward === 1) next.set(a, b);
    }
  }
  const loops: Uint32Array[] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !seen.has(v)) {
      seen.add(v);
      loop.push(v);
      v = next.get(v);
    }
    loops.push(Uint32Array.from(loop));
  }
  return loops;
}
