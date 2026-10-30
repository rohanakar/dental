# The prep finder on real preps: the ledge read from the scan's cross-sections

Status: **done** (2026-10-30).

## Goal

The prep finder (`apps/web/src/geometry/prepFinder.ts`, `2026-10-26-prep-finder.md`) rings the preps on a jaw scan, so
that auto frames and "bridges out of the box" can start without a click. On the exocad sample cases it found 9 of
24 posterior preps on arch scans and none of the anterior ones (`2026-10-29-exocad-sample-cases.md`). It also rings
false preps on real natural jaws: 10 on 12 Teeth3DS jaws (`2026-10-27-natural-margin.md`). The goal is to find more
real preps and fewer false ones.

## What the measurements show

Measured with `data/exocad/scripts/prepDiag.mts` and `prepSection.mts` (local).
- **Candidates are not the problem.** A candidate peak lies within 0.3–2.8 mm of every lab prep's centre.
- **The ledge test is.** It uses height profiles: a wall, then a ledge where the slope eases, then a drop. Real walls
  are near-vertical or undercut, which a height map does not sample (the same cause as `2026-10-29-margin-on-real-preps.md`).
  - From the lab margin's own top, the ledge fraction is 0.13–0.92 on the posterior preps. Only 3 of 26 reach the
    0.75 the finder needs.
  - On every candidate peak of 28 all-natural jaws (16 exocad antagonists, 12 Teeth3DS; 769 peaks), 19 peaks reach
    0.75.
- **The same signature on cross-sections** (the sections of `sectionProfile.ts`, walked from the top):
  - a wall, at least 1 mm of drop steeper than 50°;
  - then the chamfer or shoulder's inner angle, a concave turn of at least 8°;
  - within 1.5 mm, the lip, a convex turn of at least 12°;
  - then at least 0.4 mm more drop.

  From the lab tops, 18 of 26 posterior and 8 of 20 anterior preps reach 0.65, and no natural peak does (the highest
  is 0.58). Neighbouring settings give the same counts (a plateau, not a fitted point): a wall of 40° or 50°, a turn
  of 4–8°, and a lip within 1.5–2 mm.

## Scope

**In:**
- The ledge test of the prep finder on sections (the angle test on the turns of `quietTurns`), with the ring at 0.65.
- The leaning-front-tooth retry along the stump's own axis, unchanged, on sections.
- The ledge points still centre the ring.
- An optional `grid` input; the worker passes its cached triangle grid.

**Out:**
- **Scan bodies.** Their no-ledge check keeps the height profiles: it was measured on them and passes all.
- The candidate peaks.
- The pairing of preps to case teeth.

## Verification plan

- **Tests:** `prepFinder.test.ts` must pass unchanged (synthetic preps found and paired, no cavity or natural tooth
  ringed, scan bodies). No new test: the synthetic preps are height maps, and the behaviour that changes is real-scan
  recall, measured below.
