# The cement gap on real scans

Status: **done, partly** (2026-10-30). The gap is closer to its intent; the ±0.01 mm limit still fails on most real
crowns. Whether to keep that limit for real scans is a decision (see the end).

## Goal

On the exocad sample cases every real crown failed `crown.gap`, the maximum cement-gap error on the axial walls
(limit 0.01 mm, `measureIntaglioGap` in `apps/web/src/geometry/intaglio.ts`): 0.014–0.046 mm on 18 single crowns,
0.020–0.029 mm on 4 bridge retainers (`2026-10-29-exocad-sample-cases.md`). The synthetic preps meet it. The goal is
to find out why, and fix what can be fixed.

## What the measurements show (`data/exocad/scripts/gapDiag.mts`, local; 4 crowns, 1,900–6,000 wall samples each)

- **The typical error is tiny.** The median is 0.001–0.002 mm and the 99th percentile 0.010–0.013 mm. The maximum is a
  few samples.
- **Every large error is negative:** the intaglio sits too close, so the crown would bind there, not rock.
- **Not undercuts:** almost no sample lies in an undercut along the axis (22 of 2,755 on one crown, none on the
  others).
- **Three discretisation causes,** largest first:
  1. **The envelope is a height map.** The intaglio's radial profiles cast rays down the insertion axis at 200 even
     radial steps (about 0.02 mm). On a near-vertical wall one step moves 0.4 mm down, so the wall's curvature
     between samples is lost.
  2. **Too few points per profile.** Each profile is resampled to 32 points by arc length: 0.3 mm apart on a real
     prep's tall walls, which cuts inside tight line angles.
  3. **Corners round the tooth.** One profile per point of the template's cervical ring (128) puts profiles 0.23 mm
     apart. At a molar prep's tight axial corners the triangles between profiles cut inside by about 0.01–0.02 mm.
- **Not the vertex-normal offset in concave spots.** A pass moving every intaglio vertex out to its intended gap from
  the closest prep point changed nothing (one crown 0.0124 → 0.0117 mm). The vertices keep their gap; the triangles
  between them do not.

## What was built

- **Adaptive envelope samples** (`buildIntaglio`). Where two neighbouring envelope samples lie more than 0.05 mm
  apart, the profile is sampled between them, halving up to 6 times. Steep walls get dense samples and flat areas
  none extra. A blocked-out undercut stays a vertical drop. The pontic base and the Ti-base, which use
  `buildIntaglio` too, get the same sampling.
- **64 points per profile** for a crown's intaglio (`INTAGLIO_PROFILE_POINTS` in `crown.ts`; the Ti-base already used
  64).
- **Not built:** more profiles round the tooth. It needs either more columns in the crown template (the shell doubles)
  or intaglio profiles between rim points (a new stitch).

## Results (local)

| | Before | After |
|---|---|---|
| Single crowns meeting 0.01 mm (exocad golden cases) | 0 of 18 | 3 of 18 |
| Their max error | 0.014–0.046 mm (median 0.021) | 0.008–0.040 mm (median 0.013) |
| 99th-percentile error (the 4 studied crowns) | 0.010–0.013 mm | 0.006–0.007 mm |
| Bridge retainers' max error (035, 045) | 0.020–0.029 mm | 0.013–0.021 mm |
| Synthetic golden cases | pass | pass (crown 0.003–0.004 mm) |
| Crown time on real scans (median) | 0.39 s | 0.52 s |
| Bridge time (035, 045) | 1.5–1.6 s | 1.9–2.0 s |

## Verification

- `pnpm typecheck`, `pnpm test` (126; the crown and bridge tests pass).
- The synthetic golden cases (15/15), the exocad golden cases (as above), and the browser scripts (see
  `2026-10-30-prep-finder-sections.md`, run together).

## The decision left

The remaining maxima, 0.01–0.02 mm (0.03–0.04 on two crowns), sit at a few samples on tight axial corners. Two ways
on:
- **Close them.** Profiles between the template's ring points, or 256 template columns. This costs another 30–60%
  of crown time and, with the columns, a bigger shell for every later step.
- **Read the check differently on real scans.** For example, the 99th percentile within 0.01 mm and the maximum
  within 0.02 mm, about a milling tool's accuracy, keeping 0.01 mm as the maximum on the synthetic cases.
