# Inlay and onlay retainers (inlay bridges)

Status: **done** (2026-10-26). Phase A (synthetic cavities, inlay/onlay geometry), phase B (inlays and onlays in the editor, inlay bridges, the runner case) and the AI items (inlay proposer, auto-design, gate, assistant) have landed. The defaults await domain QA.
Depends on:
- [2026-10-25-bridge-mode.md](2026-10-25-bridge-mode.md) (pontics, connectors, union)
- [2026-10-25-maryland-bridges.md](2026-10-25-maryland-bridges.md) (the patch intaglio in `patchRetainer.ts`)

## Goal

Design inlays and onlays, which are partial-coverage restorations in a cavity prep:
- as **single restorations**
- as **bridge retainers** (inlay-retained bridges)

exocad supports both. The plan's MVP listed inlays under Out; they come in here because an inlay bridge needs them.

### What is different from a crown

| | Crown | Inlay / onlay |
|---|---|---|
| Prep | Stump; the margin is a closed loop around it | **Cavity**: an occlusal isthmus plus proximal boxes (inlay), or with cusps reduced (onlay) |
| Margin seen along the axis | Star-shaped around its centre | Often **not** star-shaped (an MOD cavity is dumbbell-shaped), and proximal box walls are parallel to the axis |
| Outer surface | The whole library anatomy | Only the **missing part** of the tooth, which must meet the natural surface at the margin |
| Joint at the margin | Margin band (chamfer or shoulder) | Butt joint: the restoration meets the tooth at the cavosurface edge |

### Clinical numbers (inlay-retained zirconia bridges, cited in the sources)

- **Preparation:** occlusal depth 2.5 mm, isthmus width 3 mm, proximal box depth 2 mm.
- **Connectors:** at least **3 × 3 mm**; 4 × 4 mm distributes stress noticeably better.
- **Indications:** coronal height ≥ 5 mm, parallel abutments, edentulous gap ≤ 12 mm.

## Decisions (please confirm)

1. **Restoration types:** `inlay` and `onlay`. They share the geometry, and both can be single restorations or
   bridge abutments. The type only sets defaults and labels (an onlay's region includes cusps).
2. **The outer surface comes from one of two sources:**
   - **The pre-op scan**, when the case has one (`ScanRole` `preop`, already in the schema). The restoration copies
     the tooth as it was. The pre-op scan is assumed aligned with the jaw scan, like all scans in this MVP; aligning
     it is out.
   - **The library tooth**, fitted to the remaining natural surface.
3. **Defaults** (placeholders, to confirm in domain QA):
   - minimum retainer thickness 1.5 mm at the isthmus (new `retainerMinThicknessMm`); single inlays keep the
     material's `minThicknessMm`
   - inlay-bridge connectors ≥ 3 mm high and ≥ 3 mm wide
   - warnings when the gap is over 12 mm or the abutment coronal height is under 5 mm
4. **Veneers are out.** They are not bridge retainers, but the same code supports them, so they are a cheap
   follow-up.

## Scope

In:
- `inlay` and `onlay` types (single and as retainers), with the margin, axis, proposal, adapt and finalize steps.
- **Intaglio:** the patch method from the Maryland spec, with the cement-gap ramp and spacer. It does not need a
  star-shaped margin.
- **Outer surface:** from the pre-op scan or the fitted library tooth, by **snap and subtract** (below).
- Margin-fit check, isthmus thickness, and inlay-bridge connector sizing limited by the box depth.
- Synthetic MOD cavities and the golden case `35-inlay–[36]–37-inlay`.
- Export and sidecar.

Out:
- Pre-op scan alignment (best fit on unprepared teeth).
- Veneers.
- Automatic cavity margin detection: the live-wire works on cavosurface edges, which are convex, but the
  radial-profile auto margin assumes a stump.
- Inlay design guides that suggest a cavity shape.

## Design

### Document and commands

- `RestorationType` adds `inlay` and `onlay`. Their role is abutment.
- `ToothDesign.outerSource?: 'preop' | 'library'`. The default is `preop` when a pre-op scan exists, otherwise
  `library`.
- `DesignParams.retainerMinThicknessMm?` (optional, with a default).
- `stepsFor(inlay | onlay)` = all steps. The margin step's label is "Cavity margin".
- The existing `setMargin`, `setAxis` and `setCrown` apply: the library pose for the library source.
- There is no new command; the agent edits the pose (move, rotate, scale) as for crowns.

### Geometry (`apps/web/src/geometry/inlay.ts`)

**Intaglio:** `patchRetainer` from the Maryland spec, on the cavity region.
- The region is the flood fill inside the margin from the seed, which is the cavity floor.
- The gap is the existing `cementGap(d)`: 0 at the margin, ramping to the cement gap, plus the spacer beyond
  `distanceToMarginMm`.
- Blockout along the axis.

**Outer surface: snap and subtract.** This uses the manifold-3d booleans added by bridge mode.
1. **Remaining-tooth solid S.** The fitting patch (cavity, offset and blocked out) plus a collar of the natural
   tooth surface 3 mm around the margin. It is closed by extruding the collar's outer boundary 6 mm along −axis and
   capping it.
2. **Anatomy solid A:**
   - *pre-op:* the pre-op scan's surface over the same footprint, closed the same way.
   - *library:*
     - The library tooth for the FDI is posed in the frame.
     - It is fitted to the natural tooth: a least-squares pose and scale on the collar points, then an RBF fit that
       pins sampled collar points onto the scan surface.
     - It is closed with `closeCervix`.
3. **Snap:**
   - A's vertices whose closest scan point is on the natural surface outside the margin (the collar, not the
     cavity) move 0.1 mm *inside* S, along −normal.
   - A then only exceeds S where tooth structure is missing, which is inside the margin.
