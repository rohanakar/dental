# Bridge mode

Status: **in progress** (2026-10-25). Wave 1 of 4 has landed (schemas, reducer, anterior teeth, geometry building blocks).

## Goal

Design a bridge (fixed partial denture) end to end, the same way a single crown works today:
- **Retainers:** crowns on the prepared abutment teeth.
- **Pontics:** replacement teeth over the edentulous ridge.
- **Connectors:** the solid joints between neighbouring units.

The result is one watertight, printable solid that seats along one common insertion axis. It exports as one STL
with a construction sidecar.

**Which bridges: whatever exocad DentalCAD allows** (user decision, 2026-10-25):
- any teeth (anterior and posterior)
- any span, up to a full arch
- across the midline
- cantilever pontics
- several bridges per case

The plan's MVP listed both bridges and anterior teeth under **Out**. This spec brings in both, because a bridge
retainer or pontic on an anterior tooth is an anterior crown. As a side effect, single anterior crowns work too. A
case without connections behaves exactly as it does today.

### What a bridge changes, clinically

| Concern | Single crown today | Bridge |
|---|---|---|
| Path of insertion | One axis per prep | **One common axis for all abutments**: the bridge seats as one piece |
| Units | Crown on a prep | Retainers on preps **plus pontics** with no prep, resting on the ridge |
| Proximal sides | Contact with the neighbours (adapt to a target gap) | Sides facing another unit get a **connector** instead of a contact |
| Main failure risk | Thickness, occlusion | **Connector cross-section** (fracture). Each material has a minimum area |
| Output | One crown STL | **One** solid: the union of retainers, pontics and connectors |

### What exocad does (the reference for this spec)

From exocad's DentalCAD performance specification and wiki (sources at the end):
- **Teeth:** a library of 16 model teeth, 8 each for the upper and lower jaws. Each is placed automatically, with
  manual correction.
- **Pontics:**
  - Pontics are model teeth loaded as bridge elements, normally with anatomic chewing surfaces.
  - The pontic base can be adapted to the gingiva when the scan shows it.
  - exocad also offers reduced pontics (for layering) and pressed pontics.
- **Connectors:**
  - Connectors are created automatically between adjacent pontics and crowns when a pontic is defined.
  - Each connector can be switched on or off (green: created; grey: not created).
  - **No connector is created when the adjacent teeth have different materials**, or when a restoration type does
    not permit connectors.
- **Connector design:**
  - It starts from an automatic suggestion. The minimum cross-section and the shape (from standard shapes) are
    parameters, and the position of the interface with the unit can be adjusted.
  - The connector designer shows the cross-section, and the plane can be moved along the arch.
- **Merging:** the bridge elements are merged into one mesh, optionally into a single closed mesh.
- **Other bridge types:** inlay, cantilever and Maryland bridges, framework bridges, and implant bridges.
- **No restriction is documented** on tooth position, number of units or cantilevers.

## Decisions

1. **Configurations: as in exocad.**
   - Any teeth 11–48, with any number of units up to a full arch (16 per jaw).
   - Connections only between teeth adjacent in the tooth chart: neighbours in a quadrant, plus 11–21 and 31–41
     across the midline.
   - Pontics anywhere, including at the ends (cantilevers).
   - Several bridges per case, in either jaw.
   - Connected crowns without a pontic (splinted crowns) are the same model.
   - Two physical rules are enforced:
     - Every bridge needs at least one abutment; with none, nothing holds it in place.
     - No connection between teeth of different materials (the exocad rule).
2. **Materials: no refusals.** exocad leaves the indication to the lab, and so does this design.
   - Every material can be used for bridges.
   - Each material has a minimum connector cross-section that drives the connector QA.
   - Configurations outside a manufacturer's indication raise a **warning**, not an error. Example: lithium
     disilicate past the second premolar, or more than 3 units.
3. **Connector minimums** (defaults, editable per connector, never below the minimum):

   | Material | Anterior connector | Posterior connector |
   |---|---|---|
   | Zirconia | 7 mm² | 9 mm² |
   | Lithium disilicate | 12 mm² | 16 mm² |
   | PMMA (temporary) | 9 mm² | 12 mm² |

   - A connector is posterior if either unit is a premolar or a molar.
   - The minimum height is 3.0 mm for every material.
   - **The values must be confirmed in domain QA against the material IFU**, including any extra for long spans and
     cantilevers.
4. **Pontic type: anatomic pontic with its base adapted to the gingiva**, the exocad default.
   - The convex base follows the scanned ridge at `ponticRidgeGapMm`. The default is 0 mm (passive contact); the
     range is −0.3 to 3 mm.
5. **No new design step.** Connectors are edited in the **Adapt** step, where contacts are handled today. A new
   `StepId` would break loading of saved documents: `steps` is an exhaustive zod record.

