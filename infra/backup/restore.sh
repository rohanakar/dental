#!/bin/sh
# Restore a backup written by backup.sh. Run on the VM from the repo root:
#
#   ./infra/compose.sh stop api                       # nothing writes while restoring
#   ./infra/backup/restore.sh /var/backups/dcad/dcad-<ts>.dump /var/backups/dcad/blobs-<ts>.tgz
#   ./infra/compose.sh start api
#
# The dump is restored into the running `db` service with pg_restore --clean --if-exists
# (existing objects are dropped first). The blob tarball replaces the contents of the
# blob volume. Either argument may be "-" to skip that part.
#
# Overrides (used by the restore drill, not needed on the VM):
#   DB_EXEC       command that runs a program inside the database container with stdin attached
#                 (default: ./infra/compose.sh exec -T db)
#   PGUSER, PGDATABASE   (default: POSTGRES_USER / POSTGRES_DB from the environment, else dcad)
#   BLOBS_VOLUME  Docker volume holding the blobs (default: dcad_blobs, Compose project "dcad")
set -eu

dump="${1:-}"
blobs="${2:-}"
if [ -z "$dump" ]; then
  echo "usage: $0 <dcad-*.dump | -> [<blobs-*.tgz | ->]" >&2
  exit 2
fi

DB_EXEC="${DB_EXEC:-./infra/compose.sh exec -T db}"
USER_NAME="${PGUSER:-${POSTGRES_USER:-dcad}}"
DB_NAME="${PGDATABASE:-${POSTGRES_DB:-dcad}}"
VOLUME="${BLOBS_VOLUME:-dcad_blobs}"

if [ "$dump" != "-" ]; then
  [ -f "$dump" ] || { echo "no such dump: $dump" >&2; exit 1; }
  echo "restoring database $DB_NAME from $dump"
  # shellcheck disable=SC2086
  $DB_EXEC pg_restore -U "$USER_NAME" -d "$DB_NAME" --clean --if-exists --no-owner < "$dump"
fi

if [ -n "$blobs" ] && [ "$blobs" != "-" ]; then
  [ -f "$blobs" ] || { echo "no such tarball: $blobs" >&2; exit 1; }
  dir="$(cd "$(dirname "$blobs")" && pwd)"
  file="$(basename "$blobs")"
  echo "restoring blob volume $VOLUME from $blobs"
  docker run --rm -v "$VOLUME":/blobs -v "$dir":/in:ro alpine \
    sh -c "find /blobs -mindepth 1 -delete && tar xzf /in/$file -C /blobs"
fi

echo "restore finished"
