// A first-time visitor's journey (offline, headless Chrome): the sign-in screen → Try the demo case → Tooth frame
// looking down onto the lower jaw with 36 already framed on its prep → a click on 35 is refused → Auto-design crown
// gives a draft reviewed in one line (checks folded, Accept the only primary) → Accept, said in the status line inside the
// window → Finalize → export → the ending, and the rail showing Parameters and Finalize done → the help sheet (?)
// → the theme: light by default, dark as a remembered opt-in, sign-in always light → Start your own case → Case setup
// with the dentist's-view chart in the wider panel.
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
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
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
await page.getByRole('button', { name: 'Try the demo case' }).waitFor();
const signInLook = await state(() => ({ theme: document.documentElement.dataset.theme ?? null, font: getComputedStyle(document.body).fontFamily, ground: getComputedStyle(document.querySelector('.session-screen')).backgroundColor }));
expect(!signInLook.theme && /Hanken Grotesk/.test(signInLook.font) && signInLook.ground === 'rgb(255, 255, 255)', 'the sign-in screen is in the light landing world (white, Hanken Grotesk)', JSON.stringify(signInLook));
await page.getByRole('button', { name: 'Try the demo case' }).click();
// Case setup named 36: Tooth frame opens with its frame already set from the prep found, for review.
await waitFor(() => window.__dcad?.design.getState().activeStep === 'frame' && Boolean(window.__dcad.viewer) && Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));
await settle();
const seed = await state(async () => (await import('/src/geometry/synthetic.ts')).syntheticPrepSeed({ along: 1000 }));
const wrong = await state(async () => (await import('/src/geometry/synthetic.ts')).syntheticPrepSeed({ fdi: 35, along: 1000 }));
const frameOf36 = () => state(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).frame.origin);
const arrival = await state((s) => {
  const v = window.__dcad.viewer;
  const dir = v.viewDirection().toArray();
  const up = v.getViewFrame().up;
  const origin = window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).frame.origin;
  return { ring: v.overlays.has('demo:prep'), down: -(dir[0] * up[0] + dir[1] * up[1] + dir[2] * up[2]), offPrep: Math.hypot(...origin.map((o, k) => o - s[k])) };
}, seed);
const prepAt = await project(seed);
const canvas = await page.locator('.canvas-host').boundingBox();
expect(arrival.offPrep < 1 && !arrival.ring, 'the demo opens with 36 framed on its prep, nothing to click', JSON.stringify(arrival));
expect(arrival.down > 0.9, 'Tooth frame opens looking down onto the lower jaw', `cos ${arrival.down.toFixed(2)}`);
expect(
  Boolean(prepAt && canvas && prepAt.x > canvas.x && prepAt.x < canvas.x + canvas.width && prepAt.y > canvas.y && prepAt.y < canvas.y + canvas.height),
  'the framed prep is inside the viewport',
  JSON.stringify(prepAt),
);
await shot('01-demo-arrival');

// ---- A click on the wrong tooth is refused --------------------------------------------------------------------------
const framed = await frameOf36();
const at35 = await project(wrong);
await page.mouse.click(at35.x, at35.y);
await page.waitForTimeout(400);
const refused = await state(() => ({
  message: window.__dcad.tools.getState().message,
  running: window.__dcad.orchestrator.getState().running,
  ran: window.__dcad.orchestrator.getState().steps.length,
}));
const unchanged = JSON.stringify(await frameOf36()) === JSON.stringify(framed);
expect(refused.message?.kind === 'warning' && !refused.running && refused.ran === 0 && unchanged, 'a click on 35 is refused: nothing runs and the frame stays', JSON.stringify(refused));
expect(inWindow(await page.locator('.status-message').boundingBox()), 'the refusal is in the status line, inside the window');
await shot('02-wrong-tooth');

// ---- The frame reviewed: one button, one draft, one line to review -------------------------------------------------
await page.getByRole('region', { name: 'Auto-design' }).getByRole('button', { name: 'Auto-design crown' }).click();
await waitFor(() => {
  const o = window.__dcad.orchestrator.getState();
  return !o.running && (o.pendingReview || o.error);
});
const run = await state(() => {
  const o = window.__dcad.orchestrator.getState();
  return { complete: o.complete, error: o.error, failed: o.steps.flatMap((s) => s.qa.filter((c) => !c.passed).map((c) => `${s.key} ${c.message}`)) };
});
expect(run.complete && !run.error, 'Auto-design crown on the reviewed frame gives a complete draft', JSON.stringify(run));
const banner = page.getByRole('region', { name: 'Auto-design' }).locator('.auto-banner');
const verdict = await banner.locator('strong').textContent();
const folded = await banner.locator('details.auto-details').evaluate((d) => !d.open);
const visibleChecks = await banner.locator('.auto-checks li').evaluateAll((els) => els.filter((e) => e.checkVisibility()).length);
expect(/^Draft ready: all \d+ checks passed$/.test(verdict ?? ''), 'the review is one verdict line', verdict ?? '');
expect(folded && visibleChecks === 0, 'the step checks are folded away', `${visibleChecks} visible`);
// The review leads with Finalize's clinical rows, measured on the draft (specs/2026-10-26-draft-review-clinical.md).
await page.waitForFunction(() => [...document.querySelectorAll('.readiness.compact li')].every((li) => !/Measuring/.test(li.textContent ?? '')), null, { timeout: 60000 }).catch(() => {});
const clinical = await banner.locator('.readiness.compact li').evaluateAll((els) => els.map((e) => e.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
expect(clinical.length >= 5 && clinical.some((t) => /Thick enough/.test(t) && /mm/.test(t)), 'the review shows the clinical rows with their values', JSON.stringify(clinical));
const draftPrimaries = await primaries();
expect(draftPrimaries.length === 1 && draftPrimaries[0] === 'Accept', 'Accept is the only primary action while the draft is open', JSON.stringify(draftPrimaries));
await shot('03-draft');
await banner.locator('summary').click();
expect((await banner.locator('.auto-checks li').count()) > 5, 'Show the step checks opens the check list');
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

// ---- Theme: light by default, dark as an opt-in, the session screens always light -------------------------------------
const toggle = page.getByRole('button', { name: 'Dark theme' });
const themeOf = () => state(() => ({ theme: document.documentElement.dataset.theme ?? null, saved: localStorage.getItem('dcad.theme'), bg: window.__dcad.viewer.scene.background.getHexString() }));
const light = await themeOf();
expect((await toggle.getAttribute('aria-pressed')) === 'false' && !light.theme && light.bg === 'e9ecf0', 'the editor opens light, on the ground of the landing renders', JSON.stringify(light));
await toggle.click();
await page.waitForTimeout(300);
const dark = await themeOf();
expect(dark.theme === 'dark' && dark.saved === 'dark' && dark.bg === '20242a', 'the toggle switches the editor and its scene to dark, and remembers it', JSON.stringify(dark));
await shot('06b-dark');
const other = await context.newPage();
await other.goto(APP_URL);
await other.getByRole('button', { name: 'Try the demo case' }).waitFor();
expect(!(await other.evaluate(() => document.documentElement.dataset.theme ?? null)), 'with dark saved, the sign-in screen stays light');
await other.close();
await toggle.click();
await page.waitForTimeout(300);
expect((await themeOf()).theme === null, 'the toggle switches back to light');

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
