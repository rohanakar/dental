// A first-time visitor's journey (offline, headless Chrome): the sign-in screen → Try the demo case → Tooth frame
// looking down onto the lower jaw with the prep of 36 ringed → a click on 35 is refused → a click in the ring gives a
// draft reviewed in one line (checks folded, Accept the only primary) → Accept, said in the status line inside the
// window → Finalize → export → the ending, and the rail showing Parameters and Finalize done → the help sheet (?)
// → Start your own case → Case setup with the dentist's-view chart in the wider panel.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${resolve(process.env.E2E_OUT ?? `${ROOT}out/e2e/first-run`)}/`;
mkdirSync(OUT, { recursive: true });
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const log = (...a) => console.log('[first-run]', ...a);
const failures = [];
const expect = (ok, what, detail = '') => {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what);
};
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
page.on('console', (m) => {
  if (m.type() === 'error' && !/status of 50\d|Failed to load resource/.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => void d.accept());
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
const project = (p) => state((q) => window.__dcad.viewer.project(q), p);
const inWindow = (box) => Boolean(box && box.y >= 0 && box.y + box.height <= 900 && box.x >= 0 && box.x + box.width <= 1400);
const primaries = () => page.locator('.panel .btn.primary').evaluateAll((els) => els.filter((e) => e.checkVisibility()).map((e) => e.textContent.trim()));

// ---- Sign-in screen → the demo ------------------------------------------------------------------------------------
await page.goto(APP_URL);
await page.getByRole('button', { name: 'Try the demo case' }).click();
await waitFor(() => window.__dcad?.design.getState().activeStep === 'frame' && Boolean(window.__dcad.viewer));
await settle();
const seed = await state(async () => (await import('/src/geometry/synthetic.ts')).syntheticPrepSeed({ along: 1000 }));
const wrong = await state(async () => (await import('/src/geometry/synthetic.ts')).syntheticPrepSeed({ fdi: 35, along: 1000 }));
const arrival = await state(() => {
  const v = window.__dcad.viewer;
  const dir = v.viewDirection().toArray();
  const up = v.getViewFrame().up;
  return { ring: v.overlays.has('demo:prep'), down: -(dir[0] * up[0] + dir[1] * up[1] + dir[2] * up[2]) };
});
const ringAt = await project(seed);
const canvas = await page.locator('.canvas-host').boundingBox();
expect(arrival.ring, 'the demo marks the prep of 36 with a ring');
expect(arrival.down > 0.9, 'Tooth frame opens looking down onto the lower jaw', `cos ${arrival.down.toFixed(2)}`);
expect(
  Boolean(ringAt && canvas && ringAt.x > canvas.x && ringAt.x < canvas.x + canvas.width && ringAt.y > canvas.y && ringAt.y < canvas.y + canvas.height),
  'the ringed prep is inside the viewport',
  JSON.stringify(ringAt),
);
await shot('01-demo-arrival');

// ---- A click on the wrong tooth is refused --------------------------------------------------------------------------
const at35 = await project(wrong);
await page.mouse.click(at35.x, at35.y);
await page.waitForTimeout(400);
const refused = await state(() => ({
  message: window.__dcad.tools.getState().message,
  running: window.__dcad.orchestrator.getState().running,
  ran: window.__dcad.orchestrator.getState().steps.length,
  frame: Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame),
}));
expect(refused.message?.kind === 'warning' && !refused.running && refused.ran === 0 && !refused.frame, 'a click on 35 is refused and nothing runs', JSON.stringify(refused));
expect(inWindow(await page.locator('.status-message').boundingBox()), 'the refusal is in the status line, inside the window');
await shot('02-wrong-tooth');

// ---- The prep: one click, one draft, one line to review ---------------------------------------------------------
await page.mouse.click(ringAt.x, ringAt.y);
await waitFor(() => {
  const o = window.__dcad.orchestrator.getState();
  return !o.running && (o.pendingReview || o.error);
});
const run = await state(() => {
  const o = window.__dcad.orchestrator.getState();
  return { complete: o.complete, error: o.error, failed: o.steps.flatMap((s) => s.qa.filter((c) => !c.passed).map((c) => `${s.key} ${c.message}`)) };
});
expect(run.complete && !run.error, 'the click in the ring gives a complete draft', JSON.stringify(run));
const banner = page.getByRole('region', { name: 'Auto-design' }).locator('.auto-banner');
const verdict = await banner.locator('strong').textContent();
const folded = await banner.locator('details.auto-details').evaluate((d) => !d.open);
const visibleChecks = await banner.locator('.auto-checks li').evaluateAll((els) => els.filter((e) => e.checkVisibility()).length);
expect(/^Draft ready: all \d+ checks passed$/.test(verdict ?? ''), 'the review is one verdict line', verdict ?? '');
expect(folded && visibleChecks === 0, 'the checks are folded away', `${visibleChecks} visible`);
const draftPrimaries = await primaries();
expect(draftPrimaries.length === 1 && draftPrimaries[0] === 'Accept', 'Accept is the only primary action while the draft is open', JSON.stringify(draftPrimaries));
await shot('03-draft');
await banner.locator('summary').click();
expect((await banner.locator('.auto-checks li').count()) > 5, 'Show the checks opens the check list');
await banner.locator('summary').click();

await banner.getByRole('button', { name: 'Accept', exact: true }).click();
const accepted = page.locator('.status-message');
expect(/Draft accepted/.test((await accepted.textContent()) ?? '') && inWindow(await accepted.boundingBox()), 'Accept is confirmed in the status line, inside the window');
await shot('04-accepted');

// ---- Finalize → export → the ending ---------------------------------------------------------------------------------
await step('Finalize');
await page.locator('.readiness').waitFor();
await waitFor(() => !window.__dcad.tools.getState().crown?.computing);
const exportButton = page.getByRole('button', { name: /^Export STL/ });
await exportButton.waitFor();
await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /^Export STL/.test(b.textContent ?? '') && !b.disabled));
const [download] = await Promise.all([
  page.waitForEvent('download'),
  (async () => {
    await exportButton.click();
    const anyway = page.getByRole('button', { name: 'Export STL anyway' });
    if (await anyway.isVisible().catch(() => false)) await anyway.click();
  })(),
]);
await download.saveAs(`${OUT}${download.suggestedFilename()}`);
const end = page.getByRole('region', { name: 'What next' });
await end.waitFor();
const rail = await page
  .getByRole('navigation', { name: 'Design steps' })
  .locator('button.step')
  .evaluateAll((els) => Object.fromEntries(els.map((e) => [e.querySelector('.step-label')?.textContent?.trim(), [...e.classList].find((c) => ['done', 'pending', 'stale', 'draft'].includes(c))])));
