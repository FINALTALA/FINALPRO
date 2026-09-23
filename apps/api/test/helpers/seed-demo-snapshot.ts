import { PrismaClient } from '../../generated/prisma/client';
import {
  DEMO,
  VENDOR_ONE,
  VENDOR_TWO,
  BRAND_NORMALIZED_NAME,
  CATEGORY_NAME_EN,
  CANONICAL_GTIN,
  OFFER_ONE_SELLER_SKU,
  OFFER_TWO_SELLER_SKU,
  DEMO_ADDRESS_LABEL,
} from '../../scripts/seed-demo.constants';

/**
 * Row counts scoped to the demo's own known unique keys (phones, slugs,
 * SKUs, ...) - not blanket table counts - so comparisons stay correct
 * against a shared dev database that already holds unrelated rows.
 */
export async function snapshotDemoCounts(prisma: PrismaClient) {
  const phones = [DEMO.owner.phone, DEMO.employee.phone, DEMO.customer.phone];
  const slugs = [VENDOR_ONE.slug, VENDOR_TWO.slug];

  const users = await prisma.user.findMany({
    where: { phone: { in: phones } },
  });
  const userIds = users.map((u) => u.id);
  const vendors = await prisma.vendor.findMany({
    where: { slug: { in: slugs } },
  });
  const vendorIds = vendors.map((v) => v.id);

  return {
    users: users.length,
    customerProfiles: await prisma.customerProfile.count({
      where: { userId: { in: userIds } },
    }),
    vendors: vendors.length,
    vendorSubscriptions: await prisma.vendorSubscription.count({
      where: { vendorId: { in: vendorIds } },
    }),
    vendorUsers: await prisma.vendorUser.count({
      where: { userId: { in: userIds }, vendorId: { in: vendorIds } },
    }),
    applicableCategories: await prisma.vendorApplicableCategory.count({
      where: { vendorId: { in: vendorIds } },
    }),
    branches: await prisma.storeBranch.count({
      where: { vendorId: { in: vendorIds } },
    }),
    deliveryWindows: await prisma.deliveryWindow.count({
      where: { vendorId: { in: vendorIds } },
    }),
    deliveryZones: await prisma.vendorDeliveryZone.count({
      where: { vendorId: { in: vendorIds } },
    }),
    brands: await prisma.brand.count({
      where: { normalizedName: BRAND_NORMALIZED_NAME },
    }),
    categories: await prisma.category.count({
      where: { nameEn: CATEGORY_NAME_EN },
    }),
    canonicalProducts: await prisma.canonicalProduct.count({
      where: { brand: { normalizedName: BRAND_NORMALIZED_NAME } },
    }),
    canonicalVariants: await prisma.canonicalProductVariant.count({
      where: { gtin: CANONICAL_GTIN },
    }),
    vendorOffers: await prisma.vendorOffer.count({
      where: { vendorId: { in: vendorIds } },
    }),
    offerVariants: await prisma.offerVariant.count({
      where: {
        vendorId: { in: vendorIds },
        sellerSku: { in: [OFFER_ONE_SELLER_SKU, OFFER_TWO_SELLER_SKU] },
      },
    }),
    branchStock: await prisma.branchStock.count({
      where: { vendorId: { in: vendorIds } },
    }),
    addresses: await prisma.address.count({
      where: {
        label: DEMO_ADDRESS_LABEL,
        customer: { userId: { in: userIds } },
      },
    }),
  };
}
