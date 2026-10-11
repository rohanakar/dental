# Day 3: Walking skeleton (intaglio, template crown, stitch, validate, STL export)

Status: **done** (2026-10-11).

## Goal

Go end to end for the first time: margin + axis + params → a **watertight crown STL** that opens in a slicer. The
crown is not well fitted yet (Day 4 does RBF fit, thickness and adaptation). It is closed, correctly oriented, and its
inner surface (intaglio) is right: cement gap, spacer and blockout.

## Scope

In:
1. Intaglio: gap profile, offset, upper envelope along the insertion axis (blockout), radial-profile mesh.
2. Crown template library (procedural, synthetic), with the format real annotated crowns will use later.
3. Template placement in the tooth frame (rigid pose + anisotropic scale), mirroring by quadrant handedness.
4. Cervical blend + stitch into one closed crown mesh.
5. Mesh validation: closed, 2-manifold, consistently oriented, positive volume. Also report the minimum axial
   thickness (enforcement is Day 4).
6. Binary STL + JSON sidecar export.
7. UI: Parameters step (edit `DesignParams`), Crown proposal step (propose, show, opacity), Finalize step
   (validation report, export). The crown mesh is derived from the document and recomputed when inputs change.
8. Pipeline runner: crown STL + intaglio/crown metrics per case.

Out: RBF fit, thickness enforcement, gizmo, adapt (Day 4/5); triangle–triangle intersection check (Day 5).

## Design

All geometry is pure TS in `apps/web/src/geometry`. The worker (`designCrown`) and the pipeline runner call the same
entry point.

### Crown template (`geometry/crownTemplate.ts`)
```ts
interface CrownTemplate {
  id: string;                       // 'synthetic.lower-molar@1'
  type: 'premolar' | 'molar';
  jaw: 'upper' | 'lower';
  size: { md: number; bl: number; height: number };   // nominal mm
  mesh: IndexedMesh;                // open outer shell, template-local mm
  cervicalLoop: Uint32Array;        // ring 0 vertex ids, CCW seen from +z, starting at the most mesial vertex
  column: Uint32Array;              // per vertex: index into cervicalLoop of its column (apex: 0)
  heightFraction: Float32Array;     // per vertex: 0 at the cervix → 1 at the apex
  cuspTips: Array<{ name: string; p: V3 }>;
}
syntheticTemplate(type, jaw, { columns = 128, rings }): CrownTemplate
templateForTooth(fdi): CrownTemplate   // positions 4–5 premolar, 6–8 molar; cached
```
- Template-local frame: x mesial, y buccal, z occlusal. The cervical loop is in z = 0, centred on the origin.
- Shell = an axial wall lofted from a superellipse footprint (cervical waist → height of contour → occlusal table)
  plus an occlusal surface with cusps.
  - Molars: MB, ML, DB, DL cusps. Premolars: B, L cusps.
  - The occlusal surface has marginal ridges and a central fossa, and an apex fan at the centre.
- Columns share θ sampling, so displacements can be blended per column. Normals point outward. The shell is open at
  the cervix.

### Intaglio (`geometry/intaglio.ts`)
- `distanceFromMargin(positions, graph, vertexMask, loopVertices)`: multi-source Dijkstra (edge length) inside the prep
  region.
- `cementGap(d, params)`: 0 at the margin, smoothstep to `cementGapMm` over `RAMP_MM` = 0.15. Plus `extraSpacerMm`
  smoothstepped in from `distanceToMarginMm` over the same ramp.
- `offsetPrep(...)`: region faces → compact submesh; vertices moved along smoothed normals by `cementGap(d)`.
- `buildIntaglio({ offset: RayCaster, rim: Float32Array (N margin points), axis, samples = 200, profilePoints = 32 })`.
  - Work in a basis (u, v, axis). The centre c is the mean of the rim projected onto (u, v).
  - Profile k runs from rim point k toward c. Each sample casts a ray from above along −axis onto the offset
    surface; the first hit is the upper envelope, which blocks out undercuts.
  - Each profile is resampled to `profilePoints` by 3D arc length, so steep walls get samples. Quads join adjacent
    profiles, with a fan at c.
  - Returns `{ mesh, rim (vertex ids), warnings }`. If the projected rim is not star-shaped around c, it warns.

### Placement and assembly (`geometry/crown.ts`)
- **Pose.**
  - Origin: the margin centroid.
  - Axes: z = frame.occlusal; x = mesial ⊥ z; y = z × x … with ε = sign((mesial × buccal)·occlusal). The rotation
    columns are (ε·x, y, z), always proper, and `scale.x = ε·sx` mirrors left/right teeth. Winding flips when
    det < 0.
- **Scale.**
  - MD: the contact-to-contact distance along mesial, or 1.2 × the margin MD extent.
  - BL: 1.15 × the margin BL extent.
  - Height: the distance from the margin centroid to the antagonist along occlusal minus `occlusalClearanceMm`,
    clamped to ≥ prep height + `minThicknessMm` + 0.5 and to [4, 10] mm.
  - All are relative to the template's nominal size.
