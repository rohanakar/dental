# Critique, round 1: natural-tooth margin proposals

Critic, 2026-10-27. Inputs: `proposals.md` (written before the benchmark was fixed), `scout.md`,
`tools/pipeline-runner/src/natural/bench.ts` at 6b136e8 (32 synthetic cases plus 23 real Teeth3DS+ cases), and the
baselines `bench-refine.md` (0/32, median 2.19 mm) and `bench-refine-real.md` (0/23, median 1.54 mm).
Per the lead, **real results outrank synthetic ones**. A method that wins on synthetic and loses on real has lost.

## 0. Which of the proposer's benchmark caveats still apply

| Caveat (proposals.md §2) | Status at 6b136e8 |
|---|---|
| Tall wall triangles (0.8–1.7 mm); never use mixed-edge midpoints | **Still applies, and it cuts both ways.** The truth now uses the gum-side vertices (fixed). But any method that interpolates an isoline along a crossing edge (P3, P5, P6, P11, P12) lands partway up a 0.8–1.7 mm wall edge, so up to 0.4–0.8 mm off on synthetic. On real scans (0.21 mm edges) the same bias is ≤ 0.1 mm. Isoline methods must report both the raw isoline and a snap to the more concave endpoint. |
| Colour is a height ramp | **Obsolete for gum+colour, and now the opposite problem.** With `gingiva` set, every gum vertex is pink (205,118,124) and every tooth vertex ivory, registered *exactly* to the labels (`synthetic.ts` 316–320). After a one-ring blur and noise of σ ≈ 8, the G-channel contrast at the line is about 86 levels (~10σ). Colour is an **oracle** here, apart from the tooth-side stained band. The `bare` variant has no colour. |
| No contacts, no papillae | Papillae now exist: Gaussian bumps of 1.8 or 2.6 mm, σ = 1.6 mm along the arch. **There are still no contacts.** The real set has fused contacts. |
| Pure height fields unless lean | **Still applies to 28 of 32 cases.** Only the 4 leaned front teeth in `hard` (31, 33, 13, 11) have an undercut. See §2.1. |
| 1-ring curvature looks perfect | Partly. Taubin 4 or 8 at 0.024 × 0.08 mm spacing blurs the crease by only ~0.1–0.2 mm. Real creases blur over 0.2–0.5 mm. |

## 1. Objections, proposal by proposal

**P1 Valley ring DP.** Radial *height* profiles are top-down. On real teeth the gingival margin sits below the
height of contour on most teeth, not only on leaned incisors, so anchors land on the gum beside the bulge. Profiles
toward a neighbour climb the papilla and stop at `riseStopMm`, so the line cuts the papilla tips. The 10%
coverage slack (§2.6) hides that. Keep it only as the cheap baseline.

**P2 Star unwrap + circular DP.** Three hidden problems:
- C is set from the buccal/lingual gum level, but papillae rise 1.8–2.6 mm above that level (and more on real
  anteriors). The tip sectors therefore sit at high elevations, where rays graze the wall.
- The hard cap |Δφ| ≤ 3 steps cannot follow a papilla climb. A climb of 2.6 mm over ~1.5 mm of arch at r ≈ 4 mm
  needs ~0.13 mm of rise per 1° of azimuth. Three steps of 0.58° at 4 mm allow 0.12 mm. Use a 3D-step cost
  instead of the cap.
- For an open shell (the synthetic and real scans alike), a ray from inside the tooth that passes below the margin
  travels through tissue. It hits the gum from beneath far away, or hits nothing. The margin is therefore a
  **depth jump**, not a crease, and the unary must model that. A scan hole at the sulcus produces the same jump.
  At fused contacts, rays pass into the neighbour.

