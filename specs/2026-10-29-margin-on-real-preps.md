# The automatic margin on real preps

Status: **done** (2026-10-29).

## Goal

Make the automatic finish line right on real prepped teeth. On the exocad sample cases
(`2026-10-29-exocad-sample-cases.md`) it was right on 3 of 24 posterior preps on arch scans. The live-wire through 8
points of the lab's line was right on 22 of 24, so the anchors are the problem, not the tracing.

## What the cross-sections show

Each profile was plotted through the prep (out to 8 mm, down to 7 mm) with the lab's margin point, the current
method's candidates and its pick (`data/exocad/scripts/profileDump.mts`, `plotProfiles.py`; local).

- **What the current method does:** it samples a height map: rays cast down from above, at 0.05 mm steps outward.
- **What real preps look like:** their axial walls are near-vertical and 2–5 mm tall, often slightly undercut. Two
  things go wrong on them:
  - **No samples on the wall.** A height map has none on a vertical wall, so the profile jumps from the line angle to
    the bottom.
  - **Noise reads as edges.** The convexity score is a difference of slopes (dh/dr), which blows up on steep walls.
- **The result:** the pick often lands just past the 1.5 mm minimum drop, partway down the wall.
- **Where the lab's margin is:** always the first convex corner after the axial wall. That's the outer lip of the
  chamfer or shoulder, or the top of the ditch on a die. The occlusal line angle is the convex corner before the wall.
- **Candidates on the true contour:** the scan's cross-section in the half-plane, walked outward from the prep top,
  has a convex corner within 0.2 mm of the lab's point on 90% of profiles (tuning set) and 98% (held out). The current
  height-map candidates reach 51% and 68%.
- **One rule on the true contour:** taking the first convex corner at least 1.5 mm below the top, the right point is
  picked on 87% of profiles (tuning) and 89% (held out). The current pick gets 41% and 49%.

## Scope

**In:**
1. **The profiles from the true cross-section.** `proposeMarginAnchors` (`apps/web/src/geometry/autoMargin.ts`) walks
   the mesh's section in each half-plane outward from the prep top, instead of casting rays from above.
   - Convexity becomes the turn of the contour (degrees) over a short chord, which stays well-behaved on vertical
     walls and undercuts.
   - The output shape is unchanged (anchors, profiles with radius, drop, convexity and candidates), so the refiner's
     ring DP, the margin tools and the runner keep working.
2. **The refiner** (`marginRefine.ts`) passes one triangle grid to all its profile runs. Its candidate choice is tuned
   only if the line-level numbers show a need.
3. **The doubt warning in the margin gate,** if it holds up. First measure its false alarms on right lines (the lab's
   own lines, and right automatic ones): the old run flagged 47 of 52 wrong lines, but only 6 right lines were seen.

**Out:**
- the prep finder (it has its own height-map profiles: a separate spec);
- the cement gap on real scans;
- front-tooth frames;
- the natural tooth's gum line (`naturalMargin.ts`, untouched).

## Design

- **The section walk** (in `autoMargin.ts`):
  - Only the triangles in grid cells near the half-plane's rectangle are visited: s from −1 to the search radius
    plus 1 mm; h from 3 mm above the top to 10 mm below.
  - Each crossing point is keyed by its mesh edge, so neighbouring triangles share it exactly. The walk starts at the
    crossing nearest the prep top and heads outward.
  - It stops at the scan's border, at the search radius, when it wraps back past the axis, or on a rise of 0.5 mm onto
    a neighbour (as now, once the profile has dropped).
- **Convexity:** the contour is resampled every 0.05 mm. The turn at a sample is the chord direction before minus the
  chord direction after (over ±0.15–0.2 mm, a parameter), clockwise positive. Candidates are the local maxima of the
  turn. `convexity` stays dimensionless: turn ÷ 30°. The pick is the first candidate below the minimum drop.
- **The grid:** `buildTriangleGrid` (`crossSection.ts`), built once per call and passed in by the refiner. The
  worker's scan registry can cache it later.

## Evaluation

- **Tuning set** (iterate on this only): 042's upper jaw (14–16, 24–27), 043's dies, 035, 049 and BATCH-053: 19
  margins.
- **Held out** (measured at the end): 042's lower jaw (34–37, 44–47), 045, 056, 047, 048 and 044 (17 margins), and all
  27 anterior margins.
- **Regression:** the synthetic margin evaluation (`pnpm --filter @dcad/pipeline-runner run margin-eval`, 16/17 right
  before), the golden cases, and the unit tests.
- **Measures:** lines right (the bars of `2026-10-29-exocad-sample-cases.md`: mean ≤ 0.10 mm, ≥ 90% within 0.2 mm, ≥ 90%
  coverage), mean deviation, the gate, the doubt warning, and the time per margin.

## Verification plan

- **Tests** (+1):
  - Extend `autoMargin.test.ts` with a revolved prep with a 4.3 mm axial wall undercut by 2°, a chamfer and a flaring
    root. The margin is found at the chamfer's lip below the wall, within 0.1 mm of the analytic one.
  - If the gate changes, extend the refiner test's natural-tooth case rather than adding a test.
- `pnpm typecheck`, `pnpm test`, the margin evaluation, and the exocad tuning and held-out runs (aggregate numbers only).

## Implementation summary

### What was built
- **Section profiles** (`apps/web/src/geometry/autoMargin.ts`). `proposeMarginAnchors` cuts each radial profile
  from the mesh (`sectionProfile`) and walks it outward from the prep top.
  - It visits only the grid cells near the half-plane.
  - Crossings are keyed by mesh edge, or by the vertex when the plane passes through one, so the chain is exact.
  - The convexity is the clockwise turn of the contour over ±0.15 mm chords, divided by 30°. The pick is the first
    convex corner at least 1.5 mm below the top. Candidates for the refiner are all such corners.
  - The output shape is unchanged.
