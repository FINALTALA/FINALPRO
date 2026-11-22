import { expect, test } from "@playwright/test";
import {
  call,
  createAddress,
  createVendorWithBranch,
  otpLogOffset,
  placeDeliveryOrder,
  setDeliveryZoneFee,
  signup,
  uniquePhone,
  unique,
  waitForOtp,
} from "./helpers/api";
import { createOfferWithStock } from "./helpers/db";
import { loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";
import type { Page } from "@playwright/test";

// POST /auth/otp/request is throttled 5/60s per client (FR-AUTH-011) - a
// real, intended security rule that global-setup's four signups and this
// file's own signup share. When the UI shows the throttler's refusal,
// wait the window out and send again, instead of failing on a rule that
// is working exactly as designed.
async function sendCodeRespectingThrottle(page: Page): Promise<void> {
  const send = page.getByRole("button", { name: "إرسال رمز التحقق" });
  await send.click();
  // Phase A++: the page now words a 429 through apiErrorMessage (Arabic), no longer the server's English.
  const throttled = page.getByText(/Too Many Requests|محاولات كثيرة، انتظري قليلاً/).first();
  const wasThrottled = await throttled
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (wasThrottled) {
    await page.waitForTimeout(61_000);
    await send.click();
  }
}

// Sprint 22 (FR-AUTH-006/008/009/014, PDR-029): real-browser coverage
// for the new account/addresses screens - language switching, phone
// change, address management, deactivate/reactivate, and the order
// change-address flow. The business rules themselves are already
// proven at the HTTP level by apps/api/test/sprint22-account.e2e-spec.ts;
// this only has to prove the UI renders and drives real server
// responses correctly. The UI itself issues every OTP request below
// (there is no separate helper call for it) - waitForOtp() only polls
// the same API log the real SmsService already wrote to.
test.describe("S22 account and addresses UI", () => {
  const fixtures = loadSharedFixtures();

  test("language switch flips <html> dir/lang and visible nav labels", async ({ page }) => {
    await loginAs(page, fixtures.customerBToken);
    // The home page uses the Via header (no «طلباتي» link - its cart icon
    // leads to /cart, where «طلباتي» is a tab); the platform header with
    // the translated nav links is on every other public page.
    await page.goto("/discovery");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.getByRole("link", { name: "طلباتي", exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "التبديل إلى الإنجليزية" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("link", { name: "Orders", exact: true }).first()).toBeVisible();

    // Reversible - switching back restores the original state.
    await page.getByRole("button", { name: "Switch to Arabic" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("a language chosen before the saved preference arrives is not undone by it, and a reload reads it back from the account", async ({ page }) => {
    const token = fixtures.customerBToken;
    const savePref = (language_pref: "ar" | "en") =>
      call("/customers/me", { method: "PATCH", token, idempotencyKey: unique("lang"), body: { language_pref } });
    expect((await savePref("ar")).status).toBe(200);
    try {
      await loginAs(page, token);
      // Fetch the account sync's first GET /customers/me right away (so its
      // body still says "ar"), but hand it to the page only after EN has
      // been chosen and saved - the stale answer the race is about.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held = false;
      let delivered!: () => void;
      const deliveredPromise = new Promise<void>((resolve) => (delivered = resolve));
      await page.route("**/api/v1/customers/me", async (route) => {
        if (route.request().method() !== "GET" || held) return route.continue();
        held = true;
        const stale = await route.fetch();
        expect((await stale.json()).language_pref).toBe("ar");
        await gate;
        await route.fulfill({ response: stale });
        delivered();
      });
      await page.goto("/discovery");
      await expect.poll(() => held).toBe(true);

      const saved = page.waitForResponse(
        (r) => r.url().endsWith("/api/v1/customers/me") && r.request().method() === "PATCH",
      );
      await page.getByRole("button", { name: "التبديل إلى الإنجليزية" }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      expect((await saved).status()).toBe(200);

      release();
      await deliveredPromise;
      // Give the stale answer every chance to be (wrongly) applied.
      await page.waitForTimeout(500);
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
      await expect(page.getByRole("link", { name: "Orders", exact: true }).first()).toBeVisible();

      // A reload with this browser's own choice cleared reads EN from the
      // account (the toggle saved it) - the normal sync still works.
      await page.unroute("**/api/v1/customers/me");
      await page.evaluate(() => localStorage.removeItem("finalpro_lang_pref"));
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.getByRole("link", { name: "Orders", exact: true }).first()).toBeVisible();
    } finally {
      // Leave the shared account as the other specs expect it (Arabic).
      await savePref("ar");
    }
  });

  // Phone change and deactivate/reactivate share ONE freshly-signed-up
  // account (rather than two) deliberately - POST /auth/otp/request is
  // throttled 5/60s per API instance and shared across every purpose,
  // same real constraint global-setup.ts's own comment documents. Two
  // separate fresh signups plus this test's own otp/request calls
  // would exceed that budget when run back-to-back with no natural
  // spacing; account-s22.spec.ts is already the one file in this suite
  // that spends any of it beyond global-setup's own 4 signups.
  test("phone change, then deactivate and reactivate the same account", async ({ page }) => {
    // Up to one full OTP throttle window may be waited out (see above).
    test.setTimeout(150_000);
    const oldPhone = uniquePhone();
    const token = await signup(oldPhone, "a-strong-password");
    const newPhone = uniquePhone();

    await loginAs(page, token);
    await page.goto("/account/phone");
    const beforePhoneChangeRequest = otpLogOffset();
    await page.getByLabel("رقم الهاتف الجديد").fill(newPhone);
    await sendCodeRespectingThrottle(page);

    const phoneChangeCode = await waitForOtp(newPhone, beforePhoneChangeRequest);
    await page.getByLabel("رمز التحقق").fill(phoneChangeCode);
    await page.getByRole("button", { name: "تأكيد رقم الهاتف الجديد" }).click();
    await page.waitForLoadState("networkidle");

    // Either a new session was issued (lands on /account) or the API
    // fell back to LOGIN_REQUIRED (shows the notice) - either way the
    // change itself already succeeded server-side; prove that with a
    // real login using the NEW number, then continue the rest of this
    // test on a guaranteed-fresh session (the phone change bumps
    // sessionVersion, so the ORIGINAL token is no longer valid either
    // way once this step is done).
    // Wait for whichever of the two outcomes arrives - the URL alone is
    // read too early, before router.push("/account") has landed.
    await expect(
      page
        .getByRole("heading", { name: "حسابي", level: 1 })
        .or(page.getByText("تم تغيير رقم هاتفك"))
        .first(),
    ).toBeVisible();
    const afterPhoneChange = await call<{ session_token: string }>("/auth/login", {
      method: "POST",
      body: { phone: newPhone, password: "a-strong-password" },
    });
    expect(afterPhoneChange.status).toBe(200);

    await loginAs(page, afterPhoneChange.body.session_token);
    await page.goto("/account/deactivate");
    await page.getByRole("button", { name: "تعطيل حسابي" }).click();
    await expect(page).toHaveURL(/\/login/);

    // A login attempt on the now-deactivated account surfaces the
    // recovery link instead of a plain credentials error.
    await page.getByLabel("رقم الهاتف", { exact: true }).fill(newPhone);
    await page.getByLabel("كلمة المرور", { exact: true }).fill("a-strong-password");
    await page.getByRole("button", { name: "تسجيل الدخول" }).click();
    await expect(page.getByRole("link", { name: "استرجاع الحساب المعطّل" })).toBeVisible();

    await page.getByRole("link", { name: "استرجاع الحساب المعطّل" }).click();
    await expect(page).toHaveURL(/\/reactivate/);
    const beforeReactivateRequest = otpLogOffset();
    await page.getByLabel("رقم الهاتف").fill(newPhone);
    await sendCodeRespectingThrottle(page);

    const reactivateCode = await waitForOtp(newPhone, beforeReactivateRequest);
    await page.getByLabel("رمز التحقق").fill(reactivateCode);
    await page.getByRole("button", { name: "استرجاع الحساب" }).click();
    // Wait for the recovery's own outcome (signed in and sent home, or the
    // "sign in again" notice) - networkidle alone can resolve before the
    // confirm request has even started.
    await expect
      .poll(
        async () =>
          new URL(page.url()).pathname === "/" ||
          (await page.getByText("تم استرجاع حسابك").isVisible()),
      )
      .toBe(true);

    const afterReactivate = await call("/auth/login", {
      method: "POST",
      body: { phone: newPhone, password: "a-strong-password" },
    });
    expect(afterReactivate.status).toBe(200);
  });

  test("addresses: create, edit to set default, and delete", async ({ page }) => {
    await loginAs(page, fixtures.customerAToken);
    await page.goto("/account/addresses");

    const label = unique("pw-addr");
    await page.getByRole("button", { name: "+ عنوان جديد" }).click();
    await page.getByLabel("اسم العنوان (اختياري)").fill(label);
    await page.getByLabel("منطقة التوصيل").selectOption("WEST_BANK");
    await page.getByLabel("خط العرض (lat)").fill("31.9");
    await page.getByLabel("خط الطول (lng)").fill("35.2");
    await page.getByLabel("رقم الهاتف", { exact: true }).fill("+970591234567");
    await page.getByRole("button", { name: "حفظ العنوان" }).click();

    const card = page.locator(".card", { hasText: label });
    await expect(card).toBeVisible();

    // Edit it: tick "set as default" and save.
    await card.getByRole("button", { name: "تعديل" }).click();
    await page.getByLabel("اجعلي هذا العنوان الافتراضي").check();
    await page.getByRole("button", { name: "حفظ", exact: true }).click();
    await expect(card.getByText("الافتراضي")).toBeVisible();

    // Delete it.
    page.once("dialog", (d) => void d.accept());
    await card.getByRole("button", { name: "حذف" }).click();
    await expect(card).not.toBeVisible();
  });

  test("order change-address: a different-fee zone is unsupported, convert to pickup", async ({ page }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    await setDeliveryZoneFee(fixtures.ownerToken, vendorId, "WEST_BANK", 10);
    await setDeliveryZoneFee(fixtures.ownerToken, vendorId, "JERUSALEM", 25); // different fee, on purpose
    const variantId = await createOfferWithStock(vendorId, branchId, 40, 5);

    const jerusalemLabel = unique("pw-jerusalem-addr");
    const originalAddress = await createAddress(fixtures.customerAToken, { zone: "WEST_BANK" });
    await createAddress(fixtures.customerAToken, { zone: "JERUSALEM", label: jerusalemLabel });
    const { branchOrderId } = await placeDeliveryOrder(
      fixtures.ownerToken,
      fixtures.customerAToken,
      vendorId,
      branchId,
      variantId,
      originalAddress.id,
    );

    await loginAs(page, fixtures.customerAToken);
    await page.goto("/orders");
    const card = page.locator(`[data-order-id="${branchOrderId}"]`);
    await card.getByRole("button", { name: "تغيير عنوان التوصيل" }).click();
    await card.getByLabel(jerusalemLabel).check();
    await card.getByRole("button", { name: "تأكيد العنوان الجديد" }).click();

    await expect(card.getByText(/رسوم التوصيل لهذا العنوان مختلفة/)).toBeVisible();
    await card.getByRole("button", { name: "التحويل إلى استلام من المحل" }).click();
    // Converting away from DELIVERY unmounts this panel once the
    // order list reloads (it only renders for a DELIVERY order) - the
    // order card's own pre-existing pickup-code line is what actually
    // confirms the conversion succeeded.
    await expect(card.getByText(/رمز الاستلام:/)).toBeVisible();
  });
});