## Scope

In:
1. **All tooth positions:**
   - procedural incisor and canine templates next to the premolar and molar ones (8 types per jaw, as in exocad)
   - the frame and fit work on anterior teeth
   - the tooth chart, Rx intake and template lookup accept every tooth
2. **Case setup:**
   - Mark a tooth as a pontic.
   - Connectors are created automatically when a pontic is defined, as in exocad.
   - Toggle any connector between adjacent teeth.
   - Validation of decision 1, plus the decision 2 warnings.
3. **Document and commands:**
   - Bridge topology and connector settings in the document.
   - A common insertion axis kept identical on all abutments.
   - Staleness across units.
   - A new `setConnector` clinical command, which also becomes an agent tool.
4. **Geometry** (pure TS, worker + Node):
   - arch curve, pontic frames (including cantilevers), common-axis search
   - pontic design: a ridge base plus a fitted template shell
   - connector placement and sizing, boolean union into one solid
   - bridge validation: closed, printable, one component, seating unchanged, connector areas **measured** by
     sectioning
5. **App:**
   - Every unit of the active bridge and its connectors are shown together.
   - Click a unit to make it active.
   - The step list follows the unit kind: a pontic has no margin or axis step.
   - "Propose bridge" places every unit in one undo entry.
   - The connector panel shows the designed and measured area, with height and position offsets.
   - Export the bridge as one STL plus a sidecar.
6. **Pipeline runner:** two synthetic golden cases (no patient data).
   - Posterior: `35–[36]–37`.
   - Anterior: `[12]–11–21–[22]`, which crosses the midline and has two cantilever pontics.
7. **AI layer:**
   - Bridge auto-design (after the abutment frames exist).
   - Connector QA gate.
   - Agent: connector tool, bridge-aware prompt and metrics.
   - Rx intake reads bridges and anterior teeth.

Follow-on specs: the other exocad bridge types. The user asked for all of them on 2026-10-25, each in its own spec,
implemented in this order after this one:
1. [Framework bridges](2026-10-25-framework-bridges.md): reduced crowns and pontics, cutback, overpress, pressed
   pontics, metal materials.
2. [Maryland bridges](2026-10-25-maryland-bridges.md): resin-bonded wing retainers. It adds the surface-patch
   retainer geometry.
3. [Inlay bridges](2026-10-25-inlay-bridges.md): inlay and onlay retainers, also as single restorations. It reuses
   the patch intaglio.
4. [Implant bridges](2026-10-25-implant-bridges.md): screw-retained implant crowns and bridges on Ti-bases.

So this spec builds the extension point they share: `RESTORATION_ROLE` maps each restoration type to its role
(abutment or pontic) and to whether it permits connectors. `validateBridges`, `stepsFor` and the unit dispatch in
`designBridge` read the role, not the type, so each follow-on spec adds a type and its geometry without changing the
bridge core.

Out:
- **Connector shape library:** only an elliptical section, with area and buccal/occlusal offsets; exocad offers
  several standard shapes.
- **Connector fillets or blends.** The union leaves a crease where a connector meets a unit; see Risks.
- **Anterior guidance** (protrusion and laterotrusion). It needs an articulator, which the plan keeps out. Anterior
  units get the same static occlusion check as posterior ones.
- **Attachments** (precision attachments on bridge parts).

**Cut order if behind:** Rx bridge parsing → agent connector tool → bridge auto-design → click-to-activate units.

## Design

### All tooth positions (`apps/web/src/geometry/crownTemplate.ts`, `toothFrame.ts`, `ui/ToothChart.tsx`, `ai/rx.ts`)

- **Templates:**
  - `TemplateType` becomes `'central' | 'lateral' | 'canine' | 'premolar' | 'molar'`, and `templateForTooth` covers
    positions 1–8.
  - Anterior templates are procedural, like the posterior ones:
    - a superellipse footprint
    - the labio-lingual width tapers to an incisal edge (incisors) or a cusp tip (canine)
    - a convex labial face and a lingual cingulum
  - `heightFraction`, `column` and `cervicalLoop` keep their meaning, so the RBF fit, thickness and adaptation work
    unchanged; the anchors land on the incisal third.
  - Nominal sizes come from standard crown dimensions:

    | | MD | BL | Height |
    |---|---|---|---|
    | Upper central | 8.5 mm | 7 mm | 10.5 mm |
    | Upper lateral | 6.5 mm | 6 mm | 9 mm |
    | Upper canine | 7.5 mm | 8 mm | 10 mm |
    | Lower central | 5 mm | 6 mm | 9 mm |
    | Lower lateral | 5.5 mm | 6 mm | 9.5 mm |
    | Lower canine | 7 mm | 7.5 mm | 11 mm |

    Real annotated library teeth replace all of them later through `tools/library-builder`.
