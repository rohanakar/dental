# Critique leftovers: one primary, one "first" message, the pontic base's real target

Status: **done** (2026-10-26, merged 2026-10-27). Merged onto main after the natural-margin work. The merge applied
cleanly, with 120 tests, `first-run`, `ai-bridge` and `bridge` passing (`bridge` once flaked on a navigation race
after all its checks, and passed when re-run).

## Goal

Close three P2 leftovers of the critique re-run (`.impeccable/critique/2026-10-26T12-40-15Z__apps-web-src-ui-app-tsx.md`)
and the follow-ups of `specs/2026-10-26-undo-and-check-numbers.md`.

1. **Two primary buttons on one screen.** DESIGN.md's "The Tint Is Not The Fill Rule" allows one solid primary per
   step. The critique saw two on:
   - Insertion axis: "Least undercut" and the footer's "Next: Parameters";
   - Finalize after an export: the ending's "Create an account" and "Export STL";
   - offline Case setup: "Next: Scans" and the viewport's "Load demo scans".
2. **Two "… first" messages that disagree.** After a jump with the rail, a panel's own guard line ("Set the insertion
   axis first.") can name a different step from the footer's "This step needs Tooth frame first."
3. **The pontic-base check's hidden tolerance.** It shows target − 0.02 mm as its limit.

## Scope

**In:**
- the footer's Next and "Go to …" yield to the step panel's own primary;
- Insertion axis, Finalize (crown and bridge) and the viewport's empty state;
- the panels' guard lines (Tooth frame, Margin, Insertion axis, Crown proposal, Adapt, Finalize);
- the pontic-base check's threshold, tolerance and message.

**Out:**
- every other critique finding;
- the pass rules;
- the pipeline runner's own pontic checks;
- the assistant's "Send", which is its own form inside the panel. DESIGN.md allows one primary per form.

## Design

### One primary
- **Footer** (`ui/StepFooter.tsx`): a `MutationObserver` on the sibling `.step-panel` sees whether the panel shows a
  visible `.btn.primary` outside the assistant section.
  - While it does, Next and "Go to …" are plain buttons.
  - This keeps every panel, including the draft review in `ui/ai/AutoDesign.tsx`, unchanged. It covers "Auto-design
    crown" on Tooth frame too.
  - A CSS `:has()` rule was rejected: it would restyle the button and leave the `primary` class lying to scripts.
- **Insertion axis** (`ui/steps/AxisStep.tsx`): "Least undercut" is primary only until an axis exists, as "Propose
  crown" is. With an axis, "Next: Parameters" is the primary.
- **Finalize** (`ui/steps/FinalizeStep.tsx`, `BridgePanels.tsx`): Export STL is no longer primary once this document
  is exported (`useIsExported`, the same condition that shows the ending). The ending's own action is the primary:
  "Create an account" offline, "Back to cases" signed in.
- **Viewport** (`ui/Viewport.tsx`): "Load demo scans" is primary only on Scans. On Case setup the step's action is
  Next; on later steps it is the footer's "Go to Scans".

### One "first" message
- `useMissingStep()` in `ui/StepFooter.tsx` returns the earliest missing step, the footer's `missingBefore`.
- `NeedsFirst` renders a panel's guard line only when there is no missing step. When there is one, the footer's strip
  is the one message.
- The six guard lines use it. The line stays as a fallback, for example when a scan is still loading.

### Pontic base
- `bridge.ponticBase.<fdi>` (`ai/qa.ts`) gets `threshold` = the target (`ponticRidgeGapMm`), `bound` = `min` and
  `tolerance` = `PONTIC_BASE_TOLERANCE_MM`.
- The message names the upper side of the window, so a base floating above the ridge does not fail with numbers that
  look like a pass.
- The pass rule is unchanged: the smallest gap is from target − 0.02 to target + 0.05 mm, and the mean gap is at
  least target − 0.02 mm.

## Verification plan

- `pnpm typecheck`, `pnpm test` (115: 103 pass, 12 skipped) and `pnpm --filter @dcad/web build`.
- **Tests:** none new; the pass rules are unchanged. One assertion in the bridge part of the gates test
  (`ai/qa.test.ts`): the pontic-base check's threshold is the target, and its tolerance is 0.02 mm.
- **Browser scripts** (dev server on :5331): `first-run` (Accept stays the only primary while the draft is open),
  `ai-bridge` and `bridge`.
- **A scratch script** outside the repo counts the visible primaries on:
  - Tooth frame on arrival;
  - Insertion axis, before and after "Least undercut";
  - Finalize, before and after the export;
  - offline Case setup;
  - a rail jump to Crown proposal with missing steps (one "first" message).

