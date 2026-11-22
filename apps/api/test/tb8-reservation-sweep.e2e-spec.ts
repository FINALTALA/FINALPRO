import { execFileSync } from 'child_process';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuditLogService } from './../src/audit/audit-log.service';
import { SessionService } from './../src/auth/session.service';
import {
  RESERVATION_SWEEP_AUDIT_ACTION,
  RESERVATION_SWEEP_BATCH_LIMIT,
  RESERVATION_SWEEP_GRACE_SECONDS,
  ReservationSweepService,
} from './../src/checkout/reservation-sweep.service';
import {
  lockOfferWideForRestock,
  lockSweepOrCreateStockRow,
} from './../src/checkout/stock-lock.util';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { FeatureFlagsService } from './../src/feature-flags/feature-flags.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { API_ROOT } from './helpers/seed-demo-db';
import {
  createDisposableDatabase,
  dropDisposableDatabase,
} from './helpers/test-databases';

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FLAG = 'reservation_sweep_enabled';

// TB-8: the periodic release of expired checkout reservations. It must
// release exactly what an expired hold holds (stock counter, items,
// delivery slots, the reservation row) and nothing else - never a live
// hold, never one inside the 60 s grace (database clock), never a
// return-exchange hold on the same stock row, never anything twice -
// one transaction per reservation, skipping whatever another path holds,
// with a 3 s lock_timeout, an audit row per release, and no deadlock
// against reserve / confirm / cancel / POS / restock / exchange expiry.
//
// Own database (as tb5-lock-order): pg_stat_database.deadlocks is per
// database, and these tests count expired holds table-wide.
describe('TB-8 expired reservation sweep (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sweep: ReservationSweepService;
  const sharedUrl = process.env.DATABASE_URL!;
  const dbName = `finalpro_tb8sweep_test_${process.pid}`;

  beforeAll(async () => {
    // TB-13: created marked as a disposable test database.
    const url = await createDisposableDatabase(sharedUrl, dbName);
    execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        'prisma7.config.ts',
      ],
      {
        cwd: API_ROOT,
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
        timeout: 120_000,
      },
    );
    process.env.DATABASE_URL = url;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    sweep = app.get(ReservationSweepService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    process.env.DATABASE_URL = sharedUrl;
    // TB-13: dropped only after its own marker is checked.
    await dropDisposableDatabase(sharedUrl, dbName);
  }, 120_000);

  // Every test starts with the flag on and no expired hold left over
  // from an earlier test (each sweep is table-wide).
  beforeEach(async () => {
    await setFlag(true);
    await prisma.$executeRaw`UPDATE checkout_reservations SET "expiresAt" = now() + interval '1 day' WHERE "expiresAt" < now() + interval '1 hour'`;
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function setFlag(enabled: boolean) {
    await prisma.featureFlag.upsert({
      where: { key: FLAG },
      create: { key: FLAG, enabled, description: 'test' },
      update: { enabled },
    });
  }

  async function account() {
    const phone = `+97056${String((Date.now() + (counter += 1) * 7919) % 1e7).padStart(7, '0')}`;
    const user = await prisma.user.create({
      data: { phone, passwordHash: 'x', phoneVerifiedAt: new Date() },
    });
    const profile = await prisma.customerProfile.create({
      data: { userId: user.id },
    });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { token, userId: user.id, customerId: profile.id };
  }
  type Account = Awaited<ReturnType<typeof account>>;

  async function store() {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('tb8-sweep').toLowerCase(),
        legalName: unique('L'),
        displayName: 'متجر',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    await prisma.vendorSubscription.create({
      data: {
        vendorId: vendor.id,
        status: 'ACTIVE',
        periodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('محل'),
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
    const owner = await account();
    await prisma.vendorUser.create({
      data: { userId: owner.userId, vendorId: vendor.id, role: 'OWNER' },
    });
    return { vendorId: vendor.id, branchId: branch.id, owner };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  async function variant(s: Store, quantity: number) {
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendorId,
        titleAr: unique('عرض'),
        titleEn: unique('Offer'),
        status: 'ACTIVE',
      },
    });
    const v = await prisma.offerVariant.create({
      data: {
        vendorId: s.vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique('sku'),
        basePrice: 20,
        storeInventoryBarcode: unique('barcode'),
      },
    });
    const stock = await prisma.branchStock.create({
      data: {
        vendorId: s.vendorId,
        branchId: s.branchId,
        offerVariantId: v.id,
        quantity,
      },
    });
    return { variantId: v.id, stockId: stock.id };
  }
  type Variant = Awaited<ReturnType<typeof variant>>;

  async function addToCart(a: Account, s: Store, variantId: string, qty = 1) {
    const res = await http()
      .post('/api/v1/cart/items')
      .set(auth(a.token))
      .set('Idempotency-Key', unique('cart'))
      .send({
        vendor_id: s.vendorId,
        offer_variant_id: variantId,
        quantity: qty,
      })
      .expect(201);
    return res.body.id as string;
  }

  const reserve = (a: Account, s: Store, cartItemIds: string[]) =>
    http()
      .post('/api/v1/checkout/reserve')
      .set(auth(a.token))
      .set('Idempotency-Key', unique('reserve'))
      .send({
        terms_accepted: true,
        terms_version: '2026-10-v1',
        groups: [
          {
            cart_item_ids: cartItemIds,
            branch_id: s.branchId,
            fulfilment_method: 'PICKUP',
            payment_method: 'COD',
          },
        ],
      });
  const confirm = (a: Account, reservationId: string) =>
    http()
      .post('/api/v1/checkout/confirm')
      .set(auth(a.token))
      .set('Idempotency-Key', unique('confirm'))
      .send({ reservation_id: reservationId });
  const cancel = (a: Account, reservationId: string) =>
    http()
      .post(`/api/v1/checkout/reservations/${reservationId}/cancel`)
      .set(auth(a.token));
  const posSale = (s: Store, variantId: string) =>
    http()
      .post(
        `/api/v1/vendors/${s.vendorId}/branches/${s.branchId}/stock/${variantId}/movements`,
      )
      .set(auth(s.owner.token))
      .set('Idempotency-Key', unique('pos'))
      .send({ reason: 'SALE', quantity_delta: -1, reason_note: 'بيع' });

  /** A real hold through the API (cart -> reserve), for one variant. */
  async function apiHold(s: Store, v: Variant, qty = 1) {
    const a = await account();
    const line = await addToCart(a, s, v.variantId, qty);
    const r = await reserve(a, s, [line]).expect(201);
    return { a, reservationId: r.body.reservation_id as string };
  }

  /** A hold written directly (as reserve() writes it), for bulk tests. */
  async function directHold(s: Store, items: { v: Variant; qty: number }[]) {
    const a = await account();
    const reservation = await prisma.checkoutReservation.create({
      data: {
        customerId: a.customerId,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        platformTermsVersion: '2026-10-v1',
        termsAcceptedAt: new Date(),
      },
    });
    for (const { v, qty } of items) {
      await prisma.checkoutReservationItem.create({
        data: {
          reservationId: reservation.id,
          vendorId: s.vendorId,
          branchId: s.branchId,
          offerVariantId: v.variantId,
          quantity: qty,
          unitPriceAtReserve: 20,
          fulfilmentMethod: 'PICKUP',
          paymentMethod: 'COD',
        },
      });
      await prisma.branchStock.update({
        where: { id: v.stockId },
        data: { reservedQuantity: { increment: qty } },
      });
    }
    return { a, reservationId: reservation.id };
  }

  /** Move a reservation's expiry to `seconds` ago by the DATABASE clock. */
  async function expire(reservationId: string, seconds = 120) {
    await prisma.$executeRaw`UPDATE checkout_reservations SET "expiresAt" = now() - make_interval(secs => ${seconds}) WHERE id = ${reservationId}`;
  }

  async function counterOf(v: Variant) {
    return (
      await prisma.branchStock.findUniqueOrThrow({ where: { id: v.stockId } })
    ).reservedQuantity;
  }

  async function heldItems(s: Store, v: Variant) {
    const r = await prisma.checkoutReservationItem.aggregate({
      where: { branchId: s.branchId, offerVariantId: v.variantId },
      _sum: { quantity: true },
    });
    return r._sum.quantity ?? 0;
  }

  /** The TB-8 invariant: counter = checkout items still held + exchange holds. */
  async function expectCounter(s: Store, v: Variant, exchangeHeld = 0) {
    const stock = await prisma.branchStock.findUniqueOrThrow({
      where: { id: v.stockId },
    });
    expect(stock.reservedQuantity).toBe((await heldItems(s, v)) + exchangeHeld);
    expect(stock.quantity).toBeGreaterThanOrEqual(stock.reservedQuantity);
  }

  const auditRows = (reservationId: string) =>
    prisma.auditLog.findMany({
      where: {
        action: RESERVATION_SWEEP_AUDIT_ACTION,
        entityId: reservationId,
      },
    });

  async function deadlocks(): Promise<number> {
    await sleep(1_500);
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT deadlocks AS n FROM pg_stat_database WHERE datname = current_database()`;
    return Number(rows[0].n);
  }

  it('the flag is off by default and, while off, the sweep reads and writes nothing', async () => {
    await prisma.featureFlag.deleteMany({ where: { key: FLAG } });
    expect(await app.get(FeatureFlagsService).isEnabled(FLAG)).toBe(false);
    const s = await store();
    const v = await variant(s, 10);
    const h = await apiHold(s, v, 2);
    await expire(h.reservationId);

    const result = await sweep.sweepOnce();
    expect(result.disabled).toBe(true);
    expect(result.released).toBe(0);
    expect(await counterOf(v)).toBe(2);
    expect(
      await prisma.checkoutReservation.count({
        where: { id: h.reservationId },
      }),
    ).toBe(1);
    expect(await auditRows(h.reservationId)).toHaveLength(0);
  });

  it('releases an expired hold exactly: counter, items, delivery slot and the reservation; one audit row with counts only; a second run changes nothing', async () => {
    const s = await store();
    const v1 = await variant(s, 10);
    const v2 = await variant(s, 10);
    const h = await directHold(s, [
      { v: v1, qty: 2 },
      { v: v2, qty: 1 },
    ]);
    const window = await prisma.deliveryWindow.create({
      data: {
        vendorId: s.vendorId,
        branchId: s.branchId,
        dayOfWeek: 1,
        startMinute: 600,
        endMinute: 720,
        capacity: 5,
      },
    });
    const address = await prisma.address.create({
      data: {
        customerId: h.a.customerId,
        lat: 31.9,
        lng: 35.2,
        phoneNumber1: '+970560000000',
      },
    });
    await prisma.checkoutReservationSlot.create({
      data: {
        reservationId: h.reservationId,
        vendorId: s.vendorId,
        branchId: s.branchId,
        deliveryWindowId: window.id,
        scheduledDate: new Date('2026-12-07'),
        deliveryFeeAtReserve: 10,
        addressId: address.id,
      },
    });
    await expire(h.reservationId);

    const first = await sweep.sweepOnce();
    expect(first).toMatchObject({
      released: 1,
      items: 2,
      units: 3,
      slots: 1,
      failed: 0,
    });
    expect([await counterOf(v1), await counterOf(v2)]).toEqual([0, 0]);
    expect(
      await prisma.checkoutReservation.count({
        where: { id: h.reservationId },
      }),
    ).toBe(0);
    expect(
      await prisma.checkoutReservationItem.count({
        where: { reservationId: h.reservationId },
      }),
    ).toBe(0);
    expect(
      await prisma.checkoutReservationSlot.count({
        where: { reservationId: h.reservationId },
      }),
    ).toBe(0);
    // The customer's address, the window and the stock itself stay.
    expect(await prisma.address.count({ where: { id: address.id } })).toBe(1);
    expect(
      await prisma.deliveryWindow.count({ where: { id: window.id } }),
    ).toBe(1);

    const audit = await auditRows(h.reservationId);
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBeNull();
    expect(audit[0].entityType).toBe('CheckoutReservation');
    const state = audit[0].beforeState as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual([
      'expires_at',
      'items',
      'slots',
      'units',
    ]);
    expect(state).toMatchObject({ items: 2, units: 3, slots: 1 });
    expect(JSON.stringify(state)).not.toContain('+970');
    expect(audit[0].afterState).toBeNull();

    const second = await sweep.sweepOnce();
    expect(second.released).toBe(0);
    expect([await counterOf(v1), await counterOf(v2)]).toEqual([0, 0]);
    expect(await auditRows(h.reservationId)).toHaveLength(1);
  });

  it('never touches a live hold or one expired inside the 60 s grace (database clock)', async () => {
    expect(RESERVATION_SWEEP_GRACE_SECONDS).toBe(60);
    const s = await store();
    const v = await variant(s, 10);
    const live = await apiHold(s, v, 1);
    const inGrace = await apiHold(s, v, 2);
    const past = await apiHold(s, v, 3);
    await expire(inGrace.reservationId, 30);
    await expire(past.reservationId, 61);

    const result = await sweep.sweepOnce();
    expect(result.released).toBe(1);
    const left = await prisma.checkoutReservation.findMany({
      where: {
        id: {
          in: [live.reservationId, inGrace.reservationId, past.reservationId],
        },
      },
      select: { id: true },
    });
    expect(left.map((r) => r.id).sort()).toEqual(
      [live.reservationId, inGrace.reservationId].sort(),
    );
    expect(await counterOf(v)).toBe(3);
    await expectCounter(s, v);

    // The one inside the grace still answers "expired" at confirm, and
    // the live one still confirms.
    const c1 = await confirm(inGrace.a, inGrace.reservationId).expect(409);
    expect(c1.body.error.code).toBe('RESERVATION_EXPIRED');
    await confirm(live.a, live.reservationId).expect(201);
    await expectCounter(s, v);
  });

  it('confirm after the sweep: RESERVATION_NOT_FOUND with no "replaced" reason; a really replaced hold says REPLACED', async () => {
    const s = await store();
    const v = await variant(s, 10);
    const swept = await apiHold(s, v, 1);
    await expire(swept.reservationId);
    await sweep.sweepOnce();
    const gone = await confirm(swept.a, swept.reservationId).expect(404);
    expect(gone.body.error.code).toBe('RESERVATION_NOT_FOUND');
    expect(gone.body.error.details).toEqual([]);

    const a = await account();
    const line = await addToCart(a, s, v.variantId);
    const first = await reserve(a, s, [line]).expect(201);
    const second = await reserve(a, s, [line]).expect(201);
    expect(second.body.replaced_previous).toBe(true);
    const replaced = await confirm(a, first.body.reservation_id).expect(404);
    expect(replaced.body.error.details).toEqual([{ reason: 'REPLACED' }]);

    // Another account confirming that same id learns nothing.
    const other = await account();
    const foreign = await confirm(other, first.body.reservation_id).expect(404);
    expect(foreign.body.error.details).toEqual([]);
  });

  it('a return-exchange hold on the same stock row is never released', async () => {
    const s = await store();
    const v = await variant(s, 10);
    // An exchange hold is a bare counter increment (no reservation item).
    await prisma.branchStock.update({
      where: { id: v.stockId },
      data: { reservedQuantity: { increment: 2 } },
    });
    const h = await apiHold(s, v, 3);
    await expire(h.reservationId);
    expect(await counterOf(v)).toBe(5);

    await sweep.sweepOnce();
    expect(await counterOf(v)).toBe(2);
    await expectCounter(s, v, 2);
  });

  it('no double release: items the lazy sweep already released give nothing back again; an empty expired reservation is removed', async () => {
    const s = await store();
    const v = await variant(s, 10);
    const h = await directHold(s, [{ v, qty: 2 }]);
    const v2 = await variant(s, 10);
    await prisma.checkoutReservationItem.create({
      data: {
        reservationId: h.reservationId,
        vendorId: s.vendorId,
        branchId: s.branchId,
        offerVariantId: v2.variantId,
        quantity: 1,
        unitPriceAtReserve: 20,
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'COD',
      },
    });
    await prisma.branchStock.update({
      where: { id: v2.stockId },
      data: { reservedQuantity: { increment: 1 } },
    });
    await expire(h.reservationId);
    // A POS sale on v sweeps that row lazily - the item on v goes, the
    // reservation row and its item on v2 stay.
    await posSale(s, v.variantId).expect(201);
    expect(await counterOf(v)).toBe(0);
    expect(
      await prisma.checkoutReservation.count({
        where: { id: h.reservationId },
      }),
    ).toBe(1);

    const empty = await directHold(s, []);
    await expire(empty.reservationId);

    const result = await sweep.sweepOnce();
    expect(result).toMatchObject({ released: 2, items: 1, units: 1 });
    expect([await counterOf(v), await counterOf(v2)]).toEqual([0, 0]);
    expect(
      await prisma.checkoutReservation.count({
        where: { id: { in: [h.reservationId, empty.reservationId] } },
      }),
    ).toBe(0);
    expect((await auditRows(empty.reservationId))[0].beforeState).toMatchObject(
      { items: 0, units: 0, slots: 0 },
    );
  });

  it('a reservation another path holds is skipped at once (SKIP LOCKED), the others are released, and it is released on the next run', async () => {
    const s = await store();
    const v = await variant(s, 10);
    const held = await apiHold(s, v, 1);
    const free = await apiHold(s, v, 2);
    await expire(held.reservationId);
    await expire(free.reservationId);

    const x = new Client({ connectionString: process.env.DATABASE_URL });
    await x.connect();
    try {
      await x.query('BEGIN');
      await x.query(
        'SELECT id FROM checkout_reservations WHERE id = $1 FOR UPDATE',
        [held.reservationId],
      );
      const t0 = Date.now();
      const result = await sweep.sweepOnce();
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(result).toMatchObject({ released: 1, skipped: 1, failed: 0 });
      expect(
        await prisma.checkoutReservation.count({
          where: { id: held.reservationId },
        }),
      ).toBe(1);
      expect(await counterOf(v)).toBe(1);
    } finally {
      await x.query('ROLLBACK').catch(() => undefined);
      await x.end();
    }
    expect((await sweep.sweepOnce()).released).toBe(1);
    expect(await counterOf(v)).toBe(0);
    await expectCounter(s, v);
  });

  it('lock_timeout: a stock row held too long rolls back just that reservation (nothing half-done), the rest are released, and the next run finishes it', async () => {
    const s = await store();
    const vBusy = await variant(s, 10);
    const vFree = await variant(s, 10);
    const busy = await apiHold(s, vBusy, 2);
    const free = await apiHold(s, vFree, 1);
    await expire(busy.reservationId);
    await expire(free.reservationId);

    const x = new Client({ connectionString: process.env.DATABASE_URL });
    await x.connect();
    try {
      await x.query('BEGIN');
      await x.query('SELECT id FROM branch_stock WHERE id = $1 FOR UPDATE', [
        vBusy.stockId,
      ]);
      const t0 = Date.now();
      const result = await sweep.sweepOnce();
      const took = Date.now() - t0;
      expect(took).toBeGreaterThanOrEqual(2_500);
      expect(took).toBeLessThan(8_000);
      expect(result).toMatchObject({ released: 1, skipped: 1, failed: 0 });
      // Rolled back whole: reservation, its item and the counter.
      expect(
        await prisma.checkoutReservation.count({
          where: { id: busy.reservationId },
        }),
      ).toBe(1);
      expect(
        await prisma.checkoutReservationItem.count({
          where: { reservationId: busy.reservationId },
        }),
      ).toBe(1);
      expect(await auditRows(busy.reservationId)).toHaveLength(0);
      expect(await counterOf(vFree)).toBe(0);
    } finally {
      await x.query('ROLLBACK').catch(() => undefined);
      await x.end();
    }
    expect(await counterOf(vBusy)).toBe(2);
    expect((await sweep.sweepOnce()).released).toBe(1);
    expect(await counterOf(vBusy)).toBe(0);
    await expectCounter(s, vBusy);
    await expectCounter(s, vFree);
  });

  it('a failure in the middle of one release rolls that reservation back whole; the tick goes on and a later run completes it', async () => {
    const s = await store();
    const v = await variant(s, 10);
    const bad = await apiHold(s, v, 2);
    const good = await apiHold(s, v, 1);
    await expire(bad.reservationId);
    await expire(good.reservationId);

    const audit = app.get(AuditLogService);
    const original = audit.record.bind(audit);
    const spy = jest
      .spyOn(audit, 'record')
      .mockImplementation(async (input, tx) => {
        if (
          input.action === RESERVATION_SWEEP_AUDIT_ACTION &&
          input.entityId === bad.reservationId
        ) {
          throw new Error('injected failure after the stock was released');
        }
        return original(input, tx);
      });
    try {
      const result = await sweep.sweepOnce();
      expect(result).toMatchObject({ released: 1, failed: 1 });
    } finally {
      spy.mockRestore();
    }
    // The stock decrement and the item delete of `bad` were rolled back.
    expect(
      await prisma.checkoutReservation.count({
        where: { id: bad.reservationId },
      }),
    ).toBe(1);
    expect(
      await prisma.checkoutReservationItem.count({
        where: { reservationId: bad.reservationId },
      }),
    ).toBe(1);
    expect(await counterOf(v)).toBe(2);
    await expectCounter(s, v);

    expect((await sweep.sweepOnce()).released).toBe(1);
    expect(await counterOf(v)).toBe(0);
    expect(await auditRows(bad.reservationId)).toHaveLength(1);
  });

  it('a connection killed in the middle of a release leaves nothing half-done, and the next run completes it', async () => {
    const s = await store();
    const v = await variant(s, 10);
    const h = await apiHold(s, v, 2);
    await expire(h.reservationId);

    const x = new Client({ connectionString: process.env.DATABASE_URL });
    await x.connect();
    try {
      await x.query('BEGIN');
      await x.query('SELECT id FROM branch_stock WHERE id = $1 FOR UPDATE', [
        v.stockId,
      ]);
      const running = sweep.sweepOnce();
      // The sweep's backend: it already holds the reservation row and now
      // waits for the stock row x holds - terminate it there.
      let pid: number | null = null;
      for (let i = 0; i < 40 && pid === null; i++) {
        await sleep(50);
        const rows = await x.query(
          `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%branch_stock%' AND pid <> pg_backend_pid()`,
        );
        pid = rows.rows[0]?.pid ?? null;
      }
      expect(pid).not.toBeNull();
      await x.query('SELECT pg_terminate_backend($1)', [pid]);
      const result = await running;
      expect(result.released).toBe(0);
      expect(result.failed + result.skipped).toBe(1);
    } finally {
      await x.query('ROLLBACK').catch(() => undefined);
      await x.end();
    }
    expect(
      await prisma.checkoutReservation.count({
        where: { id: h.reservationId },
      }),
    ).toBe(1);
    expect(await counterOf(v)).toBe(2);
    expect((await sweep.sweepOnce()).released).toBe(1);
    expect(await counterOf(v)).toBe(0);
    await expectCounter(s, v);
  });

  it('batches: at most 100 per tick, oldest first, the time budget stops a tick early, and later ticks finish the backlog', async () => {
    expect(RESERVATION_SWEEP_BATCH_LIMIT).toBe(100);
    const s = await store();
    const v = await variant(s, 1000);
    const a = await account();
    const ids: string[] = [];
    for (let i = 0; i < 230; i++)
      ids.push(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await prisma.checkoutReservation.createMany({
      data: ids.map((id, i) => ({
        id,
        customerId: a.customerId,
        expiresAt: new Date(Date.now() - 3_600_000 + i * 1000),
      })),
    });
    await prisma.checkoutReservationItem.createMany({
      data: ids.map((reservationId) => ({
        reservationId,
        vendorId: s.vendorId,
        branchId: s.branchId,
        offerVariantId: v.variantId,
        quantity: 1,
        unitPriceAtReserve: 20,
        fulfilmentMethod: 'PICKUP' as const,
        paymentMethod: 'COD' as const,
      })),
    });
    await prisma.branchStock.update({
      where: { id: v.stockId },
      data: { reservedQuantity: 230 },
    });

    const stopped = await sweep.sweepOnce({ budgetMs: 0 });
    expect(stopped).toMatchObject({ released: 0, stoppedByBudget: true });

    // A generous budget from here on, so the batch limit (not the
    // machine's speed) is what this checks.
    const budgetMs = 120_000;
    const t1 = await sweep.sweepOnce({ budgetMs });
    expect(t1).toMatchObject({ candidates: 100, released: 100 });
    // Oldest first: the first 100 by expiry are the ones gone.
    expect(
      await prisma.checkoutReservation.count({
        where: { id: { in: ids.slice(0, 100) } },
      }),
    ).toBe(0);
    expect(
      await prisma.checkoutReservation.count({
        where: { id: { in: ids.slice(100) } },
      }),
    ).toBe(130);
    expect(await counterOf(v)).toBe(130);
    expect((await sweep.sweepOnce({ budgetMs })).released).toBe(100);
    expect((await sweep.sweepOnce({ budgetMs })).released).toBe(30);
    expect((await sweep.sweepOnce({ budgetMs })).released).toBe(0);
    expect(await counterOf(v)).toBe(0);
    await expectCounter(s, v);
  });

  // TB-8.3: the backlog WARN means "stuck" - old expired holds left AND a
  // tick that released nothing - never "a large backlog is being worked
  // through, 100 per tick".
  function warnSpy() {
    const logger = (
      sweep as unknown as { logger: { warn: (m: string) => void } }
    ).logger;
    return jest.spyOn(logger, 'warn');
  }

  it('a backlog bigger than one batch (250 holds expired 2 h ago) clears over several ticks with no WARN; release, counter and audit as before', async () => {
    const s = await store();
    const v = await variant(s, 1000);
    const a = await account();
    const ids: string[] = [];
    for (let i = 0; i < 250; i++)
      ids.push(`00000000-0000-4000-9000-${String(i).padStart(12, '0')}`);
    await prisma.checkoutReservation.createMany({
      data: ids.map((id, i) => ({
        id,
        customerId: a.customerId,
        expiresAt: new Date(Date.now() - 2 * 3_600_000 + i * 1000),
      })),
    });
    await prisma.checkoutReservationItem.createMany({
      data: ids.map((reservationId) => ({
        reservationId,
        vendorId: s.vendorId,
        branchId: s.branchId,
        offerVariantId: v.variantId,
        quantity: 1,
        unitPriceAtReserve: 20,
        fulfilmentMethod: 'PICKUP' as const,
        paymentMethod: 'COD' as const,
      })),
    });
    await prisma.branchStock.update({
      where: { id: v.stockId },
      data: { reservedQuantity: 250 },
    });

    const warn = warnSpy();
    try {
      const ticks = [];
      for (let i = 0; i < 4; i++)
        ticks.push(await sweep.sweepOnce({ budgetMs: 120_000 }));
      expect(ticks.map((t) => t.released)).toEqual([100, 100, 50, 0]);
      expect(
        ticks.every((t) => t.backlogWarned === false && t.failed === 0),
      ).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(await counterOf(v)).toBe(0);
    await expectCounter(s, v);
    expect(
      await prisma.auditLog.count({
        where: {
          action: RESERVATION_SWEEP_AUDIT_ACTION,
          entityId: { in: ids },
        },
      }),
    ).toBe(250);
    expect(
      await prisma.checkoutReservation.count({ where: { id: { in: ids } } }),
    ).toBe(0);
  });

  it('an old expired hold the sweep cannot release (locked by another path) gives a WARN; once it is released the WARN stops', async () => {
    const s = await store();
    const v = await variant(s, 10);
    const h = await apiHold(s, v, 2);
    await expire(h.reservationId, 2 * 3600);

    const x = new Client({ connectionString: process.env.DATABASE_URL });
    await x.connect();
    const warn = warnSpy();
    try {
      await x.query('BEGIN');
      await x.query(
        'SELECT id FROM checkout_reservations WHERE id = $1 FOR UPDATE',
        [h.reservationId],
      );
      const stuck = await sweep.sweepOnce();
      expect(stuck).toMatchObject({
        released: 0,
        skipped: 1,
        backlogWarned: true,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('this tick released none'),
      );
      // Nothing was released while stuck.
      expect(await counterOf(v)).toBe(2);
      expect(await auditRows(h.reservationId)).toHaveLength(0);
    } finally {
      await x.query('ROLLBACK').catch(() => undefined);
      await x.end();
    }
    warn.mockClear();
    try {
      const freed = await sweep.sweepOnce();
      expect(freed).toMatchObject({ released: 1, backlogWarned: false });
      const after = await sweep.sweepOnce();
      expect(after).toMatchObject({ released: 0, backlogWarned: false });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(await counterOf(v)).toBe(0);
    expect(await auditRows(h.reservationId)).toHaveLength(1);
  });

  it('an old expired hold whose release keeps failing gives a WARN (the failure itself too); nothing half-released', async () => {
    const s = await store();
    const v = await variant(s, 10);
    const h = await apiHold(s, v, 1);
    await expire(h.reservationId, 2 * 3600);

    const audit = app.get(AuditLogService);
    const original = audit.record.bind(audit);
    const fail = jest
      .spyOn(audit, 'record')
      .mockImplementation(async (input, tx) => {
        if (
          input.action === RESERVATION_SWEEP_AUDIT_ACTION &&
          input.entityId === h.reservationId
        ) {
          throw new Error('injected failure');
        }
        return original(input, tx);
      });
    const warn = warnSpy();
    try {
      const result = await sweep.sweepOnce();
      expect(result).toMatchObject({
        released: 0,
        failed: 1,
        backlogWarned: true,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('this tick released none'),
      );
    } finally {
      fail.mockRestore();
      warn.mockRestore();
    }
    expect(await counterOf(v)).toBe(1);
    expect(
      await prisma.checkoutReservation.count({
        where: { id: h.reservationId },
      }),
    ).toBe(1);
    expect((await sweep.sweepOnce()).released).toBe(1);
    expect(await counterOf(v)).toBe(0);
  });

  it('two instances sweeping at once release every hold exactly once; a second tick of one instance does not overlap the first', async () => {
    const s = await store();
    const v = await variant(s, 100);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const h = await directHold(s, [{ v, qty: 1 }]);
      await expire(h.reservationId);
      ids.push(h.reservationId);
    }
    expect(await counterOf(v)).toBe(30);
    const other = new ReservationSweepService(
      prisma,
      app.get(AuditLogService),
      app.get(FeatureFlagsService),
    );
    const [r1, r2, r3] = await Promise.all([
      sweep.sweepOnce(),
      other.sweepOnce(),
      sweep.sweepOnce(),
    ]);
    expect(r3.overlapped).toBe(true);
    expect(r1.released + r2.released).toBe(30);
    expect(r1.failed + r2.failed).toBe(0);
    expect(await counterOf(v)).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: {
          action: RESERVATION_SWEEP_AUDIT_ACTION,
          entityId: { in: ids },
        },
      }),
    ).toBe(30);
    await expectCounter(s, v);
  });

  it('stress: the sweep (two instances) against reserve, replace, cancel, confirm, POS sales, restock and an exchange-hold release on the same stock row - no 500, no deadlock, every counter adds up', async () => {
    const before = await deadlocks();
    const s = await store();
    const v = await variant(s, 200);
    const exchangeHeld = { n: 3 };
    await prisma.branchStock.update({
      where: { id: v.stockId },
      data: { reservedQuantity: { increment: exchangeHeld.n } },
    });
    const other = new ReservationSweepService(
      prisma,
      app.get(AuditLogService),
      app.get(FeatureFlagsService),
    );
    let posSold = 0;
    let restocked = 0;
    const statuses: number[] = [];

    for (let round = 0; round < 3; round++) {
      // Expired holds to sweep, a live one to cancel, a live one to
      // confirm, and a customer whose expired hold reserve() replaces.
      const expired = [];
      for (let i = 0; i < 4; i++) expired.push(await apiHold(s, v, 1));
      for (const h of expired) await expire(h.reservationId);
      const toCancel = await apiHold(s, v, 1);
      const toConfirm = await apiHold(s, v, 1);
      const replacer = await account();
      const rLine = await addToCart(replacer, s, v.variantId);
      const old = await reserve(replacer, s, [rLine]).expect(201);
      await expire(old.body.reservation_id);

      const results = await Promise.all([
        sweep.sweepOnce(),
        other.sweepOnce(),
        cancel(toCancel.a, toCancel.reservationId),
        confirm(toConfirm.a, toConfirm.reservationId),
        reserve(replacer, s, [rLine]),
        posSale(s, v.variantId),
        posSale(s, v.variantId),
        prisma.$transaction((tx) =>
          lockOfferWideForRestock(tx, {
            vendorId: s.vendorId,
            branchId: s.branchId,
            offerVariantId: v.variantId,
            quantityDelta: 1,
          }),
        ),
        round === 0
          ? prisma.$transaction(async (tx) => {
              // What the return sweep does when an exchange code expires.
              const stock = await lockSweepOrCreateStockRow(
                tx,
                s.vendorId,
                s.branchId,
                v.variantId,
              );
              await tx.branchStock.update({
                where: { id: stock.id },
                data: { reservedQuantity: { decrement: 1 } },
              });
            })
          : Promise.resolve(),
      ]);
      for (const r of results.slice(2, 7) as { status: number }[])
        statuses.push(r.status);
      posSold += 2;
      restocked += 1;
      if (round === 0) exchangeHeld.n -= 1;
      expect(
        (results[0] as { failed: number }).failed +
          (results[1] as { failed: number }).failed,
      ).toBe(0);

      await expectCounter(s, v, exchangeHeld.n);
      const stock = await prisma.branchStock.findUniqueOrThrow({
        where: { id: v.stockId },
      });
      const ordered = await prisma.branchOrderItem.aggregate({
        where: { offerVariantId: v.variantId },
        _sum: { quantity: true },
      });
      expect(stock.quantity).toBe(
        200 - posSold + restocked - (ordered._sum.quantity ?? 0),
      );
    }
    expect(statuses.every((st) => st < 500)).toBe(true);
    // Whatever is still expired now, one more run clears; the exchange hold stays.
    await prisma.$executeRaw`UPDATE checkout_reservations SET "expiresAt" = now() - interval '2 minutes' WHERE "expiresAt" < now()`;
    await sweep.sweepOnce();
    await expectCounter(s, v, exchangeHeld.n);
    expect(await deadlocks()).toBe(before);
  });
});
