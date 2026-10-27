/**
 * Natural-tooth margin benchmark (specs/2026-10-27-natural-margin-research.md). On a natural (unprepared) tooth the
 * margin is the gingival margin: the line where the tooth meets the gum. Synthetic jaws with every tooth natural are
 * labelled per vertex (tooth FDI, 0 = gum); the truth is the labelled tooth/gum boundary, the same form as Teeth3DS.
 * Variants add what real scans have: gum over the tooth's base with papillae between teeth (a scalloped line), a soft
 * crease, scan noise, scanner-like colour, an off-centre click. A method sees the mesh, the click and the tooth frame,
 * never the labels.
 */
import {
  analyzeSurface,
  buildVertexAdjacency,
  bvhRayCaster,
  computeVertexNormals,
  createBvh,
  estimateToothFrame,
  liveWireWeight,
  syntheticArch,
  withScanNoise,
  type EdgeWeight,
  type RayCaster,
  type SurfaceAnalysis,
  type V3,
} from '@dcad/web/geometry';

const ALONG = 1000;
const ACROSS = 500;

export interface NaturalVariant {
  /** Gum over the tooth's base and papillae between teeth (synthetic.ts `gingiva`). */
  gingiva?: { coverMm: number; papillaMm: number };
  /** Taubin smoothing iterations: rounds the tooth/gum crease as on a real scan. */
  soften?: number;
  /** Vertex noise along the normals, standard deviation in mm. */
  noiseMm?: number;
  /** Scanner-like vertex colour (tooth ivory, gum pink, with per-vertex colour noise). */
  colors?: boolean;
}

export interface NaturalCase {
  name: string;
  jaw: 'upper' | 'lower';
  fdi: number;
  variant: keyof typeof VARIANTS;
  /** The click moved off the tooth's centre (mm, along x and y). */
  clickOffset?: [number, number];
}

export const VARIANTS = {
  /** The tooth meets the bare gum band in a sharp crease. */
  bare: {},
  /** Gum over the base and papillae, a softened crease, light noise. */
  gum: { gingiva: { coverMm: 0.6, papillaMm: 1.8 }, soften: 4, noiseMm: 0.03 },
  /** As `gum`, with scanner colour. */
  'gum+colour': { gingiva: { coverMm: 0.6, papillaMm: 1.8 }, soften: 4, noiseMm: 0.03, colors: true },
  /** Higher gum and papillae, a softer crease, more noise (with an off-centre click in the cases). */
  hard: { gingiva: { coverMm: 0.9, papillaMm: 2.6 }, soften: 8, noiseMm: 0.05 },
} satisfies Record<string, NaturalVariant>;

const TEETH: Array<{ jaw: 'upper' | 'lower'; fdi: number }> = [
  { jaw: 'lower', fdi: 36 },
  { jaw: 'lower', fdi: 45 },
  { jaw: 'lower', fdi: 33 },
  { jaw: 'lower', fdi: 31 },
  { jaw: 'upper', fdi: 16 },
  { jaw: 'upper', fdi: 14 },
  { jaw: 'upper', fdi: 13 },
  { jaw: 'upper', fdi: 11 },
];

export const NATURAL_CASES: NaturalCase[] = (Object.keys(VARIANTS) as Array<keyof typeof VARIANTS>).flatMap((variant) =>
  TEETH.map((t) => ({ name: `${t.fdi} ${variant}`, ...t, variant, ...(variant === 'hard' ? { clickOffset: [1.5, 1] as [number, number] } : {}) })),
);

/** What a method sees. */
export interface NaturalInput {
  name: string;
  jaw: 'upper' | 'lower';
  fdi: number;
  positions: Float32Array;
  /** BVH-ordered triangles (as the worker holds them). */
  indices: Uint32Array;
  normals: Float32Array;
  /** RGB per vertex (0–255), when the scan has colour. */
  colors?: Uint8Array;
  ray: RayCaster;
  /** 1-ring graph and signed curvature (convex > 0, concave < 0), as the worker computes them. */
  surface: SurfaceAnalysis;
  /** The live-wire edge weight the app uses (low along strong curvature). */
  weight: EdgeWeight;
  /** The jaw's occlusal direction (+z lower, −z upper). */
  jawOcclusal: V3;
  /** The user's click on the tooth (on its occlusal surface). */
  click: V3;
  /** The tooth frame from the click (estimateToothFrame, natural tooth). */
  frame: { origin: V3; occlusal: V3; mesial: V3; buccal: V3 };
}

