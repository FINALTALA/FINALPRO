import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { call, createVendorWithBranch, unique } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// PD-5.3: the public Bestseller mark in a real browser - nothing while
// the `bestseller_enabled` flag is off; with it on, the small mark on
// the product page and the discovery cards and the «الأكثر مبيعاً»
// sort on the women listing and the store page - and no sales number
// anywhere on the page. The flag is switched back off at the end.

const FLAG = "bestseller_enabled";
const SCOPE = { category: "COATS", audience: "WOMEN" as const };
let counter = 0;

async function setFlag(adminToken: string, enabled: boolean) {
  const res = await call(`/admin/feature-flags/${FLAG}`, { method: "PUT", token: adminToken, body: { enabled } });
  expect(res.status).toBe(200);
}

async function buyer() {
  const user = await prisma.user.create({
    data: { phone: `+97059${Date.now().toString().slice(-6)}${(counter += 1)}`, passwordHash: "x", phoneVerifiedAt: new Date() },
  });
  return prisma.customerProfile.create({ data: { userId: user.id } });
}

/**
 * TB-32: the ranking is platform-wide per (category, audience) and keeps
 * every sale of the last 30 days, so in a database that earlier runs
 * already used, their products (same sales, sold earlier - ties go to the
 * earliest first sale) used to outrank this run's. The test now reads the
 * highest units already ranked in its scope (after a fresh recompute
 * through the API) and sells its own products strictly MORE than that, in
 * the same order - every assertion below is unchanged.
 */
async function unitsAlreadyRanked(adminToken: string): Promise<number> {
  const run = await call("/admin/sales-rank/recompute", { method: "POST", token: adminToken, idempotencyKey: unique("rank") });
  expect(run.status).toBe(200);
  const top = await prisma.salesRankSnapshot.aggregate({
    where: { scope: "CANONICAL", categoryCode: SCOPE.category, audience: SCOPE.audience },
    _max: { units: true },
  });
  return top._max.units ?? 0;
}

/** A classified offer matched to its own canonical product, sold `units` times to `customers` buyers
 * (one completed order per buyer, the units spread over their quantities). */
async function soldProduct(vendorId: string, branchId: string, units: number, customers: number, name: string) {
  const brand = await prisma.brand.create({ data: { name: unique("Brand"), normalizedName: unique("b") } });
  const category = await prisma.category.create({ data: { nameAr: unique("فئة"), nameEn: unique("C") } });
  const product = await prisma.canonicalProduct.create({
    data: { brandId: brand.id, categoryId: category.id, modelName: unique("M"), canonicalNameAr: name, status: "PUBLISHED" },
  });
  const cv = await prisma.canonicalProductVariant.create({
    data: { canonicalProductId: product.id, structuralAttributes: { n: unique("v") }, platformProductBarcode: unique("pb") },
  });
  const offer = await prisma.vendorOffer.create({
    data: { vendorId, titleAr: name, titleEn: name, status: "ACTIVE", canonicalProductId: product.id, taxonomyVersion: 1, requiresTaxonomy: true },
  });
  await prisma.vendorOfferAudience.create({ data: { vendorId, vendorOfferId: offer.id, audience: SCOPE.audience } });
  await prisma.vendorOfferCategory.create({ data: { vendorId, vendorOfferId: offer.id, categoryCode: SCOPE.category } });
  const variant = await prisma.offerVariant.create({
    data: {
      vendorId,
      vendorOfferId: offer.id,
      sellerSku: unique("sku"),
      storeInventoryBarcode: unique("sib"),
      basePrice: 120,
      isCombination: true,
      colorCode: "BLACK",
      canonicalVariantId: cv.id,
    },
  });
  await prisma.branchStock.create({ data: { vendorId, branchId, offerVariantId: variant.id, quantity: 40 } });
  await prisma.offerVariantMedia.create({
    data: { vendorId, offerVariantId: variant.id, url: "https://example.com/coat.jpg", kind: "PRIMARY", mediaType: "IMAGE", sortOrder: 0 },
  });
  for (let i = 0; i < customers; i++) {
    const quantity = Math.floor(units / customers) + (i < units % customers ? 1 : 0);
    const co = await prisma.customerOrder.create({ data: { customerId: (await buyer()).id } });
    const bo = await prisma.branchOrder.create({
      data: {
        customerOrderId: co.id,
        vendorId,
        branchId,
        fulfilmentMethod: "PICKUP",
        paymentMethod: "COD",
        status: "COMPLETED",
        subtotal: 120 * quantity,
        total: 120 * quantity,
        pickupCode: String(300000 + (counter += 1)),
        pickedUpAt: new Date(Date.now() - 86_400_000),
      },
    });
    await prisma.branchOrderItem.create({
      data: { vendorId, branchOrderId: bo.id, offerVariantId: variant.id, quantity, unitPrice: 120 },
    });
  }
  return { productId: product.id, offerId: offer.id, name };
}

