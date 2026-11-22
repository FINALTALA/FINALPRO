# API e2e tests - running them reliably

## The reliable full run (this project's dev machines)

```bash
scripts/e2e/run-api-e2e.sh                 # whole suite, 2 Jest workers
scripts/e2e/run-api-e2e.sh -- test/tb11-sweep-isolation.e2e-spec.ts   # some files
```

Run from the repository root in Git Bash (Windows) or any shell with Docker. It runs the
suite inside the Linux container `sprint10-dev` on a copy of the working tree, against a
new test database and an isolated Redis index, and prints its output folder.

Why this way:

- **Not from Windows directly.** On a Windows host the e2e workers reach Postgres through
  Docker Desktop's port forwarding. Under memory pressure the Docker VM fails to set up
  those connections (`page allocation failure: order:7 ... vmbus_add_channel_work` in
  `%LOCALAPPDATA%\Docker\log\vm\init.log`): connections drop, tests time out, and the run
  proves nothing. Inside the container the connections stay on the Docker network.
- **2 workers.** With 4 workers the Docker VM (7.6 GB) ran out of memory and the kernel
  killed a Jest worker. 2 workers ran the whole suite reliably. This does not change any
  Docker or memory setting.
- **Isolated.** The copy has no `.env` file. The run gets only `NODE_ENV=test`,
  `DATABASE_URL` (the new test database) and `REDIS_URL`. The database is created with
  the marker `finalpro:disposable-test`, and the e2e guard must pass before any
  migration or write.
- **The database is kept when the run did not finish.** Jest runs detached and writes a
  completion file last. The test database is dropped only when that file exists and no
  Jest process is left, and only after its marker is read again. If `docker exec` drops
  or Jest is still running, the database is kept and named in the output.
- **When a run does not count.** The script reports `NOT RELIABLE` when Jest did not
  finish, a worker was killed (SIGKILL), or the container or the Docker VM logged an OOM
  kill. It cannot measure host sleep or battery from inside the container. Do not count a
  run made while the machine slept or ran on battery: check Windows' Kernel-Power 506/507
  events for that time.

CI (`.github/workflows/ci.yml`) runs the same suite on Linux with `--maxWorkers=50%`.

## Safety rules every test follows

- **No test may use, create or drop `finalpro`.** The name is matched exactly, never by
  pattern.
  - The e2e `globalSetup` refuses an unmarked or protected `DATABASE_URL`.
  - The app itself (`PrismaService`, under `NODE_ENV=test`) refuses a protected name
    before connecting and an unmarked database before it is used.
- **A test that needs its own database uses `helpers/test-databases.ts`.**
  - `createDisposableDatabase` creates it marked.
  - `dropDisposableDatabase` drops it only after reading that database's own marker. It
    refuses any database without the marker and the name `finalpro`.
  - Never write `CREATE DATABASE` or `DROP DATABASE` directly.
- **Child processes are started with `process.execPath`** and the resolved CLI
  (`require.resolve('prisma/build/index.js')`, `require.resolve('ts-node/dist/bin.js')`),
  never with `npx`, which is `npx.cmd` on Windows and fails there.

## Timeouts

The per-test limit is 30 s (`jest-e2e.json`) and is not raised to hide slow or stuck
tests. The existing longer limits are set on `beforeAll`/`afterAll` hooks that create
and migrate a database (120-180 s). A new per-test limit needs a measured reason and
approval.

## Shared-database assertions

In a parallel run every test file is its own app instance on the same database, and the
periodic sweeps take rows `FOR UPDATE SKIP LOCKED`. A test that asserts one row's outcome
right after calling a sweep uses `helpers/sweep-until.ts`. A test that counts rows should
count only its own data (its own store, its own names).
