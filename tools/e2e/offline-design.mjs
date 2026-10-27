import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../../out/e2e/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const log = (...a) => console.log('[e2e]', ...a);

// Headless Chrome with software WebGL (SwiftShader); slow for 1.3M triangles, hence settle().
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (name) => page.screenshot({ path: `${OUT}${name}.png` });
const state = (expr) => page.evaluate(expr);
const waitFor = (expr, timeout = 60000) => page.waitForFunction(expr, null, { timeout, polling: 200 });
// Wait until the rendered camera stops moving (software rendering in headless Chrome is slow).
const settle = async () => {
  let last = '';
  for (let i = 0; i < 200; i++) {
    const now = await page.evaluate(() => window.__dcad.viewer.controls.camera.position.toArray().map((x) => x.toFixed(3)).join());
    if (now === last) return;
    last = now;
    await page.waitForTimeout(250);
  }
};
const project = (p) => page.evaluate((p) => window.__dcad.viewer.project(p), p);
const clickWorld = async (p) => { const s = await project(p); await page.mouse.click(s.x, s.y); return s; };
const step = (label) => page.getByRole('button', { name: label, exact: false }).first().click();

await page.goto(APP_URL);
// The click flow is under test: no frames or margins found for the user (specs/2026-10-26-bridge-out-of-the-box.md).
await page.waitForFunction(() => Boolean(window.__dcad?.tools));
await page.evaluate(() => window.__dcad.tools.getState().set({ autoFrames: false }));
await page.getByRole('button', { name: /continue offline/i }).click();
await page.getByRole('button', { name: /load demo scans/i }).first().click();
const t0 = Date.now();
await waitFor(() => window.__dcad.design.getState().doc.scans.length === 2);
log('demo loaded in', Date.now() - t0, 'ms');
await page.waitForTimeout(500);
await shot('01-demo');

// Frame
await step('Tooth frame');
await page.keyboard.press('1'); // occlusal view
await settle();
const seed = await state(async () => (await import('/src/geometry/synthetic.ts')).syntheticPrepSeed({ along: 1000 }));
await clickWorld(seed);
await waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth[0].frame));
const frame = await state(() => window.__dcad.design.getState().doc.teeth[0].frame);
log('frame', JSON.stringify(frame));
await shot('02-frame');

