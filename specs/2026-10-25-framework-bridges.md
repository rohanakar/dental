# Framework bridges (reduced crowns and pontics, overpress, pressed pontics)

Status: **done** (2026-10-26). Phases A and B (reduced crowns, pontics and framework bridges in the editor, the runner and export) and the AI items (cutback proposer and gate, agent metrics, Rx wording) have landed.
Depends on: [2026-10-25-bridge-mode.md](2026-10-25-bridge-mode.md) (units, connectors, union, unit kinds).

## Goal

Design frameworks for layered or pressed restorations, as exocad does with reduced crowns and pontics:
- **Cut-back units:** design the full anatomy first, then cut it back by a veneering space so a ceramist can layer
  porcelain, or press a ceramic, on top.
- **The framework:** the reduced units joined by connectors, exported as one solid.
- **The overpress part:** optionally, full anatomy minus framework, exported as a separate solid for pressing.

This works for single crowns and for bridges. A pressed pontic is a reduced pontic plus its overpress part.

### exocad reference

From the exocad DentalCAD performance specification:
- **Reduced crowns ("anatomical copings"):** the model teeth are reduced by a configurable *shrinkage thickness*
  (the veneering space). The material's minimum thickness above the prep is kept.
  - The whole crown is shrunk by default; the user can mark areas instead.
- **Framework bridges:** connectors between anatomic copings, offset copings and/or reduced pontics.
- **Overpress:** a surface over a reduced crown or pontic, equal to the full anatomy minus the reduced surface.
  - It is meant to be produced in wax, *not* used as a restoration directly.
  - A minimum thickness can be set on the chewing surface.
- **Switching types:** anatomic and reduced types can be switched later without redoing the design.

## Decisions (please confirm)

1. **Restoration types:** `reduced-crown` and `reduced-pontic`, alongside `anatomic-crown` and `pontic`.
   - Switching between the anatomic and the reduced type keeps the whole design: the cutback is applied last, on top
     of the adapted anatomy.
2. **Cutback modes:**

   | Mode | What is cut back |
   |---|---|
   | `full` (default) | Every outer surface except a cervical collar |
   | `facial` | Buccal/labial surface and the occlusal/incisal third, leaving lingual full contour (a common metal-ceramic design) |
   | `occlusal` | Occlusal/incisal third only |

   Brush-marked areas, as in exocad, are a follow-up: the app has no sculpt or brush tools yet.
3. **Defaults** (placeholders, to confirm in domain QA):
   - cutback 1.0 mm (range 0.3–2.0 mm)
   - lingual and proximal collar 0.8 mm above the margin, kept at full contour
   - the framework never thinner than the material's framework minimum
4. **Metals join the material list:** `cocr` (cobalt-chromium, milled or SLM) and `titanium`. They are needed for
   metal-ceramic frameworks, and the implant spec reuses them.
   - Presets are placeholders to confirm with the lab:

     | | Framework min thickness | Connector, anterior | Connector, posterior |
     |---|---|---|---|
     | CoCr | 0.3 mm | 4 mm² | 6 mm² |
     | Titanium | 0.4 mm | 6 mm² | 9 mm² |

   - Cement gap and spacer as for zirconia.
5. **Overpress** is an opt-in export per unit, as a closed solid. A *pressed pontic* is a reduced pontic with
   overpress on.

## Scope

In:
- `reduced-crown`, `reduced-pontic`, cutback modes and parameters.
- The cutback algorithm, with thickness protection.
- Framework connectors between reduced units: connector minimums apply to the framework.
- Overpress solids (boolean difference).
- Framework and overpress export, plus a sidecar.
- The metal materials.
- UI: a cutback panel in the Adapt step, a type switch in Setup, and a toggle between the anatomy and the framework
  view.

Out:
- Brush-marked cutback areas.
- Offset copings (a uniform-thickness coping made without anatomy): exocad has them, but they are a cheap follow-up
  once cutback exists.
- Lingual metal bands and collars of a custom shape.
- Telescope primary crowns and attachments.
- Porcelain layering simulation.

## Design

### Document and commands

- `RestorationType` adds `reduced-crown` and `reduced-pontic`.
  - Roles: the first is an abutment like `anatomic-crown`, the second a pontic.
  - Connectors are allowed between any reduced and anatomic units of the same material, as in exocad.
- `ToothDesign.cutback?: { mode: 'full' | 'facial' | 'occlusal'; thicknessMm; collarMm; overpress: boolean }`. It is
  optional, so saved documents load.
  - A reduced type without `cutback` uses the defaults.
