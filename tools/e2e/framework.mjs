// Framework restorations in the app (specs/2026-10-25-framework-bridges.md), offline, headless Chrome.
// 1. A reduced CoCr single crown on 36 (demo scans): the Setup switch (Reduced, CoCr), frame, margin, axis, Propose
//    crown (a printable framework with its veneering space), the Adapt cutback panel, the Framework and Both views,
//    the veneer-space map, a cutback edit (1.2 mm, overpress on), Finalize: the framework STL, the overpress STL and
//    the sidecar's framework section.
// 2. A reduced CoCr bridge 35–[36]–37 on data/synthetic/lower-bridge.stl + upper.stl: setup, frames, align to arch,
//    pontics, margins, common axis, Propose bridge, overpress on every unit, occlusion, the views, Check bridge (one
//    printable framework of genus 0, connectors at the CoCr area, three overpress parts), Finalize: the framework
//    bridge STL, one overpress STL per unit and the sidecar.
// Every downloaded STL is parsed in Node (the repo's STL reader, validateClosedMesh and meshTopology) and must be a
// closed solid.
// Run with type stripping (the STL checks import the geometry sources):
//   pnpm --filter @dcad/web fixtures && pnpm --filter @dcad/e2e framework
// APP_URL (default http://localhost:5173/app/) is the editor; E2E_OUT the output folder (default out/e2e/framework/);
// E2E_ONLY=single or bridge runs one part.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseStl } from '../../apps/web/src/geometry/stl.ts';
import { meshTopology, validateClosedMesh } from '../../apps/web/src/geometry/meshValidate.ts';

