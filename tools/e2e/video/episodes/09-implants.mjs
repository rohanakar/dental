// Episode 09: implant crowns and bridges on lower-implants-35-37.stl (as ai-implant.mjs and implant.mjs). The bridge
// 35i–[36]–37i in one click per scan body: the screw-channel gate stops the draft at the default wall, a thinner wall
// on 35 lets every gate pass, Accept, Finalize and the export (a through-hole per channel). Then a single implant
// crown on 37 through the steps: frame, implant position, crown, screw channel.
import { readFileSync } from 'node:fs';
import { DATA } from '../director.mjs';
import { stlSolid } from '../lib.mjs';

const TRUTH = Object.fromEntries(JSON.parse(readFileSync(`${DATA}lower-implants-35-37.poses.json`, 'utf8')).map((p) => [p.fdi, p]));
const SCANS = ['lower-implants-35-37.stl', 'upper.stl'];

/** The orchestrator's last run: its rows, failing checks and completeness. */
const runOf = (d) =>
  d.state(() => {
    const o = window.__dcad.orchestrator.getState();
    return {
      error: o.error,
      complete: o.complete,
      rows: o.steps.map((s) => `${s.key}:${s.status}`),
      failed: o.steps.flatMap((s) => s.qa.filter((c) => !c.passed).map((c) => `${s.key} ${c.id}: ${c.message}`)),
    };
  });
const runDone = (d) =>
  d.waitFor(() => {
    const o = window.__dcad.orchestrator.getState();
    return !o.running && (o.pendingReview || o.error);
  });

/** Offline, with no frames found on scan load: the one-click flow under test starts from the clicks. */
async function openCase(d) {
  await d.openOffline({ autoFrames: false });
  await d.page.getByRole('button', { name: /continue offline/i }).click();
  await d.waitFor(() => window.__dcad.design.getState().activeStep === 'setup');
}

/** Finalize's readiness head once every row is measured. */
async function readiness(d) {
  await d.waitFor(() => {
    const c = window.__dcad.bridge?.getState().check;
    return (!c || !c.running) && !document.querySelector('.readiness .detail')?.textContent?.includes('Measuring');
  });
  await d.pause(1500);
  return d.page.locator('#readiness-head').innerText();
}

/** Exports the STL from Finalize (past "anyway" if asked) and reads it as a solid. */
async function exportStl(d) {
  const { page } = d;
  const button = page.getByRole('button', { name: /^Export STL/ });
  await button.waitFor();
  const label = await button.innerText();
  const path = await d.download(async () => {
    await d.click(button);
    if (label.includes('anyway')) await d.click(page.getByRole('button', { name: 'Export STL anyway', exact: true }));
  });
  return { path, solid: await stlSolid(path) };
}

