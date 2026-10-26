// Crown moves after a proposal (specs/2026-10-14-crown-move-after-proposal.md), offline, headless Chrome.
// App singletons (crownTool, the worker client) come from window.__dcad: a dynamic import() of their source can get a
// second module instance once Vite has hot-updated them.
// One-click crown → edits BEFORE Accept (keys, gizmo, nudge pad) → instant preview, no snap-back, adaptation off until
// Re-adapt, open contacts reported, undo works → focus view (pixel classes) and the blue crown.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../../out/e2e/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const log = (...a) => console.log('[move]', ...a);
const failures = [];
const expect = (ok, what, detail = '') => {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
// Offline: the session check (/api/me) gets a 502 from the dev proxy; anything else is an error.
page.on('console', (m) => { if (m.type() === 'error' && !/status of 502/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (name) => page.screenshot({ path: `${OUT}${name}.png` });
const state = (fn, arg) => page.evaluate(fn, arg);
const waitFor = (fn, arg, timeout = 180000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const step = (label) => page.getByRole('button', { name: label }).first().click();
const settle = async () => {
  let last = '';
  for (let i = 0; i < 200; i++) {
    const now = await page.evaluate(() => window.__dcad.viewer.controls.camera.position.toArray().map((x) => x.toFixed(3)).join());
    if (now === last) return;
    last = now;
    await page.waitForTimeout(250);
  }
};
const crownIdle = () => waitFor(() => { const c = window.__dcad.tools.getState().crown; return c && !c.computing && c.validation; });
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** Displayed crown: centroid of the cusps (move weight ≥ 0.95 in the current result), plus status. */
const cusps = () =>
  state(async () => {
    const { crownTool } = window.__dcad;
    const r = crownTool.current();
    const g = window.__dcad.viewer.objects.get('crown').mesh.geometry.getAttribute('position').array;
    const c = [0, 0, 0];
    let n = 0;
    for (let v = 0; v < r.moveWeights.length; v++) {
      if (r.moveWeights[v] < 0.95) continue;
      c[0] += g[v * 3]; c[1] += g[v * 3 + 1]; c[2] += g[v * 3 + 2];
      n++;
    }
    const d = window.__dcad.design.getState();
    return { at: c.map((x) => x / n), computing: window.__dcad.tools.getState().crown.computing, past: d.past.length, tx: d.transaction?.label ?? null };
  });
const doc = () => state(() => { const d = window.__dcad.design.getState(); const t = d.doc.teeth[0]; return { pose: t.crown?.pose, adapt: t.crown?.adapt, steps: t.steps, frame: t.frame, past: d.past.length, tx: d.transaction?.label ?? null, message: window.__dcad.tools.getState().message?.text ?? null }; });

await page.goto(APP_URL);
// The one-click flow from a click on the prep is under test: no frames from the preps on entering Tooth frame
// (specs/2026-10-26-auto-frames.md), so undo goes back to a tooth without a frame.
await page.waitForFunction(() => Boolean(window.__dcad?.tools));
await page.evaluate(() => window.__dcad.tools.getState().set({ autoFrames: false }));
await page.getByRole('button', { name: /continue offline/i }).click();
await page.getByRole('button', { name: /load demo scans/i }).first().click();
await waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.every((o) => o.phase === 'ready'));

// ---- One-click crown, left pending (no Accept) --------------------------------------------------------------
await step('Tooth frame');
await page.keyboard.press('1');
await settle();
await page.getByLabel(/One-click crown/).check();
const seed = await state(async () => (await import('/src/geometry/synthetic.ts')).syntheticPrepSeed({ along: 1000 }));
const s = await state((p) => window.__dcad.viewer.project(p), seed);
const pastStart = (await doc()).past;
await page.mouse.click(s.x, s.y);
await waitFor(() => { const o = window.__dcad.orchestrator.getState(); return !o.running && o.pendingReview; });
const orch = await state(() => window.__dcad.orchestrator.getState().complete);
expect(orch, 'auto-design completes with every gate passed (draft pending review)');
await step('Crown proposal');
await crownIdle();
await settle();
await shot('30-draft-pending');
const draft = await doc();
expect(draft.tx === 'Auto-design' && draft.steps.adapt === 'done', 'draft open, adaptation applied', JSON.stringify({ tx: draft.tx, adapt: draft.steps.adapt }));

// ---- Keyboard nudge BEFORE Accept: auto-accept, instant preview, adaptation off ------------------------------
const buccal = draft.frame.buccal;
const c0 = await cusps();
await page.locator('.canvas-host').click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.keyboard.press('Shift+ArrowUp'); // 0.5 mm buccal
const c1 = await cusps();
const afterKey = await doc();
expect(afterKey.tx === null, 'keyboard edit accepted the draft', afterKey.message ?? '');
expect(afterKey.past === pastStart + 2, 'two undo entries: draft + move', `${afterKey.past - pastStart}`);
expect(c1.computing && Math.abs(dot(sub(c1.at, c0.at), buccal) - 0.5) < 0.02, 'instant preview: cusps moved 0.5 mm buccal before the recompute', `${dot(sub(c1.at, c0.at), buccal).toFixed(4)} mm, computing=${c1.computing}`);
expect(afterKey.steps.adapt === 'stale', 'adaptation marked stale by the move');
await crownIdle();
const keyResult = await state(() => ({ adapt: window.__dcad.tools.getState().crown.adapt ?? null }));
expect(keyResult.adapt === null, 'crown recomputed without adaptation');
expect((await page.getByRole('button', { name: 'Re-adapt' }).count()) === 1, 'Re-adapt offered');
await shot('31-moved-unadapted');

// ---- Undo / redo work after the auto-accept --------------------------------------------------------------------
await page.keyboard.press('Control+z');
const u1 = await doc();
expect(JSON.stringify(u1.pose) === JSON.stringify(draft.pose) && u1.steps.adapt === 'done', 'Ctrl+Z undoes the move only (draft kept, adapted)');
await page.keyboard.press('Control+z');
const u2 = await doc();
expect(!u2.pose && !u2.frame, 'second Ctrl+Z returns to before auto-design');
// Undoing the draft goes back to where its run started (Tooth frame), says so, and leaves no crown legend; redo returns.
const where = () => state(() => ({ step: window.__dcad.design.getState().activeStep, legend: window.__dcad.tools.getState().legend?.title ?? null }));
// The legend goes once the crown view catches up with the undo (one recompute later): wait for it, briefly.
await waitFor(() => !window.__dcad.tools.getState().legend, null, 10000).catch(() => {});
const u2At = await where();
expect(u2At.step === 'frame' && !u2At.legend && /^Undone/.test(u2.message ?? ''), 'undoing the draft: back on Tooth frame, its own notice, no legend', JSON.stringify({ ...u2At, message: u2.message }));
await page.keyboard.press('Control+Shift+z');
const r1 = await doc();
expect(JSON.stringify(r1.pose) === JSON.stringify(draft.pose) && r1.steps.adapt === 'done' && (await where()).step === 'proposal', 'redo brings the draft back, on Crown proposal');
await crownIdle();
await settle();

// ---- Gizmo drag occlusal: no snap-back, gizmo stays on the crown, then Re-adapt -----------------------------------
const occlusal = r1.frame.occlusal;
const g0 = await cusps();
const handle = await state(() => {
  const v = window.__dcad.viewer;
  const p = v.gizmo.proxy.position;
  const o = window.__dcad.design.getState().doc.teeth[0].frame.occlusal;
  const a = v.project([p.x, p.y, p.z]);
  const b = v.project([p.x + o[0], p.y + o[1], p.z + o[2]]);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return { a, dir: { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, pxPerMm: len, proxy: [p.x, p.y, p.z] };
});
const gizmoToCusps0 = Math.hypot(...sub(handle.proxy, g0.at));
let samples = [];
let committed = 0;
for (const off of [40, 55, 70, 85, 100, 30, 115]) {
  const sx = handle.a.x + handle.dir.x * off, sy = handle.a.y + handle.dir.y * off;
  await page.mouse.move(sx, sy);
  await page.waitForTimeout(150);
  await page.mouse.down();
  const px = handle.pxPerMm; // about 1 mm
  for (let k = 1; k <= 6; k++) await page.mouse.move(sx + (handle.dir.x * px * k) / 6, sy + (handle.dir.y * px * k) / 6);
  const during = await cusps();
  await page.mouse.up();
  const t0 = Date.now();
  samples = [during];
  for (;;) {
    const c = await cusps();
    samples.push(c);
    if (!c.computing || Date.now() - t0 > 20000) break;
  }
  const d = await doc();
  if (d.past > r1.past) {
    committed = dot(sub(d.pose.position, r1.pose.position), occlusal);
    break;
  }
}
const along = samples.map((c) => dot(sub(c.at, g0.at), occlusal));
expect(committed > 0.3, 'gizmo drag committed an occlusal move', `${committed.toFixed(3)} mm`);
expect(Math.abs(along[0] - committed) < 0.05, 'drag preview matched the commit', `preview ${along[0].toFixed(3)} vs ${committed.toFixed(3)}`);
expect(Math.min(...along.slice(1)) > 0.8 * committed, 'no snap-back while recomputing', `min ${Math.min(...along.slice(1)).toFixed(3)} over ${along.length - 1} samples`);
await crownIdle();
const gz = await state(async () => {
  const { crownTool } = window.__dcad;
  const p = window.__dcad.viewer.gizmo.proxy.position;
  return { proxy: [p.x, p.y, p.z], anchor: crownTool.gizmoAnchor() };
});
const gizmoToCusps1 = Math.hypot(...sub(gz.proxy, gz.anchor));
expect(gizmoToCusps1 < 0.01, 'gizmo sits on the crown cusps after the move', `${gizmoToCusps1.toFixed(4)} mm (was ${gizmoToCusps0.toFixed(3)} before the drag)`);
await page.getByLabel('Colour map').selectOption('occlusion');
await waitFor(() => { const t = window.__dcad.tools.getState(); return t.legend?.title === 'Occlusal clearance' && !t.crown.computing; });
const minOcc = () => state(async () => {
  const { crownTool } = window.__dcad;
  const r = crownTool.current();
  let m = Infinity;
  for (let v = r.shellStart; v < r.maps.occlusion.length; v++) if (Number.isFinite(r.maps.occlusion[v])) m = Math.min(m, r.maps.occlusion[v]);
  return m;
});
const occMoved = await minOcc();
expect(occMoved < 0, 'occlusion map shows the penetration of the raised crown', `${occMoved.toFixed(3)} mm`);
await settle();
await shot('32-gizmo-up-unadapted');
await page.getByRole('button', { name: 'Re-adapt' }).click();
await waitFor(() => { const t = window.__dcad.tools.getState(); return !t.crown.computing && t.crown.adapt?.occlusion; });
const re = await state(() => ({ adapt: window.__dcad.tools.getState().crown.adapt, step: window.__dcad.design.getState().doc.teeth[0].steps.adapt }));
const occRe = await minOcc();
expect(re.step === 'done' && re.adapt.occlusion.minClearanceMm >= 0.03, 'Re-adapt restores the occlusal clearance', `${re.adapt.occlusion.minClearanceMm.toFixed(3)} mm, map min ${occRe.toFixed(3)}`);
await settle();
await shot('33-readapted');

// ---- Nudge pad 1 mm mesial + Re-adapt: the distal contact is reported open --------------------------------------
const beforeNudge = (await doc()).past;
const mesialBtn = page.getByRole('button', { name: 'Move crown 0.1 mm mesial' });
await mesialBtn.click({ modifiers: ['Shift'] });
await mesialBtn.click({ modifiers: ['Shift'] });
await page.getByRole('button', { name: 'Re-adapt' }).click();
await waitFor(() => { const t = window.__dcad.tools.getState(); return !t.crown.computing && t.crown.adapt?.distal; });
const open = await state(() => { const c = window.__dcad.tools.getState().crown; return { distal: c.adapt.distal, warnings: c.warnings }; });
expect(Boolean(open.distal.open) && open.warnings.some((w) => w.startsWith('Distal contact open')), 'distal contact reported open after 1 mm mesial', JSON.stringify(open.distal.open));
await shot('34-contact-open');
for (let i = (await doc()).past; i > beforeNudge; i--) await page.keyboard.press('Control+z');
await crownIdle();
await page.getByLabel('Colour map').selectOption('none');
await crownIdle();

// ---- Focus view: pixel classes with focus on vs off -----------------------------------------------------------------
await step('Crown proposal');
await settle();
const look = () => state(() => {
  const o = (id) => { const x = window.__dcad.viewer.objects.get(id); return { opacity: x.mesh.material.opacity, desat: x.mesh.material.userData.uniforms.uDesaturate.value, overlay: x.mesh.children.filter((c) => c.name.endsWith(':focus')).length, prepass: x.mesh.children.filter((c) => c.name.endsWith(':prepass')).length }; };
  return { lower: o('lower'), upper: o('upper') };
});
const on = await look();
expect(on.lower.overlay === 1 && Math.abs(on.lower.opacity - 0.4) < 1e-6 && on.lower.desat === 0.35 && Math.abs(on.upper.opacity - 0.4) < 1e-6 && on.lower.prepass === 1 && on.upper.prepass === 1, 'focus view on: prep overlay, surroundings at 0.4, greyed, front surface only (depth pre-pass)', JSON.stringify(on));
/** Classify a pixel grid by what the ray hits first (crown, prep focus face, surroundings, antagonist, background). */
const classify = (box) => state(async (box) => {
  const v = window.__dcad.viewer;
  const { analysis } = window.__dcad;
  const d = window.__dcad.design.getState().doc;
  const t = d.teeth[0];
  const jawSha = d.scans.find((x) => x.role === 'lower').mesh.sha256;
  const faces = await analysis.focusFaces({ jawSha, margin: new Float32Array(t.margin.points.flatMap((m) => m.p)), occlusal: [...t.frame.occlusal] });
  const inFocus = new Set(faces);
  const rect = v.renderer.domElement.getBoundingClientRect();
  const b = box ?? { x0: 0, y0: 0, w: rect.width, h: rect.height, nx: 70, ny: 45 };
  const out = [];
  for (let gy = 0; gy < b.ny; gy++) for (let gx = 0; gx < b.nx; gx++) {
    // Pixel centres, so the raycast and readPixels look at the same pixel.
    const x = Math.floor(b.x0 + ((gx + 0.5) * b.w) / b.nx) + 0.5, y = Math.floor(b.y0 + ((gy + 0.5) * b.h) / b.ny) + 0.5;
    const hit = v.raycast(rect.left + x, rect.top + y);
    const cls = !hit ? 'background' : hit.objectId === 'crown' ? 'crown' : hit.objectId === 'lower' ? (inFocus.has(hit.faceIndex) ? 'prep' : 'surroundings') : 'antagonist';
    out.push({ x, y, cls });
  }
  return out;
}, box);
const classes = await classify(null);
const read = (pts) => state((pts) => {
  const v = window.__dcad.viewer;
  v.renderer.render(v.scene, v.controls.camera);
  const gl = v.renderer.getContext();
  const pr = v.renderer.getPixelRatio();
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(4);
  return pts.map((p) => { gl.readPixels(Math.floor(p.x * pr), Math.floor(h - p.y * pr - 1), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [px[0], px[1], px[2]]; });
}, pts);
// A dense grid on the prep with the crown hidden, so most prep pixels are visible.
const prepBox = await state(() => {
  const v = window.__dcad.viewer;
  const r = v.renderer.domElement.getBoundingClientRect();
  const c = v.project(window.__dcad.design.getState().doc.teeth[0].frame.origin);
  return { x0: c.x - r.left - 160, y0: c.y - r.top - 160, w: 320, h: 320, nx: 40, ny: 40 };
});
const pixOn = await read(classes);
await shot('35-focus-on');
await page.getByLabel('Show crown').uncheck();
const prepClasses = await classify(prepBox);
const prepOn = await read(prepClasses);
await shot('35b-focus-on-crown-hidden');
await page.getByLabel('Focus on the prep').uncheck();
const off = await look();
expect(off.lower.overlay === 0 && off.lower.opacity === 1 && off.lower.desat === 0 && off.upper.opacity === 1 && off.lower.prepass === 0, 'focus off restores the object-panel look', JSON.stringify(off));
const prepOff = await read(prepClasses);
await page.getByLabel('Show crown').check();
const pixOff = await read(classes);
await shot('36-focus-off');
const sat = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, Math.max(r, g, b));
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
// The viewport background follows the theme (light here): "less visible" = closer to it.
const bgLum = await state(() => { const c = window.__dcad.viewer.scene.background; return 255 * (0.299 * c.r + 0.587 * c.g + 0.114 * c.b); });
const summarize = (cls, on, offPx) => {
  const stats = {};
  cls.forEach((c, i) => {
    const st = (stats[c.cls] ??= { n: 0, satOn: 0, satOff: 0, contrastOn: 0, contrastOff: 0, unchanged: 0, blue: 0 });
    st.n++;
    st.satOn += sat(on[i]); st.satOff += sat(offPx[i]);
    st.contrastOn += Math.abs(lum(on[i]) - bgLum); st.contrastOff += Math.abs(lum(offPx[i]) - bgLum);
    const diff = Math.max(...[0, 1, 2].map((k) => Math.abs(on[i][k] - offPx[i][k])));
    if (diff <= 3) st.unchanged++;
    st.blue += on[i][2] - on[i][0];
  });
  for (const st of Object.values(stats)) for (const k of ['satOn', 'satOff', 'contrastOn', 'contrastOff', 'unchanged', 'blue']) st[k] = +(st[k] / st.n).toFixed(3);
  return stats;
};
const stats = summarize(classes, pixOn, pixOff);
const prepStats = summarize(prepClasses, prepOn, prepOff);
log('pixel classes (contrast = |luminance − background|)', JSON.stringify(stats), 'background luminance', bgLum.toFixed(1));
log('prep grid, crown hidden', JSON.stringify(prepStats));
const sur = stats.surroundings, crown = stats.crown, ant = stats.antagonist, prep = prepStats.prep;
expect(sur && sur.contrastOn < 0.6 * sur.contrastOff && sur.satOn < 0.5 * sur.satOff, 'surroundings less visible (closer to the background) and greyer with focus on', JSON.stringify(sur));
expect(!ant || (ant.contrastOn < 0.6 * ant.contrastOff && ant.satOn < 0.5 * ant.satOff), 'antagonist dimmed the same way', JSON.stringify(ant));
expect(prep && prep.n > 200 && prep.unchanged >= 0.95, 'prep pixels unchanged by the focus view, crown hidden (≥ 95% within 3/255)', JSON.stringify(prep));
// MSAA blends silhouette pixels with what is behind them (the dimmed surroundings), hence "≥ 98 %".
expect(crown && crown.blue > 25 && crown.unchanged >= 0.98, 'crown pixels blue (B − R) and untouched by the focus view (≥ 98%)', JSON.stringify(crown));
await page.getByLabel('Focus on the prep').check();
expect((await look()).lower.overlay === 1, 'focus back on');

// Orbit from a dimmed neighbour pixel still moves the camera (picking unchanged).
const target = classes.find((c, i) => c.cls === 'surroundings' && i % 7 === 3) ?? classes.find((c) => c.cls === 'surroundings');
const rect = await state(() => { const r = window.__dcad.viewer.renderer.domElement.getBoundingClientRect(); return { left: r.left, top: r.top }; });
const cam0 = await state(() => window.__dcad.viewer.controls.camera.position.toArray());
await page.mouse.move(rect.left + target.x, rect.top + target.y);
await page.mouse.down();
for (let k = 1; k <= 8; k++) await page.mouse.move(rect.left + target.x + 10 * k, rect.top + target.y + 3 * k);
await page.mouse.up();
await settle();
const cam1 = await state(() => window.__dcad.viewer.controls.camera.position.toArray());
expect(Math.hypot(...sub(cam1, cam0)) > 1, 'orbit from a dimmed neighbour works with focus on');
const pose1 = (await doc()).pose;
await page.keyboard.press('ArrowLeft');
await crownIdle();
expect(dot(sub((await doc()).pose.position, pose1.position), r1.frame.mesial) > 0.099, 'arrow keys still nudge with focus on');
await page.keyboard.press('Control+z');

// Leaving the step restores the normal look; coming back focuses again.
await step('Parameters');
const params = await look();
expect(params.lower.overlay === 0 && params.lower.opacity === 1 && params.upper.opacity === 1, 'normal look outside the crown steps');
await step('Adapt');
await waitFor(() => window.__dcad.viewer.objects.get('lower').mesh.children.some((c) => c.name.endsWith(':focus')), null, 30000);
expect(true, 'focus view in the Adapt step');
await crownIdle(); // the Adapt step switches on the occlusion map (a recompute in the worker)

// Perf: focus faces (prep region cached by the crown) + overlay build on the 1M-triangle demo.
const perf = await state(async () => {
  const v = window.__dcad.viewer;
  const { analysis } = window.__dcad;
  const d = window.__dcad.design.getState().doc;
  const t = d.teeth[0];
  const jawSha = d.scans.find((x) => x.role === 'lower').mesh.sha256;
  const t0 = performance.now();
  const faces = await analysis.focusFaces({ jawSha, margin: new Float32Array(t.margin.points.flatMap((m) => m.p)), occlusal: [...t.frame.occlusal] });
  const t1 = performance.now();
  v.setObjectFocus('lower', { faces, contextOpacity: 0.4, desaturate: 0.6 });
  const t2 = performance.now();
  return { faces: faces.length, facesMs: Math.round(t1 - t0), overlayMs: +(t2 - t1).toFixed(1), triangles: v.objects.get('lower').mesh.geometry.index.count / 3 };
});
expect(perf.facesMs + perf.overlayMs < 100, 'focus faces + overlay < 100 ms', JSON.stringify(perf));

log('console errors', errors.length ? errors : 'none');
if (errors.length) failures.push('console errors');
await browser.close();
log(failures.length ? `${failures.length} FAILED: ${failures.join('; ')}` : 'all checks passed');
process.exit(failures.length ? 1 : 0);
