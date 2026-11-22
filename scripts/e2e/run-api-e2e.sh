#!/bin/bash
# TB-13: the reliable way to run the API e2e suite on this project's dev
# machines - inside the Linux container `sprint10-dev` (Docker network to
# Postgres/Redis, no host port forwarding), with 2 Jest workers by default.
#
#   scripts/e2e/run-api-e2e.sh [--workers N] [--redis-index N] [--db NAME] [-- jest file args...]
#
# What it guarantees:
#   - the copy of the working tree in the container has NO .env file; the run
#     gets only NODE_ENV=test, DATABASE_URL (a new test database) and REDIS_URL;
#   - the test database is created marked ('finalpro:disposable-test'), never
#     named "finalpro", and the e2e guard must pass before any migration/write;
#   - Jest runs detached and writes a completion file LAST; the test database
#     is dropped only when that file exists AND no Jest process is left, and
#     only after its own marker is read again. If `docker exec` drops, Jest is
#     still running, or the run never finished, the database is KEPT (and named).
#   - the run is reported as NOT RELIABLE when it did not finish, a Jest worker
#     was killed (SIGKILL), or the container/VM logged an OOM kill during it.
#     It does NOT claim to detect host sleep or battery - it cannot measure them.
# It never changes Docker, memory or power settings, and never touches finalpro.
#
# Environment overrides: E2E_CONTAINER (sprint10-dev), E2E_PG_CONTAINER
# (finalyearproject-postgres-1), E2E_REDIS_CONTAINER (finalyearproject-redis-1),
# E2E_PG_USER / E2E_PG_PASSWORD (docker-compose dev values), E2E_TIMEOUT_MIN (120).
set -u
export MSYS_NO_PATHCONV=1   # Git Bash: keep /tmp/... paths as they are

CONTAINER=${E2E_CONTAINER:-sprint10-dev}
PG=${E2E_PG_CONTAINER:-finalyearproject-postgres-1}
REDIS=${E2E_REDIS_CONTAINER:-finalyearproject-redis-1}
PG_USER=${E2E_PG_USER:-finalpro}
PG_PASSWORD=${E2E_PG_PASSWORD:-finalpro_dev_only}
TIMEOUT_MIN=${E2E_TIMEOUT_MIN:-120}
MARKER='finalpro:disposable-test'
WORKERS=2
REDIS_INDEX=12
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
DB="api_e2e_${RUN_ID//[^0-9A-Za-z]/_}"
DB=$(echo "$DB" | tr 'A-Z' 'a-z')
JEST_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --workers) WORKERS=$2; shift 2 ;;
    --redis-index) REDIS_INDEX=$2; shift 2 ;;
    --db) DB=$2; shift 2 ;;
    --) shift; JEST_ARGS=("$@"); break ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done

REPO=$(cd "$(dirname "$0")/../.." && pwd)
REMOTE_ROOT=/tmp/finalpro-e2e
REMOTE_RUN=/tmp/finalpro-e2e-runs/$RUN_ID
OUT="${TMPDIR:-/tmp}/finalpro-e2e-runs/$RUN_ID"
mkdir -p "$OUT"
log() { echo "[run-api-e2e] $*" | tee -a "$OUT/run.log"; }
psql_admin() { docker exec "$PG" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -At "$@"; }
in_container() { docker exec -e E2E_ROOT=$REMOTE_ROOT -e E2E_RUN_DIR=$REMOTE_RUN -e NODE_ENV=test \
  -e DATABASE_URL="postgresql://$PG_USER:$PG_PASSWORD@postgres:5432/$DB" -e REDIS_URL="redis://redis:6379/$REDIS_INDEX" \
  "$@"; }
oom_kills() { # OOM kills reported by Docker Desktop's VM log since $1 (when that log exists on this host)
  local f="${LOCALAPPDATA:-}/Docker/log/vm/init.log"
  [ -n "${LOCALAPPDATA:-}" ] && [ -f "$f" ] || { echo "n/a"; return; }
  grep -ah 'Out of memory: Killed process' "$f"* 2>/dev/null | grep -aoE '"time":"[^"]+"' | awk -v t="$1" '{split($0,a,"\""); if (a[4] > t) n++} END {print n+0}'
}

