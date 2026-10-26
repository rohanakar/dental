/**
 * Margin evaluation (specs/2026-10-26-margin-ai.md): the automatic margin on synthetic prepped teeth made hard on
 * purpose (scan noise, an off-centre click, a tilted frame), plus natural teeth as negative controls. Each case runs
 * through every method (the plain margin, the refiner, and with a model the refiner plus the margin-tool loop) and is
 * scored by the margin gate and by its deviation from the true synthetic margin.
 *
 *   pnpm --filter @dcad/pipeline-runner run margin-eval [--only <case>] [--methods plain,refine]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { runMarginAgent } from '@dcad/web/margin-agent';
import { anthropicLlm } from './anthropicLlm';
import {
  analyzeSurface,
  bvhRayCaster,
  computeVertexNormals,
  createBvh,
  estimateToothFrame,
  liveWireWeight,
  marginFromAnchors,
  type MarginScan,
  type MarginWork,
  MARGIN_MAX_TURN_DEG,
  marginShapePasses,
  proposeMarginAnchors,
  refineMargin,
  sharpestTurnDeg,
  syntheticArch,
  syntheticPrepMargin,
  syntheticPrepSeed,
  withScanNoise,
  type IndexedMesh,
  type RayCaster,
  type V3,
} from '@dcad/web/geometry';

const ALONG = 1000;
const ACROSS = 500;

/** One evaluation case: a jaw, the tooth, and what makes it hard. */
export interface MarginCase {
  name: string;
  jaw: 'upper' | 'lower';
  fdi: number;
  /** Prepared teeth on the arch; the case's tooth is natural when not in it (a negative control). */
  preps: number[];
  leanDeg?: number;
  /** Vertex noise along the normals, standard deviation in mm. */
  noiseMm?: number;
  /** The click that seeds the frame, moved off the prep top (mm, along the arch's +x / +y). */
  seedOffset?: [number, number];
  /** The frame's occlusal tilted this many degrees about its mesial direction. */
  tiltDeg?: number;
}

export const MARGIN_CASES: MarginCase[] = [
  { name: '36 clean', jaw: 'lower', fdi: 36, preps: [36] },
  { name: '36 noise 0.02', jaw: 'lower', fdi: 36, preps: [36], noiseMm: 0.02 },
  { name: '36 noise 0.04', jaw: 'lower', fdi: 36, preps: [36], noiseMm: 0.04 },
  { name: '36 click 1.5 mm off', jaw: 'lower', fdi: 36, preps: [36], seedOffset: [1.5, 0] },
  { name: '36 click 2.5 mm off', jaw: 'lower', fdi: 36, preps: [36], seedOffset: [0, 2.5] },
  { name: '36 frame tilted 12°', jaw: 'lower', fdi: 36, preps: [36], tiltDeg: 12 },
  { name: '36 noise 0.05', jaw: 'lower', fdi: 36, preps: [36], noiseMm: 0.05 },
  { name: '36 noise 0.04, click 2 mm off', jaw: 'lower', fdi: 36, preps: [36], noiseMm: 0.04, seedOffset: [2, 0] },
  { name: '11 noise 0.04', jaw: 'upper', fdi: 11, preps: [11, 21], noiseMm: 0.04 },
  { name: '11 lean 25° noise 0.03', jaw: 'upper', fdi: 11, preps: [11, 21], leanDeg: 25, noiseMm: 0.03 },
  { name: '14 noise 0.04', jaw: 'upper', fdi: 14, preps: [14], noiseMm: 0.04 },
  { name: '45 noise 0.05', jaw: 'lower', fdi: 45, preps: [45], noiseMm: 0.05 },
  { name: '14 click 2 mm off', jaw: 'upper', fdi: 14, preps: [14], seedOffset: [2, 0] },
  { name: '36 noise 0.07', jaw: 'lower', fdi: 36, preps: [36], noiseMm: 0.07 },
  { name: '11 lean 25° noise 0.05', jaw: 'upper', fdi: 11, preps: [11, 21], leanDeg: 25, noiseMm: 0.05 },
  { name: '45 noise 0.06, click 2 mm off', jaw: 'lower', fdi: 45, preps: [45], noiseMm: 0.06, seedOffset: [2, 0] },
  { name: '14 noise 0.06, tilted 10°', jaw: 'upper', fdi: 14, preps: [14], noiseMm: 0.06, tiltDeg: 10 },
  { name: '11 natural (control)', jaw: 'upper', fdi: 11, preps: [] },
  { name: '46 natural (control)', jaw: 'lower', fdi: 46, preps: [36] },
  { name: '46 natural noise 0.04 (control)', jaw: 'lower', fdi: 46, preps: [36], noiseMm: 0.04 },
];

