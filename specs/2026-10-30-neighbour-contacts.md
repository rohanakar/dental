# Neighbour contacts: the neighbour's tooth, not the prep's own cusp or a gum mound

Status: **done** (2026-10-30).

## Goal

The tooth frame finds the mesial and distal contacts that crown adaptation aims for (`findNeighbourContacts`,
`apps/web/src/geometry/toothFrame.ts`). On the exocad cases (`2026-10-29-exocad-sample-cases.md`), a last molar got a
distal contact with nothing behind it ("open: nothing within reach"). The goal was to fix that.

## What the measurements show (`data/exocad/scripts/contactDiag.mts`, local)

- **Most "contacts" on 042 were the prep itself:** 0.4–0.9 mm from the click, at the height of the prep top. Two
  causes:
  - Rays start in a fan around the prep top, up to 2 mm above it. One started in the air ran into the prep's own
    raised cusps, which face back at it.
  - A ray inside the prep crossed an occlusal groove and met the opposite cusp's wall, 0.5–1.7 mm away.
- **This also explains 042's "open" contacts.** Adaptation aimed at its own cusps and reported them 1–2.5 mm open.
- **Behind the last lower molar (37), the ray met the retromolar pad.** It is a gum mound: the surface 1–3 mm beyond
  the hit rises only 0.8 mm. Beyond every real neighbour it rises 1.5–4.5 mm, a tooth's crown above its contact.
- **Real neighbour contacts lie 2.7–7.3 mm from the click**, premolars 2.7–4.9 mm and molars 5.7–7.3 mm.

## What changed

- **`ownTooth`** (the frame sets it: its origin is on a prep's top). A contact must be a new solid:
  - the ray has left one (a back-facing hit, the prep's wall);
  - the hit is at least 2 mm away (`CONTACT_MIN_MM`).

  Otherwise the hit is the prep's own surface, and the ray goes on through it. Pontics and implant crowns, whose
  origin is in the air over a ridge or an opening, keep the old rule.
- **A tooth beyond, for every caller.** Candidates are tried nearest first. The first whose surface 1–3 mm beyond
  rises at least 1 mm (`CONTACT_RISE_MM`) is the contact; a gum mound never is.

## Results (local)

- **The 11 checked crowns' contacts are all on neighbours,** 2.7–7.3 mm away. The last molars 27 and 37 have no distal
  contact. Before, 9 contacts were the prep's own cusps, at 0.37–0.97 mm.
- **Adaptation on the 18 exocad crowns:**
  - The distal failures of 27 and 37 ("nothing within reach") are gone.
  - The remaining open contacts on 042 are real gaps of 0.8–2.3 mm to neighbouring preps. No single crown closes those.
    On a multi-prep case the contact is between two crowns.
- The synthetic golden cases pass 15 of 15, including the pontic and implant bridges, and `pnpm test` passes.

## Verification

- **Test** (extends the contact test in `toothFrame.test.ts`): three revolved shapes along x, a prep whose top has a
  raised cusp rim, a neighbour tooth 8 mm mesial and a low gum mound 7 mm distal. The contact must be on the
  neighbour (beyond 4.4 mm), with none distal.
  - It fails on the old code: the contact was the prep's own rim, 0.55 mm away.
  - The synthetic jaws do not reproduce either case: their prep tops are flat and the arch ends cleanly.
- `pnpm typecheck`, `pnpm test` (126), the golden cases (15/15), and the exocad golden cases.
- **Browser scripts:** all 13 offline ones pass on a clean run (an idle machine; an earlier run with heavy jobs beside it timed out on screenshots and clicks, and did not count).