- **Rim pairing.**
  - The template's placed cervical loop is parameterized by normalized arc length, starting at the most mesial point
    and running CCW around the axis.
  - The margin is resampled at the same arc fractions, with the same start rule and winding. That gives the
    intaglio rim, so rim k ↔ cervical vertex k.
- **Outer margin loop.** O_k = M_k + `marginThicknessMm` · h_k, where h_k is the outward in-plane normal of the
  margin curve.
- **Cervical blend.** Shell vertex (column i, height fraction s) moves by (O_i − C_i) · (1 − smoothstep(0, 0.6, s)).
  The cervical ring lands exactly on O.
- **Stitch.** A quad strip joins rim M_k ↔ O_k (the margin band). Result: one closed mesh.
- **`designCrown(input)`**
  - Input: `{ jaw: {positions, indices, normals, graph, ray}, antagonistRay?, frame, margin, axis, params, pose? }`.
  - Output: `{ mesh, pose, templateId, validation, minAxialThicknessMm, gapCheck, warnings, timings }`.
  - When `pose` is omitted it proposes one. Otherwise it uses the stored pose (the margin blend is always
    recomputed).

### Validation and export
- `geometry/meshValidate.ts`: `validateClosedMesh(mesh)` → `{ triangles, boundaryEdges, nonManifoldEdges,
  inconsistentEdges, degenerateTriangles, signedVolumeMm3, closed, oriented, ok }`.
- `io/exportCrown.ts`: `crownStl(mesh)` (binary STL via `writeBinaryStl`) and
  `constructionInfo({ doc, tooth, result, appVersion })` → JSON sidecar `dcad.construction@1`. The UI downloads
  `<caseRef>-<fdi>.stl` and `.construction.json`.

### Worker + UI
- Worker `designCrown(request)`: uses the retained scan, cached surface/region/smoothed normals, and the antagonist
  scan if loaded. The mesh is transferred back.
- `tools/crownTool.ts` derives the crown from the document whenever (scan sha, frame, margin, axis, params, crown)
  change (latest wins) and shows it as the `crown` viewer object (restoration matcap). "Propose crown" dispatches
  `setCrown({kind: 'template', templateId, pose})`.
- Steps: Parameters (form; each field commits `setParams` on change), Crown proposal (propose/re-propose, visibility,
  opacity, warnings), Finalize (validation table, min thickness, Export STL). Adapt stays disabled.

## Verification plan

- Unit:
  - Template shells are open with one boundary loop and outward normals.
  - Gap profile values.
  - On the synthetic prep, the intaglio gap measured along prep normals on axial walls is within ±0.01 mm of
    cement (+ spacer where it applies).
  - Each ray along the axis hits the intaglio exactly once.
  - The crown validates (closed, oriented, volume > 0) for 36 and its mirrored counterpart 46.
  - STL round-trip.
- Pipeline on `synthetic-36`: crown valid, gap checks pass, `crown.stl` written.
- Browser: propose → crown visible → edit a param → crown recomputed → export downloads a valid STL (re-parsed and
  validated).

## Work split

- Fork: `crownTemplate.ts`, `meshValidate.ts`, `io/exportCrown.ts` + tests.
- Main session: `intaglio.ts`, `crown.ts`, worker, crown tool, step UI, pipeline runner extension.

## Implementation summary

### What was built
- **`geometry/intaglio.ts`**
  - `cementGap` (0 at the margin → cement after `GAP_RAMP_MM` = 0.15 → + spacer from `distanceToMarginMm`).
  - `distanceFromMargin` (multi-source Dijkstra; `MinHeap` is now exported from `livewire.ts`) and `offsetPrep`
    (compact region submesh moved along smoothed normals, with its own BVH).
  - `buildIntaglio`: radial profiles, 200 envelope rays per profile, 32 arc-length points, centre fan, faces toward
    the prep. It renumbers so the rim is vertices 0..N−1 and warns if the margin is not star-shaped.
  - `measureIntaglioGap`: the verification measure on the axial walls.
- **`geometry/crown.ts`**
  - `crownAxes`: frame → template axes with handedness ε. `proposeCrownPose`: margin centroid; MD from the contacts,
    BL from the margin, height from the antagonist ray minus clearance, kept ≥ prep + min thickness + 0.5.
    `poseTransform`.
  - `designCrown`:
    - Pairs the template's cervical ring and the margin by normalized arc length, both CCW around the axis from the
      mesial end.
    - Builds the outer loop as margin + `marginThicknessMm` × the in-plane outward normal, then a cervical blend
      that fades out by 60% height.
    - Joins intaglio | shell | margin band into one mesh.
    - Then validates it, measures the axial thickness and checks the gap.
