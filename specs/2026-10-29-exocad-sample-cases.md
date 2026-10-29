# A first look on real preps: the exocad sample cases

Status: **done** (2026-10-29): measured, no code changed. The fixes are follow-ups.

## Goal

Find out which of the cases in the local exocad DentalCAD 3.3 install
(`~/Documents/exocad-DentalCAD3.3-SR1-2026-01-16/CAD-Data`) are useful for dcad's crowns and bridges, and measure dcad
on them. Until now nothing had been measured on real prepped teeth (`2026-10-27-inhouse-validation.md`); these cases
have real preps and the lab's own margin lines.

## Scope

**In:** an inventory of the 60 cases; the lab's margins and insertion axes pulled out of exocad's files; dcad's prep
finder, frame, automatic margin, margin gate, doubt warning and insertion axis scored against them; the crown and
bridge designed end to end on the lab's margins with the golden-case runner.

**Out:** code changes (the fixes are follow-ups, each with its own spec); anterior teeth, implants, dentures and
partials beyond the inventory; committing any case or anything derived from one.

## The data

- **What it is:** exocad's own sample datasets (each case's notes carry a `DSID-nnn` id and `#sample` tags). The patient
  fields hold a description of the case and a fixed placeholder first name, not a person.
- **Licence:** they ship with exocad DentalCAD. Treated like Teeth3DS: local evaluation only, never committed, and
  nothing derived (meshes, margin lines, per-case tables) goes into git. Only aggregate numbers are in this spec.
  Whether exocad's licence allows using its sample data to evaluate another CAD product should be checked before
  relying on these numbers outside the team.
- **Formats:** jaw scans as STL, PLY (ASCII and binary, with colours or texture coordinates) and OBJ. dcad reads STL and
  PLY; the OBJ scans were converted to binary STL.
- **The lab's margins:** exocad writes each tooth's margin (`PreparationMargin` or `Margin`, 170–515 points) and
  usually its insertion axis (`AxisInsertionScanInfo`) into the case's `.scanInfo`, `.constructionInfo`, or the XML
  embedded in its `.dentalCAD` scene. 75 margins were found. They lie on their scans: median 0–0.07 mm from the nearest
  scan vertex, max ≤ 0.16 mm. Two were dropped: 042/17 (1.1 mm off its scan) and 058/46 (0.5 mm off; it sits on the
  coping instead). The six telescope margins of 004 sit on the primaries, not on preps, and were left out.
- **Bite:** the two jaws are in occlusion in every case but one (043 is 3.7 mm open).
- **`*-toothmodel_cad.obj`:** exocad's library teeth as placed on the preps (0.15–0.5 mm from the margin), not finished
  crowns. Few cases have a finished design as STL: a 34–36 bridge wax-up (044) and a coping (058).

### What is useful for crowns and bridges

| Use | Cases | Teeth |
|---|---|---|
| Posterior crowns on arch or quadrant scans, with the lab's margin | 042 (both jaws, 14–16, 24–27, 34–37, 44–47), 049 (25, 26, intraoral), 056 (45, intraoral), 035 and 045 (44, 46), 044 (34, 36) | 24 |
| Posterior 3-unit bridges with the lab's abutment margins | 035, 045 (44–46, quadrants), 047 (44–46, on a die section), 044 (34–36, with the lab's wax-up) | 4 |
| Posterior dies (separated, no arch), with the lab's margin | 043 (14, 17, 25, 26), 047 (44, 46), 048 (34, 44), BATCH-053 (34, 35, 36, 38) | 12 |
| Posterior crowns and bridges without a lab margin | 011 (36), 036 (26), 039 (36), 040/041 (15, post and core), 057 (26), 037/038 (35–37 provisional bridges) | 7 cases |
| Anterior crowns, copings and veneers with the lab's margin | 015, 031, 033, 043, 046, 048, 049, 051, 054, 055, BATCH-053 | 27 |
| Implants (positions, scan bodies) | 020–030, 099, 100 | for the implant flow later |
| Not useful here | dentures, partial frameworks, bars, splints, smile design, telescopes | about 25 cases |

Some cases share scans: 038 and 039, 036 and 057, the lower jaws of 040 and 041.

## Method

- **Intake** (local, `data/exocad/scripts/`): `margins.py` pulls the margins and axes out of the exocad files;
  `intake.py` writes `data/exocad/manifest.json`, one entry per margin with the scan it lies on, and converts OBJ to
  STL.
- **The click:** the prep top straight above the centre of the lab's margin (along the jaw's occlusal from the prep
  finder; on a die, along the lab's axis).
