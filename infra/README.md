# Deployment: single VM with Docker Compose

Production target: **https://dental.cognifuze.com** on an OCI VM (**aarch64 / ARM64**, 12 vCPU, 6 GB RAM).
**Nginx Proxy Manager** (NPM) on the VM owns the domain and TLS. Our stack serves plain HTTP to it over the shared
Docker network `shared_net`. Everything is plain Docker Compose with open protocols (SQL, S3 API, HTTP), so the stack
can move to another VM or cloud by changing configuration only (see [Migration path](#migration-path)).

| Service | Image | Role | Memory limit |
|---|---|---|---|
| `proxy` | `caddy:2` + built SPA (`infra/proxy.Dockerfile`) | Serves the web app, proxies `/api/*` to `api`. On `shared_net` as `dcad-proxy` | 128 MB |
| `api` | `node:22-slim` (`infra/api.Dockerfile`) | Hono API: auth, cases, files, versions, LLM proxy | 1 GB (`--max-old-space-size=768`) |
| `db` | `postgres:17` (`shared_buffers=512MB`) | All data incl. auth tables | 1.5 GB |

Roughly 3 GB is left for the OS, NPM and a future CPU inference container. No service publishes a host port.

**ARM64:** all base images (`node:22-slim`, `postgres:17`, `caddy:2`) are multi-arch, and
`docker compose up --build` on the VM builds native `linux/arm64` images.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | The stack. `proxy` joins the external network `shared_net` |
| `docker-compose.dev.yml` | Override: publish Postgres on the host for local development |
| `docker-compose.test.yml` | Throwaway Postgres + S3 (SeaweedFS) for API integration tests |
| `compose.sh` | `docker compose --env-file .env -f infra/docker-compose.yml "$@"`, nothing else |
| `api.Dockerfile`, `proxy.Dockerfile` (+ `.dockerignore`s) | Images; build context is the repo root |
| `Caddyfile` | SPA + `/api` routing, cache headers |

## Configuration: one `.env` at the repo root

All configuration and secrets live in **`/<repo>/.env`** (gitignored). Start from
[`.env.example`](../.env.example):

```dotenv
PUBLIC_URL=https://dental.cognifuze.com
# hex only: the password is embedded in DATABASE_URL
POSTGRES_PASSWORD=<output of: openssl rand -hex 24>
AUTH_SECRET=<output of: openssl rand -base64 48>
# and/or OPENAI_API_KEY; with neither, the LLM proxy uses the offline mock
ANTHROPIC_API_KEY=...
```

`./infra/compose.sh` passes the file to Compose for interpolation, and the `api` container also loads it via
`env_file`. Every other key is optional; defaults live in `apps/api/src/config.ts`. An empty `POSTGRES_PASSWORD`
stops Postgres from starting, and an `AUTH_SECRET` under 32 characters stops the API.

LLM selection per purpose: an explicit `LLM_AGENT_PROVIDER` / `LLM_RX_PROVIDER` wins; otherwise
Anthropic if `ANTHROPIC_API_KEY` is set, else OpenAI if `OPENAI_API_KEY` is set, else `mock`.
Default models: `claude-sonnet-5` (Anthropic), `gpt-5` (OpenAI); override with `LLM_AGENT_MODEL` /
`LLM_RX_MODEL`.

## First deployment on the VM

1. **DNS:** an `A` record `dental.cognifuze.com` → the VM's public IP.
2. **Docker:** Docker Engine with Compose v2.24+. The network must exist and NPM must be attached to it:
   `docker network create shared_net` (once), with `shared_net` as an external network in NPM's compose file.
3. **Code:** the repo is private on GitHub. Add a read-only deploy key, then clone:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/dcad_deploy -N ""   # add the .pub under the repo's Settings → Deploy keys
   GIT_SSH_COMMAND="ssh -i ~/.ssh/dcad_deploy" git clone git@github.com:rohanakar/dental.git ~/dcad
   git -C ~/dcad config core.sshCommand "ssh -i ~/.ssh/dcad_deploy"
   ```
4. **Config:** `cd ~/dcad && cp .env.example .env` and fill it in.
5. **Start:**
   ```bash
   ./infra/compose.sh up -d --build
   ./infra/compose.sh ps          # all three services healthy
   ```
   Migrations run automatically when the API starts (`MIGRATE_ON_START=true`).
6. **NPM proxy host:** domain `dental.cognifuze.com`, scheme `http`, forward host `dcad-proxy`, port `80`.
   Turn on *Websockets Support*. On the SSL tab request a Let's Encrypt certificate and enable *Force SSL*.
   Scans are large, so under *Advanced* add:
   ```nginx
   client_max_body_size 250m;
   proxy_request_buffering off;
   proxy_buffering off;
   proxy_read_timeout 300s;
   proxy_send_timeout 300s;
   ```
   Then open https://dental.cognifuze.com and sign up. Each new user gets a personal organization (lab).

**Deploy a new version:** `cd ~/dcad && git pull && ./infra/compose.sh up -d --build`.

## Operations

```bash
./infra/compose.sh logs -f api                      # JSON logs (pino)
./infra/compose.sh exec api node dist/migrate.js    # run migrations manually
git pull && ./infra/compose.sh up -d --build        # deploy a new version
./infra/compose.sh down                             # stop (volumes are kept)
```

**Backups.** The `backup` service runs `infra/backup/backup.sh`. Every night at `BACKUP_HOUR` (UTC, default 3) it
writes `dcad-<timestamp>.dump` (`pg_dump -Fc`) and `blobs-<timestamp>.tgz` (the blob volume) to `BACKUP_DIR` on the
host (default `/var/backups/dcad`, outside the git checkout) and deletes backups older than `BACKUP_KEEP_DAYS`
(default 14).

```bash
./infra/compose.sh logs backup                                   # "wrote dcad-….dump … next backup in …s"
ls -lh /var/backups/dcad
./infra/compose.sh run --rm -e BACKUP_ONCE=1 backup              # take a backup now
```

These backups live on the VM's own disk. Copy them off the VM (e.g. to OCI Object Storage) on a schedule;
an automated S3 upload is a follow-up.

Restore (drops and recreates the database objects, replaces the blob volume):

```bash
./infra/compose.sh stop api
./infra/backup/restore.sh /var/backups/dcad/dcad-<ts>.dump /var/backups/dcad/blobs-<ts>.tgz
./infra/compose.sh start api
```

Manual one-off backup without the service:

```bash
mkdir -p ~/backups
./infra/compose.sh exec -T db pg_dump -U dcad -Fc dcad > ~/backups/dcad-$(date +%F).dump
docker run --rm -v dcad_blobs:/blobs -v ~/backups:/out alpine tar czf /out/blobs-$(date +%F).tgz -C /blobs .
```

**Schema changes:** edit `apps/api/src/adapters/db/schema.ts`, run `pnpm --filter @dcad/api db:generate`,
commit the new `apps/api/drizzle/*.sql`. Auth tables come from `pnpm --filter @dcad/api auth:schema`.

## Switching file storage to OCI Object Storage (S3 compatibility)

1. Create a bucket (e.g. `dcad-blobs`) and a **Customer Secret Key** (Identity → your user → Customer secret keys).
2. In `.env`:
   ```dotenv
   BLOB_DRIVER=s3
   S3_ENDPOINT=https://<namespace>.compat.objectstorage.<region>.oraclecloud.com
   S3_REGION=<region, e.g. ap-mumbai-1>
   S3_BUCKET=dcad-blobs
   S3_ACCESS_KEY_ID=<secret key id>
   S3_SECRET_ACCESS_KEY=<secret key>
   S3_FORCE_PATH_STYLE=true
   ```
3. Copy existing blobs (object keys are the same relative paths, `orgs/<org>/cases/<case>/<file>`):
   `aws s3 sync /var/lib/docker/volumes/dcad_blobs/_data s3://dcad-blobs --endpoint-url "$S3_ENDPOINT"`
4. `./infra/compose.sh up -d`. The same adapter works for AWS S3 (omit `S3_ENDPOINT`), Cloudflare R2 and MinIO.

The `BlobStore` contract tests run against both the `fs` and `s3` adapters, so switching is configuration-only.

## Migration path

| Concern | Now (this VM) | Later | What changes |
|---|---|---|---|
| Database | Postgres container | Any managed Postgres | `DATABASE_URL` (compose `environment`) |
| Files | `fs` volume | OCI Object Storage / AWS S3 / R2 / MinIO | `BLOB_DRIVER` + `S3_*` |
| Auth | Better Auth, tables in our Postgres | External OIDC provider | `AuthPort` adapter in `apps/api/src/adapters/auth` |
| Jobs | Inline stub (501) | pg-boss → SQS / Cloud Tasks | `JobQueue` adapter |
| LLM | Anthropic / OpenAI / mock | Other / self-hosted | `LlmProvider` adapter |
| Hosting | Compose on one VM | k8s / ECS / Cloud Run | Same images |
| TLS | Nginx Proxy Manager | Cloud load balancer | Nothing in the app |

## Local development

```bash
cp .env.example .env
# in .env: PUBLIC_URL=http://localhost:5173, TRUSTED_ORIGINS=http://localhost:5173,
#          POSTGRES_PASSWORD / DATABASE_URL matching, AUTH_SECRET, BLOB_FS_ROOT=./data/blobs
./infra/compose.sh -f infra/docker-compose.dev.yml up -d db   # Postgres on 127.0.0.1:5432
pnpm dev:api    # http://localhost:3000 (reads ../../.env)
pnpm dev:web    # http://localhost:5173 (proxies /api to :3000)
```

Production-like stack on http://localhost:8080 (set `PUBLIC_URL=http://localhost:8080`; `docker network create shared_net` once):
`./infra/compose.sh -f infra/docker-compose.dev.yml up -d --build`.

Tests:

```bash
pnpm --filter @dcad/api test         # unit tests (integration suites skip)
pnpm --filter @dcad/api test:infra   # starts docker-compose.test.yml, runs everything, tears it down
```

## Troubleshooting

- **`network shared_net declared as external, but could not be found`:** `docker network create shared_net`.
- **502 from NPM:** NPM isn't on `shared_net`, or `proxy` isn't running (`./infra/compose.sh ps`). Check with
  `docker network inspect shared_net`.
- **413 on scan upload:** add `client_max_body_size` in the NPM proxy host's *Advanced* tab (and/or raise `MAX_UPLOAD_BYTES`).
- **`Invalid origin` / sign-in fails:** `PUBLIC_URL` must match what the browser uses (scheme + host);
  add dev origins to `TRUSTED_ORIGINS`.
