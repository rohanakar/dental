// The walkthrough video director (specs/2026-10-30-walkthrough-videos.md): films an episode of the real app in headless
// Chrome on the GPU, with a drawn cursor, captions, keycaps and check toasts, a narration from macOS `say`, and the
// checks that make the episode a test. Episodes call the methods of `Director`; run.mjs films them and writes the
// gallery.
import { chromium } from 'playwright';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { installOverlay } from './overlay.mjs';

const run = promisify(execFile);
export const ROOT = new URL('../../../', import.meta.url).pathname;
export const DATA = `${ROOT}data/synthetic/`;
export const GOLDEN = `${ROOT}data/golden/`;
export const OUT = `${resolve(process.env.VIDEO_OUT ?? `${ROOT}out/videos`)}/`;
export const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/app/';
/** The site root the app is served under (the landing page and /algorithm/ live here). */
export const SITE = new URL('..', APP_URL).href;
const VIEW = { width: 1600, height: 900 };
const SCALE = 1.2; // 1600×900 CSS px filmed as 1920×1080
const FPS = 30;
const VOICE = process.env.VOICE ?? 'Samantha';
const RATE = process.env.VOICE_RATE ?? '182';
const NARRATION = process.env.NARRATION !== '0';
/** The narration clips, shared by every output folder. */
const TTS = `${resolve(process.env.TTS_CACHE ?? `${ROOT}out/.tts-cache`)}/`;
const HAS_SAY = (() => {
  try {
    execFileSync('which', ['say'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Chrome's screencast piped to ffmpeg at a constant frame rate: each JPEG frame is repeated until the next one's
 * timestamp. Frames arrive only when the page changes, so a still page costs nothing until the next change.
 */
class Recorder {
  constructor(page, file) {
    this.page = page;
    this.file = file;
    this.written = 0;
    this.last = null;
    this.queue = Promise.resolve();
  }
  async start() {
    this.ff = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-vf', 'scale=1920:1080:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-r', String(FPS), '-movflags', '+faststart', this.file,
    ]);
    this.exited = new Promise((done, fail) => {
      this.ff.on('error', fail);
      this.ff.on('close', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited ${code}`))));
    });
    this.ff.stderr.on('data', (b) => process.stderr.write(`[ffmpeg] ${b}`));
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      this.frame(Buffer.from(data, 'base64'), metadata.timestamp ?? Date.now() / 1000);
    });
    this.t0 = Date.now() / 1000;
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  }
  /** Seconds since filming started, on the screencast's clock (wall time). */
  now() {
    return Date.now() / 1000 - this.t0;
  }
  frame(buf, t) {
    const slot = Math.floor((t - this.t0) * FPS);
    if (this.last) this.pad(slot);
    else this.pad(slot, buf);
    this.last = buf;
  }
  pad(slot, buf = this.last) {
    while (this.written < slot) {
      this.written++;
      this.write(buf);
    }
  }
  write(buf) {
    this.queue = this.queue.then(() => new Promise((done) => (this.ff.stdin.write(buf) ? done() : this.ff.stdin.once('drain', done))));
  }
  async stop() {
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    if (this.last) this.pad(Math.floor(this.now() * FPS) + 1);
    await this.queue;
    this.ff.stdin.end();
    await this.exited;
    return this.written / FPS;
  }
}

/** One narration clip per caption, cached by voice and text. Returns its file (null without `say`) and length. */
async function speech(text) {
  if (!HAS_SAY) return { file: null, seconds: 0.9 + text.split(/\s+/).length / 2.8 };
  const dir = TTS;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}${createHash('sha1').update(`${VOICE}|${RATE}|${text}`).digest('hex').slice(0, 20)}.aiff`;
  if (!existsSync(file)) await run('say', ['-v', VOICE, '-r', RATE, '-o', file, text]);
  const seconds = aiffSeconds(file);
  if (seconds) return { file, seconds };
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return { file, seconds: Number(stdout.trim()) };
}

/** An AIFF / AIFF-C clip's length from its COMM chunk (frames ÷ the 80-bit extended sample rate), or 0. */
function aiffSeconds(file) {
  const b = readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'FORM') return 0;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = b.toString('latin1', at, at + 4);
    const size = b.readUInt32BE(at + 4);
    if (id === 'COMM') {
      const frames = b.readUInt32BE(at + 10);
      const exponent = (b.readUInt16BE(at + 16) & 0x7fff) - 16383;
      const mantissa = b.readUInt32BE(at + 18) * 2 ** 32 + b.readUInt32BE(at + 22);
      const rate = mantissa * 2 ** (exponent - 63);
      return rate > 0 ? frames / rate : 0;
    }
    at += 8 + size + (size % 2);
  }
  return 0;
}

const vttTime = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
};

/** What an episode's `run(d)` drives: the page, plus filmed actions, narration and checks. */
export class Director {
  constructor({ page, context, episode, number, total, recorder, files }) {
    this.page = page;
    this.context = context;
    this.episode = episode;
    this.number = number;
    this.total = total;
    this.recorder = recorder;
    this.files = files;
    this.mouse = { x: VIEW.width * 0.62, y: VIEW.height * 0.55 };
    this.cues = [];
    this.chapters = [];
    this.checks = [];
    this.speaking = Promise.resolve();
    this.chapterTitle = '';
    this.log = (...a) => console.log(`[${episode.id}]`, ...a);
  }

  // ---- Navigation and app state ---------------------------------------------------------------------------------------
  /** A URL under the site root: `url('app/?demo')`, `url('algorithm/')`. */
  url(path = '') {
    return new URL(path, SITE).href;
  }
  async goto(path) {
    await this.page.goto(this.url(path));
  }
  /** After a new document loads (goto, or a link): the drawn cursor where the mouse is, and the caption still being said. */
  restore() {
    const c = this.caption && this.caption.until > Date.now() ? { ...this.caption, ms: this.caption.until - Date.now() } : null;
    return this.overlay(
      ([m, cap]) => {
        window.__wt.cursor(m.x, m.y);
        if (cap) window.__wt.caption(cap.text, cap.eyebrow, cap.ms);
      },
      [this.mouse, c],
    );
  }
  /** Opens the editor offline, with the dev hook ready; `autoFrames: false` leaves the tooth frames to the clicks. */
  async openOffline({ autoFrames } = {}) {
    await this.goto('app/');
    await this.page.waitForFunction(() => Boolean(window.__dcad?.tools));
    if (autoFrames !== undefined) await this.state((on) => window.__dcad.tools.getState().set({ autoFrames: on }), autoFrames);
  }
  state(fn, arg) {
    return this.page.evaluate(fn, arg);
  }
  waitFor(fn, arg, timeout = 240000) {
    return this.page.waitForFunction(fn, arg, { timeout, polling: 150 });
  }
  /** The overlay's API in the page; ignored while a navigation replaces the document. */
  overlay(fn, arg) {
    return this.page.evaluate(fn, arg).catch(() => {});
  }
  project(p) {
    return this.state((q) => window.__dcad.viewer.project(q), p);
  }
  synthetic(fn, arg) {
    return this.state(async ([f, a]) => (await import('/src/geometry/synthetic.ts'))[f](a), [fn, arg]);
  }
  tooth(fdi) {
    return this.state((f) => window.__dcad.design.getState().doc.teeth.find((t) => t.fdi === f), fdi);
  }
  /** Scrolls the side panel (only) so `selector`'s first match is at its top. */
  panelTo(selector) {
    return this.page.locator(selector).first().evaluate((el) => {
      const panel = el.closest('aside');
      panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
    });
  }
  /** The working tooth, from the panel's Tooth select (bridges, several crowns). */
  selectTooth(fdi) {
    return this.select(this.page.getByLabel('Tooth', { exact: true }), String(fdi));
  }
  /** A bridge unit's button in the bridge panel. */
  unitButton(fdi) {
    return this.page.locator(`.bridge-units button[title="Make ${fdi} the active unit"]`).first();
  }
  /** Opens "More types" for a tooth in Case setup (inlay, onlay, wing, implant, reduced). */
  async moreTypes(fdi) {
    const more = this.page.getByRole('button', { name: `More types for ${fdi}` });
    if ((await more.count()) && (await more.getAttribute('aria-expanded')) !== 'true') await this.click(more);
  }
  /**
   * Imports scan files (paths under data/synthetic/ unless absolute) on the Scans step, pointing at the import control
   * first (a file chooser is not drawn headless), and waits until every scan is loaded.
   */
  async loadScans(files, { count = files.length } = {}) {
    await this.step('Scans');
    const input = this.page.locator('input[type=file][accept=".stl,.ply"]');
    const dropzone = this.page.locator('.dropzone').first();
    if (await dropzone.count()) {
      await dropzone.scrollIntoViewIfNeeded();
      const box = await dropzone.boundingBox();
      await this.moveTo(box.x + box.width / 2, box.y + box.height / 2);
      await this.point(dropzone, 1600);
      await sleep(500);
    }
    await input.setInputFiles(files.map((f) => (f.startsWith('/') ? f : DATA + f)));
    await this.waitFor(
      (n) => window.__dcad.design.getState().doc.scans.length === n && window.__dcad.scene.getState().objects.filter((o) => o.phase === 'ready').length === n,
      count,
      300000,
    );
  }
  /**
   * Until the camera stops: two equal samples 250 ms apart, then three rendered frames in a row with the camera
   * unchanged (as in bridge.mjs).
   */
  async settle() {
    let last = '';
    for (let i = 0; i < 200; i++) {
      const now = await this.state(() => window.__dcad.viewer.controls.camera.position.toArray().map((x) => x.toFixed(3)).join());
      if (now === last) break;
      last = now;
      await sleep(250);
    }
    await this.state(
      () =>
        new Promise((done) => {
          const camera = window.__dcad.viewer.controls.camera;
          let previous = '';
          let same = 0;
          let frames = 0;
          const tick = () => {
            const now = [...camera.position.toArray(), ...camera.quaternion.toArray()].map((x) => x.toFixed(4)).join();
            same = now === previous ? same + 1 : 0;
            previous = now;
            if (same >= 3 || ++frames > 600) done();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
  }

  // ---- Narration and chapters ---------------------------------------------------------------------------------------
  /** A new chapter: a seek point in the gallery and the caption's eyebrow. */
  chapter(title) {
    this.chapterTitle = title;
    this.chapters.push({ t: this.recorder.now(), title });
    this.log('§', title);
  }
  /**
   * Says `text` and shows it as the caption. Resolves when the speech ends; `wait: false` returns once the caption is
   * up, so actions run during the speech (`hush()` waits for its end; the next `say` waits too, so clips never overlap).
   */
  async say(text, { wait = true } = {}) {
    await this.speaking;
    const clip = await speech(text);
    const start = this.recorder.now();
    this.cues.push({ start, end: start + clip.seconds, text, file: clip.file });
    const eyebrow = `${String(this.number).padStart(2, '0')} · ${this.episode.title}${this.chapterTitle ? ` — ${this.chapterTitle}` : ''}`;
    this.caption = { text, eyebrow, until: Date.now() + clip.seconds * 1000 + 700 };
    await this.overlay(([t, e, ms]) => window.__wt.caption(t, e, ms), [text, eyebrow, clip.seconds * 1000 + 700]);
    this.speaking = sleep(clip.seconds * 1000 + 650); // a breath between lines
    // Returns nothing: an async function returning the speech promise would make `await say(…, { wait: false })` wait.
    if (wait) await this.speaking;
  }
  /** Takes focus off any field, so a shortcut reaches the app and not an input (no click: a click could be a scene pick). */
  blur() {
    return this.state(() => document.activeElement?.blur?.());
  }
  /** Waits for the current speech to end. */
  hush() {
    return this.speaking;
  }
  pause(ms = 600) {
    return sleep(ms);
  }

  // ---- Checks ---------------------------------------------------------------------------------------------------------
  /** One check: logged, kept for the report, and shown as a ✓ or ✗ toast in the video. */
  async check(ok, label, detail = '') {
    const passed = Boolean(ok);
    this.checks.push({ label, ok: passed, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    this.log(passed ? 'PASS' : 'FAIL', label, typeof detail === 'string' ? detail : JSON.stringify(detail));
    await this.overlay(([o, l]) => window.__wt.toast(o, l), [passed, label]);
    return passed;
  }

  // ---- The cursor and input ---------------------------------------------------------------------------------------------
  /** Moves the drawn cursor (and the real mouse) along an eased path. */
  async moveTo(x, y, { ms } = {}) {
    const from = { ...this.mouse };
    const dist = Math.hypot(x - from.x, y - from.y);
    const duration = ms ?? Math.min(950, 260 + dist * 0.55);
    const t0 = Date.now();
    for (;;) {
      const t = Math.min(1, (Date.now() - t0) / duration);
      const k = ease(t);
      await this.page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
      if (t >= 1) break;
      await sleep(14);
    }
    this.mouse = { x, y };
  }
  /** Scrolls an element into view only when it is not already wholly in the window (a sticky one would scroll the page). */
  async reveal(loc) {
    const box = await loc.boundingBox();
    const inside = box && box.x >= 0 && box.y >= 0 && box.x + box.width <= VIEW.width && box.y + box.height <= VIEW.height;
    if (!inside) await loc.scrollIntoViewIfNeeded();
  }
  locate(target) {
    return typeof target === 'string' ? this.page.getByRole('button', { name: target, exact: true }).first() : target;
  }
  /** Rings an element briefly, to point at it. Returns its box, or null (at once) when it is not on the page. */
  async point(target, ms = 1400) {
    const loc = this.locate(target);
    if (!(await loc.waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false))) return null;
    await this.reveal(loc);
    const box = await loc.boundingBox();
    if (box) await this.overlay(([b, t]) => window.__wt.ring(b, t), [box, ms]);
    return box;
  }
  /** Moves to an element, rings it, clicks it. `target`: a locator, or a button's exact name. */
  async click(target, { ring = true, settleMs = 250, ...options } = {}) {
    const loc = this.locate(target);
    await loc.waitFor({ state: 'visible' });
    await this.reveal(loc);
    const box = await loc.boundingBox();
    await this.moveTo(box.x + box.width / 2, box.y + box.height / 2);
    if (ring) {
      await this.overlay(([b]) => window.__wt.ring(b, 650), [box]);
      await sleep(260);
    }
    await loc.click(options);
    await sleep(settleMs);
  }
  /** A step on the rail. */
  step(label) {
    return this.click(this.page.getByRole('navigation', { name: 'Design steps' }).getByRole('button', { name: label }).first());
  }
  /** Picks an option in a <select> (the native list is not drawn headless, so the choice is shown by the ring). */
  async select(target, value) {
    const loc = this.locate(target);
    await this.reveal(loc);
    const box = await loc.boundingBox();
    await this.moveTo(box.x + box.width / 2, box.y + box.height / 2);
    await this.overlay(([b]) => window.__wt.ring(b, 900), [box]);
    await sleep(350);
    await loc.selectOption(value);
    await sleep(300);
  }
  /** Clicks into a field and types, a key at a time, over what was there (select-all, so a number field never shows "0"). */
  async type(target, text, { clear = true, delay = 45 } = {}) {
    const loc = this.locate(target);
    await this.click(loc, { ring: true, settleMs: 100 });
    if (clear) await loc.press('ControlOrMeta+a');
    await loc.pressSequentially(String(text), { delay });
  }
  /** Presses a shortcut and shows its keycap with what it does. */
  async press(keys, what = '') {
    const label = keys
      .split('+')
      .map((k) => ({ Control: 'Ctrl', Meta: '⌘', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' })[k] ?? (k.length === 1 ? k.toUpperCase() : k))
      .join(' + ');
    await this.overlay(([l, w]) => window.__wt.keys(l, w), [label, what]);
    await this.page.keyboard.press(keys);
    await sleep(350);
  }
  /** Clicks a screen point. */
  async clickAt(x, y, { button = 'left' } = {}) {
    await this.moveTo(x, y);
    await sleep(120);
    await this.page.mouse.click(x, y, { button });
  }
  /**
   * Clicks a world point once the view shows it: waits until the surface under its projection is the point itself,
   * within 0.3 mm (as `clickWorld` in bridge.mjs), then moves there and clicks.
   */
  async clickWorld(p, { objectIds, guard = true } = {}) {
    for (let i = 0; guard && i < 40; i++) {
      const miss = await this.state(
        ([q, ids]) => {
          const v = window.__dcad.viewer;
          const s = v.project(q);
          const hit = s && v.raycast(s.x, s.y, ids ? { objectIds: ids } : undefined);
          return hit ? Math.hypot(hit.point.x - q[0], hit.point.y - q[1], hit.point.z - q[2]) : Infinity;
        },
        [p, objectIds ?? null],
      );
      if (miss < 0.3) break;
      await sleep(250);
      await this.settle();
    }
    const s = await this.project(p);
    await this.moveTo(s.x, s.y);
    await sleep(120);
    const at = await this.project(p);
    await this.page.mouse.click(at.x, at.y);
    this.mouse = { x: at.x, y: at.y };
    return at;
  }
  /** A drag between two screen points, eased. */
  async drag(from, to, { button = 'left', ms = 900 } = {}) {
    await this.moveTo(from.x, from.y);
    await sleep(150);
    await this.page.mouse.down({ button });
    await this.moveTo(to.x, to.y, { ms });
    await sleep(80);
    await this.page.mouse.up({ button });
  }
  /** The 3D view's centre on screen. */
  async stage() {
    const box = await this.page.locator('.canvas-host').boundingBox();
    return { ...box, cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
  }
  /** Turns the view: a left drag across the 3D view by (dx, dy) px; a negative `dy` tilts away from occlusal. */
  async orbit(dx, dy = 0, { ms = 1400 } = {}) {
    const s = await this.stage();
    await this.drag({ x: s.cx - dx / 2, y: s.cy - dy / 2 }, { x: s.cx + dx / 2, y: s.cy + dy / 2 }, { ms });
  }
  /** Pans the view: a right drag. */
  async pan(dx, dy = 0, { ms = 1100 } = {}) {
    const s = await this.stage();
    await this.drag({ x: s.cx - dx / 2, y: s.cy - dy / 2 }, { x: s.cx + dx / 2, y: s.cy + dy / 2 }, { button: 'right', ms });
  }
  /** Zooms with the wheel at the cursor; negative `clicks` zoom in. */
  async zoom(clicks, { at } = {}) {
    if (at) await this.moveTo(at.x, at.y);
    await this.overlay(([l, w]) => window.__wt.keys(l, w), ['Scroll', clicks < 0 ? 'Zoom in' : 'Zoom out']);
    for (let i = 0; i < Math.abs(clicks); i++) {
      await this.page.mouse.wheel(0, Math.sign(clicks) * 40);
      await sleep(110);
    }
  }
  /** Runs `trigger` and saves the download it starts into the episode's files folder. Returns the saved path. */
  async download(trigger) {
    const [file] = await Promise.all([this.page.waitForEvent('download'), trigger()]);
    mkdirSync(this.files, { recursive: true });
    const path = `${this.files}${file.suggestedFilename()}`;
    await file.saveAs(path);
    return path;
  }

  // ---- Cards ------------------------------------------------------------------------------------------------------------
  card(card) {
    return this.overlay((c) => window.__wt.card(c), card);
  }
  hideCard() {
    return this.overlay(() => window.__wt.hideCard());
  }
}

/**
 * Films one episode into `<OUT><id>.mp4` (+ `.vtt`) and returns its report entry. The title card covers the page while
 * `episode.setup` runs; the end card counts the checks. An episode that throws keeps its video so far and an error card.
 */
export async function film(episode, { number, total, next }) {
  mkdirSync(OUT, { recursive: true });
  const raw = `${OUT}.${episode.id}.video.mp4`;
  const mp4 = `${OUT}${episode.id}.mp4`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, acceptDownloads: true });
  await context.addInitScript(installOverlay);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 50\d|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => void d.accept());
  const recorder = new Recorder(page, raw);
  const d = new Director({ page, context, episode, number, total, recorder, files: `${OUT}files/${episode.id}/` });
  page.on('load', () => void d.restore());
  let error = null;
  const started = Date.now();
  try {
    await page.goto(d.url(episode.start ?? 'app/'));
    await d.card({ kind: 'title', eyebrow: `Episode ${number} of ${total}`, title: episode.title, body: episode.summary, bullets: episode.learn ?? [] });
    await sleep(700); // the card's fade-in, so the first frame (the poster) is the card
    await recorder.start();
    const setup = episode.setup?.(d);
    await d.say(episode.intro ?? episode.summary);
    await setup;
    await d.hideCard();
    await sleep(500);
    await episode.run(d);
    await d.hush();
    await d.check(errors.length === 0, 'No errors in the browser console', errors.slice(0, 3).join(' | '));
  } catch (e) {
    error = String(e?.stack ?? e);
    d.log('ERROR', error);
    await d.card({ kind: 'error', eyebrow: `Episode ${number} stopped`, title: 'Something went wrong', body: String(e?.message ?? e).split('\n')[0].slice(0, 220) });
    await sleep(2500);
  }
  if (!error) {
    const passed = d.checks.filter((c) => c.ok).length;
    const failed = d.checks.length - passed;
    await d.card({
      kind: failed ? 'error' : 'end',
      eyebrow: `Episode ${number} of ${total}`,
      title: episode.title,
      body: failed ? `${failed} of ${d.checks.length} checks failed.` : `All ${passed} checks passed.`,
      checks: [...d.checks.filter((c) => !c.ok), ...d.checks.filter((c) => c.ok)].slice(0, 10),
      foot: next ? `Next: ${next.title}` : 'End of the series',
    });
    await d.say(next ? `${episode.outro ?? 'That is it for this episode.'} Next: ${next.title}.` : `${episode.outro ?? ''} That is the end of the series.`.trim());
    await sleep(600);
  }
  const seconds = await recorder.stop();
  await browser.close();
  await mux(raw, mp4, d.cues);
  rmSync(raw, { force: true });
  writeFileSync(`${OUT}${episode.id}.vtt`, `WEBVTT\n\n${d.cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}\n`).join('\n')}`);
  return {
    id: episode.id,
    number,
    title: episode.title,
    summary: episode.summary,
    learn: episode.learn ?? [],
    video: `${episode.id}.mp4`,
    subtitles: `${episode.id}.vtt`,
    seconds: Math.round(seconds * 10) / 10,
    filmedInSeconds: Math.round((Date.now() - started) / 1000),
    chapters: d.chapters.map((c) => ({ t: Math.round(c.t * 10) / 10, title: c.title })),
    checks: d.checks,
    error,
    ok: !error && d.checks.every((c) => c.ok),
  };
}

/** Lays each narration clip at its start time over the video (or just moves the video in place without narration). */
async function mux(raw, mp4, cues) {
  const clips = cues.filter((c) => c.file);
  if (!NARRATION || clips.length === 0) {
    renameSync(raw, mp4);
    return;
  }
  const inputs = clips.flatMap((c) => ['-i', c.file]);
  const delays = clips.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.start * 1000)}:all=1[a${i}]`);
  const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad[aout]`;
  await run('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', raw, ...inputs, '-filter_complex', [...delays, mix].join(';'),
    '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', mp4,
  ], { maxBuffer: 1 << 24 });
}
