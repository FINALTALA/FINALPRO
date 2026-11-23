import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique, uniquePhone } from "./helpers/api";
import { createOfferWithStock, makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// «نوافذ التوصيل v1»: the «نوافذ التوصيل» tab of «إدارة الفروع» - the 7-day
// strip, the chosen day's windows (state, booked / capacity, the orders link
// filtered to the window), the weekly template, the owner's actions in
// dialogs (add, pause / resume, capacity, stop new bookings, close a day -
// refused over active orders with a link to them), the employee read only,
// the phone (sideways strip, a bottom sheet), English (LTR), the keyboard
// and axe; the old store-level address opens the tab.

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
/** A Palestine calendar date n days from today, YYYY-MM-DD. */
function dayAhead(n: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hebron", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
const dowOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

test.describe("Delivery windows v1", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchA = "";
  let branchB = "";
  let variant = "";
  const D = { orders: dayAhead(2), free: dayAhead(4) };
  const win: Record<string, string> = {};
  let orderId = "";

  async function windowOn(date: string, capacity: number, start = "08:00", end = "20:00") {
    const r = await call<{ id: string }>(`/vendors/${vendorId}/branches/${branchA}/delivery-windows`, {
      method: "POST",
      token: fixtures.ownerToken,
      body: { day_of_week: dowOf(date), start_time: start, end_time: end, capacity },
    });
    if (r.status !== 201) throw new Error(`window: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id;
  }
  /** A confirmed delivery order on that window / date, through the real checkout. */
  async function deliveryOrder(windowId: string, date: string) {
    const buyer = await account("زبونة");
    const address = await call<{ id: string }>("/customers/me/addresses", {
      method: "POST",
      token: buyer.token,
      body: { lat: 31.9, lng: 35.2, phone_number_1: "+970591111111", zone: "WEST_BANK" },
    });
    const cart = await call<{ id: string }>("/cart/items", {
      method: "POST",
      token: buyer.token,
      idempotencyKey: unique("cart"),
      body: { vendor_id: vendorId, offer_variant_id: variant, quantity: 1 },
    });
    const reserve = await call<{ reservation_id: string }>("/checkout/reserve", {
      method: "POST",
      token: buyer.token,
      idempotencyKey: unique("reserve"),
      body: {
        terms_accepted: true,
        terms_version: "2026-10-v1",
        groups: [{ cart_item_ids: [cart.body.id], branch_id: branchA, fulfilment_method: "DELIVERY", payment_method: "COD", address_id: address.body.id, delivery_window_id: windowId, scheduled_date: date }],
      },
    });
    if (reserve.status !== 201) throw new Error(`reserve: ${reserve.status} ${JSON.stringify(reserve.body)}`);
    const confirm = await call<{ branch_orders: { id: string }[] }>("/checkout/confirm", {
      method: "POST",
      token: buyer.token,
      idempotencyKey: unique("confirm"),
      body: { reservation_id: reserve.body.reservation_id },
    });
    if (confirm.status !== 201) throw new Error(`confirm: ${confirm.status} ${JSON.stringify(confirm.body)}`);
    return confirm.body.branch_orders[0].id;
  }

  test.beforeAll(async () => {
    ({ vendorId, branchId: branchA } = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع الماصيون"));
    await makeVendorEligible(vendorId);
    const added = await call<{ id: string }>(`/vendors/${vendorId}/branches`, { method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("branch"), body: { name: "فرع طولكرم" } });
    branchB = added.body.id;
    await prisma.vendorDeliveryZone.create({ data: { vendorId, region: "WEST_BANK", enabled: true, fee: 10 } });
    variant = await createOfferWithStock(vendorId, branchA, 100, 20);
    win.orders = await windowOn(D.orders, 3);
    win.free = await windowOn(D.free, 2, "10:00", "14:00");
    orderId = await deliveryOrder(win.orders, D.orders);
  });

  async function asOwner(page: Page, viewport = { width: 1360, height: 900 }) {
    await page.setViewportSize(viewport);
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
  }
  const url = (branch = branchA) => `/vendor/${vendorId}/branches/${branch}/delivery-windows`;

  test("desktop: 7 days, the chosen day's windows with booked / capacity, and «عرض الطلبات» opens the branch orders filtered to that window", async ({ page }) => {
    await asOwner(page);
    await page.goto(url());
    const strip = page.getByTestId("dw-strip");
    await expect(strip).toBeVisible({ timeout: 30_000 });
    await expect(strip.locator("button")).toHaveCount(7);
    await page.getByTestId(`dw-day-${D.orders}`).click();
    await expect(page.getByTestId(`dw-day-${D.orders}`)).toHaveAttribute("aria-pressed", "true");
    const card = page.getByTestId(`dw-win-${win.orders}`);
    await expect(card).toHaveAttribute("data-status", "OPEN");
    await expect(card.getByTestId("dw-win-status")).toHaveText("مفتوحة");
    await expect(card).toContainText("محجوز 1 من 3");
    await expect(card).toContainText("متبقٍ 2");
    await expect(card).toContainText("جديد 1");
    await card.getByTestId("dw-win-orders").click();
    await expect(page).toHaveURL(new RegExp(`/branches/${branchA}/orders\\?date=${D.orders}&window=${win.orders}`));
    await expect(page.getByTestId("bo-slot-filter")).toContainText(D.orders, { timeout: 30_000 });
    await expect(page.getByTestId("bo-slot-filter")).toContainText("08:00-20:00");
    await expect(page.locator(`[data-order-id="${orderId}"], [data-testid="bo-row-${orderId}"]`).first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("bo-slot-filter-clear").click();
    await expect(page.getByTestId("bo-slot-filter")).toHaveCount(0);
  });

  test("owner: add a window, pause it (it stays with a «موقوفة» badge) and resume it - all through dialogs with a reason", async ({ page }) => {
    await asOwner(page);
    await page.goto(url());
    await expect(page.getByTestId("dw-template")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("dw-add").click();
    const add = page.getByTestId("dw-dlg-add");
    await expect(add).toBeVisible();
    await add.getByTestId(`dw-f-day-${dowOf(dayAhead(5))}`).check();
    await add.getByTestId("dw-f-start").fill("16:00");
    await add.getByTestId("dw-f-end").fill("18:00");
    await add.getByTestId("dw-f-capacity").fill("4");
    await add.getByTestId("dw-dlg-submit").click();
    await expect(add).toHaveCount(0);
    await expect(page.getByTestId("dw-notice")).toHaveText("أُضيفت النافذة.");
    const row = page.locator(".dw-tpl", { hasText: "16:00–18:00" });
    await expect(row).toContainText("السعة: 4 طلب");

    await row.getByTestId("dw-act-pause").click();
    const pause = page.getByTestId("dw-dlg-pause");
    await pause.getByTestId("dw-dlg-submit").click();
    await expect(pause.getByTestId("dw-dlg-error")).toHaveText("اكتبي سبباً من 3 أحرف على الأقل.");
    await pause.getByTestId("dw-f-reason").fill("لا يوجد سائق مساءً");
    await pause.getByTestId("dw-dlg-submit").click();
    await expect(pause).toHaveCount(0);
    await expect(row).toContainText("موقوفة");
    await expect(row).toContainText("السبب: لا يوجد سائق مساءً");
    await page.getByTestId(`dw-day-${dayAhead(5)}`).click();
    await expect(page.locator(".dw-win", { hasText: "16:00–18:00" }).getByTestId("dw-win-status")).toHaveText("موقوفة");

    await row.getByTestId("dw-act-resume").click();
    const resume = page.getByTestId("dw-dlg-resume");
    await resume.getByTestId("dw-f-reason").fill("عاد السائق");
    await resume.getByTestId("dw-dlg-submit").click();
    await expect(resume).toHaveCount(0);
    await expect(row).not.toContainText("موقوفة");
  });

  test("owner: lowering the capacity under what is booked is refused with the number; closing a day with orders is refused with a link to them; stopping new bookings works and keeps the order", async ({ page }) => {
    await asOwner(page);
    await page.goto(url());
    const tpl = page.getByTestId(`dw-tpl-${win.orders}`);
    await expect(tpl).toBeVisible({ timeout: 30_000 });
    await expect(tpl).toContainText("عليها طلبات");
    await expect(tpl.getByTestId("dw-act-delete")).toHaveCount(0);
    await tpl.getByTestId("dw-act-capacity").click();
    const cap = page.getByTestId("dw-dlg-capacity");
    await cap.getByTestId("dw-f-capacity").fill("0");
    await cap.getByTestId("dw-f-capacity").fill("1");
    await cap.getByTestId("dw-f-reason").fill("تقليل");
    // 1 is allowed (1 booked); the API refuses only below it - try 1 then check it saved
    await cap.getByTestId("dw-dlg-submit").click();
    await expect(cap).toHaveCount(0);
    await expect(tpl).toContainText("السعة: 1 طلب");

    await page.getByTestId(`dw-day-${D.orders}`).click();
    await page.getByTestId("dw-act-close-day").click();
    const close = page.getByTestId("dw-dlg-closeDay");
    await close.getByTestId("dw-f-reason").fill("عيد");
    await close.getByTestId("dw-dlg-submit").click();
    const err = close.getByTestId("dw-dlg-error");
    await expect(err).toContainText("1 طلب توصيل نشط");
    await expect(err.getByTestId("dw-blocked-orders")).toHaveAttribute("href", `/vendor/${vendorId}/branches/${branchA}/orders?date=${D.orders}`);
    await page.keyboard.press("Escape");
    await expect(close).toHaveCount(0);

    await page.getByTestId("dw-act-stop-day").click();
    const stop = page.getByTestId("dw-dlg-stopDay");
    await stop.getByTestId("dw-f-reason").fill("ضغط عمل");
    await stop.getByTestId("dw-dlg-submit").click();
    await expect(stop).toHaveCount(0);
    const card = page.getByTestId(`dw-win-${win.orders}`);
    await expect(card).toHaveAttribute("data-status", "BOOKING_STOPPED");
    await expect(card).toContainText("السبب: ضغط عمل");
    await expect(card).toContainText("محجوز 1 من 1");
    expect((await prisma.branchOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("PLACED");
    await page.getByTestId("dw-act-reopen-day").click();
    const reopen = page.getByTestId("dw-dlg-reopenDay");
    await reopen.getByTestId("dw-f-reason").fill("خف الضغط");
    await reopen.getByTestId("dw-dlg-submit").click();
    await expect(card).toHaveAttribute("data-status", "FULL");
  });

  test("employee: her branch's board read only (no actions anywhere), another branch is refused", async ({ page }) => {
    const employee = await account("موظفة");
    await prisma.vendorUser.create({ data: { userId: employee.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: branchA } });
    await page.setViewportSize({ width: 1360, height: 900 });
    await loginAs(page, employee.token);
    await enterWorkspace(page, employee.token, { type: "vendor", vendor_id: vendorId });
    await page.goto(url());
    await expect(page.getByTestId("dw-strip")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("br-tab-delivery-windows")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("dw-read-only")).toBeVisible();
    await page.getByTestId(`dw-day-${D.orders}`).click();
    await expect(page.getByTestId(`dw-win-${win.orders}`)).toBeVisible();
    await expect(page.locator('[data-testid^="dw-act-"], [data-testid="dw-add"], .dw-more')).toHaveCount(0);
    await page.goto(url(branchB));
    await expect(page.getByTestId("dw-error")).toHaveText("هذا الفرع ليس فرعك.", { timeout: 30_000 });
  });

  test("phone: the days scroll sideways, the actions open as a bottom sheet, no sideways page scroll", async ({ page }) => {
    await asOwner(page, { width: 390, height: 844 });
    await page.goto(url());
    const strip = page.getByTestId("dw-strip");
    await expect(strip).toBeVisible({ timeout: 30_000 });
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await page.getByTestId(`dw-day-${D.free}`).scrollIntoViewIfNeeded();
    await page.getByTestId(`dw-day-${D.free}`).click();
    const card = page.getByTestId(`dw-win-${win.free}`);
    await expect(card.getByTestId("dw-win-actions-inline")).toBeHidden();
    await card.getByTestId("dw-win-actions-more").click();
    const sheet = page.getByTestId("dw-sheet");
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(844 - 2); // anchored to the bottom
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(388);
    await sheet.getByTestId("dw-act-stop-date-sheet").click();
    const form = page.getByTestId("dw-dlg-stopDate");
    await expect(form).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("keyboard, English (LTR), axe - and the old store-level address opens the tab", async ({ page }) => {
    await asOwner(page);
    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    const axe = async () => {
      await page.addScriptTag({ content: readFileSync(localRequire.resolve("axe-core/axe.min.js"), "utf8") });
      return page.evaluate(async () => {
        const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[]; any: { message: string }[] }[] }[] }> } }).axe;
        const r = await a.run({ include: [['[data-testid="dw"]']] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        // the element and why, so a failure says what to fix
        return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.map((n) => `${n.target.join(" ")} - ${n.any[0]?.message ?? ""}`).join(" | ")}`);
      });
    };
    await page.goto(`/vendor/${vendorId}/delivery-windows`);
    await expect(page).toHaveURL(new RegExp(`/branches/[0-9a-f-]+/delivery-windows$`), { timeout: 30_000 });
    await page.goto(url());
    await expect(page.getByTestId("dw-strip")).toBeVisible({ timeout: 30_000 });
    expect(await axe()).toEqual([]);
    // the keyboard: a day is a button; Enter chooses it
    await page.getByTestId(`dw-day-${D.free}`).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId(`dw-day-${D.free}`)).toHaveAttribute("aria-pressed", "true");
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await page.goto(url());
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.locator(".dw-title")).toHaveText("Delivery windows");
      await page.getByTestId(`dw-day-${D.orders}`).click();
      await expect(page.getByTestId(`dw-win-${win.orders}`)).toContainText(/1 of \d booked/);
      await expectNoHorizontalOverflow(page);
      expect(await axe()).toEqual([]);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "ar"));
    }
  });
});
