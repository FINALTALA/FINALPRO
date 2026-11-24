import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import {
  call,
  createVendorWithBranch,
  decideReturn,
  placeAndPickUpOrder,
  submitExchange,
  submitReturn,
  unique,
  uniquePhone,
} from "./helpers/api";
import { createOfferWithStock, createOfferWithTwoVariants, itemIdForOrder, makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// IX-P2 «لوحة إرجاعات الفرع» (2026-11-23) - replaces the Sprint 21 card
// list: the branch's returns as an operating board (tabs with counts, the
// item / order / reason / money / deadline of each return, details and the
// activity, approve / reject), «استلام إرجاع» as ONE entry for the code
// (typed + Enter, a store scanner, the camera) with a safe preview before the
// existing redemption and an explicit result (the amount and how). The raw
// return code never appears on a store screen (IX-P1).

const localRequire = createRequire(__filename);
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

async function account() {
  const phone = uniquePhone();
  const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" } });
  await prisma.customerProfile.create({ data: { userId: user.id } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: "a-strong-password" } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, token: res.body.session_token };
}

/** A camera that "sees" this code: the browser's own BarcodeDetector answers it. */
async function fakeCamera(page: Page, code: string) {
  await page.addInitScript((value) => {
    (window as unknown as Record<string, unknown>).BarcodeDetector = class {
      static async getSupportedFormats() {
        return ["code_128"];
      }
      private calls = 0;
      async detect() {
        this.calls += 1;
        return this.calls > 2 ? [{ rawValue: value }] : [];
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext("2d")!;
      const draw = () => {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, 320, 240);
      };
      draw();
      window.setInterval(draw, 100);
      return (canvas as HTMLCanvasElement & { captureStream: (fps: number) => MediaStream }).captureStream(15);
    };
  }, code);
}

test.describe("«لوحة إرجاعات الفرع» (IX-P2)", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchA = "";
  let branchB = "";
  let employee: Awaited<ReturnType<typeof account>>;

  test.beforeAll(async () => {
    ({ vendorId, branchId: branchA } = await createVendorWithBranch(
      fixtures.ownerToken,
      { mode: "BOTH", window_days: 14, fee_ils: 5, exchange_fee_ils: 10 },
      "فرع رام الله",
    ));
    await makeVendorEligible(vendorId);
    const added = await call<{ id: string }>(`/vendors/${vendorId}/branches`, { method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("branch"), body: { name: "فرع نابلس" } });
    if (added.status !== 201) throw new Error(`branch: ${added.status}`);
    branchB = added.body.id;
    await makeVendorEligible(vendorId);
    employee = await account();
    await prisma.vendorUser.create({ data: { userId: employee.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: branchA } });
  });

  /** A return on a fresh product of this branch; approved when asked (its code from the DB). */
  async function aReturn(branchId: string, approve: boolean, price = 90) {
    const variantId = await createOfferWithStock(vendorId, branchId, price, 5);
    const { branchOrderId } = await placeAndPickUpOrder(fixtures.ownerToken, fixtures.customerAToken, vendorId, branchId, variantId);
    const itemId = await itemIdForOrder(branchOrderId);
    const submitted = await submitReturn(fixtures.customerAToken, branchOrderId, itemId);
    if (submitted.status !== 201) throw new Error(`return: ${submitted.status}`);
    const id = submitted.body.id;
    if (approve) {
      const d = await decideReturn(fixtures.ownerToken, vendorId, branchId, id, { decision: "approve" });
      if (d.status !== 200) throw new Error(`approve: ${d.status}`);
    }
    const r = await prisma.return.findUniqueOrThrow({ where: { id } });
    return { id, branchOrderId, variantId, code: r.code };
  }
  async function asOwner(page: Page, viewport = { width: 1360, height: 900 }) {
    await page.setViewportSize(viewport);
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
  }
  const boardUrl = (branchId: string, qs = "") => `/vendor/${vendorId}/branches/${branchId}/returns${qs}`;

  test("the board: tabs with counts, the working fields of each return, details + activity; approve, and reject with a reason - never the code", async ({ page }) => {
    const r1 = await aReturn(branchA, false);
    const r2 = await aReturn(branchA, false);
    await asOwner(page);
    await page.goto(boardUrl(branchA));
    await expect(page.getByTestId("rb-count-pending_decision")).toHaveText("2", { timeout: 30_000 });
    await expect(page.getByTestId("rt-policy")).toBeVisible();
    const row = page.getByTestId(`rb-row-${r1.id}`);
    await expect(row).toContainText("منتج تجريبي");
    await expect(row).toContainText(`#${r1.branchOrderId.slice(0, 8)}`);
    await expect(row).toContainText("تغيير رأي");
    await expect(row).toContainText("إرجاع");
    await expect(row.getByTestId("rb-row-money")).toContainText("استرداد إلكتروني");
    await expect(row.getByTestId("rb-row-deadline")).toContainText("يُحال إلى المنصة");

    await row.click();
    const detail = page.getByTestId("rb-detail");
    await expect(detail.getByRole("heading", { level: 2 })).toHaveText(`إرجاع #${r1.id.slice(0, 8)}`, { timeout: 30_000 });
    await expect(detail.getByTestId("rb-detail-reason")).toHaveText("تغيير رأي");
    await expect(detail.getByTestId("rb-tl-item")).toHaveCount(1);
    await page.getByTestId("rb-approve").click();
    await expect(page.getByTestId("rb-notice")).toContainText("قُبل الطلب", { timeout: 30_000 });
    await expect(page.getByTestId("rb-count-awaiting_dropoff")).toHaveText("1");
    await expect(page.getByTestId("rb-count-pending_decision")).toHaveText("1");
    await expect(detail.getByTestId("rb-detail-status")).toHaveText("معتمد - بانتظار تسليم المنتج");
    await expect(detail.getByTestId("rb-detail-where")).toContainText("أي فرع");
    await expect(detail.locator('[data-kind="approved"]').getByTestId("rb-tl-actor")).toBeVisible();
    const code1 = (await prisma.return.findUniqueOrThrow({ where: { id: r1.id } })).code!;
    expect(await page.getByTestId("returns-board").innerText()).not.toContain(code1);

    // reject: a reason is required
    await page.getByTestId(`rb-row-${r2.id}`).click();
    await page.getByTestId("rb-reject").click();
    const dlg = page.getByTestId("rb-reject-dialog");
    await expect(dlg.getByTestId("rb-reject-reason")).toBeFocused();
    await dlg.getByTestId("rb-reject-confirm").click();
    await expect(dlg.getByTestId("rb-reject-error")).toHaveText("اكتبي سبباً من 10 أحرف على الأقل.");
    await dlg.getByTestId("rb-reject-reason").fill("آثار استعمال واضحة لا تطابق السبب المذكور.");
    await dlg.getByTestId("rb-reject-confirm").click();
    await expect(page.getByTestId("rb-notice")).toContainText("رُفض الطلب", { timeout: 30_000 });
    await expect(page.getByTestId("rb-count-closed")).toHaveText("1");
    expect((await prisma.return.findUniqueOrThrow({ where: { id: r2.id } })).status).toBe("REJECTED");
  });

  test("«استلام إرجاع»: the old address opens it; a scanner types the code + Enter -> a preview that consumes nothing -> «تالفة» -> the refund in words; a wrong code is refused", async ({ page }) => {
    const r = await aReturn(branchA, true);
    const stockBefore = (await prisma.branchStock.findFirstOrThrow({ where: { branchId: branchA, offerVariantId: r.variantId } })).quantity;
    await asOwner(page);
    await page.goto(`/vendor/${vendorId}/returns/redeem`);
    const dlg = page.getByTestId("rb-receive-dialog");
    await expect(dlg).toBeVisible({ timeout: 30_000 });
    await expect(dlg.getByTestId("rb-receive-branch")).toContainText("فرع رام الله");
    // a store scanner: it types the digits and presses Enter into the focused field
    await expect(dlg.getByTestId("rb-code-input")).toBeFocused();
    await page.keyboard.type(r.code!);
    await page.keyboard.press("Enter");
    const preview = dlg.getByTestId("rb-preview");
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview.getByTestId("rb-preview-item")).toContainText("منتج تجريبي");
    await expect(preview.getByTestId("rb-preview-money")).toContainText("استرداد إلكتروني");
    await expect(preview).toContainText("الكود صالح حتى");
    await expect(preview).toContainText("يُستلم في أي فرع");
    expect((await prisma.return.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("APPROVED_AWAITING_DROPOFF");
    expect(await prisma.branchOrderRefund.count({ where: { returnId: r.id } })).toBe(0);
    await dlg.getByTestId("rb-condition-DAMAGED").check();
    await dlg.getByTestId("rb-confirm").click();
    await expect(dlg.getByTestId("rb-result-money")).toContainText("سُجّل استرداد إلكتروني بمبلغ", { timeout: 30_000 });
    await expect(dlg.getByTestId("rb-result")).toContainText("تالف");
    const done = await prisma.return.findUniqueOrThrow({ where: { id: r.id } });
    expect(done.status).toBe("REFUNDED");
    expect(done.itemCondition).toBe("DAMAGED");
    expect(await prisma.branchOrderRefund.count({ where: { returnId: r.id } })).toBe(1);
    // a damaged item does not go back to stock
    expect((await prisma.branchStock.findFirstOrThrow({ where: { branchId: branchA, offerVariantId: r.variantId } })).quantity).toBe(stockBefore);

    await dlg.getByTestId("rb-another").click();
    await dlg.getByTestId("rb-code-input").fill("000000");
    await dlg.getByTestId("rb-check").click();
    await expect(dlg.getByTestId("rb-receive-error")).toHaveText("هذا الكود غير صالح، أو مستخدم من قبل، أو منتهي.", { timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await expect(page.getByTestId("rb-receive-open")).toBeFocused();
    expect(await page.getByTestId("returns-board").innerText()).not.toContain(r.code!);
  });

  test("the camera reads the code; an exchange shows the replacement and the difference to give back; a COD refund says «نقداً»", async ({ page }) => {
    const { originalVariantId } = await createOfferWithTwoVariants(vendorId, branchA, 100, 5, 80, 5);
    const { branchOrderId } = await placeAndPickUpOrder(fixtures.ownerToken, fixtures.customerAToken, vendorId, branchA, originalVariantId);
    const itemId = await itemIdForOrder(branchOrderId);
    const original = await prisma.offerVariant.findUniqueOrThrow({ where: { id: originalVariantId } });
    const replacement = await prisma.offerVariant.findFirstOrThrow({ where: { vendorOfferId: original.vendorOfferId, id: { not: originalVariantId } } });
    const ex = await submitExchange(fixtures.customerAToken, branchOrderId, itemId, replacement.id, branchA);
    expect(ex.status).toBe(201);
    expect((await decideReturn(fixtures.ownerToken, vendorId, branchA, ex.body.id, { decision: "approve" })).status).toBe(200);
    const code = (await prisma.return.findUniqueOrThrow({ where: { id: ex.body.id } })).code!;

    await fakeCamera(page, code);
    await asOwner(page);
    await page.goto(boardUrl(branchA, "?receive=1"));
    const dlg = page.getByTestId("rb-receive-dialog");
    await dlg.getByTestId("rb-camera").click();
    const preview = dlg.getByTestId("rb-preview");
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview).toContainText("تبديل");
    await expect(preview.getByTestId("rb-preview-replacement")).toContainText("أزرق");
    // 80 - 100 + 10 = -10: given back in cash
    await expect(preview.getByTestId("rb-preview-money")).toContainText("ردّ فرق");
    await expect(preview).toContainText("يُستلم في فرع رام الله فقط");
    await dlg.getByTestId("rb-confirm").click();
    await expect(dlg.getByTestId("rb-result-money")).toContainText("أعيدي للمتسوقة فرق", { timeout: 30_000 });
    await expect(dlg.getByTestId("rb-result-money")).toContainText("ثم سلّميها البديل");
    expect((await prisma.return.findUniqueOrThrow({ where: { id: ex.body.id } })).status).toBe("EXCHANGED");
    await dlg.getByTestId("rb-done").click();

    // a cash-on-delivery order: the refund is handed back in cash
    const cod = await aReturn(branchA, true);
    await prisma.branchOrder.update({ where: { id: cod.branchOrderId }, data: { paymentMethod: "COD" } });
    await page.getByTestId("rb-receive-open").click();
    await dlg.getByTestId("rb-code-input").fill(cod.code!);
    await dlg.getByTestId("rb-code-input").press("Enter");
    await expect(dlg.getByTestId("rb-preview-money")).toContainText("استرداد نقدي", { timeout: 30_000 });
    await dlg.getByTestId("rb-confirm").click();
    await expect(dlg.getByTestId("rb-result-money")).toContainText("أعيدي للمتسوقة", { timeout: 30_000 });
    await expect(dlg.getByTestId("rb-result-money")).toContainText("نقداً");
  });

  test("the owner's «كل الفروع», search and type filter; the employee: her branch only, no scope, receives at her branch; another branch's link is refused", async ({ page }) => {
    const rB = await aReturn(branchB, false);
    await asOwner(page);
    await page.goto(boardUrl(branchA, "?scope=all"));
    await expect(page.getByTestId("rb-scope-all")).toBeChecked({ timeout: 30_000 });
    const rowB = page.getByTestId(`rb-row-${rB.id}`);
    await expect(rowB.getByTestId("rb-row-branch")).toHaveText("فرع نابلس", { timeout: 30_000 });
    await page.getByTestId("rb-branch-filter").selectOption(branchB);
    await expect(rowB).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("a[data-return-id]")).toHaveCount(1);
    // search by the order number
    await page.goto(boardUrl(branchA, "?scope=all"));
    await page.getByTestId("rb-search").fill(`#${rB.branchOrderId.slice(0, 8)}`);
    await expect(page.locator("a[data-return-id]")).toHaveCount(1, { timeout: 30_000 });
    await expect(rowB).toBeVisible();
    // type: no exchange is awaiting a decision
    await page.goto(boardUrl(branchA, "?scope=all&type=EXCHANGE"));
    await expect(page.getByTestId("rb-empty")).toHaveText("لا توجد نتائج لهذا البحث أو الفلتر.", { timeout: 30_000 });

    // the employee of branch A
    const r = await aReturn(branchA, true);
    const emp = await page.context().browser()!.newPage();
    await emp.setViewportSize({ width: 1360, height: 900 });
    await loginAs(emp, employee.token);
    await enterWorkspace(emp, employee.token, { type: "vendor", vendor_id: vendorId });
    await emp.goto(boardUrl(branchA, "?tab=awaiting_dropoff"));
    await expect(emp.getByTestId(`rb-row-${r.id}`)).toBeVisible({ timeout: 30_000 });
    await expect(emp.getByTestId("rb-scope")).toHaveCount(0);
    await expect(emp.getByTestId("rt-policy-link")).toHaveCount(0);
    await emp.getByTestId("rb-receive-open").click();
    const dlg = emp.getByTestId("rb-receive-dialog");
    await dlg.getByTestId("rb-code-input").fill(r.code!);
    await dlg.getByTestId("rb-check").click();
    await dlg.getByTestId("rb-confirm").click();
    await expect(dlg.getByTestId("rb-result-money")).toContainText("سُجّل استرداد إلكتروني", { timeout: 30_000 });
    expect((await prisma.return.findUniqueOrThrow({ where: { id: r.id } })).receivingBranchId).toBe(branchA);
    await emp.goto(boardUrl(branchB));
    await expect(emp.getByText("هذا ليس فرعك.")).toBeVisible({ timeout: 30_000 });
    await expect(emp.getByTestId(`rb-row-${rB.id}`)).toHaveCount(0);
    await emp.close();
  });

  test("phone (list -> full return -> back, the receive dialog as a bottom sheet), keyboard, English (LTR) and axe", async ({ page }) => {
    const r = await aReturn(branchA, false);
    await aReturn(branchA, false); // a second row: the list moves with the arrows
    await asOwner(page, { width: 390, height: 844 });
    await page.goto(boardUrl(branchA));
    const row = page.getByTestId(`rb-row-${r.id}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    await row.click();
    await expect(page.getByTestId("rb-detail").getByRole("heading", { level: 2 })).toBeFocused({ timeout: 30_000 });
    await expect(page.getByTestId("rb-list")).toBeHidden();
    await expectNoHorizontalOverflow(page);
    await page.getByTestId("rb-back").click();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("rb-receive-open").click();
    const sheet = page.getByTestId("rb-receive-dialog");
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(844 - 2);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(boardUrl(branchA));
    await expect(row).toBeVisible({ timeout: 30_000 });
    // keyboard: the list moves with the arrows
    await page.locator("a.bo-row-link").first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("a.bo-row-link").nth(1)).toBeFocused();
    const axe = async (sel: string) => {
      await page.addScriptTag({ content: readFileSync(localRequire.resolve("axe-core/axe.min.js"), "utf8") });
      return page.evaluate(async (s) => {
        const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[]; any: { message: string }[] }[] }[] }> } }).axe;
        const res = await a.run({ include: [[s]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        return res.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.map((n) => `${n.target.join(" ")} - ${n.any[0]?.message ?? ""}`).join(" | ")}`);
      }, sel);
    };
    await row.click();
    await expect(page.getByTestId("rb-tl-item").first()).toBeVisible({ timeout: 30_000 });
    expect(await axe('[data-testid="returns-board"]')).toEqual([]);
    const approved = await aReturn(branchA, true);
    await page.getByTestId("rb-receive-open").click();
    await page.getByTestId("rb-code-input").fill(approved.code!);
    await page.getByTestId("rb-check").click();
    await expect(page.getByTestId("rb-preview")).toBeVisible({ timeout: 30_000 });
    expect(await axe('[data-testid="rb-receive-dialog"]')).toEqual([]);
    await page.keyboard.press("Escape");

    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await page.goto(boardUrl(branchA));
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.getByTestId("rb-tab-pending_decision")).toContainText("Awaiting decision");
      await expect(page.getByTestId("rb-tab-awaiting_dropoff")).toContainText("Awaiting the item");
      await expect(row.getByTestId("rb-row-money")).toHaveText("Online refund ₪85");
      await expect(page.getByTestId("rb-receive-open")).toContainText("Receive a return");
      await expectNoHorizontalOverflow(page);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
    }
  });

  test("the shopper: her code as large digits and CODE128 bars on her own return page", async ({ page }) => {
    const r = await aReturn(branchA, true);
    await loginAs(page, fixtures.customerAToken);
    await page.goto(`/returns/${r.id}`);
    const card = page.getByTestId("return-code-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("return-code-digits")).toHaveText(r.code!);
    await expect.poll(() => card.getByTestId("return-code-barcode").locator("rect").count(), { timeout: 10_000 }).toBeGreaterThan(10);
  });
});
