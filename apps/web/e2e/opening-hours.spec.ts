import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { addToCart, call, createVendorWithBranch, signup, unique, uniquePhone } from "./helpers/api";
import { createOfferWithStock, makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// «ساعات العمل والإغلاقات v1»: the «ساعات العمل والإغلاقات» tab of «إدارة
// الفروع» - the week calendar (several periods a day, overlap refused, copy a
// day, close a day, a draft saved by «حفظ الأسبوع»), the live summary, the
// closures (add, shorten / cancel with a reason, a started one only shortened,
// past ones folded), the employee read only, the phone (day cards + a bottom
// sheet, no sideways scroll), English (LTR), the keyboard and axe; and the
// shopper: «أقرب فتح» on the store page, the product page, the cart, and
// «سيُجهَّز طلبك عند أقرب فتح للفرع: …» at checkout - pickup outside the
// hours still goes through.

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
const AR_DAY = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
/** Today's day of the week in Palestine. */
function todayDow(): number {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hebron", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Date(`${d}T00:00:00Z`).getUTCDay();
}

test.describe("Opening hours & closures v1", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchA = "";
  let branchB = "";
  const H = 3_600_000;

  test.beforeAll(async () => {
    ({ vendorId, branchId: branchA } = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع الماصيون"));
    await makeVendorEligible(vendorId);
    const added = await call<{ id: string }>(`/vendors/${vendorId}/branches`, { method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("branch"), body: { name: "فرع طولكرم" } });
    branchB = added.body.id;
  });

  async function asOwner(page: Page, viewport = { width: 1360, height: 900 }) {
    await page.setViewportSize(viewport);
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
  }
  const url = (branch = branchA) => `/vendor/${vendorId}/branches/${branch}/hours`;
  const savedHours = async () =>
    (await prisma.branchOperatingHours.findMany({ where: { branchId: branchA }, orderBy: [{ dayOfWeek: "asc" }, { openMinute: "asc" }] })).map(
      (h) => `${h.dayOfWeek}:${h.openMinute}-${h.closeMinute}`,
    );

  async function addPeriod(page: Page, day: number, open: string, close: string) {
    await page.getByTestId(`hb-add-${day}`).click();
    const dlg = page.getByTestId("hb-dialog-period");
    await expect(dlg).toBeVisible();
    await dlg.getByTestId("hb-open").selectOption({ label: open });
    await dlg.getByTestId("hb-close").selectOption({ label: close });
    await dlg.getByTestId("hb-period-save").click();
  }

  test("desktop week: two periods on a day, an overlap refused, copy a day, close a day - a draft until «حفظ الأسبوع»", async ({ page }) => {
    await asOwner(page);
    await page.goto(url());
    const grid = page.getByTestId("hb-grid");
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("br-tab-hours")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("hb-summary")).toHaveText("لم تُحدَّد ساعات العمل بعد.");
    await expect(page.getByTestId("hb-save")).toBeDisabled();

    await addPeriod(page, 4, "09:00", "14:00");
    await expect(page.getByTestId("hb-unsaved")).toHaveText("تغييرات غير محفوظة");
    await addPeriod(page, 4, "16:00", "21:00");
    await expect(page.getByTestId("hb-col-4").locator(".hb-block")).toHaveCount(2);
    await expect(page.getByTestId("hb-block-4-0")).toHaveText("09:00–14:00");
    await expect(page.getByTestId("hb-block-4-1")).toHaveText("16:00–21:00");
    await expect(page.getByTestId("hb-col-4")).toHaveAttribute("aria-label", /الخميس/);

    // an overlap is refused in the dialog (and nothing changes)
    await page.getByTestId("hb-add-4").click();
    const dlg = page.getByTestId("hb-dialog-period");
    await dlg.getByTestId("hb-open").selectOption({ label: "13:00" });
    await dlg.getByTestId("hb-close").selectOption({ label: "15:00" });
    await dlg.getByTestId("hb-period-save").click();
    await expect(dlg.getByTestId("hb-period-error")).toHaveText("تتداخل مع فترة أخرى في اليوم نفسه.");
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await expect(page.getByTestId("hb-col-4").locator(".hb-block")).toHaveCount(2);

    // copy Thursday to Sunday and Monday, then close Monday again
    await page.getByTestId("hb-menu-4").click();
    await page.getByTestId("hb-day-copy").click();
    const copy = page.getByTestId("hb-dialog-copy");
    await copy.getByTestId("hb-copy-day-0").check();
    await copy.getByTestId("hb-copy-day-1").check();
    await copy.getByTestId("hb-copy-apply").click();
    await expect(page.getByTestId("hb-col-0").locator(".hb-block")).toHaveCount(2);
    await expect(page.getByTestId("hb-col-1").locator(".hb-block")).toHaveCount(2);
    await page.getByTestId("hb-menu-1").click();
    await page.getByTestId("hb-day-close").click();
    await expect(page.getByTestId("hb-col-1")).toContainText("مغلق");
    await expect(page.getByTestId("hb-notice")).toContainText("لا يُحفظ شيء قبل «حفظ الأسبوع»");
    // still a draft: nothing saved yet
    expect(await savedHours()).toEqual([]);

    await page.getByTestId("hb-save").click();
    await expect(page.getByTestId("hb-notice")).toHaveText("حُفظ الأسبوع.");
    await expect(page.getByTestId("hb-unsaved")).toHaveCount(0);
    expect(await savedHours()).toEqual(["0:540-840", "0:960-1260", "4:540-840", "4:960-1260"]);
    await expect(page.getByTestId("hb-summary")).toContainText(/^الآن: (مفتوح حتى|مغلق)/);
    // the edit dialog of a period: change its end, then discard the draft
    await page.getByTestId("hb-block-0-0").click();
    await page.getByTestId("hb-dialog-period").getByTestId("hb-close").selectOption({ label: "13:00" });
    await page.getByTestId("hb-dialog-period").getByTestId("hb-period-save").click();
    await expect(page.getByTestId("hb-block-0-0")).toHaveText("09:00–13:00");
    await page.getByTestId("hb-discard").click();
    await expect(page.getByTestId("hb-block-0-0")).toHaveText("09:00–14:00");
    // after a reload the saved week is back
    await page.reload();
    await expect(page.getByTestId("hb-col-4").locator(".hb-block")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId("hb-col-1")).toContainText("مغلق");
    const audit = await prisma.auditLog.findFirst({ where: { action: "store_branch.operating_hours_updated", entityId: branchA }, orderBy: { occurredAt: "desc" } });
    expect(audit).not.toBeNull();
  });

  test("closures: add hours on a day, shorten it and cancel it with a reason (audited); a started one is only shortened; past ones are folded", async ({ page }) => {
    // a started closure and an ended one, through the API
    const now = Date.now();
    const started = await call<{ id: string }>(`/vendors/${vendorId}/branches/${branchA}/closures`, {
      method: "POST",
      token: fixtures.ownerToken,
      idempotencyKey: unique("closure"),
      body: { starts_at: new Date(now - 1 * H).toISOString(), ends_at: new Date(now + 3 * H).toISOString(), reason: "جرد" },
    });
    expect(started.status).toBe(201);
    const ended = await call(`/vendors/${vendorId}/branches/${branchA}/closures`, {
      method: "POST",
      token: fixtures.ownerToken,
      idempotencyKey: unique("closure"),
      body: { starts_at: new Date(now - 50 * H).toISOString(), ends_at: new Date(now - 48 * H).toISOString() },
    });
    expect(ended.status).toBe(201);

    await asOwner(page);
    await page.goto(url());
    await expect(page.getByTestId("hc-root")).toBeVisible({ timeout: 30_000 });
    // a closure is always stronger than the week
    await expect(page.getByTestId("hb-summary")).toContainText("الآن: مغلق");
    const active = page.locator('[data-testid="hc-item"][data-state="active"]');
    await expect(active).toHaveCount(1);
    await expect(active).toContainText("جارٍ الآن");
    await expect(active.getByTestId("hc-cancel")).toHaveCount(0);
    await expect(active.getByTestId("hc-shorten")).toBeVisible();
    const history = page.getByTestId("hc-history");
    await expect(history).toContainText("إغلاقات سابقة (1)");
    await expect(history.locator('[data-testid="hc-item"]')).toBeHidden();

    // add: hours on a day, 3 days ahead
    const form = page.getByTestId("hc-form");
    await form.getByTestId("hc-kind-hours").check();
    const day = new Date(Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hebron" }).format(new Date())) + 3 * 86_400_000).toISOString().slice(0, 10);
    await form.getByTestId("hc-date").fill(day);
    await form.getByTestId("hc-from").selectOption({ label: "12:00" });
    await form.getByTestId("hc-to").selectOption({ label: "16:00" });
    await form.getByTestId("hc-reason").fill("صيانة");
    await form.getByTestId("hc-add").click();
    await expect(page.getByTestId("hb-notice")).toHaveText("أُضيف الإغلاق.");
    const upcoming = page.locator('[data-testid="hc-item"][data-state="upcoming"]');
    await expect(upcoming).toHaveCount(1);
    await expect(upcoming).toContainText("12:00–16:00");

    // shorten: the reason is required
    await upcoming.getByTestId("hc-shorten").click();
    const sh = page.getByTestId("hc-dialog-shorten");
    await sh.getByTestId("hc-end-time").selectOption({ label: "14:00" });
    await sh.getByTestId("hc-confirm").click();
    await expect(sh.getByTestId("hc-dialog-error")).toHaveText("السبب مطلوب.");
    await sh.getByTestId("hc-change-reason").fill("انتهت الصيانة أبكر");
    await sh.getByTestId("hc-confirm").click();
    await expect(page.getByTestId("hb-notice")).toHaveText("قُصِّر الإغلاق.");
    await expect(upcoming).toContainText("12:00–14:00");

    // cancel it (not started yet)
    await upcoming.getByTestId("hc-cancel").click();
    const cancel = page.getByTestId("hc-dialog-cancel");
    await cancel.getByTestId("hc-change-reason").fill("أُلغيت الصيانة");
    await cancel.getByTestId("hc-confirm").click();
    await expect(page.getByTestId("hb-notice")).toHaveText("أُلغي الإغلاق.");
    await expect(upcoming).toHaveCount(0);
    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    const rows = await prisma.auditLog.findMany({
      where: { action: { in: ["store_branch.closure_shortened", "store_branch.closure_cancelled"] }, actorId: owner.id },
      orderBy: { occurredAt: "desc" },
      take: 2,
    });
    expect(rows.map((r) => r.action).sort()).toEqual(["store_branch.closure_cancelled", "store_branch.closure_shortened"]);

    // the started closure: shorten «إنهاء الآن» - the branch is no longer closed by it
    await active.getByTestId("hc-shorten").click();
    const end = page.getByTestId("hc-dialog-shorten");
    await expect(end.getByTestId("hc-end-now")).toBeChecked();
    await end.getByTestId("hc-change-reason").fill("انتهى الجرد");
    await end.getByTestId("hc-confirm").click();
    await expect(page.getByTestId("hb-notice")).toHaveText("قُصِّر الإغلاق.");
    await expect(page.locator('[data-testid="hc-item"][data-state="active"]')).toHaveCount(0);
    await expect(history).toContainText("إغلاقات سابقة (2)");
  });

  test("employee: the branch's hours and closures read only - no add, no menu, no save, no closure form or actions", async ({ page }) => {
    const employee = await account("موظفة");
    await prisma.vendorUser.create({ data: { userId: employee.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: branchA } });
    await page.setViewportSize({ width: 1360, height: 900 });
    await loginAs(page, employee.token);
    await enterWorkspace(page, employee.token, { type: "vendor", vendor_id: vendorId });
    await page.goto(url());
    await expect(page.getByTestId("hb-grid")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("br-tab-hours")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("hb-readonly")).toBeVisible();
    await expect(page.getByTestId("hb-col-4").locator(".hb-block")).toHaveCount(2);
    await expect(page.locator('button.hb-block, [data-testid^="hb-add-"], [data-testid^="hb-menu-"], [data-testid="hb-save"], [data-testid="hc-form"], [data-testid="hc-cancel"], [data-testid="hc-shorten"]')).toHaveCount(0);
    await page.goto(url(branchB));
    await expect(page.getByTestId("hb-error")).toBeVisible({ timeout: 30_000 });
  });

  test("phone: day cards with a bottom sheet (add a period there), a read-only mini week, no calendar squeezed, no sideways scroll", async ({ page }) => {
    await asOwner(page, { width: 390, height: 844 });
    await page.goto(url());
    await expect(page.getByTestId("hb-cards")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("hb-grid")).toBeHidden();
    await expect(page.getByTestId("hb-card-4")).toContainText("09:00–14:00");
    await expect(page.getByTestId("hb-card-1")).toContainText("مغلق");
    await page.getByTestId("hb-card-2").click();
    const sheet = page.getByTestId("hb-dialog-day");
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(844 - 2);
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(388);
    await sheet.getByTestId("hb-day-add").click();
    const dlg = page.getByTestId("hb-dialog-period");
    await dlg.getByTestId("hb-open").selectOption({ label: "10:00" });
    await dlg.getByTestId("hb-close").selectOption({ label: "12:30" });
    await dlg.getByTestId("hb-period-save").click();
    await expect(page.getByTestId("hb-card-2")).toContainText("10:00–12:30");
    await expect(page.getByTestId("hb-unsaved")).toBeVisible();
    await expect(page.locator(".hb-miniweek")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByTestId("hb-discard").click();
    await expect(page.getByTestId("hb-card-2")).toContainText("مغلق");
  });

  test("keyboard, English (LTR) and axe", async ({ page }) => {
    await asOwner(page);
    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    const axe = async () => {
      await page.addScriptTag({ content: readFileSync(localRequire.resolve("axe-core/axe.min.js"), "utf8") });
      return page.evaluate(async () => {
        const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[]; any: { message: string }[] }[] }[] }> } }).axe;
        const r = await a.run({ include: [['[data-testid="hb-root"]']] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.map((n) => `${n.target.join(" ")} - ${n.any[0]?.message ?? ""}`).join(" | ")}`);
      });
    };
    await page.goto(url());
    await expect(page.getByTestId("hb-grid")).toBeVisible({ timeout: 30_000 });
    expect(await axe()).toEqual([]);
    // the keyboard: a period is a button; Enter opens its dialog, Escape closes it
    await page.getByTestId("hb-block-4-0").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("hb-dialog-period")).toBeVisible();
    await expect(page.getByTestId("hb-dialog-period").getByTestId("hb-open")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("hb-dialog-period")).toHaveCount(0);
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await page.goto(url());
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.locator(".hb .dw-title")).toHaveText("Opening hours & closures");
      await expect(page.getByTestId("hb-col-1")).toContainText("Closed");
      await expect(page.getByTestId("hb-summary")).toContainText(/^Now: (open until|closed)/);
      await expectNoHorizontalOverflow(page);
      expect(await axe()).toEqual([]);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "ar"));
    }
  });

  test("shopper: «أقرب فتح» on the store page, the product page and the cart; a pickup at checkout outside the hours says when it will be prepared - and goes through", async ({ browser }) => {
    // a fresh store whose only hours are two days from now: closed now
    const shop = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع البيرة");
    await makeVendorEligible(shop.vendorId);
    const variantId = await createOfferWithStock(shop.vendorId, shop.branchId, 80, 10);
    const openDay = (todayDow() + 2) % 7;
    const put = await call(`/vendors/${shop.vendorId}/branches/${shop.branchId}/operating-hours`, {
      method: "PUT",
      token: fixtures.ownerToken,
      body: { hours: [{ day_of_week: openDay, open_minute: 600, close_minute: 1080 }] },
    });
    expect(put.status).toBe(200);
    const next = `أقرب فتح: ${AR_DAY[openDay]} ⁦10:00⁩`;
    const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: shop.vendorId }, select: { slug: true } });
    const variant = await prisma.offerVariant.findUniqueOrThrow({ where: { id: variantId }, select: { vendorOfferId: true } });

    const token = await signup(uniquePhone(), "a-strong-password");
    const line = await addToCart(token, shop.vendorId, variantId, 1);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(
      ({ t, ids }) => {
        localStorage.setItem("finalpro_session_token", t);
        localStorage.setItem("finalpro_active_workspace", JSON.stringify({ type: "customer" }));
        localStorage.setItem("finalpro_lang_pref", "ar");
        sessionStorage.setItem("checkout_cart_item_ids", JSON.stringify(ids));
      },
      { t: token, ids: [line] },
    );
    const page = await context.newPage();

    await page.goto(`/store/${vendor.slug}`);
    await expect(page.getByTestId(`store-info-branch-${shop.branchId}`).getByTestId("store-info-opening")).toHaveText(`مغلق الآن · ${next}`, { timeout: 30_000 });

    await page.goto(`/store/${vendor.slug}/products/${variant.vendorOfferId}`);
    await expect(page.getByText(next, { exact: false }).first()).toBeVisible({ timeout: 30_000 });

    await page.goto("/cart");
    await expect(page.getByTestId("cart-pickup-opening")).toHaveText(`الاستلام من الفرع: مغلق الآن · ${next}`, { timeout: 30_000 });

    await page.goto("/checkout");
    await expect(page.getByTestId("co-pickup-opening")).toHaveText(`سيُجهَّز طلبك عند أقرب فتح للفرع: ${AR_DAY[openDay]} ⁦10:00⁩`, { timeout: 30_000 });
    await page.locator("#terms-accepted").check();
    await page.getByRole("button", { name: /^(متابعة|Continue)$/ }).click();
    await expect(page.getByRole("button", { name: /^(تأكيد الطلب|Confirm the order)$/ })).toBeVisible({ timeout: 20_000 });
    await context.close();
  });
});
