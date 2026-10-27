# Critique, round 2: results, leakage audit and verdict

Critic, 2026-10-27.

**Inputs:**
- `exp-S2.md`, `exp-S3.md`, `exp-S4.md`, `holdout-summary.md` (24 test-split cases, 3 unseen patients, frozen
  parameters) and the `holdout-*.md` and `bench-*.md` tables.
- `ux.md`.
- S1, which arrived last: `exp-S1.md`, `s1-sectors.md` and `bench-s1.md`. Its held-out rows (frozen `star` 7/24;
  `star-cap3` 13/24) are in `holdout-summary.md`.

**Spot-checked code** (worktrees under `.claude/worktrees/`):
- S1: `agent-a9bfaabf9a9ec707c`, `src/natural/s1/`.
- S2: `agent-a5e8050e77445bbd8`, `src/natural/s2/harmonic.ts`.
- S3: `agent-a86fa62512d2bd27e`, `src/natural/s3/`.
- S4: `agent-af75a65349216ac98`, `src/natural/s4/`.

## 1. Leakage and cheating audit

The bench itself is clean. All three experiment worktrees carry the same `bench.ts`/`run.ts` delta against 6b136e8,
the lead's `DCAD_TEETH3DS_DIR` and held-out commits (2da4146, f028051). No experimenter edited the scorer or the case
builder.

| Method | Labels or truth in the method? | Per-case constants? | What flatters the benchmark |
|---|---|---|---|
| **S2 walker** | **No.** `harmonic.ts:9` declares it, and the grep confirms it. Its only "label" (`:251–282`) is the watershed's own initial guess. `s2/sectors.ts` reads the truth, but it is scoring-side only. | **No.** All parameters sit in `DEFAULTS` (`harmonic.ts:32`: β 8, iso 0.5, `snap: 'gum'`). FDI is used only through `templateForTooth(c.fdi)` (`:93`). `c.name` appears only in the memo key (`:505`). | (a) **The `gum` snap matches the truth's own convention**, the gum-side vertex of each crossing edge (`:369`, `snap: 'gum'`). That is worth about 0.03 mm of median and 0 cases on the held-out set (`harmonic` 0.07 against `harmonic-raw` 0.10, both 22/24). Report the raw isoline. (b) **β = 8 was picked on the 23 dev cases** (β = 4 gave 7/23). The held-out run vindicates it. (c) The memo (`:500–512`) makes the ms column meaningless for cached variants: `holdout-s2.md` shows `harmonic` at 2 ms. Use `harmonic-raw`'s 47 ms. (d) Tooth seeds within 0.4 × min(md, bl)/2 of the axis exploit the **oracle click** (§3). |
| **S3 valley (+snake)** | **No.** `valley.ts`, `snake.ts`, `geom.ts` and `prior.ts` read only the mesh and `templateForTooth(c.fdi)` (`valley.ts:43`, `prior.ts:14`). `capture.ts`, `sectors.ts` and `diag.ts` read the truth, but they are harnesses. | **No.** Two generic rules, the radial window and the depth cap, were adjusted after looking at the real dev set. The held-out run shows it did not help: 11/23 dev against 10/24 held-out. | Its output points are off-vertex, so it gets no convention bonus. The capture study starts from `truthPolyline`, which is oracle-initialised, and it was reported apart from the method scores, as asked. |
| **S4 graph cut** | **No.** `graphcut.ts:322–407` uses `label` for its own seeds and terminals. | **No.** There is a per-FDI width table, `mdWidth` (`graphcut.ts:73`), but it holds global clinical constants. R = 16 and the curvature swap were chosen **on the dev set** (flagged †). The held-out run gives r16-ourcurv 19/24, so the choice generalised. | (a) **The ring is built on the rest-side vertices**, the truth convention (`graphcut.ts:452`). That is the same small bonus as S2's `gum` snap. (b) The upstream constants (μ 1000, β 300, α 2560, τ −1.25) were tuned by the author on Teeth3DS, which is the source of the dev *and* the held-out jaws. Our held-out run is therefore not independent of the original author's tuning. |
| **S1 star** | **No.** `s1/method.ts` reads only the mesh, the frame and `c.fdi`. `c.name` appears only as the hash seed for the jitter direction (`method.ts:13`). `s1/analyze.ts` reads the truth, but it is scoring-side. | **No.** The unary weights are global. The experimenter **declined** a per-FDI cap or window ("would be per-FDI tuning", exp-S1 §4), which was the right call. | None found. Its points are ray hits (off-vertex), so it gets no convention bonus. Both configs were frozen before the held-out run, which scored 7/24 (`star`) and 13/24 (`cap3`). |

