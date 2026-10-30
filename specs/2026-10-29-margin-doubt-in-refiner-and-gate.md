# The margin, round two: the scan picks between candidate lines, and a doubtful line stops one-click

Status: **done** (2026-10-29).

## Goal

Take the automatic margin from 28 of 36 posterior exocad preps further (`2026-10-29-margin-on-real-preps.md`), and stop
one-click on the lines that are still wrong. The gate passed 6 of the 8 remaining wrong lines; the doubt warning
flagged all 8, and 1 of 28 right ones.

## What the first round left

- **Per profile, the first pick is near its ceiling.** On 87.8% of posterior profiles it lies within 0.2 mm of the
  lab's point. The best structural rule tried (skip a corner with a shallow surface before it and a wall after it, as
  a line angle has) reaches 89.1%. Relative-strength thresholds trade anterior against posterior. None is worth its
  cost on the synthetic noisy scans.
- **Most remaining misses are a line choice, not a profile choice.** The refiner traces about 20 candidate lines per
  tooth (profile counts, ring DP, ring-consistent anchors, smoothing). It picks by shape alone: passes, then the least
  wander, then the gentlest turn. A line that follows the line angle for a stretch has a perfectly good shape.
- **The ring DP prefers sharper edges** (convexity capped at 3, a 90° turn), and line angles are the sharpest.

## Scope

**In:**
1. **The doubt warning in the refiner.** On a quiet scan (`roughnessDeg` ≤ `QUIET_TURN_DEG`), candidates are ordered:
   passes; then the fewest off stretches (`marginDoubt`); then wander and turn as now. The refiner reports the winner's
   off stretches and whether the scan was quiet. It needs the scan's vertex normals (`RefineInput.normals`, optional:
   without them nothing changes).
2. **The DP's edge preference** is capped lower or removed, if the line-level numbers say so.
3. **The doubt warning in the margin gate** (`marginGate`, `apps/web/src/ai/qa.ts`): a `margin.doubt` check that fails
   on an off stretch, only when the scan was quiet. In `marginProposer` (`apps/web/src/ai/proposers.ts`), the
   finish-or-gum choice ignores that check, so a doubtful finish line on a prepped tooth stays a finish line; one-click
   still stops on it for review.

**Out:** the prep finder; front-tooth frames; the cement gap; the 1.5 mm minimum drop (short proximal walls).

## Evaluation

- **The held-out set of round one has been looked at,** so it is not held out any more. This round develops on all 36
  posterior margins, with two rules: every change has a geometric reason, and no posterior case that is right now may
  turn wrong.
- **Independent checks:** the 27 anterior margins (never tuned on), the synthetic margin evaluation (16/17 right, 3
  natural teeth rejected), the golden cases and the browser scripts.
- **The real held-out test** is the in-house cases when they arrive (`2026-10-27-inhouse-validation.md`).

## Verification plan

- **Tests:** extend `marginRefine.test.ts`, the refiner test whose natural tooth is the gate's failing case. The
  doubtful line fails `margin.doubt` on a quiet scan; the right line passes it. No new test file.
- `pnpm typecheck`, `pnpm test`, the margin evaluation, the golden cases, the exocad posterior and anterior sets, and
  the 13 offline browser scripts.

## Implementation summary

### What was built
- **The doubt warning picks the line** (`apps/web/src/geometry/marginRefine.ts`).
  - With `RefineInput.normals`, on a quiet scan, the refiner walks its candidates in the usual order.
  - It takes the first passing line with no off stretch, else the passing line with the fewest.
  - The doubt check is lazy: on a good case only the first line is checked.
  - `RefineResult` now reports `quiet` and the winner's `doubtParts`.
  - The worker passes the scan's normals and its cached triangle grid (`autoMargin` in
    `apps/web/src/workers/geometry.worker.ts`). The synthetic margin evaluation passes normals too, so it measures
    what the app does.
- **`margin.doubt` in the margin gate** (`marginGate`, `MARGIN_DOUBT_CHECK` in `apps/web/src/ai/qa.ts`). It fails on
  an off stretch. It is only present when the scan was quiet and a line passed, so one-click stops for review there.
- **The finish-or-gum choice leaves the doubt check out** (`marginProposer`, `apps/web/src/ai/proposers.ts`). A
  doubtful finish line on a prepped tooth stays a finish line, even where the prep finder misses the prep.
- **Find all margins keeps a doubt-only line** (`findMargins`, `apps/web/src/tools/autoMargins.ts`). The line is set
  and named, so its marked parts can be checked, instead of being dropped for hand tracing.
- **Not changed:**
  - the DP's edge preference: the line-level numbers gave no reason to touch it;
  - the profile rules: no structural rule paid off per profile (see "What the first round left").

### Results (local, aggregate only)

| Set | Round one | Now | Gate passes a wrong line | Gate stops a right line |
|---|---|---|---|---|
| Posterior, 36 margins | 28 right | **30 right** | 2 of 6 | 1 of 30 (042/47) |
| Anterior, 27 (never tuned on) | 12 right | **14 right** | 1 of 6 | 0 of 14 |
| Synthetic evaluation, 17 + 3 natural | 16 + 3 rejected | 16 + 3 rejected | | |

- **No case turned wrong.** Newly right: 042/45 and 045/46 (posterior), 015/12 and 033/22 (anterior). Each picked a
  doubt-free line over a shape-preferred one beside the line angle.
- **The 6 posterior misses:**
  - 049/25 and 049/26: the lab's line is off the scan's edge.
  - 044/36 and 048/34: stopped by the doubt check.
  - 044/34 and 048/44: they pass it.
    - 044/34 is a premolar on a 17 × 24 mm segment whose margin swings 5 mm in height round the tooth. The ring DP and
      the ring filter assume a slowly changing drop.
    - 048/44 is a primary telescope whose margin lies deeper than the section's 10 mm reach.
- **Time:** an automatic margin takes a median 0.26–0.29 s on the real posterior scans (0.55 s at most). On the
  synthetic jaws it takes 0.7–0.8 s on quiet scans and 1.1–1.4 s on rough ones, about 0.15 s more for the first
  doubt check on a 1M-triangle jaw.

### Deviations from the plan
- **The gate's failing case is in `qa.test.ts`'s margin gate test,** not in the refiner test. The gate is one function
  there, with its other passing and failing cases. The refiner and margin tests got one assertion each: quiet with no
  doubt on a clean scan, not quiet on a noisy one.

### Verification
- `pnpm typecheck`: green.
- `pnpm test`: 126 tests pass, 12 skipped (no new test).
  - `qa.test.ts`: the margin gate test now also passes 0 doubtful stretches and fails 2.
  - `autoMargin.test.ts`: the mirrored 46 is quiet, with no doubtful stretch.
  - `marginRefine.test.ts`: the noisy prep is not quiet.
- The synthetic golden cases with `--auto`: 15 of 15 pass.
- The synthetic margin evaluation and the exocad sets: as above.
- **Browser scripts:** all 13 offline ones pass (dev server on :5300): crown-move, ai-bridge, bridge, first-run,
  framework, ai-framework, anterior-export, offline-design, maryland, inlay, implant, ai-implant and ai-maryland.
  ai-flows and online-case need the API and were not run.

### Follow-ups
- **Margins that change height fast round the tooth** (044/34): the ring DP's drop weight and the ring filter's
  0.5 mm tolerance assume a slowly changing drop.
- **Deep margins:** the section reaches 10 mm below the prep top; a telescope's margin can lie deeper.
- **The real test:** the in-house cases, unseen by all of this tuning.
