# Prep finder: ring the prep on any scan

Status: **done** (2026-10-26).

## Goal

Follow-up "Wrong-tooth help for real scans" of [2026-10-26-new-user-journey.md](2026-10-26-new-user-journey.md).

On the Tooth frame step the user clicks the top of the prepared tooth. With one-click armed, auto-design then runs.
Only the demo knows where its prep is: `apps/web/src/tools/demoPrep.ts` rings it, and `tools/frameTool.ts` refuses a
click more than 5.5 mm away. On a real or imported scan the user gets no help. A click on a neighbour designs the
wrong tooth, and auto-design stops at the margin with failed checks.

This task finds crown preps on the jaw that holds the active tooth. While the active tooth has no frame, it rings the
prep that belongs to it, with the demo ring's look (4.5 mm radius, frame blue).

**Precision first.** A wrong ring is worse than no ring. The detector was prototyped and measured on every synthetic
and golden case before any UI work (the user's scope trim: measure first, then wire the minimum UI only if there is
no false ring and no miss on the crown-prep cases).

## Scope

**In**
- `apps/web/src/geometry/prepFinder.ts` (pure TS):
  - `findPreps`: the crown preps on a jaw scan;
  - `prepFor`: the prep of one FDI tooth, paired in arch order.
- Worker `findPreps(jawSha, antagonistSha?)`: computed once per scan and cached in the scan registry.
- The ring on the Tooth frame step, for restorations on a crown prep (`PREP_MARGIN` in `tools/marginView.ts`:
  anatomic and reduced crowns), while the tooth has no frame.
- A status-line warning when a first click lands more than 6 mm from every prep found on that jaw: "That doesn't look
  like a prepared tooth…". The click still runs; nothing is ever refused on a real scan.
- One check in `tools/e2e/bridge.mjs`: `lower-bridge.stl` (no demo) rings the prep of 35.

**Out**
- Any change to the demo: its known seed, ring and click guard stay exactly as they are (`demoPrep.ts`).
- Scan bodies, inlay or onlay cavities and Maryland wing abutments. They are not crown preps: the detector must not
  ring them, and the ring is not offered for their restorations.
- A change to the Tooth frame hint ("Click the top of the prepared tooth 35" stays; the ring explains itself).
- Real-scan validation: the repo has synthetic data only (see Follow-ups).

## Design

### Detector (`findPreps`)
1. **Occlusal:** the jaw's least-variance axis (PCA), oriented toward the antagonist's centroid when one is loaded,
   else toward where the vertex normals face (out of the teeth).
2. **Arch and crest:** the arch curve (`fitArchCurve`, `geometry/arch.ts`). Every 0.25 mm along it, the highest
   surface point across a ±6 mm band (rays cast down the occlusal axis every 0.5 mm).
3. **Peaks:** the crest's local maxima, highest first, at least 3 mm apart (about 18 on a full arch).
4. **Finish line all round:** 24 radial height profiles from each peak (0.05 mm steps, up to 8 mm, cut where the
   surface rises onto a neighbour). A profile has a ledge when, past a wall (a slope of at least 1.2 and at least
   1 mm of drop), the slope eases to less than half the wall's for at least 0.1 mm, and then drops at least 0.4 mm
   more (the root below the margin). A peak is a prep when at least 75% of its profiles have a ledge.
   - **Natural teeth:** their profiles run into the neighbours (mesio-distally), or straight down the crown to the
     gum, where the ease never ends in a drop (bucco-lingually).
   - **Scan bodies:** they have no ledge.
   - **Cavities:** their cusps and walls stay natural.
5. **Leaning front teeth:** seen from the occlusal direction, a leaning prep hides its lingual ledge. A peak with
   40–75% is profiled again along its stump's own axis (`findPrepStump` and `stumpWallAxis`, `geometry/prepAxis.ts`)
   when that axis is within 40° of the occlusal.
6. **The ring's centre:** the centroid of the ledge points, cast onto the top along the profiles' axis.

