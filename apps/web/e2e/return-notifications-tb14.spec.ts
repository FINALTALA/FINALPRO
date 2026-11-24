import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { call, createVendorWithBranch, unique, uniquePhone } from "./helpers/api";
import { audienceOf, makeVendorEligible, prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// TB-14: the return notifications in the shared inbox (the «الإشعارات»
// page and the drawer) - each type's words in Arabic and English, the
// escalation alert's detail line (which return, and why - a fixed code),
// where each one leads, and the platform alerts disappearing for an
// account that is no longer an active administrator. Which events
// produce which rows, for whom, is proven by the API suite
// (apps/api/test/tb14-return-notifications.e2e-spec.ts); here the rows
// are written straight into the disposable test database.
//
// TB-26 (2026-11-18 regression fix): each context reads its own inbox -
// the shopping «الإشعارات» page and drawer: CUSTOMER rows only (always,
// whatever workspace_scoping_enabled says); the store's notifications in
// its workspace inbox; the platform alerts in the platform inbox.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

type NotificationType =
  | "RETURN_REQUESTED"
  | "RETURN_VENDOR_REMINDER"
  | "RETURN_APPROVED"
  | "RETURN_REJECTED"
  | "RETURN_ADMIN_REJECTED"
  | "RETURN_ESCALATED"
  | "RETURN_REFUNDED"
  | "RETURN_EXCHANGED"
  | "RETURN_CODE_EXPIRED"
  | "RETURN_ESCALATION_ALERT"
  | "ORDER_INTEGRITY_ALERT";

const TITLES: Record<"ar" | "en", Record<string, string>> = {
  ar: {
    RETURN_REQUESTED: "طلب إرجاع جديد في فرعك",
    RETURN_VENDOR_REMINDER: "تذكير: طلب إرجاع ينتظر قرارك منذ 48 ساعة",
    RETURN_APPROVED: "تمت الموافقة على طلب الإرجاع",
    RETURN_REJECTED: "رُفض طلب الإرجاع",
    RETURN_ADMIN_REJECTED: "رفضت إدارة المنصة طلب الإرجاع نهائياً",
    RETURN_ESCALATED: "أُحيل طلب الإرجاع إلى إدارة المنصة",
    RETURN_REFUNDED: "تم استرداد مبلغ الإرجاع",
    RETURN_EXCHANGED: "تم استبدال المنتج",
    RETURN_CODE_EXPIRED: "انتهت صلاحية كود تسليم الإرجاع",
    RETURN_ESCALATION_ALERT: "إرجاع متصاعد ينتظر قرار المنصة",
  },
  en: {
    RETURN_REQUESTED: "New return request at your branch",
    RETURN_VENDOR_REMINDER: "Reminder: a return request has awaited your decision for 48 hours",
    RETURN_APPROVED: "Your return request was approved",
    RETURN_REJECTED: "Your return request was rejected",
    RETURN_ADMIN_REJECTED: "The platform rejected your return request",
    RETURN_ESCALATED: "Your return request was referred to the platform",
    RETURN_REFUNDED: "Your return was refunded",
    RETURN_EXCHANGED: "Your item was exchanged",
    RETURN_CODE_EXPIRED: "Your return drop-off code has expired",
    RETURN_ESCALATION_ALERT: "Escalated return awaiting a platform decision",
  },
};
const CUSTOMER_TYPES: NotificationType[] = [
  "RETURN_APPROVED",
  "RETURN_REJECTED",
  "RETURN_ADMIN_REJECTED",
  "RETURN_ESCALATED",
  "RETURN_REFUNDED",
  "RETURN_EXCHANGED",
  "RETURN_CODE_EXPIRED",
];

/** An account signed in with a password (the OTP throttle belongs to global-setup). */
async function account(opts: { platformRole?: "PLATFORM_ADMIN"; languagePref?: "ar" | "en" } = {}) {
  const phone = uniquePhone();
  const user = await prisma.user.create({
    data: {
      phone,
      passwordHash: PASSWORD_HASH,
      phoneVerifiedAt: new Date(),
      platformRole: opts.platformRole ?? null,
      languagePref: opts.languagePref ?? "ar",
    },
  });
  await prisma.customerProfile.create({ data: { userId: user.id } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, phone, token: res.body.session_token };
}

/** A real, active store owned by this account (the store inbox needs a membership). */
async function ownStore(owner: { token: string }) {
  const { vendorId, branchId } = await createVendorWithBranch(owner.token);
  await makeVendorEligible(vendorId);
  return { vendorId, branchId };
}

/** One delivered notification, newest last - as the relay writes it. */
async function deliver(
  userId: string,
  type: NotificationType,
  extra: { targetId?: string; data?: Record<string, unknown>; vendorId?: string; branchId?: string } = {},
) {
  const event = await prisma.outboxEvent.create({
    data: { eventType: `tb14.ui.${type}`, payload: {}, status: "PUBLISHED", publishedAt: new Date() },
  });
  return prisma.notification.create({
    data: {
      outboxEventId: event.id,
      recipientUserId: userId,
      type,
      targetType: type === "ORDER_INTEGRITY_ALERT" ? "BRANCH_ORDER" : "RETURN",
      targetId: extra.targetId ?? unique("ret"),
      data: extra.data ?? {},
      vendorId: extra.vendorId ?? null,
      branchId: extra.branchId ?? null,
      audience: audienceOf(type),
    },
  });
}

const itemTitled = (page: Page, title: string) => page.locator("button.card", { hasText: title });

test.describe("TB-14: return notifications in the inbox", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();

  test("customer: each of their seven return notifications, in Arabic, leads to that return", async ({ page }) => {
    const customer = await account();
    const returnId = "00000000-0000-4000-8000-0000000000a1";
    for (const type of CUSTOMER_TYPES) {
      await deliver(customer.id, type, { targetId: type === "RETURN_APPROVED" ? returnId : undefined });
    }
    await loginAs(page, customer.token);
    await page.goto("/notifications");
    for (const type of CUSTOMER_TYPES) {
      await expect(itemTitled(page, TITLES.ar[type])).toBeVisible({ timeout: 30_000 });
    }
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await itemTitled(page, TITLES.ar.RETURN_APPROVED).click();
    await expect(page).toHaveURL(new RegExp(`/returns/${returnId}$`));
    expect(await page.content()).not.toContain(customer.phone);
  });

  test("store: a new request and the 48h reminder are in the store's inbox - never in the shopping bell - and lead to that branch's returns page", async ({ page }) => {
    const owner = await account();
    const { vendorId, branchId } = await ownStore(owner);
    await deliver(owner.id, "RETURN_REQUESTED", { vendorId, branchId });
    await deliver(owner.id, "RETURN_VENDOR_REMINDER", { vendorId, branchId });
    await loginAs(page, owner.token);
    await page.goto("/notifications");
    await expect(page.getByTestId("notifications-title")).toBeVisible({ timeout: 30_000 });
    await expect(itemTitled(page, TITLES.ar.RETURN_REQUESTED)).toHaveCount(0);
    await expect(itemTitled(page, TITLES.ar.RETURN_VENDOR_REMINDER)).toHaveCount(0);
    await enterWorkspace(page, owner.token, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/notifications`);
    await expect(itemTitled(page, TITLES.ar.RETURN_VENDOR_REMINDER)).toBeVisible({ timeout: 30_000 });
    await itemTitled(page, TITLES.ar.RETURN_REQUESTED).click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/branches/${branchId}/returns\\?return=[^&]+$`));
  });

  test("platform administrator: the escalation alert names the return and why, and leads to the escalated-returns queue", async ({ page }) => {
    const admin = await account({ platformRole: "PLATFORM_ADMIN" });
    const sla = "00000000-0000-4000-8000-0000000000c1";
    const disputed = "00000000-0000-4000-8000-0000000000c2";
    await deliver(admin.id, "RETURN_ESCALATION_ALERT", { targetId: sla, data: { reason: "SLA_TIMEOUT" } });
    await deliver(admin.id, "RETURN_ESCALATION_ALERT", { targetId: disputed, data: { reason: "CUSTOMER_DISPUTE" } });
    await loginAs(page, admin.token);
    await enterWorkspace(page, admin.token, { type: "platform" });
    await page.goto("/admin/notifications");
    await expect(page.getByText(`الإرجاع ${sla} - لم يقرّر المتجر خلال 72 ساعة`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`الإرجاع ${disputed} - اعترض العميل على رفض المتجر`)).toBeVisible();
    await expect(itemTitled(page, TITLES.ar.RETURN_ESCALATION_ALERT)).toHaveCount(2);
    await itemTitled(page, TITLES.ar.RETURN_ESCALATION_ALERT).first().click();
    await expect(page).toHaveURL(/\/admin\/returns$/);
  });

  test("the shopping drawer never shows a platform alert; the platform inbox shows its words and detail", async ({ page }) => {
    const admin = await account({ platformRole: "PLATFORM_ADMIN" });
    const id = "00000000-0000-4000-8000-0000000000d1";
    await deliver(admin.id, "RETURN_ESCALATION_ALERT", { targetId: id, data: { reason: "CUSTOMER_DISPUTE" } });
    await deliver(admin.id, "RETURN_APPROVED");
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, admin.token);
    await page.goto("/");
    await page.getByRole("button", { name: "التنبيهات" }).click();
    await expect(page.locator(".notifications-drawer-item", { hasText: TITLES.ar.RETURN_APPROVED })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".notifications-drawer-item", { hasText: TITLES.ar.RETURN_ESCALATION_ALERT })).toHaveCount(0);
    await enterWorkspace(page, admin.token, { type: "platform" });
    await page.goto("/admin/notifications");
    const item = itemTitled(page, TITLES.ar.RETURN_ESCALATION_ALERT);
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(item).toContainText(`الإرجاع ${id} - اعترض العميل على رفض المتجر`);
  });

  test("platform alerts are never in the shopping bell (its badge counts the account's own only); in the platform inbox only while the account is an active PLATFORM_ADMIN", async ({ page }) => {
    const admin = await account({ platformRole: "PLATFORM_ADMIN" });
    await deliver(admin.id, "RETURN_ESCALATION_ALERT", { data: { reason: "SLA_TIMEOUT" } });
    await deliver(admin.id, "ORDER_INTEGRITY_ALERT", { data: { issue: "DELIVERED_WITHOUT_DELIVERED_AT" } });
    await deliver(admin.id, "RETURN_APPROVED");
    await loginAs(page, admin.token);
    await page.goto("/notifications");
    const badge = page.getByRole("button", { name: "التنبيهات" }).locator(".badge-count");
    await expect(itemTitled(page, TITLES.ar.RETURN_APPROVED)).toBeVisible({ timeout: 30_000 });
    await expect(itemTitled(page, TITLES.ar.RETURN_ESCALATION_ALERT)).toHaveCount(0);
    await expect(itemTitled(page, "طلب بحالة غير سليمة يحتاج مراجعة")).toHaveCount(0);
    await expect(badge).toHaveText("1");

    await enterWorkspace(page, admin.token, { type: "platform" });
    await page.goto("/admin/notifications");
    await expect(itemTitled(page, TITLES.ar.RETURN_ESCALATION_ALERT)).toBeVisible({ timeout: 30_000 });
    await expect(itemTitled(page, "طلب بحالة غير سليمة يحتاج مراجعة")).toBeVisible();

    await prisma.user.update({ where: { id: admin.id }, data: { platformRole: null } });
    await page.reload();
    await expect(page.getByTestId("notifications-title")).toBeVisible({ timeout: 30_000 });
    await expect(itemTitled(page, TITLES.ar.RETURN_ESCALATION_ALERT)).toHaveCount(0);
    await expect(itemTitled(page, "طلب بحالة غير سليمة يحتاج مراجعة")).toHaveCount(0);
    await page.goto("/notifications");
    await expect(itemTitled(page, TITLES.ar.RETURN_APPROVED)).toBeVisible({ timeout: 30_000 });
    await expect(badge).toHaveText("1");
  });

  // One administrator, signed in once, for both languages - the login
  // endpoint allows 10 a minute per address. Its saved language is
  // switched directly in the test database between the two runs, and its
  // inbox is emptied first so each run sees exactly its own ten rows.
  let langAdmin: Awaited<ReturnType<typeof account>> | null = null;
  let langStore: { vendorId: string; branchId: string } | null = null;
  async function inboxIn(browser: Browser, lang: "ar" | "en") {
    // A signed-in user's saved language wins over the browser's (Sprint 22).
    langAdmin ??= await account({ platformRole: "PLATFORM_ADMIN", languagePref: lang });
    const admin = langAdmin;
    langStore ??= await ownStore(admin);
    const store = langStore;
    await prisma.user.update({ where: { id: admin.id }, data: { languagePref: lang } });
    await prisma.notification.deleteMany({ where: { recipientUserId: admin.id } });
    const types = Object.keys(TITLES.ar) as NotificationType[];
    for (const type of types) {
      await deliver(admin.id, type, {
        data: type === "RETURN_ESCALATION_ALERT" ? { reason: "SLA_TIMEOUT" } : {},
        vendorId: store.vendorId,
        branchId: store.branchId,
      });
    }
    // TB-26: each type in the inbox of its own context, and only there.
    const inboxes = [
      { path: "/notifications", audience: "CUSTOMER" as const },
      { path: `/vendor/${store.vendorId}/notifications`, audience: "STORE" as const },
      { path: "/admin/notifications", audience: "PLATFORM" as const },
    ];
    for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 760 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
      await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
      const page = await context.newPage();
      await loginAs(page, admin.token);
      await enterWorkspace(page, admin.token, { type: "vendor", vendor_id: store.vendorId });
      await enterWorkspace(page, admin.token, { type: "platform" });
      for (const inbox of inboxes) {
        await page.goto(inbox.path);
        for (const type of types) {
          if (audienceOf(type) === inbox.audience) {
            await expect(itemTitled(page, TITLES[lang][type])).toBeVisible({ timeout: 30_000 });
          } else {
            await expect(itemTitled(page, TITLES[lang][type])).toHaveCount(0);
          }
        }
        await expect(page.locator("html")).toHaveAttribute("dir", lang === "en" ? "ltr" : "rtl");
        if (inbox.audience === "PLATFORM") {
          await expect(
            page.getByText(lang === "en" ? "The store did not decide within 72 hours" : "لم يقرّر المتجر خلال 72 ساعة"),
          ).toBeVisible();
        }
        await expectNoHorizontalOverflow(page);
        expect(await page.content()).not.toContain(admin.phone);
      }
      await context.close();
    }
  }
  for (const lang of ["ar", "en"] as const) {
    test(`${lang}, desktop and phone: all ten return notifications' words and direction, each in its own context's inbox, no sideways scroll`, async ({ browser }) => {
      await inboxIn(browser, lang);
    });
  }

  test("the recipients page describes RETURN_ESCALATION as sent now, in Arabic and English", async ({ browser }) => {
    const setLang = (language_pref: string) =>
      call("/customers/me", { method: "PATCH", token: fixtures.adminToken, idempotencyKey: unique("lang"), body: { language_pref } });
    const words = {
      ar: "إرجاع وصل إلى التصعيد وينتظر قرار المنصة: لم يقرّر المتجر خلال 72 ساعة، أو اعترض العميل على رفض المتجر.",
      en: "A return escalated to the platform for a decision: the store did not decide within 72 hours, or the customer disputed its rejection.",
    };
    try {
      for (const lang of ["ar", "en"] as const) {
        expect((await setLang(lang)).status).toBe(200);
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
        const page = await context.newPage();
        await loginAs(page, fixtures.adminToken);
        await enterWorkspace(page, fixtures.adminToken, { type: "platform" });
        await page.goto("/admin/alert-recipients");
        const section = page.locator('section[data-category="RETURN_ESCALATION"]');
        await expect(section.getByText(words[lang])).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(/not sent yet|لا تُرسل هذه التنبيهات بعد/)).toHaveCount(0);
        await context.close();
      }
    } finally {
      await setLang("ar");
    }
  });
});
