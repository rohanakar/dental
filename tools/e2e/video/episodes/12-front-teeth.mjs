// Episode 12: crowns on the upper front teeth 11 and 21 of an arch whose front teeth lean 25° labially, then Export
// all as one zip (as anterior-export.mjs; its bridge part is left to the bridge episodes).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { strFromU8, unzipSync } from '../../../../apps/web/node_modules/fflate/esm/index.mjs';
import { ALONG, stlSolid } from '../lib.mjs';

/** The upper front teeth lean this far labially (syntheticArch's anteriorLeanDeg), as real upper incisors do. */
const LEAN_DEG = 25;
const angleDeg = (a, b) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;

/** The analytic margin of a front tooth, leaning like the generated scan. */
const marginRing = (d, fdi, samples) =>
  d.state(
    async ([f, n, along, deg]) => {
      const out = (await import('/src/geometry/synthetic.ts')).syntheticPrepMargin({ fdi: f, along, samples: n, anteriorLeanDeg: deg });
      const pts = [];
      for (let i = 0; i < out.length; i += 3) pts.push([out[i], out[i + 1], out[i + 2]]);
      return pts;
    },
    [fdi, samples, ALONG, LEAN_DEG],
  );
/** Margin points a click reaches from the current view: the pick lands within 0.3 mm of the point. */
const reachable = (d, pts) =>
  d.state(
    (ps) =>
      ps.filter((q) => {
        const s = window.__dcad.viewer.project(q);
        const hit = s && window.__dcad.viewer.raycast(s.x, s.y, { objectIds: ['upper'] });
        return hit && Math.hypot(hit.point.x - q[0], hit.point.y - q[1], hit.point.z - q[2]) < 0.3;
      }).length,
    pts,
  );
const idle = (d) => d.waitFor(() => !window.__dcad.tools.getState().busy && !window.__dcad.tools.getState().crown?.computing, null, 120000);

