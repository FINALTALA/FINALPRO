import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique, uniquePhone } from "./helpers/api";
import { createOfferWithStock, makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// «إدارة طلبات الفرع v1» (2026-11-22): the branch's order screen.
// Desktop master-detail (a dense queue | one line | the order, actions in
// one bar, no buttons on the rows), the phone's queue -> full order -> one
// «رجوع» back to the same tab and scroll, owner vs employee vs another
// branch, the pickup code (typed, never shown, wrong / right), deep links
// with the order marked, the owner's automatic branch switch, a missing
// order, RTL / LTR, the keyboard and axe (WCAG 2 A/AA).
// v2 phase 1 (2026-11-24): compact two-line rows, «دفع عند الاستلام» and
// «أُنشئ اليوم» filters (also in «كل الفروع»), search by name (never by the
// pickup code), the phone's filters bottom sheet, and the internal prep sheet.

const localRequire = createRequire(__filename);
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
async function account(name: string) {
  const phone = uniquePhone();
  const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" } });
  const profile = await prisma.customerProfile.create({ data: { userId: user.id, displayName: name } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: "a-strong-password" } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, token: res.body.session_token, profileId: profile.id, phone };
}
const code6 = () => String(100000 + Math.floor(Math.random() * 900000));

test.describe("Branch orders v1", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchA = "";
  let branchB = "";
  let variant = "";
  const orders: Record<string, { id: string; code: string | null; buyerToken: string; phone: string }> = {};

  /** An order straight in the test database (PLACED, COD, one or two pieces). */
  async function order(opts: {
    name: string;
    method: "PICKUP" | "DELIVERY";
    due?: Date;
    qty?: number;
    status?: "PLACED" | "PREPARING" | "DELIVERED" | "COMPLETED";
    branch?: string;
    pay?: "COD" | "ONLINE";
    createdAt?: Date;
    customerNote?: string;
    internalNote?: string;
  }) {
    const buyer = await account(opts.name);
    const co = await prisma.customerOrder.create({ data: { customerId: buyer.profileId } });
    const branchId = opts.branch ?? branchA;
    let windowId: string | null = null;
    let date: Date | null = null;
    if (opts.due) {
      date = new Date(Date.UTC(opts.due.getUTCFullYear(), opts.due.getUTCMonth(), opts.due.getUTCDate()));
      const start = opts.due.getUTCHours() * 60 + opts.due.getUTCMinutes();
      const w = await prisma.deliveryWindow.create({
        data: { vendorId, branchId, dayOfWeek: date.getUTCDay(), startMinute: start, endMinute: Math.min(start + 120, 1439), capacity: 10 },
      });
      windowId = w.id;
    }
    const qty = opts.qty ?? 1;
    const code = opts.method === "PICKUP" ? code6() : null;
    const bo = await prisma.branchOrder.create({
      data: {
        customerOrderId: co.id,
        vendorId,
        branchId,
        fulfilmentMethod: opts.method,
        paymentMethod: opts.pay ?? "COD",
        status: opts.status ?? "PLACED",
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        customerNote: opts.customerNote ?? null,
        internalStoreNote: opts.internalNote ?? null,
        subtotal: 120 * qty,
        total: 120 * qty,
        pickupCode: code,
        deliveryWindowId: windowId,
        scheduledDate: date,
      },
    });
    await prisma.branchOrderItem.create({
      data: {
        vendorId,
        branchOrderId: bo.id,
        offerVariantId: variant,
        quantity: qty,
        unitPrice: 120,
        titleArSnapshot: "فستان سهرة",
        titleEnSnapshot: "Evening dress",
        colorNameArSnapshot: "أسود",
        colorNameEnSnapshot: "Black",
        colorHexSnapshot: "#111111",
        sizeLabelSnapshot: "M",
      },
    });
    return { id: bo.id, code, buyerToken: buyer.token, phone: buyer.phone };
  }

  test.beforeAll(async () => {
    ({ vendorId, branchId: branchA } = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع البيرة"));
    await makeVendorEligible(vendorId);
    const added = await call<{ id: string }>(`/vendors/${vendorId}/branches`, { method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("branch"), body: { name: "فرع جنين" } });
    expect(added.status).toBe(201);
    branchB = added.body.id;
    variant = await createOfferWithStock(vendorId, branchA, 120, 50);
    const now = Date.now();
    orders.pickupOld = await order({ name: "سارة أحمد", method: "PICKUP", qty: 2 });
    orders.late = await order({ name: "ليلى محمود", method: "DELIVERY", due: new Date(now - 3 * 3600_000) });
    orders.soon = await order({ name: "منى سعيد", method: "DELIVERY", due: new Date(now + 2 * 86400_000) });
    orders.pickupNew = await order({ name: "هالة يوسف", method: "PICKUP" });
    orders.finished = await order({ name: "رنا", method: "PICKUP", status: "COMPLETED" });
    orders.otherBranch = await order({ name: "جود", method: "PICKUP", branch: branchB });
  });

  async function asOwner(page: Page, viewport = { width: 1360, height: 900 }) {
    await page.setViewportSize(viewport);
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
  }
  const url = (branch: string, qs = "") => `/vendor/${vendorId}/branches/${branch}/orders${qs}`;

  /**
   * A computer: every status tab is whole and visible (no cut name, nothing hidden
   * sideways); the page itself does not scroll - the list's head (title, tabs, search,
   * filters) and the details' head stay, only the results and the details content
   * scroll, each inside its own box.
   */
  async function expectDesktopLayout(page: Page, tabNames: string[]) {
    const tabs = page.getByTestId("bo-tabs").locator(".bo-tab");
    await expect(tabs).toHaveCount(tabNames.length);
    const nav = (await page.getByTestId("bo-tabs").boundingBox())!;
    const queue = (await page.locator(".bo-queue").boundingBox())!;
    for (let i = 0; i < tabNames.length; i += 1) {
      const tab = tabs.nth(i);
      await expect(tab).toBeVisible();
      await expect(tab).toContainText(tabNames[i]);
      const b = (await tab.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(Math.max(nav.x, queue.x) - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(Math.min(nav.x + nav.width, queue.x + queue.width) + 1);
      // the whole name fits its chip
      expect(await tab.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    expect(await page.getByTestId("bo-tabs").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    // no scroll of the page around the board
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
    // the two boxes, side by side, each with its own head
    await expect(page.locator("#bo-queue-title")).toBeVisible();
    await expect(page.getByTestId("bo-detail-pane-title")).toBeVisible();
    const style = async (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).overflowY);
    expect(await style(".bo-results")).toBe("auto");
    expect(await style(".bo-detail-scroll")).toBe("auto");
    expect(await style(".bo-queue-head")).toBe("visible");
    // scrolling the results or the details never moves the heads
    const headY = async () => (await page.getByTestId("bo-queue-head").boundingBox())!.y;
    const before = await headY();
    const titleBefore = (await page.getByTestId("bo-detail-pane-title").boundingBox())!.y;
    await page.locator(".bo-results").evaluate((el) => el.scrollBy(0, 400));
    await page.locator(".bo-detail-scroll").evaluate((el) => el.scrollBy(0, 400));
    await page.mouse.wheel(0, 600);
    expect(await headY()).toBe(before);
    expect((await page.getByTestId("bo-detail-pane-title").boundingBox())!.y).toBe(titleBefore);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.locator(".bo-results").evaluate((el) => el.scrollTo(0, 0));
    await page.locator(".bo-detail-scroll").evaluate((el) => el.scrollTo(0, 0));
  }
  const TABS_AR = ["النشطة", "جديدة", "قيد التجهيز", "مع الناقل", "بانتظار تأكيد العميلة", "تحتاج متابعة", "منتهية"];

  test("desktop: a dense queue beside the order - one line between them, no buttons on the rows, the late one first", async ({ page }) => {
    await asOwner(page);
    await page.goto(url(branchA));
    const list = page.getByTestId("bo-list");
    await expect(list).toBeVisible({ timeout: 30_000 });
    const rows = list.locator("a.bo-row-link");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toHaveAttribute("data-order-id", orders.late.id);
    await expect(rows.nth(0).getByTestId("bo-row-late")).toBeVisible();
    await expect(rows.nth(1)).toHaveAttribute("data-order-id", orders.soon.id);
    await expect(list.locator("button")).toHaveCount(0);
    // v2 phase 1: compact rows - two short lines each, no cards
    for (let i = 0; i < 4; i += 1) {
      const h = (await rows.nth(i).boundingBox())!.height;
      expect(h).toBeGreaterThanOrEqual(50);
      expect(h).toBeLessThanOrEqual(72);
    }
    await expect(page.getByTestId("bo-count-active")).toHaveText("4");
    await expect(page.getByTestId("bo-count-done")).toHaveText("1");
    // the list row masks the name
    const oldRow = page.getByTestId(`branch-order-${orders.pickupOld.id}`);
    await expect(oldRow).toContainText("سارة أ.");
    await expect(oldRow).not.toContainText("سارة أحمد");
    // one glance: number, status, method, the time, the last 4 digits, the pieces, what to collect
    await expect(oldRow).toContainText(`#${orders.pickupOld.id.slice(0, 8)}`);
    await expect(oldRow.getByTestId("bo-row-status")).toHaveText("جديد");
    await expect(oldRow.getByTestId("bo-row-method")).toHaveText("استلام");
    await expect(oldRow).toContainText(`•••• ${orders.pickupOld.phone.slice(-4)}`);
    await expect(oldRow).toContainText("2 قطعة");
    await expect(oldRow.getByTestId("bo-row-money")).toContainText("تحصيل");
    await expect(oldRow.getByTestId("bo-row-money")).toContainText("240");
    // a delivery order shows its window (day · from–to)
    await expect(page.getByTestId(`branch-order-${orders.soon.id}`).getByTestId("bo-row-method")).toHaveText("توصيل");
    await expect(page.getByTestId(`branch-order-${orders.soon.id}`).getByTestId("bo-row-time")).toContainText("–");
    // no branch badge in one branch's queue
    await expect(list.getByTestId("bo-row-branch")).toHaveCount(0);

    let detailReads = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.endsWith(`/order-queue/${orders.pickupOld.id}`)) detailReads += 1;
    });
    await page.getByTestId(`branch-order-${orders.pickupOld.id}`).click();
    await expect(page).toHaveURL(new RegExp(`order=${orders.pickupOld.id}`));
    const detail = page.getByTestId("bo-detail");
    await expect(detail).toBeVisible({ timeout: 30_000 });
    // read once - never again and again while it is open
    await page.waitForTimeout(2_000);
    expect(detailReads).toBe(1);
    await expect(page.getByTestId(`branch-order-${orders.pickupOld.id}`)).toHaveAttribute("aria-current", "true");
    // the layout: whole status tabs, two boxes with fixed heads, no outer scroll
    await expect(page.locator("#bo-queue-title")).toHaveText("الطلبات");
    await expect(page.getByTestId("bo-detail-pane-title")).toHaveText("تفاصيل الطلب");
    await expectDesktopLayout(page, TABS_AR);
    // the same inside the store's management window size (a laptop) - still no outer scroll
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(url(branchA, `?order=${orders.pickupOld.id}&embed=management`));
    await expect(page.getByTestId("bo-detail")).toBeVisible({ timeout: 30_000 });
    await expectDesktopLayout(page, TABS_AR);
    // a short board: the filters fold into «الفلاتر» so the list keeps its room (at least 3 orders in view)
    expect((await page.getByTestId("bo-results").boundingBox())!.height).toBeGreaterThanOrEqual(3 * 56);
    await expect(page.getByTestId("bo-cod")).toHaveCount(0);
    const open = page.getByTestId("bo-filters-open");
    await expect(open).toHaveText("الفلاتر");
    await open.focus();
    await page.keyboard.press("Enter");
    const dlg = page.getByTestId("bo-filters-sheet");
    await expect(dlg).toBeVisible();
    await dlg.getByTestId("bo-cod").check();
    await expect(page).toHaveURL(/cod=1/);
    await dlg.getByTestId("bo-filters-done").click();
    await expect(dlg).toHaveCount(0);
    await expect(open).toBeFocused();
    await expect(open).toHaveText("الفلاتر (1)");
    // what is on stays in sight, removable
    await expect(page.getByTestId("bo-active-cod")).toHaveText(/دفع عند الاستلام/);
    await expect(page.getByTestId("bo-active-cod")).toHaveAttribute("aria-label", "إزالة الفلتر: دفع عند الاستلام");
    await expectDesktopLayout(page, TABS_AR);
    await page.getByTestId("bo-active-cod").click();
    await expect(page).not.toHaveURL(/cod=/);
    await expect(page.getByTestId("bo-active-filters")).toHaveCount(0);
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(url(branchA, `?order=${orders.pickupOld.id}`));
    await expect(detail).toBeVisible({ timeout: 30_000 });
    // side by side: the queue on one side, the order on the other (RTL: the queue on the right)
    const lb = (await page.locator(".bo-queue").boundingBox())!;
    const db = (await page.getByTestId("bo-pane").boundingBox())!;
    expect(lb.x).toBeGreaterThan(db.x + db.width - 2);
    // the two boxes start and end on the same lines
    expect(Math.abs(lb.y - db.y)).toBeLessThan(2);
    expect(Math.abs(lb.y + lb.height - (db.y + db.height))).toBeLessThan(2);
    // the order: items, the full customer, the owner's money, no code
    await expect(page.getByTestId("bo-items").getByTestId("bo-item")).toHaveCount(1);
    await expect(page.getByTestId("bo-items")).toContainText("فستان سهرة");
    await expect(page.getByTestId("bo-items")).toContainText("×2");
    await expect(page.getByTestId("bo-customer-name")).toHaveText("سارة أحمد");
    await expect(page.getByTestId("bo-total")).toContainText("240");
    expect(await page.locator("body").innerText()).not.toContain(orders.pickupOld.code!);
    // one primary step; the rest in «إجراءات أخرى» - the bar in view without scrolling the page
    const bar = page.getByTestId("bo-actionbar");
    const barBox = (await bar.boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(900 + 1);
    await expect(bar.locator(".bo-btn-primary")).toHaveCount(1);
    await expect(bar.getByTestId("bo-action-start_preparation")).toHaveText("بدء التجهيز");
    await bar.getByTestId("bo-more").click();
    await expect(bar.getByTestId("bo-action-cancel")).toBeVisible();
    await expect(bar.getByTestId("bo-action-mark_sent")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await bar.getByTestId("bo-action-start_preparation").click();
    await expect(page.getByTestId("bo-detail-status")).toHaveText("قيد التجهيز", { timeout: 30_000 });
    await expect(page.getByTestId("bo-notice")).toHaveText("بدأ تجهيز الطلب.");
    await expect(page.getByTestId("bo-count-preparing")).toHaveText("1");
    // the activity: who (name and role at that time) and the change
    const first = page.getByTestId("bo-timeline").getByTestId("bo-tl-item").first();
    await expect(first).toContainText("تغيّرت الحالة");
    await expect(first.getByTestId("bo-tl-actor")).toContainText("المالكة");
    await expect(first).toContainText("جديد");
    await expect(first).toContainText("قيد التجهيز");
  });

  test("pickup hand-over: the code is typed, never shown; a wrong one changes nothing, the right one completes", async ({ page }) => {
    await asOwner(page);
    await page.goto(url(branchA, `?order=${orders.pickupOld.id}`));
    const bar = page.getByTestId("bo-actionbar");
    await bar.getByTestId("bo-action-pickup_handover").click({ timeout: 30_000 });
    const dlg = page.getByTestId("bo-handover");
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("سارة أحمد");
    await expect(dlg).toContainText("2 قطعة");
    await expect(page.getByTestId("bo-handover-collect")).toContainText("240");
    const input = page.getByTestId("bo-code-input");
    await expect(input).toBeFocused();
    await expect(page.getByTestId("bo-handover-submit")).toBeDisabled();
    await input.fill("12ab3");
    await expect(input).toHaveValue("123");
    const wrong = orders.pickupOld.code === "000000" ? "000001" : "000000";
    await input.fill(wrong);
    await page.getByTestId("bo-handover-submit").click();
    await expect(dlg.getByRole("alert")).toHaveText("الرمز غير صحيح. تأكدي من الرمز الذي تعرضه العميلة.", { timeout: 30_000 });
    await expect(input).toHaveValue("");
    expect(await page.locator("body").innerText()).not.toContain(orders.pickupOld.code!);
    expect((await prisma.branchOrder.findUniqueOrThrow({ where: { id: orders.pickupOld.id } })).status).toBe("PREPARING");
    // a scanner types the digits and presses Enter
    await input.pressSequentially(orders.pickupOld.code!);
    await input.press("Enter");
    await expect(dlg).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("bo-notice")).toHaveText("سُلّم الطلب للعميلة.");
    await expect(page.getByTestId("bo-detail-status")).toHaveText("مكتمل");
    await expect(page.getByTestId("bo-not-in-tab")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(orders.pickupOld.code!);
  });

  test("the employee: her branch, no owner sort, the amount to collect only; another branch's link is a safe message", async ({ page }) => {
    const emp = await account("هبة موظفة");
    await prisma.vendorUser.create({ data: { userId: emp.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: branchA } });
    await page.setViewportSize({ width: 1360, height: 900 });
    await loginAs(page, emp.token);
    await enterWorkspace(page, emp.token, { type: "vendor", vendor_id: vendorId });
    await page.goto(url(branchA, `?order=${orders.soon.id}`));
    await expect(page.getByTestId("bo-detail")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("bo-sort")).toHaveCount(0);
    await expect(page.getByTestId("bo-total")).toHaveCount(0);
    await expect(page.getByTestId("bo-amount-due")).toContainText("120");
    await expect(page.getByTestId("bo-detail-slot")).not.toHaveText("بلا موعد محدد");
    // her action shows her name and role in the activity
    await page.getByTestId("bo-action-start_preparation").click();
    await expect(page.getByTestId("bo-detail-status")).toHaveText("قيد التجهيز", { timeout: 30_000 });
    await expect(page.getByTestId("bo-tl-item").first().getByTestId("bo-tl-actor")).toContainText("هبة موظفة · موظفة");

    // another branch: nothing of it is shown, no request is made for it
    let asked = false;
    page.on("request", (r) => {
      if (r.url().includes(`/branches/${branchB}/order-queue`)) asked = true;
    });
    await page.goto(url(branchB, `?order=${orders.otherBranch.id}`));
    await expect(page.getByText("هذا الطلب يخص فرعاً آخر، ولا يمكنك فتحه من هنا.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("bo-list")).toHaveCount(0);
    await expect(page.getByTestId("bo-detail")).toHaveCount(0);
    expect(asked).toBe(false);
  });

  test("links: the owner opening another branch's order switches to it with a note; the order is marked; a missing one says so", async ({ page }) => {
    await asOwner(page);
    // the dashboard was on branch B
    await page.addInitScript(({ k, v }) => localStorage.setItem(k, v), { k: `fp.branch.current.${vendorId}`, v: branchB });
    await page.goto(url(branchA, `?order=${orders.late.id}`));
    await expect(page.getByTestId("bo-switched")).toContainText("فرع البيرة", { timeout: 30_000 });
    await expect(page.getByTestId("br-current-name")).toHaveText("فرع البيرة");
    const row = page.getByTestId(`branch-order-${orders.late.id}`);
    await expect(row).toHaveClass(/is-notified/);
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("bo-detail")).toHaveAttribute("data-order-id", orders.late.id);
    await expect(page.getByTestId("bo-detail-late")).toBeVisible();
    // an order of another branch asked for under this one, and a finished one in «النشطة»
    await page.goto(url(branchA, `?order=${orders.otherBranch.id}`));
    await expect(page.getByTestId("bo-missing")).toHaveText("الطلب غير موجود في هذا الفرع أو لم يعد ضمن هذا التبويب.", { timeout: 30_000 });
    await page.goto(url(branchA, `?order=${orders.finished.id}`));
    await expect(page.getByTestId("bo-not-in-tab")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("bo-not-in-tab").getByRole("button").click();
    await expect(page).toHaveURL(/tab=done/);
    await expect(page.getByTestId(`branch-order-${orders.finished.id}`)).toHaveAttribute("aria-current", "true");
  });

  test("filters and search live in the URL: method, late, cash on delivery, placed today; search by number, name or 4 phone digits - never by the pickup code", async ({ page }) => {
    // two more open orders of branch A: one paid online, one placed three days ago
    orders.online = await order({ name: "Dalia Online", method: "PICKUP", pay: "ONLINE" });
    orders.older = await order({ name: "عبير سليم", method: "PICKUP", createdAt: new Date(Date.now() - 3 * 86400_000) });
    // a tall window: the filters sit in the list's head (a short board folds them - see the first test)
    await asOwner(page, { width: 1360, height: 1050 });
    await page.goto(url(branchA));
    const rows = page.getByTestId("bo-list").locator("a.bo-row-link");
    const ids = async () => rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-order-id")));
    await expect(page.getByTestId("bo-list")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`branch-order-${orders.online.id}`)).toBeVisible();
    // the online order: no amount to collect, «مدفوع إلكترونياً»
    await expect(page.getByTestId(`branch-order-${orders.online.id}`).getByTestId("bo-row-money")).toContainText("مدفوع إلكترونياً");
    await page.getByTestId("bo-method-DELIVERY").click();
    await expect(page).toHaveURL(/method=DELIVERY/);
    await expect(rows).toHaveCount(2);
    await page.getByTestId("bo-method-all").click();
    await page.getByTestId("bo-late").check();
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    await page.getByTestId("bo-late").uncheck();
    await expect(page).not.toHaveURL(/late=/);
    // «دفع عند الاستلام»
    await page.getByTestId("bo-cod").check();
    await expect(page).toHaveURL(/cod=1/);
    await expect(page.getByTestId(`branch-order-${orders.online.id}`)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId(`branch-order-${orders.older.id}`)).toBeVisible();
    await expect(page.getByTestId("bo-count-active")).toHaveText(String((await ids()).length));
    await page.getByTestId("bo-cod").uncheck();
    // «أُنشئ اليوم»
    await page.getByTestId("bo-today").check();
    await expect(page).toHaveURL(/today=1/);
    await expect(page.getByTestId(`branch-order-${orders.older.id}`)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId(`branch-order-${orders.online.id}`)).toBeVisible();
    // both, then a reload keeps them
    await page.getByTestId("bo-cod").check();
    await expect(page).toHaveURL(/cod=1/);
    await expect(page.getByTestId(`branch-order-${orders.online.id}`)).toHaveCount(0, { timeout: 30_000 });
    await page.reload();
    await expect(page.getByTestId("bo-cod")).toBeChecked({ timeout: 30_000 });
    await expect(page.getByTestId("bo-today")).toBeChecked();
    await expect(page.getByTestId(`branch-order-${orders.older.id}`)).toHaveCount(0);
    await page.getByTestId("bo-cod").uncheck();
    await expect(page).not.toHaveURL(/cod=/);
    await page.getByTestId("bo-today").uncheck();
    await expect(page).not.toHaveURL(/today=/);

    const search = page.getByTestId("bo-search");
    await expect(search).toHaveAttribute("placeholder", "رقم الطلب، اسم المتسوقة، أو آخر 4 أرقام من الهاتف");
    await search.fill(`#${orders.pickupNew.id.slice(0, 8)}`);
    await expect(page).toHaveURL(/q=/, { timeout: 10_000 });
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId(`branch-order-${orders.pickupNew.id}`)).toBeVisible();
    // the shopper's name: a part of it, the full name, Latin in any case
    for (const [q, id] of [
      ["هالة", orders.pickupNew.id],
      ["سليم", orders.older.id],
      ["dalia", orders.online.id],
    ] as const) {
      await search.fill(q);
      await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(q)}`), { timeout: 10_000 });
      await expect.poll(ids, { timeout: 30_000 }).toEqual([id]);
    }
    // the last 4 digits of the phone
    await search.fill(orders.older.phone.slice(-4));
    await expect.poll(ids, { timeout: 30_000 }).toContain(orders.older.id);
    // the pickup code finds nothing (it is only checked at the hand-over)
    await search.fill(orders.pickupNew.code!);
    await expect(page.getByTestId("bo-empty")).toHaveText("لا توجد طلبات تطابق هذا البحث أو الفلتر.", { timeout: 30_000 });
    // characters outside the allowed set never reach the request
    await search.fill("%_=;<>");
    await expect(search).toHaveValue("");
    await search.fill("zz-zz");
    await expect(page.getByTestId("bo-empty")).toHaveText("لا توجد طلبات تطابق هذا البحث أو الفلتر.", { timeout: 10_000 });
    // the owner's alternative order
    await page.getByTestId("bo-search").fill("");
    await page.getByTestId("bo-sort").selectOption("newest");
    await expect(page).toHaveURL(/sort=newest/);
    await expect(page.getByTestId("bo-list").locator("a.bo-row-link").first()).toHaveAttribute("data-order-id", orders.online.id, { timeout: 30_000 });

    // the owner's «كل الفروع»: the same filters and search, each row with its branch
    await page.goto(url(branchA, "?scope=all&cod=1"));
    await expect(page.getByTestId(`branch-order-${orders.otherBranch.id}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`branch-order-${orders.otherBranch.id}`).getByTestId("bo-row-branch")).toHaveText("فرع جنين");
    await expect(page.getByTestId(`branch-order-${orders.pickupNew.id}`).getByTestId("bo-row-branch")).toHaveText("فرع البيرة");
    await expect(page.getByTestId(`branch-order-${orders.online.id}`)).toHaveCount(0);
    await expect(page.getByTestId("bo-cod")).toBeChecked();
    await page.getByTestId("bo-search").fill("جود");
    await expect.poll(ids, { timeout: 30_000 }).toEqual([orders.otherBranch.id]);
  });

  test("phone: the queue, then the order as a full screen; one «رجوع» returns to the same tab and filters; the action bar sits at the bottom", async ({ page }) => {
    await asOwner(page, { width: 390, height: 844 });
    await page.goto(url(branchA, "?method=PICKUP"));
    const rows = page.getByTestId("bo-list").locator("a.bo-row-link");
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    // the filters live in a bottom sheet: one «الفلاتر» button beside the search
    await expect(page.getByTestId("bo-cod")).toHaveCount(0);
    const open = page.getByTestId("bo-filters-open");
    await expect(open).toHaveText("الفلاتر (1)");
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await open.click();
    const sheet = page.getByTestId("bo-filters-sheet");
    await expect(sheet).toBeVisible();
    const sb = (await sheet.boundingBox())!;
    expect(Math.round(sb.y + sb.height)).toBeGreaterThanOrEqual(844 - 2);
    expect(sb.width).toBeGreaterThanOrEqual(388);
    await expect(sheet.getByTestId("bo-method-PICKUP")).toHaveAttribute("aria-pressed", "true");
    await sheet.getByTestId("bo-cod").check();
    await expect(page).toHaveURL(/cod=1/);
    await expect(sheet.getByTestId("bo-cod")).toBeChecked();
    await sheet.getByTestId("bo-filters-done").click();
    await expect(sheet).toHaveCount(0);
    await expect(open).toBeFocused();
    await expect(open).toHaveText("الفلاتر (2)");
    // Escape closes it too; «مسح الفلاتر» clears every filter
    await open.click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("bo-filters-sheet")).toHaveCount(0);
    await open.click();
    await page.getByTestId("bo-filters-clear").click();
    await expect(page).not.toHaveURL(/cod=|method=/);
    await page.getByTestId("bo-filters-done").click();
    await expect(open).toHaveText("الفلاتر");
    // the longest status with a window stays inside its row - never cut: a short clear name
    // in the row, the full one for screen readers and as its tooltip
    const delivered = await order({ name: "تالا", method: "DELIVERY", due: new Date(Date.now() - 30 * 3600_000), status: "DELIVERED" });
    await page.goto(url(branchA, "?method=DELIVERY"));
    const longRow = page.getByTestId(`branch-order-${delivered.id}`);
    await expect(longRow).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    const rb = (await longRow.boundingBox())!;
    for (const part of ["bo-row-time", "bo-row-status", "bo-row-method"]) {
      const b = (await longRow.getByTestId(part).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(rb.x - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(rb.x + rb.width + 1);
    }
    const status = longRow.getByTestId("bo-row-status");
    await expect(status).toHaveAttribute("title", "تم التوصيل - بانتظار تأكيد العميلة");
    await expect(status.getByTestId("bo-row-status-short")).toHaveText("بانتظار التأكيد");
    await expect(status.locator(".visually-hidden")).toHaveText("تم التوصيل - بانتظار تأكيد العميلة");
    expect(await status.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect((await longRow.boundingBox())!.height).toBeLessThanOrEqual(92);
    // a phone: one page scrolls - the list has no scroll box of its own, the status tabs are whole
    expect(await page.locator(".bo-results").evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
    for (const tab of await page.getByTestId("bo-tabs").locator(".bo-tab").all()) {
      expect(await tab.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      const b = (await tab.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(-1);
      expect(b.x + b.width).toBeLessThanOrEqual(391);
    }
    await page.goto(url(branchA, "?method=PICKUP"));
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    await rows.first().click();
    await expect(page.getByTestId("bo-detail")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".bo-queue")).toBeHidden();
    await expect(page.locator("#bo-detail-title")).toBeFocused();
    await expectNoHorizontalOverflow(page);
    // the order is the whole screen: no details head of the computer layout, no inner scroll box
    await expect(page.getByTestId("bo-detail-pane-title")).toHaveCount(0);
    expect(await page.locator(".bo-detail-scroll").evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
    const bar = (await page.getByTestId("bo-actionbar").boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(844 + 1);
    expect(bar.y).toBeGreaterThan(844 - 200);
    // never under the app's own bottom tab bar
    const nav = page.locator(".bottom-nav");
    if (await nav.isVisible()) expect(bar.y + bar.height).toBeLessThanOrEqual((await nav.boundingBox())!.y + 1);
    for (const b of await page.getByTestId("bo-actionbar").locator("button").all()) {
      expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId("bo-back").click();
    await expect(page.locator(".bo-queue")).toBeVisible();
    await expect(page).toHaveURL(/method=PICKUP/);
    await expect(page).not.toHaveURL(/order=/);
    await expect(page.getByTestId("bo-filters-open")).toHaveText("الفلاتر (1)");
  });

  test("the pickup code: no store page or store response shows it (owner and employee, old and new pages); only the shopper who ordered sees hers", async ({ browser }) => {
    const target = orders.pickupNew;
    const code = target.code!;
    /** Every store API answer of a page, as text. */
    async function storeView(token: string, paths: string[]) {
      const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      const page = await context.newPage();
      const answers: string[] = [];
      page.on("response", async (r) => {
        if (!r.url().includes(`/vendors/${vendorId}/`)) return;
        try {
          answers.push(await r.text());
        } catch {
          // a redirect or an aborted request has no body
        }
      });
      await loginAs(page, token);
      await enterWorkspace(page, token, { type: "vendor", vendor_id: vendorId });
      const texts: string[] = [];
      for (const p of paths) {
        await page.goto(p);
        await expect(page.locator(`[data-order-id="${target.id}"]`).first()).toBeVisible({ timeout: 30_000 });
        texts.push(await page.locator("body").innerText());
      }
      await context.close();
      return { texts, answers };
    }
    // the owner: the old store-wide list and the new branch screen (with the order open)
    const owner = await storeView(fixtures.ownerToken, [`/vendor/${vendorId}/orders`, url(branchA, `?order=${target.id}`)]);
    // the employee: her branch's screen with the order open
    const emp = await account("ريما موظفة");
    await prisma.vendorUser.create({ data: { userId: emp.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: branchA } });
    const employee = await storeView(emp.token, [url(branchA, `?order=${target.id}`)]);
    for (const v of [owner, employee]) {
      expect(v.answers.length).toBeGreaterThan(0);
      for (const t of v.texts) {
        expect(t).not.toContain(code);
        expect(t).not.toContain("رمز الاستلام:");
      }
      for (const a of v.answers) {
        expect(a).not.toContain("pickup_code");
        expect(a).not.toContain(`"${code}"`);
      }
    }
    // the shopper who ordered: her own orders show her code
    const mine = await browser.newContext();
    const minePage = await mine.newPage();
    await loginAs(minePage, target.buyerToken);
    await minePage.goto("/cart?tab=orders");
    await expect(minePage.locator(".customer-order-pickup-code")).toContainText(code, { timeout: 30_000 });
    await mine.close();
    // another shopper never sees it
    const other = await account("متسوقة أخرى");
    const otherCtx = await browser.newContext();
    const otherPage = await otherCtx.newPage();
    await loginAs(otherPage, other.token);
    await otherPage.goto("/cart?tab=orders");
    await expect(otherPage.locator("main")).toBeVisible({ timeout: 30_000 });
    await otherPage.waitForLoadState("networkidle");
    expect(await otherPage.locator("body").innerText()).not.toContain(code);
    await otherCtx.close();
  });

  test("the internal prep sheet: from the order, a clean page - number, branch, method, pieces, notes; no pickup code, price or shopper; new / preparing only; employee; print; phone; EN; axe", async ({ page, browser }) => {
    const prep = await order({
      name: "ميار حداد",
      method: "PICKUP",
      qty: 2,
      customerNote: "تغليف هدية من فضلك",
      internalNote: "القطعة على الرف العلوي",
    });
    const axePath = localRequire.resolve("axe-core/axe.min.js");
    const axe = async (p: Page) => {
      await p.addScriptTag({ content: readFileSync(axePath, "utf8") });
      return p.evaluate(async () => {
        const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe;
        const r = await a.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        return r.violations.map((v) => `${v.id} (${v.nodes.length})`);
      });
    };
    await asOwner(page);
    await page.goto(url(branchA, `?order=${prep.id}`));
    const link = page.getByTestId("bo-prep-print");
    await expect(link).toHaveText("طباعة ورقة تجهيز", { timeout: 30_000 });
    const sheetAnswer = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith(`/order-queue/${prep.id}/prep-sheet`));
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/print/prep-sheet/${vendorId}/${branchA}/${prep.id}$`));
    const sheet = page.getByTestId("prep-sheet");
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#ps-title")).toBeFocused();
    // no store header, menus or bottom tab bar
    await expect(page.locator("header:not(.ps-head)")).toHaveCount(0);
    await expect(page.locator("nav")).toHaveCount(0);
    await expect(page.locator(".app-header, .bottom-nav, .workspace-menu")).toHaveCount(0);
    await expect(page.locator("#ps-title")).toHaveText(`طلب #${prep.id.slice(0, 8)}`);
    await expect(page.getByTestId("prep-sheet-branch")).toHaveText("فرع البيرة");
    await expect(page.getByTestId("prep-sheet-method")).toHaveText("استلام من المحل");
    const item = page.getByTestId("prep-sheet-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("فستان سهرة");
    await expect(item).toContainText("أسود");
    await expect(item).toContainText("M");
    await expect(item.locator(".ps-qty")).toHaveText("2");
    await expect(page.getByTestId("prep-sheet-total")).toHaveText("مجموع القطع: 2");
    await expect(page.getByTestId("prep-sheet-customer-note")).toHaveText("تغليف هدية من فضلك");
    await expect(page.getByTestId("prep-sheet-internal-note")).toHaveText("القطعة على الرف العلوي");
    await expect(sheet).toContainText("ليست إيصالاً");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain(prep.code!);
    expect(text).not.toContain("ميار");
    expect(text).not.toContain("₪");
    expect(text).not.toContain("رمز");
    // and the answer the page read holds none of them either
    const answer = await (await sheetAnswer).text();
    for (const s of [prep.code!, "pickup_code", "price", "total", "amount", "phone", "ميار", prep.phone]) {
      expect(answer).not.toContain(s);
    }
    // «طباعة» prints this page; printed, the controls are gone
    await page.evaluate(() => {
      (window as unknown as { __printed: number }).__printed = 0;
      window.print = () => {
        (window as unknown as { __printed: number }).__printed += 1;
      };
    });
    await page.getByTestId("prep-sheet-print").click();
    expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("prep-sheet-back")).toBeHidden();
    await expect(page.getByTestId("prep-sheet-print")).toBeHidden();
    await expect(sheet).toBeVisible();
    await page.emulateMedia({ media: "screen" });
    expect(await axe(page)).toEqual([]);
    // «رجوع إلى الطلب»: the same order on the board
    await page.getByTestId("prep-sheet-back").click();
    await expect(page.getByTestId("bo-detail")).toHaveAttribute("data-order-id", prep.id, { timeout: 30_000 });
    // a finished order has no sheet - neither the action nor the page
    await page.goto(url(branchA, `?tab=done&order=${orders.finished.id}`));
    await expect(page.getByTestId("bo-detail")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("bo-prep-print")).toHaveCount(0);
    await page.goto(`/print/prep-sheet/${vendorId}/${branchA}/${orders.finished.id}`);
    await expect(page.getByTestId("prep-sheet-error")).toHaveText("ورقة التجهيز متاحة فقط للطلبات الجديدة أو قيد التجهيز.", { timeout: 30_000 });
    await expect(page.getByTestId("prep-sheet")).toHaveCount(0);
    // phone: the sheet fits, no sideways scroll
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/print/prep-sheet/${vendorId}/${branchA}/${prep.id}`);
    await expect(page.getByTestId("prep-sheet")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);

    // the branch employee: her branch's sheet; another branch's sheet is refused
    const emp = await account("سدين موظفة");
    await prisma.vendorUser.create({ data: { userId: emp.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: branchA } });
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const ep = await ctx.newPage();
    await loginAs(ep, emp.token);
    await enterWorkspace(ep, emp.token, { type: "vendor", vendor_id: vendorId });
    await ep.goto(url(branchA, `?order=${prep.id}`));
    await ep.getByTestId("bo-prep-print").click({ timeout: 30_000 });
    await expect(ep.getByTestId("prep-sheet")).toBeVisible({ timeout: 30_000 });
    expect(await ep.locator("body").innerText()).not.toContain(prep.code!);
    await ep.goto(`/print/prep-sheet/${vendorId}/${branchB}/${orders.otherBranch.id}`);
    await expect(ep.getByTestId("prep-sheet-error")).toHaveText("لا يمكنك فتح ورقة تجهيز لهذا الطلب.", { timeout: 30_000 });
    expect(await ep.locator("body").innerText()).not.toContain("جود");
    await ctx.close();

    // English (LTR)
    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.setViewportSize({ width: 1360, height: 900 });
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await page.goto(`/print/prep-sheet/${vendorId}/${branchA}/${prep.id}`);
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.getByTestId("prep-sheet")).toContainText("Prep sheet");
      await expect(page.getByTestId("prep-sheet-method")).toHaveText("Store pickup");
      await expect(page.getByTestId("prep-sheet-item")).toContainText("Evening dress");
      await expect(page.getByTestId("prep-sheet-item")).toContainText("Black");
      expect(await axe(page)).toEqual([]);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "ar"));
    }
  });

  test("keyboard, English (LTR) and axe", async ({ page }) => {
    await asOwner(page);
    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    const axePath = localRequire.resolve("axe-core/axe.min.js");
    const axe = async () => {
      await page.addScriptTag({ content: readFileSync(axePath, "utf8") });
      return page.evaluate(async () => {
        const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe;
        const r = await a.run({ include: [['[data-testid="branch-orders"]']] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        return r.violations.map((v) => `${v.id} (${v.nodes.length})`);
      });
    };
    await page.goto(url(branchA, `?order=${orders.soon.id}`));
    await expect(page.getByTestId("bo-detail")).toBeVisible({ timeout: 30_000 });
    expect(await axe()).toEqual([]);
    // the list: arrows move between orders, Enter opens one
    await page.getByTestId("bo-list").locator("a.bo-row-link").first().focus();
    await page.keyboard.press("ArrowDown");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-order-id"));
    expect(focused).toBe(await page.getByTestId("bo-list").locator("a.bo-row-link").nth(1).getAttribute("data-order-id"));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`order=${focused}`));
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await page.goto(url(branchA, `?order=${orders.late.id}`));
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.getByTestId("bo-tab-active")).toContainText("Active");
      await expect(page.getByTestId("bo-detail-late")).toContainText("late");
      // LTR: the queue on the left
      const lb = (await page.locator(".bo-queue").boundingBox())!;
      const db = (await page.getByTestId("bo-detail").boundingBox())!;
      expect(lb.x + lb.width).toBeLessThan(db.x + 2);
      await expectNoHorizontalOverflow(page);
      await expect(page.locator("#bo-queue-title")).toHaveText("Orders");
      await expect(page.getByTestId("bo-detail-pane-title")).toHaveText("Order details");
      await expectDesktopLayout(page, ["Active", "New", "Preparing", "With courier", "Awaiting confirmation", "Needs follow-up", "Finished"]);
      expect(await axe()).toEqual([]);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "ar"));
    }
  });
});
