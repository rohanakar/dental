# Walkthrough videos: a scripted series that demonstrates and checks each feature

Status: **done** (2026-10-30).

## Goal

A series of narrated walkthrough videos, one per feature, made by scripts that drive the real app. Each video:

- shows a new user how to use one feature (what to click, what to look at, what the numbers mean);
- checks that the feature works while it is filmed, so a broken feature fails the run instead of making a misleading
  video;
- is reproducible: re-running the script after a UI change re-makes the series.

## Scope

**In:** the offline editor on the synthetic and golden cases, which are already on disk (`data/synthetic/`,
`data/golden/`). The episodes:

| # | Episode | Shows |
|---|---|---|
| 01 | Quick start | landing → Try the demo → one-click crown on 36 → review the draft → Accept → Finalize → Export STL |
| 02 | The workspace | step rail, view buttons, rotate / pan / zoom, object list, undo / redo, help sheet, dark theme |
| 03 | Case setup and scans | tooth chart, restoration type and material, importing STL scans, the tooth frame from a click |
| 04 | The margin | find the margin, trace with clicks (live-wire), close, review colours, drag / insert / delete, undo |
| 05 | Insertion axis and parameters | least-undercut axis, undercut map, tilt, cement gap and thickness |
| 06 | Crown, adapt and export | propose, colour maps, move the crown (keys, gizmo, nudge pad), adapt contacts and occlusion, export, project file |
| 07 | A bridge, step by step | 35–[36]–37: abutment frames, pontic, margins, common axis, Propose bridge, connectors, Check bridge, export |
| 08 | Auto-design a bridge | one click per prep; a gate stops a bad draft; Reject, fix, Accept |
| 09 | Implant crowns and bridges | scan bodies, implant position, screw channels |
| 10 | Frameworks | reduced CoCr crown and bridge, cutback, veneer space |
| 11 | Maryland and inlay bridges | the wing outline, the cavity margin, the pre-op scan |
| 12 | Front teeth and Export all | crowns on 11 and 21 on a labially leaning arch, Export all as a zip |
| 13 | The margin algorithm page | `/algorithm/`: reading it and using its figures |

**Out:**
- **The online flows** (accounts, cases, saving, Rx intake, the assistant). They need the API with Postgres; a
  follow-up can add an episode that runs when `:3000` answers.
- Hosting or uploading the videos. They stay in `out/videos/` (gitignored), like screenshots in `out/e2e/`.
- Real scans: synthetic data only (`CLAUDE.md`).

## Design

**Where:** `tools/e2e/video/`, in the existing `@dcad/e2e` package (it already has Playwright and the patterns).
- `director.mjs`: launches the browser, films the page, draws the overlays, narrates and records checks.
- `episodes/NN-<slug>.mjs`: one per video. Each exports `{ id, title, summary, run(d) }`; `run` drives the app through
  the director `d`.
- `run.mjs`: runs the episodes (all, or those named), then writes the gallery and a report.
- `pnpm --filter @dcad/e2e videos [ids…]`.

**Filming:**
- **The GPU, not SwiftShader.** Headless Chrome on the Mac renders the 1M-triangle scans at 60 fps on Metal and at
  4 fps on SwiftShader (measured). The test scripts keep SwiftShader; the videos need the frame rate.
