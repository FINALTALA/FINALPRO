import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { loginAs } from "./helpers/session";
import { pickText, sizeName } from "../src/lib/localized";

// TB-25: store and product data, and the pages' own words, in the
// interface language - the store page, discovery, the women listing, the
// product page, the comparison, favourites, the cart, checkout, the
// orders and the review panel. English shows the English field when it
// exists and the Arabic only as the fallback for a missing translation.
//
// The English check is strict: no Arabic letter may remain on the page
// EXCEPT the explicit allowlist below - the store's own one-language free
// text (name, hero title, bio, branch name) and the Arabic of the one
// product that has no English name (the fallback). Nothing that has an
// English translation may appear in Arabic.

const ARABIC = /[؀-ۿ]/;
const FIXTURES = path.join(__dirname, "fixtures", "tb25");
const API_BASE = process.env.PW_API_BASE_URL;
const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 390, height: 800 },
];
type Lang = "ar" | "en";

const TAG = unique("t").slice(-6);
const STORE = {
  name: `متجر تجربة ${TAG}`,
  hero: `عنوان المتجر بالعربية ${TAG}`,
  bio: `وصف المتجر بالعربية فقط ${TAG}`,
  branch: `فرع رام الله ${TAG}`,
};
const DRESS = { ar: `فستان تجريبي ${TAG}`, en: `TB25 Dress ${TAG}`, specsAr: "قماش ناعم وتنورة واسعة", specsEn: "Smooth fabric and a full skirt" };
const SKIRT_AR = `تنورة بلا ترجمة ${TAG}`; // no English name at all: the fallback
const CATEGORY = { ar: `فئة تجريبية ${TAG}`, en: `TB25 Category ${TAG}` };

/** In English: no Arabic letter once the allowlisted free text is taken out.
 * The store name's first letter, standing alone, is the logo placeholder of
 * a store without a logo - the store's own data, so it is allowed too. */
function arabicLeft(text: string, allow: string[]): string[] {
  let rest = text;
  for (const a of allow) rest = rest.split(a).join("");
  const initial = STORE.name.slice(0, 1);
  return rest.split("\n").filter((line) => ARABIC.test(line) && line.trim() !== initial);
}
const ALLOW = [STORE.name, STORE.hero, STORE.bio, STORE.branch, SKIRT_AR];

test.describe("TB-25: pure language rules", () => {
  test("pickText: English when present and not blank, otherwise the Arabic - never empty", () => {
    expect(pickText("en", "Dress", "فستان")).toBe("Dress");
    expect(pickText("en", "", "فستان")).toBe("فستان");
    expect(pickText("en", "   ", "فستان")).toBe("فستان");
    expect(pickText("en", null, "فستان")).toBe("فستان");
    expect(pickText("ar", "Dress", "فستان")).toBe("فستان");
    expect(pickText("en", "Dress", null)).toBe("Dress");
  });
  test("sizeName: age sizes in English, the label otherwise", () => {
    expect(sizeName("AGE_4_5Y", "4–5 سنوات", "en")).toBe("4–5 years");
    expect(sizeName("AGE_4_5Y", "4–5 سنوات", "ar")).toBe("4–5 سنوات");
    expect(sizeName("EU_38", "38", "en")).toBe("38");
  });
});

