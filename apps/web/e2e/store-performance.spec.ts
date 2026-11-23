import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, uniquePhone } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// 2026-11-23 «أداء المتجر»: one card instead of five (أداء المتجر، تقييمات
// العملاء، مبيعات آخر 30 يوماً، مبيعات المحل، طباعة ملصقات). One screen with
// views in the URL: overview (the indicators - «غير متاحة» alone while their
// flag is off), sales (online + the shop's sales log), customers (reviews),
// quick tools (labels and the cashier in the same window with «رجوع» back
// here; the public reviews page). Old addresses open the right view; the
// employee keeps /store-sales for their branch.

const localRequire = createRequire(__filename);
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
const PERF = "vendor_performance_dashboard_enabled";
const CASHIER = "store_cashier_enabled";

async function account() {
  const phone = uniquePhone();
  const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" } });
  await prisma.customerProfile.create({ data: { userId: user.id } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: "a-strong-password" } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, token: res.body.session_token };
}
async function setFlag(key: string, enabled: boolean) {
  await prisma.featureFlag.upsert({ where: { key }, create: { key, enabled, description: "test" }, update: { enabled } });
}

test.describe("«أداء المتجر»", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchId = "";
  let slug = "";
  const before: Record<string, boolean | null> = {};

  test.beforeAll(async () => {
    for (const k of [PERF, CASHIER]) before[k] = (await prisma.featureFlag.findUnique({ where: { key: k } }))?.enabled ?? null;
    await setFlag(PERF, true);
    await setFlag(CASHIER, true);
    ({ vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع الأداء"));
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
  });
  test.afterAll(async () => {
    // back as it was - a row this spec created is removed again
    for (const k of [PERF, CASHIER]) {
      if (before[k] === null) await prisma.featureFlag.deleteMany({ where: { key: k } });
      else await setFlag(k, before[k]!);
    }
  });

  async function asOwner(page: Page, viewport = { width: 1360, height: 900 }) {
    await page.setViewportSize(viewport);
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
  }
  const frameOf = (page: Page) => page.frameLocator(".store-management-detail-frame");

  test("one card «أداء المتجر» in the grid; its window: four views in the URL, the indicators, sales (online + shop log), customers", async ({ page }) => {
    await asOwner(page);
    await page.goto(`/store/${slug}`);
    await page.locator(".store-manage-button").click();
    await expect(page.locator(".store-management-grid")).toBeVisible({ timeout: 30_000 });
    for (const k of ["reviews", "sales", "store-sales", "labels"]) await expect(page.getByTestId(`management-tile-${k}`)).toHaveCount(0);
    const tile = page.getByTestId("management-tile-performance");
    await expect(tile).toContainText("أداء المتجر");
    await expect(tile).toContainText("المؤشرات والمبيعات وتقييمات العملاء وأدوات المحل");
    await tile.click();
    await expect(page.getByTestId("management-frame-title")).toHaveText("أداء المتجر", { timeout: 30_000 });
    const frame = frameOf(page);
    await expect(frame.getByTestId("pf-views").locator("a")).toHaveText(["نظرة عامة", "المبيعات", "العملاء", "أدوات سريعة"]);
    await expect(frame.getByTestId("pf-view-overview")).toHaveAttribute("aria-current", "page");
    await expect(frame.getByText("مؤشرات الأداء (آخر 30 يوماً)")).toBeVisible({ timeout: 30_000 });
    // no panel inside a panel
    await expect(page.locator(".store-management-detail-panel")).toHaveCount(1);

    await frame.getByTestId("pf-view-sales").click();
    await expect(frame.getByTestId("pf-view-sales")).toHaveAttribute("aria-current", "page");
    await expect(frame.getByTestId("pf-view-title")).toBeFocused();
    await expect(frame.getByTestId("pf-online")).toContainText("المبيعات الأونلاين (آخر 30 يوماً)");
    await expect(frame.getByTestId("pf-store-sales")).toContainText("مبيعات المحل (سجل البيع)");
    await expect(frame.getByTestId("store-sales-summary")).toBeVisible({ timeout: 30_000 });
    // embedded: no title of its own, no second way to the cashier
    await expect(frame.getByTestId("store-sales-open-cashier")).toHaveCount(0);

    await frame.getByTestId("pf-view-customers").click();
    await expect(frame.getByTestId("pf-reviews")).toContainText("تقييمات العملاء");
    await expect(frame.getByTestId("pf-reviews-tab-ALL")).toHaveAttribute("aria-selected", "true");
    await frame.getByTestId("pf-reviews-tab-STORE").click();
    await expect(frame.getByTestId("pf-reviews-tab-STORE")).toHaveAttribute("aria-selected", "true");
  });

  test("quick tools: labels and the cashier open in the same window with «رجوع» back to «أداء المتجر»; the public reviews page", async ({ page }) => {
    await asOwner(page);
    await page.goto(`/store/${slug}`);
    await page.locator(".store-manage-button").click();
    await page.getByTestId("management-tile-performance").click({ timeout: 30_000 });
    const frame = frameOf(page);
    await frame.getByTestId("pf-view-tools").click({ timeout: 30_000 });
    await expect(frame.getByTestId("pf-tool-public-reviews")).toHaveAttribute("href", `/store/${slug}/reviews`);
    await expect(frame.getByTestId("pf-tool-public-reviews")).toHaveAttribute("target", "_blank");

    await frame.getByTestId("pf-tool-labels").click();
    await expect(frame.getByTestId("labels-screen")).toBeVisible({ timeout: 30_000 });
    const back = page.getByTestId("management-frame-back");
    await expect(back).toHaveAccessibleName("رجوع إلى أداء المتجر");
    await back.click();
    await expect(page.getByTestId("management-frame-title")).toHaveText("أداء المتجر", { timeout: 30_000 });
    await expect(frame.getByTestId("pf-view-tools")).toHaveAttribute("aria-current", "page");

    await frame.getByTestId("pf-tool-cashier").click();
    await expect(page.getByTestId("management-frame-title")).toHaveText("بيع من المحل", { timeout: 30_000 });
    await page.getByTestId("management-frame-back").click();
    await expect(frame.getByTestId("pf-view-tools")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
  });

  test("old addresses: /reviews, /sales and (owner) /store-sales open their view; the employee keeps /store-sales for their branch", async ({ page }) => {
    await asOwner(page);
    await page.goto(`/vendor/${vendorId}/reviews`);
    await expect(page).toHaveURL(new RegExp(`/performance\\?view=customers$`), { timeout: 30_000 });
    await expect(page.getByTestId("pf-reviews")).toBeVisible();
    await page.goto(`/vendor/${vendorId}/sales`);
    await expect(page).toHaveURL(new RegExp(`/performance\\?view=sales#online$`), { timeout: 30_000 });
    await expect(page.getByTestId("pf-online")).toBeVisible();
    await page.goto(`/vendor/${vendorId}/store-sales`);
    await expect(page).toHaveURL(new RegExp(`/performance\\?view=sales#store-sales$`), { timeout: 30_000 });
    await expect(page.getByTestId("pf-store-sales")).toBeFocused({ timeout: 30_000 });
    // the still-standing pages
    await page.goto(`/vendor/${vendorId}/labels`);
    await expect(page.getByTestId("labels-screen")).toBeVisible({ timeout: 30_000 });

    const emp = await account();
    await prisma.vendorUser.create({ data: { userId: emp.id, vendorId, role: "BRANCH_EMPLOYEE", branchId } });
    const other = await page.context().browser()!.newPage();
    await loginAs(other, emp.token);
    await enterWorkspace(other, emp.token, { type: "vendor", vendor_id: vendorId });
    await other.goto(`/vendor/${vendorId}/store-sales`);
    await expect(other.getByTestId("store-sales-page")).toBeVisible({ timeout: 30_000 });
    await expect(other).toHaveURL(new RegExp(`/vendor/${vendorId}/store-sales$`));
    await expect(other.getByTestId("store-sales-open-cashier")).toBeVisible();
    await other.goto(`/vendor/${vendorId}/performance`);
    await expect(other.getByText("هذه الصفحة لصاحب المتجر فقط")).toBeVisible({ timeout: 30_000 });
    await other.close();
  });

  test("flags off: the indicators alone say «غير متاحة»; the shop parts follow the cashier flag; nothing else is blocked", async ({ page }) => {
    await setFlag(PERF, false);
    await setFlag(CASHIER, false);
    try {
      await asOwner(page);
      await page.goto(`/vendor/${vendorId}/performance`);
      await expect(page.getByTestId("pf-kpis-off")).toContainText("مؤشرات الأداء غير متاحة حالياً", { timeout: 30_000 });
      await page.getByTestId("pf-view-sales").click();
      await expect(page.getByTestId("pf-online")).toBeVisible();
      await expect(page.getByTestId("pf-store-off")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("pf-store-sales")).toHaveCount(0);
      await page.getByTestId("pf-view-customers").click();
      await expect(page.getByTestId("pf-reviews")).toBeVisible();
      await page.getByTestId("pf-view-tools").click();
      await expect(page.getByTestId("pf-tools-off")).toBeVisible();
      await expect(page.getByTestId("pf-tool-labels")).toHaveCount(0);
      await expect(page.getByTestId("pf-tool-public-reviews")).toBeVisible();
    } finally {
      await setFlag(PERF, true);
      await setFlag(CASHIER, true);
    }
  });

  test("phone, keyboard, English (LTR) and axe", async ({ page }) => {
    await asOwner(page, { width: 390, height: 844 });
    await page.goto(`/vendor/${vendorId}/performance?view=sales`);
    await expect(page.getByTestId("pf-online")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    // the keyboard: a view is a link; Enter opens it and its heading takes the focus
    await page.getByTestId("pf-view-customers").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("pf-view-title")).toHaveText("العملاء");
    await expect(page.getByTestId("pf-view-title")).toBeFocused();

    await page.setViewportSize({ width: 1360, height: 900 });
    const axe = async () => {
      await page.addScriptTag({ content: readFileSync(localRequire.resolve("axe-core/axe.min.js"), "utf8") });
      return page.evaluate(async () => {
        const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[]; any: { message: string }[] }[] }[] }> } }).axe;
        const r = await a.run({ include: [['[data-testid="store-performance"]']] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.map((n) => `${n.target.join(" ")} - ${n.any[0]?.message ?? ""}`).join(" | ")}`);
      });
    };
    for (const v of ["overview", "sales", "customers", "tools"]) {
      await page.goto(`/vendor/${vendorId}/performance?view=${v}`);
      await expect(page.getByTestId(`pf-view-${v}`)).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
      await page.waitForTimeout(600);
      expect(await axe(), v).toEqual([]);
    }

    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await page.goto(`/vendor/${vendorId}/performance`);
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.locator(".pf-title")).toHaveText("Store performance");
      await expect(page.getByTestId("pf-views").locator("a")).toHaveText(["Overview", "Sales", "Customers", "Quick tools"]);
      await expect(page.getByText("Performance indicators (last 30 days)")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("pf-view-sales").click();
      await expect(page.getByTestId("pf-online")).toContainText("Online sales (last 30 days)");
      await page.getByTestId("pf-view-customers").click();
      await expect(page.getByTestId("pf-reviews-tab-PRODUCT")).toHaveText("Product reviews");
      await expectNoHorizontalOverflow(page);
      const arabic = await page.getByTestId("store-performance").innerText();
      expect(arabic).not.toMatch(/[؀-ۿ]/);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "ar"));
    }
  });
});