export interface PreparedCase {
  spec: MarginCase;
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  ray: RayCaster;
  frame: { origin: V3; occlusal: V3; mesial: V3; buccal: V3 };
  surface: ReturnType<typeof analyzeSurface>;
  /** The true margin (synthetic), or null for a natural tooth. */
  truth: Float32Array | null;
}

const rotateAbout = (v: V3, axis: V3, deg: number): V3 => {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  const x: V3 = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
  return [v[0] * c + x[0] * s + axis[0] * d * (1 - c), v[1] * c + x[1] * s + axis[1] * d * (1 - c), v[2] * c + x[2] * s + axis[2] * d * (1 - c)];
};

export function prepareCase(spec: MarginCase): PreparedCase {
  const mesh: IndexedMesh = syntheticArch({ jaw: spec.jaw, along: ALONG, across: ACROSS, preps: spec.preps, ...(spec.leanDeg ? { anteriorLeanDeg: spec.leanDeg } : {}) });
  const positions = spec.noiseMm ? withScanNoise(mesh, spec.noiseMm, spec.fdi * 1000 + Math.round(spec.noiseMm * 1000)).positions : mesh.positions;
  const indices = mesh.indices.slice();
  const normals = computeVertexNormals({ positions, indices });
  const ray = bvhRayCaster(createBvh({ positions, indices }));
  const top = syntheticPrepSeed({ fdi: spec.fdi, along: ALONG, ...(spec.leanDeg ? { anteriorLeanDeg: spec.leanDeg } : {}) });
  const seed: V3 = spec.seedOffset ? [top[0] + spec.seedOffset[0], top[1] + spec.seedOffset[1], top[2]] : top;
  const est = estimateToothFrame({ jaw: { positions, normals, indices }, seed, fdi: spec.fdi, ray, prep: true });
  let frame = { origin: est.origin, occlusal: est.occlusal, mesial: est.mesial, buccal: est.buccal };
  if (spec.tiltDeg) frame = { ...frame, occlusal: rotateAbout(frame.occlusal, frame.mesial, spec.tiltDeg), buccal: rotateAbout(frame.buccal, frame.mesial, spec.tiltDeg) };
  const surface = analyzeSurface({ positions, indices, normals });
  const prepped = spec.preps.includes(spec.fdi);
  const truth = prepped ? syntheticPrepMargin({ fdi: spec.fdi, along: ALONG, samples: 256, ...(spec.leanDeg ? { anteriorLeanDeg: spec.leanDeg } : {}) }) : null;
  return { spec, positions, indices, normals, ray, frame, surface, truth };
}

/** A margin a method proposes: the dense trace and the anchors it came from. */
export interface MarginOutcome {
  points: V3[];
  lengthMm: number;
  anchors: V3[];
  /** Ridge confidence of the anchors (0..1), when the method has one. */
  confidence?: number;
  /** Tool calls (model loop) or traces (refiner) the method used. */
  steps?: number;
  costUsd?: number;
  note?: string;
}

export type MarginMethod = (c: PreparedCase) => Promise<MarginOutcome>;

/** Trace a closed margin through `anchors` with the live-wire, as the app does. */
export function traceAnchors(c: PreparedCase, anchors: V3[]): { points: V3[]; lengthMm: number } {
  const trace = marginFromAnchors({ positions: c.positions, indices: c.indices, graph: c.surface.graph, weight: liveWireWeight(c.surface.curvature), ray: c.ray, anchors });
  const points: V3[] = [];
  for (let i = 0; i < trace.points.length; i += 3) points.push([trace.points[i]!, trace.points[i + 1]!, trace.points[i + 2]!]);
  return { points, lengthMm: trace.lengthMm };
}

