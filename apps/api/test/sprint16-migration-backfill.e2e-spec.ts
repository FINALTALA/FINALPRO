import { randomUUID } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const MIGRATION = '20260929100000_sprint16_platform_moderation';
const MIGRATIONS_DIR = join(__dirname, '..', 'prisma', 'migrations');

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  u.search = '';
  return u.toString();
}

// Sprint 16 (D3): the honest legacy backfill of StoreBranch.evidenceRevision
// / evidenceSubmittedAt. Runs on a SCRATCH database: every earlier
// migration is applied as-is, legacy rows are seeded, then the Sprint 16
// migration is applied on top and the result is inspected - the only way
// to prove what happens to rows that already existed.
describe('Sprint 16 - migration backfill of legacy branch evidence (e2e)', () => {
  const scratch = `finalpro_s16_backfill_${Date.now()}`;
  let admin: Client;
  let db: Client;

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
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin?.end();
  });

  const branch = async (
    vendorId: string,
    name: string,
    cols: {
      isPhysical?: boolean;
      lat?: number | null;
      lng?: number | null;
      photo?: string | null;
      status?: string;
      createdAt: string;
    },
  ) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO store_branches (id, "vendorId", name, "isPhysical", lat, lng, "verificationPhotoUrl", "verificationStatus", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"BranchVerificationStatus", $9)`,
      [
        id,
        vendorId,
        name,
        cols.isPhysical ?? true,
        cols.lat ?? null,
        cols.lng ?? null,
        cols.photo ?? null,
        cols.status ?? 'PENDING',
        cols.createdAt,
      ],
    );
    return id;
  };

  it('gives complete legacy evidence revision 1 (time from the latest audit row, else createdAt) and leaves everything else at revision 0 / NULL', async () => {
    const vendorId = randomUUID();
    await db.query(
      `INSERT INTO vendors (id, "legalName", slug) VALUES ($1, 'Legacy Vendor', $2)`,
      [vendorId, `legacy-${vendorId.slice(0, 8)}`],
    );

    const created = '2026-01-01T00:00:00.000Z';
    // (a) complete evidence, PENDING, with TWO audit rows -> latest wins
    const a = await branch(vendorId, 'a', {
      lat: 1,
      lng: 2,
      photo: 'https://x/a.jpg',
      createdAt: created,
    });
    // (b) complete evidence, APPROVED, no audit row -> createdAt fallback
    const b = await branch(vendorId, 'b', {
      lat: 1,
      lng: 2,
      photo: 'https://x/b.jpg',
      status: 'APPROVED',
      createdAt: created,
    });
    // (c) complete evidence, RESUBMISSION_REQUESTED, no audit row
    const c = await branch(vendorId, 'c', {
      lat: 1,
      lng: 2,
      photo: 'https://x/c.jpg',
      status: 'RESUBMISSION_REQUESTED',
      createdAt: created,
    });
    // (d) no evidence at all
    const d = await branch(vendorId, 'd', { createdAt: created });
    // (e) partial evidence: lat/lng but no photo
    const e = await branch(vendorId, 'e', {
      lat: 1,
      lng: 2,
      createdAt: created,
    });
    // (f) partial evidence: photo only
    const f = await branch(vendorId, 'f', {
      photo: 'https://x/f.jpg',
      createdAt: created,
    });
    // (g) NON-physical branch that happens to carry all three
    const g = await branch(vendorId, 'g', {
      isPhysical: false,
      lat: 1,
      lng: 2,
      photo: 'https://x/g.jpg',
      createdAt: created,
    });
    // (h) lat/lng present but the photo URL is whitespace-only - a
    // legacy/direct-DB row this backfill must NOT treat as complete
    // evidence, even though the column is non-null.
    const h = await branch(vendorId, 'h', {
      lat: 1,
      lng: 2,
      photo: '   ',
      createdAt: created,
    });

    for (const [when, extra] of [
      ['2026-03-01T10:00:00.000Z', 'first'],
      ['2026-03-05T12:30:00.000Z', 'latest'],
    ]) {
      await db.query(
        `INSERT INTO audit_logs (id, action, "entityType", "entityId", "correlationId", "occurredAt", "afterState")
         VALUES ($1, 'store_branch.evidence_submitted', 'StoreBranch', $2, $3, $4, $5::jsonb)`,
        [
          randomUUID(),
          a,
          `corr-${extra}`,
          when,
          JSON.stringify({ note: extra }),
        ],
      );
    }
    // An audit row for a DIFFERENT action on branch b must not be used.
    await db.query(
      `INSERT INTO audit_logs (id, action, "entityType", "entityId", "correlationId", "occurredAt")
       VALUES ($1, 'store_branch.verification_decided', 'StoreBranch', $2, 'corr-x', '2026-04-01T00:00:00.000Z')`,
      [randomUUID(), b],
    );

    await db.query(
      readFileSync(join(MIGRATIONS_DIR, MIGRATION, 'migration.sql'), 'utf8'),
    );

    const rows = await db.query(
      `SELECT id, "evidenceRevision" AS rev, to_char("evidenceSubmittedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM store_branches WHERE "vendorId" = $1`,
      [vendorId],
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
    expect(byId[a]).toMatchObject({ rev: 1, at: '2026-03-05T12:30:00.000Z' });
    expect(byId[b]).toMatchObject({ rev: 1, at: created });
    expect(byId[c]).toMatchObject({ rev: 1, at: created });
    for (const id of [d, e, f, g, h]) {
      expect(byId[id]).toMatchObject({ rev: 0, at: null });
    }
  });

  it('created the vendor_suspensions table with its partial unique index and CHECK, and left prior data untouched', async () => {
    const idx = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'vendor_suspensions_vendor_open_key'`,
    );
    expect(idx.rows[0].indexdef).toContain('WHERE ("reactivatedAt" IS NULL)');
    const chk = await db.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'vendor_suspensions_reactivation_all_or_none_check'`,
    );
    expect(chk.rowCount).toBe(1);
    const vendors = await db.query(`SELECT count(*)::int AS n FROM vendors`);
    expect(vendors.rows[0].n).toBe(1);
  });
});
