# Research: finding the margin on natural teeth (a proposer, a critic, parallel experiments)

Status: **done** (2026-10-27). Time box: 1–2 hours (took about 2 h 15 min).

## Goal

The user (2026-10-27): "Create multiple agents, one proposes, one criticises … we need to build a strategy / algorithm
that can work with good accuracy on finding the margin for natural teeth. Go as creative as possible … document the
findings of both the agents in a md file. Use parallelisation to test multiple approaches … We are trying to build for
accuracy, cost minimisation, fastest GTM. You can also look at making the UX better to allow for faster margin
conciliation by a human, or methods like smoothing."

**What "margin on a natural tooth" means here.**
- A natural (unprepared) tooth has no finish line. The line that matters on it is the **gingival margin**: where the
  tooth surface meets the gum on the scan.
- It is what these need:
  - pre-op ("eggshell") provisionals, veneers, wax-ups and a virtual prep;
  - tooth segmentation;
  - a sensible one-click on a natural tooth.
- Today's automatic margin looks for a prep's convex finish line, so on a natural tooth it produces 39–54 mm stepped
  lines (`2026-10-26-no-prep-no-crown.md`). The tooth/gum junction is a concave crease instead.

## Scope

**In:**
- **Approaches:** proposals (a proposer agent), prior art, data and competitor UX (a scout), and an adversarial
  critique (a critic).
- **Experiments:** a shortlist implemented in parallel and measured on one benchmark, then critiqued again.
- **Human review:** UX for confirming or correcting a margin fast.
- **Write-up:** this spec, with the findings of both sides.

**Out:**
- Shipping a method in the app.
- Training a model on real patient data.
- An LLM in the margin loop (tried and dropped in `2026-10-26-margin-ai.md`).

## Design

**Team** (background agents, at most 9):
1. **Proposer:** at least 10 approaches, each with a 30–45 minute experiment. Output:
   `out/natural-margin-research/proposals.md`.
2. **Scout:** methods, licences, datasets (Teeth3DS: per-vertex tooth labels, de-identified, public), and how exocad,
   3Shape and Medit let a technician fix a margin. Output: `scout.md`.
3. **Critic:** attacks the proposals with the scout's findings, and shortlists 3–4 with falsifiable tests.
4. **Experimenters** (one per shortlisted approach, each in its own git worktree): implement the approach against
   the benchmark and report the numbers.
5. **UX** (human-in-the-loop): the fastest confirmation and correction flow, measured where possible with a simulated
   technician on the benchmark.
6. **Critic, second round:** checks the results for ground-truth leakage and synthetic bias. The proposer then writes
   the strategy.

**Benchmark** (`tools/pipeline-runner/src/natural/bench.ts`, run with
`pnpm --filter @dcad/pipeline-runner exec tsx src/natural/run.ts`):
- **Jaws:** synthetic jaws at the demo resolution (1000 × 500), every tooth natural.
- **Ground truth:** per-vertex labels from `syntheticArch({ labels: true })`, the tooth's FDI or 0 for gum. The truth
  is the labelled tooth/gum boundary, the same form as Teeth3DS, so real labelled scans plug in unchanged.
- **Realism** (`syntheticArch` `gingiva`): the gum covers the tooth's base and rises into papillae between teeth (a
  scalloped line). Plus a softened crease (Taubin smoothing), scan noise, scanner-like colour on or off, and an
  off-centre click.
- **Teeth:** incisor, canine, premolar and molar, upper and lower.
- **What a method sees:**
  - the mesh (positions, indices, normals, colours when the variant has them);
  - the click on the tooth, its FDI, the tooth frame (`estimateToothFrame`), and surface analysis;
  - never the labels.
- **Score:**
  - mean, 95th-percentile and largest distance from the line to the truth (mm);
  - coverage: the share of the truth within 0.3 mm of the line;
  - time.
  - **Correct:** mean ≤ 0.15 mm, 95th percentile ≤ 0.4 mm, coverage ≥ 0.9.
  - **Usable:** mean ≤ 0.3 mm, coverage ≥ 0.8.

