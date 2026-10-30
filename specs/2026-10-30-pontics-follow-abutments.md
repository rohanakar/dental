# Pontics follow a redone abutment frame

Status: **done** (2026-10-30).

## Goal

Auto frames lay a bridge's pontics out on the arch between its abutments (`autoFrames.ts`). When the user redid an
abutment frame with a click, the reducer marked the pontic frames stale, but they stayed where the old abutment frames
put them. That spec (`2026-10-26-bridge-out-of-the-box.md`) listed "re-place stale pontics automatically" as a
follow-up.

## What changed

`estimateFrameAt` (`apps/web/src/tools/frameTool.ts`), a click that sets an abutment's frame, now also lays out again
the bridge's pontics that were placed automatically (frame source `auto`), from the new abutment frame. The new frames
go in the same undo step as the click's.
- A pontic the user placed with a click on the ridge (`manual`) stays where it is. It is marked stale as before, for
  the user to look at.

## Verification

- **Test** (`apps/web/src/tools/frameTool.test.ts`, new; the worker mocked, a 35–[36]–37 bridge):
  - Redoing 35's frame moves an automatically placed 36 to the new layout, with one undo entry.
  - A manually placed 36 stays.
  - It fails on the old code: the pontic stayed at its old place.
- `pnpm typecheck`; `pnpm test` (+1 test).
- **Browser scripts:** all 13 offline ones pass. `bridge.mjs` redoes 37's frame. It expected pontic 36 to go stale
  and "Re-place pontics" to be the main action. It now checks that 36 is not stale and that "Auto-design bridge" is the
  one main action.
