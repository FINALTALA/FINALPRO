import { createRequire } from "node:module";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { call, createVendorWithBranch, unique, uniquePhone } from "./helpers/api";
import { makeVendorEligible, prisma } from "./helpers/db";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { enterWorkspace, loginAs } from "./helpers/session";
import { loadSharedFixtures } from "./helpers/shared-fixtures";
import { chooseImportFiles, importFiles } from "./helpers/importFiles";

const sharp = createRequire(__filename)("sharp") as (input: object) => { jpeg(): { toBuffer(): Promise<Buffer> } };
/** A screenshot as raw grey pixels (for decoding a printed barcode). */
const sharpRaw = (png: Buffer) =>
  (createRequire(__filename)("sharp") as (input: Buffer) => { greyscale(): { raw(): { toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }> } } })(png)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

// Barcodes and in-store sales (2026-11-20, second round):
//  - the cashier: a real multi-line basket - several colours and sizes of one
//    product, the same colour x size merges, − / + / × on each line - sold
//    from each line's own colour x size x branch; the store scanner (types,
//    then Enter) leaves the field ready for the next read;
//  - the camera: its button only where a camera can be used; the browser's
//    BarcodeDetector when present, else the ZXing reader (a real EAN-13
//    drawn into a fake camera); never a panel over the screen;
//  - the product details stay read only («إدارة الباركود» opens its own
//    screen in the same window); generate / link / print from there;
//  - «طباعة ملصقات»: several products, codes and copies, the label's content;
//  - the wizard's «باركود المنتج للمحل» (optional, checked, kept);
//  - the old stock movement is no longer called a sale; «مبيعات المحل» void;
//    the icon per role; English / phone; the feature off.

const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";

async function account(lang: "ar" | "en" = "ar") {
  const phone = uniquePhone();
  const user = await prisma.user.create({ data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: lang } });
  await prisma.customerProfile.create({ data: { userId: user.id } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: "a-strong-password" } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, token: res.body.session_token };
}

let seq = 0;
/** A product: colour name -> size -> quantity in the branch; optionally its product barcode (raw SQL: the shared test client predates these tables). */
async function product(vendorId: string, branchId: string, title: string, stock: Record<string, Record<string, number>>, code?: string, status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  seq += 1;
  const offer = await prisma.vendorOffer.create({ data: { vendorId, titleAr: title, titleEn: `Dress ${seq}`, status } });
  const variants: Record<string, string> = {};
  for (const [colour, sizes] of Object.entries(stock)) {
    for (const [size, qty] of Object.entries(sizes)) {
      const v = await prisma.offerVariant.create({
        data: { vendorId, vendorOfferId: offer.id, sellerSku: unique(`pos-sku-${seq}`), basePrice: 120, storeInventoryBarcode: unique(`pos-sib-${seq}`), colour, size },
      });
      variants[`${colour}|${size}`] = v.id;
      await prisma.branchStock.create({ data: { vendorId, branchId, offerVariantId: v.id, quantity: qty } });
    }
  }
  if (code) await addCode(vendorId, offer.id, code, true);
  return { offerId: offer.id, variants };
}
async function addCode(vendorId: string, offerId: string, code: string, primary: boolean) {
  const owner = await prisma.vendorUser.findFirstOrThrow({ where: { vendorId, role: "OWNER" }, select: { userId: true } });
  const format = /^\d{13}$/.test(code) ? "EAN13" : "CODE128";
  await prisma.$executeRaw`
    INSERT INTO offer_barcodes (id, "vendorId", "vendorOfferId", code, format, source, "isPrimary", "createdById")
    VALUES (gen_random_uuid()::text, ${vendorId}, ${offerId}, ${code}, ${format}::"BarcodeFormat", 'EXTERNAL', ${primary}, ${owner.userId})`;
}
const qtyOf = async (branchId: string, variantId: string) =>
  (await prisma.branchStock.findUniqueOrThrow({ where: { branchId_offerVariantId: { branchId, offerVariantId: variantId } } })).quantity;
async function setFlag(enabled: boolean) {
  await prisma.featureFlag.upsert({ where: { key: "store_cashier_enabled" }, create: { key: "store_cashier_enabled", enabled, description: "test" }, update: { enabled } });
}

/** A fake rear camera: a canvas stream, with a real EAN-13 drawn on it when `code` is given (for the ZXing reader). */
async function fakeCamera(page: Page, opts: { code?: string; nativeDetector?: string | null; noCamera?: boolean }) {
  await page.addInitScript((o) => {
    const w = window as unknown as Record<string, unknown>;
    if (o.nativeDetector === null) delete w.BarcodeDetector;
    if (o.noCamera) {
      Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
      return;
    }
    if (typeof o.nativeDetector === "string") {
      const value = o.nativeDetector;
      w.BarcodeDetector = class {
        static async getSupportedFormats() {
          return ["ean_13", "code_128"];
        }
        private calls = 0;
        async detect() {
          this.calls += 1;
          return this.calls > 2 ? [{ rawValue: value }] : [];
        }
      };
    }
    const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
    const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
    const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
    const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];
    const ean13 = (code: string) => {
      const d = code.split("").map(Number);
      let bits = "101";
      for (let i = 1; i <= 6; i++) bits += (PARITY[d[0]][i - 1] === "L" ? L : G)[d[i]];
      bits += "01010";
      for (let i = 7; i <= 12; i++) bits += R[d[i]];
      return bits + "101";
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext("2d")!;
      const draw = () => {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, 640, 480);
        if (o.code) {
          const bits = ean13(o.code);
          const m = 4;
          const x0 = Math.round((640 - bits.length * m) / 2);
          ctx.fillStyle = "#000";
          for (let i = 0; i < bits.length; i++) if (bits[i] === "1") ctx.fillRect(x0 + i * m, 140, m, 200);
        }
      };
      draw();
      window.setInterval(draw, 100);
      return (canvas as HTMLCanvasElement & { captureStream: (fps: number) => MediaStream }).captureStream(15);
    };
  }, opts);
}

