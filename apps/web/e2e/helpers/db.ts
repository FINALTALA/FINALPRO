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
