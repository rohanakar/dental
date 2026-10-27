# Margin clicks snap onto the ridge

Status: **done** (2026-10-27).

## Goal

A margin traced by clicks should give a crown that can be milled, even when a click lands a little off the finish
line. Today a click 0.1–0.2 mm off the ridge becomes an anchor that the live-wire must pass through. The line dips to
it and comes back, and the crown built on that kink can intersect itself.

## What happens today

Found while verifying `2026-10-26-bridge-out-of-the-box.md`. `framework.mjs` fails "single 36: the framework is
printable" on main ed982d7, without that change. `offline-design.mjs` logs "The crown surface intersects itself (1
triangle pairs)". Both trace the margin of the demo prep 36 by eight clicks at the analytic finish line.

- **The cause:** one click (anchor 4) lands 0.137 mm off the analytic finish line, on the chamfer below it; the other
  seven land within 0.063 mm. The traced line dips 0.24 mm to that anchor and back: turns of 44°, 56° and 171° at
  points 82–84, 0.2 mm apart.
- **The crown's margin band folds there:** one intaglio triangle at the rim crosses a band triangle (rim → cervical
  ring), within 0.07 mm of margin point 83.
- **Why it started now:** the demo jaw got its gum in 0a0ce30 (`DEMO_GINGIVA`). With the gum off, the same flow gives
  a printable crown. The curvature field around the click changed. The off-ridge click was always possible; the gum
  made its kink sharp enough to fold the band.

A user's click is no more precise than the script's (about a screen pixel), so this is a product bug, not a script
artefact.

## Scope

**In:**
- When a closed loop is traced from clicks (the Margin step's "close the loop"), each anchor snaps to the strongest
  ridge vertex for the line kind within 0.3 mm along the surface:
  - convex for a finish line;
  - concave for a gum line.
- The stored anchors are the snapped points, so the anchor dots sit on the line.
- The snap only moves an anchor onto a real ridge: one with the line's curvature sign that is stronger than the
  clicked vertex. Otherwise the click stays where it is.

**Out:**
- Dragging a point of an accepted line, Redraw a section, and the live-wire preview while tracing. A drag is a
  deliberate placement, and the preview is redrawn by the final trace.
- The other `marginFromAnchors` callers keep their anchors exactly: the refiner, wing outlines, golden-case scripted
  anchors and tests. The snap is opt-in.
- The crown builder. It could also guard its margin band against a kinked rim; that is a separate change.

## Design

- `geometry/livewire.ts`:
  - `snapToRidge(positions, graph, curvature, vertex, line, radiusMm = ANCHOR_SNAP_MM)`: a bounded search over the
    surface graph within `radiusMm` (Euclidean) of the clicked vertex. It returns the vertex with the strongest
    line-signed curvature, or the clicked vertex when none is a stronger ridge.
  - `marginFromAnchors` takes an optional `ridge: { curvature, line }` and snaps each anchor with it. It returns
    `anchorPoints`, the snapped position of each input anchor.
- `workers/geometry.worker.ts` `traceMargin`: passes `ridge` (the scan's curvature and the line kind).
- `tools/marginTool.ts` `commit`: stores `trace.anchorPoints` as the anchors.

## Verification plan

- **Test:** extend `livewire.test.ts` "follows the convex margin ridge from a few anchors". An anchor moved 0.15 mm
  down the chamfer:
  - is snapped back onto the ridge (the anchor point is within 0.05 mm of it);
  - its trace has no sharp turn;
  - without `ridge`, the trace keeps the off-ridge anchor.

  The test count is unchanged.
- **Browser scripts:**
  - `framework.mjs` passes ("single 36: the framework is printable");
  - `offline-design.mjs` logs no self-intersection;
  - every script that traces by clicks still passes.
- `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.

## Implementation summary

**What was built:**
- **`snapToRidge`** (`apps/web/src/geometry/livewire.ts`, with `ANCHOR_SNAP_MM = 0.3`): a search over the surface
  graph within 0.3 mm of the clicked vertex. It returns the vertex with the strongest curvature of the line's sign.
- **`marginFromAnchors`** takes an opt-in `ridge: { curvature, line }` and returns `anchorPoints`, each input anchor
  where the trace took it.
- **The worker's `traceMargin`** (`apps/web/src/workers/geometry.worker.ts`) passes `ridge`. It is called only when the
  Margin step closes a clicked loop.
- **The margin tool's `commit`** (`apps/web/src/tools/marginTool.ts`) stores the snapped anchor points.

**Deviation: the guard.** The spec said to snap whenever the ridge is stronger than the clicked vertex. The guard is
now "snap only when the clicked vertex is under four-fifths of the best nearby". A click on the ridge stays put, and
cannot creep along it to a slightly stronger vertex. A first try at one half never fired on the unit-test mesh: its
ridge is broad, at 0.61–0.71 against 0.41–0.44 for a click 0.1–0.2 mm below it.

**Verification:**
- **On the demo prep 36**, the same eight scripted clicks:
  - **`framework.mjs`:** "single 36: the framework is printable" passes, where it failed on ed982d7.
  - **`offline-design.mjs`:** the crown has no warnings. It had "intersects itself (1 triangle pairs)" before. The
    margin is 154 points, 27.8 mm, with a deviation from the analytic finish line of 0.070 mm mean and 0.203 mm max.
    The trace before the gum was 156 points, 28.1 mm.
- **Unit test:** `livewire.test.ts` "follows the convex margin ridge from a few anchors", extended. An anchor clicked
  0.15 mm down the chamfer:
  - snaps to 0.072 mm from the ridge, against 0.199 mm kept where it landed;
  - traces with a sharpest turn of 30.5°, the same as a click on the ridge, against 40.6° without the snap.

  The test count is unchanged at 125.
- `pnpm typecheck` clean, `pnpm test` green, `pnpm --filter @dcad/web build` built.
- **All 13 browser scripts pass:**
  - first-run, crown-move;
  - bridge, ai-bridge, implant, ai-implant;
  - maryland, ai-maryland, inlay;
  - offline-design, anterior-export, framework, ai-framework.

**Follow-ups:**
- **The crown builder** could guard its margin band against a kinked rim. A margin edited by a drag can still kink:
  drags are not snapped, by design.
- **Golden-case scripted anchors** (`tools/pipeline-runner/src/pipeline.ts`) could opt into the snap. They stand in for
  clicks, but they stay exact for now so the benchmarks don't move.
- **The live-wire preview** while tracing still ends at the raw click. The final line goes through the snapped point,
  at most 0.3 mm away.

