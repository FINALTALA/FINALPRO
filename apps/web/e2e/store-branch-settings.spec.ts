import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique, uniquePhone } from "./helpers/api";
import { createOfferWithStock, makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// 2026-11-23 «إدارة الفروع / إعدادات المتجر»: a branch's daily tools only (no
// settings tab), «إعدادات الفرع» beside the picker (details, minimum order,
// archiving - an archived branch reads only), «إعدادات المتجر» by the title
// (delivery zones and fees with the zone minimum, the return policy - every
// branch), the owner's «كل الفروع» orders scope (badge, branch filter with
// counts, in the URL; never the employee), the branch's returns with the store
// policy in one line and «استبدال كود إرجاع» as its action (receiving branch =
// this one), the five old cards gone and their old addresses redirected.

const localRequire = createRequire(__filename);
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
async function account(name: string) {
  const phone = uniquePhone();
  const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" } });
  await prisma.customerProfile.create({ data: { userId: user.id, displayName: name } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: "a-strong-password" } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, token: res.body.session_token };
}

test.describe("Branch management and store settings", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let slug = "";
  let branchA = "";
  let branchB = "";
  let archived = "";
  const orders: Record<string, string> = {};

  /** A confirmed pickup order at one branch, through the real checkout. */
  async function pickupOrder(branchId: string, variant: string) {
    const buyer = await account("زبونة");
    const cart = await call<{ id: string }>("/cart/items", {
      method: "POST",
      token: buyer.token,
      idempotencyKey: unique("cart"),
      body: { vendor_id: vendorId, offer_variant_id: variant, quantity: 1 },
    });
    const reserve = await call<{ reservation_id: string }>("/checkout/reserve", {
      method: "POST",
      token: buyer.token,
      idempotencyKey: unique("reserve"),
      body: {
        terms_accepted: true,
        terms_version: "2026-10-v1",
        groups: [{ cart_item_ids: [cart.body.id], branch_id: branchId, fulfilment_method: "PICKUP", payment_method: "COD" }],
      },
    });
    if (reserve.status !== 201) throw new Error(`reserve: ${reserve.status} ${JSON.stringify(reserve.body)}`);
    const confirm = await call<{ branch_orders: { id: string }[] }>("/checkout/confirm", {
      method: "POST",
      token: buyer.token,
      idempotencyKey: unique("confirm"),
      body: { reservation_id: reserve.body.reservation_id },
    });
    if (confirm.status !== 201) throw new Error(`confirm: ${confirm.status} ${JSON.stringify(confirm.body)}`);
    return confirm.body.branch_orders[0].id;
  }

  test.beforeAll(async () => {
    ({ vendorId, branchId: branchA } = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع رام الله"));
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    const added = await call<{ id: string }>(`/vendors/${vendorId}/branches`, { method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("branch"), body: { name: "فرع نابلس" } });
    branchB = added.body.id;
    const old = await call<{ id: string }>(`/vendors/${vendorId}/branches`, { method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("branch"), body: { name: "فرع قديم" } });
    archived = old.body.id;
    await makeVendorEligible(vendorId);
    await prisma.storeBranch.update({ where: { id: archived }, data: { archivedAt: new Date() } });
    const vA = await createOfferWithStock(vendorId, branchA, 50, 20);
    const vB = await createOfferWithStock(vendorId, branchB, 60, 20);
    orders.a = await pickupOrder(branchA, vA);
    orders.b = await pickupOrder(branchB, vB);
  });

  async function asOwner(page: Page, viewport = { width: 1360, height: 900 }) {
    await page.setViewportSize(viewport);
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
  }
  async function asEmployee(page: Page) {
    const emp = await account("موظفة نابلس");
    await prisma.vendorUser.create({ data: { userId: emp.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: branchB } });
    await page.setViewportSize({ width: 1360, height: 900 });
    await loginAs(page, emp.token);
    await enterWorkspace(page, emp.token, { type: "vendor", vendor_id: vendorId });
    return emp;
  }

  test("the management grid: the five old cards are gone; «إدارة الفروع» stays", async ({ page }) => {
    await asOwner(page);
    await page.goto(`/store/${slug}`);
    await page.locator(".store-manage-button").click();
    await expect(page.locator(".store-management-grid")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("management-tile-branches")).toBeVisible();
    for (const k of ["delivery-zones", "delivery-windows", "orders", "return-policy", "returns/redeem"]) {
      await expect(page.getByTestId(`management-tile-${k}`)).toHaveCount(0);
    }
    for (const k of ["offers", "storefront", "performance"]) await expect(page.getByTestId(`management-tile-${k}`)).toBeVisible();
  });

  test("branch settings: a gear beside the picker (no tab) - details, minimum order, archiving; an archived branch only reads", async ({ page }) => {
    await asOwner(page);
    await page.goto(`/vendor/${vendorId}/branches/${branchA}/orders`);
    await expect(page.getByTestId("br-tabs")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".br-tool")).toHaveCount(7);
    await expect(page.getByTestId("br-tab-settings")).toHaveCount(0);
    const gear = page.getByTestId("br-branch-settings");
    await expect(gear).toHaveAccessibleName("إعدادات الفرع: فرع رام الله");
    expect(await page.locator(".br-head-actions").evaluate((el) => el.contains(document.querySelector('[data-testid="br-branch-settings"]')))).toBe(true);
    await gear.click();
    await expect(page).toHaveURL(new RegExp(`/branches/${branchA}/settings$`), { timeout: 30_000 });
    await expect(gear).toHaveAttribute("aria-current", "page");
    await expect(page.locator('.br-tool[aria-current="page"]')).toHaveCount(0);
    await expect(page.getByTestId("br-settings")).toBeVisible();
    await expect(page.getByTestId("br-minimum-order")).toBeVisible();
    await expect(page.getByTestId("br-archive")).toBeVisible();

    // an archived branch: its details and status only - no minimum editor, no write action
    await page.goto(`/vendor/${vendorId}/branches/${archived}/settings`);
    await expect(page.getByTestId("br-settings-archived-note")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("br-minimum-order")).toHaveCount(0);
    await expect(page.getByTestId("br-archive")).toHaveCount(0);
    await expect(page.getByTestId("br-archived")).toBeVisible();
  });

  test("store settings: a gear by the title (every branch) - delivery zones with the zone minimum and the return policy; the old addresses open their section", async ({ page }) => {
    await asOwner(page);
    await page.goto(`/vendor/${vendorId}/branches/${branchA}/stock`);
    const gear = page.getByTestId("br-store-settings");
    await expect(gear).toHaveText(/إعدادات المتجر.*لكل الفروع/, { timeout: 30_000 });
    // by the «إدارة الفروع» title, not with the current branch's controls
    expect(await page.locator(".br-eyebrow-row").evaluate((el) => el.contains(document.querySelector('[data-testid="br-store-settings"]')))).toBe(true);
    await gear.click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/settings$`), { timeout: 30_000 });
    await expect(page.getByTestId("store-settings")).toContainText("تنطبق على كل فروع المتجر");

    // a zone: fee and its own minimum, one save
    const wb = page.getByTestId("ss-zone-WEST_BANK");
    await wb.getByTestId("ss-zone-fee-WEST_BANK").fill("15");
    await wb.getByTestId("ss-zone-min-WEST_BANK").fill("60");
    await wb.getByTestId("ss-zone-save-WEST_BANK").click();
    await expect(wb.getByTestId("ss-zone-saved-WEST_BANK")).toHaveText("حُفظت الضفة الغربية.");
    const zone = await prisma.vendorDeliveryZone.findFirstOrThrow({ where: { vendorId, region: "WEST_BANK" } });
    expect(Number(zone.fee)).toBe(15);
    expect(Number(zone.minimumOrderValue)).toBe(60);
    // cleared minimum: back to each branch's own
    await wb.getByTestId("ss-zone-min-WEST_BANK").fill("");
    await wb.getByTestId("ss-zone-save-WEST_BANK").click();
    await expect(wb.getByTestId("ss-zone-saved-WEST_BANK")).toBeVisible();
    expect((await prisma.vendorDeliveryZone.findFirstOrThrow({ where: { vendorId, region: "WEST_BANK" } })).minimumOrderValue).toBeNull();
    await expect(page.getByTestId("ss-returns")).toBeVisible();

    // the old addresses: their section, scrolled to and focused
    await page.goto(`/vendor/${vendorId}/delivery-zones`);
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/settings#delivery$`), { timeout: 30_000 });
    await expect(page.getByTestId("ss-delivery")).toBeFocused();
    await page.goto(`/vendor/${vendorId}/return-policy`);
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/settings#returns$`), { timeout: 30_000 });
    await expect(page.getByTestId("ss-returns")).toBeFocused();
    await expect(page.getByTestId("ss-returns")).toBeInViewport();
  });

  test("orders: the owner's scope «الفرع الحالي» / «كل الفروع» - badges, branch filter with counts, in the URL; an order of another branch opens with its own branch", async ({ page }) => {
    await asOwner(page);
    await page.goto(`/vendor/${vendorId}/branches/${branchA}/orders`);
    const scope = page.getByTestId("bo-scope");
    await expect(scope).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("bo-scope-branch")).toBeChecked();
    await expect(page.locator(`[data-order-id="${orders.a}"]`)).toBeVisible();
    await expect(page.locator(`[data-order-id="${orders.b}"]`)).toHaveCount(0);
    await expect(page.getByTestId("bo-row-branch")).toHaveCount(0);
    // the scope keeps its height in the fitted queue column (never squeezed to its border)
    await page.waitForTimeout(800);
    expect((await scope.boundingBox())!.height).toBeGreaterThanOrEqual(38);

    await page.getByTestId("bo-scope-all").check();
    await expect(page).toHaveURL(/[?&]scope=all/);
    await expect(page.locator(`[data-order-id="${orders.b}"]`)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`[data-order-id="${orders.a}"]`)).toBeVisible();
    await expect(page.locator(`[data-order-id="${orders.b}"]`).getByTestId("bo-row-branch")).toHaveText("فرع نابلس");
    const filter = page.getByTestId("bo-branch-filter");
    await expect(filter.locator("option", { hasText: "فرع نابلس (1)" })).toHaveCount(1);
    await expect(filter.locator("option", { hasText: "فرع قديم" })).toHaveCount(0); // archived and nothing open
    await filter.selectOption(branchB);
    await expect(page).toHaveURL(new RegExp(`[?&]branch=${branchB}`));
    await expect(page.locator(`[data-order-id="${orders.a}"]`)).toHaveCount(0, { timeout: 30_000 });
    // open branch B's order from branch A's dashboard: it is read under its own branch
    await page.locator(`[data-order-id="${orders.b}"]`).click();
    await expect(page).toHaveURL(new RegExp(`[?&]ob=${branchB}`));
    await expect(page.getByTestId("branch-orders").locator(".bo-pane")).toContainText(orders.b.slice(0, 8), { timeout: 30_000 });
    // a reload keeps it all (the URL is the state)
    await page.reload();
    await expect(page.getByTestId("bo-scope-all")).toBeChecked({ timeout: 30_000 });
    await expect(page.getByTestId("bo-branch-filter")).toHaveValue(branchB);

    // the old store-wide address: the «كل الفروع» scope
    await page.goto(`/vendor/${vendorId}/orders`);
    await expect(page).toHaveURL(/\/orders\?scope=all$/, { timeout: 30_000 });
    await expect(page.getByTestId("bo-scope-all")).toBeChecked({ timeout: 30_000 });
  });

  test("the employee: own branch only - no scope, no store-wide queue (server 403), no settings gears, no store settings", async ({ page }) => {
    const emp = await asEmployee(page);
    await page.goto(`/vendor/${vendorId}/branches/${branchB}/orders?scope=all`);
    await expect(page.locator(`[data-order-id="${orders.b}"]`)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`[data-order-id="${orders.a}"]`)).toHaveCount(0);
    await expect(page.getByTestId("bo-scope")).toHaveCount(0);
    await expect(page.getByTestId("bo-row-branch")).toHaveCount(0);
    await expect(page.getByTestId("br-branch-settings")).toHaveCount(0);
    await expect(page.getByTestId("br-store-settings")).toHaveCount(0);
    const res = await call(`/vendors/${vendorId}/order-queue`, { token: emp.token });
    expect(res.status).toBe(403);
    await page.goto(`/vendor/${vendorId}/settings`);
    await expect(page.getByText("إعدادات المتجر للمالكة فقط.")).toBeVisible({ timeout: 30_000 });
    // the old orders address: own branch, no scope
    await page.goto(`/vendor/${vendorId}/orders`);
    await expect(page).toHaveURL(new RegExp(`/branches/${branchB}/orders$`), { timeout: 30_000 });
  });

  test("returns: the store policy in one read-only line, «استلام إرجاع» received at THIS branch; the old address opens it - owner and employee", async ({ page }) => {
    await asOwner(page);
    await page.goto(`/vendor/${vendorId}/branches/${branchA}/returns`);
    await expect(page.getByTestId("rt-policy")).toContainText("سياسة المتجر:", { timeout: 30_000 });
    await expect(page.getByTestId("rt-policy-link")).toHaveAttribute("href", `/vendor/${vendorId}/settings#returns`);
    // IX-P2: «استلام إرجاع» is the board's one entry for a code
    await page.getByTestId("rb-receive-open").click();
    const dlg = page.getByTestId("rb-receive-dialog");
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId("rb-receive-branch")).toContainText("الاستلام في: فرع رام الله");
    await expect(dlg.locator("select")).toHaveCount(0); // no branch list - the header picker decides
    await dlg.getByTestId("rb-code-input").fill("123");
    await dlg.getByTestId("rb-check").click();
    await expect(dlg.locator(".error-banner")).toHaveText("كود الإرجاع مكوّن من 6 أرقام.");
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await expect(page).not.toHaveURL(/redeem=1|receive=1/);

    // the old address: the current branch's returns with the dialog open
    await page.goto(`/vendor/${vendorId}/returns/redeem`);
    await expect(page).toHaveURL(/\/returns\?redeem=1$/, { timeout: 30_000 });
    await expect(page.getByTestId("rb-receive-dialog")).toBeVisible();

    // the employee: own branch, the same line (read only - no settings link)
    const empPage = await page.context().browser()!.newPage();
    await asEmployee(empPage);
    await empPage.goto(`/vendor/${vendorId}/returns/redeem`);
    await expect(empPage).toHaveURL(new RegExp(`/branches/${branchB}/returns\\?redeem=1$`), { timeout: 30_000 });
    await expect(empPage.getByTestId("rb-receive-branch")).toContainText("فرع نابلس");
    await expect(empPage.getByTestId("rt-policy")).toBeVisible();
    await expect(empPage.getByTestId("rt-policy-link")).toHaveCount(0);
    await empPage.close();
  });

  test("phone, keyboard, English (LTR) and axe: the branch header gears and the store settings", async ({ page }) => {
    await asOwner(page, { width: 390, height: 844 });
    await page.goto(`/vendor/${vendorId}/branches/${branchA}/orders`);
    await expect(page.getByTestId("br-branch-settings")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    await page.goto(`/vendor/${vendorId}/settings`);
    await expect(page.getByTestId("ss-zone-WEST_BANK")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    // the keyboard: the jump link moves to the section
    await page.getByTestId("ss-jump-returns").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#returns$/);

    await page.setViewportSize({ width: 1360, height: 900 });
    const axe = async (selector: string) => {
      await page.addScriptTag({ content: readFileSync(localRequire.resolve("axe-core/axe.min.js"), "utf8") });
      return page.evaluate(async (sel) => {
        const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[]; any: { message: string }[] }[] }[] }> } }).axe;
        const r = await a.run({ include: [[sel]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.map((n) => `${n.target.join(" ")} - ${n.any[0]?.message ?? ""}`).join(" | ")}`);
      }, selector);
    };
    expect(await axe('[data-testid="store-settings"]')).toEqual([]);
    await page.goto(`/vendor/${vendorId}/branches/${branchA}/orders?scope=all`);
    await expect(page.getByTestId("bo-scope")).toBeVisible({ timeout: 30_000 });
    expect(await axe('[data-testid="br-bar"]')).toEqual([]);
    expect(await axe('[data-testid="bo-scope"]')).toEqual([]);

    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await page.goto(`/vendor/${vendorId}/settings`);
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.locator(".sst-title")).toHaveText("Store settings");
      await expect(page.getByTestId("ss-delivery").locator("h2")).toHaveText("Delivery zones and fees");
      expect(await axe('[data-testid="store-settings"]')).toEqual([]);
      await page.goto(`/vendor/${vendorId}/branches/${branchA}/orders`);
      await expect(page.getByTestId("br-store-settings")).toContainText("Store settings", { timeout: 30_000 });
      await expect(page.getByTestId("bo-scope-all")).toBeVisible();
      await expect(page.getByTestId("bo-scope")).toContainText("All branches");
      await expectNoHorizontalOverflow(page);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "ar"));
    }
  });
});
