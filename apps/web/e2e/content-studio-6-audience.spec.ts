import { expect, test, type Browser, type Page } from "@playwright/test";
import { call, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";

// VIA phase 6 extension - Women, Men and Kids in the Content Studio, through
// the real screens, on a fresh marked database (asserts per-page state).
//  1. Import parity: each page renders the same text and media in Arabic and
//     English before and after its import, and its live catalogue makes the
//     very same /discovery/all requests.
//  2. Women: a draft edit stays private, the admin preview shows it, publish,
//     restore revision 1.
//  3. Trending: the reviewed English suggestions fill only the 20 empty
//     English values as a draft change (nothing saved or published by it).
//  4. Men editor in English at phone width; public Kids at phone width keeps
//     its layout after import.
// Server rules: apps/api/test/content-studio-6-audience.e2e-spec.ts.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
const PAGES = [
  { key: "WOMEN", path: "/women" },
  { key: "MEN", path: "/men" },
  { key: "KIDS", path: "/kids" },
] as const;

async function user(lang: "ar" | "en" = "ar") {
  const phone = uniquePhone();
  const u = await prisma.user.create({
    data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), platformRole: "PLATFORM_ADMIN", languagePref: lang },
  });
  await prisma.customerProfile.create({ data: { userId: u.id, displayName: "محررة المحتوى" } });
  const login = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
  return login.body.session_token;
}
async function asAdmin(page: Page, token: string, lang: "ar" | "en" = "ar") {
  await page.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
  await loginAs(page, token);
  await enterWorkspace(page, token, { type: "platform" });
}
async function visitor(browser: Browser, lang: "ar" | "en" = "ar", width = 1440) {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
  return { ctx, page };
}
/** Open a public page, wait for its Content Studio answer; returns the catalogue requests it made. */
async function open(page: Page, path: string, key: string) {
  const listing: string[] = [];
  const onReq = (r: { url: () => string }) => {
    const u = new URL(r.url());
    if (u.pathname.endsWith("/discovery/all")) listing.push(u.search);
  };
  page.on("request", onReq);
  const answered = page.waitForResponse((r) => r.url().includes(`/content/${key}`) && r.request().method() === "GET");
  await page.goto(path);
  await answered;
  await page.waitForLoadState("networkidle");
  page.off("request", onReq);
  return listing.sort();
}
function fingerprint(page: Page) {
  return page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement;
    body.querySelectorAll("script, style, noscript, template").forEach((n) => n.remove());
    const text = (body.textContent ?? "").replace(/\s+/g, " ").trim();
    const media = [...document.querySelectorAll("img, video, source")].map((el) =>
      ["src", "srcset", "poster", "alt"].map((a) => el.getAttribute(a) ?? "").join("|"),
    );
    const links = [...document.querySelectorAll("a[href^='#']")].map((a) => a.getAttribute("href"));
    return { text, media, links, overflow: document.documentElement.scrollWidth - window.innerWidth };
  });
}

