# Validation on in-house scans

Status: **proposed** (2026-10-27): waiting for the scans. See "The ask" below.

## Goal

Measure dcad on real lab cases, where it matters most and where nothing has been measured yet: prepped teeth on real
intraoral scans. Then fix what the numbers show, and keep the cases as local regression cases.

Every accuracy number so far comes from one of two sources:
- **Synthetic jaws** (`apps/web/src/geometry/synthetic.ts`): the prep finder, auto frames, the finish-line margin, the
  refiner (16/17 correct, `2026-10-26-margin-ai.md`), one-click and the crown checks.
- **Teeth3DS** (`2026-10-27-natural-margin-research.md`): natural teeth only. It has no preps, and its licence (CC
  BY-NC-ND) allows local evaluation only. The gum-line margin is 22/24 correct on held-out real teeth.

Real preps have things the generator doesn't model:
- retraction cord;
- gum lying over the margin;
- blood and saliva;
- scanner noise and holes;
- subgingival margins;
- real contacts and old restorations next to the prep.

`specs/plan.md` assumed about 100 in-house cases, and the plan's data flywheel backfills them into training bundles.
None have come in yet.

## The ask (from Rishabh, in plain English)

Written to send as is to whoever exports the scans.

> **What I need: 100 finished cases, as plain STL files**
>
> I'm testing our crown design software on real cases. I need 100 cases the lab has already finished, exported as
> plain STL files. The software never needs to know who the patient was.
>
> **For each case, please send one folder named `case-001`, `case-002`, and so on, containing:**
> 1. **The upper jaw scan** as one STL file.
> 2. **The lower jaw scan** as one STL file.
>    - Export both jaws together, so they keep their bite position (how the teeth meet).
>    - Full-arch scans are best. If only half the jaw was scanned, that's fine: send what you have.
> 3. **The finished design** as STL: the crown, bridge or implant crown exactly as it was sent for milling or printing.
>    Use the same position as the scans; don't move it.
> 4. **If you have it, the scan from before the tooth was prepared** (the "pre-op" scan), as STL.
> 5. **If your design software can export the margin line**, include that file too. If you're not sure how, skip it:
>    the finished design is enough.
>
> **And one spreadsheet for all the cases**, one row per case:
> - the case folder name (`case-001`);
> - which tooth or teeth were prepared (tooth numbers like 36, or in words like "lower left first molar");
> - what was made: crown, bridge, implant crown, inlay or onlay, or veneer;
> - the material: zirconia, lithium disilicate (e.max), metal-ceramic, and so on;
> - the scanner used (for example iTero, Medit, 3Shape TRIOS, Primescan);
> - anything unusual: margin under the gum, bleeding, a retake, a remake.
>
> **The mix of 100 I'm hoping for** (roughly; send what you have):
>
> | How many | What |
> |---|---|
> | 60 | Single crowns on back teeth (molars and premolars) |
> | 10 | Single crowns on front teeth |
> | 10 | 3-unit bridges |
> | 10 | Implant crowns, with the scan body in the scan |
> | 10 | Anything else: inlays, onlays, veneers, Maryland bridges |
>
> More than one scanner brand is a plus. Include a few difficult cases, not only the clean ones.
>
> **Please don't include anything that identifies the patient:**
> - no names, initials, dates of birth, chart numbers or clinic names in file or folder names;
> - no project files from the design software (exocad, 3Shape and similar). They contain the patient's details. Plain
>   STL only;
> - no photos, lab slips, prescriptions or X-rays;
> - some scanners write the patient's name inside the STL file itself. I'll check every file and blank that out, but
>   if your export has an option to leave the name out, please use it.
>
> **Please also confirm** that we have permission to use these scans for testing our software.
>
> **When:** the first 10 cases as soon as you can, so I can check the format works. Then the other 90.
>
> **How to send:** zip the folders and share them through our private shared drive, or hand them over on a USB stick.
> Please don't email patient scans.
>
> The scans stay on our machines. They're never uploaded to any outside service and never shared, and I'll delete
> them whenever you ask.
>
> Thank you!
> Rishabh

## Scope

**In:**
1. **Intake.** Check and de-identify each case, and convert it into the golden-case layout the pipeline runner
   already reads (`tools/pipeline-runner/src/golden.ts`).
2. **Reference lines from the lab's design.** The lab's margin comes from the finished crown's inner edge, or from an
   exported margin file when there is one.
3. **A headless runner over every case**, with a per-case report and one summary.
4. **The numbers in this spec, and a ranked list of fixes.** Fixes are follow-up specs, each with its own tests.
5. **The cases as local regression cases:** `pnpm --filter @dcad/pipeline-runner run --cases data/inhouse`.

**Out:**
- Training or fine-tuning models on the cases. That's the plan's later step and needs its own consent and spec.
- Sending any case, or anything derived from one, to an outside service. That includes LLM APIs: the runner uses the
  mock adapter only.
- Committing any case, mesh, margin line or per-case result. Only aggregate numbers go into git.
- UI changes.
- A study across scanner brands beyond whatever arrives.

## Design

### Data handling
- **Location:** cases live in `data/inhouse/<case-id>/`. `data/` is gitignored, and so is `out/`, where reports go. No
  symlinks.