/** Inlay, onlay, wing, implant and reduced sit behind "More types" in Case setup. */
const moreTypes = async (page, fdi) => {
  const more = page.getByRole('button', { name: `More types for ${fdi}` });
  if ((await more.count()) && (await more.getAttribute('aria-expanded')) !== 'true') await more.click();
};

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${resolve(process.env.E2E_OUT ?? `${ROOT}out/e2e/framework`)}/`;
mkdirSync(OUT, { recursive: true });
const DATA = `${ROOT}data/synthetic/`;
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const ALONG = 1000; // the fixtures' resolution (tools/fixtures/generate.mts)
const ONLY = process.env.E2E_ONLY;
const log = (...a) => console.log('[framework]', ...a);
const failures = [];
const expect = (ok, what, detail = '') => {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what);
};
for (const f of ['lower-bridge.stl', 'upper.stl']) {
  if (!existsSync(DATA + f)) throw new Error(`Missing ${DATA + f}: run pnpm --filter @dcad/web fixtures`);
}

/** A downloaded STL, welded by exact position: closed, oriented, its components and genus. */
function checkStl(path) {
  const soup = parseStl(new Uint8Array(readFileSync(path)));
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
  return { ok: v.ok && v.closed, triangles: v.triangles, volume: +v.signedVolumeMm3.toFixed(1), components: topo.components, genus: topo.genus };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];

/** One app page with its helpers. */
async function openApp(name) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  // Offline: the session check (/api/me) fails at the dev proxy; anything else is an error.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 50\d|Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${name}: ${String(e)}`));
  const h = {
    page,
    shot: (file) => page.screenshot({ path: `${OUT}${file}.png` }),
    state: (fn, arg) => page.evaluate(fn, arg),
    waitFor: (fn, arg, timeout = 300000) => page.waitForFunction(fn, arg, { timeout, polling: 150 }),
    step: (label) => page.getByRole('navigation', { name: 'Design steps' }).getByRole('button', { name: label }).first().click(),
    /**
     * Until the camera stops: two equal camera samples 250 ms apart, then three rendered frames in a row with the
     * camera unchanged (a SwiftShader frame of a 1M-triangle scan can take longer than 250 ms). camera-controls'
     * `active` is no idle signal: a move that ends in one step (a jump, or a long frame) goes to sleep without 'rest'
     * and leaves it true.
     */
    settle: async () => {
      let last = '';
      for (let i = 0; i < 200; i++) {
        const now = await page.evaluate(() => window.__dcad.viewer.controls.camera.position.toArray().map((x) => x.toFixed(3)).join());
        if (now === last) break;
        last = now;
        await page.waitForTimeout(250);
      }
      await page.evaluate(
        () =>
          new Promise((done) => {
            const camera = window.__dcad.viewer.controls.camera;
            let previous = '';
            let same = 0;
            let frames = 0;
            const tick = () => {
              const now = [...camera.position.toArray(), ...camera.quaternion.toArray()].map((x) => x.toFixed(4)).join();
              same = now === previous ? same + 1 : 0;
              previous = now;
              if (same >= 3 || ++frames > 600) done();
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
    },
    /**
     * Click a world point once the view shows it: wait until the surface under the point's projection is the point
     * itself, within 0.3 mm (`objectIds` limits the pick; as in ai-bridge.mjs and bridge.mjs).
     */
    clickWorld: async (p, { objectIds } = {}) => {
      for (let i = 0; i < 40; i++) {
        const miss = await page.evaluate(
          ([q, ids]) => {
            const v = window.__dcad.viewer;
            const s = v.project(q);
            const hit = s && v.raycast(s.x, s.y, ids ? { objectIds: ids } : undefined);
            return hit ? Math.hypot(hit.point.x - q[0], hit.point.y - q[1], hit.point.z - q[2]) : Infinity;
          },
          [p, objectIds ?? null],
        );
        if (miss < 0.3) break;
        await page.waitForTimeout(250);
        await h.settle();
      }
      const s = await page.evaluate((q) => window.__dcad.viewer.project(q), p);
      await page.mouse.click(s.x, s.y);
    },
    unitButton: (fdi) => page.locator(`.bridge-units button[title="Make ${fdi} the active unit"]`).first(),
    /** The tooth picker (absent with a single tooth in the case). */
    selectTooth: async (fdi) => {
      const select = page.getByLabel('Tooth', { exact: true });
      if (await select.count()) await select.selectOption(String(fdi));
    },
    /** Scroll the side panel (only) so `selector` is at its top. */
    panelTo: (selector) =>
      page.locator(selector).first().evaluate((el) => {
        const panel = el.closest('aside');
        panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
      }),
    synthetic: (fn, arg) => page.evaluate(async ([f, a]) => (await import('/src/geometry/synthetic.ts'))[f](a), [fn, arg]),
    /** Save the download that `click` starts into the output folder. */
    download: async (click) => {
      const [d] = await Promise.all([page.waitForEvent('download'), click()]);
      const path = `${OUT}${d.suggestedFilename()}`;
      await d.saveAs(path);
      return { name: d.suggestedFilename(), path };
    },
  };
  await page.goto(APP_URL);
  // Headless Chrome advances CSS transitions slowly: screenshots would catch the buttons mid-fade.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
  await page.getByRole('button', { name: /continue offline/i }).click();
  return h;
}

/** Click the synthetic prep of each abutment in the occlusal view (estimateFrame). */
async function frameAbutments(h, abutments) {
  await h.step('Tooth frame');
  for (const fdi of abutments) {
    await h.selectTooth(fdi);
    await h.page.keyboard.press('1');
    await h.settle();
    await h.clickWorld(await h.synthetic('syntheticPrepSeed', { fdi, along: ALONG }), { objectIds: ['lower'] });
    await h.waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.frame), fdi, 60000);
  }
}

/** Live-wire margin on each abutment: 8 clicks on the analytic synthetic margin, then close on the first. */
async function traceMargins(h, abutments) {
  for (const fdi of abutments) {
    await h.selectTooth(fdi);
    await h.step('Margin');
    await h.waitFor(() => window.__dcad.tools.getState().surface === 'ready');
    await h.settle();
    const ring = await h.synthetic('syntheticPrepMargin', { fdi, along: ALONG, samples: 8 });
    const pts = [];
    for (let i = 0; i < ring.length; i += 3) pts.push([ring[i], ring[i + 1], ring[i + 2]]);
    for (const p of [...pts, pts[0]]) {
      await h.clickWorld(p, { objectIds: ['lower'] });
      await h.page.waitForTimeout(250);
    }
    await h.waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.margin), fdi, 60000);
  }
}

/** Every unit of the active bridge has its crown and the displayed bridge is computed. */
const bridgeIdle = (h, units) =>
  h.waitFor((n) => {
    const s = window.__dcad.bridge.getState();
    return s.result && !s.computing && s.result.units.length === n;
  }, units);
const legendTitle = (h) => h.state(() => window.__dcad.tools.getState().legend?.title ?? null);
const objectVisible = (h, id) => h.state((k) => window.__dcad.viewer.objects.get(k)?.visible ?? window.__dcad.viewer.objects.get(k)?.mesh?.visible ?? null, id);

// ---- 1. A reduced CoCr single crown on 36 --------------------------------------------------------------------------

