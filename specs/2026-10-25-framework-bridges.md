# Framework bridges (reduced crowns and pontics, overpress, pressed pontics)

Status: **spec, awaiting review** (2026-10-25). No code yet.
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

_To be written after implementation._
