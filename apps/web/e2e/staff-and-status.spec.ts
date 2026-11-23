import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique, uniquePhone } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// 2026-11-23: «حالة التحقق» is «حالة المتجر» inside «صفحتي» (publishing,
// verification, what needs action, «عرض تفاصيل التحقق» -> the unchanged
// verification page with «رجوع» to «صفحتي»); «الموظفون» is the owner's tab
// of «إدارة الفروع» («موظفو هذا الفرع | كل الموظفين», the branch on each
// member in «كل الموظفين», move / suspend unchanged). No cards for either.

const localRequire = createRequire(__filename);
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
async function account() {
  const phone = uniquePhone();
  const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" } });
  await prisma.customerProfile.create({ data: { userId: user.id } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: "a-strong-password" } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, token: res.body.session_token, phone };
}

test.describe("«حالة المتجر» and «الموظفون»", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let slug = "";
  let ramallah = "";
  let nablus = "";
  let empA: Awaited<ReturnType<typeof account>>;
  let empB: Awaited<ReturnType<typeof account>>;
  let memberA = "";
  let memberB = "";

  test.beforeAll(async () => {
    ({ vendorId, branchId: ramallah } = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع رام الله"));
    await makeVendorEligible(vendorId);
    const added = await call<{ id: string }>(`/vendors/${vendorId}/branches`, { method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("branch"), body: { name: "فرع نابلس" } });
    if (added.status !== 201) throw new Error(`branch: ${added.status}`);
    nablus = added.body.id;
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    empA = await account();
    empB = await account();
    memberA = (await prisma.vendorUser.create({ data: { userId: empA.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: ramallah } })).id;
    memberB = (await prisma.vendorUser.create({ data: { userId: empB.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: nablus } })).id;
  });

  async function asOwner(page: Page, viewport = { width: 1360, height: 900 }) {
    await page.setViewportSize(viewport);
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
  }
  const frameOf = (page: Page) => page.frameLocator(".store-management-detail-frame");

  test("no «الموظفون» / «حالة التحقق» cards; «صفحتي» › «حالة المتجر»: publishing, verification, «عرض تفاصيل التحقق» with «رجوع» to «صفحتي»", async ({ page }) => {
    await asOwner(page);
    await page.goto(`/store/${slug}`);
    await page.locator(".store-manage-button").click();
    await expect(page.locator(".store-management-grid")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("management-tile-staff")).toHaveCount(0);
    await expect(page.getByTestId("management-tile-verification")).toHaveCount(0);
    await page.getByTestId("management-tile-storefront").click();
    const frame = frameOf(page);
    const status = frame.getByTestId("mystatus");
    await expect(status).toContainText("حالة المتجر", { timeout: 30_000 });
    await expect(frame.getByTestId("mystatus-publish")).toHaveText("منشور - يظهر للعملاء");
    // makeVendorEligible approves the branches without evidence: «no evidence yet»
    await expect(frame.getByTestId("mystatus-verification")).toHaveText("لم يُقدَّم دليل تحقق بعد");
    await frame.getByTestId("mystatus-details").click();
    await expect(page.getByTestId("management-frame-title")).toHaveText("حالة التحقق", { timeout: 30_000 });
    await expect(frame.getByRole("heading", { name: "الفروع" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("management-frame-back")).toHaveAccessibleName("رجوع إلى صفحتي");
    await page.getByTestId("management-frame-back").click();
    await expect(page.getByTestId("management-frame-title")).toHaveText("صفحتي", { timeout: 30_000 });
    await expect(frame.getByTestId("mystatus")).toBeVisible();
  });

  test("«حالة المتجر» says what needs action; the old verification address still opens the full page", async ({ page }) => {
    // a separate store whose branch evidence was sent back
    const own = await createVendorWithBranch(fixtures.ownerToken, undefined, "فرع يحتاج تصحيح");
    await makeVendorEligible(own.vendorId);
    await prisma.vendor.update({ where: { id: own.vendorId }, data: { storefrontPublished: false } });
    await prisma.storeBranch.update({
      where: { id: own.branchId },
      data: { evidenceRevision: 1, verificationStatus: "RESUBMISSION_REQUESTED", reviewNote: "الصورة غير واضحة" },
    });
    await page.setViewportSize({ width: 1360, height: 900 });
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: own.vendorId });
    await page.goto(`/vendor/${own.vendorId}/storefront`);
    await expect(page.getByTestId("mystatus-publish")).toHaveText("غير منشور - لا يظهر للعملاء بعد", { timeout: 30_000 });
    await expect(page.getByTestId("mystatus-verification")).toHaveText("يحتاج إجراء", { timeout: 30_000 });
    await expect(page.getByTestId("mystatus-actions")).toContainText("فرع يحتاج تصحيح: مطلوب إعادة إرسال الدليل بعد تصحيحه");
    await page.getByTestId("mystatus-details").click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${own.vendorId}/verification$`), { timeout: 30_000 });
    // the full page, unchanged: the reviewer's note is there
    await expect(page.getByText("الصورة غير واضحة")).toBeVisible({ timeout: 30_000 });
  });

  test("«الموظفون»: the owner's tab - this branch by default, «كل الموظفين» with each member's branch; the picker changes «this branch»; move and suspend unchanged", async ({ page }) => {
    await asOwner(page);
    await page.goto(`/vendor/${vendorId}/branches/${ramallah}/staff`);
    await expect(page.getByTestId("br-tab-staff")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
    await expect(page.getByTestId("st-scope-branch")).toBeChecked();
    await expect(page.getByTestId(`st-member-${memberA}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`st-member-${memberB}`)).toHaveCount(0);
    await expect(page.getByTestId("st-member-branch")).toHaveCount(0);

    await page.getByTestId("st-scope-all").check();
    await expect(page).toHaveURL(/[?&]scope=all$/);
    await expect(page.getByTestId(`st-member-${memberB}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`st-member-${memberA}`).getByTestId("st-member-branch")).toContainText("فرع رام الله");
    await expect(page.getByTestId(`st-member-${memberB}`).getByTestId("st-member-branch")).toContainText("فرع نابلس");

    // the header's picker: «this branch» follows
    await page.getByTestId("br-switch").selectOption(nablus);
    await expect(page).toHaveURL(new RegExp(`/branches/${nablus}/staff$`), { timeout: 30_000 });
    await expect(page.getByTestId("st-scope-branch")).toBeChecked();
    await expect(page.getByTestId(`st-member-${memberB}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`st-member-${memberA}`)).toHaveCount(0);

    // suspend / reactivate and move: the same API as before
    const b = page.getByTestId(`st-member-${memberB}`);
    await b.getByTestId("st-suspend").click();
    await expect(b.getByTestId("st-member-status")).toHaveText("معلّق", { timeout: 30_000 });
    await b.getByTestId("st-suspend").click();
    await expect(b.getByTestId("st-member-status")).toHaveText("نشط", { timeout: 30_000 });
    // move to Ramallah: gone from «this branch» (Nablus), its branch changes in the data
    await b.getByTestId("st-transfer-select").selectOption(ramallah);
    await b.getByTestId("st-transfer").click();
    await expect(page.getByTestId(`st-member-${memberB}`)).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await prisma.vendorUser.findUniqueOrThrow({ where: { id: memberB } })).branchId).toBe(ramallah);
    // and back (the later tests expect one employee in each branch)
    await page.getByTestId("st-scope-all").check();
    const moved = page.getByTestId(`st-member-${memberB}`);
    await moved.getByTestId("st-transfer-select").selectOption(nablus);
    await moved.getByTestId("st-transfer").click();
    await expect(moved.getByTestId("st-member-branch")).toContainText("فرع نابلس", { timeout: 30_000 });
  });

  test("old /staff address: the tab with «كل الموظفين»; the employee never gets the tab or the roster", async ({ page }) => {
    await asOwner(page);
    await page.goto(`/vendor/${vendorId}/staff`);
    await expect(page).toHaveURL(/\/branches\/[0-9a-f-]+\/staff\?scope=all$/, { timeout: 30_000 });
    await expect(page.getByTestId("st-scope-all")).toBeChecked();

    const emp = await page.context().browser()!.newPage();
    await loginAs(emp, empA.token);
    await enterWorkspace(emp, empA.token, { type: "vendor", vendor_id: vendorId });
    await emp.goto(`/vendor/${vendorId}/branches/${ramallah}/orders`);
    await expect(emp.getByTestId("br-tabs")).toBeVisible({ timeout: 30_000 });
    await expect(emp.getByTestId("br-tab-staff")).toHaveCount(0);
    await emp.goto(`/vendor/${vendorId}/branches/${ramallah}/staff`);
    await expect(emp.getByText("هذه الصفحة لمالك المتجر فقط")).toBeVisible({ timeout: 30_000 });
    await expect(emp.getByTestId("st-list")).toHaveCount(0);
    expect((await call(`/vendors/${vendorId}/staff`, { token: empA.token })).status).toBe(403);
    await emp.goto(`/vendor/${vendorId}/staff`);
    await expect(emp).toHaveURL(new RegExp(`/branches/${ramallah}/staff$`), { timeout: 30_000 });
    await expect(emp.getByText("هذه الصفحة لمالك المتجر فقط")).toBeVisible({ timeout: 30_000 });
    await emp.close();
  });

  test("«+ إضافة موظفة»: the existing invite, always to the branch shown (also in «كل الموظفين»); refusals in words; pending invites listed; the employee never", async ({ page }) => {
    await asOwner(page);
    await page.goto(`/vendor/${vendorId}/branches/${ramallah}/staff?scope=all`);
    const open = page.getByTestId("st-invite-open");
    await expect(open).toHaveText(/إضافة موظفة.*إلى فرع رام الله/, { timeout: 30_000 });
    await open.click();
    const dlg = page.getByTestId("st-invite-dialog");
    await expect(dlg.getByRole("heading")).toHaveText("إضافة موظفة إلى فرع رام الله");
    await expect(dlg.locator("select")).toHaveCount(0); // no second branch choice
    await expect(dlg.getByTestId("st-invite-phone")).toBeFocused();
    // the screen's own check, then the API's
    await dlg.getByTestId("st-invite-send").click();
    await expect(dlg.getByTestId("st-invite-error")).toHaveText("رقم الجوال مطلوب.");
    await dlg.getByTestId("st-invite-phone").fill("123");
    await dlg.getByTestId("st-invite-send").click();
    await expect(dlg.getByTestId("st-invite-error")).toContainText("رقم الجوال غير صالح", { timeout: 30_000 });
    await expect(dlg.getByTestId("st-invite-phone")).toHaveAttribute("aria-invalid", "true");
    // a member of this store is refused in words
    await dlg.getByTestId("st-invite-phone").fill(empA.phone);
    await dlg.getByTestId("st-invite-send").click();
    await expect(dlg.getByTestId("st-invite-error")).toHaveText("هذا الرقم عضو في متجرك بالفعل.", { timeout: 30_000 });

    const phone = uniquePhone();
    await dlg.getByTestId("st-invite-phone").fill(phone);
    await dlg.getByTestId("st-invite-send").click();
    await expect(dlg.getByTestId("st-invite-sent")).toContainText(`أُرسلت الدعوة إلى ⁦${phone}⁩ لفرع رام الله.`, { timeout: 30_000 });
    const invite = await prisma.staffInvite.findFirstOrThrow({ where: { phone, vendorId } });
    expect(invite.branchId).toBe(ramallah);
    expect(invite.status).toBe("PENDING");
    await dlg.getByTestId("st-invite-done").click();
    await expect(dlg).toHaveCount(0);
    // the pending invite, quietly, with its branch in «كل الموظفين»
    const row = page.getByTestId(`st-invite-${invite.id}`);
    await expect(row).toContainText(phone, { timeout: 30_000 });
    await expect(row).toContainText("فرع رام الله");

    // the same phone again: refused, nothing new
    await open.click();
    await page.getByTestId("st-invite-phone").fill(phone);
    await page.getByTestId("st-invite-send").click();
    await expect(page.getByTestId("st-invite-error")).toHaveText("لهذا الرقم دعوة بانتظار القبول بالفعل.", { timeout: 30_000 });
    expect(await prisma.staffInvite.count({ where: { phone } })).toBe(1);
    await page.keyboard.press("Escape");

    // another branch: chosen in the header first - the invite follows it
    await page.getByTestId("br-switch").selectOption(nablus);
    await expect(page.getByTestId("st-invite-open")).toHaveText(/إلى فرع نابلس/, { timeout: 30_000 });
    // this branch's scope: Ramallah's pending invite is not listed here
    await expect(page.getByTestId(`st-invite-${invite.id}`)).toHaveCount(0);
    await page.getByTestId("st-invite-open").click();
    await expect(page.getByTestId("st-invite-dialog").getByRole("heading")).toHaveText("إضافة موظفة إلى فرع نابلس");
    const other = uniquePhone();
    await page.getByTestId("st-invite-phone").fill(other);
    await page.getByTestId("st-invite-send").click();
    await expect(page.getByTestId("st-invite-sent")).toContainText("لفرع نابلس", { timeout: 30_000 });
    expect((await prisma.staffInvite.findFirstOrThrow({ where: { phone: other } })).branchId).toBe(nablus);

    // the employee: no button, and a direct invite is refused by the server
    const emp = await page.context().browser()!.newPage();
    await loginAs(emp, empA.token);
    await enterWorkspace(emp, empA.token, { type: "vendor", vendor_id: vendorId });
    await emp.goto(`/vendor/${vendorId}/branches/${ramallah}/staff`);
    await expect(emp.getByText("هذه الصفحة لمالك المتجر فقط")).toBeVisible({ timeout: 30_000 });
    await expect(emp.getByTestId("st-invite-open")).toHaveCount(0);
    const direct = await call(`/vendors/${vendorId}/branches/${ramallah}/staff-invites`, { method: "POST", token: empA.token, idempotencyKey: unique("inv"), body: { phone: uniquePhone() } });
    expect(direct.status).toBe(403);
    await emp.close();
  });

  test("phone, keyboard, English (LTR) and axe", async ({ page }) => {
    await asOwner(page, { width: 390, height: 844 });
    await page.goto(`/vendor/${vendorId}/branches/${ramallah}/staff?scope=all`);
    await expect(page.getByTestId(`st-member-${memberB}`)).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    // «إضافة موظفة» on a phone: a bottom sheet, full width, anchored to the bottom
    await page.getByTestId("st-invite-open").click();
    const sheet = page.getByTestId("st-invite-dialog");
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(844 - 2);
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(388);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId("st-invite-open")).toBeFocused();
    await page.goto(`/vendor/${vendorId}/storefront`);
    await expect(page.getByTestId("mystatus")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(`/vendor/${vendorId}/branches/${ramallah}/staff`);
    // the keyboard: the scope is a radio group
    await page.getByTestId("st-scope-branch").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("st-scope-all")).toBeChecked({ timeout: 30_000 });
    const axe = async (sel: string) => {
      await page.addScriptTag({ content: readFileSync(localRequire.resolve("axe-core/axe.min.js"), "utf8") });
      return page.evaluate(async (s) => {
        const a = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[]; any: { message: string }[] }[] }[] }> } }).axe;
        const r = await a.run({ include: [[s]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.map((n) => `${n.target.join(" ")} - ${n.any[0]?.message ?? ""}`).join(" | ")}`);
      }, sel);
    };
    await expect(page.getByTestId("st-list")).toBeVisible({ timeout: 30_000 });
    expect(await axe('[data-testid="staff-board"]')).toEqual([]);
    await page.getByTestId("st-invite-open").click();
    await expect(page.getByTestId("st-invite-dialog")).toBeVisible();
    expect(await axe('[data-testid="st-invite-dialog"]')).toEqual([]);
    await page.keyboard.press("Escape");
    await page.goto(`/vendor/${vendorId}/storefront`);
    await expect(page.getByTestId("mystatus-verification")).not.toHaveText("…", { timeout: 30_000 });
    expect(await axe('[data-testid="mystatus"]')).toEqual([]);

    const owner = await prisma.user.findUniqueOrThrow({ where: { phone: fixtures.ownerPhone }, select: { id: true } });
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await page.goto(`/vendor/${vendorId}/branches/${ramallah}/staff`);
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.getByTestId("br-tab-staff")).toContainText("Staff");
      await expect(page.getByTestId("st-scope")).toContainText("This branch's staff");
      await expect(page.getByTestId("st-scope")).toContainText("All staff");
      await expect(page.getByTestId(`st-member-${memberA}`).getByTestId("st-member-status")).toHaveText("Active", { timeout: 30_000 });
      await expect(page.getByTestId("st-invite-open")).toHaveText(/\+ Add staff member.*to فرع رام الله/);
      await page.getByTestId("st-invite-open").click();
      await expect(page.getByTestId("st-invite-dialog").getByRole("heading")).toHaveText("Add a staff member to فرع رام الله");
      await expect(page.getByTestId("st-invite-send")).toHaveText("Send invite");
      await page.keyboard.press("Escape");
      await page.goto(`/vendor/${vendorId}/storefront`);
      await expect(page.getByTestId("mystatus")).toContainText("Store status", { timeout: 30_000 });
      await expect(page.getByTestId("mystatus-details")).toHaveText("View verification details");
      await expectNoHorizontalOverflow(page);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
      await page.evaluate(() => localStorage.setItem("finalpro_lang_pref", "ar"));
    }
  });
});
