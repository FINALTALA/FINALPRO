import { expect, test, type Page } from "@playwright/test";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";

// VIA phase 2C - offer moderation through the real screens: an admin asks
// for changes (with a confirmation), the store owner sees the reason on the
// product page and submits the current version, the admin restores it - and
// the public product read follows the hold. The API's own rules (public
// surfaces, cart, checkout, races) are proven by
// apps/api/test/offer-moderation-2c.e2e-spec.ts; this file proves the pages.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

async function user(platformRole: "PLATFORM_ADMIN" | "VERIFICATION_REVIEWER" | null, lang: "ar" | "en" = "ar") {
  const phone = uniquePhone();
  const u = await prisma.user.create({
    data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), platformRole, languagePref: lang },
  });
  await prisma.customerProfile.create({ data: { userId: u.id } });
  const login = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
  return { id: u.id, token: login.body.session_token };
}

async function liveOffer() {
  const owner = await user(null);
  const vendor = await prisma.vendor.create({
    data: {
      slug: unique("om2c").toLowerCase(),
      legalName: unique("متجر"),
      displayName: "متجر الإشراف",
      status: "ACTIVE",
      subscriptionStatus: "ACTIVE",
      storefrontPublished: true,
    },
  });
  await prisma.vendorUser.create({ data: { vendorId: vendor.id, userId: owner.id, role: "OWNER" } });
  const branch = await prisma.storeBranch.create({
    data: { vendorId: vendor.id, name: unique("فرع"), isPhysical: true, verificationStatus: "APPROVED" },
  });
  const offer = await prisma.vendorOffer.create({
    data: { vendorId: vendor.id, titleAr: unique("فستان"), titleEn: "Dress", status: "ACTIVE" },
  });
  const variant = await prisma.offerVariant.create({
    data: { vendorId: vendor.id, vendorOfferId: offer.id, sellerSku: unique("sku"), storeInventoryBarcode: unique("sib"), basePrice: 90 },
  });
  await prisma.branchStock.create({ data: { vendorId: vendor.id, branchId: branch.id, offerVariantId: variant.id, quantity: 5 } });
  return { owner, vendor, offer };
}

async function asAdmin(page: Page, token: string, lang: "ar" | "en" = "ar") {
  await page.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
  await loginAs(page, token);
  await enterWorkspace(page, token, { type: "platform" });
}

const publicStatus = async (slug: string, offerId: string) =>
  (await call(`/storefronts/${slug}/offers/${offerId}`)).status;

