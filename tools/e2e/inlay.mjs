// Inlay bridge 35i–[36]–37i in the app (specs/2026-10-25-inlay-bridges.md), offline, headless Chrome: setup (Inlay on
// 35 and 37, 36 a pontic), the jaw, antagonist and pre-op scans (the pre-op scan starts hidden), the frame clicks on
// the cavity floors, place pontics, the "Cavity margin" live-wire (the golden case's scripted anchors), the common
// axis, Propose bridge (the outer surfaces from the pre-op scan), the source switch to the library tooth and back, the
// Adapt inlay panel and Check bridge, Finalize, and the export: the STL must be one closed solid of genus 0, the
// sidecar must carry the inlays, and Export all must name the inlay bridge. The scans and anchors are the synthetic
// golden case's:
//   pnpm --filter @dcad/pipeline-runner run --synthetic      # writes data/golden/synthetic-inlay-bridge-35-37
//   node --experimental-strip-types tools/e2e/inlay.mjs
// APP_URL (default http://localhost:5173/app/) is the editor; DATA the case folder; E2E_OUT the screenshot folder
// (default out/e2e/inlay/).
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Inlay, onlay, wing, implant and reduced sit behind "More types" in Case setup. */
const moreTypes = async (page, fdi) => {
  const more = page.getByRole('button', { name: `More types for ${fdi}` });
  if ((await more.count()) && (await more.getAttribute('aria-expanded')) !== 'true') await more.click();
};

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${resolve(process.env.E2E_OUT ?? `${ROOT}out/e2e/inlay`)}/`;
mkdirSync(OUT, { recursive: true });
const DATA = `${resolve(process.env.DATA ?? `${ROOT}data/golden/synthetic-inlay-bridge-35-37`)}/`;
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const log = (...a) => console.log('[inlay]', ...a);
const failures = [];
const expect = (ok, what, detail = '') => {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what);
};
if (!existsSync(`${DATA}case.json`)) throw new Error(`Missing ${DATA}case.json: run pnpm --filter @dcad/pipeline-runner run --synthetic`);
const golden = JSON.parse(readFileSync(`${DATA}case.json`, 'utf8'));
const inlays = golden.bridge.units.filter((u) => u.restoration === 'inlay');
const specOf = (fdi) => inlays.find((u) => u.fdi === fdi);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
page.on('console', (m) => {
  if (m.type() === 'error' && !/status of 50\d|Failed to load resource/.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (file) => page.screenshot({ path: `${OUT}${file}.png` });
const state = (fn, arg) => page.evaluate(fn, arg);
const waitFor = (fn, arg, timeout = 300000) => page.waitForFunction(fn, arg, { timeout, polling: 150 });
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
/** Distance from a world point to where a click on it lands on the lower scan (Infinity = no hit). */
const miss = (p) =>
  state((q) => {
    const v = window.__dcad.viewer;
    const s = v.project(q);
    const hit = s && v.raycast(s.x, s.y, { objectIds: ['lower'] });
    return hit ? Math.hypot(hit.point.x - q[0], hit.point.y - q[1], hit.point.z - q[2]) : Infinity;
  }, p);
/**
 * Click a world point once the view shows it (ai-bridge.mjs): settle() can return before a view change has rendered
 * its first frame, and a click in the previous view lands on whatever hid the point. So wait until the surface under
 * the point's projection is the point itself.
 */
const clickWorld = async (p) => {
  for (let i = 0; i < 40 && (await miss(p)) >= 0.3; i++) {
    await page.waitForTimeout(250);
    await settle();
  }
  const s = await state((q) => window.__dcad.viewer.project(q), p);
  await page.mouse.click(s.x, s.y);
};
/**
 * Make a cavity-margin point visible, as a user would: from above the tooth, else tilted toward the point's own side,
 * else from buccal or lingual (a proximal box wall next to a neighbour is hidden from its own side). A grazing view
 * lands the click beside the point, so look on until it lands within 0.1 mm. Returns the miss.
 */
const aim = async (p, fdi, centre) => {
  const look = (w) =>
    state(
      ([q, c, f, w]) => {
        const frame = window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f).frame;
        const out = [0, 1, 2].map((k) => q[k] - c[k]);
        const along = out.reduce((sum, x, k) => sum + x * frame.occlusal[k], 0);
        const side = out.map((x, k) => x - along * frame.occlusal[k]);
        const l = Math.hypot(...side) || 1;
        const dir = [0, 1, 2].map((k) => w[0] * frame.occlusal[k] + (w[1] * side[k]) / l + w[2] * frame.buccal[k]);
        window.__dcad.viewer.focus(q, dir, 30);
      },
      [p, centre, fdi, w],
    );
  let best = { d: await miss(p), w: null };
  if (best.d < 0.1) return best.d;
  for (const w of [[1, 0.8, 0], [1, 0, 0.8], [1, 0, -0.8], [1, 0.6, 0.6], [1, 0.6, -0.6], [1, 0, 0]]) {
    await look(w);
    await settle();
    const d = await miss(p);
    if (d < 0.1) return d;
    if (d < best.d) best = { d, w };
  }
  if (best.w) {
    await look(best.w);
    await settle();
  }
  return miss(p);
};
const bridgeIdle = (n) =>
  waitFor((k) => {
    const s = window.__dcad.bridge.getState();
    return s.result && !s.computing && s.result.units.length === k;
  }, n);
const inlayReports = () =>
  state(() =>
    window.__dcad.bridge
      .getState()
      .result.units.filter((u) => u.inlay)
      .map((u) => ({
        fdi: u.fdi,
        source: u.inlay.source,
        printable: u.validation.printable,
        marginFit: +u.inlay.marginFit.maxMm.toFixed(4),
        marginOk: u.inlay.marginFit.ok,
        isthmus: +u.inlay.isthmus.minMm.toFixed(3),
        isthmusOk: u.inlay.isthmus.ok,
        library: u.inlay.library ? { p95: +u.inlay.library.residual.p95Mm.toFixed(3), ok: u.inlay.library.ok } : null,
      })),
  );

await page.goto(APP_URL);
await page.getByRole('button', { name: /continue offline/i }).click();

// ---- Setup: 35 and 37 from the chart, 36 (the default tooth) a pontic, then 35 and 37 inlays.
await step('Case setup');
await page.getByRole('button', { name: 'Tooth 35', exact: true }).click();
await page.getByRole('button', { name: 'Tooth 37', exact: true }).click();
await page.getByRole('group', { name: 'Restoration for 36' }).getByRole('button', { name: 'Pontic' }).click();
for (const fdi of [35, 37]) {
  await moreTypes(page, fdi);
  await page.getByRole('group', { name: `Restoration for ${fdi}` }).getByRole('button', { name: 'Inlay' }).click();
}
const setup = await state(() => {
  const d = window.__dcad.design.getState().doc;
  return { teeth: d.setup.teeth.map((t) => [t.fdi, t.restoration]), bridges: d.bridges };
});
expect(
  JSON.stringify(setup.teeth) === '[[35,"inlay"],[36,"pontic"],[37,"inlay"]]' && JSON.stringify(setup.bridges.map((b) => b.teeth)) === '[[35,36,37]]',
  'setup: 35 and 37 inlays, 36 pontic, one bridge',
  JSON.stringify(setup),
);
await page.getByRole('group', { name: 'Restoration for 35' }).scrollIntoViewIfNeeded();
await shot('01-setup');

// ---- Scans: the jaw with the cavities, the antagonist and the pre-op scan (named by file); the pre-op scan is hidden.
await step('Scans');
await page.locator('input[type=file][accept=".stl,.ply"]').setInputFiles([golden.scans.lower, golden.scans.upper, golden.scans.preop].map((f) => DATA + f));
await waitFor(() => window.__dcad.design.getState().doc.scans.length === 3 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 3, null, 300000);
const scans = await state(() => ({
  roles: window.__dcad.design.getState().doc.scans.map((s) => s.role).sort(),
  preopVisible: window.__dcad.scene.getState().objects.find((o) => o.id === 'preop')?.visible,
}));
expect(JSON.stringify(scans.roles) === '["lower","preop","upper"]' && scans.preopVisible === false, 'scans: lower, upper and the pre-op scan, which starts hidden', JSON.stringify(scans));

// ---- Frames: a click on each cavity floor (occlusal view), then the pontic frame on the arch.
await step('Tooth frame');
for (const fdi of [35, 37]) {
  await selectTooth(fdi);
  await page.keyboard.press('1');
  await settle();
  await clickWorld(specOf(fdi).seed);
  await waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.frame), fdi, 60000);
}
await waitFor(() => !document.querySelector('.bridge-panel .spinner'));
const align = page.getByRole('button', { name: 'Align to arch' });
if ((await align.count()) && (await align.isEnabled())) await align.click();
await waitFor(() => !document.querySelector('.bridge-panel .spinner'));
await page.getByRole('button', { name: /place pontics/i }).click();
await waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));
await shot('02-frames');

// ---- Cavity margin: the margin step, labelled for the inlay; the scripted anchors, closed on the first.
await selectTooth(35);
const label = await page.getByRole('navigation', { name: 'Design steps' }).getByRole('button', { name: /Cavity margin/ }).count();
expect(label === 1, 'the margin step is labelled "Cavity margin" for an inlay');
for (const fdi of [35, 37]) {
  await selectTooth(fdi);
  await step('Cavity margin');
  await waitFor(() => window.__dcad.tools.getState().surface === 'ready');
  await settle();
  const anchors = specOf(fdi).marginAnchors;
  const centre = [0, 1, 2].map((k) => anchors.reduce((s, p) => s + p[k], 0) / anchors.length);
  const misses = [];
  for (const p of [...anchors, anchors[0]]) {
    misses.push(await aim(p, fdi, centre));
    await clickWorld(p);
    await page.waitForTimeout(250);
  }
  expect(Math.max(...misses) < 0.3, `cavity margin ${fdi}: every click lands on the margin`, misses.map((d) => d.toFixed(2)).join(' '));
  await waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.margin), fdi, 60000);
  // The traced margin follows the analytic cavosurface edge.
  const ring = specOf(fdi).marginRing;
  const dev = await state(
    ([f, r]) => {
      const m = window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f).margin.points;
      let sum = 0;
      let max = 0;
      for (const { p } of m) {
        let best = Infinity;
        for (const q of r) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
        sum += best;
        max = Math.max(max, best);
      }
      return { mean: sum / m.length, max };
    },
    [fdi, ring],
  );
  expect(dev.max < 0.3, `cavity margin ${fdi} follows the cavosurface edge`, `mean ${dev.mean.toFixed(3)} mm, max ${dev.max.toFixed(3)} mm`);
  await page.keyboard.press('1');
  await settle();
  await shot(`03-cavity-margin-${fdi}`);
}

// ---- Insertion axis, common to both inlays.
await selectTooth(35);
await step('Insertion axis');
await waitFor(() => {
  const r = window.__dcad.tools.getState().axisReport;
  return r?.bridge && !window.__dcad.tools.getState().busy;
});
const axis = await state(() => {
  const d = window.__dcad.design.getState().doc;
  const a = (f) => d.teeth.find((t) => t.fdi === f).axis;
  return { a35: a(35), a37: a(37), report: window.__dcad.tools.getState().axisReport };
});
expect(JSON.stringify(axis.a35) === JSON.stringify(axis.a37) && axis.report.marginUndercutCount === 0, 'one common axis on both inlays, no margin point in an undercut', JSON.stringify(axis.a35?.direction));
await shot('04-axis');

// ---- Propose bridge: both inlays from the pre-op scan, the pontic proposed; one undo entry.
await step('Crown proposal');
const past = await state(() => window.__dcad.design.getState().past.length);
await page.getByRole('button', { name: 'Propose bridge' }).click();
await waitFor(() => [35, 36, 37].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.crown));
await bridgeIdle(3);
const proposed = await state(() => {
  const r = window.__dcad.bridge.getState().result;
  return {
    past: window.__dcad.design.getState().past.length,
    units: r.units.map((u) => ({ fdi: u.fdi, ok: u.validation.ok, printable: u.validation.printable })),
    connectors: r.connectors.map((c) => ({ height: +c.heightMm.toFixed(2), width: +c.widthMm.toFixed(2), failures: c.failures.map((f) => f.code) })),
  };
});
expect(proposed.past === past + 1, 'Propose bridge is one undo entry');
expect(proposed.units.every((u) => u.ok && u.printable), 'inlays and pontic are printable closed solids', JSON.stringify(proposed.units));
const preop = await inlayReports();
expect(
  preop.length === 2 && preop.every((i) => i.source === 'preop' && i.marginOk && i.isthmusOk && i.marginFit <= 0.05),
  'both inlays from the pre-op scan meet the cavity margin within 0.05 mm, thick enough over the cavity floor',
  JSON.stringify(preop),
);
expect(
  proposed.connectors.length === 2 && proposed.connectors.every((c) => c.failures.length === 0 && c.height >= 3 && c.width >= 3),
  'two connectors of at least 3 × 3 mm in the proximal boxes, no failure',
  JSON.stringify(proposed.connectors),
);
await selectTooth(35);
expect(await page.getByText(/follows the pre-op scan/).isVisible(), 'a pre-op inlay has no nudge pad (nothing to move)');
await page.keyboard.press('1');
await settle();
await shot('05-proposal');

// ---- The outer source: the library tooth on 35 (re-proposed, the fit reported, movable), then the pre-op scan again.
const sourceGroup = page.getByRole('group', { name: 'Outer surface of 35' });
await sourceGroup.getByRole('button', { name: 'Library tooth' }).click();
await waitFor(() => {
  const u = window.__dcad.bridge.getState().result?.units.find((x) => x.fdi === 35);
  return u?.inlay?.source === 'library' && !window.__dcad.bridge.getState().computing && window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 35).crown;
});
const library = (await inlayReports()).find((i) => i.fdi === 35);
expect(library.source === 'library' && library.printable && library.library?.ok && library.marginOk, '35 from the library tooth: fitted to the tooth around the cavity, meets the margin', JSON.stringify(library));
expect(!(await page.getByText(/follows the pre-op scan/).count()), 'a library inlay can be moved (nudge pad shown)');
await shot('06-library-source');
await sourceGroup.getByRole('button', { name: 'Pre-op scan' }).click();
await waitFor(() => {
  const u = window.__dcad.bridge.getState().result?.units.find((x) => x.fdi === 35);
  return u?.inlay?.source === 'preop' && !window.__dcad.bridge.getState().computing && window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 35).crown;
});
expect((await tooth(35)).outerSource === 'preop', '35 back on the pre-op scan');

// ---- Adapt: the pontic's occlusion; the inlay panel; then Check bridge.
await step('Adapt');
await bridgeIdle(3);
await selectTooth(36);
await page.getByRole('button', { name: 'Adapt occlusion' }).click();
await waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).steps.adapt === 'done');
await bridgeIdle(3);
await selectTooth(35);
await page.getByRole('heading', { name: 'Inlay 35' }).waitFor();
await page.getByRole('button', { name: /check bridge|check again/i }).click();
await waitFor(() => {
  const c = window.__dcad.bridge.getState().check;
  return c.current && !c.running;
});
const check = await state(() => {
  const c = window.__dcad.bridge.getState().check.result;
  return { ok: c.union?.checks.ok, union: c.union && c.union.checks.union, inlays: c.union?.checks.inlays, failures: c.union?.checks.failures, error: c.unionError };
});
expect(
  Boolean(check.ok) && check.union.components === 1 && check.union.genus === 0 && check.union.printable && check.inlays?.length === 2,
  'Check bridge: one printable solid of genus 0, every check passes (inlay checks included)',
  JSON.stringify({ union: check.union && { printable: check.union.printable, genus: check.union.genus, selfIntersections: check.union.selfIntersections }, failures: check.failures, error: check.error }),
);
await page.locator('#inlay-head').evaluate((el) => {
  const panel = el.closest('aside');
  panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
});
await shot('07-adapt-inlay');

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
const inlayRows = rows['35 · inlay'] ?? [];
expect(
  inlayRows.some(([l, c]) => l === 'Meets the cavity margin' && c === 'pass') && !inlayRows.some(([l]) => l === 'Occlusion adapted'),
  'Finalize lists the inlay rows (no adaptation rows)',
  JSON.stringify(inlayRows),
);
log('readiness:', head, JSON.stringify(rows));
await shot('08-finalize');
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
const inlayInfo = [35, 37].map((f) => sidecar.units.find((u) => u.fdi === f)?.inlay);
expect(
  inlayInfo.every((i) => i?.outerSource === 'preop' && i.marginFitMm.max <= 0.05 && i.isthmusMm.min >= 1.5) && Boolean(sidecar.validation?.inlays),
  'sidecar: outer source, margin fit and isthmus of both inlays',
  JSON.stringify(inlayInfo.map((i) => i && { source: i.outerSource, marginFit: i.marginFitMm.max, isthmus: i.isthmusMm.min })),
);

// Export all: the inlay bridge as one merged STL with the inlays in its sidecar.
const all = await state(async () => {
  const { exportAll } = await import('/src/ui/steps/restorations.ts');
  const r = await exportAll(window.__dcad.design.getState().doc);
  return {
    ready: r.ready,
    restorations: r.restorations.map((x) => ({ name: x.name, stls: x.stls.map((s) => s.file), open: x.open, skipped: x.skipped, inlays: (x.info?.units ?? []).filter((u) => u.inlay).length })),
  };
});
const bridge = all.restorations[0];
expect(
  all.restorations.length === 1 && bridge.name === 'inlay bridge 35–37' && bridge.stls.length === 1 && bridge.inlays === 2 && !bridge.skipped,
  'Export all: the inlay bridge as one STL with both inlays in its sidecar',
  JSON.stringify(all),
);
if (!all.ready) log('Export all: open checks', JSON.stringify(bridge.open));

// A single inlay: 35's crown request (as a single restoration designs it) through the worker's designCrown.
const single = await state(async () => {
  const { crownRequest } = await import('/src/tools/crownTool.ts');
  const { toothContextFor } = await import('/src/tools/context.ts');
  const { analysis } = await import('/src/workers/geometryClient.ts');
  const request = crownRequest(toothContextFor(35), true, 'none');
  const r = await analysis.designCrownUnlatched(request);
  return { request: request.inlay, printable: r.validation.printable, source: r.inlay?.source, marginFit: r.inlay?.marginFit.maxMm, isthmus: r.inlay?.isthmus.minMm };
});
expect(
  single.request?.type === 'inlay' && single.source === 'preop' && single.printable && single.marginFit <= 0.05 && single.isthmus >= 1.5,
  'a single inlay (designCrown): printable, meets the margin, thick enough',
  JSON.stringify(single),
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