- **Per margin** (`evalExocad.mts`, run with the pipeline runner's tsx):
  - the prep finder (`apps/web/src/geometry/prepFinder.ts`) on the whole jaw: a prep top within 3 mm of the margin
    centre;
  - the tooth frame from the click;
  - the app's automatic margin (`refineMargin`, as the worker's `autoMargin`);
  - the technician path: the live-wire through 8 points of the lab's line, with the ridge snap;
  - the margin gate (`marginGate` in `apps/web/src/ai/qa.ts`, without the region check), the doubt warning
    (`marginDoubt`), and the insertion axis searched on the prep region inside the lab's margin.
- **A line counts as right** when its mean distance to the lab's line is ≤ 0.10 mm, ≥ 90% of it is within 0.2 mm, and
  it covers ≥ 90% of the lab's line within 0.2 mm (the in-house spec's bars, plus coverage, so a short loop on part of
  the line does not count).
- **End to end:** `goldenExocad.mts` writes golden cases (`data/exocad/golden/`) with 12 points of the lab's line as the
  scripted anchors and the line as the reference. They ran through the unchanged runner
  (`tools/pipeline-runner/src/cli.ts`).

## Results

### Margin, frame and axis (67 margins)

| Measure | Posterior, arch | Posterior, die | Anterior, arch | Anterior, die |
|---|---|---|---|---|
| Margins | 24 | 12 | 18 | 9 |
| Prep finder found the prep | **9/24** | – | 0/18 | – |
| Frame flipped (occlusal > 90° off) | 0/24 | 2/12* | 8/18 | 4/9* |
| Automatic margin right | **3/24** | 2/12 | 1/18 (8 none) | 0/9 |
| Gate passed a wrong line | **16/21** | 6/10 | 8/9 | 9/9 |
| Doubt warning flagged a wrong line | **20/21** | 7/10 | 9/9 | 9/9 |
| Doubt warning flagged a right line | 0/3 | 0/2 | 0/1 | – |
| 8 clicks on the lab's line right | **22/24** | 12/12 | 11/18 | 9/9 |
| Insertion axis vs the lab's | median 2.0°, max 16° (n = 20) | median 4.7° | | |

\* On dies without a lab axis (046, 048) the click's direction was guessed, so these flips may be the script's, not
dcad's.

- **Overall:** the gate passed 39 of 52 wrong automatic lines. The doubt warning flagged 47 of 52, and none of the 6
  right ones. The right set is small, so its false-alarm rate is not known yet.
- **Where the wrong lines go:**
  - Most follow the lab's line for part of the way, then a stretch climbs 1.5–3.5 mm up the prep (p90 height +2 to
    +3.6 mm).
  - Four run 1–2.5 mm high the whole way round (042/14, 043/17, 043/26, 049/26), and four more for over half of it
    (042/15, 042/24, 043/14, BATCH-053/34). They sit on the edge where the side walls meet the top of the prep.
  - Seven have a stretch 1–3.5 mm below the lab's line (035/46, 042/34, 042/36, 044/34, 044/36, 045/46, 056/45).
    That's the die ditch or the gum.
  - The finish line is not the sharpest edge on a real prep; the line angle at the top of its walls often is.
- **The prep finder** misses preps whose neighbours are prepped too. On 042 it found every second one in three
  quadrants (14, 16, 34, 36, 44 and 46; missed 15, 35, 37, 45 and 47) and none of 24–27. On the two bridge quadrants
  it found 44 and missed 46. It found no anterior prep.
- **The technician path** has a mean distance of 0.003–0.035 mm (median 0.019 mm) on 22 of 24 posterior arch preps.
  - It strays 0.25–0.5 mm on the intraoral scan 049 and the anterior 031, and 0.13 mm on the overlay 050. There the
    lab's line is not the sharpest crease between clicks 3.5 mm apart.
  - The ridge snap is not the cause: without it the numbers barely change.
