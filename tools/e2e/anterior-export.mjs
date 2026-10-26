// Two single crowns on upper front teeth plus a bridge, offline in headless Chrome
// (specs/2026-10-26-anterior-margin-and-export-all.md):
// 1. Setup: 11 and 21 as crowns and 35–[36]–37 as a bridge; the hint says 11 and 21 stay separate.
// 2. Margin view on 11 of a proclined upper arch (front teeth leaning 25° labially, as on real teeth): every margin
//    point is reachable by a click from the step's view, against the old view along the occlusal-plane normal.
// 3. A margin traced in the old view (as the user did) is flagged in the Margin step (warning plus kink marker) and in
//    the Proposal step; "Fix the margin" leads back, and a margin traced in the new view passes.
// 4. Crowns on 11 and 21, the bridge, then Finalize → Export all: one zip with both crowns and the merged bridge (each
//    STL parsed in Node as a closed solid, the bridge one component) and a manifest of open checks.
// Run with type stripping (the exported files are checked with the geometry sources):
//   pnpm --filter @dcad/web fixtures && pnpm --filter @dcad/e2e anterior
// APP_URL (default http://localhost:5173/app/) is the editor; E2E_OUT the output folder (default out/e2e/anterior/).
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseStl } from '../../apps/web/src/geometry/stl.ts';
import { meshTopology, validateClosedMesh } from '../../apps/web/src/geometry/meshValidate.ts';
import { strFromU8, unzipSync } from '../../apps/web/node_modules/fflate/esm/index.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${resolve(process.env.E2E_OUT ?? `${ROOT}out/e2e/anterior`)}/`;
mkdirSync(OUT, { recursive: true });
const DATA = `${ROOT}data/synthetic/`;
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const ALONG = 1000; // the fixtures' resolution (tools/fixtures/generate.mts)
/** The upper front teeth lean this far labially (syntheticArch's anteriorLeanDeg), as real upper incisors do (15–30°). */
const PROCLINE_DEG = 25;
const log = (...a) => console.log('[anterior]', ...a);
const failures = [];
const expect = (ok, what, detail = '') => {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what);
};
if (!existsSync(`${DATA}lower-bridge.stl`)) throw new Error(`Missing ${DATA}lower-bridge.stl: run pnpm --filter @dcad/web fixtures`);


const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
page.on('console', (m) => {
  if (m.type() === 'error' && !/status of 50\d|Failed to load resource/.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (file) => page.screenshot({ path: `${OUT}${file}.png` });
const state = (fn, arg) => page.evaluate(fn, arg);
const waitFor = (fn, arg, timeout = 240000) => page.waitForFunction(fn, arg, { timeout, polling: 150 });
const step = (label) => page.getByRole('navigation', { name: 'Design steps' }).getByRole('button', { name: label }).first().click();
const selectTooth = (fdi) => page.getByLabel('Tooth', { exact: true }).selectOption(String(fdi));
const tooth = (fdi) => state((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f), fdi);
/** Until the camera has stopped (camera-controls idle), so a click lands where the projection says. */
const settle = async () => {
  await page.waitForTimeout(300);
  await waitFor(() => !window.__dcad.viewer.controls.active, null, 60000);
  await page.waitForTimeout(200);
};
const idle = () => waitFor(() => !window.__dcad.tools.getState().busy && !window.__dcad.tools.getState().crown?.computing, null, 120000);
/** Points of a synthetic helper, leaning like the scan for upper teeth. */
const synthetic = (fn, arg) =>
  page.evaluate(
    async ([f, a, deg]) => {
      const out = (await import('/src/geometry/synthetic.ts'))[f](Math.floor(a.fdi / 10) <= 2 ? { ...a, anteriorLeanDeg: deg } : a);
      const pts = [];
      for (let i = 0; i < out.length; i += 3) pts.push([out[i], out[i + 1], out[i + 2]]);
      return pts;
    },
    [fn, arg, PROCLINE_DEG],
  );
const clickWorld = async (p) => {
  const s = await state((q) => window.__dcad.viewer.project(q), p);
  await page.mouse.click(s.x, s.y);
};
/** Margin points a click reaches from the current view: the pick lands within 0.3 mm of the point. */
const reachable = (pts, role) =>
  state(
    ([ps, r]) =>
      ps.filter((q) => {
        const s = window.__dcad.viewer.project(q);
        const hit = s && window.__dcad.viewer.raycast(s.x, s.y, { objectIds: [r] });
        return hit && Math.hypot(hit.point.x - q[0], hit.point.y - q[1], hit.point.z - q[2]) < 0.3;
      }).length,
    [pts, role],
  );
const sharpestTurn = (fdi) =>
  state(async (f) => {
    const { sharpestTurnDeg } = await import('/src/ai/qa.ts');
    return sharpestTurnDeg(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f).margin.points.map((x) => x.p));
  }, fdi);

async function frameAt(fdi) {
  await selectTooth(fdi);
  await page.keyboard.press('1');
  await settle();
  const [seed] = await synthetic('syntheticPrepSeed', { fdi, along: ALONG });
  await clickWorld(seed);
  await waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.frame), fdi, 60000);
}

