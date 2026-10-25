// Day 6 AI flows in the real app (headless Chrome, software WebGL).
// 1. Online (API on :3000, mock LLM): sign up → new case → Rx intake (classical/LLM) → apply.
// 2. One-click crown: arm, click the prep → frame, margin, axis, crown, adapt proposed with QA → Accept (one undo entry).
// 3. Assistant: `/tool move_crown …` via the mock provider → live change → Accept.
// 4. Save → proposal events stored (checked through the API database by the caller).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../../out/e2e/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
const log = (...a) => console.log('[ai]', ...a);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (name) => page.screenshot({ path: `${OUT}${name}.png` });
const state = (fn, arg) => page.evaluate(fn, arg);
const waitFor = (fn, arg, timeout = 180000) => page.waitForFunction(fn, arg, { timeout, polling: 250 });
const step = (label) => page.getByRole('button', { name: label }).first().click();
const settle = async () => {
  let last = '';
  for (let i = 0; i < 200; i++) {
    const now = await page.evaluate(() => window.__dcad.viewer.controls.camera.position.toArray().map((x) => x.toFixed(3)).join());
    if (now === last) return;
    last = now;
    await page.waitForTimeout(250);
  }
};

await page.goto(APP_URL);
await page.getByRole('button', { name: 'Create an account' }).click();
await page.getByLabel('Name').fill('AI Tech');
await page.getByLabel('Email').fill(`ai-${Date.now()}@example.com`);
await page.getByLabel('Password').fill('correct-horse-battery');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByText("Your lab's cases").waitFor();
await page.getByLabel(/Case reference/).fill('AI-0001');
await page.getByRole('button', { name: 'New case' }).click();
await page.getByRole('button', { name: 'Save' }).waitFor();
const caseId = await state(() => window.__dcad.design.getState().doc.caseId);
log('case', caseId);

// Rx intake (mock LLM → classical parser).
await step('Case setup');
await page.getByText('Read a prescription').click();
await page.getByLabel('Paste a prescription').fill('Ref: AI-0001\nPlease make a monolithic zirconia crown on #36, shade A3.5. Light occlusal contact.');
await page.getByRole('button', { name: 'Read prescription' }).click();
await page.getByRole('button', { name: 'Apply to case' }).waitFor({ timeout: 30000 });
await shot('20-rx-read');
await page.getByRole('button', { name: 'Apply to case' }).click();
log('setup after Rx', JSON.stringify(await state(() => window.__dcad.design.getState().doc.setup)));

// Demo scans (uploaded to the case).
await step('Scans');
await page.getByRole('button', { name: /load demo scans/i }).first().click();
await waitFor(() => window.__dcad.design.getState().doc.scans.length === 2 && window.__dcad.design.getState().doc.scans.every((s) => s.mesh.fileId));

// One-click crown.
await step('Tooth frame');
await page.keyboard.press('1');
await settle();
await page.getByLabel(/One-click crown/).check();
const seed = await state(async () => (await import('/src/geometry/synthetic.ts')).syntheticPrepSeed({ along: 1000 }));
const s = await state((p) => window.__dcad.viewer.project(p), seed);
const pastBefore = await state(() => window.__dcad.design.getState().past.length);
const t0 = Date.now();
await page.mouse.click(s.x, s.y);
await waitFor(() => { const o = window.__dcad.orchestrator.getState(); return !o.running && (o.complete || o.pendingReview || o.error); });
const orch = await state(() => { const o = window.__dcad.orchestrator.getState(); return { complete: o.complete, pendingReview: o.pendingReview, error: o.error, steps: o.steps.map((x) => ({ step: x.step, id: x.proposerId, status: x.status, failed: x.qa.filter((q) => !q.passed).map((q) => q.id), ms: Math.round(x.ms ?? 0) })) }; });
log('one-click in', Date.now() - t0, 'ms', JSON.stringify(orch));
await settle();
await shot('21-one-click-draft');
const dev = await state(async () => {
  const { syntheticPrepMargin } = await import('/src/geometry/synthetic.ts');
  const ref = syntheticPrepMargin({ along: 1000, samples: 720 });
  const m = window.__dcad.design.getState().doc.teeth[0].margin.points;
  let sum = 0, max = 0;
  for (const { p } of m) { let best = Infinity; for (let i = 0; i < ref.length; i += 3) best = Math.min(best, Math.hypot(p[0] - ref[i], p[1] - ref[i + 1], p[2] - ref[i + 2])); sum += best; max = Math.max(max, best); }
  return { mean: +(sum / m.length).toFixed(3), max: +max.toFixed(3) };
});
log('auto margin deviation mm', JSON.stringify(dev));
await page.getByRole('region', { name: 'Auto-design' }).getByRole('button', { name: 'Accept' }).first().click();
const afterAccept = await state(() => { const d = window.__dcad.design.getState(); const t = d.doc.teeth[0]; return { past: d.past.length, tx: d.transaction, author: d.lastAuthor, crown: t.crown?.kind, adapt: t.crown?.adapt, steps: t.steps }; });
log('accepted: undo entries added', afterAccept.past - pastBefore, JSON.stringify(afterAccept));

// Assistant via the mock provider's /tool syntax.
await step('Crown proposal');
await waitFor(() => { const c = window.__dcad.tools.getState().crown; return c && !c.computing; });
const pose0 = await state(() => window.__dcad.design.getState().doc.teeth[0].crown.pose.position);
await page.getByLabel('Instruction for the design assistant').fill('/tool move_crown {"fdi":36,"direction":"buccal","mm":0.3}');
await page.getByRole('button', { name: 'Send' }).click();
await waitFor(() => !window.__dcad.assistant.getState().running);
const agent = await state(() => ({ tx: window.__dcad.design.getState().transaction?.label, msgs: window.__dcad.assistant.getState().messages.map((m) => `${m.role}: ${(m.text ?? JSON.stringify(m)).slice(0, 120)}`) }));
log('assistant', JSON.stringify(agent));
await shot('22-assistant');
await page.getByRole('button', { name: 'Accept' }).first().click();
const pose1 = await state(() => window.__dcad.design.getState().doc.teeth[0].crown.pose.position);
const buccal = await state(() => window.__dcad.design.getState().doc.teeth[0].frame.buccal);
log('agent move along buccal mm', [0, 1, 2].reduce((a, k) => a + (pose1[k] - pose0[k]) * buccal[k], 0).toFixed(4), 'author', await state(() => window.__dcad.design.getState().lastAuthor));

// Save → version author + proposal events flushed.
await page.keyboard.press('Control+s');
await page.getByText(/Saved v1/).waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
log('events', JSON.stringify(await state(() => { const e = window.__dcad; return e.events ? e.events.getState() : null; })));
log('saved', await page.locator('.save-state').innerText());
log('CASE_ID', caseId);
log('page errors', errors.length ? errors : 'none');
await browser.close();
