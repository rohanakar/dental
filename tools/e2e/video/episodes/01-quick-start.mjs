// Episode 01: from the landing page to an exported crown on the demo case, with auto-design (as first-run.mjs).
import { ALONG, stlTriangles } from '../lib.mjs';

export default {
  id: '01-quick-start',
  title: 'Quick start: a crown in one click',
  summary: 'Open the demo case, let auto-design propose every step, read the measured checks, accept the draft and export the crown.',
  learn: ['Open the demo from the landing page', 'Run Auto-design crown', 'Read the draft review and its checks', 'Accept, finalize and export STL'],
  start: '',
  intro: 'Welcome to Dental CAD. In this first episode we design a crown on the demo case in one click, check it, and export it for milling.',
  outro: 'That is a whole crown, from scans to an STL file.',
  async run(d) {
    const { page } = d;
    d.chapter('The landing page');
    const demo = page.locator('a.button-secondary[href="app/?demo"]').first();
    await d.say('This is the landing page. The demo needs no account. It opens the editor on synthetic scans of a lower jaw, prepared for a crown on tooth 36.', { wait: false });
    await d.point(demo, 2600);
    await d.hush();
    await d.click(demo);
    await d.waitFor(() => window.__dcad?.design.getState().activeStep === 'frame' && Boolean(window.__dcad.viewer) && Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));
    await d.settle();

    d.chapter('The editor');
    const opened = await d.state(() => ({ scans: window.__dcad.design.getState().doc.scans.length, step: window.__dcad.design.getState().activeStep }));
    await d.check(opened.scans === 2 && opened.step === 'frame', 'The demo opens on Tooth frame with both jaws loaded', opened);
    await d.say('The editor opens on the Tooth frame step. The rail on the left lists every step, from case setup to finalize.', { wait: false });
    await d.point(page.getByRole('navigation', { name: 'Design steps' }), 3200);
    await d.hush();
    const seed = await d.synthetic('syntheticPrepSeed', { along: ALONG });
    const origin = (await d.tooth(36)).frame.origin;
    await d.check(Math.hypot(...origin.map((o, k) => o - seed[k])) < 1, 'Tooth 36 is already framed on its prep');
    await d.say('The tooth frame is already set on the prepared tooth. It tells the software which way is up, mesial and buccal for this tooth.');

    d.chapter('Auto-design');
    const region = page.getByRole('region', { name: 'Auto-design' });
    const run = region.getByRole('button', { name: 'Auto-design crown' });
    await d.say('Auto-design crown does every remaining step for you: the margin, the insertion axis, the crown, and its adaptation to the bite and the neighbours.', { wait: false });
    await d.point(run, 3000);
    await d.hush();
    await d.say('Each step has to pass its measured checks before you see anything.', { wait: false });
    await d.click(run);
    await d.waitFor(() => {
      const o = window.__dcad.orchestrator.getState();
      return !o.running && (o.pendingReview || o.error);
    });
    const result = await d.state(() => {
      const o = window.__dcad.orchestrator.getState();
      return { complete: o.complete, error: o.error, failed: o.steps.flatMap((s) => s.qa.filter((c) => !c.passed).map((c) => `${s.key} ${c.message}`)) };
    });
    await d.check(result.complete && !result.error, 'Auto-design gives a complete draft', result);
    await d.hush();
    await d.settle();

    d.chapter('Review the draft');
    const banner = region.locator('.auto-banner');
    const verdict = (await banner.locator('strong').textContent())?.trim() ?? '';
    await d.check(/^Draft ready: all \d+ checks passed$/.test(verdict), verdict || 'The draft has a verdict line');
    await d.say('The draft is ready, and the verdict line says every check passed.', { wait: false });
    await d.point(banner.locator('strong'), 2200);
    await d.hush();
    await page.waitForFunction(() => [...document.querySelectorAll('.readiness.compact li')].every((li) => !/Measuring/.test(li.textContent ?? '')), null, { timeout: 60000 }).catch(() => {});
    const rows = await banner.locator('.readiness.compact li').evaluateAll((els) => els.map((e) => e.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
    await d.check(rows.some((t) => /Thick enough/.test(t) && /mm/.test(t)), 'The review shows the clinical rows with their measured values', rows);
    await d.say('Below it are the clinical rows, each with its measured value: the margin is closed, the crown seats along the axis, it is watertight, thick enough for zirconia, and touches the bite and both neighbours by the target amounts.', { wait: false });
    await d.point(banner.locator('.readiness.compact'), 9000);
    await d.hush();
    await d.say('Show the step checks opens every check of every step.', { wait: false });
    await d.click(banner.locator('summary'));
    await d.check((await banner.locator('.auto-checks li').count()) > 5, 'Show the step checks lists the checks of every step');
    await d.hush();
    await d.pause(900);
    await d.click(banner.locator('summary'));

    d.chapter('Look it over');
    await d.say('Before accepting, look the crown over. Drag in the 3D view to turn it, and scroll to zoom.', { wait: false });
    await d.orbit(110, 20);
    await d.orbit(-220, -20);
    await d.orbit(110, 0);
    const crown = await d.project((await d.tooth(36)).frame.origin);
    await d.zoom(-2, { at: crown });
    await d.pause(700);
    await d.zoom(2);
    await d.hush();
    await d.say('The colours on the crown show the room to the opposing teeth: blue is space to spare, red would be a collision.');

    d.chapter('Accept');
    await d.say('Accept keeps the whole draft as one undo step. Reject throws it away and goes back to where you started.', { wait: false });
    await d.point(banner.getByRole('button', { name: 'Reject', exact: true }), 2000);
    await d.click(banner.getByRole('button', { name: 'Accept', exact: true }));
    const status = (await page.locator('.status-message').textContent()) ?? '';
    await d.check(/Draft accepted/.test(status), 'Accept is confirmed in the status line', status);
    await d.hush();

    d.chapter('Finalize and export');
    await d.step('Finalize');
    await page.locator('.readiness').waitFor();
    await d.waitFor(() => !window.__dcad.tools.getState().crown?.computing);
    await d.say('Finalize measures the crown once more and lists what is ready to mill.', { wait: false });
    await d.point(page.locator('.readiness').first(), 3500);
    await d.hush();
    const exportButton = page.getByRole('button', { name: /^Export STL/ });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /^Export STL/.test(b.textContent ?? '') && !b.disabled));
    await d.say('Export STL downloads the crown for your milling or printing software.', { wait: false });
    const stl = await d.download(async () => {
      await d.click(exportButton);
      const anyway = page.getByRole('button', { name: 'Export STL anyway' });
      if (await anyway.isVisible().catch(() => false)) await d.click(anyway);
    });
    const triangles = stlTriangles(stl);
    await d.check(triangles > 1000, `The exported STL is a crown mesh (${triangles.toLocaleString('en')} triangles)`, stl);
    await d.hush();
    const end = page.getByRole('region', { name: 'What next' });
    await end.waitFor();
    await d.check(await end.getByRole('button', { name: 'Create an account' }).isVisible(), 'After the export, the demo says what to do next');
    await d.say('The demo ends by offering an account, to keep your cases, or a fresh case from your own scans.', { wait: false });
    await d.point(end, 4000);
    await d.hush();
  },
};
