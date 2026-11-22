import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// The owner's product details: «التفاصيل» in the products table opens a
// read-only page in the workspace (not the shopper's page, not a form) -
// summary; colours, images and sizes; stock by branch with the stock screen;
// description, specifications, size table and model; publishing. «تعديل
// المنتج» is the main action, «معاينة كمتسوقة» the secondary one.

const API_BASE = process.env.PW_API_BASE_URL;
const FIX = (name: string) => path.join(__dirname, "fixtures", name);

test.describe("Owner product details", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchA = "";
  let slug = "";
  let offerId = "";
  const title = `فستان تفاصيل ${unique("d").slice(-5)}`;

  test.beforeAll(async () => {
    ({ vendorId, branchId: branchA } = await createVendorWithBranch(fixtures.ownerToken));
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    const form = new FormData();
    form.append("file", new Blob([readFileSync(FIX("tb25/red-1.png"))], { type: "image/png" }), "red-1.png");
    const up = (await (await fetch(`${API_BASE}/vendors/${vendorId}/uploads`, { method: "POST", headers: { Authorization: `Bearer ${fixtures.ownerToken}` }, body: form })).json()) as { url: string };
    const d = await call<{ id: string; revision: number }>(`/vendors/${vendorId}/offer-drafts`, {
      method: "POST",
      token: fixtures.ownerToken,
      body: {
        payload: {
          layout: 5, step: 5, audience: "WOMEN", category: "DRESSES_WOMEN", title_ar: title, title_en: "Details dress",
          brand: { mode: "none" }, specs: { material: "شيفون" },
          colors: [{ key: "BEIGE", family: "BEIGE", name_ar: "بيج رملي", images: [up.url] }],
          size_system: "LETTER", sizes: { BEIGE: ["S", "M"] }, price: 200,
          measurements: { keys: ["CHEST"], values: { S: { CHEST: 86 }, M: { CHEST: 90 } } },
          model: { height_cm: 170, size: "S" },
          stock: { [branchA]: { "BEIGE|S": 3, "BEIGE|M": 2 } },
          description_ar: "وصف للتفاصيل",
        },
      },
    });
    const p = await call<{ offer_id: string }>(`/vendors/${vendorId}/offer-drafts/${d.body.id}/publish`, { method: "POST", token: fixtures.ownerToken, body: { expected_revision: d.body.revision } });
    if (p.status !== 201) throw new Error(`not published (${p.status})`);
    offerId = p.body.offer_id;
  });

  async function open(page: Page) {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers`);
    const details = page.getByTestId(`offers-details-${offerId}`);
    await expect(details).toHaveAttribute("aria-label", `تفاصيل: ${title}`);
    await expect(details).toHaveAttribute("title", `تفاصيل: ${title}`);
    // a quiet eye beside the product name, not among the row actions
    await expect(page.getByTestId(`offers-row-${offerId}`).locator(".owner-cell-title").getByTestId(`offers-details-${offerId}`)).toHaveCount(1);
    await expect(details).toHaveText("");
    await expect(page.locator(`.owner-catalog a[href="/vendor/${vendorId}"]`)).toHaveCount(0);
    await details.click();
    // the same large panel as the wizard - not a separate page (the url stays the products page)
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "details");
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/offers$`));
    await expect(page.getByTestId("details-summary")).toBeVisible({ timeout: 30_000 });
  }

  test("«التفاصيل» opens a read-only page: the summary card then four sections in order, no field or save button; «تعديل المنتج» primary, «معاينة كمتسوقة» secondary to the shopper's page", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("region", { name: "الملخص" })).toBeVisible();
    await expect(page.locator(".owner-details h2")).toHaveText(["الألوان والصور والمقاسات", /^المخزون/, "الوصف والمواصفات", "النشر"]);
    // read only: no field or save anywhere - the collections are chips («إدارة المجموعات» changes them elsewhere)
    await expect(page.locator(".owner-details input, .owner-details select, .owner-details textarea")).toHaveCount(0);
    await expect(page.getByTestId("details-summary").locator("button")).toHaveText(["تعديل المنتج"]);
    await expect(page.getByTestId("details-publish").getByTestId("offer-collections-summary")).toBeVisible();
    await expect(page.getByTestId("wz-panel").getByTestId(`offer-edit-${offerId}`)).toHaveClass(/owner-primary/);
    // the quick status / price page is not linked from here
    await expect(page.getByText("الحالة والسعر السريع")).toHaveCount(0);
    await expect(page.locator(`.owner-details a[href="/vendor/${vendorId}/offers/${offerId}"]`)).toHaveCount(0);
    const summary = page.getByTestId("details-summary");
    await expect(summary.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(summary.locator(".owner-name-en")).toHaveText("Details dress");
    await expect(summary.locator(".owner-name-en")).toHaveAttribute("dir", "ltr");
    await expect(summary).toContainText("نساء › فساتين");
    await expect(summary).toContainText("200.00");
    // no discount: the line is hidden, not «لا يوجد»
    await expect(summary).not.toContainText("الخصم");
    await expect(summary.locator("img")).toHaveCount(1);
    await expect(page.getByTestId("details-colors")).toContainText("بيج رملي");
    const stock = page.getByTestId("details-stock");
    await expect(stock).toContainText("5");
    await expect(stock.getByRole("link")).toHaveAttribute("href", `/vendor/${vendorId}/branches/${branchA}/stock`);
    const about = page.getByTestId("details-about");
    await expect(about).toContainText("وصف للتفاصيل");
    await expect(about).toContainText("شيفون");
    await expect(about).toContainText("170");
    const preview = page.getByTestId("details-preview");
    await expect(preview).toHaveAttribute("href", `/store/${slug}/products/${offerId}`);
    await expect(preview).toHaveAttribute("target", "_blank");
    await expectNoHorizontalOverflow(page);
    // «تعديل المنتج» replaces the panel's content with the edit wizard - still ONE panel
    await page.getByTestId("wz-panel").getByTestId(`offer-edit-${offerId}`).click();
    await expect(page.getByTestId("wz-draft-title")).toHaveText(`تعديل: ${title}`);
    await expect(page.getByTestId("wz-panel")).toHaveCount(1);
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "wizard");
    // «رجوع» returns to the details in the same panel; × closes the whole panel
    await page.getByTestId("wzp-back").click();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "details");
    await expect(page.getByTestId("details-summary")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("wzp-close").click();
    await expect(page.getByTestId("wz-panel")).toHaveCount(0);
    await expect(page.getByTestId(`offers-row-${offerId}`)).toBeVisible();
  });

  test("browser back steps back through the panel's screens, then closes it - the products page stays", async ({ page }) => {
    await open(page);
    await page.getByTestId("wz-panel").getByTestId(`offer-edit-${offerId}`).click();
    await expect(page.getByTestId("wz-draft-title")).toHaveText(`تعديل: ${title}`);
    await page.goBack();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "details");
    await expect(page.getByTestId("details-summary")).toBeVisible({ timeout: 30_000 });
    await page.goBack();
    await expect(page.getByTestId("wz-panel")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/offers$`));
    await expect(page.getByTestId(`offers-row-${offerId}`)).toBeVisible();
    // Esc closes it too
    await page.getByTestId(`offers-details-${offerId}`).click();
    await expect(page.getByTestId("details-summary")).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("wz-panel")).toHaveCount(0);
  });

  test("«استيراد ملف» opens in the same panel; the details and import pages still open directly by their links", async ({ page }) => {
    await open(page);
    await page.getByTestId("wzp-close").click();
    await page.getByRole("link", { name: "استيراد ملف CSV/XLSX" }).click();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "import");
    await expect(page.getByTestId("wz-panel").getByRole("heading", { level: 1 })).toHaveText("استيراد منتجات من ملف");
    await page.getByTestId("wzp-close").click();
    await expect(page.getByTestId("wz-panel")).toHaveCount(0);
    await page.goto(`/vendor/${vendorId}/offers/${offerId}/details`);
    await expect(page.getByTestId("details-summary")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("wz-panel")).toHaveCount(0);
  });

  test("«نسخ كمنتج جديد» is a small dialog: the product, two image cards (without images chosen), Esc cancels", async ({ page }) => {
    await open(page);
    await page.getByTestId("wzp-close").click();
    await page.getByTestId(`offers-copy-${offerId}`).click();
    const dialog = page.getByTestId("copy-dialog");
    await expect(dialog.getByRole("heading", { level: 2 })).toHaveText("نسخ كمنتج جديد");
    await expect(dialog.locator(".cpd-product")).toContainText(title);
    await expect(dialog.locator(".cpd-choice")).toHaveCount(2);
    await expect(page.getByTestId("copy-without-images")).toBeChecked();
    await expect(page.getByTestId("copy-confirm")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("on a phone: the page fits, «تعديل المنتج» stays a clear text button", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await expect(page.getByTestId("wz-panel").getByTestId(`offer-edit-${offerId}`)).toContainText("تعديل المنتج");
    await expectNoHorizontalOverflow(page);
  });
});
