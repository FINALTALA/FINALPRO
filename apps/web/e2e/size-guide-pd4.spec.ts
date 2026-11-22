import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { call, createVendorWithBranch, unique } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// PD-4: size guides in a real browser - no link without a published
// guide, the owner choosing an approved guide, the product page's
// window (desktop and phone: RTL, focus, Esc, cm/inch, the selected
// size, in-table scrolling only) and the administrator's editor. Every
// guide this file publishes is retired again at the end, so a rerun on
// the same database starts from the same state.

const COLUMNS = [
  { key: "CHEST", is_range: true },
  { key: "WAIST", is_range: true },
  { key: "HIP", is_range: true },
  { key: "LENGTH", is_range: false },
];
const ROWS = [
  { size_code: "S", values: { CHEST: { min: 84, max: 88 }, WAIST: { min: 66, max: 70 }, HIP: { min: 90, max: 94 }, LENGTH: { min: 120 } } },
  { size_code: "M", values: { CHEST: { min: 88, max: 92 }, WAIST: { min: 70, max: 74 }, HIP: { min: 94, max: 98 }, LENGTH: { min: 122 } } },
  { size_code: "L", values: { CHEST: { min: 92, max: 96 }, WAIST: { min: 74, max: 78 }, HIP: { min: 98, max: 102 }, LENGTH: { min: 124 } } },
];

const published: string[] = [];

async function classifiedOffer(vendorId: string, branchId: string, sizes: string[]) {
  await makeVendorEligible(vendorId);
  const brand = await prisma.brand.create({ data: { name: unique("Brand"), normalizedName: unique("b") } });
  const category = await prisma.category.create({ data: { nameAr: unique("فئة"), nameEn: unique("C") } });
  const product = await prisma.canonicalProduct.create({
    data: { brandId: brand.id, categoryId: category.id, modelName: unique("M"), canonicalNameAr: "فستان", status: "PUBLISHED" },
  });
  const offer = await prisma.vendorOffer.create({
    data: {
      vendorId,
      titleAr: "فستان دليل المقاسات",
      titleEn: "Size guide dress",
      status: "ACTIVE",
      brandId: brand.id,
      canonicalProductId: product.id,
      taxonomyVersion: 1,
      requiresTaxonomy: true,
    },
  });
  await prisma.vendorOfferAudience.create({ data: { vendorId, vendorOfferId: offer.id, audience: "WOMEN" } });
  await prisma.vendorOfferCategory.create({ data: { vendorId, vendorOfferId: offer.id, categoryCode: "DRESSES_WOMEN" } });
  for (const [n, size] of sizes.entries()) {
    const cv = await prisma.canonicalProductVariant.create({
      data: { canonicalProductId: product.id, structuralAttributes: { n: unique("v") }, platformProductBarcode: unique("pb") },
    });
    const v = await prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique("sku"),
        storeInventoryBarcode: unique("sib"),
        basePrice: 150,
        isCombination: true,
        colorCode: "BLACK",
        sizeCode: size,
        canonicalVariantId: cv.id,
      },
    });
    await prisma.branchStock.create({ data: { vendorId, branchId, offerVariantId: v.id, quantity: 10 } });
    if (n === 0) {
      await prisma.offerVariantMedia.create({
        data: { vendorId, offerVariantId: v.id, url: "https://example.com/a.jpg", kind: "PRIMARY", mediaType: "IMAGE", sortOrder: 0 },
      });
    }
  }
  const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } });
  return { offerId: offer.id, slug: vendor.slug };
}

