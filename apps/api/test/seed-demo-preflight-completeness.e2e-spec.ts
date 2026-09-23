import { execFileSync } from 'child_process';
import * as path from 'path';
import * as bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import {
  DEMO,
  VENDOR_ONE,
  CANONICAL_PLATFORM_BARCODE,
  OFFER_ONE_SELLER_SKU,
  BRANCH_ONE_A_NAME,
} from '../scripts/seed-demo.constants';
import { snapshotDemoCounts } from './helpers/seed-demo-snapshot';

const API_ROOT = path.resolve(__dirname, '..');
const BASE_DB = 'finalpro_seedpreflight_test_base';
const SCENARIO_DBS = ['s1', 's2', 's3', 's4'].map(
  (s) => `finalpro_seedpreflight_test_${s}`,
);

function urlForDb(dbName: string): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function runSeed(databaseUrl: string): { ok: boolean; output: string } {
  try {
    const out = execFileSync('npx', ['ts-node', 'scripts/seed-demo.ts'], {
      cwd: API_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
      timeout: 90_000,
    });
    return { ok: true, output: out.toString() };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    return {
      ok: false,
      output: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? ''),
    };
  }
}

/**
 * Round-3 review: the preflight must catch every state that would make
 * a later create() fail with a raw PostgreSQL/Prisma constraint error
 * (employee-uniqueness index, platform-barcode and store-barcode
 * uniqueness, delivery-window EXCLUDE) and report DEMO_SEED_CONFLICT
 * instead. Each scenario runs against its own throwaway database
 * (cloned from one migrated template) so "no partial demo data" is
 * proven from a genuinely empty starting state.
 */
