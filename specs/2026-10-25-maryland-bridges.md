# Resin-bonded (Maryland) bridges

Status: **in progress** (2026-10-25). Phase A (geometry) has landed; phase B (schemas, reducer, connectors to wings, UI, runner case) is next.
Depends on: [2026-10-25-bridge-mode.md](2026-10-25-bridge-mode.md) (pontics, connectors, union, anterior teeth).
Used by: [2026-10-25-inlay-bridges.md](2026-10-25-inlay-bridges.md) (the patch intaglio introduced here).

## Goal

Design resin-bonded bridges.
- A pontic is held by thin **wings** bonded to the lingual or palatal enamel of the abutment teeth, with little or
  no preparation.
- Both designs are supported:
  - **Single-retainer cantilever:** one wing, one pontic. This is the evidence-based standard for missing incisors.
  - **Two-retainer:** a wing on each side, which exocad also allows.
- Posterior resin-bonded bridges are allowed as well, as in exocad.

### What is different from a crown retainer

| | Crown retainer | Wing retainer |
|---|---|---|
| Prep | Full circumferential prep | None or minimal (enamel) |
| Margin | Closed loop around the prep | **Wing outline**: a closed loop on the lingual surface |
| Fitting surface | Intaglio over the whole prep | The tooth surface inside the outline, plus the cement gap |
| Outer surface | Library anatomy | The fitting surface offset by the **wing thickness** |
| Main risks | Thickness, connectors | Wing too thin, **no space against the antagonist**, connector clashes with the abutment tooth |

### Clinical numbers (Kern's zirconia RBFDP guidance, cited in the sources)

- Wing thickness: at least 0.5 mm; **0.7 mm** is the target.
- Connector: at least **3 mm high** and **2 mm wide**.
- Single-retainer zirconia cantilever RBFDPs for incisors: 97.3% survival at 15 years.

## Decisions (please confirm)

1. **Restoration type:** `maryland-wing`. Its role is abutment, and its geometry is a wing.
   - Connectors are allowed from a wing to a pontic or to another wing; any other connection from a wing is
     refused.
   - Materials: zirconia (default), CoCr (classic Maryland), lithium disilicate (anterior only; outside that, a
     warning as in bridge mode).
2. **Defaults** (placeholders, to confirm in domain QA):
   - wing thickness 0.7 mm (minimum 0.5 mm)
   - edge thickness 0.2 mm, rising to full thickness within 1.0 mm of the outline
   - resin cement gap 0.03 mm, uniform (no spacer ramp)
   - connector minimum 3 mm high and 2 mm wide, for every material: Kern's numbers are the strictest published ones
     we found
3. **The wing outline is drawn by the user** with the existing live-wire margin tool.
   - An automatic outline proposal is part of the AI section, and is the first thing to cut.
4. **Retention features are out:** grooves, pin holes and proximal boxes. Wings are flat-bonded, which is what the
   cited zirconia RBFDPs use.

## Scope

In:
- `maryland-wing` units, with the outline step (the margin step, labelled "Wing outline" for wings).
- The **surface-patch retainer** geometry (shared with inlays):
  - copy the tooth surface inside the outline
  - apply the cement gap
  - block out along the insertion axis
  - thicken
  - close with a band
- Antagonist space check and "insufficient space for the wing" report.
- Connectors from wing to pontic, with a tooth-clearance check.
- A common axis over the wings.
- Export and sidecar.
- Synthetic golden case: upper `11w–[12]` single-retainer cantilever (no patient data).

