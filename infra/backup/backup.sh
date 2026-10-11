#!/bin/sh
# Nightly backup loop for the dcad stack (runs in the `backup` service, postgres:17 image).
#
# Every day at BACKUP_HOUR (UTC) it writes into /backups:
#   dcad-<UTC timestamp>.dump   pg_dump custom format of the database
#   blobs-<UTC timestamp>.tgz   tarball of the blob volume (mounted read-only at /blobs)
# and deletes backups older than BACKUP_KEEP_DAYS.
#
# Env: PGHOST PGUSER PGPASSWORD PGDATABASE (libpq), BACKUP_HOUR (0-23, default 3),
# BACKUP_KEEP_DAYS (default 14), BACKUP_RUN_ON_START=1 (also back up right away),
# BACKUP_ONCE=1 (one backup, then exit; for drills and cron-style use),
# BACKUP_OUT (default /backups), BLOBS_DIR (default /blobs).
set -u

HOUR="${BACKUP_HOUR:-3}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
OUT="${BACKUP_OUT:-/backups}"
BLOBS="${BLOBS_DIR:-/blobs}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: $*"; }

run_backup() {
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$OUT" || return 1
  # Write to .partial names first so a crash never leaves a truncated file that looks complete.
  if ! pg_dump -Fc -f "$OUT/dcad-$ts.dump.partial"; then
    log "pg_dump failed"
    rm -f "$OUT/dcad-$ts.dump.partial"
    return 1
  fi
  mv "$OUT/dcad-$ts.dump.partial" "$OUT/dcad-$ts.dump"
  if ! tar czf "$OUT/blobs-$ts.tgz.partial" -C "$BLOBS" .; then
    log "blob tarball failed"
    rm -f "$OUT/blobs-$ts.tgz.partial"
    return 1
  fi
  mv "$OUT/blobs-$ts.tgz.partial" "$OUT/blobs-$ts.tgz"
  log "wrote dcad-$ts.dump ($(du -h "$OUT/dcad-$ts.dump" | cut -f1)) and blobs-$ts.tgz ($(du -h "$OUT/blobs-$ts.tgz" | cut -f1))"
  find "$OUT" -maxdepth 1 -type f \( -name 'dcad-*.dump' -o -name 'blobs-*.tgz' \) -mtime +"$KEEP_DAYS" -print -delete |
    while read -r old; do log "pruned $(basename "$old")"; done
  return 0
}

# Seconds until the next BACKUP_HOUR:00 UTC (GNU date, as in the Debian-based postgres image).
seconds_until_next() {
  now="$(date -u +%s)"
  target="$(date -u -d "$(date -u +%Y-%m-%d) $(printf '%02d' "$HOUR"):00:00" +%s)"
  [ "$target" -le "$now" ] && target=$((target + 86400))
  echo $((target - now))
}

log "started: daily at $(printf '%02d' "$HOUR"):00 UTC, keep $KEEP_DAYS days, out $OUT"

if [ "${BACKUP_ONCE:-0}" = "1" ]; then
  run_backup
  exit $?
fi
[ "${BACKUP_RUN_ON_START:-0}" = "1" ] && run_backup

while :; do
  wait_s="$(seconds_until_next)"
  log "next backup in ${wait_s}s"
  sleep "$wait_s"
  run_backup || log "backup failed; retrying at the next scheduled time"
done
