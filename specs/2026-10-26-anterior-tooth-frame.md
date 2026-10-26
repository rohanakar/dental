# Front-tooth frame from the prep axis; leaning synthetic incisors; E2E click guards; framework E2E

Status: **done** (2026-10-26).

## Goal

Real front teeth lean. The long axis of an upper incisor sits 15–30° labial of the occlusal-plane normal, a lower
incisor and the canines less. `estimateToothFrame` takes the frame's occlusal direction from the whole jaw (the PCA
least-variance axis, when it is within 25° of the mean vertex normal near the click). On a leaning prep that leaves
the crown standing upright on a leaning stump. The previous task measured it on synthetic incisors sheared 25°
([2026-10-26-anterior-margin-and-export-all.md](2026-10-26-anterior-margin-and-export-all.md), Follow-ups):
- the least-undercut axis search, centred on the frame occlusal, stops at 6.6° with 1–2 margin points in undercut;
- the crown on 21 has 174 self-intersecting triangle pairs, even on a clean margin.

The Margin step's view already follows the prep's own axis (`apps/web/src/tools/marginView.ts`). This task makes the
tooth frame of a front-tooth prep follow it too, so the template pose, the axis search and the bridge follow the
tooth. Posterior teeth stay exactly as they are.

Three smaller items ride along:
- a leaning option on the synthetic arch, to verify all this;
- the click guard of `tools/e2e/ai-bridge.mjs` in the other E2E scripts;
- the framework browser check, which so far lived only in a scratch folder, as `tools/e2e/framework.mjs`.

## Scope

**In**
1. **Front-tooth frame** (`apps/web/src/geometry/toothFrame.ts`). For a prep on FDI positions 1–3, the occlusal
   direction comes from the prep stump's own axis, gated as below. Posterior teeth (positions 4–8), implant crowns,
   wings, cavities and pontics keep the jaw-level frame. FDI handedness is kept.
2. **The stump logic moves to geometry.** `findStump` and `prepAxis` move from `tools/marginView.ts` to a new
   `apps/web/src/geometry/prepAxis.ts`, unchanged, so the frame (worker, Node) and the Margin view (main thread) share
   them. The Margin view keeps its behaviour.
3. **Bridges with front-tooth abutments.**
   - The arch curve is fitted in the jaw's occlusal plane, not in the plane of the mean (leaning) abutment occlusal.
   - The common axis is centred on the mean of the (leaning) abutment axes, as now.
   - Pontic frames take the mean occlusal of their neighbours, as now, so a pontic next to a leaning abutment leans
     with it.
4. **Plumbing.**
   - `FrameRequest.prep` (worker): whether the click is on a crown prep. It defaults to true, so the AI frame
     proposer gets the new frame without an edit in `ai/**`.
   - The Frame step passes false for restorations without a prepared stump. Those are the types outside
     `PREP_MARGIN` (implant crowns, wings, inlays and onlays).
   - The pipeline runner passes the jaw's triangles and `prep: true` for crown abutments and single crowns.
5. **Synthetic leaning front teeth** (`apps/web/src/geometry/synthetic.ts`).
   - `ArchOptions.anteriorLeanDeg` (default 0, so every existing output stays byte-identical) leans the incisors and
     canines labially.
   - The same option on `syntheticPrepMargin` and `syntheticPrepSeed` gives matching analytic points.
6. **E2E click guard.**
   - `tools/e2e/bridge.mjs` and `tools/e2e/implant.mjs` get the guard from `ai-bridge.mjs`: before a click, wait until
     the surface under the projected point is the target, within 0.3 mm.
   - Their `settle()` also waits for `viewer.controls.active === false`.
7. **Framework E2E** `tools/e2e/framework.mjs`, ported from the scratch check:
   - a reduced CoCr single crown on 36 and a reduced CoCr bridge 35–[36]–37;
   - the Setup switch, the cutback panel, the Framework and Both views, Check bridge;
   - the Finalize export of the framework and overpress STLs, each parsed in Node as a closed solid.

   It follows the style of the other scripts: `APP_URL` defaults to `http://localhost:5173/app/`, `E2E_OUT` sets the
   output folder, and clicks use the guard. It gets a package script and a README entry.