- **Sources stay as received:** `data/inhouse/raw/` keeps the files exactly as they came, and intake writes cleaned
  copies next to them. Deleting a case means removing both.
- **Outside services:** none. The runner runs locally; LLM adapters are off (mock) and so are model calls.
- **What gets committed:** only aggregate numbers (counts, means, percentiles) in this spec. Per-case tables stay in
  `out/inhouse/`.

### Intake (`tools/pipeline-runner/src/inhouse/intake.ts`, new)
For each case folder, intake checks:
- **Each file parses** as STL (binary or ASCII), or PLY (the app already reads both; see
  `apps/web/src/geometry/processScan.ts`).
- **Plausible millimetres:** the arch width is 30–80 mm, which catches files exported in metres or inches.
- **The two jaws face each other in their bite:** the antagonist lies 0–3 mm from the prep jaw across the occlusal
  plane.
- **The design sits on the prep:** the inner surface of the crown is within 0.3 mm of the prep scan. Otherwise the
  design was moved, or exported in another coordinate frame.
- **Nothing identifying in the files** (de-identification): the binary STL header, the ASCII `solid <name>` line, PLY
  comments, and file and folder names.
  - A known scanner string ("iTero", "Medit", "TRIOS", …) or "dcad" is kept; anything else is blanked in the cleaned
    copy and listed.
  - A name-like string in a file or folder name stops the case until it is renamed.

Intake writes `case.json`, the existing `GoldenCase` with an `inhouse` block:
- the scanner;
- the restoration;
- the material;
- the reference lines;
- the source of each reference (`design-rim` or `margin-file`).

### Reference lines
- **The margin, from the finished design's inner edge.** The crown's inner surface is the part lying on the prep
  scan, within the cement gap plus 0.1 mm. Its boundary loop is the lab's margin, projected onto the scan. When an
  exported margin file is present, it is used instead, and the two are compared on the cases that have both.
- **The axis:** the lab's insertion axis isn't in the STL. Instead, the runner reports the undercut that dcad's axis
  leaves on the prep, and the lab design's own undercut along that axis.
- **Natural teeth:** there are no labels, so gum lines are scored by the gate and the doubt warning only, not by
  deviation. The pre-op scans, when sent, give natural-tooth cases on the very teeth that were later prepped.

### Runner (`tools/pipeline-runner/src/inhouse/run.ts`, new; reuses `pipeline.ts`)
The flow per case, headless, as the browser runs it:
- the prep finder on both jaws;
- auto frames;
- the automatic margin, finish line or gum line;
- the doubt test;
- the common axis;
- one-click auto-design;
- the crown checks.

Each case writes `out/inhouse/<case-id>/metrics.json`, and the run writes `out/inhouse/report.md`.

### Measures and the bars to start from (revised after the first 10 cases)

| Area | Measure | Starting bar |
|---|---|---|
| Prep finder | Listed preps found | ≥ 95% |
| Prep finder | False preps (a ring on a tooth not listed) | ≤ 1 per 10 scans |
| Auto frame | Origin to the centre of the lab margin; occlusal direction | ≤ 1 mm; ≤ 10° |
| Margin (finish line) | Mean distance to the lab's margin | ≤ 0.10 mm |
| Margin (finish line) | Share of the line within 0.2 mm of it | ≥ 90% |
| Margin | Gate passes when the line is right; fails when it is > 0.2 mm off anywhere | ≥ 90%; ≥ 80% |
| Doubt warning | Recall and precision on lines > 0.2 mm off | ≥ 80%; ≥ 80% |
| Axis | Undercut left on the prep along dcad's axis | ≤ the lab design's |
| One-click | Cases that reach a draft with every check passed | report, no bar yet |
| Crown | Printable; thick enough; fit (gap check) | 100%; 100%; as in the golden case |
| Time | One-click per crown, on the dev machine | ≤ 10 s |

Technicians differ from each other by about 0.05–0.1 mm on a margin, so a mean much below 0.05 mm is not a
meaningful target.

### Phases
0. **Before the scans** (about a day):
   - build intake, the reference rim and the runner;
   - check them on a synthetic stand-in in the in-house layout: the synthetic jaws, the synthetic crown STL as "the
     lab's design", and a header carrying a fake name.

   That way the first real cases run the same day they arrive.
1. **The first 10 cases:**
   - fix intake problems (formats, units, coordinate frames);
   - sanity-check the reference rim by eye on each case;
   - revise the bars.
2. **All 100:**
   - the full report;
   - the summary numbers in this spec;
   - the fixes ranked by how many cases they affect.
3. **Regression:** the cases become golden cases (local only), run before a release.

## Verification plan
- **Tests** (+2, in `tools/pipeline-runner`):
  - **Intake on the synthetic stand-in:** a header with a name is blanked and listed, and a clean header is kept. A
    case in metres is refused. That's one passing and one failing case per check.
  - **The reference margin from the synthetic crown:** it matches the analytic margin within 0.05 mm.
- **The stand-in through the runner:** the report is written, and its numbers match the synthetic golden case's.
- `pnpm typecheck`, `pnpm test`.
- **With the scans:** the counts per phase, every measure in the table above, and the time per case, recorded in the
  implementation summary. Aggregate numbers only.
