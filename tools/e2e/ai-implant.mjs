// Implant auto-design in the app (offline, headless Chrome), on data/synthetic/lower-implants-35-37.stl + upper.stl.
// 1. Bridge 35i–[36]–37i, one-click armed: click 35's scan body (frame only, 37 armed), click 37's (the run starts).
//    At the default 0.8 mm channel wall, 35's channel cannot pass: the draft stops at "Screw channel 35". Reject.
//    With 35's wall at 0.55 mm (Parameters): click 37 again → every gate passes → Accept → agent metrics → Finalize.
// 2. Single implant crown 37, one-click: click the scan body → frame → implant position → crown → screw channel →
//    adapt → Accept → Finalize.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';

/** Inlay, onlay, wing, implant and reduced sit behind "More types" in Case setup. */
const moreTypes = async (page, fdi) => {
  const more = page.getByRole('button', { name: `More types for ${fdi}` });
  if ((await more.count()) && (await more.getAttribute('aria-expanded')) !== 'true') await more.click();
};

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${resolve(process.env.E2E_OUT ?? `${ROOT}out/e2e/ai-implant`)}/`;
mkdirSync(OUT, { recursive: true });
const DATA = `${ROOT}data/synthetic/`;
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const ONLY = process.env.E2E_ONLY;
const TRUTH = Object.fromEntries(JSON.parse(readFileSync(`${DATA}lower-implants-35-37.poses.json`, 'utf8')).map((p) => [p.fdi, p]));
const log = (...a) => console.log('[ai-implant]', ...a);
const failures = [];
const expect = (ok, what, detail = '') => {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what);
};
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];

async function openApp(name) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 50\d|Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${name}: ${String(e)}`));
  const h = {
    page,
    shot: (file) => page.screenshot({ path: `${OUT}${file}.png` }),
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
    panelTo: (selector) =>
      page.locator(selector).first().evaluate((el) => {
        const panel = el.closest('aside');
        panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
      }),
    run: () =>
      page.evaluate(() => {
        const o = window.__dcad.orchestrator.getState();
        return {
          error: o.error,
          complete: o.complete,
          rows: o.steps.map((s) => `${s.key}:${s.status}`),
          failed: o.steps.flatMap((s) => s.qa.filter((c) => !c.passed).map((c) => `${s.key} ${c.id}: ${c.message} (${c.value}/${c.threshold})`)),
          rationale: o.steps.map((s) => `${s.key}: ${s.rationale ?? ''} [${Math.round(s.ms ?? 0)} ms]`),
          qa: o.steps.map((s) => [s.key, s.qa.map((c) => `${c.id}=${c.passed ? 'ok' : 'FAIL'}${c.value !== undefined ? `(${c.value})` : ''}`).join(' ')]),
        };
      }),
    done: () =>
      page.waitForFunction(() => {
        const o = window.__dcad.orchestrator.getState();
        return !o.running && (o.pendingReview || o.error);
      }, null, { timeout: 300000, polling: 200 }),
  };
  await page.goto(APP_URL);
  // The one-click flow is under test: no frames from the scan bodies found on scan load
  // (specs/2026-10-26-frames-from-case-setup.md); implant.mjs checks those.
  await page.waitForFunction(() => Boolean(window.__dcad?.tools));
  await page.evaluate(() => window.__dcad.tools.getState().set({ autoFrames: false }));
  await page.getByRole('button', { name: /continue offline/i }).click();
  return h;
}

async function loadScans(h) {
  await h.step('Scans');
  await h.page.locator('input[type=file][accept=".stl,.ply"]').setInputFiles([`${DATA}lower-implants-35-37.stl`, `${DATA}upper.stl`]);
  await h.waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2);
}

async function finalize(h, file) {
  await h.step('Finalize');
  await h.waitFor(() => {
    const c = window.__dcad.bridge?.getState().check;
    return (!c || !c.running) && !document.querySelector('.readiness .detail')?.textContent?.includes('Measuring');
  });
  await h.page.waitForTimeout(2500);
  const head = await h.page.locator('#readiness-head').innerText();
  const open = await h.state(() =>
    [...document.querySelectorAll('.readiness li')].filter((li) => !li.className.includes('pass')).map((li) => li.innerText.replace(/\s+/g, ' ').trim()),
  );
  await h.panelTo('#readiness-head');
  await h.shot(file);
  return { head, open };
}

