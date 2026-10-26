// Bridge mode in the app (specs/2026-10-25-bridge-mode.md), offline, headless Chrome.
// 1. Posterior 35–[36]–37 on data/synthetic/lower-bridge.stl + upper.stl, through every step in the UI: setup
//    (chart + pontic switch), abutment frame clicks, align to arch, place pontics, live-wire margins, common axis,
//    Propose bridge (one undo entry), click-to-activate and a nudge on the pontic, adaptation, a connector edit,
//    Check bridge, Finalize, and the export: the downloaded STL must be one closed solid of genus 0 (parsed here in
//    Node with the repo's STL reader and validateClosedMesh / meshTopology).
// 2. Anterior [12]–11–21–[22] on upper-anterior-bridge.stl + lower.stl up to Propose bridge (screenshot).
// Run with type stripping (the STL check imports the geometry sources):
//   pnpm --filter @dcad/web fixtures && pnpm --filter @dcad/e2e bridge
// APP_URL (default http://localhost:5173/app/) is the editor; E2E_OUT the screenshot folder (default out/e2e/bridge/);
// E2E_ONLY=posterior or anterior runs one part.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${resolve(process.env.E2E_OUT ?? `${ROOT}out/e2e/bridge`)}/`;
mkdirSync(OUT, { recursive: true });
const DATA = `${ROOT}data/synthetic/`;
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const ALONG = 1000; // the fixtures' resolution (tools/fixtures/generate.mts)
const log = (...a) => console.log('[bridge]', ...a);
const failures = [];
/** 'posterior' or 'anterior' runs only that part. */
const ONLY = process.env.E2E_ONLY;
const expect = (ok, what, detail = '') => {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what);
};
for (const f of ['lower-bridge.stl', 'upper.stl', 'upper-anterior-bridge.stl', 'lower.stl']) {
  if (!existsSync(DATA + f)) throw new Error(`Missing ${DATA + f}: run pnpm --filter @dcad/web fixtures`);
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
    waitFor: (fn, arg, timeout = 240000) => page.waitForFunction(fn, arg, { timeout, polling: 150 }),
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
    project: (p) => page.evaluate((q) => window.__dcad.viewer.project(q), p),
    /**
     * Click a world point once the view shows it. settle() can return before a view change has rendered its first
     * frame, and a click in the previous view lands on whatever hides the point. So wait until the surface under the
     * point's projection is the point itself, within 0.3 mm (`objectIds` limits the pick; as in ai-bridge.mjs).
     * `guard: false` clicks at once, for a target that is not on a surface.
     */
    clickWorld: async (p, { objectIds, guard = true } = {}) => {
      for (let i = 0; guard && i < 40; i++) {
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
    tooth: (fdi) => page.evaluate((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f), fdi),
    unitButton: (fdi) => page.locator(`.bridge-units button[title="Make ${fdi} the active unit"]`).first(),
    selectTooth: (fdi) => page.getByLabel('Tooth', { exact: true }).selectOption(String(fdi)),
    /** Scroll the side panel (only) so `selector` is at its top. */
    panelTo: (selector) =>
      page.locator(selector).first().evaluate((el) => {
        const panel = el.closest('aside');
        panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
      }),
    synthetic: (fn, arg) => page.evaluate(async ([f, a]) => (await import('/src/geometry/synthetic.ts'))[f](a), [fn, arg]),
  };
  await page.goto(APP_URL);
  await page.getByRole('button', { name: /continue offline/i }).click();
  return h;
}

async function loadScans(h, files) {
  await h.step('Scans');
  await h.page.locator('input[type=file][accept=".stl,.ply"]').setInputFiles(files.map((f) => DATA + f));
  await h.waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2, null, 300000);
}

