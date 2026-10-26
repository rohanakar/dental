# Anterior margin view, kinked-margin warning, Export all, separate-crowns hint

Status: **done** (2026-10-26).

## Goal

A user designed two single crowns on upper front teeth (11 and 21) and hit four problems:

1. **Finalize said "Not ready to mill: 5 checks open" on 11:**
   - "Margin closed: No kinks (sharpest turn over 0.6 mm ≤ 120°)" failed;
   - "Watertight solid: 1719 self-intersecting triangle pairs" failed;
   - the insertion axis was stale.

   The crown had a jagged, folded cervical fringe. In the Margin step the camera looks along the tooth frame's
   occlusal direction, which is the occlusal-plane normal of the whole jaw. On front teeth part of the margin is then
   hidden behind the tooth, the clicks land on the labial face, the margin kinks, and the crown folds. Nothing warned
   about the kink before the crown was proposed.
2. **Only one tooth was exported.** The user expected one export for both crowns. Finalize exports only the active
   restoration.
3. **Two crowns next to each other stay separate restorations** unless the connector dot between them is switched on
   in Case setup. As in exocad, connectors are created automatically only next to a pontic. Nothing said so.

## Findings (measured before the change)

Measured with a probe (Node, `estimateToothFrame` plus ray casts from a 32 mm perspective camera, the Margin step's
view) and in the browser at `/app/`:

| Case | Frame occlusal vs. true | Margin points visible from the Margin view |
|---|---|---|
| Synthetic upper arch, 11 and 21 prepped (teeth upright) | 2.5° | 64 of 64 |
| Same, 12 and 22 missing (`upper-anterior-bridge.stl`) | 4.1° | 64 of 64 |
| Synthetic lower 36 | 0.8° | 64 of 64 |
| Upper 11 and 21 proclined 15° | 2.0° | 45 of 64 |
| Upper 11 and 21 proclined 25° | 1.6° | 39 of 64 |

- **On the synthetic arch the teeth are upright.** The frame's occlusal direction is the jaw's occlusal-plane normal
  (whole-jaw PCA), and from it the whole margin is visible. The bridge E2E saw hidden points because it clicked while
  the camera was still moving. Its `settle()` compares camera positions 250 ms apart, and in headless Chrome with
  SwiftShader a frame of the 1M-triangle scan can take longer than that. The probe measured 38 of 64 visible
  mid-animation and 64 of 64 once camera-controls reported idle.
- **Real front teeth are proclined.** The long axis of an upper incisor sits 15–30° labial of the occlusal-plane
  normal. Shearing the synthetic incisors by 15–25° reproduces the user's report: 19–25 of 64 margin points (about
  3 of 8 clicks) cannot be clicked from the jaw-level view.
- **The tooth frame is not changed.** `estimateToothFrame` keeps the jaw's occlusal plane, which is right for the frame
  axes, the contacts and the template pose of posterior teeth. The Margin view needs the prep's own axis instead. The
  frame of a proclined front tooth is a follow-up (see Follow-ups).

## Scope

**In**
1. **Margin step view.** On entering the step, the camera looks along a direction derived from the prep:
   - the least-undercut axis of the prep's own walls (stump region around the frame origin), or, when a margin exists,
     whichever of that axis, the stored insertion axis and the frame occlusal hides the fewest margin points (ray
     tested from the real camera position).
   - Posterior behaviour stays the same: on the synthetic 36 the direction stays within about 1° of the frame occlusal
     and the whole margin stays visible.
2. **Kinked margin flagged before a crown is proposed.**
   - When a margin exists, `marginGate` (`apps/web/src/ai/qa.ts`, imported, not edited) runs on it.
   - The Margin step shows a warning that names the turn and the side it is on, with a hint to re-trace near it.
   - The kinks are marked in the viewport.
   - The Proposal step shows the open margin problem with a link back to Margin. This is a soft notice: proposing is
     still allowed.
