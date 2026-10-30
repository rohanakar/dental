// Episode 08: bridge auto-design on 35–[36]–37 (lower-bridge.stl + upper.stl), as ai-bridge.mjs: one click on each
// prep runs the whole bridge; a 40 mm² connector stops a re-run at the connector gate; Reject, a 12 mm² connector,
// run again, Accept, Finalize "Ready to mill".
import { ALONG } from '../lib.mjs';

const runDone = (d) =>
  d.waitFor(() => {
    const o = window.__dcad.orchestrator.getState();
    return !o.running && (o.pendingReview || o.error);
  }, null, 300000);

const runResult = (d) =>
  d.state(() => {
    const o = window.__dcad.orchestrator.getState();
    return {
      complete: o.complete,
      error: o.error,
      rows: o.steps.map((s) => `${s.key}:${s.status}`),
      failed: o.steps.flatMap((s) => s.qa.filter((c) => !c.passed).map((c) => ({ id: c.id, value: c.value, threshold: c.threshold }))),
      step: window.__dcad.design.getState().activeStep,
    };
  });

/** Sets connector 35–36's designed area on the Adapt step. */
async function connectorArea(d, mm2) {
  await d.step('Adapt');
  await d.waitFor(() => {
    const s = window.__dcad.bridge.getState();
    return s.result && !s.computing;
  });
  await d.panelTo('#connectors-head');
  const area = d.page.getByRole('listitem', { name: 'Connector 35–36' }).getByLabel('Area (mm²)');
  await d.type(area, String(mm2));
  await d.press('Enter', 'Apply');
  await d.waitFor((a) => window.__dcad.design.getState().doc.bridges[0].connectors[0].areaMm2 === a, mm2);
}