**Verdict:** I found **no ground-truth leakage and no per-case constants**. The real flattery is in the setup:
- the label-centroid click, which every method consumes;
- the truth-convention snap (S2 `gum`, S4 ring), worth ~0.03 mm and never a case;
- dev-set selection of β, R and the curvature choice, which the held-out run then confirmed.

## 2. Round-1 claims and predictions against the numbers

Real counts are "correct / cases". The real bar is mean ≤ 0.25 mm, p95 ≤ 0.6 mm, coverage ≥ 0.85.

### Claims

| Claim (critique-1 §3) | Result | Verdict |
|---|---|---|
| **S1:** real ≥ 10/23, usable ≥ 16/23, median ≤ 0.25 mm | 7/23, usable 10/23, median **0.69 mm**. Held-out: **7/24**, 0.29 mm. The capped ablation `star-cap3`: 11/23 dev, **13/24 held-out**, 0.14 mm. | **Wrong.** The cap I told it to drop does better on real teeth: it stops the DP from following the depth jump up the fused contact on molars and premolars. It loses canines and incisors in exchange. |
| **S1:** synthetic ≥ 20/32, `hard` ≥ 4/8, leaned ≥ 2/4; < 400 / 200 ms | 24/32, `hard` 6/8, leaned 3/4 (31, 33 and 11 correct; 13 usable); 303 ms synthetic and **313 ms real** (cap3: 115 ms) | Synthetic **right**. Real latency **missed** by the default. |
| **S1:** C moved 1 mm changes the median ≤ 0.03 mm; jitter loses ≤ 2 cases | C moved: real 7 → 6, and the median moves 0.22 mm. Jitter: 7 → 7. | The C claim is **wrong** on real. The jitter claim is **right**: the inside probe re-centres. |
| **S2:** real ≥ 12/23, median ≤ 0.25 mm | 20–21/23 dev at 0.09–0.10 mm. **Held-out 22/24 at 0.07–0.11 mm.** | **Right**, by a wide margin. |
| **S2:** synthetic ≥ 20/32 snapped | 12/32 snapped, 16/32 raw | **Wrong.** |
| **S2:** β = 0 collapses | 0/23 real, 0/32 synthetic | **Right.** The crease places the line. |
| **S2:** isovalue 0.3 vs 0.7 moves the line ≤ 0.05 mm | Median per-case shift 0.021 mm, but the count goes 21 → 16/23 (posteriors) | Right on the median; the field is not a step on posteriors. |
| **S2:** neighbour seeds off drops interproximal coverage | No change (99% → 99%) | **Wrong.** P13 adds nothing to the walker. |
| **S2:** the watershed leaks ≥ 3 more | +1 | **Wrong.** |
| **S3:** P1 ≥ 5/23, P1+P10 ≥ 10/23, ≤ 0.25 mm, < 200 ms | 11/23 and 12/23, 0.17–0.18 mm, +52 ms. Held-out 10/24 and 9/24. | **Right.** |
| **S3:** P1+P10 ≥ 18/32; capture from 0.6 mm; P10 beats the concave snap by ≥ 3 | 16/32; capture ~0.3 mm (5/32 and 0/23 from 0.6 mm); +1 case | **All wrong.** P10 is not an accuracy stage. |
| **S4:** licence not a blocker; real ≥ 10/23, median ≤ 0.30 mm | MIT, standard library only; 10/23 faithful at 0.18 mm. Held-out 15/24 faithful, **19/24 r16-ourcurv**. | **Right.** |

