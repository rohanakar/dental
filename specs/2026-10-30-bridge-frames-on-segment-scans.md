# Bridge frames on a segment scan

Status: **done, partly** (2026-10-30). The frames, the axis and the retainers' fit are right on 044. One connector
and the union still fail there, on a span too tight for our retainers (see Follow-ups).

## Goal

A bridge on a scan of a few teeth should get the same frames as on a full arch. On the exocad 34–[35]–36 bridge (044,
a 17.6 × 24 mm segment of three teeth, no antagonist; `2026-10-30-pontic-partial-ridge.md`) every frame is wrong:

- **Mesial is reversed** on both abutments and on the pontic (FDI handedness −0.9).
- **36's occlusal is 36° off** the lab's margin-ring normal.

From there the connectors (22.9 mm wide), the common axis (51 margin points in an undercut) and the union fail.

## What the measurements show (local, `data/exocad/scripts/bridgeFrameDiag.mts`, `occlusalCandidates.mts`)

- **Occlusal.** A frame takes the jaw's least-variance axis (whole-scan PCA) when the mean normal around the click is
  within 25° of it.
  - On full arches that axis is 2–15° from the lab's insertion axis (042, 049).
  - On segments and quadrants it is 27–47° off (035, 044, 045). Their cross-section is about as deep as it is wide:
    the spread across the arch is 1.3–1.6 times the depth's (standard deviations), against 2.2–6.1 on full arches
    and 2.6 to 3.3 on the synthetic jaws.
  - On 035 and 045 the local normal was more than 25° from it, so it wasn't used. On 044/36 it was (24°), and the frame
    tilted 36°. The local normal alone is 14° off there.
- **Buccal.** A frame's buccal points away from the scan's centroid. On a segment the centroid sits beside the teeth
  on whichever side has more scanned gum, so the side is a guess. On 044 it guessed lingual for both abutments.
- **The arch curve.** It decides its own inside from its bend. On 044 the top 40% of the scan bends toward the cheek
  behind the molar (the ramus side), so the curve's inside is buccal. It agrees with the frames, and the whole bridge
  is mirrored.
- The 035 and 045 quadrant bridges get every frame right.

## Design

1. **The jaw's occlusal plane only when the scan has one** (`toothFrame.ts`, `bridge.ts`). The least-variance axis
   counts as the occlusal-plane normal only when the scan's middle spread is at least 1.8 times its least
   (`jawPlaneNormal`, in `pca.ts`; between the segments' 1.6 and the full arches' 2.1). Otherwise the frame keeps the mean normal around the click. The same gate applies to
   the front-tooth rule in `archFitDirections`. Full arches and the synthetic jaws are unchanged.
2. **The abutments' order gives the arch direction** (`archFitDirections`, `orientArchCurve`).
   - Two abutment frames in one quadrant fix the mesial direction: the tooth with the lower position number is the
     mesial one. With the occlusal and FDI handedness, that gives buccal.
   - `archFitDirections` returns this as `order` (where, and which way is buccal). It also uses it as the buccal hint,
     in place of the sum of the frames' guessed buccals.
   - A fitted curve that is not a full arch (no midline) and whose outward normal at that point disagrees is turned
     around, as a straight fit already is.
   - A full arch's curve is never turned. Its shape is reliable, and frames in the wrong order there keep the "wrong
     order along the arch" check.
