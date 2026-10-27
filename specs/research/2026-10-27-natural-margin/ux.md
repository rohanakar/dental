# UX: confirming or correcting a natural-tooth margin in seconds

UX researcher, 2026-10-27. Branch `worktree-agent-abbd2917ad09a62f2` (worktree commit, not on main). Simulator:
`tools/pipeline-runner/src/natural/ux/simulate.ts`. Raw results, in the shared
`/Users/rishabhchaudhary/experiments/out/natural-margin-research/`:
- `ux-sim.md` and `ux-sim.json`: 24 cases, 0.1 mm click error;
- `ux-sim-sigma0.2.md`: gum and hard, 0.2 mm click error.

Benchmark as of main `5a4ad5b` (truth at the foot of the tooth wall). Competitor UX comes from `scout.md`, section 4.

## TL;DR

1. **The biggest lever is one sign.** Today's live-wire (`liveWireWeight` in `apps/web/src/geometry/livewire.ts`)
   makes convex ridges cheap and concave creases up to 3× dearer. That suits a prep's finish line. On a natural
   tooth it pushes the line *off* the tooth/gum crease. Flip the sign for natural teeth (concave cheap) and:
   - a whole-margin redraw with **4 clicks is correct on 16/24 cases, against 0/24 today**;
   - with 16 clicks, 21/24 against 3/24.
2. **Redraw a sector with two clicks** and let the concave live-wire splice in between, keeping the rest of the line.
   On the 106 start lines that needed fixing, this fixed **89/106 in a median 20.5 s**. Today's anchor drag fixed
   **49/106 in 26 s**.
3. **The recommended v1 flow** combines a doubt heat map, a fly-to key, the 2-click sector redraw, and a 6-click
   whole redraw when the line is off all the way round. It fixed **93/106 in a median 13 s and 4 actions**:
   - 21/24 of today's refiner outputs in 18 s;
   - with 0.2 mm click error, 60/60.
   - A line that needs nothing costs 2.5 s to confirm.
4. The prototypes of Tab alternatives (26–33 %), the crease-snapping brush and one-key snap-all lost to the
   live-wire. As built (a 30-minute version each), they snap to the wrong crease near embrasures. Defer them.

## 1. Today's flow and its cost

What the code does now:
- **Margin step.** The camera flies to the margin view (`tools/marginView.ts`). It looks along the prep axis or the
  frame's occlusal direction. On a natural tooth that view puts the cervical line under the height of contour, so
  the technician has to orbit.
- **The line.** The automatic margin comes from the refiner (`ai/proposers.ts` → worker `autoMargin` →
  `geometry/marginRefine.ts`). It carries **16–48 anchors**, drawn as 11 px red markers (`tools/controller.ts`).
- **Fixing a wrong sector** (`tools/marginTool.ts`):
  1. Orbit or zoom until the sector is visible: about 3 s.
  2. Grab the anchor nearest the error (within 10 px) and drag it onto the true line: about 4 s.
     - On release, `commit()` re-traces the **whole loop** through every anchor with the convex live-wire.
     - On a natural tooth, that pulls the segments either side back toward the convex height of contour.
  3. Repeat for every wrong anchor in the sector. A 6 mm sector holds 3–8 anchors.
  4. **No anchor insert or delete, and no partial redraw.**
     - If the error lies between two correct anchors, no drag fixes it.
     - The only fallback is to click on the tooth and draw a new loop (N clicks, then Enter). That replaces the whole
       margin ("Redrawing: the current margin is replaced when the new loop is closed").
  5. **Smooth** (3 Laplacian passes) only helps jitter.
  6. **The margin check** (`tools/marginCheck.ts`, `ui/steps/MarginIssues.tsx`) flags kinks and length. Nothing says
     *where the line is doubtful*.
- **Keys:** Backspace, Enter and Esc work only while drafting. Undo is the global command history.

**Measured cost of today's tools** (simulated; details in §2):

