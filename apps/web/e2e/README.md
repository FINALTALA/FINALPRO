# Playwright suite (Sprint 21, review-round point 1)

Real-browser coverage for the returns UI (customer/owner/staff/admin),
against a REAL running API + Next.js server + throwaway Postgres/Redis
- never a mock. This is the first Playwright suite in the project; it
does not replace `apps/api/test/*.e2e-spec.ts` (those remain the
source of truth for business-rule correctness), it proves the UI
renders and acts on real server responses.

## Test databases only (TB-12.1)

No test run may touch `finalpro`, the local development database (it
still carries residue from the days the suites ran against it).
`global-setup.ts` stops the run - before any signup or database write -
unless:

- `PW_API_BASE_URL`, `PW_WEB_BASE_URL` and `PW_DATABASE_URL` are all set
  explicitly (there are no defaults, and `DATABASE_URL` is never used);
- neither URL is on port 3000 or 3001 (the development web app and API,
  both backed by finalpro);
- the database is not named `finalpro` and carries the disposable-test
  marker:
  ```
  COMMENT ON DATABASE <name> IS 'finalpro:disposable-test';
  ```
- the API at `PW_API_BASE_URL` is connected to that very database. The
  setup asks it `GET /test-support/database-identity` (name, oid and
  whether the database carries the marker - nothing else) and compares
  the answer with `PW_DATABASE_URL`'s own name and oid. That route exists
  only on a test server: the API must be started with
  `E2E_TEST_SUPPORT=1`, and it is a 404 whenever `NODE_ENV=production`
  or the variable is anything but `1` - so finalpro's development API,
  any API on another database, or one not started as a test server stops
  the run.

The Jest e2e suite (`apps/api/test/jest-e2e.json`) runs the same
database check in its `globalSetup`, so `npm run test:e2e` with
`apps/api/.env`'s finalpro `DATABASE_URL` fails at once. Mark every
throwaway test database when you create it.

## Running it (inside the `sprint10-dev` container, or any host with
Node 20 + the repo's Postgres/Redis reachable)

1. Create and mark a throwaway database, migrate it, and point the
   API's `DATABASE_URL` at it (an env override - never edit `.env` to
   point at a test database you then forget):
   ```
   psql -c "CREATE DATABASE pwcheck" -c "COMMENT ON DATABASE pwcheck IS 'finalpro:disposable-test'"
   ```
2. Build and start the API on a test port (not 3001) with its stdout
   redirected to a log file - the suite reads OTP codes from it
   (`SmsService`'s real stdout fallback):
   ```
   npm run build --workspace=apps/api
   E2E_TEST_SUPPORT=1 API_PORT=3002 node apps/api/dist/src/main.js > /tmp/finalpro-playwright-api.log 2>&1 &
   ```
   Start it with `RESERVE_RATE_LIMIT_PER_MINUTE=1000` in its environment:
   the fixtures reserve far more often per account than the production
   per-user limit of 10 a minute allows (TB-5).
   Also start it with `E2E_PAUSED_TASKS=ReturnSweepService`: the suite
   seeds returns whose drop-off code has already expired (to show «انتهت
   صلاحية هذا الكود»), and the returns sweep - every 60 seconds - would
   otherwise expire them under the test. Honoured only together with
   `E2E_TEST_SUPPORT=1` and never in production (phase A+).
3. Build the web app against that API and start it on a test port (not
   3000):
   ```
   NEXT_PUBLIC_API_URL=http://localhost:3002/api/v1 npm run build --workspace=apps/web
   npm run start --workspace=apps/web -- -p 3101 &
   ```
4. From `apps/web`:
   ```
   npx playwright install --with-deps chromium   # no-op if already cached
   PW_API_BASE_URL=http://localhost:3002/api/v1 PW_WEB_BASE_URL=http://localhost:3101      PW_DATABASE_URL=postgresql://.../pwcheck npm run test:e2e
   ```

Required: `PW_API_BASE_URL`, `PW_WEB_BASE_URL`, `PW_DATABASE_URL`.
Optional: `PW_API_LOG_FILE`, `PW_FIXTURE_FILE`.

`global-setup.ts` signs up the shared owner/customerA/customerB/admin
accounts ONCE for the whole run (OTP-request is throttled 5/60s per
API instance - a real HTTP throttle this suite cannot override the way
the Jest e2e suite overrides `ThrottlerStorage` in-process). Every spec
file reuses those same tokens and creates its own vendor/branch/order
fixtures through the real HTTP API (`helpers/api.ts`) plus two raw
DB-only steps no HTTP endpoint covers - granting `PLATFORM_ADMIN` and
seeding an offer/stock to sell (`helpers/db.ts`, via the same generated
Prisma client `apps/api`'s own tests use).
