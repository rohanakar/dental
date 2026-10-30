// Episode 05: the Insertion axis and Parameters steps on the demo's 36 prep. The least-undercut axis proposed on entry,
// tilting it until the undercut map shows a hidden wall, undo, Along my view and Least undercut; then the parameters,
// a refused out-of-range value, the cement gap, and a crown that measures as set and changes with the preset.

/** The axis report once the map is computed and not busy. */
const axisNow = (d) =>
  d.state(() => {
    const t = window.__dcad.design.getState().doc.teeth.find((x) => x.fdi === 36);
    return { axis: t.axis, report: window.__dcad.tools.getState().axisReport, busy: window.__dcad.tools.getState().busy };
  });
const axisAt = (d, test, arg) =>
  d.waitFor(
    ([source, arg2]) => {
      const tools = window.__dcad.tools.getState();
      const r = tools.axisReport;
      // eslint-disable-next-line no-new-func
      return Boolean(r && !tools.busy && new Function('r', 'axis', 'arg', `return ${source}`)(r, window.__dcad.design.getState().doc.teeth.find((x) => x.fdi === 36).axis, arg2));
    },
    [test, arg],
    60000,
  );
const paramsOf = (d) => d.state(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).params);
/** The crown once it is computed. */
const crownNow = (d) =>
  d
    .waitFor(() => {
      const c = window.__dcad.tools.getState().crown;
      return Boolean(c && !c.computing && c.validation);
    }, null, 120000)
    .then(() =>
      d.state(() => {
        const c = window.__dcad.tools.getState().crown;
        return { ok: c.validation.ok, gapErrorMm: c.gapCheck?.meanErrorMm, thinnestMm: c.thickness?.minMm };
      }),
    );

