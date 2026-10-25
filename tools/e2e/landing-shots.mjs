// The demo journey, end to end, and the product images the landing page shows.
//
//   APP_URL=http://localhost:5173/app/ node landing-shots.mjs
//
// Opens /app/?demo (offline, synthetic scans of tooth 36), checks it lands on Tooth frame with one-click crown armed,
// clicks the prep once, accepts the auto-design draft, then captures the renders into out/landing/. The landing page
// ships them as WebP (apps/web/src/landing/assets/, converted with cwebp); every image is the real app on the
// synthetic case, nothing is retouched.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../../out/landing/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const log = (...a) => console.log('[landing]', ...a);

// Headless Chrome with software WebGL (SwiftShader); slow for 1.3M triangles, hence settle().
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const state = (fn, arg) => page.evaluate(fn, arg);
const waitFor = (fn, arg, timeout = 180000) => page.waitForFunction(fn, arg, { timeout, polling: 250 });
const settle = async () => {
  let last = '';
  for (let i = 0; i < 200; i++) {
    const now = await page.evaluate(() => window.__dcad.viewer.controls.camera.position.toArray().map((x) => x.toFixed(3)).join());
    if (now === last) return;
    last = now;
    await page.waitForTimeout(300);
  }
};
const fail = (msg) => { console.error('[landing] FAIL', msg); process.exitCode = 1; };

// 1. The demo link lands on Tooth frame with one-click crown armed.
await page.goto(`${APP_URL}?demo`);
await waitFor(() => window.__dcad?.design.getState().activeStep === 'frame');
const entry = await state(() => ({ url: location.search, armed: window.__dcad.tools.getState().autoArmed, scans: window.__dcad.design.getState().doc.scans.length }));
log('demo entry', JSON.stringify(entry));
if (entry.url !== '' || !entry.armed || entry.scans !== 2) fail('demo did not land on an armed Tooth frame step');
await page.screenshot({ path: `${OUT}journey-demo-frame.png` });

// 2. One click on the prep proposes the whole crown for review.
await page.keyboard.press('1');
await settle();
const seed = await state(async () => (await import('/src/geometry/synthetic.ts')).syntheticPrepSeed({ along: 1000 }));
const at = await state((p) => window.__dcad.viewer.project(p), seed);
await page.mouse.click(at.x, at.y);
await waitFor(() => { const o = window.__dcad.orchestrator.getState(); return !o.running && (o.complete || o.error); });
const orch = await state(() => { const o = window.__dcad.orchestrator.getState(); return { complete: o.complete, error: o.error, steps: o.steps.map((s) => `${s.step}:${s.status}`) }; });
log('one-click', JSON.stringify(orch));
if (!orch.complete) fail('auto-design did not complete');
// The gate values behind these images, so the landing page quotes this run and nothing else.
const gates = await state(() => window.__dcad.orchestrator.getState().steps.flatMap((s) => s.qa.map((q) => ({ step: s.step, id: q.id, passed: q.passed, value: q.value, threshold: q.threshold, message: q.message }))));
const stepRuns = await state(() => window.__dcad.orchestrator.getState().steps.map((s) => ({ step: s.step, status: s.status, ms: Math.round(s.ms ?? 0) })));
// The draft review as the editor shows it before Accept, and the hero render from that same moment: the editor
// opens a ready draft with the occlusion map on, which is what the banner says.
await page.locator('.auto-banner').first().screenshot({ path: `${OUT}draft-banner.png` });
// The review lists every step's checks with their values (the landing page shows the first steps of it).
await page.locator('section.auto-design').first().screenshot({ path: `${OUT}auto-design.png` });
// Product shots: the antagonist out of the way, surroundings solid, no viewport hint text.
await page.addStyleTag({ content: '.hint { visibility: hidden; }' });
await state(() => { window.__dcad.scene.getState().patchObject('upper', { visible: false }); window.__dcad.viewer.setObjectVisible('upper', false); });
await page.getByLabel('Focus on the prep').uncheck();
const view = async ({ up, buccal, mesial, dist, lift = 1.5 }) => {
  await state(({ up, buccal, mesial, dist, lift }) => {
    const f = window.__dcad.design.getState().doc.teeth[0].frame;
    const dir = [0, 1, 2].map((k) => f.occlusal[k] * up + f.buccal[k] * buccal + f.mesial[k] * mesial);
    const n = Math.hypot(...dir);
    const target = f.origin.map((o, k) => o + f.occlusal[k] * lift);
    const eye = target.map((t, k) => t + (dir[k] / n) * dist);
    const c = window.__dcad.viewer.controls;
    void c.setFocalOffset(0, 0, 0, false);
    void c.setLookAt(...eye, ...target, false);
  }, { up, buccal, mesial, dist, lift });
  await settle();
  await page.waitForTimeout(800);
};
const viewport = page.locator('main.viewport');
// The hero is near square, with the crown in its upper half (the checks panel overlaps the lower edge). The draft
// stays open; it is viewed from the Adapt step, which has no move gizmo on the crown.
await state(() => window.__dcad.design.getState().setActiveStep('adapt'));
await state(() => window.__dcad.crownTool.setMap('occlusion'));
await page.setViewportSize({ width: 1440, height: 1150 });
await view({ up: 1.1, buccal: 0.8, mesial: 0.45, dist: 42, lift: -3 });
log('hero map', await state(() => window.__dcad.tools.getState().crownMap));
await viewport.screenshot({ path: `${OUT}hero-crown.png` });
await page.setViewportSize({ width: 1440, height: 900 });
await state(() => window.__dcad.design.getState().setActiveStep('proposal'));
await page.getByRole('region', { name: 'Auto-design' }).getByRole('button', { name: 'Accept' }).first().click();
log('step after accept', await state(() => window.__dcad.design.getState().activeStep));