# --- checks before anything is written ---
[[ "$DB" =~ ^[a-z0-9_]{1,63}$ ]] || { log "REFUSING: invalid database name '$DB'"; exit 2; }
[ "$DB" = "finalpro" ] && { log "REFUSING: the test database may never be 'finalpro'"; exit 2; }
[[ "$REDIS_INDEX" =~ ^([0-9]|1[0-5])$ ]] || { log "REFUSING: Redis index must be 0-15"; exit 2; }
psql_admin -c "SELECT 1" > /dev/null || { log "cannot reach Postgres in $PG"; exit 2; }
EXISTS=$(psql_admin -c "SELECT count(*) FROM pg_database WHERE datname = '$DB'")
[ "$EXISTS" = "0" ] || { log "REFUSING: database $DB already exists (nothing was created or changed)"; exit 2; }
docker inspect "$CONTAINER" > /dev/null 2>&1 || { log "container $CONTAINER not found"; exit 2; }
[ "$(docker inspect -f '{{.HostConfig.Privileged}}' "$CONTAINER")" = "false" ] || { log "REFUSING: $CONTAINER is privileged"; exit 2; }
WAS_RUNNING=$(docker inspect -f '{{.State.Running}}' "$CONTAINER")
[ "$WAS_RUNNING" = "true" ] || { docker start "$CONTAINER" > /dev/null && log "started $CONTAINER (it was stopped; it will be stopped again at the end)"; }
LEFT=""
restore_container() {
  [ "$WAS_RUNNING" = "true" ] && return
  local running; running=$(docker exec "$CONTAINER" sh -c 'ps -eo args | grep -cE "[j]est|[p]rocessChild"; true' 2>/dev/null)
  [ -n "$running" ] || running=unknown
  if [ "$running" = "0" ]; then docker stop "$CONTAINER" > /dev/null && log "stopped $CONTAINER again"
  else log "leaving $CONTAINER running: jest is still running in it"; fi
}
trap restore_container EXIT
OOM_BEFORE=$(docker inspect -f '{{.State.OOMKilled}}' "$CONTAINER")
T0=$(date -u +%Y-%m-%dT%H:%M:%S)
log "run $RUN_ID | database $DB | redis index $REDIS_INDEX | workers $WORKERS | output $OUT"

# --- the working tree copy: everything but .git, dependencies, build output and every .env ---
# Files from an earlier copy are removed (node_modules and the lockfile hash are kept), so a
# file deleted from the working tree never lingers in the copy.
docker exec "$CONTAINER" sh -c "mkdir -p $REMOTE_ROOT $REMOTE_RUN && find $REMOTE_ROOT -mindepth 1 -type f -not -path '*/node_modules/*' -not -name .lockhash -delete && find $REMOTE_ROOT -mindepth 1 -type d -empty -not -path '*/node_modules/*' -delete"
( cd "$REPO" && tar -c --exclude=./.git --exclude='*/node_modules' --exclude=./node_modules --exclude=./.worktrees \
    --exclude='*/.next' --exclude=./apps/api/dist --exclude=./apps/api/generated --exclude='*/.env' --exclude='*/.env.*' \
    --exclude=./apps/web/test-results --exclude='*/tsconfig*.tsbuildinfo' --exclude='*/tb*-build' -f - . ) \
  | docker exec -i "$CONTAINER" tar -x -C "$REMOTE_ROOT"
docker exec -i "$CONTAINER" sh -c "cat > $REMOTE_RUN/in-container.sh" < "$REPO/scripts/e2e/in-container.sh"
ENVS=$(docker exec "$CONTAINER" sh -c "find $REMOTE_ROOT -name '.env*' -not -path '*/node_modules/*' | wc -l")
[ "$ENVS" = "0" ] || { log "REFUSING: $ENVS .env file(s) in the copy"; exit 2; }
log "working tree copied (no .env in the copy)"

