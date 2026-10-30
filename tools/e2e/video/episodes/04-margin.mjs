// Episode 04: the Margin step on the demo's 36 prep. The automatic line and how sure it is, the cross-section under
// the cursor, tracing by clicks with the live-wire (as offline-design.mjs), local edits (drag, insert, delete) with
// undo, raising the whole line until the doubt check flags it, N to fly there, and Enter to move on
// (specs/2026-10-27-margin-review-ux.md).
import { ALONG } from '../lib.mjs';

/** The margin of 36, or null. */
const marginOf = (d) => d.state(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.margin ?? null);

/** Mean and max distance (mm) of the margin's points from the synthetic prep's analytic finish line. */
const deviation = (d) =>
  d.state(async (along) => {
    const { syntheticPrepMargin } = await import('/src/geometry/synthetic.ts');
    const ref = syntheticPrepMargin({ along, samples: 720 });
    const m = window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).margin.points;
    let sum = 0;
    let max = 0;
    for (const { p } of m) {
      let best = Infinity;
      for (let i = 0; i < ref.length; i += 3) best = Math.min(best, Math.hypot(p[0] - ref[i], p[1] - ref[i + 1], p[2] - ref[i + 2]));
      sum += best;
      max = Math.max(max, best);
    }
    return { mean: sum / m.length, max, points: m.length };
  }, ALONG);

/** The doubt colouring once it is computed for the current line: the number of doubtful parts and the one shown. */
const doubtOf = (d) =>
  d
    .waitFor(() => {
      const m = window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.margin;
      const doubt = window.__dcad.tools.getState().marginDoubt;
      if (!m || !doubt || window.__dcad.tools.getState().busy) return false;
      // tools/marginLine.ts marginKey: the count and three points, to the micrometre.
      const r = (x) => Math.round((x ?? 0) * 1000);
      const pts = m.points;
      const key = [pts.length, ...[pts[0]?.p, pts[Math.floor(pts.length / 2)]?.p, pts.at(-1)?.p].flatMap((p) => [r(p?.[0]), r(p?.[1]), r(p?.[2])])].join(':');
      return doubt.key.startsWith(`${key}:`);
    }, null, 60000)
    .then(() => d.state(() => ({ parts: window.__dcad.tools.getState().marginDoubt.parts.length, current: window.__dcad.tools.getState().marginDoubt.current })));

const idle = (d) => d.waitFor(() => !window.__dcad.tools.getState().busy, null, 60000);

