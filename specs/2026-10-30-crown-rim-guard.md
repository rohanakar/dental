# The crown's rim guards against a kinked margin

Status: **done** (2026-10-30).

## Goal

A margin edited by a drag can double back on itself (drags aren't snapped, by design;
`2026-10-27-margin-click-snap.md`). The crown's rim is sampled along the margin (`designCrown`,
`apps/web/src/geometry/crown.ts`), so it zigzags through the spike, and the margin band folds: the crown is no longer
printable. The crown builder should not fold on a kink the user may not have seen.

## What changed

`withoutKinks` (in `crown.ts`) runs on the traced margin before the rim is sampled.
- **Cuts detours.** A stretch that leaves the line and comes back within 0.15 mm of where it left, after 0.6–4 mm of
  arc, is a spike, and is cut out. It repeats up to four times.
- **Relaxes the rest.** Any turn still sharper than the margin gate's 120° (`MARGIN_MAX_TURN_DEG`, over 0.6 mm chords)
  is moved toward its neighbours, a few rounds, each point back onto the scan.
- **Warns when it changed anything.** "The margin turns back on itself in places; the crown follows it without the
  kinks. Check the margin."

The margin stays as the user drew it; only the crown's rim leaves the kink out.

## Verification

- **Test** (extends "is a closed, printable solid" in `crown.test.ts`, the 36 case): the margin gets a 1 mm spike out
  and back along the scan.
  - It fails on the old code (the crown isn't printable).
  - It passes on the new.
- **Real margins:**
  - The guard fires on none of the 21 exocad golden cases' margins, except 049/25 and 049/26. Their margins come from
    a lab line 0.3–0.6 mm off the scan's edge, and the live-wire kinks through it.
  - There their crowns' self-intersections fall from 1,717 to 110 and from 1,543 to 114. That is not to zero: those
    margins are wrong in other ways too.
- The synthetic golden cases pass 15 of 15 (the guard never fires on them). `pnpm typecheck` and `pnpm test` pass
  (128 for this batch of six specs; no new test here). All 13 offline browser scripts pass (an idle machine).
