import { templateForTooth } from './crownTemplate';
import { MinHeap } from './livewire';
import { smoothOnSurface } from './marginRefine';
import type { V3 } from './pca';
import type { RayCaster } from './raycast';
import type { SurfaceGraph } from './surface';

/**
 * The margin of a natural (unprepared) tooth: its gum line, where the tooth meets the gum
 * (specs/2026-10-27-natural-margin.md). On a natural tooth that line is a concave crease, not a prep's convex finish
 * line. A harmonic field (random walker) on a patch round the tooth is fixed at 1 on the crown top and 0 on the
 * patch's rim; edges across concave creases conduct poorly, so the field drops across the gum line, and the margin is
 * its 0.5 level, lightly smoothed back onto the scan. The watershed of the same relief (also the
 * solver's start) is a second opinion: where the two disagree the line is doubtful.
 *
 * Research: specs/2026-10-27-natural-margin-research.md (S2, 22/24 held-out real teeth within 0.25 mm mean). The
 * axis is first re-centred by probing the crown from inside (S1), so a click off the tooth's centre does not matter.
 */

export interface NaturalMarginInput {
  positions: Float32Array;
  /** Triangles. */
  indices: Uint32Array;
  /** 1-ring vertex graph and signed curvature per vertex (convex > 0, concave < 0), as surface.ts computes them. */
  graph: SurfaceGraph;
  curvature: Float32Array;
  ray: RayCaster;
  /** The tooth frame; its origin is on the crown's occlusal surface (the click). */
  frame: { origin: V3; occlusal: V3; mesial: V3; buccal: V3 };
  fdi: number;
}

export interface NaturalMarginResult {
  /** The gum line: closed, in order, on the scan. */
  points: V3[];
  lengthMm: number;
  /** Level-set chains in the patch (1 when the line is clean). */
  loops: number;
  /** Turns of the line round the tooth axis (±1 when it goes once round the tooth). */
  winding: number;
  /** How far the inside probe moved the axis from the frame origin (mm). */
  probeShiftMm: number;
  /** How far re-centring on the solved tooth region moved the axis after the first solve (mm). */
  recentreShiftMm: number;
  /** Mean distance from the walker's line to the watershed's line (mm). */
  agreementMm: number;
  /** Length over the cervical perimeter expected for the tooth (its template's ellipse). */
  perimeterRatio: number;
  ms: number;
}

/** Crease weight: conductance exp(−β·concavity/κ_ref); β = 0 removes the crease term (and the method fails). */
const BETA = 8;
/** κ_ref: this percentile of the patch's concavity. */
const KAPPA_REF_PERCENTILE = 0.9;
const CURVATURE_SMOOTH = 2;
/** The patch: a cylinder round the axis, this much wider than the tooth, from this far below to this far above the origin. */
const PATCH_MARGIN_MM = 2.5;
const PATCH_BELOW_MM = 4;
const PATCH_ABOVE_MM = 6;
/** Crown-top seeds: within this share of the tooth's half-size of the axis, and this share of its height below the top. */
const TOOTH_SEED_RADIUS = 0.4;
const TOOTH_SEED_DEPTH = 0.35;
/** Re-centring stops once the solved region's centre is this close to the axis. */
const RECENTRE_MIN_MM = 0.25;
/** The level line is smoothed over this window and put back on the scan (vertex snapping leaves a staircase). */
const SMOOTH_WINDOW_MM = 0.4;
const CG_TOL = 1e-4;
const CG_MAX = 2000;

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const normalize = (a: V3): V3 => scale(a, 1 / (Math.hypot(...a) || 1));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

interface Axes {
  origin: V3;
  u: V3;
  m: V3;
  b: V3;
}

function axesOf(frame: NaturalMarginInput['frame']): Axes {
  const u = normalize(frame.occlusal);
  const m = normalize(sub(frame.mesial, scale(u, dot(frame.mesial, u))));
  let b = normalize(cross(u, m));
  if (dot(b, frame.buccal) < 0) b = scale(b, -1);
  return { origin: frame.origin, u, m, b };
}

/**
 * Re-centre the axis inside the crown: walk down from the origin, casting 8 horizontal rays. While they all hit the
 * wall from inside, move toward the midpoints of opposite hits. Returns the lateral shift at about a quarter of the
 * crown height (a click off the centre, or a leaning tooth, moves it back).
 */
