# The margin on natural teeth: the gum line, a doubt warning, and faster correction

Status: **done** (2026-10-27).

## Goal

From the research (`2026-10-27-natural-margin-research.md`), the user said "Yes please do this":
- **Build** the winning crease-weighted random walker into the app as the margin finder for natural (unprepared)
  teeth.
- **Click fix:** make it robust to where the user clicks.
- **Doubt warning:** flag a doubtful line.
- **Two correction tools:**
  - a live-wire that follows the gum crease;
  - a two-click section redraw.

On a natural tooth the margin is the **gum line**, a concave crease, where the tooth meets the gum. Today's
automatic margin looks for a prep's convex **finish line**, so it is 1–2 mm off on natural teeth. It still "passes"
its own checks on 19 of 47 real natural teeth.

## Scope

**In:**
1. **The engine.** `apps/web/src/geometry/naturalMargin.ts`, a port of the research's S2:
   - a crease-weighted harmonic field on a patch round the tooth;
   - the u = 0.5 line, snapped to the gum-side vertex;
   - the watershed of the same relief as a second opinion.
   - It runs in the geometry worker.
2. **Click robustness.** The research's S1 inside probe re-centres the axis before the solve: rays from inside the
   crown, walking down the axis, re-centred on the midpoints of opposite wall hits. Then one re-centring pass on the
   solved region.