4. **Subtract:** restoration = A − S (manifold-3d).
   - The largest component that covers the cavity is kept.
   - Pieces thinner than 0.05 mm are dropped.
5. **Margin fit:** the restoration's outer boundary, where A crosses S, lands within about one template edge (≈0.2
   mm) of the drawn margin. It is relaxed onto the margin by moving the boundary vertices to their closest margin
   point, then smoothing one ring.
   - Check: the boundary is within **0.05 mm** of the margin, measured with `distanceToClosedPolyline`.

**Single onlays:**
- The region covers the reduced cusps.
- The anatomy restores them, and occlusal adaptation works as for crowns: the outer surface keeps its template
  height fractions through the RBF fit.

**Checks:**
- closed and printable
- margin fit within 0.05 mm
- isthmus thickness, measured as the intaglio-to-outer distance along the axis in the cavity's central part, ≥
  `retainerMinThicknessMm`
- seating unchanged after the bridge union
- warnings: gap > 12 mm, coronal height < 5 mm, and abutment axes diverging more than the common axis can block out

### Connectors for inlay bridges

- The connector sits in the proximal box facing the pontic.
- Its **available height** is the box depth plus the marginal ridge, not the crown's height of contour:
  - the bottom ≥ 1 mm above the gingiva, as in bridge mode, and also no lower than the box floor plus 0.5 mm
  - the top ≥ 1 mm below the marginal ridge
- The minimum is 3 × 3 mm, using the bridge-mode sizing with these limits. If the box is too shallow, the report
  is "insufficient connector height: box too shallow".

### App

- **Setup:** "Inlay" and "Onlay" types.
- **Margin step:** "Cavity margin" with the live-wire. The view zooms onto the occlusal surface, then the proximal
  boxes.
- **Proposal step:**
  - "Propose inlay" builds the outer surface.
  - With the library source, the move/rotate/scale tools adjust the fitted tooth.
  - A source switch appears when a pre-op scan exists.
- **Adapt step:** occlusion, free-side contacts, isthmus thickness and margin fit.
- **Export:** as for crowns and bridges. The sidecar adds the outer source, the margin-fit statistics and the
  isthmus thickness.

### AI layer

- `classical.inlay-outer@1`: picks the outer source and fits the library tooth.
  - Gate: margin fit, thickness and printability.