- **The finder itself, from its own peaks:**
  - lab preps found (a prep within 3 mm of the lab margin's centre), posterior and anterior;
  - false preps on the 28 natural jaws;
  - its time per jaw.
- The browser scripts that use frames from case setup and bridges out of the box. `pnpm typecheck`, `pnpm test`.

## Implementation summary

### What was built
- **Shared cross-section code.** The automatic margin's section walk, resampling and noise-adaptive turns moved out of
  `autoMargin.ts` into `apps/web/src/geometry/sectionProfile.ts`, unchanged. `quietTurns` now also returns the
  smoothed profile it measured.
- **The ledge test on sections** (`apps/web/src/geometry/prepFinder.ts`):
  - `sectionFinishLine` cuts 24 profiles. `sectionLedge` reads wall, inner angle, lip and drop (`LEDGE`), and the ring
    needs 0.65.
  - The leaning-front-tooth retry runs on sections too.
  - The ledge points still centre the ring.
  - The scan-body check keeps the height profiles (`finishLine`, now used only there).
- **The grid.** `PrepFinderInput.grid` is optional; the worker passes its cached triangle grid.

### Results (local, aggregate only; `data/exocad/scripts/prepFinderEval.mts`, the finder from its own peaks)

| | Before (height ledge) | After (section ledge) |
|---|---|---|
| Posterior lab preps found | 9 of 26 | **17 of 26** |
| Anterior lab preps found | 0 of 20 | **9 of 20** |
| False preps, 28 all-natural jaws (16 exocad antagonists, 12 Teeth3DS) | 15, on 10 jaws | **0** |
| Time per jaw (once per scan, cached in the worker) | median 0.35 s, max 0.56 s | median 0.64 s, max 1.16 s |

- **The 9 posterior misses:**
  - an inlay (052/26) and an overlay (050/46), which are right to miss as crown preps;
  - the segment scan 044 (34 and 36) and 049's two (25 and 26), also hard for the margin;
  - three molars: 035/46, 045/46 (wide and low, with the occlusal surface running far out) and 042/26.
- **Rings away from every lab prep on the prepped jaws:**
  - one on 042's upper jaw: very likely 17, which is prepped but has no usable lab margin;
  - one on 031's prepped upper jaw and one on 056's lower jaw, which can't be confirmed either way.

### Deviations from the plan
- None in the design. The threshold of 0.65 is not the 0.75 of the height test, set from the measured gap: the highest
  natural peak is 0.58.

### Verification
- `pnpm typecheck`; `pnpm test` (126; `prepFinder.test.ts` unchanged and passing); the golden cases with `--auto`
  (15/15).
- **Browser scripts:** all 13 offline ones pass, in a clean run with the front-tooth frame and cement-gap changes of
  the same day (dev server on :5300). ai-flows and online-case need the API and were not run.
  - An earlier run while code was being edited failed ai-bridge, bridge and framework on page reloads (vite hot
    reload). That run did not count.

### Follow-ups
- **Wide, low molars** (035/46, 045/46): the same occlusal-surface trouble as the margin's.
- **The two unconfirmed rings** (031, 056): a look at them when the in-house cases come.
- **Time:** about 0.3 s more per scan, once. Profiles could stop at the first ledge.

## Round two (2026-10-30): off-centre peaks, duplicate rings, wall-free preps

- **Re-centring** (`prepFinder.ts`).
  - A candidate ringed partway (0.4 up to 0.65) is profiled again from the top over the centre of the ledges it found.
  - A wide molar's highest cusp can lie 2.6 mm off the prep's centre. From 042/26's own top its ring is 0.83, from the
    peak below threshold.
  - Posterior lab preps found: 17 → **18 of 26**.
- **One ring per prep.** Re-centring rang 042's 26 and 27 twice, from centres 3–5 mm apart. A fixed 3 mm spacing did
  not catch them, and neither did the ring's radius.
  - The same prep is the same finish line. A new ring is a duplicate when a third of its ledge points lie within 1 mm
    of an existing ring's (`SAME_LEDGE_MM`). The stronger ring stays.
  - Measured: 48–94% shared on the real duplicates, 0 between neighbouring preps.
  - 042 now has one ring per prepped tooth (8 on each jaw, 17 included).
- **Wall-free preps** (035/46, 045/46).
  - Their surface slopes down without a wall and turns sharper at the margin, so they ring 0.25–0.29 even from their
    tops.
  - A wall-free variant (a sharp convex corner below 1 mm of drop, then a drop) catches them only with a corner of 20°
    or less. That also rings 2–3 natural peaks at 0.65 or more.
  - Not added: a wrong ring is worse than none.

| | Round one | Round two |
|---|---|---|
| Posterior lab preps found (26) | 17 | **18** |
| Anterior lab preps found (20) | 9 | 9 |
| False preps on 28 natural jaws | 0 | **0** |
| Rings on 042 (8 prepped teeth per jaw) | upper 7, lower 8 | 8 and 8, one per tooth |
| Time per jaw (median, max) | 0.64 s, 1.16 s | 0.63 s, 1.18 s |

`prepFinder.test.ts` passes unchanged. Its pairing test is the one-ring-per-prep guard on the synthetic jaws, where
peaks are centred; the real duplicates came from wide molars.

Browser scripts after round two: all 13 offline ones pass (with the cement-gap, contact and pontic changes of the same
day).
