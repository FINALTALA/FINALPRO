import { expect, test, type Browser, type Page, type Route } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { call, createVendorWithBranch, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// TB-12.3: the PLATFORM_ADMIN's «مستلمو تنبيهات المنصة» page over
// GET/PUT/DELETE /admin/alert-recipients - both categories, the honest
// fallback warning, add/remove (one request and one audit row however
// often it is clicked, the same Idempotency-Key on a retry), loading and
// error states, every other role refused, AR/EN on desktop and phone
// without sideways scroll, and never a full phone number on the page.

const FORBIDDEN = "هذه الصفحة لمدير المنصة فقط";
const PATH = "/admin/alert-recipients";

// bcrypt of "a-strong-password": the extra accounts below are created in
// the test database and signed in with a password, because the shared
// OTP-request throttle (5/60 s) is already used by global-setup.
const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

async function accountWithSession(platformRole: "VERIFICATION_REVIEWER" | null): Promise<{ id: string; token: string }> {
  const phone = uniquePhone();
  const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), platformRole } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
  if (!res.body.session_token) throw new Error(`login(${phone}) failed (status ${res.status}): ${JSON.stringify(res.body)}`);
  return { id: user.id, token: res.body.session_token };
}

const activeAdminCount = () => prisma.user.count({ where: { platformRole: "PLATFORM_ADMIN", deactivatedAt: null } });

