# 2026-10-11: `${POSTGRES_PASSWORD}` in DATABASE_URL

Status: **done**.

## Problem
`pnpm dev:api` failed with `Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"`. The real cause was
`password authentication failed`: the local `.env` still had the literal `<POSTGRES_PASSWORD>` placeholder in
`DATABASE_URL`.

Writing `${POSTGRES_PASSWORD}` there does not help on its own, for two reasons:
- Node's `--env-file` does not expand variables.
- Compose does expand them, but it does not URL-encode, so passwords with `@ : / #` break the URL.

## Change
- `apps/api/src/config.ts` `resolveDatabaseUrl`:
  - `${NAME}` references in `DATABASE_URL` are replaced with the URL-encoded value of `NAME`. An unset variable is
    a clear error.
  - Without `DATABASE_URL`, the URL is built from `POSTGRES_USER/PASSWORD/HOST/PORT/DB` (defaults
    `dcad/127.0.0.1/5432/dcad`).
- `infra/docker-compose.yml`: the api's `DATABASE_URL` uses `$${POSTGRES_PASSWORD}`. The reference reaches the
  container unexpanded and the API encodes it. `POSTGRES_PASSWORD` comes from `env_file`.
- `.env.example` documents the default and the `${POSTGRES_PASSWORD}` form. The local `.env` now uses
  `DATABASE_URL=postgres://dcad:${POSTGRES_PASSWORD}@127.0.0.1:5432/dcad`.

## Verification
- New tests:
  - the password `p@ss:w/rd!` expands to `p%40ss%3Aw%2Frd!`;
  - an unset reference throws;
  - the URL derived from `POSTGRES_*` is correct.
- API: 20 unit tests pass and typecheck is clean.
- `pnpm dev:api` against the local `dcad-db-1` applies the migrations, and `/healthz` returns `{"ok":true}`.
- `docker compose config` renders the escaped reference.
