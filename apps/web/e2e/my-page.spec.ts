import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { createVendorWithBranch } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// 2026-11-23 «صفحتي»: one card (no «صفحة المتجر» + «تصميم الصفحة الرئيسية»
// pair); its page is the store page settings as before, with «الرئيسية» in
// its head - the home designer opened in the same management window, whose
// «رجوع» comes back to «صفحتي». Old designer links (the pencil, a link) open
// it through «صفحتي»; the designer as a page of its own links back to it.

const localRequire = createRequire(__filename);

test.describe("«صفحتي»", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let slug = "";
  let flagBefore: boolean | null = null;

  test.beforeAll(async () => {
    const f = await prisma.featureFlag.findUnique({ where: { key: "store_home_blocks_enabled" } });
    flagBefore = f?.enabled ?? null;
    await prisma.featureFlag.upsert({
      where: { key: "store_home_blocks_enabled" },
      create: { key: "store_home_blocks_enabled", enabled: true, description: "test" },
      update: { enabled: true },
    });
    ({ vendorId } = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع صفحتي"));
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
  });
  test.afterAll(async () => {
    // back as it was - a row this spec created is removed again
    if (flagBefore === null) await prisma.featureFlag.deleteMany({ where: { key: "store_home_blocks_enabled" } });
    else await prisma.featureFlag.update({ where: { key: "store_home_blocks_enabled" }, data: { enabled: flagBefore } });
  });

  async function openManagement(page: Page, viewport = { width: 1360, height: 900 }) {
    await page.setViewportSize(viewport);
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/store/${slug}`);
    await page.locator(".store-manage-button").click();
    await expect(page.locator(".store-management-grid")).toBeVisible({ timeout: 30_000 });
  }
  const frameOf = (page: Page) => page.frameLocator(".store-management-detail-frame");
  const title = (page: Page) => page.getByTestId("management-frame-title");

  test("one card «صفحتي»; its page keeps every field; «الرئيسية» opens the designer in the same window and «رجوع» comes back to «صفحتي»", async ({ page }) => {
    await openManagement(page);
    await expect(page.getByTestId("management-tile-storefront/home")).toHaveCount(0);
    const tile = page.getByTestId("management-tile-storefront");
    await expect(tile).toContainText("صفحتي");
    await expect(tile).toContainText("الشعار والغلاف ومعلومات المتجر وحالته وتصميم صفحتك الرئيسية");
    await expect(page.locator(".store-management-grid").getByText("صفحة المتجر", { exact: true })).toHaveCount(0);
    await tile.click();
    await expect(title(page)).toHaveText("صفحتي", { timeout: 30_000 });
    await expect(page.getByTestId("management-frame-back")).toHaveCount(0);
    const frame = frameOf(page);
    // the store page settings as they were: name, logo, cover, contact, the form
    await expect(frame.locator(".storefront-settings-form")).toBeVisible({ timeout: 30_000 });
    await expect(frame.locator(".storefront-basics-section")).toBeVisible();
    const home = frame.getByTestId("mypage-open-home");
    await expect(home).toHaveText("الرئيسية");
    await expect(home).toHaveAccessibleName("الرئيسية: تصميم الصفحة الرئيسية للمتجر");

    await home.click();
    await expect(title(page)).toHaveText("تصميم الصفحة الرئيسية", { timeout: 30_000 });
    await expect(frame.getByTestId("home-designer")).toBeVisible({ timeout: 30_000 });
    // one window, no panel in a panel, no back link inside the window
    await expect(page.locator(".store-management-detail-panel")).toHaveCount(1);
    await expect(frame.getByTestId("mypage-back")).toBeHidden();
    const back = page.getByTestId("management-frame-back");
    await expect(back).toHaveAccessibleName("رجوع إلى صفحتي");
    await back.click();
    await expect(title(page)).toHaveText("صفحتي", { timeout: 30_000 });
    await expect(frame.locator(".storefront-settings-form")).toBeVisible();
    await expect(page.getByTestId("management-frame-back")).toHaveCount(0);
    // still the window on «صفحتي» - not back to the cards
    await expect(page.locator(".store-management-detail-panel")).toHaveCount(1);
  });

  test("old designer links: the pencil on the store page and the old address open the designer on top of «صفحتي»", async ({ page }) => {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/store/${slug}`);
    // the store page's invitation to design (a store with no home yet) opens through «صفحتي»
    await page.getByTestId("store-home-prompt").getByRole("button").click({ timeout: 30_000 });
    await expect(title(page)).toHaveText("تصميم الصفحة الرئيسية", { timeout: 30_000 });
    await expect(page.getByTestId("management-frame-back")).toHaveAccessibleName("رجوع إلى صفحتي");
    await page.getByTestId("management-frame-back").click();
    await expect(title(page)).toHaveText("صفحتي", { timeout: 30_000 });
    // no extra step left behind: «صفحتي» is the window's first page
    await expect(page.getByTestId("management-frame-back")).toHaveCount(0);

    // the designer as a page of its own: one quiet way back to «صفحتي»
    await page.goto(`/vendor/${vendorId}/storefront/home`);
    await expect(page.getByTestId("home-designer")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("mypage-back").click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/storefront$`), { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1, name: "صفحتي" })).toBeVisible();
    await expect(page.getByTestId("mypage-open-home")).toBeVisible();
  });

  test("phone, keyboard, English (LTR) and axe", async ({ page }) => {
    await openManagement(page, { width: 390, height: 844 });
    await page.getByTestId("management-tile-storefront").click();
    const frame = frameOf(page);
    const home = frame.getByTestId("mypage-open-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    // the keyboard: the action is a link; Enter opens the designer
    await home.focus();
    await page.keyboard.press("Enter");
    await expect(title(page)).toHaveText("تصميم الصفحة الرئيسية", { timeout: 30_000 });
    await page.getByTestId("management-frame-back").click();
    await expect(title(page)).toHaveText("صفحتي", { timeout: 30_000 });

    // the page alone (no window): axe, phone, then English
    const axe = async () => {
      await page.addScriptTag({ content: readFileSync(localRequire.resolve("axe-core/axe.min.js"), "utf8") });
      return page.evaluate(async () => {
        const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[]; any: { message: string }[] }[] }[] }> } }).axe;
        const r = await a.run({ include: [[".top-bar"]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.map((n) => `${n.target.join(" ")} - ${n.any[0]?.message ?? ""}`).join(" | ")}`);
      });
    };
    await page.goto(`/vendor/${vendorId}/storefront`);
    await expect(page.getByTestId("mypage-open-home")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    expect(await axe()).toEqual([]);
    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await page.goto(`/vendor/${vendorId}/storefront/home`);
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.getByTestId("mypage-back")).toContainText("My page");
      await page.goto(`/vendor/${vendorId}/storefront`);
      await expect(page.getByTestId("mypage-open-home")).toHaveText("Home", { timeout: 30_000 });
      await expect(page.getByTestId("mypage-open-home")).toHaveAccessibleName("Home: design the store's home page");
      await expectNoHorizontalOverflow(page);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "ar"));
    }
  });
});
