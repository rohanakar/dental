# Front-tooth frames: the side toward the antagonist is the jaw's

Status: **done** (2026-10-30).

## Goal

Stop the tooth frame flipping upside down on front teeth. On the exocad sample cases, 9 anterior preps got no margin
line at all because their frame's occlusal pointed into the tooth (`2026-10-29-exocad-sample-cases.md` put this as
"front-tooth frames flip on 8 of 18").

## What was wrong

- **When it happens.** It is not every front tooth. A click at the centre of the prep top gives a frame 0–24° from the
  jaw's occlusal. A click 2–4 mm down the tooth's slope flips it 150–175° (traced on 031/13, 033/11, 033/12, 049/11
  with `data/exocad/scripts/frameTrace.mts`; local).
  - The first evaluation clicked along the lab margin's ring normal, which tilts 20–37° on a scalloped anterior
    margin. That is how the flips showed up. A user's click can land there as easily.
- **The cause,** in `estimateToothFrame` (`apps/web/src/geometry/toothFrame.ts`):
  - The normals within 10 mm of such a click tilt 25–32° labially. Their alignment with the jaw's least-variance axis
    (0.84–0.91) misses the 25° (0.906) that would switch to the jaw's axis, so the frame's occlusal is the tilted
    local one.
  - The antagonist check then tests the side against the antagonist's centroid seen from the click. From a front
    tooth that centroid lies only 3–6 mm past the incisal edges, but 15–25 mm behind them.
  - So the labially tilted occlusal scores negative and is flipped. The warning it adds, "Surface normals point away
    from the antagonist", is wrong too.

## The fix

The side is decided at jaw level, as the prep finder's `jawOcclusal` already does: the jaw's least-variance axis,
pointed from the jaw's centroid toward the antagonist's. The occlusal is flipped only if it points against that. The
jaws' centroids are 10–20 mm apart along that axis, so the test does not depend on where on the arch the click is.

## Verification
- **Test** (extends the leaning-front-tooth test in `toothFrame.test.ts`). The synthetic jaw is flat enough that its
  local normals never miss the 25°, so the test sets the condition up directly:
  - the jaw's normals turned 30° labially;
  - the antagonist's centroid 4 mm past the incisal edge and 20 mm behind it, as measured on the real cases.

  It failed before the fix (the occlusal's z +0.84, facing away) and passes after (below −0.7, no antagonist
  warning).
- **Real front teeth (local):** all 20 anterior lab preps on arch scans now get a frame 0–28° from the jaw's occlusal.
  That holds both from the centre click and from the off-centre one (before, 9 flipped). Veneer 054/22 went from 153°
  to 20°.
- **The margins on them:** anterior lines right went from 14 to 19 of 27. All 9 teeth without a line now have one, and
  case 033 has 5 more right. The 4 that are not right include 049/11 and 031/13, whose lab lines are off the scan's
  edge. Posterior unchanged (17/19 and 13/17).
- `pnpm typecheck`, `pnpm test` (126; the extended test), the golden cases (15/15), and the browser scripts (see
  `2026-10-30-prep-finder-sections.md`, run together).