test.describe("Barcodes and the in-store cashier", () => {
  test.describe.configure({ mode: "serial" });
  const fixtures = loadSharedFixtures();
  let vendorId = "";
  let branchId = "";
  let slug = "";
  const p: Record<string, { offerId: string; variants: Record<string, string> }> = {};

  test.beforeAll(async () => {
    await setFlag(true);
    ({ vendorId, branchId } = await createVendorWithBranch(fixtures.ownerToken));
    await makeVendorEligible(vendorId);
    slug = (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } })).slug;
    p.dress = await product(vendorId, branchId, "فستان كتان طويل", { أزرق: { S: 5, M: 6 }, أحمر: { S: 7, M: 0 } }, "4006381333931");
    p.hidden = await product(vendorId, branchId, "بلوزة مخفية", { أسود: { M: 3 } }, "HIDDEN-0001", "INACTIVE");
    p.plain = await product(vendorId, branchId, "تنورة بلا باركود", { بيج: { M: 4 } });
    p.scarf = await product(vendorId, branchId, "وشاح حرير", { وردي: { "مقاس واحد": 9 } }, "SCARF-0001");
  });
  test.afterAll(async () => {
    await setFlag(false);
  });

  async function openStoreAs(page: Page, token: string) {
    await loginAs(page, token);
    await enterWorkspace(page, token, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/store/${slug}`);
  }
  async function openCashier(page: Page): Promise<FrameLocator> {
    const icon = page.getByTestId("store-cashier-button");
    await expect(icon).toBeVisible({ timeout: 30_000 });
    await icon.click();
    await expect(page.getByTestId("management-frame-title")).toHaveText("بيع من المحل", { timeout: 30_000 });
    const frame = page.frameLocator(".store-management-detail-frame");
    await expect(frame.getByTestId("pos-page")).toBeVisible({ timeout: 30_000 });
    return frame;
  }
  /** What a store scanner does: types the code into the focused field, then Enter. */
  async function scan(frame: FrameLocator | Page, code: string) {
    const input = frame.getByTestId("pos-scan");
    await input.fill(code);
    await input.press("Enter");
  }
  async function pick(frame: FrameLocator, colour: string, size: string, qty: number) {
    await frame.getByTestId(`pos-color-${colour}`).click();
    await frame.getByTestId(`pos-size-${size}`).click();
    for (let i = 1; i < qty; i++) await frame.getByTestId("pos-card").getByRole("button", { name: "زيادة الكمية" }).click();
    await expect(frame.getByTestId("pos-qty")).toHaveText(String(qty));
    await frame.getByTestId("pos-add").click();
  }

  test("owner: one basket of several colours and sizes - lines, merge, − / + / ×, and a sale from each line's own colour x size x branch", async ({ page }) => {
    await openStoreAs(page, fixtures.ownerToken);
    await expect(page.getByRole("button", { name: "مشاركة المتجر" })).toHaveCount(0);
    const frame = await openCashier(page);
    const field = frame.getByTestId("pos-scan");
    await expect(field).toBeFocused();
    await expect(frame.locator(".pos-scanner-status").first()).toContainText("الماسح جاهز");

    await scan(frame, "4006381333931");
    await expect(frame.getByTestId("pos-card")).toContainText("فستان كتان طويل", { timeout: 30_000 });
    // the field is ready again for the next read
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("");
    // red M is sold out at this branch: shown, disabled
    await frame.getByTestId("pos-color-أحمر").click();
    await expect(frame.getByTestId("pos-size-M")).toBeDisabled();
    await expect(frame.getByTestId("pos-size-M")).toHaveAttribute("aria-label", /نفد/);

    await pick(frame, "أزرق", "M", 3);
    await expect(frame.getByTestId("pos-added")).toContainText("أزرق · M × 3");
    await pick(frame, "أزرق", "S", 2);
    await pick(frame, "أحمر", "S", 4);
    // the same product x colour x size again: merged into its line
    await pick(frame, "أزرق", "M", 1);
    const lines = frame.getByTestId("pos-line");
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(0)).toContainText("أزرق · M");
    await expect(lines.nth(0).getByTestId("pos-line-qty")).toHaveText("4");
    // − on that line back to 3; + then − on the red line
    await lines.nth(0).getByRole("button", { name: "إنقاص الكمية" }).click();
    await expect(lines.nth(0).getByTestId("pos-line-qty")).toHaveText("3");
    await lines.nth(2).getByRole("button", { name: "زيادة الكمية" }).click();
    await expect(lines.nth(2).getByTestId("pos-line-qty")).toHaveText("5");
    await lines.nth(2).getByRole("button", { name: "إنقاص الكمية" }).click();
    await expect(lines.nth(2).getByTestId("pos-line-qty")).toHaveText("4");
    await expect(frame.getByTestId("pos-basket")).toContainText("3 سطر · 9 قطعة");

    await frame.getByTestId("pos-confirm").click();
    await expect(frame.getByRole("alertdialog")).toContainText("بيع 9 قطعة في 3 سطر");
    await frame.getByTestId("pos-confirm-yes").click();
    await expect(frame.getByTestId("pos-done")).toContainText(/S-\d{6}/, { timeout: 30_000 });
    await expect(lines).toHaveCount(0);

    expect(await qtyOf(branchId, p.dress.variants["أزرق|M"])).toBe(3);
    expect(await qtyOf(branchId, p.dress.variants["أزرق|S"])).toBe(3);
    expect(await qtyOf(branchId, p.dress.variants["أحمر|S"])).toBe(3);
    expect(await qtyOf(branchId, p.dress.variants["أحمر|M"])).toBe(0);
    const rows = await prisma.$queryRaw<{ offerVariantId: string; quantity: number }[]>`
      SELECT i."offerVariantId", i.quantity FROM store_sale_items i JOIN store_sales s ON s.id = i."storeSaleId" WHERE s."vendorId" = ${vendorId} ORDER BY i."createdAt"`;
    expect(rows).toEqual([
      { offerVariantId: p.dress.variants["أزرق|M"], quantity: 3 },
      { offerVariantId: p.dress.variants["أزرق|S"], quantity: 2 },
      { offerVariantId: p.dress.variants["أحمر|S"], quantity: 4 },
    ]);
  });

  test("a line that ran out meanwhile stops the whole sale and is marked; nothing moves", async ({ page }) => {
    await openStoreAs(page, fixtures.ownerToken);
    const frame = await openCashier(page);
    await scan(frame, "4006381333931");
    await pick(frame, "أزرق", "S", 2);
    await pick(frame, "أحمر", "S", 3);
    // someone sold red S meanwhile: 1 left
    await prisma.branchStock.update({ where: { branchId_offerVariantId: { branchId, offerVariantId: p.dress.variants["أحمر|S"] } }, data: { quantity: 1 } });
    await frame.getByTestId("pos-confirm").click();
    await frame.getByTestId("pos-confirm-yes").click();
    await expect(frame.getByTestId("pos-sale-error")).toContainText("لم يُسجَّل شيء", { timeout: 30_000 });
    await expect(frame.getByTestId("pos-line").nth(1)).toHaveClass(/has-problem/);
    await expect(frame.getByTestId("pos-confirm")).toBeDisabled();
    expect(await qtyOf(branchId, p.dress.variants["أزرق|S"])).toBe(3);
    await frame.getByTestId("pos-line").nth(1).getByRole("button", { name: /إزالة/ }).click();
    await frame.getByTestId("pos-line").nth(0).getByRole("button", { name: /إزالة/ }).click();
    await prisma.branchStock.update({ where: { branchId_offerVariantId: { branchId, offerVariantId: p.dress.variants["أحمر|S"] } }, data: { quantity: 3 } });
  });

  test("camera: hidden where no camera can be used; the browser's own detector opens the product; the ZXing reader decodes a real EAN-13 from the camera picture", async ({ browser }) => {
    // no camera at all: only the scanner and typing
    const c1 = await browser.newContext();
    const p1 = await c1.newPage();
    await fakeCamera(p1, { noCamera: true });
    await loginAs(p1, fixtures.ownerToken);
    await enterWorkspace(p1, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await p1.goto(`/vendor/${vendorId}/cashier`);
    await expect(p1.getByTestId("pos-scan")).toBeVisible({ timeout: 30_000 });
    await expect(p1.getByTestId("pos-scan-camera")).toHaveCount(0);
    await c1.close();

    // Chrome / Edge on Android: the browser's BarcodeDetector
    const c2 = await browser.newContext();
    const p2 = await c2.newPage();
    await fakeCamera(p2, { nativeDetector: "SCARF-0001" });
    await loginAs(p2, fixtures.ownerToken);
    await enterWorkspace(p2, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await p2.goto(`/vendor/${vendorId}/cashier`);
    await p2.getByTestId("pos-scan-camera").click();
    // the scan area is in this same screen - no dialog over it
    await expect(p2.getByTestId("pos-scan-camera-view")).toBeVisible();
    await expect(p2.getByRole("dialog")).toHaveCount(0);
    await expect(p2.getByTestId("pos-card")).toContainText("وشاح حرير", { timeout: 30_000 });
    await expect(p2.getByTestId("pos-scan-camera-view")).toHaveCount(0);
    await c2.close();

    // Safari / iPhone and desktops: no BarcodeDetector - the ZXing reader on the camera picture
    const c3 = await browser.newContext();
    const p3 = await c3.newPage();
    await fakeCamera(p3, { nativeDetector: null, code: "4006381333931" });
    await loginAs(p3, fixtures.ownerToken);
    await enterWorkspace(p3, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await p3.goto(`/vendor/${vendorId}/cashier`);
    await p3.getByTestId("pos-scan-camera").click();
    await expect(p3.getByTestId("pos-card")).toContainText("فستان كتان طويل", { timeout: 30_000 });
    await c3.close();
  });

  test("a hidden (INACTIVE) product sells; an unknown code: a clear message, and the owner links it right there", async ({ page }) => {
    await openStoreAs(page, fixtures.ownerToken);
    const frame = await openCashier(page);
    await scan(frame, "HIDDEN-0001");
    await expect(frame.getByTestId("pos-card")).toContainText("مخفي عن المتسوقات", { timeout: 30_000 });
    await scan(frame, "96385074");
    await expect(frame.getByTestId("pos-unknown")).toContainText("غير مرتبط بأي منتج", { timeout: 30_000 });
    await frame.getByTestId("pos-link-open").click();
    const link = frame.getByTestId("pos-link");
    await link.getByLabel("ابحثي باسم المنتج").fill("تنورة");
    await link.getByRole("button", { name: "ربط" }).click();
    await expect(frame.getByTestId("pos-card")).toContainText("تنورة بلا باركود", { timeout: 30_000 });
    await scan(frame, "4006381333932");
    await expect(frame.getByTestId("pos-scan-error")).toContainText("قراءة غير صحيحة");
  });

  test("the product details stay read only; «إدارة الباركود» opens its own screen: generate shows real bars + «أضف إلى صفحة الطباعة»; the print list survives moving and reloading", async ({ page }) => {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers`);
    await page.getByTestId(`offers-details-${p.plain.offerId}`).click();
    await expect(page.getByTestId("details-summary")).toBeVisible({ timeout: 30_000 });
    // read only: no barcode field or button inside the details
    const sections = page.locator(".owner-details-sections");
    await expect(sections.locator("input")).toHaveCount(0);
    await expect(sections.getByRole("button", { name: /إنشاء|ربط|حذف|طباعة/ })).toHaveCount(0);
    await expect(page.getByTestId("details-barcode-line")).toContainText("96385074");

    await page.getByTestId("details-manage-barcodes").click();
    const manager = page.getByTestId("barcodes-manager");
    await expect(manager).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".wzp")).toHaveCount(1);
    await expect(page.getByTestId("wzp-back")).toBeVisible();
    await expect(manager.getByTestId("barcode-generate")).toHaveClass(/pos-btn-primary/);
    await expect(manager.getByTestId("barcode-link-open")).toHaveClass(/pos-btn-secondary/);

    // generate: the number AND the scannable bars at once
    await manager.getByTestId("barcode-generate").click();
    const card = manager.getByTestId("generated-barcode");
    await expect(card).toBeVisible({ timeout: 30_000 });
    const code = (await card.getByTestId("generated-code").textContent())!.trim();
    expect(code).toMatch(/^29\d{11}$/);
    expect(await card.locator("svg[data-testid=barcode-svg] rect").count()).toBeGreaterThan(20);
    await expect(card.locator("svg[data-testid=barcode-svg] text").first()).toBeVisible();
    // one clear button, then «مضاف إلى قائمة الطباعة ✓» and a quiet «فتح صفحة الطباعة» beside it
    await expect(card.getByTestId("generated-add-to-print")).toHaveText("إضافة إلى قائمة الطباعة");
    await card.getByTestId("generated-add-to-print").click();
    await expect(card.getByTestId("generated-add-to-print")).toHaveText("✓ مضاف إلى قائمة الطباعة");
    await expect(card.getByTestId("generated-go-print")).toHaveText("فتح صفحة الطباعة");
    await expect(manager.getByTestId(`barcode-to-print-${code}`)).toBeChecked();

    // link a code by the scanner (ready field + Enter), and add it to the list from its row
    await manager.getByTestId("barcode-link-open").click();
    const input = manager.getByTestId("barcode-add-input");
    await expect(input).toBeFocused();
    await input.fill("036000291452");
    await input.press("Enter");
    await expect(manager.getByTestId("barcode-036000291452")).toContainText("UPC-A", { timeout: 30_000 });
    await manager.getByTestId("barcode-to-print-036000291452").check();

    // to the print page, in the same window, one «رجوع»
    await manager.getByTestId("barcode-print").click();
    await expect(page.getByTestId("labels-screen")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("labels-card")).toHaveCount(2);
    await page.getByTestId("wzp-back").click();
    await expect(page.getByTestId("barcodes-manager")).toBeVisible();

    // the list is kept on this device: other pages, a reload, and back to the print page
    await page.goto(`/vendor/${vendorId}/store-sales`);
    await page.reload();
    await page.goto(`/vendor/${vendorId}/labels`);
    await expect(page.getByTestId("labels-card")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId(`labels-pick-${code}`)).toBeChecked();
  });

  test("«طباعة ملصقات»: a list of cards (several products); some chosen with their copies; copy the chosen codes; a real A4 sheet of 4 x 9 labels of 50 x 30 mm (name, price, bars at their real size, digits), or one thermal label a page", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/labels`);
    const screen = page.getByTestId("labels-screen");
    await expect(screen).toBeVisible({ timeout: 30_000 });
    const cards = page.getByTestId("labels-card");
    for (const [i, name] of ["فستان كتان", "وشاح", "بلوزة مخفية"].entries()) {
      await page.getByTestId("labels-search").fill(name);
      await page.getByTestId("labels-add").first().click();
      await expect(cards).toHaveCount(i + 1);
    }
    await expect(cards).toHaveCount(3);
    // each card shows its label: the name, the price, real bars, the digits
    const first = cards.first();
    await expect(first).toContainText("فستان كتان طويل");
    expect(await first.locator("svg rect").count()).toBeGreaterThan(20);
    await expect(first.locator(".lb-digits")).toHaveText("4006381333931");

    // choose two of the three: 2 copies of the dress, 3 of the scarf
    await page.getByTestId("labels-pick-HIDDEN-0001").uncheck();
    await page.getByTestId("labels-copies-4006381333931").fill("2");
    await page.getByTestId("labels-copies-SCARF-0001").fill("3");
    await expect(page.getByTestId("labels-print")).toContainText("5");

    // the codes of the chosen cards, for another print program
    await page.getByTestId("labels-copy").click();
    // (the system clipboard may hand back Windows line endings)
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe("4006381333931\nSCARF-0001");

    // the price: shown by default (the current one), hidden only when asked
    const price = page.getByTestId("labels-card-preview").first().getByTestId("label-price");
    await expect(price).toContainText("120");
    await page.getByTestId("labels-show-price").uncheck();
    await expect(price).toHaveCount(0);
    await page.getByTestId("labels-show-price").check();
    await expect(price).toContainText("120");

    // the preview on screen is the real sheet
    await expect(page.getByTestId("labels-preview")).toContainText("5 ملصقاً على 1 ورقة");
    await expect(page.getByTestId("labels-preview-sheet-page")).toHaveCount(1);

    // what the printer receives: A4 (the default), 4 x 9 labels of 50 x 30 mm
    await page.emulateMedia({ media: "print" });
    await expect(screen).toBeHidden();
    const sheet = page.getByTestId("labels-sheet");
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId("labels-sheet-page")).toHaveCount(1);
    const printed = sheet.getByTestId("label");
    await expect(printed).toHaveCount(5);
    const mm = (px: number) => (px * 25.4) / 96;
    for (let i = 0; i < 5; i++) {
      const label = printed.nth(i);
      await expect(label).toBeVisible();
      const box = (await label.boundingBox())!;
      expect(mm(box.width)).toBeCloseTo(50, 0);
      expect(mm(box.height)).toBeCloseTo(30, 0);
      expect(await label.locator("svg rect").count()).toBeGreaterThan(20);
      await expect(label.getByTestId("label-price")).toBeVisible();
      await expect(label.locator(".lb-digits")).toBeVisible();
      // name, then price, right above the bars; the digits under them
      const y = async (sel: string) => (await label.locator(sel).boundingBox())!.y;
      expect(await y(".lb-name")).toBeLessThan(await y(".lb-price"));
      expect(await y(".lb-price")).toBeLessThan(await y("svg"));
      expect(await y("svg")).toBeLessThan(await y(".lb-digits"));
    }
    // 4 a row: the 5th label starts the second row
    const at = async (i: number) => (await printed.nth(i).boundingBox())!;
    expect((await at(3)).y).toBeCloseTo((await at(0)).y, 0);
    expect((await at(4)).y).toBeGreaterThan((await at(0)).y + 100);
    expect((await at(4)).x).toBeCloseTo((await at(0)).x, 0);
    // the EAN-13 bars at 100%: 0.33 mm a module (95 modules = 31.35 mm)
    const bars = printed.nth(0).locator("svg");
    await expect(bars).toHaveAttribute("data-module-mm", "0.330");
    await expect(bars).toHaveAttribute("data-modules", "95");
    expect(mm((await bars.boundingBox())!.width)).toBeCloseTo(31.35, 0);
    await expect(printed.nth(0).locator(".lb-digits")).toHaveText("4006381333931");
    await expect(printed.nth(4)).toContainText("SCARF-0001");
    await expect(sheet).not.toContainText("بلوزة مخفية");
    await page.emulateMedia({ media: "screen" });

    // more than 36: a second A4 page
    await page.getByTestId("labels-copies-SCARF-0001").fill("35");
    await expect(page.getByTestId("labels-preview-sheet-page")).toHaveCount(2);
    await expect(page.getByTestId("labels-preview-sheet-page").first().getByTestId("preview-label")).toHaveCount(36);
    await page.getByTestId("labels-copies-SCARF-0001").fill("3");

    // a thermal printer: one 50 x 30 mm label a page
    await page.getByTestId("labels-size-thermal").check();
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("labels-sheet-page")).toHaveCount(5);
    const thermal = (await page.getByTestId("labels-sheet-page").first().boundingBox())!;
    expect(mm(thermal.width)).toBeCloseTo(50, 0);
    expect(mm(thermal.height)).toBeCloseTo(30, 0);
    await page.emulateMedia({ media: "screen" });

    // «طباعة المحدد» opens the system print dialog (never a silent print)
    await page.evaluate(() => {
      (window as unknown as { __printed: number }).__printed = 0;
      window.print = () => {
        (window as unknown as { __printed: number }).__printed += 1;
      };
    });
    await page.getByTestId("labels-print").click();
    expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
  });

  test("a printed EAN-13 label stays scannable: the A4 label at 100% (288 dpi) decodes back to its code", async ({ browser }) => {
    const ctx = await browser.newContext({ deviceScaleFactor: 3 });
    const page = await ctx.newPage();
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/labels`);
    await expect(page.getByTestId("labels-screen")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("labels-search").fill("فستان كتان");
    await page.getByTestId("labels-add").first().click();
    await expect(page.getByTestId("labels-card")).toHaveCount(1);
    await page.emulateMedia({ media: "print" });
    const label = page.getByTestId("labels-sheet").getByTestId("label").first();
    await expect(label).toBeVisible();
    const png = await label.screenshot();
    const { data, info } = await sharpRaw(png);
    const zx = createRequire(__filename)("@zxing/library") as typeof import("@zxing/library");
    const hints = new Map<import("@zxing/library").DecodeHintType, unknown>([
      [zx.DecodeHintType.POSSIBLE_FORMATS, [zx.BarcodeFormat.EAN_13]],
      [zx.DecodeHintType.TRY_HARDER, true],
    ]);
    const reader = new zx.MultiFormatReader();
    const result = reader.decode(new zx.BinaryBitmap(new zx.HybridBinarizer(new zx.RGBLuminanceSource(new Uint8ClampedArray(data), info.width, info.height))), hints);
    expect(result.getText()).toBe("4006381333931");
    await ctx.close();
  });

  test("the wizard: «باركود المنتج للمحل» right under the price, two choices only; a draft saves without it but cannot be published; generating shows the bars and adds it to the print page; published with that code", async ({ page }) => {
    await call(`/vendors/${vendorId}/storefront/catalogue`, { method: "PUT", token: fixtures.ownerToken, body: { departments: ["WOMEN"], categories: { WOMEN: ["DRESSES_WOMEN"] } } });
    const jpeg = await sharp({ create: { width: 60, height: 80, channels: 3, background: { r: 180, g: 150, b: 120 } } }).jpeg().toBuffer();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "dress.jpg");
    const up = await fetch(`${process.env.PW_API_BASE_URL}/vendors/${vendorId}/uploads`, { method: "POST", headers: { Authorization: `Bearer ${fixtures.ownerToken}` }, body: form });
    const image = ((await up.json()) as { url: string }).url;
    const title = `فستان باركود ${unique("w").slice(-5)}`;
    // the draft is SAVED without a barcode
    const draft = await call<{ id: string }>(`/vendors/${vendorId}/offer-drafts`, {
      method: "POST",
      token: fixtures.ownerToken,
      body: {
        payload: {
          layout: 5, step: 5, audience: "WOMEN", category: "DRESSES_WOMEN", title_ar: title, brand: { mode: "none" },
          colors: [{ key: "BEIGE", family: "BEIGE", name_ar: "بيج", images: [image] }], size_system: "LETTER", sizes: { BEIGE: ["S"] }, price: 150,
          stock: { [branchId]: { "BEIGE|S": 2 } },
        },
      },
    });
    expect(draft.status).toBe(201);
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers/drafts/${draft.body.id}`);
    const field = page.getByTestId("wz-store-barcode");
    await expect(field).toContainText("باركود المنتج للمحل", { timeout: 30_000 });
    await expect(field).toContainText("مطلوب للنشر");
    // right under the price, before the stock line
    const order = await page.evaluate(() => {
      const at = (sel: string) => Array.from(document.querySelectorAll("*")).indexOf(document.querySelector(sel)!);
      return [at('[data-testid="wz-summary-price"]'), at('[data-testid="wz-store-barcode"]'), at('[data-testid="wz-summary-stock"]')];
    });
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    // two choices only - no «later»
    await expect(field.getByRole("radio")).toHaveCount(2);
    await expect(field.getByText("سأضيفه لاحقاً")).toHaveCount(0);
    // the publish gate says why
    await expect(page.getByTestId("wz-missing")).toContainText("أضيفي باركوداً للمنتج قبل النشر", { timeout: 30_000 });
    await expect(page.getByTestId("wz-publish")).toBeDisabled();

    // a code already used by «فستان كتان طويل»: named, kept
    await field.getByTestId("wzb-external").check();
    const input = field.getByTestId("wzb-code");
    await input.fill("4006381333931");
    await input.press("Enter");
    await expect(field.getByTestId("wzb-problem")).toContainText("فستان كتان طويل", { timeout: 30_000 });
    await expect(page.getByTestId("wz-publish")).toBeDisabled();

    // «إنشاء باركود من النظام»: the code now, as real bars, and onto the print page
    // (the choice is marked once the server has given the code)
    await field.getByTestId("wzb-generate").click();
    const card = field.getByTestId("generated-barcode");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(field.getByTestId("wzb-generate")).toBeChecked();
    const code = (await card.getByTestId("generated-code").textContent())!.trim();
    expect(code).toMatch(/^29\d{11}$/);
    expect(await card.locator("svg rect").count()).toBeGreaterThan(20);
    // one clear button, then «مضاف إلى قائمة الطباعة ✓» and a quiet «فتح صفحة الطباعة» beside it
    await expect(card.getByTestId("generated-add-to-print")).toHaveText("إضافة إلى قائمة الطباعة");
    await card.getByTestId("generated-add-to-print").click();
    await expect(card.getByTestId("generated-add-to-print")).toHaveText("✓ مضاف إلى قائمة الطباعة");
    await expect(card.getByTestId("generated-go-print")).toHaveText("فتح صفحة الطباعة");
    await expect
      .poll(async () => ((await prisma.offerDraft.findUniqueOrThrow({ where: { id: draft.body.id } })).payload as { store_barcode?: unknown }).store_barcode, { timeout: 15_000 })
      .toEqual({ mode: "generate", code });
    await expect(page.getByTestId("wz-publish")).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("wz-publish").click();
    await expect
      .poll(async () => (await prisma.offerDraft.findUniqueOrThrow({ where: { id: draft.body.id } })).offerId, { timeout: 30_000 })
      .not.toBeNull();
    const offerId = (await prisma.offerDraft.findUniqueOrThrow({ where: { id: draft.body.id } })).offerId!;
    const codes = await prisma.$queryRaw<{ code: string; source: string; isPrimary: boolean }[]>`SELECT code, source::text AS source, "isPrimary" FROM offer_barcodes WHERE "vendorOfferId" = ${offerId}`;
    expect(codes).toEqual([{ code, source: "GENERATED", isPrimary: true }]);

    // the print page has it, now as the published product
    await page.goto(`/vendor/${vendorId}/labels`);
    const printed = page.getByTestId("labels-card");
    await expect(printed).toHaveCount(1, { timeout: 30_000 });
    await expect(printed).toContainText(title);
    await expect(printed).not.toContainText("مسودة لم تُنشر", { timeout: 30_000 });
  });

  test("import: barcodes are completed on the check itself (typed in the card, or generated for the chosen ones) before any draft; the batch then has only its drafts, a fixed bar adds the chosen labels to the print list and publishes", async ({ page }) => {
    const branchName = (await prisma.storeBranch.findUniqueOrThrow({ where: { id: branchId } })).name;
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/offers`);
    await page.getByRole("link", { name: "استيراد ملف CSV/XLSX" }).click();
    await expect(page.getByTestId("wz-panel")).toHaveAttribute("data-view", "import");
    const drafts0 = await prisma.offerDraft.count({ where: { vendorId } });
    await chooseImportFiles(
      page,
      await importFiles(branchName, [
        { title: "فستان بباركود الملف", color: "أحمر", family: "أحمر", barcode: "9780201379624" },
        { title: "فستان يُكتب باركوده", color: "أزرق", family: "أزرق", barcode: "5901234123458" },
        { title: "فستان يُنشأ باركوده", color: "أسود", family: "أسود" },
        { title: "فستان لم يُختر", color: "أحمر", family: "أحمر" },
      ], 70),
    );
    await page.getByTestId("import-check-button").click();
    const check = page.getByTestId("import-check");
    await expect(check).toBeVisible({ timeout: 60_000 });

    // the fixed head: nothing created yet, the counts, the ONE action at the top
    await expect(check).toContainText("لم يُنشأ شيء بعد.");
    await expect(page.getByTestId("import-count-ready")).toHaveText("جاهز: 1");
    await expect(page.getByTestId("import-count-barcode")).toHaveText("يحتاج باركوداً: 3");
    await expect(page.getByTestId("import-count-rejected")).toHaveText("مرفوض لأسباب أخرى: 0");
    await expect(page.getByTestId("import-create")).toHaveText("إنشاء 1 مسودات مكتملة غير منشورة");
    await expect(page.getByTestId("import-section-rejected")).toHaveCount(0);
    const head = page.locator(".imp-check-sticky");
    await expect(head).toHaveCSS("position", "sticky");
    const fix = page.getByTestId("import-section-barcode");
    // the head (with its action) comes before every part, and stays in view while they scroll
    expect(await head.evaluate((h) => Boolean(h.compareDocumentPosition(document.querySelector('[data-testid="import-section-barcode"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await fix.getByTestId("import-product-4").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("import-create")).toBeInViewport();

    // «تحتاج باركوداً قبل إنشاء المسودة»: not rejected - a reason and a field in each card
    await expect(fix.getByTestId("import-barcode-reason-2")).toContainText("خانة التحقق");
    await expect(fix.getByTestId("import-barcode-reason-3")).toHaveText("لم يُدخل باركود لهذا المنتج.");
    await expect(fix.getByTestId("import-barcode-reason-4")).toHaveText("لم يُدخل باركود لهذا المنتج.");
    // typed / scanned in the card: checked at once (shape, then duplicates), then the card is ready
    const field = fix.getByTestId("import-barcode-input-2");
    await field.fill("9780201379624");
    await field.press("Enter");
    await expect(fix.getByTestId("import-barcode-error-2")).toContainText("فستان بباركود الملف", { timeout: 30_000 });
    await field.fill("55123458");
    await field.press("Enter");
    await expect(fix.getByTestId("import-barcode-error-2")).toContainText("خانة التحقق", { timeout: 30_000 });
    await field.fill("55123457");
    await field.press("Enter");
    await expect(fix.getByTestId("import-barcode-ok-2")).toBeVisible({ timeout: 30_000 });
    await expect(fix.getByTestId("import-product-2")).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("import-choose-2")).toBeChecked();
    await expect(page.getByTestId("import-count-barcode")).toHaveText("يحتاج باركوداً: 2");
    await expect(page.getByTestId("import-create")).toHaveText("إنشاء 2 مسودات مكتملة غير منشورة");

    // generated by the system for the CHOSEN ones only (4 is unticked)
    await page.getByTestId("import-barcode-pick-4").uncheck();
    await expect(page.getByTestId("import-barcode-generate")).toHaveText("إنشاء باركودات من النظام لـ 1 منتجات");
    await page.getByTestId("import-barcode-generate").click();
    const generated = fix.getByTestId("import-barcode-ok-3");
    await expect(generated).toBeVisible({ timeout: 30_000 });
    expect(await generated.locator("svg rect").count()).toBeGreaterThan(20);
    await expect(fix.getByTestId("import-product-4")).toHaveAttribute("data-state", "needs_barcode");
    await expect(page.getByTestId("import-create")).toHaveText("إنشاء 3 مسودات مكتملة غير منشورة");
    // still nothing created
    expect(await prisma.offerDraft.count({ where: { vendorId } })).toBe(drafts0);

    // the complete drafts -> «دفعة الاستيراد» with THESE drafts only
    await page.getByTestId("import-create").click();
    const screen = page.getByTestId("import-batch");
    await expect(screen.locator('[data-testid^="bp-card-"]')).toHaveCount(3, { timeout: 30_000 });
    for (const ref of ["1", "2", "3"]) await expect(screen.getByTestId(`bp-barcode-${ref}`)).toHaveText("باركود جاهز");
    await screen.getByTestId("bp-not-created").locator("summary").click();
    await expect(screen.getByTestId("bp-not-created")).toContainText("فستان لم يُختر");
    await expect(screen.getByTestId("bp-not-created")).toContainText("لم يُكمَل باركوده");
    const [gen] = await prisma.$queryRaw<{ code: string }[]>`
      SELECT payload->'store_barcode'->>'code' AS code FROM offer_drafts WHERE "vendorId" = ${vendorId} AND payload->>'title_ar' = 'فستان يُنشأ باركوده'`;
    expect(gen.code).toMatch(/^29\d{11}$/);

    // the fixed bar right above the cards: «محدد X من Y», labels of the chosen ones, publish
    const bar = screen.getByTestId("bp-bar");
    expect(await bar.evaluate((b) => Boolean(b.compareDocumentPosition(document.querySelector('[data-testid="bp-card-1"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await expect(bar).toContainText("محدد 0 من 3");
    await screen.getByTestId("bp-choose-2").check();
    await screen.getByTestId("bp-choose-3").check();
    await expect(bar).toContainText("محدد 2 من 3");
    await bar.getByTestId("bp-add-labels").click();
    const toast = bar.getByTestId("bp-labels-toast");
    await expect(toast).toContainText("أُضيفت 2 ملصقات إلى قائمة الطباعة.");
    await expect(toast).not.toContainText("تمت الطباعة");
    await expect(toast.getByTestId("bp-open-print")).toHaveText("فتح صفحة الطباعة");
    const list = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("fp.printlist.")).map((k) => localStorage.getItem(k)).join(""));
    expect(list).toContain(gen.code);
    expect(list).toContain("55123457");
    expect(list).not.toContain("9780201379624");

    // publish the chosen: the preflight and the confirmation as before
    await screen.getByTestId("bp-select-all").check();
    await expect(bar).toContainText("محدد 3 من 3");
    await bar.getByTestId("bp-publish-selected").click();
    await expect(page.getByTestId("bp-pre-ready")).toContainText("3", { timeout: 30_000 });
    await page.getByTestId("bp-preflight").getByTestId("bp-confirm").click();
    await page.getByTestId("small-confirm").getByTestId("small-confirm-ok").click();
    await expect(page.getByTestId("bp-count-published")).toContainText("3", { timeout: 60_000 });
    const codes = await prisma.$queryRaw<{ title: string; code: string; source: string }[]>`
      SELECT o."titleAr" AS title, b.code, b.source::text AS source FROM offer_barcodes b JOIN vendor_offers o ON o.id = b."vendorOfferId"
       WHERE b."vendorId" = ${vendorId} AND o."titleAr" LIKE 'فستان %باركود%' ORDER BY o."titleAr"`;
    expect(codes).toEqual(
      expect.arrayContaining([
        { title: "فستان بباركود الملف", code: "9780201379624", source: "EXTERNAL" },
        { title: "فستان يُكتب باركوده", code: "55123457", source: "EXTERNAL" },
        { title: "فستان يُنشأ باركوده", code: gen.code, source: "GENERATED" },
      ]),
    );
    // after publishing: their labels, now as published products
    await page.getByTestId("bp-print-labels").getByRole("button").click();
    await expect(page.getByTestId("labels-screen")).toBeVisible({ timeout: 30_000 });
    const card = page.getByTestId("labels-card").filter({ hasText: "فستان يُنشأ باركوده" });
    await expect(card).toHaveCount(1);
    await expect(card).not.toContainText("مسودة لم تُنشر", { timeout: 30_000 });
    await expect(page.getByTestId("labels-draft-note")).toHaveCount(0);
  });

  test("an employee: the barcode icon in their header, their own branch only, no linking; a shopper sees no cashier icon", async ({ page, browser }) => {
    const employee = await account();
    await prisma.vendorUser.create({ data: { userId: employee.id, vendorId, role: "BRANCH_EMPLOYEE", branchId } });
    await openStoreAs(page, employee.token);
    const frame = await openCashier(page);
    await expect(frame.getByTestId("pos-branch-name")).toBeVisible();
    await expect(frame.getByTestId("pos-branch")).toHaveCount(0);
    await scan(frame, "CODE-NOBODY");
    await expect(frame.getByTestId("pos-unknown")).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByTestId("pos-link-open")).toHaveCount(0);
    await scan(frame, "SCARF-0001");
    await frame.getByTestId("pos-add").click();
    await frame.getByTestId("pos-confirm").click();
    await frame.getByTestId("pos-confirm-yes").click();
    await expect(frame.getByTestId("pos-done")).toBeVisible({ timeout: 30_000 });
    expect(await qtyOf(branchId, p.scarf.variants["وردي|مقاس واحد"])).toBe(8);

    const shopperCtx = await browser.newContext();
    const shopperPage = await shopperCtx.newPage();
    const shopper = await account();
    await loginAs(shopperPage, shopper.token);
    await shopperPage.goto(`/store/${slug}`);
    await expect(shopperPage.locator(".store-topbar-actions")).toBeVisible({ timeout: 30_000 });
    await expect(shopperPage.getByTestId("store-cashier-button")).toHaveCount(0);
    await shopperCtx.close();
  });

  // 2026-11-22 («إدارة مخزون الفرع v1»): the stock screen has no sale at all
  // (the server refuses a manual SALE too) - its movements are receive, count,
  // damage or loss, and «إخراج غير بيع»; it points to the cashier for a sale.
  test("the stock screen records no sale: its movements never include a sale, and it points to the cashier", async ({ page }) => {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/branches/${branchId}/stock`);
    await expect(page.getByTestId("stock-sale-note")).toContainText("لا تسجّل بيعاً", { timeout: 30_000 });
    await expect(page.getByTestId("stock-open-cashier")).toHaveAttribute("href", `/vendor/${vendorId}/cashier`);
    await page.locator('[data-testid^="stock-row-"]').first().click({ timeout: 30_000 });
    const bar = page.getByTestId("sk-actionbar");
    await expect(bar).toBeVisible({ timeout: 30_000 });
    expect(await bar.locator("button").allTextContents()).toEqual(["استلام", "جرد", "تلف أو فقدان", "إخراج غير بيع"]);
  });

  test("«مبيعات المحل»: the owner voids a whole sale with a reason and the stock comes back", async ({ page }) => {
    await loginAs(page, fixtures.ownerToken);
    await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
    await page.goto(`/vendor/${vendorId}/store-sales`);
    await expect(page.getByTestId("store-sales-summary")).toBeVisible({ timeout: 30_000 });
    const first = page.getByTestId("store-sale").first();
    const before = await qtyOf(branchId, p.scarf.variants["وردي|مقاس واحد"]);
    await first.getByTestId("store-sale-void").click();
    await page.getByTestId("store-sale-void-reason").fill("سُجّل خطأ");
    await page.getByTestId("store-sale-void-confirm").click();
    await expect(page.getByRole("status").first()).toContainText("أُلغي البيع", { timeout: 30_000 });
    expect(await qtyOf(branchId, p.scarf.variants["وردي|مقاس واحد"])).toBe(before + 1);
  });

  test("English is left-to-right, and the cashier fits a phone with the sale bar in view", async ({ page }) => {
    const owner = await prisma.vendorUser.findFirstOrThrow({ where: { vendorId, role: "OWNER" }, select: { userId: true } });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("finalpro_lang_pref", "en"));
    await prisma.user.update({ where: { id: owner.userId }, data: { languagePref: "en" } });
    try {
      await loginAs(page, fixtures.ownerToken);
      await enterWorkspace(page, fixtures.ownerToken, { type: "vendor", vendor_id: vendorId });
      await page.goto(`/vendor/${vendorId}/cashier`);
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 30_000 });
      await expect(page.getByRole("heading", { name: "In-store sale" })).toBeVisible({ timeout: 30_000 });
      await scan(page, "SCARF-0001");
      await page.getByTestId("pos-add").click();
      await expect(page.locator(".pos-mobile-bar")).toBeVisible();
      await expect(page.locator(".pos-mobile-bar")).toContainText("1 lines · 1 items");
      await expectNoHorizontalOverflow(page);
    } finally {
      await prisma.user.update({ where: { id: owner.userId }, data: { languagePref: "ar" } });
    }
  });

  test("with the feature off the owner keeps «مشاركة» and no cashier icon", async ({ page }) => {
    await setFlag(false);
    try {
      await openStoreAs(page, fixtures.ownerToken);
      await expect(page.getByRole("button", { name: "مشاركة المتجر" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("store-cashier-button")).toHaveCount(0);
    } finally {
      await setFlag(true);
    }
  });
});