export default {
  id: '05-axis-and-parameters',
  title: 'Insertion axis and parameters',
  summary: 'Choose the direction the crown seats along and read its undercut map, then set the cement gap, thicknesses and contact targets the crown is built with.',
  learn: ['The least-undercut axis', 'Tilt the axis and read the undercut map', 'Set the axis along your view', 'Cement gap, thickness and contact targets'],
  start: 'app/?demo',
  intro: 'Two short steps sit between the margin and the crown: the insertion axis, the direction the crown goes on, and the parameters it is built with.',
  outro: 'The axis and the parameters are set.',
  async setup(d) {
    await d.waitFor(() => window.__dcad?.design.getState().activeStep === 'frame' && Boolean(window.__dcad.viewer) && Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));
    // The margin, found as in episode 04, under the title card.
    await d.state(() => window.__dcad.design.getState().setActiveStep('margin'));
    await d.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.margin));
    await d.settle();
  },
  async run(d) {
    const { page } = d;

    // ---- The least-undercut axis ------------------------------------------------------------------------------------
    d.chapter('The least-undercut axis');
    await d.say('We start with the margin of 36 found, as in the last episode. Open Insertion axis.', { wait: false });
    await d.pause(2800);
    await d.step('Insertion axis');
    await axisAt(d, 'axis.source === "auto"');
    await d.settle();
    await d.hush();
    const auto = await axisNow(d);
    await d.check(auto.axis.source === 'auto' && auto.report.undercutAreaMm2 === 0, 'An axis with no undercut is proposed on entering the step', auto.report);
    await d.say('The step proposes the axis with the least undercut: the arrow shows the direction the crown slides on.', { wait: false });
    await d.pause(3500);
    await d.hush();
    await d.say('The panel measures it: the tilt from the tooth\'s own axis, the undercut area and the deepest undercut. Here every wall can be seen along the axis.', { wait: false });
    await d.point(page.locator('dl.params'), 5000);
    await d.hush();

    // ---- Tilt, and the undercut map --------------------------------------------------------------------------------
    d.chapter('Tilt and the undercut map');
    const mesial = page.getByRole('button', { name: 'Tilt the axis 1° mesial' });
    await d.say('Each of these buttons tilts the axis by one degree. This prep is well tapered, so watch how far it goes before any wall is hidden.', { wait: false });
    await d.point(page.getByRole('group', { name: 'Tilt the axis by 1°' }), 2500);
    await d.pause(2600);
    await d.click(mesial);
    for (let i = 1; i < 30; i++) {
      await mesial.click();
      await d.pause(60);
    }
    await axisAt(d, 'r.angleFromOcclusalDeg > 29.5');
    await d.hush();
    const tilted = await axisNow(d);
    await d.check(tilted.report.undercutAreaMm2 > 0 && tilted.report.maxDepthMm > 0, `At 30°, the distal wall is in undercut (${tilted.report.undercutAreaMm2.toFixed(2)} mm²)`, tilted.report);
    await d.say('At thirty degrees, the far wall is hidden from the axis. It shows in colour, red where the blockout is deepest: the inside of the crown would be filled there.', { wait: false });
    await d.point(page.locator('.legend, .color-legend').first(), 3500).catch(() => {});
    await d.hush();
    await d.say('Ctrl Z undoes one tilt at a time.', { wait: false });
    await d.pause(1100);
    await d.press('Control+z', 'Undo');
    await axisAt(d, 'r.angleFromOcclusalDeg < 29.5');
    const undone = await axisNow(d);
    await d.check(Math.abs(undone.report.angleFromOcclusalDeg - 29) < 0.2, 'Undo takes back one degree', `${undone.report.angleFromOcclusalDeg.toFixed(1)}°`);
    await d.hush();

    // ---- Along my view, and back to the least undercut ---------------------------------------------------------------
    d.chapter('Along my view');
    await d.say('You can also set the axis by eye. Look onto the prep the way the crown should go on, here straight down with Occlusal, and click Along my view.', { wait: false });
    await d.pause(3600);
    await d.click(page.getByRole('button', { name: 'Occlusal', exact: true }));
    await d.settle();
    await d.hush();
    await d.click(page.getByRole('button', { name: 'Along my view', exact: true }));
    await axisAt(d, 'axis.source !== "auto" && r.angleFromOcclusalDeg < 29');
    const view = await d.state(() => window.__dcad.viewer.viewDirection().toArray());
    const byView = await axisNow(d);
    const along = -byView.axis.direction.reduce((s, x, k) => s + x * view[k], 0);
    await d.check(along > 0.999, 'Along my view sets the axis to the viewing direction', { cos: along, tilt: byView.report.angleFromOcclusalDeg });
    await d.hush();
    await d.say('Least undercut always takes you back to the best axis the software can find.', { wait: false });
    await d.pause(900);
    await d.click(page.getByRole('button', { name: 'Least undercut', exact: true }));
    await axisAt(d, 'axis.source === "auto"');
    const reset = await axisNow(d);
    await d.check(reset.report.undercutAreaMm2 === 0 && reset.report.angleFromOcclusalDeg < 1, 'Least undercut restores the axis with no undercut', reset.report);
    await d.hush();

    // ---- Parameters ----------------------------------------------------------------------------------------------------
    d.chapter('Parameters');
    await d.step('Parameters');
    // From above, the upper jaw (shown again from here on) would hide the lower one: look from the side.
    await d.click(page.getByRole('button', { name: 'Buccal', exact: true }));
    await d.say('Parameters are in millimetres. They start from the preset of the material chosen in Case setup, zirconia here.', { wait: false });
    await d.point(page.locator('.step-body > p.muted').first(), 2600);
    await d.hush();
    const fieldset = (name) => page.locator('fieldset').filter({ has: page.locator('legend', { hasText: name }) }).first();
    await d.say('Fit: the cement gap is the space for cement over the prep. The extra spacer adds more, starting a set distance from the margin.', { wait: false });
    await d.point(fieldset('Fit'), 6500);
    await d.hush();
    await d.say('Thickness: the crown edge at the margin, and the thinnest wall allowed anywhere else.', { wait: false });
    await d.point(fieldset('Thickness'), 4500);
    await d.hush();
    await d.say('Contact targets: how close the crown comes to the opposing teeth and to the neighbours. Below zero means a tighter contact.', { wait: false });
    await d.point(fieldset('Contact targets'), 5500);
    await d.hush();
    const preset = await paramsOf(d);
    const minThickness = page.getByLabel('Minimum thickness');
    await d.say('A value outside the allowed range is refused, and the field says what is allowed.', { wait: false });
    await d.type(minThickness, '5');
    await d.press('Enter', 'Apply');
    const error = page.locator('#param-minThicknessMm-error');
    await error.waitFor({ timeout: 5000 }).catch(() => {});
    await d.check((await error.isVisible()) && (await paramsOf(d)).minThicknessMm === preset.minThicknessMm, 'An out-of-range thickness is refused and the old value kept', { kept: (await paramsOf(d)).minThicknessMm });
    await d.hush();
    await d.pause(1200);
    await d.say('Now set a cement gap of 0.08 millimetres, and press Enter.', { wait: false });
    await d.type(page.getByLabel('Cement gap'), '0.08');
    await d.press('Enter', 'Apply');
    await d.waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).params.cementGapMm === 0.08, null, 10000).catch(() => {});
    await d.check((await paramsOf(d)).cementGapMm === 0.08, 'The cement gap is set to 0.08 mm');
    await d.hush();

    // ---- The crown follows the parameters ------------------------------------------------------------------------------
    d.chapter('The crown follows them');
    await d.say('The crown is built with these values. Open Crown proposal and propose the crown.', { wait: false });
    await d.pause(2000);
    await d.step('Crown proposal');
    await d.click(page.getByRole('button', { name: /propose crown/i }).first());
    const wide = await crownNow(d);
    await d.settle();
    await d.check(wide.ok && wide.gapErrorMm < 0.005, `The gap measured on the walls is the 0.08 mm set, within ${wide.gapErrorMm.toFixed(4)} mm`, wide);
    await d.hush();
    await d.say(`The software measures the gap on the walls of the prep: it matches the setting. The thinnest point of the crown is ${wide.thinnestMm.toFixed(2)} millimetres.`, { wait: false });
    await d.point(page.locator('.step-body dl.params').filter({ hasText: 'Thinnest point' }).first(), 4500);
    await d.hush();
    await d.say('Change a parameter, and the crown is rebuilt to match. Back in Parameters, Reset to the zirconia preset brings the gap back to 0.03.', { wait: false });
    await d.pause(2600);
    await d.step('Parameters');
    await d.click(page.getByRole('button', { name: /^Reset to the/ }));
    await d.waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).params.cementGapMm === 0.03, null, 10000).catch(() => {});
    await d.check(JSON.stringify(await paramsOf(d)) === JSON.stringify(preset), 'Reset puts every parameter back to the preset');
    await d.hush();
    await d.step('Crown proposal');
    const narrow = await crownNow(d);
    await d.check(narrow.ok && narrow.thinnestMm > wide.thinnestMm && narrow.gapErrorMm < 0.005, `With the smaller gap, the thinnest wall grows from ${wide.thinnestMm.toFixed(2)} to ${narrow.thinnestMm.toFixed(2)} mm`, narrow);
    await d.say(`With less room for cement, the wall is thicker: its thinnest point is now ${narrow.thinnestMm.toFixed(2)} millimetres.`, { wait: false });
    await d.point(page.locator('.step-body dl.params').filter({ hasText: 'Thinnest point' }).first(), 4000);
    await d.hush();
  },
};
