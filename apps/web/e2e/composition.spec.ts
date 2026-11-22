import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { call, createVendorWithBranch, unique } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// Fabric composition and country of origin (2026-11-19): entered in the
// wizard's details step («مكوّنات القماش وبلد المنشأ (اختياري)» - a part,
// its fibres and percents, a live total, «100% من ليف واحد», the country),
// then shown to the shopper near the material and care - the draft preview
// shows exactly the same - and on the owner's details page. No SKU on the
// shopper's page.

const sharp = createRequire(__filename)("sharp") as (input: object) => { jpeg(): { toBuffer(): Promise<Buffer> } };

test.describe("Fabric composition and country of origin", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let slug = "";
  let draftId = "";
  let previewText = "";

  test.beforeAll(async () => {
    const created = await createVendorWithBranch(fixtures.ownerToken);
    vendorId = created.vendorId;
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    await call(`/vendors/${vendorId}/storefront/catalogue`, {
      method: "PUT",
      token: fixtures.ownerToken,
      body: { departments: ["WOMEN"], categories: { WOMEN: ["DRESSES_WOMEN"] } },
    });
    const jpeg = await sharp({ create: { width: 60, height: 80, channels: 3, background: { r: 180, g: 150, b: 120 } } }).jpeg().toBuffer();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "dress.jpg");
    const up = await fetch(`${process.env.PW_API_BASE_URL}/vendors/${vendorId}/uploads`, { method: "POST", headers: { Authorization: `Bearer ${fixtures.ownerToken}` }, body: form });
    const image = ((await up.json()) as { url: string }).url;
    const draft = await call<{ id: string }>(`/vendors/${vendorId}/offer-drafts`, {
      method: "POST",
      token: fixtures.ownerToken,
      body: {
        payload: {
          layout: 5,
          step: 1,
          audience: "WOMEN",
          category: "DRESSES_WOMEN",
          title_ar: `فستان تركيب ${unique("c").slice(-6)}`,
          brand: { mode: "none" },
          specs: { material: "قطن" },
          colors: [{ key: "BEIGE", family: "BEIGE", name_ar: "بيج", images: [image] }],
          size_system: "LETTER",
          sizes: { BEIGE: ["S", "M"] },
          price: 150,
          stock: { [created.branchId]: { "BEIGE|S": 2, "BEIGE|M": 3 } },
        },
      },
    });
    expect(draft.status).toBe(201);
    draftId = draft.body.id;
  });

  test("the details step: a part, its fibres and percents with a live total, «100% من ليف واحد», the country - saved with the draft", async ({ page }) => {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers/drafts/${draftId}`);
    const section = page.getByTestId("wz-composition");
    await expect(section).toContainText("مكوّنات القماش وبلد المنشأ");
    await expect(section).toContainText("اختياري");
    // the shell: 95% cotton + 5% elastane, the total says what is missing until 100
    await section.getByTestId("wz-comp-add-SHELL").click();
    await section.getByTestId("wz-comp-SHELL-percent-0").fill("95");
    await expect(section.getByTestId("wz-comp-total-SHELL")).toHaveText("المجموع 95% — ينقص 5%");
    await section.getByTestId("wz-comp-SHELL-add").click();
    await section.getByTestId("wz-comp-SHELL-fiber-1").selectOption("ELASTANE");
    await section.getByTestId("wz-comp-SHELL-percent-1").fill("5");
    await expect(section.getByTestId("wz-comp-total-SHELL")).toHaveText("✓ المجموع 100%");
    // the lining: one fibre, 100% in one click
    await section.getByTestId("wz-comp-add-LINING").click();
    await section.getByTestId("wz-comp-LINING-fiber-0").selectOption("POLYESTER");
    await section.getByTestId("wz-comp-LINING-single").click();
    await expect(section.getByTestId("wz-comp-LINING-percent-0")).toHaveValue("100");
    await section.getByTestId("wz-comp-country").selectOption("TR");
    // the material spec is untouched
    await expect(page.getByTestId("wz-spec-material")).toHaveCount(1);
    await expect
      .poll(async () => (await prisma.offerDraft.findUniqueOrThrow({ where: { id: draftId } })).payload as Record<string, unknown>, { timeout: 15_000 })
      .toMatchObject({
        country_of_origin: "TR",
        composition: {
          parts: [
            { part: "SHELL", fibers: [{ fiber: "COTTON", percent: 95 }, { fiber: "ELASTANE", percent: 5 }] },
            { part: "LINING", fibers: [{ fiber: "POLYESTER", percent: 100 }] },
          ],
        },
        specs: { material: "قطن" },
      });
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
  });

  test("the preview shows it exactly as the published page then does - near the material, «95% قطن، 5% إيلاستين», the lining, «تركيا»; the owner's details page too; no SKU for the shopper", async ({ page }) => {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers/drafts/${draftId}/preview`);
    // in «الوصف» (folded like on the published page)
    await page.getByRole("button", { name: /^الوصف/ }).click();
    const pv = page.getByTestId("composition-view");
    await expect(pv).toBeVisible();
    previewText = (await pv.innerText()).replace(/\s+/g, " ").trim();
    expect(previewText).toContain("95% قطن، 5% إيلاستين");
    expect(previewText).toContain("100% بوليستر");
    expect(previewText).toContain("تركيا");

    const current = await prisma.offerDraft.findUniqueOrThrow({ where: { id: draftId } });
    const published = await call<{ offer_id: string }>(`/vendors/${vendorId}/offer-drafts/${draftId}/publish`, {
      method: "POST",
      token: fixtures.ownerToken,
      body: { expected_revision: current.revision },
    });
    expect(published.status).toBe(201);

    // the owner's details page
    await page.goto(`/vendor/${vendorId}/offers/${published.body.offer_id}/details`);
    await expect(page.getByTestId("details-about").getByTestId("composition-view")).toContainText("95% قطن، 5% إيلاستين");

    // the shopper's page: the same view, in «الوصف» right after the specifications (the material first)
    await loginAs(page, fixtures.customerAToken);
    await page.goto(`/store/${slug}/products/${published.body.offer_id}`);
    await page.getByRole("button", { name: /^الوصف/ }).click();
    const live = page.getByTestId("composition-view");
    await expect(live).toBeVisible();
    expect((await live.innerText()).replace(/\s+/g, " ").trim()).toBe(previewText);
    await expect(page.getByTestId("pdp-spec-material")).toHaveText("قطن");
    const order = await page.evaluate(() => {
      const spec = document.querySelector('[data-testid="pdp-spec-material"]');
      const view = document.querySelector('[data-testid="composition-view"]');
      return spec && view ? spec.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
    });
    expect(order).toBeTruthy();
    // «95%» never flips: each percent is isolated
    await expect(live.locator("bdi").first()).toHaveText("95%");
    await expect(page.locator(".pdp-sku")).toHaveCount(0);
    await expect(page.getByText(/SKU/)).toHaveCount(0);

    // in English, left to right
    await page.getByRole("button", { name: "التبديل إلى الإنجليزية" }).click();
    await expect(live).toContainText("95% Cotton, 5% Elastane");
    await expect(live).toContainText("100% Polyester");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });
});
