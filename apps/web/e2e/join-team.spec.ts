import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, otpLogOffset, unique, uniquePhone, waitForOtp } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// 2026-11-23: «انضمام إلى فريق متجر» - the invited phone accepts the owner's
// invite over the EXISTING APIs (POST /auth/otp/verify purpose staff_invite,
// then POST /auth/staff-invites/accept). Nothing about the store or the
// branch is shown before that succeeds.
//
// The OTP budget (the project's rule, see helpers/shared-fixtures.ts and
// otp-superseded-tb17.spec.ts): POST /auth/otp/verify allows 10 a minute
// and POST /auth/otp/request 5 a minute per client, shared with the whole
// run - global-setup already spends 4 of each. So this file makes exactly
// FIVE real verify calls and NO real request call (invites text their code
// through the invite itself), each one for a rule that must be proven end to
// end here; wording-only cases (a wrong code, an expired code, «no account,
// no password», the resend notice) are answered in the browser. The API
// rules behind those are proven by the API suite (apps/api/test:
// sprint4-roles «refuses to accept an already-accepted invite a second
// time», «requires a password only when the invited phone has no existing
// account»; auth.e2e-spec OTP failures). Every phone is new (uniquePhone).

const localRequire = createRequire(__filename);
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

async function answer(page: Page, pathEnd: string, status: number, body: unknown) {
  await page.route(`**/api/v1${pathEnd}`, (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
}
const refusal = (code: string) => ({ error: { code, message: code, details: [], correlation_id: "00000000-0000-4000-8000-000000000023" } });

test.describe("«انضمام إلى فريق متجر»", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchId = "";
  let legalName = "";

  test.beforeAll(async () => {
    ({ vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع رام الله"));
    await makeVendorEligible(vendorId);
    legalName = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { legalName: true } })).legalName;
  });

  /** The owner's existing invite (it texts the code); returns that code. */
  async function invite(phone: string): Promise<string> {
    const offset = otpLogOffset();
    const res = await call(`/vendors/${vendorId}/branches/${branchId}/staff-invites`, { method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("inv"), body: { phone } });
    if (res.status !== 201) throw new Error(`invite: ${res.status} ${JSON.stringify(res.body)}`);
    return waitForOtp(phone, offset);
  }
  async function fill(page: Page, phone: string, code: string, password = "") {
    await page.getByTestId("join-phone").fill(phone);
    await page.getByTestId("join-code").fill(code);
    await page.locator("#jt-password").fill(password);
    await page.getByTestId("join-submit").click();
  }
  /** Nothing about the store or the branch on the screen. */
  async function revealsNothing(page: Page) {
    const text = (await page.getByTestId("join-team").innerText()) ?? "";
    expect(text).not.toContain(legalName);
    expect(text).not.toContain("رام الله");
  }
  const banner = (page: Page) => page.locator(".error-banner");

  // real verify calls: 2 (accept + the same code again)
  test("full cycle: the entry on sign-in, an existing account accepts with phone + code, «تم انضمامك إلى فريق …», into her branch; the same code again is refused; the owner never sees the code", async ({ page }) => {
    // an existing account (no password needed), not signed in on this device
    const phone = uniquePhone();
    const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" } });
    await prisma.customerProfile.create({ data: { userId: user.id } });
    const code = await invite(phone);

    await page.goto("/login");
    await expect(page.getByTestId("join-team-entry")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("لديك دعوة للعمل في متجر؟")).toBeVisible();
    await page.getByTestId("join-team-entry").click();
    await expect(page).toHaveURL(/\/join-team$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("انضمام إلى فريق متجر");
    // only phone, code (and the optional password) - no store, no branch
    await revealsNothing(page);
    await expect(page.getByTestId("join-form").locator("select")).toHaveCount(0);

    await fill(page, phone, code);
    const done = page.getByTestId("join-done");
    await expect(done).toContainText(`تم انضمامك إلى فريق ${legalName} · فرع رام الله`, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    const member = await prisma.vendorUser.findFirstOrThrow({ where: { userId: user.id, vendorId } });
    expect(member.role).toBe("BRANCH_EMPLOYEE");
    expect(member.branchId).toBe(branchId);
    expect((await prisma.staffInvite.findFirstOrThrow({ where: { phone, vendorId } })).status).toBe("ACCEPTED");

    await page.getByTestId("join-enter").click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/branches/${branchId}/orders`), { timeout: 30_000 });
    await expect(page.getByTestId("br-fixed")).toHaveText("فرع رام الله", { timeout: 30_000 });
    await expect(page.getByTestId("br-tab-staff")).toHaveCount(0);

    // the same code again, on a clean device: refused, nothing doubled
    const again = await page.context().browser()!.newPage();
    await again.goto("/join-team");
    await fill(again, phone, code);
    await expect(banner(again)).toContainText("الرمز أو رقم الهاتف غير صحيح.", { timeout: 30_000 });
    await revealsNothing(again);
    await again.close();
    expect(await prisma.vendorUser.count({ where: { vendorId, userId: user.id } })).toBe(1);

    // the owner: the new member is listed; the code is never on the screen
    const owner = await page.context().browser()!.newPage();
    await owner.setViewportSize({ width: 1360, height: 900 });
    await loginAs(owner, fixtures.ownerToken);
    await enterWorkspace(owner, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await owner.goto(`/vendor/${vendorId}/branches/${branchId}/staff`);
    await expect(owner.getByTestId(`st-member-${member.id}`)).toBeVisible({ timeout: 30_000 });
    const ownerText = await owner.getByTestId("staff-board").innerText();
    if (!phone.includes(code)) expect(ownerText).not.toContain(code);
    await owner.close();
  });

  // real verify calls: 2 (another phone with this code; the right phone with a password)
  test("a new number: another phone with this invite's code is refused without revealing anything; the invited phone + a password creates the account and joins", async ({ page }) => {
    const phone = uniquePhone();
    const code = await invite(phone);
    await page.goto("/join-team");
    await expect(page.getByTestId("join-form")).toBeVisible({ timeout: 30_000 });

    // the screen's own checks (no request)
    await page.getByTestId("join-submit").click();
    await expect(banner(page)).toContainText("أدخلي رقم الهاتف أولاً.");
    await page.getByTestId("join-phone").fill(phone);
    await page.getByTestId("join-submit").click();
    await expect(banner(page)).toContainText("أدخلي رمز التحقق المكوّن من 6 أرقام.");

    // someone else's number with this invite's code
    const other = uniquePhone();
    await fill(page, other, code, "a-strong-password");
    await expect(banner(page)).toContainText("الرمز أو رقم الهاتف غير صحيح.", { timeout: 30_000 });
    await revealsNothing(page);
    expect(await prisma.user.count({ where: { phone: other } })).toBe(0);

    await fill(page, phone, code, "a-strong-password");
    await expect(page.getByTestId("join-done")).toContainText(`تم انضمامك إلى فريق ${legalName} · فرع رام الله`, { timeout: 30_000 });
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    const member = await prisma.vendorUser.findFirstOrThrow({ where: { vendorId, userId: user.id } });
    expect(member.branchId).toBe(branchId);
    expect((await prisma.staffInvite.findFirstOrThrow({ where: { phone, vendorId } })).status).toBe("ACCEPTED");
  });

  // real verify calls: 1 (+ one accept with another phone, which is not an OTP call)
  test("a code verified for one phone never accepts for another (API); an expired invite: ask the owner for a new one", async ({ page }) => {
    const a = uniquePhone();
    const codeA = await invite(a);
    const verified = await call<{ session_token: string }>("/auth/otp/verify", { method: "POST", idempotencyKey: unique("v"), body: { phone: a, otp_code: codeA, purpose: "staff_invite" } });
    expect(verified.status).toBe(200);
    const other = uniquePhone();
    const stolen = await call<{ error: { code: string } }>("/auth/staff-invites/accept", { method: "POST", idempotencyKey: unique("a"), body: { phone: other, verification_token: verified.body.session_token, password: "a-strong-password" } });
    expect(stolen.status).toBe(400);
    expect(stolen.body.error.code).toBe("PHONE_NOT_VERIFIED");
    expect(await prisma.user.count({ where: { phone: other } })).toBe(0);
    expect((await prisma.staffInvite.findFirstOrThrow({ where: { phone: a, vendorId } })).status).toBe("PENDING");

    // an invite past its date, answered by the real API (the code itself is
    // still valid, so this costs one verify call - the last of the five)
    const phone = uniquePhone();
    const code = await invite(phone);
    await prisma.staffInvite.updateMany({ where: { phone, vendorId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await page.goto("/join-team");
    await fill(page, phone, code, "a-strong-password");
    await expect(banner(page)).toContainText("اطلبي دعوة جديدة من صاحبة المتجر", { timeout: 30_000 });
    await revealsNothing(page);
    expect(await prisma.vendorUser.count({ where: { vendorId, user: { phone } } })).toBe(0);
  });

  // no real OTP call: the words for the other refusals and for «إرسال رمز جديد»
  test("the words: a wrong code, an expired code, no account without a password (a new code needed), and the neutral resend notice", async ({ page }) => {
    await page.goto("/join-team");
    await expect(page.getByTestId("join-form")).toBeVisible({ timeout: 30_000 });
    await answer(page, "/auth/otp/verify", 400, refusal("OTP_INVALID"));
    await fill(page, "+970591234567", "123456");
    await expect(banner(page)).toHaveText("الرمز أو رقم الهاتف غير صحيح.", { timeout: 30_000 });
    await page.unroute("**/api/v1/auth/otp/verify");
    await answer(page, "/auth/otp/verify", 409, refusal("OTP_EXPIRED"));
    await page.getByTestId("join-submit").click();
    await expect(banner(page)).toHaveText("انتهت صلاحية الرمز. أرسلي رمزاً جديداً ثم أعيدي المحاولة.");
    await page.unroute("**/api/v1/auth/otp/verify");
    await answer(page, "/auth/otp/verify", 200, { session_token: "verification-token", phone_verified_at: new Date().toISOString() });
    await answer(page, "/auth/staff-invites/accept", 400, refusal("PASSWORD_REQUIRED"));
    await page.getByTestId("join-submit").click();
    await expect(banner(page)).toContainText("اكتبي كلمة مرور جديدة، ثم أرسلي رمزاً جديداً");
    await revealsNothing(page);
    await answer(page, "/auth/otp/request", 202, { expires_in_seconds: 300 });
    await page.getByTestId("join-resend").click();
    await expect(page.getByTestId("join-notice")).toContainText("إن كانت لهذا الرقم دعوة صالحة فسيصله رمز جديد", { timeout: 30_000 });
    await expect(banner(page)).toHaveCount(0);
  });

  test("phone, keyboard, English (LTR) and axe", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/register");
    await expect(page.getByTestId("join-team-entry")).toBeVisible({ timeout: 30_000 });
    await page.goto("/join-team");
    await expect(page.getByTestId("join-form")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expectNoHorizontalOverflow(page);
    // the keyboard: phone -> code -> password, Enter submits
    await page.getByTestId("join-phone").focus();
    await page.keyboard.type("0599000000");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("join-code")).toBeFocused();
    await page.keyboard.type("12ab");
    await expect(page.getByTestId("join-code")).toHaveValue("12"); // digits only
    await page.keyboard.press("Enter");
    await expect(banner(page)).toContainText("أدخلي رمز التحقق المكوّن من 6 أرقام.");

    const axe = async () => {
      await page.addScriptTag({ content: readFileSync(localRequire.resolve("axe-core/axe.min.js"), "utf8") });
      return page.evaluate(async () => {
        const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[]; any: { message: string }[] }[] }[] }> } }).axe;
        const r = await a.run({ include: [['[data-testid="join-team"]']] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.map((n) => `${n.target.join(" ")} - ${n.any[0]?.message ?? ""}`).join(" | ")}`);
      });
    };
    expect(await axe()).toEqual([]);

    await page.setViewportSize({ width: 1360, height: 900 });
    await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
    await page.goto("/join-team");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Join a store team");
    await expect(page.getByTestId("join-submit")).toHaveText(/Accept the invite/);
    await expect(page.getByTestId("join-resend")).toHaveText("No code? Send a new one");
    await page.getByTestId("join-submit").click();
    await expect(banner(page)).toContainText("Enter the phone number first.");
    await expectNoHorizontalOverflow(page);
    expect(await axe()).toEqual([]);
  });
});