### Predictions (critique-1 §4)

| Prediction | Result | Verdict |
|---|---|---|
| 1. Synthetic ranking S1 ≥ S3 > S2 | S1 24 > S3 16 = S2 16 (raw; snapped 12) | **Right**, apart from the S3/S2 tie. |
| 1. Real ranking S2 ≈ S4 > S1 > S3 | Dev: S2 21, S4 10 (tuned 17), S3 11–12, S1 7 (cap3 11). Held-out: S2 22, S4 15–19, S1 7 (cap3 13), S3 9–10. | **Half right.** The thesis held: region methods win on real teeth, and the rankings invert (S1 is first on synthetic and last or third on real). S2 clearly beats S4 (+3 to +7 held-out). S1 > S3 holds on the held-out set only for cap3. |
| 2. P1 alone ≤ 12/32 synthetic and ≤ 4/23 real | 16/32 and 11/23 after two generic fixes. The as-proposed version scored 5/23. | **Wrong** for the fixed version. |
| 3. S1 fails mostly on lower incisors | It fails on **molars and premolars** (0/6 each; fused contacts make the first depth jump at the contact top, and steep gum gives no jump at all). Canines 4/5, lower incisors 2/3. | **Wrong failure mode**, though the mechanism I named (rays leaking through fused contacts) is the right one. |
| 4. S2 raw isoline fails synthetic, snapped passes; real 12–16; watershed leaks ≥ 30% of real | Raw beats snapped; real 20–21; leaks 13% | **Wrong** on all three. I over-weighted the tall-triangle artefact. |
| 5. P10 capture ~0.5 mm, +6 synthetic, regression ties concave snap | ~0.3 mm, +0, tie | Right only on the tie. |
| 6. S4: median 0.2–0.35 mm, worse on synthetic, merged lower incisors, licence the likely blocker | 0.18 mm; synthetic 2/32 (right); 0 merges but 4 **collapses on upper anteriors**; MIT | **Mixed.** Wrong on the failure mode and on the licence. |
| 7. Only S1 passes > half the leaned synthetic front teeth | S1 3/4, S2 0/4, S3 0/4 | **Right.** |
| 8. The ±1.5 mm click jitter costs every method ≥ 1 real case | S2 20 → **9/23** (re-centred 15–16); S1 7 → 7 (no loss); S3 and S4 **not run** | **Right for S2**, and badly so. Wrong for S1. |
| 9. Colour adds little that geometry doesn't | S2's colour conductance gave 5/8 against 6/8 without | Consistent (synthetic only). |

**My scorecard:** right on the big call (region methods, a real-versus-synthetic inversion, the crease does the
work, the click oracle) and wrong on most of the small mechanics. The biggest miss was predicting that the raw
isoline fails.

## 3. What the held-out result proves, and what it does not

**What it proves:**
- On **Teeth3DS-style meshes from unseen patients**, a crease-weighted random walker with *frozen* constants gets
  22/24 correct and 23/24 usable, at a median of 0.10 mm (raw) in ~50 ms.
- The dev score was not an in-sample artefact. β is on a plateau (8 and 16 tie), and dev 21/23 carried over to
  held-out 22/24.
- The ranking is stable from dev to held-out: walker ≳ watershed > graph cut > star-cap3 ≈ profile DP > star ≫
  prior ≫ today's refiner (0/24).
- **Synthetic scores do not predict real ones.**
  - S1 is the best synthetic method (24/32) and 7/24 held-out.
  - S2 is 16/32 synthetic and 22/24 held-out.
  - From now on, the synthetic set is a regression and unit harness, not a selection signal.
- Region methods beat profile methods on real teeth by 10+ cases. That result is robust.

**What it does not prove:**
- **n = 3 patients.**
  - The 95% Wilson interval on 22/24 per tooth is ~74–98%.
  - Per patient the evidence is 3 data points, and **both failures belong to one patient**: 01KK2DER 16 and 36, both
    molars. Failures cluster by patient, so the per-tooth interval is optimistic.