## Verification plan
- The benchmark scores its own truth at about 0 mm (self-check), and today's refiner fails it (baseline).
- Every number in the findings comes from a benchmark run recorded in `out/natural-margin-research/`.
- `pnpm typecheck` and `pnpm test` stay green. The generator change is opt-in (`gingiva`, `labels`), so the demo
  scans and existing tests are unchanged.
- No new unit tests: research code, not product code.

## Findings

**The answer.**
- **Engine:** ship the **crease-weighted random walker (S2)** as the natural-tooth margin.
  - **Held-out:** 22 of 24 real teeth from 3 unseen patients correct, median 0.07–0.11 mm.
  - **Cost:** about 50 ms per tooth, pure TypeScript in the geometry worker, no model, $0.
  - **Effort:** about 3.5 days.
- **Correction:** pair it with two fixes to the human tools:
  - a live-wire that treats the concave gum crease as cheap (0.5 day). Today it treats concave as up to 3× more
    costly, so it avoids exactly this line.
  - a two-click sector redraw (1–1.5 days).
- **Before release:** make it robust to where the user clicks, and add a gate that flags a doubtful line.
- **Baseline:** today's margin finder gets 0 of 47 real cases and 0 of 32 synthetic cases right.

**Results.** Every row is from a benchmark run, with times per tooth in Node. "Held-out" means 6 Teeth3DS+ test-split
jaws from 3 patients that no experimenter saw, run once with frozen parameters. "Dev real" means 6 training-split
jaws, which the parameters were tuned on.

| Method | Held-out real (24) | Dev real (23) | Synthetic (32) | Median mm (held-out) | ms |
|---|---|---|---|---|---|
| Today's refiner (baseline) | 0 | 0 | 0 | 1.50 | 219 |
| **S2 random walker** (β 8; raw isoline or gum-side snap) | **22** | 21 | 16 | **0.07–0.11** | 47–80 |
| S2 watershed (P4) | 21 | 20 | 8 | 0.08 | 17 |
| S4 graph cut (MIT dental-mesh-workbench, ported; our curvature, 16 mm patch) | 19 | 17 | 8 | 0.08 | 264 |
| S1 star unwrap + circular DP (with the cap 13; frozen 7) | 13 / 7 | 11 / 7 | 23 / 24 | 0.14 / 0.29 | 119 / 315 |
| S3 valley ring DP (P1) | 10 | 11 | 16 | 0.19 | 16 |
| S3 valley + profile snake (P10) | 9 | 12 | 16 | 0.22 | 69 |
| Prior-only control (a template ring) | 0 | 0 | 0 | 1.28 | 1 |

The pass levels:
- **Real:** correct = mean ≤ 0.25 mm, 95th percentile ≤ 0.6 mm, coverage ≥ 85% (the labels are good to about 0.2
  mm).
- **Synthetic:** correct = mean ≤ 0.15 mm, 95th percentile ≤ 0.4 mm, coverage ≥ 90%.

**Proposer and critic, approach by approach.**

| Approach | Proposer (round 1) | Critic (round 1) | Measured | Verdict (round 3) |
|---|---|---|---|---|
| S1 star unwrap + DP (P2) | Rank 1: sees undercuts, closed by construction, per-sector confidence | Fused contacts and steep gum will break it; drop the step cap | Best on synthetic (24/32) but 7–13/24 held-out. Facial sectors right; interproximal p95 1.22 mm at fused contacts. The cap the critic said to drop helps on real. Confidence is a weak predictor (Spearman −0.36). | **Drop** as the engine. Keep its inside probe (jitter-proof) for the click |
| S2 random walker (P3) | Rank 2: diffusion averages noise; scribbles are more seeds | Needs a strong crease weight; the isoline will sit up the wall | **22/24 held-out**. β = 0 → 0/23, so the crease does the work. The raw isoline did not fail. Colour adds nothing. Neighbour seeds are not needed. Click jitter ±1.5 mm: 20 → 9/23 (15–16 with re-centring). | **Ship** |
| S2 watershed (P4) | An ablation of P3 | Leakier | 21/24 held-out at 12–17 ms, but leaks larger when it fails | **Keep** as a cheap second opinion for the gate |
| S4 graph cut (from the scout) | – | Swapped in for colour: the only method with published real-scan numbers; check the licence | MIT, standard library only. 19/24 held-out; got right the molar the walker missed. No merges; failures are whole-tooth collapses on upper incisors. | **Keep** as the fallback |
| S3 valley ring DP (P1) | Rank 5: 1–2 days, the baseline to beat | Will lose leaned teeth | 10/24 held-out at 16 ms; molars and premolars mostly right; fails facial/lingual undercuts on front teeth | **Drop** as a shipped method |
| P10 profile snake | Rank 3: lifts any line to under 0.06 mm | Prove it beats a "most concave vertex" snap | Capture range about 0.3 mm (not 0.6); +1 real case over the snap; no gain held-out | **Keep** only as the magnetic snap while editing |
| P6 colour | Rank 4 | Synthetic colour is an oracle; no public data has colour and labels | Adds nothing to the walker on synthetic | **Later:** a gate or leak guard on coloured scans, once real coloured data exists |
| Learned 3D segmentation, SAM-style 2D | Weeks; best real-scan upside | Licences (NC data, unlicensed weights), GPU | Not built | **Quarter:** learn on our own labels only |

