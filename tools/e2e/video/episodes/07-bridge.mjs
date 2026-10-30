// Episode 07: the posterior bridge 35–[36]–37 on lower-bridge.stl + upper.stl, step by step, as a user meets it
// (frames on scan load, margins on entering Margin, the common axis on entering its step; as bridge.mjs part 1).
import { basename } from 'node:path';
import { ALONG, stlSolid } from '../lib.mjs';

/** Every unit of the active bridge has its crown and the displayed bridge is computed. */
const bridgeIdle = (d, units) =>
  d.waitFor((n) => {
    const s = window.__dcad.bridge.getState();
    return s.result && !s.computing && s.result.units.length === n;
  }, units);

/** How far a tooth's margin is from the analytic synthetic ring (mean and max, mm). */
const marginDeviation = (d, fdi) =>
  d.state(async ([f, along]) => {
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

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};

export default {
  id: '07-bridge',
  title: 'A bridge, step by step',
  summary:
    'A three-unit bridge from 35 to 37 with a pontic on 36: set it up on the chart, review the frames, margins and common axis, propose the bridge, adjust a unit, size the connectors and export one solid.',
  learn: ['Set up a bridge on the tooth chart', 'Review frames, the pontic and margins', 'Propose every unit on one common axis', 'Check the connectors and export one solid'],
  start: 'app/',
  async setup(d) {
    await d.page.waitForFunction(() => Boolean(window.__dcad?.tools));
  },
  intro: 'In this episode we design a three-unit bridge: crowns on 35 and 37, and a pontic for the missing 36. We go step by step, so you see what each step does for a bridge.',
  outro: 'That is a bridge, from the chart to one exported solid.',
  async run(d) {
    const { page } = d;

    d.chapter('Case setup');
    await d.say('Continue offline opens the editor without an account.', { wait: false });
    await d.click(page.getByRole('button', { name: /continue offline/i }));
    await d.hush();
    await d.say('Case setup has a tooth chart, drawn as the dentist sees it. Click a tooth to add it to the case.', { wait: false });
    await d.click(page.getByRole('button', { name: 'Tooth 35', exact: true }));
    await d.click(page.getByRole('button', { name: 'Tooth 37', exact: true }));
    await d.hush();
    await d.say('36 is missing. Switch it to Pontic, and the three teeth join into one bridge, with a connector on each side.', { wait: false });
    await d.click(page.getByRole('group', { name: 'Restoration for 36' }).getByRole('button', { name: 'Pontic' }));
    const bridges = await d.state(() => window.__dcad.design.getState().doc.bridges);
    await d.check(
      JSON.stringify(bridges.map((b) => b.teeth)) === '[[35,36,37]]' && bridges[0].connectors.length === 2,
      'The chart makes one bridge, 35 to 37, with two connectors',
      bridges,
    );
    await d.hush();

    d.chapter('Scans');
    await d.say('On Scans, drop the lower and upper jaw files on the import box. Names with upper or lower are sorted for you.', { wait: false });
    await d.loadScans(['lower-bridge.stl', 'upper.stl']);
    await d.hush();
    await d.waitFor(() => [35, 36, 37].every((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.frame)), null, 60000);
    const framed = await d.state(() => window.__dcad.design.getState().doc.teeth.map((t) => [t.fdi, t.frame?.source]));
    await d.check(framed.length === 3 && framed.every(([, s]) => s === 'auto'), 'Frames are set on 35 and 37 from their preps, and the pontic is placed', framed);
    await d.say('As soon as the scans are in, the software finds both preps and sets each tooth frame. The pontic is placed on the arch between them.');

    d.chapter('Tooth frame');
    await d.step('Tooth frame');
    await d.click(page.getByRole('group', { name: 'Standard views' }).getByRole('button', { name: 'Occlusal', exact: true }));
    await d.settle();
    await d.say('Each tooth has three arrows: blue points up, green points mesial, orange points buccal. Check them on every unit.', { wait: false });
    await d.zoom(-2, { at: await d.project((await d.tooth(36)).frame.origin) });
    await d.settle();
    await d.panelTo('#bridge-frame-head');
    await d.point(page.locator('.bridge-units').first(), 2600);
    await d.hush();
    // Align to arch: the abutments' mesial arrows along the arch curve (one undo step).
    await d.waitFor(() => !document.querySelector('.bridge-panel .spinner') && document.querySelector('.bridge-changes'));
    const changes = await page.locator('.bridge-changes li').allInnerTexts();
    const turns = changes.map((t) => t.match(/^(\d+): turns ([\d.]+)°/)).filter(Boolean).map((m) => ({ fdi: Number(m[1]), deg: Number(m[2]) }));
    const worst = turns.sort((a, b) => b.deg - a.deg)[0];
    const align = page.getByRole('button', { name: 'Align to arch' });
    if (worst && (await align.isEnabled())) {
      await d.say(
        `Align to arch turns each abutment's mesial arrow to follow the arch. The panel says how far: here ${worst.fdi} turns ${Math.round(worst.deg)} degrees, so press it.`,
        { wait: false },
      );
      await d.point(page.locator('.bridge-changes'), 4000);
      await d.hush();
      const pastBefore = await d.state(() => window.__dcad.design.getState().past.length);
      await d.click(align);
      await d.check((await d.state(() => window.__dcad.design.getState().past.length)) === pastBefore + 1, 'Align to arch is one undo step', changes.join(', '));
      await d.settle();
    } else {
      await d.say('Align to arch would turn the abutments to follow the arch. Here they already do.');
    }
    await d.waitFor(() => !document.querySelector('.bridge-panel .spinner'));
    const f35 = (await d.tooth(35)).frame;
    const f37 = (await d.tooth(37)).frame;
    const to35 = unit([0, 1, 2].map((k) => f35.origin[k] - f37.origin[k]));
    await d.check(dot(f37.mesial, to35) > 0.8, "37's mesial arrow points along the arch toward 35", dot(f37.mesial, to35).toFixed(3));

    // The pontic: a ridge click moves its centre; undo puts it back.
    await d.say('Now the pontic. Make it active, then click the ridge where its centre should go.', { wait: false });
    await d.click(d.unitButton(36));
    await d.settle();
    await d.hush();
    const pontic = (await d.tooth(36)).frame;
    const to35p = unit([0, 1, 2].map((k) => f35.origin[k] - pontic.origin[k]));
    await d.check(dot(pontic.mesial, to35p) > 0.8, "The pontic's mesial arrow points toward 35", dot(pontic.mesial, to35p).toFixed(3));
    const target = [0, 1, 2].map((k) => pontic.origin[k] + 1.0 * pontic.mesial[k] + 2 * pontic.occlusal[k]);
    const hit = await d.state((p) => {
      const v = window.__dcad.viewer;
      const s = v.project(p);
      const r = v.raycast(s.x, s.y, { objectIds: ['lower'] });
      return r && [r.point.x, r.point.y, r.point.z];
    }, target);
    await d.clickWorld(hit, { objectIds: ['lower'] });
    await d.waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).frame.source === 'manual', null, 30000).catch(() => {});
    const moved = (await d.tooth(36)).frame;
    const offBy = Math.hypot(...[0, 1, 2].map((k) => moved.origin[k] - hit[k]));
    await d.check(moved.source === 'manual' && offBy < 0.5, 'A click on the ridge moves the pontic there', `${offBy.toFixed(3)} mm from the click`);
    await d.say('Changed your mind? Undo puts it back.', { wait: false });
    await d.press('Control+z', 'Undo');
    await d.check((await d.tooth(36)).frame.source === 'auto', 'Undo puts the pontic back on the arch');
    await d.hush();

    d.chapter('Margins');
    await d.say('A pontic has no margin, so pick an abutment before you open the Margin step.', { wait: false });
    await d.click(d.unitButton(35));
    await d.step('Margin');
    await d.waitFor(() => [35, 37].every((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.margin)), null, 120000);
    await d.settle();
    await d.hush();
    const dev35 = await marginDeviation(d, 35);
    const dev37 = await marginDeviation(d, 37);
    await d.check(dev35.max < 0.3 && dev37.max < 0.3, 'Margins are found on both abutments, on the prep edge', `35: max ${dev35.max.toFixed(3)} mm, 37: max ${dev37.max.toFixed(3)} mm`);
    await d.say('Opening Margin finds the margin on both abutments at once. The line follows the edge of the prep; its colour says how clear that edge is.', { wait: false });
    await d.point(page.getByRole('button', { name: 'Find the margin' }), 1800);
    await d.hush();
    await d.say('Check each one. Drag a point to move the line, or use Find the margin to start a tooth over.', { wait: false });
    await d.selectTooth(37);
    await d.settle();
    await d.hush();

    d.chapter('Common insertion axis');
    await d.step('Insertion axis');
    await d.waitFor(() => {
      const r = window.__dcad.tools.getState().axisReport;
      return r?.bridge && r.bridge.divergenceDeg !== null && !window.__dcad.tools.getState().busy;
    });
    await d.settle();
    const axis = await d.state(() => {
      const doc = window.__dcad.design.getState().doc;
      const a = (f) => doc.teeth.find((t) => t.fdi === f).axis;
      return { a35: a(35), a37: a(37), report: window.__dcad.tools.getState().axisReport };
    });
    await d.check(JSON.stringify(axis.a35) === JSON.stringify(axis.a37), 'One common insertion axis on 35 and 37', axis.a35?.direction);
    await d.check(axis.report.marginUndercutCount === 0, 'No margin point is in undercut on either abutment', axis.report.bridge.abutments.map((a) => [a.fdi, a.marginUndercutCount]));
    await d.say('A bridge goes on in one direction, so both abutments share one insertion axis, proposed with the least undercut. The table shows no margin point in undercut.', { wait: false });
    await d.point(page.locator('aside table').first(), 4500);
    await d.hush();

    d.chapter('Propose the bridge');
    await d.step('Crown proposal');
    const pastBeforePropose = await d.state(() => window.__dcad.design.getState().past.length);
    await d.say('Propose bridge places a library tooth on every unit, along the common axis, and joins them with connectors.', { wait: false });
    await d.click(page.getByRole('button', { name: 'Propose bridge' }));
    await d.waitFor(() => [35, 36, 37].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.crown));
    await bridgeIdle(d, 3);
    const proposed = await d.state(() => {
      const s = window.__dcad.bridge.getState();
      return {
        past: window.__dcad.design.getState().past.length,
        units: s.result.units.map((u) => ({ fdi: u.fdi, ok: u.validation.ok, printable: u.validation.printable })),
        connectors: s.result.connectors.map((c) => ({ between: c.between, area: +c.areaMm2.toFixed(2), failures: c.failures.length })),
      };
    });
    await d.check(proposed.past === pastBeforePropose + 1, 'Propose bridge is one undo step');
    await d.check(proposed.units.every((u) => u.ok && u.printable), 'Every unit is a printable closed solid', proposed.units);
    await d.check(proposed.connectors.length === 2 && proposed.connectors.every((c) => c.failures === 0), 'Both connectors are within their limits', proposed.connectors);
    await d.hush();
    await d.settle();
    await d.orbit(90, 20);
    await d.orbit(-90, -20);

    d.chapter('Adjust a unit');
    const ponticTop = await d.state(() => {
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
    await d.say('To adjust one unit, click it in the 3D view. It becomes the active unit, with the move handles on it.', { wait: false });
    await d.clickWorld(ponticTop, { guard: false });
    await d.waitFor(() => window.__dcad.design.getState().activeFdi === 36, null, 10000).catch(() => {});
    await d.check((await d.state(() => window.__dcad.design.getState().activeFdi)) === 36, 'Clicking the pontic makes it the active unit');
    await d.hush();
    const poses = () => d.state(() => Object.fromEntries(window.__dcad.design.getState().doc.teeth.map((t) => [t.fdi, t.crown?.pose.position])));
    const before = await poses();
    await d.say('Shift and an arrow key moves it half a millimetre. Only the active unit moves.', { wait: false });
    await d.press('Shift+ArrowUp', 'Move 0.5 mm buccal');
    await bridgeIdle(d, 3);
    const after = await poses();
    const buccal = (await d.tooth(36)).frame.buccal;
    const shift = [0, 1, 2].reduce((s, k) => s + (after[36][k] - before[36][k]) * buccal[k], 0);
    await d.check(Math.abs(shift - 0.5) < 1e-6 && JSON.stringify(after[35]) === JSON.stringify(before[35]), 'Shift+↑ moves the pontic 0.5 mm buccal, and nothing else', shift.toFixed(4));
    await d.hush();
    await d.press('Control+z', 'Undo');
    await bridgeIdle(d, 3);
    await d.check(JSON.stringify(await poses()) === JSON.stringify(before), 'Undo puts the pontic back');

    d.chapter('Adapt and connectors');
    await d.step('Adapt');
    await bridgeIdle(d, 3);
    await d.say('Adapt fits the bridge to the bite. One button adapts the occlusion of all three units.', { wait: false });
    await d.click(page.getByRole('button', { name: /Adapt occlusion, all 3 units/ }));
    await d.waitFor(() => [35, 36, 37].every((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f).steps.adapt === 'done'));
    await bridgeIdle(d, 3);
    await d.hush();
    await d.say('The free sides touch the neighbours: the mesial of 35 and the distal of 37. The sides joined by a connector have no contact.', { wait: false });
    for (const [fdi, side] of [[35, 'mesial'], [37, 'distal']]) {
      await d.click(d.unitButton(fdi));
      const button = page.getByRole('button', { name: `Adapt ${side} contact` });
      if (await button.isEnabled()) {
        await d.click(button);
        await d.waitFor(([f, s]) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f).crown.adapt?.[s]), [fdi, side]);
        await bridgeIdle(d, 3);
      }
    }
    const occlusion = await d.state(() => window.__dcad.bridge.getState().result.units.map((u) => [u.fdi, u.adapt?.occlusion ? +u.adapt.occlusion.minClearanceMm.toFixed(3) : null]));
    await d.check(occlusion.every(([, c]) => c !== null), 'Every unit is adapted to the opposing teeth', occlusion);
    await d.hush();
    await d.panelTo('#connectors-head');
    await d.say('Each connector has a designed area, at least the material minimum. A bigger area is stronger; here we give 35 to 36 ten square millimetres.', { wait: false });
    const area = page.getByRole('listitem', { name: 'Connector 35–36' }).getByLabel('Area (mm²)');
    await d.type(area, '10');
    await d.press('Enter', 'Apply');
    await d.waitFor(() => window.__dcad.design.getState().doc.bridges[0].connectors[0].areaMm2 === 10);
    const adaptSteps = await d.state(() => window.__dcad.design.getState().doc.teeth.map((t) => [t.fdi, t.steps.adapt]));
    await d.check(adaptSteps.every(([, s]) => s === 'done'), 'A connector edit keeps the adaptation', adaptSteps);
    await bridgeIdle(d, 3);
    await d.hush();
    await d.say('Check bridge merges the units into one solid and measures each connector on it.', { wait: false });
    await d.click(page.getByRole('button', { name: /check bridge|check again/i }));
    await d.waitFor(() => {
      const c = window.__dcad.bridge.getState().check;
      return c.current && !c.running;
    });
    const check = await d.state(() => {
      const c = window.__dcad.bridge.getState().check.result;
      return {
        union: c.union && { components: c.union.checks.union.components, genus: c.union.checks.union.genus, printable: c.union.checks.union.printable },
        connectors: c.union?.checks.connectors.map((x) => ({ between: x.between, measured: +x.measured.minAreaMm2.toFixed(2), target: x.targetAreaMm2, ok: x.ok })),
      };
    });
    await d.check(Boolean(check.union?.printable) && check.union.components === 1 && check.union.genus === 0, 'Check bridge: one printable solid, with no holes', check.union);
    await d.check(check.connectors?.every((c) => c.ok && c.measured >= c.target), 'Both connectors, measured on the solid, reach their area', check.connectors);
    await d.hush();
    await d.panelTo('#connectors-head');
    await d.point(page.locator('section.bridge-panel[aria-labelledby="connectors-head"]'), 2500);
    await d.pause(1200);

    d.chapter('Finalize and export');
    await d.step('Finalize');
    await d.waitFor(() => {
      const c = window.__dcad.bridge.getState().check;
      return c.current && !c.running && !document.querySelector('.readiness .detail')?.textContent?.includes('Measuring');
    });
    await d.panelTo('#readiness-head');
    await d.say('Finalize lists each unit, the connectors and the merged bridge, under one verdict.', { wait: false });
    await d.point(page.locator('#readiness-head'), 2400);
    await d.hush();
    const exportButton = page.getByRole('button', { name: /^Export STL/ });
    const label = await exportButton.innerText();
    await d.say('Export STL saves the whole bridge as one file.', { wait: false });
    const stl = await d.download(async () => {
      await d.click(exportButton);
      if (label.includes('anyway')) await d.click(page.getByRole('button', { name: 'Export STL anyway', exact: true }));
    });
    const solid = await stlSolid(stl);
    await d.check(basename(stl) === 'case-35-37-bridge.stl', 'The bridge is exported as one file', basename(stl));
    await d.check(solid.ok && solid.closed && solid.components === 1 && solid.genus === 0, `The exported STL is one closed solid (${solid.triangles.toLocaleString('en')} triangles)`, solid);
    await d.hush();
  },
};