expect(await end.getByRole('button', { name: 'Create an account' }).isVisible(), 'after the export the demo ends with what to do next');
expect(rail.Parameters === 'done' && rail.Finalize === 'done', 'the rail shows Parameters and Finalize done', JSON.stringify(rail));
await shot('05-exported');

// ---- Help --------------------------------------------------------------------------------------------------------
await page.locator('.canvas-host').click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.keyboard.press('?');
const help = page.getByRole('dialog', { name: 'Help' });
expect(await help.isVisible(), '? opens the help sheet');
expect((await help.locator('dt').allTextContents()).includes('Insertion axis'), 'the help sheet explains the terms');
await shot('06-help');
await page.keyboard.press('Escape');
expect(!(await help.isVisible().catch(() => false)), 'Esc closes the help sheet');

// ---- Your own case: Case setup with the dentist's-view chart ---------------------------------------------------------
await end.getByRole('button', { name: 'Start your own case' }).click();
await waitFor(() => window.__dcad.design.getState().activeStep === 'setup' && window.__dcad.scene.getState().objects.length === 0);
const box = async (fdi) => page.getByRole('button', { name: `Tooth ${fdi}`, exact: true }).boundingBox();
const [t18, t12, t11, t21, t48, t28] = await Promise.all([18, 12, 11, 21, 48, 28].map(box));
const panel = await page.locator('.panel').boundingBox();
expect(t18.x < t11.x && t11.x < t21.x && t21.x < t28.x && Math.abs(t18.y - t11.y) < 1 && t48.y > t18.y && Math.abs(t48.x - t18.x) < 1, "the chart is the dentist's view: 18…11 | 21…28 over 48…", JSON.stringify({ t18, t11, t21, t48 }));
expect(t11.width >= 22 && t11.x - t12.x >= 24 && t28.x + t28.width <= panel.x + panel.width, 'chart teeth keep 24 px targets inside the wider panel', `${t11.width} px, pitch ${t11.x - t12.x}`);
await shot('07-own-case-setup');

expect(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
await browser.close();
if (failures.length) {
  log(`${failures.length} FAILED:`, failures.join('; '));
  process.exit(1);
}
log('all passed');