export default {
  id: '09-implants',
  title: 'Implant crowns and bridges',
  summary: 'Design on scan bodies instead of preps: one click per scan body for a bridge, a screw channel through each implant crown, and a gate that stops a draft whose channel wall is too thin.',
  learn: ['Set up implant units in Case setup', 'One click per scan body runs the bridge', 'Read a stopped draft and fix its cause', 'The single implant crown, step by step'],
  start: 'app/',
  intro: 'In this episode we design on implants. Instead of a prep, each implant has a scan body, and the crown gets a screw channel through it.',
  outro: 'You have designed an implant bridge and an implant crown, each with its screw channels checked.',
  async setup(d) {
    await openCase(d);
  },
  async run(d) {
    const { page } = d;

    // ---- The bridge 35i–[36]–37i ---------------------------------------------------------------------------------------
    d.chapter('Case setup');
    await d.say('Case setup comes first. In the tooth chart, click 35 and 37 to add them to tooth 36, which is already in the case.', { wait: false });
    await d.click(page.getByRole('button', { name: 'Tooth 35', exact: true }));
    await d.click(page.getByRole('button', { name: 'Tooth 37', exact: true }));
    await d.hush();
    await d.say('Implant crowns sit behind More types. Open it for 35 and 37 and choose Implant.', { wait: false });
    for (const fdi of [35, 37]) {
      await d.moreTypes(fdi);
      await d.click(page.getByRole('group', { name: `Restoration for ${fdi}` }).getByRole('button', { name: 'Implant' }));
    }
    await d.hush();
    await d.say('Make 36 a pontic. The three teeth become one bridge, carried by the two implants.', { wait: false });
    await d.click(page.getByRole('group', { name: 'Restoration for 36' }).getByRole('button', { name: 'Pontic' }));
    const setup = await d.state(() => window.__dcad.design.getState().doc.setup.teeth.map((t) => [t.fdi, t.restoration]));
    await d.check(
      JSON.stringify(setup) === JSON.stringify([[35, 'implant-crown'], [36, 'pontic'], [37, 'implant-crown']]),
      'Setup: implant crowns on 35 and 37, a pontic on 36',
      setup,
    );
    await d.hush();

    d.chapter('Scans');
    await d.say('On the Scans step, import the lower scan with its two scan bodies, and the upper jaw.', { wait: false });
    await d.loadScans(SCANS);
    await d.hush();
    await d.check((await d.state(() => window.__dcad.design.getState().doc.scans.length)) === 2, 'Both scans are loaded');

    d.chapter('One click per scan body');
    await d.selectTooth(35);
    await d.step('Tooth frame');
    const oneClick = page.getByLabel(/One-click bridge/);
    await d.say('On Tooth frame, turn on One-click bridge. Then click the top of each scan body, starting with 35.', { wait: false });
    await d.click(oneClick);
    await d.blur();
    await d.press('1', 'Occlusal view');
    await d.settle();
    await d.hush();
    await d.clickWorld(TRUTH[35].topCentre, { objectIds: ['lower'] });
    await d.waitFor(() => window.__dcad.design.getState().activeFdi === 37 && window.__dcad.tools.getState().autoArmed, null, 60000);
    await d.say('35 is framed, and the app moves on to 37. The click on 37 starts the run.', { wait: false });
    await d.settle();
    await d.hush();
    await d.clickWorld(TRUTH[37].topCentre, { objectIds: ['lower'] });
    await d.say('Auto-design matches each scan body to its implant, places the pontic, finds a common path, and proposes every unit with its screw channels.', { wait: false });
    await runDone(d);
    const stopped = await runOf(d);
    await d.check(
      stopped.rows.includes('classical.scan-body-match@1:35:passed') && stopped.rows.includes('classical.scan-body-match@1:37:passed') && !stopped.rows.some((r) => r.startsWith('classical.margin-ridge')),
      'Each implant gets a scan-body match instead of a margin',
      stopped.rows,
    );
    await d.hush();

    d.chapter('A gate stops the draft');
    const banner = page.locator('.auto-banner').first();
    await d.check(
      stopped.rows.includes('classical.screw-channel@1:35:failed') && stopped.failed.some((f) => f.includes('implant.channel.exit')),
      'At the default 0.8 mm wall, the draft stops at Screw channel 35',
      stopped.failed,
    );
    await d.say('This time the draft stopped. The verdict names the step, Screw channel 35, and the failing check says why.', { wait: false });
    await d.point(banner, 5000);
    await d.hush();
    await d.say('No channel angle on 35 leaves the default 0.8 millimetre wall around the screw. A gate never hands you a crown that fails its checks.');
    await d.say('Reject throws the draft away. Nothing in the case changes.', { wait: false });
    await d.click(banner.getByRole('button', { name: 'Reject', exact: true }));
    await d.check(!(await d.state(() => window.__dcad.design.getState().transaction)), 'Reject discards the draft');
    await d.hush();

    d.chapter('Fix the cause');
    await d.selectTooth(35);
    await d.step('Parameters');
    const wall = page.locator('#param-channelWallMm');
    await d.say("The fix is a parameter. On 35's Parameters, set the channel wall to 0.55 millimetres. The synthetic teeth are about 0.7 times natural size, so the default is too thick for them.", { wait: false });
    await d.point(wall, 2400);
    await d.pause(2200);
    await d.type(wall, '0.55', { delay: 70 });
    await wall.blur();
    await d.waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 35).params.channelWallMm === 0.55);
    await d.check(true, "35's channel wall is 0.55 mm");
    await d.hush();

    d.chapter('Run it again');
    await d.selectTooth(37);
    await d.step('Tooth frame');
    if (!(await oneClick.isChecked())) await d.click(oneClick);
    await d.blur();
    await d.press('1', 'Occlusal view');
    await d.settle();
    await d.say('Back on Tooth frame, one click on the scan body of 37 runs the bridge again.', { wait: false });
    const pastBefore = await d.state(() => window.__dcad.design.getState().past.length);
    await d.hush();
    await d.clickWorld(TRUTH[37].topCentre, { objectIds: ['lower'] });
    await runDone(d);
    const run = await runOf(d);
    await d.check(!run.error && run.complete, 'Every gate passes on the second run', { error: run.error, failed: run.failed });
    await d.settle();
    await d.say('Every gate passes. Look the bridge over: each implant crown has its screw channel opening on the chewing surface.', { wait: false });
    await d.orbit(90, 50);
    await d.orbit(-180, 0);
    await d.orbit(90, -50);
    await d.hush();

    d.chapter('Accept and finalize');
    await d.say('Accept keeps the whole bridge as one undo step.', { wait: false });
    await d.click(page.locator('.auto-banner').first().getByRole('button', { name: 'Accept', exact: true }));
    const after = await d.state(() => {
      const s = window.__dcad.design.getState();
      return { past: s.past.length, author: s.lastAuthor, units: s.doc.teeth.map((t) => ({ fdi: t.fdi, implant: Boolean(t.implant), channel: Boolean(t.screwChannel), crown: Boolean(t.crown) })) };
    });
    await d.check(after.past === pastBefore + 1 && after.author === 'proposer', 'Accept is one undo step', `${pastBefore} → ${after.past}`);
    await d.check(
      after.units.filter((u) => u.implant).length === 2 && after.units.every((u) => u.crown) && after.units.find((u) => u.fdi === 35).channel,
      'Both implants are matched and every unit has its crown',
      after.units,
    );
    const metrics = await d.state(async () => {
      const url = performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === '/src/ai/metrics.ts') ?? '/src/ai/metrics.ts';
      const { designMetrics } = await import(url);
      const m = await designMetrics(undefined, 35);
      return { exit: m.implant?.channelExitOk, genus: m.bridge?.union?.genus, expected: m.bridge?.union?.expectedGenus, failed: m.bridge?.failedChecks?.length };
    });
    await d.check(metrics.exit && metrics.genus === 2 && metrics.expected === 2 && metrics.failed === 0, 'The channel exits occlusally, with a through-hole per channel', metrics);
    await d.hush();
    await d.step('Finalize');
    const head = await readiness(d);
    await d.panelTo('#readiness-head');
    await d.check(/Ready to mill/.test(head), 'Finalize: the bridge is ready to mill', head);
    await d.say('Finalize lists the implant rows too: each scan body matched, each screw channel exiting with enough wall.', { wait: false });
    await d.point(page.locator('.readiness').first(), 4000);
    await d.hush();
    await d.say('Export STL writes the bridge as one solid, with a hole through it for each screw.', { wait: false });
    const bridge = await exportStl(d);
    await d.check(bridge.solid.ok && bridge.solid.components === 1 && bridge.solid.genus === 2, 'The exported bridge is one closed solid with two screw holes', bridge.solid);
    await d.hush();

    // ---- A single implant crown on 37 ----------------------------------------------------------------------------------
    d.chapter('A single implant crown');
    await d.say('Now a single implant crown on 37, step by step, in a fresh case.');
    await openCase(d);
    await d.say('Keep 37 and remove 36 in the chart, then choose Implant for 37.', { wait: false });
    await d.click(page.getByRole('button', { name: 'Tooth 37', exact: true }));
    await d.click(page.getByRole('button', { name: 'Tooth 36', exact: true }));
    await d.moreTypes(37);
    await d.click(page.getByRole('group', { name: 'Restoration for 37' }).getByRole('button', { name: 'Implant' }));
    const single = await d.state(() => window.__dcad.design.getState().doc.setup.teeth.map((t) => [t.fdi, t.restoration]));
    await d.check(JSON.stringify(single) === '[[37,"implant-crown"]]', 'Setup: a single implant crown on 37', single);
    await d.hush();
    await d.loadScans(SCANS);
    await d.step('Tooth frame');
    await d.blur();
    await d.press('1', 'Occlusal view');
    await d.settle();
    await d.say('Click the top of the scan body to set the tooth frame.', { wait: false });
    await d.clickWorld(TRUTH[37].topCentre, { objectIds: ['lower'] });
    await d.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 37)?.frame), null, 60000);
    await d.hush();

    d.chapter('Implant position');
    const nav = await page.getByRole('navigation', { name: 'Design steps' }).locator('button.step').allInnerTexts();
    await d.check(nav.some((l) => l.includes('Implant position')) && !nav.some((l) => /\bMargin\b/.test(l)), 'An implant crown has an Implant position step instead of Margin');
    await d.step('Implant position');
    await d.settle();
    await d.say('For an implant, Implant position replaces the margin. Click the scan body, and the app fits the library scan body to it.', { wait: false });
    await d.clickWorld(TRUTH[37].topCentre, { objectIds: ['lower'] });
    await d.waitFor(() => {
      const m = window.__dcad.implant.getState().match;
      return m && m.fdi === 37 && !window.__dcad.implant.getState().matching;
    }, null, 60000);
    const match = await d.state(() => window.__dcad.implant.getState().match.result);
    const truth = TRUTH[37].pose;
    const off = Math.hypot(...[0, 1, 2].map((k) => match.pose.position[k] - truth.position[k]));
    await d.check(match.passed && match.rmsMm < 0.05 && off < 0.02, `The scan body is matched within ${off.toFixed(3)} mm`, { rms: match.rmsMm, off });
    await d.hush();
    await d.say('The matched scan body shows as a ghost over the scan, with the fit error in the panel. If it sits right, accept the match.', { wait: false });
    const fit = page.locator('dl').filter({ hasText: 'Fit RMS' }).first();
    if (await fit.count()) await d.point(fit, 3000);
    await d.hush();
    await d.click(page.getByRole('button', { name: 'Accept match' }));
    await d.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 37)?.implant), null, 30000);
    const t37 = await d.tooth(37);
    await d.check(t37.implant.engaging && Boolean(t37.axis), 'The implant axis becomes the insertion axis', t37.implant.libraryId);
    await d.hush();

    d.chapter('Crown and screw channel');
    await d.step('Crown proposal');
    await d.say('Propose crown. The crown is seated on the titanium base, and the screw channel is cut through it along the implant axis.', { wait: false });
    await d.click(page.getByRole('button', { name: /^Propose crown/ }));
    await d.waitFor(() => {
      const c = window.__dcad.crownTool.current();
      return Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 37).crown) && c && !window.__dcad.tools.getState().crown?.computing;
    });
    await d.waitFor(() => Boolean(window.__dcad.implant.getState().result));
    const view = await d.state(() => {
      const c = window.__dcad.crownTool.current();
      return { ok: c.validation.ok, printable: c.validation.printable, exitOk: c.implant.channel.exitOk, wallOk: c.implant.channel.wallOk, minWall: +c.implant.channel.minWallMm.toFixed(2), cut: c.implant.cutOk };
    });
    await d.check(view.ok && view.printable && view.exitOk && view.wallOk && view.cut, `A printable crown, its channel exits with a ${view.minWall} mm wall`, view);
    await d.settle();
    await d.hush();
    await d.say('Drag to look around it. The orange line is the screw channel: it runs along the implant axis and leaves through the chewing surface.', { wait: false });
    await d.orbit(100, 0);
    await d.orbit(-200, 0);
    await d.orbit(100, 0);
    await d.hush();

    d.chapter('Adapt and finalize');
    await d.step('Adapt');
    await d.waitFor(() => !window.__dcad.tools.getState().crown?.computing);
    await d.say('On Adapt, Adapt occlusion shapes the crown to touch the opposing teeth by the target amount.', { wait: false });
    await d.click(page.getByRole('button', { name: /^Adapt occlusion/ }));
    await d.waitFor(() => {
      const c = window.__dcad.tools.getState().crown;
      return c && !c.computing && c.adapt?.occlusion;
    });
    const adapted = await d.state(() => {
      const c = window.__dcad.tools.getState().crown;
      return { occlusion: c.adapt.occlusion, printable: c.validation.printable, exitOk: window.__dcad.crownTool.current()?.implant?.channel.exitOk };
    });
    await d.check(adapted.printable && adapted.exitOk, 'Adapted to the bite, still printable with its channel open', adapted);
    await d.hush();
    await d.step('Finalize');
    const head37 = await readiness(d);
    await d.panelTo('#readiness-head');
    await d.check(/Ready to mill/.test(head37), 'Finalize: the implant crown is ready to mill', head37);
    await d.say('Finalize now says ready to mill. Export it as before: a single implant crown has one screw hole.', { wait: false });
    const crown = await exportStl(d);
    await d.check(crown.solid.ok && crown.solid.components === 1 && crown.solid.genus === 1, 'The exported crown is one closed solid with one screw hole', crown.solid);
    await d.hush();
  },
};
