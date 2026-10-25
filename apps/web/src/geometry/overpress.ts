import type { CrownValidation } from './crown';
import { compactVertices, type IndexedMesh } from './mesh';
import { differenceMeshes, unionMeshes } from './meshBoolean';
import { validateClosedMesh } from './meshValidate';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh } from './raycast';
import { countSelfIntersections } from './selfIntersect';

/**
 * Overpress: the full anatomy minus the reduced unit (the cutback), as a
 * closed solid to press in wax over the framework. Needs the boolean engine:
 * `await initMeshBoolean()` first (see meshBoolean.ts).
 */

/** Overpress pieces thinner than this (mm, estimated as 2·volume/area) are dropped. */
export const OVERPRESS_MIN_THICKNESS_MM = 0.05;

export interface OverpressResult {
  mesh: IndexedMesh;
  validation: CrownValidation;
  /** Components kept (one per separate veneer region). */
  components: number;
  volumeMm3: number;
  /** Sliver components below the minimum thickness that were dropped. */
  dropped: { components: number; volumeMm3: number };
  timingsMs: Record<string, number>;
}

interface Component {
  faces: number[];
  volume: number;
  area: number;
}

/** Split a closed mesh into face-connected components (through shared vertices), with volume and area each. */
function components(mesh: IndexedMesh): Component[] {
  const idx = mesh.indices;
  const P = mesh.positions;
  const nv = P.length / 3;
  const parent = new Int32Array(nv);
  for (let v = 0; v < nv; v++) parent[v] = v;
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]!]!;
      v = parent[v]!;
    }
    return v;
  };
  for (let f = 0; f < idx.length; f += 3) {
    const a = find(idx[f]!), b = find(idx[f + 1]!), c = find(idx[f + 2]!);
    parent[b] = a;
    parent[c] = a;
  }
  const byRoot = new Map<number, Component>();
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f]! * 3, b = idx[f + 1]! * 3, c = idx[f + 2]! * 3;
    const r = find(idx[f]!);
    let comp = byRoot.get(r);
    if (!comp) {
      comp = { faces: [], volume: 0, area: 0 };
      byRoot.set(r, comp);
    }
    comp.faces.push(f / 3);
    const ax = P[a]!, ay = P[a + 1]!, az = P[a + 2]!;
    const bx = P[b]!, by = P[b + 1]!, bz = P[b + 2]!;
    const cx = P[c]!, cy = P[c + 1]!, cz = P[c + 2]!;
    comp.volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    comp.area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return [...byRoot.values()];
}

/**
 * Overpress solid: anatomy − reduced (manifold-3d difference). Components
 * thinner than `minThicknessMm` (2·volume/area) are dropped: slivers where
 * the protection pushed the framework back almost to the anatomy. Both inputs
 * must be closed, outward-oriented solids.
 */
export function overpressSolid(anatomy: IndexedMesh, reduced: IndexedMesh, opts: { minThicknessMm?: number } = {}): OverpressResult {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = now - t;
    t = now;
  };
  const min = opts.minThicknessMm ?? OVERPRESS_MIN_THICKNESS_MM;
  const raw = differenceMeshes(anatomy, reduced);
  lap('difference');
  const kept: number[] = [];
  let volume = 0;
  let count = 0;
  const dropped = { components: 0, volumeMm3: 0 };
  for (const c of components(raw)) {
    if (c.area <= 0 || (2 * c.volume) / c.area < min) {
      dropped.components++;
      dropped.volumeMm3 += c.volume;
      continue;
    }
    count++;
    volume += c.volume;
    for (const f of c.faces) kept.push(raw.indices[f * 3]!, raw.indices[f * 3 + 1]!, raw.indices[f * 3 + 2]!);
  }
  const mesh = compactVertices({ positions: raw.positions, indices: Uint32Array.from(kept) });
  lap('slivers');
  const closed = validateClosedMesh(mesh);
  const selfIntersections = mesh.indices.length > 0 ? countSelfIntersections(mesh).count : 0;
  lap('validate');
  return {
    mesh,
    validation: { ...closed, selfIntersections, printable: closed.ok && selfIntersections === 0 },
    components: count,
    volumeMm3: volume,
    dropped,
    timingsMs: timings,
  };
}

export interface ReassemblyCheck {
  /** Largest distance from an anatomy vertex to the outer surface of framework ∪ overpress (mm). */
  anatomyToPartsMm: number;
  /** Largest distance from a vertex of the outer surface of framework ∪ overpress to the anatomy surface (mm). */
  partsToAnatomyMm: number;
  /** max of both: the vertex-sampled Hausdorff distance between the outer surfaces. */
  hausdorffMm: number;
  /** Volume of framework ∪ overpress minus the anatomy's (mm³). */
  volumeDifferenceMm3: number;
  /**
   * Shells of the union besides the outer one: closed voids left between the
   * parts (negative volume) or loose pieces (positive). Float rounding of the
   * boolean output can leave a few micro-voids on the shared interface.
   */
  extraShells: { count: number; volumeMm3: number };
  closed: boolean;
}

/** Largest distance from any vertex of `from` to the surface of `to`. */
function oneSidedMm(from: IndexedMesh, to: IndexedMesh): number {
  const ray = bvhRayCaster(createBvh({ positions: to.positions, indices: to.indices.slice() }));
  let worst = 0;
  for (let v = 0; v < from.positions.length / 3; v++) {
    const p: V3 = [from.positions[v * 3]!, from.positions[v * 3 + 1]!, from.positions[v * 3 + 2]!];
    const cp = ray.closestPoint(p, 10);
    worst = Math.max(worst, cp ? cp.distance : 10);
  }
  return worst;
}

/**
 * Does the anatomy come back as framework ∪ overpress? Unions the two parts
 * and measures the two-sided, vertex-sampled Hausdorff distance between the
 * union's outer shell and the anatomy; other shells are reported separately.
 */
export function checkReassembly(anatomy: IndexedMesh, framework: IndexedMesh, overpress: IndexedMesh): ReassemblyCheck {
  const union = overpress.indices.length > 0 ? unionMeshes([framework, overpress]) : framework;
  const shells = components(union).sort((a, b) => b.faces.length - a.faces.length);
  const outer = shells[0]!;
  const outerIdx: number[] = [];
  for (const f of outer.faces) outerIdx.push(union.indices[f * 3]!, union.indices[f * 3 + 1]!, union.indices[f * 3 + 2]!);
  const outerMesh = compactVertices({ positions: union.positions, indices: Uint32Array.from(outerIdx) });
  const anatomyToPartsMm = oneSidedMm(anatomy, outerMesh);
  const partsToAnatomyMm = oneSidedMm(outerMesh, anatomy);
  let extraVolume = 0;
  for (const s of shells.slice(1)) extraVolume += s.volume;
  return {
    anatomyToPartsMm,
    partsToAnatomyMm,
    hausdorffMm: Math.max(anatomyToPartsMm, partsToAnatomyMm),
    volumeDifferenceMm3: validateClosedMesh(union).signedVolumeMm3 - validateClosedMesh(anatomy).signedVolumeMm3,
    extraShells: { count: shells.length - 1, volumeMm3: extraVolume },
    closed: validateClosedMesh(union).closed,
  };
}
