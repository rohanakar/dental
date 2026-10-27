# Experiment S4: dental-mesh-workbench's training-free graph cut, re-implemented in TypeScript

Experimenter S4, 2026-10-27. Branch `s4-dmw-graphcut` (worktree `agent-af75a65349216ac98`), commit `8006f97` and later.
Time box 45 minutes; this is what I had at the end of it.

## 1. Licence findings

I cloned `github.com/carlmarco/dental-mesh-workbench` at `c550f9c` (2026-10-13) into the scratchpad, outside the repo.
I read the source only. I ran no install, build, test or binary.

- **Repository:** MIT, "Copyright (c) 2026 carlmarco" (`LICENSE`).
- **Core algorithm (`src/core`, static lib `dmw_core`):** only the C++20 standard library. I grepped every `#include`.
  Apart from `<…>` standard headers there are only the repo's own `core/*.h` and `detail/*.h` (vec, hash,
  disjoint_sets, parse_number). There is no CGAL, Eigen, libigl, OpenMesh, Boost or GPL code.
- **Build-time and dev dependencies:**
  - Catch2 v3.16.0 (BSL-1.0), fetched by CMake for the native tests only.
  - Emscripten/embind (MIT/UIUC), for the WASM bindings only.
  - The web viewer: `three` 0.186.1 (MIT), plus the dev tools vite, typescript, playwright-core, gifenc and @types,
    all permissive. None of them is in the algorithm.
- **Data:** the author's parameters were tuned on Teeth3DS (CC BY-NC-ND). Tuned constants are facts, not a
  derivative work of the data, but see §8.
- **Verdict: no licence blocker.** We also do not need their code: §2 is a clean-room re-implementation from reading
  `margin.cpp`, with no code copied. An MIT attribution line in our notices would still be courteous.

## 2. The algorithm as I read it (`src/core/margin.cpp`, `margin_operating_point()`, D73/D78/D85)

The original works per jaw, on the largest connected component:

1. **Curvature.** Meyer et al. discrete operators: H from the cotan Laplacian, K from the angle defect over the mixed
   area, κ_min = H − √(H² − K). Valley strength s = max(0, −κ_min), raw (σ = 0).
2. **Seeds.**
   - Gingiva: the scan's cut boundary plus the arch vertices below the 15% height quantile along the occlusal axis.
   - Tooth: the single highest vertex plus the cusp tips from `detect_cusps` (an occlusal-prominence detector:
     1.3 mm threshold, 3.5 mm NMS, above the median height).
3. **Distances.** Two multi-source Dijkstras with edge cost l·(1 + α·s̄), α = 2560 mm.
4. **Binary cut.**
   - Unary: −A_v·log p, with p = d_G/(d_T + d_G).
   - Pairwise (Potts): μ·l′/(1 + β·s̄), with μ = 1000, β = 300 and l′ the cotan dual edge length, clamped at ≥ 0.
   - Seeds are hard constraints; the solver is Boykov–Kolmogorov max-flow.
   - μ dwarfs the unary, so in effect the result is the minimum crease-weighted cut between the hard seeds.
5. **Per tooth.**
   - Cusp tips are grouped into teeth inside the binary tooth region: tips connected through κ_min > τ = −1.25 share
     a group.
   - Then α-expansion runs over {gingiva, tooth 1..G} with p_l ∝ 1/d_l, the same Potts weights, a 3 mm expansion
     radius and a 15 mm label radius.
   - Reported: 0.338 mm ASSD after the binary cut, 0.285 mm after the per-tooth cut.

## 3. What I built, and what I simplified

The code is in `tools/pipeline-runner/src/natural/s4/graphcut.ts` and `s4/maxflow.ts`. The method is
`methods/s4.ts`, with ablations in `methods/s4-*.ts`.

**Same as the original:**
- Meyer κ_min.
- s = max(0, −κ_min), raw.
- Dijkstra cost l·(1 + 2560·s̄).
- The unary −A·log p.
- Potts weight 1000·l′/(1 + 300·s̄) with the cotan dual length.
- Hard seeds.
- Gingiva seeds at the cut boundary plus the lowest 15%.
- τ = −1.25 grouping.

**Simplified or changed:**

