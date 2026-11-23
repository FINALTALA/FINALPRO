import { ThrottlerStorage } from '@nestjs/throttler';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { CURRENT_PLATFORM_TERMS_VERSION } from './../src/checkout/checkout.service';
import {
  dateOnly,
  localDateString,
  windowStartInstant,
} from './../src/checkout/delivery-calendar.util';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { tb26Fixtures } from './helpers/tb26-fixtures';

// «نوافذ التوصيل v1»: one window state on the server (shopper slots and the
// branch board agree), a planned branch closure that stops holds / bookings /
// confirmations, the last seat under two concurrent reservations, pause and
// resume, no delete / no time change once a window has orders, no capacity
// below what is booked, no closing a day over active orders (with the
// orders listed for the branch queue), and the branch employee read-only.
describe('Delivery windows v1 (e2e)', () => {
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

  /** A Palestine calendar date n days from today, 'YYYY-MM-DD'. */
  const dayAhead = (n: number) =>
    new Date(dateOnly(localDateString(new Date())).getTime() + n * 86_400_000)
      .toISOString()
      .slice(0, 10);
  const dowOf = (date: string) => dateOnly(date).getUTCDay();
  const base = (s: Store, branchId = s.branchA) =>
    `/api/v1/vendors/${s.vendorId}/branches/${branchId}/delivery-windows`;

  async function deliveryStore() {
    const s = await f.store();
    await prisma.vendorDeliveryZone.create({
      data: {
        vendorId: s.vendorId,
        region: 'WEST_BANK',
        enabled: true,
        fee: 10,
      },
    });
    return s;
  }
  async function window(
    s: Store,
    date: string,
    capacity: number,
    start = '08:00',
    end = '20:00',
  ) {
    const r = await f
      .http()
      .post(base(s))
      .set(f.bearer(s.owner.token))
      .send({
        day_of_week: dowOf(date),
        start_time: start,
        end_time: end,
        capacity,
      })
      .expect(201);
    return r.body.id as string;
  }
  async function buyerWithLine(s: Store, variantId: string) {
    const buyer = await f.account();
    const address = await f
      .http()
      .post('/api/v1/customers/me/addresses')
      .set(f.bearer(buyer.token))
      .send({
        lat: 31.9,
        lng: 35.2,
        phone_number_1: '+970591111111',
        zone: 'WEST_BANK',
      })
      .expect(201);
    const cart = await f
      .http()
      .post('/api/v1/cart/items')
      .set(f.bearer(buyer.token))
      .set('Idempotency-Key', f.unique('cart'))
      .send({ vendor_id: s.vendorId, offer_variant_id: variantId, quantity: 1 })
      .expect(201);
    return {
      buyer,
      addressId: address.body.id as string,
      line: cart.body.id as string,
    };
  }
  const reserve = (
    s: Store,
    b: { buyer: Account; addressId: string; line: string },
    windowId: string,
    date: string,
  ) =>
    f
      .http()
      .post('/api/v1/checkout/reserve')
      .set(f.bearer(b.buyer.token))
      .set('Idempotency-Key', f.unique('reserve'))
      .send({
        terms_accepted: true,
        terms_version: CURRENT_PLATFORM_TERMS_VERSION,
        groups: [
          {
            cart_item_ids: [b.line],
            branch_id: s.branchA,
            fulfilment_method: 'DELIVERY',
            payment_method: 'COD',
            address_id: b.addressId,
            delivery_window_id: windowId,
            scheduled_date: date,
          },
        ],
      });
  const confirm = (buyer: Account, reservationId: string) =>
    f
      .http()
      .post('/api/v1/checkout/confirm')
      .set(f.bearer(buyer.token))
      .set('Idempotency-Key', f.unique('confirm'))
      .send({ reservation_id: reservationId });
  /** A confirmed (PLACED) delivery order on that window/date. */
  async function order(
    s: Store,
    variantId: string,
    windowId: string,
    date: string,
  ) {
    const b = await buyerWithLine(s, variantId);
    const r = await reserve(s, b, windowId, date).expect(201);
    const c = await confirm(b.buyer, r.body.reservation_id).expect(201);
    return c.body.branch_orders[0].id as string;
  }
  const board = (s: Store, who: { token: string }, branchId = s.branchA) =>
    f
      .http()
      .get(`${base(s, branchId)}/board`)
      .set(f.bearer(who.token));
  async function boardWindow(s: Store, windowId: string, date: string) {
    const b = await board(s, s.owner).expect(200);
    const day = b.body.days.find((d: { date: string }) => d.date === date);
    return day?.windows.find(
      (w: { window_id: string }) => w.window_id === windowId,
    );
  }
  /** The shopper's offered slots for that branch (the checkout quote). */
  async function offered(s: Store, variantId: string) {
    const b = await buyerWithLine(s, variantId);
    const q = await f
      .http()
      .post('/api/v1/checkout/quote')
      .set(f.bearer(b.buyer.token))
      .send({ cart_item_ids: [b.line], address_id: b.addressId })
      .expect(201);
    const branch = q.body.groups[0].eligible_branches.find(
      (x: { branch_id: string }) => x.branch_id === s.branchA,
    );
    return (branch?.available_slots ?? []) as {
      delivery_window_id: string;
      date: string;
      remaining_capacity: number;
    }[];
  }
  const audits = (entityId: string, action: string) =>
    prisma.auditLog.findMany({
      where: { entityId, action },
      orderBy: { occurredAt: 'asc' },
    });

  it('a planned branch closure: the slot is no longer offered, a new hold is refused, and an existing hold fails to confirm safely - earlier orders untouched', async () => {
    const s = await deliveryStore();
    const v = await f.offer(s, 10);
    const date = dayAhead(2);
    const earlierDate = dayAhead(1);
    const w = await window(s, date, 3);
    const wEarlier = await window(s, earlierDate, 3);
    const earlierOrder = await order(s, v, wEarlier, earlierDate);

    const holder = await buyerWithLine(s, v);
    const held = await reserve(s, holder, w, date).expect(201);
    const stockBefore = await prisma.branchStock.findFirstOrThrow({
      where: { branchId: s.branchA, offerVariantId: v },
    });

    // the closure covers the held window, not the earlier order's day
    const startsAt = windowStartInstant(dateOnly(date), 7 * 60);
    const endsAt = windowStartInstant(dateOnly(date), 22 * 60);
    await f
      .http()
      .post(`/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/closures`)
      .set(f.bearer(s.owner.token))
      .set('Idempotency-Key', f.unique('closure'))
      .send({
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        reason: 'جرد سنوي',
      })
      .expect(201);

    expect(
      (await offered(s, v)).some(
        (x) => x.delivery_window_id === w && x.date === date,
      ),
    ).toBe(false);
    expect(await boardWindow(s, w, date)).toMatchObject({
      status: 'CLOSED',
      closed_source: 'BRANCH_CLOSURE',
      reason: 'جرد سنوي',
    });

    const other = await buyerWithLine(s, v);
    const refused = await reserve(s, other, w, date).expect(409);
    expect(refused.body.error.code).toBe('SLOT_CLOSED');

    const c = await confirm(holder.buyer, held.body.reservation_id).expect(409);
    expect(c.body.error.code).toBe('SLOT_NO_LONGER_AVAILABLE');
    expect(
      await prisma.branchOrder.count({ where: { deliveryWindowId: w } }),
    ).toBe(0);
    const stockAfter = await prisma.branchStock.findFirstOrThrow({
      where: { branchId: s.branchA, offerVariantId: v },
    });
    expect(stockAfter.quantity).toBe(stockBefore.quantity); // nothing sold
    expect(await prisma.cartItem.count({ where: { id: holder.line } })).toBe(1); // cart kept
    expect(
      (
        await prisma.branchOrder.findUniqueOrThrow({
          where: { id: earlierOrder },
        })
      ).status,
    ).toBe('PLACED');

    // and a closure is never placed on top of an active order
    const onOrder = await f
      .http()
      .post(`/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/closures`)
      .set(f.bearer(s.owner.token))
      .set('Idempotency-Key', f.unique('closure'))
      .send({
        starts_at: windowStartInstant(
          dateOnly(earlierDate),
          7 * 60,
        ).toISOString(),
        ends_at: windowStartInstant(
          dateOnly(earlierDate),
          21 * 60,
        ).toISOString(),
      })
      .expect(409);
    expect(onOrder.body.error.code).toBe('BRANCH_CLOSURE_HAS_ACTIVE_ORDERS');
    expect(onOrder.body.error.details[0]).toMatchObject({
      active_orders: 1,
      dates: [earlierDate],
    });
  });

  it('the last seat, two reservations at once: exactly one wins; the other gets a clear "no longer available" and keeps its cart', async () => {
    const s = await deliveryStore();
    const v = await f.offer(s, 10);
    const date = dayAhead(3);
    const w = await window(s, date, 1);
    const a = await buyerWithLine(s, v);
    const b = await buyerWithLine(s, v);
    const [ra, rb] = await Promise.all([
      reserve(s, a, w, date),
      reserve(s, b, w, date),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = ra.status === 409 ? ra : rb;
    const loserLine = ra.status === 409 ? a.line : b.line;
    expect(['SLOT_CAPACITY_EXCEEDED', 'SLOT_NO_LONGER_AVAILABLE']).toContain(
      loser.body.error.code,
    );
    expect(await prisma.cartItem.count({ where: { id: loserLine } })).toBe(1);
    const winner = ra.status === 201 ? { r: ra, who: a } : { r: rb, who: b };
    await confirm(winner.who.buyer, winner.r.body.reservation_id).expect(201);
    expect(await boardWindow(s, w, date)).toMatchObject({
      status: 'FULL',
      booked: 1,
      remaining: 0,
    });
  });

  it('pause and resume: a paused window is not offered, keeps its orders on the board, frees its time; resume re-checks the overlap - all audited with the reason', async () => {
    const s = await deliveryStore();
    const v = await f.offer(s, 10);
    const date = dayAhead(4);
    const w = await window(s, date, 3);
    await order(s, v, w, date);

    const noReason = await f
      .http()
      .post(`${base(s)}/${w}/pause`)
      .set(f.bearer(s.owner.token))
      .send({})
      .expect(400);
    expect(noReason.status).toBe(400);
    await f
      .http()
      .post(`${base(s)}/${w}/pause`)
      .set(f.bearer(s.owner.token))
      .send({ reason: 'السائق في إجازة' })
      .expect(200);
    expect(await boardWindow(s, w, date)).toMatchObject({
      status: 'PAUSED',
      paused: true,
      booked: 1,
      reason: 'السائق في إجازة',
    });
    expect((await offered(s, v)).some((x) => x.delivery_window_id === w)).toBe(
      false,
    );
    const refused = await reserve(s, await buyerWithLine(s, v), w, date).expect(
      409,
    );
    expect(refused.body.error.code).toBe('SLOT_CLOSED');

    // its time is free: a new window may take it; then resuming the old one overlaps
    const w2 = await window(s, date, 2, '09:00', '12:00');
    const overlap = await f
      .http()
      .post(`${base(s)}/${w}/resume`)
      .set(f.bearer(s.owner.token))
      .send({ reason: 'عاد السائق' })
      .expect(409);
    expect(overlap.body.error.code).toBe('DELIVERY_WINDOW_OVERLAP');
    await f
      .http()
      .post(`${base(s)}/${w2}/pause`)
      .set(f.bearer(s.owner.token))
      .send({ reason: 'نافذة مؤقتة' })
      .expect(200);
    await f
      .http()
      .post(`${base(s)}/${w}/resume`)
      .set(f.bearer(s.owner.token))
      .send({ reason: 'عاد السائق' })
      .expect(200);
    expect(await boardWindow(s, w, date)).toMatchObject({
      status: 'OPEN',
      paused: false,
      booked: 1,
    });

    const paused = await audits(w, 'delivery_window.paused');
    const resumed = await audits(w, 'delivery_window.resumed');
    expect(paused).toHaveLength(1);
    expect(paused[0].actorId).toBe(s.owner.userId);
    expect(paused[0].afterState).toMatchObject({
      paused: true,
      reason: 'السائق في إجازة',
    });
    expect(paused[0].beforeState).toMatchObject({ paused: false });
    expect(resumed[0].afterState).toMatchObject({
      paused: false,
      reason: 'عاد السائق',
    });
  });

  it('a window with order history: never deleted, its day/time never edited (pause + new window instead); one without history can be deleted', async () => {
    const s = await deliveryStore();
    const v = await f.offer(s, 10);
    const date = dayAhead(5);
    const w = await window(s, date, 3);
    await order(s, v, w, date);
    const del = await f
      .http()
      .delete(`${base(s)}/${w}`)
      .set(f.bearer(s.owner.token))
      .expect(409);
    expect(del.body.error.code).toBe('DELIVERY_WINDOW_HAS_ORDER_HISTORY');
    const move = await f
      .http()
      .put(`${base(s)}/${w}`)
      .set(f.bearer(s.owner.token))
      .send({
        day_of_week: dowOf(date),
        start_time: '10:00',
        end_time: '20:00',
        capacity: 3,
      })
      .expect(409);
    expect(move.body.error.code).toBe('DELIVERY_WINDOW_TIME_LOCKED');
    const unused = await window(s, dayAhead(6), 2);
    await f
      .http()
      .delete(`${base(s)}/${unused}`)
      .set(f.bearer(s.owner.token))
      .expect(200);
  });

  it('capacity: raising is allowed, lowering stops at what is booked (the message says the number), and a change needs a reason (audited before/after)', async () => {
    const s = await deliveryStore();
    const v = await f.offer(s, 10);
    const date = dayAhead(2);
    const w = await window(s, date, 3);
    await order(s, v, w, date);
    await order(s, v, w, date);
    const put = (capacity: number, reason?: string) =>
      f
        .http()
        .put(`${base(s)}/${w}`)
        .set(f.bearer(s.owner.token))
        .send({
          day_of_week: dowOf(date),
          start_time: '08:00',
          end_time: '20:00',
          capacity,
          ...(reason ? { reason } : {}),
        });
    const tooLow = await put(1, 'تقليل').expect(409);
    expect(tooLow.body.error.code).toBe('CAPACITY_BELOW_BOOKINGS');
    expect(tooLow.body.error.message).toContain('2');
    expect(tooLow.body.error.details[0]).toMatchObject({
      requested: 1,
      booked: 2,
      date,
    });
    const noReason = await put(2).expect(400);
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    await put(2, 'سائق واحد اليوم').expect(200);
    await put(5, 'سائق إضافي').expect(200);
    const changes = await audits(w, 'delivery_window.capacity_changed');
    expect(
      changes.map((a) => [
        (a.beforeState as { capacity: number }).capacity,
        (a.afterState as { capacity: number; reason: string }).capacity,
        (a.afterState as { reason: string }).reason,
      ]),
    ).toEqual([
      [3, 2, 'سائق واحد اليوم'],
      [2, 5, 'سائق إضافي'],
    ]);
  });

  it('closing a day with active orders is refused and lists them (the branch queue filters to that date/window); stopping new bookings is allowed and keeps the orders; a day without orders closes', async () => {
    const s = await deliveryStore();
    const v = await f.offer(s, 10);
    const date = dayAhead(3);
    const w = await window(s, date, 3);
    const orderId = await order(s, v, w, date);

    const close = await f
      .http()
      .post(`${base(s)}/days/${date}/close`)
      .set(f.bearer(s.owner.token))
      .send({ reason: 'عيد' })
      .expect(409);
    expect(close.body.error.code).toBe('DAY_HAS_ACTIVE_ORDERS');
    expect(close.body.error.details[0]).toMatchObject({
      active_orders: 1,
      dates: [date],
      windows: [{ date, delivery_window_id: w, active_orders: 1 }],
    });
    const queue = await f
      .http()
      .get(
        `/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/order-queue?date=${date}&window=${w}`,
      )
      .set(f.bearer(s.owner.token))
      .expect(200);
    const ids = (queue.body.items as { id: string }[]).map((o) => o.id);
    expect(ids).toEqual([orderId]);
    const otherDay = await f
      .http()
      .get(
        `/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/order-queue?date=${dayAhead(4)}`,
      )
      .set(f.bearer(s.owner.token))
      .expect(200);
    expect(otherDay.body.items).toHaveLength(0);

    await f
      .http()
      .post(`${base(s)}/days/${date}/stop-booking`)
      .set(f.bearer(s.owner.token))
      .send({ reason: 'ضغط عمل' })
      .expect(200);
    expect(await boardWindow(s, w, date)).toMatchObject({
      status: 'BOOKING_STOPPED',
      reason: 'ضغط عمل',
      booked: 1,
    });
    expect(
      (await prisma.branchOrder.findUniqueOrThrow({ where: { id: orderId } }))
        .status,
    ).toBe('PLACED');
    expect(
      (await offered(s, v)).some(
        (x) => x.delivery_window_id === w && x.date === date,
      ),
    ).toBe(false);
    await f
      .http()
      .post(`${base(s)}/days/${date}/reopen`)
      .set(f.bearer(s.owner.token))
      .send({ reason: 'خف الضغط' })
      .expect(200);
    expect((await boardWindow(s, w, date)).status).toBe('OPEN');

    const freeDate = dayAhead(5);
    const wFree = await window(s, freeDate, 2);
    await f
      .http()
      .post(`${base(s)}/days/${freeDate}/close`)
      .set(f.bearer(s.owner.token))
      .send({ reason: 'عطلة' })
      .expect(200);
    expect(await boardWindow(s, wFree, freeDate)).toMatchObject({
      status: 'CLOSED',
      closed_source: 'DATE',
      reason: 'عطلة',
    });
    const r = await reserve(
      s,
      await buyerWithLine(s, v),
      wFree,
      freeDate,
    ).expect(409);
    expect(r.body.error.code).toBe('SLOT_CLOSED');
    expect((await audits(wFree, 'delivery_window.day_closed')).length).toBe(0); // audited on the exception row
    const closedRows = await prisma.auditLog.findMany({
      where: { action: 'delivery_window.day_closed', actorId: s.owner.userId },
    });
    expect(closedRows.length).toBeGreaterThanOrEqual(1);
    expect(closedRows[0].afterState).toMatchObject({
      is_closed: true,
      reason: 'عطلة',
    });
  });

  it("the branch employee: reads their own branch's board, every write is 403, another branch's board is 403", async () => {
    const s = await deliveryStore();
    const date = dayAhead(2);
    const w = await window(s, date, 3);
    const empA = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      s.branchA,
    );
    const empB = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      s.branchB,
    );
    const b = await board(s, empA).expect(200);
    expect(b.body.days).toHaveLength(7);
    // each request is built when it is sent (a supertest request binds its
    // own ephemeral server at creation)
    const auth = f.bearer(empA.token);
    const writes: (() => Promise<{ status: number }>)[] = [
      () =>
        f.http().post(base(s)).set(auth).send({
          day_of_week: 1,
          start_time: '08:00',
          end_time: '09:00',
          capacity: 1,
        }),
      () =>
        f
          .http()
          .put(`${base(s)}/${w}`)
          .set(auth)
          .send({
            day_of_week: dowOf(date),
            start_time: '08:00',
            end_time: '20:00',
            capacity: 9,
            reason: 'xyz',
          }),
      () =>
        f
          .http()
          .delete(`${base(s)}/${w}`)
          .set(auth),
      () =>
        f
          .http()
          .post(`${base(s)}/${w}/pause`)
          .set(auth)
          .send({ reason: 'xyz' }),
      () =>
        f
          .http()
          .post(`${base(s)}/${w}/resume`)
          .set(auth)
          .send({ reason: 'xyz' }),
      () =>
        f
          .http()
          .post(`${base(s)}/${w}/stop-booking`)
          .set(auth)
          .send({ date, reason: 'xyz' }),
      () =>
        f
          .http()
          .post(`${base(s)}/${w}/reopen`)
          .set(auth)
          .send({ date, reason: 'xyz' }),
      () =>
        f
          .http()
          .post(`${base(s)}/days/${date}/stop-booking`)
          .set(auth)
          .send({ reason: 'xyz' }),
      () =>
        f
          .http()
          .post(`${base(s)}/days/${date}/close`)
          .set(auth)
          .send({ reason: 'xyz' }),
      () =>
        f
          .http()
          .post(`${base(s)}/days/${date}/reopen`)
          .set(auth)
          .send({ reason: 'xyz' }),
    ];
    for (const send of writes) {
      expect((await send()).status).toBe(403);
    }
    const other = await board(s, empB).expect(403);
    expect(other.body.error.code).toBe('BRANCH_ACCESS_DENIED');
  });

  it('one window state: the slots the shopper is offered are exactly the OPEN windows of the branch board, with the same remaining seats', async () => {
    const s = await deliveryStore();
    const v = await f.offer(s, 20);
    const open = await window(s, dayAhead(2), 3);
    const full = await window(s, dayAhead(3), 1);
    const paused = await window(s, dayAhead(4), 3);
    const stopped = await window(s, dayAhead(5), 3);
    await order(s, v, open, dayAhead(2));
    await order(s, v, full, dayAhead(3));
    await f
      .http()
      .post(`${base(s)}/${paused}/pause`)
      .set(f.bearer(s.owner.token))
      .send({ reason: 'موقوفة' })
      .expect(200);
    await f
      .http()
      .post(`${base(s)}/${stopped}/stop-booking`)
      .set(f.bearer(s.owner.token))
      .send({ date: dayAhead(5), reason: 'متوقف' })
      .expect(200);

    const b = await board(s, s.owner).expect(200);
    type W = { window_id: string; status: string; remaining: number };
    const boardOpen = (b.body.days as { date: string; windows: W[] }[])
      .flatMap((d) =>
        d.windows
          .filter((w) => w.status === 'OPEN')
          .map((w) => `${w.window_id}|${d.date}|${w.remaining}`),
      )
      .sort();
    const shopper = (await offered(s, v))
      .map((x) => `${x.delivery_window_id}|${x.date}|${x.remaining_capacity}`)
      .sort();
    expect(shopper).toEqual(boardOpen);
    const statusOf = (id: string) =>
      (b.body.days as { windows: W[] }[])
        .flatMap((d) => d.windows)
        .filter((w) => w.window_id === id)
        .map((w) => w.status);
    expect(statusOf(open)).toContain('OPEN');
    expect(statusOf(full)).toContain('FULL');
    expect(statusOf(paused)).toContain('PAUSED');
    expect(statusOf(stopped)).toContain('BOOKING_STOPPED');
    // and the board's per-window order breakdown uses the real statuses
    const openRow = (
      b.body.days as {
        date: string;
        windows: (W & {
          orders_by_status: Record<string, number>;
          booked: number;
        })[];
      }[]
    )
      .find((d) => d.date === dayAhead(2))!
      .windows.find((w) => w.window_id === open)!;
    expect(openRow.booked).toBe(1);
    expect(openRow.orders_by_status).toEqual({ PLACED: 1 });
  });
});