export interface NaturalOutcome {
  /** The closed margin line, in order. */
  points: V3[];
  note?: string;
}

export type NaturalMethod = (input: NaturalInput) => Promise<NaturalOutcome> | NaturalOutcome;

export interface NaturalCaseData {
  spec: NaturalCase;
  input: NaturalInput;
  /** Per-vertex labels (tooth FDI, 0 = gum): for scoring only. */
  labels: Uint8Array;
  /** Points on the labelled boundary of the tooth (edge midpoints). */
  truth: V3[];
}

interface Arch {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  colors?: Uint8Array;
  labels: Uint8Array;
  ray: RayCaster;
  surface: SurfaceAnalysis;
  weight: EdgeWeight;
}

const archCache = new Map<string, Arch>();

/** Taubin smoothing (λ|μ) over the 1-ring: shrink-free rounding of creases. */
function taubin(positions: Float32Array, indices: Uint32Array, iterations: number): Float32Array {
  const nv = positions.length / 3;
  const { offsets, neighbors } = buildVertexAdjacency(indices, nv);
  let p = positions.slice();
  const pass = (factor: number) => {
    const out = new Float32Array(p.length);
    for (let v = 0; v < nv; v++) {
      const a = offsets[v]!, b = offsets[v + 1]!;
      if (b === a) {
        out.set(p.subarray(v * 3, v * 3 + 3), v * 3);
        continue;
      }
      let x = 0, y = 0, z = 0;
      for (let k = a; k < b; k++) {
        const n = neighbors[k]!;
        x += p[n * 3]!;
        y += p[n * 3 + 1]!;
        z += p[n * 3 + 2]!;
      }
      const c = b - a;
      out[v * 3] = p[v * 3]! + factor * (x / c - p[v * 3]!);
      out[v * 3 + 1] = p[v * 3 + 1]! + factor * (y / c - p[v * 3 + 1]!);
      out[v * 3 + 2] = p[v * 3 + 2]! + factor * (z / c - p[v * 3 + 2]!);
    }
    p = out;
  };
  for (let i = 0; i < iterations; i++) {
    pass(0.5);
    pass(-0.53);
  }
  return p;
}

/** Deterministic per-channel colour noise (scanner colour is never flat). */
function noisyColors(colors: Uint8Array, seed: number): Uint8Array {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Uint8Array(colors.length);
  for (let i = 0; i < colors.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(colors[i]! + (rand() + rand() + rand() - 1.5) * 16)));
  return out;
}

function archFor(jaw: 'upper' | 'lower', variantName: keyof typeof VARIANTS): Arch {
  const key = `${jaw}|${variantName}`;
  const hit = archCache.get(key);
  if (hit) return hit;
  const variant: NaturalVariant = VARIANTS[variantName];
  const mesh = syntheticArch({ jaw, along: ALONG, across: ACROSS, preps: [], labels: true, ...(variant.gingiva ? { gingiva: variant.gingiva } : {}), ...(variant.colors ? { colors: true } : {}) });
  let positions = mesh.positions;
  if (variant.soften) positions = taubin(positions, mesh.indices, variant.soften);
  if (variant.noiseMm) positions = withScanNoise({ positions, indices: mesh.indices }, variant.noiseMm, (jaw === 'upper' ? 1 : 2) * 1000 + Math.round(variant.noiseMm * 1000)).positions;
  const indices = mesh.indices.slice();
  const normals = computeVertexNormals({ positions, indices });
  const ray = bvhRayCaster(createBvh({ positions, indices }));
  const surface = analyzeSurface({ positions, indices, normals });
  const arch: Arch = {
    positions,
    indices,
    normals,
    ...(mesh.colors ? { colors: noisyColors(mesh.colors, jaw === 'upper' ? 11 : 22) } : {}),
    labels: mesh.labels!,
    ray,
    surface,
    weight: liveWireWeight(surface.curvature),
  };
  archCache.set(key, arch);
  return arch;
}

/** Points on the tooth/gum boundary of one tooth: midpoints of the mesh edges whose ends are labelled differently. */
export function boundaryPoints(positions: Float32Array, indices: Uint32Array, labels: Uint8Array, fdi: number): V3[] {
  const seen = new Set<number>();
  const out: V3[] = [];
  const nv = positions.length / 3;
  for (let f = 0; f < indices.length; f += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[f + e]!, b = indices[f + ((e + 1) % 3)]!;
      if ((labels[a] === fdi) === (labels[b] === fdi)) continue;
      const key = Math.min(a, b) * nv + Math.max(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([(positions[a * 3]! + positions[b * 3]!) / 2, (positions[a * 3 + 1]! + positions[b * 3 + 1]!) / 2, (positions[a * 3 + 2]! + positions[b * 3 + 2]!) / 2]);
    }
  }
  return out;
}