- **Frame:**
  - `estimateToothFrame` already works from a click.
  - Across the midline, both centrals' mesial points toward the other: FDI handedness is per quadrant, which is
    correct.
  - An antagonist that is not above the prep (overjet) falls back to the template height, with the existing warning.
- **Remove the posterior-only checks:**
  - the `ToothChart` disabled state
  - `templateForTooth` throwing
  - the Rx prompt line and `parseRxClassical` dropping anterior teeth
  - `isPosterior` stays, but only as the "posterior connector" rule

### Case setup and document (`packages/shared`)

`case.ts`:
- `RestorationType` adds `'pontic'`. Abutments stay `'anatomic-crown'`.
- `CaseSetup.connections: [Fdi, Fdi][]` (sorted pairs, default `[]`) records what was ordered. A bridge is a connected
  component of the connection graph.
- `BRIDGE_PRESETS: Record<Material, { connectorMinAreaMm2: { anterior; posterior }; connectorMinHeightMm }>`.
- `DesignParams.ponticRidgeGapMm`: optional, default 0, used only by pontics.
- `chartAdjacent(a, b)`: same quadrant and positions differ by 1, or {11, 21}, or {31, 41}.
- `validateBridges(setup)` is pure and used by the reducer and the Rx confirm form. It returns `errors` and
  `warnings`.
  - Errors:
    - a connection between teeth that are not adjacent in the chart
    - a connection between different materials
    - a bridge with no abutment
    - a pontic with no connection
  - Warnings: an indication outside the material's range (decision 2).
- **When the setup defines a pontic**, the setup UI adds its connections to its chart neighbours that are in the case
  and share its material, as exocad does. The connector toggle can remove them.

`design.ts`:
- `DesignDocument.bridges: BridgeDesign[]`, default `[]`.
  - `BridgeDesign = { teeth: Fdi[] (in arch order) , connectors: ConnectorDesign[] }`.
  - `ConnectorDesign = { between: [Fdi, Fdi]; areaMm2; buccalMm; occlusalMm }`. The area defaults to the material
    minimum; the offsets default to 0 and move the connector from its automatic position.
- Everything is optional or defaulted. Saved version-1 documents and `.dcad.zip` files still load, and
  `SCHEMA_VERSION` stays 1.
- Helpers:
  - `bridgeOf(doc, fdi)`
  - `unitKind(setup, fdi)`
  - `facingSide(a, b)`: mesial or distal. For 11–21 it is mesial on both.
  - `connectedSides(doc, fdi)`
  - `stepsFor(kind)`: a pontic skips `margin` and `axis`.

`commands.ts`: a new clinical command, `SetConnector { between, areaMm2?, buccalMm?, occlusalMm? }`. Because it is
in `CLINICAL_COMMANDS`, it is also the agent tool `set_connector`.

### Reducer rules (`apps/web/src/design/reducer.ts`)

- **`setCaseSetup`:**
  - Rejects a setup with `validateBridges` errors (`CommandError`); warnings pass.
  - Derives `doc.bridges` from the connections and keeps the connector settings of connections that still exist.
  - Pontic units get no margin or axis.
- **Common axis:** `setAxis` on any abutment of a bridge sets the same axis on **every** abutment of that bridge in
  one command. Each abutment's axis step becomes done and its downstream steps stale.
- **Cross-unit staleness:**
  - `setFrame` or `setMargin` on an abutment marks the axis step stale on every abutment of the bridge, because the
    common axis was computed from the old margin.
  - `setFrame` on an abutment also marks the bridge's pontic frames stale: they are derived from the neighbouring
    units.
- **Connected sides:** `setContact` toward a connected unit throws `CommandError`; that side has a connector, not a
  contact. Adaptation targets are kept only for free sides.
- **`setConnector`:** throws below the material minimum or for a pair that is not connected. Marks `adapt` stale on
  both units.
- **Moving a unit** keeps the existing rules (the moved unit only). Connectors are derived geometry and follow
  automatically.

### Geometry (`apps/web/src/geometry`, pure TS)

- **Arch curve** (new `arch.ts`):
  - Jaw scan points in the top 40% of the height along occlusal (the teeth, not the gum) are projected on the
    occlusal plane.
  - A parabola is fitted in their PCA frame. A quadrant scan, whose span is too short for a stable parabola, falls
    back to a line (the PCA long axis).
  - It gives the arc-length position, the tangent (mesial: toward the midline) and the outward normal (buccal) at
    any point.
- **Common axis** (`axis.ts`):
  - `searchInsertionAxis` already takes a face mask, so the bridge search passes the **union** of all abutment prep
    regions. The cone is centred on the mean of the abutment occlusal directions.
  - `marginUndercut` runs per abutment margin. The bridge's total must be 0.
  - The result also reports each abutment's blockout area and the largest angle between the abutments' individual
    best axes. A divergence above 12° raises a warning; long anterior–posterior spans often diverge.
