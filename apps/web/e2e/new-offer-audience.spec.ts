import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// «عرض جديد»: the API classifies every new product (audience + category)
// and refuses one without them. The form asks for both - «الفئة المستهدفة»
// (women / men / kids) and «فئة المنتج» limited to that audience - checks
// them before sending, in the interface language, next to each field, and
// sends them as `audiences` / `categories`. The API's own check is
// unchanged.

interface TaxonomyCategory {
  code: string;
  name_ar: string;
  name_en: string;
  audiences: string[];
}

test.describe("New offer: target audience and product category", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let categories: TaxonomyCategory[] = [];

  test.beforeAll(async () => {
    ({ vendorId } = await createVendorWithBranch(fixtures.ownerToken));
    await makeVendorEligible(vendorId);
    categories = (await call<{ categories: TaxonomyCategory[] }>("/taxonomy")).body.categories;
  });

  async function open(page: Page) {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers/new/classic`);
    await expect(page.getByTestId("newoffer-audience")).toBeVisible({ timeout: 30_000 });
  }
  const optionValues = (page: Page) =>
    page.getByTestId("newoffer-category").locator("option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value).filter(Boolean));

  test("the field comes before «فئة المنتج»; creating without them shows each field's own Arabic message and sends nothing", async ({ page }) => {
    await open(page);
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith(`/vendors/${vendorId}/offers`)) posts.push(r.url());
    });
    const order = await page.evaluate(() => {
      const a = document.querySelector('[data-testid="newoffer-audience"]')!;
      const c = document.querySelector('[data-testid="newoffer-category"]')!;
      return a.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING ? "audience-first" : "category-first";
    });
    expect(order).toBe("audience-first");
    await expect(page.locator("legend", { hasText: "الفئة المستهدفة" })).toBeVisible();
    await expect(page.getByTestId("newoffer-category")).toBeDisabled();

    await page.locator(".field input").nth(0).fill("عباية تجريبية");
    await page.locator(".field input").nth(1).fill("Test abaya");
    await page.getByRole("button", { name: "إنشاء العرض" }).click();
    await expect(page.getByTestId("newoffer-audience-error")).toHaveText("اختاري الفئة المستهدفة: نساء أو رجال أو أطفال.");
    await expect(page.getByTestId("newoffer-category-error")).toHaveText("اختاري فئة المنتج.");
    await expect(page.locator("body")).not.toContainText("Choose at least one");
    expect(posts).toEqual([]);
  });

  test("women: only women's categories; the choice survives typing the title and changing the category; a men's switch drops a women-only category; the women's offer is created", async ({ page }) => {
    await open(page);
    await page.getByLabel("نساء").check();
    await expect(page.getByTestId("newoffer-audience-error")).toHaveCount(0);
    const women = categories.filter((c) => c.audiences.includes("WOMEN")).map((c) => c.code).sort();
    expect((await optionValues(page)).sort()).toEqual(women);

    const womenOnly = categories.find((c) => c.audiences.length === 1 && c.audiences[0] === "WOMEN");
    const pick = womenOnly ?? categories.find((c) => c.audiences.includes("WOMEN"))!;
    await page.getByTestId("newoffer-category").selectOption(pick.code);
    // Typing the title keeps both choices.
    await page.locator(".field input").nth(0).fill("عباية سوداء تجريبية");
    await page.locator(".field input").nth(1).fill("Black test abaya");
    await expect(page.getByLabel("نساء")).toBeChecked();
    await expect(page.getByTestId("newoffer-category")).toHaveValue(pick.code);
    // Changing the category keeps the audience.
    const other = categories.find((c) => c.audiences.includes("WOMEN") && c.code !== pick.code)!;
    await page.getByTestId("newoffer-category").selectOption(other.code);
    await expect(page.getByLabel("نساء")).toBeChecked();
    await page.getByTestId("newoffer-category").selectOption(pick.code);

    if (womenOnly) {
      await page.getByLabel("رجال").check();
      await expect(page.getByTestId("newoffer-category")).toHaveValue("");
      const men = categories.filter((c) => c.audiences.includes("MEN")).map((c) => c.code).sort();
      expect((await optionValues(page)).sort()).toEqual(men);
      await page.getByLabel("نساء").check();
      await page.getByTestId("newoffer-category").selectOption(pick.code);
    }

    await page.getByRole("button", { name: "إنشاء العرض" }).click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/offers/[0-9a-f-]{36}$`), { timeout: 30_000 });
    const offerId = page.url().split("/").pop()!;
    const offer = await prisma.vendorOffer.findUniqueOrThrow({
      where: { id: offerId },
      select: { titleAr: true, status: true, audiences: { select: { audience: true } }, categories: { select: { categoryCode: true } } },
    });
    expect(offer.titleAr).toBe("عباية سوداء تجريبية");
    expect(offer.status).toBe("DRAFT");
    expect(offer.audiences.map((a) => a.audience)).toEqual(["WOMEN"]);
    expect(offer.categories.map((c) => c.categoryCode)).toEqual([pick.code]);
  });

  test("English interface: the field and its message are in English", async ({ page }) => {
    const owner = await call<{ id: string }>("/customers/me", { token: fixtures.ownerToken });
    await prisma.user.update({ where: { id: owner.body.id }, data: { languagePref: "en" } });
    try {
      await page.addInitScript(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await open(page);
      await expect(page.locator("legend", { hasText: "Target audience" })).toBeVisible();
      await page.locator(".field input").nth(0).fill(unique("عباية"));
      await page.locator(".field input").nth(1).fill("Abaya");
      await page.getByRole("button", { name: "إنشاء العرض" }).click();
      await expect(page.getByTestId("newoffer-audience-error")).toHaveText("Choose the target audience: women, men or kids.");
      await page.getByLabel("Women").check();
      await expect(page.getByTestId("newoffer-audience-error")).toHaveCount(0);
    } finally {
      await prisma.user.update({ where: { id: owner.body.id }, data: { languagePref: "ar" } });
    }
  });
});
