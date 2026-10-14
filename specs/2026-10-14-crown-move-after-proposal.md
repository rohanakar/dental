# Crown moves after a proposal behave unexpectedly

Status: **done** (2026-10-14).

## Report

"After the crown proposal, if I move it, it behaves weirdly." Reported against the Day 6 build: a crown from
Auto-design (or Propose + Adapt) moved with the gizmo, the nudge pad or the arrow keys in the Proposal step.

Follow-up from the user (2026-10-14):
- **All three inputs** (gizmo, nudge pad, arrow keys) show the problem, **even before Accept**. So the common cause is
  F1 (re-adaptation) together with F3 (the margin stays sealed), plus F6 (moves inside the open draft). F4 adds the
  gizmo-only jumps on top.
- **Visibility.** While adjusting the crown, the gums and the other teeth should be a little less visible, and the
  prepared tooth more visible. The crown must be easy to tell apart from the tooth; today both are nearly the same
  colour. Recorded as F7.

This spec lists every cause found in the code and measured on the synthetic case.

## Findings

All numbers are from a temporary probe (not committed) on synthetic-36 with zirconia params. It ran `designCrown` at
the proposed pose and at moved poses, with and without the adaptation targets the `classical.adapt@1` proposer sets
(occlusion 0.05 mm, mesial and distal 0.02 mm). "Cusps", "middle" and "cervical" are shell vertices with template
height fraction ≥ 0.7, 0.3–0.7 and ≤ 0.05. Their displacement is measured along the move direction against the crown
at the unmoved pose.

### F1. Adaptation is re-applied after every move (main cause)

`moveCrown`, `rotateCrown` and `scaleCrown` keep `crown.adapt` (`apps/web/src/design/reducer.ts`, `updateCrownPose`).
`crownTool` sends the stored targets with every recompute (`apps/web/src/tools/crownTool.ts`, `request`). So each move
becomes "move the template, then re-adapt to the antagonist and the neighbours". The reducer meanwhile marks the
`adapt` step **stale**, so the step list says the adaptation is out of date while the crown on screen is adapted.

What this does to a move:

| Move (adapted crown) | Cusps follow the move | What happens |
|---|---|---|
| occlusal 0.3 mm | 0.15 mm mean (0–0.34) | Occlusal adaptation grinds the raised cusps back down (up to 0.85 mm). |
| occlusal 1 mm | 0.32 mm mean (0–0.96) | Up to 1.55 mm ground off. The occlusal table flattens instead of rising. The distal contact opens to 0.61 mm and is not restored. |
| cervical 1 mm | 0.75 mm mean (0–1.00) | The gap to the antagonist is 0.50 mm, inside the 0.5 mm lift window, so a patch around the closest cusp is lifted back up by 0.45 mm. The result is a local bump. |
| cervical 2 mm | 1.89 mm mean | 1.5 mm gap, outside the lift window: occlusal contact is lost silently. |
| mesial 0.3 mm | 0.30 mm | The mesial wall stays flattened against the neighbour. The distal gap becomes 0.56 mm, past the lift window, so the distal contact is lost. |
| mesial 1 mm | 1.00 mm | The crown penetrates the mesial neighbour by 0.24 mm before adaptation cuts it back. The distal gap is 0.91 mm, not restored. |

Without adaptation, the same moves are smooth and predictable (see F3).

The lift window (`ADAPT_RAISE_WITHIN_MM` = 0.5 mm in `apps/web/src/geometry/adapt.ts`) makes the response
discontinuous. A contact up to 0.5 mm away is pulled into contact, and one 0.51 mm away is left alone. A run of 0.1 mm
nudges therefore keeps a contact and then suddenly drops it.

### F2. Open contacts pass QA as "target reached"

`adaptGate` (`apps/web/src/ai/qa.ts`) only fails on a **conflict**, meaning too close because thickness won. A contact
left open beyond the lift window has no conflict, so it reports "mesial: target reached" with the value 0.91 mm. The
Adapt step shows the same report. An open proximal contact is a clinical defect (food impaction), so it must be visible.