export function prepareNaturalCase(spec: NaturalCase): NaturalCaseData {
  const arch = archFor(spec.jaw, spec.variant);
  const jawOcclusal: V3 = spec.jaw === 'lower' ? [0, 0, 1] : [0, 0, -1];
  // The click: the tooth's centre (from the labels, as a user would click the middle of the tooth), plus the offset,
  // dropped onto the scan from above.
  let cx = 0, cy = 0, count = 0;
  for (let v = 0; v < arch.labels.length; v++) {
    if (arch.labels[v] !== spec.fdi) continue;
    cx += arch.positions[v * 3]!;
    cy += arch.positions[v * 3 + 1]!;
    count++;
  }
  if (!count) throw new Error(`Tooth ${spec.fdi} has no labelled vertices`);
  const [ox, oy] = spec.clickOffset ?? [0, 0];
  const above: V3 = [cx / count + ox, cy / count + oy, jawOcclusal[2] * 40];
  const hit = arch.ray.first(above, [0, 0, -jawOcclusal[2]], 100);
  if (!hit) throw new Error(`No surface under the click on ${spec.fdi}`);
  const click: V3 = [hit.point[0], hit.point[1], hit.point[2]];
  const est = estimateToothFrame({ jaw: { positions: arch.positions, normals: arch.normals, indices: arch.indices }, seed: click, fdi: spec.fdi, ray: arch.ray, prep: false });
  const input: NaturalInput = {
    name: spec.name,
    jaw: spec.jaw,
    fdi: spec.fdi,
    positions: arch.positions,
    indices: arch.indices,
    normals: arch.normals,
    ...(arch.colors ? { colors: arch.colors } : {}),
    ray: arch.ray,
    surface: arch.surface,
    weight: arch.weight,
    jawOcclusal,
    click,
    frame: { origin: est.origin, occlusal: est.occlusal, mesial: est.mesial, buccal: est.buccal },
  };
  return { spec, input, labels: arch.labels, truth: boundaryPoints(arch.positions, arch.indices, arch.labels, spec.fdi) };
}

export interface NaturalScore {
  /** Distance from the line to the truth (mm), over the line sampled every 0.05 mm. */
  meanMm: number;
  p95Mm: number;
  maxMm: number;
  /** Share of the truth within 0.3 mm of the line. */
  coverage: number;
  lengthMm: number;
  truthLengthMm: number;
  correct: boolean;
  usable: boolean;
}

export const CORRECT = { meanMm: 0.15, p95Mm: 0.4, coverage: 0.9 };
export const USABLE = { meanMm: 0.3, coverage: 0.8 };

const dist2 = (a: V3, b: V3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function densify(points: V3[], stepMm: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    const n = Math.max(1, Math.ceil(Math.sqrt(dist2(a, b)) / stepMm));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, a[2] + ((b[2] - a[2]) * k) / n]);
  }
  return out;
}

const nearest = (p: V3, set: V3[]) => {
  let best = Infinity;
  for (const q of set) best = Math.min(best, dist2(p, q));
  return Math.sqrt(best);
};

/**
 * The truth as a closed line: its points averaged in 2° bins of angle round their centroid (the edge midpoints form a
 * band one edge wide; ordered point by point they zig-zag). Fine for one tooth's closed line.
 */
export function truthPolyline(truth: V3[]): V3[] {
  const c = truth.reduce((s, q) => [s[0] + q[0] / truth.length, s[1] + q[1] / truth.length, s[2] + q[2] / truth.length] as V3, [0, 0, 0] as V3);
  const bins = Array.from({ length: 180 }, () => ({ sum: [0, 0, 0] as V3, n: 0 }));
  for (const q of truth) {
    const k = Math.min(179, Math.floor(((Math.atan2(q[1] - c[1], q[0] - c[0]) + Math.PI) / (2 * Math.PI)) * 180));
    const b = bins[k]!;
    b.sum = [b.sum[0] + q[0], b.sum[1] + q[1], b.sum[2] + q[2]];
    b.n++;
  }
  return bins.filter((b) => b.n > 0).map((b) => [b.sum[0] / b.n, b.sum[1] / b.n, b.sum[2] / b.n] as V3);
}

