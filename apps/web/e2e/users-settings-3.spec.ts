import { expect, test, type Page } from "@playwright/test";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";

// VIA phase 3 - Users Management + Settings & Team through the real
// screens: find an account, suspend it (reason + confirmation) - its
// session dies - then lift it; a platform admin's page is protected; the
// sole owner of a store explains why it cannot be suspended; Settings &
// Team shows the read-only team and the existing settings; a reviewer is
// refused; English at phone width. The API rules are proven by
// apps/api/test/users-settings-3.e2e-spec.ts.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

async function user(
  platformRole: "PLATFORM_ADMIN" | "VERIFICATION_REVIEWER" | null,
  displayName = "حساب",
  lang: "ar" | "en" = "ar",
) {
  const phone = uniquePhone();
  const u = await prisma.user.create({
    data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), platformRole, languagePref: lang },
  });
  await prisma.customerProfile.create({ data: { userId: u.id, displayName } });
  const login = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
  return { id: u.id, phone, token: login.body.session_token };
}

async function asAdmin(page: Page, token: string, lang: "ar" | "en" = "ar") {
  await page.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
  await loginAs(page, token);
  await enterWorkspace(page, token, { type: "platform" });
}

test.describe("Phase 3: users and settings", () => {
  test("find an account, suspend it with a reason and a confirmation (its session ends), then lift it", async ({ page }) => {
    const name = unique("سلمى");
    const target = await user(null, name);
    const admin = await user("PLATFORM_ADMIN");
    expect((await call("/customers/me", { token: target.token })).status).toBe(200);

    await asAdmin(page, admin.token);
    await page.goto("/admin/users");
    await page.getByLabel("بحث").fill(name);
    await page.getByTestId("au-apply").click();
    await expect(page.getByTestId("au-row")).toHaveCount(1);
    await expect(page.getByTestId("au-row")).not.toContainText(target.phone);
    await page.getByTestId("au-row").getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/admin/users/${target.id}$`));
    await expect(page.getByTestId("au-phone")).toContainText(target.phone.slice(-3));
    await expect(page.getByTestId("au-phone")).not.toContainText(target.phone);

    await expect(page.getByTestId("au-suspend")).toBeDisabled();
    await page.getByLabel("السبب (5 أحرف على الأقل، يُسجَّل في سجل التدقيق)").fill("إساءة استخدام متكررة");
    await page.getByTestId("au-suspend").click();
    await page.getByTestId("small-confirm").getByRole("button", { name: "تراجع" }).click();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).suspendedAt).toBeNull();

    await page.getByTestId("au-suspend").click();
    await page.getByTestId("small-confirm-ok").click();
    await expect(page.getByTestId("au-notice")).toBeVisible();
    await expect(page.getByTestId("au-status")).toHaveText("موقوف من المنصة");
    await expect(page.getByTestId("au-suspension")).toContainText("إساءة استخدام متكررة");
    expect((await call("/customers/me", { token: target.token })).status).toBe(401);

    await page.getByLabel("ملاحظة رفع الإيقاف (5 أحرف على الأقل)").fill("تمت مراجعة الحالة");
    await page.getByTestId("au-lift").click();
    await page.getByTestId("small-confirm-ok").click();
    await expect(page.getByTestId("au-status")).toHaveText("نشط");
  });

  test("a platform admin is protected; the sole owner of a store explains why it cannot be suspended", async ({ page }) => {
    const admin = await user("PLATFORM_ADMIN");
    const other = await user("PLATFORM_ADMIN");
    const owner = await user(null, "مالكة وحيدة");
    const vendor = await prisma.vendor.create({
      data: { slug: unique("u3").toLowerCase(), legalName: unique("متجر"), displayName: unique("متجر وحيد"), status: "ACTIVE", subscriptionStatus: "ACTIVE" },
    });
    await prisma.vendorUser.create({ data: { vendorId: vendor.id, userId: owner.id, role: "OWNER" } });

    await asAdmin(page, admin.token);
    await page.goto(`/admin/users/${other.id}`);
    await expect(page.getByTestId("au-protected")).toBeVisible();
    await expect(page.getByTestId("au-suspend")).toHaveCount(0);

    await page.goto(`/admin/users/${owner.id}`);
    await expect(page.getByTestId("au-sole-owner")).toContainText(vendor.displayName);
    await expect(page.getByTestId("au-memberships")).toContainText(vendor.displayName);
    await page.getByLabel("السبب (5 أحرف على الأقل، يُسجَّل في سجل التدقيق)").fill("سبب كافٍ للاختبار");
    await expect(page.getByTestId("au-suspend")).toBeDisabled();
    // Signing out is still possible for a store owner.
    await expect(page.getByTestId("au-sign-out")).toBeEnabled();
  });

  test("Settings & Team: the read-only team, feature flags, alert recipients and the audit log", async ({ page }) => {
    const admin = await user("PLATFORM_ADMIN", "مديرة الإعدادات");
    const reviewer = await user("VERIFICATION_REVIEWER", "مراجع الإعدادات");
    await asAdmin(page, admin.token);
    await page.goto("/admin/settings");
    const team = page.getByTestId("st-team");
    await expect(team).toContainText("مديرة الإعدادات");
    await expect(team).toContainText("مراجع الإعدادات");
    await expect(team).not.toContainText(reviewer.phone);
    await expect(page.getByTestId("st-flags").getByRole("link")).toHaveAttribute("href", "/admin/feature-flags");
    await expect(page.getByTestId("st-alert-category")).toHaveCount(2);
    await expect(page.getByRole("link", { name: "فتح سجل التدقيق" })).toHaveAttribute("href", "/admin/audit-logs");
  });

  test("a reviewer cannot open users or settings", async ({ page }) => {
    const reviewer = await user("VERIFICATION_REVIEWER");
    await asAdmin(page, reviewer.token);
    for (const path of ["/admin/users", "/admin/settings"]) {
      await page.goto(path);
      await expect(page.getByText("هذه الصفحة لمدير المنصة فقط")).toBeVisible();
    }
  });

  test("English, phone width: left-to-right, no sideways scroll on users, a user and settings", async ({ page }) => {
    const target = await user(null, "Lina");
    const admin = await user("PLATFORM_ADMIN", "Admin", "en");
    await page.setViewportSize({ width: 390, height: 844 });
    await asAdmin(page, admin.token, "en");
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto(`/admin/users/${target.id}`);
    await expect(page.getByRole("heading", { name: "Store memberships" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto("/admin/settings");
    await expect(page.getByRole("heading", { name: "Settings & Team" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
