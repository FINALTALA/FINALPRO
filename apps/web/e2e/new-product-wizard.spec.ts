import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// The product-entry wizard, phase A+: one panel over the store's list (the
// storefront's «إضافة منتج», the products table), opened with the list's
// place as changeable defaults; NO draft until the seller's first real
// information; five flat steps - details / colours and images / sizes and
// measurements / stock and price / review and publish; stock as one grid
// per branch (colours x sizes, keyboard, per-cell and overall save state,
// quick fill, totals); an optional measurements table (cm) shown to shoppers
// as «جدول المقاسات (سم)»; two actions only - «حفظ كمسودة» and «نشر» (created
// and published in one request, once), «نشر» off while the server's
// read-only publish check lists anything missing; the English name optional;
// one «مسوداتي» (drafts + products created but not published); Arabic /
// English, phone, keyboard.

const IMG = (name: string) => path.join(__dirname, "fixtures", "tb25", name);
const SIZES = ["EU_36", "EU_38", "EU_40", "EU_42", "EU_44", "EU_46"];

test.describe("Product-entry wizard (phase A+)", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let slug = "";
  let branchA = "";
  let branchB = "";
  let branchAName = "";
  /** The evening dress published in the end-to-end test (no English name). */
  let dressId = "";
  let dressTitle = "";

  test.beforeAll(async () => {
    ({ vendorId, branchId: branchA } = await createVendorWithBranch(fixtures.ownerToken));
    branchAName = (await prisma.storeBranch.findUniqueOrThrow({ where: { id: branchA } })).name;
    branchB = (await prisma.storeBranch.create({ data: { vendorId, name: unique("فرع نابلس"), isPhysical: true } })).id;
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    const catalogue = await call(`/vendors/${vendorId}/storefront/catalogue`, {
      method: "PUT",
      token: fixtures.ownerToken,
      body: { departments: ["WOMEN", "MEN"], categories: { WOMEN: ["DRESSES_WOMEN"], MEN: ["SHIRTS"] } },
    });
    if (catalogue.status !== 200) throw new Error(`storefront departments not set (${catalogue.status})`);
  });

  async function open(page: Page, url: string) {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(url);
  }
  const saved = (page: Page) => expect(page.getByTestId("wz-save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
  const openDrafts = () => prisma.offerDraft.count({ where: { vendorId, status: "OPEN" } });
  /** «منتج جديد» from «مسوداتي»: the panel, with nothing on the server yet. */
  async function openPanel(page: Page) {
    await open(page, `/vendor/${vendorId}/offers/new`);
    await page.getByTestId("wz-start-new").click();
    await expect(page.getByTestId("wz-panel")).toBeVisible();
  }
  /** A draft on the server (via the API, as the wizard's first save would). */
  async function apiDraft(payload: object): Promise<string> {
    const r = await call<{ id: string }>(`/vendors/${vendorId}/offer-drafts`, { method: "POST", token: fixtures.ownerToken, body: { payload } });
    if (r.status !== 201) throw new Error(`draft not created (${r.status})`);
    return r.body.id;
  }
  /** The storefront's own department / category tabs (the sticky copy of the bar repeats them). */
  const deptTab = (page: Page, name: string) =>
    page.getByRole("tablist", { name: "أقسام المتجر", exact: true }).getByRole("tab", { name });
  const catTab = (page: Page, name: string) => page.getByRole("tab", { name }).first();
  const latestDraft = () => prisma.offerDraft.findFirstOrThrow({ where: { vendorId }, orderBy: { createdAt: "desc" } });
  const cell = (page: Page, color: string, size: string) => page.getByTestId(`wz-cell-${color}-${size}`);
  const qty = (page: Page, color: string, size: string) => page.getByTestId(`wz-qty-${color}-${size}`);
  /** The product's own table (size guide kind OFFER) - read in SQL: this suite's client predates the column. */
  const guideVersions = async (offerId: string) =>
    (
      await prisma.$queryRaw<{ version: number; status: string; basis: string; kind: string; rows: bigint }[]>`
        SELECT v.version, v.status::text AS status, v.basis::text AS basis, g.kind::text AS kind,
               (SELECT count(*) FROM size_guide_rows r WHERE r."versionId" = v.id) AS rows
        FROM size_guide_versions v JOIN size_guides g ON g.id = v."guideId"
        WHERE g."vendorOfferId" = ${offerId} ORDER BY v.version`
    ).map((r) => ({ ...r, rows: Number(r.rows) }));
  const anImage = async () => {
    const img = (await prisma.offerVariantMedia.findFirst({ where: { vendorId }, select: { url: true } }))?.url;
    if (!img) throw new Error("the evening dress test must run first (it uploads this store's images)");
    return img;
  };

  test("no empty draft: «منتج جديد» opens the panel and creates nothing; closing before any real information leaves nothing and asks nothing; a colour first creates «مسودة جديدة», and the name then replaces it", async ({ page }) => {
    const before = await openDrafts();
    page.on("dialog", (d) => {
      throw new Error(`no question expected, got: ${d.message()}`);
    });
    await openPanel(page);
    await expect(page.getByTestId("wz-save-state")).toHaveAttribute("data-state", "local");
    await expect(page.getByRole("list").filter({ has: page.getByTestId("wz-step-5") }).getByRole("listitem")).toHaveCount(5);
    // Context only (audience) is not information.
    await page.getByRole("radio", { name: "نساء" }).check();
    await page.getByTestId("wz-panel-close").click();
    await expect(page.getByTestId("wz-panel")).toHaveCount(0);
    expect(await openDrafts()).toBe(before);

    await page.getByTestId("wz-start-new").click();
    await page.getByTestId("wz-next").click();
    await page.getByTestId("wz-color-BLACK").click();
    await saved(page);
    expect(await openDrafts()).toBe(before + 1);
    await expect(page.getByTestId("wz-draft-title")).toHaveText("مسودة جديدة");
    expect((await latestDraft()).payload).toMatchObject({ layout: 5, step: 2, // product colours: a colour added from its family, named after it
    colors: [{ key: "BLACK", family: "BLACK", name_ar: "أسود", images: [] }] });
    await page.getByTestId("wz-step-1").click();
    await page.getByTestId("wz-title-ar").fill("قميص أسود");
    await saved(page);
    await expect(page.getByTestId("wz-draft-title")).toHaveText("قميص أسود");
    // Closing after real information: saved first, then closed - and listed by its name.
    await page.getByTestId("wz-panel-close").click();
    await expect(page.getByTestId("wz-panel")).toHaveCount(0);
    await expect(page.getByTestId("wz-draft-item").filter({ hasText: "قميص أسود" })).toBeVisible();
    expect(await openDrafts()).toBe(before + 1);
  });

  test("closing right after typing saves first; when that save fails the panel stays open, says so, and closes once the retry saved it", async ({ page }) => {
    await openPanel(page);
    let fail = true;
    await page.route("**/offer-drafts", async (route) => {
      if (route.request().method() === "POST" && fail) {
        fail = false;
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_SERVER_ERROR", message: "boom" } }) });
      } else await route.continue();
    });
    const name = `فستان ${unique("c").slice(-5)}`;
    await page.getByTestId("wz-title-ar").fill(name);
    await page.getByTestId("wz-panel-close").click();
    await expect(page.getByTestId("wz-close-error")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("wz-panel")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("boom");
    await page.getByTestId("wz-close-error").getByRole("button").click();
    await saved(page);
    await page.getByTestId("wz-panel-close").click();
    await expect(page.getByTestId("wz-panel")).toHaveCount(0);
    expect(((await latestDraft()).payload as { title_ar?: string }).title_ar).toBe(name);
  });

  test("two tabs on one draft: the second tab's save is refused and shown - never silent; it can load the newer version or keep its own", async ({ context }) => {
    const id = await apiDraft({ title_ar: "مسودة التبويبين" });
    const tabA = await context.newPage();
    await open(tabA, `/vendor/${vendorId}/offers/drafts/${id}`);
    const tabB = await context.newPage();
    await open(tabB, `/vendor/${vendorId}/offers/drafts/${id}`);
    await expect(tabB.getByTestId("wz-title-ar")).toBeVisible();

    await tabA.getByTestId("wz-title-ar").fill("من التبويب الأول");
    await saved(tabA);
    await tabB.getByTestId("wz-title-ar").fill("من التبويب الثاني");
    await expect(tabB.getByTestId("wz-conflict")).toBeVisible({ timeout: 15_000 });
    expect(((await prisma.offerDraft.findUniqueOrThrow({ where: { id } })).payload as { title_ar?: string }).title_ar).toBe("من التبويب الأول");
    await tabB.getByTestId("wz-conflict-load").click();
    await expect(tabB.getByTestId("wz-title-ar")).toHaveValue("من التبويب الأول");

    await tabA.getByTestId("wz-title-ar").fill("التبويب الأول مرة أخرى");
    await saved(tabA);
    await tabB.getByTestId("wz-title-ar").fill("أحتفظ بنسختي");
    await expect(tabB.getByTestId("wz-conflict")).toBeVisible({ timeout: 15_000 });
    await tabB.getByTestId("wz-conflict-keep").click();
    await saved(tabB);
    expect(((await prisma.offerDraft.findUniqueOrThrow({ where: { id } })).payload as { title_ar?: string }).title_ar).toBe("أحتفظ بنسختي");
  });

  test("the evening dress, five steps, no English name: colours with their own images; EU sizes and a measurements table; the stock grid (fill all / row / column, typed cells, Enter goes down, a size a colour lacks is «—», totals, every cell saved); published with «نشر» exactly as entered; shoppers see «جدول المقاسات (سم)»", async ({ page }) => {
    await open(page, `/vendor/${vendorId}/offers`);
    await page.getByTestId("offers-add-product").click();
    await expect(page.getByTestId("wz-panel")).toBeVisible();
    await expect(page.getByTestId("wz-draft-title")).toHaveText("منتج جديد");
    dressTitle = `فستان سهرة ${unique("x").slice(-5)}`;
    // Step 1 - the English name is optional (no star, never asked for).
    await page.getByRole("radio", { name: "نساء" }).check();
    await page.getByTestId("wz-category").selectOption("DRESSES_WOMEN");
    await expect(page.getByTestId("wz-context")).toHaveText("نساء › فساتين");
    await page.getByTestId("wz-title-ar").fill(dressTitle);
    await expect(page.locator("label").filter({ hasText: "اسم المنتج بالإنجليزية" })).toContainText("اختياري");
    await page.getByTestId("wz-brand-none").click();
    await page.getByTestId("wz-spec-material").selectOption("شيفون");
    await page.getByTestId("wz-next").click();

    // Step 2 - colours and images (nothing else on this step).
    await expect(page.getByTestId("wz-step-2")).toHaveAttribute("aria-current", "step");
    for (const c of ["BROWN", "BLACK", "OLIVE"]) await page.getByTestId(`wz-color-${c}`).click();
    await page.getByTestId("wz-upload-BROWN").setInputFiles([IMG("red-1.png"), IMG("red-2.png")]);
    await page.getByTestId("wz-upload-BLACK").setInputFiles([IMG("blue-1.png"), IMG("blue-2.png")]);
    await page.getByTestId("wz-upload-OLIVE").setInputFiles([IMG("green-1.png")]);
    await expect(page.getByTestId("wz-images-BROWN").locator("img")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId("wz-images-BLACK").locator("img")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId("wz-images-OLIVE").locator("img")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("wz-size-system")).toHaveCount(0);
    await page.getByTestId("wz-next").click();

    // Step 3 - sizes: the system first (EU suggested for dresses); then the measurements table.
    await expect(page.getByTestId("wz-size-system-EU")).toContainText("مقترح لهذه الفئة");
    await page.getByTestId("wz-size-system-EU").click();
    for (const s of SIZES) await page.getByTestId(`wz-size-BROWN-${s}`).click();
    await page.getByTestId("wz-sizes-copy-BLACK").click();
    for (const s of SIZES.slice(1, 5)) await page.getByTestId(`wz-size-OLIVE-${s}`).click();
    const measure = page.getByTestId("wz-measure");
    await expect(measure).toContainText("جدول القياسات (سم)");
    await expect(measure).toContainText("اختياري");
    // Nothing pre-chosen, no table yet: the seller chooses what matters for this dress (chest and length).
    for (const k of ["CHEST", "WAIST", "HIP", "LENGTH"]) await expect(page.getByTestId(`wz-measure-key-${k}`)).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("wz-measure-key-INSEAM")).toHaveCount(0);
    await expect(page.getByTestId("wz-measure-choose")).toBeVisible();
    await expect(page.getByTestId("wz-measure-grid")).toHaveCount(0);
    await page.getByTestId("wz-measure-key-CHEST").click();
    await page.getByTestId("wz-measure-key-LENGTH").click();
    // Only the chosen columns - never a hip or shoulder cell to fill.
    await expect(page.getByTestId("wz-measure-grid").locator("thead th")).toHaveCount(3);
    await expect(page.getByTestId("wz-measure-grid")).not.toContainText("الورك");
    for (const [i, s] of SIZES.entries()) {
      await page.getByTestId(`wz-measure-${s}-CHEST`).fill(String(84 + 4 * i));
      if (i === 0) await expect(page.getByTestId("wz-measure-missing")).toContainText("خانات فارغة: 11");
      await page.getByTestId(`wz-measure-${s}-LENGTH`).fill(String(130 + i) + ".5");
    }
    await expect(page.getByTestId("wz-measure-missing")).toHaveCount(0);
    await page.getByTestId("wz-next").click();

    // Step 4 - price and the stock grid (one table per branch).
    await expect(page.getByTestId("wz-panel")).not.toContainText("متغيرات");
    await page.getByTestId("wz-price").fill("180");
    await page.getByTestId(`wz-branch-${branchA}`).click();
    await expect(cell(page, "OLIVE", "EU_36")).toHaveAttribute("data-state", "na");
    await expect(cell(page, "OLIVE", "EU_36")).toContainText("—");
    await expect(cell(page, "OLIVE", "EU_36").locator("input")).toHaveCount(0);
    await page.getByTestId("wz-grid-fill-value").fill("3");
    await page.getByTestId("wz-grid-fill-all").click();
    await expect(qty(page, "OLIVE", "EU_38")).toHaveValue("3");
    // Typed cells: Enter saves and goes down (brown 40 -> black 40).
    await qty(page, "BROWN", "EU_40").fill("7");
    await qty(page, "BROWN", "EU_40").press("Enter");
    await expect(qty(page, "BLACK", "EU_40")).toBeFocused();
    await qty(page, "BROWN", "EU_42").fill("5");
    await expect(cell(page, "BROWN", "EU_40")).toHaveAttribute("data-state", /saved|stored/, { timeout: 15_000 });
    await expect(cell(page, "BROWN", "EU_42")).toHaveAttribute("data-state", /saved|stored/, { timeout: 15_000 });
    await expect(page.getByTestId("wz-grid-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
    await expect(page.getByTestId("wz-grid-state")).toContainText("كل الكميات محفوظة.");
    await expect(page.getByTestId("wz-row-total-BROWN")).toHaveText("24");
    await expect(page.getByTestId("wz-col-total-EU_40")).toHaveText("13");
    await expect(page.getByTestId("wz-grid-total")).toHaveText("54");
    // Branch B: its own grid - fill all 2, then the olive row 4, the 36 column 1, black 46 emptied.
    await page.getByTestId(`wz-branch-${branchB}`).click();
    await expect(qty(page, "BROWN", "EU_40")).toHaveValue("");
    await page.getByTestId("wz-grid-fill-value").fill("2");
    await page.getByTestId("wz-grid-fill-all").click();
    await page.getByTestId("wz-grid-fill-value").fill("4");
    await page.getByTestId("wz-grid-fill-row-OLIVE").click();
    await page.getByTestId("wz-grid-fill-value").fill("1");
    await page.getByTestId("wz-grid-fill-col-EU_36").click();
    await qty(page, "BLACK", "EU_46").fill("");
    await expect(page.getByTestId("wz-grid-total")).toHaveText("36");
    await expect(page.getByTestId("wz-grid-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
    // SKU is internal and generated: no SKU field for the seller.
    await expect(page.getByTestId("wz-advanced")).toHaveCount(0);
    await expect(page.locator(".wz-sku")).toHaveCount(0);
    await page.getByTestId("wz-next").click();

    // Step 5 - review: nothing missing, «نشر» on; two actions only.
    await expect(page.getByTestId("wz-summary-versions")).toHaveText("16");
    await expect(page.getByTestId("wz-summary-stock")).toContainText("54");
    await expect(page.getByTestId("wz-summary-stock")).toContainText("36");
    await expect(page.getByTestId("wz-summary-measure")).toHaveText("6 مقاسات × 2 قياسات");
    await expect(page.getByTestId("wz-ready")).toContainText("كل شيء جاهز للنشر.", { timeout: 15_000 });
    await expect(page.getByTestId("wz-hint-MEASUREMENTS_SUGGESTED")).toHaveCount(0);
    await expect(page.getByTestId("wz-create")).toHaveCount(0);
    await expect(page.getByTestId("wz-create-publish")).toHaveCount(0);
    await expect(page.getByTestId("wz-save-later")).toHaveText("حفظ كمسودة");
    await expect(page.getByTestId("wz-publish")).toBeEnabled();
    await page.getByTestId("wz-publish").click();
    await expect(page.getByTestId("wz-panel")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator("table")).toContainText(dressTitle);

    const offer = await prisma.vendorOffer.findFirstOrThrow({
      where: { vendorId, titleAr: dressTitle },
      include: { variants: { include: { media: { orderBy: { sortOrder: "asc" } }, branchStocks: true } } },
    });
    dressId = offer.id;
    expect(offer.status).toBe("ACTIVE");
    expect(offer.titleEn).toBe("");
    expect(offer.variants).toHaveLength(16);
    const stock = (color: string, size: string, branch: string) =>
      offer.variants.find((v) => v.colorCode === color && v.sizeCode === size)!.branchStocks.find((b) => b.branchId === branch)?.quantity ?? 0;
    expect(stock("BROWN", "EU_40", branchA)).toBe(7);
    expect(stock("BROWN", "EU_42", branchA)).toBe(5);
    expect(stock("BROWN", "EU_38", branchA)).toBe(3);
    expect(stock("BROWN", "EU_40", branchB)).toBe(2);
    expect(stock("BLACK", "EU_46", branchB)).toBe(0);
    expect(stock("OLIVE", "EU_38", branchB)).toBe(4);
    expect(stock("BROWN", "EU_36", branchB)).toBe(1);
    expect(await guideVersions(offer.id)).toEqual([{ version: 1, status: "PUBLISHED", basis: "GARMENT", rows: 6, kind: "OFFER" }]);
    const draft = await prisma.offerDraft.findFirstOrThrow({ where: { offerId: offer.id } });
    const colors = (draft.payload as { colors: { key: string; images: string[] }[] }).colors;
    for (const v of offer.variants) {
      expect(v.media.map((m) => m.url)).toEqual(colors.find((c) => c.key === v.colorCode)!.images);
      expect(v.media[0].kind).toBe("PRIMARY");
    }

    // A shopper: «جدول المقاسات (سم)» on the product page, the garment's own values.
    const shopper = await page.context().browser()!.newContext();
    const sp = await shopper.newPage();
    await sp.goto(`/store/${slug}/products/${offer.id}`);
    const link = sp.locator(".pdp-size-guide-link");
    await expect(link).toHaveText("جدول المقاسات (سم)", { timeout: 30_000 });
    await link.click();
    await expect(sp.locator("#sg-title")).toHaveText("جدول المقاسات (سم)");
    await expect(sp.locator(".sg-table")).toContainText("130.5");
    await expect(sp.locator(".sg-table")).toContainText("الصدر");
    await shopper.close();
  });

  test("the storefront: «إضافة منتج» in نساء › فساتين opens with both filled; switching to رجال › قمصان clears the dress category; the list behind does not move while typing, and moves to رجال › قمصان once saved; the draft then shows as an owner-only card", async ({ page }) => {
    await open(page, `/store/${slug}`);
    await deptTab(page, "نساء").click();
    await catTab(page, "فساتين").click();
    const before = await openDrafts();
    await page.getByTestId("store-add-product").click();
    await expect(page.getByTestId("wz-panel")).toBeVisible();
    await expect(page.getByTestId("wz-context")).toHaveText("نساء › فساتين");
    await expect(page.getByRole("radio", { name: "نساء" })).toBeChecked();
    await expect(page.getByTestId("wz-category")).toHaveValue("DRESSES_WOMEN");
    expect(await openDrafts()).toBe(before);

    await page.getByRole("radio", { name: "رجال" }).check();
    await expect(page.getByTestId("wz-category")).toHaveValue("");
    await expect(page.getByTestId("wz-category").locator('option[value="DRESSES_WOMEN"]')).toHaveCount(0);
    await page.getByTestId("wz-category").selectOption("SHIRTS");
    await expect(page.getByTestId("wz-context")).toHaveText("رجال › قمصان");
    const name = `قميص كتان ${unique("m").slice(-5)}`;
    await page.getByTestId("wz-title-ar").fill(name);
    await saved(page);
    await expect(deptTab(page, "نساء")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("wz-panel-close").click();
    await expect(page.getByTestId("wz-panel")).toHaveCount(0);
    await expect(deptTab(page, "رجال")).toHaveAttribute("aria-selected", "true");
    await expect(catTab(page, "قمصان")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("store-wizard-notice")).toContainText("حُفظت المسودة في «مسوداتي».");
    const card = page.getByTestId("store-owner-card").filter({ hasText: name });
    await expect(card).toBeVisible();
    await expect(card).toContainText("مسودة");
    await expect(card).toContainText("تظهر لك وحدك");

    await deptTab(page, "الكل").click();
    await page.getByTestId("store-add-product").click();
    await expect(page.getByTestId("wz-context")).toHaveCount(0);
    await expect(page.getByTestId("wz-draft-title")).toHaveText("منتج جديد");
    await page.getByTestId("wz-panel-close").click();
    await deptTab(page, "نساء").click();
    await deptTab(page, "الكل").click();
    await page.getByTestId("store-owner-card").filter({ hasText: name }).click();
    await expect(page.getByTestId("wz-panel")).toBeVisible();
    await expect(page.getByTestId("wz-title-ar")).toHaveValue(name);
    await expect(page.getByRole("radio", { name: "رجال" })).toBeChecked();
    await expect(page.getByTestId("wz-category")).toHaveValue("SHIRTS");
  });

  test("the owner-only cards never reach the public: a visitor (and the owner outside the workspace) sees no draft or unpublished card", async ({ browser }) => {
    const visitor = await browser.newContext();
    const vp = await visitor.newPage();
    await vp.goto(`/store/${slug}`);
    await expect(vp.locator(".store-product-grid")).toBeVisible({ timeout: 30_000 });
    await expect(vp.getByTestId("store-owner-card")).toHaveCount(0);
    await expect(vp.getByTestId("store-add-product")).toHaveCount(0);
    await visitor.close();
    const outside = await browser.newContext();
    const op = await outside.newPage();
    await loginAs(op, fixtures.ownerToken);
    await op.goto(`/store/${slug}`);
    await expect(op.locator(".store-product-grid")).toBeVisible({ timeout: 30_000 });
    await expect(op.getByTestId("store-owner-card")).toHaveCount(0);
    await outside.close();
  });

  test("a grid cell whose save fails keeps its value, is marked, the grid says «تعذّر حفظ بعض الكميات», and «إعادة المحاولة» saves it", async ({ page }) => {
    const img = await anImage();
    const id = await apiDraft({
      layout: 5, step: 4, audience: "WOMEN", category: "DRESSES_WOMEN", title_ar: "عباية للتجربة",
      colors: [{ code: "BLACK", images: [img] }], size_system: "EU", sizes: { BLACK: ["EU_38", "EU_40"] },
    });
    await open(page, `/vendor/${vendorId}/offers/drafts/${id}`);
    await page.getByTestId(`wz-branch-${branchA}`).click();
    let fail = true;
    await page.route(`**/offer-drafts/${id}`, async (route) => {
      if (route.request().method() === "PATCH" && fail) {
        fail = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "down" } }) });
      } else await route.continue();
    });
    await qty(page, "BLACK", "EU_38").fill("9");
    await expect(cell(page, "BLACK", "EU_38")).toHaveAttribute("data-state", "error", { timeout: 15_000 });
    await expect(page.getByTestId("wz-grid-state")).toHaveAttribute("data-state", "error");
    await expect(page.getByTestId("wz-grid-state")).toContainText("تعذّر حفظ بعض الكميات.");
    await expect(qty(page, "BLACK", "EU_38")).toHaveValue("9");
    await expect(page.locator("body")).not.toContainText("down");
    await page.getByTestId("wz-grid-retry").click();
    await expect(cell(page, "BLACK", "EU_38")).toHaveAttribute("data-state", /saved|stored/, { timeout: 15_000 });
    await expect
      .poll(async () => ((await prisma.offerDraft.findUniqueOrThrow({ where: { id } })).payload as { stock?: Record<string, Record<string, number>> }).stock?.[branchA]?.["BLACK|EU_38"])
      .toBe(9);
  });

  /** A complete draft (one colour, one size, stock in A) with this brand choice, opened on its own page at the review. */
  async function readyDraft(page: Page, brand: object, extra: object = {}): Promise<string> {
    const img = await anImage();
    const id = await apiDraft({
      layout: 5, step: 5, audience: "WOMEN", category: "DRESSES_WOMEN",
      title_ar: `عباية ${unique("b").slice(-5)}`, brand,
      colors: [{ code: "BLACK", images: [img] }], size_system: "EU", sizes: { BLACK: ["EU_38"] },
      price: 150, stock: { [branchA]: { "BLACK|EU_38": 2 } }, ...extra,
    });
    await open(page, `/vendor/${vendorId}/offers/drafts/${id}`);
    return id;
  }
  const requestOf = async (draftId: string) =>
    prisma.brandRequest.findFirstOrThrow({ where: { draftId }, orderBy: { createdAt: "desc" } });
  const decide = (id: string, body: object) =>
    call(`/admin/brand-requests/${id}/decision`, { method: "POST", token: fixtures.adminToken, body });
  const offersTitled = (title: string) => prisma.vendorOffer.count({ where: { vendorId, titleAr: title } });

  test("a typed new brand waiting for approval: one clear item «العلامة بانتظار اعتماد الإدارة», «نشر» off, step 1 marked «!» by the server's check; «حفظ كمسودة» keeps it as a draft - nothing is created", async ({ page }) => {
    const name = `Rose Line ${unique("r").slice(-5)}`;
    const id = await readyDraft(page, { mode: "request", name });
    const missing = page.getByTestId("wz-missing");
    await expect(missing).toContainText("قبل النشر أكملي:");
    await expect(missing.locator("li")).toHaveCount(1, { timeout: 15_000 });
    await expect(missing).toContainText("العلامة بانتظار اعتماد الإدارة.");
    await expect(page.getByTestId("wz-publish")).toBeDisabled();
    // The marks follow the check: step 1 is the one with something missing.
    await expect(page.getByTestId("wz-step-1")).toHaveAttribute("data-status", "warn");
    for (const n of [2, 3, 4]) await expect(page.getByTestId(`wz-step-${n}`)).toHaveAttribute("data-status", "done");
    await page.getByTestId("wz-step-1").click();
    await expect(page.getByTestId("wz-brand-status")).toContainText("العلامة التجارية قيد المراجعة");
    await expect(page.getByTestId("wz-brand-chosen")).not.toContainText("بدون علامة");
    await page.getByTestId("wz-save-later").click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/offers/new$`));
    const d = await prisma.offerDraft.findUniqueOrThrow({ where: { id } });
    expect(d.status).toBe("OPEN");
    expect(d.offerId).toBeNull();
    expect((await requestOf(id)).status).toBe("PENDING");
  });

  test("approved: the item goes, «نشر» comes on; published once with that brand", async ({ page }) => {
    const name = `Approved Line ${unique("a").slice(-5)}`;
    const id = await readyDraft(page, { mode: "request", name });
    await expect(page.getByTestId("wz-publish")).toBeDisabled();
    expect((await decide((await requestOf(id)).id, { decision: "approve" })).status).toBe(200);
    await page.reload();
    await expect(page.getByTestId("wz-ready")).toContainText("كل شيء جاهز للنشر.", { timeout: 15_000 });
    await page.getByTestId("wz-publish").click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/offers/[0-9a-f-]{36}$`), { timeout: 30_000 });
    const offer = await prisma.vendorOffer.findUniqueOrThrow({ where: { id: page.url().split("/").pop()! }, include: { brand: true } });
    expect(offer.status).toBe("ACTIVE");
    expect(offer.brand?.name).toBe(name);
  });

  test("rejected: the list says to choose again; «بدون علامة تجارية» chosen explicitly makes it publishable", async ({ page }) => {
    const name = `Rejected Line ${unique("x").slice(-5)}`;
    const id = await readyDraft(page, { mode: "request", name });
    expect((await decide((await requestOf(id)).id, { decision: "reject", reason: "اسم مكرر لعلامة أخرى" })).status).toBe(200);
    await page.reload();
    await expect(page.getByTestId("wz-missing")).toContainText("رُفضت العلامة المطلوبة؛ اختاري علامة أخرى.", { timeout: 15_000 });
    await expect(page.getByTestId("wz-publish")).toBeDisabled();
    await page.getByTestId("wz-missing").getByRole("button", { name: "اذهبي إليه" }).first().click();
    await expect(page.getByTestId("wz-step-1")).toHaveAttribute("aria-current", "step");
    await expect(page.getByTestId("wz-brand-status")).toContainText(`رُفضت العلامة «${name}»: اسم مكرر لعلامة أخرى`);
    await page.getByTestId("wz-brand-none").click();
    await expect(page.getByTestId("wz-brand-chosen")).toContainText("بدون علامة تجارية");
    await saved(page);
    await page.getByTestId("wz-step-5").click();
    await expect(page.getByTestId("wz-ready")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("wz-publish").click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/offers/[0-9a-f-]{36}$`), { timeout: 30_000 });
    const offer = await prisma.vendorOffer.findUniqueOrThrow({ where: { id: page.url().split("/").pop()! }, include: { brand: true } });
    expect(offer.brand?.isNoBrandSentinel).toBe(true);
  });

  test("missing information is listed in Arabic before publishing, each with «اذهبي إليه» to its own step (price -> step 4) - «نشر» off, never API English; without a table a gentle «إضافة جدول القياسات تقلل الإرجاع»", async ({ page }) => {
    const id = await apiDraft({ title_ar: "ناقص", layout: 5, step: 5 });
    await open(page, `/vendor/${vendorId}/offers/drafts/${id}`);
    const box = page.getByTestId("wz-missing");
    await expect(box).toContainText("قبل النشر أكملي:");
    await expect(box).toContainText("اختاري الفئة المستهدفة.");
    await expect(box).toContainText("اختاري لوناً واحداً على الأقل.");
    await expect(box).toContainText("اكتبي السعر.");
    await expect(box).not.toContainText("بالإنجليزية");
    await expect(page.getByTestId("wz-publish")).toBeDisabled();
    await expect(page.locator("body")).not.toContainText(/Choose at least|DRAFT_|required/i);
    await box.locator('li[data-code="PRICE_REQUIRED"]').getByRole("button").click();
    await expect(page.getByTestId("wz-step-4")).toHaveAttribute("aria-current", "step");
    await expect(page.getByTestId("wz-price")).toBeVisible();

    // Complete but no table: publishable, with the gentle hint linking to step 3.
    await readyDraft(page, { mode: "none" });
    await expect(page.getByTestId("wz-ready")).toBeVisible({ timeout: 15_000 });
    const hint = page.getByTestId("wz-hint-MEASUREMENTS_SUGGESTED");
    await expect(hint).toContainText("إضافة جدول القياسات تقلل الإرجاع.");
    await expect(page.getByTestId("wz-publish")).toBeEnabled();
    await hint.getByRole("button").click();
    await expect(page.getByTestId("wz-step-3")).toHaveAttribute("aria-current", "step");
    await expect(page.getByTestId("wz-measure")).toBeVisible();
  });

  test("published once only: a double click on «نشر», and a second tab pressing it later, make ONE product - the second lands on that same product", async ({ context }) => {
    const pageA = await context.newPage();
    const id = await readyDraft(pageA, { mode: "none" });
    const title = ((await prisma.offerDraft.findUniqueOrThrow({ where: { id } })).payload as { title_ar: string }).title_ar;
    const pageB = await context.newPage();
    await open(pageB, `/vendor/${vendorId}/offers/drafts/${id}`);
    await expect(pageB.getByTestId("wz-publish")).toBeEnabled({ timeout: 15_000 });
    await expect(pageA.getByTestId("wz-publish")).toBeEnabled({ timeout: 15_000 });
    await pageA.getByTestId("wz-publish").dblclick();
    await expect(pageA).toHaveURL(new RegExp(`/vendor/${vendorId}/offers/[0-9a-f-]{36}$`), { timeout: 30_000 });
    const offerId = pageA.url().split("/").pop()!;
    await pageB.getByTestId("wz-publish").click();
    await expect(pageB).toHaveURL(new RegExp(`/vendor/${vendorId}/offers/${offerId}$`), { timeout: 30_000 });
    expect(await offersTitled(title)).toBe(1);
  });

  test("keyboard: the panel keeps focus inside and Esc closes it (nothing entered: no draft); in the grid Tab goes cell to cell (skipping «—»), Enter goes down, the arrows move in the reading direction", async ({ page }) => {
    const before = await openDrafts();
    await open(page, `/vendor/${vendorId}/offers/new`);
    const opener = page.getByTestId("wz-start-new");
    await opener.click();
    await expect(page.getByTestId("wz-panel")).toBeVisible();
    for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[data-testid='wz-panel']")))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("wz-panel")).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await openDrafts()).toBe(before);

    const img = await anImage();
    const id = await apiDraft({
      layout: 5, step: 4, audience: "WOMEN", category: "DRESSES_WOMEN", title_ar: "أسهم",
      colors: [{ code: "BLACK", images: [img] }, { code: "WHITE", images: [img] }],
      size_system: "EU", sizes: { BLACK: ["EU_38", "EU_40", "EU_42"], WHITE: ["EU_40"] },
    });
    await page.goto(`/vendor/${vendorId}/offers/drafts/${id}`);
    await page.getByTestId(`wz-branch-${branchA}`).click();
    await qty(page, "BLACK", "EU_38").focus();
    await page.keyboard.press("ArrowLeft"); // Arabic: left = next size
    await expect(qty(page, "BLACK", "EU_40")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(qty(page, "WHITE", "EU_40")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(qty(page, "BLACK", "EU_40")).toBeFocused();
    await page.keyboard.press("ArrowRight"); // back
    await expect(qty(page, "BLACK", "EU_38")).toBeFocused();
    await qty(page, "BLACK", "EU_42").focus();
    await page.keyboard.press("Tab"); // white 38 is «—»: straight to white 40
    await expect(qty(page, "WHITE", "EU_40")).toBeFocused();
    await expect(page.getByLabel(`أسود، مقاس 42، في ${branchAName}`)).toBeVisible();
  });

  test("step marks: ✓ only for a visited complete step, a quiet «!» for a visited step with something missing, a step jumped over keeps its number - the English name is never needed for ✓", async ({ page }) => {
    await openPanel(page);
    const mark = (n: number) => page.getByTestId(`wz-step-${n}`);
    await page.getByTestId("wz-step-3").click();
    await expect(mark(3)).toHaveAttribute("data-status", "current");
    await expect(mark(1)).toHaveAttribute("data-status", "warn");
    await expect(mark(1).locator(".wz-step-num")).toHaveText("!");
    await expect(mark(2)).toHaveAttribute("data-status", "todo");
    await expect(mark(2).locator(".wz-step-num")).toHaveText("2");
    await page.getByTestId("wz-step-1").click();
    await page.getByRole("radio", { name: "نساء" }).check();
    await page.getByTestId("wz-category").selectOption("DRESSES_WOMEN");
    await page.getByTestId("wz-title-ar").fill("فستان للعلامات");
    await page.getByTestId("wz-brand-none").click();
    await page.getByTestId("wz-step-2").click();
    await expect(mark(1)).toHaveAttribute("data-status", "done");
    await expect(mark(1).locator(".wz-step-num")).toHaveText("✓");
    await page.getByTestId("wz-step-5").click();
    await expect(mark(2)).toHaveAttribute("data-status", "warn");
    await expect(mark(4)).toHaveAttribute("data-status", "todo");
    await expect(page.getByTestId("wz-missing")).toContainText("اختاري لوناً واحداً على الأقل.");
  });

  test("older drafts open at the right step of the five: a four-step draft at its review -> 5, its sizes-and-stock step -> 3; a three-step (phase A) draft at its review -> 5; moving saves the new numbering", async ({ page }) => {
    const img = await anImage();
    const old4 = await apiDraft({ step: 4, title_ar: "قديمة ٤", colors: [{ code: "BLACK", images: [img] }], sizes: { BLACK: ["EU_38"] }, default_stock: { [branchA]: 2 } });
    const old3 = await apiDraft({ step: 3, title_ar: "قديمة ٣", colors: [{ code: "BLACK", images: [img] }], sizes: { BLACK: ["EU_38"] }, default_stock: { [branchA]: 2 } });
    const phaseA = await apiDraft({ step: 3, title_ar: "المرحلة أ", size_system: "EU", colors: [{ code: "BLACK", images: [img] }], sizes: { BLACK: ["EU_38"] }, stock: { [branchA]: { "BLACK|EU_38": 1 } } });
    await open(page, `/vendor/${vendorId}/offers/drafts/${old4}`);
    await expect(page.getByTestId("wz-step-5")).toHaveAttribute("aria-current", "step");
    await page.goto(`/vendor/${vendorId}/offers/drafts/${old3}`);
    await expect(page.getByTestId("wz-step-3")).toHaveAttribute("aria-current", "step");
    await page.goto(`/vendor/${vendorId}/offers/drafts/${phaseA}`);
    await expect(page.getByTestId("wz-step-5")).toHaveAttribute("aria-current", "step");
    await page.getByTestId("wz-step-4").click();
    await expect
      .poll(async () => (await prisma.offerDraft.findUniqueOrThrow({ where: { id: phaseA } })).payload)
      .toMatchObject({ layout: 5, step: 4 });
    // «مسوداتي» says the same step.
    await page.goto(`/vendor/${vendorId}/offers/new`);
    await expect(page.getByTestId("wz-draft-item").filter({ hasText: "قديمة ٤" })).toContainText("الخطوة 5 من 5");
  });

  test("one «مسوداتي»: open drafts and products created but not published (from the classic form too) together; such a product opens its own page, where the same check lists what is missing and the size table is added and edited (a new version each time) before publishing", async ({ page }) => {
    // A product created but not published, with sizes and stock (the API's create step), and one from the classic form.
    const img = await anImage();
    const draftId = await apiDraft({
      layout: 5, step: 5, audience: "WOMEN", category: "DRESSES_WOMEN", title_ar: `غير منشور ${unique("u").slice(-5)}`,
      brand: { mode: "none" }, colors: [{ code: "BLACK", images: [img] }], size_system: "LETTER", sizes: { BLACK: ["S", "M"] },
      price: 99, stock: { [branchA]: { "BLACK|S": 1, "BLACK|M": 1 } },
    });
    const d = await prisma.offerDraft.findUniqueOrThrow({ where: { id: draftId } });
    const created = await call<{ offer_id: string }>(`/vendors/${vendorId}/offer-drafts/${draftId}/submit`, { method: "POST", token: fixtures.ownerToken, body: { expected_revision: d.revision } });
    expect(created.status).toBe(201);
    const unpublishedTitle = (d.payload as { title_ar: string }).title_ar;
    const classicTitle = `من النموذج ${unique("k").slice(-5)}`;
    const classic = await call<{ id: string; title_en: string }>(`/vendors/${vendorId}/offers`, {
      method: "POST", token: fixtures.ownerToken, idempotencyKey: unique("classic"), body: { title_ar: classicTitle, audiences: ["WOMEN"], categories: ["TOPS"] },
    });
    expect(classic.status).toBe(201);
    expect(classic.body.title_en).toBe("");

    await open(page, `/vendor/${vendorId}/offers/new`);
    await expect(page.getByTestId("wz-unpublished-offer").filter({ hasText: unpublishedTitle })).toContainText("منتج غير منشور");
    await expect(page.getByTestId("wz-unpublished-offer").filter({ hasText: classicTitle })).toBeVisible();
    // The wizard's «مسوداتي» lists them too.
    await page.getByTestId("wz-start-new").click();
    await page.getByTestId("wz-panel-drafts").click();
    await expect(page.getByTestId("wz-panel-drafts-list").locator('li[data-kind="offer"]').filter({ hasText: classicTitle })).toBeVisible();
    await page.getByTestId("wz-panel-drafts-list").locator('li[data-kind="offer"]').filter({ hasText: classicTitle }).getByTestId("wz-drafts-item-offer").click();
    await expect(page).toHaveURL(new RegExp(`/vendor/${vendorId}/offers/${classic.body.id}$`));
    // Nothing to sell yet: the same reasons the status change gives; «نشر» off; no size table (no sizes).
    await expect(page.getByTestId("offer-publish-missing")).toContainText("الصورة الرئيسية");
    await expect(page.getByTestId("offer-publish-missing")).toContainText("كمية متاحة في فرع واحد على الأقل");
    await expect(page.getByTestId("offer-publish")).toBeDisabled();
    await expect(page.getByTestId("owner-measure")).toHaveCount(0);

    // The product with sizes: ready; the table added, then the product published, then the table edited.
    await page.goto(`/vendor/${vendorId}/offers/${created.body.offer_id}`);
    await expect(page.getByTestId("offer-publish-ready")).toBeVisible();
    await expect(page.getByTestId("owner-measure")).toContainText("جدول القياسات (سم)");
    // A partial table: chest, waist and length only - no hip cell exists to fill.
    await expect(page.getByTestId("owner-measure-choose")).toBeVisible();
    for (const k of ["CHEST", "WAIST", "LENGTH"]) await page.getByTestId(`owner-measure-key-${k}`).click();
    await expect(page.getByTestId("owner-measure-S-HIP")).toHaveCount(0);
    for (const [s, v] of [["S", 86], ["M", 90]] as const) {
      await page.getByTestId(`owner-measure-${s}-CHEST`).fill(String(v));
      await page.getByTestId(`owner-measure-${s}-WAIST`).fill(String(v - 20));
      await page.getByTestId(`owner-measure-${s}-LENGTH`).fill("120");
    }
    await page.getByTestId("owner-measure-save").click();
    await expect(page.getByTestId("owner-measure-version")).toHaveText("المنشور الآن: الإصدار 1");
    await page.getByTestId("offer-publish").click();
    await expect(page.locator(".badge-active")).toHaveText("منشور");
    // Published: its content (the size table too) changes through «تعديل المنتج» -
    // the page shows that, not the direct table editor; applying makes version 2.
    await expect(page.getByTestId("offer-edit-banner")).toBeVisible();
    await expect(page.getByTestId("owner-measure")).toHaveCount(0);
    const edit = await call<{ id: string; revision: number; payload: { measurements: { keys: string[]; values: Record<string, Record<string, number>> } } }>(
      `/vendors/${vendorId}/offer-drafts/edit-of/${created.body.offer_id}`, { method: "POST", token: fixtures.ownerToken });
    expect(edit.status).toBe(201);
    const m = edit.body.payload.measurements;
    const savedEdit = await call<{ revision: number }>(`/vendors/${vendorId}/offer-drafts/${edit.body.id}`, {
      method: "PATCH", token: fixtures.ownerToken,
      body: { expected_revision: edit.body.revision, payload: { ...edit.body.payload, measurements: { ...m, values: { ...m.values, M: { ...m.values.M, CHEST: 91 } } } } },
    });
    expect(savedEdit.status).toBe(200);
    expect((await call(`/vendors/${vendorId}/offer-drafts/${edit.body.id}/apply`, { method: "POST", token: fixtures.ownerToken, body: { expected_revision: savedEdit.body.revision } })).status).toBe(200);
    expect((await guideVersions(created.body.offer_id)).map((v) => [v.version, v.status])).toEqual([[1, "RETIRED"], [2, "PUBLISHED"]]);
  });

  test("phone: the five steps show the current one's name and the others' numbers; the stock grid scrolls sideways inside itself with the colour column staying in view - the page never scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, `/store/${slug}`);
    await deptTab(page, "نساء").click();
    await catTab(page, "فساتين").click();
    await page.getByTestId("store-add-product").click();
    await expect(page.getByTestId("wz-panel")).toBeVisible();
    const chip = await page.getByTestId("wz-context").boundingBox();
    const change = await page.getByTestId("wz-context-change").boundingBox();
    expect(Math.abs(chip!.y + chip!.height / 2 - (change!.y + change!.height / 2))).toBeLessThan(4);
    await expect(page.getByTestId("wz-step-1").locator(".wz-step-label")).toBeVisible();
    for (const n of [2, 3, 4, 5]) await expect(page.getByTestId(`wz-step-${n}`).locator(".wz-step-label")).toBeHidden();
    await expectNoHorizontalOverflow(page);
    await page.getByTestId("wz-panel-close").click();

    const img = await anImage();
    const id = await apiDraft({
      layout: 5, step: 4, audience: "WOMEN", category: "DRESSES_WOMEN", title_ar: "شبكة الهاتف",
      colors: [{ code: "BLACK", images: [img] }, { code: "WHITE", images: [img] }], size_system: "EU", sizes: { BLACK: SIZES, WHITE: SIZES },
    });
    await page.goto(`/vendor/${vendorId}/offers/drafts/${id}`);
    await expect(page.getByTestId("wz-step-4").locator(".wz-step-label")).toBeVisible();
    const wrap = page.getByTestId("wz-grid-wrap");
    await expect(wrap).toBeVisible();
    expect(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const colour = page.getByTestId("wz-grid-row-BLACK").locator("th");
    const before = await colour.boundingBox();
    await wrap.evaluate((el) => el.scrollBy({ left: -2000 }));
    await wrap.evaluate((el) => el.scrollBy({ left: 2000 }));
    await qty(page, "BLACK", "EU_46").scrollIntoViewIfNeeded();
    const after = await colour.boundingBox();
    expect(Math.abs(after!.x - before!.x)).toBeLessThan(2);
    await expectNoHorizontalOverflow(page);
  });

  test("English: the English name is marked optional; a product without one shows its Arabic name on the English product page; the panel fills a phone left-to-right", async ({ page }) => {
    const owner = (await call<{ id: string }>("/customers/me", { token: fixtures.ownerToken })).body;
    await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "en" } });
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript(() => localStorage.setItem("finalpro_lang_pref", "en"));
      await openPanel(page);
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
      // Measured once the 200ms opening (a slight scale) has finished.
      await expect.poll(async () => Math.round((await page.getByTestId("wz-panel").boundingBox())!.width)).toBe(390);
      await expect(page.getByRole("heading", { level: 2, name: "Details" })).toBeVisible();
      await expect(page.locator("label").filter({ hasText: "Product name in English" })).toContainText(/optional/i);
      await page.getByRole("radio", { name: "Women" }).check();
      await expect(page.getByTestId("wz-category").locator('option[value="DRESSES_WOMEN"]')).toHaveCount(1);
      await page.getByRole("radio", { name: "Kids" }).check();
      await expect(page.getByTestId("wz-category").locator('option[value="DRESSES_WOMEN"]')).toHaveCount(0);
      await expectNoHorizontalOverflow(page);

      expect(dressId).not.toBe("");
      await page.goto(`/store/${slug}/products/${dressId}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(dressTitle, { timeout: 30_000 });
      await expect(page.locator(".pdp-size-guide-link")).toHaveText("Size table (cm)");
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { languagePref: "ar" } });
    }
  });
});
