import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { createVendorWithBranch } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { chooseImportFiles, importFiles, XLSX_TYPE } from "./helpers/importFiles";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// The product import with its images (2026-11-18), as the owner meets it in
// the management window: the store's XLSX template (with «الصور»), the XLSX
// and the ZIP chosen together, a check that creates nothing, its result in
// separate parts - a short head (the files, «لم يُنشأ شيء بعد», the three
// counts, ONE action that follows the ticks), the ready products (with their
// private thumbnail), the possible duplicates (not chosen), the rejected ones
// (never choosable, the reason in plain words) and the notes on the file and
// its images - then only the ticked products are created, and the batch's
// own screen opens in the same window.

const ExcelJS = createRequire(__filename)("exceljs") as typeof import("exceljs");

test.describe("Product import", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchName = "";
  let family = "";
  // the exact bytes uploaded first, to upload the same files again (exceljs stamps the time into each file it writes)
  let firstFiles: { xlsx: Buffer; zip: Buffer } | null = null;

  test.beforeAll(async () => {
    const { vendorId: v, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    vendorId = v;
    await makeVendorEligible(vendorId);
    branchName = (await prisma.storeBranch.findUniqueOrThrow({ where: { id: branchId } })).name;
    family = (await prisma.taxonomyColor.findFirstOrThrow({ where: { code: "BEIGE" } })).nameAr;
  });

  /** 1 ready (two colours, a shared image); 2 rejected (HEIC); 3 the same product as 1 (a possible duplicate); 4 ready. */
  const story = (shade = 0) =>
    importFiles(
      branchName,
      [
        { title: "فستان مستورد", color: "موكا", family, second: { color: "بيج رملي", family }, shared: true },
        { title: "عباية", color: "أسود", family: "أسود", image: "heic" },
        { title: "فستان مستورد", color: "موكا", family, second: { color: "بيج رملي", family } },
        { title: "بلوزة مستوردة", color: "أبيض", family: "أبيض" },
      ],
      shade,
    );

  async function openImport(page: Page) {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers`);
    await page.getByRole("link", { name: "استيراد ملف CSV/XLSX" }).click();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "import");
  }

  test("the check's result in separate parts: a head with «لم يُنشأ شيء بعد», the counts and one action; ready (with the private thumbnail), possible duplicates (not chosen), rejected (the reason in plain words), notes on the files; only the ticked products are created and the batch's screen opens", async ({ page }) => {
    await openImport(page);
    const download = page.waitForEvent("download");
    await page.getByTestId("import-template").click();
    const tpl = new ExcelJS.Workbook();
    await tpl.xlsx.load(readFileSync((await (await download).path())!) as unknown as ArrayBuffer);
    expect(tpl.worksheets.map((w) => w.name)).toEqual(["المنتجات", "الألوان والمقاسات", "الصور", "جدول القياسات", "التعليمات", "القوائم"]);

    const before = await prisma.offerDraft.count({ where: { vendorId } });
    firstFiles = await story();
    // the XLSX alone is not enough
    await page.locator('input[type="file"]').setInputFiles({ name: "products.xlsx", mimeType: XLSX_TYPE, buffer: firstFiles.xlsx });
    await expect(page.getByTestId("import-check-button")).toBeDisabled();
    await chooseImportFiles(page, firstFiles);
    await page.getByTestId("import-check-button").click();
    await expect(page.getByTestId("import-check")).toBeVisible({ timeout: 60_000 });
    expect(await prisma.offerDraft.count({ where: { vendorId } })).toBe(before);

    // the head
    await expect(page.getByText("لم يُنشأ شيء بعد.")).toBeVisible();
    await expect(page.getByTestId("import-count-ready")).toHaveText("جاهز: 2");
    await expect(page.getByTestId("import-count-duplicates")).toHaveText("يحتاج قراراً (تكرار محتمل): 1");
    await expect(page.getByTestId("import-count-rejected")).toHaveText("مرفوض لأسباب أخرى: 1");
    await expect(page.getByTestId("import-count-barcode")).toHaveText("يحتاج باركوداً: 0");
    await expect(page.getByTestId("import-create")).toHaveText("إنشاء 2 مسودات مكتملة غير منشورة");

    // each kind in its own part
    const readyPart = page.getByTestId("import-section-ready");
    await expect(readyPart.getByTestId("import-product-1")).toBeVisible();
    await expect(readyPart.getByTestId("import-product-4")).toBeVisible();
    await expect(page.getByTestId("import-images-1")).toHaveText("موكا: 1 · بيج رملي: 1 · مشتركة: 1");
    // the thumbnail comes from the private staging, through the owner's session
    const thumb = page.getByTestId("import-thumb-1");
    await expect(thumb).toBeVisible({ timeout: 15_000 });
    expect(await thumb.getAttribute("src")).toMatch(/^blob:/);
    const dupPart = page.getByTestId("import-section-duplicates");
    await expect(dupPart.getByTestId("import-product-3")).toContainText("يشبه منتجاً آخر في الملف");
    await expect(page.getByTestId("import-include-3")).not.toBeChecked();
    const rejPart = page.getByTestId("import-section-rejected");
    await expect(rejPart.getByTestId("import-product-2")).toContainText("«p2.heic» بصيغة HEIC (صور iPhone) غير مدعومة");
    await expect(rejPart.getByTestId("import-product-2")).toContainText("«الصور» · صف");
    await expect(rejPart.locator('input[type="checkbox"]')).toHaveCount(0);
    // the general notes are apart from the products
    const notes = page.getByTestId("import-notes");
    await expect(notes.getByTestId("import-zip-summary")).toContainText("صورة جاهزة");
    await expect(notes.getByTestId("import-unused")).toContainText("1 ملف في ZIP غير مذكور");
    await expect(readyPart.getByTestId("import-unused")).toHaveCount(0);

    // only what is ticked: untick 4 -> one draft
    await page.getByTestId("import-choose-4").uncheck();
    await expect(page.getByTestId("import-create")).toHaveText("إنشاء 1 مسودات مكتملة غير منشورة");
    await page.getByTestId("import-create").click();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "import-batch", { timeout: 30_000 });
    const batchScreen = page.getByTestId("import-batch");
    await expect(batchScreen.getByTestId("bp-created")).toContainText("أُنشئت 1 مسودة مكتملة بالصور");
    await expect(batchScreen.getByTestId("bp-card-1")).toContainText("فستان مستورد");
    await expect(batchScreen.locator('[data-testid^="bp-card-"]')).toHaveCount(1);
    await batchScreen.getByTestId("bp-not-created").locator("summary").click();
    await expect(batchScreen.getByTestId("bp-not-created")).toContainText("لم يُختر");
    await expect(batchScreen.getByTestId("bp-not-created")).toContainText("مرفوض في الفحص");
    // the Playwright Prisma client predates the new columns: read them raw
    const drafts = await prisma.$queryRaw<{ importRef: string; payload: { step: number } }[]>`SELECT "importRef", payload FROM offer_drafts WHERE "vendorId" = ${vendorId} AND "importBatchId" IS NOT NULL`;
    expect(drafts.map((d) => d.importRef)).toEqual(["1"]);
    expect(drafts[0].payload.step).toBe(5);
    expect(await prisma.vendorOffer.count({ where: { vendorId } })).toBe(0);
  });

  test("the same files again: the note is with the other notes, «إنشاء» waits for «استيراد هذا الملف مرة أخرى» (never ticked by itself); the likely duplicate is not chosen until included", async ({ page }) => {
    await openImport(page);
    await chooseImportFiles(page, firstFiles!);
    await page.getByTestId("import-check-button").click();
    const notes = page.getByTestId("import-notes");
    await expect(notes.getByTestId("import-same-file")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("import-again")).not.toBeChecked();
    await expect(page.getByTestId("import-section-duplicates").getByTestId("import-product-1")).toContainText("يشبه مسودة مفتوحة «فستان مستورد»");
    await expect(page.getByTestId("import-include-1")).not.toBeChecked();
    await expect(page.getByTestId("import-create")).toBeDisabled();
    await page.getByTestId("import-include-1").check();
    await expect(page.getByTestId("import-create")).toBeDisabled();
    await page.getByTestId("import-again").check();
    await expect(page.getByTestId("import-create")).toBeEnabled();
    await expectNoHorizontalOverflow(page);
  });

  test("on a phone: the import screen and its check fit", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openImport(page);
    await chooseImportFiles(page, await story(90));
    await page.getByTestId("import-check-button").click();
    await expect(page.getByTestId("import-check")).toBeVisible({ timeout: 60_000 });
    await expectNoHorizontalOverflow(page);
  });
});
