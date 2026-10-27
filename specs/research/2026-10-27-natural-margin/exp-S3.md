# Experiment S3: valley ring DP (P1) + profile snake (P10), with the concave-snap and prior-only controls

Experimenter S3, 2026-10-27. Branch `worktree-agent-a86fa62512d2bd27e`, commit `d357ca1`, on top of main `2da4146`.
About 55 minutes of work (the time box was 45). Every number below comes from a run recorded in this folder.

## Headline

- **P1 (the valley ring DP) is the result.** It is today's radial-profile pipeline with the sign flipped, plus two fixes
  found on the real jaws.
  - **Real:** 11/23 correct, 16/23 usable, median mean 0.17 mm, 15 ms per tooth.
  - **Synthetic:** 16/32 correct, 21/32 usable, median 0.10 mm.
- **P10 (the profile snake) adds almost nothing on top of P1:** +1 real case (12/23), 0 synthetic cases, +50 ms per
  tooth. It ties the "most concave vertex" control on the benchmark (11/23). Its capture range is about 0.3 mm, not
  0.6 mm.
- **The prior-only control scores 0/55**, with a median of 1.46 mm on real and 1.77 mm on synthetic. Every number
  above clearly beats it.

## What I built

All files are under `tools/pipeline-runner/src/natural/`. Research code, no tests, no new dependencies, pure TS.

| File | What it does |
|---|---|
| `s3/valley.ts` | **P1.** `valleyProfiles(input)` and `valleyLine(input)`: 32 radial height profiles from the frame origin (rays along −occlusal). The concavity score is slope after − slope before over ±0.2 mm. Candidates are local concave peaks inside a radial and depth window. Then `ringDpAnchors` (reused unchanged from `marginRefine.ts`), `marginFromAnchors` with a valley weight, and `smoothOnSurface` (0.4 mm). |
| `s3/snake.ts` | **P10. The reusable refinement:** `refineLine(c: NaturalInput, points: V3[], options?: { mode?: 'regression' \| 'vertex'; passes?: number }): V3[]`. It reads only the mesh, so it runs on any method's line. Also exports `acrossFrames`, `section` and `regressionCandidates`. |
| `s3/prior.ts` | The prior-only control: the template's md × bl superellipse (exponent 2.5) at `frame.origin`, dropped onto the mesh along −occlusal. |
| `s3/geom.ts` | Vector helpers, `surfaceAt`, `curvatureAt`, and `valleyWeight`: concave cheap, with a floor of 0.25 (see "Deviations"). |
| `methods/valley.ts` | P1. |
| `methods/valley-snake.ts` | P1 + P10 (two passes). |
| `methods/valley-snapv.ts` | The control: P1, then the same snake with the regression replaced by "the most concave vertex on the section" (the same stations, sections, top 3 and DP). |
| `methods/prior.ts` | The prior-only control. |
| `methods/prior-snake.ts` | The snake on the prior line (an ablation: can the snake work from a crude start?). |
| `s3/capture.ts` | Capture-range harness. It perturbs `truthPolyline` by a 6-lobe offset across the line; the refinement itself reads only the mesh. |
| `s3/sectors.ts` | Interproximal vs facial/lingual sector scoring (harness, reads the truth). |
| `s3/diag.ts` | Per-profile dump of candidates vs truth (harness). |

**How P10 works**, in each pass:
1. Stations every 0.25 mm along the line.
2. A ±1 mm section at each station, 0.02 mm samples, rays along −n from 2 mm above. n is the bisector of radial and
   occlusal, made perpendicular to the tangent. a = t × n points toward the gum.
3. A continuous two-segment least-squares fit at every breakpoint (closed form with prefix sums). Candidates are the
   **local minima of the residual**. Strength = (atan k₂ − atan k₁) × (1 − RSS₂/RSS₁). Keep the top 3, plus a "stay"
   option.
4. A circular DP. Each station earns −min(strength, 1.2) and pays 0.25 per mm of offset from the start. Neighbouring
   stations pay 3 per mm of |Δs| + |Δh|.
5. `smoothOnSurface` (0.5 mm).

**Rules kept:**
- Parameters are global constants. None is set per FDI or per case.
- Methods never read labels or truth. Only `capture.ts`, `sectors.ts` and `diag.ts` do, as harnesses.
- No real data or anything derived from it is in the repo. All outputs are in `out/`, which is gitignored.

## Summary table (final run: `bench-s3.md` / `bench-s3.json`)

