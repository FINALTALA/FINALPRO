import { randomUUID } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const MIGRATION = '20261003070000_sprint18b_branches_operations';
const MIGRATIONS_DIR = join(__dirname, '..', 'prisma', 'migrations');

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  u.search = '';
  return u.toString();
}

// Review-round finding: branch_operating_hours_day_of_week_range is a
// real Postgres CHECK constraint, not just SubmitBranchEvidenceDto/
// UpdateBranchOperatingHoursDto's own 0-6 validation - a direct SQL
// write (a future migration, a manual fix, a bug elsewhere in the
// codebase that skips the DTO) must not be able to create a row for a
// day that can't be represented. Same scratch-database technique as
// sprint17-migration-backfill.e2e-spec.ts: every earlier migration is
// applied as-is, then this one, then raw INSERTs are attempted
// directly against the resulting table - bypassing Prisma/the DTO
// entirely, the only way to prove the constraint itself (not the
// application layer in front of it) is what actually rejects an
// out-of-range day.
describe('Sprint 18b - branch_operating_hours_day_of_week_range CHECK constraint (e2e)', () => {
  const scratch = `finalpro_s18b_dow_check_${Date.now()}`;
  let admin: Client;
  let db: Client;
  const vendorId = randomUUID();
  const branchId = randomUUID();

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
    for (const dir of dirs.filter((d) => d <= MIGRATION)) {
      await db.query(
        readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'),
      );
    }

    await db.query(
      `INSERT INTO vendors (id, "legalName", slug) VALUES ($1, $2, $3)`,
      [vendorId, 'Day-of-week constraint test vendor', `dow-test-${vendorId}`],
    );
    await db.query(
      `INSERT INTO store_branches (id, "vendorId", name) VALUES ($1, $2, $3)`,
      [branchId, vendorId, 'Day-of-week constraint test branch'],
    );
  });

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin?.end();
  });

  async function insertHours(dayOfWeek: number) {
    return db.query(
      `INSERT INTO branch_operating_hours
         (id, "vendorId", "branchId", "dayOfWeek", "openMinute", "closeMinute")
       VALUES ($1, $2, $3, $4, 540, 1020)`,
      [randomUUID(), vendorId, branchId, dayOfWeek],
    );
  }

  it('rejects dayOfWeek = -1 at the Postgres level (constraint violation, not a DTO error)', async () => {
    await expect(insertHours(-1)).rejects.toMatchObject({
      code: '23514', // check_violation
      constraint: 'branch_operating_hours_day_of_week_range',
    });
  });

  it('rejects dayOfWeek = 7 at the Postgres level (constraint violation, not a DTO error)', async () => {
    await expect(insertHours(7)).rejects.toMatchObject({
      code: '23514',
      constraint: 'branch_operating_hours_day_of_week_range',
    });
  });

  it('accepts the full valid range 0..6', async () => {
    for (let day = 0; day <= 6; day++) {
      await expect(insertHours(day)).resolves.toBeDefined();
    }
    const rows = await db.query(
      `SELECT "dayOfWeek" FROM branch_operating_hours WHERE "branchId" = $1 ORDER BY "dayOfWeek"`,
      [branchId],
    );
    expect(rows.rows.map((r) => r.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