- **Noise-adaptive smoothing.** Each profile is smoothed (Gaussian, σ from 0 to 0.4 mm, the least that does it)
  until its median turn is at most 6°.
  - Real scans measure 1.3–6° (median 1.9°), so they are never smoothed.
  - The rough synthetic scans measure 9–70°.
  - `roughnessDeg` reports the median before smoothing.
- **The height profiles stay, for rough scans** (`sampler: 'height'`, the old code as `heightEdges`). The refiner
  (`marginRefine.ts`) runs the sections. When their roughness is above 6°, it also runs the height profiles, and every
  candidate competes on the existing terms. On a quiet scan, where the height profiles' wrong lines came from, they
  are never tried.
- **One triangle grid per refiner call,** passed to every profile run (`RefineInput.grid`, optional).
- **Not changed:** the margin gate. See "Deviations".

### Results (local, aggregate only)

| Set | Right before | Right now | Median deviation of the right lines |
|---|---|---|---|
| Tuning: posterior, 19 margins | 3 | **17** | 0.020 mm |
| Held out: posterior, 17 margins | 2 | **11** | 0.020 mm |
| Anterior, 27 (not tuned on, out of scope) | 1 | **12** | 0.045 mm |
| Synthetic margin evaluation, 17 prepped + 3 natural | 16 + 3 rejected | **16 + 3 rejected** | |

- **Per profile:** the right point was picked on 41% of tuning profiles and 49% of held-out ones before, and 87% and 89%
  on the true contour. The noise study printed held-out per-profile numbers once, but no choice was made on them.
- **The 2 tuning misses** are 049/25 and 049/26. There the lab's own line sits 0.3–0.6 mm inside the scan's edge: 8
  clicks on it stray as much, and the doubt warning flags 63–77% of the lab line itself.
- **The 6 held-out misses:**
  - 044/34 and 36: a 17 × 24 mm segment with no antagonist.
  - 048/34 and 44: primary-telescope preps.
  - 045/46: a wide, low molar whose line angle lies 1.7 mm down, past the minimum drop, on a few profiles.
  - 042/45: 0.19 mm mean, just off.
- **Time:** an automatic margin takes 0.10–0.32 s on the real posterior scans (0.48 s at most on anterior ones).
  - On the synthetic jaws, 0.55–0.64 s on quiet scans and 0.9–1.2 s on rough ones, where both samplers run. Before, it
    was about 0.6 s.
  - The natural, noisy control takes 1.9 s.
- **The gate and the doubt warning on the new lines** (posterior, both sets):
  - The gate passed 6 of 8 wrong lines.
  - The doubt warning flagged 8 of 8 wrong lines and 1 of 28 right ones (042/47, where it flags the lab's own line
    too).
  - On the lab's own lines on quiet scans it fired on 1 of 34 (042/47).
  - On the synthetic margin evaluation it fires on 8 of 16 right lines on noisy scans (0.5–3 mm stretches), and on none
    on the clean ones or the demo jaw.

### Deviations from the plan
- **The height profiles are kept** for rough scans. The sections alone lost 3 of the roughest synthetic cases (0.06–0.07
  mm per-vertex noise; 14 of 17 right). The fallback costs nothing on real scans and restores 16 of 17.
- **The doubt warning is not in the gate yet.** It is reliable only on quiet scans, which the refiner can now tell. But
  in `marginProposer` a finish line that fails its gate falls back to the gum line unless the prep finder sees a prep,
  and the prep finder misses neighbouring preps. A false doubt alarm would then swap a right finish line for a gum
  line. The fix needs its own change: the finish-or-gum choice ignores the doubt check, while one-click still stops
  on it, with the browser scripts as the check.
- **The unit test checks the new sampler only.** On a clean revolved prep the height map finds the lip as well: its
  real failure is scan noise on steep walls, which a smooth test mesh does not have.

### Verification
- `pnpm typecheck`: green.
- `pnpm test`: 126 tests pass (+1: the revolved prep in `autoMargin.test.ts`), 12 skipped (the API's infrastructure
  tests).
- The synthetic golden cases with `--auto`: 15 of 15 pass.
- **Browser scripts:** all 13 offline ones pass (dev server on :5300). The automatic margin runs in crown-move,
  ai-bridge, bridge, first-run, framework, ai-framework and anterior-export; the rest are offline-design, maryland,
  inlay, implant, ai-implant and ai-maryland.
  - offline-design failed once at its anchor-drag step ("no change within 30 s"). It then passed on the old code and
    twice on the new code with identical output: a timing flake on a cold server.
  - ai-flows and online-case need the API on :3000 and were not run.
- The synthetic margin evaluation and the exocad sets: as above.
- Commands: as in `2026-10-29-exocad-sample-cases.md`, with `evalExocad.mts dev|held|anterior`.

### Follow-ups
1. **The doubt warning in the gate**, on quiet scans, with the finish-or-gum choice kept apart (see Deviations).
2. **A line angle below the minimum drop** (045/46). Take the first convex corner after the chamfer's concave inner
   angle or a steep wall, as published methods do (a 1995 Nikon patent; OcclusaCAD). Tune it on new cases, not on the
   held-out ones.
3. **Short proximal walls.** Between teeth the margin can be only 1.1–1.5 mm below the prep top (049, 042/27).
4. **The prep finder** still uses height profiles. The same sections could fix its neighbouring-prep misses.
5. **The worker** can cache the triangle grid per scan; the cross-section view already builds one.
