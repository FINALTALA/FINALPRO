import { expect, test, type Page, type Response } from "@playwright/test";
import { uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";

// VIA Control Center phase 1: a platform admin created out of band
// (seed-platform-staff.ts) has no CustomerProfile. It signs in through the
// real sign-in page, confirms the platform workspace and reaches /admin -
// and GET /customers/me, which AppShell reads on every page, answers 200
// with display_name null instead of failing.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

async function adminWithoutProfile() {
  const phone = uniquePhone();
  const user = await prisma.user.create({
    data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar", platformRole: "PLATFORM_ADMIN" },
  });
  return { id: user.id, phone };
}

function watchMe(page: Page) {
  const seen: { status: number; body: unknown }[] = [];
  page.on("response", async (res: Response) => {
    const url = new URL(res.url());
    if (res.request().method() === "GET" && url.pathname.endsWith("/customers/me")) {
      seen.push({ status: res.status(), body: await res.json().catch(() => null) });
    }
  });
  return seen;
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`a PLATFORM_ADMIN without a CustomerProfile signs in and reaches /admin (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const admin = await adminWithoutProfile();
    const me = watchMe(page);
    const serverErrors: string[] = [];
    page.on("response", (res) => {
      if (res.status() >= 500) serverErrors.push(`${res.status()} ${res.url()}`);
    });

    await page.goto("/login?next=%2Fadmin");
    await page.getByLabel("رقم الهاتف", { exact: true }).fill(admin.phone);
    await page.getByLabel("كلمة المرور", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "تسجيل الدخول" }).click();

    // /admin is a platform workspace page: it asks for the confirmation first.
    await expect(page).toHaveURL(/\/workspaces\/enter\?type=platform/, { timeout: 30_000 });
    await page.getByTestId("ws-enter-confirm").click();
    await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });
    await expect(page.getByTestId("workspace-bar")).toBeVisible();

    await expect.poll(() => me.length, { timeout: 15_000 }).toBeGreaterThan(0);
    for (const r of me) {
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ id: admin.id, display_name: null });
    }
    // The header's cart badge read (GET /cart) is an empty cart, not a 500.
    expect(serverErrors).toEqual([]);

    // The language switch saves the admin's preference on its account.
    // Desktop only: at phone width the footer's switch sits under the
    // fixed bottom nav (.app-footer comes after .app-main, whose bottom
    // padding is the only room kept for the nav) and cannot be clicked on
    // any page - a known AppShell layout issue, reported separately, not
    // hidden here. The API side is covered by admin-account-me.e2e-spec.ts.
    if (viewport.name === "desktop") {
      const saved = page.waitForResponse(
        (res) => res.request().method() === "PATCH" && new URL(res.url()).pathname.endsWith("/customers/me"),
      );
      await page.locator(".lang-switch").first().click();
      const patch = await saved;
      expect(patch.status()).toBe(200);
      expect(await patch.json()).toMatchObject({ id: admin.id, language_pref: "en", display_name: null });
      await expect
        .poll(async () => (await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).languagePref)
        .toBe("en");
    }

    expect(serverErrors).toEqual([]);
    expect(await prisma.customerProfile.count({ where: { userId: admin.id } })).toBe(0);
  });
}
