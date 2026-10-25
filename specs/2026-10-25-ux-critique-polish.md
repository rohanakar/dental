# UX critique and polish of the web app

Status: **done** (2026-10-25).

## Goal

An impeccable critique of the editor (`apps/web`) scored it 24/40 ("Acceptable"). It found four P1 issues and one P2
(snapshot: `.impeccable/critique/2026-10-25T15-58-45Z__apps-web-src-ui-app-tsx.md`). This task fixes them in one
refinement pass that keeps the incumbent look but sharpens it into a more precise instrument.

## Decisions (user, 2026-10-25)

| Question | Answer |
|---|---|
| Scope | All four areas: component polish, colour maps, ready-to-mill Finalize, AI draft review |
| Export when a clinical check fails | Soft gate: Export becomes secondary ("Export STL anyway…") and an inline confirmation names the failed checks |
| How far the visual polish goes | "Sharper instrument feel": same palette and accent, tighter type scale, tabular numbers, quieter toolbar, stronger panel hierarchy |
| Commit | Commit to main when green, only this task's files, not pushed |

## Scope

**In**
1. **Colour maps encode the clinical values.**
   - Occlusion and proximal maps draw 0 mm (contact) as the neutral colour. Today neutral sits at +0.15 mm, because
     the symmetric diverging stops are stretched over an asymmetric −0.2…0.5 mm range.
   - The thickness map draws everything below the material minimum in the warning colour.
   - The legend shows ticks at 0, the target and the material minimum.
   - The colour map can be chosen on Crown proposal, Adapt and Finalize.
2. **Ready to mill.**
   - Finalize leads with a checklist built from the existing QA gates (`apps/web/src/ai/qa.ts`): margin closed, margin
     seats along the axis, watertight with no self-intersections, thickness against the material minimum, occlusion
     and contacts adapted. Each row shows its measured value.
   - The mesh internals move into a "Mesh details" disclosure.
   - Export is primary only when every check passes. Otherwise it reads "Export STL anyway…" and asks for an inline
     confirmation that lists the open checks.
   - After an export the panel confirms the file name.
   - Entering Finalize frames the crown.
3. **AI draft review.**
   - When a one-click draft that produced a crown is ready, the editor opens Crown proposal with the occlusion map on,
     so the crown is on screen at the decision.
   - The review lists every gate with its value and threshold, not only the failed ones.
   - The step nav marks draft-touched steps as "draft", not done.
   - Accept and Reject confirm what happened, which also clears stale warnings.
