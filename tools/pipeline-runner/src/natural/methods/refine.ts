import { refineMargin } from '@dcad/web/geometry';
import type { NaturalMethod } from '../bench';

/** Baseline: today's automatic margin (the refiner), which looks for a prep's convex finish line. */
export const method: NaturalMethod = (c) => {
  const best = refineMargin({ positions: c.positions, indices: c.indices, ray: c.ray, graph: c.surface.graph, weight: c.weight, frame: c.frame });
  if (!best) return { points: [], note: 'no margin found' };
  const points = Array.from({ length: best.points.length / 3 }, (_, i) => [best.points[i * 3]!, best.points[i * 3 + 1]!, best.points[i * 3 + 2]!] as [number, number, number]);
  return { points, note: `${best.name}; passes its gate: ${best.passes}` };
};