## Implementation summary

All three leftovers are fixed. Every screen the critique named now has one solid primary. A jump ahead with the rail
shows one "… first" message, the earliest missing step. The pontic base shows its real target with the tolerance
named.

**What changed on each screen** (demo case 36, offline)

| Screen | Before | After |
|---|---|---|
| Tooth frame, on arrival | "Auto-design crown" and "Next: Margin" | "Auto-design crown" |
| Insertion axis, with an axis | "Least undercut" and "Next: Parameters" | "Next: Parameters" ("Least undercut" is primary only until an axis exists) |
| Finalize, after the export | "Create an account" and "Export STL" | "Create an account" (signed in: "Back to cases") |
| Offline Case setup, empty case | "Next: Scans" and "Load demo scans" | "Next: Scans" ("Load demo scans" is primary on Scans) |
| Crown proposal, reached with the rail | "Set the insertion axis first." and "This step needs Margin first." | "This step needs Margin first.", with "Go to Margin" |
| Pontic base check | "(0.01 mm, minimum −0.02 mm)" | "…, at most 0.05 mm above the minimum (0.01 mm, minimum 0.00 mm, 0.02 mm measuring tolerance)" |

**Where it lives**
- **The footer** (`apps/web/src/ui/StepFooter.tsx`):
  - `usePanelPrimary` is a `MutationObserver` on `.step-panel`. While the panel shows a visible primary outside the
    assistant section, Next and "Go to …" are plain.
  - `useMissingStep` and `NeedsFirst` handle the guard lines.
- **The guard lines** use `NeedsFirst`. They are in `ui/steps/FrameStep.tsx`, `MarginStep.tsx`, `AxisStep.tsx`,
  `ProposalStep.tsx`, `AdaptStep.tsx`, `FinalizeStep.tsx` and `BridgePanels.tsx` (bridge Finalize).
- **Insertion axis:** "Least undercut" is primary until an axis exists (`ui/steps/AxisStep.tsx`).
- **Finalize:** Export STL stops being primary once the document is exported (`useIsExported`). This applies to the
  crown (`FinalizeStep.tsx`) and the bridge (`BridgePanels.tsx`). Signed in, the ending's "Back to cases" is primary.
- **The viewport:** "Load demo scans" is primary only on Scans (`ui/Viewport.tsx`).
- **The pontic base:** `bridge.ponticBase.<fdi>` in `apps/web/src/ai/qa.ts` now has threshold = target, `bound` min,
  `tolerance` `PONTIC_BASE_TOLERANCE_MM`, and a message that names the upper side. The pass rule is unchanged. The
  Finalize bridge rows (`gateDetail`) pick this up through `qaValueText`.

**Deviations from the spec**
- **Tooth frame on arrival** was a fourth two-primary screen ("Auto-design crown" and "Next: Margin"). The footer
  rule fixes it with no change to `AutoDesign.tsx`.
- **Signed in, after an export**, "Back to cases" became primary. Otherwise demoting Export would leave the screen
  with no primary.

**Verification**
- `pnpm typecheck` is clean. `pnpm --filter @dcad/web build` passes; its chunk-size warning predates this task.
- **Tests:** 115 (103 pass, 12 skipped), unchanged. No new test, because no pass rule changed. The bridge gate test
  in `apps/web/src/ai/qa.test.ts` has one more assertion: the pontic base's threshold is the target (0), with `bound`
  min and tolerance 0.02.
- **Fixtures:** generated in the worktree's own `data/`; the runner passes.
- **Browser scripts** (dev server on :5331):

  | Script | Result |
  |---|---|
  | `first-run` | 24 checks, all passed, including "Accept is the only primary action while the draft is open" |
  | `ai-bridge` | 16 checks, all passed |
  | `bridge` | 37 checks, all passed |

- **A scratch script outside the repo** passes all 15 checks. It counts the visible primaries in the side panel and
  the viewport:
  - arrival;
  - the open draft;
  - Insertion axis with an axis;
  - Crown proposal with a crown;
  - Finalize before and after the export;
  - offline Case setup;
  - Scans on an empty case;
  - rail jumps to Crown proposal, Finalize and Margin (one "first" message and one primary each).

**Follow-ups**
- **Export anyway with a stale adaptation** leaves two primaries after the export: the ending's "Create an account"
  and the Re-adapt notice's "Re-adapt". Both are inside the panel. The scratch script found this when it re-ran
  Least undercut after Accept.
- **The assistant's "Send"** stays primary beside Next online (its own form). The pipeline runner's pontic checks
  still print target − 0.02 as their limit.
