# Day 6: AI layer (proposers, one-click orchestrator, LLM agent, Rx intake, proposal events)

Status: **done** (2026-10-11).

## Goal

The AI-assist layer from the plan, built on the deterministic Days 2–5:
- **One-click crown.** After a single click on the prep, `classical.*` proposers run frame → margin → axis → crown →
  adapt. Each step is gated by deterministic QA checks. The result is a draft the user accepts or rejects as one
  edit; on a QA failure it pauses at the failing step.
- **LLM agent.** Natural-language edits ("0.3 mm shorter, tighter mesial contact") run as a browser tool loop over the
  clinical-command tools, through the API proxy. Each action returns metrics, and the whole run is applied as one
  transaction with an Accept/Revert banner.
- **Rx intake.** A pasted prescription becomes a `CaseSetup` through the LLM (structured tool output), with a
  deterministic parser as fallback and cross-check. The user confirms before anything is applied.
- **Data flywheel.** Accepted, edited and rejected proposals are logged as `ProposalEvent`s with artifact references.

## Scope

In:
1. **Design-store transactions** (`design/store.ts`):
   - `beginTransaction({ label, author })`, then dispatches update `doc` live with no history entries.
   - `commitTransaction()` makes one undo entry and records `lastAuthor` (`agent` | `proposer`) for the next saved
     version. `rollbackTransaction()` restores the base document.
   - Undo/redo are blocked while a transaction is open. Saving uses `lastAuthor`.
2. **Crown evaluation hooks** (`tools/crownTool.ts`):
   - `settled()` resolves once the derived crown matches the current document.
   - `evaluate(maps)` computes a crown + maps for the current document without touching the display.
3. **Proposers** (`ai/proposers.ts`): `Proposer { id, step, run(ctx) → Promise<ProposalResult> }`, matching the shared
   contract (`output`, `qa[]`, `rationale`). Implementations:
   - `classical.frame-seed@1`: tooth frame from the seed click.
   - `classical.margin-ridge@1`: **automatic margin**, new.
     - Radial height profiles around the prep are sampled from above. On each one, the anchor is the most convex
       ridge below the axial wall drop.
     - 16 anchors feed the live-wire `marginFromAnchors`. Runs in the worker.
   - `classical.axis-least-undercut@1`.
   - `classical.template-crown@1`.
   - `classical.adapt@1`: occlusion + contacts from the params.
4. **QA gates:**
   - margin: closed, length 8–60 mm, smooth (no turn sharper than 120° after resampling);
   - axis: 0 margin points in undercut, angle ≤ 25°;
   - crown: valid + printable, thickness ≥ min − 0.02;
   - adapt: no conflicts.
5. **Orchestrator** (`ai/orchestrator.ts`):
   - It runs the proposers in order inside one transaction, waiting for the derived crown at each step.
   - It stops at the first failed gate with the failing checks.
   - It exposes the state `{ running, steps: [{ step, proposerId, qa, status }] }`.
   - Accept → commit and log `accepted` events. Reject → roll back and log `rejected`. On Save, accepted proposals
     whose step output was changed are logged as `edited` with `finalAccepted`.
6. **LLM agent** (`ai/agent.ts`):
   - System prompt: tooth-frame clinical vocabulary, units in mm, rules (one change at a time, check metrics, stop
     when done).
   - Tools: `agentToolDefs()`. The query tools are `get_case_summary`, `get_design_metrics` (min occlusal
     clearance, mesial/distal contact, min thickness, margin length, printable, conflicts) and `capture_view` (not
     supported yet; returns a tool error).
   - Action tools go through `commandFromToolCall`. A validation error is returned to the model as `isError`.
   - Each tool result carries the post-action metrics. The loop is bounded to 12 turns and runs inside a
     transaction.
   - Chat UI with an Accept/Revert banner. Offline: disabled with a note (it needs the API proxy).
7. **Rx intake** (`ai/rx.ts`):
   - `extractRxWithLlm(text)`: purpose `rx-intake`, a forced `submit_case_setup` tool with the `CaseSetup` JSON
     schema.
   - `parseRxClassical(text)`: regex/keyword parser for FDI numbers, materials, shade and notes.
   - The confirm form is in the Setup step. Mock or unavailable LLM → classical result. A disagreement between the
     two is highlighted.
   - Tested on 10 synthetic prescriptions (no patient data).
