import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { call, createVendorWithBranch, signup, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// TB-3: the admin size-guide editor decides "who may see this" before
// "still loading": a guest goes to sign-in, an owner, a branch employee
// or a customer gets the "platform admin only" message at once - no
// endless skeleton, no admin API call, nothing of the guide - and the
// platform admin still gets the editor.

const FORBIDDEN = "هذه الصفحة لمدير المنصة فقط";

test.describe("TB-3: size-guide editor for non-admins", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  const name = `دليل محجوب ${unique("t").slice(-6)}`;
  let guideId = "";
  let employeeToken = "";

  test.beforeAll(async () => {
    const created = await call<{ id: string }>("/admin/size-guides", {
      method: "POST",
      token: fixtures.adminToken,
      idempotencyKey: unique("sg"),
      body: { code: unique("tb3-guide").toLowerCase(), name_ar: name, name_en: `Hidden ${name.slice(-6)}`, kind: "STANDARD" },
    });
    expect(created.status).toBe(201);
    guideId = created.body.id;
    // A branch employee of a real store.
    const phone = uniquePhone();
    employeeToken = await signup(phone, "a-strong-password");
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    await prisma.vendorUser.create({ data: { userId: user.id, vendorId, role: "BRANCH_EMPLOYEE", branchId } });
  });

  /** Opens the editor as `token` and returns the admin API calls the page made. */
  async function openAs(browser: Browser, token: string, viewport = { width: 1280, height: 900 }, lang = "ar") {
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
    await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
    const page = await context.newPage();
    const adminCalls: string[] = [];
    page.on("request", (r) => {
      if (/\/api\/v1\/admin\//.test(r.url())) adminCalls.push(r.url());
    });
    await loginAs(page, token);
    // TB-26: the admin enters the platform workspace; nobody else can.
    if (token === fixtures.adminToken) await enterWorkspace(page, token, { type: "platform" });
    await page.goto(`/admin/size-guides/${guideId}`);
    return { context, page, adminCalls };
  }

  // TB-26: a non-admin is stopped at the platform workspace's entry
  // confirmation (its own "no access" words) before the editor - or any
  // admin call - can run.
  async function expectForbidden(page: Page, adminCalls: string[]) {
    await expect(page).toHaveURL(/\/workspaces\/enter\?type=platform/, { timeout: 20_000 });
    await expect(page.getByTestId("ws-enter-no-access")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".skeleton")).toHaveCount(0);
    await expect(page.getByText(name)).toHaveCount(0);
    for (const button of ["حفظ المسودة", "نشر هذا الإصدار", "إضافة", "إيقاف الدليل"]) {
      await expect(page.getByRole("button", { name: button })).toHaveCount(0);
    }
    // Still there a moment later (not a flash before an endless skeleton), with no admin call.
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId("ws-enter-no-access")).toBeVisible();
    expect(adminCalls).toEqual([]);
  }

  test("a guest is sent to sign in", async ({ page }) => {
    await page.goto(`/admin/size-guides/${guideId}`);
    await expect(page).toHaveURL(/\/login\?next=/, { timeout: 20_000 });
  });

  for (const role of ["owner", "employee", "customer"] as const) {
    test(`${role}: the "platform admin only" message at once - no skeleton, no admin request, nothing of the guide`, async ({ browser }) => {
      const token = role === "owner" ? fixtures.ownerToken : role === "employee" ? employeeToken : fixtures.customerAToken;
      const { context, page, adminCalls } = await openAs(browser, token);
      await expectForbidden(page, adminCalls);
      await context.close();
    });
  }

  test("the platform admin still gets the editor", async ({ browser }) => {
    const { context, page } = await openAs(browser, fixtures.adminToken);
    await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(FORBIDDEN)).toHaveCount(0);
    await context.close();
  });

  // A signed-in user's saved language wins over the browser's (Sprint 22),
  // so the account's own preference is set for each language, then restored.
  for (const who of ["customer", "admin"] as const) {
    test(`${who}: Arabic and English, desktop and phone - right direction, no sideways scroll`, async ({ browser }) => {
      const token = who === "admin" ? fixtures.adminToken : fixtures.customerAToken;
      const setLang = (language_pref: string) =>
        call("/customers/me", { method: "PATCH", token, idempotencyKey: unique("lang"), body: { language_pref } });
      try {
        for (const lang of ["ar", "en"]) {
          expect((await setLang(lang)).status).toBe(200);
          for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 760 }]) {
            const { context, page, adminCalls } = await openAs(browser, token, viewport, lang);
            if (who === "admin") await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 20_000 });
            else await expect(page.getByTestId("ws-enter-no-access")).toBeVisible({ timeout: 20_000 });
            await expect(page.locator("html")).toHaveAttribute("dir", lang === "en" ? "ltr" : "rtl");
            await expectNoHorizontalOverflow(page);
            if (who === "customer") expect(adminCalls).toEqual([]);
            await context.close();
          }
        }
      } finally {
        await setLang("ar");
      }
    });
  }
});
