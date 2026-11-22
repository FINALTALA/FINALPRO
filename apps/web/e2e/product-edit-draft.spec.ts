import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// Edit drafts: a published product is changed in the same wizard, on one
// shared draft («تعديل: اسم المنتج»). Shoppers see nothing until «تطبيق
// التعديلات»; existing colours / sizes / stock are locked; «مراجعة التعديلات»
// lists the changes by group; a change made elsewhere meanwhile is a
// conflict the seller resolves explicitly. Edit-draft columns and the
// APPLIED status are read in SQL: this suite's Prisma client predates them.

const API_BASE = process.env.PW_API_BASE_URL;
const FIX = (name: string) => path.join(__dirname, "fixtures", name);

test.describe("Edit drafts of a published product", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let slug = "";
  let branchA = "";
  let sandImg = "";

  test.beforeAll(async () => {
    ({ vendorId, branchId: branchA } = await createVendorWithBranch(fixtures.ownerToken));
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    const catalogue = await call(`/vendors/${vendorId}/storefront/catalogue`, {
      method: "PUT",
      token: fixtures.ownerToken,
      body: { departments: ["WOMEN"], categories: { WOMEN: ["DRESSES_WOMEN"] } },
    });
    if (catalogue.status !== 200) throw new Error(`storefront departments not set (${catalogue.status})`);
    sandImg = await uploadFile(FIX("tb25/red-1.png"));
  });

  async function uploadFile(file: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(file)], { type: "image/png" }), path.basename(file));
    const res = await fetch(`${API_BASE}/vendors/${vendorId}/uploads`, { method: "POST", headers: { Authorization: `Bearer ${fixtures.ownerToken}` }, body: form });
    const body = (await res.json()) as { url?: string };
    if (res.status !== 201 || !body.url) throw new Error(`upload failed (${res.status})`);
    return body.url;
  }
  async function open(page: Page, url: string) {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(url);
  }
  /** A published dress: one beige (S, M), price 200, stock in branch A. */
  async function published(title: string): Promise<string> {
    const d = await call<{ id: string; revision: number }>(`/vendors/${vendorId}/offer-drafts`, {
      method: "POST",
      token: fixtures.ownerToken,
      body: {
        payload: {
          layout: 5,
          step: 5,
          audience: "WOMEN",
          category: "DRESSES_WOMEN",
          title_ar: title,
          brand: { mode: "none" },
          specs: { material: "شيفون" },
          colors: [{ key: "BEIGE", family: "BEIGE", name_ar: "بيج رملي", images: [sandImg] }],
          size_system: "LETTER",
          sizes: { BEIGE: ["S", "M"] },
          price: 200,
          measurements: { keys: ["CHEST"], values: { S: { CHEST: 86 }, M: { CHEST: 90 } } },
          stock: { [branchA]: { "BEIGE|S": 3, "BEIGE|M": 2 } },
          description_ar: "الوصف الأول",
        },
      },
    });
    if (d.status !== 201) throw new Error(`draft not created (${d.status})`);
    const p = await call<{ offer_id: string }>(`/vendors/${vendorId}/offer-drafts/${d.body.id}/publish`, {
      method: "POST",
      token: fixtures.ownerToken,
      body: { expected_revision: d.body.revision },
    });
    if (p.status !== 201) throw new Error(`not published (${p.status})`);
    return p.body.offer_id;
  }
  const offerRow = async (offerId: string) =>
    (
      await prisma.$queryRaw<{ titleAr: string; price: string; status: string }[]>`
      SELECT o."titleAr", (SELECT v."basePrice"::text FROM offer_variants v WHERE v."vendorOfferId" = o.id LIMIT 1) AS price, o.status::text AS status
      FROM vendor_offers o WHERE o.id = ${offerId}`
    )[0];
  const editDraftOf = async (offerId: string) =>
    (
      await prisma.$queryRaw<{ id: string; status: string; revision: number }[]>`
      SELECT id, status::text AS status, revision FROM offer_drafts WHERE "editOfOfferId" = ${offerId} ORDER BY "createdAt" DESC LIMIT 1`
    )[0] ?? null;
  const saved = (page: Page) => expect(page.getByTestId("wz-save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });

  test("«تعديل المنتج» from the products list: the same wizard titled «تعديل: …», locked audience / category / colour / sizes / existing stock, a review by group, and shoppers see the change only after «تطبيق التعديلات»", async ({ page }) => {
    const title = `فستان للتعديل ${unique("e").slice(-5)}`;
    const offerId = await published(title);
    await open(page, `/vendor/${vendorId}/offers`);
    await page.getByTestId(`offer-edit-${offerId}`).click();
    await expect(page.getByTestId("wz-panel")).toBeVisible();
    await expect(page.getByTestId("wz-draft-title")).toHaveText(`تعديل: ${title}`);
    await expect(page.getByTestId("wz-edit-strip")).toContainText("التعديلات لا تظهر للمتسوقات حتى تطبّقيها");
    await expect(page.getByTestId("wz-context-change")).toHaveCount(0);

    // step 1: audience and category locked, with the way to change them
    await page.getByTestId("wz-step-1").click();
    await expect(page.getByTestId("wz-audience").locator("input").first()).toBeDisabled();
    await expect(page.getByTestId("wz-category")).toBeDisabled();
    await expect(page.getByTestId("wz-edit-locked-context")).toBeVisible();
    await expect(page.getByTestId("wz-edit-copy-new")).toBeVisible();
    await page.getByTestId("wz-title-ar").fill(`${title} الجديد`);
    await saved(page);

    // step 2: the existing colour is never removed; its family is locked
    await page.getByTestId("wz-step-2").click();
    await expect(page.getByTestId("wz-color-remove-BEIGE")).toHaveCount(0);
    await expect(page.getByTestId("wz-color-family-BEIGE")).toBeDisabled();

    // step 3: the size system is locked; an existing size is never removed
    await page.getByTestId("wz-step-3").click();
    await expect(page.getByTestId("wz-size-system").locator("input").first()).toBeDisabled();
    await expect(page.getByTestId("wz-size-BEIGE-S")).toBeDisabled();

    // step 4: existing stock is on the stock screen; no SKU field anywhere
    await page.getByTestId("wz-step-4").click();
    await expect(page.getByTestId("wz-cell-BEIGE-S")).toHaveAttribute("data-state", "existing");
    await expect(page.getByTestId("wz-qty-BEIGE-S")).toHaveCount(0);
    await expect(page.getByTestId("wz-copystock")).toHaveCount(0);
    await expect(page.locator(".wz-sku")).toHaveCount(0);
    await page.getByTestId("wz-price").fill("150");
    await saved(page);

    // the public page is unchanged while editing
    expect(await offerRow(offerId)).toMatchObject({ titleAr: title, price: "200.00" });

    // step 5: «مراجعة التعديلات», group by group
    await page.getByTestId("wz-step-5").click();
    await expect(page.getByTestId("wz-step-5")).toContainText("مراجعة التعديلات");
    await expect(page.getByTestId("wz-edit-line-title")).toHaveText("الاسم: تغيّر");
    await expect(page.getByTestId("wz-edit-line-price")).toHaveText("السعر: 200 ← 150");
    await expect(page.getByTestId("wz-publish")).toHaveCount(0);
    await expect(page.getByTestId("wz-save-later")).toHaveText("حفظ والعودة لاحقاً");
    await expect(page.getByTestId("wz-edit-discard")).toHaveText("تجاهل التعديلات");
    const apply = page.getByTestId("wz-edit-apply");
    await expect(apply).toHaveText("تطبيق التعديلات");
    await expect(apply).toBeEnabled({ timeout: 15_000 });
    await apply.click();
    await expect(page.getByTestId("wz-panel")).toHaveCount(0);
    expect(await offerRow(offerId)).toMatchObject({ titleAr: `${title} الجديد`, price: "150.00", status: "ACTIVE" });
    expect((await editDraftOf(offerId))?.status).toBe("APPLIED");
    await page.goto(`/store/${slug}/products/${offerId}`);
    await expect(page.getByText(`${title} الجديد`).first()).toBeVisible();
  });

  test("a change made elsewhere meanwhile is a conflict: no silent merge - the group changed in both needs a choice, «تحديث المسودة» rebases, then the edit applies", async ({ page }) => {
    const title = `فستان تعارض ${unique("c").slice(-5)}`;
    const offerId = await published(title);
    const d = await call<{ id: string; revision: number; payload: Record<string, unknown> }>(`/vendors/${vendorId}/offer-drafts/edit-of/${offerId}`, { method: "POST", token: fixtures.ownerToken });
    expect(d.status).toBe(201);
    const s = await call(`/vendors/${vendorId}/offer-drafts/${d.body.id}`, {
      method: "PATCH",
      token: fixtures.ownerToken,
      body: { expected_revision: d.body.revision, payload: { ...d.body.payload, step: 5, price: 180 } },
    });
    expect(s.status).toBe(200);
    // the quick price screen, meanwhile
    expect((await call(`/vendors/${vendorId}/offers/${offerId}/price`, { method: "PUT", token: fixtures.ownerToken, body: { base_price: 210 } })).status).toBe(200);

    await open(page, `/vendor/${vendorId}/offers/drafts/${d.body.id}`);
    await expect(page.getByTestId("wz-edit-conflict")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("wz-edit-conflict-price")).toHaveAttribute("data-kind", "both");
    await expect(page.getByTestId("wz-edit-apply")).toBeDisabled();
    await expect(page.getByTestId("wz-edit-rebase")).toBeDisabled();
    await page.getByTestId("wz-edit-choice-price-mine").check();
    await page.getByTestId("wz-edit-rebase").click();
    await expect(page.getByTestId("wz-edit-conflict")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("wz-edit-line-price")).toHaveText("السعر: 210 ← 180");
    await expect(page.getByTestId("wz-edit-apply")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("wz-edit-apply").click();
    await expect.poll(async () => (await offerRow(offerId)).price, { timeout: 15_000 }).toBe("180.00");
  });

  test("the product page: published content is read-only there, with «تعديل المنتج»; «تجاهل التعديلات» leaves the product as it was; an unclassified product says to classify it first", async ({ page }) => {
    const title = `فستان صفحة ${unique("p").slice(-5)}`;
    const offerId = await published(title);
    await open(page, `/vendor/${vendorId}/offers/${offerId}`);
    await expect(page.getByTestId("offer-edit-banner")).toBeVisible();
    await expect(page.getByTestId("offer-title-en")).toBeDisabled();
    await expect(page.getByRole("link", { name: "+ إضافة متغيّر" })).toHaveCount(0);
    await page.getByTestId(`offer-edit-${offerId}`).click();
    await expect(page.getByTestId("wz-draft-title")).toHaveText(`تعديل: ${title}`);
    await page.getByTestId("wz-step-1").click();
    await page.getByTestId("wz-title-ar").fill("اسم لن يُطبَّق");
    await saved(page);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("wz-edit-discard").click();
    await expect(page.getByTestId("wz-panel")).toHaveCount(0);
    expect((await editDraftOf(offerId))?.status).toBe("DISCARDED");
    expect((await offerRow(offerId)).titleAr).toBe(title);

    // an older, unclassified product: no wizard, the reason instead
    const legacy = await prisma.vendorOffer.create({
      data: { vendorId, titleAr: `قديم ${unique("l").slice(-5)}`, titleEn: "", status: "ACTIVE", firstPublishedAt: new Date() },
    });
    await page.goto(`/vendor/${vendorId}/offers`);
    await expect(page.getByTestId(`offer-edit-classify-${legacy.id}`)).toHaveText("صنّفي المنتج أولاً لاستخدام معالج التعديل");
    await expect(page.getByTestId(`offer-edit-${legacy.id}`)).toHaveCount(0);
  });

  test("on a phone: the edit wizard fits (no sideways scroll), the strip and the review stay readable", async ({ page }) => {
    const offerId = await published(`فستان هاتف ${unique("m").slice(-5)}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, `/vendor/${vendorId}/offers`);
    await page.getByTestId(`offer-edit-${offerId}`).click();
    await expect(page.getByTestId("wz-edit-strip")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByTestId("wz-step-4").click();
    await page.getByTestId("wz-price").fill("170");
    await saved(page);
    await page.getByTestId("wz-step-5").click();
    await expect(page.getByTestId("wz-edit-line-price")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