### F3. A move is not rigid: the margin stays sealed

This is by design, but it is undocumented and the preview contradicts it. The RBF fit (`apps/web/src/geometry/crown.ts`)
pins the cervical ring to the margin and lets the occlusal third follow the pose. Without adaptation, for every
direction and size tested (0.3–3 mm):

- cusps 1.00 × the move
- middle third about 0.76 × the move
- cervical ring 0.02 × the move (0.07 mm at 3 mm)

The crown shears between the margin and the cusps. It stayed printable everywhere tested, with no self-intersections.
The smallest thickness was 0.50 mm, after a 3 mm cervical move, with 30 vertices pushed. So geometry validity is not
the problem; the user is not told that "move" means "move the anatomy, keep the margin".

### F4. The gizmo preview does not match the result, and the crown snaps back on release

`TranslateGizmo` (`apps/web/src/engine/gizmo.ts`) previews a drag by offsetting the **whole** crown object:

- The intaglio and the margin band lift off the prep during the drag, which the result never does.
- On release, `previewOffset(…, null)` resets the offset immediately. The old crown snaps back to its start position
  for the length of the recompute, about 0.2–0.4 s on a 1M-triangle scan.
- Then the result appears with the margin pinned (F3) and re-adapted (F1). It looks nothing like the preview.

That makes three visible jumps per drag: a rigid drag, a snap back, then a different shape.

### F5. The gizmo drifts away from the crown

The gizmo sits at `crownCentre(pose)`, the mid-height of the *posed template* (`apps/web/src/tools/gizmoTool.ts`).
The visible crown's middle moves only about 0.76 × the move and its cervical part not at all, so each move leaves the
gizmo further off. Its distance to the shell centroid is about 0.7 mm after small moves, 0.97 mm after a 1 mm cervical
move and 1.51 mm after 3 mm.

### F6. Moving before Accept edits the Auto-design draft

After Auto-design, the draft stays in an open transaction until Accept or Reject (`apps/web/src/ai/orchestrator.ts`).
The Proposal step shows the review banner *and* the gizmo, nudge pad and arrow keys, so moves made in that state go
into the transaction:

- **Ctrl+Z does nothing.** `undo` returns silently while a transaction is open (`apps/web/src/design/store.ts`).
- **Reject throws the moves away** together with the draft.
- **Accept stores the moves** as part of the `proposer`-authored edit.

The Assistant's Accept/Revert transaction (`apps/web/src/ai/agent.ts`) has the same problem.

### F7. The crown is hard to see against the scans

- **The crown and the scan are nearly the same colour.** Both use matcaps (`apps/web/src/engine/matcap.ts`):
  - jaw scans: `stone` (sRGB 0.86, 0.82, 0.74)
  - crown: `tooth` (0.96, 0.94, 0.88)
  The difference is ΔE76 11, almost all of it lightness, and the matcap shading shrinks it further in shadowed areas.
  Where the crown meets the prep, the eye cannot tell which surface is which.
- **There is no way to dim the surroundings without dimming the prep.** The object panel's opacity slider works per
  scan (`apps/web/src/state/sceneController.ts`). The prepared tooth, the gums and the neighbours are one jaw mesh,
  so they fade together. The antagonist is shown at full strength in the Proposal and Adapt steps.

## Goal

Moving, rotating or scaling a proposed crown does what the designer expects:
- The preview matches the result.
- The adaptation never silently undoes the move or drops a contact.
- What is on screen matches the step status.
- Undo always works.

While adjusting the crown, the designer sees it clearly:
- The gums, neighbours and antagonist are dimmed.
- The prepared tooth stays at full strength.
- The crown has its own colour, clearly different from the tooth.

## Scope