8. `tools/e2e/anterior-export.mjs` builds its leaning arch with `anteriorLeanDeg` instead of its own shear. Its "old
   view" (the margin traced as the user did) becomes the jaw's occlusal-plane normal, because the frame occlusal
   now follows the prep.

**Out**
- Posterior teeth that tilt (a mesially tipped molar). They keep the jaw-level frame, as the task asks; the axis
  search handles their tilt within its 25° cone, as before.
- Saved documents keep their stored frames. A front-tooth frame changes only when the Frame step runs again.
- Shared schemas, the reducer, `ai/**` and the inlay work. The frame keeps its stored shape (origin, three axes,
  contacts).
- A runner golden case on leaning incisors. The runner files only get the plumbing; the leaning check is a scratch
  run, plus the unit test below.

## Design

### The prep axis (`geometry/prepAxis.ts`)

- **`findPrepStump`** is the old `findStump`. It finds the prep by connectivity from the click, using the frame's
  origin, mesial and buccal axes for its window and heights along a given occlusal direction. It returns:
  - the prep top's centre;
  - the area-weighted normals of the faces within 2 mm of the top (the axial walls);
  - the rim band 2.5–3.5 mm below the top.
- **`prepStumpAxis`** is the old `prepAxis`: the least-undercut direction with a 20° clearance. The Margin view keeps
  using it.
- **`stumpWallAxis`** (new) gives the frame its axis: the direction the wall normals are most nearly perpendicular to.
  - It is the least-variance eigenvector of the area-weighted unit normals of the wall faces. For a tapered stump the
    wall normals lie on a cone around the axis, so their spread is smallest along it.
  - **Walls:** faces whose normal is more than 35° from the reference direction. Then a refit against the first
    estimate, keeping faces more than 45° from it. That drops the prep top, whether it stays parallel to the
    occlusal plane or tilts with the tooth.
  - **Null** (no axis) when the fit is ambiguous: the smallest eigenvalue is more than half the middle one, or the
    walls hold less than a fifth of the stump's area.
  - **Why not the least-undercut direction?** Measured on the leaning synthetic incisors (1M triangles), the hinge
    cost stops where the larger wall reaches its clearance:

    | Lean | Jaw occlusal, off by | Least-undercut axis, off by | Wall cone fit with the refit, off by |
    |---|---|---|---|
    | 0° | 2.5° | 0.5° | 0.2° |
    | 15° | 12.9° | 2.9° | 1.4° |
    | 25° | 23.3° | 4.9° | 1.9° |
    | 30° | 28.4° | 6.6° | 2.0° |

    Each error is the angle from the true axis, the line the shear tilts the tooth's centre line to.

### The rule (`estimateToothFrame`)

1. The jaw-level frame, as now: occlusal, origin, mesial-distal line, buccal, mesial.
2. For a prep on positions 1–3 (`prep: true`, with `jaw.indices`):
   - Find the stump around the origin (jaw-level axes) and its wall axis, searched against the jaw occlusal.
   - The tilt θ is the angle from the jaw occlusal to the wall axis. The applied tilt is:
     - **θ ≤ 5°: none.** The frame stays jaw-level, so upright front teeth keep exactly the old frame. 5° covers the
       estimate's spread on an upright prep (2.0–2.3° on the synthetic incisors).
     - **5° < θ < 10°: a ramp.** The applied tilt is θ·(θ − 5°)/5°, continuous and monotonic, reaching the full tilt
       at 10°.
     - **10° ≤ θ ≤ 40°: the full prep axis.**
     - **θ > 40°: none, with a warning.** No front tooth leans that far, so the stump estimate is wrong (a neighbour,
       a fractured prep). The warning says the frame follows the occlusal plane.
   - No stump or no axis: the jaw-level frame, with a warning that the frame follows the occlusal plane.
3. The tilt is applied as one rotation, about occlusal × axis, to the occlusal and buccal axes. Mesial is then
   derived again by FDI handedness (a proper rotation keeps it, up to rounding). The origin is cast again along the
   new occlusal from the click, and the neighbour contacts are searched along the new axes.

