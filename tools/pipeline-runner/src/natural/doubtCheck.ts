/**
 * How well the margin doubt test (apps/web/src/geometry/marginDoubt.ts) points at wrong stretches of a line:
 * - gum lines on the real development teeth: the line as found, and the same line with a fifth pushed 1 mm up the
 *   tooth (wrong = more than 0.3 mm from the labelled gum line);
 * - finish lines on the synthetic preps of marginEval.ts: the refiner's line, and the same with a fifth pushed up
 *   (wrong = more than 0.3 mm from the true margin).
 *
 *   pnpm --filter @dcad/pipeline-runner exec tsx src/natural/doubtCheck.ts
 */
import { liveWireWeight, marginDoubt, naturalMargin, refineMargin, DOUBT_OFF, type MarginLineKind, type RayCaster, type V3 } from '@dcad/web/geometry';
import { MARGIN_CASES, prepareCase } from '../marginEval';
import { REAL_CASES, prepareNaturalCase } from './bench';

const dist = (p: V3, q: V3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
interface Tally {
  tp: number;
  fp: number;
  fn: number;
  flagged: number;
  n: number;
  ms: number;
  lines: number;
}
const tally = (): Tally => ({ tp: 0, fp: 0, fn: 0, flagged: 0, n: 0, ms: 0, lines: 0 });
const tallies: Record<string, Tally> = { 'gum clean': tally(), 'gum pushed': tally(), 'finish clean': tally(), 'finish pushed': tally() };

/** The line with a fifth of it pushed `mm` up the tooth, back onto the scan. */
const pushUp = (line: V3[], ray: RayCaster, up: V3, mm = 1): V3[] =>
  line.map((p, i): V3 => {
    if (i < 0.1 * line.length || i > 0.3 * line.length) return p;
    const hit = ray.closestPoint([p[0] + mm * up[0], p[1] + mm * up[1], p[2] + mm * up[2]], 2);
    return hit ? [hit.point[0], hit.point[1], hit.point[2]] : p;
  });

function score(t: Tally, scan: { positions: Float32Array; indices: Uint32Array; normals: Float32Array; ray: RayCaster; up: V3 }, line: V3[], truth: V3[], kind: MarginLineKind): void {
  const t0 = performance.now();
  const d = marginDoubt({ ...scan, points: line, line: kind });
  t.ms += performance.now() - t0;
  t.lines++;
  line.forEach((p, i) => {
    const wrong = Math.min(...truth.map((q) => dist(p, q))) > 0.3;
    const off = d.levels[i] === DOUBT_OFF;
    t.n++;
    if (off) t.flagged++;
    if (off && wrong) t.tp++;
    else if (off) t.fp++;
    else if (wrong) t.fn++;
  });
}

for (const spec of REAL_CASES) {
  const { input, truth } = prepareNaturalCase(spec);
  const scan = { positions: input.positions, indices: input.indices, normals: input.normals, ray: input.ray, up: input.frame.occlusal };
  const line = naturalMargin({ ...input, graph: input.surface.graph, curvature: input.surface.curvature }).points;
  score(tallies['gum clean']!, scan, line, truth, 'gum');
  score(tallies['gum pushed']!, scan, pushUp(line, input.ray, input.frame.occlusal), truth, 'gum');
}

for (const spec of MARGIN_CASES.filter((c) => c.preps.includes(c.fdi))) {
  const c = prepareCase(spec);
  const r = refineMargin({ positions: c.positions, indices: c.indices, ray: c.ray, graph: c.surface.graph, weight: liveWireWeight(c.surface.curvature), frame: c.frame });
  if (!r || !c.truth) continue;
  const unpack = (f: Float32Array): V3[] => Array.from({ length: f.length / 3 }, (_, i) => [f[i * 3]!, f[i * 3 + 1]!, f[i * 3 + 2]!]);
  const scan = { positions: c.positions, indices: c.indices, normals: c.normals, ray: c.ray, up: c.frame.occlusal };
  const line = unpack(r.points);
  score(tallies['finish clean']!, scan, line, unpack(c.truth), 'finish');
  score(tallies['finish pushed']!, scan, pushUp(line, c.ray, c.frame.occlusal), unpack(c.truth), 'finish');
}

for (const [name, t] of Object.entries(tallies)) {
  console.log(
    `${name.padEnd(14)} recall ${((100 * t.tp) / Math.max(1, t.tp + t.fn)).toFixed(0)}% (${t.tp}/${t.tp + t.fn}), precision ${((100 * t.tp) / Math.max(1, t.tp + t.fp)).toFixed(0)}%, flagged ${((100 * t.flagged) / Math.max(1, t.n)).toFixed(0)}% of points, ${(t.ms / Math.max(1, t.lines)).toFixed(0)} ms per line`,
  );
}
