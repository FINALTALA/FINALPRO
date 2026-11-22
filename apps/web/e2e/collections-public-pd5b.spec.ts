import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { call, createAddress, createVendorWithBranch, signup, unique, uniquePhone } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// PD-5b.4: platform collections where shoppers see them - home (≤2), a
// department page (1), the discovery links band and /collections/[slug] -
// exactly what the public API returns: live collections only, only
// products buyable now for the zone (default address, manual choice or
// all areas; a delivery-only product disappears outside the served
// zones), in the admin's order; cards open the comparison; honest empty
// and not-found states; AR/EN and desktop/phone without sideways scroll.

test.describe("PD-5b.4: public platform collections", () => {
  // TB-6: every test below stands on this group's beforeAll data alone, so
  // one failing test never hides another's result (no serial mode).
  const fixtures = loadSharedFixtures();
  const tag = unique("t").slice(-5);
  const p: string[] = [];
  let deliveryOnly = "";
  let soldOut = "";
  let store = { vendorId: "", branchId: "", slug: "", offerId: "" };
  const slug = (name: string) => `${name}-${tag}`.toLowerCase();
  const title = (name: string) => `${name} ${tag}`;

  async function product(vendorId: string, branchId: string, name: string, stock = 5) {
    const brand = await prisma.brand.create({ data: { name: unique("Brand"), normalizedName: unique("b") } });
    const category = await prisma.category.create({ data: { nameAr: unique("فئة"), nameEn: unique("C") } });
    const cp = await prisma.canonicalProduct.create({
      data: { brandId: brand.id, categoryId: category.id, modelName: unique("M"), canonicalNameAr: name, status: "PUBLISHED" },
    });
    const cv = await prisma.canonicalProductVariant.create({
      data: { canonicalProductId: cp.id, structuralAttributes: { n: unique("v") }, platformProductBarcode: unique("pb") },
    });
    const offer = await prisma.vendorOffer.create({
      data: { vendorId, titleAr: name, titleEn: name, status: "ACTIVE", canonicalProductId: cp.id },
    });
    const v = await prisma.offerVariant.create({
      data: { vendorId, vendorOfferId: offer.id, sellerSku: unique("sku"), storeInventoryBarcode: unique("sib"), basePrice: 99, canonicalVariantId: cv.id },
    });
    if (stock > 0) await prisma.branchStock.create({ data: { vendorId, branchId, offerVariantId: v.id, quantity: stock } });
    if (!store.offerId) store.offerId = offer.id;
    return cp.id;
  }

  async function collection(name: string, ids: string[], extra: Record<string, unknown> = {}, publish = true) {
    const created = await call<{ id: string }>("/admin/collections", {
      method: "POST",
      token: fixtures.adminToken,
      idempotencyKey: unique("c"),
      body: { slug: slug(name), title_ar: title(name), title_en: `${name} EN ${tag}`, ...extra },
    });
    expect(created.status).toBe(201);
    expect(
      (await call(`/admin/collections/${created.body.id}/items`, { method: "PUT", token: fixtures.adminToken, idempotencyKey: unique("i"), body: { canonical_product_ids: ids } })).status,
    ).toBe(200);
    if (publish) {
      expect((await call(`/admin/collections/${created.body.id}/publish`, { method: "POST", token: fixtures.adminToken, idempotencyKey: unique("p") })).status).toBe(200);
    }
    return created.body.id;
  }

  test.beforeAll(async () => {
    // Placements rank every live collection: leave only this file's.
    await prisma.platformCollection.updateMany({ where: { status: "PUBLISHED" }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    await makeVendorEligible(vendorId);
    store = { vendorId, branchId, slug: (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).slug!, offerId: "" };
    const online = await prisma.storeBranch.create({ data: { vendorId, name: "مستودع", isPhysical: false, verificationStatus: "APPROVED" } });
    const weekday = new Date(
      `${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hebron" }).format(new Date(Date.now() + 86_400_000))}T00:00:00Z`,
    ).getUTCDay();
    await prisma.deliveryWindow.create({ data: { vendorId, branchId: online.id, dayOfWeek: weekday, startMinute: 720, endMinute: 840, capacity: 5 } });
    await prisma.vendorDeliveryZone.upsert({
      where: { vendorId_region: { vendorId, region: "WEST_BANK" } },
      create: { vendorId, region: "WEST_BANK", enabled: true, fee: 10 },
      update: { enabled: true, fee: 10 },
    });
    for (let i = 1; i <= 4; i++) p.push(await product(vendorId, branchId, `قطعة ${i} ${tag}`));
    deliveryOnly = await product(vendorId, online.id, `توصيل فقط ${tag}`);
    soldOut = await product(vendorId, branchId, `نفدت ${tag}`, 0);

    await collection("home-a", [...p, deliveryOnly], { show_on_home: true, description_ar: `وصف أ ${tag}` });
    await collection("home-b", [p[1], p[0], p[2], p[3]], { show_on_home: true });
    await collection("home-c", [...p], { show_on_home: true }); // a third: not shown on home (max 2)
    await collection("draft", [...p], { show_on_home: true }, false);
    await collection("later", [...p], { show_on_home: true, publish_from: new Date(Date.now() + 86_400_000).toISOString() });
    await collection("three", [p[0], p[1], p[2], soldOut], { show_on_home: true, audience: "MEN" });
    await collection("women", [p[3], p[2], p[1], p[0]], { audience: "WOMEN" });
    await collection("empty", [soldOut]);
  });

  test("home shows the first two live collections, 4 cards each in the admin order, with «عرض الكل»", async ({ page }) => {
    await page.goto("/");
    const sections = page.locator(".collection-showcase-section");
    await expect(sections).toHaveCount(2, { timeout: 30_000 });
    await expect(sections.nth(0).getByRole("heading")).toHaveText(title("home-a"));
    await expect(sections.nth(0)).toContainText(`وصف أ ${tag}`);
    await expect(sections.nth(1).getByRole("heading")).toHaveText(title("home-b"));
    const ids = (i: number) => sections.nth(i).locator("[data-testid='product-card']").evaluateAll((els) => els.map((e) => e.getAttribute("data-product-id")));
    expect(await ids(0)).toEqual(p);
    expect(await ids(1)).toEqual([p[1], p[0], p[2], p[3]]);
    await expect(sections.nth(0).getByRole("link", { name: "عرض الكل" })).toHaveAttribute("href", `/collections/${slug("home-a")}`);
    // Draft, scheduled, a third one and one with only 3 buyable products: not on home.
    for (const hidden of ["home-c", "draft", "later", "three"]) await expect(page.getByText(title(hidden))).toHaveCount(0);
    // It sits after the banners and before «وصل حديثاً».
    const order = await page.evaluate(() => {
      const showcase = document.querySelector(".collection-showcase")!;
      const newIn = [...document.querySelectorAll("h2")].find((h) => h.textContent?.includes("وصل حديثاً"))!;
      return !!(showcase.compareDocumentPosition(newIn) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order).toBe(true);
  });

  test("a department page shows its one collection between the categories and the listing; discovery shows links only", async ({ page }) => {
    await page.goto("/women");
    const section = page.locator(".collection-showcase-section");
    await expect(section).toHaveCount(1, { timeout: 30_000 });
    await expect(section.getByRole("heading")).toHaveText(title("women"));
    expect(await section.locator("[data-testid='product-card']").evaluateAll((els) => els.map((e) => e.getAttribute("data-product-id")))).toEqual([p[3], p[2], p[1], p[0]]);
    const between = await page.evaluate(() => {
      const showcase = document.querySelector(".collection-showcase")!;
      const listing = document.getElementById("women-products")!;
      return !!(showcase.compareDocumentPosition(listing) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(between).toBe(true);
    // Men: its only MEN collection has 3 buyable products - below 4, so none.
    await page.goto("/men");
    await expect(page.locator("#men-products")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".collection-showcase-section")).toHaveCount(0);

    await page.goto("/discovery");
    const band = page.getByRole("navigation", { name: "المجموعات" });
    await expect(band).toBeVisible({ timeout: 30_000 });
    await expect(band.getByRole("link", { name: title("home-a") })).toHaveAttribute("href", `/collections/${slug("home-a")}`);
    await expect(band.getByRole("link", { name: title("women") })).toBeVisible();
    await expect(band.locator("[data-testid='product-card']")).toHaveCount(0);
  });

  test("the collection page: products for the zone (manual, all), cards open the comparison, honest empty and not-found", async ({ page }) => {
    const ids = () => page.locator(".collection-page-grid [data-testid='product-card']").evaluateAll((els) => els.map((e) => e.getAttribute("data-product-id")));
    await page.goto(`/collections/${slug("home-a")}`);
    await expect(page.getByRole("heading", { name: title("home-a") })).toBeVisible({ timeout: 30_000 });
    // A visitor has no address: nothing to call "my address".
    await expect(page.getByLabel("منطقة التوصيل").locator("option").first()).toHaveText("اختاري المنطقة");
    await expect(page.locator(".collection-page-grid [data-testid='product-card']")).toHaveCount(5);
    expect(await ids()).toEqual([...p, deliveryOnly]);
    // A click opens the price comparison, not a store page.
    await expect(page.locator(`.collection-page-grid [data-product-id="${p[0]}"] a`).first()).toHaveAttribute("href", new RegExp(`^/compare/${p[0]}`));
    await page.getByLabel("منطقة التوصيل").selectOption("INSIDE");
    await expect(page.locator(".collection-page-grid [data-testid='product-card']")).toHaveCount(4);
    expect(await ids()).toEqual(p);
    await page.getByLabel("منطقة التوصيل").selectOption("WEST_BANK");
    await expect(page.locator(".collection-page-grid [data-testid='product-card']")).toHaveCount(5);
    await page.getByLabel("منطقة التوصيل").selectOption("ALL");
    await expect(page.locator(".collection-page-grid [data-testid='product-card']")).toHaveCount(5);
    expect(await page.locator("main").innerText()).not.toMatch(/مسودة|منشورة|مؤرشفة|sort|مخزون|فرع/);

    // Only a sold-out product: an honest empty state.
    await page.goto(`/collections/${slug("empty")}`);
    await expect(page.getByText("لا توجد منتجات متاحة في هذه المجموعة حالياً")).toBeVisible({ timeout: 30_000 });
    // Not live (draft / scheduled) or unknown: not found.
    for (const s of [slug("draft"), slug("later"), "no-such-collection"]) {
      await page.goto(`/collections/${s}`);
      await expect(page.getByText("هذه المجموعة غير متاحة")).toBeVisible({ timeout: 30_000 });
    }
  });

  // TB-6: the former "customer, owner and employee" test, split per role.
  // Each role test checks itself against one reference - what a guest sees
  // at the same zone - so every role matches every other without any test
  // depending on another test's result. Map of the old checks:
  //   per-role home showcase + collection page at INSIDE / WEST_BANK / ALL
  //     == the other roles'          -> each role test == the guest reference
  //   default zone (address or none), "my address" label, employee's
  //     add-an-address link          -> each role test (its own default)
  //   no /admin link, no admin words -> each role test
  //   product page shows the same "my address" (PD-2) -> each role test
  // The group's beforeAll uses no OTP, so a worker restart after a failure
  // can re-run it freely; the employee's signup (an OTP, throttled to 5 a
  // minute per run) happens once, inside the employee test itself.
  test.describe("signed-in roles in the shopping space", () => {
    /** A new account, a branch employee of this file's store, with no address. */
    async function newEmployee() {
      const employeePhone = uniquePhone();
      const token = await signup(employeePhone, "Passw0rd!x");
      const employee = await prisma.user.findUniqueOrThrow({ where: { phone: employeePhone } });
      await prisma.vendorUser.create({ data: { userId: employee.id, vendorId: store.vendorId, role: "BRANCH_EMPLOYEE", branchId: store.branchId } });
      return token;
    }
    const roles = {
      customer: { token: async () => fixtures.customerBToken, mine: "عنواني (الداخل)", byDefault: 4 },
      owner: { token: async () => fixtures.ownerToken, mine: "عنواني (الضفة الغربية)", byDefault: 5 },
      employee: { token: newEmployee, mine: "اختاري المنطقة", byDefault: 5 },
    };
    // The guest's view: home showcase text, and the collection page's cards per zone.
    const reference: Record<string, string> = {};

    const gridOf = (page: Page) => page.locator(".collection-page-grid [data-testid='product-card']");
    const cardsOf = async (page: Page) =>
      (await gridOf(page).evaluateAll((els) => els.map((e) => `${e.getAttribute("data-product-id")}|${e.textContent}`))).join("\n");

    /** Home showcase text, then the collection page's cards at each zone. */
    async function publicView(page: Page, into: Record<string, string>) {
      await page.goto("/");
      await expect(page.locator(".collection-showcase-section")).toHaveCount(2, { timeout: 30_000 });
      into.home = await page.locator(".collection-showcase").innerText();
      await page.goto(`/collections/${slug("home-a")}`);
      const picker = page.getByLabel("منطقة التوصيل");
      await expect(picker).toBeVisible({ timeout: 30_000 });
      for (const zone of ["INSIDE", "WEST_BANK", "ALL"]) {
        await picker.selectOption(zone);
        await expect(gridOf(page)).toHaveCount(zone === "INSIDE" ? 4 : 5);
        into[zone] = await cardsOf(page);
      }
    }

    test.beforeAll(async ({ browser }) => {
      // Customer: default INSIDE. Owner: default WEST_BANK. (Employee: a new account with no address.)
      const setDefault = async (token: string, zone: string) => {
        const a = await createAddress(token, { zone });
        expect((await call(`/customers/me/addresses/${a.id}`, { method: "PATCH", token, idempotencyKey: unique("d"), body: { is_default: true } })).status).toBe(200);
      };
      await setDefault(fixtures.customerBToken, "INSIDE");
      await setDefault(fixtures.ownerToken, "WEST_BANK");

      const guest = await browser.newContext();
      await publicView(await guest.newPage(), reference);
      await guest.close();
    });

    for (const [name, role] of Object.entries(roles)) {
      test(`${name}: the same public collections and cards as anyone at the same zone, its own default zone, nothing from platform admin`, async ({ browser }) => {
        const token = await role.token();
        const context = await browser.newContext();
        // Signed in and browsing as a shopper (not the store or admin workspace).
        await context.addInitScript((t) => {
          localStorage.setItem("finalpro_session_token", t);
          localStorage.setItem("finalpro_active_workspace", JSON.stringify({ type: "customer" }));
        }, token);
        const page = await context.newPage();

        await page.goto("/");
        await expect(page.locator(".collection-showcase-section")).toHaveCount(2, { timeout: 30_000 });
        expect(await page.locator(".collection-showcase").innerText()).toBe(reference.home);

        await page.goto(`/collections/${slug("home-a")}`);
        const picker = page.getByLabel("منطقة التوصيل");
        await expect(picker.locator("option").first()).toHaveText(role.mine, { timeout: 30_000 });
        // Default (no choice): the account's default address zone, or none.
        await expect(gridOf(page)).toHaveCount(role.byDefault);
        if (name === "employee") await expect(page.getByRole("link", { name: /أضيفي عنواناً افتراضياً/ })).toBeVisible();
        for (const zone of ["INSIDE", "WEST_BANK", "ALL"]) {
          await picker.selectOption(zone);
          await expect(gridOf(page)).toHaveCount(zone === "INSIDE" ? 4 : 5);
          expect(await cardsOf(page)).toBe(reference[zone]);
        }
        // Nothing from platform administration.
        await expect(page.locator("a[href^='/admin']")).toHaveCount(0);
        expect(await page.locator("main").innerText()).not.toMatch(/مسودة|منشورة|مؤرشفة|أرشفة|نشر المجموعة|تعديل|إدارة المجموعات|Draft|Archive|Publish/);

        // The product page uses the same picker with the same "my address" (PD-2).
        await page.goto(`/store/${store.slug}/products/${store.offerId}`);
        await expect(page.getByLabel("منطقة التوصيل").locator("option").first()).toHaveText(role.mine, { timeout: 30_000 });
        await context.close();
      });
    }
  });

  // TB-6: the former "Arabic and English, desktop and phone" test, one test
  // per language x viewport, each with every check it had for that pair:
  // home, /women, /discovery and the collection page render their
  // collection UI with the language's direction and no sideways scroll;
  // on a phone the collection page shows two cards per row; in English the
  // collection heading is the English title.
  for (const lang of ["ar", "en"] as const) {
    for (const [device, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 360, height: 760 }]] as const) {
      test(`${lang} ${device}: ${lang === "en" ? "LTR" : "RTL"}, no sideways scroll${device === "phone" ? ", two columns" : ""}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport, isMobile: viewport.width < 500 });
        await context.addInitScript((l) => localStorage.setItem("finalpro_lang_pref", l), lang);
        const page = await context.newPage();
        for (const url of ["/", "/women", "/discovery", `/collections/${slug("home-a")}`]) {
          await page.goto(url);
          await expect(page.locator(url.startsWith("/collections") ? ".collection-page-grid" : url === "/discovery" ? ".collection-links" : ".collection-showcase")).toBeVisible({ timeout: 30_000 });
          await expect(page.locator("html")).toHaveAttribute("dir", lang === "en" ? "ltr" : "rtl");
          await expectNoHorizontalOverflow(page);
        }
        if (device === "phone") {
          const cards = page.locator(".collection-page-grid [data-testid='product-card']");
          const [a, b] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()]);
          expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
        }
        if (lang === "en") await expect(page.getByRole("heading", { name: `home-a EN ${tag}` })).toBeVisible();
        await context.close();
      });
    }
  }
});