| Original | S4 here | Why |
|---|---|---|
| Whole jaw (largest component) | A Euclidean ball of R = 13 mm round the click (its connected part); its cut boundary acts as the "scan cut" (gingiva seeds) | Per-tooth input and web-worker cost. The patch is extracted per call and timed. |
| `detect_cusps` (prominence ≥ 1.3 mm, NMS 3.5 mm) + the highest vertex | The click's 1 mm geodesic disc + "highest within 2 mm" NMS tips | Time box. There is no prominence filter, so tips also fire on gum. That is harmless when they are rest seeds. |
| Grouping inside the binary-cut tooth region | A flood from the click disc through κ_min > τ, limited to height ≥ click − 3 mm and to \|mesial offset\| ≤ 0.4·md, using template md widths by FDI (global constants) | An unrestricted flood leaks over the flat gum to the neighbours. The original avoids this by flooding inside its first binary cut. |
| α-expansion over every tooth | **One binary cut, "this tooth vs rest".** Rest seeds are the gingiva seeds plus tips at \|mesial offset\| ≥ 0.75·md (neighbours). Unary: the 3-label marginal p_t = (1/d_T)/(1/d_T + 1/d_G + 1/d_N) | The bench's truth is this tooth vs everything else. A Potts binary cut ignores the cost of the gum/neighbour boundary, which is a relaxation of the multi-label cut. |
| BK max-flow | Dinic (BFS levels, iterative DFS), on float capacities | Simpler to get right. 20–30k nodes run in tens of ms. |
| Label boundary edges, scored on edge midpoints | The region (the click's component, holes filled), then the boundary loop of the faces touching it, which runs along the rest-side vertices. That is the bench's truth convention. The longest loop is kept. | The bench wants an ordered closed line. |
| No star prior, no strip carving, no learned terms (all off at their operating point too) | The same | — |

**Ablations:**
- `s4-voronoi`: the geodesic Voronoi stage only (D71).
- `s4-nocrease`: α = β = 0.
- `s4-ourcurv`: the app's smoothed signed curvature (`surface.curvature`) instead of κ_min.
- `s4-noneigh`: no neighbour seeds.
- `s4-r16` and `s4-r16-ourcurv`: R = 16 mm.

No method reads labels or the truth. `s4/sectors.ts` is an evaluation-only script that reads the truth in order to
split the errors by sector.

## 4. Results

The commands, from the worktree's `tools/pipeline-runner`, with `DCAD_TEETH3DS_DIR=…/data/teeth3ds`:
- `tsx src/natural/run.ts --methods s4,s4-voronoi,s4-nocrease,s4-ourcurv,s4-noneigh --set real --out …/bench-s4-real-ablations.md`
- `--methods s4-r16,s4-r16-ourcurv --set real --out …/bench-s4-real-r16.md`
- `--methods s4,s4-ourcurv,s4-voronoi --set synthetic --out …/bench-s4-synthetic.md`

### Real (Teeth3DS+, 23 teeth, 6 jaws). Correct = mean ≤ 0.25, p95 ≤ 0.6, coverage ≥ 0.85

| Method | Correct | Usable | Median mean mm | Median ms / tooth | Collapsed (length < 0.6× truth) | Merged (> 1.3×) |
|---|---|---|---|---|---|---|
| refine (baseline, from the lead) | 0/23 | – | – | – | – | – |
| **s4 (faithful, R 13)** | **10/23** | **16/23** | **0.18** | **223** (max 404) | 4 | 0 |
| s4-voronoi (no cut) | 9/23 | 12/23 | 0.29 | 120 | 0 | 0 |
| s4-nocrease (α = β = 0) | 0/23 | 0/23 | 4.02 | 273 | all | 0 |
| s4-noneigh | 11/23 | 16/23 | 0.15 | 209 | – | – |
| s4-ourcurv | 15/23 | 18/23 | 0.09 | 224 | 3 | 0 |
| s4-r16 † | 16/23 | 18/23 | 0.09 | 293 | 3 | 0 |
| s4-r16-ourcurv † | **17/23** | **21/23** | **0.09** | 316 (max 472) | 2 | 0 |

† I chose R = 16 *after* seeing that the R = 13 failures were tall upper anteriors. It is tuned on the test set, so
read it as optimistic. The curvature swap was decided in advance as an ablation, not tuned.

Correct per jaw:

| Method | 01F4JV8X | EA8SBGX4 | DNSRP767 | XKTTBEE0 | V5U3CUGX | SZQ66Y5A |
|---|---|---|---|---|---|---|
| s4 | 1/4 | 1/4 | 2/4 | 1/4 | 4/4 | 1/3 |
| s4-r16-ourcurv | 1/4 | 3/4 | 3/4 | 3/4 | 4/4 | 3/3 |

### Synthetic (32 cases; report only, since the parameters were tuned on real arches)

Correct = mean ≤ 0.15, p95 ≤ 0.4, coverage ≥ 0.9.

| Method | bare | gum | gum+colour | hard | All: correct / usable / median mean mm | Median ms |
|---|---|---|---|---|---|---|
| s4 (faithful) | 2/8 (usable 6/8), median 0.09 | 0/8, 2.42 | 0/8, 2.42 | 0/8, 2.20 | **2/32 / 6/32 / 2.20** | 2268 |
| s4-ourcurv | 0/8, 5.53 | 4/8, 0.30 | 4/8, 0.30 | 0/8 (usable 3/8), 1.79 | 8/32 / 11/32 / 1.55 | 3147 |
| s4-voronoi | 0/8 (usable 2/8), 0.39 | 0/8, 3.06 | 0/8, 3.06 | 0/8, 2.50 | 0/32 / 2/32 / 2.72 | 1326 |

Why synthetic is worse:
- The demo-resolution arch is anisotropic: its wall triangles are 0.8–1.7 mm tall, with a dense grid along the arch.
  κ_min, the dual lengths and the patch size (140–150k vertices) all differ from real scans.
- Notes often show "tips 0+…": the grouping flood finds no cusp tip of the clicked tooth, so the only tooth seed is
  the 1 mm click disc.
- On the gum variants the cut takes the cover shelf or a papilla crease, landing 2–2.5 mm off.
- The faithful raw κ_min works only on `bare`, where the crease is sharp. Our smoothed curvature works on `gum` but
  not on `bare`, where the smoothed crease band is wide.
- This is the critic's "tuned on real arches" warning made concrete. Synthetic results should not be used to tune
  this method.

## 5. The critic's claims (critique-1 §3, S4, and prediction 6)

| Claim | Verdict | Numbers |
|---|---|---|
| Licence/dependencies are not a blocker | **MET** | MIT, standard library only (§1) |
| Real ≥ 10/23 correct | **MET (just)** for the faithful port | 10/23 at R 13. 15/23 with our curvature, 16–17/23 at R 16 (†) |
| Real median mean ≤ 0.30 mm | **MET** | 0.18 faithful, 0.09 for the variants |
| < 1.5 s per jaw | **NOT MET as built / not measured** | I built a per-tooth patch, not a jaw pass: 0.22–0.32 s per tooth, ≈ 3.5–5 s for a 14–16-tooth jaw if run tooth by tooth. The app needs one tooth per click, so the per-tooth time is the relevant one. |
| Ablation: merges or splits of the click's instance | Measured | 0 merges. 4 collapses (faithful) or 2 (r16-ourcurv): the region shrinks to a blob near the incisal edge on upper 11/13. The predicted "merged lower incisors" did **not** happen: the lower incisors were 5/6 correct with r16-ourcurv. |
| Per-jaw report (leakage from Teeth3DS training) | Reported above | V5U3CUGX 4/4 on every variant, 01F4JV8X 1/4 on every variant. All 6 jaws are in Teeth3DS, which the author's parameters may have seen. |
| Prediction 6: median real mean 0.2–0.35 mm | Slightly better than predicted | 0.18 |
| Prediction 6: worse on synthetic than on real | **MET (correct prediction)** | Synthetic 2/32 vs real 10/23 (faithful); 8/32 vs 15/23 (ourcurv) |
| Compare with S2 | Left to the lead | I have no S2 numbers |

**ASSD versus the bench mean.** Their 0.285 mm (median 0.219) is a symmetric average over the whole jaw's boundary,
on edge midpoints. Our "mean" is one-directional (line → truth) on the gum-side vertices of one tooth; the other
direction shows up only through coverage. On the cases that work, our median of 0.09–0.18 mm is consistent with
their per-scan median of 0.219 mm. A collapse costs us 3–4 mm on one tooth, where it would cost them a fraction of a
whole jaw's average. The two numbers are not directly comparable, but nothing here says their figures or our scorer
are off.

## 6. Failure analysis

- **Sectors** (real, `s4/sectors.ts`: interproximal = within 35° of ±mesial round the click):

  | Method | Interproximal: mean / median / p95 mm, truth missed (> 0.3 mm) | Facial/lingual: mean / median / p95 mm, truth missed |
  |---|---|---|
  | s4 | 0.42 / 0.07 / 3.13, 29% | 0.54 / 0.09 / 3.69, 32% |
  | s4-r16-ourcurv | 0.13 / 0.00 / 0.23, 12% | 0.14 / 0.07 / 0.26, 13% |

  The method fails whole teeth, not sectors: when it works, interproximal is as good as facial. Fused contacts did
  not break it on these 23 teeth.
- **Collapses on upper anteriors** (01F4JV8X 11, DNSRP767 11 on every variant; EA8SBGX4 13 and DNSRP767 13 at R 13):
  - The line is ~100 vertices long and sits 3.4–4.3 mm from the truth with 0% coverage. The cut has closed round the
    incisal end.
  - The likely cause is cheap creases plus too few tooth seeds:
    - a tall, labially inclined crown;
    - only one tooth seed (the 1 mm click disc; anteriors get "1 tip");
    - the gum seeds at the lowest 15% and at the patch edge come close to the cervical third.
  - R = 16 fixes two of the four. The two upper centrals remain. The original's whole-jaw seeds (the cut boundary is
    far away, and every incisal tip is a seed) would probably avoid this. I did not have time to confirm it.
