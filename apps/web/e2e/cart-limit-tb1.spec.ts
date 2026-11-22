import { expect, test } from "@playwright/test";
import { addToCart, createVendorWithBranch, signup, unique, uniquePhone } from "./helpers/api";
import { createOfferWithStock, prisma } from "./helpers/db";
import { loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// TB-1: the cart shows the public per-item limit (10), never a branch's
// stock: no number while the quantity is fine (also for low stock), the
// available figure only once a quantity fails (at most 10), and a line
// over the limit from before TB-1 says the limit and can be lowered.

test.describe("TB-1: cart quantity limit", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();

  test("no stock figure while fine, the available figure only on failure, the limit for an over-limit line", async ({ page }) => {
    const token = await signup(uniquePhone(), "a-strong-password");
    const { vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken);
    const line = async (title: string, stock: number, quantity: number) => {
      const variantId = await createOfferWithStock(vendorId, branchId, 20, stock);
      const v = await prisma.offerVariant.findUniqueOrThrow({ where: { id: variantId } });
      await prisma.vendorOffer.update({ where: { id: v.vendorOfferId }, data: { titleAr: title } });
      const id = await addToCart(token, vendorId, variantId, Math.min(quantity, 10));
      if (quantity > 10) await prisma.cartItem.update({ where: { id }, data: { quantity } });
      return title;
    };
    const tag = unique("t").slice(-5);
    const plenty = await line(`كثير ${tag}`, 47, 1);
    const few = await line(`قليل ${tag}`, 2, 1);
    const seven = await line(`سبعة ${tag}`, 7, 9);
    const old = await line(`قديم ${tag}`, 47, 15);

    await loginAs(page, token);
    await page.goto("/cart");
    const row = (title: string) => page.locator(".cart-line").filter({ hasText: title });
    await expect(row(plenty)).toBeVisible({ timeout: 30_000 });

    // Plenty, quantity 1: no number at all, and the field stops at the limit.
    await expect(row(plenty)).toHaveAttribute("data-line-state", "ok");
    await expect(row(plenty).locator("input[type=number]")).toHaveAttribute("max", "10");
    expect(await page.locator("main").innerText()).not.toContain("47");

    // Low stock: "limited" without a figure.
    await expect(row(few).getByText("كمية محدودة.")).toBeVisible();
    expect(await row(few).innerText()).not.toMatch(/المتاح\s*\d/);

    // Asking 9 of 7: the figure 7 appears only because the quantity fails.
    await expect(row(seven)).toHaveAttribute("data-line-state", "exceeds_max");
    await expect(row(seven)).toContainText("الكمية المتاحة حالياً 7 فقط");
    await expect(row(seven).getByRole("button", { name: "اضبطي الكمية على 7" })).toBeVisible();

    // A line of 15 from before the limit: the limit, not the stock; lowering it works.
    await expect(row(old)).toHaveAttribute("data-line-state", "exceeds_max");
    await expect(row(old)).toContainText("الحد الأقصى 10 قطع");
    await row(old).getByRole("button", { name: "اضبطي الكمية على 10" }).click();
    await expect(row(old)).toHaveAttribute("data-line-state", "ok", { timeout: 15_000 });
    expect(await page.locator("main").innerText()).not.toContain("47");

    // Typing past the limit is refused with the public limit only.
    await row(plenty).locator("input[type=number]").fill("12");
    await expect(page.getByText("الحد الأقصى 10 قطع من المنتج نفسه في الطلب.")).toBeVisible({ timeout: 15_000 });
    expect(await page.locator("main").innerText()).not.toContain("47");
  });
});