3. **Export all** in Finalize: one action, one download.
   - A zip holds every restoration of the case:
     - each single crown as `<ref>-<fdi>.stl` plus `<ref>-<fdi>.construction.json`;
     - each bridge as its union `<ref>-<first>-<last>-bridge.stl` plus its sidecar;
     - a `manifest.json` and a `README.txt` that list each restoration's readiness (its open checks).
   - Every restoration is designed from the current document, not only the active tooth.
   - The same soft gate applies: when any restoration has open checks, the button reads "Export all anyway…" and an
     inline confirmation lists them.
   - The per-restoration export stays.
4. **Setup hint.** When two chart-adjacent teeth in the case could be connected but are not, one line under the tooth
   chart says they stay separate restorations unless the connector dot between them is switched on.

**Out**
- Changing `estimateToothFrame` (the occlusal of proclined front teeth), geometry or worker code, shared schemas, the
  reducer, `ai/**`. Other agents own them in parallel.
- Hard-blocking the proposal on a kinked margin.
- Automatic re-tracing or smoothing of a kinked margin.
- A leak check (`prepClosed`) in the Margin step. It needs a worker round trip, and Finalize and the axis step already
  report it.
- Maryland and inlay restorations in the export-all zip: they are not on main yet. Implant crowns and framework units
  landed on main during this task and are in (see the Implementation summary).

## Design

### 1. Margin view (`apps/web/src/tools/marginView.ts`, new; `tools/controller.ts`)

`marginView(input)` is pure TS. It takes the jaw's positions and index, a `RayCaster`, the tooth frame, and optionally
the margin points and the stored axis. It returns `{ target, direction, source, hidden }`.

- **Prep axis.** Faces around the prep:
  - With a margin: within the margin's radius (+0.5 mm) of its centroid, and no more than 1 mm below it along
    occlusal.
  - Without one:
    - within 5 mm of a point 1.5 mm below the frame origin;
    - no lower than 5 mm below the origin along occlusal;
    - between the neighbour contacts along mesial-distal when the frame has them.
- **The search.** Least undercut with a clearance:
  - cost(d) = Σ area · max(0, sin 20° − n·d) over those faces, plus a small tie-break toward the frame occlusal.
  - A wall must face the camera by at least 20°, so the optimum lies along the axis of the stump's walls, not at the
    edge of the visible cone.
  - It runs on Fibonacci samples in a 35° cone around the frame occlusal, then a 0.5° refinement.
- **Choice.**
  - Without a margin: the prep axis.
  - With a margin: candidates in order prep axis, stored insertion axis, frame occlusal. Each candidate is ray tested
    from the camera position (target + 32 mm × direction) to every margin point, and the one hiding the fewest wins;
    ties go to the earlier one.
- **Target:**
  - the margin centroid when a margin exists;
  - otherwise the frame origin, as before.
- **Distance:** 32 mm, as before.
- `DesignTools.focusPrep('occlusal')` calls it with the jaw's main-thread geometry (positions, BVH index, and
  `boundsTree` for the ray caster). A view that cannot be computed falls back to the old one.

### 2. Kinked margin (`apps/web/src/tools/marginCheck.ts`, `ui/steps/MarginIssues.tsx`, both new)

- **`marginIssues(points, frame?)`:**
  - runs `marginGate({ points, lengthMm })` and keeps the failed checks;
  - locates the kinks with the same stride rule as `sharpestTurnDeg`: each run of points turning more than 120° is one
    kink, at its sharpest point;
  - names the side of each kink from the frame (mesial, distal, buccal or labial for teeth 1–3, lingual).
- **Margin step:** a warning lists each problem with its value, then says how to fix it: "drag the nearest point onto
  the margin, or click on the prep to trace it again with more points near the red mark".
- **Viewport:** `DesignTools.drawOverlays` draws a red marker at each kink while the Margin step is open.
- **Proposal step** (single crown and bridge): a notice names the margins with problems (in a bridge, every abutment)
  and offers "Fix the margin". It opens the Margin step on that tooth.

### 3. Export all (`apps/web/src/io/exportAllZip.ts`, `tools/exportAll.ts`, `ui/steps/ExportAll.tsx`, all new)

- **`io/exportAllZip.ts`** is pure:
  - `exportAllZip({ caseRef, createdAt, restorations })` returns the zip bytes (fflate `zipSync`).
  - Each restoration carries its kind, teeth, file base, STL bytes and sidecar (absent when it was skipped), its open
    checks, and the reason when it was skipped.
  - It writes the STL and JSON files, `manifest.json` (format `dcad.export-all@1`) and `README.txt`.