| Method | bare (8) | gum (8) | gum+colour (8) | hard (8) | Synthetic (32) correct / usable / median mm | Real (23) correct / usable / median mm | ms per tooth (real; synthetic) |
|---|---|---|---|---|---|---|---|
| **P1 valley** | 0 / 2 | 8 / 8 | 8 / 8 | 0 / 3 | **16 / 21 / 0.10** | **11 / 16 / 0.17** | 15; 27 |
| **P1 + P10** valley-snake | 0 / 2 | 8 / 8 | 8 / 8 | 0 / 3 | **16 / 21 / 0.09** | **12 / 16 / 0.18** | 67; 69 |
| Concave-snap control (valley-snapv) | 0 / 2 | 8 / 8 | 8 / 8 | 0 / 2 | 16 / 20 / 0.10 | 11 / 16 / 0.17 | 67; 72 |
| Prior-only control | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 / 1.77 | 0 / 0 / 1.46 | 1; 2 |
| Prior + P10 (ablation) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 / 1.40 | 0 / 0 / 1.44 | 58; 72 |
| Baseline refiner (`bench-refine*.md`) | 0 | 0 | 0 | 0 | 0 / 0 / 2.19 | 0 / 0 / 1.54 | ~300+ |

How to read the table:
- The variant columns are correct / usable.
- On the 4 leaned front teeth in `hard` (31, 33, 13, 11), every S3 method scores 0/4, with a median of 0.75–0.84 mm.
- `gum` and `gum+colour` are the same geometry (critique §2.2). S3 does not use colour. The distinct synthetic
  evidence is therefore 24 cases, not 32.

**Per jaw on real** (P1 / P1 + P10 correct):

| Jaw | P1 | P1 + P10 |
|---|---|---|
| 01F4JV8X (upper) | 1/4 | 1/4 |
| EA8SBGX4 (upper) | 1/4 | 1/4 |
| DNSRP767 (upper) | 2/4 | 2/4 |
| XKTTBEE0 (lower) | 2/4 | 3/4 |
| V5U3CUGX (lower) | 3/4 | 3/4 |
| SZQ66Y5A (lower) | 2/3 | 2/3 |

- Lower jaws: 7/11. Upper jaws: 4/12.
- Molars are 6/6 correct with P1+P10 (P1 alone: 5/6, XKTTBEE0 36 only usable). Lower premolars (34) are 3/3.

## Critic's claims (critique-1 §S3)

| Claim | Result | Verdict |
|---|---|---|
| Real: P1 ≥ 5/23 correct | 11/23 | **MET** |
| Real: P1 usable ≥ 12/23 | 16/23 | **MET** |
| Real: P1+P10 ≥ 10/23 correct | 12/23 | **MET** |
| Real: P1+P10 median mean ≤ 0.25 mm | 0.18 mm | **MET** |
| P10 adds under 200 ms | +52 ms on real (67 vs 15), +42 ms on synthetic | **MET** |
| Synthetic: P1 ≥ 10/32 | 16/32 | **MET** |
| Synthetic: leaned teeth ≤ 1/4 (the predicted undercut failure) | 0/4 | **MET** (the failure happens as predicted) |
| Synthetic: P1+P10 ≥ 18/32 | 16/32 | **NOT MET** |
| Capture range: from 0.6 mm, mean ≤ 0.1 mm on ≥ 75% of the cases in each set | synthetic 5/32, real 0/23 | **NOT MET** |
| P10 must beat the "most concave vertex" snap by ≥ 3 real cases | 12 vs 11 (+1) | **NOT MET**: on this benchmark the regression is mostly decoration |
| P10's gain at 400 × 120 ≥ its gain at 1000 × 500 | not run | **NOT RUN** (time) |
| Click jitter ±1.5 mm on real | not run | **NOT RUN** (time). This is the first thing to run next: P1 starts its profiles from `frame.origin`. |
| Prior-only control: a method must clearly beat it on hard and on real | P1 hard median 0.47 vs prior 2.01 mm; real 11/23 vs 0/23 (median 0.17 vs 1.46) | **MET** |

**Critic predictions (§4) falsified by S3:**
- "P1 alone ≤ 12/32 synthetic and ≤ 4/23 real": it scored 16/32 and 11/23.
- "Large gain from P10 on synthetic (+6)": it gained 0.
- "Real ranking S2 ≈ S4 > S1 > S3": we'll see. S3 is at 11–12/23.

**Confirmed:**
- "On synthetic the regression ties most-concave-vertex."
- The leaned-tooth failure.