In:
1. **Adaptation follows the step status (F1; confirmed by the user).** The derived crown applies `crown.adapt` only
   when the tooth's `adapt` step is `done`.
   - A pose edit already marks `adapt` stale, so after a move the crown is shown **un-adapted**: the moved template,
     fitted to the margin. The stored targets stay in the document.
   - A **Re-adapt** button in the nudge pad and the Adapt step re-dispatches the stored targets in one command, which
     marks `adapt` done.
   - The same rule applies to every place that builds a crown request: `crownTool.request`, `crownTool.evaluate`
     (agent metrics) and `crownRequest` in `apps/web/src/ai/proposers.ts`.
   - This also affects other upstream edits that mark `adapt` stale (params, margin, axis): they too show the
     un-adapted crown until Re-adapt. That is the intended meaning of "stale".
2. **Open contacts are reported (F2).** After adaptation, a contact or occlusal target whose clearance is still more
   than `target + 0.05 mm` is reported as `open`:
   - in the adapt report, as a new optional `open` field next to `conflict`;
   - as a warning ("Mesial contact open: 0.91 mm, target 0.02 mm; move the crown mesially or re-adapt");
   - as a failed `adaptGate` check.
   The lift window stays at 0.5 mm. Widening it would hide real space problems.
3. **The preview matches the result (F3, F4).**
   - While dragging, the crown mesh is deformed on the CPU with per-vertex weights instead of being offset rigidly:
     - intaglio vertices: 0
     - shell vertices: `smoothstep(0, 0.7, heightFraction)`, which matches the measured cervical 0 / middle 0.76 /
       cusps 1 profile
     The weights come from `templateForTooth(fdi).heightFraction` and the result's `shellStart`.
   - The gizmo uses its existing `onDrag` hook. `crownTool` gets `previewMove(delta | null)`.
   - On release, the deformed preview stays on screen until the recomputed crown replaces it. It is reset only if the
     commit dispatches nothing or throws.
   - Nudge pad tooltips say "moves the anatomy; the margin stays on the prep".
4. **Gizmo follows the crown (F5).** The gizmo sits at the centroid of the derived crown's occlusal third (shell
   vertices with height fraction ≥ 0.7) from the latest result. Before the first result it falls back to
   `crownCentre`. `gizmoTool` re-syncs when a new crown result arrives, not only on document changes.
5. **Edits during a pending review (F6).** User edits (gizmo, nudge pad, arrow keys, Re-adapt) go through one helper:
   - If a proposer or agent draft is **pending review**, the helper first accepts it (same as clicking Accept, with
     the `accepted` events), then applies the edit as its own undo entry. A status message says "Auto-design accepted;
     your move is a separate undo step".
   - While Auto-design or the agent is **running**, the edit is refused with a message.
   - Ctrl+Z while a transaction is open shows "Accept or reject the draft first" instead of doing nothing.
6. **Focus view while adjusting the crown (F7).** In the Proposal and Adapt steps, while the tooth has a crown:
   - **Focus region.** The prep region (faces inside the margin) grown by 1.5 mm of geodesic distance, so the gum
     around the margin and the emergence profile stay readable. It is drawn at the scan's normal opacity and colour.
   - **Surroundings.** The rest of the jaw scan (gums, neighbours) and the antagonist are drawn semi-transparent and
     slightly desaturated.
     - "Surroundings" slider in the step panel: 0.1–1, default 0.4.
     - Effective opacity = the scan's own object-panel opacity × the slider.
   - **"Focus on the prep" checkbox**, default on. Off restores today's look. Leaving these steps restores it too.
   - **Crown colour.** A new `restoration` matcap in a light design blue (sRGB 0.62, 0.76, 0.95). That is ΔE76 40
     against `stone`, compared with 11 today, and it stays distinct for common colour-vision deficiencies because the
     lightness differs as well.
     - It applies in every step where the crown is shown.
     - Colour maps still replace it when one is selected.
     - The existing crown opacity slider shows the prep through the crown.

Out:
- Changing the RBF fit or making moves rigid (sealing on the margin is correct behaviour).
- A "keep adapted while moving" mode (continuous re-adaptation). Revisit after F1 ships if designers ask for it.
- Rotate and scale gizmo handles. Key auto-repeat throttling. Edits to the margin or axis during a pending review.
- Focus view in the Params and Finalize steps, and a user-selectable crown colour. Both are easy to add later through
  the same settings.

