import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { loginAs } from "./helpers/session";
import { colorThumbnails, type ThumbVariant } from "../src/lib/colorThumbnails";

// TB-25.3: choosing a colour by image on the product page. One thumbnail
// per colour from that colour's own images (its first PRIMARY image, or
// its first image by order when it has no PRIMARY), the colour circle
// when it has no image at all; choosing one switches the gallery to that
// colour's images and runs the same colour change as before - variant,
// size, stock and cart logic unchanged. Arabic and English, RTL/LTR,
// desktop and phone, keyboard. The images are this spec's own tiny
// committed fixtures (e2e/fixtures/tb25), uploaded through the store's
// own upload route - never any real product photo.

const FIXTURES = path.join(__dirname, "fixtures", "tb25");
const API_BASE = process.env.PW_API_BASE_URL;
const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 390, height: 800 },
];
type Lang = "ar" | "en";
const NAMES: Record<string, Record<Lang, string>> = {
  RED: { ar: "أحمر", en: "Red" },
  BLUE: { ar: "أزرق", en: "Blue" },
  GREEN: { ar: "أخضر", en: "Green" },
  BLACK: { ar: "أسود", en: "Black" },
};

test.describe("TB-25.3: colorThumbnails (pure)", () => {
  const media = (url: string, kind: "PRIMARY" | "ADDITIONAL", sort: number, type: "IMAGE" | "VIDEO" = "IMAGE") => ({
    url, kind, media_type: type, alt_text_ar: `ar ${url}`, alt_text_en: `en ${url}`, sort_order: sort,
  });

  test("the colour's own PRIMARY image, never another colour's", () => {
    const variants: ThumbVariant[] = [
      { color_code: "RED", media: [media("red-extra", "ADDITIONAL", 0), media("red-main", "PRIMARY", 1)] },
      { color_code: "BLUE", media: [media("blue-main", "PRIMARY", 0)] },
    ];
    const t = colorThumbnails(variants, ["RED", "BLUE"]);
    expect(t.RED?.url).toBe("red-main");
    expect(t.BLUE?.url).toBe("blue-main");
    expect(t.RED?.alt_en).toBe("en red-main");
  });

  test("no PRIMARY: the first image by its order; videos are never thumbnails", () => {
    const t = colorThumbnails(
      [{ color_code: "GREEN", media: [media("clip", "ADDITIONAL", 0, "VIDEO"), media("g-2", "ADDITIONAL", 2), media("g-1", "ADDITIONAL", 1)] }],
      ["GREEN"],
    );
    expect(t.GREEN?.url).toBe("g-1");
  });

  test("a colour with no image gets null (the page shows its circle)", () => {
    const t = colorThumbnails([{ color_code: "BLACK", media: [] }, { color_code: "RED" }], ["BLACK", "RED", "PINK"]);
    expect(t).toEqual({ BLACK: null, RED: null, PINK: null });
  });

  test("the first PRIMARY among a colour's variants, in the API's order", () => {
    const t = colorThumbnails(
      [
        { color_code: "RED", media: [media("r-s", "ADDITIONAL", 0)] },
        { color_code: "RED", media: [media("r-m-main", "PRIMARY", 0)] },
        { color_code: "RED", media: [media("r-l-main", "PRIMARY", 0)] },
      ],
      ["RED"],
    );
    expect(t.RED?.url).toBe("r-m-main");
  });
});

