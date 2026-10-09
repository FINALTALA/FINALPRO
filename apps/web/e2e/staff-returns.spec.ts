import { expect, test } from "@playwright/test";
import { createVendorWithBranch, placeAndPickUpOrder, submitReturn } from "./helpers/api";
import { createOfferWithStock, itemIdForOrder, prisma } from "./helpers/db";
import { loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// Sprint 21 (FR-RET-002, PDR-031, review-round point 1): the branch-
// scoped decision queue and the vendor-wide redeem page - empty,
// populated, approve/reject, and the redeem success/error states.
test.describe("staff/owner returns UI", () => {
  const fixtures = loadSharedFixtures();

  test("empty state: a branch with no returns yet", async ({ page }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    await loginAs(page, fixtures.ownerToken);
    await page.goto(`/vendor/${vendorId}/branches/${branchId}/returns`);
    await expect(page.getByText("لا توجد طلبات إرجاع لهذا الفرع")).toBeVisible();
  });

  test("approve a REQUESTED return, then redeem its code at the same branch", async ({
    page,
  }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const variantId = await createOfferWithStock(vendorId, branchId, 90, 5);
    const { branchOrderId } = await placeAndPickUpOrder(
      fixtures.ownerToken,
      fixtures.customerAToken,
      vendorId,
      branchId,
      variantId,
    );
    const itemId = await itemIdForOrder(branchOrderId);
    const submitted = await submitReturn(fixtures.customerAToken, branchOrderId, itemId);

    await loginAs(page, fixtures.ownerToken);
    await page.goto(`/vendor/${vendorId}/branches/${branchId}/returns`);
    await expect(page.getByText("قيد مراجعة المتجر")).toBeVisible();
    await page.getByRole("button", { name: "اعتماد" }).click();
    await expect(page.getByText("معتمد - بانتظار تسليم المنتج")).toBeVisible();
    await expect(page.getByRole("button", { name: "اعتماد" })).not.toBeVisible();

    const withCode = await prisma.return.findUniqueOrThrow({
      where: { id: submitted.body.id },
    });

    await page.goto(`/vendor/${vendorId}/returns/redeem`);
    // Scoped to <main> - a plain "input" locator also matches the
    // shared header's own search box (role "searchbox", but still a
    // bare <input> tag), which this page sits behind.
    await page.locator("main input").first().fill(withCode.code!);
    await page.getByRole("button", { name: "استبدال" }).click();
    await expect(page.getByText("تم استلام المنتج بنجاح")).toBeVisible();
  });

  test("redeem with an invalid code shows the server's error", async ({ page }) => {
    const { vendorId } = await createVendorWithBranch(fixtures.ownerToken);
    await loginAs(page, fixtures.ownerToken);
    await page.goto(`/vendor/${vendorId}/returns/redeem`);
    await page.locator("main input").first().fill("000000");
    await page.getByRole("button", { name: "استبدال" }).click();
    await expect(
      page.getByText("هذا الكود غير صالح، أو مستخدم من قبل، أو منتهي."),
    ).toBeVisible();
  });

  test("rejecting a return requires a reason, then shows it as rejected", async ({
    page,
  }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const variantId = await createOfferWithStock(vendorId, branchId, 70, 5);
    const { branchOrderId } = await placeAndPickUpOrder(
      fixtures.ownerToken,
      fixtures.customerAToken,
      vendorId,
      branchId,
      variantId,
    );
    const itemId = await itemIdForOrder(branchOrderId);
    await submitReturn(fixtures.customerAToken, branchOrderId, itemId);

    await loginAs(page, fixtures.ownerToken);
    await page.goto(`/vendor/${vendorId}/branches/${branchId}/returns`);
    await page.getByRole("button", { name: "رفض" }).click();
    await page.getByRole("textbox").fill("Visible wear inconsistent with the stated reason.");
    await page.getByRole("button", { name: "تأكيد الرفض" }).click();
    await expect(page.getByText("مرفوض من المتجر")).toBeVisible();
  });
});