| Today's tool | Lines needing a fix | Fixed (correct) | Median s | Median actions | Notes |
|---|---|---|---|---|---|
| Drag anchors (convex live-wire) | 106 | 49 | 26 | 4 | Plateaus when the error lies between anchors. |
| Drag anchors, on today's refiner output | 24 | **0** | 70 (gave up at 14 drags) | 14 | Ends at a mean of 1.18 mm. The refiner is 2.2 mm off. |
| Full redraw, N clicks (convex live-wire) | 24 | 0 / 0 / 1 / 1 / 3 for N = 4, 6, 8, 12, 16 | 13–27 | N + 1 | Median mean 1.32 mm down to 0.32 mm. |
| Smooth (global) | 106 | 9 | 10 | 3 | Fixes only jitter (7/10 jitter lines). |

So today a technician **cannot reliably reach "correct" on a natural tooth** with the live-wire tools. The way out is
free clicking at well over 16 points, which I estimate at 45–60 s or more, and it was not simulated.

## 2. Simulation method

**Cases:** 24 benchmark cases:
- teeth 36, 45, 33, 31, 16, 14, 13 and 11;
- variants `bare`, `gum` and `hard`. `gum+colour` has the same geometry as `gum`, so it was skipped.

**Start lines.** Each case gets six start lines (seeded and deterministic):

| Start | What it is |
|---|---|
| push1 | One sector (5–8 mm of arc) pushed 0.5–1.5 mm along the surface profile onto the tooth or the gum (raised-cosine bump). |
| push2 | Two opposite sectors, one pushed to the tooth and one to the gum. |
| jitter | σ 0.25 mm per-point profile offsets. |
| shortcut | A chord across the mesial or distal embrasure (±3 mm of arc), projected onto the surface. |
| mixed | One push, plus a ±2.5 mm shortcut, plus σ 0.1 mm jitter. |
| refine | Today's refiner output (`refineMargin`) with its own anchors. Median 2.2 mm off. |

The injected lines carry an anchor every 2 mm, as an auto margin would. 38 of the 144 start lines already met
"correct" (mostly the jitter and shortcut lines). The tables below count only the **106 that needed fixing**.

**The technician's eyes come from the labels.**
- A line point looks wrong beyond **0.2 mm**.
- Bad points are grouped into sectors, closing gaps under 1 mm, and the worst sector is fixed first.
- A click lands on the nearest true margin point, plus **0.1 mm Gaussian aim error** (0.2 mm in the sensitivity run).
- The technician stops at "correct" (mean ≤ 0.15 mm, p95 ≤ 0.4 mm, coverage ≥ 0.9). They also stop at 14 operations,
  or when nothing they try helps:
  - an operation that doesn't improve the line is undone (+1.5 s);
  - a sector is given up after 2 failed retries.

**Tools use the mesh only.** None of them reads the labels.
- **Drag:** move the worst anchor of the sector to the click, then live-wire to its two neighbours and splice.
  - *Today:* convex weight, no insert.
  - *Proposed:* concave weight (`liveWireWeight(−κ)`), plus inserting an anchor on the line when no anchor is wrong.
- **Redraw sector:** clicks at the sector's ends, 1 mm beyond the bad run, then a live-wire between them, spliced in.
  - Each retry adds clicks every 3, 2, 1.5 and then 1 mm.
  - Measured with the convex and with the concave weight.
- **Tab alternatives:**
  - Scan offsets of ±2.4 mm across the sector along the surface profile.
  - Rank the local minima of the *profile's own* curvature (a second difference over ±0.15 mm), each pulled toward
    the current line.
  - Refine each candidate per point (±0.3 mm), median-filter it, then cycle with Tab.
  - The technician accepts the first that looks right, or cycles back to the best one.
- **Brush:** a stroke from the line to the click moves the line within 2.5 mm, snapping to the strongest crease within
  ±0.35 mm of the dragged offset.
- **Smooth:** the app's Smooth (`smoothClosedPolyline`, 3 passes, re-projected).
- **Snap-all:** one key. Every point moves to the strongest crease within ±1.5 mm, then an 11-point median.
- **v1 flow (Tab first):** Tab, then the brush, then the concave redraw.
- **v1b flow (recommended):** heat map and fly-to camera costs.
  - A line that is off all the way round is redrawn whole with 6 clicks (8 on a retry), concave weight.
  - Otherwise each bad sector is redrawn with 2 clicks (more on a retry), concave weight.