export function scoreNatural(truth: V3[], points: V3[]): NaturalScore {
  const empty = { meanMm: Infinity, p95Mm: Infinity, maxMm: Infinity, coverage: 0, lengthMm: 0, truthLengthMm: 0, correct: false, usable: false };
  if (points.length < 3 || truth.length === 0) return empty;
  let lengthMm = 0;
  for (let i = 0; i < points.length; i++) lengthMm += Math.sqrt(dist2(points[i]!, points[(i + 1) % points.length]!));
  const line = densify(points, 0.05);
  const devs = line.map((p) => nearest(p, truth)).sort((a, b) => a - b);
  const meanMm = devs.reduce((s, d) => s + d, 0) / devs.length;
  const p95Mm = devs[Math.min(devs.length - 1, Math.floor(devs.length * 0.95))]!;
  const maxMm = devs.at(-1)!;
  const coverage = truth.filter((q) => nearest(q, line) <= 0.3).length / truth.length;
  const truthLine = truthPolyline(truth);
  let truthLengthMm = 0;
  for (let i = 0; i < truthLine.length; i++) truthLengthMm += Math.sqrt(dist2(truthLine[i]!, truthLine[(i + 1) % truthLine.length]!));
  return {
    meanMm,
    p95Mm,
    maxMm,
    coverage,
    lengthMm,
    truthLengthMm,
    correct: meanMm <= CORRECT.meanMm && p95Mm <= CORRECT.p95Mm && coverage >= CORRECT.coverage,
    usable: meanMm <= USABLE.meanMm && coverage >= USABLE.coverage,
  };
}

export interface NaturalRow {
  case: string;
  variant: string;
  method: string;
  score: NaturalScore;
  ms: number;
  note?: string;
  error?: string;
}

export async function runNaturalBench(methods: Record<string, NaturalMethod>, cases = NATURAL_CASES, onRow?: (row: NaturalRow) => void): Promise<NaturalRow[]> {
  const rows: NaturalRow[] = [];
  for (const spec of cases) {
    const data = prepareNaturalCase(spec);
    for (const [name, method] of Object.entries(methods)) {
      const t0 = performance.now();
      let row: NaturalRow;
      try {
        const out = await method(data.input);
        row = { case: spec.name, variant: spec.variant, method: name, score: scoreNatural(data.truth, out.points), ms: performance.now() - t0, ...(out.note ? { note: out.note } : {}) };
      } catch (e) {
        row = { case: spec.name, variant: spec.variant, method: name, score: scoreNatural(data.truth, []), ms: performance.now() - t0, error: e instanceof Error ? e.message : String(e) };
      }
      rows.push(row);
      onRow?.(row);
    }
  }
  return rows;
}

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '–');
const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

export const formatRow = (r: NaturalRow): string =>
  `| ${r.case} | ${r.method} | ${r.score.correct ? 'correct' : r.score.usable ? 'usable' : 'no'} | ${f2(r.score.meanMm)} | ${f2(r.score.p95Mm)} | ${f2(r.score.maxMm)} | ${(r.score.coverage * 100).toFixed(0)}% | ${f2(r.score.lengthMm)} / ${f2(r.score.truthLengthMm)} | ${Math.round(r.ms)} | ${(r.error ?? r.note ?? '').slice(0, 80)} |`;

export const ROW_HEADER = '| Case | Method | Result | Mean mm | p95 mm | Max mm | Coverage | Length / truth mm | ms | Note |\n|---|---|---|---|---|---|---|---|---|---|';

/** Per method and variant: correct and usable counts, median mean deviation, median time. */
export function summarize(rows: NaturalRow[]): string {
  const lines = ['| Method | Variant | Correct | Usable | Median mean mm | Median ms |', '|---|---|---|---|---|---|'];
  const methods = [...new Set(rows.map((r) => r.method))];
  const variants = [...new Set(rows.map((r) => r.variant))];
  for (const m of methods) {
    for (const v of [...variants, 'all']) {
      const rs = rows.filter((r) => r.method === m && (v === 'all' || r.variant === v));
      if (!rs.length) continue;
      lines.push(`| ${m} | ${v} | ${rs.filter((r) => r.score.correct).length}/${rs.length} | ${rs.filter((r) => r.score.usable).length}/${rs.length} | ${f2(median(rs.map((r) => r.score.meanMm)))} | ${Math.round(median(rs.map((r) => r.ms)))} |`);
    }
  }
  return lines.join('\n');
}
