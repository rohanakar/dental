# The occlusal view faces the working tooth's jaw

Status: **done** (2026-10-30).

## Goal

The occlusal view (the toolbar's Occlusal button, key 1) showed an upper tooth from the back of the jaw. The view
frame is set once from the scans (`estimateViewFrame`, `apps/web/src/engine/viewFrame.ts`). With both jaws loaded, its
occlusal looks from above, onto the lower jaw, so on an upper tooth the camera looked at the palate side and the model
base.

## What changed

- **`viewDirection(frame, view, jaw)`:** the occlusal view looks from below for an upper tooth and from above for a
  lower one, as the per-jaw view (`Viewer.viewJaw`) already did. With no jaw given it is unchanged.
- **`sceneController.setView`** passes the active tooth's jaw, so the toolbar button and the key both follow it.

## Verification

- **Checked directly:** with both jaws loaded, the occlusal direction is −up for an upper tooth, up for a lower one,
  and up with no tooth.
- **No test:** the project's tests leave out camera and key-binding details (`CLAUDE.md`).
- `pnpm typecheck` and `pnpm test` pass. All 13 offline browser scripts pass (an idle machine).