**Time model.** These are assumptions, not measurements: the keystroke-level model (P 1.1 s, B 0.1 s, K 0.25 s,
M 1.35 s) plus camera costs I picked.

| Operation | Seconds |
|---|---|
| Overview: look round the line once | 4 |
| Overview with a heat map | 1.5 |
| Orient to a new sector | 3 |
| Fly-to key | 0.5 |
| Anchor drag | 4 |
| Anchor insert | +0.6 |
| Surface click | 1.2 |
| Redraw overhead (M + judge) | 2.35 |
| Tab press | 0.75 |
| Tab overhead | 1.85 |
| Brush stroke | 3 |
| Smooth | 1.7 |
| Snap-all | 1.2 |
| Undo | 1.5 |
| Accept | 1 |

A whole redraw adds 2 orbits (6 s).

## 3. Results

### All 106 start lines that needed fixing (0.1 mm click error)

| Tool | Fixed | Median s | Median actions | Median end mean mm |
|---|---|---|---|---|
| Drag anchors, convex live-wire (**today**) | 49/106 | 26.0 | 4 | 0.11 |
| Drag + insert, concave live-wire | 70/106 | 23.0 | 3 | 0.09 |
| Redraw sector, convex live-wire | 63/106 | 61.1 | 28 | 0.11 |
| **Redraw sector, concave live-wire** | **89/106** | **20.5** | **4** | **0.06** |
| Tab alternatives (prototype) | 33/106 | 25.5 | 16 | 0.13 |
| Brush with crease snap (prototype) | 26/106 | 36.5 | 10 | 0.16 |
| Smooth (global) | 9/106 | 9.9 | 3 | 0.17 |
| Snap-all, one key (prototype) | 24/106 | 7.7 | 2 | 0.16 |
| v1 flow: heat map + fly-to + Tab/brush/redraw | 68/106 | 33.6 | 19 | 0.09 |
| **v1b: heat map + fly-to + redraw (whole: 6 clicks, sector: 2)** | **93/106** | **13.0** | **4** | **0.06** |

### By start line (fixed / needing a fix, median s)

| Start (needing fix) | Today: drag | Drag + insert, concave | Redraw sector, concave | Tab | Brush | v1b |
|---|---|---|---|---|---|---|
| push1 (18) | 10, 21.5 s | 15, 16 s | 15, 12.8 s | 6, 15.9 s | 4, 29 s | **15, 7.8 s** |
| push2 (24) | 11, 30 s | 22, 23 s | 22, 20.5 s | 7, 34.6 s | 5, 50 s | **22, 13 s** |
| jitter (10) | 8, 31.5 s | 8, 16 s | 9, 20.5 s | 7, 27 s | 5, 72.5 s | 9, 13 s (Smooth: 7, 6.7 s) |
| shortcut (8) | 4, 24.5 s | 4, 24.5 s | 5, 30.4 s | 2, 10.6 s | 2, 23 s | 5, 22.9 s |
| mixed (22) | 16, 16 s | 21, 16 s | 21, 12.8 s | 11, 18.1 s | 10, 32 s | **21, 7.8 s** |
| refine (24) | **0**, 70 s | 0, 71.5 s | 17, 56 s | 0, 136 s | 0, 33.5 s | **21, 18 s** |

**Whole redraw of today's refiner cases with N clicks** (closed live-wire loop, clicks evenly round the true line):

| N clicks | Convex (today): correct | Convex: median mean mm | Concave: correct | Concave: median mean mm | Est. s |
|---|---|---|---|---|---|
| 4 | 0/24 | 1.32 | **16/24** | 0.08 | 12.7 |
| 6 | 0/24 | 0.79 | 18/24 | 0.07 | 15.1 |
| 8 | 1/24 | 0.53 | 19/24 | 0.08 | 17.5 |
| 12 | 1/24 | 0.44 | 19/24 | 0.07 | 22.3 |
| 16 | 3/24 | 0.32 | 21/24 | 0.07 | 27.1 |

**By variant (v1b):**
- `gum`: 48/48 lines end correct, median 7.8 s.
- `hard`: 48/48, median 7.8 s.
- `bare`: 35/48, median 18 s. All 13 bare misses are on 33, 14 and 13: mean 0.06–0.09 mm and coverage 100 %, but
  p95 0.40–0.53 mm, so they are near misses on p95 only. The bare variant has no gum cover, so the live-wire probably
  takes the gum band's own crease for a short stretch. I did not investigate.

