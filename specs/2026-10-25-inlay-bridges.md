# Inlay and onlay retainers (inlay bridges)

Status: **spec, awaiting review** (2026-10-25). No code yet.
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

_To be written after implementation._
