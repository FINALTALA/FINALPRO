import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// TB-16.2: the eight returns screens in Arabic and English - every fixed
// word, the statuses / reasons / item conditions, dates in the interface
// language, "{n} ₪" vs "₪{n}", the direction, no sideways scroll on desktop
// and phone - for the customer, the owner, the branch employee and the
// platform administrator. Free text (the customer's note, the store's
// reason) is shown as written. An error on screen follows a language switch
// at once. Of the orders page only its two return entry points are
// bilingual. The rows are written straight into the disposable test
// database; the free text, the store/branch names and the product's
// English title are Latin on purpose, so an English screen must carry no
// Arabic letter at all.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
const ARABIC = /[؀-ۿ]/;
const NOTE = "Customer note TB16";
const STORE_REASON = "Store reason TB16";
const TITLE_EN = "TB16 Item";
const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 360, height: 760 },
];
type Lang = "ar" | "en";
type Acc = { id: string; customerId: string; phone: string; token: string };

test.describe("TB-16.2: returns screens in Arabic and English", () => {
  test.describe.configure({ mode: "serial" });

  const shared = loadSharedFixtures();
  let owner: Acc;
  let employee: Acc;
  let customer: Acc;
  let admin: Acc;
  let vendorId = "";
  let branchA = "";
  const r: Record<"requested" | "approved" | "rejected" | "escalated" | "exchanged", { id: string; at: Date }> =
    {} as never;
  let orderPath = "";
  let expiresAt = new Date();

  async function account(platformRole?: "PLATFORM_ADMIN"): Promise<Acc> {
    const phone = uniquePhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar", platformRole: platformRole ?? null },
    });
    const profile = await prisma.customerProfile.create({ data: { userId: user.id } });
    const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
    if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
    return { id: user.id, customerId: profile.id, phone, token: res.body.session_token };
  }

  test.beforeAll(async () => {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique("tb16i-store").toLowerCase(),
        legalName: unique("L"),
        displayName: "TB16 Store",
        status: "ACTIVE",
        subscriptionStatus: "ACTIVE",
        storefrontPublished: true,
      },
    });
    vendorId = vendor.id;
    branchA = (
      await prisma.storeBranch.create({ data: { vendorId, name: unique("Branch A"), isPhysical: true, verificationStatus: "APPROVED" } })
    ).id;
    const offer = await prisma.vendorOffer.create({ data: { vendorId, titleAr: "قطعة TB16", titleEn: TITLE_EN, status: "ACTIVE" } });
    const variant = (size: string) =>
      prisma.offerVariant.create({
        data: { vendorId, vendorOfferId: offer.id, sellerSku: unique("sku"), storeInventoryBarcode: unique("sib"), basePrice: 50, size },
      });
    // One sign-in per account (the login endpoint allows 10 a minute per
    // address, shared with the two files just before this one in a full
    // run). The customer is global-setup's customer B, already signed in -
    // no file after this one uses it; its language goes back to Arabic in
    // afterAll, also after a failure.
    owner = await account();
    employee = await account();
    const me = await call<{ id: string; phone: string }>("/customers/me", { token: shared.customerBToken });
    if (!me.body.id) throw new Error(`GET /customers/me failed (status ${me.status})`);
    const profile = await prisma.customerProfile.findUniqueOrThrow({ where: { userId: me.body.id } });
    customer = { id: me.body.id, customerId: profile.id, phone: me.body.phone, token: shared.customerBToken };
    admin = await account("PLATFORM_ADMIN");
    await prisma.vendorUser.create({ data: { userId: owner.id, vendorId, role: "OWNER" } });
    await prisma.vendorUser.create({ data: { userId: employee.id, vendorId, role: "BRANCH_EMPLOYEE", branchId: branchA } });

    const day = 86_400_000;
    expiresAt = new Date(Date.now() + 3 * day);
    const make = async (data: Record<string, unknown>, at: Date, exchange = false) => {
      const original = await variant("M");
      const replacement = exchange ? await variant("L") : null;
      const customerOrder = await prisma.customerOrder.create({ data: { customerId: customer.customerId } });
      const order = await prisma.branchOrder.create({
        data: {
          customerOrderId: customerOrder.id,
          vendorId,
          branchId: branchA,
          fulfilmentMethod: "PICKUP",
          paymentMethod: "COD",
          status: "COMPLETED",
          subtotal: 50,
          total: 50,
          pickupCode: String(Math.floor(100000 + Math.random() * 899999)),
          pickedUpAt: new Date(Date.now() - day),
          codCollectedAt: new Date(Date.now() - day),
        },
      });
      const item = await prisma.branchOrderItem.create({
        data: { vendorId, branchOrderId: order.id, offerVariantId: original.id, quantity: 1, unitPrice: 50 },
      });
      if (!orderPath) orderPath = `/orders/${order.id}/items/${item.id}/return`;
      const ret = await prisma.return.create({
        data: {
          vendorId,
          branchOrderItemId: item.id,
          reason: "DAMAGED",
          reasonNote: NOTE,
          vendorReviewDueAt: new Date(Date.now() + 2 * day),
          createdAt: at,
          ...(replacement
            ? { desiredOutcome: "EXCHANGE", replacementOfferVariantId: replacement.id, replacementBranchId: branchA, replacementUnitPriceSnapshot: 62.5 }
            : {}),
          ...data,
        },
      });
      return { ret, item };
    };
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    r.requested = { id: (await make({ status: "REQUESTED" }, at(50))).ret.id, at: at(50) };
    r.approved = {
      id: (await make({ status: "APPROVED_AWAITING_DROPOFF", code: String(Math.floor(100000 + Math.random() * 899999)), codeExpiresAt: expiresAt }, at(40))).ret.id,
      at: at(40),
    };
    r.rejected = {
      id: (await make({ status: "REJECTED", rejectedAt: at(30), disputeDeadlineAt: expiresAt, rejectionReason: STORE_REASON }, at(30))).ret.id,
      at: at(30),
    };
    r.escalated = {
      id: (await make({ status: "ESCALATED", escalatedAt: at(20), rejectionReason: STORE_REASON }, at(20))).ret.id,
      at: at(20),
    };
    const ex = await make({ status: "EXCHANGED", receivedAt: at(5) }, at(10), true);
    r.exchanged = { id: ex.ret.id, at: at(10) };
    await prisma.exchangeSettlement.create({
      data: {
        returnId: ex.ret.id,
        branchOrderItemId: ex.item.id,
        vendorId,
        originalUnitPriceSnapshot: 50,
        replacementUnitPriceSnapshot: 62.5,
        quantity: 1,
        exchangeFeeSnapshot: 0,
        originalTotal: 50,
        replacementTotal: 62.5,
        netAmount: 12.5,
        direction: "COLLECT_CASH",
      },
    });
  });

  test.afterAll(async () => {
    // Always - also after a failure: the shared customer B is left in Arabic.
    if (customer?.id) await prisma.user.update({ where: { id: customer.id }, data: { languagePref: "ar" } });
  });

  /** Opens `path` as `acc` in `lang` on each viewport and runs `check`. */
  async function eachView(browser: Browser, acc: Acc, path: string, check: (page: Page, lang: Lang) => Promise<void>) {
    for (const lang of ["ar", "en"] as const) {
      await prisma.user.update({ where: { id: acc.id }, data: { languagePref: lang } });
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
        await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
        const page = await context.newPage();
        await loginAs(page, acc.token);
        // TB-26: a store or platform page is opened inside its workspace.
        const vendorPage = /^\/vendor\/([^/]+)/.exec(path);
        if (vendorPage) await enterWorkspace(page, acc.token, { type: "vendor", vendor_id: vendorPage[1] });
        else if (path.startsWith("/admin")) await enterWorkspace(page, acc.token, { type: "platform" });
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("dir", lang === "en" ? "ltr" : "rtl");
        await check(page, lang);
        await expectNoHorizontalOverflow(page);
        await context.close();
      }
    }
    await prisma.user.update({ where: { id: acc.id }, data: { languagePref: "ar" } });
  }
  const shell = (page: Page) => page.locator(".page-shell").first();
  /** Every expected text in this language is on screen; in English no
   * Arabic letter at all; in Arabic none of the English words. */
  async function words(page: Page, lang: Lang, texts: Record<Lang, string[]>) {
    for (const text of texts[lang]) await expect(shell(page)).toContainText(text, { timeout: 30_000 });
    const content = await shell(page).innerText();
    if (lang === "en") expect(content).not.toMatch(ARABIC);
    else for (const text of texts.en) expect(content).not.toContain(text);
  }
  /** The date as the browser formats it for this language. */
  async function dateIn(page: Page, lang: Lang, at: Date) {
    const expected = await page.evaluate(
      ([iso, locale]) => new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }),
      [at.toISOString(), lang === "en" ? "en" : "ar"],
    );
    await expect(shell(page)).toContainText(expected);
  }

  test("customer - my returns: statuses, reasons, codes and dates in both languages", async ({ browser }) => {
    await eachView(browser, customer, "/returns", async (page, lang) => {
      await words(page, lang, {
        ar: ["إرجاعاتي", "قيد مراجعة المتجر", "معتمد - بانتظار تسليم المنتج", "تالف", "كود الإرجاع", "(تبديل)", "تم التبديل"],
        en: ["My returns", "Awaiting the store's review", "Approved - awaiting drop-off", "Damaged", "Return code", "(exchange)", "Exchanged", TITLE_EN],
      });
      await dateIn(page, lang, r.requested.at);
    });
  });

  test("customer - a return: the code with its expiry date; the note as written", async ({ browser }) => {
    await eachView(browser, customer, `/returns/${r.approved.id}`, async (page, lang) => {
      await words(page, lang, {
        ar: ["طلب إرجاع", "إرجاعاتي", "معتمد - بانتظار تسليم المنتج", "كود الإرجاع", "سلّمي المنتج لأي فرع", "ملاحظتك:"],
        en: ["Return request", "My returns", "Approved - awaiting drop-off", "Return code", "hand the item to any of the store's branches", "Your note:"],
      });
      await expect(shell(page)).toContainText(NOTE);
      await dateIn(page, lang, expiresAt);
    });
  });

  test("customer - a rejected return: the store's reason as written, the dispute action", async ({ browser }) => {
    await eachView(browser, customer, `/returns/${r.rejected.id}`, async (page, lang) => {
      await words(page, lang, {
        ar: ["مرفوض من المتجر", "سبب الرفض:", "يمكنك الاعتراض حتى", "الاعتراض على الرفض"],
        en: ["Rejected by the store", "Rejection reason:", "You can dispute until", "Dispute the rejection"],
      });
      await expect(shell(page)).toContainText(STORE_REASON);
    });
  });

  test("customer - an exchanged return: the amount as '{n} ₪' in Arabic and '₪{n}' in English", async ({ browser }) => {
    await eachView(browser, customer, `/returns/${r.exchanged.id}`, async (page, lang) => {
      await words(page, lang, {
        ar: ["تم التبديل بنجاح في", "دفعتِ 12.5 ₪ نقداً في الفرع."],
        en: ["Exchanged on", "You paid ₪12.5 in cash at the branch."],
      });
      if (lang === "en") await expect(shell(page)).not.toContainText("12.5 ₪");
      else await expect(shell(page)).not.toContainText("₪12.5");
    });
  });

  test("customer - the return request form", async ({ browser }) => {
    await eachView(browser, customer, orderPath, async (page, lang) => {
      await words(page, lang, {
        ar: ["طلب إرجاع أو تبديل", "المطلوب", "السبب", "ملاحظة (اختياري)", "إرسال طلب الإرجاع"],
        en: ["Return or exchange request", "What would you like?", "Reason", "Note (optional)", "Send return request"],
      });
      const options = await page.locator("select").nth(1).locator("option").allInnerTexts();
      expect(options).toEqual(
        lang === "en"
          ? ["Damaged", "Wrong item", "Counterfeit claim", "Warranty claim", "Change of mind"]
          : ["تالف", "منتج خاطئ", "ادّعاء تقليد", "مطالبة ضمان", "تغيير رأي"],
      );
    });
  });

  test("owner and branch employee - the branch returns page", async ({ browser }) => {
    for (const acc of [owner, employee]) {
      await eachView(browser, acc, `/vendor/${vendorId}/branches/${branchA}/returns`, async (page, lang) => {
        await words(page, lang, {
          ar: ["طلبات الإرجاع", "مساحة الفرع", "قيد مراجعة المتجر", "اعتماد", "رفض", "(طلب تبديل)"],
          en: ["Return requests", "Branch workspace", "Awaiting the store's review", "Approve", "Reject", "(exchange request)"],
        });
        await expect(shell(page)).toContainText(NOTE);
        await dateIn(page, lang, r.requested.at);
      });
    }
  });

  test("owner - redeem a code and the return policy", async ({ browser }) => {
    await eachView(browser, owner, `/vendor/${vendorId}/returns/redeem`, async (page, lang) => {
      await words(page, lang, {
        ar: ["استبدال كود إرجاع", "كود الإرجاع (6 أرقام)", "يُستلم في:", "حالة المنتج"],
        en: ["Redeem a return code", "Return code (6 digits)", "Received at:", "Item condition"],
      });
      const conditions = await page.getByTestId("rt-redeem-condition").locator("option").allInnerTexts();
      expect(conditions).toEqual(lang === "en" ? ["Resellable", "Damaged"] : ["قابل لإعادة البيع", "تالف"]);
    });
    await eachView(browser, owner, `/vendor/${vendorId}/return-policy`, async (page, lang) => {
      await words(page, lang, {
        ar: ["سياسة الإرجاع", "السياسة", "آخر تعديل:"],
        en: ["Return policy", "Policy", "Last changed:"],
      });
      const modes = await page.getByTestId("ss-policy-mode").locator("option").allInnerTexts();
      expect(modes).toEqual(
        lang === "en"
          ? ["No returns or exchanges", "Returns for a refund only", "Exchanges only", "Returns or exchanges (the customer chooses)"]
          : ["لا يوجد إرجاع ولا تبديل", "إرجاع مقابل استرداد المبلغ فقط", "تبديل فقط", "إرجاع أو تبديل (العميل يختار)"],
      );
    });
  });

  test("platform administrator - the escalated returns; a non-administrator gets the refusal in their language", async ({ browser }) => {
    await eachView(browser, admin, "/admin/returns", async (page, lang) => {
      await words(page, lang, {
        ar: ["الإرجاعات المتصاعدة", "ملاحظة العميل:", "سبب رفض المتجر:", "اعتماد الإرجاع", "رفض نهائي"],
        en: ["Escalated returns", "Customer note:", "Store's rejection reason:", "Approve return", "Final rejection"],
      });
      await expect(shell(page)).toContainText(STORE_REASON);
      await dateIn(page, lang, r.escalated.at);
    });
    for (const lang of ["ar", "en"] as const) {
      await prisma.user.update({ where: { id: customer.id }, data: { languagePref: lang } });
      const context = await browser.newContext({ viewport: VIEWPORTS[0] });
      await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
      const page = await context.newPage();
      await loginAs(page, customer.token);
      await page.goto("/admin/returns");
      // TB-26: stopped at the platform workspace's entry, in their language.
      await expect(page.getByTestId("ws-enter-no-access")).toHaveText(
        lang === "en" ? "You don't have access to this workspace." : "لا تملكين صلاحية الدخول إلى مساحة العمل هذه.",
        { timeout: 30_000 },
      );
      await context.close();
    }
    await prisma.user.update({ where: { id: customer.id }, data: { languagePref: "ar" } });
  });

  test("orders page: only its two return entry points follow the language", async ({ browser }) => {
    for (const lang of ["ar", "en"] as const) {
      await prisma.user.update({ where: { id: customer.id }, data: { languagePref: lang } });
      const context = await browser.newContext({ viewport: VIEWPORTS[0] });
      await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
      const page = await context.newPage();
      await loginAs(page, customer.token);
      // /orders shows the orders inside the cart page (/cart?tab=orders):
      // "my returns" is the menu button that opens the returns dialog.
      await page.goto("/orders");
      const requestLink = page.locator(`a[href="${orderPath}"]`);
      await expect(requestLink).toHaveText(lang === "en" ? "Request a return" : "طلب إرجاع", { timeout: 30_000 });
      const trigger = page.locator("button.shopping-profile-returns-trigger");
      await expect(trigger).toHaveAttribute("aria-label", lang === "en" ? "Open my returns" : "فتح إرجاعاتي");
      await trigger.click();
      await expect(page.locator("#profile-returns-title")).toHaveText(lang === "en" ? "My returns" : "إرجاعاتي");
      // The embedded list itself is the bilingual returns list.
      await expect(page.locator(".shopping-profile-returns-dialog")).toContainText(
        lang === "en" ? "Awaiting the store's review" : "قيد مراجعة المتجر",
      );
      await context.close();
    }
    await prisma.user.update({ where: { id: customer.id }, data: { languagePref: "ar" } });
  });

  test("an error on screen follows a language switch at once - the page's own check and an API refusal", async ({ page }) => {
    const switchTo = (lang: Lang) =>
      page.evaluate((l) => {
        localStorage.setItem("finalpro_lang_pref", l);
        window.dispatchEvent(new Event("finalpro:lang"));
      }, lang);
    const banner = page.locator('.error-banner[role="alert"]');

    // The page's own check (no API call).
    await loginAs(page, owner.token);
    await enterWorkspace(page, owner.token, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/returns/redeem`);
    await page.getByRole("button", { name: "استبدال", exact: true }).click({ timeout: 30_000 });
    await expect(banner).toHaveText("الكود مكوَّن من 6 أرقام");
    await switchTo("en");
    await expect(banner).toHaveText("The code has 6 digits");
    await switchTo("ar");
    await expect(banner).toHaveText("الكود مكوَّن من 6 أرقام");

    // TB-26: a non-member never reaches the branch returns page - the
    // workspace entry refuses them, in the page's language (a tab of their
    // own: a workspace is per tab).
    const outsider = await (await page.context().browser()!.newContext()).newPage();
    await loginAs(outsider, shared.customerAToken);
    await outsider.goto(`/vendor/${vendorId}/branches/${branchA}/returns`);
    const refusal = outsider.getByTestId("ws-enter-no-access");
    await expect(refusal).toHaveText("لا تملكين صلاحية الدخول إلى مساحة العمل هذه.", { timeout: 30_000 });
    await outsider.evaluate(() => {
      localStorage.setItem("finalpro_lang_pref", "en");
      window.dispatchEvent(new Event("finalpro:lang"));
    });
    await expect(refusal).toHaveText("You don't have access to this workspace.");
    await outsider.context().close();
  });
});
