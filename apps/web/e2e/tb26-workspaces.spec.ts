import { expect, test, type Page } from "@playwright/test";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { loginAs } from "./helpers/session";

// TB-26 (web): signing in is SHOPPING only. The public store page shows no
// owner/employee tools; a member sees «إدارة هذا المتجر», which leads to an
// entry confirmation - nothing is entered on its own (sign-in, a direct
// link, the back button). The workspace token lives in the tab's
// sessionStorage only (never the URL or localStorage), so two tabs are
// independent; leaving ends it. «إشعاراتي» lists the page's own context.
// The API's own rules (tokens, SHOPPING_REQUIRED, scoping) are proven by
// apps/api/test/tb26-*.e2e-spec.ts; this file proves the pages.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
const WS_KEY = "finalpro_workspace_tokens";

async function account(platformRole?: "PLATFORM_ADMIN") {
  const phone = uniquePhone();
  const user = await prisma.user.create({
    data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar", platformRole: platformRole ?? null },
  });
  await prisma.customerProfile.create({ data: { userId: user.id } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, phone, token: res.body.session_token };
}
type Account = Awaited<ReturnType<typeof account>>;

async function store(label: string, owner?: Account) {
  const o = owner ?? (await account());
  const vendor = await prisma.vendor.create({
    data: {
      slug: unique(`tb26-${label}`).toLowerCase(),
      legalName: `TB26 ${label} ${unique("L")}`,
      displayName: `متجر ${label}`,
      status: "ACTIVE",
      subscriptionStatus: "ACTIVE",
      storefrontPublished: true,
    },
  });
  const branch = await prisma.storeBranch.create({
    data: { vendorId: vendor.id, name: unique("فرع"), isPhysical: true, verificationStatus: "APPROVED" },
  });
  await prisma.vendorUser.create({ data: { userId: o.id, vendorId: vendor.id, role: "OWNER" } });
  return { vendorId: vendor.id, slug: vendor.slug, legalName: vendor.legalName, branchId: branch.id, owner: o };
}

const ownerTools = (page: Page) => page.locator(".store-manage-button, .store-inline-edit-button, .store-employee-workspace-button");

async function storedWorkspaces(page: Page) {
  return page.evaluate((key) => ({ session: sessionStorage.getItem(key), local: JSON.stringify(localStorage) }), WS_KEY);
}

async function setFlag(enabled: boolean) {
  await prisma.featureFlag.upsert({
    where: { key: "workspace_scoping_enabled" },
    create: { key: "workspace_scoping_enabled", enabled, description: "tb26 playwright" },
    update: { enabled },
  });
}

test.describe("TB-26: shopping vs store/platform workspaces", () => {
  test.describe.configure({ mode: "serial" });

  test("the public store page shows no tools after sign-in; «إدارة هذا المتجر» asks in a small panel over the same page (no new page): «إلغاء» enters nothing, «دخول مساحة العمل» enters (checked and recorded by the API); the tools appear, leaving removes them, and the back button never re-enters", async ({ page }) => {
    const s = await store("owner");
    await loginAs(page, s.owner.token);
    await page.goto(`/store/${s.slug}`);
    const manage = page.getByTestId("store-manage-link");
    await expect(manage).toBeVisible();
    await expect(ownerTools(page)).toHaveCount(0);
    expect((await storedWorkspaces(page)).session ?? "").not.toContain(s.vendorId);
    const entryVisits: string[] = [];
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame() && f.url().includes("/workspaces/enter")) entryVisits.push(f.url());
    });
    const entered = () => prisma.auditLog.count({ where: { action: "workspace.entered", entityId: s.vendorId } });
    const before = await entered();

    // The panel: over this page, the page blurred behind it, about a quarter of a desktop screen.
    await manage.click();
    const panel = page.getByTestId("ws-confirm");
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/store/${s.slug}$`));
    await expect(page.getByTestId("ws-confirm-name")).toHaveText(s.legalName);
    await expect(page.getByTestId("ws-confirm-cancel")).toHaveText("إلغاء");
    await expect(page.getByTestId("ws-confirm-enter")).toHaveText("دخول مساحة العمل");
    const width = (await panel.boundingBox())!.width / (page.viewportSize()!.width);
    expect(width).toBeGreaterThanOrEqual(0.2);
    expect(width).toBeLessThanOrEqual(0.3);
    expect(await page.getByTestId("ws-confirm-backdrop").evaluate((el) => getComputedStyle(el).backdropFilter)).toContain("blur");
    // «إلغاء»: nothing entered, no tools.
    await page.getByTestId("ws-confirm-cancel").click();
    await expect(panel).toHaveCount(0);
    await expect(manage).toBeFocused();
    await expect(ownerTools(page)).toHaveCount(0);
    expect((await storedWorkspaces(page)).session ?? "").not.toContain(s.vendorId);
    expect(await entered()).toBe(before);
    // Esc closes it the same way.
    await manage.click();
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    expect(await entered()).toBe(before);
    // «دخول مساحة العمل»: in, on the same store page - never the confirmation page.
    await manage.click();
    await page.getByTestId("ws-confirm-enter").click();
    await expect(page.locator(".store-manage-button")).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/store/${s.slug}$`));
    expect(entryVisits).toEqual([]);
    await expect.poll(entered).toBe(before + 1);
    await expect(page.getByTestId("store-manage-link")).toHaveCount(0);
    const stored = await storedWorkspaces(page);
    expect(stored.session).toContain(s.vendorId);
    // The token is in this tab's sessionStorage only - not in the URL, not in localStorage.
    const token = (JSON.parse(stored.session!) as { vendors: Record<string, string> }).vendors[s.vendorId];
    expect(page.url()).not.toContain(token);
    expect(stored.local).not.toContain(token);

    // Into a management page and back out: leaving ends the workspace.
    // (2026-11-23: /orders only redirects into «إدارة الفروع» now - a page of its own here)
    await page.goto(`/vendor/${s.vendorId}/settings`);
    await expect(page.getByTestId("workspace-bar")).toBeVisible();
    // «خروج من مساحة العمل» lives in the workspace's header menu
    await page.getByTestId("workspace-menu-button").click();
    await page.getByTestId("workspace-leave").click();
    await expect(page).toHaveURL(/\/$/);
    expect((await storedWorkspaces(page)).session ?? "").not.toContain(s.vendorId);
    await page.goBack();
    await expect(page).toHaveURL(/\/workspaces\/enter\?/);
    await page.goto(`/store/${s.slug}`);
    await expect(ownerTools(page)).toHaveCount(0);
    await expect(page.getByTestId("store-manage-link")).toBeVisible();
  });

  test("a workspace card in «حسابي» enters at once (no confirmation) and opens the owner's tools; in another tab a direct link still goes to the confirmation page, and «إدارة هذا المتجر» asks in its panel", async ({ context }) => {
    const s = await store("card");
    const page = await context.newPage();
    await loginAs(page, s.owner.token);
    const entryVisits: string[] = [];
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame() && f.url().includes("/workspaces/enter")) entryVisits.push(f.url());
    });
    await page.goto("/account");
    await page.locator(".workspace-icon-action", { hasText: s.legalName }).click();
    // Straight in: the owner's storefront with its tools, never the confirmation.
    await expect(page).toHaveURL(new RegExp(`/store/${s.slug}$`));
    await expect(page.locator(".store-manage-button")).toBeVisible();
    expect(entryVisits).toEqual([]);
    expect((await storedWorkspaces(page)).session).toContain(s.vendorId);

    // Another tab of the same browser is still shopping: a direct link asks first...
    const other = await context.newPage();
    await loginAs(other, s.owner.token);
    await other.goto(`/vendor/${s.vendorId}/orders`);
    await expect(other).toHaveURL(/\/workspaces\/enter\?/);
    await expect(other.getByTestId("ws-enter-confirm")).toBeVisible();
    // ...and «إدارة هذا المتجر» on the public store page asks in its panel, on that page.
    await other.goto(`/store/${s.slug}`);
    await expect(ownerTools(other)).toHaveCount(0);
    await other.getByTestId("store-manage-link").click();
    await expect(other.getByTestId("ws-confirm")).toBeVisible();
    await expect(other).toHaveURL(new RegExp(`/store/${s.slug}$`));
    await expect(ownerTools(other)).toHaveCount(0);
    await other.getByTestId("ws-confirm-enter").click();
    await expect(other.locator(".store-manage-button")).toBeVisible();
    expect((await storedWorkspaces(other)).session).toContain(s.vendorId);
  });

  test("a direct link to a management page goes to the confirmation first and continues to it; an unsafe or foreign next falls back to the workspace home", async ({ page }) => {
    const s = await store("direct");
    const other = await store("foreign");
    await loginAs(page, s.owner.token);
    await page.goto(`/vendor/${s.vendorId}/orders`);
    await expect(page).toHaveURL(/\/workspaces\/enter\?/);
    expect(new URL(page.url()).searchParams.get("next")).toBe(`/vendor/${s.vendorId}/orders`);
    await page.getByTestId("ws-enter-confirm").click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${s.vendorId}/orders$`));

    const visited: string[] = [];
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) visited.push(f.url());
    });
    for (const next of ["//evil.example/x", "https://evil.example/", `/vendor/${other.vendorId}`, "/cart", "/\\evil.example"]) {
      const qs = new URLSearchParams({ type: "vendor", vendor_id: s.vendorId, next });
      visited.length = 0;
      // Already entered in this tab: the page continues straight away - to the safe place only:
      // the workspace home, /vendor/<id> (which itself sends its owner on to the own storefront).
      await page.goto(`/workspaces/enter?${qs.toString()}`);
      await expect
        .poll(() => visited.some((u) => new URL(u).pathname === `/vendor/${s.vendorId}`), { message: next })
        .toBe(true);
      await expect(page).toHaveURL(new RegExp(`/(vendor/${s.vendorId}|store/${s.slug})$`));
      for (const u of visited) {
        const url = new URL(u);
        expect(url.origin, next).toBe(new URL(page.url()).origin);
        expect(url.pathname, next).not.toBe(`/vendor/${other.vendorId}`);
        expect(url.pathname, next).not.toBe("/cart");
      }
    }
  });

  test("two tabs are independent: entering a store in one tab leaves the other tab shopping; each tab sees only its own store", async ({ context }) => {
    const owner = await account();
    const s1 = await store("tab1", owner);
    const s2 = await store("tab2", owner);
    // The orders page (the store hub itself sends an owner on to the storefront).
    const tab1 = await context.newPage();
    await loginAs(tab1, owner.token);
    await tab1.goto(`/vendor/${s1.vendorId}/orders`);
    await tab1.getByTestId("ws-enter-confirm").click();
    await expect(tab1).toHaveURL(new RegExp(`/vendor/${s1.vendorId}/orders$`));

    const tab2 = await context.newPage();
    await loginAs(tab2, owner.token);
    await tab2.goto(`/vendor/${s1.vendorId}/orders`);
    await expect(tab2).toHaveURL(/\/workspaces\/enter\?/);
    await tab2.goto(`/vendor/${s2.vendorId}/orders`);
    await tab2.getByTestId("ws-enter-confirm").click();
    await expect(tab2).toHaveURL(new RegExp(`/vendor/${s2.vendorId}/orders$`));

    // Tab 1 still in store 1 only.
    await tab1.goto(`/vendor/${s2.vendorId}/orders`);
    await expect(tab1).toHaveURL(/\/workspaces\/enter\?/);
    await tab1.goto(`/vendor/${s1.vendorId}/orders`);
    await expect(tab1.getByTestId("workspace-bar")).toBeVisible();
  });

  test("an employee sees «إدارة هذا المتجر» on their store, and only after confirming in the panel the branch workspace button - never the owner tools; a non-member is refused at the confirmation", async ({ page }) => {
    const s = await store("employee");
    const employee = await account();
    await prisma.vendorUser.create({ data: { userId: employee.id, vendorId: s.vendorId, role: "BRANCH_EMPLOYEE", branchId: s.branchId } });
    await loginAs(page, employee.token);
    await page.goto(`/store/${s.slug}`);
    await expect(page.locator(".store-employee-workspace-button")).toHaveCount(0);
    await page.getByTestId("store-manage-link").click();
    await expect(page.getByTestId("ws-confirm")).toContainText("موظف فرع");
    await page.getByTestId("ws-confirm-enter").click();
    await expect(page).toHaveURL(new RegExp(`/store/${s.slug}$`));
    await expect(page.locator(".store-employee-workspace-button")).toBeVisible();
    await expect(page.locator(".store-manage-button, .store-inline-edit-button")).toHaveCount(0);

    const stranger = await account();
    const page2 = await page.context().browser()!.newPage();
    await loginAs(page2, stranger.token);
    await page2.goto(`/store/${s.slug}`);
    await expect(page2.getByTestId("store-manage-link")).toHaveCount(0);
    await page2.goto(`/workspaces/enter?type=vendor&vendor_id=${s.vendorId}`);
    await expect(page2.getByTestId("ws-enter-no-access")).toBeVisible();
    await expect(page2.getByTestId("ws-enter-confirm")).toHaveCount(0);
    await page2.close();
  });

  test("the platform workspace: /admin needs the confirmation; then the workspace bar and «إشعاراتي» of the platform", async ({ page }) => {
    const admin = await account("PLATFORM_ADMIN");
    await loginAs(page, admin.token);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/workspaces\/enter\?type=platform/);
    await page.getByTestId("ws-enter-confirm").click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("workspace-bar")).toBeVisible();
    await expect(page.getByTestId("workspace-bar-notifications")).toHaveAttribute("href", "/admin/notifications");
    await expectNoHorizontalOverflow(page);
  });

  test("«إشعاراتي» per context (flag on): the shopping bell lists customer notifications only, the store workspace that store's only, the platform workspace platform alerts only; a store ORDER_CANCELLED opens the branch orders", async ({ page }) => {
    await setFlag(true);
    try {
      const owner = await account("PLATFORM_ADMIN");
      const s = await store("notif", owner);
      const deliver = async (type: string, audience: "CUSTOMER" | "STORE" | "PLATFORM", vendorId: string | null, branchId: string | null) => {
        const event = await prisma.outboxEvent.create({ data: { eventType: `tb26.ui.${type}`, payload: {}, status: "PUBLISHED", publishedAt: new Date() } });
        return prisma.notification.create({
          data: { outboxEventId: event.id, recipientUserId: owner.id, type: type as never, targetType: "BRANCH_ORDER", targetId: unique("bo"), data: {}, vendorId, branchId, audience },
        });
      };
      await deliver("REVIEW_INVITATION", "CUSTOMER", s.vendorId, s.branchId);
      await deliver("ORDER_CANCELLED", "STORE", s.vendorId, s.branchId);
      await deliver("ORDER_INTEGRITY_ALERT", "PLATFORM", null, null);
      const titles = (p: Page) => p.locator("button.card strong").allTextContents();

      await loginAs(page, owner.token);
      await page.goto("/notifications");
      await expect(page.locator("button.card")).toHaveCount(1);
      expect((await titles(page)).join(" ")).not.toMatch(/سلامة|إلغاء/);

      await page.goto(`/vendor/${s.vendorId}/notifications`);
      await page.getByTestId("ws-enter-confirm").click();
      await expect(page).toHaveURL(new RegExp(`/vendor/${s.vendorId}/notifications$`));
      await expect(page.getByTestId("notifications-title")).toHaveText("إشعارات المتجر");
      await expect(page.locator("button.card")).toHaveCount(1);
      await page.locator("button.card").first().click();
      await expect(page).toHaveURL(new RegExp(`/vendor/${s.vendorId}/branches/${s.branchId}/orders`));

      await page.goto("/admin/notifications");
      await page.getByTestId("ws-enter-confirm").click();
      await expect(page).toHaveURL(/\/admin\/notifications$/);
      await expect(page.getByTestId("notifications-title")).toHaveText("إشعارات المنصة");
      await expect(page.locator("button.card")).toHaveCount(1);

      // Reading the store notification did not touch the other contexts.
      const unread = await prisma.notification.groupBy({ by: ["audience"], where: { recipientUserId: owner.id, readAt: null }, _count: true });
      expect(Object.fromEntries(unread.map((u) => [u.audience, u._count]))).toEqual({ CUSTOMER: 1, PLATFORM: 1 });
    } finally {
      await setFlag(false);
    }
  });

  // Regression (2026-11-18): a STORE «المخزون منخفض على أحد المنتجات» showed in
  // an owner's SHOPPING bell where workspace_scoping_enabled was never on.
  test("regression, flag off: the shopping bell (page, badge and drawer) shows CUSTOMER only - a customer-owner's STORE low-stock notice is in the store inbox only, a store workspace open in another tab changes nothing; an employee-customer sees only their branch's notice, in the workspace", async ({ context }) => {
    await setFlag(false);
    const LOW = "المخزون منخفض على أحد المنتجات";
    const owner = await account();
    const s = await store("lowstock", owner);
    const branchB = await prisma.storeBranch.create({
      data: { vendorId: s.vendorId, name: unique("فرع"), isPhysical: true, verificationStatus: "APPROVED" },
    });
    const employee = await account();
    await prisma.vendorUser.create({ data: { userId: employee.id, vendorId: s.vendorId, role: "BRANCH_EMPLOYEE", branchId: s.branchId } });
    const deliver = async (userId: string, type: string, audience: "CUSTOMER" | "STORE", branchId: string | null) => {
      const event = await prisma.outboxEvent.create({ data: { eventType: `tb26.ui.${type}`, payload: {}, status: "PUBLISHED", publishedAt: new Date() } });
      return prisma.notification.create({
        data: {
          outboxEventId: event.id,
          recipientUserId: userId,
          type: type as never,
          targetType: type === "LOW_STOCK_AFTER_RESERVE" ? "STOCK" : "BRANCH_ORDER",
          targetId: unique("t"),
          data: {},
          vendorId: audience === "STORE" ? s.vendorId : null,
          branchId,
          audience,
        },
      });
    };
    const ownerLow = await deliver(owner.id, "LOW_STOCK_AFTER_RESERVE", "STORE", s.branchId);
    await deliver(owner.id, "REVIEW_INVITATION", "CUSTOMER", null);
    await deliver(employee.id, "LOW_STOCK_AFTER_RESERVE", "STORE", s.branchId);
    await deliver(employee.id, "LOW_STOCK_AFTER_RESERVE", "STORE", branchB.id);
    await deliver(employee.id, "FAVORITE_PRICE_DROP", "CUSTOMER", null);
    const cards = (p: Page) => p.locator("button.card");
    const low = (p: Page) => p.locator("button.card", { hasText: LOW });

    // Tab 1: the store workspace, entered for real - the notice is there.
    const storeTab = await context.newPage();
    await loginAs(storeTab, owner.token);
    await storeTab.goto(`/vendor/${s.vendorId}/notifications`);
    await storeTab.getByTestId("ws-enter-confirm").click();
    await expect(storeTab).toHaveURL(new RegExp(`/vendor/${s.vendorId}/notifications$`));
    await expect(low(storeTab)).toHaveCount(1, { timeout: 30_000 });
    await expect(cards(storeTab)).toHaveCount(1);

    // Tab 2: shopping - page, badge and drawer show the customer notice only.
    const shopTab = await context.newPage();
    await loginAs(shopTab, owner.token);
    await shopTab.goto("/notifications");
    await expect(cards(shopTab)).toHaveCount(1, { timeout: 30_000 });
    await expect(low(shopTab)).toHaveCount(0);
    await expect(shopTab.getByRole("button", { name: "التنبيهات" }).locator(".badge-count")).toHaveText("1");
    await shopTab.setViewportSize({ width: 1280, height: 900 });
    await shopTab.goto("/");
    await shopTab.getByRole("button", { name: "التنبيهات" }).click();
    await expect(shopTab.locator(".notifications-drawer-item").first()).toBeVisible({ timeout: 30_000 });
    await expect(shopTab.locator(".notifications-drawer-item", { hasText: LOW })).toHaveCount(0);
    // Nothing the shopping side did touched the store notice.
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: ownerLow.id } })).readAt).toBeNull();

    // An employee who is also a customer: no store notice in shopping;
    // in the workspace, their own branch's only.
    const empShop = await context.newPage();
    await loginAs(empShop, employee.token);
    await empShop.goto("/notifications");
    await expect(cards(empShop)).toHaveCount(1, { timeout: 30_000 });
    await expect(low(empShop)).toHaveCount(0);
    await empShop.goto(`/vendor/${s.vendorId}/notifications`);
    await empShop.getByTestId("ws-enter-confirm").click();
    await expect(empShop).toHaveURL(new RegExp(`/vendor/${s.vendorId}/notifications$`));
    await expect(low(empShop)).toHaveCount(1, { timeout: 30_000 });
    await expect(cards(empShop)).toHaveCount(1);
  });

  test("signing out ends every workspace of the tab: after signing in again, a management page asks for the confirmation again", async ({ page }) => {
    const s = await store("logout");
    // Signed in once (no init script, so signing out really signs out).
    await page.goto("/login");
    await page.evaluate((t) => localStorage.setItem("finalpro_session_token", t), s.owner.token);
    await page.goto(`/vendor/${s.vendorId}`);
    await page.getByTestId("ws-enter-confirm").click();
    await expect(page.getByTestId("workspace-bar")).toBeVisible();
    expect((await storedWorkspaces(page)).session).toContain(s.vendorId);

    await page.goto("/account");
    await page.locator(".account-signout").click();
    await expect(page).toHaveURL(/\/login/);
    expect((await storedWorkspaces(page)).session ?? "").not.toContain(s.vendorId);
    // (The server-side end of the session and its workspaces is proven by
    // the API suite - tb26-workspace-scoping.e2e-spec.ts.)

    const again = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone: s.owner.phone, password: PASSWORD } });
    await page.evaluate((t) => localStorage.setItem("finalpro_session_token", t), again.body.session_token);
    await page.goto(`/vendor/${s.vendorId}`);
    await expect(page).toHaveURL(/\/workspaces\/enter\?/);
  });

  test("English: the confirmation page is in English and fits a phone screen", async ({ page }) => {
    const s = await store("english");
    // The signed-in account's own language wins over the browser's.
    await prisma.user.update({ where: { id: s.owner.id }, data: { languagePref: "en" } });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.addInitScript(() => localStorage.setItem("finalpro_lang_pref", "en"));
    await loginAs(page, s.owner.token);
    await page.goto(`/vendor/${s.vendorId}`);
    await expect(page.getByRole("heading", { name: "Enter the store workspace" })).toBeVisible();
    await expect(page.getByTestId("ws-enter-confirm")).toHaveText("Enter the workspace");
    await expectNoHorizontalOverflow(page);
  });
});

// TB-26: the session is checked before the workspace. A lost session (401)
// always goes to sign-in with `next` = the page asked for - whichever answer
// the browser gets first - and the entry confirmation is only ever shown to
// someone still signed in. Both network orders are forced here (the
// workspaces read is answered at once, or held until the page has had every
// chance to move on), and the outcome must be the same.
test.describe("TB-26: a lost session goes to sign-in first, never by way of the entry confirmation", () => {
  const SESSION_KEY = "finalpro_session_token";
  const visited = (page: Page) => {
    const urls: string[] = [];
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) urls.push(f.url());
    });
    return urls;
  };
  const expired = async () => {
    const s = await store("expired");
    await prisma.user.update({ where: { id: s.owner.id }, data: { sessionVersion: { increment: 1 } } });
    return s;
  };
  const loginNext = (page: Page) => {
    const u = new URL(page.url());
    return u.pathname === "/login" ? u.searchParams.get("next") : null;
  };
  const lost401 = {
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "SESSION_INVALID", message: "Session is invalid or has expired", details: [], correlation_id: "tb26-order" } }),
  };

  test("401 answered BEFORE the workspace gate: sign-in with next = this page; the session is cleared", async ({ page }) => {
    const s = await expired();
    const path = `/vendor/${s.vendorId}/settings`;
    await loginAs(page, s.owner.token);
    await page.route("**/api/v1/me/workspaces", (route) => route.fulfill(lost401));
    const urls = visited(page);
    await page.goto(path);
    await expect.poll(() => loginNext(page), { timeout: 30_000 }).toBe(path);
    expect(urls.some((u) => u.includes("/workspaces/enter"))).toBe(false);
    expect(await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY)).toBeNull();
  });

  test("the workspace gate BEFORE the 401 (the read held back): still no confirmation - the same sign-in with next = this page", async ({ page }) => {
    const s = await expired();
    const path = `/vendor/${s.vendorId}/staff`;
    await loginAs(page, s.owner.token);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let asked!: () => void;
    const requested = new Promise<void>((r) => (asked = r));
    await page.route("**/api/v1/me/workspaces", async (route) => {
      asked();
      await held;
      await route.fulfill(lost401);
    });
    const urls = visited(page);
    await page.goto(path);
    await requested;
    // Every chance to go to the confirmation while the session is unknown:
    // the page stays put (a skeleton), it does not move on.
    await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(new URL(page.url()).pathname).toBe(path);
    release();
    await expect.poll(() => loginNext(page), { timeout: 30_000 }).toBe(path);
    expect(urls.some((u) => u.includes("/workspaces/enter"))).toBe(false);
    expect(await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY)).toBeNull();
  });

  test("a real expired session (no route forced) ends the same way on every workspace page", async ({ page }) => {
    const s = await expired();
    await loginAs(page, s.owner.token);
    for (const path of [`/vendor/${s.vendorId}`, `/vendor/${s.vendorId}/settings`, `/vendor/${s.vendorId}/staff`]) {
      const urls = visited(page);
      await page.goto(path);
      await expect.poll(() => loginNext(page), { timeout: 30_000 }).toBe(path);
      expect(urls.some((u) => u.includes("/workspaces/enter"))).toBe(false);
    }
    // A page whose own sign-in link carries no `next` yet (the products
    // list): still sign-in first, never by way of the confirmation.
    const urls = visited(page);
    await page.goto(`/vendor/${s.vendorId}/offers`);
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe("/login");
    expect(urls.some((u) => u.includes("/workspaces/enter"))).toBe(false);
    expect(await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY)).toBeNull();
  });

  test("still signed in (valid session, no workspace token): the confirmation - only once the session is confirmed - and the session is kept", async ({ page }) => {
    const s = await store("valid");
    const path = `/vendor/${s.vendorId}/settings`;
    await loginAs(page, s.owner.token);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/v1/me/workspaces", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(path);
    await page.waitForTimeout(1_500);
    expect(new URL(page.url()).pathname).toBe(path);
    release();
    await expect(page).toHaveURL(/\/workspaces\/enter\?/, { timeout: 30_000 });
    expect(new URL(page.url()).searchParams.get("next")).toBe(path);
    await expect(page.getByTestId("ws-enter-name")).toHaveText(s.legalName);
    expect(await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY)).toBe(s.owner.token);
  });

  test("signed out, a direct workspace link: sign-in first, then the confirmation, then the page", async ({ page }) => {
    const s = await store("direct");
    const path = `/vendor/${s.vendorId}/settings`;
    const entry = `/workspaces/enter?type=vendor&vendor_id=${s.vendorId}&next=${encodeURIComponent(path)}`;
    for (const start of [path, entry]) {
      await page.goto("/");
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      const urls = visited(page);
      await page.goto(start);
      await expect(page).toHaveURL(/\/login\?/, { timeout: 30_000 });
      expect(urls.filter((u) => u.includes("/workspaces/enter") && !start.startsWith("/workspaces")).length).toBe(0);
      await page.getByLabel("رقم الهاتف", { exact: true }).fill(s.owner.phone);
      await page.getByLabel("كلمة المرور", { exact: true }).fill(PASSWORD);
      await page.getByRole("button", { name: "تسجيل الدخول" }).click();
      await expect(page).toHaveURL(/\/workspaces\/enter\?/, { timeout: 30_000 });
      await expect(page.getByTestId("ws-enter-name")).toHaveText(s.legalName);
      await page.getByTestId("ws-enter-confirm").click();
      await expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: 30_000 });
    }
  });
});
