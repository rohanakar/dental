// Maryland bridge auto-design (offline, headless Chrome) on the synthetic golden case 11w–[12]: setup, scans,
// one-click armed, one click on 11's palatal surface → frame → pontic frames → wing outline (classical.wing-outline)
// → common axis → bridge → adapt (the wing skipped) → connectors and union (wing checks) → Accept → Finalize.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${resolve(process.env.E2E_OUT ?? `${ROOT}out/e2e/ai-maryland`)}/`;
mkdirSync(OUT, { recursive: true });
const DATA = `${ROOT}data/golden/synthetic-maryland-11-12/`;
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const golden = JSON.parse(readFileSync(`${DATA}case.json`, 'utf8'));
const wingSpec = golden.bridge.units.find((u) => u.restoration === 'maryland-wing');
const log = (...a) => console.log('[ai-maryland]', ...a);
const failures = [];
const expect = (ok, what, detail = '') => {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what);
};
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error' && !/status of 50\d|Failed to load resource/.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (file) => page.screenshot({ path: `${OUT}${file}.png` });
const state = (fn, arg) => page.evaluate(fn, arg);
const waitFor = (fn, arg, timeout = 300000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });
const step = (label) => page.getByRole('navigation', { name: 'Design steps' }).getByRole('button', { name: label }).first().click();
const settle = async () => {
  let last = '';
  for (let i = 0; i < 200; i++) {
    const now = await state(() => window.__dcad.viewer.controls.camera.position.toArray().map((x) => x.toFixed(3)).join());
    if (now === last) return;
    last = now;
    await page.waitForTimeout(250);
  }
};
const miss = (p) =>
  state((q) => {
    const s = window.__dcad.viewer.project(q);
    const hit = s && window.__dcad.viewer.raycast(s.x, s.y, { objectIds: ['upper'] });
    return hit ? Math.hypot(hit.point.x - q[0], hit.point.y - q[1], hit.point.z - q[2]) : Infinity;
  }, p);
const lookPalatal = async (p) => {
  await state((q) => window.__dcad.viewer.focus(q, [0, -0.55, -0.83], 30), p);
  await settle();
};
const clickWorld = async (p) => {
  const s = await state((q) => window.__dcad.viewer.project(q), p);
  await page.mouse.click(s.x, s.y);
};

await page.goto(APP_URL);
await page.getByRole('button', { name: /continue offline/i }).click();
await step('Case setup');
await page.getByRole('button', { name: 'Tooth 11', exact: true }).click();
await page.getByRole('button', { name: 'Tooth 12', exact: true }).click();
await page.getByRole('group', { name: 'Restoration for 12' }).getByRole('button', { name: 'Pontic' }).click();
await page.getByRole('group', { name: 'Restoration for 11' }).getByRole('button', { name: 'Wing' }).click();
await page.getByRole('button', { name: 'Tooth 36', exact: true }).click();
await step('Scans');
await page.locator('input[type=file][accept=".stl,.ply"]').setInputFiles([`${DATA}${golden.scans.upper}`, `${DATA}${golden.scans.lower}`]);
await waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2);

await page.getByLabel('Tooth', { exact: true }).selectOption('11');
await step('Tooth frame');
await page.getByLabel(/One-click bridge/).check();
await page.evaluate(() => document.activeElement?.blur());
await settle();
for (let i = 0; i < 3 && (await miss(wingSpec.seed)) >= 0.3; i++) await lookPalatal(wingSpec.seed);
expect((await miss(wingSpec.seed)) < 0.3, 'the click lands on the palatal surface', `${(await miss(wingSpec.seed)).toFixed(3)} mm`);
const pastBefore = await state(() => window.__dcad.design.getState().past.length);
const t0 = Date.now();
await clickWorld(wingSpec.seed);
await waitFor(() => {
  const o = window.__dcad.orchestrator.getState();
  return !o.running && (o.pendingReview || o.error) && o.steps.length > 0;
});
const run = await state(() => {
  const o = window.__dcad.orchestrator.getState();
  return {
    error: o.error,
    complete: o.complete,
    rows: o.steps.map((s) => `${s.key}:${s.status}`),
    failed: o.steps.flatMap((s) => s.qa.filter((c) => !c.passed).map((c) => `${s.key} ${c.id}: ${c.message} (${c.value}/${c.threshold})`)),
    rationale: o.steps.map((s) => `${s.key}: ${s.rationale ?? ''} [${Math.round(s.ms ?? 0)} ms]`),
    qa: o.steps.map((s) => [s.key, s.qa.map((c) => `${c.id}=${c.passed ? 'ok' : 'FAIL'}${c.value !== undefined ? `(${c.value})` : ''}`).join(' ')]),
  };
});
log(`run in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const r of run.rationale) log('  ', r);
for (const [k, q] of run.qa) log('   qa', k, q);
expect(run.rows.includes('classical.wing-outline@1:11:passed') && !run.rows.some((r) => r.startsWith('classical.margin-ridge')), 'the wing gets the outline proposer, not the margin', JSON.stringify(run.rows));
expect(!run.error && run.complete, 'Maryland bridge auto-design: every gate passes', JSON.stringify({ error: run.error, failed: run.failed }));
await page.waitForTimeout(500);
await settle();
await lookPalatal(wingSpec.seed);
await shot('01-draft');
await page.getByRole('button', { name: 'Accept', exact: true }).first().click();
const after = await state(() => {
  const s = window.__dcad.design.getState();
  const t11 = s.doc.teeth.find((t) => t.fdi === 11);
  return { past: s.past.length, author: s.lastAuthor, outline: t11.margin?.source, anchors: t11.margin?.anchors.length, crowns: s.doc.teeth.filter((t) => t.crown).length, adapt11: t11.crown?.adapt ?? null };
});
expect(after.past === pastBefore + 1 && after.author === 'proposer', 'Accept is one undo entry by "proposer"', JSON.stringify(after));
expect(after.outline === 'auto' && after.anchors >= 12 && after.crowns === 2 && !after.adapt11, 'the wing outline is stored (at least 12 anchors), both units proposed, the wing not adapted', JSON.stringify(after));
await step('Wing outline');
await settle();
await lookPalatal(wingSpec.seed);
await shot('02-wing-outline');
await step('Finalize');
await waitFor(() => {
  const c = window.__dcad.bridge.getState().check;
  return c.current && !c.running && !document.querySelector('.readiness .detail')?.textContent?.includes('Measuring');
});
await page.waitForTimeout(1500);
const head = await page.locator('#readiness-head').innerText();
const open = await state(() => [...document.querySelectorAll('.readiness li')].filter((li) => !li.className.includes('pass')).map((li) => li.innerText.replace(/\s+/g, ' ').trim()));
log('readiness:', head, JSON.stringify(open));
await page.locator('#readiness-head').evaluate((el) => {
  const panel = el.closest('aside');
  panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
});
await shot('03-finalize');
expect(/Ready to mill/.test(head), 'Finalize: ready to mill', `${head} ${JSON.stringify(open)}`);
await browser.close();
if (errors.length) for (const e of errors.slice(0, 10)) log('console:', e);
expect(errors.length === 0, 'no console or page errors');
log(failures.length ? `FAILED: ${failures.length}: ${failures.join('; ')}` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
