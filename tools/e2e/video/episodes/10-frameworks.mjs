// Episode 10: a reduced CoCr crown on 36 for veneering (as framework.mjs): the order in Case setup, the framework the
// proposal cuts back from the anatomy, the Adapt cutback panel (views, veneer-space map, a 1.2 mm edit with an overpress
// part), and the framework and overpress exports, each a closed solid.
import { readFileSync } from 'node:fs';
import { ALONG, stlSolid } from '../lib.mjs';

/** Whether a scene object is shown in the viewer. */
const shown = (d, id) => d.state((k) => window.__dcad.viewer.objects.get(k)?.visible ?? window.__dcad.viewer.objects.get(k)?.mesh?.visible ?? null, id);

export default {
  id: '10-frameworks',
  title: 'Frameworks for veneering',
  summary: 'Order a reduced crown, and the proposal becomes a metal framework cut back for porcelain. Set the veneering space in Adapt, see it as a map, and export the framework and its overpress part.',
  learn: ['Order a reduced CoCr crown in Case setup', 'The framework under the anatomy', 'Cutback: views, veneer-space map, edits', 'Export the framework and overpress STL'],
  start: 'app/',
  intro: 'In this episode the crown is not milled in one piece. We design a metal framework for a porcelain-fused crown, with room left for the porcelain.',
  outro: 'You have designed a framework with even room for the porcelain, and exported it with its overpress part.',
  async setup(d) {
    await d.openOffline({ autoFrames: false });
    await d.page.getByRole('button', { name: /continue offline/i }).click();
    await d.waitFor(() => window.__dcad.design.getState().activeStep === 'setup');
  },
  async run(d) {
    const { page } = d;

    d.chapter('Order a reduced crown');
    await d.say('Start in Case setup. Tooth 36 is in the case as a full crown. Open More types for 36 to see the other options.', { wait: false });
    await d.moreTypes(36);
    await d.hush();
    await d.say('Choose Reduced: the crown becomes a framework, cut back to leave room for veneering porcelain.', { wait: false });
    await d.click(page.getByRole('group', { name: 'Anatomic or reduced 36' }).getByRole('button', { name: 'Reduced' }));
    await d.hush();
    await d.say('Then pick the framework material, here cobalt chrome.', { wait: false });
    await d.select(page.getByLabel('Material for 36'), 'cocr');
    const order = await d.state(() => window.__dcad.design.getState().doc.setup.teeth.find((t) => t.fdi === 36));
    await d.check(order.restoration === 'reduced-crown' && order.material === 'cocr', 'Setup: 36 is a reduced crown in CoCr', order);
    await d.hush();

    d.chapter('Scans, frame, margin and axis');
    await d.say('Load the demo scans. The next steps are the same as for a full crown, and earlier episodes show them in detail.', { wait: false });
    await d.click(page.getByRole('button', { name: /load demo scans/i }).first());
    await d.waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2);
    await d.hush();
    await d.step('Tooth frame');
    await d.blur();
    await d.press('1', 'Occlusal view');
    await d.settle();
    await d.say('On Tooth frame, click the top of the prepared tooth.', { wait: false });
    await d.clickWorld(await d.synthetic('syntheticPrepSeed', { along: ALONG }), { objectIds: ['lower'] });
    await d.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame), null, 60000);
    await d.check(Boolean((await d.tooth(36)).frame), 'Tooth 36 is framed on its prep');
    await d.hush();
    await d.say('On the Margin step, Find the margin traces the finish line for you to review.', { wait: false });
    await d.step('Margin');
    await d.waitFor(() => window.__dcad.tools.getState().surface === 'ready');
    await d.settle();
    await d.pause(1500);
    if (!(await d.tooth(36)).margin) {
      await d.click(page.getByRole('button', { name: 'Find the margin', exact: true }));
    }
    await d.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.margin) && !window.__dcad.tools.getState().busy, null, 60000);
    const margin = (await d.tooth(36)).margin;
    await d.check(margin.points.length > 20, `The margin is a closed line of ${margin.points.length} points`);
    await d.hush();
    await d.say('The insertion axis is proposed as soon as you open its step.', { wait: false });
    await d.step('Insertion axis');
    await d.waitFor(() => Boolean(window.__dcad.tools.getState().axisReport) && !window.__dcad.tools.getState().busy);
    await d.settle();
    await d.hush();

    d.chapter('The framework');
    await d.step('Crown proposal');
    await d.say('Propose crown. The app designs the full anatomic crown first, then cuts it back by the veneering space. What you print or cast is the framework underneath.', { wait: false });
    await d.click(page.getByRole('button', { name: 'Propose crown', exact: true }));
    await d.waitFor(() => Boolean(window.__dcad.crownTool.current()?.framework));
    const fw = await d.state(() => {
      const f = window.__dcad.crownTool.current().framework;
      return { printable: f.validation.printable, thin: f.stats.thinVertices, within: f.stats.offsetWithinTolerance, min: +f.stats.minMm.toFixed(2), cutback: f.cutback };
    });
    await d.check(fw.printable, 'The framework is printable', fw.cutback);
    await d.check(fw.thin === 0 && fw.within >= 0.99, 'The veneering space is as requested all over', { thin: fw.thin, within: fw.within, min: fw.min });
    await d.settle();
    await d.hush();
    await d.orbit(100, 0);
    await d.orbit(-100, 0);

    d.chapter('Cutback in Adapt');
    await d.step('Adapt');
    await d.waitFor(() => Boolean(document.querySelector('#cutback-head')) && !window.__dcad.tools.getState().crown?.computing);
    await d.say('On Adapt, first fit the anatomy to the bite and both neighbours, as for a full crown. The framework is cut back from the adapted anatomy.', { wait: false });
    for (const [button, key] of [['Adapt occlusion', 'occlusion'], ['Adapt mesial contact', 'mesial'], ['Adapt distal contact', 'distal']]) {
      await d.click(page.getByRole('button', { name: button, exact: true }));
      await d.waitFor((k) => {
        const c = window.__dcad.tools.getState().crown;
        return c && !c.computing && c.adapt?.[k];
      }, key);
    }
    const adapted = await d.state(() => {
      const f = window.__dcad.crownTool.current().framework;
      return { adapt: Object.keys(window.__dcad.tools.getState().crown.adapt ?? {}), printable: f?.validation.printable };
    });
    await d.check(['occlusion', 'mesial', 'distal'].every((k) => adapted.adapt.includes(k)) && adapted.printable, 'Adapted to the bite and both neighbours, the framework still printable', adapted);
    await d.hush();
    await d.panelTo('#cutback-head');
    await d.settle();
    await d.check((await shown(d, 'framework:36')) === true && (await shown(d, 'crown')) === false, 'Framework view: the framework shown, the anatomy hidden');
    await d.say('Below is the Cutback panel, for the framework. The view shows the framework alone.', { wait: false });
    await d.point(page.locator('fieldset.cutback'), 3500);
    await d.hush();
    const views = page.getByRole('group', { name: 'Show anatomy, framework or both' });
    await d.say('Both shows the anatomy as a ghost over the framework, so you can see the porcelain space between them.', { wait: false });
    await d.click(views.getByRole('button', { name: 'Both' }));
    await d.check((await shown(d, 'framework:36')) === true && (await shown(d, 'crown')) === true, 'Both view: the framework under the anatomy');
    await d.hush();
    await d.pause(800);
    await d.say('The veneer-space map colours the framework by the room for porcelain above it, so a thin spot stands out.', { wait: false });
    await d.click(page.getByLabel('Veneer-space map'));
    await d.check((await d.state(() => window.__dcad.tools.getState().legend?.title ?? null)) === 'Veneer space', 'The veneer-space map has its legend');
    await d.hush();
    await d.orbit(90, 30);
    await d.orbit(-90, -30);
    const space = page.getByLabel('Veneering space (mm)');
    await d.say('To give the porcelain more room, set the veneering space to 1.2 millimetres and press Enter. The framework is cut again.', { wait: false });
    await d.type(space, '1.2', { delay: 70 });
    await d.press('Enter', 'Apply');
    await d.waitFor(() => window.__dcad.crownTool.current()?.framework?.cutback.thicknessMm === 1.2 && !window.__dcad.tools.getState().crown?.computing);
    await d.hush();
    const shortfall = await d.state(() => window.__dcad.crownTool.current().framework.shortfall ?? null);
    if (shortfall) {
      await d.say('Where the prep is too tall, the framework keeps its minimum thickness, so the porcelain gets less room. The panel warns you, and the map shows where.', { wait: false });
      const warning = page.locator('fieldset.cutback .warning').first();
      if (await warning.count()) await d.point(warning, 4000);
      await d.hush();
    }
    await d.say('Overpress part also exports the porcelain shape, the anatomy minus the framework, to press in wax.', { wait: false });
    await d.click(page.getByLabel('Overpress part'));
    await d.waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).cutback?.overpress === true);
    const edited = await d.state(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).cutback);
    await d.check(edited.thicknessMm === 1.2 && edited.overpress, 'The 1.2 mm cutback and the overpress part are stored on 36', edited);
    await d.waitFor(() => !window.__dcad.tools.getState().crown?.computing);
    const recut = await d.state(() => {
      const f = window.__dcad.crownTool.current().framework;
      return { printable: f.validation.printable, thicknessMm: f.cutback.thicknessMm };
    });
    await d.check(recut.printable && recut.thicknessMm === 1.2, 'The re-cut framework is still printable', recut);
    await d.hush();

    d.chapter('Finalize and export');
    await d.step('Finalize');
    await d.waitFor(() => Boolean(document.querySelector('#framework-head')) && !document.querySelector('.readiness .detail')?.textContent?.includes('Measuring'));
    await d.pause(1000);
    const head = await page.locator('#readiness-head').innerText();
    await d.check(/Ready to mill/.test(head), 'Finalize: the framework is ready to mill', head);
    await d.panelTo('#framework-head');
    await d.say('Finalize has a Framework section. Export STL writes the framework, and Overpress STL writes the porcelain part.', { wait: false });
    await d.point(page.locator('section.framework-finalize'), 3500);
    const exportButton = page.getByRole('button', { name: /^Export STL/ });
    const label = await exportButton.innerText();
    const stl = await d.download(async () => {
      await d.click(exportButton);
      if (label.includes('anyway')) await d.click(page.getByRole('button', { name: 'Export STL anyway', exact: true }));
    });
    const frame = await stlSolid(stl);
    await d.check(stl.endsWith('case-36-framework.stl') && frame.ok && frame.components === 1, 'The framework STL is one closed solid', frame);
    const over = await d.download(() => d.click(page.getByRole('button', { name: 'Overpress STL 36' })));
    const part = await stlSolid(over);
    await d.check(over.endsWith('case-36-overpress.stl') && part.ok, 'The overpress STL is a closed solid', part);
    const info = await d.download(() => d.click(page.getByRole('button', { name: 'Construction info' })));
    const sidecar = JSON.parse(readFileSync(info, 'utf8'));
    await d.check(Boolean(sidecar.framework), 'The construction info records the framework', Object.keys(sidecar.framework ?? {}));
    await d.hush();
    await d.say('Construction info records the cutback with the rest of the design, for the lab that veneers it.');
  },
};
