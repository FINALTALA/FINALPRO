import { execFileSync } from 'child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';
import { API_ROOT } from './helpers/seed-demo-db';
import {
  createDisposableDatabase,
  dropDisposableDatabase,
} from './helpers/test-databases';
import {
  NOTIFICATION_AUDIENCE_AT_TB26,
  NOTIFICATION_AUDIENCE_BY_TYPE,
  NOTIFICATION_TYPES_AFTER_TB26,
  ORDER_CANCELLED_IS_DUAL,
} from './helpers/notification-audience-table';

const MIGRATION = '20261115120000_tb26_notification_audience';
const MIGRATIONS_DIR = join(API_ROOT, 'prisma', 'migrations');

// TB-26: the audience migration, applied with the real `prisma migrate
// deploy` to databases of its own:
//  1. a database holding an AMBIGUOUS ORDER_CANCELLED row (the customer is
//     also a member of the store - a self-purchase) must make the
//     migration RAISE, and the database must be exactly as before: no new
//     type, no column, no constraint, no partial backfill, no outbox
//     change;
//  2. a database with one row of every kind is classified exactly as the
//     table says, unsent outbox events get the audience of their type,
//     sent / dead-lettered / unknown ones are left alone, and the new
//     constraints hold.
describe('TB-26 notification audience migration (e2e)', () => {
  const sharedUrl = process.env.DATABASE_URL!;
  const work = mkdtempSync(join(tmpdir(), 'tb26-mig-'));
  const created: string[] = [];

  afterAll(async () => {
    for (const name of created) await dropDisposableDatabase(sharedUrl, name);
    rmSync(work, { recursive: true, force: true });
  });

  /** A migrations folder with every migration before TB-26 (and TB-26
   * itself only when asked), plus a config file pointing at it. */
  function migrationsCopy(label: string, withTb26: boolean): string {
    const dir = join(work, label);
    const migrations = join(dir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name >= MIGRATION && !withTb26) continue;
      if (entry.isDirectory() && entry.name > MIGRATION) continue;
      cpSync(join(MIGRATIONS_DIR, entry.name), join(migrations, entry.name), {
        recursive: true,
      });
    }
    const config = join(dir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(API_ROOT, 'prisma', 'schema.prisma'),
        migrations: { path: migrations },
        datasource: { url: 'env:unused' },
      })};\n`.replace('"env:unused"', 'process.env.DATABASE_URL'),
    );
    return config;
  }

  function deploy(config: string, url: string): { ok: boolean; out: string } {
    try {
      const out = execFileSync(
        process.execPath,
        [
          require.resolve('prisma/build/index.js'),
          'migrate',
          'deploy',
          '--config',
          config,
        ],
        {
          cwd: API_ROOT,
          env: { ...process.env, DATABASE_URL: url },
          stdio: 'pipe',
        },
      ).toString();
      return { ok: true, out };
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      return {
        ok: false,
        out: `${e.stdout?.toString() ?? ''}\n${e.stderr?.toString() ?? ''}`,
      };
    }
  }

  async function database(label: string) {
    const name = `finalpro_tb26_${label}_${process.pid}`;
    const url = await createDisposableDatabase(sharedUrl, name);
    created.push(name);
    const before = deploy(migrationsCopy(`${label}-before`, false), url);
    expect(before.ok).toBe(true);
    const db = new Client({ connectionString: url });
    await db.connect();
    return { url, db };
  }

  /** A store (branch B) with an owner, a customer who is nobody in the
   * store, and a customer who is also an employee of it. */
  async function seed(db: Client) {
    const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
    const id = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
    const user = async (label: string) => {
      const u = id(label);
      await q(
        `INSERT INTO users (id, phone, "passwordHash") VALUES ($1, $2, 'x')`,
        [u, `+97056${Math.floor(1e6 + Math.random() * 8e6)}`],
      );
      const p = id(`${label}-profile`);
      await q(`INSERT INTO customer_profiles (id, "userId") VALUES ($1, $2)`, [
        p,
        u,
      ]);
      return { u, p };
    };
    const vendor = id('v');
    await q(`INSERT INTO vendors (id, "legalName", slug) VALUES ($1, $1, $1)`, [
      vendor,
    ]);
    const branch = id('b');
    await q(
      `INSERT INTO store_branches (id, "vendorId", name) VALUES ($1, $2, $1)`,
      [branch, vendor],
    );
    const owner = await user('owner');
    const customer = await user('customer');
    const self = await user('self');
    await q(
      `INSERT INTO vendor_users (id, "userId", "vendorId", role) VALUES ($1, $2, $3, 'OWNER')`,
      [id('vu'), owner.u, vendor],
    );
    await q(
      `INSERT INTO vendor_users (id, "userId", "vendorId", role, "branchId", status) VALUES ($1, $2, $3, 'BRANCH_EMPLOYEE', $4, 'SUSPENDED')`,
      [id('vu'), self.u, vendor, branch],
    );
    const order = async (customerProfile: string) => {
      const co = id('co');
      await q(
        `INSERT INTO customer_orders (id, "customerId") VALUES ($1, $2)`,
        [co, customerProfile],
      );
      const bo = id('bo');
      await q(
        `INSERT INTO branch_orders (id, "customerOrderId", "vendorId", "branchId", "fulfilmentMethod", "paymentMethod", subtotal, total, "updatedAt", "pickupCode")
         VALUES ($1, $2, $3, $4, 'PICKUP', 'COD', 10, 10, now(), $5)`,
        [
          bo,
          co,
          vendor,
          branch,
          String(100000 + Math.floor(Math.random() * 899999)),
        ],
      );
      return bo;
    };
    const customerOrder = await order(customer.p);
    const selfOrder = await order(self.p);
    const notification = async (
      recipient: string,
      type: string,
      targetType: string,
      targetId: string,
      vendorId: string | null,
      branchId: string | null,
    ) => {
      const n = id('n');
      // One sent event per notification (unique per event+recipient).
      const event = id('e');
      await q(
        `INSERT INTO outbox_events (id, "eventType", payload, status) VALUES ($1, 'x', '{}'::jsonb, 'PUBLISHED')`,
        [event],
      );
      await q(
        `INSERT INTO notifications (id, "recipientUserId", "outboxEventId", type, data, "targetType", "targetId", "vendorId", "branchId")
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7, $8)`,
        [n, recipient, event, type, targetType, targetId, vendorId, branchId],
      );
      return n;
    };
    const outbox = async (
      eventType: string,
      payload: Record<string, unknown>,
      status = 'PENDING',
    ) => {
      const e = id('e');
      await q(
        `INSERT INTO outbox_events (id, "eventType", payload, status) VALUES ($1, $2, $3::jsonb, $4)`,
        [e, eventType, JSON.stringify(payload), status],
      );
      return e;
    };
    return {
      vendor,
      branch,
      owner,
      customer,
      self,
      customerOrder,
      selfOrder,
      notification,
      outbox,
    };
  }

  /** Everything the migration could touch, to compare before/after. */
  async function snapshot(db: Client) {
    const rows = async (sql: string) => (await db.query(sql)).rows;
    return {
      types: await rows(
        `SELECT typname FROM pg_type WHERE typname = 'NotificationAudience'`,
      ),
      columns: await rows(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications' ORDER BY ordinal_position`,
      ),
      constraints: await rows(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'notifications'::regclass ORDER BY conname`,
      ),
      indexes: await rows(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'notifications' ORDER BY indexname`,
      ),
      notifications: await rows(
        `SELECT to_jsonb(n) AS row FROM notifications n ORDER BY id`,
      ),
      outbox: await rows(
        `SELECT id, payload, status FROM outbox_events ORDER BY id`,
      ),
    };
  }

  const enumOf = async (db: Client) =>
    (
      await db.query(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'NotificationType' ORDER BY e.enumlabel`,
      )
    ).rows.map((r: { enumlabel: string }) => r.enumlabel);

  it('the snapshot at TB-26: the classification table used for the backfill covers every NotificationType that existed then, and the migration says the same as the table', async () => {
    const { db } = await database('table');
    try {
      const enumValues = await enumOf(db);
      const tableTypes = [
        ...Object.keys(NOTIFICATION_AUDIENCE_AT_TB26),
        ORDER_CANCELLED_IS_DUAL,
      ].sort();
      expect(tableTypes).toEqual(enumValues);
      // the types added later did not exist for that backfill
      for (const later of Object.keys(NOTIFICATION_TYPES_AFTER_TB26))
        expect(enumValues).not.toContain(later);

      const sql = readFileSync(
        join(MIGRATIONS_DIR, MIGRATION, 'migration.sql'),
        'utf8',
      );
      const inMigration: Record<string, string> = {};
      for (const m of sql.matchAll(/WHEN '([A-Z_]+)'\s+THEN '([A-Z]+)'/g)) {
        inMigration[m[1]] = m[2];
      }
      expect(inMigration).toEqual(NOTIFICATION_AUDIENCE_AT_TB26);
    } finally {
      await db.end();
    }
  });

  it("the current schema: every NotificationType is classified - TB-26's plus each type added later, every one of those by its own migration after TB-26 (VARIANT_BACK_IN_STOCK and FOLLOWED_STORE_NEW_PRODUCTS: CUSTOMER)", async () => {
    // the suite's own database carries every migration
    const db = new Client({ connectionString: sharedUrl });
    await db.connect();
    try {
      expect(
        [
          ...Object.keys(NOTIFICATION_AUDIENCE_BY_TYPE),
          ORDER_CANCELLED_IS_DUAL,
        ].sort(),
      ).toEqual(await enumOf(db));
    } finally {
      await db.end();
    }
    expect(NOTIFICATION_TYPES_AFTER_TB26).toMatchObject({
      VARIANT_BACK_IN_STOCK: { audience: 'CUSTOMER' },
      FOLLOWED_STORE_NEW_PRODUCTS: { audience: 'CUSTOMER' },
    });
    for (const [type, { migration }] of Object.entries(
      NOTIFICATION_TYPES_AFTER_TB26,
    )) {
      expect(migration > MIGRATION).toBe(true);
      expect(NOTIFICATION_AUDIENCE_AT_TB26[type]).toBeUndefined();
      const sql = readFileSync(
        join(MIGRATIONS_DIR, migration, 'migration.sql'),
        'utf8',
      );
      expect(sql).toContain(
        `ALTER TYPE "NotificationType" ADD VALUE '${type}'`,
      );
    }
  });

  it('an ambiguous ORDER_CANCELLED row (self-purchase) makes the migration RAISE - and the database is exactly as it was: no type, no column, no constraint, no partial backfill', async () => {
    const { url, db } = await database('ambiguous');
    try {
      const s = await seed(db);
      // Clear rows of every other kind too, so a partial backfill would show.
      await s.notification(
        s.customer.u,
        'RETURN_APPROVED',
        'RETURN',
        'r1',
        null,
        null,
      );
      await s.notification(
        s.owner.u,
        'NEW_ORDER_FOR_EMPLOYEE',
        'BRANCH_ORDER',
        s.customerOrder,
        s.vendor,
        s.branch,
      );
      await s.notification(
        s.customer.u,
        'ORDER_CANCELLED',
        'BRANCH_ORDER',
        s.customerOrder,
        s.vendor,
        s.branch,
      );
      // The customer who is also a (suspended) employee of the store.
      await s.notification(
        s.self.u,
        'ORDER_CANCELLED',
        'BRANCH_ORDER',
        s.selfOrder,
        s.vendor,
        s.branch,
      );
      await s.outbox('return.requested', {
        return_id: 'r1',
        vendor_id: s.vendor,
        branch_id: s.branch,
        recipient_user_id: s.owner.u,
      });
      const before = await snapshot(db);

      const result = deploy(migrationsCopy('ambiguous-tb26', true), url);
      expect(result.ok).toBe(false);
      expect(result.out).toContain(
        'TB-26 notification audience: 1 ambiguous ORDER_CANCELLED row(s), 0 unclassified row(s)',
      );

      const after = await snapshot(db);
      expect(after).toEqual(before);
      expect(after.types).toEqual([]);
      expect(
        after.columns.map((c: { column_name: string }) => c.column_name),
      ).not.toContain('audience');
      // Prisma records the failed attempt in its own table (finished_at
      // empty) - the only trace; nothing of the migration itself remains.
      const recorded = (
        await db.query(
          `SELECT finished_at, rolled_back_at, applied_steps_count FROM _prisma_migrations WHERE migration_name = $1`,
          [MIGRATION],
        )
      ).rows;
      expect(recorded).toHaveLength(1);
      expect(recorded[0].finished_at).toBeNull();
      expect(recorded[0].applied_steps_count).toBe(0);
    } finally {
      await db.end();
    }
  });

  it('an unsent branch_order.cancelled event whose recipient is the customer AND a member also RAISEs, changing nothing', async () => {
    const { url, db } = await database('pending');
    try {
      const s = await seed(db);
      await s.outbox('branch_order.cancelled', {
        branch_order_id: s.selfOrder,
        vendor_id: s.vendor,
        branch_id: s.branch,
        recipient_user_id: s.self.u,
      });
      const before = await snapshot(db);
      const result = deploy(migrationsCopy('pending-tb26', true), url);
      expect(result.ok).toBe(false);
      expect(result.out).toContain(
        '1 unsent branch_order.cancelled event(s) without a clear audience',
      );
      expect(await snapshot(db)).toEqual(before);
    } finally {
      await db.end();
    }
  });

  it('a clean database: every row gets its audience, ORDER_CANCELLED row by row; unsent events get the audience of their type; sent, dead-lettered and unknown ones are left alone; the constraints hold', async () => {
    const { url, db } = await database('clean');
    try {
      const s = await seed(db);
      const n = {
        cancelledToCustomer: await s.notification(
          s.customer.u,
          'ORDER_CANCELLED',
          'BRANCH_ORDER',
          s.customerOrder,
          s.vendor,
          s.branch,
        ),
        cancelledToOwner: await s.notification(
          s.owner.u,
          'ORDER_CANCELLED',
          'BRANCH_ORDER',
          s.customerOrder,
          s.vendor,
          s.branch,
        ),
        returnApproved: await s.notification(
          s.customer.u,
          'RETURN_APPROVED',
          'RETURN',
          'r1',
          null,
          null,
        ),
        reviewInvitation: await s.notification(
          s.customer.u,
          'REVIEW_INVITATION',
          'BRANCH_ORDER',
          s.customerOrder,
          s.vendor,
          s.branch,
        ),
        newOrder: await s.notification(
          s.owner.u,
          'NEW_ORDER_FOR_EMPLOYEE',
          'BRANCH_ORDER',
          s.customerOrder,
          s.vendor,
          s.branch,
        ),
        suspended: await s.notification(
          s.owner.u,
          'VENDOR_SUSPENDED',
          'VENDOR',
          s.vendor,
          s.vendor,
          null,
        ),
        integrity: await s.notification(
          s.owner.u,
          'ORDER_INTEGRITY_ALERT',
          'BRANCH_ORDER',
          s.customerOrder,
          null,
          null,
        ),
        // A self-purchase row of a single-audience type is NOT ambiguous.
        selfInvitation: await s.notification(
          s.self.u,
          'REVIEW_INVITATION',
          'BRANCH_ORDER',
          s.selfOrder,
          s.vendor,
          s.branch,
        ),
      };
      const e = {
        pendingCancelCustomer: await s.outbox('branch_order.cancelled', {
          branch_order_id: s.customerOrder,
          vendor_id: s.vendor,
          branch_id: s.branch,
          recipient_user_id: s.customer.u,
        }),
        failedCancelOwner: await s.outbox(
          'branch_order.cancelled',
          {
            branch_order_id: s.customerOrder,
            vendor_id: s.vendor,
            branch_id: s.branch,
            recipient_user_id: s.owner.u,
          },
          'FAILED',
        ),
        pendingReturnRequested: await s.outbox('return.requested', {
          return_id: 'r1',
          vendor_id: s.vendor,
          branch_id: s.branch,
          recipient_user_id: s.owner.u,
        }),
        pendingFollower: await s.outbox('offer.published_for_followers', {
          vendor_id: s.vendor,
          offer_id: 'o1',
        }),
        pendingAlert: await s.outbox('return.escalation_alert', {
          return_id: 'r1',
          reason: 'SLA_TIMEOUT',
          recipient_user_id: s.owner.u,
        }),
        publishedApproved: await s.outbox(
          'return.approved',
          { return_id: 'r1', recipient_user_id: s.customer.u },
          'PUBLISHED',
        ),
        deadApproved: await s.outbox(
          'return.approved',
          { return_id: 'r1', recipient_user_id: s.customer.u },
          'DEAD_LETTER',
        ),
        unknownType: await s.outbox('branch_order.converted_to_pickup', {
          branch_order_id: s.customerOrder,
          recipient_user_id: s.owner.u,
        }),
      };

      const result = deploy(migrationsCopy('clean-tb26', true), url);
      expect(result.ok).toBe(true);

      const audience = async (id: string) =>
        (
          await db.query(
            `SELECT audience::text AS a FROM notifications WHERE id = $1`,
            [id],
          )
        ).rows[0].a;
      expect(await audience(n.cancelledToCustomer)).toBe('CUSTOMER');
      expect(await audience(n.cancelledToOwner)).toBe('STORE');
      expect(await audience(n.returnApproved)).toBe('CUSTOMER');
      expect(await audience(n.reviewInvitation)).toBe('CUSTOMER');
      expect(await audience(n.newOrder)).toBe('STORE');
      expect(await audience(n.suspended)).toBe('STORE');
      expect(await audience(n.integrity)).toBe('PLATFORM');
      expect(await audience(n.selfInvitation)).toBe('CUSTOMER');

      const payload = async (id: string) =>
        (
          await db.query(`SELECT payload FROM outbox_events WHERE id = $1`, [
            id,
          ])
        ).rows[0].payload;
      expect((await payload(e.pendingCancelCustomer)).audience).toBe(
        'CUSTOMER',
      );
      expect((await payload(e.failedCancelOwner)).audience).toBe('STORE');
      expect((await payload(e.pendingReturnRequested)).audience).toBe('STORE');
      expect((await payload(e.pendingFollower)).audience).toBe('CUSTOMER');
      expect((await payload(e.pendingAlert)).audience).toBe('PLATFORM');
      expect(await payload(e.publishedApproved)).not.toHaveProperty('audience');
      expect(await payload(e.deadApproved)).not.toHaveProperty('audience');
      expect(await payload(e.unknownType)).not.toHaveProperty('audience');

      const col = (
        await db.query(
          `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'audience'`,
        )
      ).rows[0];
      expect(col.is_nullable).toBe('NO');

      // The constraints: a STORE row always names its store; a
      // branch-level one its branch; a store-wide one may omit the branch.
      const insert = (
        type: string,
        aud: string,
        vendorId: string | null,
        branchId: string | null,
      ) =>
        db.query(
          `WITH e AS (
             INSERT INTO outbox_events (id, "eventType", payload, status)
             VALUES (gen_random_uuid()::text, 'x', '{}'::jsonb, 'PUBLISHED') RETURNING id
           )
           INSERT INTO notifications (id, "recipientUserId", "outboxEventId", type, data, "targetType", "targetId", "vendorId", "branchId", audience)
           SELECT gen_random_uuid()::text, $1, e.id, $2, '{}'::jsonb, 'VENDOR', 'x', $3, $4, $5 FROM e`,
          [s.owner.u, type, vendorId, branchId, aud],
        );
      await expect(
        insert('NEW_ORDER_FOR_EMPLOYEE', 'STORE', null, s.branch),
      ).rejects.toThrow(/notifications_store_vendor_check/);
      await expect(
        insert('NEW_ORDER_FOR_EMPLOYEE', 'STORE', s.vendor, null),
      ).rejects.toThrow(/notifications_store_branch_check/);
      await expect(
        insert('VENDOR_REACTIVATED', 'STORE', s.vendor, null),
      ).resolves.toBeDefined();
      await expect(
        insert('RETURN_APPROVED', 'CUSTOMER', null, null),
      ).resolves.toBeDefined();
    } finally {
      await db.end();
    }
  });
});
