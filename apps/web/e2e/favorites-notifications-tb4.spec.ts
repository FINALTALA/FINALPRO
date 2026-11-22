import { expect, test, type Page } from "@playwright/test";
import { call, createVendorWithBranch, signup, unique, uniquePhone } from "./helpers/api";
import { createMatchedOfferWithStock, prisma } from "./helpers/db";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// TB-4: the favourites page and the notifications drawer after their
// React lint fixes - same behaviour, no request loops - for a customer
// and for a store owner / branch employee browsing as shoppers.

/** Signs in as `token` in the shopping space and counts the API calls the page makes. */
async function asShopper(page: Page, token: string) {
  await page.addInitScript((t) => {
    localStorage.setItem("finalpro_session_token", t);
    localStorage.setItem("finalpro_active_workspace", JSON.stringify({ type: "customer" }));
  }, token);
  const calls = { list: 0, cards: 0 };
  page.on("request", (r) => {
    if (r.method() !== "GET") return;
    if (/\/api\/v1\/me\/notifications\?/.test(r.url())) calls.list += 1;
    if (/\/comparison-card$/.test(r.url())) calls.cards += 1;
  });
  return calls;
}

test.describe("TB-4: favourites and notifications", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let employeeToken = "";
  let vendorId = "";
  let branchId = "";
  const tokenOf = (role: "customer" | "owner" | "employee") =>
    role === "owner" ? fixtures.ownerToken : role === "employee" ? employeeToken : fixtures.customerBToken;

  test.beforeAll(async () => {
    ({ vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken));
    const phone = uniquePhone();
    employeeToken = await signup(phone, "a-strong-password");
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    await prisma.vendorUser.create({ data: { userId: user.id, vendorId, role: "BRANCH_EMPLOYEE", branchId } });
  });

  for (const role of ["customer", "owner", "employee"] as const) {
    test(`${role} in the shopping space: favourites load once, remove without refetching the rest, add from the comparison, open from the heart`, async ({ page }) => {
      const token = tokenOf(role);
      const kept = await createMatchedOfferWithStock(vendorId, branchId, 100, 5);
      const removed = await createMatchedOfferWithStock(vendorId, branchId, 110, 5);
      const added = await createMatchedOfferWithStock(vendorId, branchId, 120, 5);
      for (const id of [kept.canonicalProductId, removed.canonicalProductId]) {
        const res = await call("/favorites", {
          method: "POST",
          token,
          idempotencyKey: unique("fav"),
          body: { target_type: "PRODUCT", canonical_product_id: id },
        });
        expect([200, 201]).toContain(res.status);
      }
      const calls = await asShopper(page, token);

      await page.goto("/account/favorites");
      const card = (id: string) => page.locator(`[data-testid='product-card'][data-product-id="${id}"]`);
      await expect(card(kept.canonicalProductId)).toBeVisible({ timeout: 20_000 });
      await expect(card(removed.canonicalProductId)).toBeVisible();
      const cardsAfterLoad = calls.cards;
      // Removing one: it disappears, and the rest isn't fetched again.
      await card(removed.canonicalProductId).getByRole("button", { name: "إزالة من المفضلة" }).click();
      await expect(card(removed.canonicalProductId)).toHaveCount(0);
      await expect(card(kept.canonicalProductId)).toBeVisible();
      await page.waitForTimeout(1_000);
      expect(calls.cards).toBe(cardsAfterLoad);

      // Adding from the comparison page, then the header heart opens the favourites.
      await page.goto(`/compare/${added.canonicalProductId}`);
      const clear = page.getByRole("button", { name: "مسح الفلاتر" });
      await expect(page.locator(".compare-card").or(clear).first()).toBeVisible({ timeout: 20_000 });
      if (await clear.isVisible()) await clear.click();
      await page.getByRole("button", { name: "إضافة إلى المفضلة" }).click();
      await expect(page.getByRole("button", { name: "إزالة من المفضلة" })).toBeVisible();
      await page.goto("/");
      await page.getByRole("link", { name: "أحببته" }).click();
      await expect(page).toHaveURL(/\/profile\?tab=favorites/);
      await expect(card(added.canonicalProductId)).toBeVisible({ timeout: 20_000 });
      await expect(card(kept.canonicalProductId)).toBeVisible();
    });

    test(`${role} in the shopping space: the drawer loads once per opening, filters to unread, closes and reopens - no repeated requests`, async ({ page }) => {
      const token = tokenOf(role);
      const me = await call<{ id: string }>("/customers/me", { token });
      expect(me.status).toBe(200);
      const tag = unique("n").slice(-6);
      for (const read of [true, false]) {
        const event = await prisma.outboxEvent.create({ data: { eventType: `tb4.${tag}`, payload: {} } });
        await prisma.notification.create({
          data: {
            recipientUserId: me.body.id,
            outboxEventId: event.id,
            type: "FAVORITE_PRICE_DROP",
            data: {},
            audience: "CUSTOMER",
            targetType: "CANONICAL_PRODUCT",
            targetId: event.id,
            readAt: read ? new Date() : null,
          },
        });
      }
      const calls = await asShopper(page, token);

      await page.goto("/");
      const drawer = page.locator(".notifications-drawer-layer");
      const list = page.locator(".notifications-drawer-item");
      const before = calls.list;
      await page.getByRole("button", { name: "التنبيهات" }).click();
      await expect(drawer).toHaveClass(/is-open/);
      await expect(list.nth(1)).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(".notifications-drawer-item.unread").first()).toBeVisible();
      await expect(page.locator(".notifications-drawer-item:not(.unread)").first()).toBeVisible();
      // One request for this opening, and nothing repeating.
      await page.waitForTimeout(1_500);
      expect(calls.list - before).toBe(1);

      // Unread only: one new request, only unread items.
      await page.getByRole("button", { name: "غير المقروءة فقط" }).click();
      await expect(page.locator(".notifications-drawer-item.unread").first()).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(".notifications-drawer-item:not(.unread)")).toHaveCount(0);
      await page.waitForTimeout(1_000);
      expect(calls.list - before).toBe(2);

      // Close with ×; reopening loads again (once); Escape closes.
      await page.getByRole("button", { name: "إغلاق الإشعارات" }).click();
      await expect(drawer).not.toHaveClass(/is-open/);
      await page.getByRole("button", { name: "التنبيهات" }).click();
      await expect(drawer).toHaveClass(/is-open/);
      await expect(list.first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1_000);
      expect(calls.list - before).toBe(3);
      await page.keyboard.press("Escape");
      await expect(drawer).not.toHaveClass(/is-open/);
      await page.waitForTimeout(1_000);
      expect(calls.list - before).toBe(3);
    });
  }
});
