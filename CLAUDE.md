# DentalCAD (dcad)

Browser-based dental CAD for a single posterior crown, built so AI assist can plug in later. The master plan is
`specs/plan.md`. Read it before starting work.

## Specs workflow (required for every task)

Every task gets a spec in `specs/`, so the project history can be read in order.

1. **Before you write code**, write or extend the spec for the task. Cover the goal, the scope (in and out), the
   design and interfaces, and how you will verify it.
2. **Implement** the task.
3. **After you finish**, add an "Implementation summary" section to the same spec. Cover what was built, where it
   lives, deviations from the spec (and why), verification results (test counts, commands run, numbers measured),
   and follow-ups. Then add one line to the progress log at the end of `specs/plan.md`.

File naming:
- Plan days: `specs/day-NN-<slug>.md` (e.g. `specs/day-02-setup-frame-margin-axis.md`).
- Work outside a plan day: `specs/YYYY-MM-DD-<slug>.md`.
- `specs/README.md` is the index. Add every new spec to it.

Specs record decisions and outcomes, not code. Link to files (`apps/web/src/geometry/livewire.ts`) instead of
pasting their contents.

## Layout

pnpm workspace (Node 22, pnpm 9). See `specs/plan.md` for the full tree.
- `packages/shared`: zod v4 schemas: DesignDocument, commands, LLM tools, Proposer contract, REST DTOs.
- `apps/web`: Vite + React + plain three.js. `src/geometry` is pure TS (no DOM) and is also used by Node tools.
- `apps/api`: Hono, ports-and-adapters (Postgres/Drizzle, blob fs/s3, Better Auth, Anthropic/OpenAI/mock).
- `tools/pipeline-runner`: headless golden-case runner. `tools/fixtures`: synthetic scan generator.
- `infra/`: Docker Compose stack for the OCI VM (arm64). `documentation/`: HTML design docs.
- `data/` is gitignored. Scans and golden cases never go into git.

## Commands

```bash
pnpm typecheck                        # all packages
pnpm test                             # unit tests (API integration tests skip without TEST_INFRA=1)
pnpm --filter @dcad/api test:infra    # API integration tests against Postgres + SeaweedFS in Docker
pnpm dev:web / pnpm dev:api           # local dev (web proxies /api to :3000)
pnpm --filter @dcad/pipeline-runner run   # headless golden-case run
```

## Conventions

- All geometry is in millimetres. Tooth frames follow FDI quadrant handedness (see `geometry/toothFrame.ts`).
- Document state changes only through validated commands (`packages/shared/src/commands.ts`), applied by the reducer
  in `apps/web/src/design`. Never mutate the document directly.
- Geometry algorithms take plain typed arrays plus small interfaces (for example a `RayCaster`), so they run in
  workers, the browser and Node tests unchanged.
- Domain code in the API depends only on ports. Every external system sits behind an adapter selected by env var.
- Use synthetic or de-identified data only.
