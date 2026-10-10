# Playwright suite (Sprint 21, review-round point 1)

Real-browser coverage for the returns UI (customer/owner/staff/admin),
against a REAL running API + Next.js server + throwaway Postgres/Redis
- never a mock. This is the first Playwright suite in the project; it
does not replace `apps/api/test/*.e2e-spec.ts` (those remain the
source of truth for business-rule correctness), it proves the UI
renders and acts on real server responses.

## Running it (inside the `sprint10-dev` container, or any host with
Node 20 + the repo's Postgres/Redis reachable)

1. Migrate a throwaway database and point `apps/api/.env` (or an env
   override) at it, same as any other clean-room run.
2. Build and start the API with its stdout redirected to a log file -
   the suite reads OTP codes from it (`SmsService`'s real stdout
   fallback, same convention as every manual check in this project):
   ```
   npm run build --workspace=apps/api
   node apps/api/dist/src/main.js > /tmp/finalpro-playwright-api.log 2>&1 &
   ```
3. Build and start the web app:
   ```
   npm run build --workspace=apps/web
   npm run start --workspace=apps/web -- -p 3000 &
   ```
4. From `apps/web`:
   ```
   npx playwright install --with-deps chromium   # no-op if already cached
   npm run test:e2e
   ```

Env overrides (all optional, defaults match the above):
`PW_API_BASE_URL`, `PW_WEB_BASE_URL`, `PW_API_LOG_FILE`,
`PW_DATABASE_URL` (falls back to `DATABASE_URL`), `PW_FIXTURE_FILE`.

`global-setup.ts` signs up the shared owner/customerA/customerB/admin
accounts ONCE for the whole run (OTP-request is throttled 5/60s per
API instance - a real HTTP throttle this suite cannot override the way
the Jest e2e suite overrides `ThrottlerStorage` in-process). Every spec
file reuses those same tokens and creates its own vendor/branch/order
fixtures through the real HTTP API (`helpers/api.ts`) plus two raw
DB-only steps no HTTP endpoint covers - granting `PLATFORM_ADMIN` and
seeding an offer/stock to sell (`helpers/db.ts`, via the same generated
Prisma client `apps/api`'s own tests use).
