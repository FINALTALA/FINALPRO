import { expect, test } from "@playwright/test";
import {
  addToCart,
  call,
  createVendorWithBranch,
  decideReturn,
  placeAndPickUpOrder,
  redeemReturn,
  submitReturn,
} from "./helpers/api";
import { createOfferWithStock, createOfferWithTwoVariants, itemIdForOrder, prisma } from "./helpers/db";
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
    // nth(0) is the RETURN/EXCHANGE outcome picker (Sprint 21b) - the
    // reason select is nth(1).
    await page.locator("select").nth(1).selectOption("CHANGE_OF_MIND");
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

  // Sprint 21b (EPIC-RET): the exchange outcome - the replacement
  // picker (variant then dependent branch), the 24h exchange code
  // wording, and the EXCHANGED settlement amount once redeemed.
  // approveReturn()/redeem() themselves are already proven at the HTTP
  // level by sprint21b-exchange.e2e-spec.ts; this only has to prove
  // the UI renders and drives the real server responses correctly.
  test("submit an exchange, see the exchange code, then the settlement after redemption", async ({
    page,
  }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken, {
      mode: "BOTH",
      window_days: 14,
      fee_ils: 5,
      exchange_fee_ils: 10,
    });
    const { originalVariantId } = await createOfferWithTwoVariants(
      vendorId,
      branchId,
      100,
      5,
      130,
      5,
    );
    const { branchOrderId } = await placeAndPickUpOrder(
      fixtures.ownerToken,
      fixtures.customerAToken,
      vendorId,
      branchId,
      originalVariantId,
    );
    const itemId = await itemIdForOrder(branchOrderId);

    await loginAs(page, fixtures.customerAToken);
    await page.goto(`/orders/${branchOrderId}/items/${itemId}/return`);
    await page.locator("select").nth(0).selectOption("EXCHANGE");

    // Only one eligible replacement (the other variant of the same
    // offer) at only one eligible branch (the order's own branch), so
    // the page auto-selects both - wait for the dependent branch
    // select (nth(3)) to render, proving the whole fetch+auto-select
    // chain completed (option text inside a closed <select> is not
    // itself "visible" to Playwright, unlike the select element).
    await expect(page.locator("select").nth(3)).toBeVisible();
    await page.getByRole("button", { name: "إرسال طلب التبديل" }).click();
    await expect(page.getByText("تم إرسال طلب التبديل")).toBeVisible();
    await page.getByRole("link", { name: "تتبّع طلب التبديل" }).click();
    await expect(page).toHaveURL(/\/returns\/.+/);
    await expect(page.getByText("قيد مراجعة المتجر")).toBeVisible();

    const returnId = page.url().split("/returns/")[1];
    await decideReturn(fixtures.ownerToken, vendorId, branchId, returnId, {
      decision: "approve",
    });

    await page.reload();
    await expect(page.getByText(/كود التبديل/)).toBeVisible();
    await expect(page.getByText(/24 ساعة/)).toBeVisible();

    const withCode = await prisma.return.findUniqueOrThrow({ where: { id: returnId } });
    await redeemReturn(fixtures.ownerToken, vendorId, withCode.code!, branchId);

    await page.reload();
    await expect(page.getByText(/تم التبديل بنجاح/)).toBeVisible();
    // 130 (replacement) - 100 (original) + 10 (exchange fee) = 40, collected from the customer.
    await expect(page.getByText(/دفعتِ 40 ₪ نقداً في الفرع/)).toBeVisible();
  });
});
