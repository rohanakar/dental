# Test cleanup: fewer, core-only tests

Status: **done** (2026-10-14). Part 1 covered 34 files; part 2 covered the 6 files deferred until the crown-move
commit 8f34013 landed.

## Goal

The suite had grown to 267 tests (247 run by `pnpm test`), many of them checking colour stops, label and message
strings, file-name heuristics, timings, or internals that a higher-level test already covers. The user wants a small
suite that guards the core behaviour only.

## Scope

In: every test file. Part 1 skipped the seven listed below; part 2 did six of them after 8f34013.

Deferred to part 2 (still being edited by the open crown-move work, see
[2026-10-14-crown-move-after-proposal.md](2026-10-14-crown-move-after-proposal.md)):
`apps/web/src/geometry/crown.test.ts`, `apps/web/src/design/reducer.test.ts`, `apps/web/src/ai/qa.test.ts`,
`apps/web/src/geometry/rbf.test.ts`, `apps/web/src/tools/nudge.test.ts`, `apps/web/src/geometry/prepRegion.test.ts`,
`apps/web/src/engine/matcap.test.ts`. Editing them now would collide with that session. Apply the same criteria
once that work is committed.

Out: no production code changes, and no changes to test helpers (`testMeshes.ts`, `testUtils.ts`, `synthetic.ts`,
`apps/api/test/helpers.ts`), which the pipeline runner and the kept tests still use.

## Criteria

Keep a test when it guards a core behaviour that nothing else covers:
- scan import (STL, PLY, cleanup, units), tooth frame and FDI handedness, margin, prep region and insertion axis,
  the crown (validity, fit, thickness, adaptation), export;
- the design document (commands, staleness, undo, transactions);
- the AI flows (orchestrator accept/reject, agent tool loop, Rx intake, proposal events);
- the API (auth, org isolation, upload integrity, optimistic versions, the LLM proxy and adapters).

For a detector, keep one positive and one negative case, so a stub that always answers "none" fails.

Drop a test when it:
- checks cosmetics: colours, gradients, labels, messages, file-name role guesses, key bindings;
- measures timing or performance (the 1M-triangle import, the 24k-triangle validation);
- tests an internal that a kept higher-level test already exercises (quaternion math, Dijkstra, polylines,
  curvature, normals, the thickness profile on its own);