### Bridges (`geometry/bridge.ts`, additive)

- `archFitDirections(frames, positions?)`. Frames may carry their `fdi`.
  - When a frame is a front tooth and the jaw positions are given, the occlusal for the fit is the jaw's own
    occlusal-plane normal: the whole-jaw PCA least-variance axis, oriented along the mean of the frames, when it is
    within 35° of that mean.
  - That is the same axis the jaw-level frame starts from.
  - Without a front-tooth frame, or without positions, it is the mean as now, so posterior bridges are byte-identical.
- **Callers** pass the units' FDI and the jaw positions: the worker's `archCurveOf`, `designBridge`, the bridge and
  implant runner pipelines.

### Synthetic lean (`geometry/synthetic.ts`)

- A front tooth (types 0–2) is sheared labially. A point z mm above the gum line moves tan(lean)·z outward along the
  arch's normal (the across-band coordinate).
- The gum and the tooth's foot (z ≤ 0) stay put, so the mesh stays continuous. Neighbouring teeth meet at zero
  height.
- Each tooth's centre line tilts by the lean, and its prep top stays parallel to the occlusal plane. That is the shear
  the previous probe used, applied per tooth instead of fading over the arch angle.
- The analytic margin and seed go through the same function.

### E2E guard

Each script gets one `clickWorld(p, { objectIds?, guard? })`:
- **The guard:** up to 40 tries 250 ms apart, settling again after each, until a raycast at the projection lands
  within 0.3 mm of `p`.
- **Opt out with `guard: false`** for clicks whose target is not on a surface. The pontic-top click is one: it aims
  at a mean of crown vertices.
- **`settle()`:** the camera samples as before, then `controls.active === false`.

## Verification plan

- **Tests** (CLAUDE.md: a bug fix extends the closest test). One new test in
  `apps/web/src/geometry/toothFrame.test.ts`, "follows the prep axis on leaning front teeth; upright ones keep the
  jaw frame":
  - **Leaning:** on the synthetic upper arch with 11 and 21 prepped and leaning 25°, both frames' occlusal is within
    4° of the true axis. Handedness holds: mesial toward the midline, buccal labial, the axes orthonormal.
  - **Gate, failing case:** on the upright arch, the frame equals the jaw-level frame (`prep: false`).
  - **The crown on 21 is printable,** designed with the frame's axis as the insertion axis: no self-intersections,
    closed, and an axis search from the frame with no margin point in undercut.

  Test count: 108 → 109 (on main c8426ba: 108, of which 12 skip without infra).
