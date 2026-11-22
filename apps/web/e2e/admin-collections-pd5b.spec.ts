import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { call, unique } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// PD-5b.3: the PLATFORM_ADMIN's platform collections pages - create a
// draft, add/order/save canonical products, publish, archive, reopen,
// delete an eligible draft; honest messages for archived/merged products
// and for products not buyable now; every other role refused; AR/EN,
// desktop/phone without sideways scroll. Products here have no store
// offers on purpose: that is exactly the "not buyable now" case.

async function canonical(name: string, status: "PUBLISHED" | "ARCHIVED" | "MERGED" = "PUBLISHED", mergedIntoId?: string) {
  const brand = await prisma.brand.create({ data: { name: unique("Brand"), normalizedName: unique("b") } });
  const category = await prisma.category.create({ data: { nameAr: unique("فئة"), nameEn: unique("C") } });
  const p = await prisma.canonicalProduct.create({
    data: { brandId: brand.id, categoryId: category.id, modelName: unique("M"), canonicalNameAr: name, status, ...(mergedIntoId ? { mergedIntoId } : {}) },
  });
  return p.id;
}

test.describe("PD-5b.3: platform collections admin", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  const tag = unique("t").slice(-5);
  const names = {
    a: `فستان سهرة ${tag}`,
    b: `حقيبة جلد ${tag}`,
    c: `حذاء كعب ${tag}`,
    archived: `قلادة مؤرشفة ${tag}`,
    merged: `وشاح مدموج ${tag}`,
  };

  test.beforeAll(async () => {
    await canonical(names.a);
    const b = await canonical(names.b);
    await canonical(names.c);
    await canonical(names.archived, "ARCHIVED");
    await canonical(names.merged, "MERGED", b);
  });

  test("the admin creates a draft, adds and orders products, publishes, archives, reopens - and deletes a never-published draft", async ({ page }) => {
    await loginAs(page, fixtures.adminToken);
    await enterWorkspace(page, fixtures.adminToken, { type: "platform" });
    await page.goto("/admin/collections");
    await expect(page.getByRole("heading", { name: "مجموعات المنصة" })).toBeVisible({ timeout: 30_000 });
    const slug = `pw-${tag}`.toLowerCase();
    await page.getByLabel("الرابط (حروف إنجليزية صغيرة وأرقام وشرطات)").fill(slug);
    await page.getByLabel("العنوان بالعربية").fill(`مختارات ${tag}`);
    await page.getByLabel("العنوان بالإنجليزية").fill(`Picks ${tag}`);
    await page.getByRole("button", { name: "إنشاء مسودة" }).click();
    await expect(page.getByRole("heading", { name: `مختارات ${tag}` })).toBeVisible({ timeout: 30_000 });

    for (const key of ["a", "b", "c"] as const) {
      await page.getByLabel("إضافة منتج (ابحثي بالاسم)").fill(names[key]);
      await page.getByRole("list", { name: "نتائج البحث" }).getByRole("button", { name: "إضافة" }).first().click();
    }
    // Move the third up once: a, c, b.
    await page.getByRole("button", { name: `تقديم ${names.c}` }).click();
    await page.getByRole("button", { name: "حفظ المنتجات" }).click();
    await expect(page.getByText("تم حفظ المنتجات")).toBeVisible();
    await expect(page.locator(".admin-collection-item-name")).toHaveText([names.a, names.c, names.b]);
    await expect(page.getByText("3 / 24", { exact: false })).toBeVisible();

    await page.getByLabel("تظهر في الرئيسية").check();
    await page.getByRole("button", { name: "حفظ البيانات" }).click();
    await expect(page.getByText("تم حفظ البيانات")).toBeVisible();

    await page.getByRole("button", { name: "نشر", exact: true }).click();
    await expect(page.locator(".admin-collections .badge").first()).toHaveText("منشورة");
    await expect(page.getByText("ظاهرة الآن").first()).toBeVisible();
    // Honest: these products have no store offers - not buyable now, so not shown.
    await expect(page.getByText("غير متاح للشراء الآن - لا يظهر للعملاء حالياً").first()).toBeVisible();
    // The slug is locked and there is no "reopen" from PUBLISHED.
    await expect(page.getByLabel("الرابط")).toBeDisabled();
    await expect(page.getByRole("button", { name: "إعادة فتح كمسودة" })).toHaveCount(0);

    await page.getByRole("button", { name: "أرشفة" }).click();
    await expect(page.locator(".admin-collections .badge").first()).toHaveText("مؤرشفة");
    await expect(page.getByRole("button", { name: "حفظ المنتجات" })).toHaveCount(0);
    await page.getByRole("button", { name: "إعادة فتح كمسودة" }).click();
    await expect(page.locator(".admin-collections .badge").first()).toHaveText("مسودة");
    // Published once: never deletable.
    await expect(page.getByRole("button", { name: "حذف المسودة" })).toHaveCount(0);

    // The list shows it, and a fresh draft can be deleted from there.
    await page.goto("/admin/collections");
    const row = page.locator(".admin-collection-row", { hasText: `مختارات ${tag}` });
    await expect(row).toContainText("مسودة");
    await expect(row).toContainText("في الرئيسية");
    await expect(row).toContainText("3 / 24");
    await expect(row.getByRole("button", { name: "حذف" })).toHaveCount(0);
    await page.getByLabel("الرابط (حروف إنجليزية صغيرة وأرقام وشرطات)").fill(`pw-del-${tag}`.toLowerCase());
    await page.getByLabel("العنوان بالعربية").fill(`للحذف ${tag}`);
    await page.getByLabel("العنوان بالإنجليزية").fill(`Delete ${tag}`);
    await page.getByRole("button", { name: "إنشاء مسودة" }).click();
    await expect(page.getByRole("heading", { name: `للحذف ${tag}` })).toBeVisible({ timeout: 30_000 });
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "حذف المسودة" }).click();
    await expect(page).toHaveURL(/\/admin\/collections$/);
    await expect(page.locator(".admin-collection-row", { hasText: `للحذف ${tag}` })).toHaveCount(0);
  });

  test("archived and merged products: an honest Arabic refusal, naming the product to add instead", async ({ page }) => {
    await loginAs(page, fixtures.adminToken);
    await enterWorkspace(page, fixtures.adminToken, { type: "platform" });
    await page.goto("/admin/collections");
    await page.locator(".admin-collection-row", { hasText: `مختارات ${tag}` }).getByRole("link", { name: "فتح/تعديل" }).click();
    await expect(page.getByRole("heading", { name: `مختارات ${tag}` })).toBeVisible({ timeout: 30_000 });

    await page.getByLabel("إضافة منتج (ابحثي بالاسم)").fill(names.archived);
    await expect(page.getByRole("list", { name: "نتائج البحث" })).toContainText("مؤرشف");
    await page.getByRole("list", { name: "نتائج البحث" }).getByRole("button", { name: "إضافة" }).click();
    await page.getByRole("button", { name: "حفظ المنتجات" }).click();
    await expect(page.getByText("لا يمكن إضافة منتج مؤرشف")).toBeVisible();
    await page.locator(".admin-collection-items li", { hasText: names.archived }).getByRole("button", { name: "إزالة" }).click();

    await page.getByLabel("إضافة منتج (ابحثي بالاسم)").fill(names.merged);
    await page.getByRole("list", { name: "نتائج البحث" }).getByRole("button", { name: "إضافة" }).click();
    await page.getByRole("button", { name: "حفظ المنتجات" }).click();
    await expect(page.getByText(`هذا المنتج مدموج في «${names.b}»`, { exact: false })).toBeVisible();
    // Nothing was saved.
    await page.reload();
    await expect(page.locator(".admin-collection-item-name")).toHaveText([names.a, names.c, names.b], { timeout: 30_000 });
  });

  test("owner, customer and guest never see the admin pages", async ({ browser }) => {
    const [anyId] = await prisma.platformCollection.findMany({ take: 1, select: { id: true } });
    for (const token of [fixtures.ownerToken, fixtures.customerAToken]) {
      const page = await (await browser.newContext()).newPage();
      await loginAs(page, token);
      for (const url of ["/admin/collections", `/admin/collections/${anyId.id}`]) {
        await page.goto(url);
        // TB-26: stopped at the platform workspace's entry confirmation.
        await expect(page.getByTestId("ws-enter-no-access")).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText("مسودة جديدة")).toHaveCount(0);
        await expect(page.getByText(`مختارات ${tag}`)).toHaveCount(0);
      }
      await page.close();
    }
    const guest = await (await browser.newContext()).newPage();
    await guest.goto("/admin/collections");
    await expect(guest).toHaveURL(/\/login/, { timeout: 30_000 });
    await guest.close();
  });

  test("Arabic and English, desktop and phone: no sideways scroll", async ({ browser }) => {
    const [c] = await prisma.platformCollection.findMany({ where: { slug: `pw-${tag}`.toLowerCase() }, select: { id: true } });
    // A signed-in user's saved language preference wins over the browser's
    // (Sprint 22) - so set the admin's own preference for each language.
    const setLang = (language_pref: string) =>
      call("/customers/me", { method: "PATCH", token: fixtures.adminToken, idempotencyKey: unique("lang"), body: { language_pref } });
    for (const lang of ["ar", "en"]) {
      expect((await setLang(lang)).status).toBe(200);
      for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 760 }]) {
        const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
        await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
        const page = await context.newPage();
        await loginAs(page, fixtures.adminToken);
        await enterWorkspace(page, fixtures.adminToken, { type: "platform" });
        for (const url of ["/admin/collections", `/admin/collections/${c.id}`]) {
          await page.goto(url);
          await expect(page.locator(".admin-collections")).toBeVisible({ timeout: 30_000 });
          await expect(page.locator("html")).toHaveAttribute("dir", lang === "en" ? "ltr" : "rtl");
          await expectNoHorizontalOverflow(page);
        }
        await context.close();
      }
    }
    await setLang("ar");
  });
});
