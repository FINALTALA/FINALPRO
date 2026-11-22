import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique, uniquePhone } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// «مجموعات المتجر» (2026-11-18) and the store workspace's own «إشعاراتي».
//  - collections: reached from «المنتجات والعروض»'s toolbar, shown inside the
//    ONE management window (list -> create/edit -> product picker, each with
//    the window's «رجوع»), the Arabic name required, the picker's search and
//    select-all, the owner's order, why a product is not shown, hide/show,
//    delete through the small confirmation; the product page's own field;
//    the shopper's chips (?group=, the department back to «الكل», a hidden
//    collection's link back to «الكل»);
//  - the store bell: STORE notifications of this store with a badge, its
//    inbox in the management window, never in the shopping bell; a
//    low-stock notice opens the owner's product (colour/size) or the
//    employee's branch stock line; an order notice marks that order.

const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

async function account() {
  const phone = uniquePhone();
  const user = await prisma.user.create({
    data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" },
  });
  await prisma.customerProfile.create({ data: { userId: user.id } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: "a-strong-password" } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, token: res.body.session_token };
}

let seq = 0;
/** A product of the store: ACTIVE (or another status) with one colour x size version and stock in the branch. */
async function product(vendorId: string, branchId: string, title: string, qty: number, status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  seq += 1;
  const offer = await prisma.vendorOffer.create({ data: { vendorId, titleAr: title, titleEn: `P ${seq}`, status } });
  const variant = await prisma.offerVariant.create({
    data: {
      vendorId,
      vendorOfferId: offer.id,
      sellerSku: unique(`col-sku-${seq}`),
      basePrice: 100,
      storeInventoryBarcode: unique(`col-bc-${seq}`),
      colour: "أسود",
      size: "M",
    },
  });
  await prisma.branchStock.create({ data: { vendorId, branchId, offerVariantId: variant.id, quantity: qty } });
  return { offerId: offer.id, variantId: variant.id };
}