- **Commands:** `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.
- **Runner:** `--synthetic` with every case passing, and the hashes of every STL and of `metrics.json` (timings
  stripped) equal to main's. main's run is deterministic: two runs gave equal hashes.
- **Scratch run** on leaning incisors at 0, 15, 25 and 30°:
  - single crowns on 11 and 21: printable, with 0 self-intersections;
  - the least-undercut axis with no margin point in undercut;
  - the bridge [12]–11–21–[22]: the union printable.
- **Browser** (`vite --port 5288`): `bridge.mjs`, `implant.mjs`, `framework.mjs`, `anterior-export.mjs` and
  `ai-bridge.mjs` all pass.

## Implementation summary

### What was built

**The prep axis in geometry** ([geometry/prepAxis.ts](../apps/web/src/geometry/prepAxis.ts), new):
- `findPrepStump` and `prepStumpAxis` are `marginView`'s old `findStump` and `prepAxis`, moved unchanged.
  [tools/marginView.ts](../apps/web/src/tools/marginView.ts) imports them, and its views are unchanged.
- `stumpWallAxis` (new) is the frame's estimate: the least-variance eigenvector of the area-weighted wall normals.
  - First pass: walls are the faces more than 35° from the jaw occlusal.
  - Refit: the faces more than 45° from the first estimate.
  - Null when the walls hold under a fifth of the stump's area, or when the normals do not lie on a cone (smallest
    eigenvalue over half the middle one).

**The front-tooth frame** ([geometry/toothFrame.ts](../apps/web/src/geometry/toothFrame.ts)):
- `estimateToothFrame` takes `jaw.indices` and `prep`.
- For a prep on FDI positions 1–3 it first builds the jaw-level frame as before. It then finds the stump and its wall
  axis and gates the tilt (`frontToothTiltDeg`):
  - none up to 5°;
  - a continuous ramp θ·(θ − 5°)/5° up to 10°;
  - the whole tilt up to 40°;
  - none beyond 40°, with a warning (also when no stump or axis is found).
- The tilt is one rotation of the occlusal and buccal axes. Mesial is derived again by FDI handedness, then the origin
  and the neighbour contacts are found again along the new axes.
- `isFrontTooth` is exported for the bridge code.

**Bridges** ([geometry/bridge.ts](../apps/web/src/geometry/bridge.ts), additive):
- `archFitDirections(frames, positions?)`: with a front-tooth frame, the fit's occlusal is the whole-jaw PCA axis,
  oriented along the frames' mean, when it is within 35° of that mean.
- `layoutPontics`: next to front-tooth neighbours that lean more than 2°, a pontic leans by their mean labial lean
  along its own labial direction (the curve normal where it sits). See the deviations.
- The common axis is unchanged: it is centred on the mean of the (now leaning) abutment axes.

**Plumbing:**
- `FrameRequest.prep` ([workers/analysisTypes.ts](../apps/web/src/workers/analysisTypes.ts)) defaults to true in
  the worker, so the AI frame proposer gets the new frame without an edit in `ai/**`. The worker also passes the
  scan's indices, and the units' FDI to `archCurveOf`.
- [tools/frameTool.ts](../apps/web/src/tools/frameTool.ts) passes `prep` from the restoration type, using
  `PREP_MARGIN`. That list moved from `controller.ts` to `marginView.ts` so both share it.
- Runner: [pipeline.ts](../tools/pipeline-runner/src/pipeline.ts) and
  [bridgePipeline.ts](../tools/pipeline-runner/src/bridgePipeline.ts) pass the indices and `prep` (crown abutments
  only, not wings). The bridge and implant pipelines pass the FDI and positions to `archFitDirections`.

**Synthetic lean** ([geometry/synthetic.ts](../apps/web/src/geometry/synthetic.ts)):
- `ArchOptions.anteriorLeanDeg`, with the same option on `syntheticPrepMargin` and `syntheticPrepSeed`.
- Teeth of types 0–2 are sheared labially: a point z mm above the gum line moves tan(lean)·z along the arch normal.
  At lean 0 the code path is a no-op (`s` is returned unchanged), so every existing output is byte-identical.

**E2E:**
- [bridge.mjs](../tools/e2e/bridge.mjs) and [implant.mjs](../tools/e2e/implant.mjs):
  - `clickWorld(p, { objectIds, guard })` waits until the surface under the projected point is the target (within
    0.3 mm, picking only the jaw).
  - The pontic-top click opts out (`guard: false`): its target is a mean of crown vertices, not a surface point.
  - `settle()` adds a per-frame idle check (see the deviations).
- [framework.mjs](../tools/e2e/framework.mjs) is new: the port of the scratch check, in the style of the others. It
  has a `framework` package script and a README entry.
- [anterior-export.mjs](../tools/e2e/anterior-export.mjs) builds its arch with `anteriorLeanDeg`, which replaces its
  own shear. Its "old view" is now the occlusal-plane normal.

### Deviations from the spec (and why)

- **No dead band in `archFitDirections`.** The PCA axis of the upright synthetic-bridge-12-22 equals the old mean bit
  for bit (both abutment frames are exactly ±the PCA axis), so its hashes did not change.
- **Pontics lean along their own labial direction** (not in the spec). With the mean of the neighbours' occlusal, a
  cantilever 12 next to 11 leaned along 11's labial direction, about 20° off its own.
- **`settle()` does not wait for `controls.active === false`.** That wait timed out in `framework.mjs`, in the Adapt
  step. camera-controls marks 'rest' only on a damped frame below its threshold. A move that ends in one step (a jump,
  or one long SwiftShader frame) goes to sleep without 'rest', and `active` stays true. `settle()` waits instead for
  three rendered frames in a row with the camera unchanged.
- **The unit test runs at 600 × 300.** At 400 × 160–200 the small incisor prep's crown can fold at its rounded line
  angle, leaning or not. A probe found 5–14 pairs on upright 21 at 400 × 200, and 0 at 600 × 300 and at 1000 × 500.
- **Tried and reverted:** sizing the crown or pontic height from rays over the footprint when the axis ray misses the
  antagonist.
  - It removed the 15° fold below (101 pairs → 0).
  - But it left the occlusion 0.6–0.8 mm open on realistic cases, because the template's top is not flat. So
    `crown.ts` and `pontic.ts` are unchanged.
- **The previous agent's "174 pairs" was not reproduced with scripted margins.** It reproduces with the margin
  clicked in the app; see below.

### Verification

- **Commands:**
  - `pnpm typecheck` passes.
  - `pnpm --filter @dcad/web build` passes (the chunk-size warning was there before).
- **Tests:** `pnpm test` gives 109 tests, 97 passed and 12 skipped (infra), up from 108 on main c8426ba (+1). By
  package: shared 2, api 21, web 80, pipeline 6.
  - **New** in [toothFrame.test.ts](../apps/web/src/geometry/toothFrame.test.ts): "follows the prep axis on leaning
    front teeth (the crown on it is printable); upright ones keep the jaw frame".
  - On the upper arch with 11 and 21 leaning 25°, each frame is within 4° of the sheared centre line, while the
    jaw-level frame is more than 20° off. Mesial points to the midline, buccal is labial, the axes are orthonormal,
    and there are no warnings.
  - The least-undercut axis is within 2° of the frame (the jaw-level frame needs 6.9°), with no margin point in
    undercut. The crown on 21 is closed, with 0 self-intersections.
  - **Gate:** on the upright arch, `prep: true` returns exactly the jaw-level frame.
- **Runner** `--synthetic`: 6 of 6 cases pass. The sha256 of every STL and of every `metrics.json` (timings stripped)
  equals main's, for all six cases (36, the bridges 35–37 and 12–22, implant, framework, Maryland). main's run gives
  the same hashes twice.
- **Prep-axis estimate** (probe, upper arch, 1M triangles, 11 and 21 alike). The error is the angle from the sheared
  centre line:

  | Lean | Jaw occlusal | Least-undercut axis | Wall axis (shipped) | Wall axis, clicks 2 mm off centre |
  |---|---|---|---|---|
  | 0° | 2.5° | 0.5° | 0.2° (2.4° from the jaw occlusal: gated, the frame stays) | 0.2° |
  | 15° | 12.9° | 2.9° | 1.4° | 1.4–3.8° |
  | 25° | 23.3° | 4.9° | 1.9° | 1.8–2.0° |
  | 30° | 28.4° | 6.6° | 2.0° | 2.0–2.5° |

- **Scratch runner on leaning front teeth** (golden-case format, upper 1000 × 500, scripted margins from 8 analytic
  anchors). Both arches lean, as real incisors do; with an upright lower arch see below. Single crowns on 11 and on 21
  (one prep each) and the bridge [12]–11–21–[22], against main's code on the same files. The two crowns give the same
  numbers.

  | Lean | Frame off the tooth axis, main → new | Axis tilt from the frame, main → new | Min thickness, main → new | Crowns' self-intersections, new | Bridge |
  |---|---|---|---|---|---|
  | 0° | 1.9° → 1.9° (unchanged) | 0° → 0° | 0.51 → 0.51 mm | 0 | Union printable, all checks pass |
  | 15° | 13.6° → 1.5° | 0° → 0° | 0.61 → 0.60 mm | 0 | Union printable, all checks pass |
  | 25° | 24.0° → 2.0° | 6.9° → 0° | 0.50 (at the floor) → 0.66 mm | 0 | Union printable (0 self-intersections, 1 component, genus 0), common axis 0° from centre, no margin undercut; pontics 12 and 22 occlusion open |
  | 30° | 29.2° → 2.0° | 13.2° → 0° | 0.50 (at the floor) → 0.67 mm | 0 | Same as 25° |

  - Every single-crown check passes at every lean, including the frame within 5° of the tooth axis, the contacts,
    the adaptation and no margin undercut.
  - On main, the same crowns stand upright: the frame check fails, and the axis search makes up 6.9–13.2°.
- **The user's case reproduced.** The margins of 11 and 21 were clicked in the app on the 25° arch and redesigned in
  Node:
  - 21: 209 self-intersecting pairs with the jaw-level frame, 0 with the new one;
  - 11: 0 with the jaw-level frame, 1 with the new one (see the open issues).
- **Browser** (`vite --port 5288`, headless Chrome, outputs in the session scratchpad `afront/e2e/`):
  - `bridge.mjs`: all checks pass (34). Every margin click lands within 0.13 mm with 0 re-aimed, on 35, 37, 11 and
    21. The anterior bridge has four closed units and three connectors without failures.
  - `implant.mjs`: all pass (32), no console errors.
  - `framework.mjs`: all pass (22).
    - Single: a printable CoCr framework with its veneering space, the views, the map and the cutback edit.
      `case-36-framework.stl` and `case-36-overpress.stl` are closed.
    - Bridge: one framework solid of genus 0, connectors at the CoCr area, three printable overpress parts.
      `case-35-37-framework.stl` and the three overpress STLs are closed.
  - `anterior-export.mjs`: all 13 checks pass.
    - The Margin view reaches 64 of 64 margin points of 11, against 39 of 64 from the occlusal-plane normal.
    - The frame is 23.1° from the plane normal.
    - The kink was flagged (157°); the margin traced again gives 77°, with no warning.
    - The zip exports both crowns and the bridge, each closed. 21 now has no self-intersections (on main it had
      174). 11 has 1 pair (see the open issues).
  - `ai-bridge.mjs`: all checks pass.
  - The first `bridge.mjs` run broke when a source edit reloaded the page. It passed on the rerun.

### Open issues and follow-ups

- **Cantilever front pontics at 25–30°.** Pontics 12 and 22 lean with 11 and 21 (correct) but their occlusion stays
  open.
  - The axis ray from the ridge passes in front of the lower lateral's incisal edge.
  - The pontic keeps the template height, and nothing is within 3 mm along its axis, so the runner's
    `unit.adapt.occlusion` check fails for them.
  - On main the pontics stand upright and find the antagonist.
  - Front-tooth occlusion (overjet, a palatal contact) needs its own sizing and adaptation rule. Leaving cantilevers
    out of occlusion is also common practice.
- **Margin spike at a clicked anchor.**
  - On 11 in the app, the mesial anchor (on the surface, 0.13 mm from the analytic point, in the 0.75 mm valley
    between the 11 and 21 preps) leaves a 0.02 mm back-and-forth in the dense margin.
  - It turns 151° in the plane ⊥ the axis, below the kink gate's 0.6 mm stride.
  - The band's outward offset (tangent from the immediate neighbours) folds there: 1 self-intersecting pair.
  - A wider tangent stride or spike removal in the trace would fix it. Both change every crown, so it is left for its
    own task.
- **Upright antagonist under leaning uppers** (an unrealistic synthetic bite). At 15°, the crown's axis ray misses the
  upright lower incisor, the crown keeps the template height, and its palatal side sinks 2.2 mm into the incisal
  edge. The occlusion adaptation's 2.2 mm push folds the shell (101 pairs; on main 0). See the reverted attempt above.
- **Posterior teeth that tilt** keep the jaw-level frame, as scoped.
- **Stored frames** keep their old occlusal until the Frame step runs again.
- **AI.** The frame proposer's rationale text ("Occlusal from the arch and local normals") predates the front-tooth
  rule. It lives in `ai/**`. Maryland wings in AI flows also get `prep: true`; on a leaning natural incisor their frame
  then follows the tooth.