Out:
- Retention grooves, pin holes, proximal boxes, and minimal-prep design guides.
- Automatic minimal preparation suggestions.
- Pressed or layered wings (use the framework spec's cutback on the pontic only).

## Design

### Document and commands

- `RestorationType` adds `maryland-wing`.
- A wing uses `ToothDesign.margin` for its outline: same schema, live-wire anchors and dense points. It uses
  `ToothDesign.axis` for the insertion axis, shared across the bridge as in bridge mode.
- `stepsFor('maryland-wing')`: setup, scans, frame, margin (labelled "Wing outline"), axis, params, proposal, adapt
  (occlusion check only), finalize.
- `DesignParams` gains `wingThicknessMm?` and `wingEdgeThicknessMm?` (optional, with defaults), so saved documents
  load.
- `SetParam` covers both; there is no new command.

### Geometry: the surface-patch retainer (`apps/web/src/geometry/patchRetainer.ts`)

Shared by wings (outer = offset) and inlays (outer = anatomy, in the inlay spec).

1. **Region:**
   - The outline is a closed vertex loop on the jaw scan, from the live-wire.
   - The existing `prepRegion` flood fill from a seed inside the outline gives the vertices and faces.
   - The seed is the frame click, which for a wing is on the lingual surface.
2. **Patch copy:** the region's faces are copied into a new mesh, with the outline vertices as its boundary loop.
   The copy keeps the scan's resolution, so there is no remeshing.
3. **Cement gap:** each vertex moves along the smoothed normal by the gap. For wings the gap is uniform; inlays use
   the existing `cementGap(d)` ramp from the margin.
4. **Blockout:**
   - Each vertex is lifted along +axis to the upper envelope of the offset patch: a ray from above along −axis,
     first hit.
   - The wing can then slide on along the axis.
   - The blocked-out area is reported per unit. A wing loses bonding area there, which is shown, not hidden.
5. **Outer surface (wings):** each patch vertex offset by `thickness(d)` along the smoothed normal. d is the
   geodesic distance to the outline, and the thickness ramps from the edge thickness to the wing thickness within
   1 mm, which feathers the edges. The field is smoothed, as in adaptation, to avoid folds.
6. **Band:** a triangle strip joins the outline loop of the fitting patch to the outline loop of the outer patch.
   They have the same vertex count, so the strip is direct. The result is a closed solid; its validation is
   `validateClosedMesh` plus self-intersection.

The crown intaglio needs a star-shaped margin seen along the axis. This method does not: a wing outline is often
crescent-shaped. The crown pipeline is unchanged.

### Geometry: wing checks

- **Antagonist space:**
  - The outer surface's clearance to the antagonist, along the axis, is computed with the existing `clearanceMap`.
  - If clearance < `occlusalClearanceMm` anywhere, the wing is **not** thinned below the 0.5 mm minimum. Instead the
    report is **"insufficient space for the wing"**, with the area and the smallest clearance. This is the
    counterpart to "insufficient reduction", and the clinical answer is a minimal prep or an occlusal adjustment.
  - Above the minimum, the wing may be thinned locally toward 0.5 mm to make room, and this is reported.
- **Bonded area:** the area of the fitting patch, and the fraction blocked out. Reported only; there is no published
  threshold to gate on.

### Geometry: connectors to wings

- The connector's wing end sits on the outline's proximal part facing the pontic: the outline points with the
  largest component toward the pontic.
- The **end sinks only into the wing**, by the wing thickness minus 0.2 mm, and never through the fitting surface.
  Where the bridge-mode sink rule allows more, it is capped.
- **Tooth clearance:** a connector next to a natural abutment must not penetrate the tooth.
  - The connector's clearance to the jaw scan must be ≥ the cement gap, except where it overlaps the wing.
  - It is checked along the insertion path: the swept volume must not hit the tooth.
  - Failure: **"connector clashes with the abutment"**.
- Sizing as in bridge mode, with the Maryland minimum (3 mm × 2 mm). Width may be smaller than height, which is the
  Kern geometry.

### App

- **Setup:** "Maryland wing" as a type on a selected tooth next to a pontic. The connector toggle appears.
- **Outline step:**
  - The margin tool's live-wire on the lingual surface, starting from the frame click.
  - The view: lingual for the lower jaw, palatal for the upper.
- **Proposal step:** the wing is derived (no template pose); the pontic is proposed as in bridge mode.
- **Adapt step:**
  - Wing thickness and edge thickness.
  - Space report, bonded area, and blocked-out area.
  - The connector panel, with the tooth-clearance state.
- **Export:** one STL per bridge, plus a sidecar: wing outline, thickness, bonded and blocked-out area, connector
  dimensions.

### AI layer

- `classical.wing-outline@1` (first to cut): proposes outline anchors.
  - The candidate region is the lingual-facing faces of the abutment crown (n·(−buccal) > 0.3), between 0.5 mm
    above the gingiva and 1.0 mm below the incisal edge or occlusal contacts, extended into the proximal surface
    facing the pontic.
  - Its boundary is smoothed into 12 anchors for the live-wire.
  - Gate: the outline is closed, the region is closed, and the bonded area is > 0.
- The bridge gate adds the wing checks: thickness ≥ minimum, no space conflict, no connector clash.
- The agent can change wing parameters with `set_param`. The prompt explains wing terms.

### Synthetic data and pipeline runner

- `syntheticArch` gains an unprepared abutment: no change to the tooth.
- Golden case `synthetic-maryland-11-12`:
  - upper jaw, 12 missing
  - 11 as the wing abutment, with scripted outline anchors on its palatal surface
  - the lower arch as the antagonist
- Runner metrics: wing thickness statistics, space conflicts, bonded and blocked-out area, connector dimensions and
  tooth clearance, union validation, seating (fitting-patch gap) and `bridge.stl`.

## Verification plan

Tests: +1 new, 1 extended.
- **New** variant in `tools/pipeline-runner/src/pipeline.test.ts` (wings are the point): the synthetic Maryland case.
  - The union is closed, printable and one component.
  - The wing thickness is 0.7 mm ± 0.02 away from the edges, and ≥ 0.5 everywhere outside the edge ramp.
  - The fitting gap is 0.03 ± 0.01 mm on the patch.
  - The connector is ≥ 3 mm high and ≥ 2 mm wide.
  - The connector has no clash with the abutment.
  - There is no space conflict in the default synthetic occlusion.
- **Extended** `qa.test.ts`, bridge gate:
  - It fails on a space conflict (the same case with the antagonist moved 0.5 mm closer), on a connector clash, and
    on a wing below 0.5 mm.
  - It passes the good case.

Also:
- `pnpm typecheck` and `pnpm test`.
- Bridge-mode outputs are unchanged (sha256).
- **Manual:** open the STL in Meshmixer. The wing should hug the palatal surface with feathered edges, and the
  connector should clear the tooth.

## Work split

1. Schemas and steps for wings.
2. `patchRetainer.ts`, the wing checks, connectors to wings, and the runner case.
3. App: outline step labels, the Adapt panel, export.
4. AI: outline proposer, gate, prompt.

## Risks

- **Patch blockout on curved palatal surfaces** can lift a large share of the wing off the enamel. Reporting the
  blocked-out fraction keeps this visible. A follow-up could tilt the axis search toward the wing region.
- **Scan noise on enamel** is copied into the fitting surface. That is correct for the fit, but noise spikes can
  fold the thickened outer surface. The thickness field smoothing and the self-intersection check guard this.

## Sources

- Kern et al., single-retainer all-ceramic RBFDPs, long-term outcomes (J Esthet Restor Dent 2023):
  <https://onlinelibrary.wiley.com/doi/10.1111/jerd.13001>
- Long-term outcome of anterior cantilever zirconia RBFDPs (J Prosthet Dent 2025):
  <https://www.thejpd.org/article/S0022-3913(25)00071-X/fulltext>
- Bonding performance of zirconia cantilevered RBFDPs (in vitro + FEA):
  <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10095828/>
- exocad DentalCAD product page (Maryland bridges): <https://exocad.com/our-products/dentalcad>

## Implementation summary

### Phase A (2026-10-25): surface-patch retainer and wing geometry
- **`apps/web/src/geometry/patchRetainer.ts`** builds the retainer in steps:
  - `buildFittingPatch`: region copy at scan resolution, then a gap callback of geodesic distance (uniform for wings,
    `cementGap(d)` for inlays), then blockout along the axis with its area and fraction reported.
  - `patchRetainer<T>` adds an outer-surface plug-in and the band, giving a closed solid.
  - Helpers: `offsetOuter`, `closePatch`, `validatePatchSolid`, `fittingSurfaceOf`, `measurePatchGap`,
    `simplifyOutlineLoop`.
- **`wing.ts`**:
  - `designWing`: thickness ramp from the 0.2 mm edge to 0.7 mm within 1 mm; space check along the axis, with local
    thinning toward the 0.5 mm minimum and "insufficient space for the wing"; bonded and blocked-out area.
  - `wingInsertionAxis`: the common axis over several wing masks.
  - `WING_DEFAULTS` (local until phase B).
- **`syntheticWing.ts`**: `syntheticWingOutline` gives scripted palatal or lingual outline anchors on the synthetic
  arch.
- **Verified with scratch scripts** (11 palatal wing, 12 missing; 400×120 and 1000×500 grids):
  - Closed, printable, 0 self-intersections.
  - Thickness 0.700 beyond the ramp, edge minimum 0.200.
  - Fitting gap error ≤ 0.0009 mm; bonded area 14.7 mm²; 138 ms at full resolution.
  - Space conflict and thinning cases behave as specified.
  - The inlay path, with a `cementGap` ramp on a crown-prep region, closes with gap error ≤ 0.004 mm.
- **Deviations:**
  - The spec's forced conflict (antagonist 0.5 mm closer) cannot conflict on the synthetic 11, which has 2.37 mm
    of clearance. It is shown with a larger shift, and on 33.
  - Clearance is measured along the axis, as for crowns' "insufficient reduction".
  - Offset directions come from the jaw's smoothed normals.
  - Only the edge ramp is smoothed.
  - Self-touching live-wire traces are simplified.
- **Open:** an outline in an undercut folds the wing, which then reports not printable. Until a side-wall blockout
  exists, the phase B gate must fail on `outlineUndercutPoints > 0` or `undercutFaces > 0`.
