#!/usr/bin/env bash
# Sync the repo to the VM and (re)start the stack there.
#
#   DEPLOY_HOST=ubuntu@<vm-ip> ./infra/deploy.sh
#   DEPLOY_HOST=ubuntu@<vm-ip> DEPLOY_COMPOSE_ARGS="-f infra/docker-compose.tls.yml" ./infra/deploy.sh
#
# The VM keeps its own $DEPLOY_DIR/.env (never synced from your machine).
set -euo pipefail

: "${DEPLOY_HOST:?set DEPLOY_HOST, e.g. ubuntu@203.0.113.10}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/dcad}"
DEPLOY_COMPOSE_ARGS="${DEPLOY_COMPOSE_ARGS:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> syncing $root to $DEPLOY_HOST:$DEPLOY_DIR"
ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_DIR'"
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'data/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --include '.env.example' \
  "$root/" "$DEPLOY_HOST:$DEPLOY_DIR/"

echo "==> building and starting containers on $DEPLOY_HOST"
ssh "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && test -f .env || { echo 'Create $DEPLOY_DIR/.env first (see .env.example)'; exit 1; } \
  && ./infra/compose.sh $DEPLOY_COMPOSE_ARGS up -d --build --remove-orphans \
  && ./infra/compose.sh $DEPLOY_COMPOSE_ARGS ps"