4. **Component polish ("sharper instrument").**
   - Contrast:
     - `--ok-text`, `--ok` and `--warn-icon` tokens per theme replace the hard-coded `#2fbf71` and `#e0a325`, which
       measure 2.1–2.4:1 on white.
     - A `--field-border` token at ≥ 3:1 for inputs and selects (#dde1e6 measures 1.3:1).
     - The legend labels lose their 0.8 opacity.
   - Focus:
     - one `:focus-visible` ring everywhere;
     - the active step uses a tint, not an outline;
     - case-table rows get a visible focus ring.
   - Hierarchy:
     - the step title becomes a real heading;
     - one primary action per step;
     - toggles get a pressed style distinct from primary;
     - the Proposal panel runs Action → Result → Adjust → View.
   - Toolbar:
     - views and projection become quiet segmented groups;
     - the file actions use quiet buttons;
     - Save stays the one filled button.
   - Type: a tighter scale (13px body, 12px labels, 11px micro, 15px step title), tabular numerals throughout, and a
     themed selection colour, caret and scrollbars.
   - Icons: a small authored SVG set (`apps/web/src/ui/icons.tsx`) replaces the Unicode glyphs (↶ ↷ ✕ ↺ ↻ ✓ ✗ ⚠).
     Step status is drawn as CSS shapes with screen-reader text.
   - Visible state:
     - parameter fields reject an out-of-range value inline, revert it, and show the allowed range;
     - hints are visible text, not tooltips;
     - "Save failed" and "Project failed" show their reason;
     - errors use `role="alert"`.
   - Copy: remove the dev text "(enforced on Day 4)" and the scan-processing telemetry. The assistant's mock-provider
     hint shows only in dev builds. The tooth-frame hint changes once the frame is set.
   - The `.hint-box` callout loses its 3px side stripe, which the detector flagged as `side-tab`.

**Out**
- **Owned by the landing-and-journey session** (`specs/2026-10-25-landing-and-journey.md`): `App.tsx`, `SessionGate`,
  `AuthForm`, `CaseList`, `ScanImport`, the Back/Next footer and `state/session.ts`. That session reuses this task's
  token names.
- **Owned by the bridge-mode session until its wave 1 is committed:** `ToothChart.tsx`. Its touch targets get CSS
  only.
- **Deferred:**
  - collapsing the step nav;
  - an "Adapt all" action;
  - numeric move entry;
  - nudges that follow the camera;
  - gizmo axis colours that match the frame legend;
  - the margin line colour on gingiva;
  - keyboard-only frame and margin entry.
  - All of these are follow-ups.

## Design

- **Colour stops are built per map from the value range.** `apps/web/src/tools/crownLegend.ts` (new, pure) builds the
  legend spec for each crown map from the tooth's parameters: stops, range and ticks.
  - `apps/web/src/engine/colormap.ts` gains `centerStops()` and `thresholdStops()`.
  - The viewer accepts explicit stops (`setObjectScalars(..., { stops, range })`) and caches lookup textures by stops.
  - The legend draws the same stops, so the 3D colours and the legend still match.
- **The readiness gate is pure.** `apps/web/src/ui/steps/readiness.ts` (new) composes `marginGate`, `axisGate`,
  `crownGate` and `adaptGate` with the adaptation-stale flag into display rows: pass, fail, or "not measured" when
  the axis report is missing. `FinalizeStep` renders them, and the soft gate reads the same rows.
- **Draft review needs no orchestrator change.** A subscription in `apps/web/src/ui/ai/AutoDesign.tsx` reacts when a
  review opens: it switches to Crown proposal and the occlusion map when the draft has a crown. Accept and Reject
  wrappers post a confirmation through the tool message. `StepNav` reads the orchestrator's step runs to show
  "draft".
- **Tokens:** `apps/web/src/styles.css` `:root` and the dark block gain `--ok`, `--ok-text`, `--warn-icon`,
  `--field-border`, `--field-bg`, `--focus-ring`, `--accent-tint` and `--fs-*`. The journey session already
  references `var(--ok-text, …)` and `var(--field-border, …)`.

## Verification

- `pnpm typecheck`, `pnpm test` and `pnpm --filter @dcad/web build` pass, verified on a clean worktree of HEAD plus
  this task's files.
- **Tests (2 new, budget 1–3):**
  - `apps/web/src/ui/steps/readiness.test.ts`: a passing synthetic design is ready, and a thin, stale and undercut one
    fails those rows, with a missing axis report counted as not measured.
  - `apps/web/src/tools/crownLegend.test.ts`: 0 mm samples the neutral colour on the occlusion map, and a value below
    the material minimum samples the warning colour on the thickness map.
- Screenshots of the offline flow (Playwright, the same driver as `tools/e2e/offline-design.mjs`) in light and dark at
  1440 and 1280: Tooth frame with a one-click draft, Crown proposal, Adapt, Parameters with an invalid value,
  Finalize ready and not ready, and keyboard focus. Contrast pairs are recomputed for the new tokens.
- `impeccable detect --json` on the changed UI files, run once at the end.

## Implementation summary

**What was built**

*Colour maps*
- [apps/web/src/tools/crownLegend.ts](../apps/web/src/tools/crownLegend.ts) (new) builds each crown map's legend from the
  tooth: stops, range and ticks.
  - Occlusion and proximal maps are neutral at 0 mm (contact), with a solid tick at 0 and a dotted tick at the
    adaptation target.
  - The thickness map is red below the material minimum, then warm to cool as the crown gets thicker. Its tick reads
    "minimum, margin band exempt".
- [colormap.ts](../apps/web/src/engine/colormap.ts) gains `centerStops()`, `thresholdStops()` and `rangeT()`.
- `Viewer.setObjectScalars` accepts explicit stops, and caches lookup textures by stops.
- The legend draws the same stops, plus a tick key, and now sits top-right.
- [CrownViewControls.tsx](../apps/web/src/ui/steps/CrownViewControls.tsx) `MapSelect` puts the map choice on Crown
  proposal, Adapt and Finalize.

*Ready to mill*
- [readiness.ts](../apps/web/src/ui/steps/readiness.ts) (new, pure) phrases the existing QA gates as rows: margin closed,
  margin seated along the axis, watertight solid, thickness against the material minimum, and occlusion and each
  contact adapted. Each row is pass, fail, or not measured.
  - It takes a `needs` input so bridge pontics can drop the margin and axis rows (agreed with the bridge-mode session).
- [FinalizeStep.tsx](../apps/web/src/ui/steps/FinalizeStep.tsx):
  - the checklist comes first;
  - the soft gate: "Export STL" is primary only when every row passes, otherwise "Export STL anyway…" opens an inline
    box listing the open checks;
  - "Exported <file> at <time>" after an export;
  - mesh internals in a "Mesh details" disclosure;
  - the camera frames the crown on entry.
- `axisTool.measure()` runs the undercut analysis without drawing the map. It is needed because the axis report is
  cleared when the Axis step is left.
- `crownTool.export()` returns the file name.

*AI draft review*
- [AutoDesign.tsx](../apps/web/src/ui/ai/AutoDesign.tsx):
  - When a draft opens, the editor moves to Crown proposal with the occlusion map on, or to the step whose check
    failed.
  - The review card lists every gate with its value and limit, plus each step's rationale.
  - Accept and Reject post a confirmation, which also replaces stale warnings.
  - The orchestrator is unchanged.
- [StepNav.tsx](../apps/web/src/ui/StepNav.tsx) marks draft-touched steps "draft" (dashed dot and badge) instead of done.
- The assistant's Accept and Revert also confirm.

*Component polish*
- **Tokens** ([styles.css](../apps/web/src/styles.css)), measured against the panel:

  | Token | Light | Dark |
  |---|---|---|
  | `--ok` | #177245, 5.95:1 | #3cc47c, 7.3:1 |
  | `--warn-icon` | #a86400, 4.68:1 | #e0a325, 7.35:1 |
  | `--field-border` | #7b8591, 3.75:1 | #6b7684, 3.54:1 |

  Also added: `--accent-strong`, `--accent-tint`, `--focus-ring`, `--fs-*` and `--control-h`.
- **Base styles:** 13px body; tabular numerals; themed selection colour, caret and scrollbars.
- **Focus:** one `:focus-visible` ring. The active step is a tint, not an outline.
- **Buttons:**
  - quiet and segmented buttons for the toolbar;
  - pressed toggles use a tint, never the primary fill;
  - Proposal has one primary (Propose crown, or the open draft's Accept).
- **Step panels:** the step title is a 15px heading. Proposal runs Action, then Result, then Adjust, then View.
  Parameters are grouped (Fit, Thickness, Contact targets, Milling) with visible hints and an mm unit.
- [icons.tsx](../apps/web/src/ui/icons.tsx) (new) holds authored 16px SVG icons for undo, redo, close, rotate, check, fail,
  unknown, alert and camera. They replace the Unicode glyphs; step status is a CSS dot plus screen-reader text.
- **Visible state:**
  - "Save failed" and "Project failed" show their reason;
  - errors use `role="alert"`;
  - case-table rows have a visible focus ring;
  - an out-of-range parameter is reverted with "9 mm is out of range (0–0.3 mm). Kept 0.03 mm.";
  - the Tooth frame hint changes once the frame is set.
- **Copy:**
  - removed: "(enforced on Day 4)", "processed in N ms", "Processing (weld, cleanup, BVH)", the vertex counts in adapt
    reports, and the template ID and timing on Proposal;
  - the mock-provider hint shows only in dev builds;
  - the nudge pad shows its keys.
- **Layout fixes:**
  - the nudge pad is a cross like the axis tilt pad, with occlusal/cervical in their own column;
  - `.hint-box` lost its 3px side stripe;
  - the duplicate `.link-btn` rule is merged;
  - the legend labels lost their 0.8 opacity.

**Deviations**
- **Module name:** the new module is `tools/crownLegend.ts`, not `tools/crownMaps.ts`, because
  `geometry/crownMaps.ts` already computes the map values.
- **Toolbar:**
  - Projection is a single "Orthographic" toggle (aria-pressed) instead of a Perspective/Orthographic pair.
  - Screenshot is an icon button.
  - Both changes keep the toolbar on one row at 1100px. "Ortho" was rejected as an abbreviation because clinicians read
    it as orthodontics.
- **Parameters:** a rejected value is reverted, so the field is valid again. It gets an announced message rather than
  `aria-invalid`.
- **Shared map:** the `sequential` map runs warm to cool now. Only the thickness map uses it.
- **Tooth chart:** CSS only (26px tall). The bridge-mode session owns `ToothChart.tsx` until its wave 1 lands. Sixteen
  teeth in a 340px panel still space centres about 19px apart, under the 24px target-size guideline.
- **e2e:** `tools/e2e/offline-design.mjs` exports after a parameter change, so it now meets the soft gate. The
  landing-and-journey session, which has open edits in that file, was sent the confirm-click patch.

**Verification**
- `pnpm typecheck`, `pnpm test` and `pnpm --filter @dcad/web build` all pass on a clean worktree of HEAD (4137ef6)
  plus this task's files.
  - Tests: 86 passed and 12 skipped (infra), so the suite goes from 96 to 98. By package: shared 1, api 10, web 74,
    pipeline 1.
  - The build's chunk-size warning was there before this task.
- **Tests:** 2 new.
  - `apps/web/src/tools/crownLegend.test.ts` fails under the old encoding, where 0 mm sampled salmon.
  - `apps/web/src/ui/steps/readiness.test.ts`.
  - In the shared checkout, with the journey session's stepGuide test: 75 web tests pass, 1 skipped.
- `impeccable detect --json` on every changed UI file: 0 findings (was 1, `side-tab`).
- **Screenshots** of the offline flow with Playwright, light and dark at 1440, plus 1280 and 1100, all without console
  errors:
  - the review opens on Crown proposal with the occlusion map;
  - Accept posts "Draft accepted…";
  - cement gap 9 is rejected and 0.03 is kept;
  - Finalize shows "Ready to mill", 7 of 7, with values: margin 28.2 mm, 0 of 158 points in undercut, thinnest
    1.01 mm against the zirconia 0.50 mm, occlusion 0.05 mm against a 0.05 target, contacts 0.02 mm;
  - after one 0.1 mm nudge, "Not ready to mill: 3 checks open" and the inline confirm;
  - the focus ring is distinct from the active step;
  - the toolbar fits on one row at 1100px.
- The critique snapshot stays open: its target, `App.tsx`, belongs to the journey session. Close it with
  `impeccable critique-storage close` once a re-run of `/impeccable critique` confirms the score.

**Follow-ups**
- **Interaction:** keyboard-only entry for the tooth frame and the margin; nudges that follow the camera; "Adapt all";
  numeric move entry; a collapsible step nav.
- **Engine colours:** gizmo axis colours that match the frame legend (green is mesial in the frame step but occlusal on
  the gizmo); the margin line colour on pink gingiva.
- **Parameters status:** the step never turns "done".
- **QA copy:** proposer QA messages such as "Frame axes are orthonormal" need plain wording (`ai/*`, after the bridge
  waves).
- **Next runs:** `/impeccable document` for `DESIGN.md`, then `/impeccable critique` again.