- **The meshes are clean.** Teeth3DS meshes are cleaned, cropped and remeshed to a uniform ~0.21 mm edge.
  - Raw scanner exports have sulcus holes, tissue flaps, stitching seams, variable density (0.05–0.3 mm) and
    spatially correlated noise.
  - The walker's conductance depends on smoothed curvature at a fixed number of rings, which ties it to resolution.
- **There is no colour.** Nothing is known about colour on real teeth. Teeth3DS is grey, and no labelled colour set
  exists.
- **Full arches, not quadrants.** Crown cases are usually quadrant scans.
  - The S2 patch is a cylinder round the axis, so it should survive a quadrant scan. That is untested when the scan
    edge cuts the neighbour or comes near the target.
  - S4's gum seeds sit on the scan's cut boundary, which on a quadrant scan can cut *through* teeth.
- **The truth includes tooth/tooth contact edges.**
  - Region methods produce exactly that outline, so the benchmark rewards a *segmentation outline*. It does not
    measure the clinical gingival line under a contact.
  - That is fine for eggshell crowns, virtual preps and segmentation. For anything that needs the papilla/col line,
    it is unmeasured.
- **The click is the label centroid**, with no jitter on the held-out set.
  - S2 lost 11 of 20 dev cases under a 1.5 mm jitter (5–6 after re-centring).
  - **The held-out 22/24 is a best-click number.**
- **The population and the teeth are narrow.**
  - Only teeth 11, 13, 14, 16, 31, 33, 34 and 36 were scored: no laterals, no second or third molars at the open end
    of the arch, no gaps from missing neighbours.
  - Teeth3DS has few existing crowns, little recession, few exposed CEJs and little calculus. Crown patients have
    all of these.
- **Label noise of ~0.2 mm.** Differences under ~0.05 mm (0.07 against 0.10) are not measurable.
- **The method's tuning shares a source with the evaluation data.** S4's upstream constants and S2's β were both
  chosen on Teeth3DS. The held-out set is unseen by us, not by Teeth3DS-derived tuning.

## 4. Risks of shipping the winner (S2), ranked, and the cheapest experiment that retires each