/** The automatic margin as the app runs it today (classical.margin-ridge). */
export const plainMethod: MarginMethod = async (c) => {
  const proposal = proposeMarginAnchors({ positions: c.positions, indices: c.indices, ray: c.ray, frame: c.frame });
  if (proposal.anchors.length < 3) return { points: [], lengthMm: 0, anchors: proposal.anchors, confidence: proposal.confidence, steps: 1, note: 'no ridge' };
  return { ...traceAnchors(c, proposal.anchors), anchors: proposal.anchors, confidence: proposal.confidence, steps: 1 };
};

/** The refiner (geometry/marginRefine.ts): ring-consistent anchors, a few profile counts, a smoothed trace. */
export const refineMethod: MarginMethod = async (c) => {
  const r = refineMargin({ positions: c.positions, indices: c.indices, ray: c.ray, graph: c.surface.graph, weight: liveWireWeight(c.surface.curvature), frame: c.frame });
  if (!r) return { points: [], lengthMm: 0, anchors: [], steps: 0, note: 'no ridge' };
  const points: V3[] = [];
  for (let i = 0; i < r.points.length; i += 3) points.push([r.points[i]!, r.points[i + 1]!, r.points[i + 2]!]);
  return { points, lengthMm: r.lengthMm, anchors: r.anchors, confidence: r.passes ? r.confidence : 0, steps: r.candidates.length, note: `${r.name}; wander ${r.wander.toFixed(2)}, kept ${r.kept.toFixed(2)}` };
};

const scanOf = (c: PreparedCase): MarginScan => ({ positions: c.positions, indices: c.indices, ray: c.ray, graph: c.surface.graph, weight: liveWireWeight(c.surface.curvature), frame: c.frame });

/** The model (through ANTHROPIC_BASE_URL: the API, or the local `claude -p` bridge), or null when none is configured. */
function modelFromEnv() {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!baseUrl) return null;
  return anthropicLlm({ baseUrl, apiKey: process.env.ANTHROPIC_API_KEY ?? 'bridge', model: process.env.MARGIN_AGENT_MODEL ?? 'claude-opus-5-5' });
}

/**
 * The model repairing the margin with the margin tools (ai/marginAgent.ts), from the plain margin, or from the
 * refiner's (calling the model only when the refiner fails).
 */
function agentMethod(start: 'plain' | 'refine'): MarginMethod {
  return async (c) => {
    const llm = modelFromEnv();
    if (!llm) return { points: [], lengthMm: 0, anchors: [], note: 'no model: set ANTHROPIC_BASE_URL (tools/claude-bridge)' };
    const from = await (start === 'plain' ? plainMethod : refineMethod)(c);
    if (start === 'refine' && from.confidence !== undefined && from.confidence > 0) return { ...from, steps: 0, note: `refiner passed; no model call (${from.note ?? ''})` };
    const work: MarginWork = { anchors: from.anchors, points: from.points, lengthMm: from.lengthMm, profilesRun: 16, found: from.anchors.length };
    if (work.anchors.length < 3) return { ...from, note: 'no margin to repair' };
    const cost0 = llm.costUsd();
    const r = await runMarginAgent({ llm, scan: scanOf(c), start: work });
    const verdictOk = r.report.passes && r.verdict !== 'not_a_prep';
    return {
      points: r.work.points,
      lengthMm: r.work.lengthMm,
      anchors: r.work.anchors,
      confidence: verdictOk ? r.report.foundShare : 0,
      steps: r.calls,
      costUsd: llm.costUsd() - cost0,
      note: `${r.verdict}: ${r.reason.slice(0, 80)} | ${r.log.map((l) => l.split(' ')[0]).join(',')}`,
    };
  };
}

function distanceToPolyline(p: V3, poly: Float32Array): number {
  let best = Infinity;
  const n = poly.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 3]!, ay = poly[i * 3 + 1]!, az = poly[i * 3 + 2]!;
    const bx = poly[j * 3]! - ax, by = poly[j * 3 + 1]! - ay, bz = poly[j * 3 + 2]! - az;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * bx + (p[1] - ay) * by + (p[2] - az) * bz) / (bx * bx + by * by + bz * bz || 1)));
    best = Math.min(best, Math.hypot(p[0] - ax - t * bx, p[1] - ay - t * by, p[2] - az - t * bz));
  }
  return best;
}

