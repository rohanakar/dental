# Day 1: Foundations

Status: **done** (2026-10-03). Commits `af5968d`, `9b8f6a0`. This spec was written after the fact (2026-10-11) from the
plan, the commits and the code, so the history starts at Day 1.

## Goal

Build the foundation for every later day. That means a monorepo with shared contracts, a backend that runs on the OCI
VM, and a web viewer that imports real-size intraoral scans quickly.

## Scope

In:
- pnpm monorepo (`apps/web`, `apps/api`, `packages/shared`, `tools/*`).
- Shared zod schemas for the design document, commands, LLM tools, the Proposer job contract, ProposalEvent, the LLM
  wire format, and REST DTOs.
- Backend skeleton: Hono with ports and adapters, Postgres via Drizzle, Better Auth with organizations, cases, streamed
  file upload, versions, LLM proxy, Compose stack, deploy script.
- Web: worker import pipeline (parse, weld, cleanup, normals, BVH) and an imperative three.js viewer.

Out (moved later): web↔API integration (Day 2), OpenAPI generation, SSE streaming for the LLM proxy, backup container
(Day 5).

## Design

### Shared contracts (`packages/shared/src`)
- `geometry.ts`: `Vec3`, `Quat`, `Pose`, `Sha256`, and `MeshRef`. A MeshRef is content-addressed (sha256, optional
  fileId) with explicit units (`mm`) and frame (`scan` | `tooth-local`).
- `case.ts`: FDI numbers (posterior = positions 4-8), `Material`, `DesignParams`, `MATERIAL_PRESETS`, `CaseSetup`
  (pseudonymous `patientRef`, never a name).
- `design.ts`: `DesignDocument` → `ToothDesign` (params, frame, margin, axis, crown union `template | mesh`, step
  statuses), `STEP_ORDER`, `downstreamSteps()`.
- `commands.ts`: document commands (`setCaseSetup`, `addScan`, `setFrame`, `setMargin`, `setAxis`, `setParams`,
  `setCrown`) and clinical commands (`moveCrown`, `rotateCrown`, `scaleCrown`, `setContact`, `adaptOcclusion`,
  `setParam`, `runStep`).
- `tools.ts`: LLM agent tools are generated from the clinical command schemas (`z.toJSONSchema`). Query tools are
  `get_case_summary`, `get_design_metrics` and `capture_view`.
- `proposer.ts`: `ProposerId` (`classical|ml|llm.<name>@<ver>`), `ProposalInput`/`ProposalResult`, QA checks, job
  status.
- `events.ts`: `ProposalEvent` stores artifact references (json or mesh), not just counts.
- `llm.ts`: provider-agnostic messages, tool definitions and responses.
- `api.ts`: REST DTOs (cases, files, versions, `Me`, `ApiError`).

### Web (`apps/web/src`)
- `geometry/`: pure TS (no DOM). STL (binary/ASCII) and PLY parsers and writers, weld (exact float-bit match),
  cleanup (degenerate and duplicate faces, small components), area-weighted normals, PCA, the synthetic arch
  generator (lower jaw has a crown prep at FDI 36), and `processScan()`.
- `workers/`: a Comlink geometry worker. It builds the three-mesh-bvh BVH **in the worker** and ships it serialized.
  The BVH-ordered index is canonical. Buffers are transferred, not copied. `LatestWins` generation counters discard
  superseded results.
- `engine/`: an imperative `Viewer` with on-demand rendering, camera-controls cursor-centric orbit, standard views on
  a PCA-estimated arch `ViewFrame`, matcaps, back-face tint, opacity, perspective/orthographic, screenshot, and BVH
  raycast.
- `state/`: a zustand scene store plus `sceneController`, which holds the non-serializable geometry outside the store.
- `ui/`: toolbar, scan import (drag and drop, role assignment from file names), object panel, "Load demo scans".

### API (`apps/api/src`)
- Ports: `AuthPort`, `BlobStore`, `Repositories`, `LlmProvider`, `JobQueue`.
- Adapters: Drizzle/Postgres, blob `fs` and `s3`, Better Auth (email/password + organizations, every user gets a
  personal lab), Anthropic, OpenAI, OpenAI-strict schema normalization, mock LLM, inline jobs, in-memory rate limit.
- Routes: `/api/auth/*`, `/api/me`, cases CRUD, `POST /api/cases/:id/files` (streamed, optional gzip, sha256
  verified), `GET /api/files/:id` (streamed with `Content-Encoding`), versions with optimistic concurrency,
  `/api/llm/messages`, `/api/proposal-events`, `/api/jobs` stub, `/healthz`.
- All rows are scoped by `org_id` in the repository layer.

### Infra (`infra/`)
Caddy proxy (serves the web build and proxies `/api`), api and Postgres 17 containers for `linux/arm64`. `compose.sh`
reads the root `.env`. `deploy.sh` rsyncs to `~/dcad` and runs `docker compose up -d --build`. Public URL:
`https://dental.cognifuze.com` (sub-path mounting supported via `PUBLIC_URL`/`BASE_PATH`).

## Verification (as recorded)

- `packages/shared`: 6 tests.
- `apps/web`: 28 tests. A 1M-triangle scan processes in about 0.5 s in Node and about 1 s in the browser, BVH
  included.
- `apps/api`: 36 tests (18 unit + 18 integration against Postgres + SeaweedFS).
- Re-checked on 2026-10-11: `pnpm typecheck` clean; `pnpm test` gives 6 + 28 + 18 passed (18 integration skipped
  without `TEST_INFRA=1`).

## Deviations

- S3 contract tests use SeaweedFS (the `minio/minio` image is gone from Docker Hub).
- The LLM proxy is non-streaming (SSE later).
- OpenAPI generation and the backup container are deferred (backup is Day 5).
- Web↔API integration (login, upload to a case) moved to Day 2.
- After the commits: `infra/compose.sh` rejects the example `change-me` secrets, and the README says to keep backups
  outside `~/dcad` (rsync `--delete`). These were uncommitted on 2026-10-11.