| # | Risk | Evidence | Cheapest retiring experiment |
|---|---|---|---|
| 1 | **Click and frame sensitivity.** A real user clicks a cusp or a ridge, not the centroid. | 1.5 mm jitter: 20 → 9/23; 15–16/23 with re-centring. S2 blames `estimateToothFrame`'s axes, not the centre. S1's **inside probe** survives the same jitter with no loss (7 → 7): it casts 8 horizontal rays per 0.25 mm step down the axis and re-centres on the midpoints. | **~1 h.** Put S1's inside probe (~500 rays, a few ms; `s1/starUnwrap.ts`) in front of the walker to set the axis and centre. Alternatives: PCA of the u ≥ 0.5 region, or the case-setup frame. Then run jitter of 0.75, 1.5 and 2.5 mm in 8 directions on the dev and held-out sets. **Pass: ≤ 1 case lost at 1.5 mm.** |
| 2 | **Silent failures.** 01KK2DER 16 is 1.0 mm off and nothing says so. | Its note shows 4 chains, coverage 59% and a line length 1.13× the truth. A gate could see that. | **~1 h.** Build a gate from: chain count, winding, length against the template perimeter, field contrast across the line, re-centring shift, and **walker/watershed disagreement**. The watershed costs 12–17 ms on the same patch and seeds. It got 01KK2DER 36 correct where the walker missed. Measure on dev + held-out + synthetic. **Pass: ≥ 80% of failures flagged at ≤ 10% false alarms.** |
| 3 | **Raw scans, not Teeth3DS meshes.** | No raw export has been scored. | **~1 h for a proxy:** corrupt the held-out jaws. Punch sulcus holes over 20% of the arc (labels drive the corruption only), add correlated noise, re-mesh to 0.1 and 0.3 mm. **Decisive:** 5–10 de-identified raw partner exports with a technician-drawn line, which needs a data agreement. |
| 4 | **Quadrant scans.** | Untested. | **30 min:** crop the held-out jaws to 3–4-tooth quadrants, with the target next to the cut. Pass: ≤ 1 case lost. |
| 5 | **Competing creases in crown patients:** recession or exposed CEJ (a second concave line 1–3 mm apical), calculus ledges, existing restoration margins. | Not in Teeth3DS or the synthetic set. | **45 min:** a synthetic `recession` variant with a CEJ step 1.5 mm above the gum on 2 teeth. Check whether the walker picks the gum line. In parallel, hand-pick 3DTeethLand or test-split jaws with visible recession. |
| 6 | **Line definition at contacts** (outline against gingival line). | The truth climbs to the contact. | **A product decision, plus 15 min:** rescore the held-out set on the facial/lingual sectors only (S2's interproximal and facial accuracy are balanced, so the expected answer is "no change"). |
| 7 | **Density and latency.** | Synthetic 0.024 × 0.08 mm: 0.4–2 s. Real: 50–100 ms. The browser worker is unmeasured. | **30 min:** decimate the patch to ~0.15 mm before solving. Time it in the worker. Pass: < 200 ms with ≤ 1 case lost. |
| 8 | **Provenance of β = 8** (chosen on NC-ND Teeth3DS). | The plateau is 8–16 on real teeth, and 4–16 gives 12/32 on synthetic. | **Free:** record that β was re-derived on synthetic and own data, and get a legal note before release. |

## 5. Verdict

**Ship first: S2's crease-weighted random walker** as the natural-tooth one-click.
- Settings: β = 8, iso 0.5, the **raw** isoline (not the `gum` snap, which only matches the truth convention), one
  re-centring pass, then `smoothOnSurface`.
- About 3 days for the engine, plus the risk-1 and risk-2 work (frame from the solved region, and a gate) **before
  release**. Without them the 22/24 is a best-click number, and failures are silent.
- Pair it with the UX track's **concave live-wire 2-click sector redraw**: 89/106 fixed in a median 20.5 s. The
  v1b flow fixed 93/106 in 13 s, but those numbers are synthetic only, and their clicks come from the labels.
- Add **scribbles as extra Dirichlet seeds** on the same solver. That is +2 days and no second algorithm.

**Keep:**
- **The watershed, as a second opinion and gate signal.** It runs on the same patch and seeds, 21/24 held-out, in
  12–17 ms. The two disagree exactly where one of them is wrong (01KK2DER 36).
- **The S4 graph cut, as a fallback candidate**, not v1: 19/24 held-out after dev tuning, with 3–5× the latency. It
  got 01KK2DER 16 right where the walker failed. Revisit it if the gate shows the walker and the cut fail on
  disjoint teeth.
- **S1's inside probe, as a component.** It is the click-robust centring that S2 lacks (risk 1).
- **The P10 snake, only as the magnetic snap** for a dragged or redrawn segment. That is its 0.3 mm capture use.
  It is not an accuracy stage.

**Drop:**
- **The S1 star DP as a margin method.** Frozen it scored 7/24 held-out. Even cap3 is 13/24, against the walker's
  22/24 at about half the time.
  - Its synthetic win (24/32, 3/4 leaned) did not transfer.
  - Its per-sector confidence is too weak to gate with (Spearman −0.36, 63% recall at 42% precision).
  - Its one real strength is canines (4/5).
- P1 valley as a shipped method (10/24 held-out; the walker is better at 50 ms).
- Neighbour seeds as a feature (P13 had no effect).
- Colour as a conductance term (no gain; no real data). Revisit colour as a gate cue once coloured partner scans
  exist.
- P5, P7, P8, P11, P12 and P14 for v1, as argued in round 1.
- Today's convex refiner on natural teeth (0/24 held-out).

**What would change this verdict:**
- The jitter fix fails: more than 2 cases lost at 1.5 mm after the axis re-derivation. Then the case-setup frame
  becomes a hard dependency.
- The raw or quadrant proxies cost the walker more than 4 cases while S4 holds up. Then the cheapest gated ensemble
  wins: walker + watershed, with the graph cut as the tie-breaker.
