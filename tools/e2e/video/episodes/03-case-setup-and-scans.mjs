// Episode 03: a case of your own, offline: the dentist's-view tooth chart, the restoration and its material, the case
// reference, importing the two jaw scans, and the tooth frame from one click on the prep (as offline-design.mjs, with
// the frames left to the click).
import { ALONG } from '../lib.mjs';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export default {
  id: '03-case-setup-and-scans',
  title: 'Case setup, scans and the tooth frame',
  summary: 'Start a case of your own: pick the tooth and its material on the chart, import the two jaw scans, and set the tooth frame with one click on the prep.',
  learn: ['Read the dentist’s-view tooth chart', 'Choose the restoration and its material', 'Import the lower and upper scans', 'Set the tooth frame with one click'],
  start: 'app/',
  async setup(d) {
    // The frame is the point of this episode: leave it to the click instead of finding it from the prep.
    await d.page.waitForFunction(() => Boolean(window.__dcad?.tools));
    await d.state(() => window.__dcad.tools.getState().set({ autoFrames: false }));
  },
  intro: 'In this episode you start a case of your own: you tell the software which tooth to restore, load the scans, and set the tooth frame.',
  outro: 'The case is set up and the tooth is framed, ready for its margin.',
  async run(d) {
    const { page } = d;

    d.chapter('Start a case');
    const offline = page.getByRole('button', { name: 'Continue offline' });
    await d.say('Continue offline opens an empty case in your browser. Nothing is saved to a server, so it is a safe place to try things out.', { wait: false });
    await d.point(offline, 2600);
    await d.hush();
    await d.click(offline);
    await d.waitFor(() => window.__dcad.design.getState().activeStep === 'setup' && window.__dcad.scene.getState().objects.length === 0);
    await d.check(true, 'Continue offline opens Case setup on an empty case');

    d.chapter('The tooth chart');
    const chart = page.locator('.fdi-chart');
    await d.say('The chart is the dentist’s view: the patient’s right is on your left. Upper teeth on top, lower teeth below, numbered the FDI way.', { wait: false });
    await d.point(chart, 5000);
    await d.hush();
    const at = async (fdi) => page.getByRole('button', { name: `Tooth ${fdi}`, exact: true }).boundingBox();
    const [t18, t11, t21, t48] = await Promise.all([18, 11, 21, 48].map(at));
    await d.check(t18.x < t11.x && t11.x < t21.x && t48.y > t18.y, 'The chart reads 18 to 11, then 21 to 28, with the lower jaw below');
    await d.say('A new case starts with a crown on 36, the lower left first molar. Click a tooth to add it to the case.', { wait: false });
    await d.point(page.getByRole('button', { name: 'Tooth 36', exact: true }), 2200);
    await d.click(page.getByRole('button', { name: 'Tooth 37', exact: true }));
    await d.hush();
    const added = await d.state(() => window.__dcad.design.getState().doc.setup.teeth.map((t) => t.fdi));
    await d.check(added.includes(36) && added.includes(37), 'A click on 37 adds it to the case', added);
    await d.say('Click it again to take it out. This case is a single crown on 36.', { wait: false });
    await d.click(page.getByRole('button', { name: 'Tooth 37', exact: true }));
    await d.hush();
    const removed = await d.state(() => window.__dcad.design.getState().doc.setup.teeth.map((t) => t.fdi));
    await d.check(removed.length === 1 && removed[0] === 36, 'A second click takes 37 out again', removed);

    d.chapter('Restoration and material');
    await d.panelTo('.units');
    await d.say('Under Restorations, each tooth is a crown or a pontic. A pontic is the missing tooth of a bridge.', { wait: false });
    await d.point(page.getByRole('group', { name: 'Restoration for 36' }).locator('.seg').first(), 3000);
    await d.hush();
    await d.say('More types holds the rest: inlays and onlays, a Maryland wing, an implant crown, and reduced crowns for veneering.', { wait: false });
    await d.click(page.getByRole('button', { name: 'More types for 36' }));
    await d.point(page.getByRole('group', { name: 'Restoration for 36' }).locator('.unit-more'), 3600);
    await d.hush();
    await d.click(page.getByRole('button', { name: 'More types for 36' }));
    await d.say('Pick the material here. It sets the minimum thickness and the cement gap the checks use. Let us make this one lithium disilicate.', { wait: false });
    await d.select(page.getByLabel('Material for 36'), 'lithium-disilicate');
    await d.hush();
    await d.say('Give the case a reference, never a patient name. Press Enter to keep it.', { wait: false });
    await d.type(page.locator('#patient-ref'), 'LAB-2026-0142');
    await d.press('Enter', 'Keep the reference');
    await d.hush();
    const order = await d.state(() => window.__dcad.design.getState().doc.setup);
    await d.check(
      order.teeth.length === 1 && order.teeth[0].fdi === 36 && order.teeth[0].restoration === 'anatomic-crown' && order.teeth[0].material === 'lithium-disilicate' && order.patientRef === 'LAB-2026-0142',
      'The case is a lithium disilicate crown on 36, with its reference',
      order,
    );

    d.chapter('Import the scans');
    await d.step('Scans');
    await d.say('The Scans step lists what this case needs: the lower jaw, with the prep, and the upper jaw, for the bite.', { wait: false });
    await d.point(page.locator('.scan-checklist'), 3200);
    await d.hush();
    await d.say('Drop your STL or PLY files on the box, or click it to browse. Files named upper or lower are sorted for you; otherwise, pick the jaw in Import as.', { wait: false });
    await d.point(page.locator('#role'), 2200);
    await d.loadScans(['lower.stl', 'upper.stl']);
    await d.hush();
    const scans = await d.state(() => window.__dcad.design.getState().doc.scans.map((s) => s.role).sort());
    await d.check(scans.join() === 'lower,upper', 'Both scans are in, each on its own jaw', scans);
    const ticked = await page.locator('.scan-checklist li.done').count();
    await d.check(ticked === 2, 'The checklist ticks both jaws');
    await d.say('Each scan gets a row under Objects, with its size and triangle count. Both boxes in the checklist are ticked.', { wait: false });
    await d.panelTo('.objects');
    await d.point(page.locator('.objects'), 3000);
    await d.hush();

    d.chapter('The tooth frame');
    await d.step('Tooth frame');
    const armed = page.getByRole('checkbox', { name: /One-click crown/ });
    if (await armed.isChecked().catch(() => false)) await armed.uncheck();
    await d.say('The tooth frame tells the software which way is up, toward the midline, and toward the cheek, for this tooth. Start from the occlusal view: press 1.', { wait: false });
    await d.blur();
    await d.press('1', 'Occlusal view');
    await d.settle();
    await d.hush();
    const seed = await d.synthetic('syntheticPrepSeed', { along: ALONG });
    await d.say('Now click once on the top of the prepared tooth.', { wait: false });
    await d.clickWorld(seed, { objectIds: ['lower'] });
    await d.waitFor(() => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36)?.frame), null, 60000);
    await d.hush();
    const frame = (await d.tooth(36)).frame;
    const off = Math.hypot(...frame.origin.map((o, k) => o - seed[k]));
    await d.check(off < 1, `The frame sits on the prep (${off.toFixed(2)} mm from the click)`);
    const toUpper = await d.state((origin) => {
      const box = window.__dcad.viewer.objects.get('upper').mesh.geometry;
      box.computeBoundingBox();
      const c = box.boundingBox.getCenter(window.__dcad.viewer.controls.camera.position.clone());
      return [c.x - origin[0], c.y - origin[1], c.z - origin[2]];
    }, frame.origin);
    await d.check(dot(frame.occlusal, toUpper) > 0, 'Its occlusal arrow points up, toward the opposing jaw');
    await d.say('Three arrows appear on the tooth. Blue points occlusal, out of the tooth. Green points mesial, toward the midline. Orange points buccal, toward the cheek.', { wait: false });
    await d.point(page.locator('.axis-legend'), 3000);
    await d.orbit(0, -90);
    await d.hush();
    await d.say('If mesial and distal come out the wrong way round, Swap mesial and distal turns them over.', { wait: false });
    const mesial = frame.mesial;
    await d.click('Swap mesial and distal');
    await d.waitFor((m) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).frame.mesial[0] !== m[0], mesial);
    const flipped = (await d.tooth(36)).frame.mesial;
    await d.pause(1200);
    await d.click('Swap mesial and distal');
    await d.waitFor((m) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === 36).frame.mesial[0] === m[0], mesial);
    await d.hush();
    await d.check(dot(flipped, mesial) < -0.99, 'Swap mesial and distal flips the frame, and a second click flips it back');
    await d.say('The frame also finds where the neighbours will touch the crown. Pick lets you set a contact by hand; the cross removes one when there is no neighbour.', { wait: false });
    await d.point(page.locator('.contact-row').first(), 2400);
    await d.point(page.locator('.contact-row').nth(1), 2400);
    await d.hush();
    const contacts = (await d.tooth(36)).frame;
    await d.check(Boolean(contacts.mesialContact && contacts.distalContact), 'Both neighbour contacts are found');
    await d.say('When the frame looks right, Next takes you to the margin.', { wait: false });
    await d.point(page.locator('.panel').getByRole('button', { name: /^Next/ }), 2200);
    await d.hush();
  },
};
