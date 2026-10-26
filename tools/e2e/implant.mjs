// Implant crowns and bridges in the app (specs/2026-10-25-implant-bridges.md), offline, headless Chrome.
// 1. Bridge 35i–[36]–37i on data/synthetic/lower-implants-35-37.stl + upper.stl: setup (implant crowns, pontic), frame
//    clicks on the scan bodies, align to arch, the implant position step (scan-body match, ghost, accept), the common
//    path, Propose bridge, the auto-angled screw channel on 35, Finalize and the export: the downloaded STL must be one
//    closed solid with one through-hole per screw channel (genus 2), and the sidecar must carry the implant poses,
//    library ids and channel axes.
// 2. A single implant crown on 37 (engaging Ti-base, implant axis): propose, export (genus 1).
// Run with type stripping (the STL check imports the geometry sources):
//   pnpm --filter @dcad/web fixtures && pnpm --filter @dcad/web fixtures:implant && pnpm --filter @dcad/e2e implant
// APP_URL (default http://localhost:5173/app/) is the editor; E2E_OUT the screenshot folder (default out/e2e/implant/);
// E2E_ONLY=bridge or single runs one part.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${resolve(process.env.E2E_OUT ?? `${ROOT}out/e2e/implant`)}/`;
mkdirSync(OUT, { recursive: true });
const DATA = `${ROOT}data/synthetic/`;
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const ONLY = process.env.E2E_ONLY;
const log = (...a) => console.log('[implant]', ...a);
const failures = [];
const expect = (ok, what, detail = '') => {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what);
};
for (const f of ['lower-implants-35-37.stl', 'lower-implants-35-37.poses.json', 'upper.stl']) {
  if (!existsSync(DATA + f)) throw new Error(`Missing ${DATA + f}: run the fixtures (see the header)`);
}
/** The true implant poses and the scan-body top centres (where a user clicks). */
const TRUTH = Object.fromEntries(JSON.parse(readFileSync(`${DATA}lower-implants-35-37.poses.json`, 'utf8')).map((p) => [p.fdi, p]));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];

