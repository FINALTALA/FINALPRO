import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import {
  addToCart,
  call,
  createDeliveryWindow,
  createVendorWithBranch,
  placeAndPickUpOrder,
  scheduledDayOfWeek,
  submitReturn,
  unique,
  uniquePhone,
} from "./helpers/api";
import { createOfferWithStock, itemIdForOrder, makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// 2026-11-24: «نظرة عامة» of a branch as an operating screen - no card
// repeating the branch, no store-wide number; «وضع الفرع الآن» (opening,
// a closure now, delivery booking, the minimum order), «يحتاج متابعة» (only
// real items, each opening its tab) and «إجراءات سريعة». Every fact comes
// from the existing branch reads; the employee sees her own branch only and
// never the staff invites.

const localRequire = createRequire(__filename);
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
const ONE = /^(1|١)$/;

async function account() {
  const phone = uniquePhone();
  const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" } });
  await prisma.customerProfile.create({ data: { userId: user.id } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: "a-strong-password" } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, token: res.body.session_token };
}

test.describe("«نظرة عامة» - the branch right now", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let ramallah = "";
  let nablus = "";
  let employee: Awaited<ReturnType<typeof account>>;

  test.beforeAll(async () => {
    ({ vendorId, branchId: ramallah } = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع رام الله"));
    await makeVendorEligible(vendorId);
    const added = await call<{ id: string }>(`/vendors/${vendorId}/branches`, { method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("branch"), body: { name: "فرع نابلس" } });
    if (added.status !== 201) throw new Error(`branch: ${added.status}`);
    nablus = added.body.id;
    await makeVendorEligible(vendorId);
    employee = await account();
    await prisma.vendorUser.create({ data: { userId: employee.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: ramallah } });
  });

  async function as(page: Page, token: string, viewport = { width: 1360, height: 900 }) {
    await page.setViewportSize(viewport);
    await loginAs(page, token);
    await enterWorkspace(page, token, { type: "vendor", vendor_id: vendorId });
  }
  const overview = (branchId: string) => `/vendor/${vendorId}/branches/${branchId}`;

  test("an empty branch: no repeated card or store-wide count; what is true (no hours, no delivery windows, no minimum), «لا توجد مهام…», four quick actions", async ({ page }) => {
    await as(page, fixtures.ownerToken);
    await page.goto(overview(nablus));
    const ov = page.getByTestId("br-overview");
    await expect(ov).toBeVisible({ timeout: 30_000 });
    // the header keeps the name and one quiet line «فرع فعلي · معتمد · نشط»
    await expect(page.getByTestId("br-current-name")).toHaveText("فرع نابلس");
    await expect(page.getByTestId("br-meta")).toContainText("فرع فعلي");
    await expect(page.getByTestId("br-meta")).toContainText("معتمد");
    await expect(page.getByTestId("br-state")).toHaveText("نشط");
    // no card repeating the branch, no «الفروع النشطة»
    await expect(page.locator(".br-card")).toHaveCount(0);
    await expect(page.getByTestId("br-active-count")).toHaveCount(0);
    await expect(ov).not.toContainText("فرع نابلس");
    await expect(ov).not.toContainText("الفروع النشطة");
    // «وضع الفرع الآن» from the real reads
    await expect(page.getByTestId("bov-now-hours")).toHaveText("لم تُحدَّد ساعات العمل بعد");
    await expect(page.getByTestId("bov-now-delivery")).toHaveText("لا توجد نوافذ توصيل لهذا الفرع");
    await expect(page.getByTestId("bov-now-minimum")).toHaveCount(0);
    await expect(page.getByTestId("bov-now-closure")).toHaveCount(0);
    // nothing to follow: one short line, no empty cards
    await expect(page.getByTestId("bov-follow-none")).toHaveText("لا توجد مهام تحتاج متابعة الآن.");
    await expect(page.getByTestId("bov-follow")).toHaveCount(0);
    await expect(page.getByTestId("bov-partial")).toHaveCount(0);
    // quick actions: the four existing tabs
    for (const k of ["orders", "stock", "hours", "returns"]) {
      await expect(page.getByTestId(`br-link-${k}`)).toHaveAttribute("href", `/vendor/${vendorId}/branches/${nablus}/${k}`);
    }
  });

  test("a branch with real work: open / closure / delivery / minimum, and each follow-up line with its count opens its tab", async ({ page }) => {
    // hours: every day, all day
    await prisma.branchOperatingHours.createMany({
      data: Array.from({ length: 7 }, (_, d) => ({ vendorId, branchId: ramallah, dayOfWeek: d, openMinute: 0, closeMinute: 1440 })),
    });
    await createDeliveryWindow(fixtures.ownerToken, vendorId, ramallah, scheduledDayOfWeek());
    await prisma.storeBranch.update({ where: { id: ramallah }, data: { minimumOrderValue: 50 } });
    // one order just placed (new)
    const fresh = await createOfferWithStock(vendorId, ramallah, 80, 5);
    const cartItemId = await addToCart(fixtures.customerAToken, vendorId, fresh, 1);
    const reserved = await call<{ reservation_id: string }>("/checkout/reserve", {
      method: "POST",
      token: fixtures.customerAToken,
      idempotencyKey: unique("reserve"),
      body: { terms_accepted: true, terms_version: "2026-10-v1", groups: [{ cart_item_ids: [cartItemId], branch_id: ramallah, fulfilment_method: "PICKUP", payment_method: "ONLINE" }] },
    });
    expect(reserved.status).toBe(201);
    expect((await call("/checkout/confirm", { method: "POST", token: fixtures.customerAToken, idempotencyKey: unique("confirm"), body: { reservation_id: reserved.body.reservation_id } })).status).toBe(201);
    // stock: one low, one out
    await createOfferWithStock(vendorId, ramallah, 60, 1);
    await createOfferWithStock(vendorId, ramallah, 60, 0);
    // a return waiting for the store's decision
    const forReturn = await createOfferWithStock(vendorId, ramallah, 90, 5);
    const { branchOrderId } = await placeAndPickUpOrder(fixtures.ownerToken, fixtures.customerAToken, vendorId, ramallah, forReturn);
    expect((await submitReturn(fixtures.customerAToken, branchOrderId, await itemIdForOrder(branchOrderId))).status).toBe(201);
    // a staff invite waiting to be accepted (this branch)
    expect((await call(`/vendors/${vendorId}/branches/${ramallah}/staff-invites`, { method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("inv"), body: { phone: uniquePhone() } })).status).toBe(201);

    await as(page, fixtures.ownerToken);
    await page.goto(overview(ramallah));
    await expect(page.getByTestId("bov-now-hours")).toContainText("مفتوح الآن", { timeout: 30_000 });
    await expect(page.getByTestId("bov-now-delivery")).toContainText("التوصيل متاح للحجز · أقرب نافذة");
    await expect(page.getByTestId("bov-now-minimum")).toContainText("الحد الأدنى للطلب");
    const follow = page.getByTestId("bov-follow");
    await expect(follow.getByTestId("bov-follow-orders_new").locator(".bov-count")).toHaveText(ONE);
    await expect(follow.getByTestId("bov-follow-orders_new")).toContainText("طلبات جديدة بانتظار التجهيز");
    await expect(follow.getByTestId("bov-follow-stock_low").locator(".bov-count")).toHaveText(ONE);
    await expect(follow.getByTestId("bov-follow-stock_out").locator(".bov-count")).toHaveText(ONE);
    await expect(follow.getByTestId("bov-follow-returns_pending").locator(".bov-count")).toHaveText(ONE);
    await expect(follow.getByTestId("bov-follow-invites").locator(".bov-count")).toHaveText(ONE);
    // no line for what is zero
    await expect(follow.getByTestId("bov-follow-orders_attention")).toHaveCount(0);
    await expect(follow.getByTestId("bov-follow-returns_dropoff")).toHaveCount(0);
    await expect(page.getByTestId("bov-follow-none")).toHaveCount(0);
    // each line opens its tab
    await follow.getByTestId("bov-follow-orders_new").click();
    await expect(page).toHaveURL(new RegExp(`/branches/${ramallah}/orders\\?tab=new$`), { timeout: 30_000 });
    await expect(page.getByTestId("br-tab-orders")).toHaveAttribute("aria-current", "page");
    await page.goto(overview(ramallah));
    await page.getByTestId("bov-follow-stock_out").click();
    await expect(page).toHaveURL(new RegExp(`/branches/${ramallah}/stock\\?filter=out$`), { timeout: 30_000 });
    await page.goto(overview(ramallah));
    await page.getByTestId("bov-follow-invites").click();
    await expect(page).toHaveURL(new RegExp(`/branches/${ramallah}/staff$`), { timeout: 30_000 });

    // a temporary closure now: closed, and the closure itself
    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    await prisma.branchClosure.create({
      data: { vendorId, branchId: ramallah, startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 2 * 3_600_000), reason: "جرد", createdBy: owner.id },
    });
    await page.goto(overview(ramallah));
    await expect(page.getByTestId("bov-now-hours")).toContainText("مغلق الآن", { timeout: 30_000 });
    await expect(page.getByTestId("bov-now-closure")).toContainText("إغلاق مؤقت حتى");
    await expect(page.getByTestId("bov-now-closure")).toContainText("جرد");
  });

  test("the employee: her own branch's facts and follow-ups, never the staff invites (not even read); another branch refused", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => asked.push(new URL(r.url()).pathname));
    await as(page, employee.token);
    await page.goto(overview(ramallah));
    await expect(page.getByTestId("bov-now-hours")).toBeVisible({ timeout: 30_000 });
    const follow = page.getByTestId("bov-follow");
    await expect(follow.getByTestId("bov-follow-orders_new")).toBeVisible();
    await expect(follow.getByTestId("bov-follow-returns_pending")).toBeVisible();
    await expect(follow.getByTestId("bov-follow-invites")).toHaveCount(0);
    expect(asked.some((p) => p.endsWith("/staff-invites"))).toBe(false);
    await expect(page.getByTestId("bov-partial")).toHaveCount(0);
    // another branch: nothing of it
    await page.goto(overview(nablus));
    await expect(page.getByTestId("br-overview")).toHaveCount(0);
    await expect(page.getByTestId("bov-now-hours")).toHaveCount(0);
  });

  test("phone, keyboard, English (LTR) and axe", async ({ page }) => {
    await as(page, fixtures.ownerToken, { width: 390, height: 844 });
    await page.goto(overview(ramallah));
    await expect(page.getByTestId("bov-follow")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    await page.setViewportSize({ width: 1360, height: 900 });
    // keyboard: the follow-up lines and quick actions are reachable links
    await page.getByTestId("bov-follow-orders_new").focus();
    await expect(page.getByTestId("bov-follow-orders_new")).toBeFocused();
    await page.getByTestId("br-link-hours").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/branches/${ramallah}/hours$`), { timeout: 30_000 });
    await page.goto(overview(ramallah));
    await expect(page.getByTestId("bov-follow")).toBeVisible({ timeout: 30_000 });
    await page.addScriptTag({ content: readFileSync(localRequire.resolve("axe-core/axe.min.js"), "utf8") });
    const violations = await page.evaluate(async () => {
      const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
      const r = await a.run({ include: [['[data-testid="br-overview"]']] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
      return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
    });
    expect(violations).toEqual([]);

    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await page.goto(overview(ramallah));
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.getByRole("heading", { name: "The branch right now" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
      await expect(page.getByTestId("bov-now-minimum")).toHaveText("Minimum order: 50 ₪");
      await expect(page.getByTestId("bov-follow-orders_new")).toContainText("New orders waiting to be prepared");
      await expect(page.getByTestId("bov-quick")).toHaveAccessibleName("Quick actions");
      await expectNoHorizontalOverflow(page);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
    }
  });
});
