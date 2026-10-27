# Research: finding the margin on natural teeth (a proposer, a critic, parallel experiments)

Status: **in progress** (2026-10-27). Time box: 1–2 hours.

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
