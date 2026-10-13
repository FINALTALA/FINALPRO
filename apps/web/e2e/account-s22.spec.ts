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
    await page.goto("/");
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

  // Phone change and deactivate/reactivate share ONE freshly-signed-up
  // account (rather than two) deliberately - POST /auth/otp/request is
  // throttled 5/60s per API instance and shared across every purpose,
  // same real constraint global-setup.ts's own comment documents. Two
  // separate fresh signups plus this test's own otp/request calls
  // would exceed that budget when run back-to-back with no natural
  // spacing; account-s22.spec.ts is already the one file in this suite
  // that spends any of it beyond global-setup's own 4 signups.
  test("phone change, then deactivate and reactivate the same account", async ({ page }) => {
    const oldPhone = uniquePhone();
    const token = await signup(oldPhone, "a-strong-password");
    const newPhone = uniquePhone();

    await loginAs(page, token);
    await page.goto("/account/phone");
    const beforePhoneChangeRequest = otpLogOffset();
    await page.getByLabel("رقم الهاتف الجديد").fill(newPhone);
    await page.getByRole("button", { name: "إرسال رمز التحقق" }).click();

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
    if (!page.url().endsWith("/account")) {
      await expect(page.getByText("تم تغيير رقم هاتفك")).toBeVisible();
    }
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
    await page.getByLabel("كلمة المرور").fill("a-strong-password");
    await page.getByRole("button", { name: "دخول", exact: true }).click();
    await expect(page.getByRole("link", { name: "استرجاع الحساب المعطّل" })).toBeVisible();

    await page.getByRole("link", { name: "استرجاع الحساب المعطّل" }).click();
    await expect(page).toHaveURL(/\/reactivate/);
    const beforeReactivateRequest = otpLogOffset();
    await page.getByLabel("رقم الهاتف").fill(newPhone);
    await page.getByRole("button", { name: "إرسال رمز التحقق" }).click();

    const reactivateCode = await waitForOtp(newPhone, beforeReactivateRequest);
    await page.getByLabel("رمز التحقق").fill(reactivateCode);
    await page.getByRole("button", { name: "استرجاع الحساب" }).click();
    await page.waitForLoadState("networkidle");

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
