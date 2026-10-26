// Framework (reduced) auto-design (offline, headless Chrome): CoCr bridge 35–[36]–37 on data/synthetic/lower-bridge.stl,
// one-click on both preps → … → adapt → cutback (classical.cutback: CoCr facial 1.2 mm) → connectors; and a single
// reduced zirconia crown 36 (lower.stl): … → adapt → cutback (full 1.0 mm). The cutback gate fails on a veneer
// shortfall over 0.1 mm (the synthetic preps' walls are thinner than the framework minimum, as the runner reports).
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${resolve(process.env.E2E_OUT ?? `${ROOT}out/e2e/ai-framework`)}/`;
mkdirSync(OUT, { recursive: true });
const DATA = `${ROOT}data/synthetic/`;
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const log = (...a) => console.log('[ai-framework]', ...a);
const failures = [];
const expect = (ok, what, detail = '') => {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what);
};
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];

async function open(name) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 50\d|Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${name}: ${String(e)}`));
  await page.goto(APP_URL);
  await page.getByRole('button', { name: /continue offline/i }).click();
  const h = {
    page,
    state: (fn, arg) => page.evaluate(fn, arg),
    waitFor: (fn, arg, timeout = 300000) => page.waitForFunction(fn, arg, { timeout, polling: 200 }),
    step: (label) => page.getByRole('navigation', { name: 'Design steps' }).getByRole('button', { name: label }).first().click(),
    settle: async () => {
      let last = '';
      for (let i = 0; i < 200; i++) {
        const now = await page.evaluate(() => window.__dcad.viewer.controls.camera.position.toArray().map((x) => x.toFixed(3)).join());
        if (now === last) return;
        last = now;
        await page.waitForTimeout(250);
      }
    },
    clickWorld: async (p) => {
      for (let i = 0; i < 40; i++) {
        const miss = await page.evaluate((q) => {
          const v = window.__dcad.viewer;
          const s = v.project(q);
          const hit = s && v.raycast(s.x, s.y);
          return hit ? Math.hypot(hit.point.x - q[0], hit.point.y - q[1], hit.point.z - q[2]) : Infinity;
        }, p);
        if (miss < 0.3) break;
        await page.waitForTimeout(250);
      }
      const s = await page.evaluate((q) => window.__dcad.viewer.project(q), p);
      await page.mouse.click(s.x, s.y);
    },
    seed: (fdi, along) => page.evaluate(async ([f, a]) => (await import('/src/geometry/synthetic.ts')).syntheticPrepSeed({ fdi: f, along: a }), [fdi, along]),
    run: () =>
      page.evaluate(() => {
        const o = window.__dcad.orchestrator.getState();
        return {
          error: o.error,
          complete: o.complete,
          rows: o.steps.map((s) => `${s.key}:${s.status}`),
          qa: o.steps.map((s) => [s.key, s.qa.map((c) => `${c.id}=${c.passed ? 'ok' : 'FAIL'}${c.value !== undefined ? `(${c.value})` : ''}`).join(' ')]),
          rationale: o.steps.map((s) => `${s.key}: ${s.rationale ?? ''}`),
        };
      }),
    done: () =>
      page.waitForFunction(() => {
        const o = window.__dcad.orchestrator.getState();
        return !o.running && (o.pendingReview || o.error) && o.steps.length > 0;
      }, null, { timeout: 300000, polling: 200 }),
  };
  return h;
}

