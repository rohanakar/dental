// Episode 02: the editor around the design: the step rail, the scans' visibility and opacity, the standard views and
// their keys, turning / panning / zooming, Fit and the orthographic camera, undo and redo, the screenshot, the help
// sheet and the dark theme. On the demo case (as first-run.mjs).
import { readFileSync } from 'node:fs';
import { ALONG } from '../lib.mjs';

/** The camera as numbers: where it looks along, its target and its distance to the target. */
const camera = (d) =>
  d.state(() => {
    const v = window.__dcad.viewer;
    const target = v.controls.getTarget(v.controls.camera.position.clone());
    const position = v.controls.getPosition(v.controls.camera.position.clone());
    return { dir: v.viewDirection().toArray(), quaternion: v.controls.camera.quaternion.toArray(), target: target.toArray(), distance: position.distanceTo(target), projection: v.getProjection() };
  });
const angle = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
/** How far the camera turned between two orientations, in degrees. */
const turned = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI;

export default {
  id: '02-workspace',
  title: 'The workspace: views, navigation and help',
  summary: 'Find your way around the editor: the step rail, the scans, the standard views, turning and zooming, undo and redo, help and the dark theme.',
  learn: ['Move between steps on the rail', 'Show, hide and fade the scans', 'Standard views, turning, panning and zooming', 'Undo, redo, help and the dark theme'],
  start: 'app/?demo',
  async setup(d) {
    await d.waitFor(() => window.__dcad?.design.getState().activeStep === 'frame' && Boolean(window.__dcad.viewer) && Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame));
    await d.settle();
  },
  intro: 'This episode is a tour of the editor: how to move between steps, look at the scans from any side, and find help when you need it.',
  outro: 'You now know your way around the editor.',
  async run(d) {
    const { page } = d;
    const rail = page.getByRole('navigation', { name: 'Design steps' });

    d.chapter('The step rail');
    await d.say('The rail on the left is your path through a design, from case setup to finalize.', { wait: false });
    await d.point(rail, 3500);
    await d.hush();
    const states = await rail.locator('button.step').evaluateAll((els) => els.map((e) => [...e.classList].find((c) => ['done', 'pending', 'stale', 'draft'].includes(c))));
    await d.check(states.slice(0, 3).every((s) => s === 'done') && states.slice(3).every((s) => s === 'pending'), 'The rail shows three steps done and six to do', states);
    await d.say('A green dot is a step that is done. A hollow ring is still to do. A step auto-design proposed carries a draft tag until you accept it.', { wait: false });
    await d.point(rail.locator('button.step').nth(2), 2600);
    await d.point(rail.locator('button.step').nth(3), 2600);
    await d.hush();
    await d.say('Click any step to go there. Back and Next, at the bottom of the panel, walk through them in order.', { wait: false });
    await d.step('Scans');
    await d.point(page.locator('.panel').getByRole('button', { name: /^Next/ }), 2200);
    await d.hush();
    await d.check((await d.state(() => window.__dcad.design.getState().activeStep)) === 'scans', 'A click on the rail opens the Scans step');

    d.chapter('Show, hide and fade the scans');
    await d.say('The Scans step lists every scan in the case. Untick a scan to hide it.', { wait: false });
    await d.panelTo('.objects');
    await d.point(page.locator('.objects'), 2400);
    await d.click(page.getByLabel('Show demo-upper.ply'));
    await d.hush();
    const hidden = await d.state(() => ({ store: window.__dcad.scene.getState().objects.find((o) => o.id === 'upper').visible, mesh: window.__dcad.viewer.objects.get('upper').mesh.visible }));
    await d.check(!hidden.store && !hidden.mesh, 'Unticking the upper jaw hides it', hidden);
    await d.say('With the upper jaw hidden, you look straight onto the lower teeth. Tick it again to bring it back.', { wait: false });
    await d.pause(1800);
    await d.click(page.getByLabel('Show demo-upper.ply'));
    await d.hush();
    await d.say('The opacity slider fades a scan, so you can see what is behind it.', { wait: false });
    const slider = page.getByLabel('Opacity of demo-upper.ply');
    await slider.scrollIntoViewIfNeeded();
    const track = await slider.boundingBox();
    await d.drag({ x: track.x + track.width - 6, y: track.y + track.height / 2 }, { x: track.x + track.width * 0.35, y: track.y + track.height / 2 }, { ms: 1100 });
    await d.hush();
    const faded = await d.state(() => window.__dcad.scene.getState().objects.find((o) => o.id === 'upper').opacity);
    await d.check(faded < 0.6, `The upper jaw fades to ${Math.round(faded * 100)}% opacity`, String(faded));
    await d.pause(800);
    await d.say('Drag it back to full. Then hide the upper jaw once more, so the views that follow show the lower teeth on their own.', { wait: false });
    await d.drag({ x: track.x + track.width * 0.35, y: track.y + track.height / 2 }, { x: track.x + track.width + 4, y: track.y + track.height / 2 }, { ms: 800 });
    await d.click(page.getByLabel('Show demo-upper.ply'));
    await d.hush();

    d.chapter('Standard views');
    const views = ['Occlusal', 'Buccal', 'Lingual', 'Mesial', 'Distal'];
    await d.say('The toolbar has the five standard views. Occlusal looks down onto the biting surfaces.', { wait: false });
    await d.point(page.getByRole('group', { name: 'Standard views' }), 2400);
    const dirs = {};
    for (const view of views) {
      await d.click(page.getByRole('group', { name: 'Standard views' }).getByRole('button', { name: view, exact: true }), { settleMs: 100 });
      await d.settle();
      dirs[view] = (await camera(d)).dir;
      if (view === 'Occlusal') {
        await d.hush();
        await d.say('Buccal looks from the cheek side, lingual from the tongue side, mesial and distal from either end of the tooth row.', { wait: false });
      } else await d.pause(500);
    }
    await d.hush();
    const up = await d.state(() => window.__dcad.viewer.getViewFrame().up);
    let closest = 180;
    for (let i = 0; i < views.length; i++) for (let j = i + 1; j < views.length; j++) closest = Math.min(closest, angle(dirs[views[i]], dirs[views[j]]));
    await d.check(angle(dirs.Occlusal, up.map((x) => -x)) < 10 && closest > 60, 'Each view button turns the camera to its own side', { occlusalFromDown: angle(dirs.Occlusal, up.map((x) => -x)).toFixed(1), closestPair: closest.toFixed(1) });
    await d.say('The number keys do the same: 1 for occlusal, 2 for buccal, and so on up to 5.', { wait: false });
    await d.blur();
    await d.press('1', 'Occlusal view');
    await d.settle();
    await d.press('2', 'Buccal view');
    await d.settle();
    await d.hush();
    const byKey = (await camera(d)).dir;
    await d.check(angle(byKey, dirs.Buccal) < 3, 'Key 2 gives the same view as the Buccal button', angle(byKey, dirs.Buccal).toFixed(2));

    d.chapter('Turn, pan and zoom');
    await d.press('1', 'Occlusal view');
    await d.settle();
    let before = await camera(d);
    await d.say('To turn the view, drag with the left mouse button anywhere in the 3D view.', { wait: false });
    await d.orbit(-40, -90);
    await d.orbit(120, 0);
    await d.settle();
    let after = await camera(d);
    await d.check(turned(before.quaternion, after.quaternion) > 15, `Dragging turns the view (${Math.round(turned(before.quaternion, after.quaternion))}°)`);
    await d.hush();
    before = after;
    await d.say('To slide the view sideways, drag with the right mouse button.', { wait: false });
    await d.pan(-160, 40);
    await d.settle();
    after = await camera(d);
    const slid = Math.hypot(...after.target.map((t, k) => t - before.target[k]));
    await d.check(slid > 2, `Right-dragging pans the view (${slid.toFixed(1)} mm)`);
    await d.hush();
    before = after;
    await d.say('Scroll to zoom. The view zooms toward the pointer, so point at what you want to see closer.', { wait: false });
    const prep = await d.project(await d.synthetic('syntheticPrepSeed', { along: ALONG }));
    await d.zoom(-4, { at: prep });
    await d.settle();
    after = await camera(d);
    await d.check(after.distance < before.distance * 0.9, 'Scrolling zooms in', { from: before.distance.toFixed(1), to: after.distance.toFixed(1) });
    await d.hush();
    await d.say('When you are lost, press F, or Fit in the toolbar. It brings the whole case back into view.', { wait: false });
    await d.pause(600);
    await d.blur();
    await d.press('f', 'Fit');
    await d.settle();
    await d.hush();
    const stage = await d.stage();
    const back = await d.project(await d.synthetic('syntheticPrepSeed', { along: ALONG }));
    await d.check(back && back.x > stage.x && back.x < stage.x + stage.width && back.y > stage.y && back.y < stage.y + stage.height, 'Fit brings the prep back into view');
    await d.say('Orthographic switches the camera so distances read true, with no perspective. Click it again to go back.', { wait: false });
    const ortho = page.getByRole('button', { name: 'Orthographic', exact: true });
    await d.click(ortho);
    await d.settle();
    const orthographic = (await camera(d)).projection;
    await d.pause(900);
    await d.click(ortho);
    await d.settle();
    await d.check(orthographic === 'orthographic' && (await camera(d)).projection === 'perspective', 'Orthographic switches the camera, and back');
    await d.hush();
    await d.say('And a view key always starts you again from a standard view.', { wait: false });
    await d.blur();
    await d.press('1', 'Occlusal view');
    await d.settle();
    await d.hush();

    d.chapter('Undo and redo');
    await d.step('Tooth frame');
    await d.settle();
    const mesial0 = (await d.tooth(36)).frame.mesial;
    await d.say('Every change to the design can be undone. Say you swap mesial and distal on the tooth frame by mistake.', { wait: false });
    await d.click('Swap mesial and distal');
    await d.waitFor((m) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).frame.mesial[0] !== m[0], mesial0);
    await d.hush();
    const swapped = (await d.tooth(36)).frame.mesial;
    await d.say('Press Control Z, or the undo arrow at the top left, and the arrows go back.', { wait: false });
    await d.blur();
    await d.press('Control+z', 'Undo');
    await d.pause(600);
    const undone = (await d.tooth(36)).frame.mesial;
    await d.check(angle(swapped, mesial0) > 170 && angle(undone, mesial0) < 0.01, 'Undo puts the swapped frame back', { swapped: angle(swapped, mesial0).toFixed(1), undone: angle(undone, mesial0).toFixed(3) });
    await d.point(page.getByRole('button', { name: 'Undo', exact: true }), 1800);
    await d.hush();
    await d.say('Control Shift Z, or the redo arrow, does it again. Undo once more to keep the original frame.', { wait: false });
    await d.press('Control+Shift+z', 'Redo');
    await d.pause(500);
    const redone = (await d.tooth(36)).frame.mesial;
    await d.click(page.getByRole('button', { name: 'Undo', exact: true }));
    await d.hush();
    const final = (await d.tooth(36)).frame.mesial;
    await d.check(angle(redone, swapped) < 0.01 && angle(final, mesial0) < 0.01, 'Redo swaps again, and undo restores it');

    d.chapter('Help, theme and screenshots');
    await d.say('Press the question mark key for help: every shortcut, and a short glossary of the terms the editor uses.', { wait: false });
    await d.blur();
    await d.press('?', 'Help');
    const help = page.getByRole('dialog', { name: 'Help' });
    await help.waitFor();
    await d.check(await help.isVisible(), 'The question mark key opens the help sheet');
    await d.point(help.locator('dl').first(), 4200);
    await d.hush();
    await d.say('Help stays open while you work. Escape closes it.', { wait: false });
    await d.pause(900);
    await help.focus().catch(() => {});
    await d.press('Escape', 'Close help');
    await d.check(!(await help.isVisible().catch(() => false)), 'Escape closes the help sheet');
    await d.hush();
    await d.say('The moon button switches the editor to a dark theme, which some find easier on the eyes. The choice is remembered.', { wait: false });
    const toggle = page.getByRole('button', { name: 'Dark theme' });
    await d.click(toggle);
    await d.pause(1500);
    const dark = await d.state(() => ({ theme: document.documentElement.dataset.theme ?? null, bg: window.__dcad.viewer.scene.background.getHexString() }));
    await d.hush();
    await d.say('Click it again for the light theme.', { wait: false });
    await d.click(toggle);
    await d.pause(600);
    const light = await d.state(() => ({ theme: document.documentElement.dataset.theme ?? null, bg: window.__dcad.viewer.scene.background.getHexString() }));
    await d.check(dark.theme === 'dark' && dark.bg !== light.bg && light.theme === null, 'The theme switches to dark and back to light', { dark, light });
    await d.hush();
    await d.say('The camera button saves a picture of the 3D view as a PNG file.', { wait: false });
    const png = await d.download(() => d.click(page.getByRole('button', { name: 'Screenshot', exact: true })));
    const buf = readFileSync(png);
    const width = buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 ? buf.readUInt32BE(16) : 0;
    await d.check(width >= 800, `The screenshot is a PNG of the view (${width} px wide)`);
    await d.hush();
  },
};
