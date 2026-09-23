/**
 * Sprint 12: local demo-seed script only - no new application feature,
 * no schema change. Creates the minimum fixed data set that makes
 * every already-built customer/vendor/staff path genuinely visible
 * (storefront, discovery/comparison, cart, checkout, the fulfilment
 * loop) against a real local/dev database, through the exact same
 * Prisma models and constraints the app itself writes through - never
 * a shortcut around a CHECK/unique constraint or a role invariant.
 *
 * Two-phase, conflict-safe by construction (round-2 review fixes):
 *
 *   1. PREFLIGHT (read-only, plain PrismaClient, before any write):
 *      every entity is looked up by its own natural/unique key. A
 *      MISSING entity is queued for creation. An EXISTING entity is
 *      compared field-by-field against the exact state this script
 *      requires - any mismatch aborts the whole run with a
 *      DemoSeedConflictError (message prefixed "DEMO_SEED_CONFLICT")
 *      *before* anything is written, and the mismatched row is never
 *      modified or deleted. (BranchStock.quantity is the one
 *      deliberate exception - it's operational state the running demo
 *      is expected to change via real checkout/order usage, so only
 *      its existence, never its value, is checked.)
 *
 *   2. APPLY (one single `prisma.$transaction`): every entity the
 *      preflight found missing is created; every entity it found
 *      existing-and-matching is left untouched. Wrapping this in one
 *      transaction means any unexpected failure partway through rolls
 *      back everything - this script can never leave a partially
 *      seeded demo behind.
 *
 * Re-running this script after a first successful run is always a
 * clean no-op (every preflight check passes against what it itself
 * created, nothing new is queued). Verified by
 * test/seed-demo-idempotency.e2e-spec.ts (twice-in-a-row, identical
 * row counts) and test/seed-demo-safety.e2e-spec.ts (a genuine late
 * conflict is detected and rejected without modifying anything, and
 * the host/database-name guard rejects a remote host before any
 * connection is attempted).
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
 * Requires DATABASE_URL to point at a local database: BOTH its host
 * (postgres/localhost/127.0.0.1/::1 only) and its database name (must
 * contain "test", "dev", "demo", "local", or "clean") are checked
 * before anything else runs - see requireLocalDatabase() below. This
 * closes the gap the round-2 review found: a demo-looking database
 * name alone used to be accepted even against a remote host.
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
  User,
  CustomerProfile,
  Vendor,
  VendorSubscription,
  VendorUser,
  VendorApplicableCategory,
  StoreBranch,
  DeliveryWindow,
  VendorDeliveryZone,
  Category,
  Brand,
  CanonicalProduct,
  CanonicalProductVariant,
  VendorOffer,
  OfferVariant,
  BranchStock,
  Address,
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
 * Thrown whenever an existing row is found during preflight that does
 * not exactly match the demo's required state. Always fatal, always
 * raised before any write in this script's own transaction (see
 * main()) - the "found something, but it isn't ours / isn't right, so
 * refuse rather than guess or patch it" signal Codex's round-2 review
 * requires in place of the old silent-backfill/partial-write behaviour.
 */
export class DemoSeedConflictError extends Error {
  readonly code = 'DEMO_SEED_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'DemoSeedConflictError';
  }
}

function conflict(entityLabel: string, details: string): never {
  throw new DemoSeedConflictError(
    `DEMO_SEED_CONFLICT: existing ${entityLabel} does not match the ` +
      `required demo state - refusing to modify or delete it. ${details}`,
  );
}

/**
 * Hosts this script is ever allowed to run against. Deliberately a
 * short, exact allowlist (not a substring/regex check like the
 * database-name check below) - a hostname has no "looks local" middle
 * ground the way a database name does, so there is nothing to
 * pattern-match. "postgres" is this project's own Docker Compose
 * service name (finalyearproject-postgres-1, reachable as "postgres"
 * from any container on the finalyearproject_default network); the
 * others are loopback in every form Node's URL parser produces
 * (IPv4, and IPv6 both bracketed - as the WHATWG URL parser actually
 * returns it - and unbracketed, checked defensively).
 */