- In auto-design, inlay units skip the auto margin: the cavity margin must be traced, or come from a scripted
  anchor list in the runner.
- The agent prompt explains inlay and onlay terms.

### Synthetic data and pipeline runner

- `syntheticArch` gets `cavities?: Array<{ fdi; kind: 'mod' | 'mo' | 'do' | 'onlay' }>`. An analytic cavity is
  carved into the tooth dome: isthmus, boxes, rounded internal angles, cavosurface edge. Its margin is known
  exactly, so it can be the reference.
- `syntheticPreop` gives the same arch without the cavities, as the pre-op scan.
- Golden case `synthetic-inlay-bridge-35-37`: MOD cavities on 35 and 37, 36 missing, run once with the pre-op source
  and once with the library source.

## Verification plan

Tests: +1 new, 2 extended.
- **New** variant in `tools/pipeline-runner/src/pipeline.test.ts` (inlay retainers are the point): the synthetic
  inlay bridge.
  - The union is closed, printable and one component.
  - The margin fit is ≤ 0.05 mm on both retainers.
  - The isthmus thickness is ≥ 1.5 mm.
  - Connectors are ≥ 3 × 3 mm.
  - Seating is unchanged.
  - **With the pre-op source, the restoration's outer surface matches the pre-op tooth within 0.05 mm** (mean
    Hausdorff). This is an exact reference for the snap-and-subtract method.
- **Extended** bridge reducer test: an inlay abutment takes part in the common axis like a crown abutment.
- **Extended** `qa.test.ts`:
  - The inlay gate fails on a margin fit > 0.05 mm, a thin isthmus, and a shallow box (connector height).
  - It passes the good case.

Also:
- `pnpm typecheck` and `pnpm test`.
- Earlier runner outputs unchanged (sha256).
- **Manual:** open the inlay STLs in Meshmixer. Check that the butt joint is flush at the margin and the proximal
  surfaces are restored.

## Work split

1. Schemas, steps, synthetic cavities and the pre-op arch.
2. Snap and subtract, checks, connectors limited by the box, and the runner case.
3. App: labels, source switch, Adapt panel, export.
4. AI proposer and prompt.

## Risks

- **Snap and subtract near the margin.** If the library fit is poor (more than 0.2 mm off the natural surface), the
  crossing curve wanders, and relaxing it can fold the boundary. The pre-op source is exact, so it is the
  recommended path. The library fit's residual on the collar is reported, and the fit fails above 0.15 mm.
- **Proximal box walls parallel to the axis.** The patch intaglio keeps them, because it copies the scan surface.
  Blockout can still create slivers there; the self-intersection check guards this.
- **Boolean cost.** Two booleans per inlay plus the bridge union. This is fine for 3–4 units; it is measured in the
  runner.

## Sources

- Inlay-retained zirconia FDP, clinical option and preparation guidelines (PMC4055644):
  <https://pmc.ncbi.nlm.nih.gov/articles/PMC4055644/>
- Connector dimensions and stress distribution in monolithic zirconia and lithium disilicate IRFDPs:
  <https://www.sciencedirect.com/science/article/pii/S1687857415000025>
- Three-year performance of inlay- and wing-retained zirconia RBFPDs (randomized pilot):
  <https://www.sciencedirect.com/science/article/pii/S0300571225002519>
- exocad DentalCAD product page (inlay bridges): <https://exocad.com/our-products/dentalcad>

## Implementation summary

### Phase A (2026-10-26): synthetic cavities and inlay/onlay retainer geometry
- **Synthetic cavities:**
  - `syntheticCavity.ts` holds analytic MOD/MO/DO/onlay cavities (`CAVITY_DIMENSIONS`: occlusal depth 2.5 mm, box
    floor 2 mm below the pulpal floor, 8° walls, 0.4 mm fillets) with an exact margin contour.
  - `synthetic.ts` gains `cavities`, `syntheticCavityMargin`, `syntheticCavitySeed` and `syntheticPreop`. The default
    arches are byte-identical.
