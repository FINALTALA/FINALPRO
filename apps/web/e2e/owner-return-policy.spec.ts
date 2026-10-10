import { expect, test } from "@playwright/test";
import { createVendorWithBranch } from "./helpers/api";
import { prisma } from "./helpers/db";
import { loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";

// Sprint 21 (PDR-030, review-round point 1): the owner's return-policy
// settings page - loading -> read, a successful update, and the
// 6-month lock's 409 rendered as an error state.
test.describe("owner return-policy UI", () => {
  const fixtures = loadSharedFixtures();

  test("reads the initial NO_RETURN policy, updates it, then hits the 6-month lock", async ({
    page,
  }) => {
    const { vendorId } = await createVendorWithBranch(fixtures.ownerToken, {
      mode: "NO_RETURN",
    });
    // CreateVendorDto.return_policy's own apply() already set
    // returnPolicyUpdatedAt = now at registration (same gotcha the
    // Jest e2e suite's own "owner can read/update the policy" test
    // hit and fixed) - back-date it so this test's FIRST save isn't
    // itself inside the six-month lock.
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { returnPolicyUpdatedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) },
    });

    await loginAs(page, fixtures.ownerToken);
    await page.goto(`/vendor/${vendorId}/return-policy`);

    const modeSelect = page.locator("select");
    await expect(modeSelect).toHaveValue("NO_RETURN");

    await modeSelect.selectOption("REFUND_ONLY");
    await page.locator('input[type="number"]').nth(0).fill("10");
    await page.locator('input[type="number"]').nth(1).fill("3");
    await page.getByRole("button", { name: "حفظ" }).click();
    await expect(page.getByText("تم الحفظ")).toBeVisible();
    await expect(modeSelect).toHaveValue("REFUND_ONLY");

    // Same six-month window, same vendor: the second update is
    // rejected and the 409 renders as a plain error banner.
    await page.getByRole("button", { name: "حفظ" }).click();
    await expect(
      page.getByText(
        "يمكن تعديل سياسة الإرجاع مرة واحدة كل ستة أشهر فقط - لم تحن المدة بعد.",
      ),
    ).toBeVisible();
  });
});
