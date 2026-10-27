/**
 * Where do the refiner's finish line and the walker's gum line sit, on synthetic preps and on real natural teeth
 * (specs/2026-10-27-natural-margin.md)? On a prep the walker follows the gum line about 1.5 mm below the finish line;
 * the height gap between the two lines does not tell a prep from a natural tooth.
 *
 *   pnpm --filter @dcad/pipeline-runner exec tsx src/natural/finishVsGum.ts
 */
import { liveWireWeight, naturalMargin, refineMargin, type V3 } from '@dcad/web/geometry';
import { MARGIN_CASES, prepareCase } from '../marginEval';
import { REAL_CASES, SYNTHETIC_CASES, prepareNaturalCase } from './bench';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const pts = (f: Float32Array): V3[] => Array.from({ length: f.length / 3 }, (_, i) => [f[i * 3]!, f[i * 3 + 1]!, f[i * 3 + 2]!]);
/** Median over the refiner's points of (its height − the height of the walker's nearest-angle point), along the axis. */
function gap(finish: V3[], gum: V3[], frame: { origin: V3; occlusal: V3; mesial: V3; buccal: V3 }): number {
  const ang = (p: V3) => { const d: V3 = [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]]; return Math.atan2(dot(d, frame.buccal), dot(d, frame.mesial)); };
  const h = (p: V3) => dot(p, frame.occlusal);
  const g = gum.map((p) => ({ a: ang(p), h: h(p) }));
  const diffs = finish.map((p) => { const a = ang(p); let best = g[0]!; for (const q of g) if (Math.abs(Math.atan2(Math.sin(q.a - a), Math.cos(q.a - a))) < Math.abs(Math.atan2(Math.sin(best.a - a), Math.cos(best.a - a)))) best = q; return h(p) - best.h; }).sort((x, y) => x - y);
  return diffs[Math.floor(diffs.length / 2)]!;
}
const meanDist = (a: V3[], b: Float32Array) => a.reduce((s, p) => { let m = Infinity; for (let i = 0; i < b.length; i += 3) m = Math.min(m, Math.hypot(p[0] - b[i]!, p[1] - b[i + 1]!, p[2] - b[i + 2]!)); return s + m; }, 0) / a.length;

for (const spec of MARGIN_CASES.filter((c) => c.preps.includes(c.fdi))) {
  const c = prepareCase(spec);
  const ref = refineMargin({ positions: c.positions, indices: c.indices, ray: c.ray, graph: c.surface.graph, weight: liveWireWeight(c.surface.curvature), frame: c.frame });
  const nat = naturalMargin({ positions: c.positions, indices: c.indices, graph: c.surface.graph, curvature: c.surface.curvature, ray: c.ray, frame: c.frame, fdi: spec.fdi });
  console.log(`PREP ${spec.name}: refiner passes ${ref?.passes}, gap ${gap(pts(ref!.points), nat.points, c.frame).toFixed(2)} mm, walker→true margin ${meanDist(nat.points, c.truth!).toFixed(2)} mm, agree ${nat.agreementMm.toFixed(2)}`);
}
for (const spec of [...REAL_CASES, ...SYNTHETIC_CASES.filter((c) => c.variant === 'bare')]) {
  const { input } = prepareNaturalCase(spec);
  const ref = refineMargin({ positions: input.positions, indices: input.indices, ray: input.ray, graph: input.surface.graph, weight: input.weight, frame: input.frame });
  const nat = naturalMargin({ positions: input.positions, indices: input.indices, graph: input.surface.graph, curvature: input.surface.curvature, ray: input.ray, frame: input.frame, fdi: spec.fdi });
  if (ref) console.log(`NATURAL ${spec.name}: refiner passes ${ref.passes}, gap ${gap(pts(ref.points), nat.points, input.frame).toFixed(2)} mm`);
}
