import { defineConfig, devices } from "@playwright/test";

// Sprint 21 (review-round point 1): real-browser coverage for the
// returns UI (customer/owner/staff/admin) - first Playwright suite in
// this project. Single worker, no retries: these specs share one live
// API + one throwaway database (started separately, see
// apps/web/e2e/README.md), so parallel workers would race on
// fixture creation rather than catch real bugs.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PW_WEB_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