## Capture range (oracle-initialised, apart from the method scores)

Logs: `capture-s3-regression.txt` and `capture-s3-vertex.txt`. Start line: `truthPolyline` plus δ·sin(6θ) across
the line, put back on the scan. Two passes. The table gives the median mean (mm), start → end, and the share of cases
ending at ≤ 0.1 mm.

| δ | Synthetic, regression | Synthetic, vertex snap | Real, regression | Real, vertex snap |
|---|---|---|---|---|
| 0.3 mm | 0.150 → **0.082** (29/32) | 0.150 → 0.108 (12/32) | 0.152 → 0.125 (2/23) | 0.152 → 0.135 (0/23) |
| 0.6 mm | 0.273 → 0.130 (5/32) | 0.273 → 0.231 (0/32) | 0.288 → 0.193 (0/23) | 0.288 → 0.266 (0/23) |
| 1.0 mm | 0.446 → 0.346 (0/32) | 0.446 → 0.401 (0/32) | 0.480 → 0.385 (0/23) | 0.480 → 0.444 (0/23) |

What this shows:
- **The regression is a better refiner than the vertex snap at every offset.**
  - At 0.6 mm it roughly halves the error (0.27 → 0.13 synthetic, 0.29 → 0.19 real), where the snap barely moves the
    line.
  - This is where the regression earns its keep: pulling an off-line start onto the crease.
  - On the benchmark it doesn't matter, because P1 already starts on the crease. P1's error is a few sectors that are
    1–3 mm off, outside any snake's reach.
- **The capture range is about 0.3 mm with two passes.** From 0.6 mm the line moves most of the way but not all.
- The real ≤ 0.1 mm bar is below the label noise (about 0.2 mm, critique §2.9). Real end means of 0.12–0.19 mm sit at
  that floor.
- **Untested knobs:** more passes, a smaller pull weight (W_PULL 0.25) and wider sections (±1 mm) would probably widen
  the range. I didn't tune them.
- **Bug found and fixed on the way.** Choosing the breakpoint by the *largest turn* (my first version) puts it at the
  section ends: the continuity constraint lets the short end segment bend freely. That version made lines worse, from
  0.15 to 0.4–0.65 mm. The breakpoint must be the residual minimum.

## Failure analysis

**Sectors** (`sectors-s3.txt`, final code). Interproximal means truth points beyond 0.6 × the mesial extreme on their
side.

| Method | Set | Interproximal p95 / coverage | Facial/lingual p95 / coverage |
|---|---|---|---|
| P1 | synthetic | 0.35 / 100% | 0.11 / 100% |
| P1 | hard | 0.74 / 82% | 1.06 / 74% |
| P1 | real | 0.32 / 93% | 0.32 / 94% |
| P1 + P10 | real | 0.32 / 94% | 0.36 / 90% |

- **On real teeth the interproximal sectors are not the weak spot.**
  - Profiles toward a neighbour stop at the rise (`stop=neighbour`) right at the crease. The truth also climbs to the
    contact (critique §2.10), and the profile follows it.
  - The failures are **facial/lingual excursions of 1–3 mm**, all on **upper front teeth and premolars**:
    - 01F4JV8X 14, 13, 11;
    - EA8SBGX4 13;
    - DNSRP767 11;
    - plus the lower canines and incisors XKTTBEE0 33 and SZQ66Y5A 31.
  - That is the cervical-undercut failure. A top-down ray cannot see the margin under the labial bulge of a leaning
    incisor or canine, so the anchor lands on the gum beside it.
  - 01F4JV8X 11 is the extreme case: the line is 25.7 mm against a 43.7 mm truth, with 40% coverage.
- **The two real-data fixes that took P1 from 5/23 to 11/23** (round 1 `bench-s3-r1.md` → final `bench-s3.md`):
  1. **The proposal's "below 40% of the profile's drop" rule removes the crease on deep profiles.** A lower molar's
     lingual profile drops about 8 mm to the floor of the mouth, so a crease at 2.9 mm is excluded. Replaced by a
     radial window: r ≥ 0.55 × the template ellipse radius at that angle, and a drop of at least 0.3 mm.
  2. **Past a cervical undercut, top-down rays fall 12–14 mm onto the tissue below.** That cliff scores a concavity of
     about 36 against the real crease's 1–8. Through the relative floor (max/3) it also deletes the real crease, so the
     DP has no choice. Fix: drop ≤ the template crown height + 1.5 mm, and a floor of max/4 among the allowed samples
     only.
     - This was the cause of the 8–12 mm p95 excursions (diagnosed with `s3/diag.ts`).
     - Flooring the valley live-wire at 0.25 had almost no effect on its own (`bench-s3-floor.md`). I kept it because
       a 50× crease discount invites detours.
