import { PrismaPg } from "@prisma/adapter-pg";
// Sprint 21 (review-round point 1): the ONLY two fixture steps this
// Playwright suite cannot reach over HTTP - granting PLATFORM_ADMIN
// (no self-service endpoint exists, same as every Jest e2e spec that
// needs one) and creating an offer/stock to sell (a whole separate
// catalog-authoring UI/flow this sprint does not touch). Reuses the
// SAME generated Prisma client apps/api's own tests use, via a
// relative import across the monorepo checkout - test-only tooling,
// never shipped.
import { PrismaClient } from "../../../api/generated/prisma/client";

const DATABASE_URL = process.env.PW_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "PW_DATABASE_URL (or DATABASE_URL) must be set - the Playwright DB fixtures connect directly, the same way apps/api's own PrismaService does",
  );
}

export const prisma = new PrismaClient({ adapter: new PrismaPg(DATABASE_URL) });

export async function grantPlatformAdmin(phone: string): Promise<void> {
  await prisma.user.update({
    where: { phone },
    data: { platformRole: "PLATFORM_ADMIN" },
  });
}

export async function makeVendorEligible(vendorId: string): Promise<void> {
  await prisma.vendor.update({
    where: { id: vendorId },
    data: {
      status: "ACTIVE",
      subscriptionStatus: "ACTIVE",
      storefrontPublished: true,
    },
  });
  await prisma.storeBranch.updateMany({
    where: { vendorId },
    data: { verificationStatus: "APPROVED" },
  });
}

let skuSeq = 0;
export async function createOfferWithStock(
  vendorId: string,
  branchId: string,
  price: number,
  quantity: number,
): Promise<string> {
  skuSeq += 1;
  await makeVendorEligible(vendorId);
  const offer = await prisma.vendorOffer.create({
    data: { vendorId, titleAr: "منتج تجريبي", titleEn: "Test product", status: "ACTIVE" },
  });
  const variant = await prisma.offerVariant.create({
    data: {
      vendorId,
      vendorOfferId: offer.id,
      sellerSku: `pw-sku-${Date.now()}-${skuSeq}`,
      basePrice: price,
      storeInventoryBarcode: `pw-barcode-${Date.now()}-${skuSeq}`,
    },
  });
  await prisma.branchStock.create({
    data: { vendorId, branchId, offerVariantId: variant.id, quantity },
  });
  return variant.id;
}

/** Sprint 21b (EPIC-RET): two variants of the SAME VendorOffer, each
 * with its own branch stock - the replacement-eligible shape the
 * exchange flow requires (see returns.service.ts's own
 * validateReplacementVariantAndBranch(), which rejects a replacement
 * that isn't a sibling variant of the original item's offer). */
export async function createOfferWithTwoVariants(
  vendorId: string,
  branchId: string,
  originalPrice: number,
  originalQty: number,
  replacementPrice: number,
  replacementQty: number,
): Promise<{ originalVariantId: string; replacementVariantId: string }> {
  skuSeq += 1;
  await makeVendorEligible(vendorId);
  const offer = await prisma.vendorOffer.create({
    data: { vendorId, titleAr: "منتج تجريبي", titleEn: "Test product", status: "ACTIVE" },
  });
  const original = await prisma.offerVariant.create({
    data: {
      vendorId,
      vendorOfferId: offer.id,
      colour: "أحمر",
      sellerSku: `pw-sku-${Date.now()}-${skuSeq}-a`,
      basePrice: originalPrice,
      storeInventoryBarcode: `pw-barcode-${Date.now()}-${skuSeq}-a`,
    },
  });
  const replacement = await prisma.offerVariant.create({
    data: {
      vendorId,
      vendorOfferId: offer.id,
      colour: "أزرق",
      sellerSku: `pw-sku-${Date.now()}-${skuSeq}-b`,
      basePrice: replacementPrice,
      storeInventoryBarcode: `pw-barcode-${Date.now()}-${skuSeq}-b`,
    },
  });
  await prisma.branchStock.create({
    data: { vendorId, branchId, offerVariantId: original.id, quantity: originalQty },
  });
  await prisma.branchStock.create({
    data: { vendorId, branchId, offerVariantId: replacement.id, quantity: replacementQty },
  });
  return { originalVariantId: original.id, replacementVariantId: replacement.id };
}

// Sprint 24 (FR-FAV-001/FR-COMP-*): a CONFIRMED-match offer, same
// shape `createOfferWithStock` above builds but additionally linked
// to a real CanonicalProduct/CanonicalProductVariant - the one
// eligibility bar FavoritesService.add()/ComparisonService both
// require (OfferVariant.canonicalVariantId set), which the plain
// unmatched fixture above deliberately does not satisfy.
let matchedSeq = 0;
export async function createMatchedOfferWithStock(
  vendorId: string,
  branchId: string,
  price: number,
  quantity: number,
): Promise<{ canonicalProductId: string; offerVariantId: string }> {
  matchedSeq += 1;
  await makeVendorEligible(vendorId);
  const brand = await prisma.brand.create({
    data: { name: `PW Brand ${matchedSeq}`, normalizedName: `pw-brand-${Date.now()}-${matchedSeq}` },
  });
  const category = await prisma.category.create({
    data: { nameAr: "فئة تجريبية", nameEn: `PW Category ${matchedSeq}` },
  });
  const canonicalProduct = await prisma.canonicalProduct.create({
    data: {
      brandId: brand.id,
      categoryId: category.id,
      modelName: `PW Model ${Date.now()}-${matchedSeq}`,
      canonicalNameAr: "منتج تجريبي للمقارنة",
      canonicalNameEn: "PW comparison product",
      status: "PUBLISHED",
    },
  });
  const canonicalVariant = await prisma.canonicalProductVariant.create({
    data: {
      canonicalProductId: canonicalProduct.id,
      structuralAttributes: {},
      platformProductBarcode: `pw-platform-${Date.now()}-${matchedSeq}`,
    },
  });
  const offer = await prisma.vendorOffer.create({
    data: { vendorId, titleAr: "منتج تجريبي", titleEn: "Test product", status: "ACTIVE" },
  });
  const variant = await prisma.offerVariant.create({
    data: {
      vendorId,
      vendorOfferId: offer.id,
      sellerSku: `pw-matched-sku-${Date.now()}-${matchedSeq}`,
      basePrice: price,
      storeInventoryBarcode: `pw-matched-barcode-${Date.now()}-${matchedSeq}`,
      canonicalVariantId: canonicalVariant.id,
    },
  });
  await prisma.branchStock.create({
    data: { vendorId, branchId, offerVariantId: variant.id, quantity },
  });
  return { canonicalProductId: canonicalProduct.id, offerVariantId: variant.id };
}

export async function itemIdForOrder(branchOrderId: string): Promise<string> {
  const item = await prisma.branchOrderItem.findFirstOrThrow({
    where: { branchOrderId },
  });
  return item.id;
}

export async function escalateReturn(returnId: string): Promise<void> {
  await prisma.return.update({
    where: { id: returnId },
    data: { status: "ESCALATED", escalatedAt: new Date() },
  });
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
