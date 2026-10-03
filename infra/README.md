# Deployment: single VM with Docker Compose

Production target: **https://dental.cognifuze.com** on an OCI VM (**aarch64 / ARM64**, 12 vCPU, 6 GB RAM).
Everything is plain Docker Compose with open protocols (SQL, S3 API, HTTP), so the stack can move to
another VM or cloud by changing configuration only (see [Migration path](#migration-path)).

| Service | Image | Role | Memory limit |
|---|---|---|---|
| `proxy` | `caddy:2` + built SPA (`infra/proxy.Dockerfile`) | Serves the web app, proxies `/api/*` to `api` | 128 MB |
| `api` | `node:22-slim` (`infra/api.Dockerfile`) | Hono API: auth, cases, files, versions, LLM proxy | 1 GB (`--max-old-space-size=768`) |
| `db` | `postgres:17` (`shared_buffers=512MB`) | All data incl. auth tables | 1.5 GB |

Roughly 3 GB is left for the OS and a future CPU inference container.

**ARM64:** all base images (`node:22-slim`, `postgres:17`, `caddy:2`) are multi-arch, and
`docker compose up --build` on the VM builds native `linux/arm64` images. To build elsewhere for
the VM, use `docker buildx build --platform linux/arm64 ...`.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | The stack (default mode: plain HTTP on `127.0.0.1:8080` behind your HTTPS proxy) |
| `docker-compose.tls.yml` | Override: Caddy terminates TLS itself on 80/443 |
| `docker-compose.dev.yml` | Override: publish Postgres on the host for local development |
| `docker-compose.test.yml` | Throwaway Postgres + S3 (SeaweedFS) for API integration tests |
| `compose.sh` | Wrapper: uses the repo-root `.env`, derives `BASE_PATH`/`VITE_BASE_PATH` from `PUBLIC_URL`, checks secrets |
| `deploy.sh` | rsync the repo to the VM and `compose up --build` there |
| `api.Dockerfile`, `proxy.Dockerfile` (+ `.dockerignore`s) | Images; build context is the repo root |
| `Caddyfile` | SPA + `/api` routing, optional sub-path stripping, cache headers |

## Configuration: one `.env` at the repo root

All configuration and secrets live in **`/<repo>/.env`** (gitignored). Start from
[`.env.example`](../.env.example), which documents every key. Minimum for production:

```dotenv
PUBLIC_URL=https://dental.cognifuze.com
# hex only: the password is embedded in DATABASE_URL
POSTGRES_PASSWORD=<output of: openssl rand -hex 24>
AUTH_SECRET=<output of: openssl rand -base64 48>
# and/or OPENAI_API_KEY; with neither, the LLM proxy uses the offline mock
ANTHROPIC_API_KEY=...
```

Always run Compose through `./infra/compose.sh` (it passes `--env-file .env` for interpolation; the
`api` container also loads `.env` via `env_file`). Equivalent manual form:
`docker compose --env-file .env -f infra/docker-compose.yml ...` (then set `BASE_PATH`/`VITE_BASE_PATH` yourself
if you use a sub-path).

LLM selection per purpose: an explicit `LLM_AGENT_PROVIDER` / `LLM_RX_PROVIDER` wins; otherwise
Anthropic if `ANTHROPIC_API_KEY` is set, else OpenAI if `OPENAI_API_KEY` is set, else `mock`.
Default models: `claude-sonnet-5` (Anthropic), `gpt-5` (OpenAI); override with `LLM_AGENT_MODEL` /
`LLM_RX_MODEL`. The chosen provider/model is logged at startup (keys never are).

## First deployment on the VM

1. **DNS:** create an `A` record `dental.cognifuze.com` → the VM's public IP.
2. **Docker:** Docker Engine with Compose **v2.24+** (`docker compose version`).
3. **Code:** `git clone` the repo to `/opt/dcad`, or from your machine run
   `DEPLOY_HOST=ubuntu@<vm-ip> ./infra/deploy.sh` (it rsyncs and starts the stack, but never copies `.env`).
4. **Config:** on the VM, `cp .env.example .env` and fill it in (see above).
5. **Start:**
   ```bash
   cd /opt/dcad
   ./infra/compose.sh up -d --build
   ./infra/compose.sh ps                       # all three services healthy
   curl -s http://127.0.0.1:8080/api/healthz   # {"ok":true}
   ```
   Migrations run automatically when the API starts (`MIGRATE_ON_START=true`).
6. **Expose it** with one of the two modes below, then open https://dental.cognifuze.com and sign up.
   Each new user gets a personal organization (lab); all data is scoped to it.

### Mode A (default): behind your existing HTTPS reverse proxy

Our Caddy listens on plain HTTP at `HTTP_BIND=127.0.0.1:8080` (`SITE_ADDRESS=:80`). Point your
existing proxy at it. Example nginx config (TLS certificates managed as you already do, e.g. certbot):

```nginx
# In the http {} context (once):
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 80;
    server_name dental.cognifuze.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name dental.cognifuze.com;

    ssl_certificate     /etc/letsencrypt/live/dental.cognifuze.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dental.cognifuze.com/privkey.pem;

    # Intraoral scans are large; the API enforces its own limit (MAX_UPLOAD_BYTES, default 200 MB).
    client_max_body_size 250m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # WebSocket-safe (future live features)
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Stream scan uploads/downloads instead of spooling them to disk
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

### Mode B: our Caddy terminates TLS

Only if **nothing else on the VM owns ports 80/443**. In `.env`:

```dotenv
PUBLIC_URL=https://dental.cognifuze.com
SITE_ADDRESS=dental.cognifuze.com
```

Open ports 80 and 443 in the OCI security list / NSG and the VM firewall, then:

```bash
./infra/compose.sh -f infra/docker-compose.tls.yml up -d --build
```

Caddy obtains and renews Let's Encrypt certificates automatically (stored in the `caddy_data` volume).

### Optional: serving under a sub-path

The root deployment above is the primary setup. To mount the app at e.g. `https://example.com/dental`
instead, set `PUBLIC_URL=https://example.com/dental` and rebuild (`compose.sh` derives
`BASE_PATH=/dental` for Caddy and `VITE_BASE_PATH=/dental/` for the web build). Forward the
prefix unchanged from your proxy (`location /dental/ { proxy_pass http://127.0.0.1:8080; ... }`, same
headers as above). Caddy strips `/dental`, the API keeps serving `/api/*`, and auth cookies are scoped
to `Path=/dental`.

## Operations

```bash
./infra/compose.sh logs -f api                      # JSON logs (pino)
./infra/compose.sh exec api node dist/migrate.js    # run migrations manually
./infra/compose.sh up -d --build                    # deploy a new version (or ./infra/deploy.sh)
./infra/compose.sh down                             # stop (volumes are kept)
```

**Backups (manual until the backup container lands):**

```bash
./infra/compose.sh exec -T db pg_dump -U dcad -Fc dcad > dcad-$(date +%F).dump
docker run --rm -v dcad_blobs:/blobs -v "$PWD":/out alpine tar czf /out/blobs-$(date +%F).tgz -C /blobs .
```

Copy both off the VM (e.g. to OCI Object Storage). Restore: `pg_restore -U dcad -d dcad --clean` and untar into the
`dcad_blobs` volume.

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
| TLS | nginx (Mode A) or Caddy (Mode B) | Cloud load balancer | Nothing in the app |

## Local development

```bash
cp .env.example .env
# in .env: PUBLIC_URL=http://localhost:5173, TRUSTED_ORIGINS=http://localhost:5173,
#          POSTGRES_PASSWORD / DATABASE_URL matching, AUTH_SECRET, BLOB_FS_ROOT=./data/blobs
./infra/compose.sh -f infra/docker-compose.dev.yml up -d db   # Postgres on 127.0.0.1:5432
pnpm dev:api    # http://localhost:3000 (reads ../../.env)
pnpm dev:web    # http://localhost:5173 (proxies /api to :3000)
```

Tests:

```bash
pnpm --filter @dcad/api test         # unit tests (integration suites skip)
pnpm --filter @dcad/api test:infra   # starts docker-compose.test.yml, runs everything, tears it down
```

## Troubleshooting

- **413 on scan upload:** raise `client_max_body_size` in nginx (and/or `MAX_UPLOAD_BYTES`).
- **`Invalid origin` / sign-in fails:** `PUBLIC_URL` must match what the browser uses (scheme + host
  [+ sub-path]); add dev origins to `TRUSTED_ORIGINS`.
- **Cookies not sent under a sub-path:** check that `PUBLIC_URL` includes the sub-path and the web was
  rebuilt (`up -d --build`) so `VITE_BASE_PATH` matches.
