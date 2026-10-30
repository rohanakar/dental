// Episode 13: the margin algorithm page (apps/web/public/algorithm/, specs/2026-10-30-margin-algorithm-page.md): reading
// it, its puzzles, and four of its figures (the die, live-wire, the ring DP and doubt, the cut). The dev server serves
// the landing page at /algorithm/ (as Caddy did before 7fa8d99), so the episode opens algorithm/index.html.

/** Scrolls the window to `y` along an eased path, so the video glides instead of jumping. */
const glide = (d, y, ms = 1100) =>
  d.state(
    ([to, ms]) =>
      new Promise((done) => {
        const from = scrollY;
        const t0 = performance.now();
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
        const tick = (now) => {
          const t = Math.min(1, (now - t0) / ms);
          // 'instant': the page's smooth scroll-behavior (set in setup) would turn each step into its own animation.
          scrollTo({ top: from + (to - from) * ease(t), behavior: 'instant' });
          if (t < 1) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      }),
    [y, ms],
  );

/** Glides so `selector`'s top sits `offset` px below the window's top (under the page's 55 px bar). */
const bring = async (d, selector, offset = 64) => {
  const top = await d.state((s) => document.querySelector(s).getBoundingClientRect().top + scrollY, selector);
  await glide(d, top - offset);
};

/** Glides by `dy` px. */
const nudge = async (d, dy) => glide(d, (await d.state(() => scrollY)) + dy, 800);

/** Waits until the window stops scrolling (a smooth anchor jump). */
const still = async (d) => {
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const y = await d.state(() => scrollY);
    if (y === last) return;
    last = y;
    await d.pause(120);
  }
};

/** Drags a range input's thumb to `value` (then sets it exactly), as a reader would. */
async function slide(d, id, value) {
  const input = d.page.locator(`#${id}`);
  const r = await input.evaluate((el) => ({ min: +el.min, max: +el.max, value: +el.value }));
  const box = await input.boundingBox();
  const at = (v) => ({ x: box.x + 8 + ((v - r.min) / (r.max - r.min)) * (box.width - 16), y: box.y + box.height / 2 });
  await d.overlay(([b]) => window.__wt.ring(b, 1300), [box]);
  await d.drag(at(r.value), at(value), { ms: 900 });
  await input.fill(String(value));
  await d.pause(300);
}

/** A cheap signature of a canvas's pixels, to tell whether a figure redrew. */
const signature = (d, selector) =>
  d.state((s) => {
    const u = document.querySelector(s).toDataURL();
    let h = 0;
    for (let i = 0; i < u.length; i += 7) h = (h * 31 + u.charCodeAt(i)) | 0;
    return h;
  }, selector);

const readout = (d, id) => d.page.locator(`#${id}`).innerText();
const mm = (text) => Number(/found ([\d.]+) mm/.exec(text)?.[1] ?? NaN);