3. **The doubt warning.** A gate in `ai/qa.ts`. The line is doubtful unless all of these hold:
   - it is one closed loop round the tooth;
   - its length is plausible for the tooth (against the tooth template's cervical perimeter);
   - the re-centring moved the axis only a little;
   - the walker and the watershed agree.

   It shows in the auto-design review and in the Margin step. Thresholds are set on the development set and checked
   once on the held-out set.
4. **Which line, finish or gum.** The margin records which line it follows (`MarginLine.line`: `finish` or `gum`;
   omitted means finish, as before).
   - **The Margin step** has a choice, "finish line (prepared tooth)" or "gum line (natural tooth)". It sets the
     live-wire for drawing and editing, and the line auto-design looks for.
   - **Auto-design's margin, with no choice made:**
     - it keeps today's finish line when the refiner's line passes and does not sit clearly above the gum line;
     - otherwise it uses the gum line.
     - The research found that neither the refiner's own pass (19 of 47 real natural teeth pass, 1–2 mm off) nor the
       prep finder (10 false preps on 12 natural real jaws) can decide alone.
     - The rule is calibrated on synthetic preps against real natural teeth.
5. **Correction tool 1: a live-wire for the gum line.** `liveWireWeight(curvature, 'gum')` makes concave edges cheap
   (today's weight makes them up to 3× dearer).
   - Drawing, dragging and smoothing a gum-line margin use it.
   - The worker keeps one weight per line kind.
6. **Correction tool 2: redraw a section.**
   - In the Margin step, "Redraw a section", then two clicks.
   - The live-wire path between the clicks replaces the part of the line it is closest to, and the rest is kept.
   - It works for both line kinds.

**Out:**
- The doubt heat map and fly-to.
- Anchor insert and delete.
- Scribble seeds.
- A colour term.
- Learned models.
- Eggshell provisionals as a restoration type.
- Validation on in-house scans (blocked on de-identified data).

## Design

**Engine** (`geometry/naturalMargin.ts`, pure TS):
- **Input:** positions, BVH-ordered indices, the 1-ring graph, curvature, a `RayCaster`, the tooth frame, the FDI
  number and the click.
- **Steps:**
  1. Probe centre.
  2. Patch: a connected flood from the click inside a cylinder round the axis.
  3. Curvature smoothed twice.
  4. Conductance `exp(−8·concavity/κ_ref) / length`.
  5. Seeds: the crown top (u = 1) and the patch rim (u = 0).
  6. Watershed, which is also the CG start.
  7. Jacobi-preconditioned CG.
  8. One re-centring pass.
  9. Isolines of the walker and the watershed.
- **Output:**
  - the line (closed, on the scan) and its length;
  - the loop count and winding;
  - the probe and re-centring shifts;
  - the walker/watershed mean distance;
  - the length over the template's cervical perimeter;
  - ms.

**Worker** (`geometry.worker.ts`):
- `naturalMargin(request)` returns the line plus the measures and anchors: about 24, spaced along the line, for
  editing.
- `traceMargin`, `liveWireTree` and `smoothMargin` take the line kind, with one cached weight per scan and kind.

**Margin proposer** (`ai/proposers.ts`, `classical.margin-ridge@1`):
- runs the refiner as today;
- for a natural-tooth choice, or when the decision rule says so, runs `naturalMargin`;
- proposes `setMargin` with `line: 'gum'`, gated by `naturalMarginGate`;
- its rationale says which line it followed and why.

**Margin step** (`ui/steps/MarginStep.tsx`, `tools/marginTool.ts`):
- the line choice;
- "Redraw a section", a two-click mode with a live-wire preview between the clicks, Esc to cancel;
- the doubt warning for a gum-line margin.

**Shared schema:** `MarginLine.line?: 'finish' | 'gum'`, optional, so saved documents stay valid.

## Verification plan

- **Benchmark** (`tools/pipeline-runner/src/natural`, method `natural` calling the shipped engine):
  - synthetic, dev real (23), click jitter of ±1.5 mm on dev real, and held-out (24, run once at the end);
  - the gate's catch rate and false alarms on the same cases;
  - the line-kind rule on synthetic preps (`marginEval` cases) and on real natural teeth.
- **Tests:** +2 in `geometry/naturalMargin.test.ts`, on a synthetic natural tooth with gum and papillae.
  1. The engine finds the labelled gum line and the gate passes it; a click on a missing tooth's ridge is flagged
     (the gate's failing case).
  2. A gum-line margin with a section dragged off is fixed by a two-click redraw with the gum live-wire, and the
     finish-line weight would not fix it.
- **Checks:** `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.
- **Browser:**
  - one-click on a natural tooth in the demo gives a gum-line margin;
  - the redraw-a-section flow works;
  - `first-run`, `crown-move`, `ai-bridge` and `bridge` still pass.

## Implementation summary

**What was built, and where.**
- **The engine.** `apps/web/src/geometry/naturalMargin.ts`:
  - S1's inside probe;
  - the crease-weighted walker (β 8) and its watershed;
  - one re-centring pass;
  - the 0.5 level line through the edge crossings, smoothed 0.4 mm back onto the scan;
  - measures: loops, winding, probe and re-centring shifts, walker/watershed agreement, length over the tooth's
    nominal ellipse;
  - `anchorsAlong` for editing anchors.
- **Doubt warning.** `ai/qa.ts` `gumLineGate`:
  - length 8–60 mm and closure;
  - **`margin.agree`**: walker and watershed within 0.3 mm;
  - **`margin.round`**: at least 0.8× the nominal ellipse.

  The 120° kink rule is left out for gum lines: they turn sharply at the papillae.
- **Schema.** `MarginLine.line` (`finish` or `gum`, optional) in `packages/shared/src/design.ts`.
- **Live-wire.** `liveWireWeight(curvature, κ0, 'gum')` flips the curvature's sign (`geometry/livewire.ts`). The
  worker caches one weight per line kind. `liveWireTree` and `traceMargin` take the kind. A new worker call,
  `naturalMargin`, returns the line plus its measures and anchors.
- **Margin proposer.** `ai/proposers.ts`, `classical.margin-ridge@1`:
  - the chosen line, else the tooth's gum line if it has one, else the rule;
  - its rationale says which line was followed and why;
  - its doubt checks are kept for the Margin step (`toolStore.gumLineChecks`).
- **Margin step** (`ui/steps/MarginStep.tsx`, `tools/marginTool.ts`, `tools/marginLine.ts`):
  - the Finish line / Gum line choice;
  - **Find** (the proposer, as a plain edit);
  - **Redraw a section** (two clicks; the splice is `geometry/marginEdit.ts` `redrawSection`);
  - the gum-line doubt warning (`GumLineDoubt` in `ui/steps/MarginIssues.tsx`).
  - Gum lines are held to their length, not the kink rule.
- **Benchmark.** `tools/pipeline-runner/src/natural/methods/natural.ts` runs the shipped engine; `--jitter <mm>`
  repeats each case with the click moved. Two analysis scripts behind the decisions:
  - `prepFinderOnNatural.ts`;
  - `finishVsGum.ts`.

**Deviations from the spec.**
- **No neighbour seeds.** On development real teeth they made no difference (22/23 either way). With the click moved
  1.5 mm they cost 81 → 73 of 92 correct.
- **The line through the edge crossings, smoothed,** instead of the research's gum-side vertex snap. The snap makes
  a staircase about twice the true length. Unsnapped and smoothed was best overall: 52 of 55 usable against 47.
- **Length check: 0.8× the nominal ellipse,** not 1.15. Correct real gum lines run 1.2–2.4× (scalloped round the
  papillae), but smooth synthetic teeth are about 1.0, so 1.15 flagged every demo tooth. It now only catches a line
  that collapses onto the crown.
- **Which line, with no choice made.** The planned calibration found no geometric rule:
  - on 17 synthetic preps the walker follows the gum line 1.2–1.6 mm below the finish line;
  - the finish-to-gum height gap is 1.44–1.63 mm on preps, but −1.05 to +2.10 mm on real natural teeth;
  - the prep finder reports 10 false preps on 12 all-natural real jaws.

  So the rule is: the finish line when it passes, or when a prep is seen within 3 mm of the tooth; otherwise the gum
  line. The user's choice, or an existing gum line, overrides it. On a natural tooth where the finish line wrongly
  passes (19 of 47 real teeth), the user must choose Gum line.
- **The doubt gate's checks** (named `gumLineGate`, not `naturalMarginGate`):
  - agreement and gross length only;
  - the planned "one loop round the tooth" (winding) and "re-centring moved little" checks are measured but not
    gated: winding is 0 on correct leaning incisors, and the re-centring shift did not separate right from wrong lines
    on the development set.
- **`smoothMargin`** takes no line kind: it does not use the live-wire weight.
- **"Find" in the Margin step** was added. There was no way to run the automatic margin outside auto-design.
- **A small fix on the way:** duplicate React keys in the margin warning (two kinks on one side read the same).

**Verification.**
- **Checks:** `pnpm typecheck` clean. `pnpm test`: 120 tests (108 pass, 12 skipped), up 2 from 118.
- **The two new tests** (`geometry/naturalMargin.test.ts`):
  - **Detection:** the gum line of a natural 36 is found within 0.15 mm mean and passes the gate, and a click on
    missing 46's ridge is flagged.
  - **Correction:** a section pushed 1.2 mm up the tooth is put back within 0.15 mm by a two-click redraw with the
    gum live-wire, and the finish-line live-wire deviates more there.
- **Benchmark** (Node; real cases at the labels' resolution, correct = mean ≤ 0.25 mm, p95 ≤ 0.6, coverage ≥ 85%):

  | Set | Correct | Usable | Median mm | ms per tooth |
  |---|---|---|---|---|
  | Dev real (23) | 22 | 22 | 0.11 | 79–87 |
  | Dev real, click ±1.5 mm (92) | 81 | 83 | 0.11 | 99 |
  | **Held-out real (24), once, frozen** | **22** | **23** | **0.11** | 97 |
  | **Held-out real, click ±1.5 mm (96)** | **83** | **86** | **0.11** | 95 |
  | Synthetic (32): gum and gum+colour (16) | 16 | 16 | 0.08 | ~450 |
  | Synthetic: hard (8), bare (8, like the demo) | 0, 0 | 8, 6 | 0.17, 0.24 | ~700 |

  The research walker without the probe fell to 39% with the click moved 1.5 mm, and to 68% with re-centring alone.
  With the probe it keeps 86–88%.
- **The doubt warning:**

  | Set | Wrong lines caught | Right lines flagged |
  |---|---|---|
  | Development (115 real cases) | 7 of 12 | 6 of 103 |
  | Held-out (120 cases) | **only 3 of 15** | 8 of 105 |

  Ten of the 15 held-out misses are two molars of one patient, next to gaps where teeth are missing. They are near
  misses (0.17–0.27 mm mean, a stretch of the line off) on which both methods agree, so the agreement can't see them.
- **Browser** (scripted Chrome against the dev server, the demo):
  - one-click on the prepped 36 still gives the finish line and passes;
  - on natural 11 it gives a gum line (`line: gum`, 39.4 mm) with the fallback rationale, and stops at the margin on
    `margin.agree` (3.3 mm: the demo's sharp-creased synthetic teeth, where the line is only "usable");
  - the Margin step shows Gum line, Find and the doubt warning;
  - Redraw a section replaced a section (764 → 587 points, 16 → 12 anchors, still a gum line, source manual);
  - Find the gum line re-found it;
  - choosing Finish line and Find gave a finish line;
  - no page errors.
- **Browser scripts** against the dev server:
  - `first-run`, `ai-bridge` and `bridge` pass.
  - `crown-move` fails its "no legend after undoing the draft" check (30 of 31 alone). Clean `main` (77af73d) fails it
    the same way, plus the gizmo-drag checks, so it is not from this change. Logged as a follow-up.

**Follow-ups.**
- **`crown-move`:** the colour legend stays after undoing an auto-design draft (on main too).
- **A better doubt signal.** Held-out shows the agreement check generalises poorly. A per-sector signal (field
  contrast across the line, distance to a missing neighbour's gap) needs more real data to calibrate.
- **Validate on de-identified in-house scans** (the ~100 cases in `plan.md`), then on several scanners and
  quadrant scans.
- **A more realistic demo jaw** (gum over the tooth bases): the demo's bare synthetic teeth give gum lines that are
  only usable, and flag as doubtful.
- **From the research, not built:** the doubt heat map and fly-to, anchor insert and delete, scribble seeds on the
  same solver, a colour term for coloured scans.
