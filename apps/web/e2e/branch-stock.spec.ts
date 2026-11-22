import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique, uniquePhone } from "./helpers/api";
import { createOfferWithStock, makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// «إدارة مخزون الفرع v1» (2026-11-22): the branch's stock screen - summary
// chips as filters, search, a list with no form in its rows, the chosen
// line beside it (desktop) or as its own screen (phone), the safe
// movements (receive, a count by the counted quantity with «recount» when
// the stock moved, damage / loss, taken out), the large-quantity second
// confirmation, the owner-only threshold, the log, a low-stock link to a
// line off the first page, another branch for an employee, RTL / LTR, the
// keyboard and axe.

const localRequire = createRequire(__filename);
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
async function account(name: string) {
  const phone = uniquePhone();
  const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" } });
  await prisma.customerProfile.create({ data: { userId: user.id, displayName: name } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: "a-strong-password" } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, token: res.body.session_token };
}

test.describe("Branch stock v1", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchA = "";
  let branchB = "";
  const lines: Record<string, string> = {};

  /** A line (one colour x size) with its own title, so the list order is known. */
  async function line(title: string, qty: number) {
    const v = await createOfferWithStock(vendorId, branchA, 100, qty);
    const ov = await prisma.offerVariant.findUniqueOrThrow({ where: { id: v } });
    await prisma.vendorOffer.update({ where: { id: ov.vendorOfferId }, data: { titleAr: title, titleEn: title } });
    return v;
  }
  const qtyOf = async (v: string) =>
    (await prisma.branchStock.findUniqueOrThrow({ where: { branchId_offerVariantId: { branchId: branchA, offerVariantId: v } } })).quantity;

  test.beforeAll(async () => {
    ({ vendorId, branchId: branchA } = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع الماصيون"));
    await makeVendorEligible(vendorId);
    const added = await call<{ id: string }>(`/vendors/${vendorId}/branches`, { method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("branch"), body: { name: "فرع طولكرم" } });
    branchB = added.body.id;
    lines.dress = await line("أ فستان سهرة", 10);
    lines.shirt = await line("ب قميص حرير", 2); // low (1-3, no threshold)
    lines.skirt = await line("ج تنورة", 0); // sold out
    // 21 more lines after them: the last one is off the first page (20 a page)
    for (let i = 0; i < 21; i += 1) lines[`x${i}`] = await line(`ي منتج ${String(i).padStart(2, "0")}`, 5);
    lines.last = lines.x20;
  });

  async function asOwner(page: Page, viewport = { width: 1360, height: 900 }) {
    await page.setViewportSize(viewport);
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
  }
  const url = (branch: string, qs = "") => `/vendor/${vendorId}/branches/${branch}/stock${qs}`;

  test("desktop: summary chips, a compact list with no form in its rows, the chosen line beside it", async ({ page }) => {
    await asOwner(page);
    await page.goto(url(branchA));
    const list = page.getByTestId("sk-list");
    await expect(list).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("sk-sum-lines")).toContainText("24");
    await expect(page.getByTestId("sk-sum-low")).toContainText("1");
    await expect(page.getByTestId("sk-sum-out")).toContainText("1");
    await expect(list.locator("input, select, textarea, button")).toHaveCount(0);
    const rows = list.locator("a.sk-row-link");
    await expect(rows).toHaveCount(20);
    await expect(rows.first()).toHaveAttribute("data-variant-id", lines.dress);
    await expect(page.getByTestId(`stock-row-${lines.shirt}`).getByTestId("sk-badge-low")).toBeVisible();
    await expect(page.getByTestId(`stock-row-${lines.skirt}`).getByTestId("sk-badge-out")).toBeVisible();
    await page.getByTestId(`stock-row-${lines.dress}`).click();
    await expect(page).toHaveURL(new RegExp(`variant=${lines.dress}`));
    const detail = page.getByTestId("sk-detail");
    await expect(detail).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("sk-available")).toHaveText("10");
    await expect(page.getByTestId("sk-physical")).toHaveText("10");
    await expect(page.getByTestId("sk-open-orders")).toHaveText("0");
    // side by side (RTL: the list on the right), the action bar in view
    const lb = (await page.locator(".sk-list-pane").boundingBox())!;
    const db = (await detail.boundingBox())!;
    expect(lb.x).toBeGreaterThan(db.x + db.width - 2);
    const bar = (await page.getByTestId("sk-actionbar").boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(901);
    // the summary chips are filters
    await page.getByTestId("sk-sum-low").click();
    await expect(page).toHaveURL(/filter=low/);
    await expect(list.locator("a.sk-row-link")).toHaveCount(1, { timeout: 30_000 });
    await page.getByTestId("sk-filter-out").click();
    await expect(page).toHaveURL(/filter=out/);
    await expect(list.locator("a.sk-row-link")).toHaveCount(1, { timeout: 30_000 });
    await expect(list.locator("a.sk-row-link")).toHaveAttribute("data-variant-id", lines.skirt);
    await page.getByTestId("sk-filter-all").click();
    await expect(page).not.toHaveURL(/filter=/);
    await expect(list.locator("a.sk-row-link")).toHaveCount(20, { timeout: 30_000 });
    await page.getByTestId("sk-search").fill("قميص");
    await expect(page).toHaveURL(/q=/, { timeout: 10_000 });
    await expect(list.locator("a.sk-row-link")).toHaveCount(1, { timeout: 30_000 });
    await expect(list.locator("a.sk-row-link")).toHaveAttribute("data-variant-id", lines.shirt);
  });

  test("receive (from «+ استلام بضاعة») adds and keeps the last count; a large quantity asks once more", async ({ page }) => {
    await asOwner(page);
    await page.goto(url(branchA));
    await page.getByTestId("sk-receive-open").click({ timeout: 30_000 });
    await page.getByTestId("sk-receive-find").fill("فستان سهرة");
    await page.getByTestId(`sk-pick-${lines.dress}`).click({ timeout: 10_000 });
    const form = page.getByTestId("sk-form-receive");
    await expect(form).toBeVisible({ timeout: 30_000 });
    await form.getByTestId("sk-qty").fill("3");
    await form.getByTestId("sk-note").fill("شحنة المورد");
    await form.getByTestId("sk-submit").click();
    await expect(page.getByTestId("sk-notice")).toHaveText("سُجّل الاستلام.", { timeout: 30_000 });
    await expect(page.getByTestId("sk-physical")).toHaveText("13");
    expect(await qtyOf(lines.dress)).toBe(13);
    const first = page.getByTestId("sk-ledger-row").first();
    await expect(first).toHaveAttribute("data-reason", "RECEIVE");
    await expect(first).toContainText("+3");
    await expect(first).toContainText("شحنة المورد");
    expect((await prisma.branchStock.findUniqueOrThrow({ where: { branchId_offerVariantId: { branchId: branchA, offerVariantId: lines.dress } } })).lastPhysicalCountAt).toBeNull();
    // 60 pieces on a stock of 13: a second, explicit confirmation
    await page.getByTestId("sk-action-receive").click();
    await page.getByTestId("sk-qty").fill("60");
    await page.getByTestId("sk-submit").click();
    const big = page.getByTestId("sk-big-confirm");
    await expect(big).toContainText("60");
    expect(await qtyOf(lines.dress)).toBe(13);
    await big.getByTestId("sk-big-yes").click();
    await expect(page.getByTestId("sk-physical")).toHaveText("73", { timeout: 30_000 });
  });

  test("a count is the number on the shelf: the difference is shown; a stock that moved meanwhile asks to count again; an equal count only confirms", async ({ page }) => {
    await asOwner(page);
    await page.goto(url(branchA, `?variant=${lines.x0}`));
    await page.getByTestId("sk-action-count").click({ timeout: 30_000 });
    const form = page.getByTestId("sk-form-count");
    await expect(form.getByTestId("sk-count-system")).toHaveText("في النظام: 5");
    await form.getByTestId("sk-count-shelf").fill("7");
    await expect(form.getByTestId("sk-count-diff")).toHaveText("الفرق: +2");
    await form.getByTestId("sk-note").fill("جرد الرف");
    await form.getByTestId("sk-submit").click();
    await expect(page.getByTestId("sk-notice")).toHaveText("سُجّل فرق الجرد.", { timeout: 30_000 });
    expect(await qtyOf(lines.x0)).toBe(7);
    await expect(page.getByTestId("sk-ledger-row").first()).toHaveAttribute("data-reason", "COUNT_CORRECTION");

    // someone else's change while counting: nothing is applied, count again
    await page.getByTestId("sk-action-count").click();
    await expect(page.getByTestId("sk-count-system")).toHaveText("في النظام: 7");
    await prisma.branchStock.update({ where: { branchId_offerVariantId: { branchId: branchA, offerVariantId: lines.x0 } }, data: { quantity: 9 } });
    await page.getByTestId("sk-count-shelf").fill("4");
    await page.getByTestId("sk-note").fill("جرد");
    await page.getByTestId("sk-submit").click();
    await expect(page.getByTestId("sk-form-count").getByRole("alert")).toHaveText("تغيّر الرصيد أثناء العد. أعيدي العد من جديد.", { timeout: 30_000 });
    expect(await qtyOf(lines.x0)).toBe(9);
    await expect(page.getByTestId("sk-count-system")).toHaveText("في النظام: 9", { timeout: 30_000 });
    // the same number: a confirmed count, no movement
    await page.getByTestId("sk-count-shelf").fill("9");
    await expect(page.getByTestId("sk-count-diff")).toContainText("مطابق");
    await page.getByTestId("sk-submit").click();
    await expect(page.getByTestId("sk-notice")).toHaveText("تأكد الجرد بلا تغيير.", { timeout: 30_000 });
    expect(await qtyOf(lines.x0)).toBe(9);
  });

  test("damage or loss and taken out: a note is required, never more than available; never a sale", async ({ page }) => {
    await asOwner(page);
    await page.goto(url(branchA, `?variant=${lines.x1}`));
    await page.getByTestId("sk-action-damage").click({ timeout: 30_000 });
    const form = page.getByTestId("sk-form-damage");
    await form.getByTestId("sk-kind-LOSS").check();
    await form.getByTestId("sk-qty").fill("1");
    await form.getByTestId("sk-submit").click();
    await expect(form.getByRole("alert")).toHaveText("اكتبي ملاحظة توضّح السبب.");
    await form.getByTestId("sk-note").fill("فُقدت من الرف");
    await form.getByTestId("sk-submit").click();
    await expect(page.getByTestId("sk-notice")).toHaveText("سُجّل الفقدان.", { timeout: 30_000 });
    expect(await qtyOf(lines.x1)).toBe(4);
    await page.getByTestId("sk-action-internal").click();
    const out = page.getByTestId("sk-form-internal");
    await expect(out).toContainText("تحويل إلى فرع");
    await out.getByTestId("sk-qty").fill("9");
    await out.getByTestId("sk-note").fill("تحويل إلى فرع طولكرم");
    await out.getByTestId("sk-submit").click();
    await expect(out.getByRole("alert")).toHaveText("الكمية أكبر من المتاح (المحجوز للطلبات لا يُخرج).", { timeout: 30_000 });
    await out.getByTestId("sk-qty").fill("2");
    await out.getByTestId("sk-submit").click();
    await expect(page.getByTestId("sk-notice")).toHaveText("سُجّل الإخراج.", { timeout: 30_000 });
    expect(await qtyOf(lines.x1)).toBe(2);
    await expect(page.getByTestId("sk-ledger-row").first()).toHaveAttribute("data-reason", "INTERNAL_USE");
  });

  test("a low-stock link to a line off the first page: fetched, pinned on top, marked and open", async ({ page }) => {
    await asOwner(page);
    await page.goto(url(branchA, `?variant=${lines.last}`));
    const pinned = page.getByTestId("sk-pinned");
    await expect(pinned).toBeVisible({ timeout: 30_000 });
    const row = pinned.getByTestId(`stock-row-${lines.last}`);
    await expect(row).toHaveClass(/is-notified/);
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("sk-list").getByTestId(`stock-row-${lines.last}`)).toHaveCount(0);
    await expect(page.getByTestId("sk-detail")).toHaveAttribute("data-variant-id", lines.last);
  });

  test("the employee: movements and the log in her branch, the threshold read only; another branch is a safe message", async ({ page }) => {
    const emp = await account("سماح موظفة");
    await prisma.vendorUser.create({ data: { userId: emp.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: branchA } });
    await page.setViewportSize({ width: 1360, height: 900 });
    await loginAs(page, emp.token);
    await enterWorkspace(page, emp.token, { type: "vendor", vendor_id: vendorId });
    await page.goto(url(branchA, `?variant=${lines.x2}`));
    await expect(page.getByTestId("sk-detail")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("sk-threshold")).toHaveCount(0);
    await expect(page.getByTestId("sk-threshold-readonly")).toBeVisible();
    await page.getByTestId("sk-action-receive").click();
    await page.getByTestId("sk-qty").fill("1");
    await page.getByTestId("sk-submit").click();
    await expect(page.getByTestId("sk-notice")).toHaveText("سُجّل الاستلام.", { timeout: 30_000 });
    await expect(page.getByTestId("sk-ledger-row").first()).toContainText("سماح موظفة · موظفة");
    let asked = false;
    page.on("request", (r) => {
      // the API only (the page's own address also contains this path)
      if (r.url().includes(`/vendors/${vendorId}/branches/${branchB}/stock`)) asked = true;
    });
    await page.goto(url(branchB));
    await expect(page.getByText("هذا المخزون يخص فرعاً آخر، ولا يمكنك فتحه من هنا.")).toBeVisible({ timeout: 30_000 });
    expect(asked).toBe(false);
  });

  test("the owner's threshold makes a line low", async ({ page }) => {
    await asOwner(page);
    await page.goto(url(branchA, `?variant=${lines.x3}`));
    await page.getByTestId("sk-threshold").fill("6", { timeout: 30_000 });
    await page.getByTestId("sk-threshold-save").click();
    await expect(page.getByTestId("sk-notice")).toHaveText("حُفظت عتبة الأمان.", { timeout: 30_000 });
    await expect(page.getByTestId(`stock-row-${lines.x3}`).getByTestId("sk-badge-low")).toBeVisible({ timeout: 30_000 });
  });

  test("phone: the list, then the line as its own screen; one «رجوع» keeps the filter; the action bar above the bottom bar", async ({ page }) => {
    await asOwner(page, { width: 390, height: 844 });
    await page.goto(url(branchA, "?filter=low"));
    const rows = page.getByTestId("sk-list").locator("a.sk-row-link");
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    await rows.first().click();
    await expect(page.getByTestId("sk-detail")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".sk-list-pane")).toBeHidden();
    await expect(page.locator("#sk-detail-title")).toBeFocused();
    await expectNoHorizontalOverflow(page);
    const bar = (await page.getByTestId("sk-actionbar").boundingBox())!;
    const nav = page.locator(".bottom-nav");
    if (await nav.isVisible()) expect(bar.y + bar.height).toBeLessThanOrEqual((await nav.boundingBox())!.y + 1);
    for (const b of await page.getByTestId("sk-actionbar").locator("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByTestId("sk-back").click();
    await expect(page.locator(".sk-list-pane")).toBeVisible();
    await expect(page).toHaveURL(/filter=low/);
    await expect(page).not.toHaveURL(/variant=/);
  });

  test("keyboard, English (LTR) and axe", async ({ page }) => {
    await asOwner(page);
    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    const axe = async () => {
      await page.addScriptTag({ content: readFileSync(localRequire.resolve("axe-core/axe.min.js"), "utf8") });
      return page.evaluate(async () => {
        const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe;
        const r = await a.run({ include: [['[data-testid="branch-stock"]']] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        return r.violations.map((v) => `${v.id} (${v.nodes.length})`);
      });
    };
    await page.goto(url(branchA, `?variant=${lines.dress}`));
    await expect(page.getByTestId("sk-detail")).toBeVisible({ timeout: 30_000 });
    expect(await axe()).toEqual([]);
    const links = page.getByTestId("sk-list").locator("a.sk-row-link");
    await links.first().focus();
    await page.keyboard.press("ArrowDown");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-variant-id"));
    expect(focused).toBe(await links.nth(1).getAttribute("data-variant-id"));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`variant=${focused}`));
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await page.goto(url(branchA, `?variant=${lines.dress}`));
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.getByTestId("sk-receive-open")).toContainText("Receive goods");
      const lb = (await page.locator(".sk-list-pane").boundingBox())!;
      const db = (await page.getByTestId("sk-detail").boundingBox())!;
      expect(lb.x + lb.width).toBeLessThan(db.x + 2);
      await expectNoHorizontalOverflow(page);
      expect(await axe()).toEqual([]);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "ar"));
    }
  });
});