# --- the test database: created marked; the guard decides before any write ---
psql_admin -c "CREATE DATABASE \"$DB\"" -c "COMMENT ON DATABASE \"$DB\" IS '$MARKER'" > /dev/null
docker exec "$PG" psql -U "$PG_USER" -d "$DB" -qc "CREATE EXTENSION IF NOT EXISTS postgis"
docker exec "$REDIS" redis-cli -n "$REDIS_INDEX" FLUSHDB > /dev/null
log "created $DB (marked) and flushed Redis index $REDIS_INDEX"
if ! in_container "$CONTAINER" bash "$REMOTE_RUN/in-container.sh" prepare 2>&1 | tee -a "$OUT/run.log"; then :; fi
if ! grep -q "GUARD OK" "$OUT/run.log" || ! grep -q "migrations:" "$OUT/run.log"; then
  log "PREPARE FAILED - nothing was run; database $DB kept for inspection"; exit 3
fi

# --- Jest, detached; the completion file is written last ---
in_container -d "$CONTAINER" bash "$REMOTE_RUN/in-container.sh" jest "$WORKERS" "${JEST_ARGS[@]}"
log "jest started (detached) at $(date -u +%H:%M:%S) UTC; waiting for $REMOTE_RUN/done (max $TIMEOUT_MIN min)"
DONE=""
for _ in $(seq 1 $((TIMEOUT_MIN * 2))); do
  sleep 30
  if docker exec "$CONTAINER" test -f "$REMOTE_RUN/done" 2>/dev/null; then DONE=$(docker exec "$CONTAINER" cat "$REMOTE_RUN/done" 2>/dev/null); break; fi
done
LEFT=$(docker exec "$CONTAINER" sh -c 'ps -eo args | grep -cE "[j]est|[p]rocessChild"; true' 2>/dev/null)
[ -n "$LEFT" ] || LEFT=unknown
docker exec "$CONTAINER" cat "$REMOTE_RUN/jest.log" > "$OUT/jest.log" 2>/dev/null

# --- reliability ---
REASONS=()
[ -n "$DONE" ] || REASONS+=("jest did not finish (no completion file)")
[ "$LEFT" = "0" ] || REASONS+=("jest processes still running: $LEFT")
grep -aq "signal=SIGKILL" "$OUT/jest.log" 2>/dev/null && REASONS+=("a jest worker was killed (SIGKILL)")
OOM_AFTER=$(docker inspect -f '{{.State.OOMKilled}}' "$CONTAINER")
[ "$OOM_BEFORE" = "false" ] && [ "$OOM_AFTER" = "true" ] && REASONS+=("the container recorded an OOM kill")
VM_OOM=$(oom_kills "$T0"); [ "$VM_OOM" != "n/a" ] && [ "$VM_OOM" != "0" ] && REASONS+=("Docker VM logged $VM_OOM OOM kill(s)")
log "$(grep -aE '^(Test Suites|Tests|Time):' "$OUT/jest.log" 2>/dev/null | tr '\n' ' ')"
grep -a "  ● " "$OUT/jest.log" 2>/dev/null | grep -v Console | sort -u | cut -c1-220 | tee -a "$OUT/run.log"
log "deadlocks counted in $DB: $(psql_admin -c "SELECT deadlocks FROM pg_stat_database WHERE datname = '$DB'")"

# --- the test database: dropped only after a finished run, and only if it still carries the marker ---
if [ ${#REASONS[@]} -eq 0 ] || { [ -n "$DONE" ] && [ "$LEFT" = "0" ]; }; then
  COMMENT=$(psql_admin -c "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '$DB'")
  if [ "$DB" != "finalpro" ] && [ "$COMMENT" = "$MARKER" ]; then
    psql_admin -c "DROP DATABASE \"$DB\" WITH (FORCE)" > /dev/null && log "dropped $DB"
  else
    log "NOT dropping $DB: it does not carry the marker"
  fi
else
  log "KEEPING database $DB: the run did not finish cleanly (it is marked; drop it later with the test helper)"
fi

if [ ${#REASONS[@]} -gt 0 ]; then
  log "NOT RELIABLE: $(IFS='; '; echo "${REASONS[*]}")"
  exit 3
fi
log "RELIABLE RUN - jest exit code $DONE"
exit "$DONE"
