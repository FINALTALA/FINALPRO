import { expect, test } from "@playwright/test";
import {
  call,
  createVendorWithBranch,
  placeAndPickUpOrder,
} from "./helpers/api";
import { createOfferWithStock, prisma } from "./helpers/db";
import { loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// Sprint 25 review-round fix (Playwright): real-browser coverage for
// the three new PLATFORM_ADMIN-only pages (`/admin/audit-logs`,
// `/admin/feature-flags`, `/admin/vendors/performance`) and the
// additive inline performance section on the owner's existing
// `/vendor/:id` hub page - none of this had a real-browser test
// before this fix round, only the Jest e2e suite's HTTP-level
// coverage. Mirrors this project's established Playwright shape:
// drive the REAL running API + web app + throwaway Postgres, never a
// mock, reusing the shared global-setup fixtures.
const FLAG_KEY = "vendor_performance_dashboard_enabled";

async function setFeatureFlag(adminToken: string, enabled: boolean): Promise<void> {
  const res = await call(`/admin/feature-flags/${FLAG_KEY}`, {
    method: "PUT",
    token: adminToken,
    body: { enabled },
  });
  if (res.status !== 200) {
    throw new Error(`setFeatureFlag(${enabled}) failed (status ${res.status}): ${JSON.stringify(res.body)}`);
  }
}

test.describe("Sprint 25: admin audit logs, feature flags, vendor performance UI", () => {
  const fixtures = loadSharedFixtures();

  test("admin can search the audit log for a specific order's transitions and export it as CSV", async ({
    page,
  }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const variantId = await createOfferWithStock(vendorId, branchId, 50, 5);
    const { branchOrderId } = await placeAndPickUpOrder(
      fixtures.ownerToken,
      fixtures.customerAToken,
      vendorId,
      branchId,
      variantId,
    );

    await loginAs(page, fixtures.adminToken);
    await page.goto("/admin/audit-logs");
    await expect(page.getByRole("heading", { name: "سجل التدقيق" })).toBeVisible();

    await page.getByLabel("معرّف الكيان").fill(branchOrderId);
    await page.getByRole("button", { name: "تصفية", exact: true }).click();
    // Both start-preparation and pickup-handover transitioned this
    // order's status - the real redacted summary (never the raw
    // beforeState/afterState JSON) must show for at least one of them.
    await expect(page.getByText("status:").first()).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "تصدير CSV" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("audit-logs.csv");
  });

  test("the vendor-performance flag starts disabled by default; admin enables it via the feature-flags page", async ({
    page,
  }) => {
    await loginAs(page, fixtures.adminToken);
    await page.goto("/admin/feature-flags");
    await expect(page.getByRole("heading", { name: "أعلام الميزات" })).toBeVisible();
    await expect(page.getByText(FLAG_KEY)).toBeVisible();
    await expect(page.getByText("معطَّلة")).toBeVisible();

    await page.getByRole("button", { name: "تفعيل" }).click();
    await expect(page.getByText("مفعّلة")).toBeVisible();
    await expect(page.getByRole("button", { name: "تعطيل" })).toBeVisible();
  });

  test("admin's vendor-performance page shows real indicators for a vendor with a completed order, once the flag is enabled", async ({
    page,
  }) => {
    await setFeatureFlag(fixtures.adminToken, true);
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const variantId = await createOfferWithStock(vendorId, branchId, 50, 5);
    await placeAndPickUpOrder(
      fixtures.ownerToken,
      fixtures.customerAToken,
      vendorId,
      branchId,
      variantId,
    );
    const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });

    await loginAs(page, fixtures.adminToken);
    await page.goto("/admin/vendors/performance");
    await expect(page.getByRole("heading", { name: "أداء المتاجر" })).toBeVisible();
    await expect(page.getByRole("cell", { name: vendor.legalName })).toBeVisible();
  });

  test("owner sees the inline performance section on their own dashboard once the flag is enabled", async ({
    page,
  }) => {
    await setFeatureFlag(fixtures.adminToken, true);
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const variantId = await createOfferWithStock(vendorId, branchId, 50, 5);
    await placeAndPickUpOrder(
      fixtures.ownerToken,
      fixtures.customerAToken,
      vendorId,
      branchId,
      variantId,
    );

    await loginAs(page, fixtures.ownerToken);
    await page.goto(`/vendor/${vendorId}`);
    await expect(page.getByText("مؤشرات الأداء (آخر 30 يوماً)")).toBeVisible();
    await expect(page.getByText("معدّل الإلغاء")).toBeVisible();
    // One completed, zero cancelled order in the window -> 0.0%, never
    // a blank/dash (that would only be correct with zero terminal
    // orders at all).
    await expect(page.getByText("0.0%")).toBeVisible();
  });

  test("disabling the flag (via the admin UI) hides the owner's section and shows the disabled state on the admin page", async ({
    page,
  }) => {
    await setFeatureFlag(fixtures.adminToken, true);
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const variantId = await createOfferWithStock(vendorId, branchId, 50, 5);
    await placeAndPickUpOrder(
      fixtures.ownerToken,
      fixtures.customerAToken,
      vendorId,
      branchId,
      variantId,
    );

    // Sanity: confirmed visible while the flag is still on.
    await loginAs(page, fixtures.ownerToken);
    await page.goto(`/vendor/${vendorId}`);
    await expect(page.getByText("مؤشرات الأداء (آخر 30 يوماً)")).toBeVisible();

    await loginAs(page, fixtures.adminToken);
    await page.goto("/admin/feature-flags");
    await page.getByRole("button", { name: "تعطيل" }).click();
    await expect(page.getByText("معطَّلة")).toBeVisible();

    await page.goto("/admin/vendors/performance");
    await expect(
      page.getByText("ميزة لوحة أداء المتاجر غير مفعّلة حالياً"),
    ).toBeVisible();

    await loginAs(page, fixtures.ownerToken);
    await page.goto(`/vendor/${vendorId}`);
    await expect(page.getByText("مؤشرات الأداء (آخر 30 يوماً)")).not.toBeVisible();
  });
});
