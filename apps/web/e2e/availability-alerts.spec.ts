import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { call, createVendorWithBranch, unique } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

const sharp = createRequire(__filename)("sharp") as (input: object) => { jpeg(): { toBuffer(): Promise<Buffer> } };

test.describe("Variant availability alerts", () => {
  const fixtures = loadSharedFixtures();

  /** A colour image uploaded to the store (the publish gate needs one per colour). */
  async function ownImage(vendorId: string): Promise<string> {
    const jpeg = await sharp({ create: { width: 60, height: 80, channels: 3, background: { r: 200, g: 180, b: 150 } } }).jpeg().toBuffer();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "dress.jpg");
    const res = await fetch(`${process.env.PW_API_BASE_URL}/vendors/${vendorId}/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixtures.ownerToken}` },
      body: form,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { url: string }).url;
  }

  test("a shopper can request and cancel an alert for the exact sold-out colour and size", async ({ page }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    await makeVendorEligible(vendorId);
    const slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    await call(`/vendors/${vendorId}/storefront/catalogue`, {
      method: "PUT",
      token: fixtures.ownerToken,
      body: { departments: ["WOMEN"], categories: { WOMEN: ["DRESSES_WOMEN"] } },
    });

    const draft = await call<{ id: string }>(`/vendors/${vendorId}/offer-drafts`, {
      method: "POST",
      token: fixtures.ownerToken,
      body: {
        payload: {
          layout: 5,
          step: 5,
          audience: "WOMEN",
          category: "DRESSES_WOMEN",
          title_ar: `فستان تنبيه ${unique("a").slice(-6)}`,
          brand: { mode: "none" },
          colors: [{ key: "BEIGE", family: "BEIGE", name_ar: "بيج رملي", images: [await ownImage(vendorId)] }],
          size_system: "LETTER",
          sizes: { BEIGE: ["S", "M"] },
          price: 120,
          // The product remains purchasable through M; S is intentionally sold out.
          stock: { [branchId]: { "BEIGE|S": 0, "BEIGE|M": 2 } },
        },
      },
    });
    expect(draft.status).toBe(201);
    const current = await prisma.offerDraft.findUniqueOrThrow({ where: { id: draft.body.id } });
    const published = await call<{ offer_id: string }>(`/vendors/${vendorId}/offer-drafts/${draft.body.id}/publish`, {
      method: "POST",
      token: fixtures.ownerToken,
      body: { expected_revision: current.revision },
    });
    expect(published.status).toBe(201);

    await loginAs(page, fixtures.customerAToken);
    await page.goto(`/store/${slug}/products/${published.body.offer_id}`);
    await page.getByRole("radio", { name: "بيج رملي" }).click();
    await page.getByRole("radio", { name: "S", exact: true }).click();
    await expect(page.getByRole("button", { name: /نبّهيني عند توفر بيج رملي/ })).toBeVisible();
    await page.getByRole("button", { name: /نبّهيني عند توفر بيج رملي/ }).click();
    await expect(page.getByText("أنتِ مسجّلة لتنبيه هذا اللون والمقاس فقط.")).toBeVisible();
    await expect(page.getByTestId("pdp-availability-request")).toHaveText("إلغاء التنبيه");
    await expect(page.getByTestId("pdp-cart")).toBeDisabled();
    await expect(page.getByTestId("pdp-cart")).toHaveText("غير متوفر");

    await page.goto("/account/availability-alerts");
    const alert = page.getByRole("article");
    await expect(alert).toContainText("اللون: بيج رملي");
    await expect(alert).toContainText("المقاس: S");
    // its link returns to exactly that colour and size
    await expect(alert.getByRole("link").first()).toHaveAttribute("href", /\?color=[^&]+&size=S$/);
    await page.getByRole("button", { name: "إلغاء التنبيه" }).click();
    await expect(page.getByText("لا توجد تنبيهات فعّالة")).toBeVisible();
  });

  test("the owner's draft preview shows the sold-out colour and size exactly as the published page does - its alert request shown but disabled, and nothing is sent", async ({ page }) => {
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    await makeVendorEligible(vendorId);
    const slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    await call(`/vendors/${vendorId}/storefront/catalogue`, {
      method: "PUT",
      token: fixtures.ownerToken,
      body: { departments: ["WOMEN"], categories: { WOMEN: ["DRESSES_WOMEN"] } },
    });
    const draft = await call<{ id: string }>(`/vendors/${vendorId}/offer-drafts`, {
      method: "POST",
      token: fixtures.ownerToken,
      body: {
        payload: {
          layout: 5,
          step: 5,
          audience: "WOMEN",
          category: "DRESSES_WOMEN",
          title_ar: `فستان معاينة ${unique("p").slice(-6)}`,
          brand: { mode: "none" },
          colors: [{ key: "BEIGE", family: "BEIGE", name_ar: "بيج رملي", images: [await ownImage(vendorId)] }],
          size_system: "LETTER",
          sizes: { BEIGE: ["S", "M"] },
          price: 120,
          stock: { [branchId]: { "BEIGE|S": 0, "BEIGE|M": 2 } },
        },
      },
    });
    expect(draft.status).toBe(201);

    /** The sold-out S and the available M, as the page shows them (state classes and the alert block). */
    async function soldOutView() {
      await page.getByRole("radio", { name: "بيج رملي" }).click();
      const s = page.getByRole("radio", { name: "S", exact: true });
      const m = page.getByRole("radio", { name: "M", exact: true });
      const view = { s: await s.getAttribute("class"), m: await m.getAttribute("class") };
      await s.click();
      const request = page.getByTestId("pdp-availability-request");
      await expect(request).toBeVisible();
      await expect(request).toContainText("نبّهيني عند توفر بيج رملي");
      return { ...view, request: request };
    }

    // the preview (owner): every request it makes is recorded - only reads are allowed
    const writes: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET" && r.method() !== "OPTIONS") writes.push(`${r.method()} ${r.url()}`);
      else if (r.url().includes("availability-subscriptions")) writes.push(`read ${r.url()}`);
    });
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers/drafts/${draft.body.id}/preview`);
    await expect(page.getByTestId("pdp-preview-strip")).toBeVisible();
    const preview = await soldOutView();
    await expect(preview.request).toBeDisabled();
    await preview.request.click({ force: true });
    await page.waitForTimeout(500);
    expect(writes).toEqual([]);

    // the same product once published: the same S and M, the request now usable
    const current = await prisma.offerDraft.findUniqueOrThrow({ where: { id: draft.body.id } });
    const published = await call<{ offer_id: string }>(`/vendors/${vendorId}/offer-drafts/${draft.body.id}/publish`, {
      method: "POST",
      token: fixtures.ownerToken,
      body: { expected_revision: current.revision },
    });
    expect(published.status).toBe(201);
    await loginAs(page, fixtures.customerAToken);
    await page.goto(`/store/${slug}/products/${published.body.offer_id}`);
    const live = await soldOutView();
    await expect(live.request).toBeEnabled();
    expect({ s: live.s, m: live.m }).toEqual({ s: preview.s, m: preview.m });
  });
});
