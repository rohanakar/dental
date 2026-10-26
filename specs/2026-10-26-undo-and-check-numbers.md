# Undo and Reject that land somewhere sensible, and check numbers that agree

Status: **done** (2026-10-26).

## Goal

Fix the two P1 findings of the critique re-run
(`.impeccable/critique/2026-10-26T12-40-15Z__apps-web-src-ui-app-tsx.md`, 29/40). Background:
`specs/2026-10-26-new-user-journey.md` and `specs/2026-10-26-plain-check-wording.md`.

1. **Undo and Reject strand the user.** After Undo of an accepted auto-design draft, or after Reject, the user sees all
   of these at once:
   - the status line still says "Draft accepted…" (or "Draft rejected…");
   - the panel says "Set the insertion axis first.";
   - the footer says "This step needs Tooth frame first.";
   - the occlusal-clearance legend floats over a scene with no crown;
   - the camera stays on the proposal close-up.
2. **The draft's checks disagree with the product's own numbers.**
   - Thickness is gated at "limit 0.48", while Parameters and Finalize say "Zirconia minimum 0.50 mm".
   - Four checks repeat between steps, so the demo claims 18 checks.
   - Values are bare: "(42.79, limit 120)".
   - The landing says "five measured checks".

## Scope

**In:**
- Reject and Undo of an auto-design draft return to the step the run started from, or to the earliest step before it
  that is not done.
- Undo and redo replace the stale notice.
- The crown legend goes with the crown.
- The QA check gets an optional unit, bound and tolerance; the review and the Finalize bridge rows format them.
- The thickness check shows the material minimum and names its tolerance.
- The review counts and lists each check once.
- The landing's claims and its two captures of the review.

**Out:**
- The critique's "lead with Ready to mill's 7 rows, fold the gates into a sub-disclosure" (a review redesign, its P2).
- Pass rules and check ids (unchanged).
- The panels' own prerequisite lines when the user jumps ahead with the rail ("Set the insertion axis first" beside
  the footer's "needs Tooth frame"). Undo and Reject no longer land there.
- The pontic-base check's tolerance (`ai/qa.ts`, the same pattern as the old thickness limit), the pipeline runner's
  own checks, and every other message.

## Design

### Undo and Reject
- **Origin** (`ai/orchestrator.ts`): `execute` records the step and tooth on screen when the run starts, and the
  run's label.
  - `reject()` returns the origin.
  - `accept()` maps the committed document to the origin (a `WeakMap`), so `draftCommitted(doc)` tells an undo from
    that document that it takes the draft back. This covers every accept path, including the nudge's auto-accept.
- **Where the user lands** (`ui/history.ts`, new): `returnTo(origin)` selects the tooth and opens
  `missingBefore(origin.step) ?? origin.step`. A step with nothing missing before it has one next action, and the
  footer shows no "needs … first".
  - In the demo the origin is Tooth frame. The controller's existing step change looks down on the jaw and rings the
    prep, because the document changes before the step.
- **Undo and redo** (`ui/history.ts`, used by the keyboard in `App.tsx` and the buttons in `Toolbar.tsx`):
  - Both keep the open-draft guard: a warning while a draft is open.
  - Undoing a draft returns to its origin and says "Undone: auto-design.".
  - Redoing it returns to the step it was undone from and says "Redone: auto-design.".
  - Any other undo or redo clears an info notice, because the notice described the change it replaced. Warnings and
    errors stay.
- **Reject** (`ui/ai/AutoDesign.tsx`): it returns to the origin, then shows the notice it already had. The step is set
  before the notice, so the status line keeps the notice.
- **Legend** (`tools/crownTool.ts`): `applyVisibility` counts the crown as visible only while it has a mesh, so
  clearing the crown also removes its legend. The bridge path already does this.

### Check numbers
- **Schema** (`packages/shared/src/proposer.ts`): three optional fields on `QaCheck`.
  - `unit`: `mm`, `mm2`, `um`, `deg` or `fraction` (0–1, shown as a percentage).
  - `bound`: `min` or `max`, the side of `threshold` that passes.
  - `tolerance`: a measuring tolerance; a value that far past the threshold still passes.
