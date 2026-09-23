/**
 * Sprint 12: local demo-seed script only - no new application feature,
 * no schema change. Creates the minimum fixed data set that makes
 * every already-built customer/vendor/staff path genuinely visible
 * (storefront, discovery/comparison, cart, checkout, the fulfilment
 * loop) against a real local/dev database, through the exact same
 * Prisma models and constraints the app itself writes through - never
 * a shortcut around a CHECK/unique constraint or a role invariant.
 *
 * Idempotent by construction: every entity is looked up by its own
 * natural/unique key FIRST and only created if missing. Re-running
 * this script is always a no-op after the first successful run - it
 * never updates, deletes, or duplicates a row it (or anything else)
 * already created. Verified by
 * test/seed-demo-idempotency.e2e-spec.ts, which runs this exact script
 * twice against a real database and asserts identical row counts.
 *
 * Usage (from inside the app's Node container, apps/api as cwd):
 *   npx ts-node scripts/seed-demo.ts
 *
 * Full example, run from the host against this project's own Docker
 * dev setup (a running `sprint10-dev`-style container on the
 * `finalyearproject_default` network, alongside `postgres`/`redis`):
 *
 *   docker exec \
 *     -e DATABASE_URL="postgresql://finalpro:finalpro_dev_only@postgres:5432/finalpro_sprint11_dev?schema=public" \
 *     <container-name> sh -c "cd /workspace/apps/api && npx ts-node scripts/seed-demo.ts"
 *
 * Requires DATABASE_URL to point at a local/dev database. Refuses to
 * run against anything whose database name doesn't contain "test",
 * "dev", "demo", or "local" - a last-resort guard against accidentally
 * pointing this at a real deployment (see requireLocalDatabase() below).
 *
 * All phone numbers and passwords (scripts/seed-demo.constants.ts) are
 * LOCAL DEMO DATA ONLY - never real secrets, never valid against any
 * real SMS/auth provider, and never to be reused for a production or
 * staging account.
 */
import * as bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  Prisma,
  StoreApplicableCategory,
  DeliveryZoneRegion,
} from '../generated/prisma/client';
import {
  DEMO,
  VENDOR_ONE,
  VENDOR_TWO,
  BRAND_NORMALIZED_NAME,
  CATEGORY_NAME_EN,
  CANONICAL_GTIN,
  CANONICAL_PLATFORM_BARCODE,
  OFFER_ONE_SELLER_SKU,
  OFFER_TWO_SELLER_SKU,
  BRANCH_ONE_A_NAME,
  BRANCH_ONE_B_NAME,
  BRANCH_TWO_A_NAME,
  DEMO_ADDRESS_LABEL,
} from './seed-demo.constants';

function note(lines: string[], line: string): void {
  console.log(line);
  lines.push(line);
}

/**
 * Refuses to run against a database whose name doesn't look like a
 * local/dev/test/demo one - the same spirit as this repo's other
 * out-of-band scripts (scripts/seed-platform-staff.ts), just with an
 * explicit guard here since this script creates a much larger,
 * clearly-fake data set that must never land in a real environment.
 */
function requireLocalDatabase(connectionString: string): void {
  const dbName = connectionString.split('/').pop()?.split('?')[0] ?? '';
  // "clean(room)" included alongside test/dev/demo/local - this
  // project's own clean-room verification databases (e.g.
  // finalpro_cleanroom_12) are exactly as disposable/local as a "test"
  // or "dev" one; a caught-by-CI run of this same seed against one of
  // them (see test/seed-demo-idempotency.e2e-spec.ts) must not need a
  // special-cased database name to pass this guard.
  const looksLocal = /test|dev|demo|local|clean/i.test(dbName);
  if (!looksLocal) {
    throw new Error(
      `Refusing to run: DATABASE_URL's database name ("${dbName}") does not ` +
        'look like a local/dev/test/demo/clean-room database. This script ' +
        'seeds clearly-fake demo accounts and data and must never run ' +
        'against a real deployment. Point DATABASE_URL at a local database ' +
        'to proceed.',
    );
  }
}

async function findOrCreateUser(
  prisma: PrismaClient,
  phone: string,
  password: string,
  lines: string[],
  label: string,
) {
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    note(lines, `  ${label}: already exists (${phone}) - left untouched.`);
    return existing;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { phone, passwordHash, phoneVerifiedAt: new Date() },
  });
  note(lines, `  ${label}: created (${phone}).`);
  return user;
}

