# Day 4: Fit and feedback (RBF fit, thickness, colour maps, clinical moves, gizmo)

Status: **done** (2026-10-11).

## Goal

Turn the walking-skeleton crown into a designable one:
- The template fits the margin smoothly.
- The material never goes below the thickness profile.
- The designer sees thickness, occlusion, proximal contacts and unmillable areas as colour maps.
- The designer moves, rotates and scales the crown in clinical terms with a gizmo, buttons or the keyboard. Every
  edit is one undoable command, the same command the Day 6 agent will use.

## Scope

In:
1. **RBF fit** replaces the Day 3 per-column cervical blend. A smooth displacement field maps the placed cervical
   ring exactly onto the outer margin loop. Zero-displacement anchors on the occlusal third keep the cusp anatomy.
2. **Thickness enforcement.** After the fit, outer-shell vertices that are closer to the intaglio than the thickness
   profile are pushed outward. Profile: `marginThicknessMm` at the margin → `minThicknessMm` within 1 mm. Then a
   smoothing pass on the displacement.
3. **Colour maps** (computed in the worker on request, shown on the crown with the legend):
   - *thickness*: outer surface → distance to the intaglio.
   - *occlusion*: signed clearance to the antagonist; negative = penetration.
   - *proximal*: signed clearance to the neighbours (scan surface outside the prep region).
   - *unmillable*: intaglio areas a ball-end tool of `toolRadiusMm` cannot reach (heightfield morphological opening
     along the insertion axis).