- New clinical command `SetCutback { fdi, mode?, thicknessMm?, collarMm?, overpress? }`, which also becomes an agent
  tool. It marks `adapt` stale on the unit.
- Switching the type between anatomic and reduced keeps the frame, margin, axis, pose and adaptation. Only the
  derived geometry changes.

### Geometry (`apps/web/src/geometry/cutback.ts`)

- **Input:** the finished anatomic unit (after fit, thickness, adaptation), its intaglio and its frame.
- **Cutback mask** per outer vertex, from the mode:
  - **facial:** buccal-facing normals (n·buccal > 0.3) plus the occlusal third.
  - **occlusal:** the occlusal third (template height fraction ≥ 0.7).
  - Every mode excludes the collar: vertices within `collarMm` of the outer margin loop (geodesic).
  - The mask is feathered over 0.5 mm so the cutback edge forms a smooth shoulder for the porcelain.
- **Displacement field:** it moves inward by `thicknessMm × mask` along smoothed normals.
  - It is smoothed as a field (the adaptation code's damped fill), not by moving positions. This keeps cusp anatomy
    (an anatomically reduced framework, so the veneer has even thickness) and avoids folds at cusp tips, where the
    curvature radius is smaller than the cutback.
- **Thickness protection:** the existing `enforceThickness` runs with the framework minimum. If it pushes vertices
  out, the veneer there is thinner than requested.
  - That is reported as **"insufficient veneering space"** with the area and the smallest veneer thickness. This is
    the counterpart to "insufficient reduction".
- **Pontics:** the same, with no intaglio, so no thickness protection is needed. The base is never cut back: it
  rests on the ridge, and porcelain there is a hygiene problem.
- **Connectors** attach to the reduced units. The bridge connector sizing then runs on the framework, so its
  available height is measured between the reduced marginal ridges.
- **Overpress solid:** the anatomic unit minus the reduced unit, through the manifold-3d difference introduced by
  bridge mode.
  - Pieces thinner than 0.05 mm are dropped.
  - The optional minimum thickness on the chewing surface comes from the cutback thickness, so it holds by
    construction. A check verifies it.
- **Checks:**
  - The framework union is closed, printable and one component.
  - The veneer space is measured, not assumed: on the cutback region, the anatomic-to-framework distance is
    thickness ± 0.05 mm, except where protection reported a shortfall.
  - The overpress is closed and printable.

### App

- **Setup:** an "Anatomic / Reduced" switch per unit, and pontic → pressed pontic when overpress is on.
- **Adapt step:** a cutback panel (mode, thickness, collar, overpress), plus the "insufficient veneering space"
  report.
- **View:** "Show anatomy / framework / both", with the anatomy as a ghost over the framework. A veneer-thickness
  colour map on the framework, reusing the colour-map pipeline.
- **Finalize step:** exports the framework STL (one solid per bridge), the overpress STLs (one per unit with
  overpress), and the sidecar (the cutback per unit, the measured veneer space, and the shortfalls).

### AI layer

- `classical.cutback@1` proposes the mode and thickness from the material:
  - zirconia: full 1.0 mm
  - CoCr: facial 1.2 mm
  - Its gate is no shortfall above 0.1 mm.
- The agent gets `set_cutback`. The prompt explains what veneering space means.

### Synthetic data and pipeline runner

- A golden-case flag, `reduced: true`, turns the posterior bridge case (`35–[36]–37`) into its framework variant.
  Its CoCr material exercises the metal preset.
- Runner metrics: veneer-space statistics, shortfall area, framework and overpress validation, and
  `framework.stl` / `overpress-<fdi>.stl`.

## Verification plan

Tests: +1 new, 2 extended.
- **New** variant in `tools/pipeline-runner/src/pipeline.test.ts` (the framework is the point of the variant): the
  synthetic bridge as a CoCr framework.
  - The framework union is closed, printable and one component.
  - The veneer space on the cutback region is 1.0 ± 0.05 mm.
  - The framework thickness is at least 0.3 mm.
  - The connector sections meet the CoCr minimum.
  - The overpress solids are closed, and anatomy = framework ∪ overpress within 0.05 mm, measured as Hausdorff
    distance on the anatomy's outer surface.
- **Extended** bridge reducer test: switching `anatomic-crown` → `reduced-crown` keeps the frame, margin, axis,
  pose and adaptation; `setCutback` marks only `adapt` stale.
- **Extended** `qa.test.ts`: the cutback gate fails on a shortfall and passes without one.

Also:
- `pnpm typecheck` and `pnpm test`.
- Bridge-mode runner outputs unchanged for anatomic cases (sha256).
- **Manual:** open the framework and overpress in Meshmixer. The framework should read as an anatomically reduced
  coping, with even porcelain space and the collar intact.

## Work split

1. Schemas, commands, reducer, metals.
2. Cutback geometry, overpress, checks, and the runner variant.
3. App panel, view toggle, colour map, export.
4. AI proposer and agent tool.

## Risks

- **Inward offset of small radii.** Cusp tips and incisal edges have radii below 1 mm. The field smoothing must
  stop folds, and the self-intersection check guards the result. If folds remain, the fallback is a coarser
  offset-and-reproject on a distance field. It is slower, but robust.
- **Placeholder metal and veneer values.** All values must be confirmed with the lab and the alloy IFU before real
  use.

## Sources

- exocad DentalCAD performance specification, "Anatomical copings", "Framework bridges" and "Overpress crowns":
  <https://shop.exocad.com/media/sales/Perf-Spec-Dental-CAD-Module-en.pdf>

## Implementation summary

### Phase A (2026-10-25): cutback and overpress geometry
- **`apps/web/src/geometry/cutback.ts`:**
  - `unitCutbackSurface(design, template, frame, fitting?)` builds the cutback surface of a unit.
  - `cutbackMask` handles the `full`, `facial` and `occlusal` modes, the collar, and an outward feather of 0.5 mm.
  - `cutBack(surface, settings, framework) → CutbackResult` gives the reduced closed mesh with the same vertices and
    faces as the anatomy, the per-vertex veneer, veneer statistics, a shortfall report ("insufficient veneering
    space"), validation and timings.
  - Pontics work without a fitting surface.
- **`overpress.ts`:** `overpressSolid(anatomy, reduced)` (manifold difference, slivers dropped) and
  `checkReassembly` (Hausdorff distance of framework ∪ overpress against the anatomy).
- **Method** (deviation): erosion by S + ρ followed by dilation by ρ (ρ = half the framework minimum), mapped vertex by
  vertex. Vertices that can't be offset are projected onto the nearest fitting balls, so incisal edges come out
  shortened and rounded, never folded.
  - A smoothed displacement field, as the spec proposed, left the incisal fin standing, and smoothed positions
    folded.
  - Protection retracts each vertex along its own cut, then `enforceThickness` guarantees the minimum.
  - Up to 8 rounds of local repair remove any remaining self-intersections.
- **Verified with scratch scripts** (36 and 11; zirconia full 1.0/min 0.5, CoCr-like facial 1.2/min 0.3, a forced
  2.0, occlusal mode, pontic shells): 13 of 13 runs pass.
  - The framework is closed and printable with 0 self-intersections, and at least its minimum everywhere.
  - The overpress is closed, printable and one component.
  - Reassembly Hausdorff ≤ 9.6e-5 mm.
  - The veneer on the offset region is within ±0.05 mm in 100% of cases. The forced 2.0 mm reports a shortfall of
    111 mm².
  - Cutback takes 0.33–1.1 s and overpress about 0.2 s.
- **Spec changes, to apply in phase B:**
  - The veneer check becomes "≥ S − 0.05 outside the shortfall, and S ± 0.05 on the offset region". Sharp rims and
    incisal edges get thicker porcelain by design.
  - There is a new warning for veneer over 2 mm.
  - The runner variant asserts `veneer.thinVertices === 0`, `offsetWithinTolerance ≥ 0.99`, printable framework and
    overpress, and reassembly ≤ 0.05 mm. It must not assert "no shortfall": the synthetic prep's axial walls are
    only 0.9–1.4 mm.
- **Open:**
  - Coarse template edges can't hold the 0.5 mm feather; local refinement is a follow-up.
  - The overpress boolean leaves float32 micro-voids, under 1e-6 mm³ (reported, excluded from the Hausdorff).
  - Incisal porcelain of 2.3–2.5 mm needs domain QA.
  - Phase B needs `crown.ts` to expose `outerRing`, the intaglio triangle range and the shell height fractions.

### Phase B (2026-10-26): reduced units in the editor, metals, framework bridges, export
- **Shared** (`packages/shared/src/framework.ts`, plus additive edits):
  - `reduced-crown` and `reduced-pontic` types.
  - The `cocr` and `titanium` materials with placeholder presets.
  - `ToothDesign.cutback` and the `SetCutback` command (agent tool `set_cutback`).
- **Reducer:** switching anatomic ↔ reduced keeps the design; `setCutback` leaves the steps unchanged, like
  connectors do.
- **Geometry** (`geometry/framework.ts`):
  - Cutback after the anatomic unit; reduced units in `designBridge` and the union.
  - Connector-joint keep zones: the proximal face stays at full contour inside a 37° cone over 10–90% of the
    height, on connected sides.
  - Overpress = anatomy − its own framework − the connectors.
  - Repair and veneer statistics refined: a vertex counts as interior only if it and its closest framework face are
    fully cut, before and after protection.
- **UI:** an Anatomic/Reduced switch in Setup (hidden for implant crowns); the cutback panel; the Anatomy / Framework
  / Both view; the veneer colour map; Finalize exports the framework STL, the overpress STLs and a sidecar.
- **Runner:** `synthetic-framework-35-37` (CoCr), plus one test, "passes every check on the synthetic framework
  bridge (CoCr)" (104 → 105):
  - thinVertices 0, offsetWithinTolerance 1.0
  - printable framework and overpress
  - union of genus 0
  - connectors 6.0 mm² against the CoCr minimum of 6
  - reassembly 0.0002 mm
- **Verified on the integrated tree:** typecheck, 105 tests, build, runner 5/5 (the existing outputs are
  byte-identical), and the browser tests `bridge.mjs` 28/28, `ai-bridge.mjs` 16/16 and `implant.mjs` 31/31. The
  agent's own browser check passes 22 checks: a reduced CoCr single crown and bridge, the views, cutback edits, and
  the framework and overpress export.
- **Verification-plan wording** (replaces the phase A "thickness ± 0.05"):
  - Veneer ≥ S − 0.05 on the full cutback outside the reported shortfall, and S ± 0.05 on ≥ 99% of the offset
    region.
  - Veneer over 2 mm is a warning.
  - The runner never asserts "no shortfall": the synthetic prep walls are thinner than the CoCr minimum, which
    leaves a 7.7 mm² shortfall on 35.
- **Open:**
  - The joint keep-zone cone and height band need lab confirmation.
  - Reduced implant crowns are not supported.
  - The framework browser script (agent scratchpad) is not yet in `tools/e2e`.
  - AI items: the `classical.cutback@1` proposer and gate, agent metrics for veneer and shortfall, a `qa.test.ts`
    extension, and Rx wording for CoCr and metal-ceramic.

### AI items (2026-10-26): cutback proposer, gate, assistant, Rx
- **`classical.cutback@1`** (`apps/web/src/ai/proposers.ts`) runs after the adaptation on reduced units, in single and
  bridge auto-design. It sets the cutback from the material:
  - zirconia, lithium disilicate and PMMA: full 1.0 mm (layering or pressing)
  - CoCr and titanium: facial 1.2 mm (metal-ceramic: buccal and the occlusal third, lingual at full contour)
  - collar and overpress stay as set
  In a bridge it sets every reduced unit at once, and the connector gate then merges the frameworks.
- **Gate** (`cutbackGate`, `ai/qa.ts`): the framework is a printable solid, and the largest veneer deficit is
  ≤ 0.1 mm.
- **Assistant:**
  - The prompt explains frameworks, veneering space and `set_cutback`.
  - Metrics report the mode, the requested and measured veneer, and the shortfall area and largest deficit.
- **Rx:**
  - CoCr ("CoCr", "cobalt-chrome", "non-precious") and titanium are materials.
  - "metal-ceramic" or "PFM" without a named alloy reads as CoCr.
  - A line about a cut-back framework (PFM, cut back, layered, framework, coping, veneered, overpress) makes its
    units reduced crowns and pontics.
- **Tests:** `qa.test.ts` (the cutback gate passes a framework with no deficit and fails a 0.63 mm deficit) and
  `rx.test.ts` (a PFM bridge reads as reduced CoCr units) are extended.
- **E2E:** `tools/e2e/ai-framework.mjs`, 6/6.
  - Facial 1.2 mm on every unit of the CoCr bridge; full 1.0 mm on the single zirconia crown.
  - The gate stops both drafts on the synthetic preps' veneer shortfall: 0.82 mm on the CoCr retainers, 0.60 mm on
    the single crown. The preps' walls are thinner than the framework minimum, as the runner reports.
  - So one-click framework design never completes on the synthetic cases; it does on preps with room to veneer.
- **Verified** with the implant AI items (see `2026-10-25-implant-bridges.md`).
- **Open:** cutback depths and framework minimums are placeholders for lab QA.