/**
 * Every real account is also a customer account first (PDR-008: "One
 * account may be a customer and also hold store-owner or branch-
 * employee roles") - AuthController.register() already guarantees this
 * for every self-service signup, so the owner/employee demo accounts
 * need it too, or CustomersController's own `findUniqueOrThrow` would
 * 500 the moment either of them opens their own "me" page.
 */
async function findOrCreateCustomerProfile(
  prisma: PrismaClient,
  userId: string,
  displayName: string,
) {
  const existing = await prisma.customerProfile.findUnique({
    where: { userId },
  });
  if (existing) return existing;
  return prisma.customerProfile.create({ data: { userId, displayName } });
}

async function findOrCreateVendor(
  prisma: PrismaClient,
  input: {
    slug: string;
    legalName: string;
    displayName: string;
    instagramUrl?: string;
    facebookUrl?: string;
    whatsappUrl?: string;
  },
  lines: string[],
) {
  const existing = await prisma.vendor.findUnique({
    where: { slug: input.slug },
  });
  if (existing) {
    note(
      lines,
      `  Vendor "${input.displayName}": already exists (${input.slug}) - left untouched.`,
    );
    return existing;
  }
  // ACTIVE + storefrontPublished + subscriptionStatus ACTIVE + an
  // external contact (PDR-007) is exactly the state
  // assertItemsPurchasable() (checkout) and StorefrontController
  // (public visibility) both require - a vendor seeded any other way
  // would silently fail to appear anywhere in the demo.
  const vendor = await prisma.vendor.create({
    data: {
      slug: input.slug,
      legalName: input.legalName,
      displayName: input.displayName,
      status: 'ACTIVE',
      subscriptionStatus: 'ACTIVE',
      storeType: 'PHYSICAL',
      storefrontPublished: true,
      instagramUrl: input.instagramUrl,
      facebookUrl: input.facebookUrl,
      whatsappUrl: input.whatsappUrl,
    },
  });
  note(lines, `  Vendor "${input.displayName}": created (${input.slug}).`);
  return vendor;
}

async function ensureVendorSubscription(
  prisma: PrismaClient,
  vendorId: string,
) {
  const existing = await prisma.vendorSubscription.findFirst({
    where: { vendorId },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing;
  const periodEnd = new Date();
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 30);
  return prisma.vendorSubscription.create({
    data: { vendorId, status: 'ACTIVE', periodEnd },
  });
}

async function ensureVendorUser(
  prisma: PrismaClient,
  userId: string,
  vendorId: string,
  role: 'OWNER' | 'BRANCH_EMPLOYEE',
  branchId: string | null,
) {
  const existing = await prisma.vendorUser.findUnique({
    where: { userId_vendorId: { userId, vendorId } },
  });
  if (existing) return existing;
  return prisma.vendorUser.create({
    data: { userId, vendorId, role, branchId },
  });
}

async function ensureApplicableCategory(
  prisma: PrismaClient,
  vendorId: string,
  category: StoreApplicableCategory,
) {
  const existing = await prisma.vendorApplicableCategory.findUnique({
    where: { vendorId_category: { vendorId, category } },
  });
  if (existing) return existing;
  return prisma.vendorApplicableCategory.create({
    data: { vendorId, category },
  });
}

async function findOrCreateBranch(
  prisma: PrismaClient,
  vendorId: string,
  name: string,
  lines: string[],
) {
  const existing = await prisma.storeBranch.findFirst({
    where: { vendorId, name },
  });
  if (existing) {
    note(lines, `  Branch "${name}": already exists - left untouched.`);
    return existing;
  }
  const branch = await prisma.storeBranch.create({
    data: {
      vendorId,
      name,
      isPhysical: true,
      lat: 31.9,
      lng: 35.2,
      verificationStatus: 'APPROVED',
      reviewedAt: new Date(),
    },
  });
  note(lines, `  Branch "${name}": created.`);
  return branch;
}

/**
 * One window per day of the week, same hours - guarantees the
 * customer-facing checkout slot picker (next 3 days) always has at
 * least one real, bookable slot no matter what day the demo is run on,
 * without the seed needing to know "today" at all.
 */
async function ensureDeliveryWindowsForEveryDay(
  prisma: PrismaClient,
  vendorId: string,
  branchId: string,
  startMinute: number,
  endMinute: number,
  capacity: number,
) {
  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
    const existing = await prisma.deliveryWindow.findFirst({
      where: { vendorId, branchId, dayOfWeek, startMinute, endMinute },
    });
    if (existing) continue;
    await prisma.deliveryWindow.create({
      data: { vendorId, branchId, dayOfWeek, startMinute, endMinute, capacity },
    });
  }
}