**What the critic found in round 2.**
- **No ground-truth leakage** in S1–S4: no method reads labels or truth, and none has per-case constants.
- **Flattering factors:**
  - The click is the tooth's label centroid, a best case. Jitter halves S2 without re-centring.
  - S2's gum snap and S4's ring land exactly where the truth is defined, worth about 0.03 mm.
  - β, the patch size and the curvature choice were picked on the dev set. The held-out run confirmed them.
- **What the held-out result doesn't prove:**
  - It covers 3 patients, and both misses are one patient's molars.
  - The meshes are clean, remeshed full arches, with no colour and no quadrant scans.
  - The truth includes tooth/tooth contacts.
- **Round-1 predictions:**
  - **Right on the big call:** region methods win on real teeth, and the synthetic and real rankings invert.
  - **Wrong on mechanics:** the raw isoline, the S1 cap, P10's capture range and S4's licence.

**Human in the loop** (`ux.md`, simulated technician, keystroke-level times, not a user study).
- **Today:** anchor dragging fixes 49 of the 106 lines that needed fixing, in a median of 26 s. It fixes 0 of 24
  refiner outputs.
- **Why:** the live-wire avoids concave creases, and there is no partial redraw, insert or delete.
- **The recommended flow:**
  - concave-cheap weight: a 4-click redraw goes from 0/24 to 16/24 correct;
  - two-click sector redraw;
  - anchor insert and delete;
  - a doubt heat map, fly-to and Enter to accept.
- **Simulated result:** 93 of 106 fixed in a median of 13 s and 4 actions, and 21 of 24 refiner outputs in 18 s.
  Confirming a good line takes 2.5 s.
- **Not worth it as built:** Tab through alternatives, a crease-snapping brush, and one-key snap-all. They snap to the
  wrong crease near embrasures.
- **Not simulated:** exocad's cross-section under the cursor and Medit's global offset slider. They are in the ranking
  on competitor evidence.

**Strategy** (the proposer's `strategy.md` and the critic's verdict agree).
- **Weeks 1–2:**
  - the walker in the worker (`geometry/naturalMargin.ts`);
  - a gate: one closed loop round the axis, length 0.6–1.4× the template perimeter, re-centring shift < 0.5 mm, and
    agreement with the watershed;
  - S1's inside probe for the centre (click robustness);
  - the concave-cheap live-wire and two-click sector redraw;
  - S4 as the fallback when the gate fires.
- **Month 1:**
  - validate on real, non-Teeth3DS scans. The ~100 in-house cases in `plan.md` need de-identifying first, which
    is blocked on the user.
  - cover several scanners, quadrant scans and coloured PLYs. Colour as a gate, not a conductance.
  - the gum line as a soft prior for prep margins (it removes false edges below the finish line).
- **Quarter:**
  - a learned per-vertex term trained only on our own technician-corrected lines, with the walker as the
    regulariser;
  - scribble correction on the same solver (+2 days).
  - The moonshot: fit tooth and gum surfaces jointly and intersect them.