export default {
  id: '13-algorithm',
  title: 'How the margin is found: the algorithm page',
  summary: 'A guided read of the page that explains how Dental CAD finds a crown margin: its chapters and puzzles, and the figures you can drag, tap and slide.',
  learn: ['Read the chapters from the rail', 'Open a puzzle’s hint and answer', 'Trace a live-wire line, with and without the snap', 'See the ring choice, its doubt, and the cut'],
  start: 'algorithm/index.html',
  intro: 'The margin is the line every crown is built on. This page explains how Dental CAD finds it, chapter by chapter, with figures you can play with.',
  outro: 'Every figure on the page works the same way: change one thing and watch what the algorithm does.',
  async setup(d) {
    // Smooth anchor scrolling, so a click on the rail glides in the video instead of cutting.
    await d.page.addStyleTag({ content: 'html { scroll-behavior: smooth; }' });
  },
  async run(d) {
    const { page } = d;
    const rail = page.getByRole('navigation', { name: 'Chapters' });

    d.chapter('Reading the page');
    const shape = await d.state(() => ({ chapters: document.querySelectorAll('section.chapter').length, rail: document.querySelectorAll('.rail a').length, title: document.querySelector('article h1')?.textContent }));
    await d.check(shape.chapters === 13 && shape.rail === 13 && /finish line/i.test(shape.title ?? ''), 'The algorithm page opens with its 13 chapters', shape);
    await d.say('The page opens with the problem: one closed line around a prepared tooth, found on a scan with no labels.', { wait: false });
    await d.point(page.locator('article h1'), 2600);
    await d.hush();
    await d.say('The rail on the left lists the thirteen chapters, in the order things happened. It follows you as you read.', { wait: false });
    await d.point(rail.locator('ol'), 3500);
    await d.hush();

    d.chapter('Turn the tooth');
    await bring(d, '#fig-die');
    const die = page.locator('#die');
    const box = await die.boundingBox();
    await d.say('Every figure runs on a synthetic tooth made in the page.');
    await d.say('Drag to turn the prep. The red line is the margin.', { wait: false });
    const before = await signature(d, '#die');
    await d.drag({ x: box.x + box.width * 0.35, y: box.y + box.height * 0.5 }, { x: box.x + box.width * 0.7, y: box.y + box.height * 0.42 }, { ms: 1600 });
    // The tooth spins by itself until a drag takes over: turned, then still.
    const turned = await signature(d, '#die');
    await d.pause(400);
    await d.check(turned !== before && (await signature(d, '#die')) === turned, 'Dragging turns the tooth and stops its spin');
    await d.hush();
    await d.say('The slider moves the cutting plane round the tooth. Flattened, that cut is a profile, and most of this page is about reading profiles.', { wait: false });
    await slide(d, 'cut', 140);
    const cut = await page.locator('output[for="cut"]').innerText();
    await d.check(cut.trim() === '140°', 'The cut moves to 140°', cut);
    await d.hush();

    d.chapter('Chapters and puzzles');
    await d.say('Click a chapter in the rail to go to it.', { wait: false });
    await d.click(rail.getByRole('link', { name: /The line a crown is built on/ }));
    await still(d);
    await d.hush();
    const puzzle = page.locator('.puzzle[data-id="p1"]');
    await bring(d, '.puzzle[data-id="p1"]', 120);
    const counted = await page.locator('#puzzle-count').innerText();
    await d.say('Each chapter stops at a puzzle. Write your guess in the box first.', { wait: false });
    await d.point(puzzle.locator('.q'), 2000);
    await d.point(puzzle.locator('textarea'), 2200);
    await d.hush();
    await d.say('Then open the hint, or the answer.', { wait: false });
    await d.click(puzzle.getByRole('button', { name: 'Hint' }));
    await d.check(await puzzle.locator('.hint').isVisible(), 'Hint opens the puzzle’s hint');
    await d.pause(900);
    await d.click(puzzle.getByRole('button', { name: 'Show what dcad does' }));
    await d.hush();
    await d.check(await puzzle.locator('.answer').isVisible(), 'The answer opens under the puzzle');
    const count = await page.locator('#puzzle-count').innerText();
    await d.check(count !== counted, 'The rail counts the puzzles you opened', `${counted} → ${count}`);
    await d.say('The answer says what Dental CAD does. The rail keeps count of the puzzles you have opened.', { wait: false });
    await d.point(page.locator('#puzzle-count'), 2400);
    await d.hush();

    d.chapter('Live-wire: clicks joined along the ridge');
    await d.click(rail.getByRole('link', { name: /Let the hand lead/ }));
    await still(d);
    await bring(d, '#fig-lw', 60);
    await d.click(page.locator('#lw-clear'), { ring: false });
    await d.say('In the live-wire figure, tap a few points near the dark ring, then close the loop.', { wait: false });
    const lw = await page.locator('#lw').boundingBox();
    // The finish ring of the figure's map (LiveWire's C and R in the page), 2.2 cells outside it, as a hand would click.
    const W = 160;
    const H = 112;
    const R = (t) => 37 + 5.5 * Math.cos(2 * t) + 2.6 * Math.sin(3 * t + 1);
    const tap = (t) => {
      const r = R(t) + 2.2;
      const cx = Math.round(80 + r * Math.cos(t));
      const cy = Math.round(56 + r * Math.sin(t));
      return { x: lw.x + ((cx + 0.5) / W) * lw.width, y: lw.y + ((cy + 0.5) / H) * lw.height };
    };
    for (const t of [0.3, 1.5, 2.7, 3.9, 5.1]) {
      const p = tap(t);
      await d.clickAt(p.x, p.y);
      await d.pause(250);
    }
    await d.hush();
    await d.say('The red path between your clicks hugs the ridge, and even bridges the weak patch where the scan is faint.', { wait: false });
    await d.click(page.locator('#lw-close'));
    const snapped = await readout(d, 'lw-read');
    await d.check(/clicks\s*5/.test(snapped) && /passes the 120° rule/.test(snapped), 'Five clicks close into a line that passes the gate', snapped);
    await d.hush();
    await nudge(d, 260);
    await d.say('Below, the readout measures the line as the app’s gate does: its length, and its sharpest turn.', { wait: false });
    await d.point(page.locator('#lw-read'), 2800);
    await d.hush();
    await d.say('Now turn the snap off. Each click stays where you put it, a little off the ridge, and the line gets longer and kinks.', { wait: false });
    await d.click(page.locator('#lw-snap button[data-v="off"]'));
    const loose = await readout(d, 'lw-read');
    const turn = (s) => Number(/sharpest turn over 0\.6 mm\s*(\d+)°/.exec(s)?.[1] ?? NaN);
    await d.check(turn(loose) > turn(snapped), `Without the snap the sharpest turn grows (${turn(snapped)}° → ${turn(loose)}°)`, loose);
    await d.hush();
    await d.say('With the snap on, the app moves each click onto the ridge, within 0.3 millimetres.', { wait: false });
    await d.click(page.locator('#lw-snap button[data-v="on"]'));
    await d.hush();

    d.chapter('The ring and its doubt');
    await bring(d, '#fig-ring', 60);
    await d.say('The ring figure picks one corner on each of 32 spokes round the prep. The ring choice keeps the line smooth, so all 32 sit on the finish line.', { wait: false });
    const ring0 = await readout(d, 'ring-read');
    await d.check(/32 \/ 32/.test(ring0) && /no doubt/.test(ring0), 'All 32 spokes start on the finish line', ring0);
    await d.hush();
    await d.say('Now make a false edge up the wall run all the way round, and make it sharp.', { wait: false });
    await slide(d, 'ring-run', 32);
    await slide(d, 'ring-sharp', 3);
    await d.hush();
    await nudge(d, 200);
    const ring1 = await readout(d, 'ring-read');
    await d.check(/stretches in doubt\s*[1-9]/.test(ring1) && /margin\.doubt stops one-click/.test(ring1), 'A sharp false edge all the way round is flagged in doubt', ring1);
    await d.say('The line takes the false edge, as real preps did. But the doubt warning flags it, so one-click stops and asks you to review the margin.', { wait: false });
    await d.point(page.locator('#ring-read'), 4000);
    await d.hush();

    d.chapter('The cut through the scan');
    await bring(d, '#fig-sec', 60);
    await d.say('The cut figure shows one profile through a prep.');
    await d.say('Tilt the wall past vertical, then read the profile from above.', { wait: false });
    await slide(d, 'sec-lean', -6);
    await d.click(page.locator('#sec-sampler button[data-v="heights"]'));
    await d.hush();
    await nudge(d, 260);
    const above = await readout(d, 'sec-read');
    await d.check(!(mm(above) <= 0.1), `Read from above, the overhang hides the margin (${Number.isNaN(mm(above)) ? 'nothing found' : `${mm(above)} mm off`})`, above);
    await d.say('From above, the overhang hides the margin.');
    await d.say('The true section walks the contour itself, and finds the corner again.', { wait: false });
    await d.click(page.locator('#sec-sampler button[data-v="section"]'));
    const section = await readout(d, 'sec-read');
    await d.check(mm(section) <= 0.1, `The true section finds the margin (${mm(section)} mm off)`, section);
    await d.hush();
    await d.say('Add scan noise. The smoothing adapts: just enough to calm the profile, so the corner stays sharp and is still found.', { wait: false });
    await slide(d, 'sec-noise', 0.012);
    const noisy = await readout(d, 'sec-read');
    const sigma = Number(/smoothing σ\s*([\d.]+)/.exec(noisy)?.[1] ?? NaN);
    await d.check(sigma > 0 && mm(noisy) <= 0.1, `With noise, adaptive smoothing (σ ${sigma} mm) still finds the margin`, noisy);
    await d.point(page.locator('#sec-read'), 2600);
    await d.hush();

    d.chapter('Dark theme');
    await d.say('The theme button switches the page to dark. Every figure redraws in the new colours.', { wait: false });
    const light = await signature(d, '#sec');
    // The theme button sits in the sticky bar: click it where it is (a scroll into view would move the page).
    const tb = await page.locator('#theme').boundingBox();
    await d.overlay(([b]) => window.__wt.ring(b, 900), [tb]);
    await d.clickAt(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await d.pause(400);
    const theme = await d.state(() => document.documentElement.getAttribute('data-theme'));
    await d.check(theme === 'dark' && (await signature(d, '#sec')) !== light, 'The page and its figures switch to dark', theme);
    await bring(d, '#fig-sec', 60);
    await d.hush();
    await d.pause(1500);
  },
};
