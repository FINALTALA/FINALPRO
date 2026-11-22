#!/bin/bash
# TB-13: the in-container half of scripts/e2e/run-api-e2e.sh - runs inside
# the sprint10-dev container on its own copy of the working tree. Never
# reads a .env file: DATABASE_URL, REDIS_URL and NODE_ENV come only from
# the docker exec that starts it.
#
#   in-container.sh prepare   # deps (if the lockfile changed), prisma generate,
#                             # the e2e guard, migrate deploy
#   in-container.sh jest <workers> [jest file args...]
#                             # runs jest; writes <run>/jest.log, then <run>/done
#                             # (jest's exit code) LAST - the host drops the test
#                             # database only after that file exists
set -u
PHASE=$1; shift
ROOT=${E2E_ROOT:?E2E_ROOT is not set}
RUN=${E2E_RUN_DIR:?E2E_RUN_DIR is not set}
cd "$ROOT" || exit 2

say() { echo "[in-container] $*"; }
db_name=$(node -e 'console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))')
[ "$db_name" = "finalpro" ] && { say "REFUSING: DATABASE_URL points at finalpro"; exit 2; }
if find "$ROOT" -name '.env*' -not -path '*/node_modules/*' | grep -q .; then say "REFUSING: a .env file is present in the copy"; exit 2; fi

case "$PHASE" in
  prepare)
    lock=$(sha256sum package-lock.json | cut -c1-64)
    if [ ! -d node_modules ] || [ "$(cat .lockhash 2>/dev/null)" != "$lock" ]; then
      say "installing dependencies (lockfile changed or none installed)"
      npm ci --no-audit --no-fund > "$RUN/npm-ci.log" 2>&1 || { say "npm ci failed (see npm-ci.log)"; exit 3; }
      echo "$lock" > .lockhash
    fi
    cd apps/api || exit 2
    npx prisma generate --config prisma7.config.ts > "$RUN/prisma-generate.log" 2>&1 || { say "prisma generate failed"; exit 3; }
    node -e '
      require("ts-node").register({ transpileOnly: true });
      require("./test/guard-disposable-database").default()
        .then(() => console.log("[in-container] GUARD OK: marked, non-protected test database"))
        .catch((e) => { console.log("[in-container] GUARD REFUSED: " + e.message); process.exit(4); });' || exit 4
    npx prisma migrate deploy --config prisma7.config.ts > "$RUN/migrate.log" 2>&1 || { say "migrate deploy failed (see migrate.log)"; exit 3; }
    say "migrations: $(tail -1 "$RUN/migrate.log")"
    ;;
  jest)
    workers=${1:-2}; shift || true
    cd apps/api || exit 2
    rm -f "$RUN/done"
    npx jest --config ./test/jest-e2e.json --maxWorkers="$workers" "$@" < /dev/null > "$RUN/jest.log" 2>&1
    echo $? > "$RUN/done"
    ;;
  *) say "unknown phase $PHASE"; exit 2 ;;
esac