## Design

- **Step-aware request.**
  - One helper in `apps/web/src/tools/context.ts` decides whether the adaptation applies: the tooth has adapt
    targets and `steps.adapt === 'done'`.
  - `crownTool` already re-derives on every `crown` change. It must also re-derive when `steps.adapt` changes, so the
    steps join its input key.
- **Re-adapt command.**
  - No new command. Re-adapt dispatches the existing `adaptOcclusion` / `setContact` commands for the stored targets
    as one batch, which is one undo entry.
  - The agent gets the same through its existing tools. Its system prompt (`apps/web/src/ai/prompts.ts`) adds one
    rule: after a pose change, re-apply the adaptation.
- **Open-contact report.**
  - `findConflict` already measures the post-enforcement minimum clearance. `designCrown` sets
    `open = { clearanceMm }` when that minimum is more than target + `ADAPT_OPEN_TOLERANCE_MM` (0.05).
  - `CrownAdaptReport` gains the optional `open`. `adaptGate` fails on `conflict` or `open`.
- **Preview deformation.**
  - `crownTool` keeps the last result's base positions and a `Float32Array` of weights per vertex.
  - `previewMove(delta)` writes `base + w·delta` into the position attribute and requests a render. On about 10k
    crown vertices this costs well under 1 ms per pointer move.
  - `Viewer.previewOffset` stays for other objects. The gizmo stops using it for the crown.
- **Transaction-aware edits.** `userEdit(cmds)` lives in `apps/web/src/tools/nudge.ts` and is used by `nudge`, the
  gizmo commit and Re-adapt. It reads `useOrchestrator` and the assistant store to tell pending from running.
- **Focus faces (worker).**
  - New call `focusFaces(jawSha, margin, occlusal, bandMm)` returns a `Uint32Array` of jaw face ids: the cached prep
    region grown by geodesic distance. It reuses the Dijkstra growth that `ignoredPrepFaces` already does in
    `apps/web/src/geometry/crown.ts`, extracted into a shared `growRegion` helper in `geometry/prepRegion.ts`.
  - Ids are in the jaw's BVH index order, so they index the displayed geometry directly. The list is a few thousand
    ids, not a mask over every face, so the transfer stays small.
- **Focus rendering (viewer).** `Viewer.setObjectFocus(id, faces | null, { contextOpacity, desaturate })`:
  - **Focus overlay.** A child mesh with an index-only geometry built from `faces`. It shares the jaw's position,
    normal and colour attributes. It is drawn opaque with the scan's normal material and a slightly smaller polygon
    offset, so it wins the depth test over the jaw's own copy of those faces.
  - **Context.** The jaw mesh itself is drawn with the context opacity and desaturation, through a new `uDesaturate`
    uniform in `createSurfaceMaterial`.
  - **Picking is unchanged.** The jaw mesh stays the raycast target, and the overlay has raycasting disabled. Orbit
    points, the gizmo hit test and tool clicks behave as today.
  - **Antagonist.** It gets the context look only (`faces = null` with a context opacity).
- **Wiring.** `apps/web/src/tools/controller.ts` already switches the look per step (it hides the antagonist in the
  prep steps), so the focus view is applied there. It is keyed on step, margin, crown presence and the two settings.
  The settings live in `toolStore` and are session-only.

## Verification plan

- **Unit**
  - Reducer: after `adaptOcclusion` → `moveCrown`, `adapt` is stale and `crown.adapt` is kept. Re-adapt marks it done
    in one undo entry.
  - Crown request helper: no `adapt` in the request while the step is stale; present when it is done.
  - Geometry: on synthetic-36, `occlusal 1 mm` on the un-adapted crown moves the cusps 1.00 ± 0.02 mm, the middle
    0.76 ± 0.05 mm and the cervical ring < 0.1 mm. This pins down F3.
  - Geometry: re-adapting after `mesial 1 mm` reports the distal contact as `open` (about 0.9 mm), and `adaptGate`
    fails with that message.
  - Preview weights: 0 on every intaglio vertex; the preview of a delta and the recomputed crown differ by
    < 0.25 mm mean over shell vertices for a 1 mm buccal move.
  - `userEdit`: with a pending proposer transaction it commits first (two undo entries: the draft, then the move).
    While running, it refuses and leaves the document unchanged.
  - Focus faces on synthetic-36:
    - They contain every prep-region face.
    - None is more than 1.5 mm (geodesic) outside the margin.
    - They contain no face of the neighbour crowns.
  - Colours: ΔE76 between the `restoration` and `stone` matcap base colours is ≥ 30.