describe('Sprint 12 demo seed preflight completeness', () => {
  let admin: PrismaClient;

  async function scenarioDb(dbName: string): Promise<PrismaClient> {
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${dbName}" TEMPLATE "${BASE_DB}"`,
    );
    return new PrismaClient({ adapter: new PrismaPg(urlForDb(dbName)) });
  }

  async function assertNothingElseCreated(prisma: PrismaClient) {
    const counts = await snapshotDemoCounts(prisma);
    expect(counts.customerProfiles).toBe(0);
    expect(counts.vendorSubscriptions).toBe(0);
    expect(counts.vendorUsers).toBe(0);
    expect(counts.deliveryZones).toBe(0);
    expect(counts.offerVariants).toBe(0);
    expect(counts.branchStock).toBe(0);
    expect(counts.addresses).toBe(0);
    expect(counts.brands).toBe(0);
    expect(counts.canonicalProducts).toBe(0);
  }

  beforeAll(async () => {
    admin = new PrismaClient({
      adapter: new PrismaPg(process.env.DATABASE_URL as string),
    });
    for (const db of [BASE_DB, ...SCENARIO_DBS]) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}"`);
    }
    await admin.$executeRawUnsafe(`CREATE DATABASE "${BASE_DB}"`);
    execFileSync(
      'npx',
      ['prisma', 'migrate', 'deploy', '--config', 'prisma7.config.ts'],
      {
        cwd: API_ROOT,
        env: { ...process.env, DATABASE_URL: urlForDb(BASE_DB) },
        stdio: 'pipe',
        timeout: 120_000,
      },
    );
  }, 180_000);

  afterAll(async () => {
    for (const db of [...SCENARIO_DBS, BASE_DB]) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}"`);
    }
    await admin.$disconnect();
  });

  it('rejects when the demo employee is already a BRANCH_EMPLOYEE at another vendor', async () => {
    const prisma = await scenarioDb(SCENARIO_DBS[0]);
    try {
      const employee = await prisma.user.create({
        data: {
          phone: DEMO.employee.phone,
          passwordHash: await bcrypt.hash(DEMO.employee.password, 10),
          phoneVerifiedAt: new Date(),
        },
      });
      await prisma.customerProfile.create({
        data: { userId: employee.id, displayName: DEMO.employee.displayName },
      });
      const other = await prisma.vendor.create({
        data: { slug: 'other-store', legalName: 'Other', status: 'ACTIVE' },
      });
      const otherBranch = await prisma.storeBranch.create({
        data: { vendorId: other.id, name: 'Other branch' },
      });
      const membership = await prisma.vendorUser.create({
        data: {
          userId: employee.id,
          vendorId: other.id,
          role: 'BRANCH_EMPLOYEE',
          branchId: otherBranch.id,
        },
      });

      const before = await snapshotDemoCounts(prisma);
      const result = runSeed(urlForDb(SCENARIO_DBS[0]));

      expect(result.ok).toBe(false);
      expect(result.output).toContain('DEMO_SEED_CONFLICT');
      expect(result.output).not.toMatch(/P2002|unique constraint|violates/i);
      expect(await snapshotDemoCounts(prisma)).toEqual(before);
      const still = await prisma.vendorUser.findUniqueOrThrow({
        where: { id: membership.id },
      });
      expect(still.vendorId).toBe(other.id);
      expect(still.branchId).toBe(otherBranch.id);
      expect(
        await prisma.vendor.count({ where: { slug: VENDOR_ONE.slug } }),
      ).toBe(0);
      expect(
        await prisma.user.count({ where: { phone: DEMO.owner.phone } }),
      ).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);

  it('rejects when the demo platform barcode is held by a different canonical variant', async () => {
    const prisma = await scenarioDb(SCENARIO_DBS[1]);
    try {
      const brand = await prisma.brand.create({
        data: { name: 'Other', normalizedName: 'other-brand' },
      });
      const category = await prisma.category.create({
        data: { nameEn: 'Other cat', nameAr: 'فئة أخرى' },
      });
      const product = await prisma.canonicalProduct.create({
        data: {
          brandId: brand.id,
          categoryId: category.id,
          modelName: 'Other',
        },
      });
      const variant = await prisma.canonicalProductVariant.create({
        data: {
          canonicalProductId: product.id,
          structuralAttributes: { color: 'x' },
          gtin: 'OTHER-GTIN-1',
          platformProductBarcode: CANONICAL_PLATFORM_BARCODE,
        },
      });

      const before = await snapshotDemoCounts(prisma);
      const result = runSeed(urlForDb(SCENARIO_DBS[1]));

      expect(result.ok).toBe(false);
      expect(result.output).toContain('DEMO_SEED_CONFLICT');
      expect(result.output).toContain('platform barcode');
      expect(result.output).not.toMatch(/P2002|unique constraint|violates/i);
      expect(await snapshotDemoCounts(prisma)).toEqual(before);
      const still = await prisma.canonicalProductVariant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(still.gtin).toBe('OTHER-GTIN-1');
      expect(
        await prisma.vendor.count({ where: { slug: VENDOR_ONE.slug } }),
      ).toBe(0);
      expect(
        await prisma.user.count({ where: { phone: DEMO.owner.phone } }),
      ).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);

  it('rejects when the demo store barcode is held by a different offer variant of the same vendor', async () => {
    const prisma = await scenarioDb(SCENARIO_DBS[2]);
    try {
      const vendor = await prisma.vendor.create({
        data: {
          ...VENDOR_ONE,
          status: 'ACTIVE',
          subscriptionStatus: 'ACTIVE',
          storeType: 'PHYSICAL',
          storefrontPublished: true,
        },
      });
      const offer = await prisma.vendorOffer.create({
        data: {
          vendorId: vendor.id,
          titleAr: 'عرض آخر',
          titleEn: 'Some other offer',
          status: 'ACTIVE',
        },
      });
      const holder = await prisma.offerVariant.create({
        data: {
          vendorId: vendor.id,
          vendorOfferId: offer.id,
          sellerSku: 'SOME-OTHER-SKU',
          basePrice: 10,
          storeInventoryBarcode: `DEMO-${OFFER_ONE_SELLER_SKU}`,
        },
      });

      const before = await snapshotDemoCounts(prisma);
      const result = runSeed(urlForDb(SCENARIO_DBS[2]));

      expect(result.ok).toBe(false);
      expect(result.output).toContain('DEMO_SEED_CONFLICT');
      expect(result.output).toContain('store barcode');
      expect(result.output).not.toMatch(/P2002|unique constraint|violates/i);
      expect(await snapshotDemoCounts(prisma)).toEqual(before);
      const still = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: holder.id },
      });
      expect(still.sellerSku).toBe('SOME-OTHER-SKU');
      expect(
        await prisma.user.count({ where: { phone: DEMO.owner.phone } }),
      ).toBe(0);
      expect(
        await prisma.storeBranch.count({ where: { vendorId: vendor.id } }),
      ).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);

  it('rejects when an overlapping delivery window already exists on the demo branch/day', async () => {
    const prisma = await scenarioDb(SCENARIO_DBS[3]);
    try {
      const vendor = await prisma.vendor.create({
        data: {
          ...VENDOR_ONE,
          status: 'ACTIVE',
          subscriptionStatus: 'ACTIVE',
          storeType: 'PHYSICAL',
          storefrontPublished: true,
        },
      });
      const branch = await prisma.storeBranch.create({
        data: {
          vendorId: vendor.id,
          name: BRANCH_ONE_A_NAME,
          isPhysical: true,
          verificationStatus: 'APPROVED',
        },
      });
      const window = await prisma.deliveryWindow.create({
        data: {
          vendorId: vendor.id,
          branchId: branch.id,
          dayOfWeek: 3,
          startMinute: 600,
          endMinute: 660,
          capacity: 5,
        },
      });

      const before = await snapshotDemoCounts(prisma);
      const result = runSeed(urlForDb(SCENARIO_DBS[3]));

      expect(result.ok).toBe(false);
      expect(result.output).toContain('DEMO_SEED_CONFLICT');
      expect(result.output).toContain('overlapping window');
      expect(result.output).not.toMatch(/exclusion|violates|no_overlap/i);
      expect(await snapshotDemoCounts(prisma)).toEqual(before);
      const still = await prisma.deliveryWindow.findUniqueOrThrow({
        where: { id: window.id },
      });
      expect(still.startMinute).toBe(600);
      expect(still.capacity).toBe(5);
      expect(
        await prisma.deliveryWindow.count({ where: { branchId: branch.id } }),
      ).toBe(1);
      await assertNothingElseCreated(prisma);
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);
});