/** A published standard guide for women's dresses - not the default, so it never collides with another run. */
async function publishGuide(adminToken: string): Promise<{ id: string; name: string; nameEn: string }> {
  const name = `دليل فساتين ${unique("t").slice(-6)}`;
  const created = await call<{ id: string; draft_version: { id: string } }>("/admin/size-guides", {
    method: "POST",
    token: adminToken,
    idempotencyKey: unique("sg"),
    body: { code: unique("pw-guide").toLowerCase(), name_ar: name, name_en: `Dresses ${name.slice(-6)}`, kind: "STANDARD" },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  const put = (path: string, body: unknown) => call(`/admin/size-guides/${id}${path}`, { method: "PUT", token: adminToken, idempotencyKey: unique("sg"), body });
  expect((await put("/applicability", { pairs: [{ category_code: "DRESSES_WOMEN", audience: "WOMEN", is_default: false }] })).status).toBe(200);
  expect(
    (await put(`/versions/${created.body.draft_version.id}`, { basis: "BODY", measurements: COLUMNS, rows: ROWS, notes_ar: "قيسي حول أعرض جزء من الصدر.", notes_en: "Measure around the fullest part of the chest." })).status,
  ).toBe(200);
  const pub = await call(`/admin/size-guides/${id}/versions/${created.body.draft_version.id}/publish`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: unique("sg"),
  });
  expect(pub.status).toBe(200);
  published.push(id);
  return { id, name, nameEn: `Dresses ${name.slice(-6)}` };
}

test.describe("PD-4: size guides", () => {
  const fixtures = loadSharedFixtures();

  test.afterAll(async () => {
    for (const id of published) {
      await call(`/admin/size-guides/${id}/retire`, { method: "POST", token: fixtures.adminToken, idempotencyKey: unique("sg") });
    }
  });

  test("no published guide: the product page shows no size-guide link at all", async ({ browser }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    // JEANS for men - no guide in this suite ever applies there.
    const { offerId, slug } = await classifiedOffer(vendorId, branchId, ["S", "M"]);
    await prisma.vendorOfferCategory.updateMany({ where: { vendorOfferId: offerId }, data: { categoryCode: "JEANS" } });
    await prisma.vendorOfferAudience.updateMany({ where: { vendorOfferId: offerId }, data: { audience: "MEN" } });

    const page = await (await browser.newContext()).newPage();
    await page.goto(`/store/${slug}/products/${offerId}`);
    await expect(page.getByRole("radiogroup", { name: "المقاس" })).toBeVisible();
    await expect(page.getByRole("button", { name: "دليل المقاسات", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ليس مقاسك؟" })).toHaveCount(0);
    const api = await call<{ guides: unknown[] }>(`/storefronts/${slug}/offers/${offerId}/size-guide`);
    expect(api.status).toBe(200);
    expect(api.body.guides).toEqual([]);
  });

  test("owner picks the approved guide; the customer's window works on desktop", async ({ page, browser }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const { offerId, slug } = await classifiedOffer(vendorId, branchId, ["S", "M", "L"]);
    const guide = await publishGuide(fixtures.adminToken);

    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers/${offerId}`);
    await expect(page.getByRole("heading", { name: "دليل المقاسات", exact: true })).toBeVisible();
    await page.getByLabel("الدليل المستخدم لهذا العرض").selectOption(guide.id);
    await expect(page.getByText("تم اختيار الدليل")).toBeVisible();
    await expect(page.getByText("✓ كل مقاسات العرض موجودة في الدليل")).toBeVisible();

    const customer = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await customer.goto(`/store/${slug}/products/${offerId}`);
    await expect(customer.locator("html")).toHaveAttribute("dir", "rtl");
    await customer.getByRole("radio", { name: "M", exact: true }).click();
    const opener = customer.getByRole("button", { name: "دليل المقاسات", exact: true });
    await opener.click();

    const dialog = customer.getByRole("dialog", { name: "دليل المقاسات", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(guide.name, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "إغلاق دليل المقاسات" })).toBeFocused();
    const selected = dialog.locator("tr.is-selected");
    await expect(selected).toHaveAttribute("aria-current", "true");
    await expect(selected.locator("th")).toContainText("M");
    await expect(selected.locator("td").first()).toHaveText("88–92");
    await expect(dialog.getByText("قيسي حول أعرض جزء من الصدر.")).toBeVisible();

    // inch is a display choice remembered by this browser only.
    await dialog.getByRole("radio", { name: "إنش" }).click();
    await expect(selected.locator("td").first()).toHaveText("34.6–36.2");
    expect(await customer.evaluate(() => localStorage.getItem("finalpro_size_unit"))).toBe("in");

    // Tab stays inside the window.
    for (let i = 0; i < 8; i += 1) await customer.keyboard.press("Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);

    await customer.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();

    // "ليس مقاسك؟" opens the same guide with the measuring note, no recommendation; unit kept.
    await customer.getByRole("button", { name: "ليس مقاسك؟" }).click();
    await expect(dialog.getByText("هذا الدليل لا يوصي بمقاس آلياً")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "إنش" })).toHaveAttribute("aria-checked", "true");
    await customer.mouse.click(5, 5);
    await expect(dialog).toHaveCount(0);
  });

  test("on a phone the table scrolls inside its frame with sticky header and size column; the page never scrolls sideways", async ({ browser }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const { offerId, slug } = await classifiedOffer(vendorId, branchId, ["S", "M", "L"]);
    const guide = await publishGuide(fixtures.adminToken);
    await prisma.vendorOffer.update({ where: { id: offerId }, data: { sizeGuideId: guide.id } });

    const page = await (await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true })).newPage();
    await page.goto(`/store/${slug}/products/${offerId}`);
    await page.getByRole("button", { name: "دليل المقاسات", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "دليل المقاسات", exact: true });
    await expect(dialog.locator("tbody tr")).toHaveCount(3);
    await expectNoHorizontalOverflow(page);

    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(361);
    const sticky = await dialog.evaluate((d) => ({
      head: getComputedStyle(d.querySelector("thead th")!).position,
      col: getComputedStyle(d.querySelector("tbody th")!).position,
    }));
    expect(sticky).toEqual({ head: "sticky", col: "sticky" });
    await expect(dialog.getByRole("region", { name: "جدول المقاسات" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("in English the window shows the English name, notes and labels; the values stay the same", async ({ browser }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const { offerId, slug } = await classifiedOffer(vendorId, branchId, ["S", "M", "L"]);
    const guide = await publishGuide(fixtures.adminToken);
    await prisma.vendorOffer.update({ where: { id: offerId }, data: { sizeGuideId: guide.id } });

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => localStorage.setItem("finalpro_lang_pref", "en"));
    const page = await context.newPage();
    await page.goto(`/store/${slug}/products/${offerId}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await page.getByRole("button", { name: "Not your size?" }).click();
    const dialog = page.getByRole("dialog", { name: "Size guide", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(guide.nameEn, { exact: true })).toBeVisible();
    await expect(dialog.getByText(guide.name, { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Measure around the fullest part of the chest.")).toBeVisible();
    await expect(dialog.getByText("This guide doesn't recommend a size automatically", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("columnheader", { name: "Chest" })).toBeVisible();
    await expect(dialog.getByRole("columnheader", { name: "Hip" })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "cm" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.locator("tbody tr").nth(1).locator("td").first()).toHaveText("88–92");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Size guide", exact: true })).toBeVisible();
    await context.close();
  });

  test("admin builds, publishes and retires a guide from the editor", async ({ page }) => {
    await loginAs(page, fixtures.adminToken);
    await enterWorkspace(page, fixtures.adminToken, { type: "platform" });
    await page.goto("/admin/size-guides");
    await expect(page.getByRole("heading", { name: "أدلة المقاسات" })).toBeVisible();
    await page.getByLabel("الرمز (حروف إنجليزية صغيرة وأرقام وشرطات)").fill(unique("pw-editor").toLowerCase());
    await page.getByLabel("الاسم بالعربية").fill("دليل من المحرر");
    await page.getByLabel("الاسم بالإنجليزية").fill("Editor guide");
    await page.getByRole("button", { name: "إنشاء مسودة فارغة" }).click();

    await expect(page.getByRole("heading", { name: "دليل من المحرر" })).toBeVisible();
    await page.getByRole("checkbox", { name: "الصدر" }).check();
    for (const size of ["S", "M"]) {
      await page.getByLabel("إضافة مقاس").selectOption(size);
      await page.getByRole("button", { name: "إضافة", exact: true }).click();
    }
    await page.getByLabel("S - الصدر من").fill("84");
    await page.getByLabel("S - الصدر إلى").fill("88");
    await page.getByLabel("M - الصدر من").fill("88");
    await page.getByRole("button", { name: "حفظ المسودة" }).click();
    await expect(page.getByText("تم حفظ المسودة")).toBeVisible();

    // Incomplete: the API refuses to publish and says why, in Arabic.
    await page.getByRole("button", { name: "نشر هذا الإصدار" }).click();
    await expect(page.getByText(/لا يُنشر الدليل قبل تعبئة كل الخانات/)).toBeVisible();

    await page.getByLabel("M - الصدر إلى").fill("92");
    await page.getByRole("button", { name: "حفظ المسودة" }).click();
    await expect(page.getByText("تم حفظ المسودة")).toBeVisible();
    await page.getByRole("button", { name: "نشر هذا الإصدار" }).click();
    await expect(page.getByText("منشور - الإصدار 1")).toBeVisible();
    await expect(page.getByRole("heading", { name: "المنشور حالياً - الإصدار 1" })).toBeVisible();

    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "إيقاف النشر" }).click();
    await expect(page.getByText("تم إيقاف الدليل")).toBeVisible();
    await expect(page.getByText("الإصدار 1 - متقاعد")).toBeVisible();
  });
});
