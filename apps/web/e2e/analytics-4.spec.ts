import { readFileSync } from "fs";
import { expect, test, type Page } from "@playwright/test";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";

// VIA phase 4 - the dashboard and Analytics through the real screens: real
// KPI cards (GMV never called revenue), the Approval Center counts, a
// period filter that shows a known completed order, store/product/POS
// tabs, a CSV export carrying the same figure and its metadata, a reviewer
// kept to the plain hub, English at phone width. The figures' rules are
// proven by apps/api/test/analytics-4.e2e-spec.ts.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH =
  "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

async function user(
  platformRole: "PLATFORM_ADMIN" | "VERIFICATION_REVIEWER" | null,
  lang: "ar" | "en" = "ar",
) {
  const phone = uniquePhone();
  const u = await prisma.user.create({
    data: {
      phone,
      passwordHash: PASSWORD_HASH,
      phoneVerifiedAt: new Date(),
      platformRole,
      languagePref: lang,
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { userId: u.id },
  });
  const login = await call<{ session_token: string }>("/auth/login", {
    method: "POST",
    body: { phone, password: PASSWORD },
  });
  return { id: u.id, profileId: profile.id, token: login.body.session_token };
}

async function asAdmin(page: Page, token: string, lang: "ar" | "en" = "ar") {
  await page.addInitScript(
    (l) => localStorage.setItem("finalpro_lang_pref", l),
    lang,
  );
  await loginAs(page, token);
  await enterWorkspace(page, token, { type: "platform" });
}

/** A store, one completed order (2 x 125.00) and one in-store sale, on DAY (a 2023 local day chosen per run, so reruns on one database never add up). */
const DAY = new Date(
  Date.UTC(2023, 0, 1) + (Math.floor(Date.now() / 1000) % 360) * 86_400_000,
)
  .toISOString()
  .slice(0, 10);
async function soldOnJune10() {
  const name = unique("متجر التحليلات");
  const vendor = await prisma.vendor.create({
    data: {
      slug: unique("an4").toLowerCase(),
      legalName: unique("l"),
      displayName: name,
      status: "ACTIVE",
      subscriptionStatus: "ACTIVE",
      storefrontPublished: true,
    },
  });
  const branch = await prisma.storeBranch.create({
    data: {
      vendorId: vendor.id,
      name: unique("فرع"),
      isPhysical: true,
      verificationStatus: "APPROVED",
    },
  });
  const offer = await prisma.vendorOffer.create({
    data: {
      vendorId: vendor.id,
      titleAr: "معطف صوف",
      titleEn: "Wool coat",
      status: "ACTIVE",
    },
  });
  const variant = await prisma.offerVariant.create({
    data: {
      vendorId: vendor.id,
      vendorOfferId: offer.id,
      sellerSku: unique("s"),
      storeInventoryBarcode: unique("b"),
      basePrice: 125,
    },
  });
  const buyer = await user(null);
  const at = new Date(`${DAY}T09:00:00.000Z`);
  const co = await prisma.customerOrder.create({
    data: { customerId: buyer.profileId, createdAt: at },
  });
  const bo = await prisma.branchOrder.create({
    data: {
      customerOrderId: co.id,
      vendorId: vendor.id,
      branchId: branch.id,
      fulfilmentMethod: "PICKUP",
      paymentMethod: "ONLINE",
      status: "COMPLETED",
      subtotal: 250,
      total: 250,
      createdAt: at,
      completedAt: new Date(`${DAY}T12:00:00.000Z`),
    },
  });
  await prisma.branchOrderItem.create({
    data: {
      vendorId: vendor.id,
      branchOrderId: bo.id,
      offerVariantId: variant.id,
      quantity: 2,
      unitPrice: 125,
      titleArSnapshot: "معطف صوف",
      createdAt: at,
    },
  });
  await prisma.storeSale.create({
    data: {
      vendorId: vendor.id,
      branchId: branch.id,
      saleNumber: 1,
      status: "COMPLETED",
      paymentMethod: "CASH",
      total: 80,
      currency: "ILS",
      soldById: buyer.id,
      createdAt: new Date(`${DAY}T10:00:00.000Z`),
    },
  });
  return { name };
}

test.describe("Phase 4: dashboard and analytics", () => {
  test("the dashboard shows real figures, the approvals inbox counts and never calls GMV revenue", async ({
    page,
  }) => {
    const admin = await user("PLATFORM_ADMIN");
    await asAdmin(page, admin.token);
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "لوحة المنصة" }),
    ).toBeVisible();
    await expect(page.getByTestId("an-kpi-gmv")).toContainText("₪");
    await expect(page.getByTestId("an-kpi-registered")).toBeVisible();
    await expect(page.getByTestId("an-revenue-note")).toContainText(
      "ليس إيراد VIA",
    );
    await expect(page.getByTestId("an-approvals")).toContainText(
      "بانتظار القرار",
    );
    await expect(page.getByTestId("an-daily-chart")).toBeVisible();
    await page.getByTestId("an-open-analytics").click();
    await expect(page).toHaveURL(/\/admin\/analytics$/);
  });

  test("a period shows the known order; stores, products and POS tabs; the CSV export carries the same figure", async ({
    page,
  }) => {
    const { name } = await soldOnJune10();
    const admin = await user("PLATFORM_ADMIN");
    await asAdmin(page, admin.token);
    await page.goto("/admin/analytics");
    await page.locator("#an-from").fill(DAY);
    await page.locator("#an-to").fill(DAY);
    await page.getByTestId("an-apply").click();
    await expect(page.getByTestId("an-period")).toContainText(DAY);
    // Only this test writes 2023 data (an isolated database).
    await expect(page.getByTestId("an-kpi-gmv")).toContainText("250");

    await page.getByTestId("an-tab-stores").click();
    await expect(page.getByTestId("an-stores")).toContainText(name);
    await page.getByTestId("an-tab-products").click();
    await expect(page.getByTestId("an-offers")).toContainText("معطف صوف");
    await page.getByTestId("an-tab-pos").click();
    await expect(page.getByTestId("an-kpi-pos_total")).toContainText("80");
    await expect(page.getByTestId("an-pos")).toContainText(name);

    await page.getByTestId("an-tab-stores").click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("an-export-csv-stores").click(),
    ]);
    const csv = readFileSync((await download.path())!, "utf8");
    expect(csv).toContain('"# time_zone","Asia/Hebron"');
    expect(csv).toContain(`"# from","${DAY}"`);
    expect(csv).toContain(name);
    expect(csv).toContain('"250.00"');
  });

  test("a reviewer keeps the plain hub and cannot open analytics", async ({
    page,
  }) => {
    const reviewer = await user("VERIFICATION_REVIEWER");
    await asAdmin(page, reviewer.token);
    await page.goto("/admin");
    await expect(page.locator(".hub-tile").first()).toBeVisible();
    await expect(page.getByTestId("an-kpi-gmv")).toHaveCount(0);
    await page.goto("/admin/analytics");
    await expect(page.getByText("هذه الصفحة لمدير المنصة فقط")).toBeVisible();
  });

  test("English, phone width: left-to-right, no sideways scroll on the dashboard and analytics", async ({
    page,
  }) => {
    const admin = await user("PLATFORM_ADMIN", "en");
    await page.setViewportSize({ width: 390, height: 844 });
    await asAdmin(page, admin.token, "en");
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "Platform dashboard" }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByTestId("an-kpi-gmv")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.goto("/admin/analytics");
    await expect(
      page.getByRole("heading", { name: "Analytics", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("an-kpi-gmv")).toBeVisible();
    for (const tab of ["stores", "products", "pos"]) {
      await page.getByTestId(`an-tab-${tab}`).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
  });
});