**Risks, ranked.**
1. Where the user clicks: put S1's probe in front of the walker (about 1 h to try).
2. Unflagged failures: the gate with walker/watershed disagreement (about 1 h).
3. Raw scanner meshes, quadrant scans, recession and other pathology.
4. Which line counts as truth under fused contacts.
5. The UX numbers are simulated; speed in the browser and on dense scans is not measured.

**Data and licences.**
- **Teeth3DS+:** CC BY-NC-ND 4.0.
  - Used here for local, non-commercial evaluation only: 6 training-split jaws plus 6 held-out test-split jaws in
    `data/`, never committed.
  - Nothing trained on it ships, and a commercial licence would go through its authors.
  - The S4 graph cut's original constants were tuned on Teeth3DS; ours were re-chosen on our dev set. Get a legal view
    before relying on them.
- **dental-mesh-workbench:** MIT. It was read, not run, and re-implemented.
- **Colour:** no public dataset has both scanner colour and labels.

## Implementation summary

**What was built.**
- **The benchmark:**
  - `tools/pipeline-runner/src/natural/bench.ts` and `run.ts` (commits 4decde2, 5a4ad5b, 6b136e8, 2da4146, f028051);
  - 32 synthetic cases (bare, gum, gum+colour, hard), 23 real development cases and 24 held-out real cases;
  - truth: the labelled tooth/gum line; the self-check scores it at 0.02–0.06 mm;
  - baseline: `methods/refine.ts`;
  - run with `pnpm --filter @dcad/pipeline-runner exec tsx src/natural/run.ts --methods <names> --set
    synthetic|real|holdout|all`.
- **The generator:** `apps/web/src/geometry/synthetic.ts` gains opt-in `gingiva` (cover and papillae, scanner-like
  colour with a stained cervical band) and per-vertex `labels`. Demo scans and tests are unchanged.
- **The experiments,** each on its own branch and worktree (`tools/pipeline-runner/src/natural/<s1|s2|s3|s4|ux>/`
  and `methods/*.ts`), not merged into main:

  | Experiment | Branch | Commit |
  |---|---|---|
  | S1 | `worktree-agent-a9bfaabf9a9ec707c` | 70cd38a |
  | S2 | `worktree-agent-a5e8050e77445bbd8` | 959a9b4 |
  | S3 | `worktree-agent-a86fa62512d2bd27e` | d357ca1 |
  | S4 | `worktree-agent-af75a65349216ac98` | 8006f97 |
  | UX | `worktree-agent-abbd2917ad09a62f2` | d006f38 |

  Each S branch also has the lead's merge of main, which adds the held-out set.
- **The agents' write-ups:** [`specs/research/2026-10-27-natural-margin/`](research/2026-10-27-natural-margin/README.md).

**Deviations from the plan.**
- **Benchmark fixes.** The proposer caught a flaw in the first benchmark: synthetic wall triangles are 0.8–1.7 mm
  tall, so edge midpoints sat up the wall. The truth moved to the gum-side vertices, colour became scanner-like, and
  the hard variant gained leaning front teeth.
- **Real data.** The scout found Teeth3DS+ downloadable, so real cases were added before the experiments, and a blind
  held-out set during them.
- **The colour slot.** The critic replaced the colour experiment with the scout's MIT graph cut (S4), because
  synthetic colour is an oracle.
- **Time:** about 2 h 15 min, against the 1–2 h box.

**Verification.**
- `pnpm typecheck` clean. `pnpm test`: 118 tests (106 pass, 12 skipped), unchanged (no new tests: research code).
- The benchmark self-check passes on all 79 cases.
- Each held-out score above was run once by the lead, after the experiments froze their parameters. S2's `harmonic`
  was re-timed alone (52 ms), because a memo made its first held-out timing 2 ms.

**Follow-ups.**
- **Ship S2** as `geometry/naturalMargin.ts` behind a natural-tooth mode, with the gate, the click probe, the
  concave-cheap live-wire and the sector redraw. That needs its own spec.
- **Validate** on de-identified in-house scans.
- **Decide** whether to merge the experiment branches into main for reproducibility.
