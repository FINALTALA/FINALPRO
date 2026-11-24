import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// TB-15: the store's three return notifications in the shared inbox (the
// «الإشعارات» page and the drawer) - the platform's final decision
// (approved / rejected) and a customer's cancellation: their words in
// Arabic and English, the approval's outcome (RETURN or EXCHANGE) as the
// only detail, the link to the branch's returns page, who can open it,
// and no customer data on the notification side. Which events produce
// which rows, for whom, is proven by the API suite
// (apps/api/test/tb15-return-store-notifications.e2e-spec.ts); here the
// rows are written straight into the disposable test database.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

type StoreType = "RETURN_PLATFORM_APPROVED" | "RETURN_PLATFORM_REJECTED" | "RETURN_CANCELLED_BY_CUSTOMER";
const TYPES: StoreType[] = ["RETURN_PLATFORM_APPROVED", "RETURN_PLATFORM_REJECTED", "RETURN_CANCELLED_BY_CUSTOMER"];

const TITLES: Record<"ar" | "en", Record<StoreType, string>> = {
  ar: {
    RETURN_PLATFORM_APPROVED: "وافقت إدارة المنصة على طلب إرجاع في فرعك",
    RETURN_PLATFORM_REJECTED: "رفضت إدارة المنصة طلب إرجاع في فرعك نهائياً",
    RETURN_CANCELLED_BY_CUSTOMER: "ألغى العميل طلب إرجاع في فرعك",
  },
  en: {
    RETURN_PLATFORM_APPROVED: "The platform approved a return at your branch",
    RETURN_PLATFORM_REJECTED: "The platform made a final rejection of a return at your branch",
    RETURN_CANCELLED_BY_CUSTOMER: "A customer cancelled a return request at your branch",
  },
};
const OUTCOME: Record<"ar" | "en", Record<"RETURN" | "EXCHANGE", string>> = {
  ar: {
    RETURN: "إرجاع - بانتظار تسليم العميل للمنتج",
    EXCHANGE: "استبدال - حُجز البديل، بانتظار تسليم العميل للمنتج",
  },
  en: {
    RETURN: "Return - awaiting the customer's drop-off",
    EXCHANGE: "Exchange - replacement reserved, awaiting the customer's drop-off",
  },
};

// Customer data that exists in the database around these returns and
// must never reach a store notification.
const CUSTOMER_NAME = "TB15 Customer Fullname";
const SECRET_NOTE = "TB15 secret customer note";
const SECRET_REJECTION = "TB15 secret rejection explanation";
const ADDRESS_LINE = "TB15 Secret Street 42";
const AMOUNT = "123.45";

/** An account with a password (the OTP throttle belongs to global-setup). */
async function account(opts: { languagePref?: "ar" | "en"; displayName?: string } = {}) {
  const phone = uniquePhone();
  const user = await prisma.user.create({
    data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: opts.languagePref ?? "ar" },
  });
  const profile = await prisma.customerProfile.create({
    data: { userId: user.id, displayName: opts.displayName ?? null },
  });
  return { id: user.id, customerId: profile.id, phone };
}

/** One real sign-in (POST /auth/login) - called once per account, in beforeAll. */
async function signIn(acc: { phone: string }): Promise<string> {
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone: acc.phone, password: PASSWORD } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return res.body.session_token;
}

/** A store with branches A and B: an owner, an employee of A, a suspended
 * employee of A and an employee of B - and one return per status at
 * branch A, from a customer with a name, an address and a private note. */