// Margin
await step('Margin');
await waitFor(() => window.__dcad.tools.getState().surface === 'ready');
const ring = await state(async () => Array.from((await import('/src/geometry/synthetic.ts')).syntheticPrepMargin({ along: 1000, samples: 8 })));
const pts = [];
for (let i = 0; i < ring.length; i += 3) pts.push([ring[i], ring[i + 1], ring[i + 2]]);
// Zoom in on the prep for precise clicks.
await settle(); // the margin step zooms onto the prep (animated)
await shot('025-margin-entry');
for (let i = 0; i < pts.length; i++) {
  await clickWorld(pts[i]);
  await page.waitForTimeout(250);
  if (i === 2) {
    // Hover between anchor 3 and 4: the live-wire preview should follow the margin.
    const a = await project(pts[3]);
    await page.mouse.move(a.x, a.y);
    await page.waitForTimeout(300);
    await shot('03-livewire-preview');
  }
}
log('anchors placed', await state(() => window.__dcad.tools.getState().marginAnchors.length), 'message', JSON.stringify(await state(() => window.__dcad.tools.getState().message)));
await clickWorld(pts[0]);
await waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth[0].margin));
const margin = await state(() => { const m = window.__dcad.design.getState().doc.teeth[0].margin; return { anchors: m.anchors.length, points: m.points.length, source: m.source }; });
log('margin', JSON.stringify(margin), 'message', JSON.stringify(await state(() => window.__dcad.tools.getState().message)));
// Deviation of the traced margin from the analytic ring.
const dev = await state(async () => {
  const { syntheticPrepMargin } = await import('/src/geometry/synthetic.ts');
  const ref = syntheticPrepMargin({ along: 1000, samples: 720 });
  const m = window.__dcad.design.getState().doc.teeth[0].margin.points;
  let sum = 0, max = 0;
  for (const { p } of m) {
    let best = Infinity;
    for (let i = 0; i < ref.length; i += 3) best = Math.min(best, Math.hypot(p[0] - ref[i], p[1] - ref[i + 1], p[2] - ref[i + 2]));
    sum += best; max = Math.max(max, best);
  }
  return { mean: sum / m.length, max };
});
log('margin deviation mm', JSON.stringify(dev));
await shot('04-margin');
// Drag anchor 2 by ~0.8 mm toward the prep centre (slightly off the ridge) and check the margin is re-traced.
{
  const m0 = await state(() => window.__dcad.design.getState().doc.teeth[0].margin);
  const a = m0.anchors[2].p;
  const from = await project(a);
  const to = await project([a[0] + (seed[0] - a[0]) * 0.15, a[1] + (seed[1] - a[1]) * 0.15, a[2]]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(from.x + ((to.x - from.x) * k) / 8, from.y + ((to.y - from.y) * k) / 8);
  await page.mouse.up();
  await page.waitForFunction((x) => window.__dcad.design.getState().doc.teeth[0].margin?.anchors[2].p[0] !== x, a[0], { timeout: 30000, polling: 100 }).catch(() => log('drag: no change within 30 s'));
  const m1 = await state(() => window.__dcad.design.getState().doc.teeth[0].margin);
  log('drag: anchor moved', JSON.stringify(a), '->', JSON.stringify(m1.anchors[2].p), 'points', m0.points.length, '->', m1.points.length);
  await page.keyboard.press('Control+z');
  const m2 = await state(() => window.__dcad.design.getState().doc.teeth[0].margin.anchors[2].p);
  log('drag undone', JSON.stringify(m2) === JSON.stringify(a));
}

// Axis
await step('Insertion axis');
await waitFor(() => Boolean(window.__dcad.tools.getState().axisReport));
log('axis', JSON.stringify(await state(() => window.__dcad.design.getState().doc.teeth[0].axis)), JSON.stringify(await state(() => window.__dcad.tools.getState().axisReport)));
await settle();
await shot('05-axis');
// Tilt 10° buccal → expect a bigger undercut, then undo/redo.
for (let i = 0; i < 30; i++) await page.getByRole('button', { name: 'Tilt the axis 1° buccal' }).click();
await page.waitForTimeout(1500);
await waitFor(() => !window.__dcad.tools.getState().busy);
await settle();
log('tilted', JSON.stringify(await state(() => window.__dcad.tools.getState().axisReport)));
await shot('06-axis-tilted');
await page.keyboard.press('Control+z');
await page.waitForTimeout(800);
const afterUndo = await state(() => ({ past: window.__dcad.design.getState().past.length, future: window.__dcad.design.getState().future.length, src: window.__dcad.design.getState().doc.teeth[0].axis?.source }));
log('after undo', JSON.stringify(afterUndo));
await page.keyboard.press('Control+Shift+z'); // redo the tilt back (keeps the 30° axis) — then reset to least undercut
await page.getByRole('button', { name: 'Least undercut' }).click();
await waitFor(() => window.__dcad.design.getState().doc.teeth[0].axis?.source === 'auto' && !window.__dcad.tools.getState().busy);

// Day 3: crown proposal → parameter edit → export.
await step('Crown proposal');
await page.getByRole('button', { name: /propose crown/i }).click();
await waitFor(() => { const c = window.__dcad.tools.getState().crown; return c && !c.computing && c.validation; });
const crown1 = await state(() => { const c = window.__dcad.tools.getState().crown; return { ok: c.validation.ok, triangles: c.triangles, minAxial: c.minAxialThicknessMm, gap: c.gapCheck, ms: Math.round(c.ms), warnings: c.warnings }; });
log('crown', JSON.stringify(crown1));
await settle();
await shot('07-crown');
await page.getByRole('slider', { name: 'Crown opacity' }).fill('0.5');
await page.waitForTimeout(300);
await shot('07b-crown-translucent');
// Day 4: colour maps, keyboard nudge + undo, nudge pad, gizmo drag.
await page.getByLabel('Colour map').selectOption('thickness');
await waitFor(() => { const t = window.__dcad.tools.getState(); return t.legend?.title === 'Material thickness' && !t.crown.computing; });
await settle();
await shot('07c-thickness-map');
await page.getByLabel('Colour map').selectOption('occlusion');
await waitFor(() => { const t = window.__dcad.tools.getState(); return t.legend?.title === 'Occlusal clearance' && !t.crown.computing; });
await shot('07d-occlusion-map');
const pose0 = await state(() => window.__dcad.design.getState().doc.teeth[0].crown.pose);
await page.locator('.canvas-host').click({ position: { x: 5, y: 5 } }).catch(() => {}); // focus away from inputs
await page.keyboard.press('Shift+ArrowLeft'); // 0.5 mm mesial
await waitFor(() => !window.__dcad.tools.getState().crown.computing);
const pose1 = await state(() => window.__dcad.design.getState().doc.teeth[0].crown.pose);
const frameM = await state(() => window.__dcad.design.getState().doc.teeth[0].frame.mesial);
const moved = [0, 1, 2].reduce((acc, k) => acc + (pose1.position[k] - pose0.position[k]) * frameM[k], 0);
log('keyboard nudge along mesial mm', moved.toFixed(4));
await page.keyboard.press('Control+z');
const poseUndo = await state(() => window.__dcad.design.getState().doc.teeth[0].crown.pose);
log('nudge undone', JSON.stringify(poseUndo) === JSON.stringify(pose0));
await page.getByRole('button', { name: 'Rotate crown 2 degrees about the occlusal axis' }).click();
await waitFor(() => !window.__dcad.tools.getState().crown.computing);
log('after rotate valid', await state(() => window.__dcad.tools.getState().crown.validation.ok));
// Gizmo drag: find the screen position of the crown centre and drag the occlusal handle region.
const pastBefore = await state(() => window.__dcad.design.getState().past.length);
await settle();
const handle = await state(() => {
  const v = window.__dcad.viewer;
  const p = v.gizmo.proxy.position;
  const o = window.__dcad.design.getState().doc.teeth[0].frame.occlusal;
  const a = v.project([p.x, p.y, p.z]);
  const b = v.project([p.x + o[0], p.y + o[1], p.z + o[2]]);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return { a, dir: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } };
});
await shot('07e-gizmo');
let dragged = false;
for (const off of [40, 55, 70, 85, 100, 30, 115]) {
  const sx = handle.a.x + handle.dir.x * off, sy = handle.a.y + handle.dir.y * off;
  await page.mouse.move(sx, sy);
  await page.waitForTimeout(150);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(sx + handle.dir.x * 6 * k, sy + handle.dir.y * 6 * k);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const added = (await state(() => window.__dcad.design.getState().past.length)) - pastBefore;
  if (added > 0) { dragged = true; log('gizmo handle hit at offset', off, '→ undo entries added:', added); break; }
}
const lastBatch = await state(() => { const s = window.__dcad.design.getState(); const prev = s.past.at(-1).teeth[0].crown.pose.position; const cur = s.doc.teeth[0].crown.pose.position; const o = s.doc.teeth[0].frame.occlusal; return [0,1,2].reduce((a,k)=>a+(cur[k]-prev[k])*o[k],0); });
log('gizmo drag committed', dragged, 'moved along occlusal mm', lastBatch.toFixed(3), '');
await waitFor(() => !window.__dcad.tools.getState().crown.computing);
await shot('07f-after-gizmo');
log('steps after Day 4 edits', JSON.stringify(await state(() => window.__dcad.design.getState().doc.teeth[0].steps)), 'pastBefore', pastBefore);
await page.getByLabel('Colour map').selectOption('none');
// Day 5: adaptation (occlusion + contacts), conflict-free, undoable.
await step('Adapt');
await waitFor(() => { const c = window.__dcad.tools.getState().crown; return c && !c.computing; });
await page.getByRole('button', { name: 'Adapt occlusion' }).click();
await waitFor(() => { const c = window.__dcad.tools.getState().crown; return c && !c.computing && c.adapt?.occlusion; });
await page.getByRole('button', { name: 'Adapt mesial contact' }).click();
await waitFor(() => { const c = window.__dcad.tools.getState().crown; return c && !c.computing && c.adapt?.mesial; });
const adapted = await state(() => { const c = window.__dcad.tools.getState().crown; return { occl: c.adapt.occlusion, mesial: c.adapt.mesial, printable: c.validation.printable, self: c.validation.selfIntersections, steps: window.__dcad.design.getState().doc.teeth[0].steps.adapt }; });
log('adapted', JSON.stringify(adapted));
await settle();
await shot('075-adapted');
// Project file round trip: download, open in a fresh page, same crown.
const volBefore = await state(() => window.__dcad.tools.getState().crown.validation.signedVolumeMm3);
const [zip] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download project' }).click()]);
const zipPath = `${OUT}${zip.suggestedFilename()}`;
await zip.saveAs(zipPath);
const page2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page2.goto(APP_URL);
await page2.getByRole('button', { name: /continue offline/i }).click();
await page2.locator('input[type=file][accept*="zip"]').setInputFiles(zipPath);
await page2.waitForFunction(() => window.__dcad.design.getState().doc.teeth[0]?.crown && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2, null, { timeout: 120000 });
await page2.getByRole('button', { name: 'Adapt' }).first().click();
await page2.waitForFunction(() => { const c = window.__dcad.tools.getState().crown; return c && !c.computing && c.validation; }, null, { timeout: 120000 });
const volAfter = await page2.evaluate(() => window.__dcad.tools.getState().crown.validation.signedVolumeMm3);
log('project zip', zip.suggestedFilename(), 'crown volume', volBefore.toFixed(3), '→', volAfter.toFixed(3));
await page2.close();
await step('Parameters');
const gapInput = page.getByLabel('Cement gap');
await gapInput.fill('0.08');
await gapInput.press('Enter');
await waitFor(() => { const c = window.__dcad.tools.getState().crown; return c && !c.computing && window.__dcad.design.getState().doc.teeth[0].params.cementGapMm === 0.08; });
await page.waitForTimeout(500);
await waitFor(() => !window.__dcad.tools.getState().crown.computing);
log('after cement gap 0.08', JSON.stringify(await state(() => { const c = window.__dcad.tools.getState().crown; return { ok: c.validation.ok, gap: c.gapCheck, steps: window.__dcad.design.getState().doc.teeth[0].steps }; })));
await step('Finalize');
// Finalize asks once more when a check is open ("Export STL anyway…"); this run has a stale adaptation on purpose.
const exportStl = async () => {
  await page.getByRole('button', { name: /^Export STL/ }).click();
  const anyway = page.getByRole('button', { name: 'Export STL anyway', exact: true });
  if (await anyway.waitFor({ timeout: 2000 }).then(() => true, () => false)) await anyway.click();
};
const [stl] = await Promise.all([page.waitForEvent('download'), exportStl()]);
await stl.saveAs(`${OUT}${stl.suggestedFilename()}`);
const [json] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Construction info' }).click()]);
await json.saveAs(`${OUT}${json.suggestedFilename()}`);
log('downloads', stl.suggestedFilename(), json.suggestedFilename());
await shot('08-finalize');
log('steps', JSON.stringify(await state(() => window.__dcad.design.getState().doc.teeth[0].steps)));
log('console errors', errors.length ? errors : 'none');
await browser.close();
