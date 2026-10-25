/**
 * Headless golden-case runner.
 *
 *   pnpm pipeline [--cases data/golden] [--out out/pipeline] [--case <id>] [--synthetic] [--auto]
 *
 * --synthetic first writes the synthetic cases (no patient data) into
 * data/golden: synthetic-36 and the bridges synthetic-bridge-35-37 and
 * synthetic-bridge-12-22. Each case writes <out>/<id>/metrics.json and
 * crown.stl (a bridge case: bridge.stl). --auto also runs every case with the
 * automatic margin (classical.margin-ridge) instead of the scripted anchors,
 * writing <out>/<id>-auto/. Exits 1 if any check fails or a case errors.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runBridgeCase } from './bridgePipeline';
import { GoldenCase, SYNTHETIC_BRIDGES, writeSyntheticBridgeCase, writeSyntheticCase, type SyntheticBridgeKind } from './golden';
import { runCase } from './pipeline';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { values } = parseArgs({
  options: {
    cases: { type: 'string', default: join(repoRoot, 'data', 'golden') },
    out: { type: 'string', default: join(repoRoot, 'out', 'pipeline') },
    case: { type: 'string' },
    synthetic: { type: 'boolean', default: false },
    auto: { type: 'boolean', default: false },
  },
});
const casesDir = resolve(values.cases);
const outDir = resolve(values.out);

if (values.synthetic) {
  const dir = join(casesDir, 'synthetic-36');
  const t0 = performance.now();
  writeSyntheticCase(dir);
  console.log(`wrote ${dir} (${Math.round(performance.now() - t0)} ms)`);
  for (const kind of Object.keys(SYNTHETIC_BRIDGES) as SyntheticBridgeKind[]) {
    const bridgeDir = join(casesDir, SYNTHETIC_BRIDGES[kind].id);
    const t1 = performance.now();
    writeSyntheticBridgeCase(bridgeDir, kind);
    console.log(`wrote ${bridgeDir} (${Math.round(performance.now() - t1)} ms)`);
  }
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
let runs = 0;
const modes = values.auto ? [false, true] : [false];
for (const id of ids) {
  const dir = join(casesDir, id);
  for (const auto of modes) {
    const label = auto ? `${id}-auto` : id;
    runs++;
    try {
      const spec = GoldenCase.parse(JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')));
      const caseOut = join(outDir, label);
      mkdirSync(caseOut, { recursive: true });
      let metrics: { ok: boolean; timingsMs: Record<string, number>; checks: Array<{ id: string; passed: boolean; message: string; value?: number; threshold?: number }> };
      let title: string;
      if (spec.bridge) {
        const result = await runBridgeCase(spec, dir, { auto });
        metrics = result.metrics;
        writeFileSync(join(caseOut, 'bridge.stl'), result.bridgeStl);
        title = `bridge ${result.metrics.teeth.join('–')}, ${auto ? 'auto' : 'scripted'} margins`;
      } else {
        const result = await runCase(spec, dir, { auto });
        metrics = result.metrics;
        writeFileSync(join(caseOut, 'crown.stl'), result.crownStl);
        title = `FDI ${result.metrics.fdi}, ${result.metrics.margin.source} margin`;
      }
      writeFileSync(join(caseOut, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
      // Bridge timings include the designBridge.* breakdown of their designBridge entry.
      const total = Object.entries(metrics.timingsMs).reduce((a, [k, v]) => a + (k.startsWith('designBridge.') ? 0 : v), 0);
      console.log(`\n${metrics.ok ? 'PASS' : 'FAIL'}  ${label} (${title}) in ${Math.round(total)} ms → ${join(caseOut, 'metrics.json')}`);
      for (const c of metrics.checks) {
        const value = c.value !== undefined ? ` = ${c.value}${c.threshold !== undefined ? ` (limit ${c.threshold})` : ''}` : '';
        console.log(`  ${c.passed ? '✓' : '✗'} ${c.id}${value}: ${c.message}`);
      }
      console.log(`  timings ms: ${Object.entries(metrics.timingsMs).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}`);
      if (!metrics.ok) failed++;
    } catch (e) {
      failed++;
      console.error(`\nERROR ${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
console.log(`\n${runs - failed}/${runs} runs passed`);
process.exit(failed > 0 ? 1 : 0);