export interface MarginScore {
  pass: boolean;
  lengthMm: number;
  turnDeg: number;
  /** Mean and largest distance from the true margin (mm); null for a natural tooth. */
  meanDevMm: number | null;
  maxDevMm: number | null;
}

/** The margin gate's shape checks plus, for a prepped tooth, how far the margin is from the true one. */
export function scoreMargin(c: PreparedCase, o: MarginOutcome): MarginScore {
  const turnDeg = o.points.length ? sharpestTurnDeg(o.points) : 180;
  const pass = o.points.length > 0 && marginShapePasses(o.points, o.lengthMm) && (o.confidence === undefined || o.confidence >= 0.75);
  if (!c.truth || o.points.length === 0) return { pass, lengthMm: o.lengthMm, turnDeg, meanDevMm: null, maxDevMm: null };
  let sum = 0, max = 0;
  for (const p of o.points) {
    const d = distanceToPolyline(p, c.truth);
    sum += d;
    max = Math.max(max, d);
  }
  return { pass, lengthMm: o.lengthMm, turnDeg, meanDevMm: sum / o.points.length, maxDevMm: max };
}

/** A pass that is far from the true margin is not a success: within this mean deviation it counts as correct. */
export const CORRECT_MEAN_DEV_MM = 0.15;

export async function evaluate(methods: Record<string, MarginMethod>, cases = MARGIN_CASES): Promise<Array<{ case: string; method: string; score: MarginScore; outcome: MarginOutcome; ms: number }>> {
  const rows: Array<{ case: string; method: string; score: MarginScore; outcome: MarginOutcome; ms: number }> = [];
  for (const spec of cases) {
    const c = prepareCase(spec);
    for (const [name, method] of Object.entries(methods)) {
      const t0 = performance.now();
      const outcome = await method(c);
      const ms = performance.now() - t0;
      rows.push({ case: spec.name, method: name, score: scoreMargin(c, outcome), outcome, ms });
    }
  }
  return rows;
}

const fmt = (v: number | null, d = 2) => (v === null ? '–' : v.toFixed(d));

export function formatRows(rows: Awaited<ReturnType<typeof evaluate>>): string {
  const lines = ['| Case | Method | Gate | Length mm | Sharpest ° | Mean dev mm | Max dev mm | Correct | Steps | ms | $ | Note |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const s = r.score;
    const natural = s.meanDevMm === null && r.case.includes('natural');
    const correct = natural ? (s.pass ? 'NO (passed a natural tooth)' : 'yes (rejected)') : s.pass && s.meanDevMm !== null && s.meanDevMm <= CORRECT_MEAN_DEV_MM ? 'yes' : 'no';
    lines.push(`| ${r.case} | ${r.method} | ${s.pass ? 'pass' : 'FAIL'} | ${fmt(s.lengthMm, 1)} | ${fmt(s.turnDeg, 0)}${s.turnDeg > MARGIN_MAX_TURN_DEG ? ' !' : ''} | ${fmt(s.meanDevMm)} | ${fmt(s.maxDevMm)} | ${correct} | ${r.outcome.steps ?? ''} | ${r.ms.toFixed(0)} | ${r.outcome.costUsd !== undefined ? r.outcome.costUsd.toFixed(2) : ''} | ${r.outcome.note ?? ''} |`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
  const wanted = (args.includes('--methods') ? args[args.indexOf('--methods') + 1]! : 'plain').split(',');
  const available: Record<string, MarginMethod> = { plain: plainMethod, refine: refineMethod, agent: agentMethod('plain'), 'refine+agent': agentMethod('refine') };
  const methods = Object.fromEntries(wanted.filter((m) => available[m]).map((m) => [m, available[m]!]));
  const cases = only ? MARGIN_CASES.filter((c) => c.name.includes(only)) : MARGIN_CASES;
  const rows = await evaluate(methods, cases);
  const table = formatRows(rows);
  console.log(table);
  const dir = new URL('../../../out/margin-eval/', import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}results.md`, `${table}\n`);
  writeFileSync(`${dir}results.json`, JSON.stringify(rows.map(({ outcome, ...r }) => ({ ...r, steps: outcome.steps, note: outcome.note })), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