- **Browser** (extend `tools/e2e/ai-flows.mjs`)
  - Auto-design, then drag the gizmo 1 mm occlusal *without* Accept:
    - the draft is auto-accepted;
    - the crown never snaps back during the recompute (sample the crown bounding box every 50 ms after release);
    - the cusps rise about 1 mm;
    - Adapt shows stale and the occlusion map shows the new penetration;
    - Re-adapt brings it back to 0.05 mm;
    - Ctrl+Z three times returns to the pre-Auto-design document.
  - Move 0.5 mm mesial, then Re-adapt: the "distal contact open" warning is shown and the QA row is red.
  - Repeat the user's case on the new build with each input (gizmo, nudge pad and arrow keys), before and after
    Accept. Confirm with the user that it no longer looks wrong. If it still does, record the exact steps here as F8.
  - Focus view, by screenshot pixel sampling in the Proposal step:
    - neighbour-tooth and antagonist pixels are lighter and less saturated than with focus off;
    - prep-tooth pixels next to the margin are unchanged;
    - crown pixels are blue, and the prep is not.
    Also check that orbit about a point on a dimmed neighbour, the gizmo and the nudge keys still work with focus on.
    Turning focus off, or leaving the step, restores the object-panel opacities exactly.
  - Perf on the 1M-triangle synthetic scan: focus faces plus the overlay build in < 100 ms, and orbiting stays smooth
    with focus on.
- **Regression:** `pnpm typecheck`, `pnpm test`, `pnpm pipeline --auto`, and the offline and online E2E scripts.

## Decisions

- **After a move the crown is shown without adaptation, with Re-adapt available** (user, 2026-10-14). Continuous
  re-adaptation stays out of scope.
- **All three inputs are affected, even before Accept** (user, 2026-10-14). So F1, F3 and F6 are all in scope, and
  F4 for the gizmo.
- **Focus view and a distinct crown colour are in scope** (user request, 2026-10-14). The specific values (1.5 mm
  band, 0.4 surroundings, design blue) are this spec's defaults; the slider and checkbox let the designer adjust them.

## Implementation summary

### What was built
- **Adaptation follows the step status (F1).**
  - `apps/web/src/design/adaptation.ts`: `activeAdapt`, `adaptationStale` and `readaptCommands`. The crown request
    in `tools/crownTool.ts`, the agent's `crownTool.evaluate` and the proposers' `crownRequest` all send the targets
    only while `steps.adapt` is done. The crown's input key includes `steps.adapt`.
  - **Re-adapt.** `reAdapt()` in `tools/nudge.ts` re-dispatches the stored targets as one batch. The
    `ReadaptNotice` (`ui/steps/CrownViewControls.tsx`) is shown in the nudge pad, the Adapt step and the Finalize
    step.
  - **Agent.** Metrics carry `adaptation: 'applied' | 'stale' | 'none'`, the tool summary says when it is off, and
    the prompt asks the agent to re-apply it after a pose change.
