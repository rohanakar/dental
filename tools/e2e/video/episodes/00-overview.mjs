// Episode 00: the landing page's short video. Scan to finished crown to STL export, about 65 seconds, no cards.
import { ALONG, stlTriangles } from '../lib.mjs';

export default {
  id: '00-overview',
  title: 'Dental CAD in 65 seconds',
  summary: 'From scans to a finished crown to an STL export, in the browser.',
  promo: true,
  start: '',
  intro: 'This is Dental CAD, crown design in a browser tab. Here is a crown, from scan to export, in about a minute.',
  outro: 'Scans in, a checked crown out, as an STL. Try the demo on the site; it needs no account.',
  async run(d) {
    const { page } = d;
    const demo = page.locator('a.button-secondary[href="app/?demo"]').first();
    await d.say('The demo needs no account. It opens synthetic scans of a lower jaw, prepared for a crown on tooth 36.', { wait: false });
    await d.point(demo, 2200);
    await d.hush();
    await d.click(demo);
    await d.waitFor(() => window.__dcad?.design.getState().activeStep === 'frame' && Boolean(window.__dcad.viewer) && Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));
    await d.settle();
    const opened = await d.state(() => window.__dcad.design.getState().doc.scans.length);
    await d.check(opened === 2, 'The demo opens with both jaws loaded', opened);
    const seed = await d.synthetic('syntheticPrepSeed', { along: ALONG });
    const origin = (await d.tooth(36)).frame.origin;
    await d.check(Math.hypot(...origin.map((o, k) => o - seed[k])) < 1, 'Tooth 36 is already framed on its prep');

    const region = page.getByRole('region', { name: 'Auto-design' });
    const run = region.getByRole('button', { name: 'Auto-design crown' });
    await d.say('One click runs every step: the margin, the insertion axis, the crown, and its fit to the bite and the neighbours.', { wait: false });
    await d.click(run);
    await d.waitFor(() => {
      const o = window.__dcad.orchestrator.getState();
      return !o.running && (o.pendingReview || o.error);
    });
    const result = await d.state(() => {
      const o = window.__dcad.orchestrator.getState();
      return { complete: o.complete, error: o.error };
    });
    await d.check(result.complete && !result.error, 'Auto-design gives a complete draft', result);
    await d.hush();
    await d.settle();

    const banner = region.locator('.auto-banner');
    // The verdict waits for the rows under it to be measured.
    await page.waitForFunction(() => /all \d+ checks passed|stopped/.test(document.querySelector('.auto-banner strong')?.textContent ?? ''), null, { timeout: 60000 });
    const verdict = (await banner.locator('strong').textContent())?.trim() ?? '';
    await d.check(/^Draft ready: all \d+ checks passed$/.test(verdict), verdict || 'The draft has a verdict line');
    await d.say('Nothing reaches you until it passes its measured checks. Thickness, contacts, a closed margin, a watertight mesh.', { wait: false });
    await page.waitForFunction(() => [...document.querySelectorAll('.readiness.compact li')].every((li) => !/Measuring/.test(li.textContent ?? '')), null, { timeout: 60000 }).catch(() => {});
    await d.point(banner.locator('.readiness.compact'), 5000);
    await d.hush();
    await d.say('Every check of every step is listed, with its measured value, so you can see why the draft passed.', { wait: false });
    await d.click(banner.locator('summary'));
    await d.pause(3800);
    await d.click(banner.locator('summary'));
    await d.hush();
    await d.say('Look the crown over in 3D, and accept it, or reject it.', { wait: false });
    await d.orbit(110, 20);
    await d.orbit(-220, -20);
    await d.orbit(110, 0);
    await d.hush();
    await d.say('The colours on the crown show the room to the opposing teeth: blue is space to spare, red would be a collision.');
    await d.click(banner.getByRole('button', { name: 'Accept', exact: true }));
    await d.step('Finalize');
    await page.locator('.readiness').waitFor();
    await d.waitFor(() => !window.__dcad.tools.getState().crown?.computing);
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /^Export STL/.test(b.textContent ?? '') && !b.disabled));
    await d.say('Export STL gives you the crown for your mill or printer.', { wait: false });
    const stl = await d.download(async () => {
      await d.click(page.getByRole('button', { name: /^Export STL/ }));
      const anyway = page.getByRole('button', { name: 'Export STL anyway' });
      if (await anyway.isVisible().catch(() => false)) await d.click(anyway);
    });
    const triangles = stlTriangles(stl);
    await d.check(triangles > 1000, `The exported STL is a crown mesh (${triangles.toLocaleString('en')} triangles)`, stl);
    await d.hush();
  },
};
