# Web Dental CAD — 1-Week MVP Plan (single crown, AI-assist-ready, portable backend)

## Context
Goal: a browser-based dental CAD (exocad-like) whose first slice covers the 80:20 case — **a single posterior crown on a natural prep from an intraoral scan** — with an architecture that lets AI assist (Dentbird-style "one-click crown", natural-language edits, Rx intake) plug in without rewrites.

Constraints: **Claude + 1 developer, ~1 week**; **cloud SaaS self-hosted on an OCI VM** (12 vCPU, 6 GB RAM, Docker, HTTPS and networking ready); **backend must be easy to migrate** (no vendor lock-in, no Supabase); **React + TS + three.js**; AI via **Claude / OpenAI LLMs**; ~**100 in-house cases**. Greenfield repo.

Reality check:
- One week yields a **working prototype / demo**, not a clinical product (no regulatory work, de-identified data only).
- **General LLMs cannot produce clinical-precision geometry** (margins, crown surfaces at ~0.05 mm) from meshes; Dentbird uses specialized 3D models. **LLMs orchestrate and interpret; deterministic geometry (later, specialized models trained on the 100 cases + logged corrections) does the geometry.** Both sit behind the same `Proposer` contract.

## Decisions
| Area | Decision |
|---|---|
| Frontend | React + TS + Vite, plain three.js engine (not r3f), geometry in Web Workers (Comlink) |
| Backend | Node 22 + Hono, ports-and-adapters; Docker Compose on the OCI VM |
| Database | PostgreSQL 17 (container) via Drizzle ORM + committed plain-SQL migrations |
| File storage | `BlobStore` port: `fs` adapter (Docker volume) now, `s3` adapter (any S3-compatible) ready |
| Auth | Better Auth (TS library, tables in our own Postgres, organizations plugin) behind an auth middleware port |
| Jobs | In-process for MVP; `JobQueue` port (pg-boss on Postgres when needed — no Redis) |
| LLM | Browser runs the tool loop; API is a thin authenticated proxy with Anthropic + OpenAI adapters; model from config (default latest Claude, e.g. `claude-sonnet-5`) |
| Schemas | zod v4 in `packages/shared` → `z.toJSONSchema()` for LLM tools, OpenAPI, and (later) pydantic for Python |

## MVP scope
**In (posterior premolars + molars only):**
1. Case setup: FDI tooth chart, anatomic crown, material preset (zirconia, e.max) → default params.
2. Import STL/PLY (upper, lower, prep jaw); scans assumed already in occlusion.
3. Viewer: cursor-centric orbit, standard views, matcap shading, PLY colors toggle, back-face color, per-object visibility/opacity, clipping plane, color-map overlay + legend, screenshot.
4. **Tooth frame:** occlusal + mesial-distal directions, neighbour contact points (auto with 2-click override).
5. Margin line: **live-wire** (path to cursor shown live), drag points, smooth.
6. Insertion axis: auto (least-blockout search) / from view; undercut map; blockout; warn if margin is in undercut.
7. Params: cement gap, extra spacer, distance-to-margin, margin thickness, min thickness. Tool radius → **"unmillable" map only** (compensation left to CAM).
8. Library crown proposal (8 annotated templates) + gizmo with clinical axes + keyboard nudges.
9. Auto: adapt to antagonist, adapt to neighbours, enforce min thickness; color maps for each.
10. Finalize: watertight, non-self-intersecting crown → binary STL + JSON sidecar (like exocad `.constructionInfo`).
11. Undo/redo, wizard back/next, save/load (backend versions + local zip).
12. AI layer v1 (below).
13. Sculpt add/remove/smooth — **if time on Day 6**.

**Out:** bridges, implants, inlays/veneers, anteriors, articulator, auto bite alignment, OBJ textures, DICOM, production compliance.

