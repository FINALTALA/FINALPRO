import { expect, test, type Page } from "@playwright/test";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";

// VIA phase 2D - Admin Orders through the real screens: the list finds a
// real order, the detail shows its checkout lines, money, a masked
// customer and the customer order; the forced cancel (the existing
// endpoint) needs a reason and a confirmation. The API rules are proven
// by apps/api/test/admin-orders-2d.e2e-spec.ts; this file proves the pages.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

async function user(platformRole: "PLATFORM_ADMIN" | "VERIFICATION_REVIEWER" | null, lang: "ar" | "en" = "ar") {
  const phone = uniquePhone();
  const u = await prisma.user.create({
    data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), platformRole, languagePref: lang },
  });
  await prisma.customerProfile.create({ data: { userId: u.id, displayName: "زبونة الطلبات" } });
  const login = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
  return { id: u.id, phone, token: login.body.session_token };
}

/** A store, and a real marketplace order (cart -> reserve -> confirm), pickup + COD. */
async function placedOrder() {
  const vendor = await prisma.vendor.create({
    data: {
      slug: unique("ao2d").toLowerCase(),
      legalName: unique("متجر"),
      displayName: unique("متجر الطلبات"),
      status: "ACTIVE",
      subscriptionStatus: "ACTIVE",
      storefrontPublished: true,
    },
  });
  const branch = await prisma.storeBranch.create({
    data: { vendorId: vendor.id, name: unique("فرع"), isPhysical: true, verificationStatus: "APPROVED" },
  });
  const offer = await prisma.vendorOffer.create({
    data: { vendorId: vendor.id, titleAr: "قميص كتان", titleEn: "Linen shirt", status: "ACTIVE" },
  });
  const variant = await prisma.offerVariant.create({
    data: { vendorId: vendor.id, vendorOfferId: offer.id, sellerSku: unique("sku"), storeInventoryBarcode: unique("sib"), basePrice: 75 },
  });
  await prisma.branchStock.create({ data: { vendorId: vendor.id, branchId: branch.id, offerVariantId: variant.id, quantity: 5 } });
  const shopper = await user(null);
  const line = await call<{ id: string }>("/cart/items", {
    method: "POST",
    token: shopper.token,
    idempotencyKey: unique("cart"),
    body: { vendor_id: vendor.id, offer_variant_id: variant.id, quantity: 2 },
  });
  const reserved = await call<{ reservation_id: string }>("/checkout/reserve", {
    method: "POST",
    token: shopper.token,
    idempotencyKey: unique("reserve"),
    body: {
      terms_accepted: true,
      terms_version: "2026-10-v1",
      groups: [{ cart_item_ids: [line.body.id], branch_id: branch.id, fulfilment_method: "PICKUP", payment_method: "COD" }],
    },
  });
  const confirmed = await call<{ branch_orders: { id: string }[] }>("/checkout/confirm", {
    method: "POST",
    token: shopper.token,
    idempotencyKey: unique("confirm"),
    body: { reservation_id: reserved.body.reservation_id },
  });
  expect(confirmed.status).toBe(201);
  return { vendor, shopper, orderId: confirmed.body.branch_orders[0].id };
}

async function asAdmin(page: Page, token: string, lang: "ar" | "en" = "ar") {
  await page.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
  await loginAs(page, token);
  await enterWorkspace(page, token, { type: "platform" });
}

test.describe("Phase 2D: admin orders", () => {
  test("the list finds a real order; the detail shows its lines, money, a masked customer and the customer order", async ({ page }) => {
    const o = await placedOrder();
    const admin = await user("PLATFORM_ADMIN");
    await asAdmin(page, admin.token);
    await page.goto("/admin/orders");
    await page.getByLabel("بحث").fill(o.vendor.displayName);
    await page.getByTestId("ao-apply").click();
    await expect(page.getByTestId("ao-row")).toHaveCount(1);
    await expect(page.getByTestId("ao-row-status")).toHaveText("جديد");
    await page.getByTestId("ao-row").getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/admin/orders/${o.orderId}$`));

    await expect(page.getByTestId("ao-line")).toContainText("قميص كتان");
    await expect(page.getByTestId("ao-money")).toContainText("150");
    const customer = page.getByTestId("ao-customer");
    await expect(customer).toContainText("زبونة الطلبات");
    await expect(customer).toContainText(o.shopper.phone.slice(-3));
    await expect(customer).not.toContainText(o.shopper.phone);
    await expect(page.getByTestId("ao-siblings")).toContainText("هذا الطلب");
  });

  test("force cancel needs a reason and a confirmation; going back changes nothing", async ({ page }) => {
    const o = await placedOrder();
    const admin = await user("PLATFORM_ADMIN");
    await asAdmin(page, admin.token);
    await page.goto(`/admin/orders/${o.orderId}`);
    await expect(page.getByTestId("ao-force-cancel")).toBeDisabled();
    await page.getByLabel("السبب (10 أحرف على الأقل، يُسجَّل في سجل التدقيق)").fill("طلب مكرر بالخطأ من الزبون");
    await page.getByTestId("ao-force-cancel").click();
    await page.getByTestId("small-confirm").getByRole("button", { name: "تراجع" }).click();
    expect((await prisma.branchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe("PLACED");

    await page.getByTestId("ao-force-cancel").click();
    await page.getByTestId("small-confirm-ok").click();
    await expect(page.getByTestId("ao-notice")).toBeVisible();
    await expect(page.getByTestId("ao-status")).toHaveText(/ملغى|مسترد/);
    await expect(page.getByTestId("ao-no-action")).toBeVisible();
  });

  test("a reviewer cannot open orders", async ({ page }) => {
    const reviewer = await user("VERIFICATION_REVIEWER");
    await asAdmin(page, reviewer.token);
    await page.goto("/admin/orders");
    await expect(page.getByText("هذه الصفحة لمدير المنصة فقط")).toBeVisible();
  });

  test("English, phone width: left-to-right, no sideways scroll on the list and the detail", async ({ page }) => {
    const o = await placedOrder();
    const admin = await user("PLATFORM_ADMIN", "en");
    await page.setViewportSize({ width: 390, height: 844 });
    await asAdmin(page, admin.token, "en");
    await page.goto("/admin/orders");
    await expect(page.getByRole("heading", { name: "Orders", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto(`/admin/orders/${o.orderId}`);
    await expect(page.getByRole("heading", { name: "Items (as recorded at checkout)" })).toBeVisible();
    await expect(page.getByTestId("ao-line")).toContainText("Linen shirt");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
