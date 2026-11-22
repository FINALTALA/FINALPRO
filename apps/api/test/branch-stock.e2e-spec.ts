import { ThrottlerStorage } from '@nestjs/throttler';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { CURRENT_PLATFORM_TERMS_VERSION } from './../src/checkout/checkout.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { tb26Fixtures } from './helpers/tb26-fixtures';

// «إدارة مخزون الفرع v1» (2026-11-22): the manual movements (RECEIVE,
// a count by the counted quantity, DAMAGE / LOSS / INTERNAL_USE, a manual
// SALE refused), idempotency, roles and branches, the low-stock alert on
// the owner's threshold, the ORDER_SALE / ORDER_CANCEL_RESTOCK log lines of
// online orders (the order's own effect unchanged), and the read side:
// the board (search, filters, summary, pages, a pinned line), one line's
// details and its paginated log.
describe('Branch stock management (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const f = tb26Fixtures(() => app);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 1,
            timeToExpire: 60,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    app.get(OutboxRelayService).onModuleDestroy();
  });
  afterAll(async () => {
    await app.close();
  });

  type Store = Awaited<ReturnType<typeof f.store>>;
  type Account = Awaited<ReturnType<typeof f.account>>;
  const stockUrl = (s: Store, branchId: string, rest = '') =>
    `/api/v1/vendors/${s.vendorId}/branches/${branchId}/stock${rest}`;
  const move = (
    s: Store,
    who: { token: string },
    variantId: string,
    body: object,
    branchId = s.branchA,
    key = f.unique('mv'),
  ) =>
    f
      .http()
      .post(stockUrl(s, branchId, `/${variantId}/movements`))
      .set(f.bearer(who.token))
      .set('Idempotency-Key', key)
      .send(body);
  const row = (branchId: string, offerVariantId: string) =>
    prisma.branchStock.findUniqueOrThrow({
      where: { branchId_offerVariantId: { branchId, offerVariantId } },
    });
  const lowAlerts = (variantId: string) =>
    prisma.outboxEvent.count({
      where: {
        eventType: 'checkout.low_stock_after_reserve',
        payload: { path: ['offer_variant_id'], equals: variantId },
      },
    });
  const ownerNotices = (variantId: string) =>
    prisma.outboxEvent.count({
      where: {
        eventType: 'stock_movement.owner_notification',
        payload: { path: ['offer_variant_id'], equals: variantId },
      },
    });
  async function employee(s: Store, branchId: string) {
    return f.member(s.vendorId, await f.account(), 'BRANCH_EMPLOYEE', branchId);
  }
  /** A shopper's held reservation of `qty` (reserve only, never confirmed). */
  async function hold(s: Store, variantId: string, qty: number) {
    const buyer = await f.account();
    const cart = await f
      .http()
      .post('/api/v1/cart/items')
      .set(f.bearer(buyer.token))
      .set('Idempotency-Key', f.unique('cart'))
      .send({
        vendor_id: s.vendorId,
        offer_variant_id: variantId,
        quantity: qty,
      })
      .expect(201);
    await f
      .http()
      .post('/api/v1/checkout/reserve')
      .set(f.bearer(buyer.token))
      .set('Idempotency-Key', f.unique('reserve'))
      .send({
        terms_accepted: true,
        terms_version: CURRENT_PLATFORM_TERMS_VERSION,
        groups: [
          {
            cart_item_ids: [cart.body.id],
            branch_id: s.branchA,
            fulfilment_method: 'PICKUP',
            payment_method: 'COD',
          },
        ],
      })
      .expect(201);
  }

  let s: Store;
  let empA: Account;
  let empB: Account;
  beforeAll(async () => {
    s = await f.store();
    empA = await employee(s, s.branchA);
    empB = await employee(s, s.branchB);
  });

  it('RECEIVE adds and leaves the last count alone; a negative receive, a positive damage / loss / internal use and a manual SALE are refused', async () => {
    const v = await f.offer(s, 4);
    const before = await row(s.branchA, v);
    const r = await move(s, empA, v, {
      reason: 'RECEIVE',
      quantity_delta: 6,
      reason_note: 'شحنة المورد',
    }).expect(201);
    expect(r.body.resulting_quantity).toBe(10);
    const after = await row(s.branchA, v);
    expect(after.quantity).toBe(10);
    expect(after.lastPhysicalCountAt).toEqual(before.lastPhysicalCountAt);
    expect(await ownerNotices(v)).toBe(0); // a receipt needs no owner notice

    for (const reason of ['DAMAGE', 'LOSS', 'INTERNAL_USE']) {
      const bad = await move(s, empA, v, {
        reason,
        quantity_delta: 2,
        reason_note: 'خطأ',
      }).expect(409);
      expect(bad.body.error.code).toBe('INVALID_MOVEMENT_DIRECTION');
    }
    const negReceive = await move(s, empA, v, {
      reason: 'RECEIVE',
      quantity_delta: -1,
      reason_note: 'خطأ',
    }).expect(409);
    expect(negReceive.body.error.code).toBe('INVALID_MOVEMENT_DIRECTION');
    for (const delta of [-1, 1]) {
      const sale = await move(s, s.owner, v, {
        reason: 'SALE',
        quantity_delta: delta,
        reason_note: 'بيع',
      }).expect(400);
      expect(sale.body.error.code).toBe('MANUAL_SALE_NOT_ALLOWED');
    }
    expect((await row(s.branchA, v)).quantity).toBe(10);
    // none of the refused ones left a trace
    expect(
      await prisma.stockMovement.count({
        where: {
          offerVariantId: v,
          branchId: s.branchA,
          reason: { not: 'INITIAL_STOCK' },
        },
      }),
    ).toBe(1);
  });

  it('a count by the counted quantity: the server works the difference out, sets the last count; a stock that moved meanwhile, no difference, or below what orders hold are refused', async () => {
    const v = await f.offer(s, 10);
    const up = await move(s, empA, v, {
      reason: 'COUNT_CORRECTION',
      counted_quantity: 12,
      expected_quantity: 10,
      reason_note: 'جرد الرف',
    }).expect(201);
    expect(up.body.quantity_delta).toBe(2);
    expect(up.body.resulting_quantity).toBe(12);
    expect((await row(s.branchA, v)).lastPhysicalCountAt).not.toBeNull();
    const down = await move(s, empA, v, {
      reason: 'COUNT_CORRECTION',
      counted_quantity: 9,
      expected_quantity: 12,
      reason_note: 'جرد الرف',
    }).expect(201);
    expect(down.body.quantity_delta).toBe(-3);
    expect((await row(s.branchA, v)).quantity).toBe(9);
    expect(await ownerNotices(v)).toBe(2); // a count difference tells the owner

    // the screen showed 12 but the stock is 9 now: recount, nothing applied
    for (const counted of [14, 5]) {
      const stale = await move(s, empA, v, {
        reason: 'COUNT_CORRECTION',
        counted_quantity: counted,
        expected_quantity: 12,
        reason_note: 'جرد',
      }).expect(409);
      expect(stale.body.error.code).toBe('STOCK_CHANGED_RECOUNT');
    }
    expect((await row(s.branchA, v)).quantity).toBe(9);
    const same = await move(s, empA, v, {
      reason: 'COUNT_CORRECTION',
      counted_quantity: 9,
      expected_quantity: 9,
      reason_note: 'جرد',
    }).expect(409);
    expect(same.body.error.code).toBe('COUNT_NO_DIFFERENCE');
    // 3 held by a shopper's checkout: a count may not go below them
    await hold(s, v, 3);
    const below = await move(s, empA, v, {
      reason: 'COUNT_CORRECTION',
      counted_quantity: 2,
      expected_quantity: 9,
      reason_note: 'جرد',
    }).expect(409);
    expect(below.body.error.code).toBe('COUNT_BELOW_RESERVED');
    expect((await row(s.branchA, v)).quantity).toBe(9);
  });

  it('roles and branches: the employee acts and reads in her branch only and never sets the threshold; the owner does all', async () => {
    const v = await f.offer(s, 5);
    await move(s, empB, v, {
      reason: 'DAMAGE',
      quantity_delta: -1,
      reason_note: 'تلف',
    }).expect(403);
    for (const path of ['/board', `/${v}/detail`, `/${v}/ledger`]) {
      await f
        .http()
        .get(stockUrl(s, s.branchA, path))
        .set(f.bearer(empB.token))
        .expect(403);
      await f
        .http()
        .get(stockUrl(s, s.branchA, path))
        .set(f.bearer(empA.token))
        .expect(200);
      await f
        .http()
        .get(stockUrl(s, s.branchB, path))
        .set(f.bearer(s.owner.token))
        .expect(200);
    }
    await f
      .http()
      .put(stockUrl(s, s.branchA, `/${v}/safety-stock`))
      .set(f.bearer(empA.token))
      .set('Idempotency-Key', f.unique('t'))
      .send({ threshold: 2 })
      .expect(403);
    await f
      .http()
      .put(stockUrl(s, s.branchA, `/${v}/safety-stock`))
      .set(f.bearer(s.owner.token))
      .set('Idempotency-Key', f.unique('t'))
      .send({ threshold: 2 })
      .expect(200);
    // another store's owner is not a member
    const other = (await f.store()).owner;
    await f
      .http()
      .get(stockUrl(s, s.branchA, '/board'))
      .set(f.bearer(other.token))
      .expect(403);
  });

  it('idempotency: the same key twice is one movement', async () => {
    const v = await f.offer(s, 5);
    const key = f.unique('same');
    const body = { reason: 'LOSS', quantity_delta: -1, reason_note: 'فقدان' };
    const a = await move(s, empA, v, body, s.branchA, key).expect(201);
    const b = await move(s, empA, v, body, s.branchA, key);
    expect([200, 201]).toContain(b.status);
    expect(b.body.id).toBe(a.body.id);
    expect((await row(s.branchA, v)).quantity).toBe(4);
    expect(
      await prisma.stockMovement.count({
        where: { offerVariantId: v, reason: 'LOSS' },
      }),
    ).toBe(1);
  });

  it('low stock: one alert when damage / loss / internal use take the line to its threshold - not again while below; 1-3 only without a threshold', async () => {
    const v = await f.offer(s, 8);
    await f
      .http()
      .put(stockUrl(s, s.branchA, `/${v}/safety-stock`))
      .set(f.bearer(s.owner.token))
      .set('Idempotency-Key', f.unique('t'))
      .send({ threshold: 5 })
      .expect(200);
    const recipients = 2; // the owner and branch A's employee
    await move(s, empA, v, {
      reason: 'DAMAGE',
      quantity_delta: -2,
      reason_note: 'تلف',
    }).expect(201); // 6
    expect(await lowAlerts(v)).toBe(0);
    await move(s, empA, v, {
      reason: 'LOSS',
      quantity_delta: -1,
      reason_note: 'فقدان',
    }).expect(201); // 5
    expect(await lowAlerts(v)).toBe(recipients);
    await move(s, empA, v, {
      reason: 'INTERNAL_USE',
      quantity_delta: -1,
      reason_note: 'هدية',
    }).expect(201); // 4
    await move(s, empA, v, {
      reason: 'DAMAGE',
      quantity_delta: -1,
      reason_note: 'تلف',
    }).expect(201); // 3
    expect(await lowAlerts(v)).toBe(recipients); // still the one
    // back above, then down again: a new crossing
    await move(s, empA, v, {
      reason: 'RECEIVE',
      quantity_delta: 5,
      reason_note: 'شحنة',
    }).expect(201); // 8
    await move(s, empA, v, {
      reason: 'INTERNAL_USE',
      quantity_delta: -3,
      reason_note: 'عيّنات',
    }).expect(201); // 5
    expect(await lowAlerts(v)).toBe(2 * recipients);

    // no threshold: the old 1-3 band
    const w = await f.offer(s, 5);
    await move(s, empA, w, {
      reason: 'DAMAGE',
      quantity_delta: -1,
      reason_note: 'تلف',
    }).expect(201); // 4
    expect(await lowAlerts(w)).toBe(0);
    await move(s, empA, w, {
      reason: 'DAMAGE',
      quantity_delta: -1,
      reason_note: 'تلف',
    }).expect(201); // 3
    expect(await lowAlerts(w)).toBe(recipients);
  });

  it("online orders: ORDER_SALE on confirm and ORDER_CANCEL_RESTOCK on a cancellation, linked to the order - the order's own stock effect unchanged", async () => {
    const v = await f.offer(s, 6);
    const buyer = await f.account();
    const { branchOrderId } = await f.buy(buyer, s, v);
    const afterBuy = await row(s.branchA, v);
    expect(afterBuy.quantity).toBe(5);
    expect(afterBuy.reservedQuantity).toBe(0);
    const sale = await prisma.stockMovement.findFirstOrThrow({
      where: { branchOrderId, reason: 'ORDER_SALE' },
    });
    expect(sale).toMatchObject({
      offerVariantId: v,
      branchId: s.branchA,
      quantityDelta: -1,
      resultingQuantity: 5,
      actorId: buyer.userId,
      actorRole: 'CUSTOMER',
    });
    await f
      .http()
      .post(`/api/v1/customers/me/orders/${branchOrderId}/cancel`)
      .set(f.bearer(buyer.token))
      .set('Idempotency-Key', f.unique('cancel'))
      .send({})
      .expect((r) => expect([200, 201]).toContain(r.status));
    expect((await row(s.branchA, v)).quantity).toBe(6);
    const back = await prisma.stockMovement.findFirstOrThrow({
      where: { branchOrderId, reason: 'ORDER_CANCEL_RESTOCK' },
    });
    expect(back).toMatchObject({
      quantityDelta: 1,
      resultingQuantity: 6,
      actorRole: 'CUSTOMER',
    });
    expect(
      (
        await prisma.branchOrder.findUniqueOrThrow({
          where: { id: branchOrderId },
        })
      ).status,
    ).toBe('CANCELLED');

    // the log: newest first, both linked to the order, the shopper never named
    const log = await f
      .http()
      .get(stockUrl(s, s.branchA, `/${v}/ledger`))
      .set(f.bearer(empA.token))
      .expect(200);
    expect(
      log.body.items.slice(0, 2).map((i: { reason: string }) => i.reason),
    ).toEqual(['ORDER_CANCEL_RESTOCK', 'ORDER_SALE']);
    for (const i of log.body.items.slice(0, 2)) {
      expect(i.reference).toEqual({
        kind: 'order',
        id: branchOrderId,
        number: branchOrderId.slice(0, 8),
      });
      expect(i.actor).toEqual({ kind: 'customer' });
    }
    expect(log.body.items[0]).toMatchObject({
      delta: 1,
      resulting_quantity: 6,
    });
  });

  it('the board: summary, search by name / SKU / barcode, filters, pages, and a pinned line outside the first page', async () => {
    const t = await f.store();
    const mk = async (title: string, qty: number) => {
      const v = await f.offer(t, qty);
      const ov = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: v },
      });
      await prisma.vendorOffer.update({
        where: { id: ov.vendorOfferId },
        data: { titleAr: title, titleEn: title },
      });
      return { v, sku: ov.sellerSku, sib: ov.storeInventoryBarcode };
    };
    const a = await mk('أ فستان كتان', 20);
    const b = await mk('ب قميص حرير', 2); // low (1-3, no threshold)
    const c = await mk('ج تنورة', 0); // out
    const d = await mk('د بلوزة', 7);
    // a counted line is not «not counted lately»
    await move(t, t.owner, d.v, {
      reason: 'COUNT_CORRECTION',
      counted_quantity: 8,
      expected_quantity: 7,
      reason_note: 'جرد',
    }).expect(201);
    const get = (qs: string) =>
      f
        .http()
        .get(stockUrl(t, t.branchA, `/board${qs}`))
        .set(f.bearer(t.owner.token))
        .expect(200);

    const all = await get('');
    expect(all.body.summary).toEqual({
      total_pieces: 30,
      lines: 4,
      low: 1,
      out: 1,
      stale: 2,
    });
    expect(
      all.body.items.map(
        (i: { offer_variant_id: string }) => i.offer_variant_id,
      ),
    ).toEqual([a.v, b.v, c.v, d.v]);
    const first = all.body.items[0];
    expect(first).toMatchObject({
      quantity: 20,
      reserved_quantity: 0,
      available_quantity: 20,
      is_low: false,
      is_out: false,
      is_stale: true,
    });
    const ids = (r: { body: { items: { offer_variant_id: string }[] } }) =>
      r.body.items.map((i) => i.offer_variant_id);
    expect(ids(await get('?q=' + encodeURIComponent('قميص')))).toEqual([b.v]);
    expect(ids(await get('?q=' + encodeURIComponent(c.sku)))).toEqual([c.v]);
    expect(ids(await get('?q=' + encodeURIComponent(d.sib)))).toEqual([d.v]);
    expect(ids(await get('?filter=low'))).toEqual([b.v]);
    expect(ids(await get('?filter=out'))).toEqual([c.v]);
    expect(ids(await get('?filter=stale'))).toEqual([a.v, b.v]);
    const p1 = await get('?limit=2');
    expect(ids(p1)).toEqual([a.v, b.v]);
    expect(p1.body.next_cursor).toBe('2');
    const p2 = await get(`?limit=2&cursor=${p1.body.next_cursor}`);
    expect(ids(p2)).toEqual([c.v, d.v]);
    expect(p2.body.next_cursor).toBeNull();
    // a low-stock link to a line on a later page: pinned
    const pinned = await get(`?limit=1&variant=${d.v}`);
    expect(ids(pinned)).toEqual([a.v]);
    expect(pinned.body.pinned.offer_variant_id).toBe(d.v);
    // another store's line is never pinned
    expect((await get(`?variant=${b.v}`)).body.pinned.offer_variant_id).toBe(
      b.v,
    );
    const foreign = await f.offer(s, 1);
    expect((await get(`?variant=${foreign}`)).body.pinned).toBeNull();
    await f
      .http()
      .get(stockUrl(t, t.branchA, '/board?filter=bad'))
      .set(f.bearer(t.owner.token))
      .expect(400);
  });

  it('one line: numbers, threshold, and (read only) the units of open orders; its log pages', async () => {
    const v = await f.offer(s, 10);
    const buyer = await f.account();
    await f.buy(buyer, s, v); // 1 unit in a new (PLACED) order
    const d = await f
      .http()
      .get(stockUrl(s, s.branchA, `/${v}/detail`))
      .set(f.bearer(empA.token))
      .expect(200);
    expect(d.body).toMatchObject({
      offer_variant_id: v,
      quantity: 9,
      available_quantity: 9,
      in_open_orders: 1,
    });
    for (let i = 0; i < 3; i += 1) {
      await move(s, empA, v, {
        reason: 'RECEIVE',
        quantity_delta: 1,
        reason_note: `شحنة ${i}`,
      }).expect(201);
    }
    const l1 = await f
      .http()
      .get(stockUrl(s, s.branchA, `/${v}/ledger?limit=2`))
      .set(f.bearer(empA.token))
      .expect(200);
    expect(l1.body.items).toHaveLength(2);
    expect(l1.body.items[0]).toMatchObject({
      reason: 'RECEIVE',
      note: 'شحنة 2',
      delta: 1,
    });
    expect(l1.body.items[0].actor).toMatchObject({
      kind: 'person',
      role: 'BRANCH_EMPLOYEE',
    });
    const l2 = await f
      .http()
      .get(
        stockUrl(
          s,
          s.branchA,
          `/${v}/ledger?limit=2&cursor=${l1.body.next_cursor}`,
        ),
      )
      .set(f.bearer(empA.token))
      .expect(200);
    const seen = [...l1.body.items, ...l2.body.items].map(
      (i: { id: string }) => i.id,
    );
    expect(new Set(seen).size).toBe(seen.length);
    expect(l2.body.items.map((i: { reason: string }) => i.reason)).toContain(
      'RECEIVE',
    );
  });
});
