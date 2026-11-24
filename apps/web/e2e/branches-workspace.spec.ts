import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique, uniquePhone } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// «إدارة الفروع» (2026-11-20, frontend only): the management window opens on
// the CURRENT branch - the owner switches between the active branches, an
// employee sees her own branch fixed - with the branch's tabs (the existing
// branch screens, each replacing the window's content: one title, one
// «رجوع», never a panel inside a panel), «إضافة فرع» as its own screen, and
// «مراجعة التطابق» last and muted in the store's management grid.

const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
async function account() {
  const phone = uniquePhone();
  const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" } });
  await prisma.customerProfile.create({ data: { userId: user.id } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: "a-strong-password" } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, token: res.body.session_token };
}

test.describe("Branch management", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let ramallah = "";
  let nablus = "";
  let slug = "";

  test.beforeAll(async () => {
    ({ vendorId, branchId: ramallah } = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع رام الله"));
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    const added = await call<{ id: string }>(`/vendors/${vendorId}/branches`, { method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("branch"), body: { name: "فرع نابلس" } });
    expect(added.status).toBe(201);
    nablus = added.body.id;
  });

  async function openManagement(page: Page) {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/store/${slug}`);
    await page.locator(".store-manage-button").click();
    await expect(page.locator(".store-management-grid")).toBeVisible({ timeout: 30_000 });
  }

  test("the grid: «إدارة الفروع», and «مراجعة التطابق» last and muted (still opens)", async ({ page }) => {
    await openManagement(page);
    const tiles = page.locator(".store-management-grid .store-management-tile");
    await expect(page.getByTestId("management-tile-branches")).toContainText("إدارة الفروع");
    await expect(tiles.last()).toHaveAttribute("data-testid", "management-tile-match-review");
    await expect(tiles.last()).toHaveClass(/is-deferred/);
    expect(Number(await tiles.last().locator(".store-management-tile-copy").evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.8);
    await expect(page.getByTestId("management-tile-branches")).not.toHaveClass(/is-deferred/);
    await tiles.last().click();
    await expect(page.getByTestId("management-frame-title")).toHaveText("مراجعة التطابق", { timeout: 30_000 });
  });

  test("owner: one branch dashboard - the context header (name, status, one meta line, the picker beside «إضافة فرع»), the tools bar, and only the work area changes; no «رجوع» between tools; no panel inside a panel", async ({ page }) => {
    await openManagement(page);
    await page.getByTestId("management-tile-branches").click();
    const title = page.getByTestId("management-frame-title");
    await expect(title).toHaveText("إدارة الفروع", { timeout: 30_000 });
    const frame = page.frameLocator(".store-management-detail-frame");
    const pick = frame.getByTestId("br-switch");
    await expect(pick).toBeVisible({ timeout: 30_000 });
    // the header: the current branch, its status and one meta line; the picker and «إضافة فرع» together
    await expect(frame.getByTestId("br-current-name")).toHaveText("فرع رام الله");
    await expect(frame.getByTestId("br-meta")).toContainText("فرع فعلي");
    await expect(frame.getByTestId("br-state")).toHaveText("نشط");
    await expect(frame.getByTestId("br-add")).toHaveText(/إضافة فرع/);
    expect(await frame.locator(".br-head-actions").evaluate((el) => el.contains(document.querySelector('[data-testid="br-switch"]')) && el.contains(document.querySelector('[data-testid="br-add"]')))).toBe(true);
    // only the active branches
    await expect(pick.locator("option")).toHaveText(["فرع رام الله", "فرع نابلس"]);
    // «نظرة عامة» (2026-11-24): the branch right now, what needs attention and
    // four quick actions - no card repeating the branch, no store-wide count
    await expect(frame.getByTestId("br-tab-overview")).toHaveAttribute("aria-current", "page");
    await expect(frame.getByTestId("br-overview")).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByTestId("br-summary").locator(".br-card")).toHaveCount(0);
    await expect(frame.getByTestId("br-active-count")).toHaveCount(0);
    for (const k of ["orders", "stock", "hours", "returns"]) await expect(frame.getByTestId(`br-link-${k}`)).toBeVisible();
    await expect(frame.locator(".hub-tile")).toHaveCount(0);
    // 2026-11-23: «الموظفون» is the owner's tab too
    for (const k of ["overview", "orders", "stock", "delivery-windows", "hours", "returns", "staff"]) {
      await expect(frame.getByTestId(`br-tab-${k}`)).toBeVisible();
      await expect(frame.getByTestId(`br-tab-${k}`).locator("svg")).toHaveCount(1);
    }
    // no settings tab: «إعدادات الفرع» beside the picker, «إعدادات المتجر» by the title
    await expect(frame.getByTestId("br-tab-minimum-order")).toHaveCount(0);
    await expect(frame.getByTestId("br-tab-settings")).toHaveCount(0);
    await expect(frame.getByTestId("br-branch-settings")).toBeVisible();
    await expect(frame.getByTestId("br-store-settings")).toContainText("إعدادات المتجر");

    // switching: the whole dashboard follows
    await pick.selectOption(nablus);
    await expect(frame.getByTestId("br-current-name")).toHaveText("فرع نابلس", { timeout: 30_000 });
    await expect(frame.getByTestId("br-overview")).toBeVisible({ timeout: 30_000 });

    // a tool: the header and the bar stay, only the work area changes; no «رجوع» between tools
    await frame.getByTestId("br-tab-orders").click();
    await expect(frame.getByTestId("br-tab-orders")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
    await expect(frame.getByTestId("br-current-name")).toHaveText("فرع نابلس");
    await expect(frame.getByTestId("br-switch")).toHaveValue(nablus);
    await expect(title).toHaveText("إدارة الفروع");
    await expect(page.getByTestId("management-frame-back")).toHaveCount(0);
    await expect(page.locator(".store-management-detail-panel")).toHaveCount(1);
    await expect(frame.locator(".store-management-panel, .store-management-detail-panel, .wzp")).toHaveCount(0);
    // the screen's own duplicate title and links give way to the dashboard
    await expect(frame.locator(".br-work .top-bar").first()).toBeHidden();

    // switching on a tool: the same tool of the other branch
    await frame.getByTestId("br-switch").selectOption(ramallah);
    await expect(frame.getByTestId("br-tab-orders")).toHaveAttribute("href", `/vendor/${vendorId}/branches/${ramallah}/orders`, { timeout: 30_000 });
    await expect(frame.getByTestId("br-tab-orders")).toHaveAttribute("aria-current", "page");
    await frame.getByTestId("br-tab-stock").click();
    await expect(frame.getByTestId("br-tab-stock")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
    await frame.getByTestId("br-tab-hours").click();
    await expect(frame.getByTestId("br-tab-hours")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
    await expect(page.getByTestId("management-frame-back")).toHaveCount(0);
    await frame.getByTestId("br-tab-overview").click();
    await expect(frame.getByTestId("br-current-name")).toHaveText("فرع رام الله", { timeout: 30_000 });
    await expect(frame.getByTestId("br-overview")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("management-frame-back")).toHaveCount(0);
  });

  test("owner: «إضافة فرع» is a screen of its own with «رجوع» back to the same branch and tool; the new branch becomes the current one; archiving it from «الإعدادات»", async ({ page }) => {
    await openManagement(page);
    await page.getByTestId("management-tile-branches").click();
    const title = page.getByTestId("management-frame-title");
    const frame = page.frameLocator(".store-management-detail-frame");
    await frame.getByTestId("br-switch").selectOption(nablus);
    await expect(frame.getByTestId("br-current-name")).toHaveText("فرع نابلس", { timeout: 30_000 });
    await frame.getByTestId("br-tab-stock").click();
    await expect(frame.getByTestId("br-tab-stock")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
    await frame.getByTestId("br-add").click();
    await expect(title).toHaveText("إضافة فرع", { timeout: 30_000 });
    await expect(page.getByTestId("management-frame-back")).toHaveCount(1);
    // «رجوع»: the same branch and tool
    await page.getByTestId("management-frame-back").click();
    await expect(title).toHaveText("إدارة الفروع", { timeout: 30_000 });
    await expect(frame.getByTestId("br-tab-stock")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
    await expect(frame.getByTestId("br-current-name")).toHaveText("فرع نابلس");
    await expect(page.getByTestId("management-frame-back")).toHaveCount(0);

    await frame.getByTestId("br-add").click();
    await expect(title).toHaveText("إضافة فرع", { timeout: 30_000 });
    // the same check as before: a name is required
    await frame.getByTestId("br-add-submit").click();
    await expect(frame.getByTestId("br-add-form")).toContainText("اسم الفرع مطلوب");
    await frame.getByTestId("br-add-name").fill("فرع الخليل");
    await frame.getByTestId("br-add-submit").click();
    await expect(title).toHaveText("إدارة الفروع", { timeout: 30_000 });
    const created = await prisma.storeBranch.findFirstOrThrow({ where: { vendorId, name: "فرع الخليل" } });
    await expect(frame.getByTestId("br-switch")).toHaveValue(created.id);
    await expect(frame.getByTestId("br-current-name")).toHaveText("فرع الخليل");

    // archive it (the same request as the old card's button)
    await frame.getByTestId("br-branch-settings").click();
    await frame.getByTestId("br-archive").click();
    await frame.getByTestId("br-archive-yes").click();
    await expect(frame.getByTestId("br-archived")).toBeVisible({ timeout: 30_000 });
    expect((await prisma.storeBranch.findUniqueOrThrow({ where: { id: created.id } })).archivedAt).not.toBeNull();
    await expect(frame.getByTestId("br-state")).toHaveText("مؤرشف");
    // still shown as the current one (marked archived) until another is chosen; then it is no longer in the picker
    await expect(frame.getByTestId("br-switch").locator("option").first()).toContainText("(مؤرشف)");
    await frame.getByTestId("br-switch").selectOption(ramallah);
    await expect(frame.getByTestId("br-current-name")).toHaveText("فرع رام الله", { timeout: 30_000 });
    await expect(frame.getByTestId("br-switch").locator("option")).toHaveText(["فرع رام الله", "فرع نابلس"]);
  });

  test("employee: her own branch, fixed - no picker, no «إضافة فرع», only her tools; another branch is refused", async ({ page }) => {
    const employee = await account();
    await prisma.vendorUser.create({ data: { userId: employee.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: ramallah } });
    await loginAs(page, employee.token);
    await enterWorkspace(page, employee.token, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/branches`);
    await expect(page.getByTestId("br-fixed")).toHaveText("فرع رام الله", { timeout: 30_000 });
    await expect(page.getByTestId("br-switch")).toHaveCount(0);
    await expect(page.getByTestId("br-add")).toHaveCount(0);
    // «نوافذ التوصيل v1» + «ساعات العمل والإغلاقات v1»: the employee also reads the branch's delivery board and hours
    await expect(page.locator(".br-tool")).toHaveCount(6);
    for (const k of ["orders", "stock", "delivery-windows", "hours", "returns"]) await expect(page.getByTestId(`br-tab-${k}`)).toBeVisible();
    // never «الموظفون» for an employee
    await expect(page.getByTestId("br-tab-staff")).toHaveCount(0);
    await page.getByTestId("br-tab-stock").click();
    await expect(page).toHaveURL(new RegExp(`/branches/${ramallah}/stock`));
    await expect(page.getByTestId("br-fixed")).toHaveText("فرع رام الله");
    await expect(page.getByTestId("br-tab-stock")).toHaveAttribute("aria-current", "page");
    // another branch: no bar, and its summary refuses (each screen keeps its own server refusal)
    await page.goto(`/vendor/${vendorId}/branches/${nablus}`);
    await expect(page.getByText("لا تملكين صلاحية على هذا الفرع")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("br-bar")).toHaveCount(0);
    await page.goto(`/vendor/${vendorId}/branches/new`);
    await expect(page.getByText("إضافة الفروع للمالكة فقط.")).toBeVisible({ timeout: 30_000 });
    // no minimum-order tab or editor for the employee - the old address leads to the owner-only settings
    await expect(page.getByTestId("br-tab-minimum-order")).toHaveCount(0);
    await expect(page.getByTestId("br-branch-settings")).toHaveCount(0);
    await expect(page.getByTestId("br-store-settings")).toHaveCount(0);
    await page.goto(`/vendor/${vendorId}/branches/${ramallah}/minimum-order`);
    await expect(page).toHaveURL(new RegExp(`/branches/${ramallah}/settings#minimum-order$`), { timeout: 30_000 });
    await expect(page.getByText("لا تملكين صلاحية على هذا الفرع")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("br-minimum-order")).toHaveCount(0);
  });

  test("owner: «الحد الأدنى للطلب» inside «الإعدادات» - the explanation, an amount in ₪ or «بلا حد أدنى», saved through the same API; the old address opens it focused", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    // the old address: the settings tab, scrolled to the section, its field focused
    await page.goto(`/vendor/${vendorId}/branches/${ramallah}/minimum-order`);
    await expect(page).toHaveURL(new RegExp(`/branches/${ramallah}/settings#minimum-order$`), { timeout: 30_000 });
    await expect(page.getByTestId("br-branch-settings")).toHaveAttribute("aria-current", "page");
    const section = page.getByTestId("br-minimum-order");
    await expect(section.locator("h2")).toHaveText("الحد الأدنى للطلب");
    await expect(section).toContainText("يُحسب الحد الأدنى من قيمة المنتجات فقط، ولا يشمل رسوم التوصيل. يطبّق على الاستلام من الفرع، وعلى التوصيل عندما لا يكون للمنطقة حد أدنى خاص بها.");
    await expect(section.getByTestId("br-min-none")).toBeChecked();
    await expect(section.getByTestId("br-min-none")).toBeFocused();
    await expect(section).toBeInViewport();
    // part of the settings page: no card inside a card
    await expect(section.locator(".br-card")).toHaveCount(0);
    await expect(page.getByTestId("br-settings")).toBeVisible();

    await section.getByTestId("br-min-none").uncheck();
    await expect(section.getByTestId("br-min-amount")).toBeEnabled();
    await section.getByTestId("br-min-amount").fill("75");
    await section.getByTestId("br-min-save").click();
    await expect(section.getByTestId("br-min-notice")).toHaveText("حُفظ الحد الأدنى.");
    expect(Number((await prisma.storeBranch.findUniqueOrThrow({ where: { id: ramallah } })).minimumOrderValue)).toBe(75);
    await page.reload();
    await expect(page.getByTestId("br-min-amount")).toHaveValue("75", { timeout: 30_000 });
    await expect(page.getByTestId("br-min-amount")).toBeFocused();

    await page.getByTestId("br-min-none").check();
    await expect(page.getByTestId("br-min-amount")).toBeDisabled();
    await page.getByTestId("br-min-save").click();
    await expect(page.getByTestId("br-min-notice")).toHaveText("حُفظ الحد الأدنى.");
    expect((await prisma.storeBranch.findUniqueOrThrow({ where: { id: ramallah } })).minimumOrderValue).toBeNull();
    await expectNoHorizontalOverflow(page);
  });

  test("phone and keyboard: the header and the tools bar fit (the bar scrolls inside itself), English is left-to-right", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/branches/${ramallah}/orders`);
    await expect(page.getByTestId("br-tab-orders")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    await page.getByTestId("br-tab-stock").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/branches/${ramallah}/stock`));
    // English (the owner's own language preference, put back afterwards)
    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await page.goto(`/vendor/${vendorId}/branches`);
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.getByTestId("br-add")).toContainText("Add a branch");
      await expect(page.getByTestId("br-tab-orders")).toHaveText("Orders");
      await expectNoHorizontalOverflow(page);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "ar"));
    }
  });
});