const ALLOWED_DATABASE_HOSTS = new Set([
  'postgres',
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

/**
 * Refuses to run against anything that isn't unambiguously a local
 * database - checked BEFORE constructing a PrismaClient or opening any
 * connection, so a misconfigured DATABASE_URL fails immediately and
 * loudly rather than after a real (even if ultimately rejected)
 * network attempt.
 *
 * Round-2 review fix (Codex): the previous version only ever inspected
 * the database NAME (via a naive string split), so
 * "postgresql://user:pass@production.example.com/finalpro_demo" was
 * wrongly accepted - a demo-looking name on a real remote host. Both
 * the HOST and the database name, parsed via the standard URL API, now
 * separately have to pass before this function returns.
 */
function requireLocalDatabase(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      `Refusing to run: DATABASE_URL ("${connectionString}") could not be ` +
        'parsed as a URL, so its host cannot be verified as local.',
    );
  }

  if (!ALLOWED_DATABASE_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing to run: DATABASE_URL's host ("${url.hostname}") is not a ` +
        `recognized local database host (allowed: ${[...ALLOWED_DATABASE_HOSTS].join(', ')}). ` +
        'This script seeds clearly-fake demo accounts and data and must ' +
        'never run against a remote or production database.',
    );
  }

  const dbName = url.pathname.replace(/^\//, '');
  // "clean(room)" alongside test/dev/demo/local - this project's own
  // clean-room verification databases (e.g. finalpro_cleanroom_12) are
  // exactly as disposable/local as a "test" or "dev" one.
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

interface VendorSeedInput {
  slug: string;
  legalName: string;
  displayName: string;
  instagramUrl?: string;
  facebookUrl?: string;
  whatsappUrl?: string;
}

// ---------------------------------------------------------------------
// Phase 1: PREFLIGHT - read-only. Every function below either returns
// null ("nothing here yet, queue it for creation") or the existing row
// after confirming it exactly matches what this script requires -
// never a mismatched row silently passed through, never a write.
// ---------------------------------------------------------------------

async function preflightUser(
  prisma: PrismaClient,
  phone: string,
  password: string,
  label: string,
): Promise<User | null> {
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (!existing) return null;
  const passwordMatches = await bcrypt.compare(password, existing.passwordHash);
  if (!passwordMatches) {
    conflict(
      `${label} user (${phone})`,
      'its stored password does not match the required demo password.',
    );
  }
  return existing;
}

/**
 * Every real account is also a customer account first (PDR-008: "One
 * account may be a customer and also hold store-owner or branch-
 * employee roles") - AuthController.register() already guarantees this
 * for every self-service signup, so the owner/employee demo accounts
 * need it too, or CustomersController's own `findUniqueOrThrow` would
 * 500 the moment either of them opens their own "me" page.
 */
async function preflightCustomerProfile(
  prisma: PrismaClient,
  userId: string | null,
  displayName: string,
  label: string,
): Promise<CustomerProfile | null> {
  if (!userId) return null;
  const existing = await prisma.customerProfile.findUnique({
    where: { userId },
  });
  if (!existing) return null;
  if (existing.displayName !== displayName) {
    conflict(
      `${label} customer profile`,
      `expected displayName "${displayName}", found "${existing.displayName}".`,
    );
  }
  return existing;
}

async function preflightVendor(
  prisma: PrismaClient,
  input: VendorSeedInput,
): Promise<Vendor | null> {
  const existing = await prisma.vendor.findUnique({
    where: { slug: input.slug },
  });
  if (!existing) return null;
  const mismatches: string[] = [];
  if (existing.legalName !== input.legalName) mismatches.push('legalName');
  if (existing.displayName !== input.displayName)
    mismatches.push('displayName');
  if (existing.status !== 'ACTIVE')
    mismatches.push(`status ("${existing.status}" != "ACTIVE")`);
  if (existing.subscriptionStatus !== 'ACTIVE') {
    mismatches.push(
      `subscriptionStatus ("${existing.subscriptionStatus}" != "ACTIVE")`,
    );
  }
  if (existing.storeType !== 'PHYSICAL')
    mismatches.push(`storeType ("${existing.storeType}" != "PHYSICAL")`);
  if (!existing.storefrontPublished)
    mismatches.push('storefrontPublished (false != true)');
  if (
    input.instagramUrl !== undefined &&
    existing.instagramUrl !== input.instagramUrl
  ) {
    mismatches.push('instagramUrl');
  }
  if (
    input.facebookUrl !== undefined &&
    existing.facebookUrl !== input.facebookUrl
  ) {
    mismatches.push('facebookUrl');
  }
  if (
    input.whatsappUrl !== undefined &&
    existing.whatsappUrl !== input.whatsappUrl
  ) {
    mismatches.push('whatsappUrl');
  }
  if (mismatches.length > 0) {
    conflict(
      `vendor "${input.slug}"`,
      `mismatched fields: ${mismatches.join(', ')}.`,
    );
  }
  return existing;
}

async function preflightVendorSubscription(
  prisma: PrismaClient,
  vendorId: string | null,
  vendorLabel: string,
): Promise<VendorSubscription | null> {
  if (!vendorId) return null;
  const existing = await prisma.vendorSubscription.findFirst({
    where: { vendorId },
    orderBy: { createdAt: 'desc' },
  });
  if (!existing) return null;
  if (
    existing.status !== 'ACTIVE' ||
    existing.periodEnd.getTime() <= Date.now()
  ) {
    conflict(
      `subscription for vendor "${vendorLabel}"`,
      `expected an ACTIVE, unexpired subscription; found status "${existing.status}" ` +
        `with periodEnd ${existing.periodEnd.toISOString()}.`,
    );
  }
  return existing;
}

async function preflightVendorUser(
  prisma: PrismaClient,
  userId: string | null,
  vendorId: string | null,
  role: 'OWNER' | 'BRANCH_EMPLOYEE',
  branchId: string | null,
  label: string,
): Promise<VendorUser | null> {
  if (!userId || !vendorId) return null;
  const existing = await prisma.vendorUser.findUnique({
    where: { userId_vendorId: { userId, vendorId } },
  });
  if (!existing) return null;
  if (existing.role !== role || existing.branchId !== branchId) {
    conflict(
      `${label} membership`,
      `expected role "${role}" / branchId "${branchId}"; found role "${existing.role}" / branchId "${existing.branchId}".`,
    );
  }
  return existing;
}

async function preflightApplicableCategory(
  prisma: PrismaClient,
  vendorId: string | null,
  category: StoreApplicableCategory,
): Promise<VendorApplicableCategory | null> {
  if (!vendorId) return null;
  // Existence-only key - nothing else on this row to mismatch on.
  return prisma.vendorApplicableCategory.findUnique({
    where: { vendorId_category: { vendorId, category } },
  });
}

async function preflightBranch(
  prisma: PrismaClient,
  vendorId: string | null,
  name: string,
): Promise<StoreBranch | null> {
  if (!vendorId) return null;
  const existing = await prisma.storeBranch.findFirst({
    where: { vendorId, name },
  });
  if (!existing) return null;
  if (!existing.isPhysical || existing.verificationStatus !== 'APPROVED') {
    conflict(
      `branch "${name}"`,
      `expected isPhysical=true / verificationStatus="APPROVED"; found ` +
        `isPhysical=${existing.isPhysical} / verificationStatus="${existing.verificationStatus}".`,
    );
  }
  return existing;
}

async function preflightDeliveryWindow(
  prisma: PrismaClient,
  vendorId: string | null,
  branchId: string | null,
  dayOfWeek: number,
  startMinute: number,
  endMinute: number,
  capacity: number,
): Promise<DeliveryWindow | null> {
  if (!vendorId || !branchId) return null;
  const existing = await prisma.deliveryWindow.findFirst({
    where: { vendorId, branchId, dayOfWeek, startMinute, endMinute },
  });
  if (!existing) return null;
  if (existing.capacity !== capacity) {
    conflict(
      `delivery window (day ${dayOfWeek})`,
      `expected capacity ${capacity}; found ${existing.capacity}.`,
    );
  }
  return existing;
}

async function preflightDeliveryZone(
  prisma: PrismaClient,
  vendorId: string | null,
  region: DeliveryZoneRegion,
  fee: number,
): Promise<VendorDeliveryZone | null> {
  if (!vendorId) return null;
  const existing = await prisma.vendorDeliveryZone.findUnique({
    where: { vendorId_region: { vendorId, region } },
  });
  if (!existing) return null;
  if (
    !existing.enabled ||
    existing.fee === null ||
    existing.fee.toNumber() !== fee
  ) {
    conflict(
      `delivery zone "${region}"`,
      `expected enabled=true / fee=${fee}; found enabled=${existing.enabled} / fee=${existing.fee?.toString() ?? 'null'}.`,
    );
  }
  return existing;
}

async function preflightCategory(
  prisma: PrismaClient,
  nameEn: string,
  nameAr: string,
): Promise<Category | null> {
  const existing = await prisma.category.findFirst({ where: { nameEn } });
  if (!existing) return null;
  if (existing.nameAr !== nameAr) {
    conflict(
      `category "${nameEn}"`,
      `expected nameAr "${nameAr}"; found "${existing.nameAr}".`,
    );
  }
  return existing;
}

async function preflightBrand(
  prisma: PrismaClient,
  name: string,
  normalizedName: string,
): Promise<Brand | null> {
  const existing = await prisma.brand.findUnique({ where: { normalizedName } });
  if (!existing) return null;
  if (existing.name !== name) {
    conflict(
      `brand "${normalizedName}"`,
      `expected name "${name}"; found "${existing.name}".`,
    );
  }
  return existing;
}

/**
 * Round-2 review fix (Blocker 2): canonicalNameAr/En are now validated
 * here as part of exact-state matching, never patched onto an existing
 * row afterward. A CanonicalProduct this script needs to create always
 * gets these fields set directly in its own create() call (see
 * applyPlan) - there is no longer any separate backfill-on-update path
 * at all.
 */
async function preflightCanonicalProduct(
  prisma: PrismaClient,
  brandId: string | null,
  categoryId: string | null,
  modelName: string,
  canonicalNameAr: string,
  canonicalNameEn: string,
): Promise<CanonicalProduct | null> {
  if (!brandId || !categoryId) return null;
  const existing = await prisma.canonicalProduct.findFirst({
    where: { brandId, categoryId, modelName },
  });
  if (!existing) return null;
  const mismatches: string[] = [];
  if (existing.status !== 'PUBLISHED')
    mismatches.push(`status ("${existing.status}" != "PUBLISHED")`);
  if (existing.canonicalNameAr !== canonicalNameAr)
    mismatches.push('canonicalNameAr');
  if (existing.canonicalNameEn !== canonicalNameEn)
    mismatches.push('canonicalNameEn');
  if (mismatches.length > 0) {
    conflict(
      `canonical product "${modelName}"`,
      `mismatched fields: ${mismatches.join(', ')}.`,
    );
  }
  return existing;
}

async function preflightCanonicalVariant(
  prisma: PrismaClient,
  expectedCanonicalProductId: string | null,
  structuralAttributes: { color: string; size: string },
): Promise<CanonicalProductVariant | null> {
  const existing = await prisma.canonicalProductVariant.findUnique({
    where: { gtin: CANONICAL_GTIN },
  });
  if (!existing) return null;
  const attrs = existing.structuralAttributes as {
    color?: unknown;
    size?: unknown;
  };
  const mismatches: string[] = [];
  if (existing.canonicalProductId !== expectedCanonicalProductId) {
    mismatches.push(
      'canonicalProductId (points at a different canonical product)',
    );
  }
  if (
    attrs.color !== structuralAttributes.color ||
    attrs.size !== structuralAttributes.size
  ) {
    mismatches.push('structuralAttributes');
  }
  if (existing.platformProductBarcode !== CANONICAL_PLATFORM_BARCODE) {
    mismatches.push('platformProductBarcode');
  }
  if (mismatches.length > 0) {
    conflict(
      `canonical product variant (gtin ${CANONICAL_GTIN})`,
      `mismatched fields: ${mismatches.join(', ')}.`,
    );
  }
  return existing;
}

async function preflightOffer(
  prisma: PrismaClient,
  vendorId: string | null,
  expectedCanonicalProductId: string | null,
  titleAr: string,
  titleEn: string,
): Promise<VendorOffer | null> {
  if (!vendorId) return null;
  const existing = await prisma.vendorOffer.findFirst({
    where: { vendorId, titleEn },
  });
  if (!existing) return null;
  const mismatches: string[] = [];
  if (existing.status !== 'ACTIVE')
    mismatches.push(`status ("${existing.status}" != "ACTIVE")`);
  if (existing.canonicalProductId !== expectedCanonicalProductId)
    mismatches.push('canonicalProductId');
  if (existing.titleAr !== titleAr) mismatches.push('titleAr');
  if (mismatches.length > 0) {
    conflict(
      `offer "${titleEn}"`,
      `mismatched fields: ${mismatches.join(', ')}.`,
    );
  }
  return existing;
}

async function preflightOfferVariant(
  prisma: PrismaClient,
  vendorId: string | null,
  expectedVendorOfferId: string | null,
  expectedCanonicalVariantId: string | null,
  sellerSku: string,
  basePrice: number,
): Promise<OfferVariant | null> {
  if (!vendorId) return null;
  const existing = await prisma.offerVariant.findUnique({
    where: { vendorId_sellerSku: { vendorId, sellerSku } },
  });
  if (!existing) return null;
  const mismatches: string[] = [];
  if (existing.vendorOfferId !== expectedVendorOfferId)
    mismatches.push('vendorOfferId');
  if (existing.canonicalVariantId !== expectedCanonicalVariantId)
    mismatches.push('canonicalVariantId');
  if (existing.matchProposalStatus !== 'CONFIRMED') {
    mismatches.push(
      `matchProposalStatus ("${existing.matchProposalStatus}" != "CONFIRMED")`,
    );
  }
  if (existing.basePrice.toNumber() !== basePrice) {
    mismatches.push(
      `basePrice (${existing.basePrice.toString()} != ${basePrice})`,
    );
  }
  if (existing.storeInventoryBarcode !== `DEMO-${sellerSku}`)
    mismatches.push('storeInventoryBarcode');
  if (mismatches.length > 0) {
    conflict(
      `offer variant (SKU ${sellerSku})`,
      `mismatched fields: ${mismatches.join(', ')}.`,
    );
  }
  return existing;
}

async function preflightBranchStock(
  prisma: PrismaClient,
  branchId: string | null,
  offerVariantId: string | null,
): Promise<BranchStock | null> {
  if (!branchId || !offerVariantId) return null;
  // Existence-only: quantity is operational state the running demo is
  // *expected* to change through real checkout/order usage (Sprint 10),
  // so re-running this seed must never treat a depleted or restocked
  // quantity as a conflict - only "does the stock row exist at all" is
  // this script's own concern.
  return prisma.branchStock.findUnique({
    where: { branchId_offerVariantId: { branchId, offerVariantId } },
  });
}

async function preflightAddress(
  prisma: PrismaClient,
  customerId: string | null,
): Promise<Address | null> {
  if (!customerId) return null;
  const existing = await prisma.address.findFirst({
    where: { customerId, label: DEMO_ADDRESS_LABEL },
  });
  if (!existing) return null;
  const mismatches: string[] = [];
  if (existing.zone !== 'WEST_BANK')
    mismatches.push(`zone ("${existing.zone}" != "WEST_BANK")`);
  if (existing.phoneNumber1 !== DEMO.customer.phone)
    mismatches.push('phoneNumber1');
  if (mismatches.length > 0) {
    conflict(
      'demo customer address',
      `mismatched fields: ${mismatches.join(', ')}.`,
    );
  }
  return existing;
}

async function preflight(prisma: PrismaClient) {
  const ownerUser = await preflightUser(
    prisma,
    DEMO.owner.phone,
    DEMO.owner.password,
    'owner',
  );
  const employeeUser = await preflightUser(
    prisma,
    DEMO.employee.phone,
    DEMO.employee.password,
    'employee',
  );
  const customerUser = await preflightUser(
    prisma,
    DEMO.customer.phone,
    DEMO.customer.password,
    'customer',
  );

  const ownerProfile = await preflightCustomerProfile(
    prisma,
    ownerUser?.id ?? null,
    DEMO.owner.displayName,
    'owner',
  );
  const employeeProfile = await preflightCustomerProfile(
    prisma,
    employeeUser?.id ?? null,
    DEMO.employee.displayName,
    'employee',
  );
  const customerProfile = await preflightCustomerProfile(
    prisma,
    customerUser?.id ?? null,
    DEMO.customer.displayName,
    'customer',
  );

  const vendorOne = await preflightVendor(prisma, VENDOR_ONE);
  const vendorTwo = await preflightVendor(prisma, VENDOR_TWO);

  const subscriptionOne = await preflightVendorSubscription(
    prisma,
    vendorOne?.id ?? null,
    VENDOR_ONE.slug,
  );
  const subscriptionTwo = await preflightVendorSubscription(
    prisma,
    vendorTwo?.id ?? null,
    VENDOR_TWO.slug,
  );

  const applicableCategoryOne = await preflightApplicableCategory(
    prisma,
    vendorOne?.id ?? null,
    'WOMEN',
  );
  const applicableCategoryTwo = await preflightApplicableCategory(
    prisma,
    vendorTwo?.id ?? null,
    'WOMEN',
  );

  const branchOneA = await preflightBranch(
    prisma,
    vendorOne?.id ?? null,
    BRANCH_ONE_A_NAME,
  );
  const branchOneB = await preflightBranch(
    prisma,
    vendorOne?.id ?? null,
    BRANCH_ONE_B_NAME,
  );
  const branchTwoA = await preflightBranch(
    prisma,
    vendorTwo?.id ?? null,
    BRANCH_TWO_A_NAME,
  );

  const ownerMembershipOne = await preflightVendorUser(
    prisma,
    ownerUser?.id ?? null,
    vendorOne?.id ?? null,
    'OWNER',
    null,
    'owner @ vendor one',
  );
  const ownerMembershipTwo = await preflightVendorUser(
    prisma,
    ownerUser?.id ?? null,
    vendorTwo?.id ?? null,
    'OWNER',
    null,
    'owner @ vendor two',
  );
  const employeeMembership = await preflightVendorUser(
    prisma,
    employeeUser?.id ?? null,
    vendorOne?.id ?? null,
    'BRANCH_EMPLOYEE',
    branchOneA?.id ?? null,
    'employee @ vendor one branch A',
  );

  const deliveryWindows: Array<DeliveryWindow | null> = [];
  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
    deliveryWindows.push(
      await preflightDeliveryWindow(
        prisma,
        vendorOne?.id ?? null,
        branchOneA?.id ?? null,
        dayOfWeek,
        9 * 60,
        18 * 60,
        10,
      ),
    );
  }

  const zoneWestBank = await preflightDeliveryZone(
    prisma,
    vendorOne?.id ?? null,
    'WEST_BANK',
    15,
  );
  const zoneJerusalem = await preflightDeliveryZone(
    prisma,
    vendorOne?.id ?? null,
    'JERUSALEM',
    25,
  );

  const category = await preflightCategory(
    prisma,
    CATEGORY_NAME_EN,
    'أزياء نسائية تجريبية',
  );
  const brand = await preflightBrand(
    prisma,
    'Demo Style',
    BRAND_NORMALIZED_NAME,
  );

  const canonicalProduct = await preflightCanonicalProduct(
    prisma,
    brand?.id ?? null,
    category?.id ?? null,
    'Demo Classic Cotton Shirt',
    'قميص قطني كلاسيك',
    'Demo Classic Cotton Shirt',
  );
  const canonicalVariant = await preflightCanonicalVariant(
    prisma,
    canonicalProduct?.id ?? null,
    {
      color: 'أبيض',
      size: 'M',
    },
  );

  const offerOne = await preflightOffer(
    prisma,
    vendorOne?.id ?? null,
    canonicalProduct?.id ?? null,
    'قميص قطني كلاسيك أبيض',
    'Demo Classic Cotton Shirt - White',
  );
  const variantOne = await preflightOfferVariant(
    prisma,
    vendorOne?.id ?? null,
    offerOne?.id ?? null,
    canonicalVariant?.id ?? null,
    OFFER_ONE_SELLER_SKU,
    120,
  );

  const offerTwo = await preflightOffer(
    prisma,
    vendorTwo?.id ?? null,
    canonicalProduct?.id ?? null,
    'قميص قطني كلاسيك أبيض',
    'Demo Classic Cotton Shirt - White (Store Two)',
  );
  const variantTwo = await preflightOfferVariant(
    prisma,
    vendorTwo?.id ?? null,
    offerTwo?.id ?? null,
    canonicalVariant?.id ?? null,
    OFFER_TWO_SELLER_SKU,
    135,
  );

  const branchStockOne = await preflightBranchStock(
    prisma,
    branchOneA?.id ?? null,
    variantOne?.id ?? null,
  );
  const branchStockTwo = await preflightBranchStock(
    prisma,
    branchTwoA?.id ?? null,
    variantTwo?.id ?? null,
  );

  const address = await preflightAddress(prisma, customerProfile?.id ?? null);

  return {
    ownerUser,
    employeeUser,
    customerUser,
    ownerProfile,
    employeeProfile,
    customerProfile,
    vendorOne,
    vendorTwo,
    subscriptionOne,
    subscriptionTwo,
    applicableCategoryOne,
    applicableCategoryTwo,
    branchOneA,
    branchOneB,
    branchTwoA,
    ownerMembershipOne,
    ownerMembershipTwo,
    employeeMembership,
    deliveryWindows,
    zoneWestBank,
    zoneJerusalem,
    category,
    brand,
    canonicalProduct,
    canonicalVariant,
    offerOne,
    variantOne,
    offerTwo,
    variantTwo,
    branchStockOne,
    branchStockTwo,
    address,
  };
}

