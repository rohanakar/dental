# Bridges out of the box: margins found for every abutment, auto-design as the way through

Status: **done** (2026-10-27).

## Goal

The user (2026-10-26): "Auto bridge mode does not work out of the box. I need to set up the tooth frames and margins
for all the crowns. Auto margin works, but for individual crowns. So for an auto bridge I need to select each crown,
manually set its margin, and then propose the bridge. The first crown does support auto margin, though."

A bridge should go from Case setup and scans to a proposed bridge for review with no per-abutment frame or margin
work, the same way a single crown does. Every manual tool stays available for correcting the result.

## What happens today

Measured on main 12d5821: synthetic 35–[36]–37 on `data/synthetic/lower-bridge.stl` and `upper.stl`, offline, the UI
driven step by step.

| Step | What the user sees | Manual work forced |
|---|---|---|
| Tooth frame | Frames on 35, 37 and pontic 36 set from the preps found, as one undo step (`specs/2026-10-26-auto-frames.md`). "Auto-design bridge" is present but **not** the primary; the primary is "Next: Margin". | None, if the user presses Auto-design bridge |
| Margin | Only "Click on the margin to place the first point, then work around the prep." There is **no automatic margin action**, for a bridge abutment or a single crown. | Trace each abutment by hand |
| Insertion axis | "Draw the margin first." plus "This step needs Margin first." | Blocked until every abutment has a margin |
| Crown proposal | "Draw the margin on 35, 37." The primary is a **disabled** "Propose bridge"; "Auto-design bridge" sits below it as a plain button. | Blocked |

The engine already does the whole thing:
- Pressed on Tooth frame, **Auto-design bridge passes every gate in 2.9 s**: pontic frames, margin 35, margin 37,
  common axis, bridge proposal, adaptation, connectors.
- `BRIDGE_PROPOSERS` in `apps/web/src/ai/proposers.ts` runs the margin proposer (`classical.margin-ridge@1`,
  `analysis.autoMargin`) once per abutment.

So the automatic margin exists only inside auto-design. A user who works step by step, as the wizard invites, never
meets it, and the bridge path never points to auto-design. That matches the report: a single crown is one click from
auto-design on Tooth frame, while a bridge is not.

## Scope

**In:**
1. **Margins ready for review.** Entering the Margin step (or right after the frames are set, see
   `2026-10-26-frames-from-case-setup.md`), every crown-prep tooth of the case without a margin gets the automatic
   margin, abutments and single crowns alike. It is one undo step, and each margin passes or fails its own checks.
2. **An explicit action on the Margin step:** "Find the margin" for the active tooth, and "Find all margins" in a
   bridge (every abutment without one). This is for after an undo, or to redo a traced margin.
3. **Auto-design is the way through for a bridge:**
   - Auto-design bridge is the primary action on Tooth frame once every abutment has a frame;
   - it is offered on Margin and Insertion axis too, starting from that step (`runAutoDesign({ from })`);
   - no step shows a disabled primary: on Crown proposal with margins missing, the primary is Auto-design bridge (or
     "Find all margins"), not a disabled "Propose bridge".

**Out:**
- A new margin algorithm. The automatic margin is the existing `analysis.autoMargin` with the margin proposer's
  gates.
- An automatic insertion axis on entering the step: "Least undercut, common" is one click, and auto-design covers
  it. This could follow later with the same "ready for review" pattern.
- Implant (scan body), Maryland wing and inlay or onlay units: their outlines or positions come from their own
  proposers.

## Design