async function storeWithReturns() {
  const vendor = await prisma.vendor.create({
    data: {
      slug: unique("tb15-ui").toLowerCase(),
      legalName: unique("L"),
      displayName: "متجر TB-15",
      status: "ACTIVE",
      subscriptionStatus: "ACTIVE",
      storefrontPublished: true,
    },
  });
  const branch = (name: string) =>
    prisma.storeBranch.create({
      data: { vendorId: vendor.id, name: unique(name), isPhysical: true, verificationStatus: "APPROVED" },
    });
  const a = await branch("A");
  const b = await branch("B");
  const member = async (role: "OWNER" | "BRANCH_EMPLOYEE", branchId: string | null, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") => {
    const acc = await account();
    await prisma.vendorUser.create({ data: { userId: acc.id, vendorId: vendor.id, role, branchId, status } });
    return acc;
  };
  const owner = await member("OWNER", null);
  const employee = await member("BRANCH_EMPLOYEE", a.id);
  const suspended = await member("BRANCH_EMPLOYEE", a.id, "SUSPENDED");

  const customer = await account({ displayName: CUSTOMER_NAME });
  await prisma.address.create({
    data: { customerId: customer.customerId, lat: 31.9, lng: 35.2, phoneNumber1: customer.phone, landmarkNote: ADDRESS_LINE, isDefault: true },
  });
  const offer = await prisma.vendorOffer.create({
    data: { vendorId: vendor.id, titleAr: unique("قطعة"), titleEn: "Item", status: "ACTIVE" },
  });
  const returns: Record<StoreType, string> = {} as Record<StoreType, string>;
  const statuses: Record<StoreType, "APPROVED_AWAITING_DROPOFF" | "ADMIN_REJECTED" | "CANCELLED_BY_CUSTOMER"> = {
    RETURN_PLATFORM_APPROVED: "APPROVED_AWAITING_DROPOFF",
    RETURN_PLATFORM_REJECTED: "ADMIN_REJECTED",
    RETURN_CANCELLED_BY_CUSTOMER: "CANCELLED_BY_CUSTOMER",
  };
  for (const type of TYPES) {
    const variant = await prisma.offerVariant.create({
      data: {
        vendorId: vendor.id,
        vendorOfferId: offer.id,
        sellerSku: unique("sku"),
        storeInventoryBarcode: unique("sib"),
        basePrice: AMOUNT,
      },
    });
    const customerOrder = await prisma.customerOrder.create({ data: { customerId: customer.customerId } });
    const order = await prisma.branchOrder.create({
      data: {
        customerOrderId: customerOrder.id,
        vendorId: vendor.id,
        branchId: a.id,
        fulfilmentMethod: "PICKUP",
        paymentMethod: "COD",
        status: "COMPLETED",
        subtotal: AMOUNT,
        total: AMOUNT,
        pickupCode: String(Math.floor(100000 + Math.random() * 899999)),
        pickedUpAt: new Date(Date.now() - 86_400_000),
        codCollectedAt: new Date(Date.now() - 86_400_000),
      },
    });
    const item = await prisma.branchOrderItem.create({
      data: { vendorId: vendor.id, branchOrderId: order.id, offerVariantId: variant.id, quantity: 1, unitPrice: AMOUNT },
    });
    const r = await prisma.return.create({
      data: {
        vendorId: vendor.id,
        branchOrderItemId: item.id,
        reason: "DAMAGED",
        reasonNote: SECRET_NOTE,
        status: statuses[type],
        vendorReviewDueAt: new Date(Date.now() + 48 * 3_600_000),
        rejectionReason: type === "RETURN_PLATFORM_REJECTED" ? SECRET_REJECTION : null,
      },
    });
    returns[type] = r.id;
  }
  return { vendorId: vendor.id, branchId: a.id, otherBranchId: b.id, owner, employee, suspended, customer, returns };
}
type Store = Awaited<ReturnType<typeof storeWithReturns>>;

/** One delivered store notification, exactly as the relay writes it. */
async function deliver(s: Store, userId: string, type: StoreType, outcome?: "RETURN" | "EXCHANGE") {
  const event = await prisma.outboxEvent.create({
    data: { eventType: `tb15.ui.${type}`, payload: {}, status: "PUBLISHED", publishedAt: new Date() },
  });
  return prisma.notification.create({
    data: {
      outboxEventId: event.id,
      recipientUserId: userId,
      type,
      targetType: "RETURN",
      targetId: s.returns[type],
      data: type === "RETURN_PLATFORM_APPROVED" ? { outcome: outcome ?? "RETURN" } : {},
      vendorId: s.vendorId,
      branchId: s.branchId,
      audience: "STORE",
    },
  });
}
async function deliverAll(s: Store, userId: string) {
  for (const type of TYPES) await deliver(s, userId, type);
}