- **Frames:** posterior frames are 2–16° from the lab's axis (median about 6°) and never flipped. Front-tooth preps flip
  on 8 of 18 upper anterior arch preps (031/13, five of 033's six, 049/11, 055/21), and both veneers (051, 054) flip.
- **Inlay (052) and overlay (050):** not finish-line cases. The automatic line is 2–3 mm below the lab's.

### Crowns and bridges on the lab's margins (runner, 21 cases)

| Check | Single crowns (18) | Bridges 035, 045 (44–46) |
|---|---|---|
| Margin within 0.15 mm mean, 0.5 mm max of the lab's | 16/18 (049/25, 26: 0.32–0.39 mm mean) | 4/4 abutments |
| Watertight | 18/18 | units 6/6, union 2/2 (one solid) |
| Printable (no self-intersections) | 16/18 (049/25, 26: 446 and 895) | 6/6, union 2/2 |
| Thickness | 18/18 | 4/4 |
| Occlusion adapted | 18/18 | 6/6 (on 46 a conflict is reported: −3.0 mm clearance) |
| Cement-gap accuracy (limit 0.01 mm) | **0/18**: max error 0.014–0.046 mm | 0/4: 0.020–0.029 mm |
| Proximal contacts reached | mesial 6/18, distal 2/18 | 0/4 |
| Connectors, pontic base, seating | | all pass |
| Common axis without margin undercut | | 1/2 (045: 4 points) |

- **044's bridge** (34–36, a 17 × 24 mm segment) stopped: "Pontic 35: 20 rim points are not over the scanned ridge".
- **Contacts:** most of the open contacts are on 042, whose neighbours are preps too. There the gap to the next tooth
  is 1–2.5 mm, and no single crown can close it, so the failures say little. With natural neighbours, both contacts
  were reached on 056/45 and 049/26; 049/25's distal stayed 1.1 mm open. The distal contacts of 27 and 37 show
  "nothing within reach": a last molar still got a distal target.
- **Time:** each single crown ran in 0.7–1.3 s end to end on these scans (125k–400k triangles).

## Fixes, ranked

1. **Put the doubt warning into the margin gate.**
   - The gate passed 39 of 52 wrong lines, so one-click would carry a margin up to 3.5 mm off into a crown.
   - The doubt warning flagged 47 of 52 wrong lines and none of the 6 right ones.
   - First, more right lines are needed to measure its false alarms: the technician lines are a ready source.
2. **The automatic finish line on real preps.**
   - 3 of 24 right.
   - Prefer the lowest strong convex edge (the outer edge of the shoulder or chamfer) over the sharpest one, which is
     often the line angle at the top of the walls.
   - Reject stretches that drop into a ditch or onto the gum.
   - The live-wire is not the problem: through 8 points of the lab's line it is within 0.02 mm.
3. **The prep finder with neighbouring preps.** It finds 9 of 24, and in a row of preps at most every second one. The
   bridges-out-of-the-box flow depends on it.
4. **The cement gap on real scans.** The max gap error is 0.014–0.046 mm (limit 0.01) on every real crown, where the
   synthetic case meets it. Either the intaglio needs another pass on noisy scans, or the limit needs to change for real
   scans. That's a decision.
5. **Front-tooth prep frames.** They flip on 8 of 18 upper anterior preps and on both veneers.
6. **Smaller items:**
   - 049's crowns self-intersect where the margin is 0.3–0.4 mm off.
   - A last molar gets a distal contact target.
   - The pontic needs scanned ridge under all of its rim (044, a segment scan).

## Where things live (all local, gitignored)

- **Inputs:** `data/exocad/manifest.json` (the margins and their scans), `data/exocad/scans/` (the OBJ scans as STL) and
  `data/exocad/golden/` (21 golden cases).
- **Scripts:** `data/exocad/scripts/`.
- **Outputs:** `out/exocad-eval*.json` (per-margin rows) and `out/exocad/` (runner metrics and crowns).
- **Re-run:**
  - `python3 data/exocad/scripts/intake.py` from `data/exocad/scripts`;
  - `pnpm --filter @dcad/pipeline-runner exec tsx <abs path>/evalExocad.mts [posterior|<case>]`;
  - `pnpm --filter @dcad/pipeline-runner exec tsx src/cli.ts --cases <abs>/data/exocad/golden --out <abs>/out/exocad`.
    `pnpm … run --cases` doesn't work: pnpm takes `--cases` as its own option.

## Implementation summary

- **Built:** no repo code. Local intake, evaluation and golden-case scripts, and the numbers above.
- **Deviations:**
  - The ask in `2026-10-27-inhouse-validation.md` (100 lab cases as plain STL) still stands. These cases cover its
    posterior-crown and bridge rows only in part, and they are demo cases from one vendor's scanners and models, not
    the lab's own.
  - The reference is exocad's stored margin, not a margin derived from a finished crown's inner edge.
- **Verification:** commands as above. 67 margins measured, 21 golden cases run (20 designed, 1 stopped). Tests
  unchanged (125); no code was touched.
- **Follow-ups:** the fixes above, each as its own spec, with these cases as the local regression set. A repo version of
  the intake (an exocad-folder reader beside the plain-STL intake of the in-house spec) once the licence question is
  settled.