export default {
  id: '12-front-teeth',
  title: 'Front teeth and Export all',
  summary: 'Two separate crowns on the upper central incisors, on an arch whose front teeth lean forward as real ones do, then every restoration of the case exported in one zip.',
  learn: ['Set up two crowns side by side', 'Frames and margins that follow a leaning tooth', 'Propose a crown on each tooth', 'Export all: one zip for the whole case'],
  start: 'app/',
  intro: 'Front teeth lean forward, so they need their own view of the margin. In this episode you crown 11 and 21, then export the whole case at once.',
  outro: 'Both front crowns are designed and exported together.',
  async setup(d) {
    await d.page.waitForFunction(() => Boolean(window.__dcad?.tools));
  },
  async run(d) {
    const { page } = d;
    const panel = page.locator('aside.panel');

    d.chapter('Case setup');
    await d.say('Start a case. Here we work offline, so nothing leaves this computer.', { wait: false });
    await d.click(page.getByRole('button', { name: /continue offline/i }));
    await d.waitFor(() => window.__dcad.design.getState().activeStep === 'setup');
    await d.hush();
    await d.say('The chart is the dentist’s view of the mouth. Click 11 and 21, then click 36 to take it off the case.', { wait: false });
    for (const fdi of [11, 21, 36]) await d.click(page.getByRole('button', { name: `Tooth ${fdi}`, exact: true }));
    const setup = await d.state(() => ({ teeth: window.__dcad.design.getState().doc.setup.teeth.map((t) => `${t.fdi} ${t.restoration}`), bridges: window.__dcad.design.getState().doc.bridges.length }));
    await d.check(setup.teeth.join() === '11 anatomic-crown,21 anatomic-crown' && setup.bridges === 0, 'The case has two single crowns, 11 and 21', setup);
    await d.hush();
    const note = page.locator('p[role="note"]');
    await d.say('Neighbouring teeth stay separate crowns unless you switch on the dot between them, which would make a bridge.', { wait: false });
    await d.point(note, 3500);
    await d.check(/11 and 21 stay separate crowns/.test(await note.innerText()), 'The chart says 11 and 21 stay separate');
    await d.hush();

    d.chapter('Scans');
    await d.step('Scans');
    await d.say('The upper jaw’s front teeth lean forward 25 degrees, like real incisors. The lower jaw is the opposing arch.', { wait: false });
    const dropzone = page.locator('.dropzone').first();
    await d.point(dropzone, 2000);
    // The leaning upper arch is generated in the page with the app's own generator and dropped on the file input.
    await d.state(
      async ([along, deg]) => {
        const { syntheticArch } = await import('/src/geometry/synthetic.ts');
        const { writeBinaryStl } = await import('/src/geometry/stl.ts');
        const mesh = syntheticArch({ jaw: 'upper', along, across: along / 2, preps: [11, 21], anteriorLeanDeg: deg });
        const input = document.querySelector('input[type=file][accept=".stl,.ply"]');
        const files = new DataTransfer();
        files.items.add(new File([writeBinaryStl(mesh)], 'upper-proclined.stl'));
        input.files = files.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      [ALONG, LEAN_DEG],
    );
    await d.loadScans(['lower.stl'], { count: 2 });
    const roles = await d.state(() => window.__dcad.design.getState().doc.scans.map((s) => s.role).sort().join());
    await d.check(roles === 'lower,upper', 'Both jaws are in, sorted by their file names', roles);
    await d.hush();

    d.chapter('Tooth frames');
    await d.step('Tooth frame');
    await d.waitFor(() => window.__dcad.design.getState().doc.teeth.every((t) => t.frame), null, 60000);
    await d.settle();
    const frames = await d.state(() => window.__dcad.design.getState().doc.teeth.map((t) => ({ fdi: t.fdi, occlusal: t.frame.occlusal })));
    const leans = frames.map((f) => angleDeg(f.occlusal, [0, 0, -1]));
    await d.say('Both teeth are framed from their preps as soon as the scan is in. Nothing to click.', { wait: false });
    const status = page.locator('.status-message');
    if (await status.count()) await d.point(status.first(), 2500);
    await d.hush();
    await d.say('Look from the side: each tooth’s blue arrow follows its own lean, not the flat of the jaw.', { wait: false });
    await d.click(page.getByRole('button', { name: 'Mesial', exact: true }));
    await d.settle();
    await d.check(leans.every((a) => a > 15 && a < 30), `The frames lean with the teeth (${leans.map((a) => `${a.toFixed(0)}°`).join(', ')})`, frames);
    await d.hush();
    await d.pause(800);

    d.chapter('Margins');
    await d.say('On the Margin step, the margins of 11 and 21 are found for you. Check them, and drag a point if one is off.', { wait: false });
    await d.step('Margin');
    await d.waitFor(() => window.__dcad.design.getState().doc.teeth.every((t) => t.margin) && window.__dcad.tools.getState().surface === 'ready', null, 120000);
    await d.hush();
    await d.selectTooth(11);
    await d.waitFor(() => window.__dcad.design.getState().activeFdi === 11);
    await d.settle();
    const reach = await reachable(d, await marginRing(d, 11, 64));
    await d.say('The view looks down the tooth’s own axis, so every point of the margin, front and back, can be seen and clicked.', { wait: false });
    await d.check(reach === 64, `Every margin point of 11 can be clicked from this view (${reach} of 64)`);
    await d.orbit(70, 0);
    await d.orbit(-70, 0);
    await d.hush();

    d.chapter('Two crowns');
    const crownOn = async (fdi, first) => {
      if (first) await d.say('With 11 active, open Insertion axis: the axis is proposed from the margin you just checked.', { wait: false });
      else await d.say('Now 21: pick it in the Tooth list, and do the same, axis then crown.', { wait: false });
      if ((await d.state(() => window.__dcad.design.getState().activeFdi)) !== fdi) await d.selectTooth(fdi);
      await d.step('Insertion axis');
      await d.waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.axis) && !window.__dcad.tools.getState().busy, fdi, 60000);
      await d.settle();
      await d.hush();
      await d.step('Crown proposal');
      if (first) await d.say('On Crown proposal, press Propose crown. A library incisor is sized to the gap and seated on the margin.', { wait: false });
      await d.click(page.getByRole('button', { name: 'Propose crown', exact: true }));
      await d.waitFor((f) => Boolean(window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f)?.crown), fdi, 120000);
      await idle(d);
      const v = await d.state(() => window.__dcad.tools.getState().crown.validation);
      await d.check(v.ok && v.closed && v.printable, `${fdi}: the crown is a closed, printable solid`, v);
      await d.settle();
      await d.hush();
      if (first) {
        await d.say('Turn the view to check it from the side, against the lean of the tooth.', { wait: false });
        await d.orbit(90, 0);
        await d.orbit(-90, 0);
        await d.hush();
      }
    };
    await crownOn(11, true);
    await crownOn(21, false);
    const crowns = await d.state(() => window.__dcad.design.getState().doc.teeth.filter((t) => t.crown).map((t) => t.fdi).join());
    await d.check(crowns === '11,21', 'Both front teeth have their crowns', crowns);
    await d.say('The two crowns sit side by side, each on its own margin. The active one is blue; the other is drawn like a tooth.', { wait: false });
    await d.orbit(-90, 0);
    await d.orbit(90, 0);
    await d.hush();

    d.chapter('Export all');
    await d.step('Finalize');
    await idle(d);
    const exportAll = page.getByRole('button', { name: 'Export all (zip)' });
    await exportAll.scrollIntoViewIfNeeded();
    await d.say('Export all writes every restoration of the case into one zip, with a manifest of what is in it.', { wait: false });
    let confirmed = false;
    const zipPath = await d.download(async () => {
      await d.click(exportAll);
      const anyway = page.getByRole('button', { name: 'Export all anyway' });
      if (await anyway.waitFor({ timeout: 4000 }).then(() => true, () => false)) {
        confirmed = true;
        await d.hush();
        await page.locator('.confirm-box').scrollIntoViewIfNeeded();
        await d.say('These crowns were not adapted to the bite, so Finalize asks once more and lists what is still open. Export all anyway goes ahead.', { wait: false });
        await d.point(page.locator('.confirm-box'), 5000);
        await d.click(anyway);
      }
    });
    const files = unzipSync(new Uint8Array(readFileSync(zipPath)));
    const names = Object.keys(files).sort();
    const expected = ['README.txt', 'case-11.construction.json', 'case-11.stl', 'case-21.construction.json', 'case-21.stl', 'manifest.json'];
    await d.check(JSON.stringify(names) === JSON.stringify(expected), 'The zip has both crowns, their construction info, a manifest and a README', names);
    const dir = `${d.files}unzipped/`;
    mkdirSync(dir, { recursive: true });
    const solids = [];
    for (const name of names.filter((n) => n.endsWith('.stl'))) {
      writeFileSync(dir + name, files[name]);
      solids.push({ name, ...(await stlSolid(dir + name)) });
    }
    await d.check(solids.length === 2 && solids.every((s) => s.ok && s.closed && s.components === 1 && s.genus === 0), 'Each crown in the zip is one closed solid', solids);
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    const listed = manifest.restorations?.map((r) => ({ teeth: r.teeth, ready: r.ready, open: r.openChecks.length }));
    await d.check(
      manifest.restorations?.length === 2 && manifest.restorations.every((r) => r.files.length === 2 && (r.ready || r.openChecks.length > 0)) && (!confirmed || manifest.restorations.some((r) => r.openChecks.length > 0)),
      'The manifest lists both crowns, their files and their open checks',
      listed,
    );
    await d.hush();
    await page.locator('.export-done').last().scrollIntoViewIfNeeded().catch(() => {});
    await d.say('Send the zip to the mill as it is: each crown is its own file, and the manifest says what is in it.', { wait: false });
    if (await page.locator('.export-done').count()) await d.point(page.locator('.export-done').last(), 3000);
    await d.hush();
  },
};