- **`bare` 0/8.** On the bare variant the gum band is narrow and some sections lose the gum side (no ray hits). Errors
  sit at 0.1–0.38 mm mean with p95 of 0.4–1.9 mm, mostly at the papilla-free junction points. Not investigated
  further. It is the least realistic variant.
- **`hard` 0/8.** The leaned 31, 33, 13 and 11 are 0.47–0.91 mm, the undercut again. The upright 36, 45, 16 and 14 are
  0.13–0.22 mm with p95 of 0.48–0.77 mm: the p95 fails, at the higher papillae.

## Time per tooth

| Stage | Real (~0.2 mm mesh) | Synthetic (demo grid) |
|---|---|---|
| P1 | 15 ms (median) | 27 ms |
| P10, two passes | +50 ms | +40–70 ms |
| Prior | 1–2 ms | 1–2 ms |

Node 22 on the dev Mac. The case setup (BVH, curvature) is shared and not counted.

## What shipping it in the app would take

- **P1 is closest to today's code** (about 1.5–2 days including tests and spec):
  - a `concave` mode for `proposeMarginAnchors` (or a sibling `proposeGumAnchors`) with the radial and depth windows,
    and `withCandidates`;
  - a sign and floor option on `liveWireWeight`;
  - reuse `ringDpAnchors`, `marginFromAnchors` and `smoothOnSurface` unchanged.
  - It runs in the margin worker in about 15–30 ms. The natural-tooth branch of one-click calls it instead of
    `refineMargin`.
  - Tests: one passing case (synthetic `gum`) and one failing case (a crease-free dome, so that a stub answering
    "none" fails). That is 2 tests, within budget.
- **The P10 snake** (1–2 days more):
  - port `s3/snake.ts` as `geometry/marginSnake.ts`;
  - use it as the "magnetic" snap for a dragged or redrawn segment, where its 0.3–0.6 mm capture range is exactly the
    use case;
  - not as an always-on pass after P1.
- **Before shipping either:**
  - run the ±1.5 mm click-jitter ablation on real cases;
  - score 4–6 Teeth3DS test-split jaws once, with the parameters frozen as committed;
  - add a confidence flag for undercut sectors: a profile whose ray drops more than the crown height marks that sector
    for the human.

## Recommendation

- **Ship P1 (valley ring DP) as the natural-tooth one-click.**
  - It is cheap (15 ms, $0, about 2 days, almost all reuse), and it is right on 11/23 real teeth and usable on 16/23
    as they stand.
  - Molars and premolars are mostly right: 9/9 real molar and lower premolar cases are correct with P1+P10.
  - The known failure is visible and local: labial and lingual undercuts on front teeth.
- **Pair it with a human-fix flow** (the UX track's concave-cheap live-wire redraw, or the snake as a magnet). Do not
  expect P10 to fix P1's misses: they are 1–3 mm off, outside its capture range.
- **For front teeth, P1 needs a non-top-down view.** S1's star rays from inside the tooth, or casting the profiles
  along the tooth's own axis, would answer the undercut directly. That is the next experiment, not more snake tuning.
- **Keep P10 as the shared refiner and the magnetic snap. Don't sell it as accuracy.**
  - On this benchmark it is within 1 case of a trivial concave-vertex snap.
  - Its real value shows only in the capture study: it halves a 0.6 mm offset, and the snap doesn't.
- **Caveats:**
  - Parameters were adjusted twice after looking at real cases: the radial window and the depth cap. Both are generic
    geometric rules, not per-FDI or per-case rules. Still, the 23 real cases are now in-sample. A frozen test-split
    run is required before any claim.
  - Margins of 1–2 cases are noise.

## Output files (all in `out/natural-margin-research/` in the worktree)

- `bench-s3.md` / `bench-s3.json`: final run (all five methods).
- `bench-s3-r1.md` / `.json`: round 1 (40% drop rule, max-turn breakpoint, live-wire floor 0.02).
- `bench-s3-floor.md` / `.json`: round 3 (live-wire floor only).
- `capture-s3-regression.txt` and `capture-s3-vertex.txt`: the capture-range study.
- `sectors-s3.txt`: sector analysis on the final code.