- **Pontic frame** (new `bridge.ts`): no click needed.
  - The pontic centre lies on the arch curve.
    - A pontic between two units sits between their facing edges; consecutive pontics split that span by their
      nominal template widths.
    - A cantilever pontic sits one nominal width beyond its unit along the curve.
  - occlusal = the mean of the neighbouring units' occlusal directions; mesial = the curve tangent toward the
    midline; buccal = the outward normal. The handedness is checked against the FDI rule in `toothFrame.ts`.
  - origin = the ridge point under the centre (ray cast along −occlusal).
  - Contacts: the facing points of the neighbouring units, or natural teeth found by the existing contact search
    on free sides.
  - A click in the Frame step overrides the centre.
  - On abutments, contacts toward a connected unit are dropped: only natural neighbours give contacts.
- **Pontic design** (`designPontic`, same `CrownDesign` result shape, so maps, adaptation, move weights and the
  gizmo work unchanged):
  - **Rim:** the posed template's cervical footprint, narrowed to 0.7 for a smaller tissue-contact area. It is
    projected along −occlusal onto the ridge and raised by `ponticRidgeGapMm`.
  - **Base:** a convex cap over the ridge inside the rim. It reuses `buildIntaglio` (radial profiles) on a ray
    caster over the ridge, raised by the gap. Its faces point toward the ridge.
  - **Shell:** the library template for the missing tooth's FDI. The RBF fit pins its cervical ring to the rim, as
    a crown is pinned to its margin, with the occlusal or incisal third anchored. It is joined to the base by the
    band.
  - **Pose proposal:**
    - MD = the span the arch curve gives it.
    - BL = the template's nominal width, scaled by the mean ratio of the neighbouring retainers.
    - Height = from the ridge plus the gap to the antagonist, minus the occlusal clearance. Without an antagonist
      above it, the template height is used.
  - No thickness enforcement (the pontic is solid). Occlusal adaptation is the same as for crowns; there is no
    proximal adaptation toward connected units.