3. **Out of scope:**
   - single crowns on a segment scan (buccal is still the centroid's guess; nothing on the scan tells it);
   - the prep finder on a segment scan (it takes the PCA axis as its occlusal, and pairs teeth with preps in the
     curve's order).

## Verification

- **The 044 bridge** (local): frame handedness passes; the occlusal error, connectors, axis and union as measured.
- **Unchanged:** the 035 and 045 quadrant bridges, the 18 exocad crowns, the 15 synthetic golden cases.
- **Test:** one in `prepFinder.test.ts`, next to the bridge-frame check. A segment cut from the synthetic 35–[36]–37
  arch gets frames whose mesial follows FDI handedness. It must fail on the old code. If the plain cut doesn't
  reproduce the failure, the test adds a cheek-side flare behind the last molar, as on 044.
- `pnpm typecheck`, `pnpm test`, the browser scripts that design bridges.

## Implementation summary

### What was built

The two design changes, and three more that the 044 bridge needed once its frames were right.

1. **The occlusal plane only when the scan has one.** `jawPlaneNormal` (`apps/web/src/geometry/pca.ts`) is used by
   `estimateToothFrame` (`toothFrame.ts`) and by `archFitDirections`' front-tooth rule (`bridge.ts`). Without a plane,
   the antagonist side test uses the line between the two scans' centroids.
2. **The arch direction from the abutments.** `archOrder` (`bridge.ts`) is returned by `archFitDirections` as
   `order`. `orientArchCurve` (`arch.ts`) turns a curve without a midline that disagrees with it. `fitArchCurve` applies
   `order` when it is given, and the worker's cached fit gets it per call (`archCurveOf`).
3. **Margin undercuts below a scan's roughness don't count.** `marginUndercut` (`axis.ts`) casts the ray again from
   the point moved 0.05 mm outward (`MARGIN_UNDERCUT_TOLERANCE_MM`), and the overhang must still hide it.
   - At the common axis, all 48 of 044's flagged points were overhung by at most 0.1 mm, 30 of them by less than
     0.02 mm. Even each prep's best direction alone left 14 and 5 (the lab's own margins 23 and 17).
   - 045's 4 points were overhung by less than 0.03 mm.
   - The bulbous test prep's 0.6 mm overhang still counts.
4. **An axis that keeps the margins visible.** `searchVisibleAxis` (`axis.ts`) runs the least-undercut search, and when
   that direction hides margin points, takes the least-undercut direction in the cone that hides none (candidates in
   cost order, checked lazily: `searchInsertionAxis`'s new `accept`). Used for the bridge's common axis
   (`searchCommonAxis`) and for single crowns (the worker's axis analysis, the runner).
   - On 044 the axis moved 15° from the abutments' mean occlusal, and no margin point is hidden.
   - The search took 124 ms there (65 ms before).
5. **The cement gap where the rim limits it.** On 044 the axis runs along 36's mesio-lingual wall, which leans over
   the margin by up to 0.05 mm there.
   - **A signed gap measure.** `measureIntaglioGap` (`intaglio.ts`) casts from 0.2 mm inside the prep wall
     (`GAP_BEHIND_MM`). Before, an intaglio inside the prep gave no hit and the sample was skipped. On 044 that hid 26
     samples where the crown cut 0.045 mm into the wall. The union's seating check, which casts against the whole
     bridge, met the outer surface there and reported a 0.46 mm "seating change".
   - **`clearRim`** (`intaglio.ts`, called in `designCrown`): a rim point the prep hides along the axis moves outward,
     by at most the tolerance, until it clears. The crown's rim then slides past the wall instead of into it.
   - **Walls outside the margin, seen along the axis** (`loop`, the margin loop, passed by `designCrown` and
     `checkBridgeUnion`). The rim has to slide past such a wall, so it can't have the full gap. There only a collision
     counts, as on the walls the shadow test already skips.

### Deviations from the design

- **Items 3–5 were not planned.** Once the frames were right, 044 failed on the margin undercut, the cement gap and
  the seating. Each failure traced to a check or a construction that real scans exposed, not to the frames.
- **The test is a constructed point set, not a cut of the synthetic arch.** A cut keeps the synthetic arch's correct
  bend, so the old code passes it. The test builds a 24 mm segment that bends toward the cheek, as 044's does.
- **Tried and reverted:** zipping the intaglio's strips by the shorter diagonal (no change: the cause was the rim, not
  the triangles); a connector that slides along the axis until its ends clear the fitting surfaces (no height cleared
  044's 3.3 mm pontic).

### Results (local, exocad golden cases; `data/exocad/scripts/*.mts`)

| 044 bridge 34–[35]–36 | Before | After |
|---|---|---|
| Frame handedness 35, 36 | −0.92, −0.90 | 0.96, 0.99 |
| 36's occlusal from the lab's ring normal | 36° | 14° |
| Margin points in an undercut (common axis) | 51 | 0 |
| Connector heights 34–35, 35–36 (min 3 mm) | 0.02, −0.53 mm (22.9 mm wide) | 3.39, 3.39 mm |
| Pontic base gap | −0.96 mm | −0.0008 mm |
| Retainer cement-gap error 34, 36 (limit 0.01) | 0.061, 0.070 mm | 0.0097, 0.0097 mm |
| Seating change in the union 34, 36 | 0.77, 0.71 mm | 0, 0 |
| Pontic self-intersections | 126 | 0 |
| Union self-intersections | 159 | 32 |

- **Still failing on 044:**
  - Connector 35–36: its end is through the pontic's base.
  - The union: 32 self-intersections and 2 degenerate triangles, all at that junction. The exported STL, welded, has
    none.
- **Other real cases:**
  - 045: the margin undercut passes (4 → 0).
  - 056: on its quadrant scan the frame keeps the local occlusal; crown gap error 0.009 → 0.0052 mm, thickness
    0.79 → 0.84 mm.
  - The 16 crowns of 042 and 049, and the 035 bridge: no check changed (one value moved by 0.0001 mm).
- **Synthetic golden cases:** 8 of 8 pass, 15 of 15 with the automatic margin.

### Verification

- **Tests:** 128 → 129. Each fails on the old code and passes on the new.
  - **New** in `prepFinder.test.ts`: "follows the abutments' order on a segment scan whose curve bends the wrong
    way". On the old code the curve's normal was +0.97 on x, where buccal is −x.
  - **Extended** "reports undercut and a margin in undercut for a bulbous prep" (`axis.test.ts`): a wall 0.03 mm over
    the margin hides it from the plain ray test only. Old code: all 96 points flagged.
  - **Extended** "seats on the prep" (`crown.test.ts`, 36 only): an intaglio pulled 0.15 mm into the walls measures
    over 0.1 mm of error. Old code: 0 (every sample skipped).
- `pnpm typecheck` and `pnpm test` pass.

### Follow-ups

- **A tight span: the retainers take the pontic's room.** On 044 the pontic gets 3.3 mm along the arch.
  - The lab's wax-up gives it about 4.3 mm, with 36 about 10.5 mm wide (no wider than its margin) and 34 about 6.4 mm.
  - Our retainers' templates are scaled to the margin (36 by 1.21) and keep their full width on the side that faces
    the pontic. Sharing a tight span would narrow those sides.
  - Then connector 35–36 can sit inside the pontic, and the union's sliver goes with it.
- **Single crowns on a segment scan:** buccal is still the centroid's guess.
- **The prep finder on a segment scan:**
  - It takes the PCA axis as its occlusal, and found no preps on 044.
  - Fixing that also needs its tooth pairing to stop relying on the curve's direction.
