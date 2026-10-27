/**
 * Run the natural-tooth margin benchmark (bench.ts).
 *
 *   pnpm --filter @dcad/pipeline-runner exec tsx src/natural/run.ts --methods refine,<name> [--only <substr>] [--out <file>]
 *
 * A method is src/natural/methods/<name>.ts exporting `method: NaturalMethod`. `--methods truth` scores the truth
 * against itself (the benchmark's self-check: about 0 mm).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NATURAL_CASES, ROW_HEADER, formatRow, prepareNaturalCase, runNaturalBench, scoreNatural, summarize, truthPolyline, type NaturalMethod } from './bench';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const names = (arg('methods') ?? 'refine').split(',').filter(Boolean);
const only = arg('only');
const out = arg('out') ?? `../../out/natural-margin-research/bench-${names.join('+')}.md`;
const cases = only ? NATURAL_CASES.filter((c) => c.name.includes(only)) : NATURAL_CASES;

if (names.includes('truth')) {
  // Self-check: the truth as a line (truthPolyline), scored against its own points.
  for (const spec of cases) {
    const { truth } = prepareNaturalCase(spec);
    const s = scoreNatural(truth, truthPolyline(truth));
    console.log(`${spec.name}: truth ${truth.length} points, mean ${s.meanMm.toFixed(3)} mm, coverage ${(s.coverage * 100).toFixed(0)}%, length ${s.truthLengthMm.toFixed(1)} mm`);
  }
  process.exit(0);
}

const methods: Record<string, NaturalMethod> = {};
for (const name of names) methods[name] = ((await import(`./methods/${name}.ts`)) as { method: NaturalMethod }).method;

console.log(ROW_HEADER);
const rows = await runNaturalBench(methods, cases, (r) => console.log(formatRow(r)));
const summary = summarize(rows);
console.log(`\n${summary}`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `# Natural-tooth margin benchmark: ${names.join(', ')}\n\n${summary}\n\n${ROW_HEADER}\n${rows.map(formatRow).join('\n')}\n`);
writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(rows, null, 1));
console.log(`\nwritten ${out}`);
