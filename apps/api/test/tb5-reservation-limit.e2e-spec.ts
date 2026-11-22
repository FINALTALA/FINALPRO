import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { RedisService } from './../src/redis/redis.service';

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

// TB-5: one live checkout reservation per customer (a new reserve()
// atomically replaces the previous one), at most 30 units in one
// reservation, the customer's reservation lock shared by reserve,
// confirm and cancel, and a per-user rate limit on new reserve attempts
// that never blocks an idempotent retry.
describe('TB-5 active reservation limit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeEach(async () => {
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
  });

  afterEach(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A signed-in account with its customer profile (every account has one). */
  async function account() {
    const phone = `+993${Date.now()}${(counter += 1)}`;
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
        slug: unique('tb5-store').toLowerCase(),
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
    return { vendor, branch };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  async function variant(s: Store, stock: number, branchId = s.branch.id) {
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendor.id,
        titleAr: unique('عرض'),
        titleEn: unique('Offer'),
        status: 'ACTIVE',
      },
    });
    const v = await prisma.offerVariant.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: offer.id,
        sellerSku: unique('sku'),
        basePrice: 20,
        storeInventoryBarcode: unique('barcode'),
      },
    });
    await prisma.branchStock.create({
      data: {
        vendorId: s.vendor.id,
        branchId,
        offerVariantId: v.id,
        quantity: stock,
      },
    });
    return v.id;
  }

  async function addToCart(
    a: Account,
    s: Store,
    variantId: string,
    quantity: number,
  ) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set(auth(a.token))
      .set('Idempotency-Key', unique('cart'))
      .send({ vendor_id: s.vendor.id, offer_variant_id: variantId, quantity })
      .expect(201);
    return res.body.id as string;
  }

  function reserve(
    a: Account,
    groups: { branchId: string; cartItemIds: string[] }[],
    key = unique('reserve'),
  ) {
    return request(app.getHttpServer())
      .post('/api/v1/checkout/reserve')
      .set(auth(a.token))
      .set('Idempotency-Key', key)
      .send({
        terms_accepted: true,
        terms_version: '2026-10-v1',
        groups: groups.map((g) => ({
          cart_item_ids: g.cartItemIds,
          branch_id: g.branchId,
          fulfilment_method: 'PICKUP',
          payment_method: 'COD',
        })),
      });
  }

  const confirm = (a: Account, reservationId: string) =>
    request(app.getHttpServer())
      .post('/api/v1/checkout/confirm')
      .set(auth(a.token))
      .set('Idempotency-Key', unique('confirm'))
      .send({ reservation_id: reservationId });

  const cancel = (a: Account, reservationId: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/checkout/reservations/${reservationId}/cancel`)
      .set(auth(a.token));

  const stockRow = (s: Store, variantId: string, branchId = s.branch.id) =>
    prisma.branchStock.findUniqueOrThrow({
      where: {
        branchId_offerVariantId: { branchId, offerVariantId: variantId },
      },
    });

  const liveReservations = (a: Account) =>
    prisma.checkoutReservation.findMany({
      where: { customerId: a.customerId, expiresAt: { gt: new Date() } },
      include: { items: true },
    });

  it('a second reserve replaces the first: one live hold, its stock given back, the old one gone for confirm and cancel', async () => {
    const a = await account();
    const s = await store();
    const v = await variant(s, 5);
    const line = await addToCart(a, s, v, 2);

    const first = await reserve(a, [
      { branchId: s.branch.id, cartItemIds: [line] },
    ]).expect(201);
    expect(first.body.replaced_previous).toBe(false);
    const second = await reserve(a, [
      { branchId: s.branch.id, cartItemIds: [line] },
    ]).expect(201);
    expect(second.body.replaced_previous).toBe(true);
    expect(second.body.reservation_id).not.toBe(first.body.reservation_id);

    const live = await liveReservations(a);
    expect(live.map((r) => r.id)).toEqual([second.body.reservation_id]);
    expect((await stockRow(s, v)).reservedQuantity).toBe(2);
    expect(
      await prisma.checkoutReservation.count({
        where: { id: first.body.reservation_id },
      }),
    ).toBe(0);

    const stale = await confirm(a, first.body.reservation_id).expect(404);
    expect(stale.body.error.code).toBe('RESERVATION_NOT_FOUND');
    const staleCancel = await cancel(a, first.body.reservation_id).expect(201);
    expect(staleCancel.body.released).toBe(false);
    await confirm(a, second.body.reservation_id).expect(201);
    const after = await stockRow(s, v);
    expect([after.quantity, after.reservedQuantity]).toEqual([3, 0]);

    // The replacement is audited - ids only, never quantities.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        action: 'checkout.reservation_replaced',
        entityId: first.body.reservation_id,
      },
    });
    expect(audit.afterState).toEqual({
      replaced_by: second.body.reservation_id,
    });
  });

  it('three concurrent reserves of one account end with exactly one live hold and a correct reserved counter', async () => {
    const a = await account();
    const s = await store();
    const v = await variant(s, 9);
    const line = await addToCart(a, s, v, 3);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        reserve(a, [{ branchId: s.branch.id, cartItemIds: [line] }]),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const live = await liveReservations(a);
    expect(live).toHaveLength(1);
    expect((await stockRow(s, v)).reservedQuantity).toBe(3);
    expect(
      results.filter((r) => r.body.replaced_previous === true),
    ).toHaveLength(2);
  });

  it('a new reserve racing the confirm of the old one: exactly one wins, never an order AND a live hold of the same units', async () => {
    const a = await account();
    const s = await store();
    const v = await variant(s, 5);
    const line = await addToCart(a, s, v, 2);
    const old = await reserve(a, [
      { branchId: s.branch.id, cartItemIds: [line] },
    ]).expect(201);

    const [renewed, confirmed] = await Promise.all([
      reserve(a, [{ branchId: s.branch.id, cartItemIds: [line] }]),
      confirm(a, old.body.reservation_id),
    ]);
    const stock = await stockRow(s, v);
    const live = await liveReservations(a);
    const orders = await prisma.customerOrder.count({
      where: { customerId: a.customerId },
    });
    if (confirmed.status === 201) {
      // Confirm first: the order consumed the line, so the new reserve
      // found nothing left to reserve.
      expect(renewed.status).toBe(404);
      expect([
        stock.quantity,
        stock.reservedQuantity,
        orders,
        live.length,
      ]).toEqual([3, 0, 1, 0]);
    } else {
      // Reserve first: it replaced the old hold, so confirm found nothing.
      expect(confirmed.status).toBe(404);
      expect(renewed.status).toBe(201);
      expect([
        stock.quantity,
        stock.reservedQuantity,
        orders,
        live.length,
      ]).toEqual([5, 2, 0, 1]);
    }
  });

  it('a new reserve racing the cancel of the old one: one live hold, the counter equal to it', async () => {
    const a = await account();
    const s = await store();
    const v = await variant(s, 5);
    const line = await addToCart(a, s, v, 2);
    const old = await reserve(a, [
      { branchId: s.branch.id, cartItemIds: [line] },
    ]).expect(201);
    const [renewed, cancelled] = await Promise.all([
      reserve(a, [{ branchId: s.branch.id, cartItemIds: [line] }]),
      cancel(a, old.body.reservation_id),
    ]);
    expect(renewed.status).toBe(201);
    expect(cancelled.status).toBe(201);
    const live = await liveReservations(a);
    expect(live.map((r) => r.id)).toEqual([renewed.body.reservation_id]);
    expect((await stockRow(s, v)).reservedQuantity).toBe(2);
  });

  it('a retry with the same Idempotency-Key returns the same hold and replaces nothing; the rate limit counts new attempts only', async () => {
    const previous = process.env.RESERVE_RATE_LIMIT_PER_MINUTE;
    process.env.RESERVE_RATE_LIMIT_PER_MINUTE = '2';
    const a = await account();
    try {
      const s = await store();
      const v = await variant(s, 9);
      const line = await addToCart(a, s, v, 1);
      const body = [{ branchId: s.branch.id, cartItemIds: [line] }];

      const first = await reserve(a, body, 'tb5-same-key-1').expect(201);
      const replay = await reserve(a, body, 'tb5-same-key-1').expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.reservation_id).toBe(first.body.reservation_id);
      expect((await liveReservations(a)).map((r) => r.id)).toEqual([
        first.body.reservation_id,
      ]);
      expect((await stockRow(s, v)).reservedQuantity).toBe(1);

      const second = await reserve(a, body, 'tb5-same-key-2').expect(201);
      // A third NEW attempt within the minute is refused...
      const third = await reserve(a, body, 'tb5-same-key-3').expect(429);
      expect(third.body.error.code).toBe('RESERVE_RATE_LIMITED');
      // ...but retries of attempts already sent are not.
      const retry = await reserve(a, body, 'tb5-same-key-2').expect(201);
      expect(retry.body.reservation_id).toBe(second.body.reservation_id);
      await reserve(a, body, 'tb5-same-key-1').expect(201);
      expect((await liveReservations(a)).map((r) => r.id)).toEqual([
        second.body.reservation_id,
      ]);
      // Per user: another account is not limited by this one.
      const b = await account();
      const lineB = await addToCart(b, s, v, 1);
      await reserve(b, [
        { branchId: s.branch.id, cartItemIds: [lineB] },
      ]).expect(201);
    } finally {
      if (previous === undefined)
        delete process.env.RESERVE_RATE_LIMIT_PER_MINUTE;
      else process.env.RESERVE_RATE_LIMIT_PER_MINUTE = previous;
      await app.get(RedisService).del(`rate:checkout-reserve:${a.userId}`);
    }
  });

  it('only an expired earlier hold: cleaned up, but not reported as a replacement', async () => {
    const a = await account();
    const s = await store();
    const v = await variant(s, 5);
    const line = await addToCart(a, s, v, 2);
    const old = await reserve(a, [
      { branchId: s.branch.id, cartItemIds: [line] },
    ]).expect(201);
    await prisma.checkoutReservation.update({
      where: { id: old.body.reservation_id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const renewed = await reserve(a, [
      { branchId: s.branch.id, cartItemIds: [line] },
    ]).expect(201);
    expect(renewed.body.replaced_previous).toBe(false);
    expect(
      await prisma.checkoutReservation.count({
        where: { id: old.body.reservation_id },
      }),
    ).toBe(0);
    expect((await stockRow(s, v)).reservedQuantity).toBe(2);
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'checkout.reservation_replaced',
          entityId: old.body.reservation_id,
        },
      }),
    ).toBe(0);
  });

  it('30 units across stores, branches and variants is the limit: 31 is refused with only { limit: 30 }, nothing held', async () => {
    const a = await account();
    const s1 = await store();
    const s2 = await store();
    const secondBranch = await prisma.storeBranch.create({
      data: {
        vendorId: s2.vendor.id,
        name: unique('فرع'),
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
    const v1 = await variant(s1, 47);
    const v2 = await variant(s1, 47);
    const v3 = await variant(s2, 47);
    const v4 = await variant(s2, 47, secondBranch.id);
    const l1 = await addToCart(a, s1, v1, 10);
    const l2 = await addToCart(a, s1, v2, 10);
    const l3 = await addToCart(a, s2, v3, 9);
    const l4 = await addToCart(a, s2, v4, 2);

    const quote = await request(app.getHttpServer())
      .post('/api/v1/checkout/quote')
      .set(auth(a.token))
      .send({ cart_item_ids: [l1, l2, l3, l4] })
      .expect(201);
    expect(quote.body.units_limit).toBe(30);

    const groups = [
      { branchId: s1.branch.id, cartItemIds: [l1, l2] },
      { branchId: s2.branch.id, cartItemIds: [l3] },
      { branchId: secondBranch.id, cartItemIds: [l4] },
    ];
    // TB-13: the trace id is random and may contain "47" by chance (it did,
    // ~1 run in 9) - so it carries "47" on purpose here, and the stock check
    // looks at everything in the answer EXCEPT that trace id.
    const traceId = `tb5-limit-47-${unique('trace')}`;
    const refused = await reserve(a, groups)
      .set('X-Correlation-Id', traceId)
      .expect(422);
    expect(Object.keys(refused.body)).toEqual(['error']);
    const { correlation_id: echoedTraceId, ...answer } = refused.body.error;
    expect(echoedTraceId).toBe(traceId);
    expect(answer).toEqual({
      code: 'RESERVATION_UNITS_LIMIT_EXCEEDED',
      message: expect.any(String),
      details: [{ limit: 30 }],
    });
    // The branch's stock (47 of each variant) appears nowhere in the answer.
    expect(JSON.stringify(answer)).not.toMatch(/47/);
    expect(await liveReservations(a)).toHaveLength(0);
    for (const [st, v, b] of [
      [s1, v1, s1.branch.id],
      [s2, v4, secondBranch.id],
    ] as const) {
      expect((await stockRow(st, v, b)).reservedQuantity).toBe(0);
    }

    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${l4}`)
      .set(auth(a.token))
      .send({ quantity: 1 })
      .expect(200);
    const ok = await reserve(a, groups).expect(201);
    expect(
      ok.body.items.reduce(
        (n: number, i: { quantity: number }) => n + i.quantity,
        0,
      ),
    ).toBe(30);
  });

  it("holds that aren't this customer's - an exchange's, another shopper's - are never touched by a replacement", async () => {
    const a = await account();
    const b = await account();
    const s = await store();
    const v = await variant(s, 20);
    // An approved exchange's replacement hold on the same row (a bare
    // reservedQuantity hold with no checkout reservation behind it).
    await prisma.branchStock.updateMany({
      where: { branchId: s.branch.id, offerVariantId: v },
      data: { reservedQuantity: { increment: 3 } },
    });
    const lineB = await addToCart(b, s, v, 4);
    const holdB = await reserve(b, [
      { branchId: s.branch.id, cartItemIds: [lineB] },
    ]).expect(201);
    const lineA = await addToCart(a, s, v, 2);
    await reserve(a, [{ branchId: s.branch.id, cartItemIds: [lineA] }]).expect(
      201,
    );
    const renewed = await reserve(a, [
      { branchId: s.branch.id, cartItemIds: [lineA] },
    ]).expect(201);

    expect((await stockRow(s, v)).reservedQuantity).toBe(3 + 4 + 2);
    expect((await liveReservations(b)).map((r) => r.id)).toEqual([
      holdB.body.reservation_id,
    ]);
    // Nothing about B leaks into A's response.
    expect(JSON.stringify(renewed.body)).not.toContain(
      holdB.body.reservation_id,
    );
  });

  it('an owner and a branch employee shopping are limited the same way; a guest cannot reserve at all', async () => {
    for (const role of ['OWNER', 'BRANCH_EMPLOYEE'] as const) {
      const staff = await account();
      const own = await store();
      await prisma.vendorUser.create({
        data: {
          userId: staff.userId,
          vendorId: own.vendor.id,
          role,
          branchId: role === 'OWNER' ? null : own.branch.id,
        },
      });
      const s = await store();
      const v = await variant(s, 5);
      const line = await addToCart(staff, s, v, 2);
      await reserve(staff, [
        { branchId: s.branch.id, cartItemIds: [line] },
      ]).expect(201);
      const second = await reserve(staff, [
        { branchId: s.branch.id, cartItemIds: [line] },
      ]).expect(201);
      expect(second.body.replaced_previous).toBe(true);
      expect(await liveReservations(staff)).toHaveLength(1);
      expect((await stockRow(s, v)).reservedQuantity).toBe(2);
    }
    await request(app.getHttpServer())
      .post('/api/v1/checkout/reserve')
      .set('Idempotency-Key', unique('guest'))
      .send({ terms_accepted: true, terms_version: '2026-10-v1', groups: [] })
      .expect(401);
  });

  it('no deadlock: a replacing reserve, a POS sale and another shopper on the same rows, with an expired hold to sweep', async () => {
    const a = await account();
    const b = await account();
    const owner = await account();
    const s = await store();
    await prisma.vendorUser.create({
      data: { userId: owner.userId, vendorId: s.vendor.id, role: 'OWNER' },
    });
    const v1 = await variant(s, 30);
    const v2 = await variant(s, 30);
    const a1 = await addToCart(a, s, v1, 2);
    const a2 = await addToCart(a, s, v2, 2);
    // A has an expired hold and a live one; both are on the shared rows.
    const expired = await reserve(a, [
      { branchId: s.branch.id, cartItemIds: [a1] },
    ]).expect(201);
    await prisma.checkoutReservation.update({
      where: { id: expired.body.reservation_id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await reserve(a, [{ branchId: s.branch.id, cartItemIds: [a1, a2] }]).expect(
      201,
    );
    const b1 = await addToCart(b, s, v2, 3);
    const b2 = await addToCart(b, s, v1, 3);

    const results = await Promise.all([
      reserve(a, [{ branchId: s.branch.id, cartItemIds: [a2, a1] }]),
      reserve(b, [{ branchId: s.branch.id, cartItemIds: [b1, b2] }]),
      request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${s.vendor.id}/branches/${s.branch.id}/stock/${v1}/movements`,
        )
        .set(auth(owner.token))
        .set('Idempotency-Key', unique('pos'))
        .send({
          reason: 'SALE',
          quantity_delta: -1,
          reason_note: 'بيع في المحل',
        }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(await liveReservations(a)).toHaveLength(1);
    const r1 = await stockRow(s, v1);
    const r2 = await stockRow(s, v2);
    expect([r1.quantity, r1.reservedQuantity]).toEqual([29, 2 + 3]);
    expect([r2.quantity, r2.reservedQuantity]).toEqual([30, 2 + 3]);
  });
});