function probeCentre(ray: RayCaster, a: Axes, size: { md: number; bl: number; height: number }): V3 {
  const reach = 0.75 * Math.max(size.md, size.bl);
  const dirs = [...Array(8).keys()].map((k) => add(scale(a.m, Math.cos((k * Math.PI) / 4)), scale(a.b, Math.sin((k * Math.PI) / 4))));
  let lateral: V3 = [0, 0, 0];
  let atQuarter: V3 | null = null;
  for (let d = 0.5; d < 0.6 * size.height; d += 0.25) {
    const p = add(add(a.origin, lateral), scale(a.u, -d));
    const hits = dirs.map((dir) => {
      const h = ray.first(p, dir, reach);
      return h && dot(h.normal, dir) > 0 ? h.distance : null;
    });
    if (!hits.every((h) => h !== null)) break;
    let shift: V3 = [0, 0, 0];
    for (let k = 0; k < 4; k++) shift = add(shift, scale(dirs[k]!, (hits[k]! - hits[k + 4]!) / 2 / 4));
    lateral = add(lateral, scale(shift, 0.5));
    if (d >= 0.25 * size.height && !atQuarter) atQuarter = lateral;
  }
  return atQuarter ?? lateral;
}

interface Field {
  verts: Int32Array;
  local: Int32Array;
  offsets: Uint32Array;
  nbrs: Uint32Array;
  /** The walker's field and the watershed's labels (0/1), per patch vertex. */
  u: Float64Array;
  shed: Float64Array;
}

function solveField(input: NaturalMarginInput, a: Axes, size: { md: number; bl: number; height: number }): Field {
  const { positions, graph, curvature } = input;
  const nv = positions.length / 3;
  const Rp = Math.max(size.md, size.bl) / 2 + PATCH_MARGIN_MM;
  const H = size.height;
  const rel = (v: number): V3 => [positions[v * 3]! - a.origin[0], positions[v * 3 + 1]! - a.origin[1], positions[v * 3 + 2]! - a.origin[2]];
  const inBox = (v: number) => {
    const d = rel(v);
    const h = dot(d, a.u);
    return h >= -(H + PATCH_BELOW_MM) && h <= PATCH_ABOVE_MM && Math.hypot(dot(d, a.m), dot(d, a.b)) <= Rp;
  };

  // The patch: a connected flood from the vertex nearest the origin, inside the box (so the antagonist or a far part of
  // the arch never joins).
  let start = -1, best = Infinity;
  for (let v = 0; v < nv; v++) {
    const d = (positions[v * 3]! - a.origin[0]) ** 2 + (positions[v * 3 + 1]! - a.origin[1]) ** 2 + (positions[v * 3 + 2]! - a.origin[2]) ** 2;
    if (d < best) {
      best = d;
      start = v;
    }
  }
  const local = new Int32Array(nv).fill(-1);
  const order: number[] = [start];
  local[start] = 0;
  for (let q = 0; q < order.length; q++) {
    const v = order[q]!;
    for (let k = graph.offsets[v]!; k < graph.offsets[v + 1]!; k++) {
      const w = graph.neighbors[k]!;
      if (local[w] !== -1 || !inBox(w)) continue;
      local[w] = order.length;
      order.push(w);
    }
  }
  const verts = Int32Array.from(order);
  const n = verts.length;
  const offsets = new Uint32Array(n + 1);
  const rim = new Uint8Array(n);
  const tmp: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = verts[i]!;
    for (let k = graph.offsets[v]!; k < graph.offsets[v + 1]!; k++) {
      const w = local[graph.neighbors[k]!]!;
      if (w < 0) rim[i] = 1;
      else tmp.push(w);
    }
    offsets[i + 1] = tmp.length;
  }
  const nbrs = Uint32Array.from(tmp);

  // Concavity from the curvature, smoothed inside the patch.
  let kappa = new Float32Array(n);
  for (let i = 0; i < n; i++) kappa[i] = curvature[verts[i]!]!;
  for (let it = 0; it < CURVATURE_SMOOTH; it++) {
    const next = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = kappa[i]!;
      for (let k = offsets[i]!; k < offsets[i + 1]!; k++) s += kappa[nbrs[k]!]!;
      next[i] = s / (1 + offsets[i + 1]! - offsets[i]!);
    }
    kappa = next;
  }
  const concave = new Float32Array(n);
  for (let i = 0; i < n; i++) concave[i] = Math.max(0, -kappa[i]!);
  const sorted = Float32Array.from(concave).sort();
  const kref = Math.max(1e-6, sorted[Math.min(n - 1, Math.floor(KAPPA_REF_PERCENTILE * n))] ?? 0);

  // Seeds: the crown top (u = 1) and the patch's rim (u = 0). (Seeding the neighbours' crown tops too, as in the
  // research, made no difference on real teeth and cost robustness to an off-centre click.)
  const fixed = new Uint8Array(n);
  const u = new Float64Array(n);
  const seedR = TOOTH_SEED_RADIUS * (Math.min(size.md, size.bl) / 2);
  let top = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = rel(verts[i]!);
    if (Math.hypot(dot(d, a.m), dot(d, a.b)) <= seedR) top = Math.max(top, dot(d, a.u));
  }
  for (let i = 0; i < n; i++) {
    const d = rel(verts[i]!);
    if (Math.hypot(dot(d, a.m), dot(d, a.b)) <= seedR && dot(d, a.u) >= top - TOOTH_SEED_DEPTH * H) {
      fixed[i] = 1;
      u[i] = 1;
    } else if (rim[i]) fixed[i] = 1;
  }

  // Conductance per CSR slot: low across concave creases, over edge length.
  const g = new Float64Array(nbrs.length);
  for (let i = 0; i < n; i++) {
    const vi = verts[i]!;
    for (let k = offsets[i]!; k < offsets[i + 1]!; k++) {
      const j = nbrs[k]!;
      const vj = verts[j]!;
      const len = Math.max(0.005, Math.hypot(positions[vi * 3]! - positions[vj * 3]!, positions[vi * 3 + 1]! - positions[vj * 3 + 1]!, positions[vi * 3 + 2]! - positions[vj * 3 + 2]!));
      g[k] = Math.exp((-BETA * 0.5 * (concave[i]! + concave[j]!)) / kref) / len;
    }
  }

  // Watershed (Meyer flooding of the concavity relief from the seeds): the second opinion and the solver's start.
  const label = new Int8Array(n).fill(-1);
  const heap = new MinHeap();
  for (let i = 0; i < n; i++) {
    if (!fixed[i]) continue;
    label[i] = u[i]! > 0.5 ? 1 : 0;
    heap.push(concave[i]!, i);
  }
  const out: [number, number] = [0, 0];
  while (heap.size) {
    heap.pop(out);
    const i = out[1];
    for (let k = offsets[i]!; k < offsets[i + 1]!; k++) {
      const j = nbrs[k]!;
      if (label[j] !== -1) continue;
      label[j] = label[i]!;
      heap.push(Math.max(out[0], concave[j]!), j);
    }
  }
  const shed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    shed[i] = label[i] === 1 ? 1 : 0;
    if (!fixed[i]) u[i] = shed[i]!;
  }
  conjugateGradient(n, offsets, nbrs, g, fixed, u);
  return { verts, local, offsets, nbrs, u, shed };
}

