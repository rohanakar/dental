/**
 * Headless golden-case runner.
 *
 *   pnpm pipeline [--cases data/golden] [--out out/pipeline] [--case <id>] [--synthetic]
 *
 * --synthetic first writes data/golden/synthetic-36 (no patient data). Each
 * case writes <out>/<id>/metrics.json and crown.stl. Exits 1 if any check
 * fails or a case errors.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GoldenCase, writeSyntheticCase } from './golden';
import { runCase } from './pipeline';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { values } = parseArgs({
  options: {
    cases: { type: 'string', default: join(repoRoot, 'data', 'golden') },
    out: { type: 'string', default: join(repoRoot, 'out', 'pipeline') },
    case: { type: 'string' },
    synthetic: { type: 'boolean', default: false },
  },
});
const casesDir = resolve(values.cases);
const outDir = resolve(values.out);

if (values.synthetic) {
  const dir = join(casesDir, 'synthetic-36');
  const t0 = performance.now();
  writeSyntheticCase(dir);
  console.log(`wrote ${dir} (${Math.round(performance.now() - t0)} ms)`);
}

if (!existsSync(casesDir)) {
  console.error(`No golden cases at ${casesDir}. Run with --synthetic to create the synthetic case.`);
  process.exit(1);
}
const ids = readdirSync(casesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(casesDir, d.name, 'case.json')))
  .map((d) => d.name)
  .filter((id) => !values.case || id === values.case)
  .sort();
if (ids.length === 0) {
  console.error(`No cases found in ${casesDir}${values.case ? ` matching "${values.case}"` : ''}.`);
  process.exit(1);
}

let failed = 0;
for (const id of ids) {
  const dir = join(casesDir, id);
  try {
    const spec = GoldenCase.parse(JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')));
    const { metrics, crownStl } = await runCase(spec, dir);
    const caseOut = join(outDir, id);
    mkdirSync(caseOut, { recursive: true });
    writeFileSync(join(caseOut, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
    writeFileSync(join(caseOut, 'crown.stl'), crownStl);
    const total = Object.values(metrics.timingsMs).reduce((a, b) => a + b, 0);
    console.log(`\n${metrics.ok ? 'PASS' : 'FAIL'}  ${id} (FDI ${metrics.fdi}) in ${Math.round(total)} ms → ${join(caseOut, 'metrics.json')}`);
    for (const c of metrics.checks) {
      const value = c.value !== undefined ? ` = ${c.value}${c.threshold !== undefined ? ` (limit ${c.threshold})` : ''}` : '';
      console.log(`  ${c.passed ? '✓' : '✗'} ${c.id}${value}: ${c.message}`);
    }
    console.log(`  timings ms: ${Object.entries(metrics.timingsMs).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}`);
    if (!metrics.ok) failed++;
  } catch (e) {
    failed++;
    console.error(`\nERROR ${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`\n${ids.length - failed}/${ids.length} cases passed`);
process.exit(failed > 0 ? 1 : 0);