test.describe("TB-12.3: platform alert recipients admin page", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  // A second active administrator to subscribe - a target only, it never signs in.
  const targetPhone = uniquePhone();
  let targetId = "";
  let reviewerToken = "";
  let employeeToken = "";

  const section = (page: Page, category: string) => page.locator(`section[data-category="${category}"]`);
  const audits = (action: string) =>
    prisma.auditLog.count({ where: { entityType: "User", entityId: targetId, action } });

  test.beforeAll(async () => {
    // This file owns every subscription in the disposable test database.
    await prisma.platformAlertRecipient.deleteMany({});
    targetId = (
      await prisma.user.create({
        data: { phone: targetPhone, passwordHash: "x", phoneVerifiedAt: new Date(), platformRole: "PLATFORM_ADMIN" },
      })
    ).id;
    reviewerToken = (await accountWithSession("VERIFICATION_REVIEWER")).token;
    const employee = await accountWithSession(null);
    employeeToken = employee.token;
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    await prisma.vendorUser.create({ data: { userId: employee.id, vendorId, role: "BRANCH_EMPLOYEE", branchId } });
  });

  test.afterAll(async () => {
    await prisma.platformAlertRecipient.deleteMany({ where: { userId: targetId } });
    await prisma.user.update({ where: { id: targetId }, data: { platformRole: null, deactivatedAt: new Date() } });
  });

  test("with nobody chosen, both categories warn that alerts go to every active administrator", async ({ page }) => {
    await loginAs(page, fixtures.adminToken);
    await enterWorkspace(page, fixtures.adminToken, { type: "platform" });
    await page.goto(PATH);
    await expect(page.getByRole("heading", { name: "مستلمو تنبيهات المنصة" })).toBeVisible({ timeout: 30_000 });
    const n = await activeAdminCount();
    for (const [category, title] of [["ORDER_INTEGRITY", "سلامة الطلبات"], ["RETURN_ESCALATION", "تصعيد الإرجاعات"]]) {
      const s = section(page, category);
      await expect(s.getByRole("heading", { name: title })).toBeVisible();
      await expect(s.getByText("بلا مستلم محدّد")).toBeVisible();
      await expect(s.getByRole("note")).toHaveText(
        `لا يوجد مستلم محدّد لهذه الفئة، لذلك ستصل تنبيهاتها إلى كل مدراء المنصة النشطين (${n}).`,
      );
    }
    // The target is offered by short id and phone hint - never the full number.
    await expect(
      section(page, "ORDER_INTEGRITY").locator("option", { hasText: `${targetId.slice(0, 8)} · •••${targetPhone.slice(-3)}` }),
    ).toHaveCount(1);
    expect(await page.content()).not.toContain(targetPhone);
    expect(await page.content()).not.toContain(targetPhone.slice(1));
  });

  test("adding: one request and one audit row even when clicked twice; the warning clears for that category only", async ({ page }) => {
    const puts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "PUT" && r.url().includes("/admin/alert-recipients/")) puts.push(r.url());
    });
    await loginAs(page, fixtures.adminToken);
    await enterWorkspace(page, fixtures.adminToken, { type: "platform" });
    await page.goto(PATH);
    const s = section(page, "ORDER_INTEGRITY");
    await s.getByLabel("إضافة مستلم").selectOption(targetId);
    await s.getByRole("button", { name: "إضافة" }).dblclick();
    await expect(page.locator(".notice-banner")).toHaveText("تمت إضافة المستلم.", { timeout: 30_000 });
    await expect(s.getByText("مستلمون محدّدون: 1")).toBeVisible();
    await expect(s.getByRole("note")).toHaveCount(0);
    await expect(s.locator(".admin-alert-row")).toHaveCount(1);
    await expect(s.locator(".admin-alert-admin")).toHaveText(`${targetId.slice(0, 8)} · •••${targetPhone.slice(-3)}`);
    await expect(section(page, "RETURN_ESCALATION").getByRole("note")).toBeVisible();

    expect(puts).toHaveLength(1);
    expect(await prisma.platformAlertRecipient.count({ where: { userId: targetId, category: "ORDER_INTEGRITY" } })).toBe(1);
    expect(await audits("platform_alert_recipient.added")).toBe(1);
    expect(await page.content()).not.toContain(targetPhone);
  });

  test("removing the last recipient asks first, then the fallback warning returns", async ({ page }) => {
    await loginAs(page, fixtures.adminToken);
    await enterWorkspace(page, fixtures.adminToken, { type: "platform" });
    await page.goto(PATH);
    const s = section(page, "ORDER_INTEGRITY");
    await expect(s.locator(".admin-alert-row")).toHaveCount(1, { timeout: 30_000 });

    // Declining changes nothing.
    page.once("dialog", (d) => d.dismiss());
    await s.getByRole("button", { name: "إزالة" }).click();
    await expect(s.locator(".admin-alert-row")).toHaveCount(1);

    page.once("dialog", (d) => {
      expect(d.message()).toContain("كل مدراء المنصة النشطين");
      void d.accept();
    });
    await s.getByRole("button", { name: "إزالة" }).click();
    await expect(page.locator(".notice-banner")).toHaveText("تمت إزالة المستلم.", { timeout: 30_000 });
    await expect(s.getByRole("note")).toBeVisible();
    await expect(s.getByText("لا أحد بعد.")).toBeVisible();
    expect(await prisma.platformAlertRecipient.count({ where: { userId: targetId } })).toBe(0);
    expect(await audits("platform_alert_recipient.removed")).toBe(1);
  });

  test("an unconfirmed add says so honestly, and the retry reuses its Idempotency-Key", async ({ page }) => {
    const keys: string[] = [];
    let failNext = true;
    await loginAs(page, fixtures.adminToken);
    await enterWorkspace(page, fixtures.adminToken, { type: "platform" });
    await page.route("**/admin/alert-recipients/RETURN_ESCALATION/*", async (route: Route) => {
      keys.push(route.request().headers()["idempotency-key"]);
      if (failNext) {
        failNext = false;
        await route.abort("connectionreset");
      } else {
        await route.continue();
      }
    });
    await page.goto(PATH);
    const s = section(page, "RETURN_ESCALATION");
    await s.getByLabel("إضافة مستلم").selectOption(targetId);
    await s.getByRole("button", { name: "إضافة" }).click();
    await expect(page.locator(".error-banner")).toHaveText("تعذّر الاتصال بالخادم. لم يتأكد تنفيذ العملية؛ أعيدي المحاولة.", {
      timeout: 30_000,
    });
    expect(await prisma.platformAlertRecipient.count({ where: { userId: targetId } })).toBe(0);
    await expect(s.getByRole("note")).toBeVisible();

    await s.getByRole("button", { name: "إضافة" }).click();
    await expect(page.locator(".notice-banner")).toHaveText("تمت إضافة المستلم.", { timeout: 30_000 });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(await audits("platform_alert_recipient.added")).toBe(2); // one per real change: ORDER_INTEGRITY earlier, this one now
  });

  test("loading shows a skeleton; a failed load shows an error and a working retry; an older API says it is unavailable", async ({ page }) => {
    await loginAs(page, fixtures.adminToken);
    await enterWorkspace(page, fixtures.adminToken, { type: "platform" });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route(`**/api/v1${PATH}`, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(PATH);
    await expect(page.getByLabel("جارٍ تحميل المستلمين...")).toBeVisible({ timeout: 30_000 });
    release();
    await expect(section(page, "ORDER_INTEGRITY")).toBeVisible({ timeout: 30_000 });
    await page.unroute(`**/api/v1${PATH}`);

    const failWith = (status: number, code: string) => (route: Route) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code, message: "boom: internal detail", details: [] } }) });
    await page.route(`**/api/v1${PATH}`, failWith(500, "INTERNAL_ERROR"));
    await page.goto(PATH);
    await expect(page.locator(".error-banner")).toHaveText("حدث خطأ في الخادم. لم يتأكد تنفيذ العملية؛ أعيدي المحاولة.", { timeout: 30_000 });
    expect(await page.locator("body").innerText()).not.toContain("internal detail");
    await page.unroute(`**/api/v1${PATH}`);
    await page.getByRole("button", { name: "إعادة المحاولة" }).click();
    await expect(section(page, "ORDER_INTEGRITY")).toBeVisible({ timeout: 30_000 });

    await page.route(`**/api/v1${PATH}`, failWith(404, "NOT_FOUND"));
    await page.goto(PATH);
    await expect(page.locator(".error-banner")).toHaveText("إدارة مستلمي التنبيهات غير متاحة على هذا الخادم بعد.", { timeout: 30_000 });
  });

  async function openAs(browser: Browser, token: string, platformStaff = false) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const calls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/v1/admin/alert-recipients")) calls.push(r.url());
    });
    await loginAs(page, token);
    // TB-26: platform staff enter the platform workspace; nobody else can.
    if (platformStaff) await enterWorkspace(page, token, { type: "platform" });
    await page.goto(PATH);
    return { context, page, calls };
  }

  for (const role of ["owner", "employee", "customer", "reviewer"] as const) {
    test(`${role}: "platform admin only", no recipients request and no administrator shown`, async ({ browser }) => {
      const token = { owner: fixtures.ownerToken, employee: employeeToken, customer: fixtures.customerAToken, reviewer: reviewerToken }[role];
      const { context, page, calls } = await openAs(browser, token, role === "reviewer");
      // A reviewer is platform staff: inside the workspace the page itself
      // says "admin only"; the others are stopped at the workspace entry.
      if (role === "reviewer") await expect(page.getByText(FORBIDDEN)).toBeVisible({ timeout: 30_000 });
      else await expect(page.getByTestId("ws-enter-no-access")).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1_000);
      if (role === "reviewer") await expect(page.getByText(FORBIDDEN)).toBeVisible();
      else await expect(page.getByTestId("ws-enter-no-access")).toBeVisible();
      await expect(page.locator(".admin-alert-category")).toHaveCount(0);
      expect(await page.content()).not.toContain(targetId.slice(0, 8));
      expect(calls).toEqual([]);
      // The API is the final word, whatever the page shows.
      expect((await call(PATH, { token })).status).toBe(403);
      await context.close();
    });
  }

  test("a guest is sent to sign in, and the API refuses it", async ({ page }) => {
    await page.goto(PATH);
    await expect(page).toHaveURL(/\/login\?next=/, { timeout: 30_000 });
    expect((await call(PATH)).status).toBe(401);
  });

  test("the admin hub links to the page", async ({ page }) => {
    await loginAs(page, fixtures.adminToken);
    await enterWorkspace(page, fixtures.adminToken, { type: "platform" });
    await page.goto("/admin");
    await page.getByRole("link", { name: /مستلمو تنبيهات المنصة/ }).click();
    await expect(page).toHaveURL(new RegExp(`${PATH}$`));
    await expect(section(page, "ORDER_INTEGRITY")).toBeVisible({ timeout: 30_000 });
  });

  // A signed-in user's saved language wins over the browser's (Sprint 22),
  // so the admin's own preference is set for each language, then restored.
  const words = {
    ar: { title: "مستلمو تنبيهات المنصة", order: "سلامة الطلبات", subscribed: "مستلمون محدّدون: 1", warning: "ستصل تنبيهاتها إلى كل مدراء المنصة النشطين" },
    en: { title: "Platform alert recipients", order: "Order integrity", subscribed: "Chosen recipients: 1", warning: "its alerts go to every active platform administrator" },
  };
  for (const lang of ["ar", "en"] as const) {
    test(`${lang}, desktop and phone: right words and direction, fallback warning, no sideways scroll`, async ({ browser }) => {
      const setLang = (language_pref: string) =>
        call("/customers/me", { method: "PATCH", token: fixtures.adminToken, idempotencyKey: unique("lang"), body: { language_pref } });
      // ORDER_INTEGRITY has its recipient again for this check; RETURN_ESCALATION already has one from the retry test.
      await prisma.platformAlertRecipient.deleteMany({ where: { userId: targetId, category: "RETURN_ESCALATION" } });
      await prisma.platformAlertRecipient.upsert({
        where: { userId_category: { userId: targetId, category: "ORDER_INTEGRITY" } },
        create: { userId: targetId, category: "ORDER_INTEGRITY" },
        update: {},
      });
      try {
        expect((await setLang(lang)).status).toBe(200);
        for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 760 }]) {
          const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
          await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
          const page = await context.newPage();
          await loginAs(page, fixtures.adminToken);
          await enterWorkspace(page, fixtures.adminToken, { type: "platform" });
          await page.goto(PATH);
          await expect(page.getByRole("heading", { name: words[lang].title })).toBeVisible({ timeout: 20_000 });
          await expect(page.locator("html")).toHaveAttribute("dir", lang === "en" ? "ltr" : "rtl");
          await expect(section(page, "ORDER_INTEGRITY").getByRole("heading", { name: words[lang].order })).toBeVisible();
          await expect(section(page, "ORDER_INTEGRITY").getByText(words[lang].subscribed)).toBeVisible();
          await expect(section(page, "RETURN_ESCALATION").getByRole("note")).toContainText(words[lang].warning);
          await expectNoHorizontalOverflow(page);
          await context.close();
        }
      } finally {
        await setLang("ar");
      }
    });
  }
});