- **Open contacts (F2).**
  - `designCrown` sets `open: { clearanceMm }` when the post-enforcement minimum is more than target +
    `ADAPT_OPEN_TOLERANCE_MM` (0.05 mm, `geometry/adapt.ts`), and adds a warning ("Distal contact open: 0.91 mm …
    move the crown distally and re-adapt").
  - `adaptGate` fails on it. The Adapt step, the agent's conflict list and the pipeline's `crown.adapt.*` check show
    it too.
- **Preview = result (F3, F4).**
  - `designCrown` returns `moveWeights`: how far each vertex follows a translation of the pose. It is the RBF fit's
    response to a unit ring displacement, solved with the fit (`solveRbfFields` / `evaluateRbfFields` in
    `geometry/rbf.ts` share one LU and the kernel evaluations).
  - `crownTool.applyPreview` shows `base + w · offset`. The offset is any pending document move (the pose differs
    from the displayed result's by a translation only) plus the gizmo drag.
  - `TranslateGizmo` no longer offsets the whole crown. It reports `onDrag(delta | null)` to
    `crownTool.previewDrag`.
- **Gizmo on the crown (F5).** `crownTool.gizmoAnchor()` is the centroid of the displayed crown's cusps (move
  weight ≥ 0.95) plus the pending move. `gizmoTool` re-syncs on each new result (`crownTool.onResult`).
- **Edits during a draft (F6).**
  - `userEdit()` (`tools/nudge.ts`) is used by the gizmo, the nudge pad, the keys, Re-adapt and the Adapt-step
    buttons. It first accepts a pending auto-design or assistant draft, with the message "Auto-design accepted; your
    edit is a separate undo step". While either is still running it refuses the edit.
  - Ctrl+Z with an open draft shows "Accept or reject the open draft first", and the toolbar's undo and redo are
    disabled with that tooltip.
- **Focus view and crown colour (F7).**
  - `tools/focusTool.ts` drives the view in the Proposal and Adapt steps from `toolStore.focusPrep` and
    `surroundings` (UI: `FocusControls`).
  - The worker's `focusFaces` returns the prep-region face ids.
  - `Viewer.setObjectFocus` draws a compact opaque copy of those faces. The scan itself is drawn at its opacity ×
    surroundings, greyed by a new `uDesaturate` uniform (0.6) and pushed back with polygon offset 2. The antagonist
    gets the same dimming.
  - New `restoration` matcap in design blue (sRGB 0.62, 0.76, 0.95).
- **Tooling.**
  - `crownTool` and the worker client are exposed on the dev-only `window.__dcad` hook. A dynamic `import()` from a
    test page can get a second module instance after Vite hot-updates them.
  - New browser script `tools/e2e/crown-move.mjs` (`pnpm --filter @dcad/e2e move`).

### Deviations from the spec
- **Exact preview weights from the worker**, instead of `smoothstep(0, 0.7, heightFraction)` in the main thread.
  - The fit is linear in the pose position, so the RBF's response gives the exact per-vertex weight.
  - Preview vs recompute on synthetic 36: 0.06 µm mean, 0.3 µm max (target < 0.25 mm).
  - Cost: the fit went from 28 to 35 ms. A separate second solve had cost 29 ms; sharing the factorization and the
    kernel evaluations brought that down.
- **The preview covers every input, not only the gizmo**: keys, nudge pad, undo/redo of moves and agent moves.
  Rotate and scale still wait for the recompute, because the pose then changes more than by a translation.
- **No gum band in the focus region.** The focus faces are the prep region inside the margin.
  - With the gum see-through, the 1.5 mm band showed the synthetic prep's sulcus walls under the crown, at every
    width tried (0.5, 1.0, 1.5 mm): spiky slivers with any-corner faces, scattered specks with all-corner faces.
  - The prep alone reads cleanly and is what the user asked for ("the tooth for which the crown is applied").
  - So the planned `growRegion` extraction was not needed.
- **Polygon offset.** The focus copy keeps the normal surface offset, and the dimmed scan is pushed back, instead of
  the copy being pulled forward. A smaller offset on the copy changed which surface won at the crown margin (1 of
  260 crown pixels).
- **Gizmo API.** The gizmo's own rigid preview (`objectId`, `previewOffset`) is removed; the caller previews from
  `onDrag`.
- **More places use the new rules.** The Adapt-step buttons and "Reset adaptation" go through `userEdit`, and the
  Finalize step shows the Re-adapt notice.
  - This is a behaviour change. After a parameter edit, export uses the un-adapted crown until Re-adapt; before,
    stale targets were still applied silently.
- **Helper location.** The helpers are in `design/adaptation.ts` (pure and unit-tested), not `tools/context.ts`.

### Verification
- **Commands.** Run on a clean worktree of `HEAD` plus this change only. A concurrent test-cleanup session was
  editing other test files in the same checkout.
  - `pnpm typecheck` clean.
  - `pnpm test`: 6 shared, 218 web (2 skipped), 20 API unit, 2 pipeline.
  - `pnpm pipeline --synthetic --auto`: 2/2. All `crown.adapt.*` checks reach the target and none is open.
- **New unit tests (10).**
  - `crown.test.ts`, 3 tests:
    - an occlusal 1 mm move: cusps 1.00 ± 0.02, middle 0.76 ± 0.05, cervical < 0.1 mm;
    - move weights predict a 1 mm buccal move to 0.06 µm;
    - re-adapting after mesial 1 mm reports the distal contact open at 0.91 mm, and the gate fails.
  - `rbf.test.ts`: several fields solved together equal solving each alone.
  - `reducer.test.ts`: targets apply only while adapt is done; Re-adapt is one undo entry and keeps the move.
  - `qa.test.ts`: open contact and nothing within reach.
  - `nudge.test.ts`, 3 tests:
    - an edit during a pending auto-design is accepted first and gets two undo entries;
    - the same with an assistant draft;
    - an edit while auto-design is running is refused.
  - `matcap.test.ts`: the crown and the stone colour differ by ΔE76 ≥ 30.
- **Browser, `crown-move.mjs`: 30/30 checks pass** on the 1M-triangle demo, offline, headless Chrome.
  - **Auto-design left pending.**
    - Shift+↑ accepts the draft (two undo entries).
    - The cusps move 0.4991 mm buccal on screen while the recompute is still running.
    - The result comes back without adaptation, and Re-adapt is offered.
    - Ctrl+Z ×2 and redo behave.
  - **Gizmo drag.**
    - It commits 0.956 mm occlusal; the preview matches it (0.954 mm).
    - The crown never snaps back: the minimum is 0.954 mm over 391 samples during the recompute.
    - The gizmo is on the cusps (0.0000 mm).
    - The occlusion map shows −1.678 mm (penetration); Re-adapt brings it back to 0.050 mm.
  - **Nudge pad.** After 1 mm mesial and Re-adapt, the distal contact is reported open at 0.887 mm.
  - **Focus view, pixel classes by ray hit, focus on vs off.**
    - Surroundings: contrast to the background 75.6 → 28.1, saturation 0.207 → 0.027.
    - Antagonist: contrast 112.6 → 44.4.
    - Prep, with the crown hidden: 99.8% of 619 pixels unchanged.
    - Crown: B − R = 51.6, 98.8% unchanged (the rest are antialiased silhouette pixels).
  - **Other focus checks.**
    - Unticking the checkbox or leaving the steps restores the object-panel look exactly.
    - Orbit from a dimmed neighbour and the arrow keys still work.
    - Focus faces + overlay: 2 + 5.5 ms for 53k faces on the 1M-triangle scan.
- **Browser, `offline-design.mjs`: passes** (frame, margin, axis, crown, keyboard nudge 0.5000 mm and undo, rotate,
  gizmo drag as one undo entry, adapt, project zip, cement gap, export). The only console errors are the expected
  502s for `/api/me` with no API running.
- **Not run.**
  - `online-case.mjs` and `ai-flows.mjs`: they need the API and Postgres.
  - The trimesh check of the exported STL: trimesh is not installed. Mesh validity is covered by the crown tests and
    the in-app validation.

### Follow-ups
- Previews for rotate and scale (the pose then changes more than by a translation).
- A "keep adapted while moving" mode if designers ask for it.
- Check the focus view on real intraoral scans. If their sulcus is clean, consider a thin gum band with all-corner
  faces.
- The test-cleanup spec ([2026-10-14-test-cleanup.md](2026-10-14-test-cleanup.md)) deferred this change's test
  files until it is committed. Its criteria now apply to them, including the new tests.
