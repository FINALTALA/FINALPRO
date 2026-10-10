import { expect, test } from "@playwright/test";
import {
  addToCart,
  call,
  createVendorWithBranch,
  decideReturn,
  placeAndPickUpOrder,
  submitReturn,
} from "./helpers/api";
import { createOfferWithStock, itemIdForOrder } from "./helpers/db";
import { loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// Sprint 21 (FR-RET-001..003, review-round point 1): the customer-
// facing returns UI, in a real Chromium browser against the real API -
// loading/empty/error/forbidden/success states, not just the Jest e2e
// suite's HTTP-level proof that the business rules themselves work.
test.describe("customer returns UI", () => {
  const fixtures = loadSharedFixtures();

  test("signed out: /returns redirects to login", async ({ page }) => {
    await page.goto("/returns");
    await expect(page).toHaveURL(/\/login/);
  });

  test("empty state: a customer with no returns sees the empty message", async ({
    page,
  }) => {
    await loginAs(page, fixtures.customerBToken);
    await page.goto("/returns");
    await expect(page.getByText("لا توجد طلبات إرجاع")).toBeVisible();
  });

  test("error state: requesting a return before the item is picked up shows the server's eligibility error", async ({
    page,
  }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const variantId = await createOfferWithStock(vendorId, branchId, 80, 5);
    const cartItemId = await addToCart(fixtures.customerBToken, vendorId, variantId, 1);
    const reserved = await call<{ reservation_id: string }>("/checkout/reserve", {
      method: "POST",
      token: fixtures.customerBToken,
      idempotencyKey: `pw-reserve-${Date.now()}`,
      body: {
        terms_accepted: true,
        terms_version: "2026-10-v1",
        groups: [
          {
            cart_item_ids: [cartItemId],
            branch_id: branchId,
            fulfilment_method: "PICKUP",
            payment_method: "ONLINE",
          },
        ],
      },
    });
    const confirmed = await call<{ branch_orders: { id: string }[] }>(
      "/checkout/confirm",
      {
        method: "POST",
        token: fixtures.customerBToken,
        idempotencyKey: `pw-confirm-${Date.now()}`,
        body: { reservation_id: reserved.body.reservation_id },
      },
    );
    const branchOrderId = confirmed.body.branch_orders[0].id;
    const itemId = await itemIdForOrder(branchOrderId);

    await loginAs(page, fixtures.customerBToken);
    await page.goto(`/orders/${branchOrderId}/items/${itemId}/return`);
    await page.getByRole("button", { name: "إرسال طلب الإرجاع" }).click();
    await expect(
      page.getByText("لا يمكن طلب إرجاع قبل استلام المنتج فعلياً"),
    ).toBeVisible();
  });

  test("submit a return, see it in the list, open it, and cancel it", async ({
    page,
  }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
    const { branchOrderId } = await placeAndPickUpOrder(
      fixtures.ownerToken,
      fixtures.customerAToken,
      vendorId,
      branchId,
      variantId,
    );
    const itemId = await itemIdForOrder(branchOrderId);

    await loginAs(page, fixtures.customerAToken);

    // Submit via the real form.
    await page.goto(`/orders/${branchOrderId}/items/${itemId}/return`);
    await page.locator("select").selectOption("CHANGE_OF_MIND");
    await page.getByRole("button", { name: "إرسال طلب الإرجاع" }).click();
    await expect(page.getByText("تم إرسال طلب الإرجاع")).toBeVisible();
    await page.getByRole("link", { name: "تتبّع طلب الإرجاع" }).click();
    await expect(page).toHaveURL(/\/returns\/.+/);
    await expect(page.getByText("قيد مراجعة المتجر")).toBeVisible();

    // It shows up in the list too.
    await page.goto("/returns");
    await expect(page.getByText("قيد مراجعة المتجر")).toBeVisible();
    await page.getByText("قيد مراجعة المتجر").first().click();

    // Cancel it from the detail page.
    await page.getByRole("button", { name: "إلغاء طلب الإرجاع" }).click();
    await expect(page.getByText("ألغاه العميل")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "إلغاء طلب الإرجاع" }),
    ).not.toBeVisible();

    // A second attempt on the same item is rejected server-side, and
    // that error renders too.
    await page.goto(`/orders/${branchOrderId}/items/${itemId}/return`);
    await page.getByRole("button", { name: "إرسال طلب الإرجاع" }).click();
    // CANCELLED_BY_CUSTOMER allows resubmission, so this one actually
    // succeeds - prove the resubmission path instead.
    await expect(page.getByText("تم إرسال طلب الإرجاع")).toBeVisible();
  });

  test("dispute a store rejection within the window", async ({ page }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const variantId = await createOfferWithStock(vendorId, branchId, 60, 5);
    const { branchOrderId } = await placeAndPickUpOrder(
      fixtures.ownerToken,
      fixtures.customerAToken,
      vendorId,
      branchId,
      variantId,
    );
    const itemId = await itemIdForOrder(branchOrderId);
    const submitted = await submitReturn(fixtures.customerAToken, branchOrderId, itemId);
    await decideReturn(fixtures.ownerToken, vendorId, branchId, submitted.body.id, {
      decision: "reject",
      rejection_reason: "Item shows signs of use beyond trying it on.",
    });

    await loginAs(page, fixtures.customerAToken);
    await page.goto(`/returns/${submitted.body.id}`);
    await expect(page.getByText("مرفوض من المتجر")).toBeVisible();
    await page.getByRole("button", { name: "الاعتراض على الرفض" }).click();
    await expect(page.getByText("معلَّق - قيد مراجعة إدارة المنصة")).toBeVisible();
  });
});
