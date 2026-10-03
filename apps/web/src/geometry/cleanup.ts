import { compactVertices, type IndexedMesh } from './mesh';

export interface CleanupStats {
  removedDegenerate: number;
  removedDuplicate: number;
  removedSmallComponentFaces: number;
  removedComponents: number;
  keptComponents: number;
}

export interface CleanupOptions {
  /** Faces with area below this (mm²) are degenerate. */
  minArea?: number;
  /** Components with fewer faces than ratio × largest component are removed. */
  smallComponentRatio?: number;
}

/**
 * Remove degenerate faces (repeated indices, zero/NaN area), duplicate faces
 * (same vertex set regardless of winding), and small disconnected components
 * (scan debris such as tongue/cheek fragments). Unused vertices are dropped.
 */
export function cleanupMesh(mesh: IndexedMesh, options: CleanupOptions = {}): { mesh: IndexedMesh; stats: CleanupStats } {
  const minArea = options.minArea ?? 1e-10;
  const ratio = options.smallComponentRatio ?? 0.01;

  const afterDegenerate = removeDegenerateFaces(mesh, minArea);
  const afterDuplicate = removeDuplicateFaces(afterDegenerate.mesh);
  const afterComponents = removeSmallComponents(afterDuplicate.mesh, ratio);
  return {
    mesh: compactVertices(afterComponents.mesh),
    stats: {
      removedDegenerate: afterDegenerate.removed,
      removedDuplicate: afterDuplicate.removed,
      removedSmallComponentFaces: afterComponents.removedFaces,
      removedComponents: afterComponents.removedComponents,
      keptComponents: afterComponents.keptComponents,
    },
  };
}

function filterFaces(mesh: IndexedMesh, keep: Uint8Array, kept: number): IndexedMesh {
  if (kept === mesh.indices.length / 3) return mesh;
  const indices = new Uint32Array(kept * 3);
  let o = 0;
  for (let f = 0; f < keep.length; f++) {
    if (!keep[f]) continue;
    indices[o++] = mesh.indices[f * 3]!;
    indices[o++] = mesh.indices[f * 3 + 1]!;
    indices[o++] = mesh.indices[f * 3 + 2]!;
  }
  return { ...mesh, indices };
}

export function removeDegenerateFaces(mesh: IndexedMesh, minArea: number): { mesh: IndexedMesh; removed: number } {
  const p = mesh.positions;
  const faces = mesh.indices.length / 3;
  const keep = new Uint8Array(faces);
  const min2 = minArea * 2; // |cross| = 2 × area
  let kept = 0;
  for (let f = 0; f < faces; f++) {
    const a = mesh.indices[f * 3]!;
    const b = mesh.indices[f * 3 + 1]!;
    const c = mesh.indices[f * 3 + 2]!;
    if (a === b || b === c || a === c) continue;
    const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!;
    const ux = p[b * 3]! - ax, uy = p[b * 3 + 1]! - ay, uz = p[b * 3 + 2]! - az;
    const vx = p[c * 3]! - ax, vy = p[c * 3 + 1]! - ay, vz = p[c * 3 + 2]! - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (!(len > min2)) continue; // also rejects NaN
    keep[f] = 1;
    kept++;
  }
  return { mesh: filterFaces(mesh, keep, kept), removed: faces - kept };
}

export function removeDuplicateFaces(mesh: IndexedMesh): { mesh: IndexedMesh; removed: number } {
  const faces = mesh.indices.length / 3;
  let size = 1;
  while (size < faces * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const sorted = new Uint32Array(faces * 3);
  const keep = new Uint8Array(faces);
  let kept = 0;
  for (let f = 0; f < faces; f++) {
    let a = mesh.indices[f * 3]!, b = mesh.indices[f * 3 + 1]!, c = mesh.indices[f * 3 + 2]!;
    if (a > b) [a, b] = [b, a];
    if (b > c) [b, c] = [c, b];
    if (a > b) [a, b] = [b, a];
    sorted[f * 3] = a;
    sorted[f * 3 + 1] = b;
    sorted[f * 3 + 2] = c;
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) >>> 0;
    h = (h ^ (h >>> 16)) & mask;
    let duplicate = false;
    for (;;) {
      const slot = table[h]!;
      if (slot === -1) {
        table[h] = f;
        break;
      }
      if (sorted[slot * 3] === a && sorted[slot * 3 + 1] === b && sorted[slot * 3 + 2] === c) {
        duplicate = true;
        break;
      }
      h = (h + 1) & mask;
    }
    if (!duplicate) {
      keep[f] = 1;
      kept++;
    }
  }
  return { mesh: filterFaces(mesh, keep, kept), removed: faces - kept };
}

function find(parent: Int32Array, x: number): number {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]!]!; // path halving
    x = parent[x]!;
  }
  return x;
}

function union(parent: Int32Array, rank: Uint8Array, a: number, b: number): void {
  let ra = find(parent, a);
  let rb = find(parent, b);
  if (ra === rb) return;
  if (rank[ra]! < rank[rb]!) [ra, rb] = [rb, ra];
  parent[rb] = ra;
  if (rank[ra] === rank[rb]) rank[ra]!++;
}

export interface ComponentInfo {
  /** Component id (root vertex) per face. */
  faceComponent: Int32Array;
  /** Face count per component root. */
  sizes: Map<number, number>;
}

/** Connected components over faces sharing vertices. */
export function faceComponents(mesh: IndexedMesh): ComponentInfo {
  const n = mesh.positions.length / 3;
  const faces = mesh.indices.length / 3;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const rank = new Uint8Array(n);
  for (let f = 0; f < faces; f++) {
    const a = mesh.indices[f * 3]!;
    union(parent, rank, a, mesh.indices[f * 3 + 1]!);
    union(parent, rank, a, mesh.indices[f * 3 + 2]!);
  }
  const faceComponent = new Int32Array(faces);
  const sizes = new Map<number, number>();
  for (let f = 0; f < faces; f++) {
    const root = find(parent, mesh.indices[f * 3]!);
    faceComponent[f] = root;
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  return { faceComponent, sizes };
}

export function removeSmallComponents(
  mesh: IndexedMesh,
  ratio: number,
): { mesh: IndexedMesh; removedFaces: number; removedComponents: number; keptComponents: number } {
  const faces = mesh.indices.length / 3;
  if (faces === 0) return { mesh, removedFaces: 0, removedComponents: 0, keptComponents: 0 };
  const { faceComponent, sizes } = faceComponents(mesh);
  let largest = 0;
  for (const s of sizes.values()) if (s > largest) largest = s;
  const threshold = Math.max(1, ratio * largest);
  let removedComponents = 0;
  for (const s of sizes.values()) if (s < threshold) removedComponents++;
  const keep = new Uint8Array(faces);
  let kept = 0;
  for (let f = 0; f < faces; f++) {
    if (sizes.get(faceComponent[f]!)! >= threshold) {
      keep[f] = 1;
      kept++;
    }
  }
  return {
    mesh: filterFaces(mesh, keep, kept),
    removedFaces: faces - kept,
    removedComponents,
    keptComponents: sizes.size - removedComponents,
  };
}
