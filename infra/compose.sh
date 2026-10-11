#!/usr/bin/env bash
# docker compose with the repo-root .env.  e.g. ./infra/compose.sh up -d --build
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$root/.env"
cd "$root"
exec docker compose --env-file "$env_file" -f "$root/infra/docker-compose.yml" "$@"