test.describe("Phase 2C: offer moderation", () => {
  test.describe.configure({ mode: "serial" });

  // One flow in three serial steps (each within the default per-test limit).
  let w: Awaited<ReturnType<typeof liveOffer>>;
  let admin: Awaited<ReturnType<typeof user>>;

  test("request changes: the admin finds the offer and holds it (confirmed)", async ({ browser }) => {
    w = await liveOffer();
    admin = await user("PLATFORM_ADMIN");
    expect(await publicStatus(w.vendor.slug, w.offer.id)).toBe(200);

    const adminPage = await browser.newPage();
    await asAdmin(adminPage, admin.token);
    await adminPage.goto("/admin/offers");
    await adminPage.getByLabel("بحث").fill(w.offer.titleAr);
    await adminPage.getByTestId("om-apply").click();
    await expect(adminPage.getByTestId("om-row")).toHaveCount(1);
    await adminPage.getByTestId("om-row").getByRole("link").click();
    await expect(adminPage).toHaveURL(new RegExp(`/admin/offers/${w.offer.id}$`));
    await adminPage.getByLabel("السبب (يظهر للمتجر، 3 أحرف على الأقل)").fill("الصور لا تطابق الوصف");
    await adminPage.getByTestId("om-request").click();
    await adminPage.getByTestId("small-confirm-ok").click();
    await expect(adminPage.getByTestId("om-notice")).toBeVisible();
    await expect(adminPage.getByTestId("om-hold-action")).toHaveText("مطلوب تعديلات");
    expect(await publicStatus(w.vendor.slug, w.offer.id)).toBe(404);
    await adminPage.close();
  });

  test("the owner sees the reason and submits the current version; still held", async ({ browser }) => {
    const ownerPage = await browser.newPage();
    await loginAs(ownerPage, w.owner.token);
    await enterWorkspace(ownerPage, w.owner.token, { type: "vendor", vendor_id: w.vendor.id });
    await ownerPage.goto(`/vendor/${w.vendor.id}/offers/${w.offer.id}`);
    const notice = ownerPage.getByTestId("platform-hold-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("الصور لا تطابق الوصف");
    await ownerPage.getByTestId("platform-hold-submit").click();
    await expect(ownerPage.getByTestId("platform-hold-submitted")).toBeVisible();
    expect(await publicStatus(w.vendor.slug, w.offer.id)).toBe(404); // still held
    await ownerPage.close();
  });

  test("the admin sees the submitted revision and restores (confirmed)", async ({ browser }) => {
    const adminPage = await browser.newPage();
    await asAdmin(adminPage, admin.token);
    await adminPage.goto(`/admin/offers/${w.offer.id}`);
    await expect(adminPage.getByTestId("om-correction")).toContainText(String(await revision(w.offer.id)));
    await adminPage.getByLabel("ملاحظة (3 أحرف على الأقل)").fill("تمت المراجعة");
    await adminPage.getByTestId("om-restore").click();
    await adminPage.getByTestId("small-confirm-ok").click();
    await expect(adminPage.getByTestId("om-current")).toContainText("لا يوجد إيقاف مفتوح");
    await expect(adminPage.getByTestId("om-history")).toBeVisible();
    expect(await publicStatus(w.vendor.slug, w.offer.id)).toBe(200);
    await adminPage.close();
  });

  test("hide needs a reason and a confirmation; cancelling changes nothing", async ({ page }) => {
    const w = await liveOffer();
    const admin = await user("PLATFORM_ADMIN");
    await asAdmin(page, admin.token);
    await page.goto(`/admin/offers/${w.offer.id}`);
    await expect(page.getByTestId("om-hide")).toBeDisabled();
    await page.getByLabel("السبب (يظهر للمتجر، 3 أحرف على الأقل)").fill("منتج مقلّد");
    await page.getByTestId("om-hide").click();
    await page.getByTestId("small-confirm").getByRole("button", { name: "إلغاء" }).click();
    expect(await prisma.offerPlatformHold.count({ where: { vendorOfferId: w.offer.id } })).toBe(0);
    await page.getByTestId("om-hide").click();
    await page.getByTestId("small-confirm-ok").click();
    await expect(page.getByTestId("om-hold-action")).toHaveText("مخفي من المنصة");
    expect(await publicStatus(w.vendor.slug, w.offer.id)).toBe(404);
  });

  test("a reviewer cannot use offer moderation", async ({ page }) => {
    const reviewer = await user("VERIFICATION_REVIEWER");
    await asAdmin(page, reviewer.token);
    await page.goto("/admin/offers");
    await expect(page.getByText("هذه الصفحة لمدير المنصة فقط")).toBeVisible();
  });

  test("English, phone width: left-to-right labels, no sideways scroll", async ({ page }) => {
    const w = await liveOffer();
    const admin = await user("PLATFORM_ADMIN", "en");
    await page.setViewportSize({ width: 390, height: 844 });
    await asAdmin(page, admin.token, "en");
    await page.goto("/admin/offers");
    await expect(page.getByRole("heading", { name: "Offer moderation" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await page.goto(`/admin/offers/${w.offer.id}`);
    await expect(page.getByRole("heading", { name: "Current moderation" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

async function revision(offerId: string) {
  return (await prisma.vendorOffer.findUniqueOrThrow({ where: { id: offerId }, select: { contentRevision: true } }))
    .contentRevision;
}
