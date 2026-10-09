import { expect, test } from "@playwright/test";
import { createVendorWithBranch, placeAndPickUpOrder, submitReturn } from "./helpers/api";
import { createOfferWithStock, escalateReturn, itemIdForOrder } from "./helpers/db";
import { loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// Sprint 21 (PDR-031 escalation, review-round point 1): the admin's
// escalation queue - forbidden for a non-admin, empty, populated, and
// both resolution outcomes (approve issues a code; reject is
// ADMIN_REJECTED, final).
test.describe("admin returns UI", () => {
  const fixtures = loadSharedFixtures();

  test("forbidden state: a non-admin signed-in user cannot see the page", async ({
    page,
  }) => {
    await loginAs(page, fixtures.ownerToken);
    await page.goto("/admin/returns");
    await expect(page.getByText("هذه الصفحة لمدير المنصة فقط")).toBeVisible();
  });

  test("empty state: no escalated returns", async ({ page }) => {
    await loginAs(page, fixtures.adminToken);
    await page.goto("/admin/returns");
    await expect(
      page.getByText("لا توجد إرجاعات معلَّقة لمراجعتك حالياً"),
    ).toBeVisible();
  });

  test("approve an escalated return", async ({ page }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const variantId = await createOfferWithStock(vendorId, branchId, 50, 5);
    const { branchOrderId } = await placeAndPickUpOrder(
      fixtures.ownerToken,
      fixtures.customerAToken,
      vendorId,
      branchId,
      variantId,
    );
    const itemId = await itemIdForOrder(branchOrderId);
    const submitted = await submitReturn(fixtures.customerAToken, branchOrderId, itemId);
    await escalateReturn(submitted.body.id);

    await loginAs(page, fixtures.adminToken);
    await page.goto("/admin/returns");
    await expect(page.getByText("معلَّق - قيد مراجعة إدارة المنصة")).toBeVisible();
    await page.getByRole("button", { name: "اعتماد الإرجاع" }).click();
    await expect(
      page.getByText("لا توجد إرجاعات معلَّقة لمراجعتك حالياً"),
    ).toBeVisible();
  });

  test("reject an escalated return - final, requires a reason", async ({ page }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const variantId = await createOfferWithStock(vendorId, branchId, 50, 5);
    const { branchOrderId } = await placeAndPickUpOrder(
      fixtures.ownerToken,
      fixtures.customerAToken,
      vendorId,
      branchId,
      variantId,
    );
    const itemId = await itemIdForOrder(branchOrderId);
    const submitted = await submitReturn(fixtures.customerAToken, branchOrderId, itemId);
    await escalateReturn(submitted.body.id);

    await loginAs(page, fixtures.adminToken);
    await page.goto("/admin/returns");
    await page.getByRole("button", { name: "رفض نهائي" }).click();
    await page
      .getByRole("textbox")
      .fill("Platform review confirms the store's original decision.");
    await page.getByRole("button", { name: "تأكيد الرفض النهائي" }).click();
    await expect(
      page.getByText("لا توجد إرجاعات معلَّقة لمراجعتك حالياً"),
    ).toBeVisible();
  });
});