const itemTitled = (page: Page, title: string) => page.locator("button.card", { hasText: title });

function expectNoCustomerData(text: string, s: Store) {
  for (const secret of [CUSTOMER_NAME, SECRET_NOTE, SECRET_REJECTION, ADDRESS_LINE, AMOUNT, s.customer.phone, "₪"]) {
    expect(text).not.toContain(secret);
  }
}

test.describe("TB-15: the store's return notifications in the inbox", () => {
  test.describe.configure({ mode: "serial" });

  // One store, its returns and every account for the whole file, each
  // account signed in exactly once - the login endpoint allows 10 a minute
  // per address, shared with the file before this one in a full run. The
  // other-branch employee and the non-member are global-setup's shared
  // customers B and A (already signed in): customer B is made a member of
  // branch B here only, and that membership is always removed in afterAll;
  // customer A gets no membership. Neither inbox is emptied - only the one
  // notification this file delivers to each is removed afterwards.
  let s: Store;
  const shared = loadSharedFixtures();
  let otherBranchEmployee = { id: "" };
  let outsider = { id: "" };
  const tokens: Record<string, string> = {};
  const sharedNotificationIds: string[] = [];
  const idOf = async (token: string) => {
    const res = await call<{ id: string }>("/customers/me", { token });
    if (!res.body.id) throw new Error(`GET /customers/me failed (status ${res.status})`);
    return res.body.id;
  };
  test.beforeAll(async () => {
    otherBranchEmployee = { id: await idOf(shared.customerBToken) };
    outsider = { id: await idOf(shared.customerAToken) };
    // Explicit: customer B has no membership at all before this file.
    expect(await prisma.vendorUser.count({ where: { userId: otherBranchEmployee.id } })).toBe(0);
    s = await storeWithReturns();
    expect(await prisma.vendorUser.count({ where: { userId: outsider.id, vendorId: s.vendorId } })).toBe(0);
    await prisma.vendorUser.create({
      data: { userId: otherBranchEmployee.id, vendorId: s.vendorId, role: "BRANCH_EMPLOYEE", branchId: s.otherBranchId },
    });
    tokens[otherBranchEmployee.id] = shared.customerBToken;
    tokens[outsider.id] = shared.customerAToken;
    for (const acc of [s.owner, s.employee, s.suspended]) {
      tokens[acc.id] = await signIn(acc);
    }
  });
  test.afterAll(async () => {
    // Always - also after a failure: customer B leaves this store, and the
    // notifications delivered to the shared accounts are removed.
    if (otherBranchEmployee.id && s) {
      await prisma.vendorUser.deleteMany({ where: { userId: otherBranchEmployee.id, vendorId: s.vendorId } });
    }
    await prisma.notification.deleteMany({ where: { id: { in: sharedNotificationIds } } });
    if (otherBranchEmployee.id) {
      // Explicit: no membership left behind for customer B.
      expect(await prisma.vendorUser.count({ where: { userId: otherBranchEmployee.id } })).toBe(0);
    }
  });
  // TB-26 (2026-11-18 regression fix): these are STORE notifications - read
  // in the store workspace's inbox; the shopping bell never shows them.
  const storeInbox = () => `/vendor/${s.vendorId}/notifications`;
  const freshInbox = (...ids: string[]) => prisma.notification.deleteMany({ where: { recipientUserId: { in: ids } } });
  const setOwnerLanguage = (languagePref: "ar" | "en") =>
    prisma.user.update({ where: { id: s.owner.id }, data: { languagePref } });

  test("owner: the three notifications in Arabic - the approval shows its outcome only - each leads to the branch's returns page, which opens", async ({ page }) => {
    await setOwnerLanguage("ar");
    await freshInbox(s.owner.id);
    await deliverAll(s, s.owner.id);
    await loginAs(page, tokens[s.owner.id]);
    // TB-26: the links below open the store workspace (entered here).
    await page.goto("/notifications");
    await expect(page.getByTestId("notifications-title")).toBeVisible({ timeout: 30_000 });
    for (const type of TYPES) await expect(itemTitled(page, TITLES.ar[type])).toHaveCount(0);
    await enterWorkspace(page, tokens[s.owner.id], { type: "vendor", vendor_id: s.vendorId });
    await page.goto(storeInbox());
    for (const type of TYPES) {
      await expect(itemTitled(page, TITLES.ar[type])).toBeVisible({ timeout: 30_000 });
    }
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(itemTitled(page, TITLES.ar.RETURN_PLATFORM_APPROVED)).toContainText(OUTCOME.ar.RETURN);
    // No detail line at all on the rejection and the cancellation.
    for (const type of ["RETURN_PLATFORM_REJECTED", "RETURN_CANCELLED_BY_CUSTOMER"] as const) {
      const text = await itemTitled(page, TITLES.ar[type]).innerText();
      expect(text).not.toContain(OUTCOME.ar.RETURN);
      expect(text).not.toContain(OUTCOME.ar.EXCHANGE);
    }
    const cards = await page.locator("button.card").allInnerTexts();
    expectNoCustomerData(cards.join("\n"), s);

    for (const type of TYPES) {
      await page.goto(storeInbox());
      await itemTitled(page, TITLES.ar[type]).click();
      await expect(page).toHaveURL(new RegExp(`/vendor/${s.vendorId}/branches/${s.branchId}/returns\\?return=[0-9a-f-]{36}$`));
      // IX-P2: the returns board, that return open
      await expect(page.getByTestId("returns-board")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("rb-detail-reason")).toHaveText("تالف", { timeout: 30_000 });
      await expect(page.locator(".error-banner")).toHaveCount(0);
    }
  });

  test("an approved EXCHANGE says so; an unknown outcome code shows no detail", async ({ page }) => {
    await setOwnerLanguage("ar");
    await freshInbox(s.owner.id, s.employee.id);
    await deliver(s, s.owner.id, "RETURN_PLATFORM_APPROVED", "EXCHANGE");
    const event = await prisma.outboxEvent.create({
      data: { eventType: "tb15.ui.bad", payload: {}, status: "PUBLISHED", publishedAt: new Date() },
    });
    await prisma.notification.create({
      data: {
        outboxEventId: event.id,
        recipientUserId: s.employee.id,
        type: "RETURN_PLATFORM_APPROVED",
        targetType: "RETURN",
        targetId: s.returns.RETURN_PLATFORM_APPROVED,
        data: { outcome: "SOMETHING_ELSE" },
        vendorId: s.vendorId,
        branchId: s.branchId,
        audience: "STORE",
      },
    });
    await loginAs(page, tokens[s.owner.id]);
    await enterWorkspace(page, tokens[s.owner.id], { type: "vendor", vendor_id: s.vendorId });
    await page.goto(storeInbox());
    await expect(itemTitled(page, TITLES.ar.RETURN_PLATFORM_APPROVED)).toContainText(OUTCOME.ar.EXCHANGE, { timeout: 30_000 });

    await loginAs(page, tokens[s.employee.id]);
    await enterWorkspace(page, tokens[s.employee.id], { type: "vendor", vendor_id: s.vendorId });
    await page.goto(storeInbox());
    const card = itemTitled(page, TITLES.ar.RETURN_PLATFORM_APPROVED);
    await expect(card).toBeVisible({ timeout: 30_000 });
    expect(await card.innerText()).not.toMatch(/SOMETHING_ELSE|بانتظار تسليم/);
  });

  test("branch employee: the notifications are in the store inbox - the shopping drawer never shows them - and the link opens their branch's returns page", async ({ page }) => {
    await freshInbox(s.employee.id);
    await deliverAll(s, s.employee.id);
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, tokens[s.employee.id]);
    await page.goto("/");
    await page.getByRole("button", { name: "التنبيهات" }).click();
    await expect(page.locator(".notifications-drawer")).toBeVisible({ timeout: 30_000 });
    for (const type of TYPES) {
      await expect(page.locator(".notifications-drawer-item", { hasText: TITLES.ar[type] })).toHaveCount(0);
    }
    await enterWorkspace(page, tokens[s.employee.id], { type: "vendor", vendor_id: s.vendorId });
    await page.goto(storeInbox());
    for (const type of TYPES) {
      await expect(itemTitled(page, TITLES.ar[type])).toBeVisible({ timeout: 30_000 });
    }
    await expect(itemTitled(page, TITLES.ar.RETURN_PLATFORM_APPROVED)).toContainText(OUTCOME.ar.RETURN);
    expectNoCustomerData((await page.locator("button.card").allInnerTexts()).join("\n"), s);
    await itemTitled(page, TITLES.ar.RETURN_CANCELLED_BY_CUSTOMER).click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${s.vendorId}/branches/${s.branchId}/returns\\?return=[0-9a-f-]{36}$`));
    await expect(page.getByTestId("rb-detail-reason")).toHaveText("تالف", { timeout: 30_000 });
    await expect(page.locator(".error-banner")).toHaveCount(0);
  });

  test("nobody outside the branch reaches it: another branch's employee, a suspended employee and a non-member never see it in the shopping bell, and the other-branch employee not in the store inbox either", async ({ page }) => {
    for (const who of [s.suspended, outsider, otherBranchEmployee]) {
      const isShared = who.id === otherBranchEmployee.id || who.id === outsider.id;
      if (!isShared) await freshInbox(who.id);
      const delivered = await deliver(s, who.id, "RETURN_CANCELLED_BY_CUSTOMER");
      if (isShared) sharedNotificationIds.push(delivered.id);
      await loginAs(page, tokens[who.id]);
      await page.goto("/notifications");
      await expect(page.getByTestId("notifications-title")).toBeVisible({ timeout: 30_000 });
      await expect(itemTitled(page, TITLES.ar.RETURN_CANCELLED_BY_CUSTOMER)).toHaveCount(0);
      if (who.id === otherBranchEmployee.id) {
        // a member of another branch: their workspace inbox is their branch only
        await enterWorkspace(page, tokens[who.id], { type: "vendor", vendor_id: s.vendorId });
        await page.goto(storeInbox());
        await expect(page.getByTestId("notifications-title")).toBeVisible({ timeout: 30_000 });
        await expect(itemTitled(page, TITLES.ar.RETURN_CANCELLED_BY_CUSTOMER)).toHaveCount(0);
      }
      await expect(page.locator(".card", { hasText: "تالف" })).toHaveCount(0);
      expect(await page.content()).not.toContain(SECRET_NOTE);
    }
  });

  async function inboxIn(browser: Browser, lang: "ar" | "en") {
    // The signed-in user's saved language wins over the browser's: switched
    // directly in the test database, no new sign-in.
    await setOwnerLanguage(lang);
    await freshInbox(s.owner.id);
    await deliverAll(s, s.owner.id);
    for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 760 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
      await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
      const page = await context.newPage();
      await loginAs(page, tokens[s.owner.id]);
      await enterWorkspace(page, tokens[s.owner.id], { type: "vendor", vendor_id: s.vendorId });
      await page.goto(storeInbox());
      for (const type of TYPES) {
        await expect(itemTitled(page, TITLES[lang][type])).toBeVisible({ timeout: 30_000 });
      }
      await expect(itemTitled(page, TITLES[lang].RETURN_PLATFORM_APPROVED)).toContainText(OUTCOME[lang].RETURN);
      await expect(page.locator("html")).toHaveAttribute("dir", lang === "en" ? "ltr" : "rtl");
      await expectNoHorizontalOverflow(page);
      expectNoCustomerData((await page.locator("button.card").allInnerTexts()).join("\n"), s);
      await context.close();
    }
  }
  for (const lang of ["ar", "en"] as const) {
    test(`${lang}, desktop and phone: the three store notifications' words and direction, no sideways scroll`, async ({ browser }) => {
      await inboxIn(browser, lang);
    });
  }
});