**P3 Harmonic field / random walker.** On synthetic, the potential drop concentrates on the crease vertex's edges,
so u = 0.5 falls partway up a tall wall edge (see §0); it needs the endpoint snap. On real scans, where the crease
is weak (the col, rolled or inflamed gingiva), the 0.5 level follows the seed geometry and not the crease. The test
is whether β = 0 or a different isovalue moves the line. Note that a K-label walker (P13) gives the target the
*same* harmonic probability as a 2-label walker with the neighbour seeds counted as "other". Only the threshold
changes (argmax instead of 0.5), so P13 is P3 plus a threshold rule.

**P4 Watershed.** It has no smoothness term, so one gap in the crease leaks it. On real scans that gap exists:
a sulcus hole, the papilla col, a fused contact. Its vertex-quantised boundary happens to flatter the synthetic
truth (gum-side vertices). Use it as P3's same-seed ablation only.

**P5 Mesh GrabCut.** Hidden complexity: BK max-flow, GMM EM and multi-scale features will not fit in 45 minutes.
Without colour, GMMs on geometric features collapse. With synthetic colour, it is perfect for the wrong reason.
The scout's MIT workbench already *is* the crease-aware graph cut (§3, S4), so measure that instead of writing one.

**P6 Colour likelihood.** It is an oracle on this benchmark (§0) and has only 8 synthetic cases. **There is no real
colour data:** Teeth3DS is constant grey, and the scout found no public dataset with colour and labels. So it cannot
be validated today, and STL files never carry colour. The cue is real and cheap (Medit's patent uses colour plus
curvature), but a number from this benchmark would not change a decision. Test it only as a misregistered-colour
ablation term (S2).

**P7 Height-map top-hat.** *Wrong-headed for real scans.* A top-down map cannot see a margin that sits under the
height of contour, and the opening erodes papillae. It will score well on the 28 synthetic cases that have no
undercut, which is the reason not to build it.

**P8 Multi-view SAM.** It cannot be validated here: synthetic renders are not photographs, and real cases have no
colour. Mask edges are soft by 2–4 px (≈ 0.1–0.15 mm), which is the whole error budget. It costs 0.5–3 s per tooth
plus a 10–40 MB download, and the mask granularity is fragile on molars. If a learned route is wanted later, the
scout's FiboSeg-style 2D U-Net is the better browser shape. Revisit with licensed data.

