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

// «ساعات العمل والإغلاقات v1»: several periods a day (overlap refused by the
// API and by the DB), 15-minute steps, ONE opening rule (Palestine time, a
// temporary closure always wins) behind the owner tab, the store page, the
// product page and the checkout quote; hours never block pickup; a closure
// can be cancelled (not started) or shortened (from now on) with a reason
// and an audit row; the branch employee reads only.
describe('Operating hours & closures v1 (e2e)', () => {
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
    jest.useRealTimers();
    await app.close();
  });

  type Store = Awaited<ReturnType<typeof f.store>>;
  const hoursUrl = (s: Store, branchId = s.branchA) =>
    `/api/v1/vendors/${s.vendorId}/branches/${branchId}/operating-hours`;
  const closuresUrl = (s: Store, branchId = s.branchA) =>
    `/api/v1/vendors/${s.vendorId}/branches/${branchId}/closures`;
  const putHours = (
    s: Store,
    hours: { day_of_week: number; open_minute: number; close_minute: number }[],
    token = s.owner.token,
  ) => f.http().put(hoursUrl(s)).set(f.bearer(token)).send({ hours });
  const createClosure = (s: Store, startsAt: Date, endsAt: Date) =>
    f
      .http()
      .post(closuresUrl(s))
      .set(f.bearer(s.owner.token))
      .set('Idempotency-Key', f.unique('closure'))
      .send({
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        reason: 'جرد',
      });

  /** The next Thursday (Palestine) at least two days ahead, 'YYYY-MM-DD'. */
  function nextThursday(): string {
    const today = dateOnly(localDateString(new Date()));
    for (let k = 2; k < 10; k += 1) {
      const d = new Date(today.getTime() + k * 86_400_000);
      if (d.getUTCDay() === 4) return d.toISOString().slice(0, 10);
    }
    throw new Error('unreachable');
  }
  const THU = 4;
  const at = (date: string, hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return windowStartInstant(dateOnly(date), h * 60 + m);
  };
  /** Only Date is faked - timers, ticks and I/O stay real. */
  function freezeAt(instant: Date) {
    jest.useFakeTimers({
      now: instant,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
  }
  afterEach(() => jest.useRealTimers());

  it('two periods a day; overlap refused (API 400 and DB EXCLUDE); 15-minute steps; touching periods fine; audited', async () => {
    const s = await f.store();
    const two = [
      { day_of_week: THU, open_minute: 16 * 60, close_minute: 21 * 60 },
      { day_of_week: THU, open_minute: 9 * 60, close_minute: 14 * 60 },
      { day_of_week: 5, open_minute: 9 * 60, close_minute: 12 * 60 },
      { day_of_week: 5, open_minute: 12 * 60, close_minute: 24 * 60 },
    ];
    const ok = await putHours(s, two).expect(200);
    expect(ok.body.hours).toEqual([
      { day_of_week: THU, open_minute: 540, close_minute: 840 },
      { day_of_week: THU, open_minute: 960, close_minute: 1260 },
      { day_of_week: 5, open_minute: 540, close_minute: 720 },
      { day_of_week: 5, open_minute: 720, close_minute: 1440 },
    ]);

    const overlap = await putHours(s, [
      { day_of_week: 2, open_minute: 9 * 60, close_minute: 14 * 60 },
      { day_of_week: 2, open_minute: 13 * 60, close_minute: 18 * 60 },
    ]).expect(400);
    expect(overlap.body.error.code).toBe('OVERLAPPING_PERIODS');

    const step = await putHours(s, [
      { day_of_week: 2, open_minute: 9 * 60 + 10, close_minute: 14 * 60 },
    ]).expect(400);
    expect(step.body.error.code).toBe('INVALID_HOURS_STEP');

    const range = await putHours(s, [
      { day_of_week: 2, open_minute: 14 * 60, close_minute: 9 * 60 },
    ]).expect(400);
    expect(range.body.error.code).toBe('INVALID_HOURS_RANGE');
    // nothing changed by the refused PUTs
    const get = await f
      .http()
      .get(hoursUrl(s))
      .set(f.bearer(s.owner.token))
      .expect(200);
    expect(get.body.hours).toHaveLength(4);

    // The database itself refuses an overlap that skips the API.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO branch_operating_hours (id, "vendorId", "branchId", "dayOfWeek", "openMinute", "closeMinute")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 4, 600, 660)`,
        s.vendorId,
        s.branchA,
      ),
    ).rejects.toThrow(/branch_operating_hours_no_overlap/);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        action: 'store_branch.operating_hours_updated',
        entityId: s.branchA,
      },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.actorId).toBe(s.owner.userId);
    expect((audit.afterState as { hours: unknown[] }).hours).toHaveLength(4);
  });

  it('"open now", "open until" and "next opening" with two periods and a temporary closure - the same on the owner tab, the store page, the product page and the checkout quote', async () => {
    const s = await f.store();
    const variantId = await f.offer(s);
    const offer = await prisma.offerVariant.findUniqueOrThrow({
      where: { id: variantId },
      select: { vendorOfferId: true, vendor: { select: { slug: true } } },
    });
    await putHours(s, [
      { day_of_week: THU, open_minute: 9 * 60, close_minute: 14 * 60 },
      { day_of_week: THU, open_minute: 16 * 60, close_minute: 21 * 60 },
    ]).expect(200);
    const thu = nextThursday();
    const iso = (hhmm: string) => at(thu, hhmm).toISOString();

    const ownerTab = async () =>
      (await f.http().get(hoursUrl(s)).set(f.bearer(s.owner.token)).expect(200))
        .body.opening;
    const storePage = async () =>
      (
        await f
          .http()
          .get(`/api/v1/storefronts/${offer.vendor.slug}/info`)
          .expect(200)
      ).body.branches.find((b: { id: string }) => b.id === s.branchA);
    const productPickup = async () =>
      (
        await f
          .http()
          .get(
            `/api/v1/storefronts/${offer.vendor.slug}/offers/${offer.vendorOfferId}`,
          )
          .expect(200)
      ).body.variants[0].fulfilment.pickup.branches[0];
    const buyer = await f.account();
    const line = (
      await f
        .http()
        .post('/api/v1/cart/items')
        .set(f.bearer(buyer.token))
        .set('Idempotency-Key', f.unique('cart'))
        .send({
          vendor_id: s.vendorId,
          offer_variant_id: variantId,
          quantity: 1,
        })
        .expect(201)
    ).body.id as string;
    const quoteOpening = async () => {
      const q = await f
        .http()
        .post('/api/v1/checkout/quote')
        .set(f.bearer(buyer.token))
        .send({ cart_item_ids: [line] })
        .expect(201);
      if (!q.body.groups?.[0]) throw new Error(JSON.stringify(q.body));
      return q.body.groups[0].eligible_branches.find(
        (b: { branch_id: string }) => b.branch_id === s.branchA,
      ).opening;
    };

    // 10:00 inside the morning period
    freezeAt(at(thu, '10:00'));
    const morning = {
      open_now: true,
      open_until: iso('14:00'),
      next_open_at: iso('16:00'),
    };
    expect(await ownerTab()).toEqual(morning);
    expect(await storePage()).toMatchObject(morning);
    const pickup = await productPickup();
    expect(pickup.hours_today).toEqual([
      { open: '09:00', close: '14:00' },
      { open: '16:00', close: '21:00' },
    ]);
    expect(pickup.opening).toEqual(morning);
    expect(await quoteOpening()).toEqual(morning);

    // 15:00 in the gap: closed, opens again 16:00
    freezeAt(at(thu, '15:00'));
    const gap = {
      open_now: false,
      open_until: null,
      next_open_at: iso('16:00'),
    };
    expect(await ownerTab()).toEqual(gap);
    expect(await storePage()).toMatchObject(gap);
    expect((await productPickup()).opening).toEqual(gap);
    expect(await quoteOpening()).toEqual(gap);
    jest.useRealTimers();

    // A temporary closure 12:00-17:00 always wins over the template.
    await createClosure(s, at(thu, '12:00'), at(thu, '17:00')).expect(201);
    freezeAt(at(thu, '10:00'));
    const cut = {
      open_now: true,
      open_until: iso('12:00'),
      next_open_at: iso('17:00'),
    };
    expect(await ownerTab()).toEqual(cut);
    expect(await storePage()).toMatchObject(cut);
    expect((await productPickup()).opening).toEqual(cut);
    expect(await quoteOpening()).toEqual(cut);
    freezeAt(at(thu, '13:00'));
    const closed = {
      open_now: false,
      open_until: null,
      next_open_at: iso('17:00'),
    };
    expect(await ownerTab()).toEqual(closed);
    expect(await storePage()).toMatchObject(closed);
    // unchanged Sprint 18b rule: while a temporary closure is ACTIVE the
    // branch is not sellable at all (hours alone never block anything)
    const during = await f
      .http()
      .post('/api/v1/checkout/quote')
      .set(f.bearer(buyer.token))
      .send({ cart_item_ids: [line] })
      .expect(201);
    expect(during.body.groups).toEqual([]);
  });

  it('pickup outside opening hours is still bookable; the quote tells when the branch opens next', async () => {
    const s = await f.store();
    const variantId = await f.offer(s);
    await putHours(s, [
      { day_of_week: THU, open_minute: 9 * 60, close_minute: 14 * 60 },
      { day_of_week: THU, open_minute: 16 * 60, close_minute: 21 * 60 },
    ]).expect(200);
    const thu = nextThursday();
    const buyer = await f.account();
    const line = (
      await f
        .http()
        .post('/api/v1/cart/items')
        .set(f.bearer(buyer.token))
        .set('Idempotency-Key', f.unique('cart'))
        .send({
          vendor_id: s.vendorId,
          offer_variant_id: variantId,
          quantity: 1,
        })
        .expect(201)
    ).body.id as string;

    // Thursday 22:00 - closed; next opening is the next Thursday 09:00.
    freezeAt(at(thu, '22:00'));
    const quote = await f
      .http()
      .post('/api/v1/checkout/quote')
      .set(f.bearer(buyer.token))
      .send({ cart_item_ids: [line] })
      .expect(201);
    const branch = quote.body.groups[0].eligible_branches.find(
      (b: { branch_id: string }) => b.branch_id === s.branchA,
    );
    const nextThu = new Date(dateOnly(thu).getTime() + 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(branch.opening).toEqual({
      open_now: false,
      open_until: null,
      next_open_at: at(nextThu, '09:00').toISOString(),
    });
    jest.useRealTimers();

    // ...and the pickup order goes through (hours never block buying).
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
            cart_item_ids: [line],
            branch_id: s.branchA,
            fulfilment_method: 'PICKUP',
            payment_method: 'COD',
          },
        ],
      })
      .expect(201);
  });

  it('closures: a future one is cancelled, a started one only shortened from now on, an ended one never touched - reason required, audited with before/after and actor', async () => {
    const s = await f.store();
    const now = Date.now();
    const H = 3_600_000;
    const owner = f.bearer(s.owner.token);
    const post = (id: string, action: string, body: object) =>
      f
        .http()
        .post(`${closuresUrl(s)}/${id}/${action}`)
        .set(owner)
        .send(body);

    // future: reason required, then cancelled
    const future = (
      await createClosure(
        s,
        new Date(now + 48 * H),
        new Date(now + 72 * H),
      ).expect(201)
    ).body.id as string;
    await post(future, 'cancel', {}).expect(400);
    await post(future, 'cancel', { reason: '   ' }).expect(400);
    const cancelled = await post(future, 'cancel', {
      reason: 'تأجّل الجرد',
    }).expect(200);
    expect(cancelled.body).toMatchObject({ id: future, cancelled: true });
    expect(
      await prisma.branchClosure.findUnique({ where: { id: future } }),
    ).toBeNull();
    const cancelAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'store_branch.closure_cancelled', entityId: future },
    });
    expect(cancelAudit.actorId).toBe(s.owner.userId);
    expect(cancelAudit.beforeState).toMatchObject({ id: future });
    expect(cancelAudit.afterState).toEqual({
      cancelled: true,
      change_reason: 'تأجّل الجرد',
    });
    await post(future, 'cancel', { reason: 'x' }).expect(404);

    // started: cannot be cancelled; shortened only from now on
    const started = (
      await createClosure(
        s,
        new Date(now - 1 * H),
        new Date(now + 5 * H),
      ).expect(201)
    ).body.id as string;
    expect(
      (await post(started, 'cancel', { reason: 'x' }).expect(409)).body.error
        .code,
    ).toBe('BRANCH_CLOSURE_STARTED');
    expect(
      (
        await post(started, 'shorten', {
          ends_at: new Date(now - 0.5 * H).toISOString(),
          reason: 'x',
        }).expect(400)
      ).body.error.code,
    ).toBe('CLOSURE_END_IN_PAST');
    expect(
      (
        await post(started, 'shorten', {
          ends_at: new Date(now + 6 * H).toISOString(),
          reason: 'x',
        }).expect(400)
      ).body.error.code,
    ).toBe('CLOSURE_NOT_SHORTER');
    await post(started, 'shorten', {
      ends_at: new Date(now + 2 * H).toISOString(),
    }).expect(400);
    const newEnd = new Date(now + 2 * H).toISOString();
    const shortened = await post(started, 'shorten', {
      ends_at: newEnd,
      reason: 'انتهى الجرد مبكراً',
    }).expect(200);
    expect(shortened.body.ends_at).toBe(newEnd);
    const shortenAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'store_branch.closure_shortened', entityId: started },
    });
    expect(shortenAudit.actorId).toBe(s.owner.userId);
    expect(shortenAudit.beforeState).toMatchObject({
      ends_at: new Date(now + 5 * H).toISOString(),
    });
    expect(shortenAudit.afterState).toMatchObject({
      ends_at: newEnd,
      change_reason: 'انتهى الجرد مبكراً',
    });

    // ended: never edited
    const ended = (
      await createClosure(
        s,
        new Date(now - 30 * H),
        new Date(now - 26 * H),
      ).expect(201)
    ).body.id as string;
    for (const [action, body] of [
      ['cancel', { reason: 'x' }],
      [
        'shorten',
        { ends_at: new Date(now - 27 * H).toISOString(), reason: 'x' },
      ],
    ] as const) {
      expect(
        (await post(ended, action, body).expect(409)).body.error.code,
      ).toBe('BRANCH_CLOSURE_ENDED');
    }

    // another branch's closure is not reachable through this branch
    const other = (
      await f
        .http()
        .post(closuresUrl(s, s.branchB))
        .set(owner)
        .set('Idempotency-Key', f.unique('closure'))
        .send({
          starts_at: new Date(now + 48 * H).toISOString(),
          ends_at: new Date(now + 50 * H).toISOString(),
        })
        .expect(201)
    ).body.id as string;
    await post(other, 'cancel', { reason: 'x' }).expect(404);
  });

  it('the branch employee reads hours and closures; every write is 403', async () => {
    const s = await f.store();
    await putHours(s, [
      { day_of_week: THU, open_minute: 9 * 60, close_minute: 14 * 60 },
    ]).expect(200);
    const now = Date.now();
    const closure = (
      await createClosure(
        s,
        new Date(now + 48 * 3_600_000),
        new Date(now + 50 * 3_600_000),
      ).expect(201)
    ).body.id as string;
    const emp = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      s.branchA,
    );
    const auth = f.bearer(emp.token);
    const read = await f.http().get(hoursUrl(s)).set(auth).expect(200);
    expect(read.body.hours).toHaveLength(1);
    expect(read.body.opening).toHaveProperty('open_now');
    await f.http().get(closuresUrl(s)).set(auth).expect(200);

    const writes: (() => Promise<{ status: number }>)[] = [
      () => f.http().put(hoursUrl(s)).set(auth).send({ hours: [] }),
      () =>
        f
          .http()
          .post(closuresUrl(s))
          .set(auth)
          .set('Idempotency-Key', f.unique('closure'))
          .send({
            starts_at: new Date(now + 96 * 3_600_000).toISOString(),
            ends_at: new Date(now + 98 * 3_600_000).toISOString(),
          }),
      () =>
        f
          .http()
          .post(`${closuresUrl(s)}/${closure}/cancel`)
          .set(auth)
          .send({ reason: 'x' }),
      () =>
        f
          .http()
          .post(`${closuresUrl(s)}/${closure}/shorten`)
          .set(auth)
          .send({
            ends_at: new Date(now + 49 * 3_600_000).toISOString(),
            reason: 'x',
          }),
    ];
    for (const w of writes) expect((await w()).status).toBe(403);
    // and nothing changed
    expect(
      await prisma.branchOperatingHours.count({
        where: { branchId: s.branchA },
      }),
    ).toBe(1);
    expect(
      await prisma.branchClosure.findUnique({ where: { id: closure } }),
    ).not.toBeNull();
  });
});