- **`inlay.ts` `designInlay`:**
  - The fitting patch with the `cementGap` ramp and blockout, the remaining-tooth slab S, and the anatomy slab A
    (pre-op scan, or the library tooth fitted by `anatomyFit.ts` `fitAnatomy`).
  - Then shaping and snapping, A − S, and a relax onto the margin.
  - Checks: printable, margin fit, isthmus thickness, library-fit residual, seating.
  - Helpers: `inlayConnectorLimit` (the connector's available height comes from the proximal box: "Insufficient
    connector height: box too shallow"), `inlayConnectorUnit`, `measureCavitySeating`, `inlayBridgeIndications`.
  - `faceSets.ts` holds the slab and mesh-cleanup helpers.
- **Verified with scratch scripts** (MOD on 35 and 37, onlay on 36, 2000×250 grid with 1M triangles):
  - Every result is printable with 0 self-intersections.
  - Margin fit ≤ 0.045 mm; isthmus ≥ 2.4 mm (onlay 1.78); gap error ≤ 8 µm.
  - With the pre-op source, the outer surface is 0.001 mm (mean) from the pre-op tooth.
  - The library collar fit passes (p95 ≤ 0.136 mm).
  - A trial bridge union with a pontic and two 9 mm² connectors (3.2–3.6 mm high) gives one component of genus 0,
    with seating unchanged.
  - A shallow box fails as intended.
- **Deviations:**
  - The solids are closed as slabs along a height-field direction within 15° of the axis, not as walls plus a cap.
  - The library tooth is sampled onto the scan instead of subtracted directly.
  - The snap shapes A along that direction, so the crossing lands on the margin.
  - The library-fit gate uses the p95 residual.
- **Integration fix:** `inlayConnectorUnit` now passes the fitting surface as `inner`, because the connectors' signed
  fit clearance (review fix 07cfd8f) needs it.
- **Open:**
  - The pre-op union has one 2e-7 mm² rounding sliver, so the bridge reports not printable until phase B fixes it.
  - `buildFittingPatch` can fold where it lifts isolated wall vertices.
  - Grids with 0.12 mm rows are too coarse for the 0.05 mm margin tolerance, so the runner case must use 2000×250.
  - On the library source, the onlay's occlusion is not adapted yet.

### Phase B (2026-10-26): inlays and onlays in the editor, inlay bridges, runner case
- **Shared:**
  - `inlay` and `onlay` types: role abutment, connecting to pontics only (`isCavityRestoration`).
  - Optional `DesignParams.retainerMinThicknessMm` (0.5–3 mm, default 1.5).
  - `ToothDesign.outerSource`, read with `outerSourceOf`: the pre-op scan while the case has one, unless the library
    tooth was chosen.
  - The `SetOuterSource` command.
- **Reducer** (`apps/web/src/design/inlay.ts`):
  - Switching between the crown, wing and cavity families redoes the margin.
  - `setOuterSource` applies to cavity teeth only, and to `preop` only with a pre-op scan; a change redoes the
    proposal.
  - Adding, replacing or removing the pre-op scan redoes or invalidates the proposals that depend on it.
  - A pre-op inlay cannot be moved: it follows the scan.
  - Inlay abutments share the common axis like crowns.
- **Geometry:**
  - `geometry/inlayUnit.ts`: `designInlayUnit` returns an inlay as a crown-shaped unit (fitting surface first; the
    pre-op one has the placeholder template `inlay-preop`).
  - `geometry/inlayChecks.ts` holds the inlay gate: margin fit, isthmus, margin undercut and library fit.
  - `designBridge` dispatches inlay units. The pre-op scan's hash is part of the unit's cache key, and the unit's
    fitting surface is its first `fittingFaces` faces.
  - Connectors to an inlay (`ConnectorUnit.inlay`, `INLAY_BRIDGE_CONNECTOR`):
    - centred between the walls of the proximal box they pass through;
    - bottom at least 0.5 mm above the box floor;
    - at least 3 mm wide (widening only adds area);
    - when the box floor sets the bottom and the height is short, the failure is `box-too-shallow`.
  - The union measures inlay seating with `measureCavitySeating` and adds the inlay checks.
  - An edentulous gap over 12 mm is a warning.
- **Worker, tools and UI:**
  - The worker serves single inlays and inlay bridge units from the pre-op scan's sha (`InlayRequest`). The fitting
    patch stays in the worker.
  - The pre-op scan starts hidden.
  - Setup gets Inlay and Onlay. The margin step is "Cavity margin", with its own hints.
  - Parameters get an "Inlay / onlay" group.
  - Proposal gets "Propose inlay", the outer surface switch, and no nudges on a pre-op inlay.
  - Adapt gets an inlay panel: source, margin fit, isthmus, library fit, fitting gap and the bridge's connectors.
  - Finalize drops the adaptation rows and adds margin fit, isthmus, seat and library fit.
  - The sidecar carries the outer source, margin fit, isthmus, fit, blockout, library residual and coronal height.
  - Export all names "inlay bridge 35–37" and "36 inlay".
- **Kinked-margin warning: kept for cavity margins.** The rule flags a line that turns more than 120° within 0.6 mm,
  which is a tracing error on any margin. MOD box corners turn about 90° over 0.4 mm fillets and are not flagged
  (none on the synthetic MOD margins, clicked or scripted). The warning names the restoration.
- **Runner:**
  - `synthetic-inlay-bridge-35-37` (pre-op source) and `synthetic-inlay-bridge-35-37-library`, at 2000 × 250, with
    16 analytic margin anchors per cavity.
  - `GoldenCase.scans.preop` holds the pre-op scan.
  - New checks: connectors at least 3 × 3 mm, and `inlay.preopMatch` (outer surface to pre-op, both ways, mean
    ≤ 0.05 mm).
- **Test:** `pipeline.test.ts` "passes every check on the synthetic inlay bridge, and fails a connector moved out of
  the proximal box" (110 → 111). The shared test (inlays connect to pontics, not crowns) and the reducer bridge test
  (common axis, the source switch, no moves on a pre-op inlay) are extended.
- **Deviation: the anatomy is built on S's fitting vertices, for both sources** (`sampledTop` in
  `geometry/inlay.ts`).
  - Each fitting vertex except the margin is raised along the slab direction to the anatomy over it: the pre-op
    surface where a ray from under it leaves the pre-op tooth, or the fitted library tooth.
  - Each is also kept at least 0.02 mm above itself.
  - The margin and the collar stay on the scan, and `lowerCollar` drops the collar into S.
  - Inside the margin, A and S are then the same triangles seen along the slab direction, with A at or above S on
    every corner, so A − S meets the traced margin exactly.
  - This replaces the phase A pre-op crop (the pre-op scan's own triangles) and the snap's lift and margin-column
    rules. The relax stays as a guard.
  - Why: the crossing used to land within one scan edge of the margin. Edges on steep box walls are 0.2–0.3 mm, so
    the gap reached 0.044–0.045 mm in the runner and 0.054 mm (pre-op) and 0.068 mm (library) in the editor, where
    the clicks land up to 0.2 mm off the cavity edge. The relax could not close it: the boolean's slivers flip, and
    undoing it locally moves the fold elsewhere.
  - Now every margin fit is 0.000 mm (runner, editor, both sources), and designing the two pre-op inlays takes
    2.4 s, against 3.3 s before.
- **Deviation:** the margin fit is measured against the margin as traced on the scan (the loop through its
  vertices). The dense points are a resampling of it that cuts its corners by up to a scan edge.
- **Runner numbers** (both cases 45/45; the existing cases' inputs and outputs are byte-identical to main, timings
  aside):
  - Margin fit 0.000 mm on 35 and 37 (455 and 550 boundary vertices).
  - Pre-op source: outer surface to the pre-op tooth 0.0002 / 0.0015 mm mean both ways (largest 0.063 / 0.068 mm);
    isthmus 2.437 / 2.436 mm.
  - Library source: collar residual p95 0.135 / 0.078 mm (limit 0.15); isthmus 2.663 / 2.722 mm.
  - Fitting gap error ≤ 0.0082 mm. Seating on the union unchanged: same samples, Δ ≤ 6 µm.
  - Connectors measured at 9.0045 mm²: 3.39 × 3.39 and 3.31 × 3.47 mm (pre-op); 3.39 × 3.39 and 3.19 × 3.60 mm
    (library).
  - The union is one printable solid of genus 0 (94,738 triangles).
- **E2E:** `tools/e2e/inlay.mjs`, 23/23.
  - Setup, the three scans (pre-op hidden), frames on the cavity floors and pontic placement.
  - The clicked cavity margins: every click within 0.22 mm of the analytic edge, the trace within 0.21 mm of it.
  - The common axis; Propose bridge as one undo entry; both pre-op inlays at margin fit 0, isthmus 2.44 mm.
  - Connectors of at least 3 × 3 mm; the switch to the library tooth and back (p95 0.12 mm, margin fit 0).
  - Check bridge, the Finalize rows, the sidecar, Export all (ready) and a single inlay.
  - The exported STL is one closed solid of genus 0.

### AI items (2026-10-26): inlay proposer, auto-design, gate, assistant
- **`classical.inlay-outer@1`** (`apps/web/src/ai/proposers.ts`) is the proposal step of a single inlay or onlay.
  - It designs from the case's outer source: the pre-op scan when there is one, else the fitted library tooth.
  - Gate: the crown gate (closed, printable, thick enough) plus the inlay checks.
  - In a bridge the bridge proposal designs the inlays, and `bridgeGate` adds their checks from the union.
- **Auto-design:**
  - The automatic margin (`classical.margin-ridge`) never runs on a cavity: its ridge search assumes a stump.
  - The cavity margin is traced by hand. Without one, the axis step says so.
  - A run starts at the first step at or after the requested one that has a proposer for the tooth, so a single
    inlay with its frame starts at the axis. Before, it fell back to the frame and re-proposed it.
  - Single inlays skip the adaptation; in a bridge, the inlays get no adaptation targets.
  - The auto-design panel says what it does for inlays and that the margin is traced first.
- **Assistant:** the prompt explains inlays and onlays, their outer source (a pre-op one is never moved),
  `retainerMinThicknessMm` and the 3 × 3 mm connector in the proximal box ("box too shallow").
- **Export all** lists each wing and inlay check once (the unit rows), not again from the gate.
- **Tests** (no new ones):
  - `qa.test.ts`: the inlay checks inside `bridgeGate` pass, then fail on a 0.068 mm margin fit, a 1.1 mm isthmus
    and a `box-too-shallow` connector.
  - `orchestrator.test.ts`: a single inlay with its frame starts at the axis. This fails on the old start rule.
- **Verified on the integrated tree** (main + the AI items + this):
  - typecheck, 111 tests, build;
  - runner `--synthetic` 8/8;
  - the browser tests `bridge.mjs` 34/34, `ai-bridge.mjs` 16/16, `implant.mjs` 31/31, `maryland.mjs` 16/16,
    `anterior-export.mjs` 13/13, `framework.mjs` 22/22, `inlay.mjs` 23/23, `ai-implant.mjs` 13/13,
    `ai-maryland.mjs` 7/7 and `ai-framework.mjs` 6/6, with no console errors.
- **Open:**
  - Real pre-op scans must be aligned with the jaw scan first (out of scope). A misaligned one leaves a step at the
    margin.
  - The anatomy is a height field along the slab direction: an outer contour that overhangs the margin seen along
    the axis is filled straight up.
  - Onlays from the library tooth get no occlusal adaptation.
  - Coarse scans: on the 1000 × 500 grid (0.12 mm rows) the margins still fit exactly, but on both sources 37's
    restoration intersects itself (7–8 triangle pairs) and the 35–36 connector gets 2.74–2.86 mm of height. So the
    golden case stays at 2000 × 250, and real scans this coarse need a look.
  - The assistant's metrics do not report margin fit or isthmus yet.
  - The defaults (1.5 mm isthmus, 3 × 3 mm connectors, 0.05 mm margin fit) still await domain QA.