/** Eight clicks on the analytic margin from the current view, then close (Enter); resolves once the margin changed. */
async function traceMargin(fdi) {
  const before = (await tooth(fdi))?.margin ?? null;
  const ring = await synthetic('syntheticPrepMargin', { fdi, along: ALONG, samples: 8 });
  for (const p of ring) {
    await clickWorld(p);
    await page.waitForTimeout(300);
  }
  await page.keyboard.press('Enter');
  await waitFor(
    ([f, b]) => {
      const m = window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.margin;
      return m && JSON.stringify(m.anchors) !== JSON.stringify(b?.anchors);
    },
    [fdi, before],
    60000,
  );
  await idle();
}

async function enterMargin(fdi) {
  await selectTooth(fdi);
  await step('Margin');
  await waitFor(() => window.__dcad.tools.getState().surface === 'ready');
  await settle();
}

// ---- 1. Setup ---------------------------------------------------------------------------------------------------

await page.goto(APP_URL);
// The click flow is under test: no frames from the preps on entering Tooth frame (specs/2026-10-26-auto-frames.md).
await page.waitForFunction(() => Boolean(window.__dcad?.tools));
await page.evaluate(() => window.__dcad.tools.getState().set({ autoFrames: false }));
await page.getByRole('button', { name: /continue offline/i }).click();
await step('Case setup');
for (const fdi of [11, 21, 35, 37]) await page.getByRole('button', { name: `Tooth ${fdi}`, exact: true }).click();
await page.getByRole('group', { name: 'Restoration for 36' }).getByRole('button', { name: 'Pontic' }).click();
const setup = await state(() => ({ bridges: window.__dcad.design.getState().doc.bridges.map((b) => b.teeth), teeth: window.__dcad.design.getState().doc.setup.teeth.map((t) => t.fdi) }));
expect(JSON.stringify(setup.bridges) === '[[35,36,37]]', 'setup: 11 and 21 as crowns, bridge 35–[36]–37', JSON.stringify(setup));
const hint = await page.locator('p[role="note"]').innerText().catch(() => '');
expect(/11 and 21 stay separate crowns/.test(hint) && !/35|36|37/.test(hint), 'setup hint: 11 and 21 stay separate unless connected', hint);
await shot('01-setup-hint');

await step('Scans');
// The proclined upper arch is generated in the page (the app's own generator) and dropped on the file input.
await state(
  async ([along, deg]) => {
    const { syntheticArch } = await import('/src/geometry/synthetic.ts');
    const { writeBinaryStl } = await import('/src/geometry/stl.ts');
    const mesh = syntheticArch({ jaw: 'upper', along, across: along / 2, preps: [11, 21], anteriorLeanDeg: deg });
    const input = document.querySelector('input[type=file][accept=".stl,.ply"]');
    const files = new DataTransfer();
    files.items.add(new File([writeBinaryStl(mesh)], 'upper-proclined.stl'));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  },
  [ALONG, PROCLINE_DEG],
);
await page.locator('input[type=file][accept=".stl,.ply"]').setInputFiles([`${DATA}lower-bridge.stl`]);
await waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2, null, 300000);

