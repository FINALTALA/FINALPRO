import { expect, test } from "@playwright/test";
import { createVendorWithBranch } from "./helpers/api";
import { createMatchedOfferWithStock } from "./helpers/db";
import { loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// Sprint 24 (FR-FAV-001/002, FR-COMP-001/002/005): real-browser
// coverage for the new favorites/saved-comparison-set/cross-comparison
// screens. The business rules themselves are already proven at the
// HTTP level by apps/api/test/sprint24-favorites-comparison-alerts
// .e2e-spec.ts (27 tests); this only has to prove the new UI renders
// and drives real server responses correctly.
test.describe("S24 favorites and comparison sets UI", () => {
  const fixtures = loadSharedFixtures();

  test("favoriting a product from its comparison page shows it in /favorites, then removing it there clears it", async ({
    page,
  }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const { canonicalProductId } = await createMatchedOfferWithStock(
      vendorId,
      branchId,
      100,
      5,
    );

    await loginAs(page, fixtures.customerAToken);
    await page.goto(`/compare/${canonicalProductId}`);
    await expect(page.getByText("100.00 ₪", { exact: true })).toBeVisible();
    await expect(page.getByText("غير متوفر").first()).toBeVisible();

    await page.getByRole("button", { name: "أضيفي للمفضلة" }).click();
    await expect(page.getByRole("button", { name: "في المفضلة" })).toBeVisible();

    await page.goto("/account/favorites");
    await expect(page.getByText("منتج تجريبي للمقارنة")).toBeVisible();

    await page.getByRole("button", { name: "إزالة من المفضلة" }).click();
    await expect(page.getByText("منتج تجريبي للمقارنة")).not.toBeVisible();
  });

  test("saved comparison set: create from the comparison page, add a second item, then delete the set", async ({
    page,
  }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const a = await createMatchedOfferWithStock(vendorId, branchId, 60, 5);
    const b = await createMatchedOfferWithStock(vendorId, branchId, 80, 5);

    await loginAs(page, fixtures.customerBToken);
    await page.goto(`/compare/${a.canonicalProductId}`);
    await page.getByRole("button", { name: "أضيفي لمجموعة مقارنة جديدة" }).click();
    await expect(
      page.getByRole("button", { name: "أُضيف لمجموعة مقارنة جديدة" }),
    ).toBeVisible();

    await page.goto("/compare/sets");
    await page.getByRole("link", { name: /مجموعة من 1 منتج/ }).click();
    await expect(page.getByRole("heading", { name: "مجموعة المقارنة" })).toBeVisible();

    await page.getByPlaceholder("معرّف منتج جديد").fill(b.canonicalProductId);
    await page.getByRole("button", { name: "إضافة" }).click();
    await expect(page.getByText("80.00 ₪")).toBeVisible();

    await page.getByRole("button", { name: "حذف المجموعة" }).click();
    await expect(page).toHaveURL(/\/compare\/sets$/);
  });

  test("cross-comparison tags the cheaper of two competing products", async ({ page }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const cheap = await createMatchedOfferWithStock(vendorId, branchId, 50, 5);
    const expensive = await createMatchedOfferWithStock(vendorId, branchId, 150, 5);

    await page.goto("/compare/cross");
    const inputs = page.getByPlaceholder(/معرّف المنتج/);
    await inputs.nth(0).fill(cheap.canonicalProductId);
    await inputs.nth(1).fill(expensive.canonicalProductId);
    await page.getByRole("button", { name: "قارني" }).click();

    await expect(page.getByText("50.00 ₪", { exact: true })).toBeVisible();
    await expect(page.getByText("150.00 ₪", { exact: true })).toBeVisible();
    await expect(page.getByText("أقل سعر بين المنتجات المقارَنة")).toBeVisible();
  });
});
