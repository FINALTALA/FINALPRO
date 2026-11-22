import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// Product colours: a product's own named colours - a free Arabic name
// (unique in the product), an optional English one, a family for filters
// (it may repeat: two beiges), an optional HEX / fabric swatch, the
// seller's order (the first is the default). The wizard adds a colour from
// its family and names it; a repeated name is held with a message, never
// sent; the shopper sees each shade by name, and the cart says which one.
// New tables are read in SQL: this suite's Prisma client predates them.

const API_BASE = process.env.PW_API_BASE_URL;
const FIX = (name: string) => path.join(__dirname, "fixtures", name);

test.describe("Product colours", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let slug = "";
  let branchA = "";
  let sandImg = "";
  let darkImg = "";
  let offerId = "";

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
    darkImg = await uploadFile(FIX("tb25/blue-1.png"));
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
  async function apiDraft(payload: object): Promise<string> {
    const r = await call<{ id: string }>(`/vendors/${vendorId}/offer-drafts`, { method: "POST", token: fixtures.ownerToken, body: { payload } });
    if (r.status !== 201) throw new Error(`draft not created (${r.status})`);
    return r.body.id;
  }
  const colorsOf = async (id: string) =>
    ((await prisma.offerDraft.findUniqueOrThrow({ where: { id } })).payload as { colors?: { key: string; family: string; name_ar: string; name_en?: string; hex?: string }[] }).colors ?? [];
  const saved = (page: Page) => expect(page.getByTestId("wz-save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });

  test("the wizard: a family adds a named colour; a second beige is its own shade; a repeated name is held with a message and never sent; HEX and order are the seller's", async ({ page }) => {
    const id = await apiDraft({ layout: 5, step: 2, audience: "WOMEN", category: "DRESSES_WOMEN", title_ar: `فستان ${unique("c").slice(-5)}`, brand: { mode: "none" } });
    await open(page, `/vendor/${vendorId}/offers/drafts/${id}`);
    await page.getByTestId("wz-color-BEIGE").click();
    await page.getByTestId("wz-color-BEIGE").click();
    await expect(page.getByTestId("wz-color-name-BEIGE")).toHaveValue("بيج");
    await expect(page.getByTestId("wz-color-name-BEIGE-2")).toHaveValue("بيج 2");
    await page.getByTestId("wz-color-name-BEIGE").fill("بيج رملي");
    await page.getByTestId("wz-color-name-BEIGE-2").fill("بيج غامق");
    await expect
      .poll(async () => (await colorsOf(id)).map((c) => [c.key, c.family, c.name_ar]), { timeout: 15_000 })
      .toEqual([
        ["BEIGE", "BEIGE", "بيج رملي"],
        ["BEIGE-2", "BEIGE", "بيج غامق"],
      ]);
    // A repeated name (after normalisation): held here, said, never saved.
    await page.getByTestId("wz-color-name-BEIGE-2").fill("  بيج   رملى ");
    await expect(page.getByTestId("wz-color-name-error-BEIGE-2")).toContainText("مستخدم للون آخر");
    await expect(page.getByTestId("wz-color-name-BEIGE-2")).toHaveAttribute("aria-invalid", "true");
    // nothing was sent: the draft still has the last accepted name
    await saved(page);
    expect((await colorsOf(id))[1].name_ar).toBe("بيج غامق");
    await page.getByTestId("wz-color-name-BEIGE-2").fill("بيج قهوة");
    await expect(page.getByTestId("wz-color-name-error-BEIGE-2")).toHaveCount(0);
    // HEX, an English name, and the order: the second shade becomes the default.
    await page.getByTestId("wz-color-hex-BEIGE").fill("#d8c3a0");
    await page.getByTestId("wz-color-name-en-BEIGE").fill("Sand beige");
    await page.getByTestId("wz-color-up-BEIGE-2").click();
    await expect
      .poll(async () => (await colorsOf(id)).map((c) => [c.key, c.name_ar, c.name_en ?? null, c.hex ?? null]), { timeout: 15_000 })
      .toEqual([
        ["BEIGE-2", "بيج قهوة", null, null],
        ["BEIGE", "بيج رملي", "Sand beige", "#d8c3a0"],
      ]);
    await expect(page.getByTestId("wz-images-BEIGE-2")).toContainText("اللون الافتراضي");
    // Removing a colour takes its sizes with it.
    await page.getByTestId("wz-color-remove-BEIGE-2").click();
    await expect.poll(async () => (await colorsOf(id)).map((c) => c.key), { timeout: 15_000 }).toEqual(["BEIGE"]);
  });

  test("the shopper: two beiges by name in the seller's order; choosing one shows its images; a HEX colour is a circle; the English page shows the Arabic name when there is no English one", async ({ browser }) => {
    const payload = {
      layout: 5, step: 5, audience: "WOMEN", category: "DRESSES_WOMEN", title_ar: `فستان بدرجتين ${unique("s").slice(-5)}`, brand: { mode: "none" },
      colors: [
        { key: "BEIGE", family: "BEIGE", name_ar: "بيج رملي", name_en: "Sand beige", hex: "#d8c3a0", images: [sandImg] },
        { key: "BEIGE-2", family: "BEIGE", name_ar: "بيج غامق", images: [darkImg] },
      ],
      size_system: "LETTER", sizes: { BEIGE: ["S", "M"], "BEIGE-2": ["S", "M"] }, price: 120,
      stock: { [branchA]: { "BEIGE|S": 2, "BEIGE|M": 1, "BEIGE-2|S": 3, "BEIGE-2|M": 1 } },
    };
    const id = await apiDraft(payload);
    const cur = await prisma.offerDraft.findUniqueOrThrow({ where: { id } });
    const pub = await call<{ offer_id: string }>(`/vendors/${vendorId}/offer-drafts/${id}/publish`, { method: "POST", token: fixtures.ownerToken, body: { expected_revision: cur.revision } });
    expect(pub.status).toBe(201);
    offerId = pub.body.offer_id;
    for (const lang of ["ar", "en"] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
      const page = await ctx.newPage();
      await page.goto(`/store/${slug}/products/${offerId}`);
      const buttons = page.locator(".pdp-color-thumb");
      await expect(buttons).toHaveCount(2, { timeout: 30_000 });
      const names = lang === "en" ? ["Sand beige", "بيج غامق"] : ["بيج رملي", "بيج غامق"];
      await expect(buttons.nth(0)).toHaveAttribute("aria-label", names[0]);
      await expect(buttons.nth(1)).toHaveAttribute("aria-label", names[1]);
      await expect(buttons.nth(0)).toHaveAttribute("data-color", "BEIGE");
      await expect(buttons.nth(1)).toHaveAttribute("data-color", "BEIGE");
      await expect(buttons.nth(0)).toHaveClass(/is-swatch/);
      await expect(buttons.nth(1).locator("img")).toHaveAttribute("src", new RegExp(path.basename(darkImg)));
      await buttons.nth(1).click();
      await expect(page.getByTestId("pdp-color-name")).toHaveText(names[1]);
      await expect(page.locator(".pdp-image img")).toHaveAttribute("src", new RegExp(path.basename(darkImg)));
      await buttons.nth(0).click();
      await expect(page.getByTestId("pdp-color-name")).toHaveText(names[0]);
      await expect(page.locator(".pdp-image img")).toHaveAttribute("src", new RegExp(path.basename(sandImg)));
      await ctx.close();
    }
    // The store: the card shows the default (first) colour; found by a shade's name.
    const shopper = await browser.newPage();
    await shopper.goto(`/store/${slug}`);
    await expect(shopper.locator("body")).toContainText(payload.title_ar, { timeout: 30_000 });
    await shopper.close();
    const found = await call<{ items: { id: string }[] }>(`/storefronts/${slug}/products?q=${encodeURIComponent("غامق")}`);
    expect(found.body.items.some((i) => i.id === offerId)).toBe(true);
  });

  test("the cart says which shade and size; on a phone nothing scrolls sideways", async ({ page }) => {
    const variant = await prisma.$queryRaw<{ id: string }[]>`
      SELECT v.id FROM offer_variants v JOIN offer_colors c ON c.id = v."offerColorId"
      WHERE v."vendorOfferId" = ${offerId} AND c."nameAr" = 'بيج غامق' AND v."sizeCode" = 'S'`;
    const added = await call<{ id: string }>("/cart/items", {
      method: "POST",
      token: fixtures.customerAToken,
      idempotencyKey: unique("cart"),
      body: { vendor_id: vendorId, offer_variant_id: variant[0].id, quantity: 1 },
    });
    expect(added.status).toBe(201);
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, fixtures.customerAToken);
    await page.goto("/cart");
    const line = page.getByTestId("cart-line-variant").filter({ hasText: "بيج غامق" });
    await expect(line).toBeVisible({ timeout: 30_000 });
    await expect(line).toContainText("S");
    await expectNoHorizontalOverflow(page);
    await call(`/cart/items/${added.body.id}`, { method: "DELETE", token: fixtures.customerAToken });
  });
});
