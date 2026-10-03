#!/usr/bin/env bash
# docker compose wrapper: uses the repo-root .env for interpolation and derives
# BASE_PATH / VITE_BASE_PATH from PUBLIC_URL unless they are set explicitly.
#
#   ./infra/compose.sh up -d --build
#   ./infra/compose.sh -f infra/docker-compose.tls.yml up -d --build
#   ./infra/compose.sh logs -f api
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$root/.env"
if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file (copy .env.example and fill it in)" >&2
  exit 1
fi

# Read one KEY from .env without sourcing it (values may contain shell metacharacters).
env_value() {
  grep -E "^[[:space:]]*$1=" "$env_file" | tail -n 1 | sed -E "s/^[[:space:]]*$1=//; s/^['\"]//; s/['\"]$//"
}

public_url="$(env_value PUBLIC_URL || true)"
public_url="${public_url:-http://localhost:8080}"
# https://example.com/dental/ -> /dental ; https://dental.cognifuze.com -> ""
derived_path="$(printf '%s' "$public_url" | sed -E 's#^[a-zA-Z]+://[^/]+##; s#/+$##')"

if [[ -z "$(env_value BASE_PATH || true)" && -z "${BASE_PATH:-}" ]]; then
  export BASE_PATH="$derived_path"
fi
if [[ -z "$(env_value VITE_BASE_PATH || true)" && -z "${VITE_BASE_PATH:-}" ]]; then
  export VITE_BASE_PATH="${derived_path}/"
fi

# Fail fast on missing secrets when starting the stack.
if [[ " $* " == *" up "* ]]; then
  for key in POSTGRES_PASSWORD AUTH_SECRET; do
    if [[ -z "$(env_value "$key" || true)" ]]; then
      echo "$key is empty in $env_file" >&2
      exit 1
    fi
  done
fi

cd "$root"
exec docker compose --env-file "$env_file" -f "$root/infra/docker-compose.yml" "$@"