async function openApp(name) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 50\d|Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${name}: ${String(e)}`));
  const h = {
    page,
    shot: (file) => page.screenshot({ path: `${OUT}${file}.png` }),
    state: (fn, arg) => page.evaluate(fn, arg),
    waitFor: (fn, arg, timeout = 240000) => page.waitForFunction(fn, arg, { timeout, polling: 150 }),
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
      const s = await page.evaluate((q) => window.__dcad.viewer.project(q), p);
      await page.mouse.click(s.x, s.y);
    },
    tooth: (fdi) => page.evaluate((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f), fdi),
    selectTooth: (fdi) => page.getByLabel('Tooth', { exact: true }).selectOption(String(fdi)),
    panelTo: (selector) =>
      page.locator(selector).first().evaluate((el) => {
        const panel = el.closest('aside');
        panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
      }),
  };
  await page.goto(APP_URL);
  await page.getByRole('button', { name: /continue offline/i }).click();
  return h;
}

async function loadScans(h) {
  await h.step('Scans');
  await h.page.locator('input[type=file][accept=".stl,.ply"]').setInputFiles([`${DATA}lower-implants-35-37.stl`, `${DATA}upper.stl`]);
  await h.waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2, null, 300000);
}

/** Frame step: a click on each scan body's top (estimateFrame). */
async function frames(h, teeth) {
  await h.step('Tooth frame');
  for (const fdi of teeth) {
    if (teeth.length > 1 || (await h.page.getByLabel('Tooth', { exact: true }).count())) await h.selectTooth(fdi);
    await h.page.keyboard.press('1');
    await h.settle();
    await h.clickWorld(TRUTH[fdi].topCentre);
    await h.waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.frame), fdi, 60000);
  }
}

/** Implant position step: click the scan body's top, check the match against the truth, accept. */
async function matchScanBody(h, fdi, shot) {
  if (await h.page.getByLabel('Tooth', { exact: true }).count()) await h.selectTooth(fdi);
  await h.step('Implant position');
  await h.settle();
  await h.clickWorld(TRUTH[fdi].topCentre);
  await h.waitFor((f) => {
    const m = window.__dcad.implant.getState().match;
    return m && m.fdi === f && !window.__dcad.implant.getState().matching;
  }, fdi, 60000);
  const m = await h.state(() => window.__dcad.implant.getState().match.result);
  const truth = TRUTH[fdi].pose;
  const d = Math.hypot(...[0, 1, 2].map((k) => m.pose.position[k] - truth.position[k]));
  expect(m.passed && m.rmsMm < 0.05, `${fdi}: scan-body match passes its gate`, `RMS ${m.rmsMm.toFixed(4)} mm, inliers ${(m.inlierFraction * 100).toFixed(1)}%, coverage ${(m.coverage * 100).toFixed(1)}%`);
  expect(d < 0.02, `${fdi}: matched platform within 0.02 mm of the truth`, `${d.toFixed(4)} mm`);
  expect(await h.state(() => window.__dcad.viewer.objects.has('implant:scan-body')), `${fdi}: the matched scan body is shown`);
  if (shot) await h.shot(shot);
  await h.page.getByRole('button', { name: 'Accept match' }).click();
  await h.waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.implant), fdi, 30000);
  const t = await h.tooth(fdi);
  expect(t.steps.margin === 'done' && t.implant.fit.rmsMm < 0.05, `${fdi}: implant position stored (margin step done)`, t.implant.libraryId);
}

/** Download the STL (and the sidecar) from Finalize; parse the STL in Node. */
async function exportAndCheck(h, expected) {
  const { page } = h;
  const exportButton = page.getByRole('button', { name: /^Export STL/ });
  const label = await exportButton.innerText();
  const [stl] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await exportButton.click();
      if (label.includes('anyway')) await page.getByRole('button', { name: 'Export STL anyway', exact: true }).click();
    })(),
  ]);
  const stlPath = `${OUT}${stl.suggestedFilename()}`;
  await stl.saveAs(stlPath);
  const [info] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Construction info' }).click()]);
  const infoPath = `${OUT}${info.suggestedFilename()}`;
  await info.saveAs(infoPath);
  const { parseStl } = await import('../../apps/web/src/geometry/stl.ts');
  const { validateClosedMesh, meshTopology } = await import('../../apps/web/src/geometry/meshValidate.ts');
  const soup = parseStl(new Uint8Array(readFileSync(stlPath)));
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
  const topo = meshTopology(mesh);
  expect(v.ok && topo.components === 1 && topo.genus === expected.genus, `${expected.what}: exported STL is one closed solid with ${expected.genus} through-hole(s)`, `${stl.suggestedFilename()}: ${v.triangles} triangles, ${v.signedVolumeMm3.toFixed(1)} mm³, components ${topo.components}, genus ${topo.genus}`);
  return JSON.parse(readFileSync(infoPath, 'utf8'));
}

// ---- 1. Bridge 35i–[36]–37i --------------------------------------------------------------------------------------

if (ONLY !== 'single') {
  const h = await openApp('bridge');
  const { page } = h;
  // Setup: 35 and 37 as implant crowns (single units first: a bridge may not mix supports), then 36 becomes a pontic.
  await h.step('Case setup');
  await page.getByRole('button', { name: 'Tooth 35', exact: true }).click();
  await page.getByRole('button', { name: 'Tooth 37', exact: true }).click();
  for (const fdi of [35, 37]) await page.getByRole('group', { name: `Restoration for ${fdi}` }).getByRole('button', { name: 'Implant' }).click();
  await page.getByRole('group', { name: 'Restoration for 36' }).getByRole('button', { name: 'Pontic' }).click();
  const setup = await h.state(() => {
    const d = window.__dcad.design.getState().doc;
    return { bridges: d.bridges.map((b) => b.teeth), types: d.setup.teeth.map((t) => [t.fdi, t.restoration]) };
  });
  expect(JSON.stringify(setup.bridges) === '[[35,36,37]]', 'setup: 35i–[36]–37i', JSON.stringify(setup));
  await h.shot('01-setup');

  await loadScans(h);
  await frames(h, [35, 37]);
  // Align the implant units' frames to the arch, then place the pontic.
  await page.locator('.bridge-units button[title="Make 35 the active unit"]').first().click();
  await h.waitFor(() => !document.querySelector('.bridge-panel .spinner') && document.querySelector('.bridge-changes'));
  const align = page.getByRole('button', { name: 'Align to arch' });
  if (await align.isEnabled()) await align.click();
  await h.waitFor(() => !document.querySelector('.bridge-panel .spinner'));
  await page.getByRole('button', { name: /place pontics/i }).click();
  await h.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));

  // Implant position: the nav says so for implant crowns.
  await h.selectTooth(35);
  const navLabels = await page.getByRole('navigation', { name: 'Design steps' }).getByRole('button').allInnerTexts();
  expect(navLabels.some((l) => l.startsWith('Implant position')) && !navLabels.some((l) => l.startsWith('Margin')), 'an implant crown has an Implant position step, no Margin', navLabels.join(' | '));
  await matchScanBody(h, 35, '02-implant-position-35');
  await matchScanBody(h, 37, null);

  // Common path over the implant axes.
  await h.selectTooth(35);
  await h.step('Insertion axis');
  await page.getByRole('button', { name: 'Common path' }).click();
  await h.waitFor(() => window.__dcad.implant.getState().path && window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 35).axis);
  const path = await h.state(() => {
    const s = window.__dcad.implant.getState().path;
    const d = window.__dcad.design.getState().doc;
    return { path: s, a35: d.teeth.find((t) => t.fdi === 35).axis, a37: d.teeth.find((t) => t.fdi === 37).axis };
  });
  const truthDiv =
    (Math.acos(
      [0, 1, 2].reduce((s, k) => {
        const qa = TRUTH[35].pose.quaternion, qb = TRUTH[37].pose.quaternion;
        const z = (q) => [2 * (q[0] * q[2] + q[3] * q[1]), 2 * (q[1] * q[2] - q[3] * q[0]), 1 - 2 * (q[0] * q[0] + q[1] * q[1])];
        return s + z(qa)[k] * z(qb)[k];
      }, 0),
    ) *
      180) /
    Math.PI;
  expect(path.path.ok && Math.abs(path.path.divergenceDeg - truthDiv) < 0.3, 'common path: divergence within the library limit and ±0.3° of the truth', `${path.path.divergenceDeg.toFixed(2)}° (true ${truthDiv.toFixed(2)}°, limit ${path.path.maxDivergenceDeg}°)`);
  expect(JSON.stringify(path.a35) === JSON.stringify(path.a37), 'one path on 35 and 37', JSON.stringify(path.a35.direction));
  await h.settle();
  await h.shot('03-common-path');

  // Propose bridge, then the auto-angled channel on 35.
  await h.step('Crown proposal');
  await page.getByRole('button', { name: 'Propose bridge' }).click();
  await h.waitFor(() => [35, 36, 37].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.crown));
  const idle = () => h.waitFor(() => {
    const s = window.__dcad.bridge.getState();
    return s.result && !s.computing && s.result.units.length === 3;
  });
  await idle();
  const units = await h.state(() =>
    window.__dcad.bridge.getState().result.units.map((u) => ({
      fdi: u.fdi,
      ok: u.validation.ok,
      printable: u.validation.printable,
      implant: u.implant && { exitOk: u.implant.channel.exitOk, wallOk: u.implant.channel.wallOk, minWall: +u.implant.channel.minWallMm.toFixed(2), cut: Boolean(u.implant.cutOk), seat: u.implant.rimUndercutCount },
    })),
  );
  expect(units.every((u) => u.ok && u.printable), 'every unit is a printable closed solid', JSON.stringify(units));
  expect(units.filter((u) => u.implant).length === 2 && units.every((u) => !u.implant || (u.implant.cut && u.implant.seat === 0)), 'both implant crowns: channel cut, seated on their Ti-bases', JSON.stringify(units.map((u) => u.implant)));
  await h.selectTooth(35);
  await page.waitForTimeout(300);
  await h.settle();
  await h.shot('04-proposal');
  // At the default 0.8 mm wall no angle fits the synthetic 4.8 mm premolar (the arch's teeth are 0.7× natural size):
  // the auto angle says so. With the wall scaled to 0.55 mm (Parameters, Implant group) it finds an angle.
  await page.getByRole('button', { name: 'Auto angle' }).click();
  await h.waitFor(() => !window.__dcad.implant.getState().channelBusy);
  const refused = await h.state(() => ({ error: window.__dcad.implant.getState().error, stored: window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 35).screwChannel }));
  expect(!refused.stored && /No channel angle/.test(refused.error ?? ''), '35 at the 0.8 mm default wall: no angle passes, and the app says so', refused.error ?? '');
  await h.step('Parameters');
  const wall = page.locator('#param-channelWallMm');
  await wall.fill('0.55');
  await wall.blur();
  await h.waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 35).params.channelWallMm === 0.55);
  await h.step('Crown proposal');
  await idle();
  await page.getByRole('button', { name: 'Auto angle' }).click();
  await h.waitFor(() => !window.__dcad.implant.getState().channelBusy);
  await idle();
  const channel = await h.state(() => ({
    stored: window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 35).screwChannel,
    view: (() => {
      const u = window.__dcad.bridge.getState().result.units.find((x) => x.fdi === 35);
      return u.implant && { angle: u.implant.channel.angleDeg, exitOk: u.implant.channel.exitOk, wallOk: u.implant.channel.wallOk, minWall: +u.implant.channel.minWallMm.toFixed(2), required: u.implant.channel.requiredWallMm };
    })(),
    shown: window.__dcad.viewer.objects.has('implant:channel'),
  }));
  log('35 channel:', JSON.stringify(channel));
  expect(Boolean(channel.stored?.angleDeg) && channel.view?.exitOk && channel.view?.wallOk, '35: the auto angle stores an angled channel that exits occlusally with enough wall', JSON.stringify(channel));
  expect(channel.shown, 'the screw channel is shown in the viewer');
  await h.panelTo('fieldset legend:text("Screw channel")');
  await h.settle();
  await h.shot('05-screw-channel');

  // Finalize: readiness with the implant rows, then the export.
  await h.step('Finalize');
  await h.waitFor(() => {
    const c = window.__dcad.bridge.getState().check;
    return c.current && !c.running;
  });
  const check = await h.state(() => {
    const c = window.__dcad.bridge.getState().check.result.union?.checks;
    return c && { ok: c.ok, components: c.union.components, genus: c.union.genus, seating: c.seating.map((s) => [s.fdi, s.ok]), failures: c.failures };
  });
  expect(check && check.components === 1 && check.genus === 2 && check.seating.length === 2 && check.seating.every(([, ok]) => ok), 'Check bridge: one solid, a through-hole per channel, seating unchanged on both Ti-bases', JSON.stringify(check));
  await page.waitForTimeout(500);
  const rows = await h.state(() => [...document.querySelectorAll('.readiness li')].map((li) => li.textContent.trim().slice(0, 80)));
  expect(rows.some((r) => r.includes('Scan body matched')) && rows.some((r) => r.includes('Screw channel exits')), 'readiness lists the implant rows', `${rows.length} rows`);
  await h.panelTo('#readiness-head');
  await h.shot('06-finalize');
  const sidecar = await exportAndCheck(h, { what: 'bridge', genus: 2 });
  const implants = sidecar.units.filter((u) => u.implant);
  expect(
    implants.length === 2 && implants.every((u) => u.implant.libraryId && u.implant.implantPose && u.implant.screwChannel?.direction && u.implant.screwChannel?.pivot),
    'sidecar: implant poses, library ids and channel axes',
    JSON.stringify(implants.map((u) => ({ fdi: u.fdi, lib: u.implant.libraryId, angle: u.implant.screwChannel?.angleDeg }))),
  );
  await page.close();
}

// ---- 2. A single implant crown on 37 -------------------------------------------------------------------------------

if (ONLY !== 'bridge') {
  const h = await openApp('single');
  const { page } = h;
  await h.step('Case setup');
  await page.getByRole('button', { name: 'Tooth 37', exact: true }).click();
  await page.getByRole('button', { name: 'Tooth 36', exact: true }).click(); // remove the default 36
  await page.getByRole('group', { name: 'Restoration for 37' }).getByRole('button', { name: 'Implant' }).click();
  const teeth = await h.state(() => window.__dcad.design.getState().doc.setup.teeth.map((t) => [t.fdi, t.restoration]));
  expect(JSON.stringify(teeth) === '[[37,"implant-crown"]]', 'setup: a single implant crown on 37', JSON.stringify(teeth));
  await loadScans(h);
  await frames(h, [37]);
  await matchScanBody(h, 37, null);
  const t37 = await h.tooth(37);
  expect(t37.implant.engaging && Boolean(t37.axis), '37: engaging Ti-base, the implant axis as the insertion axis', t37.implant.libraryId);
  await h.step('Crown proposal');
  await page.getByRole('button', { name: /^Propose crown/ }).click();
  await h.waitFor(() => {
    const c = window.__dcad.crownTool.current();
    return Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 37).crown) && c && !window.__dcad.tools.getState().crown?.computing;
  });
  await h.waitFor(() => Boolean(window.__dcad.implant.getState().result));
  const view = await h.state(() => {
    const c = window.__dcad.crownTool.current();
    return { ok: c.validation.ok, printable: c.validation.printable, exitOk: c.implant.channel.exitOk, wallOk: c.implant.channel.wallOk, minWall: +c.implant.channel.minWallMm.toFixed(2), cut: c.implant.cutOk, gap: +c.implant.tiBaseGap.maxErrorMm.toFixed(4) };
  });
  expect(view.ok && view.printable && view.exitOk && view.wallOk && view.cut, '37: printable implant crown, channel exits occlusally with enough wall, cut', JSON.stringify(view));
  await h.settle();
  await h.shot('07-single-implant-crown');
  await h.step('Finalize');
  await page.waitForTimeout(1000);
  const sidecar = await exportAndCheck(h, { what: 'single crown', genus: 1 });
  expect(Boolean(sidecar.implant?.implantPose && sidecar.implant?.screwChannel?.direction), 'single-crown sidecar: implant pose and channel axis', sidecar.implant?.libraryId);
  await h.panelTo('#readiness-head');
  await h.shot('08-single-finalize');
  await page.close();
}

await browser.close();
if (errors.length) {
  log('console errors:', errors.length);
  for (const e of errors.slice(0, 10)) log('  ', e);
}
expect(errors.length === 0, 'no console or page errors');
log(`${failures.length ? 'FAILED' : 'ALL PASSED'}: ${failures.length} failure(s)`);
process.exit(failures.length ? 1 : 0);
