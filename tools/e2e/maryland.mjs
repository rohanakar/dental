// Maryland (resin-bonded) bridge 11w–[12] in the app (specs/2026-10-25-maryland-bridges.md), offline, headless Chrome:
// setup (Crown → Wing on 11 next to the pontic 12), scans, the frame click on 11's palatal surface, place pontics, the
// "Wing outline" live-wire (the golden case's scripted anchors), the common axis, Propose bridge, the Adapt wing panel
// and Check bridge, Finalize, and the export: the STL must be one closed solid of genus 0 and the sidecar must carry
// the wing. The scans and anchors are the synthetic golden case's:
//   pnpm --filter @dcad/pipeline-runner run --synthetic      # writes data/golden/synthetic-maryland-11-12
//   node --experimental-strip-types tools/e2e/maryland.mjs
// APP_URL (default http://localhost:5173/app/) is the editor; DATA the case folder; E2E_OUT the screenshot folder
// (default out/e2e/maryland/).
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Inlay, onlay, wing, implant and reduced sit behind "More types" in Case setup. */
const moreTypes = async (page, fdi) => {
  const more = page.getByRole('button', { name: `More types for ${fdi}` });
  if ((await more.count()) && (await more.getAttribute('aria-expanded')) !== 'true') await more.click();
};

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${resolve(process.env.E2E_OUT ?? `${ROOT}out/e2e/maryland`)}/`;
mkdirSync(OUT, { recursive: true });
const DATA = `${resolve(process.env.DATA ?? `${ROOT}data/golden/synthetic-maryland-11-12`)}/`;
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const log = (...a) => console.log('[maryland]', ...a);
const failures = [];
const expect = (ok, what, detail = '') => {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what);
};
if (!existsSync(`${DATA}case.json`)) throw new Error(`Missing ${DATA}case.json: run pnpm --filter @dcad/pipeline-runner run --synthetic`);
const golden = JSON.parse(readFileSync(`${DATA}case.json`, 'utf8'));
const wingSpec = golden.bridge.units.find((u) => u.restoration === 'maryland-wing');

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
const settle = async () => {
  let last = '';
  for (let i = 0; i < 200; i++) {
    const now = await state(() => window.__dcad.viewer.controls.camera.position.toArray().map((x) => x.toFixed(3)).join());
    if (now === last) return;
    last = now;
    await page.waitForTimeout(250);
  }
};
/** Distance from a world point to where a click on it lands on the upper scan (Infinity = no hit). */
const miss = (p) =>
  state((q) => {
    const s = window.__dcad.viewer.project(q);
    const hit = s && window.__dcad.viewer.raycast(s.x, s.y, { objectIds: ['upper'] });
    return hit ? Math.hypot(hit.point.x - q[0], hit.point.y - q[1], hit.point.z - q[2]) : Infinity;
  }, p);
/** Look at `p` from below and behind (the palatal side of an upper incisor), as a user would. */
const lookPalatal = async (p) => {
  await state((q) => window.__dcad.viewer.focus(q, [0, -0.55, -0.83], 30), p);
  await settle();
};
const clickWorld = async (p) => {
  const s = await state((q) => window.__dcad.viewer.project(q), p);
  await page.mouse.click(s.x, s.y);
};
const bridgeIdle = (n) =>
  waitFor((k) => {
    const s = window.__dcad.bridge.getState();
    return s.result && !s.computing && s.result.units.length === k;
  }, n);

await page.goto(APP_URL);
await page.getByRole('button', { name: /continue offline/i }).click();

// ---- Setup: 11 and 12 from the chart, 12 a pontic (connects to 11), then 11 a Maryland wing; 36 leaves the case.
await step('Case setup');
await page.getByRole('button', { name: 'Tooth 11', exact: true }).click();
await page.getByRole('button', { name: 'Tooth 12', exact: true }).click();
await page.getByRole('group', { name: 'Restoration for 12' }).getByRole('button', { name: 'Pontic' }).click();
await moreTypes(page, 11);
await page.getByRole('group', { name: 'Restoration for 11' }).getByRole('button', { name: 'Wing' }).click();
await page.getByRole('button', { name: 'Tooth 36', exact: true }).click();
const setup = await state(() => {
  const d = window.__dcad.design.getState().doc;
  return { teeth: d.setup.teeth.map((t) => [t.fdi, t.restoration]), bridges: d.bridges };
});
expect(
  JSON.stringify(setup.teeth) === '[[11,"maryland-wing"],[12,"pontic"]]' && JSON.stringify(setup.bridges.map((b) => b.teeth)) === '[[12,11]]',
  'setup: 11 wing + 12 pontic, one bridge',
  JSON.stringify(setup),
);
expect(setup.bridges[0]?.connectors[0]?.areaMm2 === 4.72, 'the wing connector starts at the Maryland minimum (3 × 2 mm)', String(setup.bridges[0]?.connectors[0]?.areaMm2));
await page.getByRole('group', { name: 'Restoration for 11' }).scrollIntoViewIfNeeded();
await shot('01-setup');

// ---- Scans.
await step('Scans');
await page.locator('input[type=file][accept=".stl,.ply"]').setInputFiles([`${DATA}${golden.scans.upper}`, `${DATA}${golden.scans.lower}`]);
await waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2, null, 300000);

// ---- Frame: the click on 11's palatal surface (inside the outline); then the pontic frame on the arch.
await selectTooth(11);
await step('Tooth frame');
await settle();
// The view may still be moving into place: re-aim a few times, as a user would.
for (let i = 0; i < 3 && (await miss(wingSpec.seed)) >= 0.3; i++) await lookPalatal(wingSpec.seed);
expect((await miss(wingSpec.seed)) < 0.3, 'frame click lands on the palatal surface', `${(await miss(wingSpec.seed)).toFixed(3)} mm`);
await clickWorld(wingSpec.seed);
await waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 11)?.frame), null, 60000);
await waitFor(() => !document.querySelector('.bridge-panel .spinner'));
await page.getByRole('button', { name: /place pontics/i }).click();
await waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 12)?.frame));
await shot('02-frame');

// ---- Wing outline: the margin step, labelled for the wing; the scripted anchors, closed on the first.
const label = await page.getByRole('navigation', { name: 'Design steps' }).getByRole('button', { name: /Wing outline/ }).count();
expect(label === 1, 'the margin step is labelled "Wing outline" for the wing');
await step('Wing outline');
await waitFor(() => window.__dcad.tools.getState().surface === 'ready');
await settle();
const anchors = wingSpec.marginAnchors;
const misses = [];
for (const p of [...anchors, anchors[0]]) {
  let d = await miss(p);
  for (let i = 0; i < 3 && d >= 0.3; i++) {
    await lookPalatal(p);
    d = await miss(p);
  }
  misses.push(d);
  await clickWorld(p);
  await page.waitForTimeout(250);
}
expect(Math.max(...misses) < 0.3, 'every outline click lands on the tooth', misses.map((d) => d.toFixed(2)).join(' '));
await waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 11)?.margin), null, 60000);
await lookPalatal(wingSpec.seed);
await shot('03-wing-outline');

// ---- Insertion axis (common to the bridge's abutments: the wing).
await step('Insertion axis');
await waitFor(() => window.__dcad.tools.getState().axisReport?.bridge && !window.__dcad.tools.getState().busy);
const axis = await state(() => window.__dcad.tools.getState().axisReport);
expect(axis.marginUndercutCount === 0, 'no outline point in an undercut along the axis', `${axis.angleFromOcclusalDeg.toFixed(1)}° from occlusal`);
await shot('04-axis');

// ---- Propose bridge: the wing is derived, the pontic proposed; one undo entry.
await step('Crown proposal');
const past = await state(() => window.__dcad.design.getState().past.length);
await page.getByRole('button', { name: 'Propose bridge' }).click();
await waitFor(() => [11, 12].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.crown));
await bridgeIdle(2);
const proposed = await state(() => {
  const r = window.__dcad.bridge.getState().result;
  return {
    past: window.__dcad.design.getState().past.length,
    units: r.units.map((u) => ({ fdi: u.fdi, templateId: u.templateId, ok: u.validation.ok, printable: u.validation.printable })),
    wing: r.units.find((u) => u.fdi === 11).wing,
    connectors: r.connectors.map((c) => ({ height: +c.heightMm.toFixed(2), width: +c.widthMm.toFixed(2), clash: c.toothClearance?.clashSamples, failures: c.failures.map((f) => f.code) })),
  };
});
expect(proposed.past === past + 1, 'Propose bridge is one undo entry');
expect(proposed.units.every((u) => u.ok && u.printable) && proposed.units.find((u) => u.fdi === 11)?.templateId === 'maryland-wing', 'wing and pontic are printable closed solids', JSON.stringify(proposed.units));
const w = proposed.wing;
expect(Math.abs(w.thickness.minMm - 0.7) <= 0.02 && Math.abs(w.fit.meanMm - 0.03) <= 0.01 && !w.space?.conflict, 'wing: 0.7 mm, 0.03 mm gap, room against the antagonist', `thickness ${w.thickness.minMm.toFixed(3)}–${w.thickness.maxMm.toFixed(3)}, gap ${w.fit.meanMm.toFixed(4)}, space ${w.space?.minClearanceMm.toFixed(2)} mm, bonded ${w.area.bondedMm2.toFixed(1)} mm²`);
expect(proposed.connectors.length === 1 && proposed.connectors[0].failures.length === 0 && proposed.connectors[0].clash === 0, 'connector 11–12: no failure, clear of the tooth', JSON.stringify(proposed.connectors));
await settle();
await lookPalatal(wingSpec.seed);
await shot('05-proposal');

// ---- Adapt: the pontic's occlusion and its free (distal) contact to 13; the wing panel; then Check bridge.
await step('Adapt');
await bridgeIdle(2);
await selectTooth(12);
await page.getByRole('button', { name: 'Adapt occlusion' }).click();
await waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 12).steps.adapt === 'done');
await bridgeIdle(2);
const distal = page.getByRole('button', { name: 'Adapt distal contact' });
if (await distal.isEnabled()) {
  await distal.click();
  await waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 12).crown.adapt?.distal));
  await bridgeIdle(2);
} else log('12: no distal neighbour in the frame');
await selectTooth(11);
await page.getByRole('heading', { name: 'Wing 11' }).waitFor();
await page.getByRole('button', { name: /check bridge|check again/i }).click();
await waitFor(() => {
  const c = window.__dcad.bridge.getState().check;
  return c.current && !c.running;
});
const check = await state(() => {
  const c = window.__dcad.bridge.getState().check.result;
  return { ok: c.union?.checks.ok, union: c.union && c.union.checks.union, wings: c.union?.checks.wings, failures: c.union?.checks.failures, error: c.unionError };
});
expect(Boolean(check.ok) && check.union.components === 1 && check.union.genus === 0 && check.union.printable, 'Check bridge: one printable solid of genus 0, every check passes', JSON.stringify({ failures: check.failures, error: check.error }));
await page.locator('#wing-head').evaluate((el) => {
  const panel = el.closest('aside');
  panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
});
await shot('06-adapt-wing');

// ---- Finalize and export.
await step('Finalize');
await waitFor(() => {
  const c = window.__dcad.bridge.getState().check;
  return c.current && !c.running && !document.querySelector('.readiness .detail')?.textContent?.includes('Measuring');
});
await page.waitForTimeout(500);
const head = await page.locator('#readiness-head').innerText();
const rows = await state(() =>
  Object.fromEntries(
    [...document.querySelectorAll('.readiness-group')].map((g) => [
      g.querySelector('summary').firstChild.textContent.trim(),
      [...g.querySelectorAll('li')].map((li) => [li.querySelector('span').firstChild.textContent.trim(), li.className, li.querySelector('.detail')?.textContent ?? '']),
    ]),
  ),
);
expect(Boolean(rows['11 · wing']?.some(([l]) => l === 'Space for the wing')), 'Finalize lists the wing rows', JSON.stringify(rows['11 · wing']));
log('readiness:', head, JSON.stringify(rows));
await shot('07-finalize');
const exportButton = page.getByRole('button', { name: /^Export STL/ });
const exportLabel = await exportButton.innerText();
const [stl] = await Promise.all([
  page.waitForEvent('download'),
  (async () => {
    await exportButton.click();
    if (exportLabel.includes('anyway')) await page.getByRole('button', { name: 'Export STL anyway', exact: true }).click();
  })(),
]);
const stlPath = `${OUT}${stl.suggestedFilename()}`;
await stl.saveAs(stlPath);
const [info] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Construction info' }).click()]);
const infoPath = `${OUT}${info.suggestedFilename()}`;
await info.saveAs(infoPath);
const sidecar = JSON.parse(readFileSync(infoPath, 'utf8'));
const wingInfo = sidecar.units.find((u) => u.fdi === 11)?.wing;
expect(Boolean(wingInfo?.area?.bondedMm2 > 0 && wingInfo.thicknessMm && sidecar.units.find((u) => u.fdi === 11).margin), 'sidecar: wing outline, thickness, bonded and blocked-out area', JSON.stringify(wingInfo?.area));

// Export all (the Finalize step's zip of every restoration): the Maryland bridge as one merged STL with the wing in
// its sidecar, ready to mill.
const all = await state(async () => {
  const { exportAll } = await import('/src/ui/steps/restorations.ts');
  const r = await exportAll(window.__dcad.design.getState().doc);
  return {
    ready: r.ready,
    zip: r.zip.fileName,
    restorations: r.restorations.map((x) => ({ name: x.name, stls: x.stls.map((s) => s.file), open: x.open, skipped: x.skipped, wing: Boolean(x.info?.units?.find((u) => u.fdi === 11)?.wing) })),
  };
});
const maryland = all.restorations[0];
expect(
  all.restorations.length === 1 && maryland.name === 'Maryland bridge 12–11' && maryland.stls.length === 1 && maryland.wing && all.ready,
  'Export all: the Maryland bridge as one STL with the wing in its sidecar, ready to mill',
  JSON.stringify(all),
);

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
expect(v.ok && topo.components === 1 && topo.genus === 0, `exported ${stl.suggestedFilename()}: one closed solid of genus 0`, JSON.stringify({ triangles: v.triangles, volume: +v.signedVolumeMm3.toFixed(1), components: topo.components, genus: topo.genus }));

expect(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
await browser.close();
log(failures.length ? `${failures.length} FAILED: ${failures.join('; ')}` : 'all checks passed');
process.exit(failures.length ? 1 : 0);