/** Click the synthetic prep of each abutment in the occlusal view (estimateFrame). */
async function frameAbutments(h, abutments) {
  await h.step('Tooth frame');
  for (const fdi of abutments) {
    await h.selectTooth(fdi);
    await h.page.keyboard.press('1');
    await h.settle();
    await h.clickWorld(await h.synthetic('syntheticPrepSeed', { fdi, along: ALONG }), { objectIds: [fdi < 30 ? 'upper' : 'lower'] });
    await h.waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.frame), fdi, 60000);
  }
}

/** Live-wire margin on each abutment: 8 clicks on the analytic synthetic margin, then close on the first. */
async function traceMargins(h, abutments) {
  for (const fdi of abutments) {
    await h.selectTooth(fdi); // a pontic has no Margin step: pick the abutment first
    await h.step('Margin');
    await h.waitFor(() => window.__dcad.tools.getState().surface === 'ready');
    await h.settle();
    const ring = await h.synthetic('syntheticPrepMargin', { fdi, along: ALONG, samples: 8 });
    const pts = [];
    for (let i = 0; i < ring.length; i += 3) pts.push([ring[i], ring[i + 1], ring[i + 2]]);
    // Each click must land on the margin point, not on a wall in front of it. Where the step's view hides a point (an
    // upper incisor seen along a tilted occlusal estimate), look at it from above its own side first, as a user would.
    const role = fdi < 30 ? 'upper' : 'lower';
    const centre = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
    const miss = (p) =>
      h.state(
        ([q, r]) => {
          const s = window.__dcad.viewer.project(q);
          const hit = s && window.__dcad.viewer.raycast(s.x, s.y, { objectIds: [r] });
          return hit ? Math.hypot(hit.point.x - q[0], hit.point.y - q[1], hit.point.z - q[2]) : Infinity;
        },
        [p, role],
      );
    const misses = [];
    let reaimed = 0;
    for (const p of [...pts, pts[0]]) {
      let d = await miss(p);
      if (d >= 0.3) {
        reaimed++;
        await h.state(
          ([q, c, f]) => {
            const occlusal = window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f).frame.occlusal;
            const out = [0, 1, 2].map((k) => q[k] - c[k]);
            const along = out.reduce((s, x, k) => s + x * occlusal[k], 0);
            const side = out.map((x, k) => x - along * occlusal[k]);
            const l = Math.hypot(...side) || 1;
            window.__dcad.viewer.focus(c, [0, 1, 2].map((k) => occlusal[k] + (0.8 * side[k]) / l), 32);
          },
          [p, centre, fdi],
        );
        await h.settle();
        d = await miss(p);
      }
      misses.push(d);
      await h.clickWorld(p, { objectIds: [role] });
      await h.page.waitForTimeout(250);
    }
    expect(Math.max(...misses) < 0.3, `margin ${fdi}: every click lands on the margin`, `${misses.map((d) => d.toFixed(2)).join(' ')} mm (${reaimed} re-aimed)`);
    await h.waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.margin), fdi, 60000);
    // The traced margin follows the analytic ring.
    const dev = await h.state(async ([f, along]) => {
      const { syntheticPrepMargin } = await import('/src/geometry/synthetic.ts');
      const ref = syntheticPrepMargin({ fdi: f, along, samples: 720 });
      const m = window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f).margin.points;
      let sum = 0;
      let max = 0;
      for (const { p } of m) {
        let best = Infinity;
        for (let i = 0; i < ref.length; i += 3) best = Math.min(best, Math.hypot(p[0] - ref[i], p[1] - ref[i + 1], p[2] - ref[i + 2]));
        sum += best;
        max = Math.max(max, best);
      }
      return { mean: sum / m.length, max };
    }, [fdi, ALONG]);
    expect(dev.max < 0.3, `margin ${fdi} follows the prep margin`, `mean ${dev.mean.toFixed(3)} mm, max ${dev.max.toFixed(3)} mm`);
  }
}