async function ensureDeliveryZoneFee(
  prisma: PrismaClient,
  vendorId: string,
  region: DeliveryZoneRegion,
  fee: number,
) {
  const existing = await prisma.vendorDeliveryZone.findUnique({
    where: { vendorId_region: { vendorId, region } },
  });
  if (existing) return existing;
  return prisma.vendorDeliveryZone.create({
    data: { vendorId, region, enabled: true, fee },
  });
}

async function findOrCreateCategory(
  prisma: PrismaClient,
  nameEn: string,
  nameAr: string,
) {
  const existing = await prisma.category.findFirst({ where: { nameEn } });
  if (existing) return existing;
  return prisma.category.create({ data: { nameEn, nameAr } });
}

async function findOrCreateBrand(
  prisma: PrismaClient,
  name: string,
  normalizedName: string,
) {
  const existing = await prisma.brand.findUnique({ where: { normalizedName } });
  if (existing) return existing;
  return prisma.brand.create({ data: { name, normalizedName } });
}

async function findOrCreateCanonicalProduct(
  prisma: PrismaClient,
  brandId: string,
  categoryId: string,
  modelName: string,
) {
  const existing = await prisma.canonicalProduct.findFirst({
    where: { brandId, categoryId, modelName },
  });
  if (existing) return existing;
  return prisma.canonicalProduct.create({
    data: { brandId, categoryId, modelName, status: 'PUBLISHED' },
  });
}

async function findOrCreateCanonicalVariant(
  prisma: PrismaClient,
  canonicalProductId: string,
  structuralAttributes: Prisma.InputJsonValue,
) {
  const existing = await prisma.canonicalProductVariant.findUnique({
    where: { gtin: CANONICAL_GTIN },
  });
  if (existing) return existing;
  return prisma.canonicalProductVariant.create({
    data: {
      canonicalProductId,
      structuralAttributes,
      gtin: CANONICAL_GTIN,
      platformProductBarcode: CANONICAL_PLATFORM_BARCODE,
    },
  });
}

/**
 * One matched offer + variant for a given vendor, confirmed against
 * the shared canonical variant - this is what makes discovery/
 * comparison show a real multi-store card (RB-COMP-001), not just two
 * unrelated listings.
 */
async function ensureMatchedOffer(
  prisma: PrismaClient,
  vendorId: string,
  canonicalProductId: string,
  canonicalVariantId: string,
  titleAr: string,
  titleEn: string,
  sellerSku: string,
  basePrice: number,
  lines: string[],
) {
  let offer = await prisma.vendorOffer.findFirst({
    where: { vendorId, titleEn },
  });
  let created = false;
  if (!offer) {
    offer = await prisma.vendorOffer.create({
      data: {
        vendorId,
        canonicalProductId,
        titleAr,
        titleEn,
        status: 'ACTIVE',
      },
    });
    created = true;
  }

  let variant = await prisma.offerVariant.findUnique({
    where: { vendorId_sellerSku: { vendorId, sellerSku } },
  });
  if (!variant) {
    variant = await prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        canonicalVariantId,
        matchProposalStatus: 'CONFIRMED',
        sellerSku,
        basePrice,
        storeInventoryBarcode: `DEMO-${sellerSku}`,
      },
    });
    created = true;
  }
  note(
    lines,
    `  Offer "${titleEn}": ${created ? 'created' : 'already existed - left untouched'}.`,
  );
  return { offer, variant };
}

async function ensureBranchStock(
  prisma: PrismaClient,
  vendorId: string,
  branchId: string,
  offerVariantId: string,
  quantity: number,
) {
  const existing = await prisma.branchStock.findUnique({
    where: { branchId_offerVariantId: { branchId, offerVariantId } },
  });
  if (existing) return existing;
  return prisma.branchStock.create({
    data: { vendorId, branchId, offerVariantId, quantity },
  });
}

