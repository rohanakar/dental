// Bridge auto-design in the app (offline, headless Chrome). Posterior 35–[36]–37 on data/synthetic/lower-bridge.stl +
// upper.stl:
// 1. Setup, click both preps; the Frame and Proposal steps offer "Auto-design bridge" (not the crown one).
// 2. A 40 mm² connector: the draft stops at the connector gate on the Adapt step, which offers Accept / Reject in the
//    footer; Reject restores the document.
// 3. Auto-design bridge passes every gate → Accept (one undo entry by "proposer", events per unit and step) → the
//    agent's metrics (connectors measured on the union, no contacts on connected sides) → Finalize "Ready to mill".
// 4. One-click bridge: arm, click 35 (frame only, 37 armed next), click 37 (the run starts) → Reject.
// Run: pnpm --filter @dcad/web fixtures && pnpm dev:web, then pnpm --filter @dcad/e2e ai-bridge.
// APP_URL (default http://localhost:5173/app/) is the editor; E2E_OUT the screenshot folder (default out/e2e/ai-bridge/).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = resolve(process.env.E2E_OUT ?? `${ROOT}out/e2e/ai-bridge`);
mkdirSync(OUT, { recursive: true });
const DATA = `${ROOT}data/synthetic/`;
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const ALONG = 1000;
const log = (...a) => console.log('[ai-bridge]', ...a);
const failures = [];
const expect = (ok, what, detail = '') => {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
let page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error' && !/status of 50\d|Failed to load resource/.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
const state = (fn, arg) => page.evaluate(fn, arg);
const waitFor = (fn, arg, timeout = 240000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });
const step = (label) => page.getByRole('navigation', { name: 'Design steps' }).getByRole('button', { name: label }).first().click();
const shot = (file) => page.screenshot({ path: `${OUT}/${file}.png` });
const settle = async () => {
  let last = '';
  for (let i = 0; i < 200; i++) {
    const now = await page.evaluate(() => window.__dcad.viewer.controls.camera.position.toArray().map((x) => x.toFixed(3)).join());
    if (now === last) return;
    last = now;
    await page.waitForTimeout(250);
  }
};
const clickWorld = async (p) => {
  const s = await page.evaluate((q) => window.__dcad.viewer.project(q), p);
  await page.mouse.click(s.x, s.y);
};
const synthetic = (fn, arg) => page.evaluate(async ([f, a]) => (await import('/src/geometry/synthetic.ts'))[f](a), [fn, arg]);
/** Import an app module in the page by the URL the app loaded it with (HMR adds ?t=…; another URL is another instance). */
const appModule = (path) =>
  `performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === '${path}') ?? '${path}'`;
const panelTo = (selector) =>
  page.locator(selector).first().evaluate((el) => {
    const panel = el.closest('aside');
    panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
  });

await page.goto(APP_URL);
await page.getByRole('button', { name: /continue offline/i }).click();

// Setup: 35 and 37 crowns, 36 pontic.
await step('Case setup');
await page.getByRole('button', { name: 'Tooth 35', exact: true }).click();
await page.getByRole('button', { name: 'Tooth 37', exact: true }).click();
await page.getByRole('group', { name: 'Restoration for 36' }).getByRole('button', { name: 'Pontic' }).click();
const bridges = await state(() => window.__dcad.design.getState().doc.bridges.map((b) => b.teeth));
expect(JSON.stringify(bridges) === '[[35,36,37]]', 'setup 35–[36]–37', JSON.stringify(bridges));

// Scans.
await step('Scans');
await page.locator('input[type=file][accept=".stl,.ply"]').setInputFiles(['lower-bridge.stl', 'upper.stl'].map((f) => DATA + f));
await waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2, null, 300000);

// Click both preps (Frame step).
await step('Tooth frame');
for (const fdi of [35, 37]) {
  await page.getByLabel('Tooth', { exact: true }).selectOption(String(fdi));
  await page.keyboard.press('1');
  await settle();
  await clickWorld(await synthetic('syntheticPrepSeed', { fdi, along: ALONG }));
  await waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.frame), fdi, 60000);
}
const frameButtons = await page.getByRole('button', { name: /^Auto-design (bridge|crown)$/ }).allInnerTexts();
expect(frameButtons.length === 1 && frameButtons[0] === 'Auto-design bridge', 'Frame step offers "Auto-design bridge" only', JSON.stringify(frameButtons));
await panelTo('.auto-design');
await shot('01-frame-step');

// Proposal step: the bridge's auto-design button replaces the crown one.
await step('Crown proposal');
await page.waitForTimeout(300);
const proposalButtons = await page.getByRole('button', { name: /^Auto-design (bridge|crown)$/ }).allInnerTexts();
expect(proposalButtons.length === 1 && proposalButtons[0] === 'Auto-design bridge', 'Proposal step offers "Auto-design bridge" only', JSON.stringify(proposalButtons));
await shot('02-proposal-step');