/** Every unit of the active bridge has its crown and the displayed bridge is computed. */
const bridgeIdle = (h, units) =>
  h.waitFor((n) => {
    const s = window.__dcad.bridge.getState();
    return s.result && !s.computing && s.result.units.length === n;
  }, units);

// ---- 1. Posterior 35–[36]–37 --------------------------------------------------------------------

if (ONLY !== 'anterior') {
  const h = await openApp('posterior');
  const { page } = h;

  // Setup: 35 and 37 as crowns from the chart, then 36 (the default tooth) becomes a pontic: it connects to both.
  await h.step('Case setup');
  await page.getByRole('button', { name: 'Tooth 35', exact: true }).click();
  await page.getByRole('button', { name: 'Tooth 37', exact: true }).click();
  await page.getByRole('group', { name: 'Restoration for 36' }).getByRole('button', { name: 'Pontic' }).click();
  const bridges = await h.state(() => window.__dcad.design.getState().doc.bridges);
  expect(JSON.stringify(bridges.map((b) => b.teeth)) === '[[35,36,37]]' && bridges[0].connectors.length === 2, 'setup: 35–[36]–37 with two connectors', JSON.stringify(bridges));

  await loadScans(h, ['lower-bridge.stl', 'upper.stl']);
  // Not the demo's scan: the prep of 35 is found on it and ringed (specs/2026-10-26-prep-finder.md).
  await h.step('Tooth frame');
  await h.selectTooth(35);
  const ringed = await h.waitFor(() => window.__dcad.viewer.overlays.has('demo:prep'), null, 60000).then(
    () =>
      h.state(async (along) => {
        const { syntheticPrepSeed } = await import('/src/geometry/synthetic.ts');
        const ring = window.__dcad.viewer.overlays.items.get('demo:prep').geometry;
        ring.computeBoundingSphere();
        const c = ring.boundingSphere.center;
        const top = syntheticPrepSeed({ fdi: 35, along });
        return Math.hypot(c.x - top[0], c.y - top[1], c.z - top[2]);
      }, ALONG),
    () => Infinity,
  );
  expect(ringed < 1, 'a scan that is not the demo rings the prep of 35', `${ringed.toFixed(2)} mm from its top`);
  await frameAbutments(h, [35, 37]);
  await h.shot('01-frames');

  // Align to arch, then place the pontic (one setFrame batch each).
  await h.unitButton(35).click();
  const align = page.getByRole('button', { name: 'Align to arch' });
  await h.waitFor(() => !document.querySelector('.bridge-panel .spinner') && document.querySelector('.bridge-changes'));
  const changes = await page.locator('.bridge-changes').innerText();
  if (await align.isEnabled()) {
    const pastBefore = await h.state(() => window.__dcad.design.getState().past.length);
    await align.click();
    const pastAfter = await h.state(() => window.__dcad.design.getState().past.length);
    expect(pastAfter === pastBefore + 1, 'align to arch is one undo entry', changes.replace(/\n/g, ' '));
  } else log('abutments already aligned:', changes.replace(/\n/g, ' '));
  await h.waitFor(() => !document.querySelector('.bridge-panel .spinner'));
  await page.getByRole('button', { name: /place pontics/i }).click();
  await h.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));
  const ponticFrame = (await h.tooth(36)).frame;
  const f35 = (await h.tooth(35)).frame;
  const towards35 = [0, 1, 2].map((k) => f35.origin[k] - ponticFrame.origin[k]);
  const len = Math.hypot(...towards35);
  const mesialDot = [0, 1, 2].reduce((s, k) => s + (ponticFrame.mesial[k] * towards35[k]) / len, 0);
  expect(mesialDot > 0.8, 'pontic 36 frame: mesial points toward 35 (FDI handedness)', mesialDot.toFixed(3));
  const f37 = (await h.tooth(37)).frame;
  const to35 = [0, 1, 2].map((k) => f35.origin[k] - f37.origin[k]);
  const aligned37 = [0, 1, 2].reduce((s, k) => s + (f37.mesial[k] * to35[k]) / Math.hypot(...to35), 0);
  expect(aligned37 > 0.8, 'aligned 37 frame: mesial points along the arch toward 35', aligned37.toFixed(3));
  await h.selectTooth(36);
  await h.settle();
  await h.shot('02-pontic-frame');
  // A click on the ridge while the pontic is active moves its centre there (a manual frame); undo it again.
  const target = [0, 1, 2].map((k) => ponticFrame.origin[k] + 1.0 * ponticFrame.mesial[k] + 2 * ponticFrame.occlusal[k]);
  const hit = await h.state((p) => {
    const v = window.__dcad.viewer;
    const s = v.project(p);
    const r = v.raycast(s.x, s.y, { objectIds: ['lower'] });
    return r && [r.point.x, r.point.y, r.point.z];
  }, target);
  await h.clickWorld(hit, { objectIds: ['lower'] });
  await h.waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).frame.source === 'manual', null, 30000).catch(() => {});
  const clicked = (await h.tooth(36)).frame;
  const offBy = Math.hypot(...[0, 1, 2].map((k) => clicked.origin[k] - hit[k]));
  expect(clicked.source === 'manual' && offBy < 0.5, 'a ridge click places the pontic centre', `${offBy.toFixed(3)} mm from the click`);
  await page.keyboard.press('Control+z');
  expect((await h.tooth(36)).frame.source === 'auto', 'undo restores the laid-out pontic frame');

  await traceMargins(h, [35, 37]);

  // Common axis: entering the step searches over both preps; setAxis on one sets both.
  await h.selectTooth(35);
  await h.step('Insertion axis');
  await h.waitFor(() => {
    const r = window.__dcad.tools.getState().axisReport;
    return r?.bridge && r.bridge.divergenceDeg !== null && !window.__dcad.tools.getState().busy;
  });
  const axis = await h.state(() => {
    const d = window.__dcad.design.getState().doc;
    const a = (f) => d.teeth.find((t) => t.fdi === f).axis;
    return { a35: a(35), a37: a(37), report: window.__dcad.tools.getState().axisReport };
  });
  expect(JSON.stringify(axis.a35) === JSON.stringify(axis.a37), 'one common axis on 35 and 37', JSON.stringify(axis.a35?.direction));
  expect(axis.report.marginUndercutCount === 0, 'no margin undercut on either abutment', JSON.stringify(axis.report.bridge.abutments.map((a) => [a.fdi, a.marginUndercutCount, +a.blockoutAreaMm2.toFixed(2)])));
  log('divergence', axis.report.bridge.divergenceDeg.toFixed(1), '°');
  await h.settle();
  await h.shot('03-axis');

  // Propose bridge: every unit in one batch (one undo entry).
  await h.step('Crown proposal');
  const pastBeforePropose = await h.state(() => window.__dcad.design.getState().past.length);
  await page.getByRole('button', { name: 'Propose bridge' }).click();
  await h.waitFor(() => [35, 36, 37].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.crown));
  await bridgeIdle(h, 3);
  const proposed = await h.state(() => {
    const s = window.__dcad.bridge.getState();
    return {
      past: window.__dcad.design.getState().past.length,
      units: s.result.units.map((u) => ({ fdi: u.fdi, kind: u.kind, ok: u.validation.ok, printable: u.validation.printable })),
      connectors: s.result.connectors.map((c) => ({ between: c.between, area: +c.areaMm2.toFixed(2), height: +c.heightMm.toFixed(2), failures: c.failures.length })),
      objects: [...window.__dcad.viewer.objects.keys()].filter((k) => k.startsWith('bridge:')),
    };
  });
  expect(proposed.past === pastBeforePropose + 1, 'Propose bridge is one undo entry');
  expect(proposed.units.every((u) => u.ok && u.printable), 'every unit is a printable closed solid', JSON.stringify(proposed.units));
  expect(proposed.connectors.length === 2 && proposed.connectors.every((c) => c.failures === 0), 'two connectors without failures', JSON.stringify(proposed.connectors));
  expect(proposed.objects.length === 5, 'viewer shows 3 units + 2 connectors', proposed.objects.join(' '));
  await h.settle();
  await h.shot('04-proposal');

  // Click the pontic in the viewport: it becomes the active unit (outlined, gizmo and status on it).
  const ponticTop = await h.state(() => {
    const u = window.__dcad.bridge.getState().result.units.find((x) => x.fdi === 36);
    const c = [0, 0, 0];
    let n = 0;
    for (let v = 0; v < u.moveWeights.length; v++) {
      if (u.moveWeights[v] < 0.95) continue;
      for (let k = 0; k < 3; k++) c[k] += u.positions[v * 3 + k];
      n++;
    }
    return c.map((x) => x / n);
  });
  await h.clickWorld(ponticTop, { guard: false }); // a mean of the pontic's top vertices: inside the crown, not on it
  await h.waitFor(() => window.__dcad.design.getState().activeFdi === 36, null, 10000).catch(() => {});
  expect((await h.state(() => window.__dcad.design.getState().activeFdi)) === 36, 'clicking the pontic makes it active');
  await page.waitForTimeout(300);
  await h.shot('04b-pontic-active');
  // A keyboard nudge moves only the active unit; undo restores it.
  const poses = () => h.state(() => Object.fromEntries(window.__dcad.design.getState().doc.teeth.map((t) => [t.fdi, t.crown?.pose.position])));
  const before = await poses();
  await page.keyboard.press('Shift+ArrowUp');
  await bridgeIdle(h, 3);
  const after = await poses();
  const buccal = ponticFrame.buccal;
  const moved = [0, 1, 2].reduce((s, k) => s + (after[36][k] - before[36][k]) * buccal[k], 0);
  expect(Math.abs(moved - 0.5) < 1e-6 && JSON.stringify(after[35]) === JSON.stringify(before[35]), 'Shift+↑ moves the pontic 0.5 mm buccal, nothing else', moved.toFixed(4));
  await page.keyboard.press('Control+z');
  await bridgeIdle(h, 3);
  expect(JSON.stringify(await poses()) === JSON.stringify(before), 'undo restores the pontic');

  // Adapt: occlusion on every unit (one batch), contacts on the free sides, a connector edit.
  await h.step('Adapt');
  await bridgeIdle(h, 3);
  await page.getByRole('button', { name: /Adapt occlusion, all 3 units/ }).click();
  await h.waitFor(() => [35, 36, 37].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f).steps.adapt === 'done'));
  await bridgeIdle(h, 3);
  for (const [fdi, side] of [[35, 'mesial'], [37, 'distal']]) {
    await h.unitButton(fdi).click();
    const button = page.getByRole('button', { name: `Adapt ${side} contact` });
    if (await button.isEnabled()) {
      await button.click();
      await h.waitFor(([f, s]) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f).crown.adapt?.[s]), [fdi, side]);
      await bridgeIdle(h, 3);
    } else log(`${fdi}: no ${side} neighbour in the frame`);
  }
  const occlusion = await h.state(() => window.__dcad.bridge.getState().result.units.map((u) => [u.fdi, u.adapt?.occlusion ? +u.adapt.occlusion.minClearanceMm.toFixed(3) : null]));
  expect(occlusion.every(([, c]) => c !== null), 'every unit is adapted to the antagonist', JSON.stringify(occlusion));
  const area = page.getByRole('listitem', { name: 'Connector 35–36' }).getByLabel('Area (mm²)');
  await area.fill('10');
  await area.press('Enter');
  await h.waitFor(() => window.__dcad.design.getState().doc.bridges[0].connectors[0].areaMm2 === 10);
  const adaptSteps = await h.state(() => window.__dcad.design.getState().doc.teeth.map((t) => [t.fdi, t.steps.adapt]));
  expect(adaptSteps.every(([, s]) => s === 'done'), 'a connector edit keeps the adaptation on', JSON.stringify(adaptSteps));
  await bridgeIdle(h, 3);
  await page.getByRole('button', { name: /check bridge|check again/i }).click();
  await h.waitFor(() => {
    const c = window.__dcad.bridge.getState().check;
    return c.current && !c.running;
  });
  const check = await h.state(() => {
    const c = window.__dcad.bridge.getState().check.result;
    return {
      ok: c.union?.checks.ok,
      union: c.union && { components: c.union.checks.union.components, genus: c.union.checks.union.genus, printable: c.union.checks.union.printable },
      connectors: c.union?.checks.connectors.map((x) => ({ between: x.between, measured: +x.measured.minAreaMm2.toFixed(2), target: x.targetAreaMm2, height: +x.measured.heightMm.toFixed(2), ok: x.ok })),
      failures: c.union?.checks.failures,
      error: c.unionError,
    };
  });
  expect(Boolean(check.union?.printable) && check.union.components === 1 && check.union.genus === 0, 'Check bridge: one printable solid of genus 0', JSON.stringify(check.union));
  expect(check.connectors?.every((c) => c.ok && c.measured >= c.target), 'connectors measured on the union reach their area and height', JSON.stringify(check.connectors));
  await h.unitButton(36).click();
  await h.panelTo('#connectors-head');
  await h.settle();
  await h.shot('05-adapt-connectors');

  // Finalize: per-unit readiness, connectors and the union under one gate; export the merged solid.
  await h.step('Finalize');
  await h.waitFor(() => {
    const c = window.__dcad.bridge.getState().check;
    return c.current && !c.running && !document.querySelector('.readiness .detail')?.textContent?.includes('Measuring');
  });
  await page.waitForTimeout(500);
  // Per unit: the rows it has. A side joined by a connector has no contact row (35 distal, 36 both, 37 mesial).
  const rows = await h.state(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.readiness-group')].map((g) => [
        g.querySelector('summary').firstChild.textContent.trim(),
        [...g.querySelectorAll('li')].map((li) => li.querySelector('span').firstChild.textContent.trim()),
      ]),
    ),
  );
  const contactRows = (title) => (rows[title] ?? []).filter((r) => /contact adapted/.test(r));
  expect(
    !contactRows('35 · crown').includes('Distal contact adapted') && contactRows('36 · pontic').length === 0 && !contactRows('37 · crown').includes('Mesial contact adapted'),
    'no contact rows on connected sides',
    JSON.stringify(Object.fromEntries(Object.keys(rows).map((k) => [k, contactRows(k)]))),
  );
  log('readiness:', await page.locator('#readiness-head').innerText());
  await h.panelTo('#readiness-head');
  await h.shot('06-finalize');
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
  expect(stl.suggestedFilename() === 'case-35-37-bridge.stl', 'export file name', stl.suggestedFilename());
  const [info] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Construction info' }).click()]);
  const infoPath = `${OUT}${info.suggestedFilename()}`;
  await info.saveAs(infoPath);
  const sidecar = JSON.parse(readFileSync(infoPath, 'utf8'));
  expect(
    sidecar.kind === 'bridge' && sidecar.units.length === 3 && sidecar.units.every((u) => u.kind && u.frame && u.crown.pose) && sidecar.axis && sidecar.connectors.every((c) => c.designed && c.measured),
    'sidecar: units (kind, frame, pose), common axis, connectors designed + measured',
    info.suggestedFilename(),
  );
  const exported = await page.locator('.export-done').innerText();
  expect(/Exported case-35-37-bridge\.stl at/.test(exported), 'Finalize shows the exported file', exported);

  // The downloaded STL, parsed in Node: one closed solid, one component, genus 0.
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
  expect(v.ok && v.closed && topo.components === 1 && topo.genus === 0, 'exported STL: one closed, oriented solid of genus 0', JSON.stringify({ triangles: v.triangles, closed: v.closed, ok: v.ok, volume: +v.signedVolumeMm3.toFixed(1), components: topo.components, genus: topo.genus }));
  await page.close();
}

