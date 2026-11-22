import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { addToCart, call, createVendorWithBranch, unique } from "./helpers/api";
import { createOfferWithStock } from "./helpers/db";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// TB-8: a hold the expiry sweep removed answers RESERVATION_NOT_FOUND
// (no "replaced" reason). The checkout page then says the hold ran out
// when its known expiry has passed, a plain "no longer exists" when it
// has not - and "you started another checkout" only for a real
// replacement (checkout-hold-tb5.spec.ts). Uses the shared customer B
// (no signup of its own: the OTP request throttle is shared by the whole
// run) and leaves it as found - no hold, no cart line, Arabic.

// TB-25 translated the checkout page: its buttons follow the account's
// language, so they are found by either language's words.
const BUTTON = { continue: /^(متابعة|Continue)$/, confirm: /^(تأكيد الطلب|Confirm the order)$/ };
const AR = {
  continue: "متابعة",
  confirm: "تأكيد الطلب",
  expired: "انتهت مدة الحجز. ابدئي الطلب من جديد.",
  gone: "هذا الحجز لم يعد قائماً - ابدئي من جديد.",
  another: "طلب آخر",
};
const EN = {
  expired: "This checkout hold has expired. Please start again.",
  gone: "This checkout hold no longer exists. Please start again.",
  another: "another checkout",
};

test.describe("TB-8: the checkout page after a hold is gone", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  const token = fixtures.customerBToken;
  let vendorId = "";
  let branchId = "";

  const cartLines: string[] = [];

  test.beforeAll(async () => {
    ({ vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken));
  });

  test.afterAll(async () => {
    for (const id of cartLines) await call(`/cart/items/${id}`, { method: "DELETE", token });
  });

  const setLang = (language_pref: string) =>
    call("/customers/me", { method: "PATCH", token, idempotencyKey: unique("lang"), body: { language_pref } });

  /** Opens checkout on a fake clock, reserves, and returns the reservation id. */
  async function reserved(context: BrowserContext): Promise<{ page: Page; reservationId: string }> {
    const variantId = await createOfferWithStock(vendorId, branchId, 20, 9);
    const cartItemId = await addToCart(token, vendorId, variantId, 1);
    cartLines.push(cartItemId);
    const page = await context.newPage();
    await page.clock.install();
    await page.addInitScript(
      ({ t, ids }) => {
        localStorage.setItem("finalpro_session_token", t);
        localStorage.setItem("finalpro_active_workspace", JSON.stringify({ type: "customer" }));
        sessionStorage.setItem("checkout_cart_item_ids", JSON.stringify(ids));
      },
      { t: token, ids: [cartItemId] },
    );
    await page.goto("/checkout");
    await page.locator("#terms-accepted").check({ timeout: 20_000 });
    const reserveResponse = page.waitForResponse((r) => r.url().includes("/checkout/reserve") && r.request().method() === "POST");
    await page.getByRole("button", { name: BUTTON.continue }).click();
    const body = await (await reserveResponse).json();
    await expect(page.getByRole("button", { name: BUTTON.confirm })).toBeVisible({ timeout: 20_000 });
    return { page, reservationId: body.reservation_id };
  }

  /** Removes the hold on the server the way the sweep leaves it: gone, not replaced. */
  async function removeOnServer(reservationId: string) {
    const res = await call<{ released: boolean }>(`/checkout/reservations/${reservationId}/cancel`, { method: "POST", token });
    expect(res.status).toBe(201);
    expect(res.body.released).toBe(true);
  }

  for (const lang of ["ar", "en"] as const) {
    test(`${lang}: gone after its known expiry -> «the hold expired», never «another checkout»`, async ({ browser }) => {
      expect((await setLang(lang)).status).toBe(200);
      try {
        const viewport = lang === "ar" ? { width: 1280, height: 900 } : { width: 360, height: 760 };
        const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
        await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
        const { page, reservationId } = await reserved(context);
        await removeOnServer(reservationId);
        // The page's own clock passes the hold's 10 minutes.
        await page.clock.fastForward("11:00");

        await page.getByRole("button", { name: BUTTON.confirm }).click();
        const banner = page.locator(".error-banner");
        await expect(banner).toHaveText(lang === "en" ? EN.expired : AR.expired, { timeout: 20_000 });
        await expect(banner).not.toContainText(lang === "en" ? EN.another : AR.another);
        await expect(page.locator("#terms-accepted")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await context.close();
      } finally {
        await setLang("ar");
      }
    });

    test(`${lang}: gone before its known expiry and not replaced -> a plain «no longer exists»`, async ({ browser }) => {
      expect((await setLang(lang)).status).toBe(200);
      try {
        const viewport = lang === "en" ? { width: 1280, height: 900 } : { width: 360, height: 760 };
        const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
        await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
        const { page, reservationId } = await reserved(context);
        await removeOnServer(reservationId);

        await page.getByRole("button", { name: BUTTON.confirm }).click();
        const banner = page.locator(".error-banner");
        await expect(banner).toHaveText(lang === "en" ? EN.gone : AR.gone, { timeout: 20_000 });
        await expect(banner).not.toContainText(lang === "en" ? EN.another : AR.another);
        await expectNoHorizontalOverflow(page);
        await context.close();
      } finally {
        await setLang("ar");
      }
    });
  }
});
