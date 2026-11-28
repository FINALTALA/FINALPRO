import { expect, test, type Browser, type Page } from "@playwright/test";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";

// VIA phase 6 - the Content Studio through the real screens, on a fresh
// marked database (it asserts per-page state: run it on its own database).
//  1. Import parity: each page (Homepage, Trending, Ads) renders the same
//     text and media in Arabic and English before and after its import
//     ("revision 1").
//  2. Edit -> private draft (anonymous visitors and ?content_preview never
//     see it) -> admin preview with the same renderers -> publish ->
//     unpublish keeps the page shell -> restore revision 1. A story image
//     is chosen from the Media Library (signed preview, then public URL).
//  3. Schedule at an Asia/Hebron time and cancel it.
//  4. English editor at phone width; a reviewer is refused.
// The server rules are proven by apps/api/test/content-studio-6.e2e-spec.ts.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PAGES = [
  { key: "HOMEPAGE", path: "/" },
  { key: "TRENDING", path: "/trending" },
  { key: "ADS", path: "/ads" },
] as const;

async function user(platformRole: "PLATFORM_ADMIN" | "VERIFICATION_REVIEWER" | null, lang: "ar" | "en" = "ar") {
  const phone = uniquePhone();
  const u = await prisma.user.create({
    data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), platformRole, languagePref: lang },
  });
  await prisma.customerProfile.create({ data: { userId: u.id, displayName: "محررة المحتوى" } });
  const login = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
  return { id: u.id, token: login.body.session_token };
}

async function asAdmin(page: Page, token: string, lang: "ar" | "en" = "ar") {
  await page.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
  await loginAs(page, token);
  await enterWorkspace(page, token, { type: "platform" });
}

/** An anonymous visitor's page (own context: no session, no workspace). */
async function visitor(browser: Browser, lang: "ar" | "en" = "ar") {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
  return { ctx, page };
}

/** Load a public page and wait for its Content Studio answer. */
async function open(page: Page, path: string, pageKey: string) {
  const answered = page.waitForResponse((r) => r.url().includes(`/content/${pageKey}`) && r.request().method() === "GET");
  await page.goto(path);
  await answered;
  await page.waitForLoadState("networkidle");
}

/** What the visitor gets: the page's text and every image / video source (motion reduced; the film clock left out). */
function fingerprint(page: Page) {
  return page.evaluate(() => {
    // Visible copy only: Next's inline scripts carry a per-request id.
    const body = document.body.cloneNode(true) as HTMLElement;
    body.querySelectorAll("script, style, noscript, template").forEach((n) => n.remove());
    const text = (body.textContent ?? "").replace(/\d+\.\ds \/ \d+\.\ds/g, "").replace(/\s+/g, " ").trim();
    const media = [...document.querySelectorAll("img, video, source")].map((el) =>
      ["src", "srcset", "poster"].map((a) => el.getAttribute(a) ?? "").join("|"),
    );
    return { text, media };
  });
}