test.describe("TB-25: store and product data and the pages' words by language", () => {
  test.describe.configure({ mode: "serial" });

  let slug = "";
  let dressOfferId = "";
  let dressProductId = "";
  let shopper = { id: "", token: "" };

  async function signIn(): Promise<{ id: string; token: string }> {
    const phone = uniquePhone();
    const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" } });
    await prisma.customerProfile.create({ data: { userId: user.id } });
    const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
    if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
    return { id: user.id, token: res.body.session_token };
  }

  test.beforeAll(async () => {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique("tb25p-store").toLowerCase(),
        legalName: unique("L"),
        displayName: STORE.name,
        heroTitle: STORE.hero,
        bio: STORE.bio,
        status: "ACTIVE",
        subscriptionStatus: "ACTIVE",
        storefrontPublished: true,
      },
    });
    slug = vendor.slug;
    const vendorId = vendor.id;
    const branchId = (
      await prisma.storeBranch.create({ data: { vendorId, name: STORE.branch, isPhysical: true, verificationStatus: "APPROVED" } })
    ).id;
    const owner = await signIn();
    await prisma.vendorUser.create({ data: { userId: owner.id, vendorId, role: "OWNER" } });
    shopper = await signIn();

    const form = new FormData();
    form.append("file", new Blob([readFileSync(path.join(FIXTURES, "red-1.png"))], { type: "image/png" }), "red-1.png");
    const up = await fetch(`${API_BASE}/vendors/${vendorId}/uploads`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}` }, body: form });
    const image = ((await up.json()) as { url: string }).url;

    const brand = await prisma.brand.create({ data: { name: `TB25 ${TAG}`, normalizedName: unique("tb25-brand") } });
    const category = await prisma.category.create({ data: { nameAr: CATEGORY.ar, nameEn: CATEGORY.en } });

    /** A classified, matched product with one RED variant per size. */
    async function product(nameAr: string, nameEn: string, sizes: string[], specs?: { ar: string; en: string }) {
      const cp = await prisma.canonicalProduct.create({
        data: { brandId: brand.id, categoryId: category.id, modelName: unique("m"), canonicalNameAr: nameAr, canonicalNameEn: nameEn, status: "PUBLISHED" },
      });
      const offer = await prisma.vendorOffer.create({
        data: { vendorId, titleAr: nameAr, titleEn: nameEn, status: "ACTIVE", canonicalProductId: cp.id, taxonomyVersion: 1, requiresTaxonomy: true },
      });
      await prisma.vendorOfferAudience.create({ data: { vendorId, vendorOfferId: offer.id, audience: "WOMEN" } });
      await prisma.vendorOfferCategory.create({ data: { vendorId, vendorOfferId: offer.id, categoryCode: "DRESSES_WOMEN" } });
      const variants: Record<string, string> = {};
      for (const size of sizes) {
        const cv = await prisma.canonicalProductVariant.create({
          data: { canonicalProductId: cp.id, structuralAttributes: { size }, platformProductBarcode: unique("pb") },
        });
        const v = await prisma.offerVariant.create({
          data: {
            vendorId, vendorOfferId: offer.id, sellerSku: unique("sku"), storeInventoryBarcode: unique("sib"), basePrice: 150,
            isCombination: true, colorCode: "RED", sizeCode: size, canonicalVariantId: cv.id,
            specsTextAr: specs?.ar ?? null, specsTextEn: specs?.en ?? null,
          },
        });
        await prisma.branchStock.create({ data: { vendorId, branchId, offerVariantId: v.id, quantity: 9 } });
        await prisma.offerVariantMedia.create({ data: { vendorId, offerVariantId: v.id, url: image, kind: "PRIMARY", mediaType: "IMAGE", sortOrder: 0 } });
        variants[size] = v.id;
      }
      return { productId: cp.id, offerId: offer.id, variants };
    }
    const dress = await product(DRESS.ar, DRESS.en, ["S", "M"], { ar: DRESS.specsAr, en: DRESS.specsEn });
    dressOfferId = dress.offerId;
    dressProductId = dress.productId;
    await product(SKIRT_AR, "", ["M"]);

    // The shopper's favourite, cart line and a completed order of the dress (M, RED).
    const fav = await call("/favorites", { method: "POST", token: shopper.token, body: { target_type: "PRODUCT", canonical_product_id: dress.productId } });
    expect([200, 201]).toContain(fav.status);
    const cart = await call("/cart/items", {
      method: "POST", token: shopper.token, idempotencyKey: unique("cart"),
      body: { vendor_id: vendorId, offer_variant_id: dress.variants.S, quantity: 1 },
    });
    expect(cart.status).toBe(201);
    const profile = await prisma.customerProfile.findUniqueOrThrow({ where: { userId: shopper.id } });
    const customerOrder = await prisma.customerOrder.create({ data: { customerId: profile.id } });
    const order = await prisma.branchOrder.create({
      data: {
        customerOrderId: customerOrder.id, vendorId, branchId, fulfilmentMethod: "PICKUP", paymentMethod: "COD", status: "COMPLETED",
        subtotal: 150, total: 150, pickupCode: String(Math.floor(100000 + Math.random() * 899999)),
        pickedUpAt: new Date(Date.now() - 86_400_000), codCollectedAt: new Date(Date.now() - 86_400_000),
      },
    });
    await prisma.branchOrderItem.create({
      data: {
        vendorId, branchOrderId: order.id, offerVariantId: dress.variants.M, quantity: 1, unitPrice: 150,
        titleArSnapshot: DRESS.ar, titleEnSnapshot: DRESS.en, colorCodeSnapshot: "RED", colorLabelSnapshot: "أحمر", sizeCodeSnapshot: "M", sizeLabelSnapshot: "M",
      },
    });
  });

  test.afterAll(async () => {
    // Always - also after a failure: the account goes back to Arabic.
    if (shopper.id) await prisma.user.update({ where: { id: shopper.id }, data: { languagePref: "ar" } });
  });

  async function view(browser: Browser, lang: Lang, viewport: { width: number; height: number }, url: string, signedIn = false) {
    if (signedIn) await prisma.user.update({ where: { id: shopper.id }, data: { languagePref: lang } });
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
    await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
    const page = await context.newPage();
    if (signedIn) await loginAs(page, shopper.token);
    await page.goto(url);
    await expect(page.locator("html")).toHaveAttribute("dir", lang === "en" ? "ltr" : "rtl");
    return { context, page };
  }

  /** The page's words and data in `lang`: the expected texts are shown; in
   * English no Arabic remains but the allowlist; in Arabic no English
   * product/category name (it has an Arabic one). */
  async function checkLanguage(page: Page, lang: Lang, expected: Record<Lang, string[]>, othersData = false) {
    const main = page.locator("main").first();
    for (const text of expected[lang]) await expect(main).toContainText(text, { timeout: 30_000 });
    // A shared listing also shows other spec files' products and collections
    // (their data, not this page's words): they are left out of the strict
    // check - this file's own product cards and every word of the page stay in.
    const content = othersData
      ? await main.evaluate((el, ours) => {
          const copy = el.cloneNode(true) as HTMLElement;
          copy.querySelectorAll('[data-testid="product-card"]').forEach((card) => {
            if (!ours.includes(card.getAttribute("data-product-id") ?? "")) card.remove();
          });
          copy.querySelectorAll(".collection-showcase, .collection-links").forEach((s) => s.remove());
          copy.style.position = "absolute";
          document.body.appendChild(copy);
          const text = copy.innerText;
          copy.remove();
          return text;
        }, [dressProductId])
      : await main.innerText();
    if (lang === "en") expect(arabicLeft(content, ALLOW)).toEqual([]);
    else for (const text of [DRESS.en, CATEGORY.en]) expect(content).not.toContain(text);
  }

  const PAGES: { name: string; url: () => string; signedIn?: boolean; othersData?: boolean; expected: Record<Lang, string[]>; ready?: (page: Page) => Promise<void> }[] = [
    {
      name: "store page",
      url: () => `/store/${slug}`,
      expected: { ar: [DRESS.ar, SKIRT_AR, STORE.hero, "معلومات المتجر"], en: [DRESS.en, SKIRT_AR, STORE.hero, "Store information", "All store products"] },
    },
    {
      name: "discovery search",
      url: () => `/discovery?q=${TAG}`,
      expected: { ar: [DRESS.ar, SKIRT_AR, "المنتجات"], en: [DRESS.en, SKIRT_AR, "Products", CATEGORY.en] },
    },
    {
      name: "women listing",
      url: () => `/women?category=DRESSES_WOMEN`,
      othersData: true,
      ready: async (page) => {
        await expect(page.locator(`[data-product-id="${dressProductId}"]`)).toBeVisible({ timeout: 30_000 });
      },
      expected: { ar: [DRESS.ar], en: [DRESS.en, "Categories", "Trending"] },
    },
    {
      name: "product page",
      url: () => `/store/${slug}/products/${dressOfferId}`,
      othersData: true, // «You may also like» shows other files' products
      ready: async (page) => {
        await page.locator(".pdp-sizes .pdp-size", { hasText: /^M$/ }).click();
        await page.locator(".pdp-section-head", { hasText: /الوصف|Description/ }).click();
      },
      expected: { ar: [DRESS.ar, "أحمر", DRESS.specsAr, "الوصف", "سجّلي الدخول للشراء"], en: [DRESS.en, "Red", DRESS.specsEn, "Description", "Sign in to buy"] },
    },
    {
      name: "comparison",
      url: () => `/compare/${dressProductId}`,
      expected: { ar: [DRESS.ar, "افتحي في المتجر"], en: [DRESS.en, "Open in the store"] },
    },
    {
      name: "favourites",
      url: () => `/account/favorites`,
      signedIn: true,
      expected: { ar: [DRESS.ar, "المفضلة"], en: [DRESS.en, "Favourites"] },
    },
    {
      name: "cart",
      url: () => `/cart`,
      signedIn: true,
      expected: { ar: [DRESS.ar, "متابعة للدفع"], en: [DRESS.en, "Continue to payment"] },
    },
    {
      name: "orders",
      url: () => `/cart?tab=orders`,
      signedIn: true,
      expected: { ar: [DRESS.ar, "أحمر / M", "قيّمي المنتج"], en: [DRESS.en, "Red / M", "Review the product", "Pickup from the shop"] },
    },
  ];

  for (const p of PAGES) {
    for (const lang of ["ar", "en"] as const) {
      for (const viewport of VIEWPORTS) {
        test(`${p.name} - ${lang} ${viewport.width}px`, async ({ browser }) => {
          const { context, page } = await view(browser, lang, viewport, p.url(), p.signedIn);
          if (p.ready) await p.ready(page);
          await checkLanguage(page, lang, p.expected, p.othersData);
          await expectNoHorizontalOverflow(page);
          await context.close();
        });
      }
    }
  }

  for (const lang of ["ar", "en"] as const) {
    test(`checkout (from the cart) - ${lang}`, async ({ browser }) => {
      const { context, page } = await view(browser, lang, VIEWPORTS[0], "/cart", true);
      await page.locator(".cart-summary-card .button").click();
      const dialog = page.locator(".checkout-dialog");
      await expect(dialog).toBeVisible();
      const words = lang === "en" ? [DRESS.en, "Checkout", "Branch", "Payment method", "Continue"] : [DRESS.ar, "إتمام الطلب", "الفرع", "طريقة الدفع"];
      for (const w of words) await expect(dialog).toContainText(w, { timeout: 30_000 });
      const content = await dialog.innerText();
      if (lang === "en") expect(arabicLeft(content, ALLOW)).toEqual([]);
      else expect(content).not.toContain(DRESS.en);
      await context.close();
    });

    test(`review panel (from the orders) - ${lang}`, async ({ browser }) => {
      const { context, page } = await view(browser, lang, VIEWPORTS[0], "/cart?tab=orders", true);
      await page.locator(".customer-order-review-cta", { hasText: lang === "en" ? "Review the product" : "قيّمي المنتج" }).click();
      const dialog = page.locator(".rv-dialog");
      await expect(dialog).toBeVisible();
      const words = lang === "en"
        ? ["Review the product", DRESS.en, "Colour: Red · Size: M", "Your rating", "Publish review"]
        : ["قيّمي المنتج", DRESS.ar, "اللون: أحمر · المقاس: M", "تقييمك", "نشر التقييم"];
      for (const w of words) await expect(dialog).toContainText(w);
      if (lang === "en") expect(arabicLeft(await dialog.innerText(), ALLOW)).toEqual([]);
      await context.close();
    });
  }

  test("switching the language without a reload renames the data on the product page and the store page", async ({ browser }) => {
    for (const url of [`/store/${slug}/products/${dressOfferId}`, `/store/${slug}`]) {
      const { context, page } = await view(browser, "ar", VIEWPORTS[0], url);
      await expect(page.locator("main")).toContainText(DRESS.ar, { timeout: 30_000 });
      await page.evaluate(() => {
        localStorage.setItem("finalpro_lang_pref", "en");
        window.dispatchEvent(new Event("finalpro:lang"));
      });
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
      await expect(page.locator("main")).toContainText(DRESS.en);
      await expect(page.locator("main")).not.toContainText(DRESS.ar);
      await context.close();
    }
  });
});