export default {
  id: '04-margin',
  title: 'The margin: find it, trace it, fix it',
  summary: 'Find the finish line automatically, judge it with its doubt check and the cross-section, trace it yourself with a few clicks, and fix any part of it without starting over.',
  learn: ['Find the margin and check how sure it is', 'Judge the edge in the cross-section', 'Trace it with clicks (live-wire)', 'Drag, add, delete and raise points'],
  start: 'app/?demo',
  intro: 'The margin is the line where the crown ends on the prep. In this episode you find it automatically, check it, trace it yourself, and correct it.',
  outro: 'That is the margin: found, checked, traced and corrected.',
  async setup(d) {
    await d.waitFor(() => window.__dcad?.design.getState().activeStep === 'frame' && Boolean(window.__dcad.viewer) && Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));
  },
  async run(d) {
    const { page } = d;

    // ---- The automatic line ----------------------------------------------------------------------------------------
    d.chapter('Find the margin');
    await d.say('We start on the demo case, with tooth 36 already framed. Open the Margin step on the rail.', { wait: false });
    await d.pause(2600);
    await d.step('Margin');
    await d.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.margin));
    await d.settle();
    await d.hush();
    const found = await marginOf(d);
    const foundDev = await deviation(d);
    const gap = Math.hypot(...found.points[0].p.map((x, k) => x - found.points.at(-1).p[k]));
    await d.check(found.source === 'auto' && gap < 0.5, 'The margin is found on entering the step, as a closed loop', { source: found.source, closingGapMm: gap });
    await d.check(foundDev.mean < 0.1, `The found line is ${foundDev.mean.toFixed(2)} mm from the true finish line on average`, foundDev);
    await d.say('The step finds the finish line for you, the edge the dentist cut, and draws it in red with its points.', { wait: false });
    await d.point(page.getByRole('group', { name: 'The line the margin follows' }), 2600);
    await d.hush();
    await d.say('Finish line is for a prepared tooth. Choose Gum line for a natural tooth, then press Find again.');
    const doubt0 = await doubtOf(d);
    await d.check(doubt0.parts === 0, 'The found line has no doubtful parts', doubt0);
    await d.say('The software also checks how sure it is of the line. Here the line is on a clear edge all the way round: no doubtful parts.', { wait: false });
    await d.point(page.locator('.margin-confidence'), 3200);
    await d.hush();

    // ---- The cross-section ------------------------------------------------------------------------------------------
    d.chapter('The cross-section');
    await d.panelTo('.margin-section');
    const ring = found.points.map((m) => m.p);
    const at = (i) => ring[Math.floor((i * ring.length) / 4) % ring.length];
    await d.say('To judge the edge yourself, move the cursor over the line. The panel shows the scan cut across it, with the margin as a dot on the profile.', { wait: false });
    for (const i of [0, 1]) {
      const s = await d.project(at(i));
      await d.moveTo(s.x, s.y, { ms: 900 });
      await d.pause(400);
      await d.point(page.locator('.section-plot'), 1800);
      await d.pause(1300);
    }
    const section = await d.state(() => window.__dcad.tools.getState().section);
    await d.check(Boolean(section?.segments.length) && section.marks.length > 0, 'The cross-section shows the scan profile with the margin on it', { segments: section?.segments.length, marks: section?.marks.length });
    await d.hush();
    await d.say('Up is toward the biting surface, right is outward. The margin should sit right on the corner of the profile.');

    // ---- Trace it yourself -----------------------------------------------------------------------------------------
    d.chapter('Trace it with clicks');
    await d.say('You can also trace the line yourself. First undo the found line.', { wait: false });
    await d.pause(2200);
    await d.press('Control+z', 'Undo');
    await d.waitFor(() => !window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).margin);
    await d.check(!(await marginOf(d)), 'Undo removes the found line');
    await d.hush();
    await d.waitFor(() => window.__dcad.tools.getState().surface === 'ready');
    const flat = await d.synthetic('syntheticPrepMargin', { along: ALONG, samples: 8 });
    const pts = [];
    for (let i = 0; i < flat.length; i += 3) pts.push([flat[i], flat[i + 1], flat[i + 2]]);
    await d.say('Click on the finish line to place the first point. Then click further round: between clicks, the path follows the edge on its own.', { wait: false });
    for (let i = 0; i < 4; i++) {
      await d.clickWorld(pts[i]);
      await d.pause(350);
    }
    await d.hush();
    await d.say('A click in the wrong place? Backspace removes the last point.', { wait: false });
    await d.pause(1700);
    await d.press('Backspace', 'Remove the last point');
    const afterBack = await d.state(() => window.__dcad.tools.getState().marginAnchors.length);
    await d.check(afterBack === 3, 'Backspace removes the last point', `${afterBack} points`);
    await d.hush();
    await d.say('Eight points are plenty for a prep like this one. Watch the path follow the edge as the cursor moves.', { wait: false });
    for (let i = 3; i < pts.length; i++) {
      await d.clickWorld(pts[i]);
      await d.pause(350);
    }
    await d.hush();
    await d.say('To close the loop, click the first point again, or press Enter.', { wait: false });
    await d.pause(900);
    await d.clickWorld(pts[0], { guard: false });
    await d.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.margin));
    const traced = await marginOf(d);
    const tracedDev = await deviation(d);
    await d.check(traced.anchors.length === 8 && traced.source === 'manual', 'Eight clicks give a closed margin', { anchors: traced.anchors.length, source: traced.source });
    await d.check(tracedDev.mean < 0.1 && tracedDev.max < 0.3, `The traced line is ${tracedDev.mean.toFixed(2)} mm from the true finish line on average`, tracedDev);
    await d.hush();

    // ---- Fix a part --------------------------------------------------------------------------------------------------
    d.chapter('Drag, add and delete points');
    const before = await marginOf(d);
    const seed = await d.synthetic('syntheticPrepSeed', { along: ALONG });
    const a = before.anchors[2].p;
    const from = await d.project(a);
    const to = await d.project([a[0] + (seed[0] - a[0]) * 0.15, a[1] + (seed[1] - a[1]) * 0.15, a[2]]);
    await d.say('Drag a point to move the line. Only the stretch between its two neighbours is traced again; the rest stays.', { wait: false });
    await d.drag(from, to, { ms: 1100 });
    await d.waitFor((x) => JSON.stringify(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).margin.anchors[2].p) !== x, JSON.stringify(a), 30000);
    await idle(d);
    await d.hush();
    const problems = page.locator('.margin-problems');
    await problems.waitFor({ timeout: 15000 }).catch(() => {});
    await d.check(await problems.isVisible(), 'Pulled off the edge, the line is flagged before it can fold the crown');
    await d.say('Pulled inward like this, off the finish line, the step warns that the crown would fold here.', { wait: false });
    await d.point(problems, 3400);
    await d.hush();
    await d.say('Undo puts it back exactly.', { wait: false });
    await d.press('Control+z', 'Undo');
    await d.pause(500);
    const undone = await marginOf(d);
    await d.check(JSON.stringify(undone) === JSON.stringify(before) && !(await problems.isVisible()), 'Undo restores the line exactly');
    await d.hush();

    // Insert a point on the line, halfway between two of its points, then delete it.
    const nearest = (p) => before.points.reduce((best, m, i) => (Math.hypot(...m.p.map((x, k) => x - p[k])) < Math.hypot(...before.points[best].p.map((x, k) => x - p[k])) ? i : best), 0);
    const i4 = nearest(before.anchors[4].p);
    const i5 = nearest(before.anchors[5].p);
    const mid = before.points[Math.round((i4 + (i5 < i4 ? i5 + before.points.length : i5)) / 2) % before.points.length].p;
    await d.say('Click on the line to add a point there. The line itself does not change, but you get a new handle to drag.', { wait: false });
    await d.clickWorld(mid);
    await d.waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).margin.anchors.length === 9, null, 15000).catch(() => {});
    const inserted = await marginOf(d);
    await d.check(inserted.anchors.length === 9 && JSON.stringify(inserted.points) === JSON.stringify(before.points), 'A click on the line adds a point and leaves the line as it was', { anchors: inserted.anchors.length });
    await d.hush();
    await d.say('To remove a point, rest the cursor on it, and press Delete.', { wait: false });
    const added = inserted.anchors.find((q) => !before.anchors.some((b) => JSON.stringify(b.p) === JSON.stringify(q.p)))?.p ?? mid;
    const hover = await d.project(added);
    await d.moveTo(hover.x + 14, hover.y + 10, { ms: 500 });
    await d.moveTo(hover.x, hover.y, { ms: 500 });
    await d.pause(500);
    await d.press('Delete', 'Remove the point under the cursor');
    await d.waitFor(() => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).margin.anchors.length === 8, null, 15000).catch(() => {});
    await idle(d);
    const deleted = await marginOf(d);
    await d.check(deleted.anchors.length === 8, 'Delete removes the point under the cursor', `${deleted.anchors.length} points`);
    await d.hush();

    // ---- The whole line, and how sure it is ------------------------------------------------------------------------
    d.chapter('Raise, lower and doubtful parts');
    const level = await marginOf(d);
    const up = (await d.tooth(36)).frame.occlusal;
    await d.say('Raise and Lower move the whole line a tenth of a millimetre up or down the tooth. The keys are the square brackets.', { wait: false });
    await d.point(page.getByRole('group', { name: 'Move the whole line' }), 2400);
    await d.pause(1800);
    await d.moveTo((await d.stage()).x + (await d.stage()).width - 120, (await d.stage()).y + 120, { ms: 700 });
    for (let k = 0; k < 3; k++) {
      await d.press(']', 'Raise 0.1 mm');
      await idle(d);
    }
    await d.hush();
    const raised = await marginOf(d);
    const lift = raised.points.reduce((s, m, i) => s + m.p.reduce((t, x, k) => t + (x - level.points[i].p[k]) * up[k], 0), 0) / raised.points.length;
    await d.check(lift > 0.1, `Three presses raise the line ${lift.toFixed(2)} mm up the tooth`, { liftMm: lift });
    const doubt1 = await doubtOf(d);
    await d.check(doubt1.parts > 0, `Lifted off the edge, the line shows ${doubt1.parts} doubtful part${doubt1.parts === 1 ? '' : 's'}`, doubt1);
    await d.say('Lifted off the edge, the line is no longer on the finish line in places, and the panel counts the doubtful parts.', { wait: false });
    await d.point(page.locator('.margin-confidence'), 3600);
    await d.hush();
    // N steps through the parts in order; stop on the most buccal or lingual one, which no neighbour hides.
    const frame = (await d.tooth(36)).frame;
    const parts = await d.state(() => window.__dcad.tools.getState().marginDoubt.parts.map((q) => q.at));
    const side = (q) => {
      const r = q.map((x, k) => x - frame.origin[k]);
      const dot = (v) => r.reduce((t, x, k) => t + x * v[k], 0);
      return Math.abs(dot(frame.buccal)) - Math.abs(dot(frame.mesial));
    };
    const target = parts.reduce((best, q, i) => (side(q) > side(parts[best]) ? i : best), 0);
    const camera0 = await d.state(() => window.__dcad.viewer.controls.camera.position.toArray());
    await d.say('Press N to fly to each doubtful part in turn, and Shift N to go back. The status line says where the stronger edge is.', { wait: false });
    await d.pause(1200);
    for (let k = 0; k <= target; k++) {
      await d.press('n', 'Next doubtful part');
      await d.pause(900);
    }
    await d.settle();
    const flown = await d.state(() => ({ current: window.__dcad.tools.getState().marginDoubt.current, camera: window.__dcad.viewer.controls.camera.position.toArray() }));
    const moved = Math.hypot(...flown.camera.map((x, k) => x - camera0[k]));
    await d.check(flown.current === target && moved > 1, `N steps through the doubtful parts and flies the view to each`, { current: flown.current, target, cameraMovedMm: moved });
    await d.point(page.locator('.status-message'), 2600);
    await d.hush();
    await d.say('Undo three times, and the line is back on the edge.', { wait: false });
    await d.pause(900);
    for (let k = 0; k < 3; k++) await d.press('Control+z', 'Undo');
    await d.pause(600);
    const back = await marginOf(d);
    const doubt2 = await doubtOf(d);
    await d.check(JSON.stringify(back) === JSON.stringify(level) && doubt2.parts === 0, 'Undo puts the line back, with no doubtful parts');
    await d.hush();

    // ---- On to the next step ---------------------------------------------------------------------------------------
    d.chapter('Next step');
    await d.say('When the line looks right, press Enter to go on to the insertion axis.', { wait: false });
    await d.blur();
    await d.pause(2000);
    await d.press('Enter', 'Next step');
    await d.waitFor(() => window.__dcad.design.getState().activeStep === 'axis', null, 15000).catch(() => {});
    await d.check((await d.state(() => window.__dcad.design.getState().activeStep)) === 'axis', 'Enter on a closed margin opens the Insertion axis step');
    await d.settle();
    await d.hush();
  },
};
