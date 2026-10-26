# Every tooth chosen in Case setup gets its tooth frame as soon as its scan is in

Status: **proposed** (2026-10-26).

## Goal

The user (2026-10-26): "The tooth selected in Case setup: should it not automatically be assigned a tooth frame?"

Case setup says which teeth are restored. Once the jaw scan that holds a tooth is loaded, that tooth should have its
frame, without the user opening Tooth frame or clicking anything. Tooth frame becomes a review step the user can skip.

## What happens today

On main 12d5821 (`specs/2026-10-26-auto-frames.md`):
- **When:** frames are assigned only **when the user opens the Tooth frame step**, from `tools/autoFrames.ts` called by
  the controller's Tooth-frame sync.
- **Which teeth:** only **crown-prep teeth on the active tooth's jaw**. The other jaw's teeth wait until one of them
  is active on that step. Implant crowns, Maryland wings and inlay or onlay teeth are never framed automatically.
- **Consequences:**
  - after Scans the rail still shows Tooth frame "not done", and the footer's Next leads there;
  - a user who goes from Scans straight to Margin or Crown proposal meets "This step needs Tooth frame first";
  - opening a saved case resumes at Tooth frame.
- **Work in progress:** branch `worktree-agent-a2ef73ceee8f1261d` (`specs/2026-10-26-auto-frames-jaws-implants.md`)
  extends auto frames to both jaws and to implant crowns (a scan-body detector, measured clean on 31 scans). It is
  still tied to opening the Tooth frame step.

## Scope

**In:**
1. **Frames on scan load.**
   - **Trigger:** when a jaw scan becomes ready, or Case setup changes (a tooth added, or its restoration changed).
   - **Which teeth:** every case tooth on that jaw without a frame:
     - crown preps from the prep finder;
     - implant crowns from the scan-body finder, after the WIP branch;
     - pontics laid out once their bridge's abutments are framed.
   - **Undo:** one undo step per batch.
2. **The rail and the next step follow:**
   - Tooth frame shows done once every frameable tooth has a frame;
   - after Scans, Next goes to Margin, or offers auto-design;
   - `resumeStep` lands past Tooth frame.
3. **Case setup changes after the scans are in:**
   - a tooth added gets its frame;
   - a tooth whose restoration changes between a prep crown and an implant crown has its frame redone from the right
     finder;
   - a tooth removed loses its frame (already true).
4. **Teeth that can't be framed automatically** are named once in the status line, so the user knows where to click:
   "No prep found for 26: click its prep on Tooth frame." This covers a Maryland wing, an inlay or onlay, a count
   mismatch, or no prep found.

**Out:**
- Wing and cavity teeth: they still get their frame by a click (their outlines are proposed on Margin).
- Refusing anything: the frames are proposals to review, and a click on Tooth frame still redoes one.

## Design
- **Trigger** (`tools/autoFrames.ts`, `state/sceneController.ts`): a subscription instead of the Tooth-frame sync.
  `autoFrames(jaw)` runs:
  - when a jaw scan reaches `ready`: the scene store's `phase`, with the BVH built, so the finder can run in the
    worker;
  - when `doc.setup.teeth` changes.

  It keeps its once-per-tooth-per-scan memory (`sha:fdi`), so an undone frame is not put back. It runs per jaw (both
  jaws, from the WIP branch's per-jaw finding) and is skipped while an auto-design draft is open.
- **Undo:** a batch is its own undo entry ("Frames from the preps"), after the scan import's entry.
- **Opening a saved case** with scans and no frames assigns them on open, which marks the case unsaved like any
  edit. It does not assign them in a read-only view.
- **The demo:** frames are set while its scans load, so it still opens on Tooth frame, framed, for review.
- **Rail:** no change to statuses: `steps.frame` is `done` once a frame is set, as today. `resumeStep` and the
  footer's Next already follow the statuses.
- **Restoration change:** `setCaseSetup` from crown-prep to implant, or back, marks the frame stale. `autoFrames`
  treats a stale frame whose source is `auto` and whose basis no longer matches as "no frame", and redoes it once.

## Dependencies
- Merge branch `worktree-agent-a2ef73ceee8f1261d` (both jaws and implants) first: this builds on its per-jaw finding
  and scan-body finder.
- `2026-10-26-bridge-out-of-the-box.md` builds on this: margins found as soon as frames exist.

## Verification plan
- `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.
- **Tests:** none new expected. The trigger is UI wiring, and the finders are already tested. If the "frame redone
  on restoration change" rule ends up as a pure function, +1 test with one passing and one failing case.
- **Browser scripts:**
  - `bridge.mjs` auto part: right after the scans load, without visiting Tooth frame, 35 and 37 are framed and
    pontic 36 placed. The rail shows Tooth frame done, and the footer on Scans offers Margin.
  - `bridge.mjs`: adding 46 in Case setup after the scans are in gives 46 a frame.
  - `implant.mjs`: the implant crowns are framed on scan load.
  - `first-run`: the demo is unchanged.
  - Every script passes. Click-flow scripts keep `autoFrames` off.