// 3. The adapted crown, seen from a clinical three-quarter view (buccal, mesial, above).
await state(() => window.__dcad.design.getState().setActiveStep('adapt'));
await waitFor(() => { const c = window.__dcad.tools.getState().crown; return c && !c.computing && c.validation; });
await state(() => window.__dcad.crownTool.setMap('thickness'));
await view({ up: 0.45, buccal: 1, mesial: 0.2, dist: 28 });
await page.waitForTimeout(1500);
await viewport.screenshot({ path: `${OUT}map-thickness.png` });
await state(() => window.__dcad.crownTool.setMap('occlusion'));
await view({ up: 1, buccal: 0.2, mesial: 0.05, dist: 28 });
await page.waitForTimeout(1500);
await viewport.screenshot({ path: `${OUT}map-occlusion.png` });

// 4. The editor at Finalize: the wizard, the ready-to-mill checks, and the crown. The toolbar is cropped off: it
// carries the working name, and the landing page shows a placeholder until the name is chosen.
await state(() => window.__dcad.crownTool.setMap('none'));
await state(() => window.__dcad.design.getState().setActiveStep('finalize'));
await view({ up: 0.9, buccal: 0.75, mesial: 0.35, dist: 30, lift: -0.5 });
const toolbar = await state(() => document.querySelector('.toolbar').getBoundingClientRect().height);
await page.screenshot({ path: `${OUT}editor-finalize.png`, clip: { x: 0, y: toolbar, width: 1440, height: 900 - toolbar } });
// Phones get the side panel alone, at 1:1, instead of the whole editor scaled down.
await page.locator('aside.panel').screenshot({ path: `${OUT}editor-panel.png` });

const crown = await state(() => { const v = window.__dcad.tools.getState().crown.validation; return v && { ok: v.ok, printable: v.printable, selfIntersections: v.selfIntersections, triangles: v.triangles, volumeMm3: v.volumeMm3 }; });
writeFileSync(`${OUT}metrics.json`, JSON.stringify({ steps: stepRuns, gates, crown }, null, 2));
log('gates', gates.map((g) => `${g.id}=${g.value ?? (g.passed ? 'pass' : 'fail')}`).join(' '));
log('page errors', errors.length ? errors : 'none');
await browser.close();
