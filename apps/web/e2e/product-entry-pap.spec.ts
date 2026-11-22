import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique, uniquePhone } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// Phase A++ of the product-entry wizard, as a seller and a shopper use it:
// phone numbers typed the way people type them (item 8); the discount in
// the wizard (7); the closed clothing specifications (4); «نسخ كمنتج جديد»
// (1); «نسخ من فرع…» as ONE all-or-nothing change (2); the model and the
// shared images with image-size advice (5, 6); «معاينة» showing exactly
// what the published page shows, with every action off (3); the import
// naming what it does not take yet (condition 7).
// New columns/tables are read in SQL: this suite's Prisma client predates them.

const API_BASE = process.env.PW_API_BASE_URL;
const FIX = (name: string) => path.join(__dirname, "fixtures", name);
const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
/** U+200F RIGHT-TO-LEFT MARK - what an Arabic keyboard or a copied number often carries. */
const RLM = String.fromCharCode(0x200f);
const DESCRIPTION = "الوصف";
const arabicDigits = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));

test.describe("Phase A++: product entry", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let slug = "";
  let branchA = "";
  let branchB = "";
  let image = "";
  let shared = "";

  test.beforeAll(async () => {
    ({ vendorId, branchId: branchA } = await createVendorWithBranch(fixtures.ownerToken));
    branchB = (await prisma.storeBranch.create({ data: { vendorId, name: unique("فرع الخليل"), isPhysical: true } })).id;
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    const catalogue = await call(`/vendors/${vendorId}/storefront/catalogue`, {
      method: "PUT",
      token: fixtures.ownerToken,
      body: { departments: ["WOMEN"], categories: { WOMEN: ["DRESSES_WOMEN"] } },
    });
    if (catalogue.status !== 200) throw new Error(`storefront departments not set (${catalogue.status})`);
    image = await uploadFile(FIX("pap/good-900x1200.png"));
    shared = await uploadFile(FIX("tb25/blue-1.png"));
  });

  async function uploadFile(file: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(file)], { type: "image/png" }), path.basename(file));
    const res = await fetch(`${API_BASE}/vendors/${vendorId}/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixtures.ownerToken}` },
      body: form,
    });
    const body = (await res.json()) as { url?: string };
    if (res.status !== 201 || !body.url) throw new Error(`upload failed (${res.status})`);
    return body.url;
  }
  async function open(page: Page, url: string) {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(url);
  }
  const ready = (title: string) => ({
    layout: 5,
    step: 5,
    audience: "WOMEN",
    category: "DRESSES_WOMEN",
    title_ar: title,
    brand: { mode: "none" },
    colors: [{ code: "FUCHSIA", images: [image] }],
    size_system: "LETTER",
    sizes: { FUCHSIA: ["S", "M", "L"] },
    price: 200,
    stock: { [branchA]: { "FUCHSIA|S": 2, "FUCHSIA|M": 3, "FUCHSIA|L": 1 } },
  });
  async function apiDraft(payload: object): Promise<string> {
    const r = await call<{ id: string }>(`/vendors/${vendorId}/offer-drafts`, { method: "POST", token: fixtures.ownerToken, body: { payload } });
    if (r.status !== 201) throw new Error(`draft not created (${r.status})`);
    return r.body.id;
  }
  const payloadOf = async (id: string) =>
    (await prisma.offerDraft.findUniqueOrThrow({ where: { id } })).payload as Record<string, unknown> & {
      stock?: Record<string, Record<string, number>>;
    };
  const saved = (page: Page) => expect(page.getByTestId("wz-save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });

  // ------------------------------------------------------------------ item 8
  test("item 8: signing in with the number as people type it - a hidden RTL mark, Arabic digits, spaces - works; an invalid number is refused in Arabic, never in English", async ({ page }) => {
    const phone = uniquePhone();
    const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" } });
    await prisma.customerProfile.create({ data: { userId: user.id } });
    // "+970 59 123 4567" in Arabic digits, with spaces, after an RLM.
    const local = phone.slice(1);
    const typed = `${RLM}+${arabicDigits(local.slice(0, 3))} ${arabicDigits(local.slice(3, 5))} ${arabicDigits(local.slice(5, 8))} ${arabicDigits(local.slice(8))}`;

    await page.goto("/login");
    await page.locator('input[type="tel"]').fill("+970 59");
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    const banner = page.getByRole("alert").first();
    await expect(banner).toContainText("رقم الهاتف غير صحيح");
    await expect(page.locator("body")).not.toContainText(/must be|invalid|Bad Request/i);
    await expect(page).toHaveURL(/\/login/);

    await page.locator('input[type="tel"]').fill(typed);
    await page.locator('input[type="password"]').fill("wrong-password");
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("alert").first()).toContainText("رقم الهاتف أو كلمة المرور غير صحيحة");

    await page.locator('input[type="tel"]').fill(typed);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
    expect(await page.evaluate(() => window.localStorage.getItem("finalpro_session_token"))).toBeTruthy();
  });

  // ---------------------------------------------------------- items 7, 4, 5, 3
  test("items 7, 4, 5, 6 and 3: the specs as closed choices, a sale price, the model, a shared image with a size warning; «معاينة» shows the discounted price, the table, the images and the model - with the strip and every action off, nothing sent; the published page then shows the same", async ({ page }) => {
    const title = `فستان معاينة ${unique("p").slice(-5)}`;
    const id = await apiDraft({
      ...ready(title),
      step: 1,
      measurements: { keys: ["CHEST", "LENGTH"], values: { S: { CHEST: 86, LENGTH: 120 }, M: { CHEST: 90, LENGTH: 121 }, L: { CHEST: 96, LENGTH: 122.5 } } },
    });
    await open(page, `/vendor/${vendorId}/offers/drafts/${id}`);
    // Step 1: closed lists - one occasion, several care codes.
    await page.getByTestId("wz-spec-occasion").selectOption("EVENING");
    await page.getByTestId("wz-spec-care-HAND_WASH").click();
    await page.getByTestId("wz-spec-care-NO_BLEACH").click();
    await page.getByTestId("wz-next").click();
    // Step 2: the guidance; a shared image (small square -> a warning, never a block).
    await expect(page.getByTestId("wz-images-guide")).toContainText("3:4");
    await page.getByTestId("wz-shared-upload").setInputFiles(FIX("pap/small-square-300.png"));
    await expect(page.getByTestId("wz-shared-image")).toHaveCount(1, { timeout: 30_000 });
    const warn = page.getByTestId("wz-shared").getByTestId("wz-img-warn");
    await expect(warn).toContainText("دقة الصورة منخفضة");
    await expect(warn).toContainText("النسبة بعيدة عن 3:4");
    await page.getByTestId("wz-next").click();
    // Step 3: the model - a size of this product only.
    await expect(page.getByTestId("wz-model-size").locator("option")).toHaveText(["اختاري المقاس", "S", "M", "L"]);
    await page.getByTestId("wz-model-height").fill(arabicDigits("172"));
    await expect(page.getByTestId("wz-model-height")).toHaveValue("172");
    await page.getByTestId("wz-model-size").selectOption("M");
    await page.getByTestId("wz-next").click();
    // Step 4: a sale price (immediate, no dates).
    await page.getByTestId("discount-mode-sale").click();
    await page.getByTestId("discount-sale-price").fill("150");
    await page.getByTestId("wz-next").click();
    await expect(page.getByTestId("wz-summary-price")).toContainText("150");
    await saved(page);
    const p = await payloadOf(id);
    expect(p).toMatchObject({
      specs: { occasion: "EVENING", care: "HAND_WASH,NO_BLEACH" },
      model: { height_cm: 172, size: "M" },
      discount: { mode: "sale", sale_price: 150 },
    });
    expect((p.shared_images as string[]).length).toBe(1);

    // «معاينة»: a new window, the same page as the shopper's, in preview mode.
    const [pv] = await Promise.all([page.context().waitForEvent("page"), page.getByTestId("wz-preview").click()]);
    await expect(pv).toHaveURL(new RegExp(`/vendor/${vendorId}/offers/drafts/${id}/preview$`), { timeout: 30_000 });
    const writes: string[] = [];
    pv.on("request", (r) => {
      if (r.method() !== "GET" && r.url().includes("/api/v1/")) writes.push(`${r.method()} ${r.url()}`);
    });
    await expect(pv.getByTestId("pdp-preview-strip")).toContainText("معاينة — غير منشور", { timeout: 30_000 });
    await expect(pv.locator("h1")).toContainText(title);
    await expect(pv.locator(".pdp-price-now")).toHaveText("150 ₪");
    await expect(pv.locator(".pdp-price-old")).toHaveText("200 ₪");
    await pv.locator(".pdp-section-head").filter({ hasText: DESCRIPTION }).click();
    await expect(pv.getByTestId("pdp-spec-occasion")).toHaveText("سهرة");
    await expect(pv.getByTestId("pdp-spec-care")).toHaveText("غسيل يدوي، بدون مبيّض");
    await expect(pv.getByTestId("pdp-model")).toHaveText("العارضة طولها 172 سم وترتدي مقاس M");
    // The colour's own image first, then the shared one.
    const thumbs = pv.locator(".pdp-thumbs img");
    await expect(thumbs).toHaveCount(2);
    await expect(thumbs.nth(0)).toHaveAttribute("src", new RegExp(path.basename(image)));
    await expect(pv.locator(".pdp-image img")).toBeVisible();
    // The table, as the shopper will see it.
    await pv.locator(".pdp-size-guide-link").click();
    await expect(pv.locator("#sg-title")).toHaveText("جدول المقاسات (سم)");
    await expect(pv.locator(".sg-table")).toContainText("122.5");
    await expect(pv.locator(".sg-table")).toContainText("الصدر");
    await pv.keyboard.press("Escape");
    // Every action is off, and nothing is sent.
    await pv.getByRole("radio", { name: "M", exact: true }).click();
    await expect(pv.getByTestId("pdp-cart")).toBeDisabled();
    await expect(pv.getByTestId("pdp-cart")).toHaveText("معاينة فقط");
    await pv.getByTestId("pdp-cart").click({ force: true });
    await expect(pv.locator(".pdp-zone")).toHaveCount(0);
    await expect(pv.locator(".pdp-whatsapp")).toHaveCount(0);
    expect(writes).toEqual([]);
    await pv.close();

    // Published: the shopper's page shows the same.
    await page.getByTestId("wz-publish").click();
    await expect.poll(async () => (await prisma.offerDraft.findUniqueOrThrow({ where: { id } })).offerId, { timeout: 30_000 }).not.toBeNull();
    const offerId = (await prisma.offerDraft.findUniqueOrThrow({ where: { id } })).offerId!;
    const shopper = await page.context().browser()!.newContext();
    const sp = await shopper.newPage();
    await sp.goto(`/store/${slug}/products/${offerId}`);
    await expect(sp.locator(".pdp-price-now")).toHaveText("150 ₪", { timeout: 30_000 });
    await expect(sp.locator(".pdp-price-old")).toHaveText("200 ₪");
    await expect(sp.getByTestId("pdp-preview-strip")).toHaveCount(0);
    await sp.locator(".pdp-section-head").filter({ hasText: DESCRIPTION }).click();
    await expect(sp.getByTestId("pdp-spec-occasion")).toHaveText("سهرة");
    await expect(sp.getByTestId("pdp-spec-care")).toHaveText("غسيل يدوي، بدون مبيّض");
    await expect(sp.getByTestId("pdp-model")).toHaveText("العارضة طولها 172 سم وترتدي مقاس M");
    await expect(sp.locator(".pdp-thumbs img")).toHaveCount(2);
    await shopper.close();
    const rows = await prisma.$queryRaw<{ h: number | null; s: string | null; shared: bigint }[]>`
      SELECT "modelHeightCm" AS h, "modelSize" AS s,
             (SELECT count(*) FROM vendor_offer_shared_media m WHERE m."vendorOfferId" = o.id) AS shared
      FROM vendor_offers o WHERE o.id = ${offerId}`;
    expect(rows.map((r) => [r.h, r.s, Number(r.shared)])).toEqual([[172, "M", 1]]);
  });

  test("item 5: a model size that is not one of the product's sizes, or a height out of 100-220, is named in Arabic and blocks publishing", async ({ page }) => {
    const id = await apiDraft({ ...ready(`فستان عارضة ${unique("m").slice(-5)}`), model: { height_cm: 95, size: "M" } });
    await open(page, `/vendor/${vendorId}/offers/drafts/${id}`);
    await expect(page.getByTestId("wz-publish")).toBeDisabled({ timeout: 15_000 });
    await expect(page.locator("main, body").first()).toContainText("طول العارضة يجب أن يكون بين 100 و220 سم.");
    await page.getByTestId("wz-step-3").click();
    await page.getByTestId("wz-model-height").fill("170");
    await page.getByTestId("wz-model-clear").click();
    await saved(page);
    await page.getByTestId("wz-step-5").click();
    await expect(page.getByTestId("wz-publish")).toBeEnabled({ timeout: 15_000 });
  });

  // ------------------------------------------------------------------ item 2
  test("item 2: «نسخ من فرع…» asks before overwriting, copies every cell in ONE change and says «تم نسخ الكميات»; when another tab saved first, nothing changes and the reason is shown", async ({ page }) => {
    const id = await apiDraft({
      ...ready(`فستان فروع ${unique("b").slice(-5)}`),
      step: 4,
      stock: { [branchA]: { "FUCHSIA|S": 4, "FUCHSIA|L": 2 }, [branchB]: { "FUCHSIA|M": 9 } },
    });
    await open(page, `/vendor/${vendorId}/offers/drafts/${id}`);
    await page.getByTestId(`wz-branch-${branchB}`).click();
    await expect(page.getByTestId("wz-qty-FUCHSIA-M")).toHaveValue("9");
    // B has a quantity: a question first; cancelling changes nothing.
    await page.getByTestId("wz-copystock-from").selectOption(branchA);
    await page.getByTestId("wz-copystock-run").click();
    await expect(page.getByTestId("wz-copystock-ask")).toContainText("سيستبدل هذا كل الكميات الحالية");
    await page.getByTestId("wz-copystock-cancel").click();
    await expect(page.getByTestId("wz-qty-FUCHSIA-M")).toHaveValue("9");
    // Another tab saves a newer version meanwhile: the copy is refused as a whole.
    const cur = await prisma.offerDraft.findUniqueOrThrow({ where: { id } });
    const other = await call(`/vendors/${vendorId}/offer-drafts/${id}`, {
      method: "PATCH",
      token: fixtures.ownerToken,
      body: { expected_revision: cur.revision, payload: { ...(cur.payload as object), stock: { [branchA]: { "FUCHSIA|S": 4, "FUCHSIA|L": 2 }, [branchB]: { "FUCHSIA|M": 8 } } } },
    });
    expect(other.status).toBe(200);
    await page.getByTestId("wz-copystock-run").click();
    await page.getByTestId("wz-copystock-confirm").click();
    await expect(page.getByTestId("wz-copystock-error")).toContainText("لم تُنسخ الكميات وبقيت كما كانت.");
    await expect(page.getByTestId("wz-copystock-error")).toContainText("نسخة أحدث");
    await expect(page.getByTestId("wz-copystock-done")).toHaveCount(0);
    await expect(page.getByTestId("wz-qty-FUCHSIA-M")).toHaveValue("9");
    expect((await payloadOf(id)).stock).toEqual({ [branchA]: { "FUCHSIA|S": 4, "FUCHSIA|L": 2 }, [branchB]: { "FUCHSIA|M": 8 } });

    // Reloaded on the newer version: now it copies - all cells, one change.
    await page.reload();
    await page.getByTestId(`wz-branch-${branchB}`).click();
    await expect(page.getByTestId("wz-qty-FUCHSIA-M")).toHaveValue("8");
    const before = (await prisma.offerDraft.findUniqueOrThrow({ where: { id } })).revision;
    await page.getByTestId("wz-copystock-from").selectOption(branchA);
    await page.getByTestId("wz-copystock-run").click();
    await page.getByTestId("wz-copystock-confirm").click();
    await expect(page.getByTestId("wz-copystock-done")).toHaveText("تم نسخ الكميات");
    await expect(page.getByTestId("wz-qty-FUCHSIA-S")).toHaveValue("4");
    await expect(page.getByTestId("wz-qty-FUCHSIA-M")).toHaveValue("");
    await expect(page.getByTestId("wz-qty-FUCHSIA-L")).toHaveValue("2");
    const after = await prisma.offerDraft.findUniqueOrThrow({ where: { id } });
    expect(after.revision).toBe(before + 1);
    expect((after.payload as { stock: unknown }).stock).toEqual({
      [branchA]: { "FUCHSIA|S": 4, "FUCHSIA|L": 2 },
      [branchB]: { "FUCHSIA|S": 4, "FUCHSIA|L": 2 },
    });
    // A failed request (the server down): the cells keep their values, a clear error.
    await page.route("**/copy-stock", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_SERVER_ERROR", message: "boom" } }) }));
    await page.getByTestId(`wz-branch-${branchA}`).click();
    await page.getByTestId("wz-copystock-from").selectOption(branchB);
    await page.getByTestId("wz-copystock-run").click();
    await page.getByTestId("wz-copystock-confirm").click();
    await expect(page.getByTestId("wz-copystock-error")).toContainText("لم تُنسخ الكميات وبقيت كما كانت.");
    await expect(page.locator("body")).not.toContainText("boom");
    await expect(page.getByTestId("wz-qty-FUCHSIA-S")).toHaveValue("4");
  });

  // ------------------------------------------------------------------ item 1
  test("item 1: «نسخ كمنتج جديد» from the products table - without images by default; the copy opens in the wizard named «(نسخة)», with no quantities, and waits for its own images", async ({ page }) => {
    const title = `فستان أصل ${unique("c").slice(-5)}`;
    const id = await apiDraft({ ...ready(title), specs: { occasion: "WORK" }, shared_images: [shared] });
    const cur = await prisma.offerDraft.findUniqueOrThrow({ where: { id } });
    const pub = await call<{ offer_id: string }>(`/vendors/${vendorId}/offer-drafts/${id}/publish`, {
      method: "POST",
      token: fixtures.ownerToken,
      body: { expected_revision: cur.revision },
    });
    expect(pub.status).toBe(201);
    await open(page, `/vendor/${vendorId}/offers`);
    await page.getByTestId(`offers-copy-${pub.body.offer_id}`).click();
    await expect(page.getByTestId("copy-dialog")).toContainText(title);
    await expect(page.getByTestId("copy-without-images")).toBeChecked();
    await page.getByTestId("copy-confirm").click();
    await expect(page.getByTestId("wz-panel")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("wz-draft-title")).toHaveText(`${title} (نسخة)`);
    const copy = await prisma.offerDraft.findFirstOrThrow({ where: { vendorId, status: "OPEN" }, orderBy: { createdAt: "desc" } });
    expect(copy.payload).toMatchObject({ title_ar: `${title} (نسخة)`, specs: { occasion: "WORK" }, colors: [{ key: "FUCHSIA", family: "FUCHSIA", name_ar: "فوشي", images: [] }], shared_images: [] });
    expect((copy.payload as { stock?: unknown }).stock).toBeUndefined();
    await page.getByTestId("wz-step-5").click();
    await expect(page.getByTestId("wz-publish")).toBeDisabled({ timeout: 15_000 });
  });

  // ------------------------------------------------- items 5, 6 after creation
  test("items 5 and 6 on the product page: the model and the shared images are edited with the same rules; removing a shared image from one product leaves the other product's", async ({ page }) => {
    // created, not published: its content is still edited on its own page
    // (a published product's content changes through «تعديل المنتج»)
    const mk = async (title: string) => {
      const id = await apiDraft({ ...ready(title), shared_images: [shared] });
      const cur = await prisma.offerDraft.findUniqueOrThrow({ where: { id } });
      const r = await call<{ offer_id: string }>(`/vendors/${vendorId}/offer-drafts/${id}/submit`, { method: "POST", token: fixtures.ownerToken, body: { expected_revision: cur.revision } });
      expect(r.status).toBe(201);
      return r.body.offer_id;
    };
    const one = await mk(`فستان واحد ${unique("o").slice(-5)}`);
    const two = await mk(`فستان اثنان ${unique("o").slice(-5)}`);
    await open(page, `/vendor/${vendorId}/offers/${one}`);
    const card = page.getByTestId("offer-presentation-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByTestId("offer-model-height").fill("168");
    await card.getByTestId("offer-model-size").selectOption("S");
    await card.getByTestId("offer-model-save").click();
    await expect(card.getByTestId("offer-presentation-notice")).toHaveText("تم الحفظ");
    await expect(card.getByTestId("offer-shared-image")).toHaveCount(1);
    await card.getByTestId("offer-shared-remove-0").click();
    await card.getByTestId("offer-shared-save").click();
    await expect(card.getByTestId("offer-shared-image")).toHaveCount(0);
    const count = async (offerId: string) =>
      Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM vendor_offer_shared_media WHERE "vendorOfferId" = ${offerId}`)[0].n);
    await expect.poll(() => count(one)).toBe(0);
    expect(await count(two)).toBe(1);
    const model = await prisma.$queryRaw<{ h: number; s: string }[]>`SELECT "modelHeightCm" AS h, "modelSize" AS s FROM vendor_offers WHERE id = ${one}`;
    expect(model).toEqual([{ h: 168, s: "S" }]);
  });

  // -------------------------------------------------------------- condition 7
  test("condition 7 (2026-11-18): the owner's import is the product import - the older flat CSV screen is gone; XLSX only, a CSV is refused; what the file does not take (images, SKU) is said plainly", async ({ page }) => {
    await open(page, `/vendor/${vendorId}/offers/import`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("استيراد منتجات من ملف");
    await expect(page.getByRole("button", { name: "رفع واستيراد" })).toHaveCount(0);
    await expect(page.getByTestId("import-template")).toBeVisible();
    await page.getByTestId("import-limits").locator("summary").click();
    await expect(page.getByTestId("import-limits")).toContainText("الصور");
    await expect(page.getByTestId("import-limits")).toContainText("SKU");
    await page.locator('input[type="file"]').setInputFiles({ name: "products.csv", mimeType: "text/csv", buffer: Buffer.from("title_ar,price\nفستان,40", "utf-8") });
    // images in bulk (2026-11-18): only the template's XLSX and a ZIP of images are taken
    await expect(page.getByText("اختاري ملف XLSX من القالب وملف ZIP للصور فقط.")).toBeVisible();
    await expect(page.getByTestId("import-check-button")).toBeDisabled();
  });

  // ------------------------------------------------------------------- phone
  test("phone: the copy-stock control, the model fields, the shared images and the preview fit a phone - no sideways page scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const id = await apiDraft({
      ...ready(`فستان هاتف ${unique("h").slice(-5)}`),
      step: 4,
      shared_images: [shared],
      model: { height_cm: 165, size: "S" },
      stock: { [branchA]: { "FUCHSIA|S": 1 }, [branchB]: { "FUCHSIA|M": 2 } },
    });
    await open(page, `/vendor/${vendorId}/offers/drafts/${id}`);
    await expect(page.getByTestId("wz-copystock")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    await page.getByTestId("wz-step-3").click();
    await expect(page.getByTestId("wz-model")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByTestId("wz-step-2").click();
    await expect(page.getByTestId("wz-shared")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.goto(`/vendor/${vendorId}/offers/drafts/${id}/preview`);
    await expect(page.getByTestId("pdp-preview-strip")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pdp-model")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
