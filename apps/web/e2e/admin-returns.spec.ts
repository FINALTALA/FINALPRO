import { expect, test } from "@playwright/test";
import {
  createVendorWithBranch,
  placeAndPickUpOrder,
  submitExchange,
  submitReturn,
} from "./helpers/api";
import {
  createOfferWithStock,
  createOfferWithTwoVariants,
  escalateReturn,
  itemIdForOrder,
  prisma,
} from "./helpers/db";
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

  // Sprint 21b (EPIC-RET): an escalated EXCHANGE request is marked
  // distinctly and its approval button says so - approveReturn() is
  // the SAME unified helper decide() uses, so approving here also
  // reserves the replacement stock (proven at the HTTP level by
  // sprint21b-exchange.e2e-spec.ts's own "unified approval" tests).
  test("approve an escalated exchange request", async ({ page }) => {
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
      100,
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
    const original = await prisma.offerVariant.findUniqueOrThrow({
      where: { id: originalVariantId },
    });
    const replacement = await prisma.offerVariant.findFirstOrThrow({
      where: { vendorOfferId: original.vendorOfferId, id: { not: originalVariantId } },
    });
    const submitted = await submitExchange(
      fixtures.customerAToken,
      branchOrderId,
      itemId,
      replacement.id,
      branchId,
    );
    await escalateReturn(submitted.body.id);

    await loginAs(page, fixtures.adminToken);
    await page.goto("/admin/returns");
    await expect(page.getByText("(طلب تبديل)")).toBeVisible();
    await page.getByRole("button", { name: "اعتماد التبديل" }).click();
    await expect(
      page.getByText("لا توجد إرجاعات معلَّقة لمراجعتك حالياً"),
    ).toBeVisible();
  });
});
