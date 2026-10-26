import { distanceFromMargin } from './intaglio';
import { marginFromAnchors, resampleClosedPolyline, smoothClosedPolyline, snapToVertex, type EdgeWeight, type MarginTrace } from './livewire';
import { boundaryLoops } from './meshValidate';
import type { V3 } from './pca';
import type { PrepRegion } from './prepRegion';
import type { RayCaster } from './raycast';
import type { SurfaceGraph } from './surface';
import { wingRegion } from './wingUnit';

/**
 * Automatic Maryland wing outline (classical.wing-outline, specs/2026-10-25-maryland-bridges.md AI layer): the
 * region a wing may cover on an unprepared abutment, found from the frame click on its lingual surface, and its
 * boundary as live-wire anchors.
 *
 * The candidate region is grown from the click over the tooth surface:
 * - lingual-facing (n·lingual > 0.3), or on the proximal surface facing the pontic (n·toward > 0.3) and not facing
 *   labially (n·lingual > −0.3: about its lingual half, where the connector attaches);
 * - between 0.5 mm above the gingiva and 1.0 mm below the incisal edge or cusp tip (heights along the occlusal axis;
 *   both are found on a lingual height profile through the click);
 * - at least 0.5 mm from any concave crease (the gingival margin and the embrasures toward the neighbours), so it
 *   neither reaches the gingiva nor a contact; on the lingual surface, also finely scanned (no edge over 0.5 mm);
 * then closed (inlets under 1.2 mm filled). Its outer boundary is smoothed and sampled into 12 anchors by arc length,
 * closed by the live-wire as a drawn outline is; where the live-wire strays more than 0.5 mm from the boundary (it
 * prefers convex ridges), an anchor is added. The region inside the traced outline, flood-filled from the click as the
 * bridge design does, is the bonded surface; when the click lies outside it, the seed (the frame origin) moves to the
 * region's most interior point.
 */

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Region rules (mm, dimensionless dot products, 1/mm). */
export const WING_OUTLINE_DEFAULTS = {
  /** Lingual-facing: n·lingual above this. */
  lingualMin: 0.3,
  /** Proximal surface toward the pontic: n·toward above this, and n·lingual above proximalLingualMin (its lingual half). */
  proximalMin: 0.3,
  proximalLingualMin: -0.3,
  /** Keep this far above the gingiva (and from every crease) and this far below the incisal edge. */
  gingivaMarginMm: 0.5,
  incisalMarginMm: 1.0,
  /** Vertices with a signed curvature below this are creases (the gingival margin, embrasures). */
  creaseCurvature: -0.5,
  /** Nothing farther than this from the click belongs to the tooth. */
  maxRadiusMm: 8,
  /** Vertices with an edge longer than this are too coarsely scanned to carry the outline. */
  maxEdgeMm: 0.5,
  /**
   * The live-wire between anchors prefers convex ridges, so on a smooth surface it can stray from the boundary: an
   * anchor is added where it strays more than this, up to maxAnchors.
   */
  toleranceMm: 0.5,
  maxAnchors: 36,
  /** Inlets narrower than twice this are filled (morphological closing of the region). */
  closingMm: 0.6,
  anchors: 12,
} as const;

export interface WingOutlineInput {
  positions: Float32Array;
  indices: Uint32Array;
  graph: SurfaceGraph;
  /** Signed vertex curvature, 1/mm (analyzeSurface). */
  curvature: Float32Array;
  /** Smoothed vertex normals. */
  normals: Float32Array;
  ray: RayCaster;
  /** Live-wire edge weight, as for drawn outlines. */
  weight: EdgeWeight;
  /** The wing's tooth frame; `origin` is the click on the lingual surface. */
  frame: { origin: V3; occlusal: V3; mesial: V3; buccal: V3 };
  /** The proximal sides facing the bridge's other units (the pontic): the outline wraps onto them. */
  toward: ReadonlyArray<'mesial' | 'distal'>;
  /** Overrides of WING_OUTLINE_DEFAULTS. */
  options?: Partial<Record<keyof typeof WING_OUTLINE_DEFAULTS, number>>;
}

