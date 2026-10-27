/**
 * Does the prep finder report preps on real, all-natural jaws (Teeth3DS+, local only)? It did: 10 false preps on 12
 * jaws (specs/2026-10-27-natural-margin.md), so a prep seen near a tooth only breaks the tie in auto-design's rule.
 *
 *   pnpm --filter @dcad/pipeline-runner exec tsx src/natural/prepFinderOnNatural.ts
 */
import { findPreps } from '../../../../apps/web/src/geometry/prepFinder';
import { HOLDOUT_CASES, REAL_CASES, prepareNaturalCase } from './bench';

const seen = new Set<string>();
for (const spec of [...REAL_CASES, ...HOLDOUT_CASES]) {
  if (seen.has(spec.teeth3ds!)) continue;
  seen.add(spec.teeth3ds!);
  const { input } = prepareNaturalCase(spec);
  const f = findPreps({ positions: input.positions, normals: input.normals, indices: input.indices, ray: input.ray });
  console.log(`${spec.name.split(' ').slice(0, 2).join(' ')} ${spec.jaw}: ${f.preps.length} preps (examined ${f.examined}, ${Math.round(f.ms)} ms)${f.preps.map((p) => ` ring ${p.ring.toFixed(2)}`).join('')}`);
}
