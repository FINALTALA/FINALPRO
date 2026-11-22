import { expect, test, type Page } from "@playwright/test";
import { createVendorWithBranch } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// TB-9: an order in a state the order state machine never produces (a
// pickup order "delivered") used to fail its customer's whole order
// list and its store's lists with the API's raw English message. Now
// every list loads with it among the others, and a list that does fail
// says so in Arabic - never the technical message.

const RAW = /Cannot move|INVALID_BRANCH_ORDER_TRANSITION|branch order/i;
const LOAD_FAILED = "تعذّر تحميل الطلبات الآن. حاولي مرة أخرى بعد قليل.";
const FORBIDDEN = "لا تملكين صلاحية عرض هذه الطلبات.";
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

test.describe("TB-9: order lists with an invalid order", () => {
  const fixtures = loadSharedFixtures();
  let customerToken = "";
  let vendorId = "";
  let branchId = "";
  let bad = "";
  let good = "";

  test.beforeAll(async () => {
    // The shared owner account shops here too (every account has a
    // customer profile) - no new signup, so a re-run never meets the
    // 5-per-minute OTP limit.
    const phone = fixtures.ownerPhone;
    customerToken = fixtures.ownerToken;
    ({ vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken));
    await makeVendorEligible(vendorId);
    const profile = await prisma.customerProfile.findFirstOrThrow({ where: { user: { phone } } });
    const make = async (data: { fulfilmentMethod: "PICKUP" | "DELIVERY"; deliveredAt: Date; pickupCode?: string }) => {
      const customerOrder = await prisma.customerOrder.create({ data: { customerId: profile.id } });
      const row = await prisma.branchOrder.create({
        data: { customerOrderId: customerOrder.id, vendorId, branchId, paymentMethod: "COD", subtotal: 10, total: 10, status: "DELIVERED", ...data },
      });
      return row.id;
    };
    // The invalid one, written straight in as the old fixture did, and a valid one due its auto-confirm.
    bad = await make({ fulfilmentMethod: "PICKUP", deliveredAt: hoursAgo(10_000), pickupCode: String(Date.now()).slice(-6) });
    good = await make({ fulfilmentMethod: "DELIVERY", deliveredAt: hoursAgo(80) });
  });

  async function noRawMessage(page: Page) {
    await expect(page.locator(".error-banner")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toMatch(RAW);
  }

  test("the customer's orders list shows every order, with no error and no technical text", async ({ page }) => {
    await loginAs(page, customerToken);
    await page.goto("/cart?tab=orders");
    await expect(page.locator(`[data-order-id="${good}"]`)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`[data-order-id="${bad}"]`)).toBeVisible();
    await noRawMessage(page);
  });

  test("the store's and the branch's order lists load with it", async ({ page }) => {
    await loginAs(page, fixtures.ownerToken);
    // TB-26: store pages need the store workspace entered (as the next test
    // does) - without it both lists were the workspace-entry page, whose
    // own card satisfied the old `.card` check
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    // 2026-11-22: the branch's screen is the order queue (rows, not cards)
    for (const [url, row] of [
      [`/vendor/${vendorId}/orders`, ".card"],
      [`/vendor/${vendorId}/branches/${branchId}/orders`, '[data-testid^="branch-order-"]'],
    ] as const) {
      await page.goto(url);
      await expect(page.locator(row).filter({ hasText: /./ }).first()).toBeVisible({ timeout: 30_000 });
      await noRawMessage(page);
    }
  });

  test("a list that fails anyway says so in Arabic, never with the API's own message", async ({ page }) => {
    const technical = { error: { code: "INVALID_BRANCH_ORDER_TRANSITION", message: "Cannot move a PICKUP branch order from DELIVERED to COMPLETED", details: [] } };
    const fail = (status: number) => (route: import("@playwright/test").Route) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(technical) });

    await loginAs(page, customerToken);
    await page.route("**/customers/me/orders", fail(409));
    await page.goto("/cart?tab=orders");
    await expect(page.locator(".error-banner")).toHaveText(LOAD_FAILED, { timeout: 30_000 });
    expect(await page.locator("body").innerText()).not.toMatch(RAW);
    await page.unroute("**/customers/me/orders");

    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    // 2026-11-22: the branch's screen reads the order queue
    for (const [path, pagePath, status, text] of [
      [`/vendors/${vendorId}/orders`, `/vendor/${vendorId}/orders`, 409, LOAD_FAILED],
      [`/vendors/${vendorId}/branches/${branchId}/order-queue`, `/vendor/${vendorId}/branches/${branchId}/orders`, 500, LOAD_FAILED],
      [`/vendors/${vendorId}/orders`, `/vendor/${vendorId}/orders`, 403, FORBIDDEN],
    ] as const) {
      await page.route(`**${path}`, fail(status));
      await page.goto(pagePath);
      await expect(page.locator(".error-banner")).toHaveText(text, { timeout: 30_000 });
      expect(await page.locator("body").innerText()).not.toMatch(RAW);
      await page.unroute(`**${path}`);
    }
  });
});
