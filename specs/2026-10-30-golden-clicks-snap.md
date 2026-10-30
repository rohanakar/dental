# Golden cases' scripted clicks snap like the app's

Status: **done** (2026-10-30).

## Goal

In the app a margin click snaps onto the finish line's ridge within 0.3 mm (`2026-10-27-margin-click-snap.md`). The
golden cases' scripted anchors stand in for those clicks but stayed exact, so the runner measured a different path
from the app's. That spec left it as a follow-up.

## What changed

- **Single crowns:** the runner's scripted margin (`tools/pipeline-runner/src/pipeline.ts`) traces with the same ridge
  snap as the app's clicks (`line: 'finish'`).
- **Bridges:** the bridge runner (`bridgePipeline.ts`) does the same for crown preps. A Maryland wing's outline and an
  inlay cavity's margin are not finish lines and stay exact.
- The automatic margin is unchanged.

## Results

- **Synthetic golden cases:** 15 of 15 pass, margins 0.04–0.06 mm from the analytic ones.
- **Exocad golden cases** (local), mean distance to the lab's line:
  - 0.001–0.008 mm different on the 12 that changed;
  - 049/25 and 049/26, whose lab line is off the scan's edge, lose more self-intersections (110 → 38, 114 → 66).

## Verification

- The golden cases as above. `pnpm typecheck` and `pnpm test` pass (no new test).