8. **Events** (`ai/events.ts`): `ProposalEvent` with `inputSnapshot {scanHashes, params, appVersion, docVersion}`,
   `proposal` (json artifact), `finalAccepted`, `action`, `editsCount` and `durationMs`. Posted to
   `/api/proposal-events` when a case is open; kept in memory offline.
9. **Pipeline:** an `auto` mode runs the margin-ridge proposer instead of scripted anchors on synthetic-36 and checks
   its deviation from the analytic margin.

Out: sculpt (cut; the plan's cut order puts it first), `capture_view` images, SSE streaming, `ml.*` proposers (the
contract is ready).

## Verification plan

- Unit:
  - Transactions: commit is one undo entry, rollback restores, undo is blocked while open, author recorded.
  - Auto-margin on synthetic 36/46: mean deviation < 0.15 mm from the analytic ring.
  - QA gates: pass on the synthetic case, fail on a degraded one (open margin, tilted axis).
  - Orchestrator with stub proposers: stop on gate failure, rollback on reject.
  - Agent loop with a scripted fake LLM: a tool call → command → metrics → end; invalid input → `isError`; turn
    limit.
  - Rx: 10 synthetic prescriptions with the classical parser (exact FDI/material/shade), plus LLM path parsing with
    a fake response.
  - Events payload schema-valid.
- Pipeline: auto margin passes the deviation check.
- Browser:
  - One click on the prep → Auto-design → draft crown, QA all green → Accept → one undo entry.
  - Online with the mock LLM: `/tool move_crown {...}` in chat → crown moves → Accept. Rx paste → classical parse →
    confirm.
  - Proposal events stored (API check).

## Work split

- Main session: spec, transactions + crown hooks (seams), integration, E2E, summary.
- Fork A: proposers + auto margin (worker), QA gates, orchestrator, events, the Auto-design UI, pipeline auto mode.
- Fork B: agent loop + metrics, Rx intake (LLM + classical parser + 10 synthetic Rx), assistant chat UI and Rx UI,
  the API client `llm()` / `postProposalEvent()`.

## Implementation summary

### What was built
- **Main session (seams).**
  - `design/store.ts` transactions: `beginTransaction`/`commitTransaction`/`rollbackTransaction`; `lastAuthor` is
    saved as the version author; undo and redo are blocked while one is open.
  - `session.save` refuses to save during an open transaction and records the author.
  - `crownTool.settled()` / `evaluate(maps)`; worker client `designCrownUnlatched`.
  - One-click arming: `toolStore.autoArmed` plus the Frame-step checkbox, and `frameTool` runs `runAutoDesign({seed})`
    on the click.
  - Wiring for AutoDesign (Frame and Proposal steps), the AssistantPanel (Proposal and Adapt steps), RxIntake (Setup
    step), event flushing on save and open, and the dev debug hooks.
  - `vite.config.ts`: `DCAD_API_TARGET` overrides the proxy target, so tests can run their own API.
- **Fork A** (proposers + orchestrator).
  - `geometry/autoMargin.ts`: radial height profiles from above. The anchor is the first strong convex slope change
    past a ≥ 1.5 mm drop; it stops on a rise (neighbour). 16 anchors feed the live-wire. Worker `autoMargin`.
  - `ai/qa.ts`: margin, axis, crown and adapt gates.
  - `ai/proposers.ts`: `classical.frame-seed@1`, `margin-ridge@1`, `axis-least-undercut@1`, `template-crown@1`,
    `adapt@1`, each returning `ProposalResult`-valid output `{commands, artifact}`.
  - `ai/orchestrator.ts` (`useOrchestrator`, `runAutoDesign`, `accept`, `reject`, `recordEditsOnSave`).
  - `ai/events.ts` (`ProposalEvent` queue → `/api/proposal-events`).
  - `ui/ai/AutoDesign.tsx`.
  - Pipeline `--auto` runs a second pass with the auto margin.
- **Fork B** (agent + Rx).
  - `ai/metrics.ts`: `designMetrics()`, the clinical metrics from crown maps.
  - `ai/prompts.ts`.
  - `ai/agent.ts`: tool loop over `agentToolDefs()`. Query tools; action tools through `commandFromToolCall`. Errors
    go back to the model as `isError`. Metrics follow each action. At most 8 actions and 12 turns. The transaction
    opens on the first valid action. `useAssistant` store.
  - `ai/rx.ts`: `parseRxClassical` (FDI, Palmer shorthand, "lower left 6", materials, VITA shades, references; never
    names) and `extractRxWithLlm` (forced `submit_case_setup` tool, falling back to the classical reader on mock,
    error or invalid output, with a field-level diff).
  - `ui/ai/AssistantPanel.tsx`, `ui/ai/RxIntake.tsx`; `api/client.ts` `llm()` + `postProposalEvent()`.

