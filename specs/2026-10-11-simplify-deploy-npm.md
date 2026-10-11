# 2026-10-11: Simplify deploy scripts, sit behind Nginx Proxy Manager

## Goal

Cut the deployment tooling down to the bare minimum. The VM already runs Nginx Proxy Manager (NPM), which owns the
domain (e.g. `dental.cognifuze.com`) and TLS, so our stack only needs to serve plain HTTP to NPM over a shared
Docker network. The code now lives in a private GitHub repo (`git@github.com:rohanakar/dental.git`), so deploys are
`git pull` + `compose up` on the VM instead of an rsync script.

## Scope

In:
- `infra/compose.sh`: a few lines that `exec docker compose --env-file "$root/.env" -f "$root/infra/docker-compose.yml" "$@"`.
  No `PUBLIC_URL` parsing, no secret checks.
- Delete `infra/deploy.sh` (replaced by `git pull` on the VM).
- Delete `infra/docker-compose.tls.yml` (NPM terminates TLS).
- `infra/docker-compose.yml`: the `proxy` service publishes no host port. It joins NPM's external Docker network
  `shared_net` (`external: true`, created once on the VM) with the alias `dcad-proxy`; NPM forwards to `http://dcad-proxy:80`.
- `.env.example`: only the keys someone actually sets, with short comments.
- `infra/README.md`, `documentation/deployment.html`, `specs/plan.md`: describe the new flow.

Out:
- Sub-path mounting stays possible (Compose still passes `BASE_PATH` / `VITE_BASE_PATH` through, Caddy still strips
  the prefix), but nothing derives them any more and the docs no longer cover it.
- No change to the API, the web app, the Dockerfiles, or the test compose file.

## Design

- Secrets: an empty `POSTGRES_PASSWORD` already stops the `postgres` image from starting, and an `AUTH_SECRET`
  shorter than 32 chars fails the API's zod config. The wrapper doesn't repeat those checks.
- Network: NPM and our `proxy` share one external network. `api` and `db` stay on the project's default network only,
  so NPM can reach only the web/proxy container.
- Local dev (`-f infra/docker-compose.dev.yml up -d db`) must not need the NPM network to exist.

## Verification

- `docker compose config` renders for the base file and the dev override.
- `--dry-run up -d db` with the dev override succeeds without the external network.
- `pnpm typecheck` unaffected (no TS changes).
- `grep` finds no remaining references to `deploy.sh`, `docker-compose.tls.yml`, or the derived-path behaviour.

## Implementation summary

Built:
- `infra/compose.sh`: 4 effective lines, `cd` to the repo root and `exec docker compose --env-file .env -f infra/docker-compose.yml "$@"`.
- `infra/deploy.sh` and `infra/docker-compose.tls.yml` deleted.
- `infra/docker-compose.yml`: `proxy` has no `ports`. It is on `default` plus the external network `shared_net`, with the alias
  `dcad-proxy`. `SITE_ADDRESS` is gone. `api` and `db` are only on the default network.
- `infra/Caddyfile`: site address is a fixed `:80`.
- `.env.example`: 6 keys (`PUBLIC_URL`, `POSTGRES_PASSWORD`, `AUTH_SECRET`, both LLM keys). Dev and optional keys are
  listed commented out.
- Docs: `infra/README.md` (NPM proxy host settings, deploy key + `git clone`, `git pull` deploys, troubleshooting),
  `documentation/deployment.html`, `primer.html`, `architecture.html`, `backend.html`, `decisions.html` (ADR 016),
  `glossary.html`, and `specs/plan.md`.

Deviations:
- The network is a fixed name, `shared_net` (`external: true`), as the user asked, not `PROXY_NETWORK`.
- `infra/docker-compose.dev.yml` also publishes `proxy` on `127.0.0.1:8080`. Without this, the stack can't be reached
  locally, now that the base file publishes nothing.
- The `change-me` secret check is gone. `.env.example` now ships empty secrets. Postgres refuses an empty password, and
  zod refuses an `AUTH_SECRET` under 32 characters.

Verification:
- `docker compose config -q`: passed for the base file and for the base file plus the dev override.
- `--dry-run up -d db` with the dev override starts only `db` and does not need `shared_net`.
- A full `up` without the network fails with `network npm_default declared as external, but could not be found`. That
  was checked before the rename to `shared_net`; the same error now names `shared_net`. `shared_net` exists on the dev
  machine, so the full dry run passes there.
- `bash -n infra/compose.sh`: passed. `pnpm typecheck`: passed (no TS changes).
- `grep` for `deploy.sh|HTTP_BIND|SITE_ADDRESS|tls.yml|Mode A/B` hits only the Day 1 history entries and this spec.

Follow-ups:
- On the VM, NPM's compose file must also list `shared_net` as an external network.
- Not yet checked on the VM itself: an NPM → `dcad-proxy` request, and an upload through NPM with the *Advanced* snippet.