- **Partial leaks** (usable, not correct: 01F4JV8X 13 and 14, EA8SBGX4 16 at R 13): p95 is 1.3–3 mm over part of the
  loop, where the cut takes a shortcut across a soft crease.
- **The crease term is everything.** With α = β = 0 every case collapses (0/23, 4 mm). Our smoothed curvature beats raw
  κ_min (+5 correct at R 13). That fits a narrow cervical crease that the smoothed signed curvature captures more
  robustly at this mesh density.

## 7. Time

- **Per tooth (real):** median 223 ms and max 404 ms faithful; 316 / 472 ms for r16-ourcurv. Node 22, single thread,
  on 20–32k-vertex patches. This includes patch extraction, curvature, three Dijkstras, the cut and the ring.
- **Synthetic:** 1.4–4.3 s per tooth, because the demo-resolution synthetic arch is dense (a 140–150k-vertex patch).
- **Per jaw:** not built. Tooth by tooth it would be ≈ 3.5–5 s. A jaw pass would share the curvature and seeds and
  should be ~1–2 s in TS.

## 8. What shipping it in the app would take

- **Code:** ~450 lines of pure TS on typed arrays, no dependencies. It fits `apps/web/src/geometry` and the web worker
  as is. Work:
  - move it to `geometry/naturalMargin.ts`;
  - reuse the worker's adjacency instead of rebuilding the patch's;
  - replace the Map-based edge table with CSR;
  - add the `detect_cusps`-style prominence filter;
  - group inside a first binary cut, as the original does (this should fix the incisor collapses);
  - smooth the ring for display.
