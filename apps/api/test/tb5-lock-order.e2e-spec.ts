import { execFileSync } from 'child_process';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
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

// TB-5 lock order: every checkout path (reserve, cancel, both confirm
// transactions) takes the account lock (the users row) BEFORE the
// customer's reservation lock. Before the fix, a reserve() replacing a
// live hold took the reservation lock and then - through its audit row's
// actorId foreign key - waited for the users row that confirm() held
// while confirm() waited for the reservation lock: a deadlock, one
// request answered 500. Two outside sessions (X1, X2) steer the timing
// into exactly that interleaving; the stress test then races reserve,
// cancel, confirm, POS sales and the expired-hold sweep. Nothing may
// answer 500, Postgres must count no deadlock in this database, and
// stock, holds and orders must add up.
//
// The file runs on a database of its own: pg_stat_database.deadlocks is
// per database, and the shared one also serves sprint21b, whose
// "reproduces the OLD per-key-sequential pattern" test deadlocks on
// purpose - on a shared database that would make this check fail for a
// deadlock that is not ours, or hide one that is.
describe('TB-5 checkout lock order (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sharedUrl = process.env.DATABASE_URL!;
  const dbName = `finalpro_tb5lock_test_${process.pid}`;

  beforeAll(async () => {
    // TB-13: created marked as a disposable test database.
    const url = await createDisposableDatabase(sharedUrl, dbName);
    // Node runs the Prisma CLI directly (no npx), so this works on
    // Windows as well as in CI.
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
    // PrismaService reads DATABASE_URL when the app is built below, and
    // the outside sessions further down use it too.
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
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    process.env.DATABASE_URL = sharedUrl;
    // TB-13: dropped only after its own marker is checked.
    await dropDisposableDatabase(sharedUrl, dbName);
  }, 120_000);

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function account() {
    const phone = `+97059${String((Date.now() + (counter += 1) * 7919) % 1e7).padStart(7, '0')}`;
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
        slug: unique('tb5-lock').toLowerCase(),
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
      // 2026-11-22: a manual SALE movement is refused (a sale is the cashier's
      // alone); the same decrement through the same lock path is an internal use
      .send({
        reason: 'INTERNAL_USE',
        quantity_delta: -1,
        reason_note: 'إخراج',
      });

  /** Deadlocks Postgres has counted in this database so far. A
   * backend reports its counters when it goes idle (at most once a
   * second), so wait for that before reading. */
  async function deadlocks(): Promise<number> {
    await sleep(1_500);
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT deadlocks AS n FROM pg_stat_database WHERE datname = current_database()`;
    return Number(rows[0].n);
  }

  /** Stock, holds and orders add up for one variant. */
  async function expectConsistent(
    s: Store,
    v: { variantId: string; stockId: string },
    initial: number,
    posSold: number,
  ) {
    const stock = await prisma.branchStock.findUniqueOrThrow({
      where: { id: v.stockId },
    });
    const held = await prisma.checkoutReservationItem.aggregate({
      where: { branchId: s.branchId, offerVariantId: v.variantId },
      _sum: { quantity: true },
    });
    const ordered = await prisma.branchOrderItem.aggregate({
      where: { offerVariantId: v.variantId },
      _sum: { quantity: true },
    });
    expect(stock.reservedQuantity).toBe(held._sum.quantity ?? 0);
    expect(stock.quantity).toBe(
      initial - posSold - (ordered._sum.quantity ?? 0),
    );
    expect(stock.quantity).toBeGreaterThanOrEqual(stock.reservedQuantity);
  }

  const liveReservationsOf = (a: Account) =>
    prisma.checkoutReservation.count({
      where: { customerId: a.customerId, expiresAt: { gt: new Date() } },
    });

  it('a reserve replacing a live hold while that hold is being confirmed: no deadlock, no 500, one consistent outcome', async () => {
    const before = await deadlocks();
    const a = await account();
    const s = await store();
    const v = await variant(s, 10);
    const line = await addToCart(a, s, v.variantId);
    const r0 = await reserve(a, s, [line]).expect(201);

    // The exact interleaving that deadlocked: confirm and the replacing
    // reserve queue up behind X1 (the customer's reservation lock); the
    // reserve is then held inside its transaction by X2 (the stock row)
    // while confirm moves on to its second transaction.
    const cs = process.env.DATABASE_URL!;
    const x1 = new Client({ connectionString: cs });
    const x2 = new Client({ connectionString: cs });
    await x1.connect();
    await x2.connect();
    try {
      await x1.query('BEGIN');
      await x1.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `checkout-reservation:${a.customerId}`,
      ]);
      await x2.query('BEGIN');
      await x2.query('SELECT id FROM branch_stock WHERE id = $1 FOR UPDATE', [
        v.stockId,
      ]);
      const confirmP = Promise.resolve(confirm(a, r0.body.reservation_id));
      await sleep(300);
      const reserveP = Promise.resolve(reserve(a, s, [line]));
      await sleep(300);
      await x1.query('COMMIT');
      await sleep(1_500);
      await x2.query('COMMIT');
      const [c, r] = await Promise.all([confirmP, reserveP]);

      expect(c.status).toBeLessThan(500);
      expect(r.status).toBeLessThan(500);
      // Whichever ran first, exactly one of them holds the unit now: an
      // order, or a new live hold - never both, never neither.
      const orders = await prisma.branchOrder.count({
        where: { customerOrder: { customerId: a.customerId } },
      });
      expect(orders + (await liveReservationsOf(a))).toBe(1);
      await expectConsistent(s, v, 10, 0);
    } finally {
      await x1.query('ROLLBACK').catch(() => undefined);
      await x2.query('ROLLBACK').catch(() => undefined);
      await x1.end();
      await x2.end();
    }
    expect(await deadlocks()).toBe(before);
  });

  it('a reserve replacing a live hold while that hold is being cancelled: no deadlock, no 500, consistent', async () => {
    const before = await deadlocks();
    const a = await account();
    const s = await store();
    const v = await variant(s, 10);
    const line = await addToCart(a, s, v.variantId);
    const r0 = await reserve(a, s, [line]).expect(201);

    const x2 = new Client({ connectionString: process.env.DATABASE_URL });
    await x2.connect();
    try {
      await x2.query('BEGIN');
      await x2.query('SELECT id FROM branch_stock WHERE id = $1 FOR UPDATE', [
        v.stockId,
      ]);
      const reserveP = Promise.resolve(reserve(a, s, [line]));
      await sleep(300);
      const cancelP = Promise.resolve(cancel(a, r0.body.reservation_id));
      await sleep(1_000);
      await x2.query('COMMIT');
      const [r, c] = await Promise.all([reserveP, cancelP]);
      expect(r.status).toBe(201);
      expect(c.status).toBeLessThan(500);
      expect(await liveReservationsOf(a)).toBe(1);
      await expectConsistent(s, v, 10, 0);
    } finally {
      await x2.query('ROLLBACK').catch(() => undefined);
      await x2.end();
    }
    expect(await deadlocks()).toBe(before);
  });

  it('a POS sale and a reserve on the same stock row: no deadlock, no 500, consistent', async () => {
    // POS takes the stock row and then - through its stock_movements
    // row's vendorId foreign key - the vendor row (FOR KEY SHARE);
    // reserve() takes the vendor row FOR UPDATE and then the stock row.
    // X2 holds the stock row so that POS queues first and reserve()
    // second (already holding the vendor row) - the order that
    // deadlocked when POS reached the vendor row only after the stock row.
    const before = await deadlocks();
    const a = await account();
    const s = await store();
    const v = await variant(s, 10);
    const line = await addToCart(a, s, v.variantId);

    const x2 = new Client({ connectionString: process.env.DATABASE_URL });
    await x2.connect();
    try {
      await x2.query('BEGIN');
      await x2.query('SELECT id FROM branch_stock WHERE id = $1 FOR UPDATE', [
        v.stockId,
      ]);
      const posP = Promise.resolve(posSale(s, v.variantId));
      await sleep(400);
      const reserveP = Promise.resolve(reserve(a, s, [line]));
      await sleep(600);
      await x2.query('COMMIT');
      const [p, r] = await Promise.all([posP, reserveP]);
      expect(p.status).toBe(201);
      expect(r.status).toBe(201);
      await expectConsistent(s, v, 10, 1);
    } finally {
      await x2.query('ROLLBACK').catch(() => undefined);
      await x2.end();
    }
    expect(await deadlocks()).toBe(before);
  });

  it('stress: reserve, replace, cancel, confirm, POS sales and an expired hold to sweep, all at once, round after round - no 500, no deadlock, stock adds up', async () => {
    const before = await deadlocks();
    const s = await store();
    const initial = 200;
    const v1 = await variant(s, initial);
    const v2 = await variant(s, initial);
    const a = await account();
    const b = await account();
    const c = await account();
    const lines = {
      a: [
        await addToCart(a, s, v1.variantId),
        await addToCart(a, s, v2.variantId),
      ],
      b: [
        await addToCart(b, s, v2.variantId),
        await addToCart(b, s, v1.variantId),
      ],
      c: [await addToCart(c, s, v1.variantId)],
    };
    let posSold = { v1: 0, v2: 0 };
    const statuses: number[] = [];

    /** A's cart lines - a successful confirm consumes them, so they
     * are put back (one unit each) whenever they are gone. */
    async function cartLinesOfA() {
      const ids: string[] = [];
      for (const v of [v1, v2]) {
        const existing = await prisma.cartItem.findFirst({
          where: { customerId: a.customerId, offerVariantId: v.variantId },
        });
        ids.push(existing ? existing.id : await addToCart(a, s, v.variantId));
      }
      return ids;
    }

    for (let round = 0; round < 8; round++) {
      lines.a = await cartLinesOfA();
      const held = await reserve(a, s, lines.a).expect(201);
      const cHold = await reserve(c, s, lines.c).expect(201);
      // C's hold expires - the next stock writer on v1 sweeps it.
      await prisma.checkoutReservation.update({
        where: { id: cHold.body.reservation_id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const results = await Promise.all([
        reserve(a, s, [lines.a[1], lines.a[0]]),
        confirm(a, held.body.reservation_id),
        cancel(a, held.body.reservation_id),
        reserve(b, s, lines.b),
        posSale(s, v1.variantId),
        posSale(s, v2.variantId),
      ]);
      statuses.push(...results.map((r) => r.status));
      if (results[4].status === 201)
        posSold = { ...posSold, v1: posSold.v1 + 1 };
      if (results[5].status === 201)
        posSold = { ...posSold, v2: posSold.v2 + 1 };
      // B's hold and anything A still holds go back before the next round.
      for (const who of [a, b]) {
        const live = await prisma.checkoutReservation.findMany({
          where: { customerId: who.customerId },
        });
        for (const r of live) await cancel(who, r.id);
      }
      expect(await liveReservationsOf(a)).toBeLessThanOrEqual(1);
    }

    expect(statuses.filter((st) => st >= 500)).toEqual([]);
    await expectConsistent(s, v1, initial, posSold.v1);
    await expectConsistent(s, v2, initial, posSold.v2);
    expect(await deadlocks()).toBe(before);
  });
});
