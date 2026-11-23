import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { call, createVendorWithBranch, setDeliveryZoneFee, unique, uniquePhone } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// «الصفحة الرئيسية المرنة للمتجر» (2026-11-20):
//  - a store without a layout keeps its page exactly as before (the
//    department chips in the identity, no browse heading, no blocks);
//  - the owner designs in the ONE management window (its tile; list ->
//    block -> product picker, the window's one «رجوع»), uploads images
//    (size warnings, never refused), picks products, orders,
//    hides, deletes; the draft autosaves; «معاينة» renders the draft with the
//    shoppers' own component (desktop / phone); nothing shows to shoppers
//    until «نشر»;
//  - shoppers: «الكل» = identity -> «استكشفي التصنيفات» -> blocks -> «معلومات
//    المتجر» -> «تصفّحي المنتجات» (search, Filter, smart filters, collections)
//    -> the grid; a department (with or without a category), a search or a
//    filter = the product browsing only (no blocks, no store information),
//    «استكشفي التصنيفات» stays; «الكل» brings the whole home page back;
//    hidden blocks and sold-out picks never show; the carousel;
//  - «فئات المتجر» is retired: not offered any more, and a saved one is kept
//    but never shown (the fixed categories never appear twice);
//  - «معلومات المتجر»: the end of the «الكل» page (after the blocks, before
//    «تصفّحي المنتجات»); everything it showed before (full weekly hours or
//    «not set», closures, every zone with fee and minimum, return mode,
//    period and fees) in one section of three columns; in the preview;
//  - English / LTR, a phone, accessibility (axe), the employee, and two tabs
//    of the owner (a stale tab is told, never overwrites).
// store_home_blocks_enabled is one global row: this spec turns it on and
// back off; do not run it in parallel with another spec that toggles it.

const localRequire = createRequire(__filename);
const sharp = localRequire("sharp") as (input: object) => { png(): { toBuffer(): Promise<Buffer> } };

const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

async function setFlag(enabled: boolean) {
  await prisma.featureFlag.upsert({
    where: { key: "store_home_blocks_enabled" },
    create: { key: "store_home_blocks_enabled", enabled, description: "test" },
    update: { enabled },
  });
}

/** The home layout row (raw SQL: the shared Playwright client predates this table). */
async function layoutRow(vendorId: string) {
  const rows = await prisma.$queryRaw<{ draft: unknown; published: unknown }[]>`SELECT draft, published FROM store_home_layouts WHERE "vendorId" = ${vendorId}`;
  if (!rows[0]) throw new Error("no home layout row");
  return rows[0];
}

async function account() {
  const phone = uniquePhone();
  const user = await prisma.user.create({
    data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" },
  });
  await prisma.customerProfile.create({ data: { userId: user.id } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: "a-strong-password" } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, token: res.body.session_token };
}

let seq = 0;
/** A classified ACTIVE product (audience, category, one colour x size version) with `qty` in the branch. */
async function product(vendorId: string, branchId: string, title: string, category: string, qty: number) {
  seq += 1;
  const offer = await prisma.vendorOffer.create({
    data: { vendorId, titleAr: title, titleEn: `Item ${seq}`, status: "DRAFT", taxonomyVersion: 1, requiresTaxonomy: true },
  });
  await prisma.vendorOfferAudience.create({ data: { vendorId, vendorOfferId: offer.id, audience: "WOMEN" } });
  await prisma.vendorOfferCategory.create({ data: { vendorId, vendorOfferId: offer.id, categoryCode: category } });
  const variant = await prisma.offerVariant.create({
    data: {
      vendorId,
      vendorOfferId: offer.id,
      sellerSku: unique(`home-sku-${seq}`),
      storeInventoryBarcode: unique(`home-sib-${seq}`),
      basePrice: 100 + seq,
      isCombination: true,
      colorCode: "BLACK",
      sizeCode: "M",
    },
  });
  await prisma.branchStock.create({ data: { vendorId, branchId, offerVariantId: variant.id, quantity: qty } });
  await prisma.vendorOffer.update({ where: { id: offer.id }, data: { status: "ACTIVE" } });
  return offer.id;
}

/** A real image of the given size (the server reads its size for the owner's warnings). */
async function image(width: number, height: number, colour: string) {
  const buffer = await sharp({ create: { width, height, channels: 3, background: colour } }).png().toBuffer();
  return { name: `img-${width}x${height}.png`, mimeType: "image/png", buffer };
}