test.describe.serial("Phase 6: Content Studio", () => {
  test.use({ reducedMotion: "reduce" });

  test("import: revision 1 renders each page exactly as before, in Arabic and English", async ({ page, browser }) => {
    test.setTimeout(240_000);
    const before: Record<string, Awaited<ReturnType<typeof fingerprint>>> = {};
    for (const p of PAGES)
      for (const lang of ["ar", "en"] as const) {
        const v = await visitor(browser, lang);
        await open(v.page, p.path, p.key);
        before[`${p.key}-${lang}`] = await fingerprint(v.page);
        await v.ctx.close();
      }

    const admin = await user("PLATFORM_ADMIN");
    await asAdmin(page, admin.token);
    for (const p of PAGES) {
      await page.goto(`/admin/content/${p.key}`);
      await page.getByTestId("cs-import-submit").click();
      await expect(page.getByTestId("cs-status")).toBeVisible();
      await expect(page.getByTestId("cs-rev-1")).toContainText("1");
    }
    await page.goto("/admin/content");
    for (const p of PAGES) await expect(page.getByTestId(`cs-page-${p.key}`)).toContainText("1");

    for (const p of PAGES)
      for (const lang of ["ar", "en"] as const) {
        const v = await visitor(browser, lang);
        await open(v.page, p.path, p.key);
        const after = await fingerprint(v.page);
        expect(after.text, `${p.key} ${lang} text`).toBe(before[`${p.key}-${lang}`].text);
        expect(after.media, `${p.key} ${lang} media`).toEqual(before[`${p.key}-${lang}`].media);
        await v.ctx.close();
      }
  });

  test("draft stays private, preview, publish with a Media Library image, unpublish keeps the shell, restore", async ({ page, browser }) => {
    test.setTimeout(180_000);
    const admin = await user("PLATFORM_ADMIN");
    await asAdmin(page, admin.token);

    // A library image for the first story.
    const imgName = unique("قصة");
    await page.goto("/admin/media");
    await page.locator("#ml-file").setInputFiles({ name: "story.png", mimeType: "image/png", buffer: PNG });
    await page.locator("#ml-up-category").selectOption("HOMEPAGE");
    await page.locator("#ml-name").fill(imgName);
    await page.getByTestId("ml-upload-submit").click();
    await expect(page.getByTestId("ml-upload-notice")).toBeVisible();

    await page.goto("/admin/content/HOMEPAGE");
    await expect(page.getByTestId("cs-ready")).toBeVisible();
    await page.locator("#home-stories-heading-ar").fill("قصص مختارة");
    await page.locator("#home-stories-heading-en").fill("Chosen Stories");
    await page.getByTestId("cs-pick-home-stories-denim-image").click();
    await page.getByTestId("cs-picker").getByRole("button", { name: imgName }).click();
    await page.locator("#home-stories-denim-image-alt-ar").fill("سروال دنيم أزرق");
    await page.locator("#home-stories-denim-image-alt-en").fill("Blue denim trousers");
    await expect(page.getByTestId("cs-dirty")).toBeVisible();
    await expect(page.getByTestId("cs-publish")).toBeDisabled(); // save first
    await page.getByTestId("cs-save").click();
    await expect(page.getByTestId("cs-notice")).toBeVisible();
    await expect(page.getByTestId("cs-ready")).toBeVisible();

    // Private: the public page and an anonymous preview request keep the live revision.
    const v = await visitor(browser);
    await open(v.page, "/", "HOMEPAGE");
    await expect(v.page.getByRole("heading", { name: "قصص VIA" })).toBeVisible();
    await v.page.goto("/?content_preview=draft");
    await v.page.waitForLoadState("networkidle");
    await expect(v.page.getByTestId("content-preview-banner")).toHaveCount(0);
    await expect(v.page.getByText("قصص مختارة")).toHaveCount(0);

    // The admin preview: same renderer, the draft, a signed preview image.
    const preview = await page.context().newPage();
    await preview.goto("/?content_preview=draft");
    await expect(preview.getByTestId("content-preview-ready")).toBeVisible();
    await expect(preview.getByRole("heading", { name: "قصص مختارة" })).toBeVisible();
    await expect(preview.locator('img[src*="/media/preview/"]')).toHaveCount(1);
    await preview.close();

    // Publish: everyone sees it, the image from its public URL.
    await page.getByTestId("cs-publish").click();
    await expect(page.getByTestId("cs-rev-2")).toContainText("2");
    await open(v.page, "/", "HOMEPAGE");
    await expect(v.page.getByRole("heading", { name: "قصص مختارة" })).toBeVisible();
    await expect(v.page.locator('img[src*="/media/p/"]')).toHaveCount(1);

    // Unpublish: the managed sections leave, the page shell (footer) stays.
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("cs-unpublish").click();
    await expect(page.getByTestId("cs-unpublish")).toHaveCount(0);
    await open(v.page, "/", "HOMEPAGE");
    await expect(v.page.getByText("قصص مختارة")).toHaveCount(0);
    await expect(v.page.getByText("قصص VIA")).toHaveCount(0);
    await expect(v.page.locator("footer").last()).toBeVisible();

    // Restore revision 1 (the import): the original content is live again.
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("cs-rev-1").getByRole("button", { name: "استعادة ونشر" }).click();
    // Immutable history: the restore is a new revision (#3, from #1), now live.
    await expect(page.getByTestId("cs-rev-3")).toContainText("استعادة");
    await expect(page.getByTestId("cs-rev-3")).toContainText("حية");
    await open(v.page, "/", "HOMEPAGE");
    await expect(v.page.getByRole("heading", { name: "قصص VIA" })).toBeVisible();
    await v.ctx.close();
  });

  test("schedule at an Asia/Hebron time, then cancel it", async ({ page }) => {
    const admin = await user("PLATFORM_ADMIN");
    await asAdmin(page, admin.token);
    // Trending's built-in copy is Arabic only: its import keeps English empty
    // (as shown today), and publishing or scheduling waits for the English.
    await page.goto("/admin/content/TRENDING");
    await expect(page.getByTestId("cs-problems")).toContainText("EN text is missing");
    await expect(page.getByTestId("cs-publish")).toBeDisabled();
    await expect(page.getByTestId("cs-schedule-submit")).toBeDisabled();

    await page.goto("/admin/content/HOMEPAGE");
    await expect(page.getByTestId("cs-ready")).toBeVisible();
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Hebron" });
    await page.locator("#cs-date").fill(tomorrow);
    await page.locator("#cs-time").fill("10:30");
    await page.getByTestId("cs-schedule-submit").click();
    await expect(page.getByTestId("cs-sched-PENDING")).toContainText(`${tomorrow} 10:30`);
    await expect(page.getByTestId("cs-revisions")).toContainText("مجدولة");
    await page.getByTestId("cs-schedule-cancel").click();
    await expect(page.getByTestId("cs-sched-PENDING")).toHaveCount(0);
    await expect(page.getByTestId("cs-schedule-cancel")).toHaveCount(0);
  });

  test("English editor at phone width; a reviewer is refused", async ({ page, browser }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await user("PLATFORM_ADMIN", "en");
    await asAdmin(page, admin.token, "en");
    await page.goto("/admin/content/ADS");
    await expect(page.getByRole("heading", { name: /Content Studio · Ads page/ })).toBeVisible();
    await expect(page.getByTestId("cs-section-ads.hero")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    const reviewer = await user("VERIFICATION_REVIEWER");
    const ctx = await browser.newContext();
    const rp = await ctx.newPage();
    await rp.addInitScript(() => localStorage.setItem("finalpro_lang_pref", "ar"));
    await loginAs(rp, reviewer.token);
    await enterWorkspace(rp, reviewer.token, { type: "platform" });
    await rp.goto("/admin/content/HOMEPAGE");
    await expect(rp.getByText("هذه الصفحة لمدير المنصة فقط.")).toBeVisible();
    await ctx.close();
  });
});