/** Jacobi-preconditioned CG for the free vertices: L_II u_I = −L_IB u_B (u holds the seeds and the start). */
function conjugateGradient(n: number, offsets: Uint32Array, nbrs: Uint32Array, g: Float64Array, fixed: Uint8Array, u: Float64Array): void {
  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let k = offsets[i]!; k < offsets[i + 1]!; k++) diag[i] = diag[i]! + g[k]!;
  const apply = (x: Float64Array, y: Float64Array) => {
    for (let i = 0; i < n; i++) {
      if (fixed[i]) {
        y[i] = 0;
        continue;
      }
      let s = diag[i]! * x[i]!;
      for (let k = offsets[i]!; k < offsets[i + 1]!; k++) if (!fixed[nbrs[k]!]) s -= g[k]! * x[nbrs[k]!]!;
      y[i] = s;
    }
  };
  const x = new Float64Array(n);
  const r = new Float64Array(n);
  let bnorm = 0;
  for (let i = 0; i < n; i++) {
    if (fixed[i]) continue;
    x[i] = u[i]!;
    let b = 0;
    for (let k = offsets[i]!; k < offsets[i + 1]!; k++) if (fixed[nbrs[k]!]) b += g[k]! * u[nbrs[k]!]!;
    r[i] = b;
    bnorm += b * b;
  }
  const ax = new Float64Array(n);
  apply(x, ax);
  for (let i = 0; i < n; i++) if (!fixed[i]) r[i] = r[i]! - ax[i]!;
  bnorm = Math.sqrt(bnorm) || 1;
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const q = new Float64Array(n);
  let rz = 0;
  for (let i = 0; i < n; i++) {
    if (fixed[i] || diag[i] === 0) continue;
    z[i] = r[i]! / diag[i]!;
    p[i] = z[i]!;
    rz += r[i]! * z[i]!;
  }
  for (let it = 0; it < CG_MAX; it++) {
    let rn = 0;
    for (let i = 0; i < n; i++) rn += r[i]! * r[i]!;
    if (Math.sqrt(rn) / bnorm < CG_TOL) break;
    apply(p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) pq += p[i]! * q[i]!;
    if (pq <= 0) break;
    const alpha = rz / pq;
    let rzNext = 0;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      x[i] = x[i]! + alpha * p[i]!;
      r[i] = r[i]! - alpha * q[i]!;
      z[i] = diag[i] ? r[i]! / diag[i]! : 0;
      rzNext += r[i]! * z[i]!;
    }
    const beta = rzNext / rz;
    rz = rzNext;
    for (let i = 0; i < n; i++) if (!fixed[i]) p[i] = z[i]! + beta * p[i]!;
  }
  for (let i = 0; i < n; i++) if (!fixed[i]) u[i] = Math.min(1, Math.max(0, x[i]!));
}

