#!/usr/bin/env bash
# Run the full API test suite (incl. Postgres + S3 integration) against
# throwaway containers from infra/docker-compose.test.yml.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
compose=(docker compose -f "$here/../../infra/docker-compose.test.yml")
"${compose[@]}" up -d --wait
code=0
TEST_INFRA=1 npx vitest run "$@" || code=$?
"${compose[@]}" down -v
exit $code
