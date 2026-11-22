import { expect, test, type Page } from "@playwright/test";
import { createVendorWithBranch } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { chooseImportFiles, importFiles } from "./helpers/importFiles";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// «دفعة الاستيراد» and «نشر المحدد» (2026-11-18), in the management window:
// the batch's screen shows ONLY the drafts its import created; a draft is
// reviewed in the wizard or read in its details (an eye, no field) and
// «رجوع» comes back to the batch with the ticks kept; «نشر المحدد» checks
// the chosen drafts with the publish gate first (ready / not and why), then
// publishes only the ready ones after an explicit confirmation; published
// cards cannot be chosen again.

test.describe("Import batch and bulk publishing", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchName = "";
  let batchId = "";

  test.beforeAll(async () => {
    const { vendorId: v, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    vendorId = v;
    await makeVendorEligible(vendorId);
    branchName = (await prisma.storeBranch.findUniqueOrThrow({ where: { id: branchId } })).name;
  });

  async function openImport(page: Page) {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers`);
    await page.getByRole("link", { name: "استيراد ملف CSV/XLSX" }).click();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "import");
  }
  async function importAll(page: Page, titles: string[], shade: number) {
    await chooseImportFiles(
      page,
      await importFiles(
        branchName,
        titles.map((title, i) => ({ title, color: ["أحمر", "أزرق", "أسود"][i % 3], family: ["أحمر", "أزرق", "أسود"][i % 3] })),
        shade,
      ),
    );
    await page.getByTestId("import-check-button").click();
    await expect(page.getByTestId("import-create")).toBeEnabled({ timeout: 60_000 });
    await page.getByTestId("import-create").click();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "import-batch", { timeout: 30_000 });
  }
  /** Back to the batch's screen of this test's import (from the import screen's history). */
  async function openBatch(page: Page) {
    await openImport(page);
    await page.getByTestId(`import-history-open-${batchId}`).click();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "import-batch");
  }

  test("only this import's drafts; «مراجعة وتعديل» and the eye open in the same window, and «رجوع» comes back with the ticks kept", async ({ page }) => {
    await openImport(page);
    // an earlier import of the same store: its draft is not this batch's
    await importAll(page, ["فستان من دفعة سابقة"], 10);
    await page.getByTestId("wzp-back").click();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "import");
    await importAll(page, ["فستان أ", "فستان ب", "فستان ج"], 20);
    const [row] = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM import_batches WHERE "vendorId" = ${vendorId} AND status = 'CONFIRMED' ORDER BY "completedAt" DESC LIMIT 1`;
    batchId = row.id;
    const screen = page.getByTestId("import-batch");
    await expect(screen.locator('[data-testid^="bp-card-"]')).toHaveCount(3);
    await expect(screen).not.toContainText("فستان من دفعة سابقة");
    expect(await prisma.offerDraft.count({ where: { vendorId } })).toBe(4);

    // tick two, review the first in the wizard, come back
    await screen.getByTestId("bp-choose-1").check();
    await screen.getByTestId("bp-choose-2").check();
    await expect(page.getByTestId("bp-bar")).toContainText("محدد 2");
    await screen.getByTestId("bp-review-1").click();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "wizard");
    await expect(page.getByTestId("wz-draft-title")).toHaveText("فستان أ", { timeout: 30_000 });
    await page.goBack();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "import-batch", { timeout: 30_000 });
    await expect(page.getByTestId("bp-choose-1")).toBeChecked();
    await expect(page.getByTestId("bp-choose-2")).toBeChecked();
    await expect(page.getByTestId("bp-bar")).toContainText("محدد 2");

    // the eye: the draft's details, read only, then «رجوع»
    const eye = page.getByTestId("bp-details-3");
    await expect(eye).toHaveAccessibleName("تفاصيل المسودة: فستان ج");
    await eye.click();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "draft-details");
    const details = page.getByTestId("draft-details");
    await expect(details.getByRole("heading", { level: 1 })).toHaveText("فستان ج");
    await expect(details.getByTestId("draft-details-colors")).toContainText("أسود");
    await expect(details.getByTestId("draft-details-ready")).toHaveText("نعم");
    await expect(details.locator("input, textarea, select")).toHaveCount(0);
    await page.getByTestId("wzp-back").click();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "import-batch");
    await expect(page.getByTestId("bp-choose-1")).toBeChecked();
    await expect(page.getByTestId("bp-choose-2")).toBeChecked();
    await expect(page.getByTestId("bp-choose-3")).not.toBeChecked();
  });

  test("another import batch's running publish is not shown as this batch's: the screen stays this batch's, and «نشر المحدد» is refused naming the other batch - nothing of this batch is published", async ({ page }) => {
    // a run of the EARLIER batch, still running (the isolated API's resume is paused: it stays RUNNING)
    const [other] = await prisma.$queryRaw<{ id: string; createdBy: string }[]>`SELECT id, "createdBy" FROM import_batches WHERE "vendorId" = ${vendorId} AND status = 'CONFIRMED' AND id <> ${batchId} LIMIT 1`;
    const runId = `pw-other-batch-${Date.now()}`;
    await prisma.$executeRaw`INSERT INTO bulk_publish_runs (id, "vendorId", "actorId", "importBatchId", status, "correlationId", total) VALUES (${runId}, ${vendorId}, ${other.createdBy}, ${other.id}, 'RUNNING', ${runId}, 0)`;
    try {
      await openBatch(page);
      const screen = page.getByTestId("import-batch");
      await expect(screen.locator('[data-testid^="bp-card-"]')).toHaveCount(3);
      await expect(page.getByTestId("bp-run")).toHaveCount(0);
      await screen.getByTestId("bp-choose-3").check();
      await page.getByTestId("bp-publish-selected").click();
      await page.getByTestId("bp-preflight").getByTestId("bp-confirm").click();
      await page.getByTestId("small-confirm").getByTestId("small-confirm-ok").click();
      await expect(page.getByText("عملية نشر من دفعة استيراد أخرى جارية الآن لهذا المتجر")).toBeVisible();
      await expect(page.getByTestId("bp-run")).toHaveCount(0);
      expect(await prisma.vendorOffer.count({ where: { vendorId } })).toBe(0);
      const [still] = await prisma.$queryRaw<{ status: string }[]>`SELECT status::text FROM bulk_publish_runs WHERE id = ${runId}`;
      expect(still.status).toBe("RUNNING");
    } finally {
      await prisma.$executeRaw`UPDATE bulk_publish_runs SET status = 'DONE', "finishedAt" = now() WHERE id = ${runId}`;
    }
  });

  test("«نشر المحدد»: the preflight says what is ready and what is not (and why); only the ready ones are published after the explicit confirmation; published cards are no longer choosable", async ({ page }) => {
    // «فستان ب» loses its stock after the import: the gate refuses it
    await prisma.$executeRaw`UPDATE offer_drafts SET payload = jsonb_set(payload, '{stock}', '{}'::jsonb), revision = revision + 1 WHERE "importBatchId" = ${batchId} AND "importRef" = '2'`;
    await openBatch(page);
    await page.getByTestId("bp-select-all").check();
    await expect(page.getByTestId("bp-bar")).toContainText("محدد 3");
    await page.getByTestId("bp-publish-selected").click();
    const pre = page.getByTestId("bp-preflight");
    await expect(pre.getByTestId("bp-pre-ready")).toHaveText("جاهزة للنشر: 2");
    await expect(pre.getByTestId("bp-pre-not-ready")).toHaveText("لن تُنشر: 1");
    await expect(pre).toContainText("فستان ب");
    await expect(pre).toContainText("كمية في فرع واحد على الأقل");
    expect(await prisma.vendorOffer.count({ where: { vendorId } })).toBe(0);
    await pre.getByTestId("bp-confirm").click();
    const confirm = page.getByTestId("small-confirm");
    await expect(confirm).toContainText("نشر 2 منتجات الآن؟");
    await confirm.getByTestId("small-confirm-ok").click();
    const run = page.getByTestId("bp-run");
    await expect(run).toHaveAttribute("data-state", "DONE", { timeout: 60_000 });
    await expect(run.getByTestId("bp-count-published")).toHaveText("نُشر: 2");
    await expect(run.getByTestId("bp-count-refused")).toHaveText("لم يُنشر: 0");
    expect(await prisma.vendorOffer.count({ where: { vendorId, status: "ACTIVE" } })).toBe(2);
    await run.getByTestId("bp-back-to-batch").click();
    const screen = page.getByTestId("import-batch");
    await expect(screen.getByTestId("bp-card-1")).toHaveAttribute("data-state", "PUBLISHED");
    await expect(screen.getByTestId("bp-card-3")).toHaveAttribute("data-state", "PUBLISHED");
    await expect(screen.getByTestId("bp-choose-1")).toBeDisabled();
    await expect(screen.getByTestId("bp-card-2")).toHaveAttribute("data-state", "OPEN");
    await expect(screen.getByTestId("bp-choose-2")).toBeEnabled();
    await expect(screen.getByTestId("bp-created")).toContainText("نُشر منها 2");
  });

  test("on a phone: the batch's screen and its bar fit; the ticks work from the keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openBatch(page);
    const choose = page.getByTestId("bp-choose-2");
    await choose.focus();
    await page.keyboard.press("Space");
    await expect(choose).toBeChecked();
    await expect(page.getByTestId("bp-bar")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