test.describe("The store's flexible home page", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchId = "";
  let slug = "";
  const p: Record<string, string> = {};

  test.beforeAll(async () => {
    await setFlag(true);
    ({ vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken));
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    p.velvet = await product(vendorId, branchId, "فستان سهرة مخملي", "DRESSES_WOMEN", 5);
    p.satin = await product(vendorId, branchId, "فستان ساتان", "DRESSES_WOMEN", 4);
    p.soldOut = await product(vendorId, branchId, "فستان نافد", "DRESSES_WOMEN", 0);
    p.blouse = await product(vendorId, branchId, "بلوزة حرير", "TOPS", 6);
    // the store's own categories under «نساء» («استكشفي التصنيفات»)
    await prisma.storefrontCategory.create({ data: { vendorId, audience: "WOMEN", categoryCode: "DRESSES_WOMEN", sortOrder: 0 } });
    await prisma.storefrontCategory.create({ data: { vendorId, audience: "WOMEN", categoryCode: "TOPS", sortOrder: 1 } });
    // «معلومات المتجر»: real data through the owner's own screens' API (every day 10:00-22:00, one delivery zone)
    const hours = await call(`/vendors/${vendorId}/branches/${branchId}/operating-hours`, {
      method: "PUT",
      token: fixtures.ownerToken,
      body: { hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, open_minute: 600, close_minute: 1320 })) },
    });
    if (hours.status !== 200) throw new Error(`operating hours: ${hours.status} ${JSON.stringify(hours.body)}`);
    await setDeliveryZoneFee(fixtures.ownerToken, vendorId, "WEST_BANK", 15);
    await setDeliveryZoneFee(fixtures.ownerToken, vendorId, "JERUSALEM", 0);
    // a second branch without opening hours (its line says so)
    await prisma.storeBranch.create({ data: { vendorId, name: "فرع بلا ساعات", isPhysical: true, verificationStatus: "APPROVED" } });
    // a visible store collection: its chip joins the smart filters (the phone width check covers that row)
    const section = unique("sec");
    await prisma.$executeRaw`INSERT INTO store_sections (id, "vendorId", name, "isVisible", "sortOrder") VALUES (${section}, ${vendorId}, 'فساتين السهرة المختارة', true, 0)`;
    await prisma.$executeRaw`INSERT INTO store_section_offers (id, "vendorId", "sectionId", "offerId", "sortOrder") VALUES (${unique("so")}, ${vendorId}, ${section}, ${p.velvet}, 0)`;
  });
  test.afterAll(async () => {
    await setFlag(false);
  });

  async function openStore(page: Page, token?: string) {
    if (token) {
      await loginAs(page, token);
      await enterWorkspace(page, token, { type: "vendor", vendor_id: vendorId });
    }
    await page.goto(`/store/${slug}`);
    await expect(page.locator(".store-products")).toBeVisible({ timeout: 30_000 });
  }
  async function openDesigner(page: Page): Promise<FrameLocator> {
    await openStore(page, fixtures.ownerToken);
    await page.locator(".store-manage-button").click();
    // 2026-11-23: one card «صفحتي»; the designer is its «الرئيسية» action, in the same window
    const tile = page.getByTestId("management-tile-storefront");
    await expect(tile).toContainText("صفحتي", { timeout: 30_000 });
    await tile.click();
    await expect(page.getByTestId("management-frame-title")).toHaveText("صفحتي", { timeout: 30_000 });
    const frame = page.frameLocator(".store-management-detail-frame");
    await frame.getByTestId("mypage-open-home").click({ timeout: 30_000 });
    await expect(page.getByTestId("management-frame-title")).toHaveText("تصميم الصفحة الرئيسية", { timeout: 30_000 });
    await expect(frame.getByTestId("home-designer")).toHaveAttribute("data-view", "list", { timeout: 30_000 });
    return frame;
  }
  /** On a narrow designer «معاينة» is a tab; on a wide one the live preview is always beside. */
  async function showPreview(frame: FrameLocator) {
    const tab = frame.getByTestId("home-tab-preview");
    if (await tab.isVisible()) await tab.click();
    await expect(frame.getByTestId("home-preview")).toBeVisible();
  }
  async function showEdit(frame: FrameLocator) {
    const tab = frame.getByTestId("home-tab-edit");
    if (await tab.isVisible()) await tab.click();
  }
  async function saved(frame: FrameLocator) {
    await expect(frame.getByTestId("home-save-state")).not.toHaveText(/جارٍ الحفظ/, { timeout: 30_000 });
  }

  test("a store without a home layout keeps its page exactly as before; the owner gets the tile and a quiet invitation only while the flag is on", async ({ page }) => {
    await openStore(page);
    await expect(page.getByTestId("store-home")).toHaveCount(0);
    await expect(page.getByText("تصفّحي المنتجات")).toHaveCount(0);
    // the department chips stay in the store's identity
    await expect(page.locator(".store-hero .store-categories")).toBeVisible();
    await expect(page.getByTestId("store-home-prompt")).toHaveCount(0);

    const owner = await page.context().browser()!.newPage();
    await openStore(owner, fixtures.ownerToken);
    await expect(owner.getByTestId("store-home-prompt")).toBeVisible();
    await setFlag(false);
    try {
      await owner.reload();
      await expect(owner.locator(".store-products")).toBeVisible({ timeout: 30_000 });
      await expect(owner.getByTestId("store-home-prompt")).toHaveCount(0);
      await owner.locator(".store-manage-button").click();
      await expect(owner.locator(".store-management-grid")).toBeVisible({ timeout: 30_000 });
      await expect(owner.getByTestId("management-tile-storefront/home")).toHaveCount(0);
      // «صفحتي» stays; its «الرئيسية» action follows the flag like the old card did
      await owner.getByTestId("management-tile-storefront").click();
      const mine = owner.frameLocator(".store-management-detail-frame");
      await expect(mine.locator(".storefront-settings-form")).toBeVisible({ timeout: 30_000 });
      await expect(mine.getByTestId("mypage-open-home")).toHaveCount(0);
    } finally {
      await setFlag(true);
      await owner.close();
    }
  });

  test("the owner designs in the one management window: hero with two slides (size warnings, never refused), picked products, new arrivals (no «فئات المتجر» offered), a text block; order, hide, delete; autosaved draft; preview desktop/phone; nothing public until «نشر»", async ({ page }) => {
    const frame = await openDesigner(page);
    await expect(frame.getByTestId("home-tab-edit")).toHaveAttribute("aria-selected", "true");
    // the designer sits on «صفحتي»: the window's «رجوع» names it
    await expect(page.getByTestId("management-frame-back")).toHaveAccessibleName(/صفحتي/);

    // Hero: the first image is uploaded when the block is added
    await frame.getByTestId("home-add").click();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), frame.getByTestId("home-add-hero").click()]);
    await chooser.setFiles(await image(1920, 640, "#8a3b48"));
    await expect(frame.getByTestId("home-designer")).toHaveAttribute("data-view", "block", { timeout: 30_000 });
    // a screen inside the window: its title and the one «رجوع»
    await expect(page.getByTestId("management-frame-title")).toHaveText("Hero");
    await expect(page.getByTestId("management-frame-back")).toBeVisible();
    await expect(page.locator(".store-management-detail-panel")).toHaveCount(1);
    await expect(frame.getByTestId("hero-image-0-warnings")).toHaveCount(0);
    await frame.getByTestId("hero-title-0-ar").fill("موسم السهرة");
    await frame.getByTestId("hero-title-0-en").fill("Evening season");
    await frame.getByTestId("hero-button-0-ar").fill("تسوقي الآن");
    await frame.getByTestId("hero-target-0-kind").selectOption("products");
    // the phone image: a small, wrong-shaped one is warned about, not refused
    await frame.getByTestId("hero-image-phone-0-input").setInputFiles(await image(600, 600, "#2a3b52"));
    await expect(frame.getByTestId("hero-image-phone-0-warnings")).toContainText("أصغر من المقترح");
    await expect(frame.getByTestId("hero-image-phone-0-warnings")).toContainText("سيُقص جزء منها");
    // a second slide, its button to a collection-less category
    await frame.getByTestId("hero-add-slide-input").setInputFiles(await image(1920, 640, "#1f3557"));
    await expect(frame.getByTestId("hero-slide-1")).toBeVisible({ timeout: 30_000 });
    await frame.getByTestId("hero-title-1-ar").fill("بلايز الموسم");
    await frame.getByTestId("hero-button-1-ar").fill("شاهدي البلايز");
    await frame.getByTestId("hero-target-1-kind").selectOption("category");
    await frame.getByTestId("hero-target-1").getByLabel("اختاري الفئة").selectOption("WOMEN/TOPS");
    await saved(frame);
    await page.getByTestId("management-frame-back").click();
    await expect(frame.getByTestId("home-designer")).toHaveAttribute("data-view", "list");

    // Picked products: the picker is a screen of the same window
    await frame.getByTestId("home-add").click();
    await frame.getByTestId("home-add-products").click();
    await frame.getByTestId("products-pick").click();
    await expect(frame.getByTestId("home-designer")).toHaveAttribute("data-view", "pick");
    await expect(page.getByTestId("management-frame-title")).toHaveText("اختيار المنتجات");
    for (const id of [p.velvet, p.soldOut, p.satin]) await frame.getByTestId(`home-pick-${id}`).check();
    await expect(frame.locator(`[data-testid="home-pick-${p.soldOut}"]`).locator("xpath=..")).toContainText("نفد — لا يظهر");
    await frame.getByTestId("home-picker-done").click();
    await expect(frame.getByTestId("home-designer")).toHaveAttribute("data-view", "block");
    await expect(frame.getByTestId("products-chosen").locator("li")).toHaveCount(3);
    await expect(frame.getByTestId("products-chosen-1-status")).toHaveText("نفد — لا يظهر");
    await page.getByTestId("management-frame-back").click();

    // «فئات المتجر» is not offered (the categories are in «استكشفي التصنيفات»); new arrivals instead
    await frame.getByTestId("home-add").click();
    // eight types to add (P1: «بطاقات التصنيفات», P3: «لوحة ترويجية»), plus «مقطع مميّز» shown as a look only (not addable)
    await expect(frame.locator(".shd-types button.shd-type")).toHaveCount(8);
    await expect(frame.getByTestId("home-add-soon")).toHaveCount(1);
    await expect(frame.getByTestId("home-add-categories")).toHaveCount(0);
    await frame.getByTestId("home-add-auto_products").click();
    await page.getByTestId("management-frame-back").click();

    // A text block, then hidden
    await frame.getByTestId("home-add").click();
    await frame.getByTestId("home-add-text").click();
    await frame.getByTestId("text-title-ar").fill("نص مخفي للتجربة");
    await page.getByTestId("management-frame-back").click();

    // order: new arrivals above the products; the text block hidden; an extra block deleted
    await expect(frame.locator(".shd-list > li")).toHaveCount(4);
    await frame.getByTestId("home-row-2-up").click();
    await expect(frame.getByTestId("home-row-1")).toHaveAttribute("data-type", "auto_products");
    await frame.getByTestId("home-row-3-toggle").click();
    await frame.getByTestId("home-add").click();
    await frame.getByTestId("home-add-auto_products").click();
    await page.getByTestId("management-frame-back").click();
    await frame.getByTestId("home-row-4-delete").click();
    await frame.getByRole("button", { name: "حذف البلوك" }).click();
    await expect(frame.locator(".shd-list > li")).toHaveCount(4);
    await saved(frame);
    await expect(frame.getByTestId("home-row-3-state")).toHaveText("مخفي");
    await expect(frame.getByTestId("home-save-state")).toHaveText("لم تُنشر بعد");

    // the draft is saved on the server, in that order
    const row = await layoutRow(vendorId);
    expect((row.draft as { blocks: { type: string; visible: boolean }[] }).blocks.map((b) => [b.type, b.visible])).toEqual([
      ["hero", true],
      ["auto_products", true],
      ["products", true],
      ["text", false],
    ]);
    expect(row.published).toBeNull();
    // ...and shoppers see nothing of it yet
    const before = await call<{ blocks: unknown[] }>(`/storefronts/${slug}/home`);
    expect(before.body.blocks).toEqual([]);

    // preview: the shoppers' own component, desktop and phone
    await showPreview(frame);
    const preview = frame.getByTestId("home-preview");
    await expect(preview.getByTestId("store-home")).toBeVisible({ timeout: 30_000 });
    await expect(preview.locator(".sh-hero-title").first()).toHaveText("موسم السهرة");
    await expect(preview.locator('[data-block="products"] .product-card')).toHaveCount(2);
    await expect(preview.getByText("نص مخفي للتجربة")).toHaveCount(0);
    // the home area ends with «معلومات المتجر», as shoppers will see it
    await expect(preview.getByTestId("store-info")).toBeVisible({ timeout: 30_000 });
    await frame.getByTestId("home-device-phone").click();
    await expect(preview).toHaveClass(/is-phone/);
    const box = await preview.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(400);
    // the phone layout of the blocks themselves (container queries): a portrait hero
    const slide = await preview.locator(".sh-hero-slide").first().boundingBox();
    expect(slide!.height).toBeGreaterThan(slide!.width);

    await showEdit(frame);
    await frame.getByTestId("home-publish").click();
    await expect(frame.getByTestId("home-toast")).toHaveText("نُشرت الصفحة الرئيسية. تراها المتسوقات الآن.", { timeout: 30_000 });
    await expect(frame.getByTestId("home-save-state")).toHaveText("منشورة — لا تغييرات جديدة");
    const audit = await prisma.auditLog.count({ where: { entityId: vendorId, action: "store_home.published" } });
    expect(audit).toBe(1);
  });

  test("shoppers: identity, «استكشفي التصنيفات», the blocks, then «تصفّحي المنتجات» with the browsing tools; a department (or a category, a search) shows the product browsing only - no blocks, no store information - and «الكل» brings the home page back; hidden blocks and sold-out picks never show", async ({ page }) => {
    await openStore(page);
    const home = page.getByTestId("store-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    // the order on the page
    const y = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
    const ys = [await y(".store-identity"), await y(".store-hero .store-categories"), await y('[data-testid="store-home"]'), await y('[data-testid="store-info"]'), await y(".store-products-heading")];
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    // «استكشفي التصنيفات» only up there - never inside «تصفّحي المنتجات», never twice
    await expect(page.locator(".store-browse .store-categories")).toHaveCount(0);
    await expect(page.locator(".store-categories:not(.store-sticky-bar *)")).toHaveCount(1);
    await expect(page.locator('[data-block="categories"]')).toHaveCount(0);
    // no «تصفّحي المنتجات» heading or line; «الكل» has no audience title either
    await expect(page.getByText("تصفّحي المنتجات")).toHaveCount(0);
    await expect(page.getByText("ابحثي وفلتري كل منتجات المتجر.")).toHaveCount(0);
    await expect(page.getByTestId("store-audience-title")).toHaveCount(0);
    // what is shown
    await expect(home.locator(".sh-hero-slide")).toHaveCount(2);
    await expect(home.getByText("نص مخفي للتجربة")).toHaveCount(0);
    const cards = home.locator('[data-block="products"] .product-card');
    await expect(cards).toHaveCount(2);
    await expect(home.locator('[data-block="products"]')).not.toContainText("فستان نافد");

    // the carousel: buttons, dots, keyboard (RTL: ArrowLeft is «next»), inactive slides hidden from assistive tech
    const hero = home.locator('[data-block="hero"]');
    await expect(hero).toHaveAttribute("aria-roledescription", "carousel");
    await expect(hero.locator(".sh-hero-slide").nth(1)).toHaveAttribute("aria-hidden", "true");
    await page.getByTestId("home-hero-next").click();
    await expect(hero.locator(".sh-hero-dot").nth(1)).toHaveAttribute("aria-current", "true");
    await expect(hero.locator(".sh-hero-slide").nth(1)).toHaveAttribute("data-active", "true");
    await hero.locator(".sh-hero-dot").nth(1).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(hero.locator(".sh-hero-dot").nth(0)).toHaveAttribute("aria-current", "true");

    // «تسوقي الآن» -> the products section (no filter: the blocks stay)
    await hero.locator(".sh-hero-slide").nth(0).getByTestId("home-hero-button").click();
    await expect(page.locator(".store-products-heading")).toBeInViewport({ timeout: 10_000 });
    await expect(home).toBeVisible();

    // a department: the product browsing only - its categories open in «استكشفي التصنيفات», no home blocks, no store information
    const explore = page.locator(".store-hero .store-categories");
    await explore.getByRole("tab", { name: /نساء/ }).click();
    await expect(explore.locator(".store-subcategory-row")).toBeVisible();
    await expect(page.getByTestId("store-home")).toHaveCount(0);
    await expect(page.getByTestId("store-info")).toHaveCount(0);
    await expect(page.locator(".store-hero .store-categories")).toBeVisible();
    // the audience page's own quiet title: «نساء» (no count); the tools keep their place
    const audience = page.getByTestId("store-audience-title");
    await expect(audience.locator("h2")).toHaveText("نساء");
    await expect(page.getByTestId("store-audience-count")).toHaveCount(0);
    await expect(page.locator(".store-products-heading h2")).toHaveCount(0);
    await expect(page.locator(".store-products-heading .store-search")).toBeVisible();
    await expect(page.locator(".store-products-heading .store-filter-toggle")).toBeVisible();
    await expect(page.locator(".store-product-grid .product-card").first()).toBeVisible({ timeout: 30_000 });
    // a category: the filter applies, the blocks step aside, the page is at the products
    await explore.locator(".store-subcategory-row").getByRole("tab", { name: /بلايز/ }).click();
    await expect(page.getByTestId("store-home")).toHaveCount(0);
    // a category: «نساء · بلايز وتوبات» with the count
    await expect(page.getByTestId("store-audience-title").locator("h2")).toHaveText("نساء · بلايز وتوبات", { timeout: 30_000 });
    await expect(page.getByTestId("store-audience-count")).toHaveText("1 منتج");
    await expect(page.locator(".store-product-grid .product-card")).toHaveCount(1);
    await expect(page.locator(".store-product-grid .product-card")).toContainText("بلوزة حرير");
    await expect(page.locator(".store-products-heading")).toBeInViewport();
    // back to «الكل»: the whole home page again
    await explore.locator(".store-department-chips").getByRole("tab").first().click();
    await expect(page.getByTestId("store-home")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("store-info")).toBeVisible();
    await expect(explore.locator(".store-subcategory-row")).toHaveCount(0);
    // the second slide's button: a category destination applies the same filter
    await page.getByTestId("home-hero-next").click();
    await home.locator(".sh-hero-slide").nth(1).getByTestId("home-hero-button").click();
    await expect(page.getByTestId("store-home")).toHaveCount(0);
    await expect(page.locator(".store-product-grid .product-card")).toHaveCount(1, { timeout: 30_000 });
    await explore.locator(".store-department-chips").getByRole("tab").first().click();
    await expect(page.getByTestId("store-home")).toBeVisible({ timeout: 30_000 });
    // searching also steps them aside
    await page.locator(".store-search").click();
    await page.locator(".store-search input").fill("ساتان");
    await expect(page.getByTestId("store-home")).toHaveCount(0, { timeout: 10_000 });
  });

  test("«معلومات المتجر»: after the blocks and before «تصفّحي المنتجات», «الكل» only; everything it showed before, in one section of three columns", async ({ page }) => {
    await openStore(page);
    const info = page.getByTestId("store-info");
    await expect(info).toBeVisible({ timeout: 30_000 });
    const y = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
    const ys = [await y('[data-testid="store-home"]'), await y('[data-testid="store-info"]'), await y(".store-products-heading")];
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    await expect(info.locator(".si-title")).toHaveText("معلومات المتجر");
    // three balanced columns on a desktop, side by side
    const parts = info.locator(".si-item");
    await expect(parts).toHaveCount(3);
    await expect(parts.nth(0)).toHaveAttribute("data-part", "branches");
    await expect(parts.nth(1)).toHaveAttribute("data-part", "delivery");
    await expect(parts.nth(2)).toHaveAttribute("data-part", "returns");
    const boxes = await Promise.all([0, 1, 2].map((i) => parts.nth(i).boundingBox()));
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
    expect(Math.abs(boxes[1]!.y - boxes[2]!.y)).toBeLessThan(2);
    expect(Math.abs(boxes[0]!.width - boxes[2]!.width)).toBeLessThan(4);
    // branches: one line each - the full week, or «not set», with a divider between them
    const branches = info.locator('[data-part="branches"] .si-branch');
    await expect(branches).toHaveCount(2);
    const withHours = branches.filter({ hasText: "Branch A" });
    await expect(withHours.locator(".si-hours li")).toHaveCount(7);
    await expect(withHours.locator(".si-hours li").first()).toContainText("10:00 - 22:00");
    await expect(branches.filter({ hasText: "فرع بلا ساعات" })).toContainText("لم يحدّد المتجر ساعات العمل بعد.");
    // delivery: every zone with its fee (free shown as such)
    const zones = info.locator('[data-part="delivery"] .si-rows li');
    await expect(zones).toHaveCount(2);
    await expect(zones.filter({ hasText: "الضفة الغربية" })).toContainText("15 ₪");
    await expect(zones.filter({ hasText: "القدس" })).toContainText("مجاناً");
    // returns: mode, period, fee
    const returns = info.locator('[data-part="returns"]');
    await expect(returns.locator(".si-mode")).toHaveText("إرجاع مقابل استرداد المبلغ");
    await expect(returns.locator(".si-rows li").filter({ hasText: "المهلة" })).toContainText("خلال 14 يوماً من الاستلام");
    await expect(returns.locator(".si-rows li").filter({ hasText: "رسوم الإرجاع" })).toContainText("5 ₪");
    // nothing hidden behind a disclosure
    await expect(info.locator("details")).toHaveCount(0);
    // «الكل» only: a department or a search hides it; «الكل» brings it back
    const explore = page.locator(".store-hero .store-categories");
    await explore.getByRole("tab", { name: /نساء/ }).click();
    await expect(page.getByTestId("store-info")).toHaveCount(0);
    await explore.locator(".store-department-chips").getByRole("tab").first().click();
    await expect(page.getByTestId("store-info")).toBeVisible();
    await page.locator(".store-search").click();
    await page.locator(".store-search input").fill("ساتان");
    await expect(page.getByTestId("store-info")).toHaveCount(0, { timeout: 10_000 });
  });

  test("English / LTR: the same blocks, English text where the owner gave it (Arabic otherwise), mirrored controls", async ({ browser }) => {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem("finalpro_lang_pref", "en"));
    const page = await context.newPage();
    await openStore(page);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    const home = page.getByTestId("store-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    // no «Browse the products» heading any more
    await expect(page.getByText("Browse the products")).toHaveCount(0);
    await expect(home.locator(".sh-hero-title").first()).toHaveText("Evening season");
    // no English given: the Arabic text, never an empty heading
    await expect(home.locator(".sh-hero-title").nth(1)).toHaveText("بلايز الموسم");
    await expect(page.locator('[data-block="categories"]')).toHaveCount(0);
    await expect(page.getByTestId("home-hero-prev")).toHaveAttribute("aria-label", "Previous slide");
    const zonesEn = page.getByTestId("store-info").locator('[data-part="delivery"] .si-rows li');
    await expect(zonesEn.filter({ hasText: "West Bank" })).toContainText("₪15");
    await expect(zonesEn.filter({ hasText: "Jerusalem" })).toContainText("Free");
    await context.close();
  });

  test("a phone: no sideways scroll, a portrait hero with the phone image, two cards per row in the rails; and the blocks pass axe (WCAG 2 A/AA)", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await openStore(page);
    const home = page.getByTestId("store-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    // the store page rises and fades in (~0.8 s): sizes and colours are measured once it has finished
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity));
    await expectNoHorizontalOverflow(page);
    const slide = await home.locator(".sh-hero-slide").first().boundingBox();
    expect(slide!.height).toBeGreaterThan(slide!.width);
    await expect(home.locator(".sh-hero-slide").first().locator("source[media]")).toHaveCount(1);
    const card = await home.locator('[data-block="products"] .sh-rail-item').first().boundingBox();
    expect(card!.width).toBeLessThan(390 / 2);
    // «معلومات المتجر» stacks its parts on a phone
    const parts = page.getByTestId("store-info").locator(".si-item");
    await expect(parts).toHaveCount(3);
    const [p1, p2] = [await parts.nth(0).boundingBox(), await parts.nth(1).boundingBox()];
    expect(p2!.y).toBeGreaterThan(p1!.y + p1!.height - 2);

    const axePath = localRequire.resolve("axe-core/axe.min.js");
    await page.addScriptTag({ content: readFileSync(axePath, "utf8") });
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe;
      const r = await axe.run({ include: [['[data-testid="store-home"]'], ['[data-testid="store-info"]']] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
      return r.violations.map((v) => `${v.id} (${v.nodes.length})`);
    });
    expect(violations).toEqual([]);
    await context.close();
  });

  test("the employee: sees the blocks as a shopper, has no designer (no pencil, no tile); the designer page is refused for her by the API", async ({ page }) => {
    const employee = await account();
    await prisma.vendorUser.create({ data: { userId: employee.id, vendorId, role: "BRANCH_EMPLOYEE", branchId } });
    await openStore(page, employee.token);
    await expect(page.getByTestId("store-home")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("store-home-design")).toHaveCount(0);
    await expect(page.locator(".store-management-grid")).toHaveCount(0);
    await page.goto(`/vendor/${vendorId}/storefront/home`);
    await expect(page.locator(".error-banner, [role='alert']").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("home-add")).toHaveCount(0);
  });

  test("two tabs of the owner: the stale tab is told and cannot overwrite the newer draft; a reload continues from it", async ({ browser }) => {
    const context = await browser.newContext();
    const a = await context.newPage();
    const b = await context.newPage();
    const fa = await openDesigner(a);
    const fb = await openDesigner(b);
    await fa.getByTestId("home-row-3-edit").click();
    await fa.getByTestId("text-title-ar").fill("من التبويب الأول");
    await saved(fa);
    await fb.getByTestId("home-row-3-edit").click();
    await fb.getByTestId("text-title-ar").fill("من التبويب الثاني");
    await expect(fb.getByTestId("home-conflict")).toBeVisible({ timeout: 30_000 });
    const row = await layoutRow(vendorId);
    expect(JSON.stringify(row.draft)).toContain("من التبويب الأول");
    expect(JSON.stringify(row.draft)).not.toContain("من التبويب الثاني");
    await fb.getByTestId("home-conflict").getByRole("button").click();
    await expect(fb.getByTestId("home-designer")).toHaveAttribute("data-view", "list", { timeout: 30_000 });
    await expect(fb.getByTestId("home-conflict")).toHaveCount(0);
    await context.close();
  });

  test("a layout saved earlier with a «فئات المتجر» block keeps working: saved and published as it is, never shown to shoppers, the owner told why and able to delete it", async ({ page }) => {
    const owner = await call<{ draft: { blocks: unknown[] }; draft_version: number }>(`/vendors/${vendorId}/storefront/home`, { token: fixtures.ownerToken });
    const blocks = [...owner.body.draft.blocks, { id: "old-categories", type: "categories", visible: true, title: { ar: "قديمة", en: "" }, items: [{ audience: "WOMEN", category: "TOPS" }, { audience: "WOMEN", category: "DRESSES_WOMEN" }] }];
    const savedRes = await call<{ draft_version: number; review: Record<string, { shown: boolean; reason: string }> }>(`/vendors/${vendorId}/storefront/home/draft`, { method: "PUT", token: fixtures.ownerToken, body: { version: owner.body.draft_version, layout: { blocks } } });
    expect(savedRes.status).toBe(200);
    expect(savedRes.body.review["old-categories"]).toMatchObject({ shown: false, reason: "retired" });
    const pub = await call(`/vendors/${vendorId}/storefront/home/publish`, { method: "POST", token: fixtures.ownerToken, body: { version: savedRes.body.draft_version } });
    expect(pub.status).toBe(200);
    // shoppers: the rest of the page as before, no second set of categories
    await openStore(page);
    await expect(page.getByTestId("store-home")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-block="categories"]')).toHaveCount(0);
    await expect(page.getByTestId("store-home")).not.toContainText("قديمة");
    // the owner: the row says why; it can be deleted
    const p2 = await page.context().browser()!.newPage();
    const frame = await openDesigner(p2);
    const row = frame.locator('.shd-list > li[data-type="categories"]');
    await expect(row).toContainText("استكشفي التصنيفات");
    await row.getByRole("button", { name: /حذف/ }).click();
    await frame.getByRole("button", { name: "حذف البلوك" }).click();
    await saved(frame);
    await expect(frame.locator('.shd-list > li[data-type="categories"]')).toHaveCount(0);
    await p2.close();
  });

  test("the designer, live: block cards, the add cards with «مقطع مميّز» (a look only, never added), size and spacing per type, the preview changing at once, phone/desktop, «معاينة كاملة» of the unpublished draft; shoppers see it only after «نشر»", async ({ page }) => {
    const frame = await openDesigner(page);
    // the cards: a miniature of each block, its state and its actions
    const cards = frame.locator(".shd-list > li.shd-card");
    expect(await cards.count()).toBeGreaterThan(2);
    await expect(cards.first().locator(".shd-thumb-frame img").first()).toBeVisible();
    // «إضافة بلوك»: drawings for every type, and «مقطع مميّز» as a look only
    await frame.getByTestId("home-add").click();
    await expect(frame.locator(".shd-types .shd-draw")).toHaveCount(8);
    const soon = frame.getByTestId("home-add-soon");
    await expect(soon).toHaveAttribute("aria-disabled", "true");
    await expect(soon).toContainText("قريباً — يتطلب إضافة الفيديوهات");
    await expect(soon.locator(".shd-soon-play")).toBeVisible();
    const before = await cards.count();
    await soon.click({ force: true });
    await expect(cards).toHaveCount(before);
    await frame.getByRole("button", { name: "إلغاء" }).click();

    // the hero: the live preview follows the title and the display choices at once
    await frame.getByTestId("home-row-0-edit").click();
    await expect(frame.getByTestId("home-designer")).toHaveAttribute("data-view", "block");
    await showPreview(frame);
    const live = frame.getByTestId("home-preview");
    await showEdit(frame);
    await frame.getByTestId("hero-title-0-ar").fill("عنوان لم يُنشر بعد");
    await showPreview(frame);
    await expect(live.locator(".sh-hero-title").first()).toHaveText("عنوان لم يُنشر بعد", { timeout: 2_000 });
    await showEdit(frame);
    const display = frame.getByTestId("home-display");
    await expect(display.getByRole("radiogroup")).toHaveCount(3);
    await expect(frame.getByTestId("home-display-height-medium")).toBeChecked();
    await frame.getByTestId("home-display-height-wide").check();
    await frame.getByTestId("home-display-width-full").check();
    await frame.getByTestId("home-display-spacing-tight").check();
    await showPreview(frame);
    const slot = live.locator(".sh-slot").first();
    await expect(slot).toHaveClass(/sh-h-wide/);
    await expect(slot).toHaveClass(/sh-w-full/);
    await expect(slot).toHaveClass(/sh-sp-tight/);
    // the block being edited is marked in the preview
    await expect(slot).toHaveClass(/is-editing/);
    // phone / desktop
    await frame.getByTestId("home-device-phone").click();
    await expect(live).toHaveClass(/is-phone/);
    await frame.getByTestId("home-device-desktop").click();
    await expect(live).toHaveClass(/is-desktop/);
    await saved(frame);
    await page.getByTestId("management-frame-back").click();
    // a text block takes only the spacing
    await frame.locator('.shd-list > li[data-type="text"]').first().getByRole("button", { name: /^تعديل/ }).last().click();
    await expect(frame.getByTestId("home-display").getByRole("radiogroup")).toHaveCount(1);
    await expect(frame.getByTestId("home-display-height-wide")).toHaveCount(0);
    await page.getByTestId("management-frame-back").click();
    await saved(frame);

    // saved with the draft (closed values), not published yet
    const row = await layoutRow(vendorId);
    const hero = (row.draft as { blocks: { type: string; display: unknown }[] }).blocks.find((b) => b.type === "hero")!;
    expect(hero.display).toEqual({ width: "full", height: "wide", spacing: "tight" });
    const shopper = await call<{ blocks: { type: string; display?: unknown; slides?: { title: { ar: string } }[] }[] }>(`/storefronts/${slug}/home`);
    expect(JSON.stringify(shopper.body)).not.toContain("عنوان لم يُنشر بعد");

    // «معاينة كاملة»: the store page with the unpublished draft, in a new tab, nothing published
    const [full] = await Promise.all([page.context().waitForEvent("page"), frame.getByTestId("home-full-preview").first().click()]);
    await full.waitForURL(/home_preview=draft/, { timeout: 30_000 });
    await expect(full.getByTestId("store-home-draft-banner")).toBeVisible({ timeout: 30_000 });
    await expect(full.getByTestId("store-home").locator(".sh-hero-title").first()).toHaveText("عنوان لم يُنشر بعد");
    await expect(full.getByTestId("store-home").locator(".sh-slot").first()).toHaveClass(/sh-w-full/);
    // full width without sideways scrolling
    expect(await full.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await full.close();
    const after = await call(`/storefronts/${slug}/home`);
    expect(JSON.stringify(after.body)).not.toContain("عنوان لم يُنشر بعد");
    // a shopper asking for the draft gets the public page
    const stranger = await page.context().browser()!.newPage();
    await stranger.goto(`/store/${slug}?home_preview=draft`);
    await expect(stranger.getByTestId("store-home")).toBeVisible({ timeout: 30_000 });
    await expect(stranger.getByTestId("store-home-draft-banner")).toHaveCount(0);
    await expect(stranger.getByTestId("store-home")).not.toContainText("عنوان لم يُنشر بعد");
    await stranger.close();

    // «نشر»: now shoppers get it, with its display
    await frame.getByTestId("home-publish").click();
    await expect(frame.getByTestId("home-toast")).toHaveText("نُشرت الصفحة الرئيسية. تراها المتسوقات الآن.", { timeout: 30_000 });
    const shopperPage = await page.context().browser()!.newPage();
    await shopperPage.goto(`/store/${slug}`);
    const first = shopperPage.getByTestId("store-home").locator(".sh-slot").first();
    await expect(first).toHaveClass(/sh-h-wide/, { timeout: 30_000 });
    await expect(first).toHaveClass(/sh-w-full/);
    await expect(shopperPage.getByTestId("store-home").locator(".sh-hero-title").first()).toHaveText("عنوان لم يُنشر بعد");
    await shopperPage.close();
  });

  // ---------------- «قوالب وستايلات وأشكال الصفحة الرئيسية» (2026-11-21)

  test("templates, styles and shapes: a template asks before replacing the DRAFT only (published untouched), is built from the store's real things with «أضيفي صورة» places; «فحص قبل النشر» blocks «نشر» until they are filled; a split Hero, a double banner, a product strip, a focus point and a style, published together", async ({ page }) => {
    const publishedBefore = JSON.stringify((await call(`/storefronts/${slug}/home`)).body);
    const frame = await openDesigner(page);
    const rowsBefore = await frame.locator(".shd-list > li").count();
    expect(rowsBefore).toBeGreaterThan(0);

    // one Hero per page: adding another is not offered
    await frame.getByTestId("home-add").click();
    await expect(frame.getByTestId("home-add-hero")).toBeDisabled();
    await expect(frame.getByTestId("home-add-hero")).toContainText("Hero واحد بالفعل");
    await frame.getByRole("button", { name: "إلغاء" }).click();

    // the four templates; on a draft with blocks, a template asks first - and «إلغاء» changes nothing
    await frame.getByTestId("home-templates").click();
    const list = frame.getByTestId("home-template-list");
    for (const tpl of ["luxe", "sale", "kids", "minimal"]) await expect(list.getByTestId(`home-template-${tpl}`)).toBeVisible();
    await list.getByTestId("home-template-luxe").click();
    const confirm = frame.getByTestId("small-confirm");
    await expect(confirm).toContainText("استبدال المسودة بقالب «أزياء راقٍ»؟");
    await expect(confirm).toContainText("الصفحة المنشورة لا تتغير");
    await confirm.getByRole("button", { name: "إلغاء" }).click();
    await expect(frame.locator(".shd-list > li")).toHaveCount(rowsBefore);
    await list.getByTestId("home-template-luxe").click();
    await frame.getByTestId("small-confirm").getByRole("button", { name: "استبدال المسودة" }).click();

    // built from the store's real things: one collection only (fewer than two: left out), its buyable products, its new arrivals
    const rows = frame.locator(".shd-list > li");
    // applied once the template's empty image place is there (the old draft also had four rows)
    await expect(frame.getByTestId("home-row-0")).toContainText("أضيفي صورة", { timeout: 30_000 });
    await expect(rows).toHaveCount(4);
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-type")))).toEqual(["hero", "products", "banner", "auto_products"]);
    await saved(frame);
    let row = await layoutRow(vendorId);
    const draft = row.draft as { template: string; style: string; blocks: { type: string; offer_ids?: string[] }[] };
    expect(draft.template).toBe("luxe");
    expect(draft.style).toBe("default");
    expect(draft.blocks.find((b) => b.type === "products")!.offer_ids!.sort()).toEqual([p.velvet, p.satin, p.blouse].sort());
    // the published page is untouched
    expect(JSON.stringify((await call(`/storefronts/${slug}/home`)).body)).toBe(publishedBefore);

    // «فحص قبل النشر»: the empty image places are errors - «نشر» waits
    const checks = frame.getByTestId("home-checks");
    await expect(checks.getByTestId("home-check-error")).toHaveCount(2, { timeout: 30_000 });
    await expect(checks.locator('[data-testid="home-check-error"][data-code="no_image"]')).toHaveCount(2);
    await expect(frame.getByTestId("home-publish")).toBeDisabled();

    // the Hero: «منقسم» from the template; its image added; the focus on the model's side
    await frame.getByTestId("home-row-0-edit").click();
    await expect(frame.getByTestId("home-variant-split")).toBeChecked();
    await expect(frame.getByTestId("hero-image-0-needed")).toHaveText(/أضيفي صورة/);
    await frame.getByTestId("hero-image-0-input").setInputFiles(await image(1200, 1000, "#6d1f33"));
    await expect(frame.getByTestId("hero-image-0-needed")).toHaveCount(0, { timeout: 30_000 });
    await frame.getByTestId("hero-focus-0-top-right").check();
    await expect(frame.getByTestId("hero-focus-0-top-right")).toBeChecked();
    await page.getByTestId("management-frame-back").click();

    // the banner: «مزدوج» - two complete cards
    await frame.getByTestId("home-row-2-edit").click();
    await frame.getByTestId("home-variant-double").check();
    await expect(frame.getByTestId("banner-card-2")).toBeVisible();
    await frame.getByTestId("banner-image-input").setInputFiles(await image(1200, 600, "#b08d57"));
    await frame.getByTestId("banner-title-ar").fill("فساتين السهرة");
    await frame.getByTestId("banner2-image-input").setInputFiles(await image(1200, 600, "#3a0c1a"));
    await frame.getByTestId("banner2-title-ar").fill("وصل حديثاً");
    await frame.getByTestId("banner2-target-kind").selectOption("new");
    await saved(frame);
    await page.getByTestId("management-frame-back").click();
    await saved(frame);
    await expect(checks.getByTestId("home-check-error")).toHaveCount(0, { timeout: 30_000 });
    await expect(frame.getByTestId("home-publish")).toBeEnabled();

    // the style: independent of the template; the live preview follows at once
    await frame.getByTestId("home-style-elegant").check();
    await showPreview(frame);
    const live = frame.getByTestId("home-preview");
    await expect(live.locator(".sh-root")).toHaveAttribute("data-style", "elegant");
    await expect(live.locator('[data-block="hero"]')).toHaveAttribute("data-variant", "split");
    await expect(live.locator('[data-block="banner"]')).toHaveAttribute("data-variant", "double");
    await expect(live.locator('[data-block="products"][data-variant="side"] .sh-side-lead')).toHaveText("قطع مختارة من المتجر.");
    await expect(live.locator('[data-block="hero"] img.sh-fp-top-right')).toHaveCount(1);
    await showEdit(frame);
    await saved(frame);
    row = await layoutRow(vendorId);
    expect((row.draft as { style: string; template: string }).style).toBe("elegant");
    expect((row.draft as { style: string; template: string }).template).toBe("luxe");
    expect(JSON.stringify((await call(`/storefronts/${slug}/home`)).body)).toBe(publishedBefore);

    // «معاينة كاملة»: the unpublished draft with its style, nothing published
    const [full] = await Promise.all([page.context().waitForEvent("page"), frame.getByTestId("home-full-preview").first().click()]);
    await full.waitForURL(/home_preview=draft/, { timeout: 30_000 });
    await expect(full.getByTestId("store-home")).toHaveAttribute("data-style", "elegant", { timeout: 30_000 });
    await expect(full.locator('[data-block="hero"][data-variant="split"]')).toBeVisible();
    await full.close();
    expect(JSON.stringify((await call(`/storefronts/${slug}/home`)).body)).toBe(publishedBefore);

    // «نشر»: blocks, shapes and style reach shoppers together (wait for the publish notice itself -
    // the template's notice may still be showing)
    await frame.getByTestId("home-publish").click();
    await expect(frame.getByTestId("home-toast")).toHaveText("نُشرت الصفحة الرئيسية. تراها المتسوقات الآن.", { timeout: 30_000 });
    const pub = await call<{ style?: string; blocks: { type: string; variant?: string }[] }>(`/storefronts/${slug}/home`);
    expect(pub.body.style).toBe("elegant");
    expect(pub.body.blocks.map((b) => `${b.type}:${b.variant}`)).toEqual(["hero:split", "products:side", "banner:double", "auto_products:standard"]);

    const shopper = await page.context().browser()!.newPage();
    await shopper.goto(`/store/${slug}`);
    const home = shopper.getByTestId("store-home");
    await expect(home).toHaveAttribute("data-style", "elegant", { timeout: 30_000 });
    await expect(home.getByTestId("home-banner-card-1")).toContainText("فساتين السهرة");
    await expect(home.getByTestId("home-banner-card-2")).toContainText("وصل حديثاً");
    // the heading font is one of the app's own (Amiri for «راقٍ»)
    expect(await home.locator(".sh-heading").first().evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Finalpro Amiri");
    // a department: the product browsing only - no blocks, no store information, no jump link
    await shopper.locator(".store-hero .store-categories").getByRole("tab", { name: /نساء/ }).click();
    await expect(shopper.getByTestId("store-home")).toHaveCount(0);
    await expect(shopper.getByTestId("store-info")).toHaveCount(0);
    await expect(shopper.getByTestId("store-jump-products")).toHaveCount(0);
    await shopper.close();
  });

  test("a phone and English: no sideways scroll; the split Hero puts the image above the text; the double banner stacks; «تسوّقي كل المنتجات ↓» on «الكل» only jumps to the products; «استكشفي التصنيفات» scrolls in its own row; LTR mirrors the layout, never the images; axe", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await openStore(page);
    const home = page.getByTestId("store-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    // the store page rises and fades in (~0.8 s): sizes and colours are measured once it has finished
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity));
    await expectNoHorizontalOverflow(page);
    // image above, text below - the text never covers the model
    const hero = home.locator('[data-block="hero"]');
    const media = await hero.locator(".sh-hero-media").first().boundingBox();
    const text = await hero.locator(".sh-hero-text").first().boundingBox();
    expect(text!.y).toBeGreaterThanOrEqual(media!.y + media!.height - 1);
    expect(media!.height).toBeGreaterThan(media!.width);
    // two promo cards, one under the other
    const [c1, c2] = [await home.getByTestId("home-banner-card-1").boundingBox(), await home.getByTestId("home-banner-card-2").boundingBox()];
    expect(c2!.y).toBeGreaterThan(c1!.y + c1!.height - 1);
    // the jump to the products (phone only, «الكل» only)
    const jump = page.getByTestId("store-jump-products");
    await expect(jump).toBeVisible();
    await expect(jump).toHaveText("تسوّقي كل المنتجات ↓");
    await jump.click();
    await expect(page.locator(".store-products-heading")).toBeInViewport({ timeout: 10_000 });
    await expect(page.locator("#store-browse")).toBeFocused();
    // «استكشفي التصنيفات»: one row that scrolls on its own (never the page)
    const chips = page.locator(".store-hero .store-categories .store-department-chips");
    expect(await chips.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
    await page.locator(".store-hero .store-categories").getByRole("tab", { name: /نساء/ }).click();
    await expect(page.getByTestId("store-home")).toHaveCount(0);
    await expect(jump).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.locator(".store-hero .store-categories .store-department-chips").getByRole("tab").first().click();
    await expect(page.getByTestId("store-home")).toBeVisible({ timeout: 30_000 });

    const axePath = localRequire.resolve("axe-core/axe.min.js");
    await page.addScriptTag({ content: readFileSync(axePath, "utf8") });
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe;
      const r = await axe.run({ include: [['[data-testid="store-home"]'], ['[data-testid="store-jump-products"]']] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
      return r.violations.map((v) => `${v.id} (${v.nodes.length})`);
    });
    expect(violations).toEqual([]);
    await context.close();

    // English on a computer: LTR, no jump link (phone only), the images never mirrored
    const en = await browser.newContext();
    await en.addInitScript(() => localStorage.setItem("finalpro_lang_pref", "en"));
    const desktop = await en.newPage();
    await openStore(desktop);
    await expect(desktop.locator("html")).toHaveAttribute("dir", "ltr");
    const enHome = desktop.getByTestId("store-home");
    await expect(enHome).toBeVisible({ timeout: 30_000 });
    await expect(desktop.getByTestId("store-jump-products")).toBeHidden();
    // the split: the image takes the start side (left in English), the text the other
    const m = await enHome.locator(".sh-hero-media").first().boundingBox();
    const tx = await enHome.locator(".sh-hero-text").first().boundingBox();
    expect(m!.x).toBeLessThan(tx!.x);
    expect(await enHome.locator(".sh-hero-media img").first().evaluate((el) => getComputedStyle(el).transform)).toBe("none");
    await expectNoHorizontalOverflow(desktop);
    await en.close();
  });

  // ---------------- P1 (2026-11-22): category cards, strips, the safe preview

  /** Every request that is not a read, from now on. */
  function writes(page: Page) {
    const out: string[] = [];
    page.on("request", (r) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(r.method())) out.push(`${r.method()} ${r.url()}`);
    });
    return out;
  }
  const BLOCKED = "لا يمكن التفاعل داخل المعاينة. انشري التغييرات أو أغلقي المعاينة للتصفح.";

  test("«بطاقات التصنيفات»: the owner builds cards to real departments and categories (images, Arabic titles, shape); shoppers see them on «الكل» only, open a department or category by mouse or keyboard; English falls back; the fixed chips stay", async ({ page }) => {
    const frame = await openDesigner(page);
    await frame.getByTestId("home-add").click();
    await expect(frame.getByTestId("home-add-category_cards")).toBeVisible();
    await expect(frame.getByTestId("home-add-categories")).toHaveCount(0);
    await frame.getByTestId("home-add-category_cards").click();
    await expect(frame.getByTestId("cards-editor")).toBeVisible({ timeout: 30_000 });
    // destinations: the store's real department and its categories with products - never typed
    for (let i = 0; i < 3; i += 1) await frame.getByTestId("cards-add").click();
    await expect(frame.getByTestId("card-0-target")).toHaveValue("WOMEN/");
    await expect(frame.getByTestId("card-1-target")).toHaveValue("WOMEN/DRESSES_WOMEN");
    await expect(frame.getByTestId("card-2-target")).toHaveValue("WOMEN/TOPS");
    await expect(frame.getByTestId("card-0-target").locator("option", { hasText: "رجال" })).toHaveCount(0);
    await frame.getByTestId("cards-shape-square").check();
    const titles = ["نساء", "فساتين", "بلايز"];
    for (let i = 0; i < 3; i += 1) {
      await frame.getByTestId(`card-${i}-image-input`).setInputFiles(await image(800, 800, ["#6d1f33", "#b08d57", "#3a0c1a"][i]));
      await expect(frame.getByTestId(`card-${i}-image-needed`)).toHaveCount(0, { timeout: 30_000 });
      await frame.getByTestId(`card-${i}-title-ar`).fill(titles[i]);
    }
    await frame.getByTestId("card-1-title-en").fill("Dresses");
    await frame.getByTestId("card-0-text-ar").fill("كل جديد النساء");
    await saved(frame);
    await page.getByTestId("management-frame-back").click();
    await saved(frame);
    await expect(frame.getByTestId("home-checks").getByTestId("home-check-error")).toHaveCount(0, { timeout: 30_000 });
    await frame.getByTestId("home-publish").click();
    await expect(frame.getByTestId("home-toast")).toHaveText("نُشرت الصفحة الرئيسية. تراها المتسوقات الآن.", { timeout: 30_000 });

    // shoppers (desktop, Arabic)
    const shopper = await page.context().browser()!.newPage();
    await openStore(shopper);
    const block = shopper.locator('[data-block="category_cards"]');
    await expect(block).toBeVisible({ timeout: 30_000 });
    await expect(block).toHaveAttribute("data-shape", "square");
    await expect(block.locator(".sh-cardc")).toHaveCount(3);
    await expect(block.getByTestId("home-card-WOMEN")).toContainText("كل جديد النساء");
    // the fixed chips stay as they are, once
    await expect(shopper.locator(".store-hero .store-categories .store-department-chips")).toBeVisible();
    await expect(shopper.locator('[data-block="categories"]')).toHaveCount(0);
    // the strip: no browser scrollbar
    const rail = block.locator("ul.sh-rail");
    expect(await rail.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("none");
    expect(await rail.evaluate((el) => (el as HTMLElement).offsetHeight - el.clientHeight)).toBe(0);
    // the keyboard: a category card opens that category
    await block.getByTestId("home-card-WOMEN-TOPS").focus();
    await shopper.keyboard.press("Enter");
    await expect(shopper.getByTestId("store-audience-title").locator("h2")).toHaveText("نساء · بلايز وتوبات", { timeout: 30_000 });
    await expect(shopper.locator('[data-block="category_cards"]')).toHaveCount(0);
    // back to «الكل», then a department card
    await shopper.locator(".store-hero .store-categories .store-department-chips").getByRole("tab").first().click();
    await shopper.locator('[data-block="category_cards"]').getByTestId("home-card-WOMEN").click();
    await expect(shopper.getByTestId("store-audience-title").locator("h2")).toHaveText("نساء", { timeout: 30_000 });
    await expect(shopper.getByTestId("store-home")).toHaveCount(0);
    await shopper.close();

    // English: the owner's English title, else the Arabic one
    const en = await page.context().browser()!.newContext();
    await en.addInitScript(() => localStorage.setItem("finalpro_lang_pref", "en"));
    const enPage = await en.newPage();
    await openStore(enPage);
    const enBlock = enPage.locator('[data-block="category_cards"]');
    await expect(enBlock.getByTestId("home-card-WOMEN-DRESSES_WOMEN")).toContainText("Dresses", { timeout: 30_000 });
    await expect(enBlock.getByTestId("home-card-WOMEN-TOPS")).toContainText("بلايز");
    await en.close();
  });

  test("strips on a phone: no browser scrollbar, the next card peeks in, arrows in the title row (never over the cards), the start arrow disabled but shown, keyboard and RTL; nothing extra outside «الكل»; axe", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await openStore(page);
    const home = page.getByTestId("store-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity));
    await expectNoHorizontalOverflow(page);
    const block = home.locator('[data-block="category_cards"]');
    const rail = block.locator("ul.sh-rail");
    expect(await rail.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("none");
    // the next card peeks in
    const railBox = (await rail.boundingBox())!;
    const third = (await block.locator(".sh-cardc-item").nth(2).boundingBox())!;
    expect(third.x).toBeLessThan(railBox.x + railBox.width);
    expect(third.x + third.width).toBeGreaterThan(railBox.x);
    // arrows: in the title row, not over the cards; the side ones are not shown on a phone
    const next = block.getByTestId("home-rail-next-head");
    const prev = block.getByTestId("home-rail-prev-head");
    await expect(next).toBeVisible();
    await expect(block.getByTestId("home-rail-next-side")).toBeHidden();
    expect((await next.boundingBox())!.y + 30).toBeLessThan(railBox.y + 2);
    await expect(prev).toBeVisible();
    await expect(prev).toBeDisabled();
    // the keyboard moves the strip (RTL: scrollLeft goes negative)
    const before = await rail.evaluate((el) => el.scrollLeft);
    await next.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => rail.evaluate((el) => Math.abs(el.scrollLeft))).toBeGreaterThan(Math.abs(before) + 20);
    await expect(prev).toBeEnabled();
    // «وصل حديثاً» strips too
    expect(await home.locator('[data-block="auto_products"] ul.sh-rail').first().evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("none");
    // outside «الكل»: no blocks, no cards
    await page.locator(".store-hero .store-categories").getByRole("tab", { name: /نساء/ }).click();
    await expect(page.locator('[data-block="category_cards"]')).toHaveCount(0);
    await expect(page.getByTestId("store-home")).toHaveCount(0);
    await page.locator(".store-hero .store-categories .store-department-chips").getByRole("tab").first().click();
    await expect(page.locator('[data-block="category_cards"]')).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity));
    const axePath = localRequire.resolve("axe-core/axe.min.js");
    await page.addScriptTag({ content: readFileSync(axePath, "utf8") });
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe;
      const r = await axe.run({ include: [['[data-testid="store-home"]']] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
      return r.violations.map((v) => `${v.id} (${v.nodes.length})`);
    });
    expect(violations).toEqual([]);
    await context.close();
  });

  test("the live preview is safe: links, product cards, category cards and buttons do nothing - a polite notice says why, with no request but reads; controls keep their roles and are described as unavailable; the Hero's and strips' arrows still move it locally", async ({ page }) => {
    // a second Hero slide, so the Hero has arrows (the owner's own API)
    const owner = await call<{ draft: { blocks: { type: string; slides?: unknown[] }[] }; draft_version: number }>(`/vendors/${vendorId}/storefront/home`, { token: fixtures.ownerToken });
    const blocks = owner.body.draft.blocks.map((b) => (b.type === "hero" ? { ...b, slides: [...b.slides!, { ...(b.slides![0] as object), title: { ar: "شريحة ثانية", en: "" } }] } : b));
    const put = await call(`/vendors/${vendorId}/storefront/home/draft`, { method: "PUT", token: fixtures.ownerToken, body: { version: owner.body.draft_version, layout: { ...owner.body.draft, blocks } } });
    expect(put.status).toBe(200);

    const frame = await openDesigner(page);
    await showPreview(frame);
    const live = frame.getByTestId("home-preview");
    await expect(live.getByTestId("store-home")).toBeVisible({ timeout: 30_000 });
    await saved(frame);
    const sent = writes(page);
    const url = page.url();
    const notice = live.getByTestId("preview-blocked");
    // a product card (a link) - nothing opens
    await live.locator('[data-block="products"] .store-card-link').first().click();
    await expect(notice).toHaveText(BLOCKED);
    await expect(notice).toHaveAttribute("role", "status");
    // a category card by keyboard - nothing happens
    const cardBtn = live.locator('[data-block="category_cards"] .sh-cardc').first();
    await cardBtn.focus();
    await expect(cardBtn).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(cardBtn).toHaveAccessibleDescription(/معاينة — التفاعل غير متاح/);
    await expect(cardBtn).toHaveRole("button");
    // a Hero button
    await live.getByTestId("home-hero-button").first().click();
    expect(page.url()).toBe(url);
    // the Hero's arrows move it, locally
    const hero = live.locator('[data-block="hero"]');
    await hero.getByTestId("home-hero-next").click();
    await expect(hero.locator(".sh-hero-dot").nth(1)).toHaveAttribute("aria-current", "true");
    await expect(hero.getByTestId("home-hero-next")).not.toHaveAttribute("aria-describedby", /.+/);
    // nothing but reads left the browser, nothing changed
    await page.waitForTimeout(1500);
    expect(sent).toEqual([]);
    expect(page.url()).toBe(url);
    await expect(frame.getByTestId("home-designer")).toHaveAttribute("data-view", "list");
  });

  test("the full preview (?home_preview=draft) is read only: links, products, chips, search, filters, cart, follow and the Hero's buttons do nothing (a notice says why); no write request leaves the browser even if tried; the Hero's and strips' arrows work; «إغلاق المعاينة» still works", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/store/${slug}?home_preview=draft`);
    await expect(page.getByTestId("store-home-draft-banner")).toBeVisible({ timeout: 30_000 });
    const home = page.getByTestId("store-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity));
    const sent = writes(page);
    const url = page.url();
    const notice = page.getByTestId("preview-blocked");

    // a product card, a category card, the department chip, the Hero's button
    await home.locator('[data-block="products"] .store-card-link').first().click();
    await expect(notice).toHaveText(BLOCKED);
    await home.locator('[data-block="category_cards"] .sh-cardc').first().click();
    await page.locator(".store-hero .store-categories").getByRole("tab", { name: /نساء/ }).click();
    await home.getByTestId("home-hero-button").first().click();
    expect(page.url()).toBe(url);
    await expect(page.getByTestId("store-home")).toBeVisible();
    await expect(page.getByTestId("store-audience-title")).toHaveCount(0);
    // the search: nothing typed, nothing filtered
    const search = page.locator(".store-search");
    if (await search.count()) {
      await search.first().click();
      const input = page.locator(".store-search input");
      if (await input.count()) {
        await input.first().focus();
        await page.keyboard.type("ساتان");
        await expect(input.first()).toHaveValue("");
      }
    }
    await expect(page.getByTestId("store-home")).toBeVisible();
    // the Hero's and the strips' arrows: local only
    const hero = home.locator('[data-block="hero"]');
    await hero.getByTestId("home-hero-next").click();
    await expect(hero.locator(".sh-hero-dot").nth(1)).toHaveAttribute("aria-current", "true");
    const strip = home.locator('[data-block="category_cards"]');
    const rail = strip.locator("ul.sh-rail");
    await strip.getByTestId("home-rail-next-head").click();
    await expect.poll(() => rail.evaluate((el) => Math.abs(el.scrollLeft))).toBeGreaterThan(20);
    expect(page.url()).toBe(url);

    // even a write tried directly never leaves the browser
    const api = process.env.PW_API_BASE_URL;
    const tried = await page.evaluate(async (base) => {
      const out: string[] = [];
      try {
        await fetch(`${base}/favorites`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        out.push("fetch sent");
      } catch {
        out.push("fetch refused");
      }
      out.push(navigator.sendBeacon(`${base}/favorites`, "{}") ? "beacon sent" : "beacon refused");
      return out;
    }, api);
    expect(tried).toEqual(["fetch refused", "beacon refused"]);
    await page.waitForTimeout(1500);
    expect(sent).toEqual([]);

    // «إغلاق المعاينة» still works - and then the page acts again
    await page.getByTestId("store-home-draft-close").click();
    await page.waitForURL((u) => !u.search.includes("home_preview"), { timeout: 30_000 });
    await expect(page.getByTestId("store-home-draft-banner")).toHaveCount(0);
    await page.locator(".store-hero .store-categories").getByRole("tab", { name: /نساء/ }).click();
    await expect(page.getByTestId("store-audience-title")).toBeVisible({ timeout: 30_000 });
    await context.close();
  });

  // ---------------- P2 (2026-11-22): fine sizes and alignment

  type Blk = { id: string; type: string; display?: Record<string, unknown> };
  const idOf = async (type: string) => {
    const r = await call<{ draft: { blocks: Blk[] } }>(`/vendors/${vendorId}/storefront/home`, { token: fixtures.ownerToken });
    return r.body.draft.blocks.find((b) => b.type === type)!.id;
  };
  async function editRow(frame: FrameLocator, type: string) {
    await frame.locator(`.shd-list > li[data-type="${type}"]`).first().getByRole("button", { name: /^تعديل/ }).last().click();
    await expect(frame.getByTestId("home-designer")).toHaveAttribute("data-view", "block");
    await expect(frame.getByTestId("home-fine")).toBeVisible();
  }

  test("«القياس الدقيق» in the designer: −10 / +10 steps, the value, «رجوع للافتراضي», ranges per type (Hero, banner, text, products, collections, category cards), alignment and items per view; the live preview follows; saved as whole steps", async ({ page }) => {
    // a text block and a collections block (two collections with buyable products) to size too
    // (real ids: a block refers to collections by their UUID)
    const sections = [{ id: randomUUID(), name: "سهرة مختارة", offer: p.velvet }, { id: randomUUID(), name: "بلايز مختارة", offer: p.blouse }];
    for (const [i, x] of sections.entries()) {
      await prisma.$executeRaw`INSERT INTO store_sections (id, "vendorId", name, "isVisible", "sortOrder") VALUES (${x.id}, ${vendorId}, ${x.name}, true, ${i + 1})`;
      await prisma.$executeRaw`INSERT INTO store_section_offers (id, "vendorId", "sectionId", "offerId", "sortOrder") VALUES (${randomUUID()}, ${vendorId}, ${x.id}, ${x.offer}, 0)`;
    }
    const owner = await call<{ draft: { blocks: Blk[] }; draft_version: number }>(`/vendors/${vendorId}/storefront/home`, { token: fixtures.ownerToken });
    const blocks = [
      ...owner.body.draft.blocks,
      { id: "text-fine", type: "text", visible: true, style: "text", title: { ar: "نص بالمقاس", en: "Sized text" }, text: { ar: "سطر يوضح عرض المحتوى ومحاذاته.", en: "" } },
      { id: "cols-fine", type: "collections", visible: true, title: { ar: "", en: "" }, collection_ids: sections.map((x) => x.id) },
    ];
    const put = await call(`/vendors/${vendorId}/storefront/home/draft`, { method: "PUT", token: fixtures.ownerToken, body: { version: owner.body.draft_version, layout: { ...owner.body.draft, blocks } } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const frame = await openDesigner(page);
    const live = frame.getByTestId("home-preview");

    // Hero: overlay, +30px, a 70% text panel, text at the end; the height range ends at +160px
    await editRow(frame, "hero");
    await frame.getByTestId("home-variant-overlay").check();
    const heroFine = frame.getByTestId("fine-height_step");
    await expect(frame.getByTestId("fine-height_step-value")).toHaveText("0px");
    await expect(frame.getByTestId("fine-height_step-reset")).toBeDisabled();
    for (let i = 0; i < 3; i += 1) await frame.getByTestId("fine-height_step-up").click();
    await expect(frame.getByTestId("fine-height_step-value")).toHaveText("+30px");
    await showPreview(frame);
    const heroId = await idOf("hero");
    await expect(live.locator(`[data-block-id="${heroId}"]`)).toHaveClass(/sh-dh/);
    await showEdit(frame);
    for (let i = 0; i < 13; i += 1) await frame.getByTestId("fine-height_step-up").click();
    await expect(frame.getByTestId("fine-height_step-value")).toHaveText("+160px");
    await expect(frame.getByTestId("fine-height_step-up")).toBeDisabled();
    await frame.getByTestId("fine-height_step-reset").click();
    await expect(frame.getByTestId("fine-height_step-value")).toHaveText("0px");
    await showPreview(frame);
    await expect(live.locator(`[data-block-id="${heroId}"]`)).not.toHaveClass(/sh-dh/);
    await showEdit(frame);
    for (let i = 0; i < 3; i += 1) await frame.getByTestId("fine-height_step-up").click();
    await expect(heroFine).toContainText("+30px");
    // the space after: from the preset («افتراضي (20px)») to 30px
    await expect(frame.getByTestId("fine-space_after-value")).toHaveText("افتراضي (20px)");
    await frame.getByTestId("fine-space_after-up").click();
    await expect(frame.getByTestId("fine-space_after-value")).toHaveText("30px");
    // the text panel: 60% -> 70%, the end of its range
    await expect(frame.getByTestId("fine-text_width-value")).toHaveText("افتراضي (62%)");
    await frame.getByTestId("fine-text_width-up").click();
    await expect(frame.getByTestId("fine-text_width-value")).toHaveText("70%");
    await expect(frame.getByTestId("fine-text_width-up")).toBeDisabled();
    await frame.locator('[data-testid="hero-slide-0"] input[name^="align-"]').nth(2).check();
    // a Hero takes no content width or items per view
    await expect(frame.getByTestId("fine-content_width")).toHaveCount(0);
    await expect(frame.getByTestId("fine-per-view-default")).toHaveCount(0);
    await saved(frame);
    await page.getByTestId("management-frame-back").click();

    // banner: +20px
    await editRow(frame, "banner");
    for (let i = 0; i < 2; i += 1) await frame.getByTestId("fine-height_step-up").click();
    await expect(frame.getByTestId("fine-height_step-value")).toHaveText("+20px");
    await expect(frame.getByTestId("fine-text_width")).toHaveCount(0);
    await saved(frame);
    await page.getByTestId("management-frame-back").click();

    // text: 60% wide, centred; its range ends at 60%
    await editRow(frame, "text");
    await expect(frame.getByTestId("fine-height_step")).toHaveCount(0);
    for (let i = 0; i < 4; i += 1) await frame.getByTestId("fine-content_width-down").click();
    await expect(frame.getByTestId("fine-content_width-value")).toHaveText("60%");
    await expect(frame.getByTestId("fine-content_width-down")).toBeDisabled();
    await frame.getByTestId("fine-align-center").check();
    await saved(frame);
    await page.getByTestId("management-frame-back").click();

    // products: three on a computer
    await editRow(frame, "products");
    await frame.getByTestId("fine-per-view-3").check();
    await expect(frame.getByTestId("fine-per-view-6")).toHaveCount(0);
    await saved(frame);
    await page.getByTestId("management-frame-back").click();

    // collections: no space before it
    await editRow(frame, "collections");
    await expect(frame.getByTestId("fine-per-view-default")).toHaveCount(0);
    for (let i = 0; i < 2; i += 1) await frame.getByTestId("fine-space_before-down").click();
    await expect(frame.getByTestId("fine-space_before-value")).toHaveText("0px");
    await expect(frame.getByTestId("fine-space_before-down")).toBeDisabled();
    await saved(frame);
    await page.getByTestId("management-frame-back").click();

    // category cards (square): 4 / 5 / 6 only
    await editRow(frame, "category_cards");
    await expect(frame.getByTestId("fine-per-view-3")).toHaveCount(0);
    await frame.getByTestId("fine-per-view-6").check();
    await saved(frame);
    await page.getByTestId("management-frame-back").click();
    await saved(frame);

    // saved as whole steps
    const row = await layoutRow(vendorId);
    const d = Object.fromEntries((row.draft as { blocks: Blk[] }).blocks.map((b) => [b.type === "text" ? "text" : b.type, b.display]));
    expect(d.hero).toMatchObject({ height_step: 3, space_after: 3, text_width: 7 });
    expect(d.banner).toMatchObject({ height_step: 2 });
    expect(d.text).toMatchObject({ content_width: 6, content_align: "center" });
    expect(d.products).toMatchObject({ per_view: 3 });
    expect(d.collections).toMatchObject({ space_before: 0 });
    expect(d.category_cards).toMatchObject({ per_view: 6 });
    await expect(frame.getByTestId("home-checks").getByTestId("home-check-error")).toHaveCount(0, { timeout: 30_000 });
    await frame.getByTestId("home-publish").click();
    await expect(frame.getByTestId("home-toast")).toHaveText("نُشرت الصفحة الرئيسية. تراها المتسوقات الآن.", { timeout: 30_000 });
  });

  /** The sizes shoppers get, measured (the CSS formulas: preset + steps, clamped). */
  async function measure(page: Page) {
    const ids = { hero: await idOf("hero"), banner: await idOf("banner"), text: "text-fine", products: await idOf("products"), cols: "cols-fine", cards: await idOf("category_cards") };
    const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    const slot = (id: string) => `[data-testid="store-home"] [data-block-id="${id}"]`;
    const root = await box('[data-testid="store-home"]');
    return {
      root,
      heroSlot: await box(slot(ids.hero)),
      heroSlide: await box(`${slot(ids.hero)} .sh-hero-slide`),
      heroText: await box(`${slot(ids.hero)} .sh-hero-slide[data-active] .sh-hero-text`),
      heroAfter: await page.locator(slot(ids.hero)).evaluate((el) => getComputedStyle(el).marginBlockEnd),
      bannerSlot: await box(slot(ids.banner)),
      bannerFrame: await box(`${slot(ids.banner)} .sh-banner-frame`),
      text: await box(`${slot(ids.text)} .sh-block`),
      colsBefore: await page.locator(slot(ids.cols)).evaluate((el) => getComputedStyle(el).marginBlockStart),
      rail: await box(`${slot(ids.products)} ul.sh-rail`),
      card: await box(`${slot(ids.products)} .sh-card-item`),
      cardsRail: await box(`${slot(ids.cards)} ul.sh-rail`),
      cardc: await box(`${slot(ids.cards)} .sh-cardc-item`),
    };
  }
  const near = (a: number, b: number, tol = 2) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
  /** Each preset's shape (width / height, floor, phone width / height) - as the CSS. */
  const SHAPES: Record<string, Record<string, [number, number, number]>> = {
    hero: { compact: [4, 200, 1], medium: [3, 260, 0.8], wide: [2.2, 340, 0.75] },
    banner: { compact: [6, 110, 2.5], medium: [4, 140, 2], wide: [3, 200, 1.3333] },
    double: { compact: [3, 120, 2.5], medium: [2, 160, 2], wide: [1.5, 200, 1.3333] },
  };
  async function presets() {
    const r = await call<{ blocks: { type: string; variant?: string; display?: { height?: string } }[] }>(`/storefronts/${slug}/home`);
    const hero = r.body.blocks.find((b) => b.type === "hero")!;
    const banner = r.body.blocks.find((b) => b.type === "banner")!;
    return { hero: SHAPES.hero[hero.display?.height ?? "medium"], banner: SHAPES[banner.variant === "double" ? "double" : "banner"][banner.display?.height ?? "medium"], double: banner.variant === "double" };
  }

  test("shoppers get the fine sizes: a computer (exact steps, clamped heights, 60% centred text, three products, six cards, the Hero's 70% text panel at the end; LTR mirrors it) and a phone (half the height steps, 0.6x spaces, full width, the next card peeking); no sideways scroll; the full preview shows them and stays read only", async ({ browser }) => {
    // a computer, Arabic
    const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openStore(desk);
    await expect(desk.getByTestId("store-home")).toBeVisible({ timeout: 30_000 });
    await desk.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity));
    await expectNoHorizontalOverflow(desk);
    const ps = await presets();
    let m = await measure(desk);
    near(m.heroSlide.height, Math.min(720, Math.max(220, Math.max(ps.hero[1], m.heroSlot.width / ps.hero[0]) + 30)));
    const bannerW = ps.double ? (m.bannerSlot.width - 16) / 2 : m.bannerSlot.width;
    near(m.bannerFrame.height, Math.min(420, Math.max(100, Math.max(ps.banner[1], bannerW / ps.banner[0]) + 20)));
    expect(m.heroAfter).toBe("30px");
    expect(m.colsBefore).toBe("0px");
    near(m.text.width, Math.max(m.root.width * 0.6, 520), 3);
    near(m.text.x - m.root.x, m.root.x + m.root.width - (m.text.x + m.text.width), 3);
    near(m.card.width, Math.max(170, (m.rail.width - 36) / 3), 3);
    near(m.cardc.width, Math.max(130, (m.cardsRail.width - 5 * 18) / 6), 3);
    // the Hero's text panel: 70% of the slide, at the end of the line (RTL: the left)
    near(m.heroText.width, m.heroSlide.width * 0.7, 3);
    near(m.heroText.x, m.heroSlide.x, 3);
    await desk.close();

    // a computer, English: the same, mirrored
    const enCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await enCtx.addInitScript(() => localStorage.setItem("finalpro_lang_pref", "en"));
    const en = await enCtx.newPage();
    await openStore(en);
    await expect(en.getByTestId("store-home")).toBeVisible({ timeout: 30_000 });
    await en.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity));
    m = await measure(en);
    near(m.heroText.x + m.heroText.width, m.heroSlide.x + m.heroSlide.width, 3);
    await expectNoHorizontalOverflow(en);
    await enCtx.close();

    // a phone: its own safe values
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const phone = await phoneCtx.newPage();
    await openStore(phone);
    await expect(phone.getByTestId("store-home")).toBeVisible({ timeout: 30_000 });
    await phone.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity));
    await expectNoHorizontalOverflow(phone);
    m = await measure(phone);
    near(m.heroSlide.height, Math.min(560, Math.max(240, m.heroSlot.width / ps.hero[2] + 15)));
    near(m.bannerFrame.height, Math.min(320, Math.max(90, m.bannerSlot.width / ps.banner[2] + 10)));
    expect(m.heroAfter).toBe("18px");
    near(m.text.width, m.root.width, 2);
    near(m.heroText.width, m.heroSlide.width, 2);
    // the next card still peeks in
    expect(m.card.width).toBeLessThan(m.rail.width / 2);
    await phoneCtx.close();

    // the full preview: the same sizes, still read only
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pv = await ctx.newPage();
    await loginAs(pv, fixtures.ownerToken);
    await enterWorkspace(pv, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await pv.goto(`/store/${slug}?home_preview=draft`);
    await expect(pv.getByTestId("store-home-draft-banner")).toBeVisible({ timeout: 30_000 });
    const heroSlot = pv.getByTestId("store-home").locator(`[data-block-id="${await idOf("hero")}"]`);
    await expect(heroSlot).toHaveClass(/sh-dh/);
    await expect(heroSlot).toHaveClass(/sh-tw/);
    const sent = writes(pv);
    await pv.getByTestId("store-home").locator('[data-block="products"] .store-card-link').first().click();
    await expect(pv.getByTestId("preview-blocked")).toHaveText(BLOCKED);
    expect(sent).toEqual([]);
    await ctx.close();
  });

  // ---------------- P3 (2026-11-22): «لوحة ترويجية» promo_grid

  test("«لوحة ترويجية» in the designer: an add card and a miniature; two empty tiles («أضيفي صورة») block «نشر» with clear reasons; tiles filled (image, titles, a button with its destination); layouts for the tile count (adjusted when a tile is added), the wide tile's part, the dividers; the live preview stays safe", async ({ page }) => {
    const frame = await openDesigner(page);
    await frame.getByTestId("home-add").click();
    await expect(frame.getByTestId("home-add-promo_grid")).toContainText("لوحة ترويجية");
    await frame.getByTestId("home-add-promo_grid").click();
    await expect(frame.getByTestId("promo-editor")).toBeVisible({ timeout: 30_000 });
    // two empty tiles to start with
    await expect(frame.getByTestId("tile-0-image-needed")).toBeVisible();
    await expect(frame.getByTestId("tile-1-image-needed")).toBeVisible();
    await expect(frame.getByTestId("promo-layout-even")).toBeChecked();
    await expect(frame.getByTestId("promo-layout-big_start")).toHaveCount(0);
    await saved(frame);
    await page.getByTestId("management-frame-back").click();
    await saved(frame);
    // «فحص قبل النشر»: the empty tiles are errors, «نشر» waits
    const errors = frame.getByTestId("home-checks").getByTestId("home-check-error");
    await expect(errors.filter({ hasText: "مكان صورة فارغ" })).toHaveCount(2, { timeout: 30_000 });
    await expect(errors.filter({ hasText: "بطاقة بلا عنوان عربي" })).toHaveCount(2);
    await expect(frame.getByTestId("home-publish")).toBeDisabled();
    const row = frame.locator('.shd-list > li[data-type="promo_grid"]');
    await expect(row).toContainText("أضيفي صورة");

    await row.getByRole("button", { name: /^تعديل/ }).last().click();
    const titles = ["فساتين السهرة", "بلايز الموسم", "تخفيضات"];
    for (let i = 0; i < 2; i += 1) {
      await frame.getByTestId(`tile-${i}-image-input`).setInputFiles(await image(1200, 900, ["#6d1f33", "#b08d57"][i]));
      await expect(frame.getByTestId(`tile-${i}-image-needed`)).toHaveCount(0, { timeout: 30_000 });
      await frame.getByTestId(`tile-${i}-title-ar`).fill(titles[i]);
    }
    await frame.getByTestId("tile-0-title-en").fill("Evening dresses");
    await frame.getByTestId("tile-0-text-ar").fill("قطع مختارة للمناسبات");
    // a button label without a destination is an error until both are set
    await frame.getByTestId("tile-0-button-ar").fill("تسوّقي");
    await saved(frame);
    await frame.getByTestId("tile-0-target-kind").selectOption("products");
    // two tiles: 60/40, a slanted divider
    await frame.getByTestId("promo-layout-start_wide").check();
    await frame.getByTestId("promo-divider-slant").check();
    // a third tile: the layout follows the count (60/40 is a two-tile layout)
    await frame.getByTestId("tiles-add").click();
    await expect(frame.getByTestId("promo-layout-even")).toBeChecked();
    await frame.getByTestId("tile-2-image-input").setInputFiles(await image(1200, 900, "#3a0c1a"));
    await expect(frame.getByTestId("tile-2-image-needed")).toHaveCount(0, { timeout: 30_000 });
    await frame.getByTestId("tile-2-title-ar").fill(titles[2]);
    await frame.getByTestId("promo-layout-big_end").check();
    await frame.getByTestId("promo-share-50").check();
    await frame.getByTestId("promo-divider-wave").check();
    await expect(frame.getByTestId("tiles-add")).toBeVisible();
    await saved(frame);

    // the live preview: the panel, its tiles; a tile's button does nothing there
    await showPreview(frame);
    const live = frame.getByTestId("home-preview");
    const panel = live.locator('[data-block="promo_grid"]');
    await expect(panel).toHaveAttribute("data-layout", "big_end");
    await expect(panel.locator(".sh-pg-tile")).toHaveCount(3);
    const sent = writes(page);
    await panel.getByTestId("home-tile-1-button").click();
    await expect(live.getByTestId("preview-blocked")).toHaveText(BLOCKED);
    expect(sent).toEqual([]);
    await showEdit(frame);
    await page.getByTestId("management-frame-back").click();
    await saved(frame);

    const draft = (await layoutRow(vendorId)).draft as { blocks: { type: string; layout?: string; share?: number; divider?: string; tiles?: unknown[] }[] };
    expect(draft.blocks.find((b) => b.type === "promo_grid")).toMatchObject({ layout: "big_end", share: 50, divider: "wave" });
    await expect(row.locator(".shd-mini-promo img")).toHaveCount(3);
    await expect(errors).toHaveCount(0, { timeout: 30_000 });
    await frame.getByTestId("home-publish").click();
    await expect(frame.getByTestId("home-toast")).toHaveText("نُشرت الصفحة الرئيسية. تراها المتسوقات الآن.", { timeout: 30_000 });
  });

  /** The panel's tiles as shoppers see them. */
  async function tiles(page: Page) {
    const panel = page.locator('[data-block="promo_grid"]');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity));
    const n = await panel.locator(".sh-pg-tile").count();
    const boxes = [];
    for (let i = 1; i <= n; i += 1) boxes.push((await panel.locator(`.sh-pg-tile.t${i}`).boundingBox())!);
    // never a cut text: each tile's text inside its tile, nothing hidden
    for (let i = 1; i <= n; i += 1) {
      const fits = await panel.locator(`.sh-pg-tile.t${i}`).evaluate((tile) => {
        const text = tile.querySelector(".sh-pg-text")!.getBoundingClientRect();
        const box = tile.getBoundingClientRect();
        return text.top >= box.top - 1 && text.bottom <= box.bottom + 1 && tile.scrollHeight <= tile.clientHeight + 1;
      });
      expect(fits).toBe(true);
    }
    const mask = await panel.locator(".sh-promo-grid").evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage);
    return { boxes, mask, panel };
  }
  const nearP = (a: number, b: number, tol = 3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

  test("«لوحة ترويجية» for shoppers: every layout of 2 / 3 / 4 tiles and every divider on a computer (RTL and LTR mirrored, images never) and a phone (stacked, the wide tile first; a 2x2 grid stays one); slanted and wave cuts on a computer only; no cut text, no sideways scroll; the full preview stays read only", async ({ browser }) => {
    const owner = await call<{ draft: { blocks: { id: string; type: string; tiles?: { image: unknown }[] }[] }; draft_version: number }>(`/vendors/${vendorId}/storefront/home`, { token: fixtures.ownerToken });
    const base = owner.body.draft.blocks.find((b) => b.type === "promo_grid")!;
    const images = base.tiles!.map((tile) => tile.image);
    let version = owner.body.draft_version;
    const configs: { n: number; layout: string; divider: string; share: number }[] = [
      { n: 3, layout: "big_end", divider: "wave", share: 50 }, // as the owner published it
      { n: 2, layout: "start_wide", divider: "slant", share: 60 },
      { n: 3, layout: "even", divider: "gap", share: 60 },
      { n: 4, layout: "grid", divider: "straight", share: 60 },
      { n: 4, layout: "big_start", divider: "gap", share: 60 },
    ];
    for (const [k, c] of configs.entries()) {
      if (k > 0) {
        const tilesN = Array.from({ length: c.n }, (_, i) => ({ image: images[i % images.length], title: { ar: `بلاطة ${i + 1}`, en: `Tile ${i + 1}` }, text: { ar: "وصف قصير للعرض", en: "" } }));
        const blocks = owner.body.draft.blocks.map((b) => (b.id === base.id ? { ...b, layout: c.layout, divider: c.divider, share: c.share, tiles: tilesN } : b));
        const put = await call<{ draft_version: number }>(`/vendors/${vendorId}/storefront/home/draft`, { method: "PUT", token: fixtures.ownerToken, body: { version, layout: { ...owner.body.draft, blocks } } });
        expect(put.status, JSON.stringify(put.body)).toBe(200);
        version = put.body.draft_version;
        const pub = await call<{ draft_version: number }>(`/vendors/${vendorId}/storefront/home/publish`, { method: "POST", token: fixtures.ownerToken, body: { version } });
        expect(pub.status, JSON.stringify(pub.body)).toBe(200);
      }
      // a computer, Arabic (RTL: the start is on the right)
      const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await openStore(desk);
      const first = await tiles(desk);
      let { boxes, mask } = first;
      const panel = first.panel;
      await expect(panel).toHaveAttribute("data-layout", c.layout);
      await expect(panel).toHaveAttribute("data-divider", c.divider);
      expect(boxes).toHaveLength(c.n);
      if (c.divider === "slant" || c.divider === "wave") expect(mask).toContain("svg");
      else expect(mask === "none" || mask === "").toBe(true);
      const [a, b] = boxes;
      if (c.n === 2) {
        expect(a.x).toBeGreaterThan(b.x); // the first tile at the start (right)
        nearP(a.width / b.width, 1.5, 0.08);
        nearP(a.y, b.y);
      } else if (c.layout === "even") {
        expect(a.x).toBeGreaterThan(b.x);
        nearP(a.width, b.width);
        nearP(a.y, boxes[2].y);
      } else if (c.layout === "grid") {
        nearP(a.y, b.y);
        expect(boxes[2].y).toBeGreaterThan(a.y + a.height - 1);
        nearP(a.width, b.width);
      } else {
        // the wide tile beside a stack of the others
        if (c.layout === "big_start") expect(a.x).toBeGreaterThan(b.x);
        else expect(a.x).toBeLessThan(b.x);
        nearP(a.height, boxes[c.n - 1].y + boxes[c.n - 1].height - b.y);
        if (c.share === 50) nearP(a.width, b.width, 6);
        else nearP(a.width / b.width, 1.5, 0.08);
      }
      await expectNoHorizontalOverflow(desk);
      await desk.close();

      // a computer, English: mirrored
      const enCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await enCtx.addInitScript(() => localStorage.setItem("finalpro_lang_pref", "en"));
      const en = await enCtx.newPage();
      await openStore(en);
      ({ boxes } = await tiles(en));
      if (c.layout === "big_end") expect(boxes[0].x).toBeGreaterThan(boxes[1].x);
      else if (c.layout !== "grid") expect(boxes[0].x).toBeLessThan(boxes[1].x);
      await expect(en.locator('[data-block="promo_grid"] .sh-pg-tile.t1 .sh-pg-title')).toHaveText(k === 0 ? "Evening dresses" : "Tile 1");
      await enCtx.close();

      // a phone: stacked, the wide tile first; a 2x2 grid stays a grid; no slanted / wave cut
      const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const phone = await phoneCtx.newPage();
      await openStore(phone);
      ({ boxes, mask } = await tiles(phone));
      expect(mask === "none" || mask === "").toBe(true);
      const full = boxes[0].width;
      if (c.layout === "grid") {
        nearP(boxes[0].y, boxes[1].y);
        expect(boxes[2].y).toBeGreaterThan(boxes[0].y + boxes[0].height - 1);
      } else if (c.n === 3 && c.layout !== "even") {
        // the wide tile across, the two others side by side under it
        expect(boxes[1].y).toBeGreaterThan(boxes[0].y + boxes[0].height - 1);
        nearP(boxes[1].y, boxes[2].y);
        expect(boxes[1].width).toBeLessThan(full / 2 + 2);
      } else {
        for (let i = 1; i < boxes.length; i += 1) {
          expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y + boxes[i - 1].height - 1);
          nearP(boxes[i].width, full);
        }
      }
      await expectNoHorizontalOverflow(phone);
      await phoneCtx.close();
    }

    // the full preview: a tile's button does nothing, no write leaves the browser
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pv = await ctx.newPage();
    await loginAs(pv, fixtures.ownerToken);
    await enterWorkspace(pv, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await pv.goto(`/store/${slug}?home_preview=draft`);
    await expect(pv.getByTestId("store-home-draft-banner")).toBeVisible({ timeout: 30_000 });
    const sent = writes(pv);
    const url = pv.url();
    const panel = pv.locator('[data-block="promo_grid"]');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await panel.locator(".sh-pg-title").first().click();
    expect(pv.url()).toBe(url);
    expect(sent).toEqual([]);
    await ctx.close();
  });

  test("the first full-width Hero starts at the top of the content panel: no gap, its top corners rounded like the panel, edge to edge; the owner's pencil floats over it (no row of its own, not over the title); the phone's jump link follows it; a Hero within the content keeps the spacing as before", async ({ browser }) => {
    async function publishHeroWidth(width: "full" | "content") {
      const owner = await call<{ draft: { blocks: { type: string; display?: Record<string, unknown> }[] }; draft_version: number }>(`/vendors/${vendorId}/storefront/home`, { token: fixtures.ownerToken });
      const blocks = owner.body.draft.blocks;
      expect(blocks[0].type).toBe("hero");
      blocks[0] = { ...blocks[0], display: { ...blocks[0].display, width } };
      const put = await call<{ draft_version: number }>(`/vendors/${vendorId}/storefront/home/draft`, { method: "PUT", token: fixtures.ownerToken, body: { version: owner.body.draft_version, layout: { ...owner.body.draft, blocks } } });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      const pub = await call(`/vendors/${vendorId}/storefront/home/publish`, { method: "POST", token: fixtures.ownerToken, body: { version: put.body.draft_version } });
      expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    }
    async function measureTop(page: Page) {
      await expect(page.getByTestId("store-home")).toBeVisible({ timeout: 30_000 });
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity));
      const panel = page.locator("section.store-products");
      const view = page.getByTestId("store-home").locator(".sh-slot").first().locator(".sh-hero-viewport");
      const p = (await panel.boundingBox())!;
      const h = (await view.boundingBox())!;
      const radius = async (loc: typeof panel) => loc.evaluate((el) => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el).borderTopRightRadius, getComputedStyle(el).borderBottomLeftRadius]);
      return { p, h, panelR: await radius(panel), heroR: await radius(view), flush: await panel.evaluate((el) => el.classList.contains("has-flush-hero")) };
    }

    await publishHeroWidth("full");
    for (const [viewport, mobile] of [[{ width: 1280, height: 900 }, false], [{ width: 390, height: 844 }, true]] as const) {
      const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
      const page = await ctx.newPage();
      await openStore(page);
      const m = await measureTop(page);
      expect(m.flush).toBe(true);
      nearP(m.h.y, m.p.y, 1);
      nearP(m.h.x, m.p.x, 1);
      nearP(m.h.x + m.h.width, m.p.x + m.p.width, 1);
      // the panel's own top corners, square at the bottom, the image clipped
      expect(m.heroR[0]).toBe(m.panelR[0]);
      expect(m.heroR[1]).toBe(m.panelR[1]);
      expect(parseFloat(m.heroR[0])).toBeGreaterThan(0);
      expect(m.heroR[2]).toBe("0px");
      expect(await page.getByTestId("store-home").locator(".sh-hero-viewport").first().evaluate((el) => getComputedStyle(el).overflow)).toBe("hidden");
      // shoppers: no pencil
      await expect(page.getByTestId("store-home-design")).toHaveCount(0);
      if (mobile) {
        // the jump link follows the Hero
        const link = (await page.getByTestId("store-jump-products").boundingBox())!;
        expect(link.y).toBeGreaterThan(m.h.y + m.h.height - 1);
      }
      await expectNoHorizontalOverflow(page);
      await ctx.close();
    }

    // the owner: the pencil floats over the Hero - no row, not over its title
    const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const ownerPage = await ownerCtx.newPage();
    await openStore(ownerPage, fixtures.ownerToken);
    const om = await measureTop(ownerPage);
    expect(om.flush).toBe(true);
    nearP(om.h.y, om.p.y, 1);
    const pencil = (await ownerPage.getByTestId("store-home-design").boundingBox())!;
    expect(pencil.y).toBeGreaterThanOrEqual(om.h.y);
    expect(pencil.y + pencil.height).toBeLessThan(om.h.y + om.h.height);
    const title = await ownerPage.getByTestId("store-home").locator(".sh-hero-slide[data-active] .sh-hero-title").first().boundingBox();
    if (title) {
      const overlap = !(pencil.x + pencil.width <= title.x || title.x + title.width <= pencil.x || pencil.y + pencil.height <= title.y || title.y + title.height <= pencil.y);
      expect(overlap).toBe(false);
    }
    await expect(ownerPage.getByTestId("store-home-design")).toBeVisible();
    await ownerCtx.close();

    // a Hero within the content: the spacing and corners as before
    await publishHeroWidth("content");
    const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openStore(desk);
    const m = await measureTop(desk);
    expect(m.flush).toBe(false);
    expect(m.h.y).toBeGreaterThan(m.p.y + 20);
    expect(m.h.x).toBeGreaterThan(m.p.x + 10);
    await desk.close();
  });
});
