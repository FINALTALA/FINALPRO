import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, uniquePhone } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";

// 2026-11-24 (frontend / UX only): the header has no «أحببته» heart; the
// person icon opens the current personal page directly for a shopping-only
// account and the workspace chooser for an owner / employee (whose shopping
// card leads to the same personal page); «إعدادات المستخدم» inside the
// personal page (addresses, back-in-stock alerts, the account's phone,
// sign-out and closing it); sign-out from anywhere lands on the full sign-in
// page of the site; the store page's loading never shows the legacy bar.

const localRequire = createRequire(__filename);
const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

async function account(lang: "ar" | "en" = "ar") {
  const phone = uniquePhone();
  const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: lang } });
  await prisma.customerProfile.create({ data: { userId: user.id, displayName: "ليلى" } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, phone, token: res.body.session_token };
}
/** An owner of her own store (never the shared fixture: signing out revokes the session). */
async function owner() {
  const a = await account();
  const { vendorId, branchId } = await createVendorWithBranch(a.token);
  await makeVendorEligible(vendorId);
  const slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
  return { ...a, vendorId, branchId, slug };
}
const axe = async (page: Page, sel: string) => {
  await page.addScriptTag({ content: readFileSync(localRequire.resolve("axe-core/axe.min.js"), "utf8") });
  return page.evaluate(async (s) => {
    const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const r = await a.run({ include: [[s]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  }, sel);
};

test.describe("account: header, personal page, user settings, sign-out, store loading", () => {
  test("a shopping-only account: no «أحببته» heart in the header; the person icon (and the phone's «حسابي» tab) open the personal page directly - no chooser", async ({ page }) => {
    const me = await account();
    await page.setViewportSize({ width: 1360, height: 900 });
    await loginAs(page, me.token);
    await page.goto("/");
    const header = page.locator("header").first();
    await expect(header.getByTestId("header-account")).toBeVisible({ timeout: 30_000 });
    await expect(header.getByRole("link", { name: "أحببته" })).toHaveCount(0);
    await header.getByTestId("header-account").click();
    await expect(page).toHaveURL(/\/profile$/, { timeout: 30_000 });
    await expect(page.locator(".account-modal-overlay")).toHaveCount(0);
    // the favourites are still there, on the personal page
    await expect(page.getByRole("tab", { name: /أحببته/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /أتابعه/ })).toBeVisible();
    // /account itself (the phone's tab, an old link) goes to the same page
    await page.goto("/account");
    await expect(page).toHaveURL(/\/profile$/, { timeout: 30_000 });
    // phone: the bottom tab «حسابي»
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/cart");
    await page.locator(".bottom-nav").getByRole("link", { name: "حسابي" }).click();
    await expect(page).toHaveURL(/\/profile$/, { timeout: 30_000 });
    await expect(page.locator(".account-modal-overlay")).toHaveCount(0);
  });

  test("«إعدادات المستخدم» in the personal page: grouped rows (addresses, alerts | phone, sign-out, close), the existing screens come back to it; keyboard focus; English (LTR); phone; axe", async ({ page }) => {
    const me = await account();
    await page.setViewportSize({ width: 1360, height: 900 });
    await loginAs(page, me.token);
    await page.goto("/profile");
    const gear = page.getByTestId("profile-settings-open");
    await expect(gear).toBeVisible({ timeout: 30_000 });
    await expect(gear).toHaveAccessibleName("الإعدادات");
    await gear.click();
    await expect(page).toHaveURL(/\/profile\?view=settings$/);
    const settings = page.getByTestId("user-settings");
    await expect(settings.getByRole("heading", { level: 2 })).toHaveText("إعدادات المستخدم");
    await expect(settings.getByRole("heading", { level: 2 })).toBeFocused();
    await expect(settings.getByRole("group", { name: "التسوّق" })).toContainText("عناويني");
    await expect(settings.getByRole("group", { name: "التسوّق" })).toContainText("تنبيهات عودة التوفر");
    const acct = settings.getByRole("group", { name: "الحساب والأمان" });
    await expect(acct.getByTestId("us-phone")).toContainText(me.phone);
    await expect(acct.getByTestId("us-signout")).toContainText("تسجيل الخروج");
    await expect(acct.getByTestId("us-close")).toContainText("إغلاق الحساب");
    // the tabs and lists are not shown in the settings view
    await expect(page.getByRole("tab", { name: /أحببته/ })).toHaveCount(0);
    // no big cards: a list of rows
    await expect(settings.locator(".hub-tile, .card")).toHaveCount(0);
    expect(await axe(page, '[data-testid="user-settings"]')).toEqual([]);

    // the existing addresses screen, and back to the settings
    await settings.getByTestId("us-addresses").click();
    await expect(page).toHaveURL(/\/account\/addresses$/, { timeout: 30_000 });
    await page.getByTestId("addresses-back").click();
    await expect(page).toHaveURL(/\/profile\?view=settings$/, { timeout: 30_000 });
    // the existing back-in-stock alerts screen, and back
    await page.getByTestId("us-alerts").click();
    await expect(page).toHaveURL(/\/account\/availability-alerts$/, { timeout: 30_000 });
    await page.getByRole("link", { name: /العودة إلى الإعدادات/ }).click();
    await expect(page).toHaveURL(/\/profile\?view=settings$/, { timeout: 30_000 });
    // the phone and closing screens are the existing ones
    await expect(page.getByTestId("us-phone")).toHaveAttribute("href", "/account/phone");
    await expect(page.getByTestId("us-close")).toHaveAttribute("href", "/account/deactivate");

    // keyboard: «رجوع إلى صفحتي» -> the personal page, the focus back on the gear
    await page.getByTestId("us-back").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/profile$/, { timeout: 30_000 });
    await expect(page.getByTestId("profile-settings-open")).toBeFocused();

    // phone width: no sideways scroll, the gear keeps its name
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("profile-settings-open").click();
    await expect(page.getByTestId("user-settings")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // English (LTR)
    await prisma.user.update({ where: { id: me.id }, data: { languagePref: "en" } });
    await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto("/profile?view=settings");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
    const en = page.getByTestId("user-settings");
    await expect(en.getByRole("heading", { level: 2 })).toHaveText("User settings");
    await expect(en.getByRole("group", { name: "Account and security" })).toContainText("Sign out");
    await expect(en.getByTestId("us-addresses")).toContainText("My addresses");
  });

  test("an owner: the person icon opens the workspace chooser; its shopping card and its settings link open the SAME personal page (full page); the owner entry opens the store page directly", async ({ page }) => {
    const o = await owner();
    await page.setViewportSize({ width: 1360, height: 900 });
    await loginAs(page, o.token);
    await page.goto("/");
    await page.getByTestId("header-account").click();
    const overlay = page.locator(".account-modal-overlay");
    await expect(overlay).toBeVisible({ timeout: 30_000 });
    const frame = page.frameLocator(".account-modal-frame");
    await expect(frame.getByTestId("account-workspace-owner")).toBeVisible({ timeout: 30_000 });
    // addresses and the account tiles are no longer in the chooser
    await expect(frame.locator(".hub-tile")).toHaveCount(0);
    await frame.getByTestId("account-workspace-customer").click();
    await expect(page).toHaveURL(/\/profile$/, { timeout: 30_000 });
    await expect(overlay).toHaveCount(0);

    await page.getByTestId("header-account").click();
    await page.frameLocator(".account-modal-frame").getByTestId("account-settings-link").click();
    await expect(page).toHaveURL(/\/profile\?view=settings$/, { timeout: 30_000 });
    await expect(page.getByTestId("user-settings")).toBeVisible();
    await expect(page.locator(".account-modal-overlay")).toHaveCount(0);

    // the store entry: straight to the store page (never the old /vendor/<id> wait)
    await page.goto("/");
    await page.getByTestId("header-account").click();
    await page.frameLocator(".account-modal-frame").getByTestId("account-workspace-owner").click();
    await expect(page).toHaveURL(new RegExp(`/store/${o.slug}$`), { timeout: 30_000 });
  });

  test("sign-out from inside the chooser and from the settings: every window closes, the FULL sign-in page; signing in again opens the whole app", async ({ page }) => {
    const o = await owner();
    await page.setViewportSize({ width: 1360, height: 900 });
    // a real sign-in (no init script, so signing out really signs out)
    await page.goto("/login");
    await page.evaluate((t) => localStorage.setItem("finalpro_session_token", t), o.token);
    await page.goto("/");
    await page.getByTestId("header-account").click();
    await page.frameLocator(".account-modal-frame").getByTestId("account-signout").click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
    await expect(page.locator(".account-modal-overlay")).toHaveCount(0);
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("finalpro_session_token"))).toBeNull();
    // the full page form, then the whole app
    await page.getByLabel("رقم الهاتف").fill(o.phone);
    await page.locator("#password").fill(PASSWORD);
    await page.locator("form button[type=submit]").click();
    await expect(page).toHaveURL(/localhost:\d+\/$/, { timeout: 30_000 });
    await expect(page.getByTestId("header-account")).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);

    // from the personal settings
    await page.goto("/profile?view=settings");
    await page.getByTestId("us-signout").click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
    expect(await page.evaluate(() => localStorage.getItem("finalpro_session_token"))).toBeNull();

    // a sign-in page loaded inside a frame moves the whole window there
    const other = await account();
    await loginAs(page, other.token);
    await page.goto("/profile");
    await page.evaluate(() => {
      const f = document.createElement("iframe");
      f.src = "/login?next=%2Faccount%3Fembed%3Daccount";
      document.body.appendChild(f);
    });
    await expect(page).toHaveURL(/\/login\?next=%2Faccount$/, { timeout: 30_000 });
  });

  test("the store page while it loads: its own skeleton in the content places - never the legacy FINALPRO bar or a wide empty page; also through the old /vendor/<id> address", async ({ page }) => {
    const o = await owner();
    await page.setViewportSize({ width: 1360, height: 900 });
    await loginAs(page, o.token);
    await enterWorkspace(page, o.token, { type: "vendor", vendor_id: o.vendorId });
    // the storefront read is held back, so the loading state stays on screen
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`**/api/v1/storefronts/${o.slug}`, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(`/store/${o.slug}`);
    await expect(page.getByTestId("store-skeleton")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".app-header")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain("FINALPRO");
    expect(await axe(page, '[data-testid="store-skeleton"]')).toEqual([]);
    release();
    await expect(page.locator(".store-name")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("store-skeleton")).toHaveCount(0);
    await page.unroute(`**/api/v1/storefronts/${o.slug}`);

    // the old owner hub address: the same skeleton while it waits, then the store page
    let release2: () => void = () => undefined;
    const held2 = new Promise<void>((r) => (release2 = r));
    await page.route(`**/api/v1/vendors/${o.vendorId}/storefront`, async (route) => {
      await held2;
      await route.continue();
    });
    await page.goto(`/vendor/${o.vendorId}`);
    await expect(page.getByTestId("store-skeleton")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".app-header")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain("FINALPRO");
    release2();
    await expect(page).toHaveURL(new RegExp(`/store/${o.slug}$`), { timeout: 30_000 });
    // phone: the skeleton has no sideways scroll
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/store/${o.slug}`);
    await expect(page.locator(".store-name")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
  });
});