- **Formatter:** `qaValueText(check)`, next to the schema so geometry code can use it too. Examples:
  - "1.01 mm, minimum 0.50 mm, 0.02 mm measuring tolerance";
  - "42.79°, maximum 120°";
  - "100%, minimum 75%";
  - a count reads "0, limit 0".
  - Millimetres take two decimals, as in Parameters and Finalize. Values below 0.01 take two significant digits.
- **Who uses it:**
  - the review (`checkValue`);
  - the Finalize bridge rows (`ui/steps/restorations.ts`, `gateDetail`);
  - the wing and inlay failure lines (`geometry/bridgeUnion.ts`).
- **Units on every check with a value.** The checks are in `ai/qa.ts`, `ai/proposers.ts`, `geometry/wingUnit.ts`
  and `geometry/inlayChecks.ts`. Each message loses its ", in mm" or ", in degrees" ending, because the value now
  carries the unit.
- **Thickness:**
  - `threshold` is the material minimum (`params.minThicknessMm`), `bound` is `min`, and `tolerance` is
    `THICKNESS_TOLERANCE_MM` (0.02).
  - The pass rule stays `min ≥ minimum − 0.02`.
- **Each check once** (`latestChecks` in `ai/qa.ts`):
  - A check that a later row of the run measures again is shown only on that last row, so the review shows the final
    crown's numbers. Rows are told apart by tooth (a bridge's per-abutment rows).
  - `axis.prepClosed` counts as `margin.closed` (one measurement of the same closure).
  - The verdict count and "Show the checks (N)" use the result. The demo goes from 18 to 14.
- **Landing** (`apps/web/index.html`):
  - The description and the lede drop the number ("passes its measured checks").
  - The checks table is "Five of the checks".
  - The hero card keeps "5 of 5": it counts its own five rows.
  - The two captures of the review (`draft-banner.webp`, `auto-design.webp`) are re-shot with
    `tools/e2e/landing-shots.mjs`, with their alt text, sizes and provenance updated.

## Verification plan