export interface WingOutlineResult {
  /** Live-wire anchors on the surface, in order around the outline. */
  anchors: V3[];
  /** The traced outline (dense points, the closed vertex loop). */
  trace: MarginTrace;
  /** The region inside the traced outline, flood-filled from `seed` as the bridge design does; `closed` false = it leaked. */
  region: PrepRegion & { loopVertices: Uint32Array };
  /** A surface point inside the outline: the click, or (seedMoved) the region's most interior vertex. */
  seed: V3;
  seedMoved: boolean;
  /** Area of the region (the surface the wing is bonded to before blockout), mm². */
  areaMm2: number;
  /** Heights along the occlusal axis from the click: the gingiva and the incisal edge (or cusp tip) found. */
  gingivaMm: number;
  incisalMm: number;
  warnings: string[];
}

/**
 * Heights of the gingiva and the incisal edge from lingual height profiles: rays from the lingual side toward the
 * tooth at 0.1 mm steps along the occlusal axis. Upward, the edge is the last height a ray still hits the tooth near
 * the click, the highest of five profiles 0.75 mm apart along the arch (a click off the crest of a cusp or the
 * cingulum would find it too low); downward, the gingiva is the first hit on a crease (or where the surface jumps
 * lingually: the gum) on the profile through the click.
 */
function profileHeights(input: WingOutlineInput, lingual: V3): { gingiva: number; incisal: number } {
  const { ray, curvature, positions, indices, frame } = input;
  const reach = 8;
  const depthAt = (t: number, m = 0): { depth: number; v: number | null } | null => {
    const start = add(add(add(frame.origin, scale(frame.occlusal, t)), scale(frame.mesial, m)), scale(lingual, reach));
    const hit = ray.first(start, scale(lingual, -1), 2 * reach);
    if (!hit) return null;
    return { depth: hit.distance - reach, v: snapToVertex(positions, indices, ray, hit.point) };
  };
  let incisal = 0;
  for (const m of [-1.5, -0.75, 0, 0.75, 1.5]) {
    for (let t = 0.1; t <= 12; t += 0.1) {
      const d = depthAt(t, m);
      // Past the edge the ray misses, or passes over the tooth to something well behind the click.
      if (!d || d.depth > 3) break;
      incisal = Math.max(incisal, t);
    }
  }
  let gingiva = -12;
  let last = 0;
  for (let t = -0.1; t >= -12; t -= 0.1) {
    const d = depthAt(t);
    if (!d) continue;
    if ((d.v !== null && curvature[d.v]! < WING_OUTLINE_DEFAULTS.creaseCurvature) || d.depth < last - 0.3) {
      gingiva = t;
      break;
    }
    last = d.depth;
  }
  return { gingiva, incisal };
}

