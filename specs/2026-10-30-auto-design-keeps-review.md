# Auto-design from a step panel keeps what was reviewed

Status: **done** (2026-10-30).

## Goal

The compact auto-design panel on Tooth frame, Margin (bridges) and Crown proposal starts a run
(`apps/web/src/ui/ai/AutoDesign.tsx`). A bridge run re-proposed the pontic frames and every abutment's margin, and a
crown run its margin and axis, over what the user had already reviewed. "Wire `from` into the bridge auto-design, so a
run started on Margin keeps the reviewed margins" was a follow-up of `2026-10-26-bridge-out-of-the-box.md`.

## What changed

- **`keepReviewed`** (`runAutoDesign`, `apps/web/src/ai/orchestrator.ts`; the compact panels pass it).
  - The run drops every frame, margin or axis row whose output the units already have and is not stale: the pontic
    layout when every pontic is placed, a margin per abutment, the common axis.
  - Everything else runs: a missing margin is still found, and a row with the run's own click (a frame being set now)
    always runs.
- **Not a plain `from` step.** On Crown proposal the panel is the main action exactly when a margin is missing.
  Starting at the proposal would skip it.
- **The full panel** (one-click from the Frame step) is unchanged.

## Verification

- **Test** (extends "starts at the margin when a frame exists…" in `orchestrator.test.ts`): a 35–[36]–37 bridge with
  every frame placed and 35's margin reviewed.
  - A panel run has no frame row and no margin row for 35, but one for 37.
  - It fails on the old code (it re-proposed 35's margin).
- `pnpm typecheck`, `pnpm test` (an extended test, no new one). All 13 offline browser scripts pass (an idle machine).