// ---- 1. Bridge 35i–[36]–37i ---------------------------------------------------------------------------------------
if (ONLY !== 'single') {
  const h = await openApp('bridge');
  const { page } = h;
  await h.step('Case setup');
  await page.getByRole('button', { name: 'Tooth 35', exact: true }).click();
  await page.getByRole('button', { name: 'Tooth 37', exact: true }).click();
  for (const fdi of [35, 37]) {
    await moreTypes(page, fdi);
    await page.getByRole('group', { name: `Restoration for ${fdi}` }).getByRole('button', { name: 'Implant' }).click();
  }
  await page.getByRole('group', { name: 'Restoration for 36' }).getByRole('button', { name: 'Pontic' }).click();
  await loadScans(h);

  // One-click: arm, click 35 (frame only), click 37 (runs).
  await page.getByLabel('Tooth', { exact: true }).selectOption('35');
  await h.step('Tooth frame');
  await page.getByLabel(/One-click bridge/).check();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('1');
  await h.settle();
  await h.clickWorld(TRUTH[35].topCentre);
  await h.waitFor(() => window.__dcad.design.getState().activeFdi === 37 && window.__dcad.tools.getState().autoArmed, null, 60000);
  await h.settle();
  await h.clickWorld(TRUTH[37].topCentre);
  await h.done();
  const fail = await h.run();
  log('default-wall run:', JSON.stringify(fail, null, 1));
  expect(
    fail.rows.includes('classical.scan-body-match@1:35:passed') && fail.rows.includes('classical.scan-body-match@1:37:passed') && !fail.rows.some((r) => r.startsWith('classical.margin-ridge')),
    'implant bridge: each abutment gets the scan-body match, no margin',
  );
  expect(
    fail.rows.includes('classical.screw-channel@1:35:failed') && fail.failed.some((f) => f.includes('implant.channel.exit')),
    'at the default 0.8 mm wall the draft stops at Screw channel 35 (no angle passes)',
    fail.failed.join(' | '),
  );
  await page.waitForTimeout(500);
  await h.settle();
  await h.shot('01-bridge-stops-at-channel');
  await page.getByRole('button', { name: 'Reject', exact: true }).first().click();
  expect(!(await h.state(() => window.__dcad.design.getState().transaction)), 'Reject discards the draft');

  // 35's channel wall to 0.55 mm (as the implant E2E does), then click 37 again (one-click armed).
  await page.getByLabel('Tooth', { exact: true }).selectOption('35');
  await h.step('Parameters');
  const wall = page.locator('#param-channelWallMm');
  await wall.fill('0.55');
  await wall.blur();
  await h.waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 35).params.channelWallMm === 0.55);
  await page.getByLabel('Tooth', { exact: true }).selectOption('37');
  await h.step('Tooth frame');
  if (!(await page.getByLabel(/One-click bridge/).isChecked())) await page.getByLabel(/One-click bridge/).check();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('1');
  await h.settle();
  const pastBefore = await h.state(() => window.__dcad.design.getState().past.length);
  const t0 = Date.now();
  await h.clickWorld(TRUTH[37].topCentre);
  await h.done();
  const run = await h.run();
  log(`run in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const r of run.rationale) log('  ', r);
  for (const [k, q] of run.qa) log('   qa', k, q);
  expect(!run.error && run.complete, 'implant bridge auto-design: every gate passes', JSON.stringify({ error: run.error, failed: run.failed }));
  await page.waitForTimeout(500);
  await h.settle();
  await h.panelTo('.auto-design');
  await h.shot('02-bridge-draft');
  await page.getByRole('button', { name: 'Accept', exact: true }).first().click();
  const after = await h.state(() => {
    const s = window.__dcad.design.getState();
    return {
      past: s.past.length,
      author: s.lastAuthor,
      units: s.doc.teeth.map((t) => ({ fdi: t.fdi, implant: t.implant?.libraryId, engaging: t.implant?.engaging, channel: t.screwChannel, crown: Boolean(t.crown), steps: t.steps })),
      axes: s.doc.teeth.map((t) => t.axis?.direction),
    };
  });
  log('after accept:', JSON.stringify(after));
  expect(after.past === pastBefore + 1 && after.author === 'proposer', 'Accept is one undo entry by "proposer"', `${pastBefore} → ${after.past}`);
  expect(after.units.filter((u) => u.implant).length === 2 && after.units.every((u) => u.crown) && after.units.find((u) => u.fdi === 35).channel, 'both implants matched (non-engaging), every unit proposed, 35 has its channel', JSON.stringify(after.units.map((u) => [u.fdi, u.implant, u.engaging, u.channel])));
  const metrics = await h.state(async () => {
    const url = performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === '/src/ai/metrics.ts') ?? '/src/ai/metrics.ts';
    const { designMetrics } = await import(url);
    const m = await designMetrics(undefined, 35);
    return { implant: m.implant, union: m.bridge?.union, failed: m.bridge?.failedChecks, units: m.bridge?.units.map((u) => [u.fdi, u.implant]) };
  });
  log('agent metrics 35:', JSON.stringify(metrics));
  expect(metrics.implant?.channelExitOk && metrics.union?.genus === 2 && metrics.union?.expectedGenus === 2 && metrics.failed?.length === 0, 'agent metrics: channel exit, a through-hole per channel, no failing bridge check');
  const fin = await finalize(h, '03-bridge-finalize');
  log('readiness:', fin.head, JSON.stringify(fin.open));
  expect(/Ready to mill/.test(fin.head), 'Finalize: ready to mill', fin.head);
  await page.close();
}

// ---- 2. Single implant crown 37 -----------------------------------------------------------------------------------
if (ONLY !== 'bridge') {
  const h = await openApp('single');
  const { page } = h;
  await h.step('Case setup');
  await page.getByRole('button', { name: 'Tooth 37', exact: true }).click();
  await page.getByRole('button', { name: 'Tooth 36', exact: true }).click();
  await moreTypes(page, 37);
  await page.getByRole('group', { name: 'Restoration for 37' }).getByRole('button', { name: 'Implant' }).click();
  await loadScans(h);
  await h.step('Tooth frame');
  await page.getByLabel(/One-click crown/).check();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('1');
  await h.settle();
  const t0 = Date.now();
  await h.clickWorld(TRUTH[37].topCentre);
  await h.done();
  const run = await h.run();
  log(`single run in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const r of run.rationale) log('  ', r);
  for (const [k, q] of run.qa) log('   qa', k, q);
  expect(!run.error && run.complete, 'single implant crown auto-design: every gate passes', JSON.stringify({ error: run.error, failed: run.failed }));
  expect(
    JSON.stringify(run.rows) ===
      JSON.stringify(['classical.frame-seed@1:passed', 'classical.scan-body-match@1:passed', 'classical.template-crown@1:passed', 'classical.screw-channel@1:passed', 'classical.adapt@1:passed']),
    'single implant: frame → implant position → crown → screw channel → adapt (no margin, no least-undercut axis)',
    JSON.stringify(run.rows),
  );
  await page.waitForTimeout(500);
  await h.settle();
  await h.panelTo('.auto-design');
  await h.shot('04-single-draft');
  await page.getByRole('button', { name: 'Accept', exact: true }).first().click();
  const t = await h.state(() => window.__dcad.design.getState().doc.teeth.find((x) => x.fdi === 37));
  expect(t.implant?.engaging && t.axis && t.screwChannel && t.crown, '37: engaging Ti-base, the implant axis, the channel and the crown stored', JSON.stringify({ lib: t.implant?.libraryId, channel: t.screwChannel }));
  const fin = await finalize(h, '05-single-finalize');
  log('readiness:', fin.head, JSON.stringify(fin.open));
  expect(/Ready to mill/.test(fin.head), 'Finalize: ready to mill', fin.head);
  await page.close();
}

await browser.close();
if (errors.length) for (const e of errors.slice(0, 10)) log('console:', e);
expect(errors.length === 0, 'no console or page errors');
log(failures.length ? `FAILED: ${failures.length}: ${failures.join('; ')}` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