export default {
  id: '08-auto-bridge',
  title: 'Auto-design a bridge',
  summary:
    'One click on each prep designs the whole bridge, gate by gate. Review the draft, accept it, and see what happens when a draft fails a gate: reject it, fix the cause, and run again.',
  learn: ['Turn on One-click bridge', 'Click each prep once', 'Read the gates of a draft', 'Reject, fix and run again'],
  start: 'app/',
  async setup(d) {
    // The click flow is the point: no frames from the preps on loading the scans (specs/2026-10-26-auto-frames.md).
    await d.page.waitForFunction(() => Boolean(window.__dcad?.tools));
    await d.state(() => window.__dcad.tools.getState().set({ autoFrames: false }));
  },
  intro: 'Auto-design can do a whole bridge for you. In this episode you click each prep once, review the draft, and see what happens when a draft fails one of its checks.',
  outro: 'Every draft passes its gates before you see it, and nothing is kept until you accept.',
  async run(d) {
    const { page } = d;

    d.chapter('Set up the bridge');
    await d.say('Set the case up as in the last episode: crowns on 35 and 37, a pontic for 36, then the two jaw scans.', { wait: false });
    await d.click(page.getByRole('button', { name: /continue offline/i }));
    await d.click(page.getByRole('button', { name: 'Tooth 35', exact: true }));
    await d.click(page.getByRole('button', { name: 'Tooth 37', exact: true }));
    await d.click(page.getByRole('group', { name: 'Restoration for 36' }).getByRole('button', { name: 'Pontic' }));
    const bridges = await d.state(() => window.__dcad.design.getState().doc.bridges.map((b) => b.teeth));
    await d.check(JSON.stringify(bridges) === '[[35,36,37]]', 'The chart makes one bridge, 35 to 37', bridges);
    await d.loadScans(['lower-bridge.stl', 'upper.stl']);
    await d.hush();

    d.chapter('One click on each prep');
    await d.selectTooth(35);
    await d.step('Tooth frame');
    await d.say('On Tooth frame, tick One-click bridge. Then click each prep once: the bridge is designed after the last abutment.', { wait: false });
    const oneClick = page.getByLabel(/One-click bridge/);
    await d.click(oneClick);
    await d.check(await oneClick.isChecked(), 'One-click bridge is on');
    await d.blur();
    await d.click(page.getByRole('group', { name: 'Standard views' }).getByRole('button', { name: 'Occlusal', exact: true }));
    await d.settle();
    await d.hush();
    await d.say('Click the prep of 35.', { wait: false });
    await d.clickWorld(await d.synthetic('syntheticPrepSeed', { fdi: 35, along: ALONG }));
    await d.waitFor(() => window.__dcad.design.getState().activeFdi === 37 && window.__dcad.tools.getState().autoArmed, null, 60000);
    const armed = await d.state(() => ({ frame35: Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 35).frame), transaction: window.__dcad.design.getState().transaction }));
    await d.check(armed.frame35 && !armed.transaction, 'The first click frames 35 and asks for 37 next', armed);
    await d.hush();
    await d.say('The status line asks for 37 next. One more click, and the whole bridge is designed.', { wait: false });
    await d.point(page.locator('.status-message'), 2200);
    await d.settle();
    await d.clickWorld(await d.synthetic('syntheticPrepSeed', { fdi: 37, along: ALONG }));
    await runDone(d);
    const first = await runResult(d);
    await d.check(first.complete && !first.error && first.failed.length === 0, 'The last click designs the whole bridge, and every gate passes', first.rows);
    await d.hush();
    await d.settle();

    d.chapter('Review the draft');
    const banner = page.locator('.auto-banner').first();
    await d.say(
      'Each step of the run is a gate: the pontic, both margins, the common axis, every unit, the adaptation, and the connectors on the merged bridge. You only see a draft that passed them all.',
      { wait: false },
    );
    await d.point(banner, 4000);
    await d.hush();
    await d.say('Show the step checks lists every check, unit by unit.', { wait: false });
    await d.click(banner.locator('summary'));
    await d.pause(1500);
    await d.click(banner.locator('summary'));
    await d.hush();
    const pastBefore = await d.state(() => window.__dcad.design.getState().past.length);
    await d.say('Look it over, then Accept. The whole bridge is one undo step.', { wait: false });
    await d.orbit(100, 0);
    await d.orbit(-100, 0);
    await d.click(banner.getByRole('button', { name: 'Accept', exact: true }));
    const accepted = await d.state(() => {
      const s = window.__dcad.design.getState();
      const axis = (f) => s.doc.teeth.find((t) => t.fdi === f).axis?.direction;
      return {
        past: s.past.length,
        transaction: s.transaction,
        author: s.lastAuthor,
        commonAxis: JSON.stringify(axis(35)) === JSON.stringify(axis(37)),
        units: s.doc.teeth.map((t) => [t.fdi, Boolean(t.crown), t.steps.adapt]),
      };
    });
    await d.check(accepted.past === pastBefore + 1 && !accepted.transaction && accepted.author === 'proposer', 'Accept keeps the draft as one undo step', accepted);
    await d.check(accepted.commonAxis && accepted.units.every(([, crown, adapt]) => crown && adapt === 'done'), 'One common axis, and every unit has its crown and adaptation', accepted.units);
    await d.hush();

    d.chapter('When a gate stops a draft');
    await d.say('Now say you want a much stronger connector between 35 and 36: forty square millimetres. Set it on the Adapt step.', { wait: false });
    await connectorArea(d, 40);
    await d.hush();
    await d.step('Crown proposal');
    await d.say('Run Auto-design bridge again. It keeps the frames, margins and axis you have, and designs the units again.', { wait: false });
    const docBefore = await d.state(() => JSON.stringify(window.__dcad.design.getState().doc));
    await d.click(page.getByRole('button', { name: 'Auto-design bridge' }));
    await runDone(d);
    const stopped = await runResult(d);
    const tooWide = stopped.failed.find((c) => c.id === 'bridge.connector.35-36.too-wide');
    await d.check(
      !stopped.complete && stopped.rows.at(-1) === 'classical.connectors@1:failed' && Boolean(tooWide) && stopped.step === 'adapt',
      'A 40 mm² connector stops the draft at the connector gate',
      stopped,
    );
    await d.hush();
    await d.settle();
    const review = page.locator('.draft-review');
    await review.scrollIntoViewIfNeeded();
    await d.say(
      tooWide
        ? `The draft stopped at the connector gate. That connector would be ${Number(tooWide.value).toFixed(1)} millimetres wide, more than the ${Number(tooWide.threshold).toFixed(1)} the narrower unit allows.`
        : 'The draft stopped at the connector gate: that connector is too wide for the units.',
      { wait: false },
    );
    await d.point(review, 5000);
    await d.hush();
    await d.say('Nothing is kept until you decide. Reject puts the case back exactly as it was.', { wait: false });
    await d.point(review.getByRole('button', { name: 'Reject', exact: true }), 2200);
    await d.hush();
    await d.click(review.getByRole('button', { name: 'Reject', exact: true }));
    const restored = await d.state((before) => JSON.stringify(window.__dcad.design.getState().doc) === before && !window.__dcad.design.getState().transaction, docBefore);
    await d.check(restored, 'Reject puts the case back as it was');
    await d.hush();

    d.chapter('Fix it and run again');
    await d.say('Fix the cause: twelve square millimetres is still stronger than the minimum, and fits between the units.', { wait: false });
    await connectorArea(d, 12);
    await d.hush();
    await d.step('Crown proposal');
    await d.say('Run it again.', { wait: false });
    await d.click(page.getByRole('button', { name: 'Auto-design bridge' }));
    await runDone(d);
    const second = await runResult(d);
    await d.check(second.complete && !second.error && second.failed.length === 0, 'With a 12 mm² connector, every gate passes', second.rows);
    await d.hush();
    await d.settle();
    const pastBeforeSecond = await d.state(() => window.__dcad.design.getState().past.length);
    await d.say('This time every gate passes. Accept it.', { wait: false });
    await d.point(page.locator('.auto-banner').first(), 1800);
    await d.click(page.locator('.auto-banner').first().getByRole('button', { name: 'Accept', exact: true }));
    const kept = await d.state(() => ({ past: window.__dcad.design.getState().past.length, area: window.__dcad.design.getState().doc.bridges[0].connectors[0].areaMm2 }));
    await d.check(kept.past === pastBeforeSecond + 1 && kept.area === 12, 'Accepted as one undo step, with the 12 mm² connector', kept);
    await d.hush();

    d.chapter('Ready to mill');
    await d.step('Finalize');
    await d.waitFor(() => {
      const c = window.__dcad.bridge.getState().check;
      return c.current && !c.running && !document.querySelector('.readiness .detail')?.textContent?.includes('Measuring');
    }, null, 300000);
    await d.pause(600);
    await d.panelTo('#readiness-head');
    const head = await page.locator('#readiness-head').innerText();
    await d.check(/Ready to mill/.test(head), 'Finalize: ready to mill', head);
    await d.say('Finalize measures the merged bridge once more, and it is ready to mill.', { wait: false });
    await d.point(page.locator('#readiness-head'), 2600);
    await d.hush();
  },
};
