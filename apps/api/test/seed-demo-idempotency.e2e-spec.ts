import { execFileSync } from 'child_process';
import * as path from 'path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
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
} from '../scripts/seed-demo.constants';

const API_ROOT = path.resolve(__dirname, '..');

/**
 * Sprint 12: proves scripts/seed-demo.ts's own idempotency claim by
 * actually running the real script (not an imported function - the
 * exact command a developer would type) TWICE against a real database,
 * and asserting every demo-created row count is identical after both
 * runs. Scoped to the demo's own known unique keys (phones, slugs,
 * SKUs, etc.) throughout, not blanket table counts, so this stays
 * correct even against a shared dev database that already has
 * unrelated rows in every one of these tables.
 */
describe('Sprint 12 demo seed idempotency', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set for this test run');
    }
    prisma = new PrismaClient({ adapter: new PrismaPg(connectionString) });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function snapshotDemoCounts() {
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

  it('running the seed script twice produces identical demo-data row counts - no duplication', async () => {
    const runSeed = () =>
      execFileSync('npx', ['ts-node', 'scripts/seed-demo.ts'], {
        cwd: API_ROOT,
        env: process.env,
        stdio: 'pipe',
      });

    runSeed();
    const afterFirst = await snapshotDemoCounts();
    // Every count must be strictly positive - a zero here would mean
    // the seed silently failed to create something, not that
    // idempotency held.
    for (const value of Object.values(afterFirst)) {
      expect(value).toBeGreaterThan(0);
    }

    runSeed();
    const afterSecond = await snapshotDemoCounts();
    expect(afterSecond).toEqual(afterFirst);
  }, 120_000);
});