- **Chrome's screencast (CDP `Page.startScreencast`), not Playwright's `recordVideo`.** `recordVideo` needs
  Playwright's own ffmpeg and writes low-bitrate VP8. The screencast's JPEG frames are piped to the system ffmpeg at a
  constant 30 fps (each frame repeated until the next one's timestamp), then encoded as H.264 MP4.
- **The viewport is 1600×900 at a device scale of 1.2,** so the frames are 1920×1080. The app's layout has been
  checked at 900 px high.

**Overlays.** These are injected into the page (`addInitScript`), so they are in the frames. They are
`pointer-events: none`, so they never take a click.
- **A cursor** that follows real mouse events, with a ripple on each press. Headless Chrome draws no cursor.
- **Captions:** the narration as a lower third, over the 3D view.
- **Title and end cards:** the end card counts the checks passed.
- **A keycap badge** for each shortcut pressed.
- **A ring around the element** about to be clicked.
- **A check toast** (✓ or ✗) each time a check runs: the testing is visible.

**Narration:**
- macOS `say` (voice `VOICE`, default Samantha) writes one clip per caption, cached by text in `out/.tts-cache/`.
- The clip's length sets how long the caption stays up and how long the script waits, so the pace follows the
  speech.
- After filming, ffmpeg places each clip at its start time (`adelay`, `amix`) and adds the AAC track.
- `NARRATION=0` leaves the audio out. Without `say` (Linux), the timing comes from the word count.

**Interaction:**
- Clicks, drags and orbits move the cursor along an eased path before acting, so a viewer can follow.
- Scene clicks wait until the surface under the projected point is the target (as `clickWorld` in `bridge.mjs`).
- The episodes reuse the test scripts' flows. Their state checks read the dev-only `window.__dcad` hook, so the
  series runs against `pnpm dev:web`, not a production build.

**Outputs** (`out/videos/`):
- `NN-<slug>.mp4` and `NN-<slug>.vtt` (subtitles);
- `report.json`: per episode, the checks, chapters, duration and any error;
- `index.html`: a gallery to watch the series, with each episode's chapters (click to seek) and its checks.

**Failures:**
- A failed check is shown in the video (✗) and in the report, and the run exits non-zero.
- An episode that throws gets an error card, keeps its video up to that point, and the run goes on to the next
  episode.

## Verification

- Every episode runs to the end with all its checks passing: `pnpm --filter @dcad/e2e videos`.
- `ffprobe` on each MP4 shows 1920×1080 H.264 at 30 fps, an AAC track, and a duration matching the report.
- Stills extracted with ffmpeg at a few chapter times are looked at:
  - the cursor, the caption and the checks are visible;
  - the 3D view is rendered, not black.
- The gallery page opens and seeks to its chapters.
- **No unit tests.** This is tooling around the app (`CLAUDE.md`: tests guard app behaviour); `pnpm test` is
  unchanged.

## Implementation summary

**What was built.** A narrated series of 13 videos (33 min in all), filmed from the real app, that checks the features
it shows: 209 checks, all passing. It lives in `tools/e2e/video/`:

- **[`director.mjs`](../tools/e2e/video/director.mjs):**
  - **Filming:** Chrome's screencast into ffmpeg.
  - **Narration:** `say` clips; each clip's length is read from its AIFF header, and clips are cached in
    `out/.tts-cache/`.
  - **Filmed actions:** clicks, drags, orbits, zooms, keys, typing, selects, scene clicks and downloads.
  - **Also:** the checks, chapters, the title, end and error cards, and the audio mux.
- **[`overlay.mjs`](../tools/e2e/video/overlay.mjs):** the in-page overlay (cursor, captions, keycaps, rings, check
  toasts, cards).
- **[`run.mjs`](../tools/e2e/video/run.mjs):** the runner. It merges `report.json`; `--full` joins the episodes.
- **[`gallery.mjs`](../tools/e2e/video/gallery.mjs):** writes `out/videos/index.html`.
- **[`lib.mjs`](../tools/e2e/video/lib.mjs):** STL checks that use the repo's own `parseStl`, `validateClosedMesh`
  and `meshTopology`.
- **`episodes/01-…13-…`**, and `pnpm --filter @dcad/e2e videos` in
  [`tools/e2e/package.json`](../tools/e2e/package.json), documented in
  [`tools/e2e/README.md`](../tools/e2e/README.md).

| # | Episode | Checks | Video |
|---|---|---|---|
| 01 | Quick start: a crown in one click | 10/10 | 1:58 |
| 02 | The workspace: views, navigation and help | 18/18 | 2:27 |
| 03 | Case setup, scans and the tooth frame | 12/12 | 2:11 |
| 04 | The margin: find it, trace it, fix it | 18/18 | 2:11 |
| 05 | Insertion axis and parameters | 11/11 | 2:16 |
| 06 | The crown: propose, move, adapt, export | 21/21 | 2:55 |
| 07 | A bridge, step by step | 23/23 | 2:55 |
| 08 | Auto-design a bridge | 12/12 | 2:06 |
| 09 | Implant crowns and bridges | 21/21 | 3:48 |
| 10 | Frameworks for veneering | 16/16 | 2:28 |
| 11 | Maryland and inlay bridges | 20/20 | 3:35 |
| 12 | Front teeth and Export all | 12/12 | 2:04 |
| 13 | How the margin is found: the algorithm page | 15/15 | 2:24 |

**How it was made.** Episode 01 and the director came first. Episodes 02–13 were then written in parallel, two per
agent, each agent filming into its own `out/videos-dev/<x>/`. The final series was filmed one episode at a time.

**Deviations from the spec:**
- **07 follows the app's default path, not `bridge.mjs`'s clicks.** By default, frames come with the scans, margins on
  entering Margin, and the axis on entering its step. So 07 reviews each of those steps, then shows Align to arch, a
  ridge click, a nudge, a connector edit, Check bridge and the export.
- **08 sets the oversize connector in the UI**, on a first accepted bridge. `ai-bridge.mjs` sets it with a command
  instead, because the area field only exists once a bridge has been proposed.
- **12 leaves out the 35–[36]–37 bridge**, which 07 and 08 cover, and proposes the crowns by hand:
  - auto-design on the leaning 11 stops, rightly, at the Adapt gate, because the synthetic lower arch is out of reach;
  - Export all goes through the open-checks confirmation, and the manifest lists those checks.
- **13 opens `algorithm/index.html`.** The Vite dev server serves the landing page at `/algorithm/`, the dev twin of
  the Caddy bug fixed above.
- **Director changes that came out of filming:**
  - **`say(…, { wait: false })` waited for the speech anyway.** An async function that returns a promise adopts it.
    Without the fix, an action never overlapped its narration, and episode 03 ran 5.5 min.
  - **`blur()` no longer clicks:** a click in the 3D view could be a scene pick.
  - **`point()` returns at once** when its target is not on the page.
  - **`type()` selects all and types over**, so a number field never shows "01.2".
  - **`reveal()` scrolls only elements that are off screen**, so a sticky element no longer scrolls the page.
  - **After every page load**, the caption still being said and the cursor are put back.
  - **Clip lengths come from the AIFF header**, not from an `ffprobe` per caption. Under load, that call took 10–29 s.
  - **Smaller fixes:** the check toasts sit above the caption line, the card title is not an `<h1>` (it collided with
    episodes' locators), and there is a 0.65 s breath between lines.

**Verification:**
- **`pnpm --filter @dcad/e2e videos -- --full`, sequential, on an idle M3 Max:** 13/13 episodes ok, 209/209 checks,
  exit 0.
  - Filming time is the video length plus about 2 s per episode, for example 118 s of video in 120 s.
  - Every MP4 is 1920×1080 H.264 at 30 fps with AAC narration.
  - The joined `dcad-walkthrough-full.mp4` runs 2003 s (33:22), the sum of the episodes.
- **Stills** were checked at three chapters of every episode: the cursor, captions, rings and toasts are visible, and
  the 3D views are rendered and framed on what is said.
- **The gallery** was checked at 1400 px (light) and 390 px (dark): no horizontal scroll, and the video loads.
- **The seven episodes edited after that run** (helpers swapped for `d.blur()` and `d.type`) were refilmed: 7/7 ok,
  all their checks passing. The series as committed: 13/13 episodes, 209/209 checks.
- **No unit tests changed.** The series is tooling (`CLAUDE.md`). `pnpm typecheck` passes.
- **`pnpm test` is green:** 129 tests, of which 117 pass and 12 are skipped (the API's, without `TEST_INFRA`).
  - On this machine the margin refiner and prep finder suites had been timing out in `beforeAll`. Each builds its
    synthetic case there, which took over Vitest's 10 s default when the files ran in parallel. Each passes alone in
    6 s.
  - `apps/web/vitest.config.ts` now gives hooks the 60 s that tests already had.

**Follow-ups:**
- **Load:** film one episode at a time. With six filming at once (load average about 200), the compute waits
  stretched videos up to 2×.
- **An online episode** (accounts, cases, saving, Rx intake, the assistant), once the API and Postgres run locally.
- **App findings from filming:**
  - The margin's confidence colours are not redrawn when the doubt levels arrive: `drawOverlays` in
    `apps/web/src/tools/controller.ts` remembers its inputs, but not `marginDoubt`.
  - `N` on a mesial or distal doubtful part flies to a view where the neighbouring tooth hides the line.
  - The automatic frame of 37 on `lower-bridge.stl` comes out turned 85° from the arch; Align to arch fixes it.
  - In Case setup, clicking the only tooth chosen does not remove it.
  - Vite dev serves the landing page at `/algorithm/`.