test.describe("Store collections and the store inbox", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchId = "";
  let slug = "";
  let ownerId = "";
  const p: Record<string, { offerId: string; variantId: string }> = {};

  test.beforeAll(async () => {
    ({ vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken));
    await makeVendorEligible(vendorId);
    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } });
    slug = v.slug;
    ownerId = (await prisma.vendorUser.findFirstOrThrow({ where: { vendorId, role: "OWNER" }, select: { userId: true } })).userId;
    p.evening = await product(vendorId, branchId, "فستان سهرة مخملي", 5);
    p.satin = await product(vendorId, branchId, "فستان ساتان", 4);
    p.soldOut = await product(vendorId, branchId, "فستان نافد", 0);
    p.paused = await product(vendorId, branchId, "فستان موقوف", 3, "INACTIVE");
  });

  async function openProducts(page: Page) {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers`);
    await expect(page.getByTestId("offers-collections")).toBeVisible({ timeout: 30_000 });
  }

  test("from the products toolbar: «مجموعات المتجر» (secondary) opens in the same window; a collection is created (the Arabic name required), its products picked with search and select-all, ordered, the reasons a product is not shown; back, hide, and delete through the small confirmation", async ({ page }) => {
    await openProducts(page);
    const btn = page.getByTestId("offers-collections");
    await expect(btn).toHaveClass(/owner-secondary/);
    await expect(btn).toHaveAttribute("aria-label", "مجموعات المتجر");
    await expect(page.getByTestId("offers-add-product")).toHaveClass(/owner-primary/);
    await btn.click();
    const panel = page.getByTestId("wz-panel");
    await expect(panel).toHaveAttribute("data-view", "collections");
    await expect(panel.getByRole("heading", { level: 1 })).toHaveText("مجموعات المتجر");
    await expect(panel).toContainText("لا تغيّر المجموعة فئة المنتج الأساسية");
    // the automatic filters: read only, apart from the collections
    await expect(panel.locator(".col-auto")).toContainText("وصل حديثاً");
    await expect(page.locator(".wzp")).toHaveCount(1);

    await page.getByTestId("collections-new").click();
    await expect(panel).toHaveAttribute("data-view", "collection");
    await page.getByTestId("collection-save").click();
    await expect(page.getByText("اكتبي اسم المجموعة بالعربية.")).toBeVisible();
    await page.getByTestId("collection-name-ar").fill("فساتين سهرة");
    await page.getByTestId("collection-name-en").fill("Evening dresses");
    await page.getByTestId("collection-save").click();
    // saved: a small message at the top (no backdrop), and back to the list where it now is
    await expect(page.getByTestId("toast")).toHaveText("تم حفظ المجموعة", { timeout: 30_000 });
    await expect(panel).toHaveAttribute("data-view", "collections");
    const collectionId = (await prisma.storeSection.findFirstOrThrow({ where: { vendorId, name: "فساتين سهرة" } })).id;
    await expect(page.getByTestId(`collection-row-${collectionId}`)).toBeVisible();
    await expect(page.getByTestId(`collection-note-${collectionId}`)).toHaveText("لا تظهر للمتسوقات: لا منتجات متاحة");
    await page.getByTestId(`collection-edit-${collectionId}`).click();
    await expect(panel).toHaveAttribute("data-view", "collection");
    await expect(page.getByTestId("collection-edit-note")).toHaveText("لا تظهر للمتسوقات: لا منتجات متاحة");

    // the picker: a full screen in the same window, search narrows, select all shown
    await page.getByTestId("collection-add-products").click();
    await expect(panel).toHaveAttribute("data-view", "collection-pick");
    await page.getByTestId("picker-search").fill("فستان");
    await expect(page.getByTestId(`picker-item-${p.paused.offerId}`)).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("picker-status").selectOption("ACTIVE");
    await expect(page.getByTestId(`picker-item-${p.paused.offerId}`)).toHaveCount(0);
    await page.getByTestId("picker-select-page").check();
    await expect(page.getByTestId("picker-add")).toHaveText(/إضافة 3 إلى المجموعة/);
    await page.getByTestId("picker-add").click();
    // back in the collection, in the order shown (newest first), the sold-out one says why
    await expect(panel).toHaveAttribute("data-view", "collection");
    await expect(page.locator(".col-item")).toHaveCount(3, { timeout: 30_000 });
    await expect(page.getByTestId(`collection-item-${p.soldOut.offerId}`)).toContainText("لا يظهر للمتسوقات · نافد");
    const order = async () =>
      // the Playwright Prisma client predates the new column: read it raw
      (await prisma.$queryRaw<{ offerId: string }[]>`SELECT "offerId" FROM store_section_offers WHERE "sectionId" = ${collectionId} ORDER BY "sortOrder"`).map((r) => r.offerId);
    const before = await order();
    // the keyboard alternative to dragging: the last one up
    const last = before[before.length - 1];
    await page.getByTestId(`collection-item-${last}`).getByRole("button", { name: /تحريك للأعلى/ }).click();
    await expect.poll(order).toEqual([before[0], last, before[1]]);

    // «رجوع» to the list: counts and what shoppers see
    await page.getByTestId("wzp-back").click();
    await expect(panel).toHaveAttribute("data-view", "collections");
    const row = page.getByTestId(`collection-row-${collectionId}`);
    await expect(row).toContainText("3 منتج");
    await expect(row).toContainText("2 ظاهر للمتسوقات");
    await page.getByTestId(`collection-toggle-${collectionId}`).click();
    await expect(page.getByTestId(`collection-note-${collectionId}`)).toHaveText("مخفية عن المتسوقات");
    await page.getByTestId(`collection-toggle-${collectionId}`).click();
    await expect(page.getByTestId(`collection-note-${collectionId}`)).toHaveCount(0);

    // delete: a small confirmation only; Esc keeps it
    const temp = await call<{ id: string }>(`/vendors/${vendorId}/sections`, { method: "POST", token: fixtures.ownerToken, body: { name_ar: "مؤقتة" } });
    // the list is the window's first screen: × closes it; reopened, it shows the new one
    await page.getByTestId("wzp-close").click();
    await expect(panel).toHaveCount(0);
    await btn.click();
    await page.getByTestId(`collection-delete-${temp.body.id}`).click();
    await expect(page.getByTestId("small-confirm")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("small-confirm")).toHaveCount(0);
    await page.getByTestId(`collection-delete-${temp.body.id}`).click();
    await page.getByTestId("small-confirm-ok").click();
    await expect(page.getByTestId(`collection-row-${temp.body.id}`)).toHaveCount(0);
    expect(await prisma.storeSection.count({ where: { id: temp.body.id } })).toBe(0);
    await expectNoHorizontalOverflow(page);
  });

  test("the product page shows its «المجموعات» read only (chips, no field); «إدارة المجموعات» changes them on their own screen in the same window - directly, then back to the details; the old «الأقسام» page lands on «مجموعات المتجر»", async ({ page }) => {
    await openProducts(page);
    const second = await call<{ id: string }>(`/vendors/${vendorId}/sections`, { method: "POST", token: fixtures.ownerToken, body: { name_ar: "اختيارات العيد" } });
    await page.getByTestId(`offers-details-${p.evening.offerId}`).click();
    const summary = page.getByTestId("offer-collections-summary");
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".owner-details input, .owner-details select, .owner-details textarea")).toHaveCount(0);
    // already in «فساتين سهرة» (picked in the first test)
    await expect(summary.locator(".owner-chip")).toHaveText(["فساتين سهرة"], { timeout: 30_000 });
    await summary.getByTestId("offer-collections-manage").click();
    const panel = page.getByTestId("wz-panel");
    await expect(panel).toHaveAttribute("data-view", "offer-collections");
    await expect(page.locator(".wzp")).toHaveCount(1);
    await panel.getByTestId(`offer-collection-${second.body.id}`).check();
    await panel.getByTestId("offer-collections-save").click();
    await expect(page.getByTestId("toast")).toHaveText("حُفظت المجموعات.", { timeout: 30_000 });
    await expect(panel).toHaveAttribute("data-view", "details");
    await expect(page.getByTestId("offer-collections-summary").locator(".owner-chip")).toHaveText(["فساتين سهرة", "اختيارات العيد"], { timeout: 30_000 });
    expect(await prisma.storeSectionOffer.count({ where: { sectionId: second.body.id, offerId: p.evening.offerId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "offer.collections_set", entityId: p.evening.offerId } })).toBe(1);
    await page.goto(`/vendor/${vendorId}/sections`);
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "collections", { timeout: 30_000 });
  });

  test("the shopper: chips of the visible collections with available products after the automatic filters; a chip keeps ?group= and narrows the products; a hidden collection's link lands on «الكل»", async ({ page }) => {
    const shown = await prisma.storeSection.findFirstOrThrow({ where: { vendorId, name: "فساتين سهرة" } });
    const hidden = await call<{ id: string }>(`/vendors/${vendorId}/sections`, { method: "POST", token: fixtures.ownerToken, body: { name_ar: "مخفية", visible: false } });
    await call(`/vendors/${vendorId}/sections/${hidden.body.id}/offers`, { method: "POST", token: fixtures.ownerToken, body: { offer_ids: [p.satin.offerId] } });
    await page.goto(`/store/${slug}`);
    const chip = page.getByTestId(`store-group-${shown.id}`);
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toContainText("2");
    await expect(page.getByTestId(`store-group-${hidden.body.id}`)).toHaveCount(0);
    await chip.click();
    await expect(page).toHaveURL(new RegExp(`group=${shown.id}`));
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await page.goto(`/store/${slug}?group=${hidden.body.id}`);
    await expect(page).not.toHaveURL(/group=/, { timeout: 30_000 });
  });

  test("the store bell: STORE notifications of this store with a badge, in the shopping drawer's own look - from the right in Arabic, over the page (never a screen of the management window); never in the shopping bell; low stock opens the owner's product (colour/size) in the management window with the branch stock one tap away; an order notice marks the order", async ({ page }) => {
    const customer = await account();
    const profile = await prisma.customerProfile.findUniqueOrThrow({ where: { userId: customer.id } });
    const co = await prisma.customerOrder.create({ data: { customerId: profile.id } });
    const bo = await prisma.branchOrder.create({
      data: { customerOrderId: co.id, vendorId, branchId, fulfilmentMethod: "PICKUP", paymentMethod: "COD", subtotal: 10, total: 10, pickupCode: String(100000 + Math.floor(Math.random() * 899999)) },
    });
    const deliver = async (type: string, targetType: string, targetId: string, data: Record<string, unknown> = {}) => {
      const event = await prisma.outboxEvent.create({ data: { eventType: `col.ui.${type}`, payload: {}, status: "PUBLISHED", publishedAt: new Date() } });
      return prisma.notification.create({
        data: { outboxEventId: event.id, recipientUserId: ownerId, type: type as never, targetType: targetType as never, targetId, data: data as never, vendorId, branchId, audience: "STORE" },
      });
    };
    await prisma.notification.deleteMany({ where: { recipientUserId: ownerId, vendorId } });
    await deliver("LOW_STOCK_AFTER_RESERVE", "STOCK", p.satin.variantId, { remaining_quantity: 1 });
    await deliver("NEW_ORDER_FOR_EMPLOYEE", "BRANCH_ORDER", bo.id);

    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    // the shopping bell: no store notice
    await page.goto("/notifications");
    await expect(page.getByTestId("notifications-title")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("button.card", { hasText: "المخزون منخفض" })).toHaveCount(0);

    await page.goto(`/store/${slug}`);
    const bell = page.getByTestId("store-inbox-button");
    await expect(bell).toHaveAttribute("aria-label", /إشعارات المتجر \(2 غير مقروء\)/, { timeout: 30_000 });
    await bell.click();
    // the drawer: the shopping one's look and behaviour, from the right (Arabic), the page dimmed behind
    const drawer = page.getByTestId("store-inbox-drawer");
    await expect(drawer).toHaveClass(/is-open/);
    await expect(drawer.getByRole("heading", { level: 2 })).toHaveText("إشعارات المتجر");
    await expect(page.locator(".store-management-detail-frame")).toHaveCount(0);
    const item = drawer.locator(".notifications-drawer-item", { hasText: "المخزون منخفض على أحد المنتجات" });
    await expect(item).toBeVisible({ timeout: 30_000 });
    // once it has slid in: against the right edge (Arabic), the shopping drawer's width
    const width = page.viewportSize()!.width;
    const edge = async () => {
      const b = await drawer.locator(".notifications-drawer").boundingBox();
      return b ? Math.round(b.x + b.width) : -1;
    };
    await expect.poll(edge, { timeout: 5_000 }).toBe(width);
    const box = await drawer.locator(".notifications-drawer").boundingBox();
    expect(box!.width).toBeLessThanOrEqual(431);
    // «غير المقروءة فقط» as in the shopping drawer
    await drawer.getByRole("button", { name: "غير المقروءة فقط" }).click();
    await expect(drawer.locator(".notifications-drawer-item")).toHaveCount(2, { timeout: 30_000 });
    // Esc closes it
    await page.keyboard.press("Escape");
    await expect(drawer).not.toHaveClass(/is-open/);
    await bell.click();
    await drawer.locator(".notifications-drawer-item", { hasText: "المخزون منخفض على أحد المنتجات" }).click();
    // the owner's product, colour and size - in the management window
    const frame = page.frameLocator(".store-management-detail-frame");
    await expect(page.getByTestId("management-frame-title")).toHaveText("المنتجات والعروض", { timeout: 30_000 });
    await expect(frame.getByTestId("offers-low-stock")).toContainText("فستان ساتان", { timeout: 30_000 });
    await expect(frame.getByTestId("offers-low-stock")).toContainText("أسود / M");
    await expect(frame.getByTestId(`offers-row-${p.satin.offerId}`)).toHaveClass(/is-notified/);
    await expect(frame.getByTestId("offers-low-stock-branch")).toHaveAttribute("href", `/vendor/${vendorId}/branches/${branchId}/stock?variant=${p.satin.variantId}`);
    // the bell in the window's header opens the same drawer, over the window
    await page.getByTestId("management-frame-inbox").click();
    await expect(drawer).toHaveClass(/is-open/);
    await drawer.locator(".notifications-drawer-item", { hasText: "طلب جديد" }).first().click();
    await expect(frame.getByTestId(`branch-order-${bo.id}`)).toHaveClass(/is-notified/, { timeout: 30_000 });
    await expect(frame.getByTestId(`branch-order-${bo.id}`)).toHaveAttribute("aria-current", "true");
  });

  test("an employee: the store inbox has their branch's notice; low stock opens their branch stock with the line marked", async ({ page }) => {
    const employee = await account();
    await prisma.vendorUser.create({ data: { userId: employee.id, vendorId, role: "BRANCH_EMPLOYEE", branchId } });
    const event = await prisma.outboxEvent.create({ data: { eventType: "col.ui.emp", payload: {}, status: "PUBLISHED", publishedAt: new Date() } });
    await prisma.notification.create({
      data: { outboxEventId: event.id, recipientUserId: employee.id, type: "LOW_STOCK_AFTER_RESERVE", targetType: "STOCK", targetId: p.evening.variantId, data: { remaining_quantity: 1 }, vendorId, branchId, audience: "STORE" },
    });
    await loginAs(page, employee.token);
    await enterWorkspace(page, employee.token, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/notifications`);
    await page.locator("button.card", { hasText: "المخزون منخفض على أحد المنتجات" }).click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/branches/${branchId}/stock\\?variant=${p.evening.variantId}`));
    await expect(page.getByTestId(`stock-row-${p.evening.variantId}`)).toHaveClass(/is-notified/, { timeout: 30_000 });
  });

  test("on a phone: the collections screen fits, the actions stay reachable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openProducts(page);
    await page.getByTestId("offers-collections").click();
    await expect(page.getByTestId("collections-view")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("collections-new")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