- repeats a case with different parameters (other resolutions, all four template kinds checked six ways);
- covers an edge-case format or error path (big-endian PLY, `-0` welding, every malformed-zip message);
- tests a stub (the orchestrator's `ProposalResult` check ran against the mock proposer).

Kept tests drop `console.info` timing lines and assertions on label or message text.

## Plan per file

| File | Before | After | Kept |
|---|---|---|---|
| `packages/shared/src/shared.test.ts` | 6 | 1 | tool call → validated command |
| `tools/pipeline-runner/src/pipeline.test.ts` | 2 | 1 | end-to-end synthetic 36 with the automatic margin |
| `apps/api/test/llm-adapters.test.ts` | 14 | 6 | Anthropic and OpenAI translation (one each), strict schemas for every tool, provider choice, rate limiter, DATABASE_URL |
| `apps/api/test/blob-store.contract.test.ts` | 5×2+1 | 3×2+1 | round trip, missing → null, failed upload stores nothing, key escape |
| `apps/api/test/api.integration.test.ts` | 13 | 8 | 401, sign-up/org, cases, gzip upload/download, bad uploads leave nothing, org isolation, versions, LLM proxy |
| `apps/web/src/api/client.test.ts` | 6 | 2 | gzip upload, error mapping (404 → null, 409 details, network/5xx unavailable) |
| `apps/web/src/api/client.e2e.test.ts` | 2 | 1 | case flow against a live API |
| `apps/web/src/state/session.test.ts` | 6 | 3 | open a new case, open the latest version, save with parent version |
| `apps/web/src/ai/agent.test.ts` | 7 | 4 | tool call → command in a draft, invalid input, max turns, revert |
| `apps/web/src/ai/orchestrator.test.ts` | 5 | 3 | accept path, failed gate + reject, edits logged on save |
| `apps/web/src/ai/events.test.ts` | 4 | 2 | queued offline and retried, local documents never sent |
| `apps/web/src/ai/rx.test.ts` | 15 | 5 | 3 notations (FDI + ref, Palmer, quadrant words) with anterior rejection, LLM tool use, fallback |
| `apps/web/src/ai/metrics.test.ts` | 3 | 1 | map minima split by side |
| `apps/web/src/io/projectZip.test.ts` | 4 | 2 | round trip, checksum mismatch rejected |
| `apps/web/src/workers/scanPayload.test.ts` | 4 | 1 | BVH built in the worker works on the main thread |
| `apps/web/src/geometry/stl.test.ts` | 5 | 2 | binary (incl. a "solid" header) and ASCII parse, weld |
| `apps/web/src/geometry/ply.test.ts` | 4 | 2 | ASCII with quads and colours, binary round trip |
| `apps/web/src/geometry/processScan.test.ts` | 6 | 2 | STL import, unit warnings |
| `apps/web/src/geometry/cleanup.test.ts` | 6 | 1 | full cleanup |
| `apps/web/src/geometry/meshValidate.test.ts` | 6 | 2 | closed cube accepted, defects rejected |
| `apps/web/src/geometry/selfIntersect.test.ts` | 3 | 1 | none on a cube, found on overlapping cubes |
| `apps/web/src/geometry/toothFrame.test.ts` | 2 | 2 | handedness, frame on the synthetic prep |
| `apps/web/src/geometry/livewire.test.ts` | 4 | 1 | live-wire on the synthetic prep |
| `apps/web/src/geometry/autoMargin.test.ts` | 3 | 1 | mirrored 46 case (the pipeline test covers 36) |
| `apps/web/src/geometry/axis.test.ts` | 3 | 3 | synthetic prep (no undercut), bulbous prep (undercut found), tilted prep (axis tilts) |
| `apps/web/src/geometry/adapt.test.ts` | 4 | 2 | occlusal reduction, proximal contact |
| `apps/web/src/geometry/crownMaps.test.ts` | 6 | 1 | signed clearance |
| `apps/web/src/geometry/crownTemplate.test.ts` | 25 | 1 | every template closes into a valid solid |
| Deleted: `clinical`, `colormap`, `files`, `surface`, `axisTool`, `thickness`, `exportCrown` | 20 | 0 | covered by the reducer, crown, STL and pipeline tests, or cosmetic |

## Verification plan

- `pnpm typecheck` and `pnpm test` pass.
- `pnpm --filter @dcad/api test:infra` passes against the Docker test stack, since the integration suite is
  sequential and later tests use ids from earlier ones.
- Record the test counts and the run time before and after.

## Implementation summary

What changed (tests only; no production code, helpers or config touched):
- Deleted 7 files: `apps/web/src/design/clinical.test.ts`, `apps/web/src/engine/colormap.test.ts`,
  `apps/web/src/ui/files.test.ts`, `apps/web/src/geometry/surface.test.ts`, `apps/web/src/tools/axisTool.test.ts`,
  `apps/web/src/geometry/thickness.test.ts`, `apps/web/src/io/exportCrown.test.ts`.
- Trimmed the other 27 in-scope files to the tests in the plan table. Where two kept checks guarded one behaviour they
  were merged into one test: STL binary + ASCII, the three validation defects, self-intersection none/found, the
  Anthropic and OpenAI request + response mappings, provider selection, DATABASE_URL, and the four crown templates.
- Removed from kept tests: `console.info` timing lines, timing assertions (auto-margin anchors < 2 s), and assertions
  on label or message text (the agent's transaction label, the assistant's tool list, Rx notes, the proposal-event
  error text, the session's save warning, the project manifest). Error-reason checks stay where they prove *why*
  something was rejected (`/checksum/` on a tampered project).
- `autoMargin.test.ts` now runs only the mirrored 46 case; the pipeline runner test runs 36 with the automatic margin.

Deviations from the plan: none in the counts. The deleted files held 20 tests, not 22 as first written.

Verification (2026-10-14):
- `pnpm typecheck`: all 5 packages pass.
- `pnpm test`: shared 1, api 10 (+11 skipped without infra), web 111 (+1 skipped live-API e2e), pipeline runner 1.
  All pass. Wall time 6.8 s.
- `pnpm --filter @dcad/api test:infra`: 3 files, 21 tests pass against the Docker test stack (was 38).

| | Before | After |
|---|---|---|
| Tests in the 34 in-scope files | 199 | 68 |
| Whole suite after part 1 (incl. infra and live-API tests) | 267 | 135 |
| Lines in test files after part 1 | 4172 | 2802 |
| Pipeline runner test time | 2.1 s | 1.2 s |

## Part 2: the deferred files

The crown-move session committed 8f34013 and handed the files over. `prepRegion.test.ts` was dropped by that session
and never committed. Cuts (the Follow-ups list in part 1 estimated about 19; the listed cuts add up to 29, and the
result is 28):

| File | Before | After | Kept |
|---|---|---|---|
| `apps/web/src/geometry/crown.test.ts` | 26 | 10 | per handedness: closed printable solid; seats on the prep (ring on the margin, cement gap, no intaglio undercut); thickness incl. the shrunk crown. 36 only: adaptation, insufficient reduction, cusps move while the margin stays, open contact after a move |
| `apps/web/src/design/reducer.test.ts` | 23 | 11 | scan replacement, downstream staleness, setup sync, immutability, undo batch, dirty tracking, two transaction tests, move/rotate/scale per handedness (merged), adaptation targets + Re-adapt (merged) |
| `apps/web/src/ai/qa.test.ts` | 7 | 3 | margin gate, stride-based turn measure, axis/crown/adapt gates |
| `apps/web/src/geometry/rbf.test.ts` | 5 | 2 | exact interpolation, multi-field equals single field |
| `apps/web/src/tools/nudge.test.ts` | 5 | 2 | accepts a pending auto-design first, refuses edits while it runs |
| `apps/web/src/engine/matcap.test.ts` | 1 | 0 | deleted (colour only) |

Dropped in part 2: the cement-gap unit test, "material above the intaglio" (the validity and thickness tests cover
it), the colour-map layout test, the move-weight preview test, the separate self-intersection count (the validation
already reports it), adaptation for the mirrored case, the `CROWN_TEST_NOTES` hook, the gizmo-delta and key-binding
tests, the assistant-draft duplicate of the auto-design edit test, scan step bookkeeping, wrong-tooth and
precondition errors, `setParam`, the duplicate batch-undo test, affine reproduction, RBF smoothness and singular
systems, and message-text assertions (QA check messages, tool messages, the transaction error).

Verification (2026-10-14, after part 2):
- `pnpm typecheck`: all 5 packages pass.
- `pnpm test`: shared 1, api 10 (+11 skipped without infra), web 72 (+1 skipped live-API e2e), pipeline runner 1.
  All pass. Wall time 5.8 s; the web suite takes 3.4 s, of which `crown.test.ts` is 3.2 s.
- `pnpm --filter @dcad/api test:infra`: 21 tests pass (no API test changed in part 2).

| | Before | After |
|---|---|---|
| Whole suite (incl. infra and live-API tests) | 267 | 96 |
| Test files | 42 | 33 |
| Lines in test files | 4172 | 2459 |

## Part 3: testing conventions in CLAUDE.md

Goal: keep the suite from growing back. Turn the criteria above into standing rules in `CLAUDE.md` (a "Tests"
section), so every task applies them without rereading this spec.

Scope: `CLAUDE.md` only. The rules are the Criteria section, plus a budget: a feature adds 1–3 tests, a bug fix
extends the closest existing test, a file stays at about 10 tests, and the spec names the tests to add and reports
the count change.

Verification: read the section back against the Criteria; no code or test changes, so no test run.

Result: `CLAUDE.md` has a "Tests" section (what to test, what not to, one test per behaviour, detector cases,
parameters, assertions, budget, speed). It matches the Criteria section above.

## Follow-ups

- None for this task. `crown.test.ts` still dominates the run time (two synthetic crowns per handedness plus extra
  `designCrown` calls); sharing one synthetic run per handedness across the describe blocks would cut it further if
  the suite gets slow.
