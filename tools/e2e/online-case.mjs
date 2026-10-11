import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../../out/e2e/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/';
const log = (...a) => console.log('[online]', ...a);
// Headless Chrome with software WebGL (SwiftShader); slow for 1.3M triangles, hence settle().
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (name) => page.screenshot({ path: `${OUT}${name}.png` });
const state = (fn, arg) => page.evaluate(fn, arg);
const waitFor = (fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });
const settle = async () => {
  let last = '';
  for (let i = 0; i < 200; i++) {
    const now = await page.evaluate(() => window.__dcad.viewer.controls.camera.position.toArray().map((x) => x.toFixed(3)).join());
    if (now === last) return;
    last = now;
    await page.waitForTimeout(250);
  }
};
const clickWorld = async (p) => { const s = await page.evaluate((p) => window.__dcad.viewer.project(p), p); await page.mouse.click(s.x, s.y); };
const step = (label) => page.getByRole('button', { name: label }).first().click();

await page.goto(APP_URL);
// Sign up.
await page.getByRole('button', { name: 'Create an account' }).click();
await page.getByLabel('Name').fill('E2E Tech');
await page.getByLabel('Email').fill(`e2e-${Date.now()}@example.com`);
await page.getByLabel('Password').fill('correct-horse-battery');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByText("Your lab's cases").waitFor();
log('signed up');
// New case (default 36 zirconia).
await page.getByLabel(/Case reference/).fill('E2E-0001');
await page.getByRole('button', { name: 'New case' }).click();
await page.getByRole('button', { name: 'Save' }).waitFor();
log('case opened; doc caseId', await state(() => window.__dcad.design.getState().doc.caseId));
// Demo scans → uploaded.
await page.getByRole('button', { name: /load demo scans/i }).first().click();
await waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.design.getState().doc.scans.every((s) => s.mesh.fileId));
log('scans uploaded', JSON.stringify(await state(() => window.__dcad.design.getState().doc.scans.map((s) => [s.role, s.mesh.fileId?.slice(0, 8), s.mesh.triangleCount]))));
// Frame + margin.
await step('Tooth frame');
await page.keyboard.press('1');
await settle();
const seed = await state(async () => (await import('/src/geometry/synthetic.ts')).syntheticPrepSeed({ along: 1000 }));
await clickWorld(seed);
await waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth[0].frame));
await step('Margin');
await waitFor(() => window.__dcad.tools.getState().surface === 'ready');
await settle();
const ring = await state(async () => Array.from((await import('/src/geometry/synthetic.ts')).syntheticPrepMargin({ along: 1000, samples: 8 })));
for (let i = 0; i < ring.length; i += 3) { await clickWorld([ring[i], ring[i + 1], ring[i + 2]]); await page.waitForTimeout(200); }
await clickWorld([ring[0], ring[1], ring[2]]);
await waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth[0].margin));
await step('Insertion axis');
await waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth[0].axis));
await step('Crown proposal');
await page.getByRole('button', { name: /propose crown/i }).click();
await waitFor(() => { const c = window.__dcad.tools.getState().crown; return c && !c.computing && c.validation?.ok; });
const crownBefore = await state(() => window.__dcad.tools.getState().crown.validation.signedVolumeMm3);
// Save with Ctrl+S.
await page.keyboard.press('Control+s');
await page.getByText(/Saved v1/).waitFor({ timeout: 30000 }).catch(() => {});
log('save state', await page.locator('.save-state').innerText().catch(() => '?'), 'version', await state(() => window.__dcad.design.getState().version));
await shot('10-online-saved');
const before = await state(() => { const t = window.__dcad.design.getState().doc.teeth[0]; return { margin: t.margin.points.length, axis: t.axis.direction, crown: t.crown, steps: t.steps }; });
// Reload: session persists, reopen the case from the list.
await page.reload();
await page.getByText("Your lab's cases").waitFor();
await page.getByRole('cell', { name: 'E2E-0001' }).click();
await waitFor(() => window.__dcad.design.getState().version === 1 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2);
const after = await state(() => { const t = window.__dcad.design.getState().doc.teeth[0]; return { margin: t.margin?.points.length, axis: t.axis?.direction, crown: t.crown, steps: t.steps }; });
log('reopened equal:', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after.steps));
await step('Crown proposal');
await waitFor(() => { const c = window.__dcad.tools.getState().crown; return c && !c.computing && c.validation; });
const crownAfter = await state(() => window.__dcad.tools.getState().crown.validation.signedVolumeMm3);
log('crown recomputed from the saved pose: volume', crownBefore.toFixed(3), '→', crownAfter.toFixed(3));
await step('Margin');
await settle();
await shot('11-online-reopened');
// Second tab saving a stale version → conflict.
const page2 = await context.newPage();
await page2.goto(APP_URL);
await page2.getByRole('cell', { name: 'E2E-0001' }).click();
await page2.waitForFunction(() => window.__dcad.design.getState().version === 1, null, { timeout: 60000 });
await page2.evaluate(() => window.__dcad.design.getState().dispatch({ type: 'setCaseSetup', setup: { ...window.__dcad.design.getState().doc.setup, notes: 'tab 2' } }));
await page2.keyboard.press('Control+s');
await page2.waitForFunction(() => window.__dcad.design.getState().version === 2, null, { timeout: 30000 });
await page.evaluate(() => window.__dcad.design.getState().dispatch({ type: 'setCaseSetup', setup: { ...window.__dcad.design.getState().doc.setup, notes: 'tab 1' } }));
await page.keyboard.press('Control+s');
await page.waitForTimeout(2000);
log('conflict state', await page.locator('.save-state').innerText().catch(() => '?'), '|', await page.getByRole('button', { name: 'Save' }).getAttribute('title'));
log('console errors', errors.length ? errors : 'none');
await browser.close();
