import { randomUUID } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const MIGRATION = '20260930100000_sprint17_owner_catalog';
const MIGRATIONS_DIR = join(__dirname, '..', 'prisma', 'migrations');

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  u.search = '';
  return u.toString();
}

// Sprint 17 (blocker 1, FR-PRICE-002): the honest one-time
// MIGRATED_BASELINE backfill of price_history for every OfferVariant
// that already existed before this migration ran (plus the brand
// sentinel and offer_variant_media.mediaType backfills, the migration's
// other two data-touching changes). Same scratch-database technique as
// sprint16-migration-backfill.e2e-spec.ts: every earlier migration is
// applied as-is, legacy rows are seeded directly, then the Sprint 17
// migration is applied ONCE on top (it is not idempotent - re-running it
// against an already-migrated schema would itself fail, exactly like a
// real `prisma migrate deploy` never re-runs an applied migration) and
// the result is inspected across several `it()`s - the only way to
// prove what a real production backfill would do.
describe('Sprint 17 - migration backfill of price_history (e2e)', () => {
  const scratch = `finalpro_s17_backfill_${Date.now()}`;
  let admin: Client;
  let db: Client;

  const variantNoSale = randomUUID();
  const variantWithSale = randomUUID();
  const legacyMediaId = randomUUID();
  const created = '2026-02-01T09:00:00.000Z';

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    admin = new Client({ connectionString: withDatabase(url, 'postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${scratch}"`);
    db = new Client({ connectionString: withDatabase(url, scratch) });
    await db.connect();

    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toContain(MIGRATION);
    for (const dir of dirs.filter((d) => d < MIGRATION)) {
      await db.query(
        readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'),
      );
    }

    // Seed every legacy row this describe block inspects, BEFORE the
    // Sprint 17 migration ever runs.
    const vendorId = randomUUID();
    await db.query(
      `INSERT INTO vendors (id, "legalName", slug) VALUES ($1, 'Legacy Vendor', $2)`,
      [vendorId, `legacy-${vendorId.slice(0, 8)}`],
    );
    const offerId = randomUUID();
    await db.query(
      `INSERT INTO vendor_offers (id, "vendorId", "titleAr", "titleEn") VALUES ($1, $2, 'قديم', 'Legacy')`,
      [offerId, vendorId],
    );
    // (a) basePrice only.
    await db.query(
      `INSERT INTO offer_variants (id, "vendorId", "vendorOfferId", "sellerSku", "storeInventoryBarcode", "basePrice", "createdAt")
       VALUES ($1, $2, $3, 'sku-a', $4, 40.00, $5)`,
      [variantNoSale, vendorId, offerId, `SIB-${variantNoSale}`, created],
    );
    // (b) basePrice + a manual salePrice already set at migration time -
    // effectivePriceAtChange must be the SALE price, not basePrice
    // (the exact rule every pre-Sprint-17 consumer already applied).
    await db.query(
      `INSERT INTO offer_variants (id, "vendorId", "vendorOfferId", "sellerSku", "storeInventoryBarcode", "basePrice", "salePrice", "createdAt")
       VALUES ($1, $2, $3, 'sku-b', $4, 100.00, 75.00, $5)`,
      [variantWithSale, vendorId, offerId, `SIB-${variantWithSale}`, created],
    );
    // A pre-existing media row - every video kind was introduced by
    // this same migration, so every row that already exists must be
    // treated as IMAGE, with certainty, not an approximation.
    await db.query(
      `INSERT INTO offer_variant_media (id, "vendorId", "offerVariantId", url, kind)
       VALUES ($1, $2, $3, 'https://example.com/legacy.jpg', 'PRIMARY')`,
      [legacyMediaId, vendorId, variantNoSale],
    );

    await db.query(
      readFileSync(join(MIGRATIONS_DIR, MIGRATION, 'migration.sql'), 'utf8'),
    );
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin?.end();
  });

  it("gives every pre-existing OfferVariant exactly one MIGRATED_BASELINE row, changedBy NULL, changedAt = the variant's own createdAt (never NOW())", async () => {
    const rows = await db.query(
      `SELECT "offerVariantId", "basePrice", "salePrice", "discountPercent",
              "effectivePriceAtChange", "currency", "reason", "changedBy",
              to_char("changedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "changedAt"
       FROM price_history WHERE "offerVariantId" IN ($1, $2) ORDER BY "offerVariantId"`,
      [variantNoSale, variantWithSale],
    );
    expect(rows.rows).toHaveLength(2);
    const byVariant = Object.fromEntries(
      rows.rows.map((r) => [r.offerVariantId, r]),
    );

    expect(byVariant[variantNoSale]).toMatchObject({
      basePrice: '40.00',
      salePrice: null,
      discountPercent: null,
      effectivePriceAtChange: '40.00',
      currency: 'ILS',
      reason: 'MIGRATED_BASELINE',
      changedBy: null,
      changedAt: created,
    });
    expect(byVariant[variantWithSale]).toMatchObject({
      basePrice: '100.00',
      salePrice: '75.00',
      discountPercent: null,
      effectivePriceAtChange: '75.00',
      currency: 'ILS',
      reason: 'MIGRATED_BASELINE',
      changedBy: null,
      changedAt: created,
    });
  });

  it('backfills the "No brand" sentinel exactly once, at the fixed documented id', async () => {
    const rows = await db.query(
      `SELECT id, name, "normalizedName", "isNoBrandSentinel" FROM brands WHERE "isNoBrandSentinel" = true`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      id: 'a0000000-0000-4000-8000-000000000001',
      normalizedName: 'no-brand',
      isNoBrandSentinel: true,
    });
  });

  it('backfills mediaType = IMAGE and sortOrder = 0 for every pre-existing offer_variant_media row', async () => {
    const rows = await db.query(
      `SELECT "mediaType", "sortOrder" FROM offer_variant_media WHERE id = $1`,
      [legacyMediaId],
    );
    expect(rows.rows[0]).toMatchObject({ mediaType: 'IMAGE', sortOrder: 0 });
  });
});
