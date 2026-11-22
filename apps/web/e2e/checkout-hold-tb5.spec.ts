import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { addToCart, call, createVendorWithBranch, signup, unique, uniquePhone } from "./helpers/api";
import { createOfferWithStock } from "./helpers/db";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// TB-5: one live checkout hold per account. Starting checkout again (a
// reload, a second tab) replaces the earlier hold - the new one says so
// in one quiet line, and the earlier tab gets an honest message instead
// of an order - and an order over 30 items is flagged before reserving.

// TB-25 translated the checkout page: its buttons follow the account's
// language, so they are found by either language's words.
const BUTTON = { continue: /^(متابعة|Continue)$/, confirm: /^(تأكيد الطلب|Confirm the order)$/ };
const AR = {
  continue: "متابعة",
  confirm: "تأكيد الطلب",
  replaced: "ألغينا حجزك السابق وبدأنا هذا الحجز.",
  gone: "هذا الحجز لم يعد قائماً",
  // TB-8: said only for a real replacement.
  because: "لأنك بدأتِ إتمام طلب آخر",
  limit: "الحد الأقصى 30 قطعة في الطلب الواحد",
};
const EN = {
  replaced: "Your previous checkout hold was released and replaced by this one.",
  gone: "This checkout hold no longer exists",
  because: "because you started another checkout",
  limit: "At most 30 items per order",
};

test.describe("TB-5: one checkout hold per account", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let token = "";
  let vendorId = "";
  let branchId = "";

  test.beforeAll(async () => {
    token = await signup(uniquePhone(), "a-strong-password");
    ({ vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken));
  });

  /** A fresh cart line of `quantity` (a new variant with plenty of stock). */
  async function line(quantity: number) {
    const variantId = await createOfferWithStock(vendorId, branchId, 20, 47);
    return addToCart(token, vendorId, variantId, quantity);
  }

  async function openCheckout(context: BrowserContext, cartItemIds: string[]) {
    const page = await context.newPage();
    await page.addInitScript(
      ({ t, ids }) => {
        localStorage.setItem("finalpro_session_token", t);
        localStorage.setItem("finalpro_active_workspace", JSON.stringify({ type: "customer" }));
        sessionStorage.setItem("checkout_cart_item_ids", JSON.stringify(ids));
      },
      { t: token, ids: cartItemIds },
    );
    await page.goto("/checkout");
    return page;
  }

  async function reserveOn(page: Page) {
    await page.locator("#terms-accepted").check({ timeout: 20_000 });
    await page.getByRole("button", { name: BUTTON.continue }).click();
    await expect(page.getByRole("button", { name: BUTTON.confirm })).toBeVisible({ timeout: 20_000 });
  }

  const setLang = (language_pref: string) =>
    call("/customers/me", { method: "PATCH", token, idempotencyKey: unique("lang"), body: { language_pref } });

  for (const lang of ["ar", "en"] as const) {
    test(`${lang}: a second checkout replaces the first quietly; the first tab gets an honest message, not an order`, async ({ browser }) => {
      expect((await setLang(lang)).status).toBe(200);
      try {
        const viewport = lang === "ar" ? { width: 1280, height: 900 } : { width: 360, height: 760 };
        const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
        await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
        const ids = [await line(2)];

        const first = await openCheckout(context, ids);
        await reserveOn(first);
        await expect(first.locator(".checkout-hold-note")).toHaveCount(0);

        const second = await openCheckout(context, ids);
        await reserveOn(second);
        await expect(second.locator(".checkout-hold-note")).toHaveText(lang === "en" ? EN.replaced : AR.replaced);
        await expect(second.locator("html")).toHaveAttribute("dir", lang === "en" ? "ltr" : "rtl");
        await expectNoHorizontalOverflow(second);

        await first.getByRole("button", { name: BUTTON.confirm }).click();
        await expect(first.locator(".error-banner")).toContainText(lang === "en" ? EN.gone : AR.gone, { timeout: 20_000 });
        await expect(first.locator(".error-banner")).toContainText(lang === "en" ? EN.because : AR.because);
        await expect(first.locator(".error-banner")).not.toContainText(/\d/);
        await expectNoHorizontalOverflow(first);
        // Release the remaining hold, as the shopper would.
        await second.getByRole("button", { name: /^(إلغاء والعودة|Cancel and go back)$/ }).click();
        await expect(second.locator("#terms-accepted")).toBeVisible({ timeout: 20_000 });
        await context.close();
      } finally {
        await setLang("ar");
      }
    });
  }

  for (const lang of ["ar", "en"] as const) {
    test(`${lang}: more than 30 items in one order is flagged before reserving - the limit only`, async ({ browser }) => {
      expect((await setLang(lang)).status).toBe(200);
      try {
        const viewport = lang === "en" ? { width: 1280, height: 900 } : { width: 360, height: 760 };
        const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
        await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
        const ids = [await line(10), await line(10), await line(10), await line(1)];
        const page = await openCheckout(context, ids);
        const banner = page.locator(".checkout-units-limit");
        await expect(banner).toContainText(lang === "en" ? EN.limit : AR.limit, { timeout: 20_000 });
        await expect(banner).not.toContainText("47");
        await expectNoHorizontalOverflow(page);
        await context.close();
      } finally {
        await setLang("ar");
      }
    });
  }
});