// ---- 2. Margin view on a proclined 11 -------------------------------------------------------------------------------

await step('Tooth frame');
await frameAt(11);
await frameAt(21);
const ring64 = await synthetic('syntheticPrepMargin', { fdi: 11, along: ALONG, samples: 64 });
await enterMargin(11);
const reachNew = await reachable(ring64, 'upper');
const viewDir = await state(() => window.__dcad.viewer.viewDirection().toArray());
await shot('02-margin-11-new-view');
const frame11 = (await tooth(11)).frame;
// The old view: along the jaw's occlusal-plane normal (−z for the synthetic upper jaw), which was the frame occlusal
// of every tooth before the front-tooth frame (specs/2026-10-26-anterior-tooth-frame.md).
const PLANE_NORMAL = [0, 0, -1];
await state(([f, n]) => window.__dcad.viewer.focus(f.origin, n, 32), [frame11, PLANE_NORMAL]);
await settle();
const reachOld = await reachable(ring64, 'upper');
await shot('03-margin-11-old-view');
const angle = (a, b) => (Math.acos(Math.min(1, a.reduce((s, x, k) => s + x * b[k], 0))) * 180) / Math.PI;
const tilt = angle(viewDir.map((x) => -x), frame11.occlusal);
expect(
  reachNew === 64,
  'Margin view on proclined 11: every margin point reachable by a click',
  `${reachNew}/64 (old view along the occlusal-plane normal: ${reachOld}/64), view ${tilt.toFixed(1)}° from the frame occlusal, frame ${angle(frame11.occlusal, PLANE_NORMAL).toFixed(1)}° from the plane normal`,
);

// ---- 3. A kinked margin is flagged before the crown -----------------------------------------------------------------

// Traced from the old view, as the user did: clicks behind the tooth land on the wrong surface.
await traceMargin(11);
const kinkedTurn = await sharpestTurn(11);
await page.waitForTimeout(300);
const warning = await page.locator('.margin-problems').innerText().catch(() => '');
const kinkMarker = await state(() => window.__dcad.viewer.overlays.has('margin:kinks'));
expect(kinkedTurn > 120 && /Kink/.test(warning) && kinkMarker, 'a kinked margin is flagged in the Margin step, with a marker', `${kinkedTurn.toFixed(0)}°; "${warning.replace(/\n/g, ' ')}"`);
await shot('04-kinked-margin-flagged');
await step('Insertion axis');
await idle();
await step('Crown proposal');
const notice = page.locator('.margin-problems');
const noticeText = await notice.innerText().catch(() => '');
expect(/Fix the margin of 11/.test(noticeText), 'the Proposal step shows the open margin problem', noticeText.replace(/\n/g, ' '));
await shot('05-proposal-margin-notice');
await notice.getByRole('button', { name: 'Fix the margin of 11' }).click();
expect((await state(() => window.__dcad.design.getState().activeStep)) === 'margin', '"Fix the margin" opens the Margin step');
await waitFor(() => window.__dcad.tools.getState().surface === 'ready');
await settle();
// Start again from no margin (undo the axis and the kinked margin): a click near one of its points would drag it.
for (let i = 0; i < 4 && (await tooth(11)).margin; i++) {
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
}
await traceMargin(11);
const fixedTurn = await sharpestTurn(11);
const warningAfter = await page.locator('.margin-problems').count();
expect(fixedTurn <= 120 && warningAfter === 0, 'a margin traced in the new view passes (no warning)', `${fixedTurn.toFixed(0)}°`);
await shot('06-margin-11-fixed');

// ---- 4. Crowns on 11 and 21, the bridge, Export all ------------------------------------------------------------------

async function crownOn(fdi) {
  await selectTooth(fdi);
  await step('Insertion axis');
  await idle();
  await page.getByRole('button', { name: 'Least undercut', exact: true }).click();
  await idle();
  await step('Crown proposal');
  await page.getByRole('button', { name: /^(Re-)?[Pp]ropose crown$/ }).click();
  await waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.crown), fdi, 120000);
  await idle();
}
await crownOn(11);
await enterMargin(21);
await traceMargin(21);
await crownOn(21);