if (ONLY !== 'bridge') {
  const h = await openApp('single');
  const { page } = h;
  await h.step('Case setup');
  await moreTypes(page, 36);
  await page.getByRole('group', { name: 'Anatomic or reduced 36' }).getByRole('button', { name: 'Reduced' }).click();
  await page.getByLabel('Material for 36').selectOption('cocr');
  const order = await h.state(() => window.__dcad.design.getState().doc.setup.teeth.find((t) => t.fdi === 36));
  expect(order.restoration === 'reduced-crown' && order.material === 'cocr', 'setup: 36 is a reduced CoCr crown', JSON.stringify(order));
  await h.shot('01-setup-reduced-cocr');

  await page.getByRole('button', { name: /load demo scans/i }).first().click();
  await h.waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2);
  await frameAbutments(h, [36]);
  await traceMargins(h, [36]);
  await h.step('Insertion axis');
  await h.waitFor(() => Boolean(window.__dcad.tools.getState().axisReport) && !window.__dcad.tools.getState().busy);
  await h.step('Crown proposal');
  await page.getByRole('button', { name: 'Propose crown' }).click();
  await h.waitFor(() => Boolean(window.__dcad.crownTool.current()?.framework));
  const fw = await h.state(() => {
    const f = window.__dcad.crownTool.current().framework;
    return { printable: f.validation.printable, stats: f.stats, shortfall: f.shortfall ?? null, cutback: f.cutback };
  });
  expect(fw.printable, 'single 36: the framework is printable', JSON.stringify(fw.cutback));
  expect(
    fw.stats.thinVertices === 0 && fw.stats.offsetWithinTolerance >= 0.99,
    'single 36: the veneering space is as requested',
    JSON.stringify({ thin: fw.stats.thinVertices, offset: fw.stats.offsetWithinTolerance, min: fw.stats.minMm, max: fw.stats.maxMm, shortfall: fw.shortfall?.areaMm2 }),
  );

  // Adapt: the cutback panel, the views, the veneer-space map, a cutback edit.
  await h.step('Adapt');
  await h.waitFor(() => Boolean(document.querySelector('#cutback-head')));
  await h.panelTo('#cutback-head');
  await h.settle();
  expect((await objectVisible(h, 'framework:36')) === true && (await objectVisible(h, 'crown')) === false, 'Framework view: the framework is shown, the anatomy hidden');
  await h.shot('02-adapt-framework');
  await page.getByRole('group', { name: 'Show anatomy, framework or both' }).getByRole('button', { name: 'Both' }).click();
  await page.waitForTimeout(300);
  expect((await objectVisible(h, 'framework:36')) === true && (await objectVisible(h, 'crown')) === true, 'Both view: the framework and the anatomy are shown');
  await h.shot('03-adapt-both');
  await page.getByLabel('Veneer-space map').check();
  await page.waitForTimeout(300);
  expect((await legendTitle(h)) === 'Veneer space', 'veneer-space map: its legend is shown');
  await h.shot('04-adapt-veneer-map');
  const space = page.getByLabel('Veneering space (mm)');
  await space.fill('1.2');
  await space.press('Enter');
  await h.waitFor(() => window.__dcad.crownTool.current()?.framework?.cutback.thicknessMm === 1.2);
  await page.getByLabel('Overpress part').check();
  await h.waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).cutback?.overpress === true);
  const edited = await h.state(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).cutback);
  expect(edited.thicknessMm === 1.2 && edited.overpress, 'the cutback edit is stored on the tooth', JSON.stringify(edited));
  await h.waitFor(() => !window.__dcad.tools.getState().crown?.computing);
  await page.waitForTimeout(300);
  await h.shot('05-adapt-cutback-1.2');

  // Finalize: the framework STL, the overpress STL, the sidecar.
  await h.step('Finalize');
  await h.waitFor(() => Boolean(document.querySelector('#framework-head')));
  await h.panelTo('#framework-head');
  await page.waitForTimeout(300);
  await h.shot('06-finalize');
  const exportButton = page.getByRole('button', { name: /^Export STL/ });
  const label = await exportButton.innerText();
  const stl = await h.download(async () => {
    await exportButton.click();
    if (label.includes('anyway')) await page.getByRole('button', { name: 'Export STL anyway', exact: true }).click();
  });
  const stlCheck = checkStl(stl.path);
  expect(stl.name === 'case-36-framework.stl' && stlCheck.ok && stlCheck.components === 1, 'single: the framework STL is one closed solid', `${stl.name} ${JSON.stringify(stlCheck)}`);
  const over = await h.download(() => page.getByRole('button', { name: 'Overpress STL 36' }).click());
  const overCheck = checkStl(over.path);
  expect(over.name === 'case-36-overpress.stl' && overCheck.ok, 'single: the overpress STL is a closed solid', `${over.name} ${JSON.stringify(overCheck)}`);
  const info = await h.download(() => page.getByRole('button', { name: 'Construction info' }).click());
  const sidecar = JSON.parse(readFileSync(info.path, 'utf8'));
  expect(Boolean(sidecar.framework), 'single: the sidecar has the framework section', JSON.stringify(sidecar.framework).slice(0, 300));
  await page.close();
}

