#!/bin/bash
# Hourly Postgres dump for Project Airlock.
#
# Hourly rather than daily because a 24-hour window is exactly what lost a day
# of history once. Each dump is a few KB, so 30 days of hourly retention costs
# single-digit megabytes. No de-duplication: session rows change on every
# request, so consecutive dumps always differ anyway.
#
# The audit database holds de-identified text only, but it is still the record
# of what this instance did — and a Docker volume is one `compose down -v` away
# from gone. Dumps land in ~/Documents so Time Machine picks them up.
#
# Installed as a launchd job; see ops/uk.galenchen.airlock.backup.plist
set -euo pipefail

PROJECT_DIR="${AIRLOCK_DIR:-$HOME/Desktop/local_llm}"
BACKUP_DIR="${AIRLOCK_BACKUP_DIR:-$HOME/Documents/airlock-backups}"
KEEP_DAYS="${AIRLOCK_BACKUP_KEEP_DAYS:-30}"
STAMP="$(date +%Y-%m-%d_%H%M)"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }

cd "$PROJECT_DIR" || { log "FAIL project dir not found: $PROJECT_DIR"; exit 1; }

# Prefer the container's own pg_dump: it always matches the server version,
# and it works whether or not Postgres client tools are installed on the host.
if ! /usr/local/bin/docker compose ps db --status running >/dev/null 2>&1 &&
   ! /usr/bin/env docker compose ps db --status running >/dev/null 2>&1; then
  log "SKIP database container is not running"
  exit 0
fi

OUT="$BACKUP_DIR/airlock_${STAMP}.sql.gz"
if docker compose exec -T db pg_dump -U airlock -d clinical_notes --clean --if-exists \
   | gzip -9 > "$OUT.partial"; then
  mv "$OUT.partial" "$OUT"
  chmod 600 "$OUT"
  SIZE=$(du -h "$OUT" | cut -f1)
  ROWS=$(docker compose exec -T db psql -U airlock -d clinical_notes -tAc \
         'select count(*) from "AuditLog";' 2>/dev/null | tr -d '[:space:]')
  log "OK   $OUT ($SIZE, ${ROWS:-?} audit rows)"
else
  rm -f "$OUT.partial"
  log "FAIL pg_dump returned non-zero"
  exit 1
fi

# Prune old dumps. Never touches the log.
DELETED=$(find "$BACKUP_DIR" -name 'airlock_*.sql.gz' -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
[ "$DELETED" != "0" ] && log "pruned $DELETED dump(s) older than $KEEP_DAYS days"

exit 0
