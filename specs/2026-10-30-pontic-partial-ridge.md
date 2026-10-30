# A pontic over a partly scanned ridge

Status: **done** (2026-10-30). A bridge on a 3-tooth segment scan still fails, for another reason (see the end).

## Goal

The pontic's base rests on the ridge at a set gap (`designPontic`, `apps/web/src/geometry/pontic.ts`). Its outline
(the template's cervical ring drawn in to 70%) is cast down onto the ridge. If any outline point lands on no scanned
ridge, the pontic stops: "N rim points are not over the scanned ridge". On the exocad 34–[35]–36 bridge (044) that
stopped the whole bridge. Lab scans have such gaps: a segment scan's edge, and the saw cuts between a sectioned model's
dies.

## What the measurements show

Under pontic 35 of 044 the ridge is there but full of holes. One outline point misses, and a little further in it
hits; the misses are scattered round the ring. A first fix, drawing missing points in with a running minimum round the
ring, spread each deep dip to its neighbours, whose drawn-in positions fell into other holes.

## What changed

Each outline point keeps the furthest-out place where it lands on scanned ridge, drawn toward the centre in 5% steps
down to 30% (`PONTIC_MIN_REACH`).
- **The outline stays even:** each point is placed at the average reach of its ±3 neighbours, and keeps its own hit if
  that misses.
- **A point over a hole all along its line** (a saw cut) takes its place on the line between its nearest neighbours: no
  base can touch a hole.
- **When it stops:** only if more than a quarter of the outline has no ridge at all (`PONTIC_MAX_HOLES`). The message
  then gives the count out of the total.
- **When it warns:** whenever it draws in or bridges a hole, saying how many points.

With the ridge fully scanned, every point reaches 100% and the pontic is the same as before.

## Verification

- **Test** (extends the posterior synthetic bridge test in `tools/pipeline-runner/src/pipeline.test.ts`): the scan is
  rewritten with a 0.5 mm saw cut across the ridge under pontic 36. The bridge is designed again, and the pontic base
  must still rest at its target gap (−0.02/+0.05 mm).
  - It fails on the old code: "Pontic 36: 9 rim points are not over the scanned ridge".
  - It passes on the new.
- The synthetic golden cases pass 15 of 15, every pontic base at −0.0001 to −0.0002 mm, as before. `pnpm test` passes.
- **044:** the pontic is now designed. The bridge still fails, see below.
- **Browser scripts:** all 13 offline ones pass on a clean run (an idle machine; an earlier run with heavy jobs beside it timed out on screenshots and clicks, and did not count).

## What still fails on 044

044 is a 3-tooth segment (17.6 × 24 mm) with no antagonist, and the arch curve can't be fitted to it.
- The bridge frames for 35 and 36 point the wrong way (FDI handedness −0.9).
- The pontic frame finds "no ridge … its frame origin is on the arch curve".
- From there the connectors (22.9 mm wide), the common axis and the union all fail.

Making bridge frames work on a segment of a few teeth is its own task: the arch direction from the abutments
themselves, not from an arch curve.