test.describe("TB-25.3: colour choice by image on the product page", () => {
  test.describe.configure({ mode: "serial" });

  let slug = "";
  let offerId = "";
  let price = "";
  let shopper: { id: string; token: string } = { id: "", token: "" };
  const urls: Record<string, string> = {};
  const variantIds: Record<string, string> = {};
  /** Each colour's gallery, in the page's order (PRIMARY first, then by order). */
  const gallery: Record<string, string[]> = {};
  const thumb: Record<string, string | null> = {};

  async function signIn(): Promise<{ id: string; token: string }> {
    const phone = uniquePhone();
    const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" } });
    await prisma.customerProfile.create({ data: { userId: user.id } });
    const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
    if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
    return { id: user.id, token: res.body.session_token };
  }

  async function upload(vendorId: string, token: string, file: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(path.join(FIXTURES, file))], { type: "image/png" }), file);
    const res = await fetch(`${API_BASE}/vendors/${vendorId}/uploads`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    const body = (await res.json()) as { url?: string };
    if (res.status !== 201 || !body.url) throw new Error(`upload ${file} failed (status ${res.status})`);
    return body.url;
  }

  test.beforeAll(async () => {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique("tb25t-store").toLowerCase(),
        legalName: unique("L"),
        displayName: "TB25 Thumbs",
        status: "ACTIVE",
        subscriptionStatus: "ACTIVE",
        storefrontPublished: true,
      },
    });
    slug = vendor.slug;
    const branchId = (
      await prisma.storeBranch.create({ data: { vendorId: vendor.id, name: "TB25 Branch", isPhysical: true, verificationStatus: "APPROVED" } })
    ).id;
    const owner = await signIn();
    await prisma.vendorUser.create({ data: { userId: owner.id, vendorId: vendor.id, role: "OWNER" } });
    shopper = await signIn();

    for (const f of ["red-1", "red-2", "blue-1", "blue-2", "green-1", "green-2"]) urls[f] = await upload(vendor.id, owner.token, `${f}.png`);

    const offer = await prisma.vendorOffer.create({
      data: { vendorId: vendor.id, titleAr: "فستان TB25", titleEn: "TB25 Dress", status: "ACTIVE", taxonomyVersion: 1, requiresTaxonomy: true },
    });
    offerId = offer.id;
    await prisma.vendorOfferAudience.create({ data: { vendorId: vendor.id, vendorOfferId: offer.id, audience: "WOMEN" } });
    await prisma.vendorOfferCategory.create({ data: { vendorId: vendor.id, vendorOfferId: offer.id, categoryCode: "DRESSES_WOMEN" } });
    price = "180";

    // RED: S and M (PRIMARY then ADDITIONAL); BLUE: S only (its PRIMARY
    // inserted after the ADDITIONAL); GREEN: M only, no PRIMARY at all;
    // BLACK: S and M, no image (the circle).
    const combos: [string, string][] = [["RED", "S"], ["RED", "M"], ["BLUE", "S"], ["GREEN", "M"], ["BLACK", "S"], ["BLACK", "M"]];
    for (const [color, size] of combos) {
      const v = await prisma.offerVariant.create({
        data: {
          vendorId: vendor.id, vendorOfferId: offer.id, sellerSku: unique("sku"), storeInventoryBarcode: unique("sib"),
          basePrice: Number(price), isCombination: true, colorCode: color, sizeCode: size,
        },
      });
      variantIds[`${color}-${size}`] = v.id;
      await prisma.branchStock.create({ data: { vendorId: vendor.id, branchId, offerVariantId: v.id, quantity: 5 } });
      const add = (url: string, kind: "PRIMARY" | "ADDITIONAL", sortOrder: number) =>
        prisma.offerVariantMedia.create({ data: { vendorId: vendor.id, offerVariantId: v.id, url, kind, mediaType: "IMAGE", sortOrder } });
      if (color === "RED") { await add(urls["red-1"], "PRIMARY", 0); await add(urls["red-2"], "ADDITIONAL", 1); }
      if (color === "BLUE") { await add(urls["blue-2"], "ADDITIONAL", 1); await add(urls["blue-1"], "PRIMARY", 0); }
      if (color === "GREEN") { await add(urls["green-2"], "ADDITIONAL", 2); await add(urls["green-1"], "ADDITIONAL", 1); }
    }
    gallery.RED = [urls["red-1"], urls["red-2"]];
    gallery.BLUE = [urls["blue-1"], urls["blue-2"]];
    gallery.GREEN = [urls["green-1"], urls["green-2"]];
    thumb.RED = urls["red-1"];
    thumb.BLUE = urls["blue-1"];
    thumb.GREEN = urls["green-1"];
    thumb.BLACK = null;
  });

  test.afterAll(async () => {
    if (shopper.id) await prisma.user.update({ where: { id: shopper.id }, data: { languagePref: "ar" } });
  });

  async function open(browser: Browser, lang: Lang, viewport: { width: number; height: number }, signedIn = false) {
    if (signedIn) await prisma.user.update({ where: { id: shopper.id }, data: { languagePref: lang } });
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
    await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
    const page = await context.newPage();
    if (signedIn) await loginAs(page, shopper.token);
    await page.goto(`/store/${slug}/products/${offerId}`);
    await expect(page.locator("html")).toHaveAttribute("dir", lang === "en" ? "ltr" : "rtl");
    await expect(page.locator(".pdp-color-thumb")).toHaveCount(4, { timeout: 30_000 });
    return { context, page };
  }
  const thumbs = (page: Page) => page.locator(".pdp-color-thumbs [role=radio]");
  const galleryUrls = (page: Page) =>
    page.locator(".pdp-gallery img").evaluateAll((imgs) => [...new Set(imgs.map((i) => (i as HTMLImageElement).getAttribute("src") ?? ""))]);

  for (const lang of ["ar", "en"] as const) {
    for (const viewport of VIEWPORTS) {
      test(`${lang} ${viewport.width}px: one thumbnail per colour from its own images, the circle without one; choosing switches the gallery`, async ({ browser }) => {
        const { context, page } = await open(browser, lang, viewport);
        await expect(page.locator(".pdp-color-thumbs")).toHaveAttribute("role", "radiogroup");
        await expect(page.locator(".pdp-color-thumbs")).toHaveAttribute("aria-label", lang === "en" ? "Colour" : "اللون");
        const order = await thumbs(page).evaluateAll((b) => b.map((x) => x.getAttribute("data-color") ?? ""));
        expect(order.sort()).toEqual(["BLACK", "BLUE", "GREEN", "RED"]);
        for (const color of ["RED", "BLUE", "GREEN", "BLACK"]) {
          const button = page.locator(`.pdp-color-thumb[data-color="${color}"]`);
          await expect(button).toHaveAttribute("aria-label", NAMES[color][lang]);
          if (thumb[color]) {
            await expect(button.locator("img")).toHaveAttribute("src", thumb[color]!);
            await expect(button).not.toHaveClass(/is-swatch/);
          } else {
            await expect(button.locator("img")).toHaveCount(0);
            await expect(button).toHaveClass(/is-swatch/);
            await expect(button.locator(".pdp-color-thumb-swatch")).toBeVisible();
          }
        }
        for (const color of ["BLUE", "GREEN", "RED"]) {
          await page.locator(`.pdp-color-thumb[data-color="${color}"]`).click();
          await expect(page.getByTestId("pdp-color-name")).toHaveText(NAMES[color][lang]);
          await expect.poll(() => galleryUrls(page)).toEqual(gallery[color]);
          // The chosen one alone is checked and framed.
          const states = await thumbs(page).evaluateAll((b) => b.map((x) => [x.getAttribute("data-color"), x.getAttribute("aria-checked"), x.classList.contains("active")]));
          for (const [c, checked, active] of states) {
            expect(checked).toBe(c === color ? "true" : "false");
            expect(active).toBe(c === color);
          }
          // The frame fades in (transition: border-color .15s from transparent):
          // read it once it has settled, not in the transition's first frame.
          await expect
            .poll(() => page.locator(`.pdp-color-thumb[data-color="${color}"]`).evaluate((el) => getComputedStyle(el).borderTopColor))
            .not.toBe("rgba(0, 0, 0, 0)");
        }
        // A colour without images keeps the page's existing fallback (no crash, no other colour's photo as its thumbnail).
        await page.locator('.pdp-color-thumb[data-color="BLACK"]').click();
        await expect(page.getByTestId("pdp-color-name")).toHaveText(NAMES.BLACK[lang]);
        await expectNoHorizontalOverflow(page);
        await context.close();
      });
    }
  }

  for (const lang of ["ar", "en"] as const) {
    test(`${lang}: keyboard - one tab stop, arrows follow the reading direction and choose, Home/End jump`, async ({ browser }) => {
      const { context, page } = await open(browser, lang, VIEWPORTS[0]);
      const tabbable = await thumbs(page).evaluateAll((b) => b.filter((x) => (x as HTMLElement).tabIndex === 0).length);
      expect(tabbable).toBe(1);
      const codes = await thumbs(page).evaluateAll((b) => b.map((x) => x.getAttribute("data-color") ?? ""));
      const checked = () => page.locator('.pdp-color-thumbs [aria-checked="true"]').getAttribute("data-color");
      const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-color") ?? null);
      // The page opens on its first available combination's colour - the one tab stop.
      const start = codes.indexOf((await checked()) ?? "");
      expect(start).toBeGreaterThanOrEqual(0);
      await page.locator('.pdp-color-thumbs [tabindex="0"]').focus();
      expect(await focused()).toBe(codes[start]);
      const forward = lang === "en" ? "ArrowRight" : "ArrowLeft";
      const back = lang === "en" ? "ArrowLeft" : "ArrowRight";
      await page.keyboard.press(forward);
      await expect.poll(checked).toBe(codes[(start + 1) % codes.length]);
      expect(await focused()).toBe(codes[(start + 1) % codes.length]);
      await page.keyboard.press(back);
      await expect.poll(checked).toBe(codes[start]);
      await page.keyboard.press("End");
      await expect.poll(checked).toBe(codes[codes.length - 1]);
      expect(await focused()).toBe(codes[codes.length - 1]);
      await page.keyboard.press("Home");
      await expect.poll(checked).toBe(codes[0]);
      await page.keyboard.press("ArrowDown");
      await expect.poll(checked).toBe(codes[1]);
      // The chosen colour is now the only tab stop.
      const stop = await thumbs(page).evaluateAll((b) => b.filter((x) => (x as HTMLElement).tabIndex === 0).map((x) => x.getAttribute("data-color")));
      expect(stop).toEqual([codes[1]]);
      await expect(page.locator(`.pdp-color-thumb[data-color="${codes[1]}"]`)).toBeFocused();
      await context.close();
    });
  }

  test("unchanged logic: size kept or cleared exactly as before, price and stock unchanged, the cart gets the chosen colour-and-size variant", async ({ browser }) => {
    const { context, page } = await open(browser, "en", VIEWPORTS[0], true);
    await expect(page.locator(".pdp-price-now")).toContainText(price);
    await page.locator('.pdp-color-thumb[data-color="RED"]').click();
    await page.locator(".pdp-sizes .pdp-size", { hasText: /^M$/ }).click();
    await expect(page.locator('.pdp-sizes [aria-checked="true"]')).toHaveText("M");
    // BLUE has no M: the size is cleared (the old rule); its S is offered, M disabled.
    await page.locator('.pdp-color-thumb[data-color="BLUE"]').click();
    await expect(page.locator('.pdp-sizes [aria-checked="true"]')).toHaveCount(0);
    await expect(page.locator(".pdp-sizes .pdp-size", { hasText: /^M$/ })).toBeDisabled();
    await expect(page.locator(".pdp-sizes .pdp-size", { hasText: /^S$/ })).toBeEnabled();
    // GREEN has M: choose it and add - the request carries exactly GREEN-M.
    await page.locator('.pdp-color-thumb[data-color="GREEN"]').click();
    await page.locator(".pdp-sizes .pdp-size", { hasText: /^M$/ }).click();
    await expect(page.locator(".pdp-price-now")).toContainText(price);
    await expect(page.locator(".availability-badge").first()).toHaveText("In stock");
    const request = page.waitForRequest((r) => r.url().endsWith("/cart/items") && r.method() === "POST");
    await page.locator(".pdp-cart").click();
    const body = JSON.parse((await request).postData() ?? "{}") as { offer_variant_id?: string; quantity?: number };
    expect(body.offer_variant_id).toBe(variantIds["GREEN-M"]);
    expect(body.quantity).toBe(1);
    await expect(page.locator(".notice-banner")).toContainText("Added to your cart");
    await context.close();
    const cart = await call<{ offer_variant_id: string }[]>("/cart", { token: shopper.token });
    expect(cart.body.map((i) => i.offer_variant_id)).toContain(variantIds["GREEN-M"]);
  });

  test("switching the language without a reload renames the colours and keeps the chosen one", async ({ browser }) => {
    const { context, page } = await open(browser, "ar", VIEWPORTS[0]);
    await page.locator('.pdp-color-thumb[data-color="BLUE"]').click();
    await expect(page.getByTestId("pdp-color-name")).toHaveText("أزرق");
    await page.evaluate(() => {
      localStorage.setItem("finalpro_lang_pref", "en");
      window.dispatchEvent(new Event("finalpro:lang"));
    });
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByTestId("pdp-color-name")).toHaveText("Blue");
    await expect(page.locator('.pdp-color-thumb[data-color="BLUE"]')).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => galleryUrls(page)).toEqual(gallery.BLUE);
    await context.close();
  });
});