await step('Tooth frame');
await frameAt(35);
await frameAt(37);
await waitFor(() => !document.querySelector('.bridge-panel .spinner') && document.querySelector('.bridge-changes'));
await page.getByRole('button', { name: /place pontics/i }).click();
await waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));
for (const fdi of [35, 37]) {
  await enterMargin(fdi);
  await traceMargin(fdi);
}
await selectTooth(35);
await step('Insertion axis');
await waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 35)?.axis && !window.__dcad.tools.getState().busy);
await step('Crown proposal');
await page.getByRole('button', { name: 'Propose bridge' }).click();
await waitFor(() => [35, 36, 37].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.crown));

await selectTooth(11);
await step('Finalize');
await idle();
const exportAll = page.getByRole('button', { name: 'Export all (zip)' });
await exportAll.scrollIntoViewIfNeeded();
await exportAll.click();
const anyway = page.getByRole('button', { name: 'Export all anyway' });
const download = page.waitForEvent('download', { timeout: 300000 });
await Promise.race([anyway.waitFor({ timeout: 300000 }), download]);
if (await anyway.isVisible()) {
  await page.locator('.confirm-box').scrollIntoViewIfNeeded();
  await shot('07-export-all-confirm');
  await anyway.click();
}
const zipFile = await download;
const zipPath = `${OUT}${zipFile.suggestedFilename()}`;
await zipFile.saveAs(zipPath);
await page.locator('.export-done').last().scrollIntoViewIfNeeded();
await shot('08-export-all-done');

const files = unzipSync(new Uint8Array(readFileSync(zipPath)));
const names = Object.keys(files).sort();
expect(
  JSON.stringify(names) ===
    JSON.stringify(['README.txt', 'case-11.construction.json', 'case-11.stl', 'case-21.construction.json', 'case-21.stl', 'case-35-37-bridge.construction.json', 'case-35-37-bridge.stl', 'manifest.json']),
  'Export all: one zip with both crowns, the bridge, a manifest and a README',
  `${zipFile.suggestedFilename()}: ${names.join(' ')}`,
);
/** Weld an STL soup by exact position and check it is one closed, oriented solid. */
function check(name) {
  const soup = parseStl(files[name]);
  const ids = new Map();
  const positions = [];
  const indices = new Uint32Array(soup.positions.length / 3);
  for (let i = 0; i < indices.length; i++) {
    const key = `${soup.positions[i * 3]},${soup.positions[i * 3 + 1]},${soup.positions[i * 3 + 2]}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      ids.set(key, id);
      positions.push(soup.positions[i * 3], soup.positions[i * 3 + 1], soup.positions[i * 3 + 2]);
    }
    indices[i] = id;
  }
  const mesh = { positions: new Float32Array(positions), indices };
  const v = validateClosedMesh(mesh);
  return { ok: v.ok && v.closed, triangles: v.triangles, volume: +v.signedVolumeMm3.toFixed(1), components: meshTopology(mesh).components };
}
for (const name of names.filter((n) => n.endsWith('.stl'))) {
  const c = check(name);
  expect(c.ok && (!name.includes('bridge') || c.components === 1), `${name}: a closed, oriented solid${name.includes('bridge') ? ', one component' : ''}`, JSON.stringify(c));
}
const manifest = JSON.parse(strFromU8(files['manifest.json']));
expect(
  manifest.restorations.length === 3 && manifest.restorations.every((r) => r.files.length === 2 && Array.isArray(r.openChecks)),
  'manifest: three restorations, each with its files and open checks',
  JSON.stringify(manifest.restorations.map((r) => ({ teeth: r.teeth, ready: r.ready, open: r.openChecks.length }))),
);
const sidecar = JSON.parse(strFromU8(files['case-35-37-bridge.construction.json']));
expect(sidecar.kind === 'bridge' && sidecar.units.length === 3, 'the bridge sidecar lists its three units');
log('README:\n' + strFromU8(files['README.txt']));

log('console errors', errors.length ? errors : 'none');
if (errors.length) failures.push('console errors');
await browser.close();
log(failures.length ? `${failures.length} FAILED: ${failures.join('; ')}` : 'all checks passed');
process.exit(failures.length ? 1 : 0);
