# Tooth frames ready for review, kept to the teeth chosen in Case setup

Status: **done** (2026-10-26).

## Goal

The user (2026-10-26):
- "When the user selects the teeth (say during the case setup), why do we need to ask the user to select the teeth
  again? Can we not have a tooth frame ready and the user just reviews?"
- "Also, I can select 2 teeth in bridge mode and in Tooth frame make them disjoint (teeth 1 and 2 in Case setup: an
  upper molar and a canine)."

**Today**
- Case setup names the teeth. Tooth frame then asks for one click on each prep. The prep finder
  (`specs/2026-10-26-prep-finder.md`) already knows where each prep is and which case tooth it belongs to, but it only
  draws a ring.
- Nothing ties a click to its tooth. A click for 16 can land on 13's prep, and a bridge's abutment frames can sit on
  any two teeth, in either order and any distance apart. Pontics are then laid out between the wrong places, and
  nothing says so.

## Scope

**In:**
1. **Frames ready.** On entering Tooth frame, every crown-prep tooth of that jaw with no frame gets its frame from
   the prep paired with it. In a bridge whose abutments all get frames this way, the pontics are placed too. All of it
   is one undo step, and the user reviews it.
2. **Clicks checked against the setup.** A click for one tooth that lands on the prep paired with another case tooth
   gets a warning that names that tooth.
3. **Bridge frames checked against the setup.** When a bridge's abutment frames are in the wrong order along the
   arch, or much further apart than the teeth between them need, the bridge panel says so.

**Out:**
- Implant (scan body), Maryland wing and inlay or onlay teeth: they are not crown preps, so the prep finder does not
  apply. They are framed by a click, as before.
- No refusals on real scans: warnings only, as for the prep finder.
- "Align to arch" stays a button.

## Design

### Frames from the preps (`tools/autoFrames.ts`, new)
- **Trigger:** the controller calls `autoFrames()` while the Tooth frame step is active. It runs again when the prep
  finding arrives (`onPrepsFound`).
- **Teeth:** the case teeth on the active tooth's jaw whose restoration takes a crown prep (`PREP_MARGIN`) and have
  no frame. The seed for each is the demo's known prep (`demoPrep`), or the prep paired by `prepFor` (all-or-nothing
  pairing in arch order).
- **Once per tooth and scan.** Each tooth is tried once per jaw scan (`sha:fdi`). An undone or deleted frame is not
  put back; the ring then shows for a click.
