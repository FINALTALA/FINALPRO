import { writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import {
  assertApiUsesSameDatabase,
  assertDisposableDatabase,
  DATABASE_COMMENT_SQL,
  DATABASE_IDENTITY_SQL,
  type ApiDatabaseIdentity,
} from "../../api/test/helpers/disposable-database";
import { signup, uniquePhone } from "./helpers/api";
import { DATABASE_URL, grantPlatformAdmin, prisma } from "./helpers/db";

// Sprint 21 (review-round point 1): OTP request is throttled 5/60s per
// app instance (see otp.service.ts / auth.controller.ts's own
// @Throttle decorators) - a real HTTP throttle this Playwright run
// cannot override the way the Jest e2e suite does (that overrides
// ThrottlerStorage inside its own in-process TestingModule; this suite
// talks to an already-running, separate API process). Signing up every
// shared account ONCE here, before any spec file runs, keeps the whole
// run's total signups low and far under that limit - every spec file
// then reuses these same tokens instead of creating its own users.
const FIXTURE_FILE =
  process.env.PW_FIXTURE_FILE ?? "/tmp/finalpro-playwright-fixtures.json";

// TB-12.1: the development servers - the web app on :3000 and the API
// on :3001 both run against finalpro. A run may never target them.
const PROTECTED_PORTS = ["3000", "3001"];

function requireTestServer(variableName: "PW_API_BASE_URL" | "PW_WEB_BASE_URL"): void {
  const raw = process.env[variableName];
  if (!raw) {
    throw new Error(
      `Refusing to run Playwright: ${variableName} is not set. Point it explicitly at the test servers (see apps/web/e2e/README.md).`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Refusing to run Playwright: ${variableName} ("${raw}") is not a valid URL.`);
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (PROTECTED_PORTS.includes(port)) {
    throw new Error(
      `Refusing to run Playwright: ${variableName} points at port ${port}, a development server backed by finalpro. Use the test servers.`,
    );
  }
}

/** The API's own answer to "which database are you connected to?" -
 * null when it has no test-support route (not a test server). */
async function apiDatabaseIdentity(apiBaseUrl: string): Promise<ApiDatabaseIdentity | null> {
  // node:http(s) with no keep-alive rather than fetch(): a refusal stops
  // the run right after this, and fetch's pooled connection made Node
  // abort on exit on Windows (libuv "UV_HANDLE_CLOSING" assertion)
  // instead of failing with a plain exit code.
  const target = new URL(`${apiBaseUrl}/test-support/database-identity`);
  const client = target.protocol === "https:" ? https : http;
  let status: number;
  let body: string;
  try {
    ({ status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = client.get(target, { agent: false, timeout: 10_000 }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", reject);
    }));
  } catch (err) {
    throw new Error(`Refusing to run Playwright: the API at ${apiBaseUrl} could not be reached (${(err as NodeJS.ErrnoException).code ?? ((err as Error).message || "no answer")}).`);
  }
  if (status === 404) return null;
  if (status !== 200) {
    throw new Error(`Refusing to run Playwright: the API at ${apiBaseUrl} answered ${status} when asked for its database.`);
  }
  return JSON.parse(body) as ApiDatabaseIdentity;
}

/** Refuses to start - before any signup or database write - unless the
 * run targets the test servers, the database it seeds directly is a
 * marked disposable test database, and the API is connected to that
 * very database (not finalpro, not another one). */
async function guardTestEnvironment(): Promise<void> {
  requireTestServer("PW_API_BASE_URL");
  requireTestServer("PW_WEB_BASE_URL");
  await assertDisposableDatabase(DATABASE_URL, "PW_DATABASE_URL", async () => {
    const rows = await prisma.$queryRawUnsafe<{ comment: string | null }[]>(DATABASE_COMMENT_SQL);
    return rows[0]?.comment ?? null;
  });
  const [own] = await prisma.$queryRawUnsafe<{ name: string; oid: number }[]>(DATABASE_IDENTITY_SQL);
  const apiBaseUrl = process.env.PW_API_BASE_URL!;
  assertApiUsesSameDatabase(await apiDatabaseIdentity(apiBaseUrl), own, apiBaseUrl);
}

export default async function globalSetup() {
  try {
    await guardTestEnvironment();
  } catch (err) {
    // Close the direct database connection before stopping the run, so
    // a refusal ends as a plain failure, not a crash on exit.
    await prisma.$disconnect().catch(() => undefined);
    throw err;
  }

  const ownerPhone = uniquePhone();
  const customerAPhone = uniquePhone();
  const customerBPhone = uniquePhone();
  const adminPhone = uniquePhone();

  const ownerToken = await signup(ownerPhone, "a-strong-password");
  const customerAToken = await signup(customerAPhone, "a-strong-password");
  const customerBToken = await signup(customerBPhone, "a-strong-password");
  const adminToken = await signup(adminPhone, "a-strong-password");
  await grantPlatformAdmin(adminPhone);

  writeFileSync(
    FIXTURE_FILE,
    JSON.stringify({
      ownerPhone,
      ownerToken,
      customerAToken,
      customerBToken,
      adminToken,
    }),
  );
}
