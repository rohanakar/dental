# The margin algorithm, as a page to read

Status: **done** (2026-10-30).

## Goal

An interactive technical document about how dcad finds the crown margin, served at
`https://dental.cognifuze.com/algorithm`. A reader should be able to:

- follow it linearly, from what a margin is to the algorithm as it runs today;
- see how it evolved, each step forced by a failure;
- rediscover the ideas themselves, prompted by questions placed before each answer;
- play with every key idea in the browser.

## Scope

**In:**
- the margin by clicks (live-wire, ridge snap);
- the automatic margin (radial profiles, then true cross-sections, turn of the contour, noise-adaptive smoothing,
  height profiles on rough scans);
- the refiner and the doubt warning;
- the gate;
- the gum line on natural teeth (briefly);
- the prep finder's ledge, which shares the sections;
- the measured progress, as aggregate numbers only.

**Out:** frames, axis, crown design (one line each where the margin feeds them).

## Design

- **One static, self-contained page:** `apps/web/public/algorithm/index.html`, with its fonts in
  `apps/web/public/algorithm/fonts/` (IBM Plex Sans Condensed, Source Serif 4, IBM Plex Mono; OFL, self-hosted, so
  no third-party requests).
  - Vite copies `public/` into the build untouched.
  - Caddy redirects `/algorithm` to `/algorithm/`, as it does for `/app`, so the page's relative URLs work under any
    base path (`infra/Caddyfile`).
- **Interactive figures:** plain canvas and JavaScript, no libraries, on synthetic geometry generated in the page:
  - a die to turn, with its margin and a cutting plane;
  - live-wire on a curvature map, clicks with and without the snap;
  - a cross-section with noise, lean and smoothing controls, and its turn plot;
  - the ring of candidates with the refiner's choice and the doubt;
  - the scoreboard over time.
- **Puzzles:** each chapter opens with a question to think about before the answer is shown.
- **Data:**
  - Only aggregate results go on the page.
  - The real sample cases used for evaluation stay unnamed: they are local evaluation data, and their licence for
    this use hasn't been checked.
  - No scan, margin or per-case table from them.
- **Themes:** light and dark from the system, with a toggle. Readable at phone width.

## Verification

- The page loads from the built app (`vite build`, then `dist/algorithm/index.html`), and every figure works with no
  console errors (checked in a headless browser).
- `/algorithm` redirects to `/algorithm/` in Caddy's config.
- No test: documentation, outside what the tests cover (`CLAUDE.md`).

## Implementation summary

### What was built

**`apps/web/public/algorithm/index.html`** (130 KB), "Finding the finish line", with seven self-hosted font files
(240 KB). It has 13 chapters in the order things happened:

1. what a margin is;
2. live-wire;
3. the click snap;
4. the first automatic margin;
5. the refiner and wander;
6. the gum line by random walker;
7. the first real preps;
8. true cross-sections, turn and adaptive smoothing;
9. doubt picks the line;
10. the prep finder's ledge;
11. the scoreboard;
12. still open;
13. the twelve questions that rebuild the algorithm.

**Ten puzzles.** Each has a guess box (kept in the reader's browser), a hint and the answer.

**Six interactive figures,** all on synthetic data generated in the page:
- **A die to turn by dragging,** with its margin and a cutting plane, and the cut drawn flat.
- **Live-wire on a curvature map.** It uses dcad's own edge weight (κ₀, the 0.02 floor, up to 3× on the other sign)
  and the 0.3 mm snap with its four-fifths rule. You can:
  - tap your own clicks;
  - switch the snap off;
  - change the noise;
  - follow the finish line or the gum line.

  A readout gives the sharpest turn over 0.6 mm against the 120° rule.
- **One cut, read two ways.** It compares heights from above with the true section, using `turnsDeg` over ±0.15 mm,
  `quietTurns` with the real σ list and 6°, and `sectionEdges` (the first local maximum of at least 12°, 1.5 mm below
  the top). It marks the prep finder's ledge (wall, inner angle, lip). You can change:
  - wall lean;
  - noise;
  - gum height;
  - adaptive or manual σ.
- **The ring of candidates on 32 spokes.** It compares first corner, strongest and the ring DP, with dcad's costs
  (−0.5·min(convexity, 3); 5·|Δdrop| + 2·|Δradius|). You can change the jump cost, and the run and sharpness of the
  wall corners. It shows the finish-line doubt rule (a 1.6× stronger crease 0.35–1.5 mm away) and whether
  `margin.doubt` would stop one-click.
- **The β plateau,** using the measured points only.
- **A before/after scoreboard** of the aggregate numbers.

**Mobile:**
- one column under 1180 px, with a Chapters sheet instead of the rail;
- canvases sized to their container and the screen's pixel density;
- controls stack at phone width;
- the die turns on horizontal drags while vertical swipes still scroll the page.

**Themes:** light and dark from the system, with a toggle.

**`infra/Caddyfile`:** `/algorithm` redirects to `/algorithm/`, next to the `/app` redirect.

### Deviations

- **No headless-browser check.** The user asked to skip it. Instead:
  - every script parses (`node --check`);
  - every element id the scripts use exists in the page;
  - the cut and ring logic was run in Node.
- **Two figure defaults were corrected after that Node check:**
  - **The cut's default noise is now quiet.** It gives 4.3° of roughness, unsmoothed, as real scans are (1.3–6°). At
    13° and above the pick fails, 2.6 mm off, as on rough scans.
  - **The ring's caption was wrong.** It claimed a long run of sharp wall corners makes the DP give in. With dcad's
    real costs it doesn't: the DP stays on the finish line for any run short of the whole ring. The caption and
    chapter 9 now say "all the way round", which is also what real preps did.
- **The real lab demo cases stay unnamed on this public page.** Their licence for this use is unchecked, so the page
  calls them "60 demo cases that ship with a commercial dental CAD".

### Verification

- `node --check` on the page's script passes, and no element id is missing.
- **In Node:**
  - **The cut:** the margin is found 0.016–0.018 mm from the true one at roughness up to 9°, at wall leans of +6° and
    −6°. It fails at 13° and above.
  - **The ring:** the DP keeps all 32 spokes on the finish line for runs of 6–28 wall corners at sharpness 1.6–3. For
    a run all the way round at sharpness 3 it takes the wall corners, and every spoke is in doubt.
- No unit test: documentation (`CLAUDE.md`). `pnpm test` is unaffected.

### Follow-ups

- **It goes live on the next deploy** (`git pull && ./infra/compose.sh up -d --build` on the VM).
- **A real-device look,** on a phone and in both themes.