- **Frames:**
  - `estimateFrame` runs once per tooth, one after the other: the worker call is latest-wins, so a user click
    meanwhile supersedes it, and auto frames then stop.
  - In a bridge whose abutments all have frames afterwards (checked on `applyCommands`' dry run) and whose pontics
    have none, the pontic frames come from `bridgeFrames` on that dry-run document.
- **Dispatch:** one dispatch with every `setFrame`, so one undo step. A tooth framed meanwhile by a click is left
  alone.
- **Status line:** "Frames set from the preps found: 35, 37, pontic 36. Check them, or click a prep to redo one."
- **Off switch:** `toolStore.autoFrames` (default on), for browser scripts that exercise the manual click flow.

### Tooth frame step (`ui/steps/FrameStep.tsx`)
- **Frame set automatically:** "Frame set on 36 from its prep. Check the arrows, then auto-design the crown." The
  AutoDesign panel (already shown once a frame exists) is the main action.
- **The demo** gets its frame the same way, so its first action is "Auto-design crown". A click on 35 is still
  refused, and a click on the prep still redoes the frame (and auto-designs when one-click is armed).
- **The camera** keeps the jaw view taken on entry: the frame arrows show on the jaw.

### Click check (`tools/prepRing.ts`, `tools/frameTool.ts`)
- `prepWarning` also names another case tooth whose paired prep is within 6 mm of the click: "That is the prep of 13,
  not 16. The frame is set on 16; click 16's prep (in the ring) to redo it." The click is still applied.

### Bridge frames check (`geometry/bridge.ts`, `ui/steps/BridgePanels.tsx`)
- **New checks:** `layoutPontics` checks the span between two abutments around a pontic run, and reports in a new
  `PonticLayout.frameCheck`:
  - wrong order along the arch: "The frames of 37 and 35 are in the wrong order along the arch: check that each is on
    its own prep.";
  - more than 1.6 × the run's nominal width: "37 and 35 are 31 mm apart along the arch, but the pontics between them
    need about 11 mm: check that each frame is on its own prep."
- **Shown in the bridge panel** on Tooth frame, with the margins drawn or not (unlike the room warnings, which wait for
  the margins).

## Verification plan

- `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.
- **Tests:**
  - extend the closest existing `layoutPontics` test with the wrong-order and too-far cases. Per CLAUDE.md's
    detector rule: a correct span gives no frame check, and both wrong spans give one;
  - at most +1 test if no bridge layout test exists.
- **Browser scripts:**
  - `first-run.mjs`: the demo opens with 36 framed from its prep (no ring); a click on 35 is refused and changes
    nothing; "Auto-design crown" gives the draft; the rest as before;
  - `bridge.mjs`: a short section with auto frames on `lower-bridge.stl`:
    - 35 and 37 framed and pontic 36 placed, as one undo entry;
    - a click for 37 on 35's prep warns with 35's name;
    - 37's frame put on the far side of 35 makes the bridge panel report the wrong order;
  - scripts that test the manual click flow turn `autoFrames` off at start;
  - every script passes.

## Implementation summary

**What was built, and where**
- **Frames ready** (`apps/web/src/tools/autoFrames.ts`, new).
  - `autoFrames()` runs from the controller on every sync of the Tooth frame step. It is re-triggered when the prep
    finding arrives.
  - For the active jaw's crown-prep teeth with no frame, it takes the demo's known prep or the prep paired by
    `prepFor`. It estimates their frames one at a time, so a click meanwhile supersedes the run.
  - On a dry run (`applyCommands`) it lays out the pontics of any bridge it completed (`bridgeFrames`).
  - Everything goes out in one dispatch, leaving out teeth framed by a click meanwhile.
  - Each tooth is tried once per jaw scan.
  - Status line: "Frames set from the preps found: 35, 37, pontic 36. …" (singular for one tooth).
  - `toolStore.autoFrames` (default on, kept across `reset`) lets browser scripts test the click flow.
- **Click check** (`tools/prepRing.ts`). `activeFinding` is exported. `prepWarning` also names another case tooth
  whose paired prep is within 6 mm of the click: "That is the prep of 35, not 37. The frame is set on 37; click the
  prep of 37 to redo it."
- **Bridge frames check** (`geometry/bridge.ts`, `workers/analysisTypes.ts`, `ui/steps/BridgePanels.tsx`).
  - `layoutPontics` sets `frameCheck` on a pontic run whose abutment frames are in the wrong order along the arch, or
    more than 1.6 × the pontics' nominal width apart.
  - The bridge panel shows it at once, without waiting for the margins.
- **Tooth frame hint** (`ui/steps/FrameStep.tsx`): with a frame the step reads as a review ("Frame set on 36. Check the
  arrows, then auto-design the crown, or click the prep again to redo the frame."). "Auto-design crown" is the main
  action.
- **DESIGN.md:** First Click describes frames ready, the ring for a tooth still without one, and the checks.

**Deviations from the spec**
- **Click check:** the "far too far apart" check uses frame origins with nominal widths. On the synthetic arch a frame
  two teeth off (33 for 35) stays under 1.6 ×. Those near misses are caught by the click check, which names the other
  case tooth; the span check catches the gross ones (31 for 35) and any wrong order.
- **Click-flow scripts:** six browser scripts turn `autoFrames` off at start: `bridge` (its posterior and anterior
  parts), `ai-bridge`, `framework`, `anterior-export`, `ai-framework` and `crown-move`. `crown-move` was added after
  its "second Ctrl+Z returns to before auto-design" check met the auto frame.

**Verification**
- `pnpm typecheck` clean. `pnpm test`: 114 tests (102 pass, 12 skipped), +1. The new test is in
  `geometry/prepFinder.test.ts` on the bridge arch already built there: frames on 35 and 37 give no frame check,
  swapped they report the wrong order, and 31 for 35 reports the distance.
- **Browser scripts:**
  - `first-run`: 24 checks. The demo opens with 36 framed 0.0 mm from its prep and no ring, looking down on the jaw.
    A click on 35 is refused and the frame stays. Auto-design crown gives a complete draft. The rest as before.
  - `bridge`: 37 checks. The new auto part:
    - 35 and 37 are framed on their preps and pontic 36 placed, as one undo step;
    - 37's frame clicked onto 35's prep gives "That is the prep of 35, not 37…";
    - the bridge panel reports the wrong order.
  - `ai-bridge` 16, `framework` 22, `anterior-export` 13, `ai-framework` 7, `crown-move` 30, and `offline-design`
    passes.

**Follow-ups**
- Frames from the preps for upper and lower jaw teeth in one go: today the active tooth's jaw only. The other jaw's
  teeth are framed when one of them becomes active on the step.
- Implant scan bodies: a matching "scan body found" pass could frame implant crowns the same way.
