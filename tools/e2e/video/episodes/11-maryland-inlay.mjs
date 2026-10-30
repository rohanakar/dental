// Episode 11: a Maryland bridge 11w–[12] by auto-design (as ai-maryland.mjs), then an inlay bridge 35i–[36]–37i step by
// step (as inlay.mjs), on the synthetic golden cases (pnpm --filter @dcad/pipeline-runner run --synthetic).
import { existsSync, readFileSync } from 'node:fs';
import { GOLDEN } from '../director.mjs';
import { stlSolid } from '../lib.mjs';

const MARYLAND = `${GOLDEN}synthetic-maryland-11-12/`;
const INLAY = `${GOLDEN}synthetic-inlay-bridge-35-37/`;
const golden = (dir) => {
  if (!existsSync(`${dir}case.json`)) throw new Error(`Missing ${dir}case.json: run pnpm --filter @dcad/pipeline-runner run --synthetic`);
  return JSON.parse(readFileSync(`${dir}case.json`, 'utf8'));
};

/** Look at `p` from below and behind: the palatal side of an upper incisor, as a user would turn the view. */
const lookPalatal = async (d, p) => {
  await d.state((q) => window.__dcad.viewer.focus(q, [0, -0.55, -0.83], 30), p);
  await d.settle();
};

/** Distance from a world point to where a click on it lands on `id`'s scan (Infinity = no hit). */
const miss = (d, p, id) =>
  d.state(
    ([q, o]) => {
      const v = window.__dcad.viewer;
      const s = v.project(q);
      const hit = s && v.raycast(s.x, s.y, { objectIds: [o] });
      return hit ? Math.hypot(hit.point.x - q[0], hit.point.y - q[1], hit.point.z - q[2]) : Infinity;
    },
    [p, id],
  );

/**
 * Makes a cavity-margin point visible (inlay.mjs): from where the view is, else tilted toward the point's own side,
 * else from buccal or lingual (a proximal box wall next to a neighbour is hidden from its own side).
 */
