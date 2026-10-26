# One-click crown on a tooth without a prep: say so before the margin, not after it

Status: **proposed** (2026-10-26).

## Goal

The user (2026-10-26): "One-click crown (auto-design) always seems to fail at margins. I always see similar warnings
and errors." For example:
- "The crown would fold at this margin."
- five "Kink on the mesiolabial side: the line turns 146° within 0.6 mm…" lines;
- "Length 48.7 mm";
- "Draft stopped at Margin…";
- "No kinks: sharpest bend in the margin line (146.16°, maximum 120°)".

"The crown with the proposed margin always looks like the images, not full; I don't know if this is correct."

The screenshots show an upper incisor on the Insertion axis step. The red margin zig-zags in rectangular steps across
the labial face. The region inside it (green, the undercut map) covers part of the tooth.

A one-click crown should either design the crown, or, when it can't, say why in one line before it runs.

## Diagnosis

The automatic margin (`classical.margin-ridge@1`: `geometry/autoMargin.ts` `proposeMarginAnchors`, closed by
`marginFromAnchors`, gated by `ai/qa.ts` `marginGate`) was run on synthetic arches at the demo resolution (1000 × 500),
with the frame from `estimateToothFrame` at the tooth's top:

| Tooth (synthetic) | Margin | Sharpest bend (≤ 120° passes) | Ridge score | Prep finder | Result |
|---|---|---|---|---|---|
| 36, prepped (as in the demo) | 28.1 mm | 43° | 16/16 | prep | **pass** |
| 11, prepped, upright | 19.0 mm | 73° | 16/16 | prep | **pass** |
| 11, prepped, leaning 25° | 19.8 mm | 86° | 16/16 | prep | **pass** |
| 13, prepped (canine) | 19.9 mm | 49° | 16/16 | prep | **pass** |
| 14, prepped (premolar) | 20.5 mm | 41° | 16/16 | prep | **pass** |
| 11, **natural** | 39.0 mm | **157°** | 16/16 | no prep | **fail** |
| 46, **natural** | 53.7 mm | **156°** | 16/16 | no prep | **fail** |

**Findings:**
- **The automatic margin works on prepped teeth,** front and back, upright and leaning. Lengths are 19–28 mm and
  bends 41–86°.
- **On a natural tooth it can only fail.** With no finish line, the profiles stop at the gum line, and the live-wire
  follows it in stair steps along the scan's grid. The result is 39–54 mm with ~150° kinks, which is exactly the
  user's 48.7 mm and 146°. The prep region inside that line is the partial "crown" in the screenshots.
- **The demo's scans have one prep: 36 on the lower jaw.** The upper jaw has none. The fixtures: `lower-bridge.stl`
  (35, 37), `upper-anterior-bridge.stl` (11, 21). Any other tooth on these scans is natural, so a crown set up on an
  upper incisor of the demo fails every time.
- **Nothing stops the run at the start.** One-click auto-design runs on any tooth. The prep finder
  (`geometry/prepFinder.ts`) already knows 11 has no prep, but only draws (or omits) a ring.
- **The margin gate can't tell.** "Margin edge shows clearly around the prep" scores 16 of 16 on natural teeth too,
  because the gum line is an edge. Only the kink check catches it, and it reports five kinks rather than the cause.
- **The failure reads as a margin problem,** not a tooth problem. It shows a kink list, "drag the nearest point onto
  the margin", and "Keep the draft and trace the margin yourself", which is impossible on a tooth with no finish line.
  A kept draft then shows a partial prep region on Insertion axis, which looks like a broken crown.

## Scope

**In:**
1. **Before the run.** With the prep finder's result for the jaw, auto-design on a crown-prep tooth with no prep paired
   doesn't run. It says why, naming the teeth that are prepared on this scan: "No prep found on 11: the scan shows a
   natural tooth there, and a crown needs a prep. Prepared teeth on this scan: 36. Change the tooth in Case setup, or
   load the scan with the prep." The same applies to a one-click click on such a tooth.
2. **A finish-line check in the margin gate.** `marginGate` gets the prep finder's ledge score along the found margin
   (`margin.finishLine`: the share of profiles with a wall that eases into a ledge and then drops, as
   `prepFinder.ts` measures it). This catches a gum-line margin even when its bends pass, with a plain message:
   "No finish line under this margin: it follows the gum line."
3. **The stopped margin says the cause first.**
   - When the margin stops on a tooth with no prep found, the draft review's one sentence (`AutoDesign.tsx`
     `nextAction`) and the Margin step's warning (`MarginIssues.tsx`) lead with "This tooth has no prep finish line;
     the margin followed the gum line." "Keep the draft" is not offered (Reject only).
   - With a prep, kinks are grouped by side ("Kinks on the mesiolabial (3) and distal sides"), not listed one per
     line.
4. **The demo says which tooth it is for.** Case setup in the demo marks 36 as the prepared tooth. Adding another
   tooth says once that the demo scans have no prep there.

**Out:**
- A margin for a natural tooth (veneers, onlays without a prep line): they are out of scope (PRODUCT.md).
- Changing the margin algorithm: it passes on every prepped case measured.
- Real scans: no de-identified real scans are available. The user skipped that validation (2026-10-26).

## Design
- **Prep check before the run** (`ai/orchestrator.ts` `runAutoDesign`, `tools/frameTool.ts` one-click). Ask
  `activeFinding()` (`tools/prepRing.ts`) for the jaw; it is cached, so this costs nothing after the first call.
  - **Run:** a crown-prep tooth with a paired prep, or a demo tooth with its known prep.
  - **Refuse** with the message: a crown-prep tooth on a jaw whose finding has no prep near the frame origin or the
    click (within 6 mm).
  - **Run as today:** the finding not yet available (it is computed on demand, so wait once, bounded at about 2 s),
    or the tooth not a crown prep.
  - A bridge applies the same rule per abutment.
- **Gate** (`ai/qa.ts` `marginGate`; the worker's `autoMargin` returns the ledge score). Compute it with
  `prepFinder.ts`'s profile test along the traced margin. Require ≥ 0.75, the finder's threshold.
- **Copy** (`ai/qa.ts`, `ui/ai/AutoDesign.tsx` `nextAction`, `ui/steps/MarginIssues.tsx`): the cause first, grouped
  kinks, and no "Keep the draft" when there is no finish line.
- **Demo** (`ui/steps/SetupStep.tsx`): `demoPrep` knows 36. A tooth added in the demo gets a one-line note.

## Dependencies
- The prep finder (on main, `specs/2026-10-26-prep-finder.md`).
- `2026-10-26-frames-from-case-setup.md` names teeth with no prep found at scan load. This spec reuses that message
  and stops the run.

## Verification plan
- `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.
- **Tests:**
  - extend `qa.test.ts`'s margin gate test: a prepped tooth passes `margin.finishLine`, and the natural tooth's
    gum-line margin fails it. Use the table's synthetic cases, built once;
  - +1 at most for the refusal before the run, if no orchestrator test can take it.
- **Browser scripts:**
  - `first-run.mjs`:
    - the demo with 11 added in Case setup: a one-click on 11 is refused before anything runs, with the message
      naming 36;
    - 36 still designs.
  - `ai-bridge`, `ai-implant`, `crown-move` and `anterior-export` pass. Their teeth are all prepped.
  - Every script passes.
- **Measure:** re-run the table above with the new gate. Prepped teeth all pass, and natural teeth are refused before
  the run (or fail `margin.finishLine` if forced).
