# Experiment S1: star unwrap from inside the tooth + circular DP (P2)

Experimenter S1, 2026-10-27. Branch `worktree-agent-a9bfaabf9a9ec707c` (commit `70cd38a`, on top of main `2da4146`).
Time box: 45 minutes. I went about 10 minutes over to finish the ablation run.

Every number below comes from one frozen run:
`out/natural-margin-research/bench-s1.md` (+ `.json`) in the main checkout, and the sector and confidence analysis
`out/natural-margin-research/s1-sectors.md` in this worktree. The run was 8 methods × 55 cases. Earlier tuning
iterations are in the worktree's `out/natural-margin-research/s1-iter*.md`.

## 1. What I built

- `tools/pipeline-runner/src/natural/s1/starUnwrap.ts`: the method (pure TS; uses `RayCaster`, `templateForTooth`,
  `smoothOnSurface`).
  1. **Centre C, from an inside probe.** Walk down the frame axis from the occlusal origin in 0.25 mm steps. At each
     step, cast 8 horizontal rays.
     - While all 8 hit the wall from inside (a back face within 0.75 × the template's largest size), re-centre on the
       midpoints of opposite hits. This follows a leaning tooth and an off-centre click.
     - The depth at which the buccal and lingual rays stop hitting from inside is taken as the gum level.
     - C sits 30% of that crown height above the gum level, at the probe centre for that depth. About 500 rays.
     - The proposal's rule (8 top-down rays beside the tooth) is kept as the `star-noprobe` ablation.
  2. **Ray grid.** From C, 240 azimuths × 140 elevations (+75° to −50°), traced with `ray.first`: 33.6k rays.
  3. **Unary per cell.** All weights are global constants.
     - **Depth jump** (w 0.6): the next lower ray lands more than 0.5 mm farther or misses, times the share of the rest
       of the column that stays far. On an open shell, seen from inside, the gum line is an occluding contour.
     - **Profile turn** (w 1.0): the concave turning angle of the column's 3D hit profile at arc lengths of 0.15 and
       0.4 mm, signed by the hit normal.
     - **Mesh concavity** (w 0.8): `surface.curvature` at the hit triangle.
     - **Height prior** (w 0.3): a ramp above gum level + 1.5 mm and below gum level − 1 mm.
     - **Neighbour side:** after the column's first jump, any hit more than 1.5 mm beyond that segment's end gets a
       neutral cost. This covers the neighbour tooth and gum seen from beneath far away.
  4. **Circular DP.** The transition cost is 0.6 per mm of 3D step between columns, with a wide ±40-step window (not
     the |Δφ| ≤ 3 cap). The loop is closed by trying the 5 best cells of the most distinctive column as start states.
  5. **Output.**
     - Bisect each chosen ray 4 times towards the silhouette (sub-step).
     - `smoothOnSurface` with a 0.4 mm window.
     - Per-column confidence: the unary gap to the best cell more than 0.5 mm away.
- `s1/method.ts`: the benchmark adapter. It also implements the click-jitter ablation: the click moves 1.5 mm in a
  direction hashed from the case name, is dropped onto the scan, and `estimateToothFrame` is re-run.
- `methods/star.ts` plus the ablations `star-jump`, `star-concave`, `star-cap3`, `star-coff`, `star-jitter`,
  `star-noref` and `star-noprobe`.
- `s1/analyze.ts`: the scoring-side analysis, which reads the truth (never inside a method).
  - Interproximal versus facial truth coverage and p95, using critique §2.6's definition (projection on
    `frame.mesial` beyond 0.6 × that side's extreme).
  - Spearman correlation of per-sector (30°) confidence against error.
- No labels, no generator constants, no per-FDI parameters. Typecheck is green. No real data or anything derived
  from it is in git.

## 2. Results (frozen config `star`)

| Set | Correct | Usable | Median mean mm | Median ms |
|---|---|---|---|---|
| bare | 2/8 | 6/8 | 0.11 | 290 |
| gum | 8/8 | 8/8 | 0.08 | 305 |
| gum+colour | 8/8 | 8/8 | 0.08 | 296 |
| hard | 6/8 | 8/8 | 0.10 | 311 |
| **synthetic total** | **24/32** | **30/32** | 0.10 | ~300 |
| **real (Teeth3DS+)** | **7/23** | **10/23** | **0.69** | 313 |

Baseline (refiner): 0/32 and 0/23.

- **Real, per jaw** (correct): 01F4JV8X 1/4, EA8SBGX4 1/4, DNSRP767 1/4, XKTTBEE0 1/4, V5U3CUGX 2/4, SZQ66Y5A 1/3.
  Upper 3/12, lower 4/11.
- **The bimodal shape.** Real cases that pass are very accurate (mean 0.08–0.15 mm). Those that fail have p95 of
  2–6 mm: one or two sectors of the line make an excursion. The method is never "a little off".
- **gum+colour** is identical to gum (colour is not used), so there are 24 distinct geometry cases.

## 3. The critic's claims (critique-1 §3, S1)

| Claim | Result | Verdict |
|---|---|---|
| Real ≥ 10/23 correct | 7/23 | **NOT MET** (the `star-cap3` ablation reaches 11/23, see §4) |
| Real usable ≥ 16/23 | 10/23 | **NOT MET** (cap3: 11/23) |
| Real median mean ≤ 0.25 mm | 0.69 | **NOT MET** (cap3: 0.42) |
| Synthetic ≥ 20/32 | 24/32 | **MET** |
| `hard` ≥ 4/8 | 6/8 | **MET** |
| Leaned teeth (31, 33, 13, 11 hard) ≥ 2/4 | 3/4 correct (13 is usable: p95 0.50) | **MET** |
| < 400 ms synthetic | ~300 ms median | **MET** |
| < 200 ms real | 313 ms (cap3: 115 ms) | **NOT MET** for the default; met by cap3 |
| C moved 1 mm: median changes ≤ 0.03 mm | Synthetic 0.10 → 0.10 (but `hard` 6 → 4 correct). Real 0.69 → 0.47, 7 → 6 correct | **NOT MET** on real. The median moves by 0.22 mm (for the better), which shows real-case instability. Met on synthetic |
| Click jitter ±1.5 mm on real: lose ≤ 2 cases | 7 → 7 correct (lost XKTTBEE0 33, gained DNSRP767 14); usable 10 → 11 | **MET** |
| Concavity-only vs depth-jump-only | jump-only 9/55, concave-only 18/55, both 31/55 | Concavity carries more, but **both cues are needed** (see §4) |
| Cap \|Δφ\| ≤ 3 vs 3D-step cost, on interproximal coverage | The cap is **better** overall (34/55 vs 31/55, real 11 vs 7) | **The critic's prediction is refuted.** But the cap loses canines and incisors (see §4) |
| 400 × 120 synthetic grid: lose ≤ 4 | not run (needs a bench option; out of time) | **NOT RUN** |

## 4. Ablations (all 55 cases, same frozen constants)

| Method | bare | gum | hard | real correct / usable / median mm | all | ms |
|---|---|---|---|---|---|---|
| **star** (all cues, window ±40) | 2/8 | 8/8 | 6/8 | 7 / 10 / 0.69 | 31/55 | 303 |
| star-jump (depth jump only) | 0/8 | 4/8 | 0/8 | 1 / 3 / 2.20 | 9/55 | 262 |
| star-concave (no depth jump) | 0/8 | 4/8 | 4/8 | 6 / 8 / 0.56 | 18/55 | 299 |
| star-cap3 (\|Δφ\| ≤ 3 steps) | 2/8 | 8/8 | 5/8 | **11 / 11 / 0.42** | **34/55** | **113** |
| star-coff (C moved 1 mm) | 2/8 | 8/8 | 4/8 | 6 / 10 / 0.47 | 28/55 | 304 |
| star-jitter (click ±1.5 mm) | 2/8 | 8/8 | 6/8 | 7 / 11 / 0.67 | 31/55 | 305 |
| star-noref (no bisection, no smoothing) | 2/8 | 8/8 | 5/8 | 7 / 9 / 0.72 | 30/55 | 297 |
| star-noprobe (proposal's top-down gum rule) | 2/8 | 8/8 | **1/8** | 4 / 7 / 0.85 | 23/55 | 319 |

What the ablations say:

- **Which cue does the work.**
  - The depth jump alone is poor: real 1/23.
    - On real upper jaws the buccal alveolar wall and the palate are steep. Rays below the margin hit the gum from
      beneath, close by, so there is no jump at the margin.
    - On synthetic `gum`/`hard`, the gum rises over the base, so the contour sits slightly off the crease.
  - Concavity alone is better (18/55), but on `bare` it is 0/8: one-ring curvature and the profile turn smear over
    the 0.8–1.7 mm tall wall triangles.
  - Together they make 31/55. The jump localises the line and the concavity picks the right jump.
- **The inside probe is the biggest single gain.**
  - The proposal's top-down gum rule collapses on `hard` (1/8): the off-centre click and the lean put its rays on the
    crown.
  - It also loses 3 real cases.
- **Cap versus wide window.** The two configs are complementary.
  - On real data the cap wins on molars and premolars: 01F4JV8X 16, EA8SBGX4 16, XKTTBEE0 36 and 34, V5U3CUGX 36 and
    34, DNSRP767 14 all go from no or usable to correct.
    - The wide window lets the line jump up to the top of a fused contact (the occlusal embrasure), 2–4 mm off.
    - The cap physically cannot make that jump.
  - The cap loses canines and incisors (01F4JV8X 13, V5U3CUGX 31, SZQ66Y5A 31, EA8SBGX4 13), where the papilla climb
    is steep. That part of the critic's argument holds.
  - Picking the better of the two per case (an oracle) would give **14/23** real. Choosing the window per tooth type
    would be per-FDI tuning, so I did not do it.
  - A principled fix, not tested: express the transition limit as rise per mm of arc, not in elevation steps, and add
    a penalty on the hit-distance discontinuity between columns.
- **Bisection and smoothing** add 1 synthetic case and 1 usable real case. They matter little.

## 5. Failure analysis

Interproximal versus facial (`s1-sectors.md`; truth coverage within 0.3 mm and truth-to-line p95):

| Set | Interproximal coverage (median) | Interproximal p95 (median) | Facial coverage (median) | Facial p95 (median) | Cases with interprox cov < 85% | Cases with facial cov < 85% |
|---|---|---|---|---|---|---|
| bare | 78% | 0.41 | 100% | 0.05 | 6/8 | 0/8 |
| gum | 100% | 0.19 | 100% | 0.17 | 0/8 | 0/8 |
| hard | 100% | 0.18 | 100% | 0.19 | 0/8 | 1/8 |
| real | 74% | **1.22** | 93% | 0.32 | 13/23 | 10/23 |

- **Synthetic `bare`** (2/8). Coverage stalls at 76–82% on every tooth except the molars.
  - Footprints touch at one point at gum level, and the truth there includes the tooth/tooth edges and their
    1.7 mm-tall wall triangles.
  - The line is right, but it cannot cover the truth points on the neighbour's foot.
  - This is a benchmark artefact more than a method failure: facial p95 is 0.05 mm.
- **Real interproximal is the main failure.**
  - Seen from inside a tooth with a fused contact, rays pass into the neighbour. The first depth jump is then at the
    contact top (the bottom of the occlusal embrasure), not at the papilla.
  - With the wide window, the DP follows it up on molars and premolars. Examples: 01F4JV8X 16 distal (interprox
    p95 2.8 mm, facial p95 0.20 mm) and DNSRP767 16 (interprox coverage 19%).
- **Real facial failures** are mostly on upper teeth (EA8SBGX4 14 and 16, DNSRP767 11, 01F4JV8X 11) and on lower
  molars (XKTTBEE0 36, SZQ66Y5A 36).
  - The gum is steep (buccal alveolar wall, palate, lingual of lower molars), so there is no depth jump at the margin.
    The concave turn competes with the cervical constriction and the gingival roll.
  - On upper central incisors, the probe's gum level was 13 mm deep. Below the margin, the horizontal rays keep
    hitting the labial gum from inside, so C sits too low.
- **Real canines** are the method's strength: 4/5 correct (01F4JV8X 13, DNSRP767 13, XKTTBEE0 33 and V5U3CUGX 33;
  EA8SBGX4 13 fails). Lower incisors: 2/3. Upper central incisors: 1/3. Molars: 0/6 (1 usable). Premolars: 0/6 (2 usable). With the cap, molars go to 4/6 and premolars to 3/6.
- **Click oracle.** The jitter ablation shows the method does not depend on the exact centre: the inside probe
  re-centres. The 1 mm C offset (applied after the probe, so not corrected) does hurt: `hard` −2, real −1.

## 6. Time per tooth

- **Measurements.** Median 300 ms on both synthetic (1M-triangle jaw) and real (Teeth3DS, ~100k–200k triangles), with
  the BVH and surface analysis prebuilt as in the app.
  - The run shared the CPU with the analysis job, so these figures are slightly high.
  - Rays dominate: 33.6k grid + ~500 probe + ~1k bisection.
  - With the ±40 window, the DP is 5 starts × 240 × 140 × 81 transitions. The cap3 config runs at 113 ms, which puts
    the DP at about 190 ms of the 300.
- **Earlier configs:**
  - The first version (360 × 200 rays, 2 passes) took 1.3–1.8 s.
  - 240 × 140 with one pass lost nothing on synthetic.
- **Cheap speed-ups, not done:**
  - prune DP transitions with a distance bound;
  - cast pass 2 only in an elevation band around a coarse pass.
  - 100–150 ms per tooth looks reachable with the wide window.

## 7. Does per-sector confidence predict error?

**Weakly.** Over 660 sectors (55 cases × 12 sectors of 30°):
- Spearman(confidence, error) = −0.36: lower confidence goes with higher error.
- 89 sectors have mean error > 0.3 mm. The lowest-20% confidence flag catches 56 of them (63% recall) at 42%
  precision.
- On a single real molar (01F4JV8X 16) it was −0.57, but the flag missed the distal excursion. There the wrong cell
  (the contact-top jump) is itself a confident depth jump.

As a "check this sector" hint in the UI it is usable. As a gate, it is not reliable enough.

## 8. What shipping it in the app's worker would take

- **Fit.** The method needs only `RayCaster`, the frame, the template size and `surface.curvature`, all of which the
  worker already has. Output: a closed ray-hit polyline (on the surface, sub-vertex), plus per-column confidence for
  the UI.
- **Cost.** About 100–300 ms per tooth in the worker, no network, $0.
- **Remaining work: about 3–5 days.**
  - 1–2 days: fix the interproximal failure (the cap/window issue, a distance-continuity transition term, and a
    contact-top rule).
  - 1 day: the probe's steep-gum failure on upper incisors.
  - 1 day: port into `apps/web/src/geometry` with one synthetic test, plus the `MarginTrace`/`loopVertices` mapping
    (`marginFromAnchors` with anchors every 1.5 mm).
  - 1 day: score on Teeth3DS test-split jaws (critique §2.8), since every parameter here was chosen while looking at
    these 23 training-split cases.

## 9. Honest recommendation

- **Synthetic.** S1 is strong: 24/32, gum and hard 14/16, leaned teeth 3/4, facial p95 ≈ 0.2 mm.
- **Real.** It is **not good enough alone**: 7/23 frozen, 11/23 with the cap. The critic's real bar (≥ 10/23) is met
  only by an ablation.
  - **In-sample caveat.** I tried 4 configs on the real set (probe on/off × two weight sets) before freezing.
- **The failure mode is clean and localised.** Facial sectors are right. Interproximal sectors at fused contacts and
  steep-gum sectors make 2–6 mm excursions.
- **Proposed role:**
  1. Keep S1 as the **facial-sector engine and the closed-loop scaffold**. It handles undercuts and leaned teeth by
     construction, and it does not depend on the click (jitter-proof).
  2. Combine it with a method that is good interproximally (S2's walker or neighbour seeds). Or use S1's
     low-confidence sectors to hand the interproximal arcs to the profile refiner (P10) or to the user.
  3. Make the cap-versus-window choice principled (a rise-per-mm limit), since the per-case oracle shows 14/23 is in
     reach.
- **Do not ship it alone as "one-click natural margin" on real scans yet.**