/**
 * The 0.5 level set of a field over the patch's triangles, chained; the chain that winds round the axis (the longest
 * such, else the longest). Each point is the gum-side (lower-value) vertex of a crossed edge.
 */
function levelLine(positions: Float32Array, indices: Uint32Array, f: Field, field: Float64Array, a: Axes, snap = true): { points: V3[]; loops: number; winding: number } {
  const { local } = f;
  const val = (v: number) => field[local[v]!]!;
  const nv = positions.length / 3;
  const key = (p: number, q: number) => (p < q ? p * nv + q : q * nv + p);
  const link = new Map<number, number[]>();
  const ends = new Map<number, [number, number]>();
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    if (tri.some((v) => local[v]! < 0)) continue;
    const crossed: number[] = [];
    for (let e = 0; e < 3; e++) {
      const p = tri[e]!, q = tri[(e + 1) % 3]!;
      if (val(p) >= 0.5 === val(q) >= 0.5) continue;
      const k = key(p, q);
      crossed.push(k);
      if (!ends.has(k)) ends.set(k, [p, q]);
    }
    if (crossed.length !== 2) continue;
    const [k1, k2] = crossed as [number, number];
    (link.get(k1) ?? link.set(k1, []).get(k1)!).push(k2);
    (link.get(k2) ?? link.set(k2, []).get(k2)!).push(k1);
  }
  const visited = new Set<number>();
  const chains: number[][] = [];
  for (const k0 of link.keys()) {
    if (visited.has(k0)) continue;
    const chain: number[] = [k0];
    visited.add(k0);
    for (let dir = 0; dir < 2; dir++) {
      let prev = -1, cur = k0;
      const seq: number[] = [];
      for (;;) {
        const next = (link.get(cur) ?? []).filter((x) => x !== prev && !visited.has(x));
        const step = dir === 0 ? next[0] : next.at(-1);
        if (step === undefined) break;
        visited.add(step);
        seq.push(step);
        prev = cur;
        cur = step;
      }
      if (dir === 0) chain.push(...seq);
      else chain.unshift(...seq.reverse());
    }
    chains.push(chain);
  }
  const pointOf = (k: number): V3 => {
    const [p, q] = ends.get(k)!;
    if (!snap) {
      const s = (0.5 - val(p)) / (val(q) - val(p));
      return [positions[p * 3]! + s * (positions[q * 3]! - positions[p * 3]!), positions[p * 3 + 1]! + s * (positions[q * 3 + 1]! - positions[p * 3 + 1]!), positions[p * 3 + 2]! + s * (positions[q * 3 + 2]! - positions[p * 3 + 2]!)];
    }
    const v = val(p) < val(q) ? p : q;
    return [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
  };
  const windingOf = (pts: V3[]) => {
    const angle = (p: V3) => {
      const d = sub(p, a.origin);
      return Math.atan2(dot(d, a.b), dot(d, a.m));
    };
    let total = 0;
    let prev = angle(pts[0]!);
    for (let i = 1; i <= pts.length; i++) {
      const next = angle(pts[i % pts.length]!);
      let da = next - prev;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      total += da;
      prev = next;
    }
    return Math.round(total / (2 * Math.PI));
  };
  let best: V3[] = [], bestScore = -1, winding = 0;
  for (const chain of chains) {
    if (chain.length < 3) continue;
    const pts = chain.map(pointOf);
    const w = windingOf(pts);
    const score = chain.length + (w !== 0 ? 1e9 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = pts;
      winding = w;
    }
  }
  // Snapped points repeat where neighbouring crossed edges share their gum-side vertex.
  const points: V3[] = [];
  for (const p of best) {
    const q = points.at(-1);
    if (!q || q[0] !== p[0] || q[1] !== p[1] || q[2] !== p[2]) points.push(p);
  }
  while (points.length > 1 && points[0]!.every((x, i) => x === points.at(-1)![i])) points.pop();
  return { points, loops: chains.length, winding };
}

