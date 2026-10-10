import { writeFileSync } from "node:fs";
import { signup, uniquePhone } from "./helpers/api";
import { grantPlatformAdmin } from "./helpers/db";

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

export default async function globalSetup() {
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
