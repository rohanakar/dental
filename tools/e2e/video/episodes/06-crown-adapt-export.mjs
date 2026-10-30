// Episode 06: the crown on 36 of the demo case, by hand: propose, change how it is shown, move it (keys, pad, gizmo,
// undo), adapt it, export it, and save and reopen the project (as offline-design.mjs and crown-move.mjs).
import { readFileSync } from 'node:fs';
import { stlSolid } from '../lib.mjs';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crownIdle = (d) =>
  d.waitFor(() => {
    const t = window.__dcad.tools.getState();
    return t.crown && !t.crown.computing && t.crown.validation && !t.busy;
  });
const tooth36 = (d) =>
  d.state(() => {
    const s = window.__dcad.design.getState();
    const t = s.doc.teeth.find((x) => x.fdi === 36);
    return { pose: t.crown?.pose, frame: t.frame, steps: t.steps, past: s.past.length };
  });
/** The lowest occlusal clearance on the crown's outer surface (negative: it bites into the antagonist). */
const minOcclusion = (d) =>
  d.state(() => {
    const r = window.__dcad.crownTool.current();
    let m = Infinity;
    for (let v = r.shellStart; v < r.maps.occlusion.length; v++) if (Number.isFinite(r.maps.occlusion[v])) m = Math.min(m, r.maps.occlusion[v]);
    return m;
  });
/** Drags a range input's thumb to `value` with the cursor. */
async function slide(d, locator, value) {
  const box = await locator.boundingBox();
  const { min, max, now } = await locator.evaluate((el) => ({ min: Number(el.min), max: Number(el.max), now: Number(el.value) }));
  const x = (v) => box.x + 8 + ((box.width - 16) * (v - min)) / (max - min);
  await d.drag({ x: x(now), y: box.y + box.height / 2 }, { x: x(value), y: box.y + box.height / 2 }, { ms: 900 });
}
/**
 * The screen point of the gizmo's occlusal (Z) handle: walks out from the gizmo's centre along the projected occlusal
 * direction and keeps the middle of the stretch that the gizmo's own hit test calls the Z axis.
 */
const occlusalHandle = (d) =>
  d.state(() => {
    const v = window.__dcad.viewer;
    const g = v.gizmo;
    const p = g.proxy.position;
    const o = window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).frame.occlusal;
    const a = v.project([p.x, p.y, p.z]);
    const b = v.project([p.x + o[0], p.y + o[1], p.z + o[2]]);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const r = v.renderer.domElement.getBoundingClientRect();
    const hits = [];
    for (let off = 12; off <= 160; off += 3) {
      const x = a.x + dir.x * off;
      const y = a.y + dir.y * off;
      const ndc = { x: ((x - r.left) / r.width) * 2 - 1, y: -(((y - r.top) / r.height) * 2 - 1) };
      if (g.hitTest(ndc) && g.controls.axis === 'Z') hits.push(off);
    }
    g.hitTest({ x: 9, y: 9 }); // clear the hover highlight
    if (!hits.length) return null;
    const off = hits[Math.floor(hits.length / 2)];
    return { x: a.x + dir.x * off, y: a.y + dir.y * off, dir, pxPerMm: len };
  });