An occlusal-reduction gate (the top at least 0.8 mm below the jaw's level) was tried and dropped:
- with a global level (the crest's 75th percentile) under the PCA axis, the axis tilts 2.75° on the asymmetric
  bridge scan, and the left preps read as level with the natural right side;
- with an occlusal plane fitted through the peaks, 37 at the arch end, next to the missing 36, is extrapolated to
  only 0.34 mm.

The finish line alone separates every case (measurements below), and the pairing's count check rejects any extra
detection.

### Pairing (`prepFor`)
The arch curve's arc length `s` grows toward quadrant 4 (lower) and quadrant 2 (upper): its tangent is
normal × occlusal (`ArchCurve`). So FDI teeth in arch order are 37…31 41…47 and 17…11 21…27 (`archOrdinal`).

The case's crown-prep teeth on the jaw are paired with the preps found, both in arch order, on the active tooth's
side of the midline when the scan is a full arch (`midlineS`). If the two counts differ on that side, nothing is
paired: a missed or an extra prep can never shift the pairing onto a neighbour. A partial scan (no midline) pairs over
the whole scan.

### App
- `tools/prepRing.ts` (new):
  - `prepRing()`: the demo's ring first (`demoPrep()`, unchanged). Otherwise, for a crown-prep tooth, the paired prep
    of the active tooth, once the worker's finding for its jaw has arrived.
  - The first request per scan starts the worker call, and its arrival re-syncs the controller.
  - `prepWarning(point)`: the warning for a first click far from every prep found. It is null in the demo, before the
    finding arrives and when nothing was found.
- `tools/controller.ts` draws `prepRing()` where it drew `demoPrep()` (same overlay, same look).
- `tools/frameTool.ts` passes the warning into the status line of both paths: the frame estimate and the one-click
  run.

## Verification plan

- **Prototype measurement** (a one-off script over the files below, not committed): per case, the preps found,
  missed and false, the ring of every crown tooth of the case (right, wrong or none), the highest ring score among
  non-preps, and the time.
- **Tests (+2, 111 → 113):** `apps/web/src/geometry/prepFinder.test.ts`, with the synthetic arches built once per
  `describe`:
  - the passing case: the 35–[36]–37 bridge arch finds exactly 35 and 37, and pairs each tooth with its own prep;
    with a count mismatch, no pair;
  - the failing case: an arch with a MOD cavity and an onlay (and natural teeth) finds no prep.
- **Browser:** `bridge.mjs` gains the check that `lower-bridge.stl` rings the prep of 35. Run `first-run` (the demo
  ring and guard unchanged) and `bridge`.
- `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.

## Measurements (prototype, before any UI)

Each scan went through the import pipeline (`processScan`) and a BVH, as in the worker. Node 22, M-series laptop.

"Rings" pairs every crown tooth of the case with the prep found for it: "ok" is the right prep, "wrong" another
tooth's (none occurred), "none" no ring. "Highest other" is the highest ring score of any peak that is not a prep
(the threshold is 0.75).

| Case (scan) | Preps | Found | Missed | False | Rings | Highest other | ms |
|---|---|---|---|---|---|---|---|
| synthetic-36 (lower.stl, 1M) | 36 | 36 | – | 0 | 36 ok | 0.21 (35) | 147 |
| synthetic-36 antagonist (upper.stl) | – | – | – | 0 | – | 0.04 | 122 |
| synthetic-bridge-35-37 (lower-bridge.stl, 1M) | 35, 37 | 35, 37 | – | 0 | 35 ok, 37 ok | 0.00 | 145 |
| synthetic-framework-35-37 (same scan) | 35, 37 | 35, 37 | – | 0 | 35 ok, 37 ok | 0.00 | 120 |
| synthetic-bridge-12-22 (upper-anterior-bridge.stl, 1M) | 11, 21 | 11, 21 | – | 0 | 11 ok, 21 ok | 0.00 | 129 |
| synthetic-bridge-12-22 antagonist (lower.stl) | – | – | – | 0 | – | 0.00 | 116 |
| synthetic-implant-bridge-35-37 (scan bodies, 0.65M) | – | – | – | 0 | – | 0.04 (scan body 35) | 132 |
| synthetic-inlay-bridge-35-37 (MOD cavities, 1M) | – | – | – | 0 | – | 0.29 (cavity 35) | 124 |
| synthetic-inlay-bridge-35-37 pre-op | – | – | – | 0 | – | 0.00 | 109 |
| synthetic-maryland-11-12 (upper-maryland.stl, 1M) | – | – | – | 0 | – | 0.00 | 113 |
| data/synthetic lower.stl / upper.stl | 36 / – | 36 / – | – | 0 | 36 ok | 0.21 / 0.04 | 105 / 96 |
| data/synthetic lower-colored.ply / upper-colored.ply (0.3M) | 36 / – | 36 / – | – | 0 | 36 ok | 0.00 / 0.04 | 93 / 95 |
| data/synthetic lower-implants-35-37.stl (0.11M) | – | – | – | 0 | – | 0.04 | 94 |
| generator: lower preps 31, 33, 44, 47 | 4 | 4 | – | 0 | all ok | 0.00 | 103 |
| generator: upper preps 13, 14, 16, 27 | 4 | 4 | – | 0 | all ok | 0.00 | 95 |
| generator: lower adjacent preps 34, 35, 36 | 3 | 3 | – | 0 | all ok | 0.00 | 100 |
| generator: lower prep 46 (mirror of 36) | 46 | 46 | – | 0 | 46 ok | 0.00 | 100 |
| generator: upper prep 26 | 26 | 26 | – | 0 | 26 ok | 0.21 (25) | 104 |
| generator: upper preps 11, 12, 21 leaning 20° | 3 | 3 | – | 0 | all ok | 0.00 | 107 |
| generator: upper preps 11, 23 leaning 30° | 2 | 2 | – | 0 | all ok | 0.00 | 211 |
| generator: upper natural, leaning 25° | – | – | – | 0 | – | 0.00 | 103 |
| generator: lower onlay 36, MOD 46 | – | – | – | 0 | – | 0.29 (cavity 46) | 102 |
| generator: lower 36 at 400 × 120 (0.1M) | 36 | 36 | – | 0 | 36 ok | 0.00 | 82 |

- **Rings:** every prep scores 1.00, except 11, 12 and 21 leaning 20° (0.75–0.83, cast along the occlusal). The 30°
  leaning preps reach 1.00 only on the retry along their own axis (0.42–0.54 before). Every non-prep stays at 0.29
  or below.
- **Ring centres:** within 0.3 mm of the synthetic prep's top centre on upright preps, and within 1.0 mm on leaning
  ones. The ring is 4.5 mm in radius.
- **Time:** 82–211 ms in Node, 105–147 ms on the 1M-triangle arches (one worker call per scan, cached). The worker
  time in the browser is in the implementation summary.

## Implementation summary

The prototype had no false ring and no miss on any crown-prep case, so the ring was wired in with the minimum UI: the
ring and the status-line warning.

**What was built, and where**
- **Detector:** `apps/web/src/geometry/prepFinder.ts`.
  - `findPreps` implements steps 1–6 of the design.
  - `archOrdinal` and `prepFor` do the pairing.
  - Pure TS; it reuses `fitArchCurve`, `findPrepStump` and `stumpWallAxis`.
- **Worker:** `findPreps(jawSha, antagonistSha?)` in `apps/web/src/workers/geometry.worker.ts`.
  - Cached in the scan registry per scan and antagonist.
  - The occlusal faces the antagonist's centroid, as in `estimateToothFrame`, so an inverted scan cannot reverse the
    arch order.
  - Client: `analysis.findPreps` in `workers/geometryClient.ts`.
- **App:** `apps/web/src/tools/prepRing.ts`.
  - `prepRing()`: the demo's prep first (`demoPrep.ts`, unchanged). Otherwise, for an anatomic or reduced crown, the
    prep paired with the active tooth among the case's crown-prep teeth on that jaw. The first request per scan
    starts the worker call, and `onPrepsFound` re-syncs the controller when it arrives.
  - `prepWarning(point)`: "That doesn't look like a prepared tooth. If it is not the prep of {fdi}, click the prep to
    redo the frame." It fires for a first click more than 6 mm from every prep found on the jaw. It is null in the
    demo, before the finding arrives, when nothing was found, and for other restorations.
- `tools/controller.ts` draws `prepRing()` with the demo ring's overlay and look.
- `tools/frameTool.ts` puts the warning in the status line of both paths: `estimateFrameAt` takes it as its message,
  and the one-click path sets it before `runAutoDesign`. The click is never refused.

**Deviations from the spec**
- **No occlusal-reduction gate.** It was in the first prototype; why it went is under Design.
- **The measurement script is not committed.** It was a one-off over the files in the table. The two tests guard the
  passing and failing cases.
- **Unit-test arches at 600 × 250 (0.3M triangles), not the usual 400 × 120.** At 400 × 120 the synthetic
  premolar's chamfer ledge (about 0.2 mm wide) is one mesh row, and 35 scored exactly 0.75. At 600 × 250 both preps
  score 1.00. The MOD cavity scores 0.46 there (0.29 at the golden case's 2000 × 250): it is profiled again along its
  stump axis and still rejected.
- **The overlay key stays `demo:prep`.** `first-run.mjs` checks it, and the browser-script changes were limited to
  one check in `bridge.mjs`.
- **The warning can be replaced.** On a one-click bridge before the last abutment, the orchestrator's "Frame set on
  35. Click the prep of 37 next" replaces it (a new message replaces the old one).

**Verification**
- `pnpm typecheck` clean.
- `pnpm test`: 113 tests (101 pass, 12 skipped without infrastructure), up from 111 (99 pass). The two new tests are
  in `apps/web/src/geometry/prepFinder.test.ts`:
  - "finds the crown preps and pairs each tooth with its own, in arch order": both tops within 1 mm of the synthetic
    seeds, and no pair on a count mismatch;
  - "rings no inlay or onlay cavity and no natural tooth".
- `pnpm --filter @dcad/web build` passes. Its chunk-size warning predates this task.
- **Browser scripts** (dev server on :5313), run again after the last edit:
  - `first-run`: all 24 checks pass. The demo ring, the refusal of a click on 35 and the draft are unchanged.
  - `bridge`: all 35 checks pass (34 before). The new one: `lower-bridge.stl` rings the prep of 35, with the ring's
    centre 0.40 mm from its top.
- **One-off browser check** (not committed), on `lower.stl` + `upper.stl` (no demo):
  - 36 is ringed (screenshot checked);
  - with one-click off, a click on 34 shows the warning and still sets the frame.
- **Worker time in the browser** (headless Chrome), first call:
  - the 1M-triangle demo lower arch: 111 ms, with its prep found 0.16 mm from the synthetic seed;
  - the 0.3M upper arch: 87 ms, no prep;
  - a cached call: 0.2 ms.

**Follow-ups**
- **Validate on de-identified real scans before relying on the ring.** Precision and recall are measured on synthetic
  arches only. On real scans:
  - the chamfer ledges are wider than the synthetic premolar's (good for recall);
  - gingiva lying on the margin may hide the drop below the ledge (a miss, not a false ring);
  - natural teeth's real contacts, gingival margins and restorations are untested.
- The Tooth frame hint could say "inside the blue ring" when a found prep is ringed. That needs the step panel to
  re-render when the finding arrives.
- Keep the warning visible through the one-click bridge flow.
- Rename the overlay key to `prep:ring`, together with `first-run.mjs`.