// A failing gate first: a 40 mm² connector is too wide for 35–36. The draft stops at the connector gate and opens
// the Adapt step, which has no auto-design panel: the footer offers Accept / Reject. Reject restores the document.
await state(() => window.__dcad.design.getState().dispatch({ type: 'setConnector', between: [35, 36], areaMm2: 40 }));
const docBeforeFail = await state(() => JSON.stringify(window.__dcad.design.getState().doc));
await page.getByRole('button', { name: 'Auto-design bridge' }).click();
await waitFor(() => {
  const o = window.__dcad.orchestrator.getState();
  return !o.running && (o.pendingReview || o.error);
}, null, 300000);
const failRun = await state(() => {
  const o = window.__dcad.orchestrator.getState();
  return {
    rows: o.steps.map((s) => `${s.key}:${s.status}`),
    failed: o.steps.flatMap((s) => s.qa.filter((c) => !c.passed).map((c) => c.id)),
    step: window.__dcad.design.getState().activeStep,
  };
});
log('failing run:', JSON.stringify(failRun));
expect(failRun.rows.at(-1) === 'classical.connectors@1:failed' && failRun.failed.includes('bridge.connector.35-36.too-wide') && failRun.step === 'adapt', 'an oversize connector stops the draft at the connector gate, on the Adapt step');
await page.waitForTimeout(500);
await settle();
expect(await page.locator('.draft-review').isVisible(), 'the Adapt step offers Accept / Reject for the draft');
await shot('03a-failed-gate-adapt');
await page.locator('.draft-review').getByRole('button', { name: 'Reject', exact: true }).click();
expect((await state(() => JSON.stringify(window.__dcad.design.getState().doc))) === docBeforeFail && !(await state(() => window.__dcad.design.getState().transaction)), 'Reject restores the document');
await state(() => window.__dcad.design.getState().dispatch({ type: 'setConnector', between: [35, 36], areaMm2: 9 }));
await step('Crown proposal');
await page.waitForTimeout(300);

// Run it.
const pastBefore = await state(() => window.__dcad.design.getState().past.length);
const t0 = Date.now();
await page.getByRole('button', { name: 'Auto-design bridge' }).click();
await waitFor(() => {
  const o = window.__dcad.orchestrator.getState();
  return !o.running && (o.pendingReview || o.error);
}, null, 300000);
const run = await state(() => {
  const o = window.__dcad.orchestrator.getState();
  return {
    error: o.error,
    complete: o.complete,
    bridge: o.bridge,
    steps: o.steps.map((s) => ({ key: s.key, status: s.status, ms: Math.round(s.ms ?? 0), failed: s.qa.filter((c) => !c.passed).map((c) => `${c.id}: ${c.message} (${c.value} / ${c.threshold})`), checks: s.qa.length })),
    rationale: o.steps.map((s) => s.rationale).filter(Boolean),
  };
});
log('run in', ((Date.now() - t0) / 1000).toFixed(1), 's');
for (const s of run.steps) log(' ', s.key, s.status, `${s.ms} ms`, `${s.checks} checks`, s.failed.length ? JSON.stringify(s.failed) : '');
for (const r of run.rationale) log('  rationale:', r);
expect(!run.error && run.complete, 'bridge auto-design: every step passed its gate', run.error ?? '');
const connectorQa = await state(() => window.__dcad.orchestrator.getState().steps.find((s) => s.proposerId === 'classical.connectors@1')?.qa.map((c) => [c.id, c.passed, c.value, c.threshold]));
log('connector gate:', JSON.stringify(connectorQa));
await page.waitForTimeout(500);
await settle();
await panelTo('.auto-design');
await shot('03-draft-review');

// Accept: one undo entry, author proposer, events per unit and step.
await page.getByRole('button', { name: 'Accept', exact: true }).click();
const after = await state(async (url) => {
  const s = window.__dcad.design.getState();
  const { useEventLog } = await import(eval(url));
  return {
    past: s.past.length,
    transaction: s.transaction,
    author: s.lastAuthor,
    units: s.doc.teeth.map((t) => ({ fdi: t.fdi, frame: Boolean(t.frame), margin: Boolean(t.margin), axis: t.axis?.direction, crown: Boolean(t.crown), adapt: t.steps.adapt, adaptTargets: t.crown?.adapt })),
    events: useEventLog.getState().queued.map((e) => `${e.fdi}:${e.step}:${e.proposerId}:${e.action}${e.proposal.value && e.proposal.value.connectors ? '+connectors' : ''}`),
  };
}, appModule("/src/ai/events.ts"));
expect(after.past === pastBefore + 1 && !after.transaction && after.author === 'proposer', 'Accept is one undo entry by "proposer"', `${pastBefore} → ${after.past}`);
expect(JSON.stringify(after.units.find((u) => u.fdi === 35).axis) === JSON.stringify(after.units.find((u) => u.fdi === 37).axis), 'one common axis on 35 and 37');
expect(after.units.every((u) => u.crown && u.adapt === 'done'), 'every unit has a crown and its adaptation', JSON.stringify(after.units.map((u) => [u.fdi, u.adapt, u.adaptTargets])));
log('events:', after.events.join(' '));
expect(!after.events.some((e) => /^36:(margin|axis):/.test(e)) && after.events.filter((e) => e.includes(':accepted') && e.endsWith('+connectors')).length === 1, 'events per unit and step; no pontic margin/axis event; connectors once');