export default {
  id: '06-crown-adapt-export',
  title: 'The crown: propose, move, adapt, export',
  summary: 'Propose a library crown on your margin, change how it is shown, move it by keys, pad or gizmo, adapt it to the bite and the neighbours, export it, and save the project.',
  learn: ['Propose a crown and read its status', 'Opacity, colour maps and the focus view', 'Move with arrow keys, the pad or the gizmo', 'Adapt, export, and save the project file'],
  start: 'app/?demo',
  intro: 'In this episode you design the crown by hand: propose it, look at it, move it, fit it to its neighbours, and export it.',
  outro: 'You have designed, adapted, exported and saved a crown by hand.',
  /** Under the title card: the demo's margin and axis, found on entering their steps. */
  async setup(d) {
    const { page } = d;
    const rail = (label) => page.getByRole('navigation', { name: 'Design steps' }).getByRole('button', { name: label }).first().click();
    await d.waitFor(() => window.__dcad?.design.getState().activeStep === 'frame' && Boolean(window.__dcad.viewer) && Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));
    await rail('Margin');
    await d.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.margin) && window.__dcad.tools.getState().surface === 'ready');
    await rail('Insertion axis');
    await d.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.axis) && !window.__dcad.tools.getState().busy);
    await rail('Crown proposal');
    await d.settle();
  },
  async run(d) {
    const { page } = d;
    const panel = page.locator('aside.panel');

    d.chapter('Propose the crown');
    await d.say('Tooth 36 has its margin and insertion axis. You are on the Crown proposal step.', { wait: false });
    await d.point(page.getByRole('navigation', { name: 'Design steps' }).getByRole('button', { name: 'Crown proposal' }), 2600);
    await d.hush();
    await d.say('Press Propose crown. A library tooth is sized to the gap and the bite, and seated on your margin.', { wait: false });
    await d.click(page.getByRole('button', { name: 'Propose crown', exact: true }));
    await crownIdle(d);
    const proposed = await d.state(() => window.__dcad.tools.getState().crown.validation);
    await d.check(proposed.ok && proposed.closed && proposed.printable, 'The proposed crown is a closed, printable solid', proposed);
    await d.hush();
    await d.settle();
    await d.say('Below the button you read the result: watertight, and the thinnest point against the material minimum.', { wait: false });
    await d.point(panel.locator('dl.params').first(), 5200);
    await d.hush();

    d.chapter('How the crown is shown');
    await d.panelTo('.view-controls');
    await d.say('The View box changes only what you see. Lower the crown opacity to look through the crown at the prep.', { wait: false });
    const opacity = page.getByRole('slider', { name: 'Crown opacity' });
    await slide(d, opacity, 0.35);
    await d.check((await d.state(() => window.__dcad.tools.getState().crownOpacity)) < 0.5, 'The crown is see-through at low opacity');
    await d.hush();
    await d.pause(600);
    await slide(d, opacity, 1);
    const map = page.getByLabel('Colour map');
    await d.say('Colour map paints a measurement on the crown. Material thickness: the thinner the wall, the warmer the colour.', { wait: false });
    await d.select(map, 'thickness');
    const thickness = await d.waitFor(() => window.__dcad.tools.getState().legend?.title === 'Material thickness' && !window.__dcad.tools.getState().crown.computing, null, 30000).then(() => true, () => false);
    await d.check(thickness, 'The thickness map is on, with its legend');
    await d.hush();
    await d.say('Occlusal clearance shows the room left to the opposing teeth. Red means the crown still bites into them; adapting will fix that.', { wait: false });
    await d.select(map, 'occlusion');
    await d.waitFor(() => window.__dcad.tools.getState().legend?.title === 'Occlusal clearance' && !window.__dcad.tools.getState().crown.computing);
    await d.point(page.locator('.legend').first(), 2400);
    await d.hush();
    const focus = page.getByLabel('Focus on the prep');
    await d.say('Focus on the prep dims the gums, the neighbours and the opposing jaw. Untick it to see everything as scanned.', { wait: false });
    await d.point(focus, 2000);
    await d.pause(2600);
    await d.click(focus);
    await d.check(!(await d.state(() => window.__dcad.tools.getState().focusPrep)), 'Focus off shows the scans as they are');
    await d.pause(1200);
    await d.click(focus);
    await d.check(await d.state(() => window.__dcad.tools.getState().focusPrep), 'Focus on dims the surroundings again');
    await d.hush();

    d.chapter('Move the crown');
    const before = await tooth36(d);
    const s = await d.stage();
    await d.say('To move the crown, click an empty spot in the view, then use the arrow keys: 0.1 millimetres a press, 0.5 with Shift.', { wait: false });
    await d.clickAt(s.x + 40, s.y + 40);
    await d.hush();
    await d.press('Shift+ArrowLeft', 'Move 0.5 mm mesial');
    await crownIdle(d);
    const moved = await tooth36(d);
    const mesialMm = dot(sub(moved.pose.position, before.pose.position), before.frame.mesial);
    await d.check(Math.abs(mesialMm - 0.5) < 0.01, `Shift and an arrow moved the crown ${mesialMm.toFixed(2)} mm mesially`);
    await d.say('Every move is one undo step. Control Z puts it back.', { wait: false });
    await d.pause(1500);
    await d.press('Control+z', 'Undo');
    await crownIdle(d);
    await d.check(JSON.stringify((await tooth36(d)).pose) === JSON.stringify(before.pose), 'Undo puts the crown back where it was');
    await d.hush();

    await d.panelTo('.nudge-pad');
    await d.say('The pad does the same with the mouse: arrows to move, then rotate or scale about each of the tooth’s axes.', { wait: false });
    const buccal = page.getByRole('button', { name: 'Move crown 0.1 mm buccal' });
    await d.click(buccal);
    await d.click(buccal);
    await d.click(page.getByRole('button', { name: 'Rotate crown 2 degrees about the Occlusal axis' }));
    await crownIdle(d);
    const padded = await tooth36(d);
    const buccalMm = dot(sub(padded.pose.position, before.pose.position), before.frame.buccal);
    await d.check(Math.abs(buccalMm - 0.2) < 0.01 && padded.past === before.past + 3, `The pad moved the crown ${buccalMm.toFixed(2)} mm buccally and turned it, three undo steps`);
    await d.hush();
    for (let i = 0; i < 3; i++) await d.press('Control+z', 'Undo');
    await crownIdle(d);
    await d.check(JSON.stringify((await tooth36(d)).pose) === JSON.stringify(before.pose), 'Three undos restore the crown');

    await d.settle();
    const biteBefore = await minOcclusion(d);
    const handle = await occlusalHandle(d);
    await d.say('You can also drag the gizmo on the crown. The blue arrow moves it along the tooth’s axis, up and down.', { wait: false });
    if (handle) {
      await d.moveTo(handle.x, handle.y);
      await d.pause(500);
      await d.drag({ x: handle.x, y: handle.y }, { x: handle.x + handle.dir.x * handle.pxPerMm * 0.6, y: handle.y + handle.dir.y * handle.pxPerMm * 0.6 }, { ms: 1300 });
      await d.waitFor((n) => window.__dcad.design.getState().past.length > n, before.past, 20000).catch(() => {});
      await crownIdle(d);
    }
    const raised = await tooth36(d);
    const upMm = raised.pose ? dot(sub(raised.pose.position, before.pose.position), before.frame.occlusal) : 0;
    await d.check(Boolean(handle) && upMm > 0.3, `The gizmo raised the crown ${upMm.toFixed(2)} mm`);
    await d.hush();
    const bite = await minOcclusion(d);
    await d.say('Raised like this, the crown bites deeper into the opposing teeth, and the red spreads. Undo takes the move back.', { wait: false });
    await d.check(bite < biteBefore - 0.3, `Raising the crown deepens the collision to ${bite.toFixed(2)} mm`, { before: biteBefore, after: bite });
    await d.orbit(90, -30);
    await d.hush();
    await d.press('Control+z', 'Undo');
    await crownIdle(d);
    await d.orbit(-90, 30);

    d.chapter('Adapt');
    await d.step('Adapt');
    await crownIdle(d);
    await d.say('Adapt fits the crown to what is around it. Each row has a target clearance in millimetres, and a button.', { wait: false });
    await d.point(panel.locator('.adapt-row').first(), 3000);
    await d.hush();
    const adapt = async (button, key) => {
      await d.click(page.getByRole('button', { name: button, exact: true }));
      await d.waitFor((k) => {
        const c = window.__dcad.tools.getState().crown;
        return c && !c.computing && c.adapt?.[k];
      }, key);
      return d.state((k) => {
        const r = window.__dcad.tools.getState().crown.adapt[k];
        return { min: r.minClearanceMm, target: r.targetMm, open: Boolean(r.open), conflict: Boolean(r.conflict) };
      }, key);
    };
    await d.say('Adapt occlusion moves the biting surface until its closest point is at the target, here 0.05 millimetres.', { wait: false });
    const occ = await adapt('Adapt occlusion', 'occlusion');
    await d.check(Math.abs(occ.min - occ.target) < 0.01 && !occ.conflict, `Occlusion adapted: closest ${occ.min.toFixed(2)} mm, target ${occ.target} mm`, occ);
    const cleared = await minOcclusion(d);
    await d.check(cleared > 0.03, 'The red collision is gone from the occlusion map', `${cleared.toFixed(3)} mm`);
    await d.hush();
    await d.say('Then the two contacts with the neighbours, at 0.02 millimetres each.', { wait: false });
    const mesial = await adapt('Adapt mesial contact', 'mesial');
    const distal = await adapt('Adapt distal contact', 'distal');
    await d.check(
      [mesial, distal].every((c) => Math.abs(c.min - c.target) < 0.01 && !c.open && !c.conflict),
      `Both contacts adapted to ${mesial.target} mm`,
      { mesial, distal },
    );
    await d.hush();
    await d.settle();

    await d.step('Crown proposal');
    await crownIdle(d);
    await d.say('A move after adapting switches the adaptation off. Watch: one press of the left arrow.', { wait: false });
    const s2 = await d.stage();
    await d.clickAt(s2.x + 40, s2.y + 40);
    await d.hush();
    await d.press('ArrowLeft', 'Move 0.1 mm mesial');
    const reAdapt = page.getByRole('button', { name: 'Re-adapt' });
    await reAdapt.waitFor();
    await d.check((await tooth36(d)).steps.adapt === 'stale', 'The move switched the adaptation off');
    await d.say('The notice says so. Press Re-adapt to fit the moved crown again, with the same targets.', { wait: false });
    await d.point(page.locator('.readapt').first(), 2200);
    await d.pause(1400);
    await d.click(reAdapt);
    await d.waitFor(() => {
      const t = window.__dcad.tools.getState();
      return !t.crown.computing && t.crown.adapt?.occlusion && window.__dcad.design.getState().doc.teeth.find((x) => x.fdi === 36).steps.adapt === 'done';
    });
    const again = await d.state(() => Object.fromEntries(Object.entries(window.__dcad.tools.getState().crown.adapt).map(([k, r]) => [k, { min: r.minClearanceMm, target: r.targetMm ?? r.clearanceMm }])));
    await d.check(
      Math.abs(again.occlusion.min - 0.05) < 0.01 && Math.abs(again.mesial.min - 0.02) < 0.01 && Math.abs(again.distal.min - 0.02) < 0.01,
      'Re-adapt brings the moved crown back to its targets',
      again,
    );
    await d.hush();

    d.chapter('Export');
    await d.step('Finalize');
    await crownIdle(d);
    await page.waitForFunction(() => [...document.querySelectorAll('.readiness li')].every((li) => !/Measuring/.test(li.textContent ?? '')), null, { timeout: 60000 }).catch(() => {});
    await d.say('Finalize measures the crown one last time. Export STL writes the crown for your mill or printer.', { wait: false });
    await d.point(page.locator('.readiness').first(), 2500);
    const stl = await d.download(async () => {
      await d.click(page.getByRole('button', { name: /^Export STL/ }));
      const anyway = page.getByRole('button', { name: 'Export STL anyway', exact: true });
      if (await anyway.isVisible().catch(() => false)) await d.click(anyway);
    });
    const solid = await stlSolid(stl);
    await d.check(solid.ok && solid.closed && solid.components === 1 && solid.genus === 0, `The STL is one closed solid (${solid.triangles.toLocaleString('en')} triangles)`, solid);
    await d.hush();
    await d.say('Construction info is a JSON file with the margin, the axis, the parameters and the checks, for your records.', { wait: false });
    const infoPath = await d.download(() => d.click(page.getByRole('button', { name: 'Construction info', exact: true })));
    const info = JSON.parse(readFileSync(infoPath, 'utf8'));
    await d.check(info.fdi === 36 && info.margin?.points?.length > 20 && info.axis?.direction?.length === 3 && info.validation?.ok, 'The construction info holds the margin, the axis and the checks');
    await d.hush();

    d.chapter('Save and reopen');
    const volume = await d.state(() => window.__dcad.tools.getState().crown.validation.signedVolumeMm3);
    await d.say('Download project saves the design and its scans as one file. It works offline too.', { wait: false });
    const project = await d.download(() => d.click(page.getByRole('button', { name: 'Download project', exact: true })));
    await d.check(readFileSync(project).length > 100000, 'The project file holds the design and its scans');
    await d.hush();
    await d.say('To show it comes back, we start the editor again, empty.');
    await d.goto('app/');
    const offline = page.getByRole('button', { name: /continue offline/i });
    if (await offline.isVisible().catch(() => false)) await d.click(offline);
    await d.waitFor(() => Boolean(window.__dcad?.design) && window.__dcad.design.getState().doc.scans.length === 0);
    await d.hush();
    await d.say('Press Open project and pick the file. The scans, the margin, the axis and the crown all come back.', { wait: false });
    await d.click(page.getByRole('button', { name: 'Open project', exact: true }), { settleMs: 400 });
    await page.locator('input[type=file][accept*="zip"]').setInputFiles(project);
    await d.hush();
    await d.say('The scans are in the file too, so opening takes a few seconds.', { wait: false });
    await d.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.crown) && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === 2, null, 120000);
    await d.step('Adapt');
    await crownIdle(d);
    await d.settle();
    const reopened = await d.state(() => window.__dcad.tools.getState().crown.validation.signedVolumeMm3);
    await d.check(Math.abs(reopened - volume) < 0.01, `The reopened crown is the same (${reopened.toFixed(1)} mm³)`, { before: volume, after: reopened });
    await d.hush();
    await d.say('Here it is again, adapted and ready to finalize, to the hundredth of a cubic millimetre.', { wait: false });
    await d.orbit(80, 20);
    await d.hush();
  },
};