4. **Clinical commands** in the reducer, on `TemplateCrown` poses in the tooth frame:
   - `moveCrown` (direction, mm)
   - `rotateCrown` (axis, deg, about the crown's mid-height centre)
   - `scaleCrown` (axis, pct; the margin stays fixed because the fit re-pins it)
   - `setParam`
   Each marks `proposal` done (and downstream stale). `setContact`, `adaptOcclusion` and `runStep` stay for Day 5/6.
5. **Gizmo + nudges.**
   - A translate gizmo (three.js TransformControls) aligned with the tooth frame. Dragging previews by moving the
     crown object; on release it becomes one batch of `moveCrown` commands, so one undo entry.
   - Nudge pad (mesial/distal/buccal/lingual/occlusal/cervical, rotate ±2° about each clinical axis, scale ±2%).
   - Keyboard in the proposal step: arrows = mesial/distal/buccal/lingual, PageUp/PageDown = occlusal/cervical,
     0.1 mm (Shift: 0.5 mm).
6. **Pipeline:** the thickness check becomes `crown.thickness ≥ minThicknessMm − 0.02` (measured by closest-point
   distance outer → intaglio away from the margin band), plus map statistics.

Out: adapt to antagonist and neighbours (Day 5), sculpt (Day 6 stretch), rotation gizmo handles (buttons only).

## Design

### Geometry (pure TS)
- `geometry/rbf.ts`:
  - `solveRbf(centers: Float32Array, values: Float32Array, opts?: { kernel?: 'cubic' | 'linear'; smoothing?: number })`
    → `RbfField`. The kernel is φ(r) = r³ by default, with an affine polynomial term. The solve is dense LU on
    n + 4 unknowns (n ≈ 200) and errors on singular systems.
  - `evaluateRbf(field, p): V3` and `applyRbf(field, positions, weights?)`.
- `geometry/thickness.ts`:
  - `thicknessProfile(distanceToMarginMm, params)`.
  - `enforceThickness({ positions, vertexStart, vertexEnd, intaglio: RayCaster, marginLoop: Float32Array, params,
    iterations = 3 }) → { pushedVertices, maxPushMm }`. It moves shell vertices in place along
    (vertex − closest intaglio point), then applies a Laplacian smoothing of the push field over the shell (the
    caller passes the shell graph).
- `geometry/crownMaps.ts`, all returning `Float32Array` per crown vertex (NaN = not applicable):
  - `thicknessMap(...)`
  - `clearanceMap(...)`: rays along outer normals; signed by hit-face orientation; the face filter excludes the prep
    region for the proximal map.
  - `unmillableMap(...)`: heightfield grid at 0.05 mm, ball opening of radius R, depth > 0.01 mm → unmillable.
- `geometry/crown.ts`: `designCrown` uses the RBF fit + `enforceThickness`. The result adds `shellStart`,
  `thickness: { minMm, pushedVertices, maxPushMm }` and optional `maps`.

### Document / commands (`apps/web/src/design/reducer.ts`)
- Direction vectors from the tooth frame:
  - mesial = frame.mesial, distal = −mesial
  - buccal = frame.buccal, lingual = −buccal
  - occlusal = frame.occlusal, cervical = −occlusal
- `rotateCrown` uses a right-hand rotation about frame.mesial / frame.buccal / frame.occlusal through the centre
  c = pose.position + R·S·(0, 0, height/2). The template height is not known in the reducer, so it uses
  `pose.scale.z × templateNominalHeight`; the nominal heights are exported from `crownTemplate`.
- `scaleCrown` multiplies scale[x|y|z] by (1 + pct/100), with x ↔ mesial-distal, y ↔ buccal-lingual,
  z ↔ occlusal; scale.x keeps its sign.
- Commands error (`CommandError`) without a frame or template crown.

### Worker / UI
- Worker `designCrown(request)` takes `maps?: CrownMapName[]`. `crownTool` asks for the map selected in the UI and
  shows it with `setObjectScalars('crown', ...)` plus the legend. Ranges:
  - thickness: [0, 2] mm sequential
  - occlusion and proximal: [−0.2, 0.5] mm diverging
  - unmillable: [0, 0.2] mm undercut map
- Viewer: `attachGizmo(object id | null, frame)` / gizmo events. The camera is disabled while the gizmo is dragged.
- Proposal step: map selector, nudge pad, gizmo toggle, keyboard nudges.

## Verification plan

- **Unit:**
  - RBF interpolates its centres exactly (< 1e-6) and reproduces affine fields.
  - After the fit, the cervical ring = outer margin loop.
  - Thickness everywhere ≥ profile − 0.02 mm after enforcement, on the synthetic case and with an artificially
    shrunk pose.
  - Clinical commands move, rotate and scale the pose as specified for both handednesses; undo restores; they error
    without a frame.
  - Maps: thickness ≥ 0 on the outer shell, NaN on the intaglio; occlusion negative where the crown penetrates a test
    antagonist; unmillable flags a sharp concave step and not a smooth dome.
- **Pipeline:** synthetic-36 passes the thickness check; map statistics are in the metrics.
- **Browser:**
  - Propose → thickness map + legend.
  - Keyboard nudge mesial 0.5 mm moves the pose by 0.5 mm along mesial and recomputes; undo.
  - Gizmo drag → one undo entry.
  - Export is still valid (trimesh).

## Work split

- Fork A (geometry): `rbf.ts`, `thickness.ts`, `crownMaps.ts` + tests, and the `designCrown` integration in
  `crown.ts` (fit, thickness, maps).
- Fork B (commands + gizmo): the reducer's clinical commands + tests, Viewer gizmo, nudge pad component and keyboard
  handling.
- Main session: spec, worker/crownTool map plumbing, map selector, pipeline checks, E2E, review and integration.

## Implementation summary

### What was built
- **Geometry** (fork A): `geometry/rbf.ts`, `geometry/thickness.ts`, `geometry/crownMaps.ts`, and `crown.ts` changes.
  - `rbf.ts`: cubic or linear RBF with an affine term and dense LU; `applyRbf` works in place.
  - `crown.ts`: the RBF fit replaces the Day 3 per-column blend.
    - Constraints: the cervical ring → the outer margin loop, plus 56 zero-displacement cusp anchors at height
      fraction ≥ 0.7.
    - After the fit comes `enforceThickness`: profile `marginThicknessMm` → `minThicknessMm` over 1 mm, 6
      iterations; the requirement is recomputed each round, and the push field is smoothed without shrinking
      violators' pushes.
    - Result adds `shellStart`, `thickness {minMm, minSlackMm, pushedVertices, maxPushMm}` and optional `maps`.
  - Maps (one value per crown vertex, NaN = not applicable):
    - `thickness`
    - `occlusion`: signed, along the outer normal against the antagonist.
    - `proximal`: signed, against the prep jaw minus a 1 mm *geodesic* band around the prep, and minus faces
      pointing up or down.
    - `unmillable`: ball-end tool opening on the intaglio heightfield, 0.08 mm cells.
- **Commands and gizmo** (fork B).
  - `design/clinical.ts`: quaternion and pose maths, frame direction and axis vectors, `crownCentre`.
  - `design/reducer.ts`: `moveCrown`, `rotateCrown` (about the mid-height centre), `scaleCrown` (keeps the mirror
    sign) and `setParam` (schema-checked). They mark `proposal` / `params` done and throw `CommandError` without a
    frame or template crown.
  - `engine/gizmo.ts` + `Viewer.setGizmo`: a TransformControls translate gizmo in the tooth frame. The camera is
    disabled while dragging, the press does not trigger tool clicks or orbit points, the drag shows a live preview,
    and release calls `onCommit(delta)`.
  - `tools/gizmoTool.ts`: decomposes the world delta into one batch of `moveCrown`s (split at 2 mm).
  - `tools/nudge.ts`: keyboard ←/→ mesial/distal, ↑/↓ buccal/lingual, PgUp/PgDn occlusal/cervical, Shift = 0.5 mm.
  - `ui/steps/NudgePad.tsx`: move, rotate ±2° and scale ±2% per clinical axis, plus a gizmo toggle; every button has
    an aria-label.
- **Main session.**
  - Map plumbing: `CrownRequest.maps` → the worker transfers the map buffers back → `crownTool.setMap` /
    `applyMap` → `setObjectScalars('crown', …)`. The legend comes from `CROWN_MAPS`:
    - thickness 0–2 mm sequential
    - occlusion and proximal −0.2–0.5 mm diverging
    - unmillable 0–0.2 mm
  - UI: map selector and thickness-enforcement stats in the proposal step; nudge keys in `App.tsx`; gizmo wiring in
    `controller.ts`.
  - Pipeline: the `crown.thickness` check (≥ min − 0.02 mm) and per-map min/max/mean statistics in
    `metrics.json`.

### Deviations from the spec
- `enforceThickness` takes `IntaglioSurface` (ray caster + mesh), because it needs face normals to detect shell
  vertices below the intaglio. It runs 6 iterations, not 3: the requirement rises as vertices move away from the
  margin.
- The proximal map ignores a geodesic 1 mm band, not `dilateMask` rings. On the anisotropic synthetic mesh, rings
  hid the neighbours (3 hits instead of 901).
- Unmillable cells are 0.08 mm, not 0.05 mm: 60 ms vs 452 ms.
- The gizmo is translate-only (rotation by buttons and keys), as planned. In left-handed frames its X handle points
  distal; moves are worked out in world space, so the commands are always correct.

### Verification
- **Unit:** `pnpm test`: 6 shared, 144 web (2 skipped), 18 API unit, 1 pipeline. Typecheck and build are clean.
  - Geometry 94 tests:
    - RBF exactness and affine reproduction.
    - After the fit, the cervical ring sits exactly the margin thickness from the margin.
    - Thickness ≥ profile − 0.02 mm for 36 and mirrored 46.
    - A pose shrunk to 70% width and 50% height gets 1709 vertices pushed (max 0.55 mm), ends at min 0.503 mm
      against 0.5, and stays valid.
    - Map NaN layout and ranges; unmillable flags a sharp step but not a smooth dome.
  - Commands: reducer 19 tests (both handednesses, 180 × 2° returns to the start, a batch is one undo entry),
    clinical 4, nudge 2.
- **Pipeline:** `pnpm pipeline`: 15/15.
  - `crown.thickness` = 0.89 mm against a 0.48 limit.
  - Crown 380–400 ms on the 1M-triangle scan with all four maps (165–198 ms without).
- **Browser, offline:**
  - Thickness and occlusion maps render with the legend.
  - Shift+← moves the pose exactly 0.500 mm along mesial; Ctrl+Z restores it bit for bit.
  - "Rotate 2° occlusal" keeps the crown valid.
  - A gizmo drag on the occlusal handle commits 1.25 mm as one undo entry.
  - A cement-gap edit recomputes the crown, and the exported STL passes trimesh (watertight, winding consistent).
- **Browser, online:** save, reopen, and the crown recomputes identically (307.569 → 307.569 mm³).

### Follow-ups
- The occlusion map shows the template cusps up to 0.5 mm into the antagonist. Day 5 adapts the occlusion and the
  contacts and reports conflicts.
- There is no triangle–triangle self-intersection check yet (Day 5). Thickness pushes near the band could
  theoretically fold; none were observed.
- The gizmo handle direction in left-handed frames could be made to always point mesial.