test.describe.serial("Phase 6 extension: Women, Men, Kids", () => {
  test.use({ reducedMotion: "reduce" });

  test("import: revision 1 renders each page exactly as before (AR + EN, desktop + phone); the catalogue is unchanged", async ({ page, browser }) => {
    test.setTimeout(300_000);
    const views = [
      ["ar", 1440],
      ["en", 1440],
      ["ar", 390],
    ] as const;
    const before: Record<string, unknown> = {};
    for (const p of PAGES)
      for (const [lang, w] of views) {
        const v = await visitor(browser, lang, w);
        const listing = await open(v.page, p.path, p.key);
        before[`${p.key}-${lang}-${w}`] = { ...(await fingerprint(v.page)), listing };
        await v.ctx.close();
      }

    await asAdmin(page, await user());
    for (const p of PAGES) {
      await page.goto(`/admin/content/${p.key}`);
      await page.getByTestId("cs-import-submit").click();
      await expect(page.getByTestId("cs-rev-1")).toBeVisible();
      await expect(page.getByTestId("cs-ready")).toBeVisible(); // all bilingual, decorative art needs no alt
      await expect(page.getByTestId("cs-import-submit")).toHaveCount(0);
    }
    await page.goto("/admin/content");
    for (const p of PAGES) await expect(page.getByTestId(`cs-page-${p.key}`)).toContainText("1");

    for (const p of PAGES)
      for (const [lang, w] of views) {
        const v = await visitor(browser, lang, w);
        const listing = await open(v.page, p.path, p.key);
        expect({ ...(await fingerprint(v.page)), listing }, `${p.key} ${lang} ${w}`).toEqual(before[`${p.key}-${lang}-${w}`]);
        await v.ctx.close();
      }
  });

  test("Women: draft stays private, admin preview, publish, restore revision 1", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await asAdmin(page, await user());
    await page.goto("/admin/content/WOMEN");
    await page.locator("#women-ticker-phrase-1-text-ar").fill("مختارات الأسبوع");
    await page.locator("#women-ticker-phrase-1-text-en").fill("This week's picks");
    await page.getByTestId("cs-save").click();
    await expect(page.getByTestId("cs-notice")).toBeVisible();

    const v = await visitor(browser);
    await open(v.page, "/women", "WOMEN");
    await expect(v.page.locator(".women-ticker")).not.toContainText("مختارات الأسبوع");
    await v.page.goto("/women?content_preview=draft");
    await v.page.waitForLoadState("networkidle");
    await expect(v.page.getByTestId("content-preview-banner")).toHaveCount(0);
    await expect(v.page.locator(".women-ticker")).not.toContainText("مختارات الأسبوع");

    const preview = await page.context().newPage();
    await preview.goto("/women?content_preview=draft");
    await expect(preview.getByTestId("content-preview-ready")).toBeVisible();
    await expect(preview.locator(".women-ticker")).toContainText("مختارات الأسبوع");
    await preview.close();

    await page.getByTestId("cs-publish").click();
    await expect(page.getByTestId("cs-rev-2")).toBeVisible();
    await open(v.page, "/women", "WOMEN");
    await expect(v.page.locator(".women-ticker")).toContainText("مختارات الأسبوع");

    page.once("dialog", (d) => d.accept());
    await page.getByTestId("cs-rev-1").getByRole("button", { name: "استعادة ونشر" }).click();
    await expect(page.getByTestId("cs-rev-3")).toContainText("حية");
    await open(v.page, "/women", "WOMEN");
    await expect(v.page.locator(".women-ticker")).not.toContainText("مختارات الأسبوع");
    await expect(v.page.locator(".women-ticker")).toContainText("اكتشفي أزياء من محلات فلسطينية");
    await v.ctx.close();
  });

  test("Trending: suggested English fills only the 20 empty values, as an unsaved draft change", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await asAdmin(page, await user());
    await page.goto("/admin/content/TRENDING");
    await page.getByTestId("cs-import-submit").click();
    await expect(page.getByTestId("cs-problems")).toContainText("(20)");
    await expect(page.getByTestId("cs-suggest")).toContainText("20");
    await page.getByTestId("cs-suggest").click();
    await expect(page.getByTestId("cs-dirty")).toBeVisible(); // not saved by itself
    await expect(page.getByTestId("cs-suggest")).toHaveCount(0);
    await expect(page.locator("#trend-hero-subline-en")).toHaveValue("The burgundy set, your way.");
    await expect(page.locator("#trend-look-jeans-title-en")).toHaveValue("Wide white high-waisted jeans");
    await expect(page.locator("#trend-collections-liquid-gold-image-alt-en")).toHaveValue("Gold rings and chains on a dark reflective surface");
    // Arabic untouched.
    await expect(page.locator("#trend-look-jeans-title-ar")).toHaveValue("جينز أبيض واسع بخصر عالٍ");

    await page.getByTestId("cs-save").click();
    await expect(page.getByTestId("cs-ready")).toBeVisible();
    // Saved draft only: the live page in English still shows today's Arabic title.
    const v = await visitor(browser, "en");
    await open(v.page, "/trending", "TRENDING");
    await expect(v.page.locator(".ts-sub")).toHaveText("الطقم الخمري، بطريقتك.");
    await v.ctx.close();
    await expect(page.getByTestId("cs-rev-2")).toHaveCount(0); // nothing published
  });

  test("Men editor in English at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await asAdmin(page, await user("en"), "en");
    await page.goto("/admin/content/MEN");
    await expect(page.getByRole("heading", { name: /Content Studio · Men/ })).toBeVisible();
    await expect(page.getByTestId("cs-section-men.offer")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
});