- `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.
- **Tests** (113 now: 101 pass, 12 skipped):
  - **New** (1), in `ai/qa.test.ts`: `latestChecks`. A crown run counts the repeated crown checks and the closure
    once, and keeps the adapted thickness. A bridge's two margin rows stay separate.
  - **Extended:**
    - `ai/qa.test.ts`, the gates test: the thickness check's threshold is the material minimum, and 0.49 mm passes a
      0.50 mm minimum.
    - `ai/orchestrator.test.ts`: accept maps the committed document to the origin; reject returns it.
- **Browser scripts** (dev server on :5321): `ai-bridge` (Reject from the footer), `ai-implant`, `ai-framework`,
  `crown-move`.
  - `crown-move` gets one check, after its Ctrl+Z of the draft: Tooth frame, the "Undone" notice and no legend. Redo
    returns to Crown proposal, which the script's gizmo part needs.
  - A scratch script outside the repo covers Reject on the demo: Tooth frame, no legend, nothing missing.

## Implementation summary

Both P1 findings are fixed.
- **Reject and Undo** of a draft now land on Tooth frame in the demo, the step the run started from. The camera looks
  down onto the jaw, the prep is ringed, and the notice names what happened. No legend and no "needs … first" are
  left.
- **The draft review** counts each check once (14 in the demo, was 18). Every value carries its unit, and thickness
  is shown against the material minimum with the tolerance named.

**What was built, and where**
- **Origin and committed drafts** (`apps/web/src/ai/orchestrator.ts`):
  - `DraftOrigin` holds the step, the tooth and the label.
  - `reject()` returns the origin.
  - `draftCommitted(doc)` is filled by `accept()`.
- **Undo, redo and the landing step** (`apps/web/src/ui/history.ts`, new): `returnTo`, `undo` and `redo`, used by
  `ui/App.tsx` (keyboard), `ui/Toolbar.tsx` (buttons) and Reject in `ui/ai/AutoDesign.tsx`.
- **Legend:** one condition in `crownTool.applyVisibility` (`apps/web/src/tools/crownTool.ts`).
- **QA check:** `unit`, `bound` and `tolerance` in `packages/shared/src/proposer.ts`, with `qaValueText`.
- **Units on every check with a value:**
  - `apps/web/src/ai/qa.ts`, which also adds `THICKNESS_TOLERANCE_MM` and `latestChecks`;
  - `ai/proposers.ts` (frame, pontic handedness, axis divergence);
  - `geometry/wingUnit.ts`;
  - `geometry/inlayChecks.ts`.
- **Formatted values outside the review:** the Finalize bridge rows (`ui/steps/restorations.ts`) and the wing and
  inlay failure lines (`geometry/bridgeUnion.ts`).
- **Landing:** `apps/web/index.html` has the claims, the alt text and the new height. `draft-banner.webp` and
  `auto-design.webp` are re-shot, with their `.json` provenance updated.

**Before and after** (demo case 36):

| Check | Before | After |
|---|---|---|
| Verdict | Draft ready: all 18 checks passed | Draft ready: all 14 checks passed |
| `crown.thickness` | Thinnest material away from the margin, in mm (1.01, limit 0.48) | Thinnest material away from the margin (1.01 mm, minimum 0.50 mm, 0.02 mm measuring tolerance) |
| `margin.smooth` | No kinks: sharpest bend in the margin line, in degrees (42.79, limit 120) | No kinks: sharpest bend in the margin line (42.79°, maximum 120°) |
| `margin.ridge` | … share of the way round (1, limit 0.75) | … share of the way round (100%, minimum 75%) |
| After Undo | "Draft accepted. Undo …" on Crown proposal, legend, "needs Tooth frame first" | "Undone: auto-design." on Tooth frame, looking down at the ringed prep (cos 0.96), no legend |

**Deviations from the spec**
- **Wing thickness:** `wing.<fdi>.thickness` had the same hidden 0.02 (shown as "limit 0.48"). It now shows the wing
  minimum with the named tolerance, under the same pass rule.
- **No-break spaces:** values keep their unit, and "minimum" keeps its value, on one line. The first capture had
  "75%)" alone on a line.
- **`auto-design.webp`** is now 626 × 636 (was 674). The margin row lost its closure check to Insertion axis, its last
  run.

**Verification**
- `pnpm typecheck` is clean. `pnpm --filter @dcad/web build` passes; its chunk-size warning predates this task.
- **Tests:** 114 (102 pass, 12 skipped without infrastructure), up from 113 (101 pass).
  - **New** (1): `ai/qa.test.ts`, "the review counts each check once, on its last run".
  - **Extended:** the crown gate in `ai/qa.test.ts` (0.49 mm passes a 0.50 mm minimum, threshold 0.5, tolerance
    0.02); accept and reject in `ai/orchestrator.test.ts` (the origin).
- **Fixtures:** generated in the worktree's own `data/`; 8/8 runner cases pass.
- **Browser scripts** (dev server on :5321), every one passes:

  | Script | Checks passed |
  |---|---|
  | `crown-move` | 31 (+1: undoing the draft goes to Tooth frame with its notice and no legend; redo returns to Crown proposal) |
  | `ai-bridge` | 16 (Reject from the footer) |
  | `ai-implant` | 13 |
  | `ai-framework` | 6 |
  | `first-run` | 24 ("all 14 checks passed") |
  | `ai-maryland` | 7 |

- **A scratch script outside the repo** (demo, 6 checks) passes:
  - 14 checks counted once;
  - Reject: Tooth frame, cos 0.96, ring, no legend, nothing missing;
  - Undo: the same, plus "Undone: auto-design.";
  - Redo: Crown proposal;
  - a raw store undo on Crown proposal leaves no legend. With the `crownTool` line reverted, this last check fails.

**Follow-ups**
- After Reject or Undo, one-click stays unchecked: the click disarms it in `tools/frameTool.ts`, as before, so a click
  sets the frame only. Re-arming it belongs with the critique's P2 on the silent uncheck.
- If the auto tooth frames set a frame on entering Tooth frame, `returnTo` lands there too. A frame set by that
  dispatch would clear the redo of an undone draft.
- The panels' prerequisite lines still differ from the footer when the user jumps ahead with the rail.
- The pontic base still gates at the target − 0.02 mm, shown as the limit.
- The critique's review redesign (Ready to mill's rows first, the gates folded) is still open.