**Click aim error 0.2 mm** (gum and hard, 60 lines needing a fix): v1b fixed **60/60** in a median 13 s. The concave
redraw fixed 54/60 and today's drag 24/60. The concave live-wire supplies the precision, so clicks only need to land
near the line.

**Confidence heat map.** This is a mesh-only detector. A point is doubtful when it is not on a concave profile crease
(κ > −0.15), or a stronger crease lies more than 0.25 mm across the line within ±1.5 mm. Scored against true error
> 0.3 mm:

| Start | Recall | Precision | Share of the line flagged |
|---|---|---|---|
| push1 | 83 % | 36 % | 33 % |
| push2 | 81 % | 54 % | 45 % |
| mixed | 85 % | 32 % | 44 % |
| refine | 91 % | 97 % | 91 % |
| jitter | 84 % | 15 % | 64 % |
| shortcut | 52 % | 10 % | 23 % |

It finds most pushed sectors but flags 2–3× too much. It is weak on embrasure shortcuts, because the embrasure itself
is a broad concave valley. Good enough to *order* fly-to stops, not to skip review. The heat map's time savings in v1b
are assumed: 4 → 1.5 s overview, and 3 → 0.5 s per sector. They are not measured.

## 4. Ranked UX proposals (time saved per day of effort)

"Sim" says whether this simulation supports the idea.

| # | Change | What it is and why it is fast | Effort | Sim |
|---|---|---|---|---|
| 1 | **Natural-tooth live-wire weight** | Concave is cheap when the tooth is natural (unprepared): `liveWireWeight(−κ)`, selected per tooth in the worker's `weightOf`. Every click-based tool then snaps to the gingival crease instead of avoiding it. | 0.5 d | **Strong**: whole redraw 0/24 → 16/24 at 4 clicks; sector redraw 63 → 89/106 and 61 → 20.5 s. |
| 2 | **Two-click sector redraw** | With a margin present, clicking near the line starts a sector edit. A second click ends it, and the live-wire splices in between while the rest of the line stays. Enter or the second click commits; Esc cancels. It is one `setMargin` command, so one undo. Nothing like it exists today. | 1–1.5 d | **Strong**: with 1, v1b 93/106 in 13 s against today's 49/106 in 26 s. |
| 3 | **Insert or delete an anchor on the line** | Click the line to insert an anchor, and right-click or Backspace on an anchor to delete it, as in Medit and Dentbird. Local re-trace of the two neighbouring segments only, instead of the whole loop. | 0.5 d | Yes: drag + insert with the concave weight goes 49 → 70/106 and 26 → 23 s. It is a fallback to 2. |
| 4 | **"Off all round": redraw whole with about 6 clicks** | When most of the line is doubtful (a bad auto margin), say so and invite a 6-click loop. The code exists (click on the tooth); it needs 1 and a hint. | 0.25 d | **Strong**: refiner output 21/24 in 18 s, against 0/24 by dragging. |
| 5 | **Doubt heat map + fly-to key** | Colour the line by mesh-only doubt (profile-crease test). N or Shift+N flies the camera to the next doubtful sector, framed obliquely so the cervical area shows. | 1.5–2 d | Partial: the detector has 81–91 % recall but 32–54 % precision; the time saving (about 5 s of v1b's 13 s) is assumed. |
| 6 | **One-key accept and a keyboard flow** | Enter accepts, N goes to the next doubtful sector, Esc cancels a sector edit, Ctrl+Z undoes a sector. A line that is right costs 2.5 s instead of 5 s. | 0.5 d | Assumed (time model only). |
| 7 | **Margin view for natural teeth** | An oblique buccal and lingual view (or exocad-style PageUp/PageDown orbit round the margin), because the occlusal view hides the cervical line under the height of contour. | 1 d | Not simulated; it removes the 2 orbits (6 s) assumed for a whole redraw. |
| 8 | **Cross-section bubble under the cursor** (exocad) | A 2D profile at the pointer with the line's position and the crease marked. The human sees 0.1 mm decisions; the 3D view alone hides them. | 2–3 d | Not simulated (the simulated eyes are perfect). Supported by competitor practice. |
| 9 | **Colour on/off** (3Shape) | Toggle vertex colour where the PLY has it, since tooth and gum colour is a strong human cue. | 0.25 d | Not simulated. |
| 10 | Smooth | Keep the existing button. It is the fastest fix for jitter only (7/10 in 6.7 s, 1 press) and useless on sector errors. A slider adds little. | 0 | Yes, narrow. |
| 11 | Per-sector alternatives on Tab | As prototyped, 33/106 with 16 actions, because the ranking picks embrasure valleys and other creases. Worth retrying later on top of the margin algorithm's own k-best candidates (a DP's 2nd and 3rd paths), not an offset scan. | 2–3 d | **No** (as built). |
| 12 | Push/pull brush with crease snap, and one-key snap-all | 26/106 and 24/106. They snap to the nearest strong crease, which is often the wrong one. Snap-all on the refiner output: 0/24. | 2 d | **No** (as built). |
| 13 | Global +/- offset (exocad, Medit, Dentbird) | Natural-tooth errors are sectoral, not uniform, so it is low value here. | 0.25 d | Not simulated. |

