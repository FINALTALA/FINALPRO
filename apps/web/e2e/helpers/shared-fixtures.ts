import { readFileSync } from "node:fs";

const FIXTURE_FILE =
  process.env.PW_FIXTURE_FILE ?? "/tmp/finalpro-playwright-fixtures.json";

export interface SharedFixtures {
  ownerPhone: string;
  ownerToken: string;
  customerAToken: string;
  customerBToken: string;
  adminToken: string;
}

/** The accounts global-setup.ts signed up once for the whole run -
 * every spec file reuses these rather than signing up its own (the
 * real OTP-request throttle is shared across the whole run). */
export function loadSharedFixtures(): SharedFixtures {
  return JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as SharedFixtures;
}