**P9 Library fit + loop transfer.** Partly circular on synthetic. The template sizes are close to the generator's
(the upper central's md is 8.5 in both), and on a wall that is vertical at its foot the xy footprint is nearly the
whole answer. The cervical loop is planar and contributes nothing in z, where the line scallops 1.8–2.6 mm. On
real scans, ICP to a superellipse drifts on worn or rotated teeth. Use it as the **prior-only control** (§2.7),
not as a method.

**P10 Profile snake (two-segment regression).** The two-segment model fits the synthetic exactly: a vertical wall
plus the gum slope. A real cross-section runs wall → sulcus → convex rolled free gingiva → attached gingiva, which
is three or four segments, and the best two-segment breakpoint can land on the gingival crest. Its capture range
(probably ≤ 0.5 mm) means it cannot rescue a line that sits on the wrong valley. Cross-sections are ill-posed at the
papilla tip. It is still the best shared stage.

**P11 Synthetic-trained classifier.** *Wrong-headed now.* It learns the generator: height above the cover shelf
separates the classes. Holding out tooth types does not help, because the 8 synthetic teeth are 5 shapes (types
0, 2, 3, 4, 5) mirrored between jaws. Teeth3DS could train it, but its NC-ND licence forbids shipping the result.

**P12 Learned segmentation.** Licence: Teeth3DS is CC BY-NC-ND 4.0 (scout verified). The winning checkpoints have no
licence file (TGNet, CrossTooth) or were trained on NC-ND data (FiboSeg), so none can ship. The challenge metrics
(TSA, TLA) are not boundary distances in mm. It would take 4–8 weeks plus in-house labels. That flywheel is the
real path, but none of it is testable today.

**P13 Arch-level joint segmentation.** By the P3 note above it is P3 plus a threshold rule. Its real benefit (fused
contacts) is now measurable on the real set, so test it as **P3's neighbour-seed ablation**, not as a separate
build.

**P14 Consensus.** Agreement is not correctness. P1, P2, P3 and P10 all key on the same concave cue, so they fail
together (fissure rings, soft creases, sulcus holes). The only independent cue is colour, and no real case has it.
Defer it until two members pass on real cases.

**P15 HITL kit.** This is probably the actual go-to-market: every competitor ships auto-detect plus a cross-section
bubble, a global ± offset, "re-detect from here" and a magnetic draw. But the oracle editor places seeds *at the true
point*, and it picks the worst sector *from the labels*. A technician clicks with 0.1–0.2 mm of scatter and needs
the confidence map to find the sector. The UX agent should add click noise and pick sectors by confidence.

**Moonshot (intersect a tooth model with a gum model).** The synthetic *is* exactly this, `z = gum + max(cover,
tooth)`, so a synthetic win means nothing. Real-only.

**Spillover: "the gum line as a barrier" for preps.** It must be a soft prior, never a hard barrier. A
subgingival finish line sits *below* the gum line by definition, and a barrier would delete the right answer.

## 2. Benchmark weaknesses that would flatter a method

Synthetic:
1. **No undercut on 28 of 32 cases.** `z = H·√(1 − r⁴)` is widest at the foot, so every top-down method sees the
   whole margin. Real teeth bulge above the margin. Report the 4 leaned `hard` teeth separately.
2. **Duplicated and correlated cases.**
   - For a geometry-only method, `gum` and `gum+colour` are the same 8 meshes (same noise seed, identical
     baseline rows). There are 24 distinct geometry cases, not 32.
   - Upper and lower use the same 5 tooth shapes, mirrored.
   - Treat a difference of 1–2 cases as noise.
3. **Colour is label-registered** (§0). A colour-on score without a misregistration test proves nothing.
4. **Resolution and noise.**
   - The grid is 0.024 × 0.08 mm, against a 0.21 mm mean edge on Teeth3DS.
   - The wall triangles are anisotropic and tall, which penalises isolines and flatters vertex snapping.
   - The noise is i.i.d. along the normal, so any smoothing removes it. Real noise is spatially correlated
     (stitching ripples), and it makes false creases.
   - Ablation: rebuild at 400 × 120 (≈ 0.2 × 0.1 mm).
5. **Missing pathology.** No contacts. The papillae are smooth Gaussians, not a pyramid with a col. No recession or
   exposed CEJ (a second concave crease and colour edge 1–3 mm apical), no calculus ledge, no sulcus holes, no blood.
6. **Scoring slack.**
   - `coverage ≥ 0.9` lets a line skip ~10% of the truth, which is about the length of the papilla tips, the
     hardest part.
   - `max` is not gated.
   - The mean is one-sided (line to truth).
   - Every experimenter must also report **interproximal-sector coverage and p95**: truth points whose projection
     on `frame.mesial` exceeds 0.6 × that projection's extreme on their own side.
7. **The size prior is near the generator.** Every report needs a **prior-only control**: the template's md × bl
   superellipse at the frame origin, dropped onto the mesh. A method must clearly beat it on `hard` and on real
   cases.

Real (Teeth3DS+, 23 cases):
8. **Small, correlated, in-sample.** 6 jaws, all from the Teeth3DS *training* split, and 23 teeth that are
   correlated within a jaw. The effective n is about 6–12. Report results per jaw.
   - Freeze all parameters before round 2. Then range-fetch 4–6 *test-split* jaws (the scout says this is cheap)
     and score them once.
9. **Label noise at the threshold.**
   - The labels were drawn as 2D polygons on a UV flattening, so they are good to about one edge (~0.2 mm), and
     the 0.25 mm "correct" bar is at that noise floor.
   - A mean difference under ~0.05 mm between methods is not significant.
10. **The real truth includes tooth/tooth edges.**
    - `boundaryPoints` counts any edge to a non-target label. At a fused contact the truth therefore climbs the
      interproximal valley to the contact, and its "gum-side" vertex is the neighbour's.
    - A method that draws the clinical gingival line (papilla to col) is marked wrong there.
    - The product must choose which line it needs: the outline for segmentation and eggshell crowns, or the
      papilla line. Report the interproximal sectors separately.
11. **Cleaner than raw exports.** Teeth3DS meshes are cleaned and remeshed (uniform 0.21 mm edges, few holes, no
    tissue tags, no colour). Raw IOS exports have sulcus holes, flaps and stitching seams.
12. **The click is an oracle.** It is the label centroid dropped from above, with no offset on real cases, so C,
    seeds and windows get an exact centre for free. Every method must run a **±1.5 mm click-jitter ablation on
    real cases**.

**What would not convince me:**
- A synthetic total carried by `bare` and `gum` while real ≤ 8/23.
- Colour wins without the misregistration test.
- Parameters tuned per FDI, or on the 23 real cases, without a frozen hold-out.
- An aggregate mean that hides interproximal p95 > 0.6 mm on real cases.
- A P10 capture range measured only from oracle-perturbed truth.
- Results that collapse under the click jitter or at 400 × 120.
- Any use of generator constants (`TOOTH_WIDTHS`, `BL_HALF`, `gumHeight`, junction positions).
- Margins of 1–2 cases.

## 3. Shortlist: four approaches to build in parallel now

Diversity:
- S1: rays plus a polar DP.
- S2: a diffusion field.
- S3: a cheap profile baseline plus the shared refiner.
- S4: an external training-free graph cut. This is the fastest-GTM test, and it calibrates our real set against a
  published number.

**Colour (P6) is deliberately not one of the four.** No real case has colour, and the synthetic colour is an oracle,
so no number it produced could change a decision today. It enters as an ablation term in S2. If the lead still wants
a colour slot, its claim is under "Alternate" below.

Every report must include:
- the standard rows (synthetic 32 and real 23);
- the interproximal-sector metrics;
- the prior-only control row (S3 owns it, ~15 lines);
- the click-jitter ablation on real cases.

Times are per tooth with the BVH and surface analysis prebuilt (as in the app), but patch extraction counts.

### S1. Star unwrap + circular DP (P2), for undercuts and closure by construction
- **Build:** `methods/star.ts`.
  - C on the frame axis, 30% of the local crown height above the median gum level. Find the gum level with 8
    rays at 1.2× the template's bl/2.
  - From C, a grid of 360 azimuths × 220 elevations (+75° to −45°), traced with `ray.first`.
  - Unary per cell, from the arc-length profile of each column:
    - concave turning angle at 0.15 and 0.4 mm;
    - a **depth-jump** candidate at the last wall hit before a jump of more than 0.5 mm in hit distance;
    - neutral cost on the neighbour side of a jump (fused contacts).
  - Circular DP with a transition cost proportional to the 3D step and **no hard |Δφ| cap**. Close the loop with
    the best of 5 start states.
  - Back-map the cells to their hit points, then `smoothOnSurface`.
- **Claim:**
  - Real: **≥ 10/23 correct, usable ≥ 16/23, median mean ≤ 0.25 mm**.
  - Synthetic: ≥ 20/32, including `hard` ≥ 4/8 and the leaned teeth ≥ 2/4.
  - Under 400 ms (synthetic) and under 200 ms (real).
- **Ablations that expose a cheat:**
  - C moved 1 mm off the axis: the median changes by ≤ 0.03 mm.
  - Click jitter on real: lose ≤ 2 cases.
  - Concavity-only versus depth-jump-only unary: say which cue carries the result.
  - The |Δφ| ≤ 3 cap versus the 3D-step cost, measured on interproximal coverage.
  - The 400 × 120 synthetic grid: lose ≤ 4 cases.

### S2. Crease-weighted random walker (P3), with watershed (P4) and neighbour-seed (P13) ablations
- **Build:** `methods/harmonic.ts`.
  - Patch: vertices within the template radius + 2.5 mm of the frame axis.
  - Seeds:
    - u = 1 on vertices above 60% of the local height drop within 0.4R of the axis;
    - u = 0 on the patch's outer ring and on the neighbours' crown tops at ±md along `frame.mesial`.
  - Conductance `exp(−β·max(0, −κ̄)/κ_ref)`, where κ̄ is the curvature after 2 rounds of `smoothScalar`.
  - Jacobi-PCG on the CSR graph (tolerance 1e-4, at most 2,000 iterations).
  - The u = 0.5 isoline, marched through triangles. Report both the raw isoline and the version **snapped to the
    more concave endpoint**.
  - Watershed (P4) with the same seeds and relief, through `MinHeap`.
  - Optional if time allows: a colour conductance term on `gum+colour`, with colours shifted 0.2 mm in a fixed
    world direction.
- **Claim:**
  - Real: **≥ 12/23 correct, median mean ≤ 0.25 mm** (the workbench's crease-aware cut reports 0.285 mm ASSD).
  - Synthetic: ≥ 20/32 (snapped).
  - Under 1 s (synthetic) and under 300 ms (real). Report the patch size and the CG iteration count.
  - Watershed: ≥ 3 more leaks (max > 1 mm) than the walker on `hard` plus real.
- **Ablations that expose a cheat:**
  - β = 0 must collapse (≤ 3/23 real). Otherwise the seeds, not the crease, place the line.
  - Isovalue 0.3 versus 0.7: the median moves ≤ 0.05 mm.
  - Neighbour seeds off: real interproximal coverage must drop, which shows the seeds handle fused contacts.
  - Click jitter on real.
  - Raw isoline versus snapped on synthetic, which quantifies the tall-triangle artefact.

### S3. Valley ring DP (P1) + two-segment profile snake (P10): the cheapest pipeline and the shared refiner
- **Build:**
  - `methods/valley.ts`: a concave-scored copy of `proposeMarginAnchors`, keeping candidates below 40% of the
    profile drop, then `ringDpAnchors`, then `marginFromAnchors` with `liveWireWeight(−κ)`, then
    `smoothOnSurface`.
  - `methods/valley-snake.ts`: P10 on top of P1. Stations every 0.25 mm, ±1 mm sections traced along −n, a
    two-segment breakpoint fit, the top 3 breakpoints per station, a circular DP, two passes.
  - The **prior-only control**: `methods/prior.ts`.
  - A capture-range study, reported apart from method scores because it is oracle-initialised: P10 on
    `truthPolyline` plus 6-lobe normal offsets of 0.3, 0.6 and 1.0 mm.
- **Claim:**
  - Real:
    - P1 ≥ 5/23 correct and usable ≥ 12/23;
    - P1+P10 **≥ 10/23 correct, median mean ≤ 0.25 mm**, with P10 adding under 200 ms.
  - Synthetic:
    - P1 ≥ 10/32, with the leaned teeth ≤ 1/4 (the predicted undercut failure);
    - P1+P10 ≥ 18/32.
  - Capture range: from 0.6 mm, a mean ≤ 0.1 mm on ≥ 75% of the cases in each set.
- **Ablations that expose a cheat:**
  - Replace the regression with "the most concave vertex on the section". P10 must win by ≥ 3 cases on real.
    Otherwise the regression is decoration.
  - P10's gain at 400 × 120 must be ≥ its gain at 1000 × 500, as its claimed resolution independence requires.
  - Click jitter on real.

### S4. External training-free graph cut: the MIT dental-mesh-workbench (scout §1), as a reuse-or-build test
- **Build:**
  - Clone it, and **check the LICENSE and every dependency's licence first.** If it links CGAL (GPL) or similar,
    stop and report: the GTM claim is then dead.
  - Run its WASM (267 kB) in Node, or its native build, on the 6 real jaws and the 8 synthetic arches.
  - Take the instance containing the click vertex, extract its label boundary as our truth is built (gum-side
    vertices, ordered), and score it with `scoreNatural`.
  - Wrap it as `methods/workbench.ts` (a per-jaw cache, then a per-tooth lookup).
- **Claim:**
  - Real: **≥ 10/23 correct, median mean ≤ 0.30 mm**. That is its published 0.285 mm ASSD translated to our
    scorer. Failing this means either our scorer or their numbers are off.
  - Synthetic: report only. It was tuned on real arches.
  - Under 1.5 s per jaw.
- **Ablations that expose a cheat:**
  - Count the cases where the click's instance merges two teeth or splits one.
  - Report results per jaw, because all 6 jaws are in Teeth3DS training, which its parameters may have seen.
  - Compare it with S2 on the same cases, as an external yardstick for our own region method.
- **Fallback:** if it does not run within 40 minutes, report the blocker (build, dependencies, licence). That is
  itself the GTM answer.

**Alternate (only if the lead insists on a colour slot): P6 colour LLR + crease snap.**
- Run it on `gum+colour` plus a local `hard+colour` variant (16 cases), with colours shifted 0.2 mm in a fixed world
  direction and blurred over 0.3 mm.
- Claim: snapped, ≥ 12/16 and a median ≤ 0.10 mm. Unsnapped, it shows a ≥ 0.1 mm bias, which proves the snap does
  the work.
- Real target: none is possible (no colour data). Its unshifted score is not evidence.

## 4. Predictions on record (round 2 checks these)

1. **The synthetic and real rankings will disagree.**
   - Synthetic: S1 ≥ S3 (P1+P10) > S2.
   - Real: S2 ≈ S4 > S1 > S3.
   - The undercuts, fused contacts and soft creases of real teeth hurt the ray and profile methods most.
2. **P1 alone:** ≤ 12/32 synthetic (mostly `bare`) and ≤ 4/23 real. It cuts papilla tips, and real cervical
   undercuts push it 0.3–1 mm onto the gum.
3. **S1 star:** strong on synthetic `bare` and `gum` (≥ 6/8 each). It loses papilla tips on `hard` with a hard
   |Δφ| cap. On real cases it reaches 8–12/23 and fails mostly on lower incisors (31, 33), where rays leak through
   fused contacts.
4. **S2 walker:**
   - The raw isoline fails synthetic (mean 0.2–0.5 mm, the tall-wall artefact) and the snapped version passes.
   - Real: 12–16/23, the best of our own methods.
   - The isovalue ablation moves the line by more than 0.05 mm on real anteriors, where creases are weak.
   - β = 0 collapses.
   - The watershed leaks (max > 1 mm) on ≥ 30% of real cases.
5. **S3 P10:**
   - Capture range ~0.5 mm. It fails from 1.0 mm by locking onto the gum ridge or the rounded wall top.
   - Large gain on synthetic (+6 or more cases over P1), small gain on real (+2 to +4).
   - On synthetic the regression ties "most concave vertex". On real it beats it by only 1–3 cases, because
     real sections have 3–4 segments.
6. **S4 workbench:**
   - It runs, and lands at a median real mean of 0.2–0.35 mm.
   - The per-tooth mapping fails on 2–4 cases (merged lower incisors).
   - It does worse on synthetic than on real.
   - Licence or dependency risk is the most likely blocker; I cannot verify it from here.
7. **No method** passes more than half of the 4 leaned synthetic incisors and canines except S1.
8. **Under the ±1.5 mm click jitter**, every method loses ≥ 1 real case. The real click is an oracle today.
9. **Colour (not run):** any colour method would score ≥ 15/16 on unshifted synthetic colour, regardless of its
   quality. That is why it is not in the four.