// ---- 2. Anterior [12]–11–21–[22] (across the midline, two cantilever pontics) -------------------

if (ONLY !== 'posterior') {
  const h = await openApp('anterior');
  const { page } = h;
  await h.state(() => {
    const unit = (fdi, pontic) => ({ fdi, restoration: pontic ? 'pontic' : 'anatomic-crown', material: 'zirconia' });
    const s = window.__dcad.design.getState();
    s.dispatch({
      type: 'setCaseSetup',
      setup: { patientRef: '', notes: '', teeth: [unit(11), unit(12, true), unit(21), unit(22, true)], connections: [[11, 12], [11, 21], [21, 22]] },
    });
    s.setActiveFdi(11);
  });
  await loadScans(h, ['upper-anterior-bridge.stl', 'lower.stl']);
  await frameAbutments(h, [11, 21]);
  await h.selectTooth(11);
  await h.waitFor(() => !document.querySelector('.bridge-panel .spinner') && document.querySelector('.bridge-changes'));
  const align = page.getByRole('button', { name: 'Align to arch' });
  if (await align.isEnabled()) await align.click();
  await h.waitFor(() => !document.querySelector('.bridge-panel .spinner'));
  await page.getByRole('button', { name: /place pontics/i }).click();
  await h.waitFor(() => [12, 22].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.frame));
  await traceMargins(h, [11, 21]);
  await h.selectTooth(11);
  await h.step('Insertion axis');
  await h.waitFor(() => window.__dcad.tools.getState().axisReport?.bridge && !window.__dcad.tools.getState().busy);
  await h.step('Crown proposal');
  await page.getByRole('button', { name: 'Propose bridge' }).click();
  await h.waitFor(() => [11, 12, 21, 22].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.crown));
  await bridgeIdle(h, 4);
  const anterior = await h.state(() => {
    const r = window.__dcad.bridge.getState().result;
    return {
      units: r.units.map((u) => ({ fdi: u.fdi, kind: u.kind, ok: u.validation.ok, cantilever: u.layout?.cantilever ?? null })),
      connectors: r.connectors.map((c) => ({ between: c.between, area: +c.areaMm2.toFixed(2), height: +c.heightMm.toFixed(2), failures: c.failures.map((f) => f.code) })),
    };
  });
  expect(anterior.units.length === 4 && anterior.units.every((u) => u.ok), 'anterior: four closed units', JSON.stringify(anterior.units));
  expect(
    anterior.connectors.length === 3 && anterior.connectors.every((c) => c.failures.length === 0),
    'anterior: three connectors (incl. 11–21 across the midline) without failures',
    JSON.stringify(anterior.connectors),
  );
  await h.settle();
  await page.waitForTimeout(400); // the panel's button styles fade (0.15 s) after the proposal lands
  await h.shot('07-anterior-proposal');
  // Close-up from labial, centred on the bridge.
  await h.state(() => {
    const r = window.__dcad.bridge.getState().result;
    const c = [0, 1, 2].map((k) => r.units.reduce((s, u) => s + u.pose.position[k], 0) / r.units.length);
    const f = window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 11).frame;
    window.__dcad.viewer.focus(c, [0, 1, 2].map((k) => f.buccal[k] + 0.3 * f.occlusal[k]), 48);
  });
  await h.settle();
  await h.shot('08-anterior-labial');
  await page.close();
}

log('console errors', errors.length ? errors : 'none');
if (errors.length) failures.push('console errors');
await browser.close();
log(failures.length ? `${failures.length} FAILED: ${failures.join('; ')}` : 'all checks passed');
process.exit(failures.length ? 1 : 0);