// ---- 2. A reduced CoCr bridge 35–[36]–37 ---------------------------------------------------------------------------

if (ONLY !== 'single') {
  const h = await openApp('bridge');
  const { page } = h;
  await h.step('Case setup');
  await page.getByRole('button', { name: 'Tooth 35', exact: true }).click();
  await page.getByRole('button', { name: 'Tooth 37', exact: true }).click();
  await page.getByRole('group', { name: 'Restoration for 36' }).getByRole('button', { name: 'Pontic' }).click();
  await page.getByLabel('Material for bridge 35–37').selectOption('cocr');
  for (const fdi of [35, 36, 37]) {
    await moreTypes(page, fdi);
    await page.getByRole('group', { name: `Anatomic or reduced ${fdi}` }).getByRole('button', { name: 'Reduced' }).click();
  }
  const setup = await h.state(() => window.__dcad.design.getState().doc.setup.teeth.map((t) => [t.fdi, t.restoration, t.material]));
  expect(
    JSON.stringify(setup) === JSON.stringify([[35, 'reduced-crown', 'cocr'], [36, 'reduced-pontic', 'cocr'], [37, 'reduced-crown', 'cocr']]),
    'setup: a reduced CoCr bridge 35–[36]–37',
    JSON.stringify(setup),
  );
  await h.shot('07-bridge-setup');

  await h.step('Scans');
  await page.locator('input[type=file][accept=".stl,.ply"]').setInputFiles(['lower-bridge.stl', 'upper.stl'].map((f) => DATA + f));
  await h.waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2);
  await frameAbutments(h, [35, 37]);
  await h.unitButton(35).click();
  await h.waitFor(() => !document.querySelector('.bridge-panel .spinner') && document.querySelector('.bridge-changes'));
  const align = page.getByRole('button', { name: 'Align to arch' });
  if (await align.isEnabled()) await align.click();
  await h.waitFor(() => !document.querySelector('.bridge-panel .spinner'));
  await page.getByRole('button', { name: /place pontics/i }).click();
  await h.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));
  await traceMargins(h, [35, 37]);
  await h.selectTooth(35);
  await h.step('Insertion axis');
  await h.waitFor(() => window.__dcad.tools.getState().axisReport?.bridge && !window.__dcad.tools.getState().busy);
  await h.step('Crown proposal');
  await page.getByRole('button', { name: 'Propose bridge' }).click();
  await h.waitFor(() => [35, 36, 37].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.crown));
  await bridgeIdle(h, 3);
  const proposed = await h.state(() =>
    window.__dcad.bridge.getState().result.units.map((u) => ({
      fdi: u.fdi,
      printable: u.framework?.validation.printable,
      thin: u.framework?.stats.thinVertices,
      offset: u.framework && +u.framework.stats.offsetWithinTolerance.toFixed(3),
      shortfall: u.framework?.shortfall ? +u.framework.shortfall.areaMm2.toFixed(2) : 0,
    })),
  );
  expect(proposed.every((u) => u.printable && u.thin === 0 && u.offset >= 0.99), 'bridge: every unit has a printable framework with its veneering space', JSON.stringify(proposed));

  // Adapt: overpress on each unit (the cutback panel), occlusion on every unit, the views, Check bridge.
  await h.step('Adapt');
  await bridgeIdle(h, 3);
  for (const fdi of [35, 36, 37]) {
    await h.unitButton(fdi).click();
    await h.waitFor((f) => document.querySelector('#cutback-head')?.textContent.includes(String(f)), fdi, 30000);
    await page.getByLabel('Overpress part').check();
    await h.waitFor((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f).cutback?.overpress === true, fdi, 30000);
  }
  await bridgeIdle(h, 3);
  await page.getByRole('button', { name: /Adapt occlusion, all 3 units/ }).click();
  await h.waitFor(() => [35, 36, 37].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f).steps.adapt === 'done'));
  await bridgeIdle(h, 3);
  await h.unitButton(36).click();
  await h.panelTo('#cutback-head');
  await h.settle();
  const shown = await h.state(() => [35, 36, 37].map((f) => [f, window.__dcad.viewer.objects.has(`framework:${f}`)]));
  expect(shown.every(([, s]) => s), 'bridge: framework objects for 35, 36 and 37', JSON.stringify(shown));
  await h.shot('08-bridge-adapt-framework');
  await page.getByRole('group', { name: 'Show anatomy, framework or both' }).getByRole('button', { name: 'Both' }).click();
  await page.waitForTimeout(300);
  await h.shot('09-bridge-adapt-both');
  await page.getByLabel('Veneer-space map').check();
  await page.waitForTimeout(300);
  expect((await legendTitle(h)) === 'Veneer space', 'bridge: the veneer-space map legend');
  await page.getByRole('group', { name: 'Show anatomy, framework or both' }).getByRole('button', { name: 'Framework' }).click();
  await page.waitForTimeout(300);
  await h.shot('10-bridge-veneer-map');
  await page.getByRole('button', { name: /check bridge|check again/i }).click();
  await h.waitFor(() => {
    const c = window.__dcad.bridge.getState().check;
    return c.current && !c.running;
  });
  const check = await h.state(() => {
    const c = window.__dcad.bridge.getState().check.result;
    return {
      union: c.union && { components: c.union.checks.union.components, genus: c.union.checks.union.genus, printable: c.union.checks.union.printable },
      connectors: c.union?.checks.connectors.map((x) => ({ between: x.between, measured: +x.measured.minAreaMm2.toFixed(2), target: x.targetAreaMm2, ok: x.ok })),
      overpress: (c.overpress ?? []).map((o) => ({ fdi: o.fdi, printable: o.validation.printable, volume: +o.volumeMm3.toFixed(1) })),
      error: c.unionError ?? null,
    };
  });
  expect(Boolean(check.union?.printable) && check.union.components === 1 && check.union.genus === 0, 'Check bridge: the framework bridge is one printable solid of genus 0', JSON.stringify(check.union));
  expect(check.connectors?.every((c) => c.ok), 'Check bridge: the connectors reach the CoCr area', JSON.stringify(check.connectors));
  expect(check.overpress.length === 3 && check.overpress.every((o) => o.printable), 'Check bridge: three printable overpress parts', JSON.stringify(check.overpress));

  // Finalize: the framework bridge STL, an overpress STL per unit, the sidecar.
  await h.step('Finalize');
  await h.waitFor(() => {
    const c = window.__dcad.bridge.getState().check;
    return c.current && !c.running && !document.querySelector('.readiness .detail')?.textContent?.includes('Measuring');
  });
  await page.waitForTimeout(500);
  await h.panelTo('#framework-head');
  await h.shot('11-bridge-finalize');
  const exportButton = page.getByRole('button', { name: /^Export STL/ });
  const label = await exportButton.innerText();
  const stl = await h.download(async () => {
    await exportButton.click();
    if (label.includes('anyway')) await page.getByRole('button', { name: 'Export STL anyway', exact: true }).click();
  });
  const stlCheck = checkStl(stl.path);
  expect(
    stl.name === 'case-35-37-framework.stl' && stlCheck.ok && stlCheck.components === 1 && stlCheck.genus === 0,
    'bridge: the framework STL is one closed solid of genus 0',
    `${stl.name} ${JSON.stringify(stlCheck)}`,
  );
  for (const fdi of [35, 36, 37]) {
    const over = await h.download(() => page.getByRole('button', { name: `Overpress STL ${fdi}` }).click());
    const c = checkStl(over.path);
    expect(over.name === `case-${fdi}-overpress.stl` && c.ok, `bridge: the overpress STL of ${fdi} is a closed solid`, `${over.name} ${JSON.stringify(c)}`);
  }
  const info = await h.download(() => page.getByRole('button', { name: 'Construction info' }).click());
  const sidecar = JSON.parse(readFileSync(info.path, 'utf8'));
  expect(sidecar.kind === 'bridge' && Boolean(sidecar.framework), 'bridge: the sidecar has the framework section', JSON.stringify(sidecar.framework).slice(0, 400));
  await page.close();
}

log('console errors', errors.length ? errors : 'none');
if (errors.length) failures.push('console errors');
await browser.close();
log(failures.length ? `${failures.length} FAILED: ${failures.join('; ')}` : 'all checks passed');
process.exit(failures.length ? 1 : 0);