// ---------------------------------------------------------------------
// Phase 2: APPLY - runs entirely inside one `prisma.$transaction`.
// Every helper below only ever creates a row the preflight phase
// already determined is missing; an entity the preflight found
// existing-and-matching is passed straight through untouched.
// ---------------------------------------------------------------------

async function createUser(
  tx: Prisma.TransactionClient,
  phone: string,
  password: string,
): Promise<User> {
  const passwordHash = await bcrypt.hash(password, 10);
  return tx.user.create({
    data: { phone, passwordHash, phoneVerifiedAt: new Date() },
  });
}

async function createVendor(
  tx: Prisma.TransactionClient,
  input: VendorSeedInput,
): Promise<Vendor> {
  // ACTIVE + storefrontPublished + subscriptionStatus ACTIVE + an
  // external contact (PDR-007) is exactly the state
  // assertItemsPurchasable() (checkout) and StorefrontController
  // (public visibility) both require.
  return tx.vendor.create({
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
}

async function createBranch(
  tx: Prisma.TransactionClient,
  vendorId: string,
  name: string,
): Promise<StoreBranch> {
  return tx.storeBranch.create({
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
}

async function ensureSubscription(
  tx: Prisma.TransactionClient,
  existing: VendorSubscription | null,
  vendorId: string,
): Promise<void> {
  if (existing) return;
  const periodEnd = new Date();
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 30);
  await tx.vendorSubscription.create({
    data: { vendorId, status: 'ACTIVE', periodEnd },
  });
}

async function ensureVendorUserTx(
  tx: Prisma.TransactionClient,
  existing: VendorUser | null,
  userId: string,
  vendorId: string,
  role: 'OWNER' | 'BRANCH_EMPLOYEE',
  branchId: string | null,
): Promise<void> {
  if (existing) return;
  await tx.vendorUser.create({ data: { userId, vendorId, role, branchId } });
}

async function ensureApplicableCategoryTx(
  tx: Prisma.TransactionClient,
  existing: VendorApplicableCategory | null,
  vendorId: string,
  category: StoreApplicableCategory,
): Promise<void> {
  if (existing) return;
  await tx.vendorApplicableCategory.create({ data: { vendorId, category } });
}

async function ensureDeliveryZoneTx(
  tx: Prisma.TransactionClient,
  existing: VendorDeliveryZone | null,
  vendorId: string,
  region: DeliveryZoneRegion,
  fee: number,
): Promise<void> {
  if (existing) return;
  await tx.vendorDeliveryZone.create({
    data: { vendorId, region, enabled: true, fee },
  });
}

async function ensureProfile(
  tx: Prisma.TransactionClient,
  existing: CustomerProfile | null,
  userId: string,
  displayName: string,
): Promise<CustomerProfile> {
  return (
    existing ?? tx.customerProfile.create({ data: { userId, displayName } })
  );
}

interface ApplyPlanResult {
  vendorOne: Vendor;
  vendorTwo: Vendor;
  branchOneA: StoreBranch;
  branchOneB: StoreBranch;
  branchTwoA: StoreBranch;
  canonicalProduct: CanonicalProduct;
}

async function applyPlan(
  tx: Prisma.TransactionClient,
  plan: Awaited<ReturnType<typeof preflight>>,
  lines: string[],
): Promise<ApplyPlanResult> {
  note(lines, '== Sprint 12 demo seed ==');

  // ---- Accounts ----
  note(lines, '\n-- Accounts --');
  const ownerUser =
    plan.ownerUser ??
    (await createUser(tx, DEMO.owner.phone, DEMO.owner.password));
  note(
    lines,
    plan.ownerUser
      ? `  Owner: already exists (${DEMO.owner.phone}) - left untouched.`
      : `  Owner: created (${DEMO.owner.phone}).`,
  );
  const employeeUser =
    plan.employeeUser ??
    (await createUser(tx, DEMO.employee.phone, DEMO.employee.password));
  note(
    lines,
    plan.employeeUser
      ? `  Employee: already exists (${DEMO.employee.phone}) - left untouched.`
      : `  Employee: created (${DEMO.employee.phone}).`,
  );
  const customerUser =
    plan.customerUser ??
    (await createUser(tx, DEMO.customer.phone, DEMO.customer.password));
  note(
    lines,
    plan.customerUser
      ? `  Customer: already exists (${DEMO.customer.phone}) - left untouched.`
      : `  Customer: created (${DEMO.customer.phone}).`,
  );

  await ensureProfile(
    tx,
    plan.ownerProfile,
    ownerUser.id,
    DEMO.owner.displayName,
  );
  await ensureProfile(
    tx,
    plan.employeeProfile,
    employeeUser.id,
    DEMO.employee.displayName,
  );
  const customerProfile = await ensureProfile(
    tx,
    plan.customerProfile,
    customerUser.id,
    DEMO.customer.displayName,
  );

  // ---- Vendor One: two branches (owner + employee, delivery + pickup) ----
  note(lines, '\n-- Vendor one (delivery + pickup, owner + employee) --');
  const vendorOne = plan.vendorOne ?? (await createVendor(tx, VENDOR_ONE));
  note(
    lines,
    plan.vendorOne
      ? `  Vendor "${VENDOR_ONE.displayName}": already exists (${VENDOR_ONE.slug}) - left untouched.`
      : `  Vendor "${VENDOR_ONE.displayName}": created (${VENDOR_ONE.slug}).`,
  );
  await ensureSubscription(tx, plan.subscriptionOne, vendorOne.id);
  await ensureVendorUserTx(
    tx,
    plan.ownerMembershipOne,
    ownerUser.id,
    vendorOne.id,
    'OWNER',
    null,
  );
  await ensureApplicableCategoryTx(
    tx,
    plan.applicableCategoryOne,
    vendorOne.id,
    'WOMEN',
  );

  const branchOneA =
    plan.branchOneA ??
    (await createBranch(tx, vendorOne.id, BRANCH_ONE_A_NAME));
  note(
    lines,
    plan.branchOneA
      ? `  Branch "${BRANCH_ONE_A_NAME}": already exists - left untouched.`
      : `  Branch "${BRANCH_ONE_A_NAME}": created.`,
  );
  const branchOneB =
    plan.branchOneB ??
    (await createBranch(tx, vendorOne.id, BRANCH_ONE_B_NAME));
  note(
    lines,
    plan.branchOneB
      ? `  Branch "${BRANCH_ONE_B_NAME}": already exists - left untouched.`
      : `  Branch "${BRANCH_ONE_B_NAME}": created.`,
  );

  await ensureVendorUserTx(
    tx,
    plan.employeeMembership,
    employeeUser.id,
    vendorOne.id,
    'BRANCH_EMPLOYEE',
    branchOneA.id,
  );

  // 09:00-18:00 every day, so a delivery slot is always bookable within
  // the checkout's own next-3-days window regardless of today's date.
  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
    if (!plan.deliveryWindows[dayOfWeek]) {
      await tx.deliveryWindow.create({
        data: {
          vendorId: vendorOne.id,
          branchId: branchOneA.id,
          dayOfWeek,
          startMinute: 9 * 60,
          endMinute: 18 * 60,
          capacity: 10,
        },
      });
    }
  }
  await ensureDeliveryZoneTx(
    tx,
    plan.zoneWestBank,
    vendorOne.id,
    'WEST_BANK',
    15,
  );
  await ensureDeliveryZoneTx(
    tx,
    plan.zoneJerusalem,
    vendorOne.id,
    'JERUSALEM',
    25,
  );

  // ---- Vendor Two: one branch (pickup only, no staff) ----
  note(lines, '\n-- Vendor two (pickup, second store for comparison) --');
  const vendorTwo = plan.vendorTwo ?? (await createVendor(tx, VENDOR_TWO));
  note(
    lines,
    plan.vendorTwo
      ? `  Vendor "${VENDOR_TWO.displayName}": already exists (${VENDOR_TWO.slug}) - left untouched.`
      : `  Vendor "${VENDOR_TWO.displayName}": created (${VENDOR_TWO.slug}).`,
  );
  await ensureSubscription(tx, plan.subscriptionTwo, vendorTwo.id);
  await ensureVendorUserTx(
    tx,
    plan.ownerMembershipTwo,
    ownerUser.id,
    vendorTwo.id,
    'OWNER',
    null,
  );
  await ensureApplicableCategoryTx(
    tx,
    plan.applicableCategoryTwo,
    vendorTwo.id,
    'WOMEN',
  );
  const branchTwoA =
    plan.branchTwoA ??
    (await createBranch(tx, vendorTwo.id, BRANCH_TWO_A_NAME));
  note(
    lines,
    plan.branchTwoA
      ? `  Branch "${BRANCH_TWO_A_NAME}": already exists - left untouched.`
      : `  Branch "${BRANCH_TWO_A_NAME}": created.`,
  );

  // ---- Canonical product + confirmed matches from BOTH vendors ----
  note(lines, '\n-- Canonical product + comparison-ready matched offers --');
  const category =
    plan.category ??
    (await tx.category.create({
      data: { nameEn: CATEGORY_NAME_EN, nameAr: 'أزياء نسائية تجريبية' },
    }));
  const brand =
    plan.brand ??
    (await tx.brand.create({
      data: { name: 'Demo Style', normalizedName: BRAND_NORMALIZED_NAME },
    }));

  // Round-2 review fix (Blocker 2): canonicalNameAr/En are set directly
  // in this create() call, never backfilled onto an existing row later.
  // preflightCanonicalProduct() above already guarantees that if this
  // product already existed, it already had these exact values - or
  // the whole run would have aborted with DEMO_SEED_CONFLICT before
  // reaching this transaction at all.
  const canonicalProduct =
    plan.canonicalProduct ??
    (await tx.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: 'Demo Classic Cotton Shirt',
        status: 'PUBLISHED',
        canonicalNameAr: 'قميص قطني كلاسيك',
        canonicalNameEn: 'Demo Classic Cotton Shirt',
      },
    }));

  const canonicalVariant =
    plan.canonicalVariant ??
    (await tx.canonicalProductVariant.create({
      data: {
        canonicalProductId: canonicalProduct.id,
        structuralAttributes: { color: 'أبيض', size: 'M' },
        gtin: CANONICAL_GTIN,
        platformProductBarcode: CANONICAL_PLATFORM_BARCODE,
      },
    }));

  const offerOne =
    plan.offerOne ??
    (await tx.vendorOffer.create({
      data: {
        vendorId: vendorOne.id,
        canonicalProductId: canonicalProduct.id,
        titleAr: 'قميص قطني كلاسيك أبيض',
        titleEn: 'Demo Classic Cotton Shirt - White',
        status: 'ACTIVE',
      },
    }));
  const variantOne =
    plan.variantOne ??
    (await tx.offerVariant.create({
      data: {
        vendorId: vendorOne.id,
        vendorOfferId: offerOne.id,
        canonicalVariantId: canonicalVariant.id,
        matchProposalStatus: 'CONFIRMED',
        sellerSku: OFFER_ONE_SELLER_SKU,
        basePrice: 120,
        storeInventoryBarcode: `DEMO-${OFFER_ONE_SELLER_SKU}`,
      },
    }));
  note(
    lines,
    plan.offerOne && plan.variantOne
      ? '  Offer "Demo Classic Cotton Shirt - White": already existed - left untouched.'
      : '  Offer "Demo Classic Cotton Shirt - White": created.',
  );

  const offerTwo =
    plan.offerTwo ??
    (await tx.vendorOffer.create({
      data: {
        vendorId: vendorTwo.id,
        canonicalProductId: canonicalProduct.id,
        titleAr: 'قميص قطني كلاسيك أبيض',
        titleEn: 'Demo Classic Cotton Shirt - White (Store Two)',
        status: 'ACTIVE',
      },
    }));
  const variantTwo =
    plan.variantTwo ??
    (await tx.offerVariant.create({
      data: {
        vendorId: vendorTwo.id,
        vendorOfferId: offerTwo.id,
        canonicalVariantId: canonicalVariant.id,
        matchProposalStatus: 'CONFIRMED',
        sellerSku: OFFER_TWO_SELLER_SKU,
        basePrice: 135,
        storeInventoryBarcode: `DEMO-${OFFER_TWO_SELLER_SKU}`,
      },
    }));
  note(
    lines,
    plan.offerTwo && plan.variantTwo
      ? '  Offer "Demo Classic Cotton Shirt - White (Store Two)": already existed - left untouched.'
      : '  Offer "Demo Classic Cotton Shirt - White (Store Two)": created.',
  );

  // ---- Stock ----
  note(lines, '\n-- Stock --');
  if (!plan.branchStockOne) {
    await tx.branchStock.create({
      data: {
        vendorId: vendorOne.id,
        branchId: branchOneA.id,
        offerVariantId: variantOne.id,
        quantity: 25,
      },
    });
  }
  if (!plan.branchStockTwo) {
    await tx.branchStock.create({
      data: {
        vendorId: vendorTwo.id,
        branchId: branchTwoA.id,
        offerVariantId: variantTwo.id,
        quantity: 25,
      },
    });
  }
  note(lines, '  Stock ensured at both branches.');

  // ---- Customer address (for the delivery checkout path) ----
  note(lines, '\n-- Customer address --');
  if (!plan.address) {
    await tx.address.create({
      data: {
        customerId: customerProfile.id,
        label: DEMO_ADDRESS_LABEL,
        lat: 31.9,
        lng: 35.2,
        landmarkNote: 'بجانب الدوار الرئيسي',
        phoneNumber1: DEMO.customer.phone,
        zone: 'WEST_BANK',
      },
    });
    note(lines, '  Demo address: created (zone WEST_BANK).');
  } else {
    note(lines, '  Demo address: already exists - left untouched.');
  }

  return {
    vendorOne,
    vendorTwo,
    branchOneA,
    branchOneB,
    branchTwoA,
    canonicalProduct,
  };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  requireLocalDatabase(connectionString);
  const prisma = new PrismaClient({ adapter: new PrismaPg(connectionString) });

  try {
    const plan = await preflight(prisma);

    const lines: string[] = [];
    const result = await prisma.$transaction(
      (tx) => applyPlan(tx, plan, lines),
      { timeout: 20_000 },
    );

    // ---- Summary ----
    note(lines, '\n== Demo accounts (LOCAL ONLY - never real secrets) ==');
    note(lines, `  Owner:    ${DEMO.owner.phone} / ${DEMO.owner.password}`);
    note(
      lines,
      `  Employee: ${DEMO.employee.phone} / ${DEMO.employee.password}  (branch: ${result.branchOneA.name})`,
    );
    note(
      lines,
      `  Customer: ${DEMO.customer.phone} / ${DEMO.customer.password}`,
    );

    note(lines, '\n== Vendor / branch identifiers ==');
    note(
      lines,
      `  Vendor one: ${result.vendorOne.id}  (slug: ${result.vendorOne.slug})`,
    );
    note(
      lines,
      `    Branch A (${result.branchOneA.name}): ${result.branchOneA.id}`,
    );
    note(
      lines,
      `    Branch B (${result.branchOneB.name}): ${result.branchOneB.id}`,
    );
    note(
      lines,
      `  Vendor two: ${result.vendorTwo.id}  (slug: ${result.vendorTwo.slug})`,
    );
    note(
      lines,
      `    Branch A (${result.branchTwoA.name}): ${result.branchTwoA.id}`,
    );
    note(lines, `  Canonical product: ${result.canonicalProduct.id}`);

    note(lines, '\n== Pages to open for the demo (web on localhost:3000) ==');
    note(lines, '  Login:                /login');
    note(lines, `  Store one storefront:  /store/${result.vendorOne.slug}`);
    note(lines, `  Store two storefront:  /store/${result.vendorTwo.slug}`);
    note(
      lines,
      `  Comparison card/list:  /compare/${result.canonicalProduct.id}`,
    );
    note(lines, '  Discovery (All page):  /discovery');
    note(lines, '  Customer cart:         /cart');
    note(lines, '  Customer checkout:     /checkout');
    note(lines, '  Customer Orders UI:    /orders');
    note(
      lines,
      `  Branch A orders/staff: /vendor/${result.vendorOne.id}/branches/${result.branchOneA.id}/orders`,
    );
    note(
      lines,
      `  Branch A delivery windows: /vendor/${result.vendorOne.id}/branches/${result.branchOneA.id}/delivery-windows`,
    );
    note(
      lines,
      `  Vendor one delivery zones: /vendor/${result.vendorOne.id}/delivery-zones`,
    );

    note(lines, '\nSeed complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
