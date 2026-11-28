import { expect, test, type Page } from "@playwright/test";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";

// VIA Control Center phase 2B - the Approval Center page. Counts come from
// GET /admin/approval-center/summary; the tabs must show exactly those
// numbers, list their source's own pending items and link each one to the
// source's own decision screen. A reviewer sees only verification. The
// API's own rules (what counts, dedup, conflicts, partial) are proven by
// apps/api/test/approval-center-2b.e2e-spec.ts; this file proves the page.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

const DECISION_PAGE: Record<string, RegExp> = {
  BRANCH_VERIFICATION: /^\/admin\/verification\/[0-9a-f-]{36}$/,
  WAREHOUSE_VERIFICATION: /^\/admin\/verification\/[0-9a-f-]{36}$/,
  NAME_CHANGE: /^\/admin\/name-change-requests$/,
  BRAND_REQUEST: /^\/admin\/brands\/requests$/,
  REPORTED_REVIEW: /^\/admin\/reviews$/,
  ESCALATED_RETURN: /^\/admin\/returns$/,
  SIZE_GUIDE_REQUEST: /^\/admin\/size-guides\/requests$/,
};

async function staff(role: "PLATFORM_ADMIN" | "VERIFICATION_REVIEWER", lang: "ar" | "en" = "ar") {
  const phone = uniquePhone();
  await prisma.user.create({
    data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), platformRole: role, languagePref: lang },
  });
  const login = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
  const token = login.body.session_token;
  const ws = await call<{ workspace_token: string }>("/me/workspace-sessions", { method: "POST", token, body: { type: "platform" } });
  return { token, wsToken: ws.body.workspace_token };
}

async function open(page: Page, s: { token: string; wsToken: string }, lang: "ar" | "en" = "ar") {
  await page.addInitScript(
    ({ token, wsToken, lang }) => {
      localStorage.setItem("finalpro_lang_pref", lang);
      localStorage.setItem("finalpro_session_token", token);
      sessionStorage.setItem("finalpro_workspace_tokens", JSON.stringify({ vendors: {}, platform: wsToken }));
    },
    { ...s, lang },
  );
  await page.goto("/admin/approvals");
  await page.locator("[data-testid^='ac-tab-']").first().waitFor();
}

/** One pending item in each source the store-independent way the API reads them. */
async function seedPending() {
  const owner = await prisma.user.create({ data: { phone: uniquePhone(), passwordHash: "x", phoneVerifiedAt: new Date() } });
  const vendor = await prisma.vendor.create({
    data: { slug: unique("ac2b").toLowerCase(), legalName: unique("متجر"), status: "UNDER_REVIEW" },
  });
  await prisma.storeBranch.create({
    data: {
      vendorId: vendor.id,
      name: unique("فرع"),
      isPhysical: true,
      lat: 31.9,
      lng: 35.2,
      verificationPhotoUrl: "https://example.com/p.jpg",
      verificationStatus: "PENDING",
      evidenceRevision: 1,
      evidenceSubmittedAt: new Date(),
    },
  });
  await prisma.brandRequest.create({
    data: { vendorId: vendor.id, requestedByUserId: owner.id, name: unique("Brand"), normalizedName: unique("brand") },
  });
}

test.describe("Phase 2B: Approval Center", () => {
  test.describe.configure({ mode: "serial" });

  test("admin: seven sources whose counts equal the API, each row links to its source's decision page", async ({ page }) => {
    await seedPending();
    const admin = await staff("PLATFORM_ADMIN");
    const summary = await call<{ sources: { source: string; status: string; pending: number | null }[]; total: number }>(
      "/admin/approval-center/summary",
      { token: admin.token },
    );
    expect(summary.body.sources).toHaveLength(7);
    await open(page, admin);
    await expect(page.getByRole("heading", { name: "مركز الموافقات" })).toBeVisible();
    await expect(page.getByTestId("ac-total")).toContainText(String(summary.body.total));
    for (const s of summary.body.sources) {
      const tab = page.getByTestId(`ac-tab-${s.source}`);
      await expect(tab).toHaveAttribute("data-status", s.status);
      await expect(tab).toHaveAttribute("data-pending", String(s.pending ?? ""));
      await tab.click();
      await expect(page.getByTestId("ac-list").or(page.getByTestId("ac-empty"))).toBeVisible();
      for (const href of await page.locator("[data-testid='ac-row'] a").evaluateAll((as) => as.map((a) => a.getAttribute("href")))) {
        expect(href).toMatch(DECISION_PAGE[s.source]);
      }
    }
    // The sidebar has the Approval Center as the current section.
    await expect(page.locator("aside [aria-current='page']")).toHaveText("مركز الموافقات");
  });

  test("reviewer: only branch and warehouse verification", async ({ page }) => {
    const reviewer = await staff("VERIFICATION_REVIEWER");
    await open(page, reviewer);
    await expect(page.locator("[data-testid^='ac-tab-']")).toHaveCount(2);
    await expect(page.getByTestId("ac-tab-BRANCH_VERIFICATION")).toBeVisible();
    await expect(page.getByTestId("ac-tab-WAREHOUSE_VERIFICATION")).toBeVisible();
    await expect(page.getByTestId("ac-tab-BRAND_REQUEST")).toHaveCount(0);
  });

  test("English: left-to-right, English labels; phone width: no sideways scroll", async ({ page }) => {
    const admin = await staff("PLATFORM_ADMIN", "en");
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, admin, "en");
    await expect(page.getByRole("heading", { name: "Approval Center" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByTestId("ac-tab-BRANCH_VERIFICATION")).toContainText("Branch verification");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("a brand request decided in its own screen leaves the inbox", async ({ page }) => {
    await seedPending();
    const admin = await staff("PLATFORM_ADMIN");
    const before = await call<{ sources: { source: string; pending: number }[] }>("/admin/approval-center/summary", { token: admin.token });
    const pendingBefore = before.body.sources.find((s) => s.source === "BRAND_REQUEST")!.pending;
    expect(pendingBefore).toBeGreaterThan(0);
    await open(page, admin);
    await page.getByTestId("ac-tab-BRAND_REQUEST").click();
    await page.locator("[data-testid='ac-row'] a").first().click();
    await expect(page).toHaveURL(/\/admin\/brands\/requests$/);
    await page.getByTestId("br-row").first().getByRole("button", { name: "اعتماد" }).click();
    await expect(page.locator(".notice-banner")).toBeVisible();
    await page.goto("/admin/approvals");
    await expect(page.getByTestId("ac-tab-BRAND_REQUEST")).toHaveAttribute("data-pending", String(pendingBefore - 1));
  });
});