test.describe("PD-5.3: Bestseller mark and sort", () => {
  // One shared catalogue and one global flag: these tests must not run in
  // parallel workers (one would switch the flag off under the other).
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let slug = "";
  let top: Awaited<ReturnType<typeof soldProduct>>[] = [];
  let below: Awaited<ReturnType<typeof soldProduct>>;

  test.beforeAll(async () => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    top = [];
    const base = await unitsAlreadyRanked(fixtures.adminToken);
    for (const [i, [units, customers]] of ([[9, 4], [8, 3], [7, 3], [6, 3]] as const).entries()) {
      top.push(await soldProduct(vendorId, branchId, base + units, customers, `معطف ${i + 1} ${unique("x").slice(-5)}`));
    }
    below = await soldProduct(vendorId, branchId, 4, 4, `معطف أقل ${unique("x").slice(-5)}`);
    const run = await call("/admin/sales-rank/recompute", { method: "POST", token: fixtures.adminToken, idempotencyKey: unique("rank") });
    expect(run.status).toBe(200);
  });

  test.afterAll(async () => {
    await setFlag(fixtures.adminToken, false);
  });

  test("flag off: no mark and no «الأكثر مبيعاً» sort anywhere", async ({ page }) => {
    await setFlag(fixtures.adminToken, false);
    await page.goto(`/store/${slug}/products/${top[0].offerId}`);
    await expect(page.getByRole("heading", { name: top[0].name })).toBeVisible();
    await expect(page.locator(".bestseller-badge")).toHaveCount(0);

    await page.goto(`/women?category=${SCOPE.category}`);
    await expect(page.locator(`[data-product-id="${top[0].productId}"]`)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".bestseller-badge")).toHaveCount(0);
    await page.locator(".women-filter-toggle").click();
    await expect(page.getByRole("button", { name: "الأحدث", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "الأكثر مبيعاً" })).toHaveCount(0);
  });

  test("flag on: the product page and discovery cards show the quiet mark; the sort lists bestsellers first; no number is shown", async ({ page }) => {
    await setFlag(fixtures.adminToken, true);

    await page.goto(`/store/${slug}/products/${top[0].offerId}`);
    const badge = page.locator(".pdp-bestseller .bestseller-badge");
    await expect(badge).toBeVisible({ timeout: 30_000 });
    await expect(badge).toContainText("الأكثر مبيعاً");
    await expect(badge).toContainText("معاطف");
    // TB-7: the «قد يعجبك أيضاً» section loads after the product itself and
    // rightly carries the top products' own marks - wait for it, then check
    // only the main product's mark, never every mark on the page.
    const similarResponse = page.waitForResponse(
      (r) => r.url().includes("/discovery/all?") && r.url().includes(`category=${SCOPE.category}`) && r.ok(),
    );
    await page.goto(`/store/${slug}/products/${below.offerId}`);
    await expect(page.getByRole("heading", { name: below.name })).toBeVisible();
    await similarResponse;
    const similar = page.locator("section.pdp-similar");
    await expect(similar).toBeVisible();
    for (const p of top) {
      await expect(similar.locator(`[data-product-id="${p.productId}"] .bestseller-badge`)).toBeVisible();
    }
    await expect(page.locator(".pdp-bestseller")).toHaveCount(0);

    // The women listing, sorted «الأكثر مبيعاً».
    await page.goto(`/women?category=${SCOPE.category}`);
    await page.locator(".women-filter-toggle").click();
    await page.getByRole("button", { name: "الأكثر مبيعاً" }).click();
    await page.getByRole("button", { name: "عرض النتائج" }).click();
    await expect(page).toHaveURL(/sort=bestseller/);
    const cards = page.locator("[data-testid='product-card']");
    await expect(cards.first()).toHaveAttribute("data-product-id", top[0].productId, { timeout: 30_000 });
    const firstFour = await cards.evaluateAll((els) => els.slice(0, 4).map((e) => e.getAttribute("data-product-id")));
    expect(firstFour).toEqual(top.map((p) => p.productId));
    for (const p of top) {
      await expect(page.locator(`[data-product-id="${p.productId}"] .bestseller-badge`)).toBeVisible();
    }
    await expect(page.locator(`[data-product-id="${below.productId}"] .bestseller-badge`)).toHaveCount(0);
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/\d+\s*(وحدة|وحدات|عميل|عملاء)/);

    // The store page sort.
    const storeResponse = page.waitForResponse((r) => r.url().includes(`/storefronts/${slug}/products`) && r.url().includes("sort=bestseller"));
    await page.goto(`/store/${slug}`);
    await page.locator(".store-filter-toggle").first().click();
    await page.getByRole("button", { name: "الأكثر مبيعاً" }).click();
    await page.getByRole("button", { name: "عرض النتائج" }).click();
    const body = await (await storeResponse).json();
    expect(body.items.slice(0, 4).map((i: { id: string }) => i.id)).toEqual(top.map((p) => p.offerId));
    expect(JSON.stringify(body)).not.toMatch(/"units"|"customers"|qualified_rank|"rank"/);
  });

  test("on a phone the mark stays inside the card image and the page doesn't scroll sideways", async ({ browser }) => {
    await setFlag(fixtures.adminToken, true);
    const page = await (await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true })).newPage();
    await page.goto(`/women?category=${SCOPE.category}`);
    const card = page.locator(`[data-product-id="${top[0].productId}"]`);
    const mark = card.locator(".bestseller-badge");
    await expect(mark).toBeVisible({ timeout: 30_000 });
    const [m, c] = await Promise.all([mark.boundingBox(), card.boundingBox()]);
    expect(m!.x).toBeGreaterThanOrEqual(c!.x);
    expect(m!.x + m!.width).toBeLessThanOrEqual(c!.x + c!.width + 1);
    await expectNoHorizontalOverflow(page);
  });
});