// ---- 1. CoCr framework bridge 35–[36]–37 ----
{
  const h = await open('bridge');
  const { page } = h;
  await h.state(() =>
    window.__dcad.design.getState().dispatch({
      type: 'setCaseSetup',
      setup: { patientRef: '', notes: '', teeth: [35, 36, 37].map((fdi) => ({ fdi, restoration: fdi === 36 ? 'reduced-pontic' : 'reduced-crown', material: 'cocr' })), connections: [[35, 36], [36, 37]] },
    }),
  );
  await h.step('Scans');
  await page.locator('input[type=file][accept=".stl,.ply"]').setInputFiles([`${DATA}lower-bridge.stl`, `${DATA}upper.stl`]);
  await h.waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2);
  await page.getByLabel('Tooth', { exact: true }).selectOption('35');
  await h.step('Tooth frame');
  await page.getByLabel(/One-click bridge/).check();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('1');
  await h.settle();
  await h.clickWorld(await h.seed(35, 1000));
  await h.waitFor(() => window.__dcad.design.getState().activeFdi === 37 && window.__dcad.tools.getState().autoArmed, null, 60000);
  await h.settle();
  await h.clickWorld(await h.seed(37, 1000));
  await h.done();
  const run = await h.run();
  for (const r of run.rationale) log('  ', r.slice(0, 300));
  for (const [k, q] of run.qa) log('   qa', k, q);
  expect(run.rows.some((r) => r.startsWith('classical.cutback@1:')), 'the reduced bridge gets the cutback row', JSON.stringify(run.rows));
  const cut = await h.state(() => window.__dcad.design.getState().doc.teeth.map((t) => [t.fdi, t.cutback ?? null]));
  log('cutbacks in the draft:', JSON.stringify(cut));
  expect(cut.every(([, c]) => c?.mode === 'facial' && c?.thicknessMm === 1.2), 'CoCr: facial 1.2 mm on every reduced unit', JSON.stringify(cut));
  await page.waitForTimeout(500);
  await h.settle();
  await page.screenshot({ path: `${OUT}01-bridge-draft.png` });
  await page.getByRole('button', { name: 'Reject', exact: true }).first().click();
  await page.close();
}

// ---- 2. Single reduced zirconia crown 36 ----
{
  const h = await open('single');
  const { page } = h;
  await h.state(() =>
    window.__dcad.design.getState().dispatch({
      type: 'setCaseSetup',
      setup: { patientRef: '', notes: '', teeth: [{ fdi: 36, restoration: 'reduced-crown', material: 'zirconia' }], connections: [] },
    }),
  );
  await h.step('Scans');
  await page.locator('input[type=file][accept=".stl,.ply"]').setInputFiles([`${DATA}lower.stl`, `${DATA}upper.stl`]);
  await h.waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2);
  await h.step('Tooth frame');
  await page.getByLabel(/One-click crown/).check();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('1');
  await h.settle();
  await h.clickWorld(await h.seed(36, 1000));
  await h.done();
  const run = await h.run();
  for (const r of run.rationale) log('  ', r.slice(0, 300));
  for (const [k, q] of run.qa) log('   qa', k, q);
  expect(JSON.stringify(run.rows.map((r) => r.split(':')[0])) === JSON.stringify(['classical.frame-seed@1', 'classical.margin-ridge@1', 'classical.axis-least-undercut@1', 'classical.template-crown@1', 'classical.adapt@1', 'classical.cutback@1']), 'single reduced crown: … → adapt → cutback', JSON.stringify(run.rows));
  const t = await h.state(() => window.__dcad.design.getState().doc.teeth.find((x) => x.fdi === 36).cutback);
  expect(t?.mode === 'full' && t?.thicknessMm === 1, 'zirconia: full 1.0 mm', JSON.stringify(t));
  const metrics = await h.state(async () => {
    const url = performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === '/src/ai/metrics.ts') ?? '/src/ai/metrics.ts';
    const { designMetrics } = await import(url);
    return (await designMetrics(undefined, 36))?.veneer;
  });
  log('agent veneer metrics:', JSON.stringify(metrics));
  expect(Boolean(metrics && metrics.mode === 'full' && metrics.thicknessMm === 1), 'agent metrics: veneer space of the reduced crown', JSON.stringify(metrics));
  await page.waitForTimeout(500);
  await h.settle();
  await page.screenshot({ path: `${OUT}02-single-draft.png` });
  await page.close();
}

await browser.close();
if (errors.length) for (const e of errors.slice(0, 10)) log('console:', e);
expect(errors.length === 0, 'no console or page errors');
log(failures.length ? `FAILED: ${failures.length}: ${failures.join('; ')}` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
