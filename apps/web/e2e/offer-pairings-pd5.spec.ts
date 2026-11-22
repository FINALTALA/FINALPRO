import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { createVendorWithBranch, unique } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// PD-5.4 «نسّقي معه» in a real browser: the owner picks pairings on the
// offer page; the product page shows them after the details accordion as
// a 2-column grid of the store's own cards - only what can be bought for
// the chosen zone, and nothing at all below two.

async function plainOffer(vendorId: string, branchId: string, title: string, stock = 5) {
  const offer = await prisma.vendorOffer.create({ data: { vendorId, titleAr: title, titleEn: title, status: "ACTIVE" } });
  const variant = await prisma.offerVariant.create({
    data: { vendorId, vendorOfferId: offer.id, sellerSku: unique("sku"), storeInventoryBarcode: unique("sib"), basePrice: 90 },
  });
  if (stock > 0) await prisma.branchStock.create({ data: { vendorId, branchId, offerVariantId: variant.id, quantity: stock } });
  return offer.id;
}

test.describe("PD-5.4: «نسّقي معه»", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let slug = "";
  let main = "";
  let names: Record<string, string> = {};
  let ids: Record<string, string> = {};

  test.beforeAll(async () => {
    const v = await createVendorWithBranch(fixtures.ownerToken);
    vendorId = v.vendorId;
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    // An online-only branch that delivers to the West Bank tomorrow.
    const online = await prisma.storeBranch.create({
      data: { vendorId, name: "مستودع أونلاين", isPhysical: false, verificationStatus: "APPROVED" },
    });
    const weekday = new Date(
      `${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hebron" }).format(new Date(Date.now() + 86_400_000))}T00:00:00Z`,
    ).getUTCDay();
    await prisma.deliveryWindow.create({ data: { vendorId, branchId: online.id, dayOfWeek: weekday, startMinute: 720, endMinute: 840, capacity: 5 } });
    await prisma.vendorDeliveryZone.upsert({
      where: { vendorId_region: { vendorId, region: "WEST_BANK" } },
      create: { vendorId, region: "WEST_BANK", enabled: true, fee: 10 },
      update: { enabled: true, fee: 10 },
    });
    const tag = unique("t").slice(-5);
    names = { main: `فستان سهرة ${tag}`, bag: `حقيبة سهرة ${tag}`, shoes: `حذاء سهرة ${tag}`, scarf: `وشاح أونلاين ${tag}`, gone: `قلادة نفدت ${tag}` };
    main = await plainOffer(vendorId, v.branchId, names.main);
    ids = {
      bag: await plainOffer(vendorId, v.branchId, names.bag),
      shoes: await plainOffer(vendorId, v.branchId, names.shoes),
      scarf: await plainOffer(vendorId, online.id, names.scarf),
      gone: await plainOffer(vendorId, v.branchId, names.gone, 0),
    };
  });

  test("the owner picks pairings on the offer page; the product page shows the eligible ones as a 2-column section", async ({ page }) => {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers/${main}`);
    const panel = page.locator(".owner-pairings");
    await expect(panel.getByRole("heading", { name: "نسّقي معه" })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("لا توجد منتجات منسّقة بعد.")).toBeVisible();
    for (const key of ["bag", "gone", "scarf", "shoes"]) {
      await panel.getByLabel("إضافة منتج للتنسيق").selectOption(ids[key]);
      await panel.getByRole("button", { name: "إضافة", exact: true }).click();
    }
    // The main offer itself is never offered as a choice.
    await expect(panel.getByLabel("إضافة منتج للتنسيق").locator(`option[value="${main}"]`)).toHaveCount(0);
    await panel.getByRole("button", { name: "حفظ التنسيق" }).click();
    await expect(panel.getByText("تم حفظ التنسيق")).toBeVisible();

    await page.goto(`/store/${slug}/products/${main}`);
    const section = page.locator(".pdp-pairings");
    await expect(section.getByRole("heading", { name: "نسّقي معه" })).toBeVisible({ timeout: 30_000 });
    // Sold out is hidden; the delivery-only scarf counts while no zone is chosen.
    const titles = () => section.locator(".product-card-name").allInnerTexts();
    await expect(section.locator(".product-card")).toHaveCount(3);
    expect(await titles()).toEqual([names.bag, names.scarf, names.shoes]);
    // It comes after the details accordion, in the buy column.
    const after = await page.evaluate(() => {
      const sections = document.querySelector(".pdp-sections");
      const pairings = document.querySelector(".pdp-pairings");
      return !!sections && !!pairings && !!(sections.compareDocumentPosition(pairings) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(after).toBe(true);
    // A card opens that store's own product page.
    await expect(section.locator(".store-card-link").first()).toHaveAttribute("href", `/store/${slug}/products/${ids.bag}`);

    // A zone the store doesn't deliver to drops the delivery-only scarf.
    await page.getByLabel("منطقة التوصيل").selectOption("INSIDE");
    await expect(section.locator(".product-card")).toHaveCount(2);
    expect(await titles()).toEqual([names.bag, names.shoes]);
  });

  test("on a phone it's a 2-column grid with no sideways scroll; below two eligible picks there is no section", async ({ browser }) => {
    const phone = await (await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true })).newPage();
    await phone.goto(`/store/${slug}/products/${main}`);
    const cards = phone.locator(".pdp-pairings .product-card");
    await expect(cards).toHaveCount(3, { timeout: 30_000 });
    const [a, b] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()]);
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(2); // side by side
    await expectNoHorizontalOverflow(phone);
    // Reviews / later sections come after it on the phone too.
    await phone.close();

    // Only one eligible pick left -> no section, no empty box.
    await prisma.branchStock.updateMany({ where: { offerVariant: { vendorOfferId: { in: [ids.shoes, ids.scarf] } } }, data: { quantity: 0 } });
    const page = await (await browser.newContext()).newPage();
    await page.goto(`/store/${slug}/products/${main}`);
    await expect(page.getByRole("heading", { name: names.main })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".pdp-pairings")).toHaveCount(0);
  });
});