- **Fork** (template library, validation, export)
  - `geometry/crownTemplate.ts`: four procedural templates (upper/lower × premolar/molar, 6273 vertices / 12416
    triangles each, bounding boxes match the nominal sizes), plus `templateForTooth` and `closeCervix`.
  - `geometry/meshValidate.ts`: `validateClosedMesh` and `boundaryLoops`.
  - `io/exportCrown.ts`: `crownStl`, `constructionInfo` (`dcad.construction@1`) and `downloadBytes`.
- **Worker:** `designCrown(request)`. It reuses the cached prep region (now including `loopVertices`), smoothed
  normals (3 passes) and the antagonist BVH.
- **`tools/crownTool.ts`**
  - The crown is **derived data**: it is recomputed in the worker whenever (scans, frame, margin, axis, params,
    crown pose) change, so undo/redo and parameter edits always show the matching crown.
  - "Propose crown" dispatches `setCrown({kind:'template', templateId, pose})`. The crown shows as the `crown`
    viewer object in the params, proposal and finalize steps.
  - Export: STL and construction info.
- **UI:** step panels Parameters (`ParamsStep`, a schema-ranged form, reset to preset), Crown proposal
  (`ProposalStep`: propose/re-propose, visibility, opacity) and Finalize (`FinalizeStep`: validation table, gap error,
  Export STL, Construction info). `CrownStatusView` is shared between them. The proposal step zooms obliquely onto
  the tooth.
- **Pipeline runner:** `runCase` → `{ metrics, crownStl }`. It adds `crown` metrics, the checks `crown.watertight`,
  `crown.gap` (≤ 0.01 mm) and `crown.material` (> 0), and writes `out/pipeline/<id>/crown.stl`.

### Deviations from the spec
- **Export is two buttons** (STL, Construction info). Chrome blocks a second download started by one click; this
  showed up in the browser test.
- **The crown is not shown in the margin/axis steps**, and the margin line is hidden once the crown exists (the crown
  covers it).
- **Steps after a parameter change.** A parameter change marks `proposal` stale, as the generic invalidation rule
  says, even though the derived crown is already recomputed. That is defensible: the *pose* was proposed with the old
  clearance and thickness. Revisit with Day 4's re-run automation.
- **The prep-region cache in the worker** is keyed per margin content and never evicted within a session. Each entry
  is about 1.5 MB for a 1M-triangle scan. Fine for now.
- **Fixed a Day 2 bug found by the Day 3 browser run.** Leaving the axis step recursed forever: restoring the hidden
  antagonist re-entered `sync()` before the bookkeeping was cleared, giving "Maximum call stack size exceeded" and a
  frozen panel. The bookkeeping is now updated before the side effect, and `DesignTools.sync()` has a re-entrancy
  guard that re-runs once instead of recursing.

### Verification
- **Unit:** `pnpm test`: 6 shared, 106 web (2 skipped), 18 API unit, 1 pipeline-runner. `pnpm typecheck` and the web
  build are clean.
  - `crown.test.ts` (9 tests) covers the gap profile values. For 36 (right-handed frame) **and** mirrored 46
    (left-handed), the crown is closed, 2-manifold, consistently oriented with volume > 50 mm³, and the template is
    mirrored exactly for the left-handed quadrant.
  - The gap error on the axial walls is < 0.01 mm. Each of more than 400 rays along the axis inside the margin hits
    the intaglio exactly once (no undercut), and material is > 0.
  - Fork tests: 33 (templates, validation, STL round-trip, sidecar).
- **Pipeline:** `pnpm pipeline --synthetic` gives 14/14 checks.
  - Crown: watertight, gap error max 7.5 µm (mean 0.7 µm, 5569 wall samples), min axial thickness 3.53 mm, 185 ms on
    the 1M-triangle scan.
  - **trimesh** (independent library) on `crown.stl`: watertight, winding consistent, `is_volume`, 308.9 mm³,
    extents 10.5 × 9.1 × 8.3 mm.
- **Browser, offline** (`tools/e2e/offline-design.mjs`): Day 2 flow →
  - Propose: valid, 20,736 triangles, 88 ms in the worker.
  - Cement gap → 0.08 via the form: recomputed and still valid; step statuses update.
  - Export: both files downloaded. The browser STL passes trimesh (watertight, 304.9 mm³) and the sidecar has the
    edited parameters.
- **Browser, online** (`tools/e2e/online-case.mjs`): the crown pose is saved in v1. After a reload and reopen the
  document is identical and the recomputed crown has the same volume (309.115 → 309.115 mm³).

### Follow-ups
- **The crown shape is the walking skeleton.** The template is boxy and the cervical blend pinches the waist; the
  height comes straight from the antagonist ray, so it touches the antagonist. Day 4: RBF fit, thickness
  enforcement, then adapt (Day 5).
- **No triangle–triangle self-intersection check yet** (Day 5). Only a closed, oriented mesh is guaranteed.
- **Real annotated crowns** for `tools/library-builder` (same `CrownTemplate` format).
- **Manual check:** open `out/pipeline/synthetic-36/crown.stl` in a slicer or Meshmixer. Substituted here by trimesh.