### Margins ready (`tools/autoMargins.ts`, new; the same pattern as `tools/autoFrames.ts`)
- **Trigger:** the controller on the Margin step, and after auto frames land.
- **Teeth:** for each crown-prep tooth (`PREP_MARGIN`) with a frame and no margin, run the margin proposer's
  computation (`analysis.autoMargin` with the tooth's frame) and gate it with its QA (`ai/qa.ts`, margin checks).
- **Outcome per tooth:**
  - a margin that passes is set as a margin command;
  - a margin that fails is not set; the tooth is listed with its failing check in plain words ("37: the margin doubles
    back at one point; trace it by hand").
- **One dispatch:** every passing margin in one undo step.
- **Once per tooth and scan:** each tooth is tried once per jaw scan and frame (key `sha:fdi:frame`), so an undone
  margin is not put back, and a new frame allows a new try.
- **Status line:** "Margins found for 35 and 37. Check them; drag a point to adjust, or trace a tooth again."
- **Off switch:** `toolStore.autoMargins` (default on), alongside `autoFrames`, for browser scripts that exercise
  tracing.

### Margin step (`ui/steps/MarginStep.tsx`)
- "Find the margin" (single crown or active abutment) and, in a bridge, "Find all margins". Each runs the same
  computation for the teeth without a margin, or replaces the active tooth's margin after a confirm when it has one.
- The hint reads as a review once a margin exists. "Click on the margin to place the first point…" stays the hint for
  a tooth with no margin found.

### Bridge path (`ui/steps/FrameStep.tsx`, `ProposalStep.tsx`, `AxisStep.tsx`, `ui/ai/AutoDesign.tsx`)
- **Tooth frame:** `AutoDesign primary` for a bridge once `unframed` is empty. Today it is `primary={!bridge}`.
- **Margin and Insertion axis:** show the compact AutoDesign panel. It starts `from` the step, keeping the frames
  (and margins) already there.
- **Crown proposal:**
  - with a margin missing, "Propose bridge" is not primary;
  - Auto-design bridge is primary;
  - the footer's "This step needs Margin first" strip stays the one missing-step message (critique leftovers,
    branch `worktree-agent-a4d7358395fb72f96`).

## Dependencies
- `2026-10-26-frames-from-case-setup.md`: frames for every case tooth on scan load. Margins follow straight after.
- The three WIP branches in memory (critique leftovers, clinical draft review, auto frames for both jaws and
  implants). Merge them first: the primary-button rule lives in the critique-leftovers branch.

## Verification plan
- `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.
- **Tests:**
  - +1: the margins-ready selection on the synthetic bridge arch (built once). Both abutments get a passing margin as
    one batch, and a tooth whose margin fails its gate is listed, not set. Per CLAUDE.md's detector rule, one passing
    and one failing case.
- **Browser scripts:**
  - `bridge.mjs` auto part, extended: after Tooth frame, entering Margin gives margins on 35 and 37 as one undo step,
    with no clicks. Insertion axis is no longer blocked. "Propose bridge" is enabled without tracing.
  - `bridge.mjs` second check: from Tooth frame, the primary is "Auto-design bridge", and it completes.
  - Click-flow scripts turn `autoMargins` off, as they do `autoFrames`.
  - Every script passes.
- **Measure:** clicks from Scans to a proposed bridge, before (step by step: 16 margin clicks plus closes, or finding
  auto-design) and after (0 to 1).

## Implementation summary

**What was built:**
- **Margins ready for review** (`apps/web/src/tools/autoMargins.ts`, new; called from `apps/web/src/tools/controller.ts`
  after `autoFrames()` on every sync).
  - On Margin, Insertion axis and Crown proposal, every framed crown-prep tooth of the case without a margin gets the
    margin proposer's line (`marginProposer` in `apps/web/src/ai/proposers.ts`: the finish line, or the gum line on a
    natural tooth). Pontics are left out.
  - A margin that passes its checks is set. All the passing margins go out as one undo step. The others are named in
    the status line with their failing check, or the reason they threw, to trace by hand. One tooth's failure does not
    stop the rest.
  - Each tooth is tried once per jaw scan and frame origin, so an undone margin is not put back and a new frame allows
    a new try. Nothing is set into an open auto-design draft.
- **Margin step** (`apps/web/src/ui/steps/MarginStep.tsx`): "Find all margins" in a bridge, for the abutments
  without one (`findMargins`). The compact Auto-design panel is shown for a bridge, not as the primary.
- **Insertion axis** (`apps/web/src/ui/steps/AxisStep.tsx`): the "no margin yet" warning has a "Find it/them" link.
  "Least undercut" is primary only once every abutment has a margin.
- **Tooth frame** (`apps/web/src/ui/steps/FrameStep.tsx`): Auto-design bridge is the primary once every unit has a
  frame and no pontic is stale. Before that, Place or Re-place pontics in the bridge panel is the primary.
- **Crown proposal** (`apps/web/src/ui/steps/ProposalStep.tsx`): with a margin or frame missing, the primary is
  Auto-design bridge, not a disabled "Propose bridge".

**Deviations:**
- **No separate `toolStore.autoMargins` switch.** `autoFrames: false` turns both off. The click-flow scripts already
  set it, and `offline-design.mjs` now does too. One switch covers "the click flow is under test".
- **No "Find the margin" button added.** The Margin step already had one for the active tooth ("Find the margin" /
  "Find again", `marginTool.find`).
- **Auto-design on Insertion axis.** Not added: the margins are found on entering the step, and the "Find them"
  link covers a margin that was undone. The bridge auto-design is not wired with `from`. It re-runs from the pontic
  frames and keeps the abutment frames, so its draft re-proposes the margins too. That is harmless, and the draft
  review shows them.
- **The disjoint-frame check in `bridge.mjs` moved ahead of the margins.** With margins in place, the pontic layout
  goes by the margin outlines (`layoutPontics`), so a frame moved onto the wrong prep no longer flips the order. The
  outline is the better evidence, so this is correct behaviour. The script now checks the wrong order before the
  margins, then puts 37 back on its own prep.
- **Bug found in the browser:** the first version included pontic 36, which has no prep. Its throw ("No margin ridge
  found around the prep") aborted the whole batch, so neither abutment got a margin. Fixed with the pontic filter
  and a per-tooth catch. The unit test covers both.

**Verification:**
- `pnpm typecheck` clean. `pnpm --filter @dcad/web build` built.
- `pnpm test`:
  - web 93 passed and 1 skipped, of 94;
  - suite 125 with the skipped API integration tests (124 + 1).
- **Test added:** `apps/web/src/tools/autoMargins.test.ts`, "sets the passing margins as one undo step, names the
  rest, and does not put back an undone margin". The stub proposer passes 35, fails 37's gate and throws on pontic 36.
  It checks:
  - the selection leaves out the pontic;
  - only 35 is set, in one undo entry, with 36 and 37 named;
  - nothing happens on Tooth frame;
  - the automatic pass runs on Margin;
  - an undone margin is not put back.
- **`bridge.mjs`, auto part:**
  - frames on load;
  - the disjoint frame named and the bridge reporting the wrong order;
  - margins for 35 and 37 on entering Margin with no clicks (125 and 156 points);
  - "Least undercut" enabled;
  - on Tooth frame, the only primary is "Re-place pontics" while 36 is stale, then "Auto-design bridge";
  - the add-46 notice.
- **All 13 browser scripts pass.** On the way, `framework.mjs` failed on main ed982d7 itself: the demo crown with a
  hand-traced margin was not printable. Fixed in `2026-10-27-margin-click-snap.md`.
- **Clicks from Scans to the margins of a 35–[36]–37 bridge:** 0, down from tracing each abutment by hand (about 16
  point clicks plus closes). The step-by-step path to a proposed bridge is now "Least undercut, common" plus "Propose
  bridge". Auto-design bridge is one click from Tooth frame.

**Follow-ups:**
- Re-place stale pontics automatically when the user redoes an abutment frame that auto frames had set.
- Wire `from` into the bridge auto-design, so a run started on Margin keeps the reviewed margins.
- An automatic common axis on entering Insertion axis, with the same "ready for review" pattern (out of scope here).

