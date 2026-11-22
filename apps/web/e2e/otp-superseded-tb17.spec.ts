import { expect, test, type Page } from "@playwright/test";
import { call, unique } from "./helpers/api";
import { loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// TB-17: when the API refuses an older OTP with OTP_SUPERSEDED (the code
// is real, just not the newest one sent), every OTP page says so in the
// page's language instead of showing the server's English text. Which
// codes the API calls superseded is proven by the API suite
// (apps/api/test/auth.e2e-spec.ts); here the request and verify calls are
// answered in the browser, so no OTP is sent and the run's shared OTP
// request budget is untouched.

const WORDS = {
  ar: "أُرسل رمز أحدث، استخدم آخر رمز وصلك.",
  en: "A newer code was sent. Use the latest code you received.",
};

async function answer(page: Page, pathEnd: string, status: number, body: unknown) {
  await page.route(`**/api/v1${pathEnd}`, (route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

const SUPERSEDED = {
  error: {
    code: "OTP_SUPERSEDED",
    message: "A newer code was sent. Use the latest code you received.",
    details: [],
    correlation_id: "00000000-0000-4000-8000-000000000017",
  },
};

async function inLanguage(page: Page, lang: "ar" | "en") {
  await page.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
}

test.describe("TB-17: OTP_SUPERSEDED on the OTP pages", () => {
  for (const lang of ["ar", "en"] as const) {
    test(`register (${lang}): an older code is reported as superseded`, async ({ page }) => {
      await inLanguage(page, lang);
      await answer(page, "/auth/otp/request", 202, { expires_in_seconds: 300 });
      await answer(page, "/auth/otp/verify", 400, SUPERSEDED);
      await page.goto("/register");
      await page.getByLabel("رقم الهاتف").fill("+970591234567");
      await page.locator("form button[type=submit]").click();
      await page.getByLabel("رمز التحقق").fill("111111");
      await page.locator("form button[type=submit]").click();
      await expect(page.locator(".error-banner")).toHaveText(WORDS[lang], { timeout: 20_000 });
    });

    test(`reset password (${lang}): an older code is reported as superseded`, async ({ page }) => {
      await inLanguage(page, lang);
      await answer(page, "/auth/password/reset-request", 202, { expires_in_seconds: 300 });
      await answer(page, "/auth/password/reset-confirm", 400, SUPERSEDED);
      await page.goto("/reset-password");
      await page.getByLabel("رقم الهاتف").fill("+970591234567");
      await page.locator("form button[type=submit]").click();
      await page.getByLabel("رمز التحقق").fill("111111");
      await page.getByLabel(/كلمة المرور الجديدة/).fill("a-new-password");
      await page.locator("form button[type=submit]").click();
      await expect(page.locator(".error-banner")).toHaveText(WORDS[lang], { timeout: 20_000 });
    });
  }

  test("change phone (en and ar): an older code is reported as superseded; any other error is worded by the central list, never the server's English (Phase A++)", async ({ page }) => {
    const fixtures = loadSharedFixtures();
    // A signed-in user's saved language wins over the browser's (Sprint 22).
    const setLang = (language_pref: string) =>
      call("/customers/me", { method: "PATCH", token: fixtures.customerAToken, idempotencyKey: unique("lang"), body: { language_pref } });
    await loginAs(page, fixtures.customerAToken);
    await answer(page, "/auth/otp/request", 202, { expires_in_seconds: 300 });
    let verifyBody: unknown = SUPERSEDED;
    await page.route("**/api/v1/auth/otp/verify", (route) =>
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify(verifyBody) }),
    );
    // The page's own form (the header has a search form too).
    const submitOf = (field: string) =>
      page.locator("form", { has: page.locator(field) }).locator("button[type=submit]");
    const codeStep = async () => {
      await page.goto("/account/phone");
      await page.locator("#new-phone").fill("+970591234568");
      await submitOf("#new-phone").click();
      await page.locator("#phone-code").fill("111111");
      await submitOf("#phone-code").click();
    };
    try {
      for (const lang of ["en", "ar"] as const) {
        expect((await setLang(lang)).status).toBe(200);
        await codeStep();
        await expect(page.locator("html")).toHaveAttribute("lang", lang);
        await expect(page.locator(".error-banner")).toHaveText(WORDS[lang], { timeout: 20_000 });
      }
      // An ordinary wrong code: since Phase A++ (approved item 8) the OTP pages word every
      // code through apiErrorMessage - in the page's language (Arabic here), never the API's English.
      verifyBody = { error: { code: "OTP_INVALID", message: "This OTP code is invalid", details: [], correlation_id: "x" } };
      await submitOf("#phone-code").click();
      await expect(page.locator(".error-banner")).toHaveText("رمز التحقق غير صحيح.", { timeout: 20_000 });
    } finally {
      await setLang("ar");
    }
  });
});