## Frontend architecture (the extensibility core)
- **Typed document + typed commands.** UI, keyboard, orchestrator, and LLM agent all mutate state only through commands validated by zod schemas → one path for undo, replay, audit, and AI safety.
- `DesignDocument` (`packages/shared`): case info, scan refs (content-addressed: sha256 + units + frame), tooth frame, margin as **3D points (+ optional face hint)**, insertion axis, params, step status, and a **crown union**:
  `{kind:'template', templateId, pose, deform} | {kind:'mesh', meshRef}` (so an ML-generated crown fits later).
- **Undo = immutable document snapshots** (structural sharing) + a derived-geometry cache keyed by input hashes. No hand-written `invert()` per command. An agent batch = one version.
- **Step invalidation:** editing margin / axis / params re-runs intaglio → fit → adapt (sculpt deltas stored in the crown's local frame and re-applied).
- **Geometry in workers** via Comlink; always `Comlink.transfer` buffers; "latest wins" generation counters (Comlink can't cancel). Picking, gizmo, and sculpt stay on the main thread (crown is only 30–60k verts).

## AI-assist architecture (Dentbird-style, extensible)
- **`Proposer` contract** (one per step: frame, margin, axis, crown, adapt):
  async job → `{jobId, progress, cancel}`; result `{output, qa, rationale, proposerId@version, modelHash?}`. Inputs are content-addressed mesh refs with explicit frame/units, so the same contract works in-browser (`classical.*`) or over HTTP to a future Python GPU service (`ml.*`). JSON Schema is the cross-language source of truth.
- **Auto-design orchestrator ("one-click crown"):** runs proposers in order; **gates on deterministic QA checks** (closed margin, seating/no undercut at margin, min thickness, occlusal clearance, no self-intersection) — not on "confidence" (classical proposers have none). Pauses for review on failure; otherwise produces a full draft. UI shows proposals as ghost overlays → Accept / Edit / Reject.
- **LLM agent (tool loop runs in the browser):** the API only proxies provider calls with server-held keys. Tools in **tooth-local clinical terms**, each returning metrics after acting:
  - Query: `get_case_summary`, `get_design_metrics` (min clearance, contact distances, min thickness, margin length), `capture_view` (PNG, stretch).
  - Action: `move_crown {direction: mesial|distal|buccal|lingual|occlusal|cervical, mm}`, `rotate_crown {axis, deg}`, `scale_crown {axis, pct}`, `set_contact {side, targetMm}`, `adapt_occlusion {clearanceMm}`, `set_param`, `run_step`.
  - Agent output is applied as **one transaction with an Accept/Revert banner**; never direct geometry edits. Schemas normalized per provider (OpenAI strict: all properties required, nullable optionals, `additionalProperties:false`).
- **Rx intake:** paste text (photo/PDF stretch) → LLM structured output into `CaseSetup` → user confirms. Test with **synthetic** prescriptions only.
- **Data flywheel:** `ProposalEvent` stores **artifact references**, not just counts: input snapshot (scan hashes, params, app version), proposal, final accepted margin / axis / crown mesh. Backfill the 100 in-house cases into the same "training bundle" format (harvest margin/axis from exocad files if present, else derive margin from the finished crown's intaglio rim).

## Key geometry algorithms
- **Import (worker):** parse → drop degenerate/duplicate faces and tiny components → weld (exact float-bit match is enough for STL) → normals. Build BVH **once in the worker** and ship it via `MeshBVH.serialize/deserialize` (three-mesh-bvh reorders the index buffer unless `indirect: true` — never store face IDs before this). Lasso cut = face-mask bitset, compact only at export. Units mm; warn on implausible size.
- **Tooth frame:** occlusal dir = least-spread PCA axis of prep jaw, oriented toward antagonist centroid; MD dir = long PCA axis (quadrant scan) or fitted-parabola tangent (full arch). Neighbour contacts = ray-cast ±MD from margin centroid excluding prep region and gingival ring; 2-click override.
- **Margin (live-wire):** bounded single-source Dijkstra per click; edge cost = length × f(**signed convex curvature** over ~0.3 mm on smoothed normals) so it doesn't snap into the sulcus/chamfer floor. Prep region = flood fill 1–2 rings beyond the margin loop.
- **Insertion axis:** search a ~25° cone around occlusal dir for least blockout; undercut map = `dot(normal, axis)`.
- **Intaglio:** offset prep vertices along smoothed normals by `gap(d)` (0 at margin, ramp to cement gap over 0.1–0.2 mm, extra spacer beyond "distance to margin") → upper envelope by ray-casting the BVH along −axis (blocks out undercuts). **Mesh with radial profiles:** for each of N resampled margin points, ray-cast a profile toward the prep centre, resample by 3D arc length to M points (samples land on steep walls), quads + centre fan. Requires star-shaped projected margin (normal for posteriors; check and warn).
- **Unmillable map:** heightfield morphological opening with tool radius R; relief domes at sharp convex edges = stretch.
- **Library:** 8 hand-annotated templates (4 posterior types × 2 jaws), mirrored for the other side (flip winding). Each = open outer shell + cervical loop pre-resampled to fixed N + metadata (FDI, local axes, cusp tips).
- **Crown fit:** place at margin centroid in tooth frame; anisotropic scale (MD from neighbour gap, BL from margin extent, height from antagonist); match loops by **normalized arc length from a mesial start with enforced winding**; RBF deform with zero-displacement anchors on the occlusal third; re-solve on every pose change.
- **Thickness constraint (enforced, not just checked):** after fit/adapt/sculpt, push outer vertices outward to a thickness profile (margin thickness at margin → material min within ~1 mm).
- **Adapt to antagonist / neighbours:** clearance measured along axis (contacts along MD, proximal-facing upper-2/3 vertices only); smooth the **displacement field**, not positions (preserves cusps); if clearance conflicts with min thickness → stop and report "insufficient reduction".
- **Finalize:** stitch outer loop to intaglio loop with a triangle strip (same N). Validate: every edge has 2 faces, consistent orientation, signed volume > 0, **no tri–tri intersections** (BVH). manifold-3d only as a boolean repair fallback (it doesn't detect self-intersections).
- **Color maps:** worker writes a `Float32Array` scalar attribute → shader 1D LUT with uniform range; legend in React.

## Backend & deployment (portable by design)
**Rule:** domain code depends only on ports; every external system is behind an adapter selected by env var. Only open protocols: SQL (Postgres), S3 API, HTTP/JSON, OIDC-compatible sessions.

**Ports:** `Db` (Drizzle/Postgres), `BlobStore` (`fs` | `s3`), `AuthContext` (middleware → `{userId, orgId, role}`), `LLMProvider` (`anthropic` | `openai`), `JobQueue` (`inline` now | `pgboss` later), `Clock/IdGen`.

**Docker Compose services (VM):**
| Service | Image | Mem limit |
|---|---|---|
| `proxy` | Caddy (or plug into your existing HTTPS proxy) — serves web build at `/`, proxies `/api` (single origin, no CORS) | 128 MB |
| `api` | Node 22 + Hono (`--max-old-space-size=768`) | 1 GB |
| `db` | postgres:17 (`shared_buffers=512MB`) | 1.5 GB |
| `backup` | cron: nightly `pg_dump` + blob volume tarball → off-box (S3-compatible target) | 128 MB |
Headroom ≈ 3 GB for OS and a future CPU ONNX inference container. **If the VM is Ampere (ARM64), build `linux/arm64` images.** No GPU on this box → future `ml.*` proposers run on a separate GPU host behind the same HTTP job contract.

**Data model (Postgres):** `organizations`, `users`/`sessions`/`memberships` (Better Auth), `cases (id, org_id, teeth, status, current_version)`, `case_files (id, case_id, kind: upper|lower|prep|export, blob_key, sha256, bytes, content_type)`, `design_versions (case_id, version, doc jsonb, author: user|agent|proposer, parent_version)`, `proposal_events`, `llm_usage (user, provider, model, tokens_in, tokens_out)`. Every row scoped by `org_id`; enforced in the repository layer.

**API (REST, OpenAPI generated from zod):**
- `/api/auth/*` (Better Auth)
- `GET|POST /api/cases`, `GET|PATCH /api/cases/:id`
- `POST /api/cases/:id/files` (streamed upload, client gzips via `CompressionStream`, 200 MB cap), `GET /api/files/:id` (streamed)
- `POST /api/cases/:id/versions`, `GET /api/cases/:id/versions/latest`
- `POST /api/llm/messages` (SSE streaming proxy; model allowlist, per-user rate limit, usage logging; payloads carry no patient identifiers)
- `POST /api/proposal-events`
- `POST /api/jobs` (stub for future `ml.*` proposers), `GET /healthz`

Uploads stream **through the API** (not presigned URLs) so storage backends stay interchangeable; switch to presigned multipart later for scale.

**Migration path:**
| Concern | Now (OCI VM) | Later | What changes |
|---|---|---|---|
| Database | Postgres container | Any managed Postgres | `DATABASE_URL` |
| Files | `fs` volume | OCI Object Storage (S3-compat) / AWS S3 / R2 / MinIO | `BLOB_DRIVER` + creds |
| Auth | Better Auth in own DB | External OIDC (Keycloak, Auth0, Cognito…) | `AuthContext` adapter |
| Jobs | Inline | pg-boss → SQS / Cloud Tasks | `JobQueue` adapter |
| LLM | Anthropic / OpenAI | Other / self-hosted | `LLMProvider` adapter |
| Hosting | Compose on VM | k8s / ECS / Cloud Run | Same images |
| TLS | Caddy / existing proxy | Cloud load balancer | Nothing in app |

**Deployment target (confirmed):**
- VM is **aarch64** → all images run natively on `linux/arm64`.
- Public location is configurable via `PUBLIC_URL`, currently **`https://dental.cognifuze.com`** (root of its own subdomain). DNS: an A record pointing to the VM.
- Sub-path mounting is still possible (set `BASE_PATH` / `VITE_BASE_PATH` by hand; Caddy strips the prefix) but no longer derived or documented. Internally the API is always at `/api/*`.
- Nginx Proxy Manager on the VM owns the domain and TLS. Our Caddy joins the external Docker network `shared_net` as `dcad-proxy` (plain HTTP :80, no host ports); NPM forwards to `http://dcad-proxy:80`. See `specs/2026-10-11-simplify-deploy-npm.md`.
- better-auth: `baseURL = PUBLIC_URL`, `basePath = /api/auth`.

**Config:** one gitignored `.env` at the repo root (documented in `.env.example`). It is used by local dev and by Compose (`env_file`). The LLM provider is picked automatically per purpose:
1. An explicit `LLM_AGENT_PROVIDER` wins.
2. Otherwise `anthropic` if `ANTHROPIC_API_KEY` is set.
3. Otherwise `openai` if `OPENAI_API_KEY` is set.
4. Otherwise `mock`.

Models are set by `LLM_AGENT_MODEL` / `LLM_RX_MODEL` (defaults: `claude-sonnet-5` / `gpt-5`).

Deploy: on the VM, `git pull && ./infra/compose.sh up -d --build` (private repo `git@github.com:rohanakar/dental.git`, read-only deploy key). Registry + CI later.

## Repo layout (pnpm workspace)
```
apps/web/                 Vite + React + TS
  src/engine/             renderer, camera (camera-controls), matcaps, overlays, picking, clipping, colormap material
  src/geometry/           pure TS: import cleanup, frame, curvature, livewire, axis, intaglio, fit (RBF), thickness, adapt, stitch, validate
  src/workers/            geometry.worker.ts (Comlink facade)
  src/design/             document store (zustand, snapshots), commands, steps, invalidation
  src/ai/                 proposer registry, orchestrator + QA gates, agent tool loop, tool defs, proposal overlay
  src/ui/                 wizard, tooth chart, object panel, params, legend, AI panel, Rx intake
  src/io/                 STL/PLY import, STL export, sidecar JSON, project zip (fflate)
apps/api/
  src/domain/             cases, versions, files, proposal events (no infra imports)
  src/ports/              Db, BlobStore, AuthContext, LLMProvider, JobQueue interfaces
  src/adapters/           drizzle-pg, blob-fs, blob-s3, better-auth, anthropic, openai, jobs-inline
  src/http/               Hono routes, zod validation, OpenAPI
  drizzle/                SQL migrations
packages/shared/          zod schemas: DesignDocument, crown union, commands, tools, Proposer job contract, ProposalEvent
tools/pipeline-runner/    headless Node runner: golden case → metrics JSON + STL (regression, batch mode, ML backfill)
tools/library-builder/    template annotation → open shells, fixed-N cervical loops, metadata
infra/                    docker-compose.yml, Caddyfile, backup script, .env.example
```
Main libraries: `three`, `three-mesh-bvh`, `camera-controls`, `zustand`, `comlink`, `zod` (v4), `fflate`, `manifold-3d`, `hono`, `drizzle-orm`, `better-auth`, `@aws-sdk/client-s3`, `@anthropic-ai/sdk`, `openai`, `pino`, `vitest`, `@playwright/test`.

## Day-by-day (walking skeleton by Day 3)
Claude writes most code; the developer supplies data, annotates templates, does domain QA, runs deploys.

- **Day 0 (dev):** 3–5 de-identified golden cases (upper/lower/prep + exocad crown STL); confirm VM CPU arch + domain; API keys; start annotating the 8 templates (continues through Day 3).
- **Day 1 — Foundations:** monorepo; shared schemas; backend skeleton (Compose: proxy/api/db, Drizzle migrations, Better Auth with orgs, cases + streamed file upload via `blob-fs`, LLM proxy stub) **deployed to the VM**; web: worker import pipeline (cleanup, weld, BVH serialize), renderer (matcap, cursor orbit, standard views, object panel).
- **Day 2 — Setup, frame, margin, axis:** tooth chart + material presets; tooth frame + neighbour contacts; live-wire margin; axis cone search + undercut map; headless pipeline runner over golden fixtures.
- **Day 3 — Walking skeleton:** intaglio (offset + envelope + radial mesh); rigid template placement; stitch + validate; STL export → verified in a slicer; color-map material + legend.
- **Day 4 — Fit + feedback:** RBF fit with arc-length loop matching + anisotropic scale; thickness projection; color maps (occlusion, contacts, thickness, undercut, unmillable); gizmo with clinical axes + nudges; snapshot undo + step invalidation.
- **Day 5 — Adapt + persist:** adapt antagonist/neighbours with conflict report; full export validation (tri–tri, signed volume) + sidecar; save/load versions to backend + local zip; backup container.
- **Day 6 — AI layer:** `classical.*` proposers behind the async job contract; orchestrator with QA gates + proposal overlays; browser tool loop via proxy, clinical-term tools, Accept/Revert transactions; Rx text intake; ProposalEvent artifact logging. Sculpt add/remove/smooth if time.
- **Day 7 — Verify + ship:** golden-case regression via headless runner; browser smoke E2E; perf pass; redeploy; demo script. Buffer.

**Most likely to slip:** intaglio correctness, fit without intersections, agent preview UX.
**Cut order if behind:** sculpt → section outlines → lasso → Rx photo/PDF → `capture_view` → backend version history (keep auth + file upload + local zip).

## Post-MVP AI roadmap (same `Proposer` contract)
1. Python inference service (FastAPI + PyTorch/ONNX) exposing `ml.*` proposers as HTTP jobs; pydantic models generated from shared JSON Schema; GPU host separate from the VM.
2. Tooth segmentation: pretrain on public **Teeth3DS / 3DTeethSeg'22**, fine-tune on in-house bundles → automatic frame/neighbours/antagonist.
3. Margin detection model (in-house cases + logged corrections) → true one-click.
4. Crown generation model (Dentbird-style, outputs `{kind:'mesh'}` crowns), then batch mode via the pipeline runner.
5. Before real patient data: BAAs / zero-retention terms with LLM and cloud vendors, de-identification before LLM calls, medical-device regulatory path (FDA 510(k) / EU MDR).

## Library gotchas
- three-mesh-bvh: build in worker, serialize to main thread; index reorder (see Import).
- camera-controls: `setOrbitPoint` on pointerdown for cursor-centric orbit; disable while dragging TransformControls.
- manifold-3d: load wasm via Vite `?url`; booleans only, not validation.
- zod v4: use built-in `z.toJSONSchema()` (zod-to-json-schema targets v3).
- Large scans: gzip before upload; Node streams end-to-end in the API (never buffer whole files in 1 GB API memory).

## Verification
- **Geometry unit (vitest):** weld/cleanup counts; live-wire path continuity; intaglio gap measured **along the surface normal on axial walls** within ±0.01 mm; no undercut (single hit per ray along axis); crown closed manifold + consistent orientation + signed volume > 0 + no tri–tri intersections; outer-to-intaglio ≥ thickness profile everywhere.
- **Headless golden-case regression (pipeline runner, CI):** each case → STL + metrics JSON; Hausdorff mean/max vs the exocad crown; thresholds fail the build.
- **Browser smoke E2E (Playwright):** upload → margin (scripted clicks) → axis → proposal → adapt → export downloads a valid STL.
- **Backend:** `BlobStore` contract tests run against **both** `fs` and `s3` (MinIO test container) adapters; API integration tests against Postgres; org isolation test (org A cannot read org B's case/files); streamed 100 MB upload stays under API memory limit.
- **Portability drill:** restore last night's backup onto a fresh VM/compose stack and open a case end-to-end.
- **Perf:** 1M-tri arch loads < 3 s, orbits at 60 fps on a mid-range laptop; color map update < 100 ms during adapt.
- **AI:** mocked-LLM tool-loop tests (zod-validated calls, one-transaction Accept/Revert); provider schema normalization tests (Anthropic + OpenAI strict); Rx extraction on 10 synthetic prescriptions; ProposalEvent written with artifact refs for every accepted/edited proposal.
- **Manual:** developer opens exported STLs in a slicer/Meshmixer (and exocad if available) and judges fit and anatomy on each golden case.

## Progress log
**Day 1: done (2026-10-03)**
- `packages/shared`: zod schemas (document, crown union, commands → LLM tools, Proposer job contract, ProposalEvent, LLM wire format, REST DTOs). 6 tests.
- `apps/web`: STL/PLY import worker (parse, cleanup, weld, normals, BVH serialized from the worker), imperative three.js viewer (cursor-centric orbit, standard views on a PCA view frame, matcaps, back-face colour, opacity, ortho toggle, screenshot), object panel, synthetic fixtures. 28 tests. A 1M-triangle scan processes in about 0.5 s in Node and about 1 s in the browser.
- `apps/api` + `infra`: Hono API with ports/adapters (Postgres/Drizzle, blob fs/s3, Better Auth + orgs, Anthropic/OpenAI/mock LLM with strict-schema normalization), streamed uploads with sha256 verification, optimistic version saves, Compose stack (Caddy, api, Postgres) for arm64, `compose.sh`/`deploy.sh`, README for dental.cognifuze.com. 36 tests (18 unit + 18 integration against Postgres + SeaweedFS).
- Deviations:
  - S3 contract tests use SeaweedFS (the `minio/minio` image is gone from Docker Hub).
  - The LLM proxy is non-streaming (SSE later).
  - OpenAPI generation and the backup container are deferred (backup is Day 5).
  - Web ↔ API integration (login, upload to a case) is not wired yet; it moves to Day 2.

**2026-10-11: deploy simplified for Nginx Proxy Manager.** `compose.sh` is a plain `exec docker compose` wrapper, `deploy.sh` and the TLS override are gone, `proxy` joins external `shared_net` as `dcad-proxy`, `.env.example` trimmed to the keys you set. Code pushed to private GitHub repo `rohanakar/dental`. See [2026-10-11-simplify-deploy-npm.md](2026-10-11-simplify-deploy-npm.md).

**Day 2: done (2026-10-11).** Case setup, tooth frame, live-wire margin, insertion axis + undercut map, document store with undo, colour maps, web↔API (auth, cases, uploads, versions), pipeline runner, browser E2E scripts. See [day-02-setup-frame-margin-axis.md](day-02-setup-frame-margin-axis.md).

**Day 3: done (2026-10-11).** Intaglio (gap ramp, blockout envelope, radial profiles), procedural crown templates, placement with quadrant mirroring, cervical blend + margin band → closed crown, validation, STL + construction-info export, derived crown in the UI, pipeline crown checks. See [day-03-walking-skeleton.md](day-03-walking-skeleton.md).

**Day 4: done (2026-10-11).** RBF fit, thickness enforcement, crown colour maps (thickness, occlusion, proximal, unmillable), clinical move/rotate/scale commands, translate gizmo + nudge pad + keyboard. See [day-04-fit-and-feedback.md](day-04-fit-and-feedback.md).

**Day 5: done (2026-10-11).** Occlusion/contact adaptation with conflict reports (stored as targets, crown re-derived), self-intersection check (printable), `.dcad.zip` project files, nightly backup service with a verified restore drill. See [day-05-adapt-and-persist.md](day-05-adapt-and-persist.md).

**Day 6: done (2026-10-11).** Design-store transactions, classical proposers incl. automatic margin, QA-gated one-click auto-design (Accept/Reject), LLM agent tool loop with metrics, Rx intake (LLM + classical parser), ProposalEvent logging. Sculpt cut. See [day-06-ai-layer.md](day-06-ai-layer.md).

**2026-10-14: test cleanup.** Cut the suite to core-only tests: 8 files deleted, 32 trimmed, 267 → 96 tests (incl. infra and live-API tests), 4172 → 2459 lines. Part 2 (crown, reducer, QA, RBF, nudge) ran after the crown-move commit 8f34013. Testing conventions added to `CLAUDE.md` so the suite stays small. See [2026-10-14-test-cleanup.md](2026-10-14-test-cleanup.md).

**2026-10-14: crown moves after a proposal.** A move no longer re-adapts silently: adaptation applies only while the
Adapt step is done, with Re-adapt one click away. Open contacts fail QA. Every move previews instantly and exactly
(per-vertex move weights from the fit), with no snap-back. Edits accept a pending draft first, so undo works. Focus
view: the prep stays bright, the surroundings are dimmed, and the crown is design blue. See
[2026-10-14-crown-move-after-proposal.md](2026-10-14-crown-move-after-proposal.md).

**2026-10-25: UX critique and polish.** An impeccable critique scored the editor 24/40. Colour maps are now neutral at contact with the material minimum marked; Finalize leads with a ready-to-mill checklist from the QA gates and a soft export gate; one-click drafts are reviewed with the crown on screen and every gate listed; contrast, focus, field and type tokens give a sharper instrument look. +2 tests. See [2026-10-25-ux-critique-polish.md](2026-10-25-ux-critique-polish.md).
