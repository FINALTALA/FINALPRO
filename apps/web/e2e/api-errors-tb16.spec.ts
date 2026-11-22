import { expect, test, type Page } from "@playwright/test";
import { ApiError } from "../src/lib/api";
import {
  API_ERROR_TEXT,
  ELIGIBILITY_TEXT,
  NETWORK_TEXT,
  apiErrorMessage,
  loginPathFor,
  statusText,
} from "../src/lib/apiErrors";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// TB-16.1: one error-words function for the returns and notification
// screens - the error's own code first, then its HTTP status, never the
// API's own message (not for an unknown code, not for a 5xx) - and what
// the returns screens do with 401 / 403 / 404 / 409.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
const SESSION_TOKEN_KEY = "finalpro_session_token";
const SECRET_NOTE = "TB16 private customer note";
// The API's own English words for the refusals - never on screen.
const API_ENGLISH = [
  "You are not a member",
  "membership in this vendor account has been suspended",
  "cannot perform this action",
  "You are not assigned to this branch",
  "This store is suspended and cannot make this change", // (not on returns routes: they stay open for a suspended store)
  "Session is invalid",
  "ThrottlerException",
];

/** A route answer in the API's own error shape, with its own (technical,
 * English) message - which must never reach the screen. */
function apiError(status: number, code: string) {
  const message = status === 429 ? "ThrottlerException: Too Many Requests" : "Session is invalid or has expired";
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify({ error: { code, message, details: [], correlation_id: "tb16-route" } }),
  };
}

test.describe("TB-16.1: the error words (pure)", () => {
  const TECH = "TECH relation \"users\" violates constraint users_phone_key";

  test("every known code has its own words in Arabic and English, whatever the API's message", () => {
    for (const [code, text] of Object.entries(API_ERROR_TEXT)) {
      for (const status of [400, 403, 404, 409, 500]) {
        const err = new ApiError(status, code, TECH);
        expect(apiErrorMessage(err, "ar")).toBe(text.ar);
        expect(apiErrorMessage(err, "en")).toBe(text.en);
      }
    }
    // A specific code wins over its status' generic words.
    const denied = new ApiError(403, "BRANCH_ACCESS_DENIED", "You are not assigned to this branch");
    expect(apiErrorMessage(denied, "ar")).toBe("لا تملكين صلاحية الوصول إلى مرتجعات هذا الفرع.");
    expect(apiErrorMessage(denied, "ar")).not.toBe(statusText(403).ar);
  });

  test("an unknown code gets its status' words; a 5xx never shows the internal text; anything else is a connection failure", () => {
    for (const status of [400, 401, 403, 404, 409, 418, 422, 429, 500, 502, 503]) {
      const err = new ApiError(status, `SOMETHING_NEW_${status}`, TECH);
      for (const lang of ["ar", "en"] as const) {
        const words = apiErrorMessage(err, lang);
        expect(words).toBe(statusText(status)[lang]);
        expect(words).not.toContain("TECH");
        expect(words).not.toContain("users");
      }
    }
    const internal = new ApiError(500, "INTERNAL_SERVER_ERROR", TECH);
    expect(apiErrorMessage(internal, "ar")).toBe("حدث خطأ غير متوقع، حاولي لاحقاً.");
    expect(apiErrorMessage(internal, "en")).toBe("Something went wrong - please try again later.");
    expect(apiErrorMessage(new TypeError("Failed to fetch"), "ar")).toBe(NETWORK_TEXT.ar);
    expect(apiErrorMessage(new TypeError("Failed to fetch"), "en")).toBe(NETWORK_TEXT.en);
    expect(apiErrorMessage("nonsense", "en")).toBe(NETWORK_TEXT.en);
  });

  test("not eligible: the reason code's words; an unknown or missing reason gets the general words", () => {
    for (const [reason, text] of Object.entries(ELIGIBILITY_TEXT)) {
      const err = new ApiError(409, "NOT_ELIGIBLE_FOR_RETURN", TECH, [{ reason_code: reason }]);
      expect(apiErrorMessage(err, "ar")).toBe(text.ar);
      expect(apiErrorMessage(err, "en")).toBe(text.en);
    }
    for (const details of [[], [{ reason_code: "NEW_REASON" }], [{ reason_code: 7 }], [null]]) {
      const err = new ApiError(409, "NOT_ELIGIBLE_FOR_RETURN", TECH, details as unknown[]);
      expect(apiErrorMessage(err, "ar")).toBe("هذا المنتج غير مؤهل للإرجاع.");
      expect(apiErrorMessage(err, "en")).toBe("This item isn't eligible for return.");
    }
  });

  test("the sign-in link only ever comes back to a same-site path", () => {
    expect(loginPathFor("/returns/abc?x=1")).toBe("/login?next=%2Freturns%2Fabc%3Fx%3D1");
    expect(loginPathFor("/profile?tab=orders")).toBe("/login?next=%2Fprofile%3Ftab%3Dorders");
    for (const unsafe of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "/a\nb", "", "returns"]) {
      expect(loginPathFor(unsafe)).toBe("/login?next=%2F");
    }
  });
});