async function ensureDemoAddress(
  prisma: PrismaClient,
  customerId: string,
  lines: string[],
) {
  const existing = await prisma.address.findFirst({
    where: { customerId, label: DEMO_ADDRESS_LABEL },
  });
  if (existing) {
    note(lines, '  Demo address: already exists - left untouched.');
    return existing;
  }
  const address = await prisma.address.create({
    data: {
      customerId,
      label: DEMO_ADDRESS_LABEL,
      lat: 31.9,
      lng: 35.2,
      landmarkNote: 'بجانب الدوار الرئيسي',
      phoneNumber1: DEMO.customer.phone,
      zone: 'WEST_BANK',
    },
  });
  note(lines, '  Demo address: created (zone WEST_BANK).');
  return address;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  requireLocalDatabase(connectionString);
  const prisma = new PrismaClient({ adapter: new PrismaPg(connectionString) });

  const lines: string[] = [];
  note(lines, '== Sprint 12 demo seed ==');

  // ---- Accounts ----
  note(lines, '\n-- Accounts --');
  const ownerUser = await findOrCreateUser(
    prisma,
    DEMO.owner.phone,
    DEMO.owner.password,
    lines,
    'Owner',
  );
  const employeeUser = await findOrCreateUser(
    prisma,
    DEMO.employee.phone,
    DEMO.employee.password,
    lines,
    'Employee',
  );
  const customerUser = await findOrCreateUser(
    prisma,
    DEMO.customer.phone,
    DEMO.customer.password,
    lines,
    'Customer',
  );
  await findOrCreateCustomerProfile(
    prisma,
    ownerUser.id,
    DEMO.owner.displayName,
  );
  await findOrCreateCustomerProfile(
    prisma,
    employeeUser.id,
    DEMO.employee.displayName,
  );
  const customerProfile = await findOrCreateCustomerProfile(
    prisma,
    customerUser.id,
    DEMO.customer.displayName,
  );

  // ---- Vendor One: two branches (owner + employee, delivery + pickup) ----
  note(lines, '\n-- Vendor one (delivery + pickup, owner + employee) --');
  const vendorOne = await findOrCreateVendor(prisma, VENDOR_ONE, lines);
  await ensureVendorSubscription(prisma, vendorOne.id);
  await ensureVendorUser(prisma, ownerUser.id, vendorOne.id, 'OWNER', null);
  await ensureApplicableCategory(prisma, vendorOne.id, 'WOMEN');
  const branchOneA = await findOrCreateBranch(
    prisma,
    vendorOne.id,
    BRANCH_ONE_A_NAME,
    lines,
  );
  const branchOneB = await findOrCreateBranch(
    prisma,
    vendorOne.id,
    BRANCH_ONE_B_NAME,
    lines,
  );
  await ensureVendorUser(
    prisma,
    employeeUser.id,
    vendorOne.id,
    'BRANCH_EMPLOYEE',
    branchOneA.id,
  );
  // 09:00-18:00 every day, so a delivery slot is always bookable within
  // the checkout's own next-3-days window regardless of today's date.
  await ensureDeliveryWindowsForEveryDay(
    prisma,
    vendorOne.id,
    branchOneA.id,
    9 * 60,
    18 * 60,
    10,
  );
  await ensureDeliveryZoneFee(prisma, vendorOne.id, 'WEST_BANK', 15);
  await ensureDeliveryZoneFee(prisma, vendorOne.id, 'JERUSALEM', 25);

  // ---- Vendor Two: one branch (pickup only, no staff) ----
  note(lines, '\n-- Vendor two (pickup, second store for comparison) --');
  const vendorTwo = await findOrCreateVendor(prisma, VENDOR_TWO, lines);
  await ensureVendorSubscription(prisma, vendorTwo.id);
  await ensureVendorUser(prisma, ownerUser.id, vendorTwo.id, 'OWNER', null);
  await ensureApplicableCategory(prisma, vendorTwo.id, 'WOMEN');
  const branchTwoA = await findOrCreateBranch(
    prisma,
    vendorTwo.id,
    BRANCH_TWO_A_NAME,
    lines,
  );

  // ---- Canonical product + confirmed matches from BOTH vendors ----
  note(lines, '\n-- Canonical product + comparison-ready matched offers --');
  const category = await findOrCreateCategory(
    prisma,
    CATEGORY_NAME_EN,
    'أزياء نسائية تجريبية',
  );
  const brand = await findOrCreateBrand(
    prisma,
    'Demo Style',
    BRAND_NORMALIZED_NAME,
  );
  const canonicalProduct = await findOrCreateCanonicalProduct(
    prisma,
    brand.id,
    category.id,
    'Demo Classic Cotton Shirt',
  );
  const canonicalVariant = await findOrCreateCanonicalVariant(
    prisma,
    canonicalProduct.id,
    {
      color: 'أبيض',
      size: 'M',
    },
  );

  const { variant: offerVariantOne } = await ensureMatchedOffer(
    prisma,
    vendorOne.id,
    canonicalProduct.id,
    canonicalVariant.id,
    'قميص قطني كلاسيك أبيض',
    'Demo Classic Cotton Shirt - White',
    OFFER_ONE_SELLER_SKU,
    120,
    lines,
  );
  const { variant: offerVariantTwo } = await ensureMatchedOffer(
    prisma,
    vendorTwo.id,
    canonicalProduct.id,
    canonicalVariant.id,
    'قميص قطني كلاسيك أبيض',
    'Demo Classic Cotton Shirt - White (Store Two)',
    OFFER_TWO_SELLER_SKU,
    135,
    lines,
  );

  // The canonicalNameAr/En fields only get set by the app's own
  // confirmation code path (CanonicalNamingService, on the FIRST
  // confirmed match) - never by this script directly, since directly
  // seeding OfferVariant.canonicalVariantId above bypasses that
  // controller entirely. Comparison requires them non-null (see
  // ComparisonService.buildCard()'s own `!` assertions), so this seed
  // backfills them here, idempotently (only if still unset) - a plain
  // Prisma write with the exact same effect the app's own code would
  // have had on first confirmation, not a shortcut around any
  // constraint.
  if (!canonicalProduct.canonicalNameAr || !canonicalProduct.canonicalNameEn) {
    await prisma.canonicalProduct.update({
      where: { id: canonicalProduct.id },
      data: {
        canonicalNameAr: 'قميص قطني كلاسيك',
        canonicalNameEn: 'Demo Classic Cotton Shirt',
      },
    });
    note(
      lines,
      '  Canonical name: backfilled (first-confirmation equivalent).',
    );
  }

  // ---- Stock ----
  note(lines, '\n-- Stock --');
  await ensureBranchStock(
    prisma,
    vendorOne.id,
    branchOneA.id,
    offerVariantOne.id,
    25,
  );
  await ensureBranchStock(
    prisma,
    vendorTwo.id,
    branchTwoA.id,
    offerVariantTwo.id,
    25,
  );
  note(lines, '  Stock ensured at both branches (25 units each).');

  // ---- Customer address (for the delivery checkout path) ----
  note(lines, '\n-- Customer address --');
  await ensureDemoAddress(prisma, customerProfile.id, lines);

  // ---- Summary ----
  note(lines, '\n== Demo accounts (LOCAL ONLY - never real secrets) ==');
  note(lines, `  Owner:    ${DEMO.owner.phone} / ${DEMO.owner.password}`);
  note(
    lines,
    `  Employee: ${DEMO.employee.phone} / ${DEMO.employee.password}  (branch: ${branchOneA.name})`,
  );
  note(lines, `  Customer: ${DEMO.customer.phone} / ${DEMO.customer.password}`);

  note(lines, '\n== Vendor / branch identifiers ==');
  note(lines, `  Vendor one: ${vendorOne.id}  (slug: ${vendorOne.slug})`);
  note(lines, `    Branch A (${branchOneA.name}): ${branchOneA.id}`);
  note(lines, `    Branch B (${branchOneB.name}): ${branchOneB.id}`);
  note(lines, `  Vendor two: ${vendorTwo.id}  (slug: ${vendorTwo.slug})`);
  note(lines, `    Branch A (${branchTwoA.name}): ${branchTwoA.id}`);
  note(lines, `  Canonical product: ${canonicalProduct.id}`);

  note(lines, '\n== Pages to open for the demo (web on localhost:3000) ==');
  note(lines, '  Login:                /login');
  note(lines, `  Store one storefront:  /store/${vendorOne.slug}`);
  note(lines, `  Store two storefront:  /store/${vendorTwo.slug}`);
  note(lines, `  Comparison card/list:  /compare/${canonicalProduct.id}`);
  note(lines, '  Discovery (All page):  /discovery');
  note(lines, '  Customer cart:         /cart');
  note(lines, '  Customer checkout:     /checkout');
  note(lines, '  Customer Orders UI:    /orders');
  note(
    lines,
    `  Branch A orders/staff: /vendor/${vendorOne.id}/branches/${branchOneA.id}/orders`,
  );
  note(
    lines,
    `  Branch A delivery windows: /vendor/${vendorOne.id}/branches/${branchOneA.id}/delivery-windows`,
  );
  note(
    lines,
    `  Vendor one delivery zones: /vendor/${vendorOne.id}/delivery-zones`,
  );

  note(lines, '\nSeed complete.');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
