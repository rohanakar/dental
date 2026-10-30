# The insertion axis, as soon as its margins are ready

Status: **done** (2026-10-30).

## Goal

Entering Insertion axis proposes an axis when the tooth (or every bridge abutment) has its margin and frame
(`axisTool.enter`, `apps/web/src/tools/axisTool.ts`). On a bridge the margins are found automatically on entering
Margin, Insertion axis or Crown proposal (`2026-10-26-bridge-out-of-the-box.md`). Entering Insertion axis directly
therefore met no margins yet, and the common axis waited for a click. That spec listed "an automatic common axis on
entering Insertion axis" as a follow-up.

## What changed

- **When the axis is proposed.** On the axis step, `enter` runs on every update (unless a draft is open or the tool is
  busy). The axis is proposed the moment its inputs are ready: on entering the step, or when the margins arrive just
  after.
- **Once per set of inputs.** It is proposed once per jaw scan and every abutment's margin and frame. An undone axis
  is not put back; a changed margin or frame is new input.
  - Before, re-entering the step after undoing the axis proposed it again.

## Verification

- **Test** (`apps/web/src/tools/axisTool.test.ts`, new; the worker mocked):
  - on the axis step without a margin, there is no axis;
  - the margin arrives, and the axis follows;
  - undone, it is not proposed again for the same margin;
  - a changed margin gets one.
  - It fails on the old code at "not proposed again".
- `pnpm typecheck`; `pnpm test` (+1 test). All 13 offline browser scripts pass (an idle machine).