test.describe("TB-16.1: returns screens - 403, 404, 409 and 401", () => {
  test.describe.configure({ mode: "serial" });

  const shared = loadSharedFixtures();
  type Acc = { id: string; customerId: string; phone: string; token: string };
  let owner: Acc;
  let employee: Acc; // branch A
  let otherBranchEmployee: Acc; // branch B
  let suspended: Acc; // branch A, SUSPENDED
  let customer: Acc;
  let vendorId = "";
  let branchA = "";
  let offerId = "";

  async function account(): Promise<Acc> {
    const phone = uniquePhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" },
    });
    const profile = await prisma.customerProfile.create({ data: { userId: user.id } });
    const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
    if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
    return { id: user.id, customerId: profile.id, phone, token: res.body.session_token };
  }

  /** One return at branch A by `customer`, in the given state. */
  async function makeReturn(data: Record<string, unknown>) {
    const variant = await prisma.offerVariant.create({
      data: { vendorId, vendorOfferId: offerId, sellerSku: unique("sku"), storeInventoryBarcode: unique("sib"), basePrice: 50 },
    });
    const customerOrder = await prisma.customerOrder.create({ data: { customerId: customer.customerId } });
    const order = await prisma.branchOrder.create({
      data: {
        customerOrderId: customerOrder.id,
        vendorId,
        branchId: branchA,
        fulfilmentMethod: "PICKUP",
        paymentMethod: "COD",
        status: "COMPLETED",
        subtotal: 50,
        total: 50,
        pickupCode: String(Math.floor(100000 + Math.random() * 899999)),
        pickedUpAt: new Date(Date.now() - 86_400_000),
        codCollectedAt: new Date(Date.now() - 86_400_000),
      },
    });
    const item = await prisma.branchOrderItem.create({
      data: { vendorId, branchOrderId: order.id, offerVariantId: variant.id, quantity: 1, unitPrice: 50 },
    });
    return prisma.return.create({
      data: {
        vendorId,
        branchOrderItemId: item.id,
        reason: "DAMAGED",
        reasonNote: SECRET_NOTE,
        vendorReviewDueAt: new Date(Date.now() + 48 * 3_600_000),
        ...data,
      },
    });
  }
  const sixDigits = () => String(Math.floor(100000 + Math.random() * 899999));

  test.beforeAll(async () => {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique("tb16-store").toLowerCase(),
        legalName: unique("L"),
        displayName: "متجر TB-16",
        status: "ACTIVE",
        subscriptionStatus: "ACTIVE",
        storefrontPublished: true,
      },
    });
    vendorId = vendor.id;
    const branch = (name: string) =>
      prisma.storeBranch.create({ data: { vendorId, name: unique(name), isPhysical: true, verificationStatus: "APPROVED" } });
    branchA = (await branch("A")).id;
    const branchB = (await branch("B")).id;
    offerId = (await prisma.vendorOffer.create({ data: { vendorId, titleAr: unique("قطعة"), titleEn: "Item", status: "ACTIVE" } })).id;
    // One sign-in per account (the login endpoint allows 10 a minute).
    owner = await account();
    employee = await account();
    otherBranchEmployee = await account();
    suspended = await account();
    customer = await account();
    const member = (acc: Acc, role: "OWNER" | "BRANCH_EMPLOYEE", branchId: string | null, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") =>
      prisma.vendorUser.create({ data: { userId: acc.id, vendorId, role, branchId, status } });
    await member(owner, "OWNER", null);
    await member(employee, "BRANCH_EMPLOYEE", branchA);
    await member(otherBranchEmployee, "BRANCH_EMPLOYEE", branchB);
    await member(suspended, "BRANCH_EMPLOYEE", branchA, "SUSPENDED");
  });

  const setLanguage = async (page: Page, acc: Acc, lang: "ar" | "en") => {
    await prisma.user.update({ where: { id: acc.id }, data: { languagePref: lang } });
    await page.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
  };
  // ErrorBanner (role=alert) - the detail page also styles the store's
  // rejection reason with .error-banner, without the role.
  const banner = (page: Page) => page.locator('.error-banner[role="alert"]');
  const expectNoApiEnglish = async (page: Page) => {
    const text = await page.locator("body").innerText();
    for (const words of API_ENGLISH) expect(text).not.toContain(words);
  };

  // TB-26: a member enters the store workspace first; another branch's
  // employee is a member, so the page's own 403 words show. A suspended
  // employee and a non-member never get past the entry confirmation (its
  // own words - see tb26-workspaces.spec.ts), and the API refuses them
  // either way. One browser context per person (a workspace is per tab).
  test("403 on the branch returns page: another branch's employee gets the page's Arabic words; a suspended employee and a non-member are stopped at the workspace entry - no API English, no return", async ({ browser }) => {
    await makeReturn({ status: "REQUESTED" });
    const url = `/vendor/${vendorId}/branches/${branchA}/returns`;
    const fresh = async () => (await browser.newContext()).newPage();

    const other = await fresh();
    await loginAs(other, otherBranchEmployee.token);
    await enterWorkspace(other, otherBranchEmployee.token, { type: "vendor", vendor_id: vendorId });
    await other.goto(url);
    await expect(banner(other)).toHaveText("لا تملكين صلاحية الوصول إلى مرتجعات هذا الفرع.", { timeout: 30_000 });
    await expect(other.locator(".card", { hasText: "تالف" })).toHaveCount(0);
    expect(await other.content()).not.toContain(SECRET_NOTE);
    await expectNoApiEnglish(other);
    await other.context().close();

    const stopped: [string, string][] = [
      [suspended.token, "حسابك في هذا المتجر معلّق، فلا يمكن الدخول إلى مساحة عمله."],
      [shared.customerAToken, "لا تملكين صلاحية الدخول إلى مساحة العمل هذه."],
    ];
    for (const [token, words] of stopped) {
      const p = await fresh();
      await loginAs(p, token);
      await p.goto(url);
      await expect(p).toHaveURL(/\/workspaces\/enter\?/);
      await expect(p.locator("p[role=alert]")).toHaveText(words, { timeout: 30_000 });
      await expect(p.getByTestId("ws-enter-confirm")).toHaveCount(0);
      expect(await p.content()).not.toContain(SECRET_NOTE);
      await expectNoApiEnglish(p);
      await p.context().close();
    }
    // The owner and the branch's own employee still see it.
    for (const token of [owner.token, employee.token]) {
      const p = await fresh();
      await loginAs(p, token);
      await enterWorkspace(p, token, { type: "vendor", vendor_id: vendorId });
      await p.goto(url);
      await expect(p.locator(".card", { hasText: "تالف" }).first()).toBeVisible({ timeout: 30_000 });
      await expect(banner(p)).toHaveCount(0);
      await p.context().close();
    }
  });

  test("403 in English: the same refusal in English words", async ({ page }) => {
    await setLanguage(page, otherBranchEmployee, "en");
    await loginAs(page, otherBranchEmployee.token);
    await enterWorkspace(page, otherBranchEmployee.token, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/branches/${branchA}/returns`);
    await expect(banner(page)).toHaveText("You don't have access to this branch's returns.", { timeout: 30_000 });
    await expectNoApiEnglish(page);
    await setLanguage(page, otherBranchEmployee, "ar");
  });

  test("404: another customer's return, and one that does not exist, read the same - nothing of the return shown", async ({ page }) => {
    const r = await makeReturn({ status: "REQUESTED" });
    for (const id of [r.id, "00000000-0000-4000-8000-00000000f404"]) {
      await loginAs(page, shared.customerBToken);
      await page.goto(`/returns/${id}`);
      await expect(page.getByText("لم يُعثر على طلب الإرجاع")).toBeVisible({ timeout: 30_000 });
      expect(await page.content()).not.toContain(SECRET_NOTE);
      await expectNoApiEnglish(page);
    }
  });

  test("409: cancelling after the store decided, disputing after the window, a second store decision, an expired code - each in its own words", async ({ page }) => {
    await prisma.return.updateMany({ where: { vendorId, status: "REQUESTED" }, data: { status: "CANCELLED_BY_CUSTOMER" } });
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);

    // Cancel: shown while REQUESTED, decided by the store meanwhile.
    const toCancel = await makeReturn({ status: "REQUESTED" });
    await loginAs(page, customer.token);
    await page.goto(`/returns/${toCancel.id}`);
    const cancelButton = page.getByRole("button", { name: "إلغاء طلب الإرجاع" });
    await expect(cancelButton).toBeVisible({ timeout: 30_000 });
    await prisma.return.update({ where: { id: toCancel.id }, data: { status: "APPROVED_AWAITING_DROPOFF", code: sixDigits(), codeExpiresAt: future } });
    await cancelButton.click();
    await expect(banner(page)).toHaveText("لا يمكن إلغاء طلب الإرجاع إلا وهو بانتظار قرار المتجر.", { timeout: 30_000 });

    // Dispute: shown inside the window, which closes meanwhile.
    const toDispute = await makeReturn({ status: "REJECTED", rejectedAt: new Date(), disputeDeadlineAt: future, rejectionReason: "سبب رفض المتجر للاختبار" });
    await page.goto(`/returns/${toDispute.id}`);
    const disputeButton = page.getByRole("button", { name: "الاعتراض على الرفض" });
    await expect(disputeButton).toBeVisible({ timeout: 30_000 });
    await prisma.return.update({ where: { id: toDispute.id }, data: { disputeDeadlineAt: past } });
    await disputeButton.click();
    await expect(banner(page)).toHaveText("انتهت مهلة الاعتراض على هذا الرفض (7 أيام).", { timeout: 30_000 });

    // A second store decision: shown REQUESTED, decided meanwhile.
    const decided = await makeReturn({ status: "REQUESTED" });
    await loginAs(page, owner.token);
    await enterWorkspace(page, owner.token, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/branches/${branchA}/returns`);
    const approve = page.getByRole("button", { name: "اعتماد" });
    await expect(approve).toBeVisible({ timeout: 30_000 });
    await prisma.return.update({ where: { id: decided.id }, data: { status: "APPROVED_AWAITING_DROPOFF", code: sixDigits(), codeExpiresAt: future } });
    await approve.click();
    await expect(banner(page)).toHaveText("تم البتّ في هذا الطلب بالفعل.", { timeout: 30_000 });

    // An expired code at the counter, in Arabic and then in English.
    for (const lang of ["ar", "en"] as const) {
      const code = sixDigits();
      // The isolated API runs with E2E_PAUSED_TASKS=ReturnSweepService (README): no sweep
      // expires this code under the test - the counter sees an expired, still-approved code.
      const expired = await makeReturn({ status: "APPROVED_AWAITING_DROPOFF", code, codeExpiresAt: past });
      await setLanguage(page, owner, lang);
      await loginAs(page, owner.token);
      await enterWorkspace(page, owner.token, { type: "vendor", vendor_id: vendorId });
      await page.goto(`/vendor/${vendorId}/returns/redeem`);
      const input = page.locator('input[maxlength="6"]'); // the code field (not the header search)
      await expect(input).toBeVisible({ timeout: 30_000 });
      await input.fill(code);
      // TB-16.2: the page is bilingual now - the button follows the language.
      await page.getByRole("button", { name: lang === "ar" ? "استبدال" : "Redeem", exact: true }).click();
      await expect(banner(page)).toHaveText(
        lang === "ar" ? "انتهت صلاحية هذا الكود (7 أيام من الاعتماد)." : "This code has expired (7 days after approval).",
        { timeout: 30_000 },
      );
      // Proof the state was the expired code itself: still approved, never swept.
      expect((await prisma.return.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe("APPROVED_AWAITING_DROPOFF");
      await expectNoApiEnglish(page);
    }
    await setLanguage(page, owner, "ar");
  });

  // 401: one test per screen (each its own time budget - seven screens in one
  // test ran past it in a full run). The customer's session is made invalid
  // once, before them (as after a password change). Each screen's own 401
  // handling and the app shell's (its workspace read gets the same 401 and
  // clears the session) both lead to sign-in; the test checks where the user
  // lands, whichever got there first.
  test.describe("401: an expired session goes to sign-in, back to the same screen, and the stored session is cleared", () => {
    let mineId = "";
    let orderPath = "";
    test.beforeAll(async () => {
      const mine = await makeReturn({ status: "REQUESTED" });
      mineId = mine.id;
      const item = await prisma.branchOrderItem.findUniqueOrThrow({
        where: { id: mine.branchOrderItemId },
        select: { id: true, branchOrderId: true },
      });
      orderPath = `/orders/${item.branchOrderId}/items/${item.id}/return`;
      await prisma.user.update({ where: { id: customer.id }, data: { sessionVersion: { increment: 1 } } });
    });
    const screens: [string, () => string][] = [
      ["my returns", () => "/returns"],
      ["a return", () => `/returns/${mineId}`],
      ["the branch returns page", () => `/vendor/${vendorId}/branches/${branchA}/returns`],
      ["redeem", () => `/vendor/${vendorId}/returns/redeem`],
      ["the return policy", () => `/vendor/${vendorId}/return-policy`],
      ["the admin escalations", () => "/admin/returns"],
      ["the return request form", () => orderPath],
    ];
    for (const [name, pathOf] of screens) {
      test(`401 on ${name}`, async ({ browser }) => {
      const path = pathOf();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("/");
      // Seeded once (not on every load), so a cleared session stays cleared.
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SESSION_TOKEN_KEY, customer.token]);
      // Deterministic: the workspaces read answers 401 here whatever the
      // API's per-address rate limit is doing in a long run (it answered
      // 429 to it once in a full run). Every other call reaches the API
      // with the really-expired session.
      await page.route("**/api/v1/me/workspaces", (route) => route.fulfill(apiError(401, "SESSION_INVALID")));
      await page.goto(path);
      // Lands on sign-in with `next` = exactly this screen (encoded or not).
      await expect
        .poll(
          () => {
            const url = new URL(page.url());
            return url.pathname === "/login" ? url.searchParams.get("next") : null;
          },
          { timeout: 30_000 },
        )
        .toBe(path);
      expect(await page.evaluate((k) => localStorage.getItem(k), SESSION_TOKEN_KEY)).toBeNull();
      await expectNoApiEnglish(page);
      await context.close();
      });
    }
  });

  test("429 on the workspaces read: the admin escalations page says to wait and retry - not that it is for platform administrators only", async ({ browser }) => {
    const words = {
      ar: "محاولات كثيرة، انتظري قليلاً ثم حاولي مجدداً.",
      en: "Too many attempts - wait a moment and try again.",
    };
    for (const lang of ["ar", "en"] as const) {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: lang } });
      const context = await browser.newContext();
      await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
      const page = await context.newPage();
      await loginAs(page, owner.token);
      await page.route("**/api/v1/me/workspaces", (route) => route.fulfill(apiError(429, "TOO_MANY_REQUESTS")));
      await page.goto("/admin/returns");
      await expect(banner(page)).toHaveText(words[lang], { timeout: 30_000 });
      await expect(page.getByText("هذه الصفحة لمدير المنصة فقط")).toHaveCount(0);
      // TB-26: the platform workspace's entry page reads the workspaces; it
      // keeps the page asked for as `next`.
      expect(new URL(page.url()).pathname).toBe("/workspaces/enter");
      expect(new URL(page.url()).searchParams.get("next")).toBe("/admin/returns");
      // A rate limit is not a lost session.
      expect(await page.evaluate((k) => localStorage.getItem(k), SESSION_TOKEN_KEY)).toBe(owner.token);
      await expectNoApiEnglish(page);
      await context.close();
    }
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
  });
});