- **`tools/exportAll.ts`** designs every restoration of the current document in the worker:
  - **Single crowns:** a crown request per tooth (`crownRequestFor` from `crownTool.ts` plus `toothContextFor(fdi)` in
    `context.ts`), then `analysis.designCrownUnlatched`.
  - **Bridges:** `bridgeRequest(doc, fdi, { union: true })`, then `analysis.designBridgeUnlatched`.
  - **Readiness:** `millReadiness` per tooth or unit (with `axisTool.measureTooth`), plus the failed `bridgeGate`
    checks for a bridge. These are the rows Finalize shows.
  - A restoration with no crown yet, missing inputs or a failed union is listed as skipped, with the reason.
- **`ui/steps/ExportAll.tsx`** appears in Finalize when the case has two or more restorations.
  - It lists them; the button is "Export all (zip)".
  - A click designs everything (with a spinner), then:
    - downloads at once when every restoration is ready;
    - otherwise shows the inline confirmation, which lists the restorations with open checks and offers "Export all
      anyway" and Cancel. That download comes from the zip already built, inside the click.
  - A document change discards a prepared zip.
- **Shared files touched** (additive only):
  - `FinalizeStep.tsx`: renders `<ExportAll />`.
  - `crownTool.ts`: exports the request builder and `APP_VERSION`.
  - `context.ts`: `toothContextFor(fdi)`; `toothContext()` delegates to it.

### 4. Setup hint (`apps/web/src/ui/SeparateHint.tsx`, new; one line in `ui/steps/SetupStep.tsx`)

- `separatePairs(setup)` lists the chart-adjacent pairs that are both in the case and could be connected but are not
  (`connectorState(...).status === 'open'`).
- The hint is one muted line under the chart, for example: "11 and 21 stay separate crowns. Switch on the dot
  between them to join them into one piece." It uses "restorations" when a pair includes a pontic.

## Verification plan

- **Tests** (CLAUDE.md budget; two features with logic, so +2, 103 → 105):
  - **New** `apps/web/src/tools/marginCheck.test.ts`, "finds the kink in a margin that doubles back, none in a smooth
    one". Detector rule: one passing and one failing case. The failing case's kink must be located at the spike.
  - **New** `apps/web/src/io/exportAllZip.test.ts`, "Export all writes every restoration and a manifest of open
    checks". Two crowns, one bridge and one skipped restoration go into one zip: file names, STL triangle counts,
    sidecars, and the manifest's readiness per restoration.
  - No tests for camera framing or text (CLAUDE.md).