### Deviations from the spec
- **Auto-margin scoring** uses profile slope change instead of vertex curvature (the curvature is negative on sliver
  triangles at the margin edge). It takes the first convex peak that reaches half the profile's maximum: a diagonal
  profile otherwise picked interdental gum.
- **Two extra unlatched calls** (`estimateFrameUnlatched`, `axisUnlatched`), so the interactive tools' "latest wins"
  calls cannot cancel an orchestrator run.
- **The assistant and the LLM Rx reader need an open backend case** (proxy session). Offline, Rx uses the classical
  reader and the assistant is hidden.
- **Sculpt is cut**, as the plan's cut order says. `capture_view` returns "not supported yet".

### Bugs found by the browser run and fixed
- **Margin smoothness gate too strict.** On the 1M-triangle scan the gate rejected an accurate auto margin (0.057 mm
  mean deviation): vertex-snapping jitter between 0.2 mm segments looked like kinks. `sharpestTurnDeg` now measures
  between chords over about 0.6 mm. A doubled-back 1 mm spike still fails. Regression tests added.
- **Proposal events stored up to 5×.** Each `logProposalEvent` started its own flush over the same queue. The flush
  is now single-flight (overlapping calls schedule one more pass). Regression test: 5 overlapping events → exactly 5
  POSTs.

### Verification
- **Unit:** `pnpm test`: 6 shared, 208 web (2 skipped), 20 API unit (+18 integration with `TEST_INFRA`), 2 pipeline.
  Typecheck clean; build OK.
  - `src/ai`: 40 tests. Transactions, 2. Rx: 15 tests including 10 synthetic prescriptions, matched exactly.
  - Agent: 7 tests (scripted fake LLM: tool → command → metrics; error results; turn limit; questions-only; revert).
  - Orchestrator: 5 tests with stub proposers.
  - Auto-margin: 36 / mirrored 46 at 0.090 mm mean at test resolution.
- **Pipeline:** `pnpm pipeline --auto` passes both cases (scripted and auto margin). Auto margin on the 1M-triangle
  synthetic: 0.048 mm mean / 0.125 mm max, a little better than the 0.055 mm scripted anchors.
- **Browser** (`tools/e2e/ai-flows.mjs`; API on :3100 with the mock LLM, Vite on :5175):
  - **Rx:** "monolithic zirconia crown on #36, shade A3.5, Ref: AI-0001" → `{36, zirconia, A3.5, AI-0001}` → applied.
  - **One-click crown:** one click on the prep runs frame → margin → axis → crown → adapt in **2.5 s**, all gates
    pass, auto-margin deviation 0.057 mm mean. Accept → **1** undo entry with author `proposer`; steps through adapt
    are done.
  - **Assistant:** `/tool move_crown {"fdi":36,"direction":"buccal","mm":0.3}` → the tool result reads "occlusal
    clearance 0.04 mm, mesial 0.02, distal 0.02, min thickness 1.02" → Accept → pose moved **0.3000 mm** buccal,
    author `agent`.
  - **Save:** version 1 has author `agent`. The database has exactly one `accepted` event per step plus
    `proposal|edited`, because the assistant changed the accepted crown.
  - Offline and online regression scripts still pass (adapt, project zip, gizmo, nudges, export, reopen, conflict).

### Follow-ups
- **Real LLM runs.** `.env` has no valid keys. The `pnpm dev:api` running in the user's terminal on :3000 used an
  OpenAI key from the shell environment, and OpenAI rejected it (401). Plain-English agent edits and LLM Rx extraction
  need a valid `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
- **Main bundle size.** The main chunk is 1.218 MB (> 1.2 MB warning). Code-split the AI panels and three addons in
  the Day 7 perf pass.
- **Auto-design computes each crown step twice** (gate + display), about 0.5 s each on 1M triangles.
- `capture_view` (PNG tool results), SSE streaming, `ml.*` proposers over the existing job contract.
