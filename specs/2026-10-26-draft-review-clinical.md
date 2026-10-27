# The draft review leads with the clinical checks; one-click stays armed after a draft

Status: **done** (2026-10-26, finished and merged 2026-10-27).

## Goal

Two leftovers of the critique re-run (`.impeccable/critique/2026-10-26T12-40-15Z__apps-web-src-ui-app-tsx.md`), which
`specs/2026-10-26-undo-and-check-numbers.md` left out.

1. **The draft review leads with the clinical rows** (the P1 "checks disagree" fix list and the P2 "draft decision is
   buried"). Today the review shows a verdict ("Draft ready: all 14 checks passed"), one sentence, Accept and Reject,
   and "Show the checks (14)", which folds every proposer's checks. Technicians judge a design by Finalize's "Ready to
   mill" rows (`millReadiness`: margin, axis, solid, thickness, occlusion and the contacts, with their values). The
   review should show those rows, computed on the draft, so the draft and Finalize show the same numbers.
2. **One-click stays armed.** A click on the prep with one-click armed unchecks the box before the run
   (`tools/frameTool.ts`). After Reject or "Keep the draft" it stays unchecked, so the next click on the prep only sets
   the frame.

## Scope

**In:**
- The review (`ui/ai/AutoDesign.tsx`, `Review`) of a single unit whose draft has a crown: the verdict, the clinical
  rows, Accept and Reject, then "Show the step checks (N)" folding the proposers' checks.
- One source for the rows: Finalize's row computation and its list move to a shared file, used by both.
- A row whose input is being measured (the axis, or the crown while it recomputes) reads "Measuring…".
- Re-arming one-click after Reject, Undo or "Keep the draft" of a run started by a one-click.

**Out:**
- A bridge draft (Finalize has per-unit groups and the union gate): its review is unchanged.
- A draft stopped before it has a crown: no rows (nothing to measure); it keeps its sentence and failing checks.
- Accept of a complete draft: one-click stays as the click left it (the tooth now has a crown).
- The editing controls beside the review, the gizmo, and the step checks themselves.

## Design

- **Shared rows** (`ui/steps/ReadinessList.tsx`, new):
  - `useCrownReadiness()`: the active tooth's rows, as `CrownFinalize` computes them today (`millReadiness`, the
    implant and inlay rows, the axis measured with `axisTool.measure()`). The axis row reads "Measuring…" while it is
    measured; the crown rows (solid, thickness, occlusion, contacts) read "Measuring…", not measured, while the crown
    recomputes.
  - `ReadinessList({ items, compact })`: moved from `FinalizeStep.tsx`. `compact` drops the "Ready to mill" head (the
    review's verdict is the head) and the id, and puts each row on one line where it fits, in small type.
- **Review:** a complete draft drops its sentence ("Look it over on screen…") for the rows, so the panel grows by
  about the rows' height. A stopped draft keeps its sentence and failing checks, then the rows if it has a crown. The
  fold is "Show the step checks (N)".
- **One-click** (`ai/orchestrator.ts`, `ui/history.ts`, `ui/ai/AutoDesign.tsx`): `DraftOrigin` gets `oneClick`, true
  when the run had a seed click (only an armed one-click starts a run with a seed). `accept()` returns the origin, as
  `reject()` does. `returnTo` (Reject and Undo) and "Keep the draft" re-arm one-click (`autoArmed`, `framePick:
  'seed'`) for a one-click origin. `frameTool.ts` is unchanged.

## Verification plan

- `pnpm typecheck`, `pnpm test` (115: 103 pass, 12 skipped), `pnpm --filter @dcad/web build`.
- **Tests:** no new test. Extended: `ai/orchestrator.test.ts`, the accept and reject cases assert the origin's
  `oneClick` (true for a seed run), and accept returns it.
- **Browser scripts** (dev server on :5332): `first-run` (verdict, folded step checks, Accept the only primary; plus
  the clinical rows shown with values), `ai-bridge`, `ai-implant`, `crown-move`, `landing-shots`.
- The review's height on the demo at 1400 × 900, before and after; Reject re-arms one-click (a scratch check).

## Implementation summary

**What was built** (branch `worktree-agent-a3ba4d1b43fb71713`, by an agent on 2026-10-26; finished and merged on
2026-10-27):
- **Shared rows:**
  - `ui/steps/ReadinessList.tsx`: `ReadinessList` and `useCrownReadiness`;
  - used by Finalize, and by the draft review in compact form;
  - a row being measured reads "Measuring…".
- **The review** (`ui/ai/AutoDesign.tsx`): a complete draft shows the verdict, the clinical rows, Accept and Reject,
  then "Show the step checks (N)".
- **One-click re-armed:**
  - `DraftOrigin.oneClick`;
  - `rearmOneClick` after Reject, Undo, and "Keep the draft" of an unfinished one-click run;
  - `accept()` returns the origin.
- **The merge with today's work:**
  - the shared list carries the natural-tooth note (`note`), and the readiness gets the gum-line rule (`marginLine`);
  - Finalize keeps the critique leftovers' "Propose a crown first" message (`NeedsFirst`) and its single primary
    button after an export.

**Measured** (the demo at 1400 × 900, a complete draft): the review is 321 px and 88 words, up from 135 px and 24
words, as designed. The rows replace the sentence, and the panel still fits the sidebar. Reject re-arms one-click.

**Verification:**
- `pnpm typecheck` clean; `pnpm test` 124. `ai/orchestrator.test.ts` was extended: accept returns the origin with
  `oneClick`, the committed draft and Reject carry it, and Reject re-arms one-click.
- **`first-run`** now also checks that the review shows the clinical rows with their values.
- **Browser scripts:**
  - with the frames work: `first-run`, `crown-move`, `ai-bridge`, `bridge`, `implant`, `ai-implant`, `maryland`,
    `ai-maryland` and `inlay` pass;
  - `ai-implant` now turns auto frames off for its one-click flow, because scan bodies are now framed on load.