const lengthOf = (points: V3[]) => points.reduce((s, p, i) => s + Math.hypot(...sub(points[(i + 1) % points.length]!, p)), 0);

/** Mean distance from each point of `a` to the nearest point of `b`. */
function meanDistance(a: V3[], b: V3[]): number {
  if (!a.length || !b.length) return Infinity;
  let sum = 0;
  for (const p of a) {
    let best = Infinity;
    for (const q of b) best = Math.min(best, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);
    sum += Math.sqrt(best);
  }
  return sum / a.length;
}

/** The cervical perimeter expected for a tooth: the ellipse of its template's mesio-distal and bucco-lingual size. */
export function expectedPerimeterMm(fdi: number): number {
  const { md, bl } = templateForTooth(fdi).size;
  const a = md / 2, b = bl / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

export function naturalMargin(input: NaturalMarginInput): NaturalMarginResult {
  const t0 = performance.now();
  const size = templateForTooth(input.fdi).size;
  const start = axesOf(input.frame);
  const lateral = probeCentre(input.ray, start, size);
  let axes: Axes = { ...start, origin: add(start.origin, lateral) };
  const probeShiftMm = Math.hypot(dot(lateral, start.m), dot(lateral, start.b));
  let field = solveField(input, axes, size);

  // One re-centring pass: move the axis to the centre of the solved tooth region and solve again.
  let recentreShiftMm = 0;
  let sum: V3 = [0, 0, 0], count = 0;
  for (let i = 0; i < field.verts.length; i++) {
    if (field.u[i]! < 0.5) continue;
    const v = field.verts[i]! * 3;
    sum = add(sum, [input.positions[v]!, input.positions[v + 1]!, input.positions[v + 2]!]);
    count++;
  }
  if (count) {
    const d = sub(scale(sum, 1 / count), axes.origin);
    const m = dot(d, axes.m), b = dot(d, axes.b);
    recentreShiftMm = Math.hypot(m, b);
    if (recentreShiftMm >= RECENTRE_MIN_MM) {
      axes = { ...axes, origin: add(axes.origin, add(scale(axes.m, m), scale(axes.b, b))) };
      field = solveField(input, axes, size);
    }
  }

  // The walker's line through the edge crossings, lightly smoothed back onto the scan; the watershed's (labels 0/1)
  // snapped to the gum-side vertex.
  const line = levelLine(input.positions, input.indices, field, field.u, axes, false);
  const shed = levelLine(input.positions, input.indices, field, field.shed, axes, false);
  const smoothed = line.points.length > 4 ? smoothOnSurface(new Float32Array(line.points.flat()), input.ray, SMOOTH_WINDOW_MM) : null;
  const points: V3[] = smoothed ? Array.from({ length: smoothed.length / 3 }, (_, i) => [smoothed[i * 3]!, smoothed[i * 3 + 1]!, smoothed[i * 3 + 2]!]) : line.points;
  const lengthMm = lengthOf(points);
  return {
    points,
    lengthMm,
    loops: line.loops,
    winding: line.winding,
    probeShiftMm,
    recentreShiftMm,
    agreementMm: meanDistance(line.points, shed.points),
    perimeterRatio: lengthMm / expectedPerimeterMm(input.fdi),
    ms: performance.now() - t0,
  };
}

/** Anchors for editing a line: points about `spacingMm` apart along it (at least 8). */
export function anchorsAlong(points: V3[], spacingMm = 2.5): V3[] {
  const total = lengthOf(points);
  const count = Math.max(8, Math.round(total / spacingMm));
  const step = total / count;
  const out: V3[] = [];
  let walked = 0, next = 0;
  for (let i = 0; i < points.length && out.length < count; i++) {
    const p = points[i]!;
    if (walked >= next) {
      out.push(p);
      next += step;
    }
    walked += Math.hypot(...sub(points[(i + 1) % points.length]!, p));
  }
  return out;
}