- **Commands:** `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.
- **Probe numbers:** margin visibility from the new view on upright 11/21, proclined 11/21 (15°, 20°, 25°) and 36
  (angle from the old view and points visible).
- **Browser** (`vite --port 5285`, Playwright, the dev debug hook), screenshots in the session scratchpad:
  - the Margin step on 11 of a proclined upper arch, before and after (whole margin visible);
  - a deliberately kinked margin flagged in the Margin step (warning plus marker) and in Proposal;
  - two single crowns plus one bridge exported with Export all, with the zip unzipped and each STL validated as closed
    in Node;
  - the setup hint.

## Implementation summary

### What was built

**1. Margin view.**
- **[tools/marginView.ts](../apps/web/src/tools/marginView.ts)** (new, pure TS on typed arrays plus a `RayCaster`):
  - **`findStump`** finds the prep by connectivity, so a click anywhere on the prep gives the same view:
    - It works in a ±6 mm window around the frame origin, on the edges of the faces inside it.
    - The prep top is the highest point connected to the origin through vertices no lower than 0.5 mm below it. A
      neighbour is separated from the prep by a lower valley.
    - The stump is everything connected to the top down to 3.5 mm below it.
  - **`prepAxis`** is the least-undercut direction of the stump's walls with a 20° clearance:
    - over the faces within 2 mm of the top;
    - sampled on a Fibonacci cap in a 35° cone around the frame occlusal, then refined;
    - a tie-break keeps the occlusal direction on an upright prep.
  - **`bestView`** checks that axis against the band 2.5–3.5 mm below the top, the foot of the walls toward the margin.
    It tries the axis and tilts of 4°, 8° and 12° from it, and keeps the one that hides the fewest band points.
  - **With a margin**, the candidates are tried in order: prep axis, stored insertion axis, frame occlusal. The one
    whose camera reaches the most margin points wins.
- **The camera** looks at the centre of the prep top from 32 mm.
- **[tools/controller.ts](../apps/web/src/tools/controller.ts)**:
  - `focusPrep('occlusal')` uses the new view for `anatomic-crown` and `reduced-crown` (`PREP_MARGIN`).
  - Implant crowns keep the old view in their Implant position step. So will types without a stump, such as Maryland
    wings and inlays.
  - It runs on the main thread from the scan's BVH (`boundsTree`), in 20–70 ms on a 1M-triangle scan.

**2. Kinked margin flagged.**
- **[tools/marginCheck.ts](../apps/web/src/tools/marginCheck.ts)**:
  - `marginProblems(points, tooth)` runs `marginGate` (imported from `ai/qa.ts`, unchanged) and locates each kink.
  - A kink is a run of points turning more than the gate's 120° over its 0.6 mm stride (the `sharpestTurnDeg` rule),
    reported at its sharpest point.
  - The side is named from the frame: mesial, distal, buccal (labial on teeth 1–3), lingual, or a combination such as
    mesiolabial.
- **[ui/steps/MarginIssues.tsx](../apps/web/src/ui/steps/MarginIssues.tsx)**:
  - The Margin step warns "The crown would fold at this margin" with each kink, its angle and side, and how to fix it.
  - Crown proposal shows a soft notice for the active tooth, or every abutment of its bridge. Its "Fix the margin of
    11" link opens the Margin step on that tooth. Proposing stays allowed.
- **Viewport:** the controller marks each kink with a red ring while the Margin step is open.

**3. Export all.**
- **[io/exportAllZip.ts](../apps/web/src/io/exportAllZip.ts)** (pure) builds one zip: per restoration its STL files
  and construction sidecar, plus `manifest.json` (`dcad.export-all@1`) and `README.txt`. Both list each restoration's
  readiness: ready, its open checks, or why it was left out.
- **[ui/steps/restorations.ts](../apps/web/src/ui/steps/restorations.ts)** designs every restoration of the document
  in the worker, one at a time, and writes the files the per-restoration exports write:
  - **Single crowns:** `crownRequest` and `toothContextFor` → `designCrownUnlatched`.
    - An implant crown: its STL with the screw channel, and the sidecar's implant section.
    - A reduced crown: `<ref>-<fdi>-framework.stl`, plus `<ref>-<fdi>-overpress.stl` when its cutback asks for
      overpress (`overpress: true`).
  - **Bridges:** `bridgeRequest(…, { union: true })` → `designBridgeUnlatched`.
    - The union as `<ref>-<first>-<last>-bridge.stl`, or `-framework.stl` with reduced units.
    - Each overpress part as `<ref>-<fdi>-overpress.stl`.
    - The sidecar's framework section.
  - **Readiness:** Finalize's rows, from `millReadiness`, `implantReadiness` and the failed `bridgeGate` checks.
- **[ui/steps/ExportAll.tsx](../apps/web/src/ui/steps/ExportAll.tsx)**: an "All restorations" section after the export
  row of `CrownFinalize` and `BridgeFinalize`, shown with two or more restorations.
  - "Export all (zip)" designs everything, then downloads.
  - With open checks, an inline confirmation lists them per restoration and offers "Export all anyway", which
    downloads the prepared zip inside the click.

**4. Setup hint.** [ui/SeparateHint.tsx](../apps/web/src/ui/SeparateHint.tsx): under the tooth chart, "11 and 21 stay
separate crowns unless you switch on the dot between them." It lists every chart-adjacent pair that could be
connected but is not.

**Shared files, additive edits only:**
- `tools/context.ts`: `toothContextFor`.
- `tools/crownTool.ts`: exports `crownRequest` and `APP_VERSION`.
- `tools/controller.ts`, `MarginStep.tsx`, `ProposalStep.tsx`, `SetupStep.tsx`: one element or call each.
- `FinalizeStep.tsx`, `BridgePanels.tsx`: `<ExportAll />` after `<FrameworkFinalize />`.

**E2E:** [tools/e2e/anterior-export.mjs](../tools/e2e/anterior-export.mjs) (`pnpm --filter @dcad/e2e anterior`).

### Deviations from the spec (and why)

- **Prep region and view, found by testing on a proclined arch:**
  - **The prep region is found by connectivity from the prep top**, not as a sphere around the frame origin.
    - With the sphere, a click 2 mm off the prep centre gave 39–41 of 64 margin points even on upright incisors.
  - **The stump region is 2 mm deep**, not 5 mm.
    - At 3–4 mm the region takes in the steep root surface below the margin and undershoots the lean.
  - **`bestView` was added.**
    - The walls' axis alone reached 18° on a 25° lean, which left 9 of 64 points edge-on.
  - **The target is the centre of the prep top**, not the frame origin (the prep top under the click). The view no
    longer depends on where the prep was clicked.
- **"Hidden" means a click cannot reach the point** (the pick lands more than 0.3 mm from it), not only that something
  is in front of it.
  - From the jaw-level view, the labial margin of a leaning incisor is seen edge-on: the pick lands 1.6 mm beyond it
    on the gum.
  - Measured with occlusion alone, the old view looked fine (61 of 64 at 25°).
- **The orchestration lives in `ui/steps/restorations.ts`**, not `tools/exportAll.ts`. It uses Finalize's readiness
  helpers (`readiness.ts`, `implantReadiness.ts`, `MATERIAL_LABEL`), which live in `ui/steps`.
  - It keeps its own six-line copy of `freeNeighbours`: importing BridgePanels would close an import cycle, because
    BridgePanels renders `ExportAll`.
- **The hint lives in `ui/SeparateHint.tsx`**, so SetupStep gets only one line.
- **`marginIssues` is named `marginProblems`** and takes the tooth (its FDI and frame), because the FDI chooses
  "labial" or "buccal".
- **Scope change mid-task (the coordinator):**
  - Implant crowns and framework units landed on main. Export all includes their outputs.
  - `RestorationExport` carries several STL files and a display name ("14 implant crown", "framework bridge 35–37").
- **The prep view applies only to prepared crowns.** It is restricted to `PREP_MARGIN`, so the Implant position step
  (and the Maryland "Wing outline" step when it lands) keep their own view.

### Verification

- **Commands:** `pnpm typecheck` passes; `pnpm --filter @dcad/web build` passes (the chunk-size warning was already
  there).
- **Tests:** `pnpm test` gives 107 tests, 95 passed and 12 skipped (infra), up from 105 on main (e91f72a), so +2.
  By package: shared 2, api 21, web 79, pipeline 5.
  - `tools/marginCheck.test.ts` "finds the kink of a margin that doubles back and names its side; none on a smooth
    margin": the detector's passing and failing cases. The kink is located within 0.5 mm of the spike, on the labial
    side.
  - `io/exportAllZip.test.ts` "writes every restoration in one zip with a manifest of open checks":
    - a crown, a reduced crown with framework and overpress STLs, a bridge, and a skipped crown;
    - the file list, the STL triangle counts, the sidecar, and the manifest's ready, open and skipped entries.
- **Probe** (Node, 1M-triangle synthetic upper arch). Margin points of 11, out of 64, that a click from the Margin
  view reaches. The incisors are proclined by a shear; the frame is clicked at the prep centre and 2 mm buccal,
  lingual, mesial and distal of it.

  | Incisor lean | Old view (frame occlusal) | New view | New view, angle from the frame occlusal |
  |---|---|---|---|
  | 0° (synthetic as is) | 60–64 | 64 (every click position) | 2.0° |
  | 15° | 43–47 | 64 | 10–16° |
  | 20° | 40–42 | 64 | 14–20° |
  | 25° | 38–39 | 64; 61 for a click 2 mm onto the labial face | 18–24° |
  | 30° | 37–39 | 64; 53 for a click 2 mm onto the labial face | 26–33° |

  - With 12 and 22 missing, every case reaches 64.
  - Posterior teeth:
    - 36 on the synthetic lower arch: 64 of 64 before and after, the view unchanged (0.0°).
    - 35 on `lower-bridge.stl`: 64 of 64, the view 4.8° from the frame occlusal (old view: 52 to 64).
  - The view takes 20–70 ms per step entry.
- **Browser** (`vite --port 5285`, Playwright, headless Chrome). Screenshots are in the session scratchpad
  (`fixes-anterior/e2e/`):
  - **`anterior-export.mjs`: all 13 checks pass**, with no console errors.
    - **Setup hint:** "11 and 21 stay separate crowns unless you switch on the dot between them."
    - **Margin step on 11** (incisors leaning 25°): 64 of 64 margin points reachable, against 39 of 64 in the old view.
      The view is 18.5° from the frame occlusal.
    - **Margin traced from the old view, as the user did:** a 153° kink and 30.6 mm long, against 19.5 mm when traced
      in the new view.
      - The Margin step warns "Kink on the mesiolabial side: the line turns 153°…" and shows a ring marker.
      - Crown proposal shows the notice; "Fix the margin of 11" opens the Margin step.
      - Traced again in the new view: 71°, no warning.
    - **Export all:** one zip, `case-restorations.zip`, with both crowns, the bridge, the manifest and the README.
      - Each STL is closed in Node, and the bridge is one component (58,852 triangles).
      - The manifest lists 4, 5 and 4 open checks: no adaptation, and 21's self-intersections (see Follow-ups).
  - **A scratch probe of Export all on the other restoration types** passes every check:
    - **Two implant crowns** (`lower-implants-35-37.stl`): `case-35.stl` and `case-37.stl` with their screw channels
      (closed, genus 1); the sidecars carry the implant section.
    - **A framework bridge 35–[36p]–37 with a pressed pontic, plus 46 not designed:**
      - `case-35-37-framework.stl` is one closed solid;
      - `case-36-overpress.stl` is closed;
      - the sidecar's framework section has 3 units and 1 overpress part;
      - 46 is listed as left out.
    - **A single reduced crown on 36 with overpress:** `case-36-framework.stl` and `case-36-overpress.stl`, both
      closed, with a framework sidecar.
  - **No regressions:**
    - `bridge.mjs` (posterior): 28 of 28, every margin click on target with 0 re-aimed.
    - `ai-bridge.mjs`: all checks pass.
    - `implant.mjs`: all checks pass, 0 failures.
    - `offline-design.mjs` (single 36): margin deviation 0.064 mm mean, 0.18 mm max; crown and exports as before. Its
      only console error is the offline `/api/me` 502.

### Follow-ups

- **Frame of proclined front teeth.**
  - `estimateToothFrame` takes the jaw's occlusal plane as the tooth's occlusal direction. The crown template is posed
    along it, and the axis search is centred on it (25° cone).
  - On the 25° proclined synthetic incisors:
    - the crowns stand upright on leaning preps;
    - the least-undercut axis stops at 6.6° with 1–2 margin points in undercut;
    - 21's crown has 174 self-intersecting triangle pairs, even on a clean margin.
  - Likely fix: an anterior frame whose occlusal follows the prep axis (`marginView`'s `prepAxis`, or the same
    estimate in `toothFrame.ts`), and an axis cone centred on it. That changes `estimateToothFrame` semantics and the
    geometry tests, so it was left out here.
- **Bridge E2E settle:** `tools/e2e/bridge.mjs`'s `settle()` compares camera positions 250 ms apart. In headless
  SwiftShader that can pass mid-animation, which is what made its anterior margin clicks miss. Waiting for
  `viewer.controls.active` to turn false, as `anterior-export.mjs` does, is reliable.
- **Margin leaks:** the Margin step's warning does not check `prepClosed`. That needs a worker round trip; Finalize and
  the axis step report it.
- **Maryland "Wing outline" and inlay outlines:** when they land, they keep their own view (not in `PREP_MARGIN`).
  Their outputs go into `ui/steps/restorations.ts`.