// Agent metrics on the accepted bridge (what get_design_metrics returns).
const metrics = await state(async (url) => {
  const { designMetrics } = await import(eval(url));
  const m36 = await designMetrics(undefined, 36);
  const m35 = await designMetrics(undefined, 35);
  return { m36: { ...m36, bridge: undefined }, m35: { ...m35, bridge: undefined }, connectors: m36.bridge?.connectors, union: m36.bridge?.union, units: m36.bridge?.units.map((u) => [u.fdi, u.kind, u.mesialContactMm, u.distalContactMm, u.ponticBaseGapMm]) };
}, appModule('/src/ai/metrics.ts'));
log('metrics 36:', JSON.stringify(metrics.m36));
log('metrics 35:', JSON.stringify(metrics.m35));
log('bridge metrics:', JSON.stringify({ connectors: metrics.connectors, union: metrics.union, units: metrics.units }));
expect(
  metrics.m36.mesialContactMm === null && metrics.m36.distalContactMm === null && metrics.connectors?.length === 2 && metrics.connectors.every((c) => c.measuredAreaMm2 >= c.minAreaMm2) && metrics.union?.components === 1,
  'agent metrics: pontic has no contacts, both connectors measured on the union',
);

// Finalize.
await step('Finalize');
await waitFor(() => {
  const c = window.__dcad.bridge.getState().check;
  return c.current && !c.running && !document.querySelector('.readiness .detail')?.textContent?.includes('Measuring');
}, null, 300000);
await page.waitForTimeout(800);
const head = await page.locator('#readiness-head').innerText();
const open = await state(() =>
  [...document.querySelectorAll('.readiness li')]
    .filter((li) => !li.className.includes('pass'))
    .map((li) => li.innerText.replace(/\s+/g, ' ').trim()),
);
log('readiness:', head, JSON.stringify(open));
expect(/Ready to mill/.test(head), 'Finalize: ready to mill', head);
await panelTo('#readiness-head');
await shot('04-finalize');

// One-click bridge on a fresh page: arm, click 35 (frame only, 37 armed next), click 37 (the run starts).
{
  await page.close();
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } }); // a new context: nothing to resume
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(APP_URL);
  await page.getByRole('button', { name: /continue offline/i }).click();
  await step('Case setup');
  await page.getByRole('button', { name: 'Tooth 35', exact: true }).click();
  await page.getByRole('button', { name: 'Tooth 37', exact: true }).click();
  await page.getByRole('group', { name: 'Restoration for 36' }).getByRole('button', { name: 'Pontic' }).click();
  await step('Scans');
  await page.locator('input[type=file][accept=".stl,.ply"]').setInputFiles(['lower-bridge.stl', 'upper.stl'].map((f) => DATA + f));
  await waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2, null, 300000);
  await page.getByLabel('Tooth', { exact: true }).selectOption('35');
  await step('Tooth frame');
  await page.getByLabel(/One-click bridge/).check();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('1');
  await settle();
  await clickWorld(await synthetic('syntheticPrepSeed', { fdi: 35, along: ALONG }));
  await waitFor(() => window.__dcad.design.getState().activeFdi === 37 && window.__dcad.tools.getState().autoArmed, null, 60000);
  const mid = await state(() => ({ frame35: Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 35).frame), transaction: window.__dcad.design.getState().transaction, message: window.__dcad.tools.getState().message?.text }));
  expect(mid.frame35 && !mid.transaction, 'one-click: the first prep click sets 35 and arms 37', mid.message);
  await shot('05-one-click-armed');
  await settle();
  await clickWorld(await synthetic('syntheticPrepSeed', { fdi: 37, along: ALONG }));
  await waitFor(() => {
    const o = window.__dcad.orchestrator.getState();
    return !o.running && (o.pendingReview || o.error);
  }, null, 300000);
  const oneClick = await state(() => {
    const o = window.__dcad.orchestrator.getState();
    return { error: o.error, complete: o.complete, rows: o.steps.map((s) => `${s.key}:${s.status}`), failed: o.steps.flatMap((s) => s.qa.filter((c) => !c.passed).map((c) => `${s.key} ${c.id} ${c.message} ${c.value}/${c.threshold}`)), rationale: o.steps.map((s) => s.rationale) };
  });
  expect(!oneClick.error && oneClick.complete && oneClick.rows[0] === 'classical.frame-seed@1:37:passed', 'one-click: the last prep click runs the whole bridge', JSON.stringify(oneClick));
  await page.waitForTimeout(500);
  await settle();
  await shot('06-one-click-draft');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  const rejected = await state(() => ({ transaction: window.__dcad.design.getState().transaction, crowns: window.__dcad.design.getState().doc.teeth.filter((t) => t.crown).length }));
  expect(!rejected.transaction && rejected.crowns === 0, 'Reject discards the draft');
}

log('console errors', errors.length ? errors : 'none');
if (errors.length) failures.push('console errors');
await browser.close();
log(failures.length ? `${failures.length} FAILED: ${failures.join('; ')}` : 'all checks passed');
process.exit(failures.length ? 1 : 0);