- **Effort:** about 2–3 days to product quality, plus 1 day of tests (one passing and one failing case on the
  synthetic jaw).
- **Latency:** 0.2–0.5 s per click on real-density scans now. 0.1–0.2 s is likely after the CSR/typed-array cleanup.
  Decimate first on dense scans.
- **Licence:** MIT and reimplemented, so no obligations. One caution: the constants (μ 1000, β 300, α 2560, τ −1.25)
  were tuned on Teeth3DS, which is CC BY-NC-ND. Constants are not a derivative dataset, and we use them unchanged.
  The legal view should still be recorded before release. Our own tuning (R, curvature) must not be done on Teeth3DS
  if it ships; tune on our own or licensed scans.

## 9. Recommendation

- **Adopt it as the natural-tooth margin baseline.**
  - It is the only approach so far with real-scan evidence: 10/23 correct faithful, 15–17/23 with small changes,
    0 merges, and ~0.2–0.3 s per tooth.
  - It is training-free and ships as pure TS without licence risk.
- **Next steps, in order:**
  1. Do the first binary cut and group inside it, as the original does, to fix the upper-incisor collapses.
  2. Freeze R and the curvature choice on *non-Teeth3DS* data, then re-run once on the 23 cases.
  3. Add the click-jitter ablation (not run, for lack of time).
  4. Pair it with a human-confirm UX: when it fails, it collapses visibly (the line is far too short), which a length
     gate (< 0.6× the expected perimeter by tooth type) can flag automatically.
- **Caveats:**
  - Only 23 real teeth from 6 jaws, all in Teeth3DS, which the author tuned on.
  - The R = 16 numbers are tuned on this test set.
  - Synthetic performance: poor (2/32 faithful, 8/32 with our curvature); the method is tuned to real-scan density and creases.
