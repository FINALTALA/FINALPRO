import { randomUUID } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const MIGRATION = '20261003090001_sprint19_notification_relay';
const MIGRATIONS_DIR = join(__dirname, '..', 'prisma', 'migrations');

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  u.search = '';
  return u.toString();
}

// Sprint 19 (review-round finding): every PENDING/FAILED row for the
// three event types whose enqueue call sites did not yet snapshot a
// recipient (stock_movement.owner_notification, vendor.suspended,
// vendor.reactivated) predates the recipient-snapshot guarantee this
// sprint's application code adds. Resolving such a row's recipient
// later, at relay time, would use the CURRENT owner set instead of the
// set that existed when the event actually happened - exactly the
// snapshot-not-lookup violation explicitly rejected during planning.
// This sprint's own migration must instead move every such row
// straight to DEAD_LETTER with a specific, honest reason. Same
// scratch-database technique as sprint17-migration-backfill.e2e-spec.ts
// and sprint18b-operating-hours-day-constraint.e2e-spec.ts: every
// earlier migration applied as-is, legacy rows seeded directly via raw
// SQL (bypassing Prisma/the application entirely - this is the only
// way to prove the MIGRATION itself, not the app code around it, does
// this), then this migration applied once on top.
describe('Sprint 19 - legacy Outbox row migration (DEAD_LETTER backfill, e2e)', () => {
  const scratch = `finalpro_s19_legacy_${Date.now()}`;
  let admin: Client;
  let db: Client;

  const legacyStockMovementId = randomUUID();
  const legacyVendorSuspendedId = randomUUID();
  const freshStockMovementId = randomUUID();
  const unrelatedEventTypeId = randomUUID();
  const alreadyPublishedId = randomUUID();

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

    // Seed every legacy/fresh/unrelated row BEFORE the Sprint 19
    // migration ever runs - exactly the state a real pre-S19 database
    // would be in.
    await db.query(
      `INSERT INTO outbox_events (id, "eventType", payload, status, "createdAt", "attemptCount")
       VALUES
         ($1, 'stock_movement.owner_notification', '{"vendor_id":"v1"}'::jsonb, 'PENDING', now(), 0),
         ($2, 'vendor.suspended', '{"vendor_id":"v1"}'::jsonb, 'FAILED', now(), 2),
         ($3, 'stock_movement.owner_notification', '{"vendor_id":"v1","recipient_user_id":"u1"}'::jsonb, 'PENDING', now(), 0),
         ($4, 'branch_order.not_received_reported', '{"vendor_id":"v1"}'::jsonb, 'PENDING', now(), 0),
         ($5, 'vendor.reactivated', '{"vendor_id":"v1","recipient_user_id":"u1"}'::jsonb, 'PUBLISHED', now(), 1)`,
      [
        legacyStockMovementId,
        legacyVendorSuspendedId,
        freshStockMovementId,
        unrelatedEventTypeId,
        alreadyPublishedId,
      ],
    );

    await db.query(
      readFileSync(join(MIGRATIONS_DIR, MIGRATION, 'migration.sql'), 'utf8'),
    );
  });

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin?.end();
  });

  it('moves a legacy PENDING stock_movement row (no recipient_user_id) to DEAD_LETTER with the exact reason', async () => {
    const row = (
      await db.query(
        `SELECT status, "lastError" FROM outbox_events WHERE id = $1`,
        [legacyStockMovementId],
      )
    ).rows[0];
    expect(row).toMatchObject({
      status: 'DEAD_LETTER',
      lastError: 'LEGACY_MISSING_RECIPIENT_SNAPSHOT',
    });
  });

  it('moves a legacy FAILED vendor.suspended row (no recipient_user_id) to DEAD_LETTER too - not just PENDING ones', async () => {
    const row = (
      await db.query(`SELECT status, "lastError" FROM outbox_events WHERE id = $1`, [
        legacyVendorSuspendedId,
      ])
    ).rows[0];
    expect(row).toMatchObject({
      status: 'DEAD_LETTER',
      lastError: 'LEGACY_MISSING_RECIPIENT_SNAPSHOT',
    });
  });

  it('leaves a fresh-style row (same eventType, but carrying recipient_user_id) untouched and PENDING', async () => {
    const row = (
      await db.query(`SELECT status, "lastError" FROM outbox_events WHERE id = $1`, [
        freshStockMovementId,
      ])
    ).rows[0];
    expect(row).toMatchObject({ status: 'PENDING', lastError: null });
  });

  it('leaves an unrelated eventType (never missing a recipient to begin with) completely untouched', async () => {
    const row = (
      await db.query(`SELECT status, "lastError" FROM outbox_events WHERE id = $1`, [
        unrelatedEventTypeId,
      ])
    ).rows[0];
    expect(row).toMatchObject({ status: 'PENDING', lastError: null });
  });

  it('never touches an already-PUBLISHED row, even for one of the three affected event types', async () => {
    const row = (
      await db.query(`SELECT status, "lastError" FROM outbox_events WHERE id = $1`, [
        alreadyPublishedId,
      ])
    ).rows[0];
    expect(row).toMatchObject({ status: 'PUBLISHED', lastError: null });
  });
});