- **Connectors** (`connectors.ts`): one per connection, an elliptical tube along the line between the two unit
  centres.
  - Its centre sits at the midpoint of the facing shell points, with the stored buccal and occlusal offsets.
  - **Available height:**
    - The bottom stays at least 1.0 mm above the gingiva or ridge under it, for hygiene (ray cast along −axis).
    - The top stays at least 1.0 mm below the lower marginal ridge or incisal edge of the two units (occlusal
      embrasure).
  - **Sizing:** h = min(available height, √(4A/π)) and w = 4A/(πh).
    - It fails with **"insufficient connector height"** when h < the minimum height. This is the bridge's
      counterpart to "insufficient reduction".
    - It also fails when w > 0.8 × the narrower unit's BL.
  - **Ends:** each end sinks into its unit by min(1 mm, distance to that unit's intaglio − 0.2 mm), so a connector
    never reaches the fitting surface.
- **Union** (`bridgeUnion.ts`):
  - It runs **manifold-3d**, already listed in the plan's libraries, over the closed retainers, pontics and
    connectors.
  - The WASM loads lazily, in the worker and in Node only, so the main bundle is unaffected.
  - The output is checked with the existing `validateClosedMesh` + `countSelfIntersections`, plus a check for **one
    connected component of genus 0** (Euler characteristic 2).
- **Bridge checks** (all measured on the union):
  - **Connector area:** the union is sliced with planes ⊥ the connector line across the interproximal gap (new
    `sectionArea`: triangle–plane segments → loops → area). The smallest section must be ≥ the target area. This
    is exocad's moving cross-section plane, made into a check.
  - **Seating:** `measureIntaglioGap` is re-run per retainer against a ray caster over the union. Its mean and max
    error must match the retainer's own values within 0.005 mm. This proves the union left the fitting surfaces
    untouched.
  - **Pontic base:** the smallest and mean gap to the ridge along the axis must be ≥ `ponticRidgeGapMm` − 0.02.

### Worker and app

- **Worker:**
  - `designBridge(request)` returns a result per unit (a retainer via `designCrown`, a pontic via `designPontic`),
    the connectors, and the union with its checks when `union: true`.
  - Unit results are cached by an input hash in the worker. Moving one unit recomputes only that unit and its
    connectors, so full-arch bridges stay interactive.
  - The union runs only for QA and export, not on every move.
- **Display:**
  - The crown tool shows every unit plus the connector meshes. Overlapping solids in one material look like the
    union.
  - Move previews (move weights) apply to the active unit only.
  - Clicking a unit makes it active.
- **Setup step:**
  - Every tooth can be selected.
  - A pontic toggle on a selected tooth adds its connections automatically.
  - Connector toggles sit between adjacent teeth in the tooth chart: shown as connected or not connected, and
    unavailable across different materials.
  - Errors and warnings are shown inline.
- **Step list:** follows `stepsFor(kind)`, and the axis step says "common axis for 11, 21".
- **Proposal step:** "Propose bridge" places the retainers first, then the pontics along the arch curve. All
  `setCrown` commands go in one batch, so one undo entry.
- **Adapt step:**
  - Occlusion for every unit.
  - Contacts only on free sides.
  - A connector panel per connection: designed and measured area against the minimum, height, offsets, and a red
    state when a check fails.
- **Finalize step:** one STL per bridge (`<ref>-12-22-bridge.stl`) plus a sidecar. The sidecar lists the units
  (kind, frame, margin, pose), the common axis, the connectors (designed and measured area, height), the warnings
  and the validation.

### AI layer

- **Proposers:**
  - `classical.pontic-frame@1`
  - `classical.bridge-axis@1`
  - `classical.bridge-proposal@1`
  - `classical.adapt@1`, made bridge-aware: free sides only
  - `classical.connectors@1` (a gate only; the geometry is derived)
- **Bridge auto-design:**
  - Needs a frame on every abutment. The user clicks each prep in the Frame step; otherwise the error names the
    missing abutments.
  - It then runs in one transaction: pontic frames → each abutment's auto margin → common axis → bridge proposal →
    adapt → connector and union gate.
  - Gates are the existing margin, axis, crown and adapt gates per unit, plus `bridgeGate`: connector area and
    height, printable union, one component, seating unchanged.
- **Agent:**
  - The system prompt names the bridge and each unit's kind, and says that connected sides have connectors, not
    contacts.
  - `get_design_metrics` adds the connector areas and heights.
  - `set_connector` comes from the new command.
- **Rx intake:**
  - The prompt allows every tooth, `pontic` and `connections`.
  - The rule-based reader recognises "bridge 35-37", "35–37 bridge" and "13x23": the ends are abutments, and the
    teeth between are pontics unless the text names them as abutments. It also reads "pontic 22" and "cantilever".
- **Events:** one `ProposalEvent` per unit and step, as for single crowns. Connector settings are logged as the
  adapt artifact.

### Synthetic data and pipeline runner

- `syntheticArch` gets `preps?: number[]` (default `[36]` for the lower jaw, so today's arch is byte-identical) and
  `missing?: number[]`, for either jaw.
  - A missing tooth leaves the convex gum band as the edentulous ridge.
  - `syntheticPrepMargin` and `syntheticPrepSeed` take an `fdi`.
- `tools/fixtures/generate.mts` also writes demo scans for both cases: `lower-bridge.stl` (35, 37 prepped; 36
  missing) and `upper-anterior-bridge.stl` (11, 21 prepped; 12, 22 missing).
- `GoldenCase` gets an optional `bridge` block: the units, the connections, and the seed and margin anchors per
  abutment. The single-crown fields are unchanged.
- The runner's bridge mode writes `metrics.json` (per unit + connectors + union + seating + pontic base) and
  `bridge.stl`.

## Verification plan

Tests (per `CLAUDE.md`). This adds 4 tests and extends 2, so the suite goes from 96 to 100. That is one over the
1–3 budget, because this spec is two features: bridges and anterior teeth.
- **New** `tools/pipeline-runner/src/pipeline.test.ts`, "passes every check on the synthetic bridges". It runs over
  the two golden cases (posterior `35–[36]–37` and anterior `[12]–11–21–[22]`); the variant is the point. For each
  case:
  - one common axis with no margin undercut on any abutment
  - the union is closed and printable, one component
  - every connector's **measured** smallest section is at least its material minimum, and its height is at least
    3 mm
  - seating is unchanged per retainer (±0.005 mm)
  - pontic base gap ≥ target − 0.02 mm
  - the pontic frames follow FDI handedness
  - the STL byte size matches the triangle count

  The anterior case also covers the anterior templates, the midline connector, cantilevers and an upper-jaw prep.
- **New** `apps/web/src/design/reducer.test.ts`, "bridge: derives units, keeps one common axis, invalidates across
  units":
  - The setup derives `bridges` and the pontic has no margin or axis.
  - `setAxis` on 35 sets 37.
  - `setMargin` on 37 marks the axis stale on 35.
  - `setContact` toward a connected side and `setConnector` below the minimum are rejected.
- **New** `packages/shared/src/shared.test.ts`, "validates bridge setups". This is the detector rule (passing cases,
  failing cases).
  - Passes: a cantilever, a midline bridge, a full arch.
  - Fails: a non-adjacent connection, mixed materials, a bridge with no abutment, an unconnected pontic.
  - Warns: lithium disilicate over 3 units.
- **Extended** `apps/web/src/ai/qa.test.ts` (axis/crown/adapt gates): `bridgeGate` fails on a connector below the
  minimum area, insufficient connector height, two components, and moved seating; it passes the good case.
- **Extended** `apps/web/src/ai/rx.test.ts` (rule-based reader): "bridge 35-37, zirconia" gives the 36 pontic and
  both connections, and "11, 21 crowns, 12 and 22 cantilever pontics" keeps the anterior teeth.

Commands and measurements:
- `pnpm typecheck`, `pnpm test`, and `pnpm --filter @dcad/api test:infra` (the API stores `bridges` in the document
  jsonb unchanged).
- **No regression on single crowns:** the synthetic-36 runner output (`crown.stl` sha256 and `metrics.json`) is
  identical before and after.
- **Old documents load:** a version-1 document saved before this change parses and opens with `bridges: []`.
- **Perf on the 1M-triangle demo:**
  - moving one unit recomputes in < 1 s
  - the union with its checks takes < 1.5 s for 3–4 units
  - a synthetic 10-unit bridge is timed and the result reported (no target yet)
  - the main bundle does not grow by more than 10 kB (manifold-3d stays in the worker)
- **Browser E2E** (`tools/e2e/bridge.mjs`): load `lower-bridge.stl` and `upper.stl` → set up 35–36p–37 → click both
  preps → bridge auto-design → Accept → export. The STL downloads and opens as one closed solid in trimesh.
- **Manual:**
  - Open both `bridge.stl` files in a slicer or Meshmixer. Check that the connectors meet the units, that the
    pontic base follows the ridge and that the anterior shapes read as incisors and canines.
  - Compare the workflow with exocad on one real case once golden data exists.

## Work split

1. **All tooth positions:**
   - anterior templates
   - remove the posterior-only checks
   - an anterior single crown on a synthetic prep, checked through the runner
2. **Shared + reducer:** schemas, `validateBridges`, reducer rules, and 2 tests.
3. **Geometry + runner:**
   - arch curve, common axis
   - pontic frame and design
   - connectors
   - union and checks
   - synthetic scans, the golden cases and the pipeline test

   This is the core and is verifiable headless.
4. **App:** setup UI, unit display, the bridge proposal, the connector panel, export, and the E2E script.
5. **AI:** proposers, auto-design, the gate, agent and Rx, and the `qa`/`rx` test extensions.

## Risks

- **Union robustness.** manifold-3d needs closed, manifold inputs. The crowns already are, and connectors and
  pontics are built closed. If a union fails, the bridge gate fails with the reason; nothing is exported silently.
- **Connector creases.** Without fillets, the junction between a connector and a unit is a sharp concave edge, which
  concentrates stress. The first follow-up is a blend: a Laplacian band around the intersection curve on the union.
- **Anterior shapes and occlusion.** The procedural incisors and canines are placeholders, like today's posterior
  templates. Static clearance along the axis is a weak check for anteriors: their contacts are lingual and depend on
  guidance, which needs an articulator.
- **Long spans and divergent abutments.** A common axis over a curved full arch can force large blockouts. This is
  reported per abutment, not hidden. The unit cache keeps edits interactive, but a full recompute of a 14-unit bridge
  will take several seconds; it is measured, not targeted, in this spec.
- **Arch curve on quadrant scans.** A short scan falls back to a line, which is fine for 3–4 units. Cantilevers on
  quadrant scans may be placed slightly off the arch and need the click override.
- **Ridge-contact base on real scans.** Soft-tissue scans are noisy, so the base cap smooths the ridge heights. It is
  checked only on the synthetic ridge until real golden cases exist (a Day 0 data dependency).

## Sources

- exocad DentalCAD performance specification (03/2019), sections "Crowns with anatomical chewing surfaces", "Design
  of bridges" and "Framework bridges": <https://shop.exocad.com/media/sales/Perf-Spec-Dental-CAD-Module-en.pdf>
- exocad wiki, "Defining jobs for individual teeth" (connectors toggled per gap; none between different materials):
  <https://wiki.exocad.com/wiki/index.php/Defining_jobs_for_individual_teeth>
- exocad DentalCAD product page (inlay, cantilever and Maryland bridges; single crowns to full arch):
  <https://exocad.com/our-products/dentalcad>
- Straumann screw-retained bridge design guide for exocad (cross-section shown in the connector designer, plane moved
  along the arch): <https://www.straumann.com/content/dam/media-center/straumann/en/software/exocad/exocad_SRBB_Design_Guide_EN.pdf>

## Implementation summary

Built by parallel agents in git worktrees, integrated in waves. Each green wave is one commit on main.

### Wave 1 (2026-10-25): shared schemas, reducer, anterior teeth, geometry building blocks
- **Shared** (`packages/shared/src/{case,design,commands,tools}.ts`):
  - `FdiPair`, `RestorationType` with `'pontic'`, `UnitKind`, `RESTORATION_ROLE`, and `BRIDGE_PRESETS` with
    `minConnectorAreaMm2`.
  - `CaseSetup.connections`, `DesignParams.ponticRidgeGapMm`.
  - Tooth-numbering helpers: `archIndex`, `archOrder`, `chartAdjacent`, `facingSide`, `normalizeConnections`.
  - `unitKind`, `bridgesOf`, `validateBridges` (machine-readable codes).
  - `ConnectorDesign`, `BridgeDesign`, `DesignDocument.bridges`, `deriveBridges`, `bridgeOf`, `connectedSides`,
    `stepsFor`.
  - The `SetConnector` command (agent tool `set_connector`).
- **Reducer** (`apps/web/src/design/reducer.ts`): the rules in "Reducer rules", plus:
  - **Re-forming a bridge:** when a bridge is formed, merged, split or changes kind, every abutment whose bridge has
    a new set of abutments gets its axis marked stale. Code review found this gap.
  - **Removing a tooth:** connections to teeth that leave the case are dropped instead of refused.
- **API** (`apps/api/src/domain/cases.ts`): case create and update run `validateBridges` and return 400
  (`validation_error`) on errors.
- **All tooth positions:**
  - procedural central, lateral and canine templates (`crownTemplate.ts`); the posterior templates are
    byte-identical
  - `templateTypeOf`, and `templateForTooth` for positions 1–8
  - the posterior-only checks are removed from `ToothChart`, the new-case form, Rx (classical and LLM) and the Rx
    prompt
- **Synthetic arch:** `syntheticArch({ preps, missing })` on either jaw, `syntheticTooth(fdi)`, and
  `syntheticPrepMargin`/`Seed({ fdi })`.
- **Geometry building blocks:**
  - `meshBoolean.ts`: manifold-3d `unionMeshes` and `differenceMeshes`, initialized in Node or in the worker
    (`analysis.initBooleans()`).
  - `meshTopology`.
  - `sectionArea.ts`: `sectionMesh` and `scanSections`, with a `within` filter.
  - `arch.ts`: `fitArchCurve`. The parabola only seeds the fit; the curve is a local-linear radius-versus-angle
    regression, because a plain parabola gave 14–25° tangent error at the molars.
- **Bug found and fixed:** the FDI handedness rule and the synthetic arch were both mirrored; see
  [2026-10-25-fdi-handedness-fix.md](2026-10-25-fdi-handedness-fix.md).

**Wave 1 deviations from the spec:**
- Tool schemas are generated in zod's `io: 'input'` mode, so the tuple survives OpenAI strict mode.
- `RestorationRole.connectsTo` is optional, for Maryland wings.
- The indication warnings are data-driven.
- There is an extra `unknown-tooth` error code.
- `setConnector` marks `adapt` stale on both units as specified. This is under review: it hides the adaptation while
  connectors are edited in the Adapt step.

**Wave 1 verification:**
- `pnpm typecheck` and `pnpm test` pass, 96 → 100 tests:
  - +2 bridge tests (shared "validates bridge setups", reducer "bridge: derives units…")
  - +2 from the parallel UI-polish session
- An old version-1 document parses with the defaults. Every tool schema passes OpenAI strict normalization.
- Anterior single crowns (31–43, 11–23) on synthetic preps: all closed and printable, gap error ≤ 0.006 mm.
- Booleans: sphere union volume within 0.014%; a 4-crown union in 0.78 s. Sections within 0.03% of analytic.
- Arch tangent error ≤ 2.8° for teeth 1–6.
- Build: manifold-3d is a 44 kB lazy chunk plus 541 kB of WASM, referenced only from the worker.

### Wave 2a (2026-10-25): bridge setup UI, step list per unit kind, Rx bridges
- **Tooth chart** (`apps/web/src/ui/ToothChart.tsx`, `ui/bridge.css`):
  - Quadrant rows run from the midline outward (11–18 over 21–28, 41–48 over 31–38), so every chart neighbour,
    including 11–21 and 31–41, sits next to its partner.
  - Targets are 32×30 px for teeth and 36×24 px for connectors (WCAG 2.5.8).
  - A connector toggle sits between in-case neighbours; across different materials it is shown unavailable, with the
    reason. Bridges are grouped by brackets.
- **Setup step:**
  - Restorations are grouped by bridge, with a Crown/Pontic switch per unit and one material per bridge.
  - A new pontic connects to its neighbours of the same material.
  - Changes are checked with `validateBridges` before dispatch, and refusals are shown inline.
- **Step list:** follows `stepsFor`; a pontic has no Margin or Axis. The tooth selector shows each unit's kind and
  its bridge. The axis step says it is common to the abutments.
- **Readiness:** `readinessNeeds(kind)` feeds Finalize.
- **Rx:**
  - The rule-based reader handles "bridge 35-37", "35–37 bridge", "13x23", "pontic 22" and cantilevers.
  - The LLM path drops dangling connections and validates.
  - `RxIntake` shows issues and keeps Apply disabled while there are errors.
- **Adapt proposer:** skips connected sides.
- **Verification:**
  - 100 tests. The Rx and readiness tests were extended; two Rx cases were merged into one to stay within the budget.
  - Playwright in Chrome, light and dark: 22 of 23 checks pass. The one miss is an unrelated 401 from another
    session's API.
- **Open:**
  - Finalize readiness still counts a connected side's frame contact as a neighbour (wave 3).
  - The chart layout is not the standard dentist's-view row; to be confirmed with the user.

### Wave 2b (2026-10-25): pontics, connectors, union checks, worker API, bridge golden cases
- **Geometry** (`apps/web/src/geometry/`):
  - `axis.ts` `searchCommonAxis`
  - `bridge.ts`: `layoutPontics` (arch curve, cantilevers), `archAlignedFrame`, `designBridge` + `BridgeCache`
  - `pontic.ts`: `designPontic`, `proposePonticPose`
  - `connectors.ts`: `designConnector`, `measureConnector`
  - `bridgeUnion.ts`: `checkBridgeUnion`
  - `crown.ts`: the second half of `designCrown` split into `placeShell` / `fitAndFinishShell` / `proposeCrownPoseFor`,
    shared with pontics. Single-crown output is byte-identical.
  - `designBridge` dispatches on unit kind only, so the follow-on retainer types plug in.
- **Worker** (`analysis.*`, each with an unlatched variant): `bridgeAxis`, `bridgeFrames` and `designBridge`. Unit
  results are cached by resolved pose, so moving one unit recomputes only it and its connectors.
- **Runner:**
  - `tools/pipeline-runner/src/bridgePipeline.ts`.
  - `GoldenCase.bridge` (units carry `restoration`).
  - `writeSyntheticBridgeCase(dir, 'posterior' | 'anterior')`.
  - The CLI runs every case, and `--synthetic` writes all three.
  - Fixtures: `lower-bridge.stl` and `upper-anterior-bridge.stl`.
- **Test:** `pipeline.test.ts` "passes every check on the synthetic bridges" (posterior `35–[36]–37`, anterior
  `[12]–11–21–[22]`; 1.7 s and 2.2 s). The suite goes 100 → 102.
- **Measured at 1M triangles:**

  | | Posterior | Anterior | 10 units (35–45) |
  |---|---|---|---|
  | First design | 0.91 s | 1.19 s | 2.44 s |
  | Union + checks | 0.41 s | 0.45 s | 1.63 s |

  - Moving a retainer recomputes in 335–390 ms, a pontic in 204–215 ms.
  - Connectors measured on the union: posterior 9.0 mm² and 3.39 mm high; anterior 7.0 mm² and 3.0 mm; the midline
    11.0 mm².
  - Seating change on the union ≤ 3e-7 mm. Pontic base gap −0.0002 mm (target 0).
  - The common axis has no blockout. Pontic mesial · direction to the mesial neighbour is 0.96–0.98.
  - Each union is one closed, printable solid of genus 0.
  - Runner CLI at 1M triangles: 6/6 runs pass.
- **Deviations:**
  - **Connector height:** h = min(available, max(√(4A/π), minimum height)). Otherwise every 7 mm² anterior connector
    would be 2.985 mm high, below the 3 mm minimum.
  - **Connector line and placement:**
    - The connector line is horizontal, so the section height is along the insertion axis.
    - The tube is sized 0.05% over its target area.
    - The intaglio clearance is checked over the whole end cap.
  - **Pontic base:** built along the common axis.
  - **Pontic height:** falls back to the template when the antagonist is more than 1.3× the template height away.
  - **Cantilevers:** shortened when a natural neighbour is closer than the nominal width.
  - **Abutment MD direction:** `archAlignedFrame` re-derives it from the arch curve, because the click estimate next to
    a gap was up to 102° off. The runner applies it; the app offers it.
  - **Pontic proximal adaptation:** only toward a natural contact on a free side.
  - **Failed union:** reported as `unionError`, not thrown.
- **Open:**
  - **10-unit anterior span:** the incisor pontics are 1.74 mm short of the antagonist. With six front teeth missing,
    the whole-jaw PCA occlusal estimate tilts 7° labially.
  - **Arch curve across a 21 mm gap:** about 1.8 mm labial of the true arch.
  - No connector fillets.
  - Worker cache: up to 64 entries.

Waves 3–4 (app; AI; follow-on specs) follow.