/** Propose a wing outline around the click; see the module comment. Throws when no candidate region is found. */
export function proposeWingOutline(input: WingOutlineInput): WingOutlineResult {
  const { positions, indices, graph, curvature, normals, ray, frame } = input;
  const o = { ...WING_OUTLINE_DEFAULTS, ...input.options };
  const nv = positions.length / 3;
  const warnings: string[] = [];
  const occlusal = normalize(frame.occlusal);
  const lingual = normalize(scale(frame.buccal, -1));
  const toward = input.toward.map((side) => normalize(side === 'mesial' ? frame.mesial : scale(frame.mesial, -1)));
  const seed = snapToVertex(positions, indices, ray, frame.origin);
  if (seed === null) throw new Error('The wing click is not on the scan');
  const origin: V3 = [positions[seed * 3]!, positions[seed * 3 + 1]!, positions[seed * 3 + 2]!];
  const P = (v: number): V3 => [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
  const N = (v: number): V3 => [normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!];

  const { gingiva, incisal } = profileHeights(input, lingual);
  const lo = gingiva + o.gingivaMarginMm;
  const hi = incisal - o.incisalMarginMm;
  if (hi <= lo) throw new Error(`No room for a wing between the gingiva and the incisal edge (${(incisal - gingiva).toFixed(1)} mm)`);

  // The neighbourhood of the click, and the distance of each of its vertices to the nearest crease.
  const local = new Uint8Array(nv);
  const creases: number[] = [];
  for (let v = 0; v < nv; v++) {
    const d = sub(P(v), origin);
    if (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > (o.maxRadiusMm + 1) ** 2) continue;
    local[v] = 1;
    if (curvature[v]! < o.creaseCurvature) creases.push(v);
  }
  const fromCrease = distanceFromMargin(positions, graph, local, creases);

  // A vertex with a long edge sits where the scan is coarse (steep walls of a height-field scan, filled holes): the
  // outline cannot follow the surface there.
  const coarse = (v: number): boolean => {
    for (let k = graph.offsets[v]!; k < graph.offsets[v + 1]!; k++) {
      const d = sub(P(graph.neighbors[k]!), P(v));
      if (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > o.maxEdgeMm * o.maxEdgeMm) return true;
    }
    return false;
  };
  const allowed = (v: number): boolean => {
    if (!local[v] || !(fromCrease[v]! >= o.gingivaMarginMm)) return false;
    const p = P(v);
    const d = sub(p, origin);
    if (Math.hypot(d[0], d[1], d[2]) > o.maxRadiusMm) return false;
    const h = dot(d, occlusal);
    if (h < lo || h > hi) return false;
    const n = N(v);
    const nl = dot(n, lingual);
    // The proximal surface toward the pontic carries the connector's end: it is kept even where it is coarse.
    if (nl > o.proximalLingualMin && toward.some((t) => dot(n, t) > o.proximalMin)) return true;
    return nl > o.lingualMin && !coarse(v);
  };

  // Grow from the click (or the nearest allowed vertex: the click can sit just outside the band).
  let start = allowed(seed) ? seed : -1;
  if (start < 0) {
    let best = Infinity;
    for (let v = 0; v < nv; v++) {
      if (!local[v] || !allowed(v)) continue;
      const d = sub(P(v), origin);
      const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      if (dd < best && dd < 4) [best, start] = [dd, v];
    }
  }
  if (start < 0) throw new Error('The click is not on a lingual surface that can carry a wing');
  const grown = new Uint8Array(nv);
  grown[start] = 1;
  const stack = [start];
  while (stack.length) {
    const v = stack.pop()!;
    for (let k = graph.offsets[v]!; k < graph.offsets[v + 1]!; k++) {
      const w = graph.neighbors[k]!;
      if (grown[w] || !allowed(w)) continue;
      grown[w] = 1;
      stack.push(w);
    }
  }
  // Close narrow inlets (a crease line or a sliver of steeper surface reaching into the region): an outline would
  // follow them into a spur. Morphological closing over the surface: dilate by closingMm, then erode by as much.
  const inside = closeRegion(positions, graph, local, grown, o.closingMm);

  // The faces inside, as one piece: the edge-connected component around the start (lobes joined only through a
  // vertex would otherwise give an outline around one lobe and a seed in another). Its outer boundary is the longest
  // boundary loop; the others are holes.
  const faces = facePatch(indices, inside, start);
  if (faces.length < 3) throw new Error('The wing region is empty');
  const patch = new Uint8Array(nv);
  for (const v of faces) patch[v] = 1;
  const loops = boundaryLoops({ positions, indices: Uint32Array.from(faces) });
  const lengthOf = (loop: Uint32Array) => {
    let s = 0;
    for (let i = 0; i < loop.length; i++) s += Math.hypot(...sub(P(loop[i]!), P(loop[(i + 1) % loop.length]!)));
    return s;
  };
  const outer = loops.reduce<Uint32Array | null>((a, b) => (!a || lengthOf(b) > lengthOf(a) ? b : a), null);
  if (!outer || outer.length < 6) throw new Error('The wing region has no usable boundary');
  if (loops.length > 1) warnings.push(`The candidate region had ${loops.length - 1} hole(s); the outline follows its outer boundary.`);

  // Smooth, then sample the anchors by arc length on the surface; the live-wire closes them.
  const chain = new Float32Array(outer.length * 3);
  outer.forEach((v, i) => chain.set(P(v), i * 3));
  const project = (p: V3): V3 => ray.closestPoint(p, 1)?.point ?? p;
  const smooth = smoothClosedPolyline(resampleClosedPolyline(chain, 0.2), 20, project);
  const { anchors, trace } = anchorOutline({ ...input, smooth, project, count: o.anchors, toleranceMm: o.toleranceMm, maxAnchors: o.maxAnchors });

  // The region the wing is designed on, as the bridge design fills it (wingRegion, from the frame origin). The click
  // stays the seed when it lies inside the region; otherwise (a click just outside the band) the seed moves to the
  // region's most interior vertex, and the frame origin has to follow it.
  const fromBoundary = distanceFromMargin(positions, graph, patch, outer);
  let interior = start;
  for (let v = 0; v < nv; v++) if (patch[v] && fromBoundary[v]! > fromBoundary[interior]!) interior = v;
  const seedVertex = patch[seed] && fromBoundary[seed]! >= o.gingivaMarginMm ? seed : interior;
  const region = wingRegion({ positions, indices, graph, weight: input.weight, ray, outline: trace.points, seed: P(seedVertex) });
  let areaMm2 = 0;
  for (let f = 0; f < region.faceMask.length; f++) {
    if (!region.faceMask[f]) continue;
    const a = P(indices[f * 3]!), b = P(indices[f * 3 + 1]!), c = P(indices[f * 3 + 2]!);
    const u = sub(b, a), w = sub(c, a);
    areaMm2 += 0.5 * Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
  }
  return { anchors, trace, region, seed: P(seedVertex), seedMoved: seedVertex !== seed, areaMm2, gingivaMm: gingiva, incisalMm: incisal, warnings };
}

/**
 * The triangles whose corners are all in `mask`, restricted to the edge-connected component that contains `start`
 * (or the largest one when no such triangle touches it), as a flat index list.
 */
function facePatch(indices: Uint32Array, mask: Uint8Array, start: number): number[] {
  const tris: number[] = [];
  for (let f = 0; f < indices.length; f += 3) {
    if (mask[indices[f]!] && mask[indices[f + 1]!] && mask[indices[f + 2]!]) tris.push(f);
  }
  const byEdge = new Map<string, number[]>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  tris.forEach((f, t) => {
    for (let k = 0; k < 3; k++) {
      const e = key(indices[f + k]!, indices[f + ((k + 1) % 3)]!);
      const list = byEdge.get(e);
      if (list) list.push(t);
      else byEdge.set(e, [t]);
    }
  });
  const component = new Int32Array(tris.length).fill(-1);
  const sizes: number[] = [];
  let startComponent = -1;
  for (let t0 = 0; t0 < tris.length; t0++) {
    if (component[t0] !== -1) continue;
    const c = sizes.length;
    let size = 0;
    const stack = [t0];
    component[t0] = c;
    while (stack.length) {
      const t = stack.pop()!;
      size++;
      const f = tris[t]!;
      for (let k = 0; k < 3; k++) {
        const a = indices[f + k]!;
        if (a === start) startComponent = c;
        for (const u of byEdge.get(key(a, indices[f + ((k + 1) % 3)]!)) ?? []) {
          if (component[u] !== -1) continue;
          component[u] = c;
          stack.push(u);
        }
      }
    }
    sizes.push(size);
  }
  const chosen = startComponent >= 0 ? startComponent : sizes.indexOf(Math.max(...sizes));
  const out: number[] = [];
  tris.forEach((f, t) => {
    if (component[t] === chosen) out.push(indices[f]!, indices[f + 1]!, indices[f + 2]!);
  });
  return out;
}

/**
 * Morphological closing of a vertex set over the surface (geodesic distances within `domain`): dilate `set` by r,
 * then erode the result by r. Fills inlets and holes narrower than 2r and keeps the set's convex boundary in place.
 */
function closeRegion(positions: Float32Array, graph: SurfaceGraph, domain: Uint8Array, set: Uint8Array, r: number): Uint8Array {
  const nv = set.length;
  const members: number[] = [];
  for (let v = 0; v < nv; v++) if (set[v]) members.push(v);
  const out = distanceFromMargin(positions, graph, domain, members);
  const dilated = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) if (domain[v] && out[v]! <= r) dilated[v] = 1;
  const rim: number[] = [];
  for (let v = 0; v < nv; v++) {
    if (!domain[v] || dilated[v]) continue;
    for (let k = graph.offsets[v]!; k < graph.offsets[v + 1]!; k++) {
      if (dilated[graph.neighbors[k]!]) {
        rim.push(v);
        break;
      }
    }
  }
  const back = distanceFromMargin(positions, graph, domain, rim);
  const closed = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) if (set[v] || (dilated[v] && back[v]! > r)) closed[v] = 1;
  return closed;
}

