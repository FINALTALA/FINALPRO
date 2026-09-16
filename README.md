# FINALPRO

Multi-vendor e-commerce and product-comparison platform for local stores across the West Bank. Final year project.

Full specification: [`docs/srs/`](docs/srs/) — a nine-part SRS (00 through 09) covering requirements, data model, architecture, backlog, and sprint plan. Start with [`docs/srs/00-phase0-scope-and-clarifications.md`](docs/srs/00-phase0-scope-and-clarifications.md) for context, or [`docs/srs/08-backlog-sprint-plan.md`](docs/srs/08-backlog-sprint-plan.md) for what's being built and when.

## Status

Implementation began at **Sprint 1 (EPIC-FOUND)**, per the FYP Delivery Increment approved 2026-09-16 (Part 7, OPEN-006). Payment gateway, SMS/OTP provider, and vendor subscription policy remain open product-owner decisions (OPEN-001, OPEN-003, OPEN-004) — the API runs against documented sandbox/fallback behavior until those resolve; nothing here claims a production integration that hasn't been decided.

## Repository layout

```
apps/
  api/    NestJS + TypeScript backend (Part 6, ADR-002)
  web/    Next.js + TypeScript frontend, wrapped via Capacitor for
          Android/iOS in a later sprint (Part 6, ADR-004)
docs/
  srs/    The nine-part SRS
```

Architecture: modular monolith (Part 6, §M.1, ADR-001) — PostgreSQL + PostGIS via Prisma, Redis for cache/rate-limiting/session state, a transactional outbox (`OutboxEvent`, ADR-006) for durable async work.

## Local development

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/). Node.js does not need to be installed on the host — every command below runs inside a Node container against the project's own `node_modules`, kept in a Docker volume rather than the host filesystem.

**1. Start local infrastructure** (PostgreSQL+PostGIS, Redis):

```sh
docker compose up -d
```

**2. Set up the API:**

```sh
cd apps/api
cp .env.example .env   # or use the repo-root .env.example as a reference
```

Then, from the repo root, run installs/migrations/tests via a Node container on the compose network (`finalyearproject_default`) so it can reach `postgres`/`redis` by service name:

```sh
docker run --rm --network finalyearproject_default -v "$(pwd):/workspace" -w /workspace/apps/api node:20-alpine sh -c "npm install && npx prisma migrate dev"
```

**3. Run the API:**

```sh
docker run --rm --network finalyearproject_default -p 3001:3001 --env-file apps/api/.env -v "$(pwd):/workspace" -w /workspace/apps/api node:20-alpine node dist/src/main.js
```

(Build first with `npm run build` inside the same container pattern, or use `npm run start:dev` for hot-reload during active development.) The API takes roughly 5–10 seconds to finish its first-boot module resolution in a cold container — this is normal, not a hang.

Once running: `GET http://localhost:3001/api/v1/health` should return `{"status":"ok",...}`.

**4. Run the web app:**

```sh
docker run --rm -p 3000:3000 -v "$(pwd):/workspace" -w /workspace/apps/web node:20-alpine sh -c "npm install && npm run dev -- -H 0.0.0.0"
```

**Tests:** `npm test` (unit) and `npm run test:e2e` (end-to-end, needs Postgres running) inside `apps/api`, using the same `docker run --network finalyearproject_default ...` pattern as above.

Once Node.js is installed natively (or in CI, see `.github/workflows/ci.yml`), all of the above are just the plain `npm install` / `npm run dev` / `npm test` commands from within each app's directory — Docker is a workaround for local development on a machine without Node installed, not a hard architectural requirement.

## Governance

This project follows a documented SRS with an explicit product-owner approval trail (Part 7 registers) and a Codex-audited review history for every part of the specification. Do not add scope, change confirmed decisions (`BDR-*`), or resolve an open item (`OPEN-*`) without updating the relevant SRS part first — the backlog (Part 8) is the source of truth for what's actually being built in the current sprint.