## 5. Recommended "v1 in a week"

1. **Day 1.** A natural-tooth live-wire weight (concave cheap) in `livewire.ts` and the worker's `weightOf`, chosen
   from the tooth's setup (natural or unprepared). Extend the existing live-wire test: on a natural synthetic tooth, a
   4-click loop lands on the crease.
2. **Days 2–3.** Sector redraw in `marginTool.ts`: click near the line, click again, and the live-wire splices in as
   one `setMargin` command. Add anchor insert (click on the line) and delete (Backspace on a hovered anchor), each
   re-tracing only the neighbouring segments.
3. **Day 4.** Colour the line by doubt, using the mesh-only profile-crease test from `simulate.ts` `doubt()`, moved to
   `geometry/`. Add N / Shift+N to fly to the next doubtful sector, Enter to accept, and a "most of the line is
   doubtful: click 6 points round the tooth" hint.
4. **Day 5.** The oblique natural-tooth margin view (or margin orbit keys), polish, and a rerun of `simulate.ts`
   against the shipped code paths.

**The flow it gives:**
1. Enter the step; the auto margin is drawn and coloured by doubt.
2. N flies to the first doubtful sector.
3. If it is wrong, two clicks redraw it. Repeat N.
4. Enter accepts.
5. If the whole line is wrong, 6 clicks round the tooth, then Enter.

**Expected, by the simulation:**
- about 13 s median and 4 actions for a line with one or two bad sectors;
- about 18 s for a line that is off all the way round;
- 2.5 s to confirm a good line.

Today it is 26 s with less than half of the lines fixed, and the refiner output cannot be fixed at all.

## 6. Assumptions and limits

- **Synthetic crease.** On the benchmark the tooth/gum crease is clean and is the strongest concave feature nearby,
  so a concave live-wire follows it well. Real scans differ:
  - inflamed or bleeding gum, plaque, scan holes and subgingival stretches have no visible crease;
  - other concave features (fissures, embrasure valleys, the mucogingival fold) can capture the live-wire.
  Expect more clicks per sector on real scans. A Teeth3DS check (evaluation only) is the next step.
- **Perfect eyes.** The technician always sees where the true line is, and sees any error over 0.2 mm. Real
  hesitation, mis-judgement and the view problem (the cervical line hidden from the occlusal view) are only partly
  covered by the time model.
- **Time model.** The times are keystroke-level-model estimates with camera costs I picked, not user-study
  measurements. Compare tools against each other (the ratios hold better than the absolute seconds).
- **Error injection.**
  - Gum-side pushes on `hard` came out smaller than asked, because profile marching on noisy, flat gum loses about
    half the offset.
  - 38 of the 144 start lines already met "correct", so only the 106 that needed fixing are compared.
- **Prototypes.** Tab, the brush and snap-all are about 30-minute prototypes. Their failure shows that naive "snap to
  the nearest concave crease" is fragile next to embrasures. It does not refute the UX idea.
- **Coverage.** `gum+colour` was not run (same geometry as `gum`), and colour cues are not modelled.