const aim = async (d, p, fdi, centre) => {
  const look = (w) =>
    d.state(
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
  let best = { d: await miss(d, p, 'lower'), w: null };
  if (best.d < 0.1) return best.d;
  for (const w of [[1, 0.8, 0], [1, 0, 0.8], [1, 0, -0.8], [1, 0.6, 0.6], [1, 0.6, -0.6], [1, 0, 0]]) {
    await look(w);
    await d.settle();
    const m = await miss(d, p, 'lower');
    if (m < 0.1) return m;
    if (m < best.d) best = { d: m, w };
  }
  if (best.w) {
    await look(best.w);
    await d.settle();
  }
  return miss(d, p, 'lower');
};

/** The second tooth's trace, brisker: the same aim, a short cursor move and no pause. */
async function quickClick(d, p, fdi, centre) {
  const m = await aim(d, p, fdi, centre);
  for (let i = 0; i < 20 && (await miss(d, p, 'lower')) >= 0.3; i++) {
    await d.pause(200);
    await d.settle();
  }
  const s = await d.project(p);
  await d.moveTo(s.x, s.y, { ms: 160 });
  await d.page.mouse.click(s.x, s.y);
  await d.pause(40);
  return m;
}


const bridgeIdle = (d, n) =>
  d.waitFor((k) => {
    const s = window.__dcad.bridge.getState();
    return s.result && !s.computing && s.result.units.length === k;
  }, n);

/** Finalize's export: Export STL (or "anyway" when a check is open), checked as one closed solid of genus 0. */
async function exportSolid(d, what) {
  const { page } = d;
  const button = page.getByRole('button', { name: /^Export STL/ });
  await button.waitFor();
  const label = await button.innerText();
  const stl = await d.download(async () => {
    await d.click(button);
    if (label.includes('anyway')) await d.click(page.getByRole('button', { name: 'Export STL anyway', exact: true }));
  });
  const solid = await stlSolid(stl);
  await d.check(solid.ok && solid.components === 1 && solid.genus === 0, `The exported ${what} is one closed solid`, solid);
}

/** Waits for Finalize's readiness to be measured and returns its headline. */
async function readiness(d) {
  await d.waitFor(() => {
    const c = window.__dcad.bridge.getState().check;
    return c.current && !c.running && !document.querySelector('.readiness .detail')?.textContent?.includes('Measuring');
  });
  await d.pause(500);
  return d.page.locator('#readiness-head').innerText();
}

export default {
  id: '11-maryland-inlay',
  title: 'Maryland and inlay bridges',
  summary: 'Two bridges that hold on without crowning the neighbours: a Maryland bridge on a bonded wing, designed in one click, and an inlay bridge anchored in two cavities, step by step.',
  learn: ['Set up a wing and an inlay in Case setup', 'Auto-design a Maryland bridge from one click', 'Trace a cavity margin and propose inlays from the pre-op scan', 'Check the bridge and export one solid'],
  start: 'app/',
  intro: 'Not every bridge needs crowns on its neighbours. In this episode we design a Maryland bridge on a bonded wing, then an inlay bridge anchored in two cavities.',
  outro: 'Both bridges came out as one closed solid each, ready to mill.',
  async setup(d) {
    await d.page.waitForFunction(() => Boolean(window.__dcad?.tools));
    await d.page.getByRole('button', { name: /continue offline/i }).click();
  },
  async run(d) {
    const { page } = d;
    const chart = (fdi) => page.getByRole('button', { name: `Tooth ${fdi}`, exact: true });
    const kind = (fdi, label) => page.getByRole('group', { name: `Restoration for ${fdi}` }).getByRole('button', { name: label });

    // ---- Maryland bridge 11w–[12] -------------------------------------------------------------------------------------
    const mary = golden(MARYLAND);
    const wing = mary.bridge.units.find((u) => u.restoration === 'maryland-wing');
    d.chapter('Maryland: case setup');
    await d.step('Case setup');
    await d.say('A Maryland bridge replaces a missing tooth with a pontic, held by a thin metal or zirconia wing bonded to the back of the neighbour.');
    await d.say('Pick both teeth on the chart. Make 12 the pontic. Then open More types for 11 and choose Wing.', { wait: false });
    await d.click(chart(11));
    await d.click(chart(12));
    await d.click(kind(12, 'Pontic'));
    await d.moreTypes(11);
    await d.click(kind(11, 'Wing'));
    await d.hush();
    await d.say('Tooth 36 came with the new case. Click it to take it out.', { wait: false });
    await d.click(chart(36));
    const setup = await d.state(() => {
      const doc = window.__dcad.design.getState().doc;
      return { teeth: doc.setup.teeth.map((t) => [t.fdi, t.restoration]), bridges: doc.bridges.map((b) => b.teeth) };
    });
    await d.check(JSON.stringify(setup.teeth) === '[[11,"maryland-wing"],[12,"pontic"]]' && setup.bridges.length === 1, 'Case setup: 11 is a wing, 12 the pontic, one bridge', setup);
    await d.hush();

    d.chapter('Maryland: scans');
    await d.say('On the Scans step, drop the upper and lower scans. Files named upper or lower are sorted for you.', { wait: false });
    await d.loadScans([`${MARYLAND}${mary.scans.upper}`, `${MARYLAND}${mary.scans.lower}`]);
    const roles = await d.state(() => window.__dcad.design.getState().doc.scans.map((s) => s.role).sort());
    await d.check(JSON.stringify(roles) === '["lower","upper"]', 'Both scans are loaded and sorted by jaw', roles);
    await d.hush();

    d.chapter('Maryland: one click');
    await d.selectTooth(11);
    await d.step('Tooth frame');
    const oneClick = page.getByLabel(/One-click bridge/);
    await d.say('On Tooth frame, tick One-click bridge. Then one click on the palatal surface of 11, where the wing will sit, designs the whole bridge.', { wait: false });
    await d.click(oneClick);
    if (!(await oneClick.isChecked())) await oneClick.check();
    await d.blur();
    await d.settle();
    await d.hush();
    await d.say('Turn the view to look at the back of 11.', { wait: false });
    for (let i = 0; i < 3 && (i === 0 || (await miss(d, wing.seed, 'upper')) >= 0.3); i++) await lookPalatal(d, wing.seed);
    await d.hush();
    const pastBefore = await d.state(() => window.__dcad.design.getState().past.length);
    await d.say('One click on the back of 11 starts it. Auto-design frames the tooth, places the pontic, draws the wing outline, and proposes the bridge.', { wait: false });
    await d.clickWorld(wing.seed, { objectIds: ['upper'] });
    await d.waitFor(() => {
      const o = window.__dcad.orchestrator.getState();
      return !o.running && (o.pendingReview || o.error) && o.steps.length > 0;
    });
    const run = await d.state(() => {
      const o = window.__dcad.orchestrator.getState();
      return { error: o.error, complete: o.complete, rows: o.steps.map((s) => `${s.key}:${s.status}`), failed: o.steps.flatMap((s) => s.qa.filter((c) => !c.passed).map((c) => `${s.key} ${c.id}`)) };
    });
    await d.check(run.rows.includes('classical.wing-outline@1:11:passed'), 'The wing gets an outline, not a crown margin', run.rows);
    await d.check(run.complete && !run.error, 'Every gate of the Maryland draft passes', { error: run.error, failed: run.failed });
    await d.hush();

    d.chapter('Maryland: review and accept');
    await d.settle();
    await lookPalatal(d, wing.seed);
    const banner = page.getByRole('region', { name: 'Auto-design' }).locator('.auto-banner');
    await d.say('Here is the wing on the back of 11, joined to the pontic. The review lists the wing checks: its thickness, its gap and its room against the bite.', { wait: false });
    await d.point(banner, 5000);
    await d.hush();
    await d.say('Accept keeps the whole bridge as one undo step.', { wait: false });
    await d.click(banner.getByRole('button', { name: 'Accept', exact: true }));
    const after = await d.state(() => {
      const s = window.__dcad.design.getState();
      const t11 = s.doc.teeth.find((t) => t.fdi === 11);
      return { past: s.past.length, outline: t11.margin?.anchors.length ?? 0, crowns: s.doc.teeth.filter((t) => t.crown).length };
    });
    await d.check(after.past === pastBefore + 1 && after.outline >= 12 && after.crowns === 2, 'Accept keeps the wing and the pontic in one undo step', after);
    await d.hush();
    await d.say('To change where the wing ends, open the Wing outline step and drag its points, like any margin.', { wait: false });
    await d.point(page.getByRole('navigation', { name: 'Design steps' }).getByRole('button', { name: /Wing outline/ }), 2500);
    await d.hush();

    d.chapter('Maryland: finalize');
    await d.step('Finalize');
    const head = await readiness(d);
    await d.check(/Ready to mill/.test(head), 'Finalize: the Maryland bridge is ready to mill', head);
    await d.say('Finalize measures everything again. The bridge is ready to mill, so export it as one STL.', { wait: false });
    await d.point(page.locator('#readiness-head'), 2200);
    await exportSolid(d, 'Maryland bridge');
    await d.hush();

    // ---- Inlay bridge 35i–[36]–37i ----------------------------------------------------------------------------------
    const inl = golden(INLAY);
    const specOf = (fdi) => inl.bridge.units.find((u) => u.fdi === fdi);
    d.chapter('Inlay bridge: case setup');
    await d.goto('app/');
    await page.waitForFunction(() => Boolean(window.__dcad?.tools));
    await d.say('Now an inlay bridge, in a new case.', { wait: false });
    await d.click(page.getByRole('button', { name: /continue offline/i }));
    await d.step('Case setup');
    await d.hush();
    await d.say('Pick 35 and 37 on the chart, and make 36 the pontic. Under More types, choose Inlay for 35 and 37.', { wait: false });
    await d.click(chart(35));
    await d.click(chart(37));
    await d.click(kind(36, 'Pontic'));
    for (const fdi of [35, 37]) {
      await d.moreTypes(fdi);
      await d.click(kind(fdi, 'Inlay'));
    }
    const inlaySetup = await d.state(() => {
      const doc = window.__dcad.design.getState().doc;
      return { teeth: doc.setup.teeth.map((t) => [t.fdi, t.restoration]), bridges: doc.bridges.map((b) => b.teeth) };
    });
    await d.check(JSON.stringify(inlaySetup.teeth) === '[[35,"inlay"],[36,"pontic"],[37,"inlay"]]' && inlaySetup.bridges.length === 1, 'Case setup: inlays on 35 and 37, 36 the pontic', inlaySetup);
    await d.hush();

    d.chapter('Inlay bridge: three scans');
    await d.say('Import three scans: the jaw with the cavities, the opposing jaw, and a pre-op scan taken before the teeth were cut. The inlays copy their outer surface from it.', { wait: false });
    await d.loadScans([inl.scans.lower, inl.scans.upper, inl.scans.preop].map((f) => `${INLAY}${f}`), { count: 3 });
    const scans = await d.state(() => ({
      roles: window.__dcad.design.getState().doc.scans.map((s) => s.role).sort(),
      preopVisible: window.__dcad.scene.getState().objects.find((o) => o.id === 'preop')?.visible,
    }));
    await d.check(JSON.stringify(scans.roles) === '["lower","preop","upper"]' && scans.preopVisible === false, 'Three scans, and the pre-op scan starts hidden', scans);
    await d.hush();

    d.chapter('Inlay bridge: frames');
    await d.step('Tooth frame');
    await d.say('On Tooth frame, look from above and click the floor of each cavity: 35 first, then 37.', { wait: false });
    for (const fdi of [35, 37]) {
      await d.selectTooth(fdi);
      await d.blur();
      await d.press('1', 'Occlusal view');
      await d.settle();
      await d.clickWorld(specOf(fdi).seed, { objectIds: ['lower'] });
      await d.waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.frame), fdi, 60000);
    }
    await d.hush();
    await d.waitFor(() => !document.querySelector('.bridge-panel .spinner'));
    const align = page.getByRole('button', { name: 'Align to arch' });
    await d.say('Align to arch lines the frames up with the arch, and Place pontics frames 36 in the gap.', { wait: false });
    if ((await align.count()) && (await align.isEnabled())) {
      await d.click(align);
      await d.waitFor(() => !document.querySelector('.bridge-panel .spinner'));
    }
    await d.click(page.getByRole('button', { name: /place pontics/i }));
    await d.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));
    const framed = await d.state(() => [35, 36, 37].filter((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.frame));
    await d.check(framed.length === 3, 'Both cavities and the pontic are framed', framed);
    await d.hush();

    d.chapter('Inlay bridge: cavity margins');
    for (const fdi of [35, 37]) {
      await d.selectTooth(fdi);
      await d.step('Cavity margin');
      await d.waitFor(() => window.__dcad.tools.getState().surface === 'ready');
      await d.settle();
      if (fdi === 35)
        await d.say('For an inlay, the margin step is the Cavity margin. Click round the edge of the cavity, where the cut meets the tooth, and close on the first point.', { wait: false });
      else await d.say('Then trace 37 the same way. The line between your clicks follows the edge by itself.', { wait: false });
      // Every other scripted anchor: the live-wire follows the cavity edge between them (checked below).
      const anchors = specOf(fdi).marginAnchors.filter((_, i) => i % 2 === 0);
      const centre = [0, 1, 2].map((k) => anchors.reduce((s, p) => s + p[k], 0) / anchors.length);
      const misses = [];
      for (const p of [...anchors, anchors[0]]) {
        if (fdi === 35) {
          misses.push(await aim(d, p, fdi, centre));
          await d.clickWorld(p, { objectIds: ['lower'] });
          await d.pause(150);
        } else misses.push(await quickClick(d, p, fdi, centre));
      }
      await d.waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.margin), fdi, 60000);
      const dev = await d.state(
        ([f, ring]) => {
          const m = window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f).margin.points;
          let max = 0;
          for (const { p } of m) {
            let best = Infinity;
            for (const q of ring) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
            max = Math.max(max, best);
          }
          return max;
        },
        [fdi, specOf(fdi).marginRing],
      );
      await d.check(Math.max(...misses) < 0.3 && dev < 0.3, `Cavity margin ${fdi} follows the cavity edge (within ${dev.toFixed(2)} mm)`, { misses, dev });
      await d.hush();
      await d.blur();
      await d.press('1', 'Occlusal view');
    }

    d.chapter('Inlay bridge: axis and proposal');
    await d.selectTooth(35);
    await d.step('Insertion axis');
    await d.waitFor(() => window.__dcad.tools.getState().axisReport?.bridge && !window.__dcad.tools.getState().busy);
    const axis = await d.state(() => {
      const doc = window.__dcad.design.getState().doc;
      const a = (f) => doc.teeth.find((t) => t.fdi === f).axis;
      return { same: JSON.stringify(a(35)) === JSON.stringify(a(37)), undercut: window.__dcad.tools.getState().axisReport.marginUndercutCount };
    });
    await d.check(axis.same && axis.undercut === 0, 'One insertion axis for both inlays, with no undercut', axis);
    await d.say('Insertion axis finds one direction both inlays can seat along, with no undercut in either cavity.');
    await d.step('Crown proposal');
    const past = await d.state(() => window.__dcad.design.getState().past.length);
    await d.say('Propose bridge makes both inlays and the pontic, and joins them with connectors in the proximal boxes.', { wait: false });
    await d.click(page.getByRole('button', { name: 'Propose bridge' }));
    await d.waitFor(() => [35, 36, 37].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.crown));
    await bridgeIdle(d, 3);
    const proposed = await d.state(() => {
      const r = window.__dcad.bridge.getState().result;
      return {
        past: window.__dcad.design.getState().past.length,
        units: r.units.map((u) => ({ fdi: u.fdi, printable: u.validation.printable })),
        inlays: r.units.filter((u) => u.inlay).map((u) => ({ fdi: u.fdi, source: u.inlay.source, fit: +u.inlay.marginFit.maxMm.toFixed(3), ok: u.inlay.marginFit.ok && u.inlay.isthmus.ok })),
        connectors: r.connectors.map((c) => c.failures.length),
      };
    });
    await d.check(proposed.past === past + 1 && proposed.units.every((u) => u.printable), 'Propose bridge: three printable units in one undo step', proposed.units);
    await d.check(proposed.inlays.length === 2 && proposed.inlays.every((i) => i.source === 'preop' && i.ok && i.fit <= 0.05), 'Both inlays take their outside from the pre-op scan and meet the margin', proposed.inlays);
    await d.check(proposed.connectors.length === 2 && proposed.connectors.every((n) => n === 0), 'Both connectors are thick enough', proposed.connectors);
    await d.hush();
    await d.settle();
    await d.say('Each inlay copies the tooth as it was before the prep. Outer surface switches it to a library tooth instead.');

    d.chapter('Inlay bridge: check and export');
    await d.step('Adapt');
    await bridgeIdle(d, 3);
    await d.selectTooth(36);
    await d.say('On Adapt, bring the pontic to the bite with Adapt occlusion. The inlays keep the pre-op shape.', { wait: false });
    await d.click(page.getByRole('button', { name: 'Adapt occlusion' }));
    await d.waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).steps.adapt === 'done');
    await bridgeIdle(d, 3);
    await d.hush();
    await d.selectTooth(35);
    await page.getByRole('heading', { name: 'Inlay 35' }).waitFor();
    await d.say('Check bridge merges the units into one piece and measures it: closed, printable, the inlays thick enough over the cavity floor.', { wait: false });
    await d.click(page.getByRole('button', { name: /check bridge|check again/i }));
    await d.waitFor(() => {
      const c = window.__dcad.bridge.getState().check;
      return c.current && !c.running;
    });
    const check = await d.state(() => {
      const c = window.__dcad.bridge.getState().check.result;
      return { ok: c.union?.checks.ok, components: c.union?.checks.union.components, genus: c.union?.checks.union.genus, printable: c.union?.checks.union.printable, inlays: c.union?.checks.inlays?.length, failures: c.union?.checks.failures };
    });
    await d.check(check.ok && check.components === 1 && check.genus === 0 && check.printable && check.inlays === 2, 'Check bridge: one printable solid, every check passes', check);
    await d.hush();
    await d.step('Finalize');
    const inlayHead = await readiness(d);
    await d.say('Finalize lists each inlay with its own rows: it meets the cavity margin, and it is thick enough. Export STL gives the bridge as one solid.', { wait: false });
    await d.point(page.locator('#readiness-head'), 2200);
    await exportSolid(d, 'inlay bridge');
    await d.check(/Ready to mill/.test(inlayHead) || /check/i.test(inlayHead), 'Finalize measured the inlay bridge', inlayHead);
    await d.hush();
  },
};
