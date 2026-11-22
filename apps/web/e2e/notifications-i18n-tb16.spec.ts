import { expect, test, type Browser } from "@playwright/test";
import { NotificationType as ApiNotificationType } from "../../api/generated/prisma/enums";
import {
  NOTIFICATION_TITLES,
  NOTIFICATION_TYPES,
  type NotificationDto,
  notificationDetail,
  notificationLabel,
} from "../src/lib/notifications";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { call, uniquePhone } from "./helpers/api";
import { audienceOf, prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";

// TB-16.3: the notification inbox (page and drawer) in Arabic and English -
// every NotificationType the API has (old, TB-14, TB-15, and the Sprint 20a
// order-exception types that had no web title at all), every structured
// detail line, dates in the interface language, links unchanged, errors in
// the unified words (never the server's text) following a language switch,
// desktop and phone, for the store owner, the customer and the platform
// administrator. Rows are written straight into the disposable test
// database, exactly as the relay writes them.

const ARABIC = /[؀-ۿ]/;
type Lang = "ar" | "en";

test.describe("TB-16.3: notification words (pure)", () => {
  test("every API notification type has a title in Arabic and English - no more, no fewer, never the raw code", () => {
    const api = Object.values(ApiNotificationType).sort();
    expect([...NOTIFICATION_TYPES].sort()).toEqual(api);
    for (const type of api) {
      const ar = notificationLabel(type, "ar");
      const en = notificationLabel(type, "en");
      expect(ar).toMatch(ARABIC);
      expect(en).not.toMatch(ARABIC);
      expect(en.length).toBeGreaterThan(3);
      for (const words of [ar, en]) expect(words).not.toBe(type);
    }
    // A type the web does not know yet: a plain title, never its code.
    expect(notificationLabel("SOMETHING_NEW", "ar")).toBe("إشعار");
    expect(notificationLabel("SOMETHING_NEW", "en")).toBe("Notification");
  });

  test("detail lines: every fixed code in both languages; unknown codes add nothing; the administrator's reason as written", () => {
    const n = (type: string, data: Record<string, unknown>, targetId = "t-1") =>
      ({ id: "n", type, data, target_type: "BRANCH_ORDER", target_id: targetId, vendor_id: null, branch_id: null, read_at: null, created_at: "" }) as NotificationDto;
    const cases: [NotificationDto, string, string][] = [
      [n("STOCK_ADJUSTMENT", { reason: "DAMAGE" }), "السبب: تلف", "Reason: Damage"],
      [n("STOCK_ADJUSTMENT", { reason: "LOSS" }), "السبب: فقدان", "Reason: Loss"],
      [n("STOCK_ADJUSTMENT", { reason: "COUNT_CORRECTION" }), "السبب: تصحيح جرد", "Reason: Count correction"],
      [n("VENDOR_SUSPENDED", { reason_code: "POLICY_VIOLATION" }), "السبب: مخالفة السياسة", "Reason: Policy violation"],
      [n("VENDOR_SUSPENDED", { reason_code: "NON_PAYMENT" }), "السبب: عدم السداد", "Reason: Non-payment"],
      [n("VENDOR_SUSPENDED", { reason_code: "OTHER" }), "السبب: سبب آخر", "Reason: Another reason"],
      [n("LOW_STOCK_AFTER_RESERVE", { remaining_quantity: 2 }), "الكمية المتبقية: 2", "Remaining quantity: 2"],
      [n("ORDER_INTEGRITY_ALERT", { issue: "PICKUP_IN_DELIVERY_STATUS" }, "o-1"), "الطلب o-1 - طلب استلام من المحل بحالة خاصة بالتوصيل", "Order o-1 - A pickup order in a delivery status"],
      [n("ORDER_INTEGRITY_ALERT", { issue: "DELIVERY_IN_PICKUP_STATUS" }, "o-1"), "الطلب o-1 - طلب توصيل بحالة خاصة بالاستلام من المحل", "Order o-1 - A delivery order in a pickup status"],
      [n("ORDER_INTEGRITY_ALERT", { issue: "DELIVERED_WITHOUT_DELIVERED_AT" }, "o-1"), "الطلب o-1 - طلب «تم التسليم» بلا وقت تسليم", "Order o-1 - Marked delivered with no delivery time"],
      [n("ORDER_INTEGRITY_ALERT", { issue: "NEW_ISSUE" }, "o-1"), "الطلب o-1", "Order o-1"],
      [n("REVIEW_HIDDEN", { reason: "Admin words as written" }), "السبب: Admin words as written", "Reason: Admin words as written"],
      [n("RETURN_ESCALATION_ALERT", { reason: "SLA_TIMEOUT" }, "r-1"), "الإرجاع r-1 - لم يقرّر المتجر خلال 72 ساعة", "Return r-1 - The store did not decide within 72 hours"],
      [n("RETURN_PLATFORM_APPROVED", { outcome: "EXCHANGE" }), "استبدال - حُجز البديل، بانتظار تسليم العميل للمنتج", "Exchange - replacement reserved, awaiting the customer's drop-off"],
    ];
    for (const [notification, ar, en] of cases) {
      expect(notificationDetail(notification, "ar")).toBe(ar);
      expect(notificationDetail(notification, "en")).toBe(en);
    }
    for (const unknown of [
      n("STOCK_ADJUSTMENT", { reason: "NEW_REASON" }),
      n("VENDOR_SUSPENDED", { reason_code: "NEW_CODE" }),
      n("LOW_STOCK_AFTER_RESERVE", { remaining_quantity: "2" }),
      n("RETURN_PLATFORM_APPROVED", { outcome: "NEW" }),
      n("PREP_REMINDER", {}),
    ]) {
      expect(notificationDetail(unknown, "ar")).toBeNull();
      expect(notificationDetail(unknown, "en")).toBeNull();
    }
  });
});

test.describe("TB-16.3: the inbox page and drawer in Arabic and English", () => {
  test.describe.configure({ mode: "serial" });

  const PASSWORD = "a-strong-password";
  const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
  type Acc = { id: string; token: string };
  let owner: Acc;
  let customer: Acc;
  let admin: Acc;
  // 2026-11-22: a real store of the owner - its STORE notifications are read
  // in that store's own inbox (/vendor/<id>/notifications), never in the
  // shopping bell (TB-26: the shopping bell lists CUSTOMER notifications only)
  let vendorId = "";
  let branchId = "";
  const TARGET = "order-tb16";

  // What each role receives (as the relay writes it: fixed codes only).
  const OWNER: [string, Record<string, unknown>][] = [
    ["STOCK_ADJUSTMENT", { reason: "DAMAGE" }],
    ["LOW_STOCK_AFTER_RESERVE", { remaining_quantity: 3 }],
    ["VENDOR_SUSPENDED", { reason_code: "NON_PAYMENT" }],
    ["NEW_ORDER_FOR_EMPLOYEE", {}],
    ["PREP_REMINDER", {}],
    ["ORDER_RESCHEDULED", {}],
    ["REFUND_REQUESTED", {}],
    ["ORDER_CANCELLED", {}],
    ["NOT_RECEIVED_REPORTED", {}],
  ];
  const CUSTOMER: [string, Record<string, unknown>][] = [
    ["DELIVERY_CONFIRM_REQUESTED", {}],
    ["ORDER_AUTO_CONFIRMED", {}],
    ["DELIVERY_FAILED", {}],
    ["REFUND_APPROVED", {}],
    ["REFUND_AUTOMATIC", {}],
    ["SLOT_MISSED", {}],
    ["FAVORITE_PRICE_DROP", {}],
    ["FOLLOWED_STORE_DISCOUNT", {}],
    ["REVIEW_HIDDEN", { reason: "Admin words as written" }],
  ];
  const ADMIN: [string, Record<string, unknown>][] = [["ORDER_INTEGRITY_ALERT", { issue: "DELIVERED_WITHOUT_DELIVERED_AT" }]];

  async function account(platformRole?: "PLATFORM_ADMIN"): Promise<Acc> {
    const phone = uniquePhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar", platformRole: platformRole ?? null },
    });
    await prisma.customerProfile.create({ data: { userId: user.id } });
    const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
    if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
    return { id: user.id, token: res.body.session_token };
  }
  /** `side`: ORDER_CANCELLED goes to both sides - the owner's copy is the store's. */
  async function deliver(userId: string, type: string, data: Record<string, unknown>, side: "CUSTOMER" | "STORE" = "CUSTOMER") {
    const event = await prisma.outboxEvent.create({
      data: { eventType: `tb16.ui.${type}`, payload: {}, status: "PUBLISHED", publishedAt: new Date() },
    });
    await prisma.notification.create({
      data: {
        outboxEventId: event.id,
        recipientUserId: userId,
        type: type as never,
        targetType: type === "STOCK_ADJUSTMENT" || type === "LOW_STOCK_AFTER_RESERVE" ? "STOCK" : type === "VENDOR_SUSPENDED" ? "VENDOR" : "BRANCH_ORDER",
        targetId: TARGET,
        data: data as never,
        vendorId,
        branchId,
        audience: audienceOf(type, side),
      },
    });
  }

  test.beforeAll(async () => {
    owner = await account();
    const vendor = await prisma.vendor.create({
      data: { slug: `tb16-${Date.now()}-${process.pid}`, legalName: `TB16 ${Date.now()}`, displayName: "متجر TB16", status: "ACTIVE", subscriptionStatus: "ACTIVE" },
    });
    const branch = await prisma.storeBranch.create({ data: { vendorId: vendor.id, name: "فرع TB16", isPhysical: true, verificationStatus: "APPROVED" } });
    await prisma.vendorUser.create({ data: { userId: owner.id, vendorId: vendor.id, role: "OWNER" } });
    vendorId = vendor.id;
    branchId = branch.id;
    customer = await account();
    admin = await account("PLATFORM_ADMIN");
    for (const [type, data] of OWNER) await deliver(owner.id, type, data, "STORE");
    for (const [type, data] of CUSTOMER) await deliver(customer.id, type, data);
    for (const [type, data] of ADMIN) await deliver(admin.id, type, data);
  });

  const expectedWords = (list: [string, Record<string, unknown>][], lang: Lang) =>
    list.map(([type, data]) => ({
      title: NOTIFICATION_TITLES[type as keyof typeof NOTIFICATION_TITLES][lang],
      detail: notificationDetail({ id: "", type, data, target_type: "BRANCH_ORDER", target_id: TARGET, vendor_id: null, branch_id: null, read_at: null, created_at: "" } as NotificationDto, lang),
    }));

  /** Each role's own inbox: the shopping one, the store's, the platform's. */
  type Where = "shopping" | "store" | "platform";
  const inboxPath = (where: Where) => (where === "store" ? `/vendor/${vendorId}/notifications` : where === "platform" ? "/admin/notifications" : "/notifications");
  const inboxTitle = (where: Where, lang: Lang) =>
    where === "store" ? (lang === "en" ? "Store notifications" : "إشعارات المتجر") : where === "platform" ? (lang === "en" ? "Platform notifications" : "إشعارات المنصة") : lang === "en" ? "Notifications" : "الإشعارات";
  async function inbox(browser: Browser, acc: Acc, list: [string, Record<string, unknown>][], where: Where) {
    for (const lang of ["ar", "en"] as const) {
      await prisma.user.update({ where: { id: acc.id }, data: { languagePref: lang } });
      for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 760 }]) {
        const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
        await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
        const page = await context.newPage();
        await loginAs(page, acc.token);
        if (where === "store") await enterWorkspace(page, acc.token, { type: "vendor", vendor_id: vendorId });
        if (where === "platform") await enterWorkspace(page, acc.token, { type: "platform" });
        await page.goto(inboxPath(where));
        const content = page.locator(".notifications-content");
        await expect(content.getByRole("heading", { level: 1 })).toHaveText(inboxTitle(where, lang), { timeout: 30_000 });
        for (const { title, detail } of expectedWords(list, lang)) {
          const card = content.locator("button.card", { hasText: title }).first();
          await expect(card).toBeVisible({ timeout: 30_000 });
          if (detail) await expect(card).toContainText(detail);
        }
        await expect(page.locator("html")).toHaveAttribute("dir", lang === "en" ? "ltr" : "rtl");
        const text = await content.innerText();
        if (lang === "en") expect(text).not.toMatch(ARABIC);
        for (const [type] of list) expect(text).not.toContain(type); // never a raw code
        // The time as the browser formats it for this language.
        const created = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: acc.id }, orderBy: { createdAt: "desc" } });
        const when = await page.evaluate(
          ([iso, locale]) => new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }),
          [created.createdAt.toISOString(), lang === "en" ? "en" : "ar"],
        );
        await expect(content).toContainText(when);
        await expectNoHorizontalOverflow(page);
        await context.close();
      }
    }
    await prisma.user.update({ where: { id: acc.id }, data: { languagePref: "ar" } });
  }

  test("store owner: the page in both languages, desktop and phone - stock, suspension, low stock and the order-exception types", async ({ browser }) => {
    await inbox(browser, owner, OWNER, "store");
    // and never in her shopping bell (TB-26)
    const page = await browser.newPage();
    await loginAs(page, owner.token);
    await page.goto("/notifications");
    // the list has loaded (its empty state), and none of her store's notices is in it
    await expect(page.locator(".notifications-content")).toContainText("لا توجد إشعارات بعد", { timeout: 30_000 });
    await expect(page.locator(".notifications-content button.card")).toHaveCount(0);
    await page.close();
  });

  test("customer: the page in both languages, desktop and phone - delivery, refunds, favourites, a hidden review's reason as written", async ({ browser }) => {
    await inbox(browser, customer, CUSTOMER, "shopping");
  });

  test("platform administrator: the integrity alert with its order and issue, in both languages", async ({ browser }) => {
    await inbox(browser, admin, ADMIN, "platform");
  });

  test("the drawer in both languages, desktop and phone: title, filters, items, details and the bell's own label", async ({ browser }) => {
    for (const lang of ["ar", "en"] as const) {
      // 2026-11-22: the shopping bell's drawer lists CUSTOMER notifications (TB-26)
      await prisma.user.update({ where: { id: customer.id }, data: { languagePref: lang } });
      for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 760 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
      await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
      const page = await context.newPage();
      await loginAs(page, customer.token);
      await page.goto("/");
      await page.getByRole("button", { name: lang === "en" ? "Notifications" : "التنبيهات", exact: true }).click({ timeout: 30_000 });
      const drawer = page.locator(".notifications-drawer");
      await expect(drawer.locator("#notifications-drawer-title")).toHaveText(lang === "en" ? "Notifications" : "الإشعارات");
      await expect(drawer.getByRole("button", { name: lang === "en" ? "All" : "الكل", exact: true })).toBeVisible();
      await expect(drawer.getByRole("button", { name: lang === "en" ? "Unread only" : "غير المقروءة فقط" })).toBeVisible();
      await expect(drawer.getByRole("button", { name: lang === "en" ? "Close notifications" : "إغلاق الإشعارات" })).toBeVisible();
      for (const { title, detail } of expectedWords(CUSTOMER, lang)) {
        const item = drawer.locator(".notifications-drawer-item", { hasText: title }).first();
        await expect(item).toBeVisible({ timeout: 30_000 });
        if (detail) await expect(item).toContainText(detail);
      }
      if (lang === "en") expect(await drawer.innerText()).not.toMatch(ARABIC);
      // The drawer follows the page direction (its CSS no longer fixes rtl).
      expect(await drawer.evaluate((el) => getComputedStyle(el).direction)).toBe(lang === "en" ? "ltr" : "rtl");
      // It slides in (a .38s transform): measure once it has fully arrived.
      await expect.poll(async () => (await drawer.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
      await expectNoHorizontalOverflow(page);
      await context.close();
      }
    }
    await prisma.user.update({ where: { id: customer.id }, data: { languagePref: "ar" } });
  });

  test("links are unchanged: stock to the branch stock, an order exception to /orders, the integrity alert to the audit log", async ({ page }) => {
    // 2026-11-22: from the store's own inbox (the store workspace entered)
    await loginAs(page, owner.token);
    await enterWorkspace(page, owner.token, { type: "vendor", vendor_id: vendorId });
    const storeInbox = `/vendor/${vendorId}/notifications`;
    const pathOf = () => {
      const u = new URL(page.url());
      return `${u.pathname}${u.search}`;
    };
    await page.goto(storeInbox);
    await page.locator("button.card", { hasText: NOTIFICATION_TITLES.STOCK_ADJUSTMENT.ar }).click({ timeout: 30_000 });
    // (the stock line the notice is about is marked: ?variant=, since 2026-11-18)
    await expect.poll(pathOf, { timeout: 15_000 }).toBe(`/vendor/${vendorId}/branches/${branchId}/stock?variant=${TARGET}`);
    await page.goto(storeInbox);
    await page.locator("button.card", { hasText: NOTIFICATION_TITLES.PREP_REMINDER.ar }).click({ timeout: 30_000 });
    // a store notification about an order opens the branch's orders - never the customer's own orders
    await expect.poll(pathOf, { timeout: 15_000 }).toBe(`/vendor/${vendorId}/branches/${branchId}/orders?order=${TARGET}`);
    // «لم يصل الطلب» (2026-11-22): the branch's order screen on that order, where its action is
    await page.goto(storeInbox);
    await page.locator("button.card", { hasText: NOTIFICATION_TITLES.NOT_RECEIVED_REPORTED.ar }).click({ timeout: 30_000 });
    await expect.poll(pathOf, { timeout: 15_000 }).toBe(`/vendor/${vendorId}/branches/${branchId}/orders?order=${TARGET}`);
    await loginAs(page, admin.token);
    await enterWorkspace(page, admin.token, { type: "platform" });
    await page.goto("/admin/notifications");
    await page.locator("button.card", { hasText: NOTIFICATION_TITLES.ORDER_INTEGRITY_ALERT.ar }).click({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/admin\/audit-logs$/);
  });

  test("errors: the page and the drawer show the unified words - never the server's text - and follow a language switch", async ({ page }) => {
    const TECH = 'relation "notifications" does not exist';
    const fail = (status: number, code: string) => ({
      status,
      contentType: "application/json",
      body: JSON.stringify({ error: { code, message: TECH, details: [], correlation_id: "tb16-route" } }),
    });
    const switchTo = (lang: Lang) =>
      page.evaluate((l) => {
        localStorage.setItem("finalpro_lang_pref", l);
        window.dispatchEvent(new Event("finalpro:lang"));
      }, lang);
    await loginAs(page, owner.token);
    await page.route("**/api/v1/me/notifications?*", (route) => route.fulfill(fail(500, "INTERNAL_SERVER_ERROR")));
    await page.goto("/notifications");
    const banner = page.locator('.notifications-content .error-banner[role="alert"]');
    await expect(banner).toHaveText("حدث خطأ غير متوقع، حاولي لاحقاً.", { timeout: 30_000 });
    await switchTo("en");
    await expect(banner).toHaveText("Something went wrong - please try again later.");
    expect(await page.content()).not.toContain(TECH);

    await page.unroute("**/api/v1/me/notifications?*");
    await page.route("**/api/v1/me/notifications?*", (route) => route.fulfill(fail(429, "TOO_MANY_REQUESTS")));
    await switchTo("ar");
    await page.goto("/");
    await page.getByRole("button", { name: "التنبيهات", exact: true }).click({ timeout: 30_000 });
    const drawerBanner = page.locator('.notifications-drawer .error-banner[role="alert"]');
    await expect(drawerBanner).toHaveText("محاولات كثيرة، انتظري قليلاً ثم حاولي مجدداً.", { timeout: 30_000 });
    await switchTo("en");
    await expect(drawerBanner).toHaveText("Too many attempts - wait a moment and try again.");
    expect(await page.content()).not.toContain(TECH);
  });
});