/**
 * Anchors on a smoothed boundary (dense closed polyline on the surface) and their live-wire outline: `count` anchors
 * evenly spaced by arc length; then, while the traced outline between two anchors strays more than `toleranceMm` from
 * the boundary, an anchor is added halfway between them on the boundary (up to `maxAnchors`).
 */
function anchorOutline(input: {
  positions: Float32Array;
  indices: Uint32Array;
  graph: SurfaceGraph;
  weight: EdgeWeight;
  ray: RayCaster;
  smooth: Float32Array;
  project: (p: V3) => V3;
  count: number;
  toleranceMm: number;
  maxAnchors: number;
}): { anchors: V3[]; trace: MarginTrace } {
  const { positions, smooth, project } = input;
  const n = smooth.length / 3;
  const at = (i: number): V3 => [smooth[i * 3]!, smooth[i * 3 + 1]!, smooth[i * 3 + 2]!];
  const distToBoundary = (p: V3): number => {
    let best = Infinity;
    for (let i = 0; i < n; i++) best = Math.min(best, (smooth[i * 3]! - p[0]) ** 2 + (smooth[i * 3 + 1]! - p[1]) ** 2 + (smooth[i * 3 + 2]! - p[2]) ** 2);
    return Math.sqrt(best);
  };
  const ids = Array.from({ length: input.count }, (_, k) => Math.floor((k * n) / input.count));
  for (;;) {
    const anchors = ids.map((i) => project(at(i)));
    const trace = marginFromAnchors({ ...input, anchors });
    if (trace.anchorVertices.length !== ids.length || ids.length >= input.maxAnchors) return { anchors, trace };
    // The traced loop runs through the anchor vertices in order: find each segment and how far it strays.
    const loop = trace.loopVertices;
    const starts: number[] = [];
    let from = 0;
    for (const a of trace.anchorVertices) {
      let i = from;
      while (i < loop.length && loop[i] !== a) i++;
      if (i === loop.length) return { anchors, trace };
      starts.push(i);
      from = i;
    }
    let worst = -1, worstDist = input.toleranceMm;
    for (let k = 0; k < starts.length; k++) {
      const end = k + 1 < starts.length ? starts[k + 1]! : loop.length;
      for (let i = starts[k]!; i < end; i++) {
        const v = loop[i]!;
        const d = distToBoundary([positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!]);
        if (d > worstDist) [worst, worstDist] = [k, d];
      }
    }
    if (worst < 0) return { anchors, trace };
    const a = ids[worst]!, b = worst + 1 < ids.length ? ids[worst + 1]! : ids[0]! + n;
    if (b - a < 4) return { anchors, trace };
    ids.splice(worst + 1, 0, Math.floor((a + b) / 2) % n);
  }
}
