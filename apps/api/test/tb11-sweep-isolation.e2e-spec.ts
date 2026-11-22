import { execFileSync } from 'child_process';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuditLogService } from './../src/audit/audit-log.service';
import { SessionService } from './../src/auth/session.service';
import { ReservationSweepService } from './../src/checkout/reservation-sweep.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { SweepBackoff } from './../src/common/sweep-runner.util';
import { DiscountActivationSweepService } from './../src/offers/discount-activation-sweep.service';
import { FulfilmentExceptionSweepService } from './../src/orders/fulfilment-exception-sweep.service';
import { FulfilmentSweepService } from './../src/orders/fulfilment-sweep.service';
import { OutboxEventService } from './../src/outbox/outbox-event.service';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { ReturnSweepService } from './../src/returns/return-sweep.service';
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
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

// TB-11: the periodic sweeps are isolated from each other and from their
// own bad items - one item that fails (or is locked, or keeps failing)
// never stops the rest of its step, the steps after it, or a newer
// healthy item; two API instances sweeping at once never duplicate an
// outbox row, an audit row or a stock release; the relay drains a burst
// without one producer's backlog holding everyone else's back.
//
// Own database (as tb5-lock-order / tb8): deadlocks are counted per
// database and these tests count due items table-wide.
describe('TB-11 sweep isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let returns: ReturnSweepService;
  let exceptions: FulfilmentExceptionSweepService;
  let discounts: DiscountActivationSweepService;
  let relay: OutboxRelayService;
  const sharedUrl = process.env.DATABASE_URL!;
  const dbName = `finalpro_tb11sweep_test_${process.pid}`;

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
    returns = app.get(ReturnSweepService);
    exceptions = app.get(FulfilmentExceptionSweepService);
    discounts = app.get(DiscountActivationSweepService);
    relay = app.get(OutboxRelayService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    process.env.DATABASE_URL = sharedUrl;
    // TB-13: dropped only after its own marker is checked.
    await dropDisposableDatabase(sharedUrl, dbName);
  }, 120_000);

  // Each test starts with nothing due from an earlier one, and clean deferrals.
  beforeEach(async () => {
    await prisma.$executeRaw`UPDATE returns SET status = 'CANCELLED_BY_CUSTOMER' WHERE status IN ('REQUESTED', 'REJECTED', 'APPROVED_AWAITING_DROPOFF')`;
    await prisma.$executeRaw`UPDATE branch_orders SET status = 'COMPLETED' WHERE status IN ('PLACED', 'PREPARING', 'DELIVERED', 'DELIVERY_FAILED')`;
    await prisma.$executeRaw`UPDATE offer_variants SET "discountPercent" = NULL, "discountStartAt" = NULL, "discountEndAt" = NULL WHERE "discountPercent" IS NOT NULL`;
    for (const s of [returns, exceptions, discounts] as unknown as {
      backoff: Record<string, SweepBackoff> | SweepBackoff;
    }[]) {
      const b = s.backoff;
      if (b instanceof SweepBackoff) clearBackoff(b);
      else for (const x of Object.values(b)) clearBackoff(x);
    }
  });
  function clearBackoff(b: SweepBackoff) {
    for (const id of b.deferredIds(0)) b.recordSuccess(id);
    (b as unknown as { entries: Map<string, unknown> }).entries.clear();
  }

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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
    return { token, userId: user.id, customerId: profile.id, phone };
  }
  type Account = Awaited<ReturnType<typeof account>>;

  async function store() {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('tb11').toLowerCase(),
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

  async function variant(s: Store, quantity = 0) {
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

  /** A completed pickup item and a return on it, in the given state. */
  async function returnRow(
    s: Store,
    customer: Account,
    state: {
      status: 'REQUESTED' | 'REJECTED' | 'APPROVED_AWAITING_DROPOFF';
      createdAt?: Date;
      reminded?: boolean;
      due?: Date;
    },
  ) {
    const v = await variant(s);
    const co = await prisma.customerOrder.create({
      data: { customerId: customer.customerId },
    });
    const bo = await prisma.branchOrder.create({
      data: {
        customerOrderId: co.id,
        vendorId: s.vendorId,
        branchId: s.branchId,
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'COD',
        status: 'COMPLETED',
        subtotal: 20,
        total: 20,
        pickupCode: String(100000 + (counter += 1)),
      },
    });
    const item = await prisma.branchOrderItem.create({
      data: {
        vendorId: s.vendorId,
        branchOrderId: bo.id,
        offerVariantId: v.variantId,
        quantity: 1,
        unitPrice: 20,
      },
    });
    const r = await prisma.return.create({
      data: {
        vendorId: s.vendorId,
        branchOrderItemId: item.id,
        reason: 'DAMAGED',
        status: state.status,
        vendorReviewDueAt: hoursAgo(1),
        vendorReminderSentAt: state.reminded ? hoursAgo(1) : null,
        createdAt: state.createdAt ?? hoursAgo(80),
        ...(state.status === 'REJECTED'
          ? {
              rejectedAt: hoursAgo(100),
              disputeDeadlineAt: state.due ?? hoursAgo(1),
            }
          : {}),
        ...(state.status === 'APPROVED_AWAITING_DROPOFF'
          ? {
              code: String(200000 + counter),
              codeExpiresAt: state.due ?? hoursAgo(1),
            }
          : {}),
      },
    });
    return r.id;
  }

  /** Many REQUESTED returns at once (one item each), created at the given times. */
  async function bulkReturns(s: Store, customer: Account, createdAts: Date[]) {
    const v = await variant(s);
    const co = await prisma.customerOrder.create({
      data: { customerId: customer.customerId },
    });
    const bo = await prisma.branchOrder.create({
      data: {
        customerOrderId: co.id,
        vendorId: s.vendorId,
        branchId: s.branchId,
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'COD',
        status: 'COMPLETED',
        subtotal: 20,
        total: 20,
        pickupCode: String(100000 + (counter += 1)),
      },
    });
    const tag = Date.now().toString(16).slice(-6);
    const run = String(counter).padStart(4, '0').slice(-4);
    const itemIds = createdAts.map(
      (_, i) => `11111111-${run}-4000-8000-${tag}${String(i).padStart(6, '0')}`,
    );
    await prisma.branchOrderItem.createMany({
      data: itemIds.map((id) => ({
        id,
        vendorId: s.vendorId,
        branchOrderId: bo.id,
        offerVariantId: v.variantId,
        quantity: 1,
        unitPrice: 20,
      })),
    });
    const returnIds = itemIds.map((id) => id.replace(/^11111111/, '22222222'));
    await prisma.return.createMany({
      data: returnIds.map((id, i) => ({
        id,
        vendorId: s.vendorId,
        branchOrderItemId: itemIds[i],
        reason: 'DAMAGED' as const,
        status: 'REQUESTED' as const,
        vendorReviewDueAt: hoursAgo(1),
        vendorReminderSentAt: hoursAgo(1),
        createdAt: createdAts[i],
      })),
    });
    return returnIds;
  }

  /** A DELIVERY order whose slot started `slotHoursAgo` ago, still PLACED. */
  async function missedSlotOrder(
    s: Store,
    customer: Account,
    opts: { slotMissedAt?: Date; variantId?: string } = {},
  ) {
    const window = await prisma.deliveryWindow
      .create({
        data: {
          vendorId: s.vendorId,
          branchId: s.branchId,
          dayOfWeek: (counter += 1) % 7,
          startMinute: 0,
          endMinute: 1,
          capacity: 50,
        },
      })
      .catch(() => null);
    const w =
      window ??
      (await prisma.deliveryWindow.findFirstOrThrow({
        where: { vendorId: s.vendorId, branchId: s.branchId },
      }));
    const co = await prisma.customerOrder.create({
      data: { customerId: customer.customerId },
    });
    const bo = await prisma.branchOrder.create({
      data: {
        customerOrderId: co.id,
        vendorId: s.vendorId,
        branchId: s.branchId,
        fulfilmentMethod: 'DELIVERY',
        paymentMethod: 'COD',
        status: 'PLACED',
        subtotal: 20,
        total: 20,
        deliveryWindowId: w.id,
        scheduledDate: new Date(
          new Date().toISOString().slice(0, 10) + 'T00:00:00Z',
        ),
        createdAt: hoursAgo(30),
        slotMissedAt: opts.slotMissedAt ?? null,
      },
    });
    if (opts.variantId) {
      await prisma.branchOrderItem.create({
        data: {
          vendorId: s.vendorId,
          branchOrderId: bo.id,
          offerVariantId: opts.variantId,
          quantity: 1,
          unitPrice: 20,
        },
      });
    }
    return bo.id;
  }

  /** An active discount that started `minutesAgo` ago on a fresh variant. */
  async function activeDiscount(s: Store, minutesAgo = 5) {
    const v = await variant(s);
    const start = new Date(Date.now() - minutesAgo * 60_000);
    await prisma.offerVariant.update({
      where: { id: v.variantId },
      data: {
        discountPercent: 10,
        discountStartAt: start,
        discountEndAt: new Date(Date.now() + 86_400_000),
      },
    });
    return { variantId: v.variantId, start };
  }

  const auditCount = (action: string, entityIds: string[]) =>
    prisma.auditLog.count({ where: { action, entityId: { in: entityIds } } });
  const outboxFor = (eventType: string, key: string, ids: string[]) =>
    prisma.outboxEvent.count({
      where: {
        eventType,
        OR: ids.map((id) => ({ payload: { path: [key], equals: id } })),
      },
    });

  async function deadlocks(): Promise<number> {
    await sleep(1_500);
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT deadlocks AS n FROM pg_stat_database WHERE datname = current_database()`;
    return Number(rows[0].n);
  }

  function failFor(ids: Set<string>, action?: string) {
    const audit = app.get(AuditLogService);
    const original = audit.record.bind(audit);
    return jest.spyOn(audit, 'record').mockImplementation(async (input, tx) => {
      if (ids.has(input.entityId) && (!action || input.action === action)) {
        throw new Error('injected item failure');
      }
      return original(input, tx);
    });
  }
  function quiet(service: unknown) {
    const logger = (
      service as {
        logger: {
          error: (...a: unknown[]) => void;
          warn: (...a: unknown[]) => void;
          log: (...a: unknown[]) => void;
        };
      }
    ).logger;
    return {
      error: jest.spyOn(logger, 'error').mockImplementation(() => undefined),
      warn: jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
      log: jest.spyOn(logger, 'log').mockImplementation(() => undefined),
    };
  }

  it('returns: one failing item never stops its step or the steps after it; it is deferred, then completed later; nothing duplicated', async () => {
    const s = await store();
    const c = await account();
    const bad = await returnRow(s, c, { status: 'REQUESTED', reminded: true });
    const good = [
      await returnRow(s, c, { status: 'REQUESTED', reminded: true }),
      await returnRow(s, c, { status: 'REQUESTED', reminded: true }),
    ];
    const rejected = await returnRow(s, c, { status: 'REJECTED' });
    const approved = await returnRow(s, c, {
      status: 'APPROVED_AWAITING_DROPOFF',
    });

    const logs = quiet(returns);
    const spy = failFor(new Set([bad]), 'return.auto_escalated');
    try {
      const counts = await returns.sweepOnce();
      expect(counts).toMatchObject({
        autoEscalated: 2,
        disputeWindowsClosed: 1,
        codesExpired: 1,
      });
      const esc = returns.lastTick.find((t) => t.step === 'autoEscalation')!;
      expect(esc).toMatchObject({
        candidates: 3,
        done: 2,
        failed: 1,
        newFailures: 1,
      });
      expect(logs.error).toHaveBeenCalledTimes(1);
      expect(String(logs.error.mock.calls[0][0])).toContain(
        `item ${bad} failed (Error)`,
      );
      expect(String(logs.error.mock.calls[0][0])).not.toContain(c.phone);
      expect(logs.warn).toHaveBeenCalledTimes(1); // the tick summary
    } finally {
      spy.mockRestore();
    }
    expect(
      (await prisma.return.findUniqueOrThrow({ where: { id: bad } })).status,
    ).toBe('REQUESTED');
    expect(await auditCount('return.auto_escalated', [bad])).toBe(0);
    expect(
      (await prisma.return.findUniqueOrThrow({ where: { id: rejected } }))
        .status,
    ).toBe('REJECTED_CLOSED');
    expect(
      (await prisma.return.findUniqueOrThrow({ where: { id: approved } }))
        .status,
    ).toBe('EXPIRED');

    // Next tick: still deferred - left out of the query, no new log line.
    await returns.sweepOnce();
    expect(
      returns.lastTick.find((t) => t.step === 'autoEscalation'),
    ).toMatchObject({ candidates: 0, deferred: 1 });
    expect(logs.error).toHaveBeenCalledTimes(1);

    // Once its deferral runs out it is done, exactly once.
    clearBackoff(
      (returns as unknown as { backoff: Record<string, SweepBackoff> }).backoff
        .autoEscalation,
    );
    await returns.sweepOnce();
    expect(
      (await prisma.return.findUniqueOrThrow({ where: { id: bad } })).status,
    ).toBe('ESCALATED');
    expect(await auditCount('return.auto_escalated', [bad, ...good])).toBe(3);
    expect(
      await outboxFor('return.escalated', 'return_id', [bad, ...good]),
    ).toBe(3);
    for (const l of Object.values(logs)) l.mockRestore();
  });

  it('poison items beyond the batch: 205 always-failing returns older than a healthy one do not keep it out (tick 2 reaches it); at most 3 error lines', async () => {
    const s = await store();
    const c = await account();
    const poison = new Set(
      await bulkReturns(
        s,
        c,
        Array.from({ length: 205 }, (_, i) => hoursAgo(200 - i * 0.01)),
      ),
    );
    const healthy = await returnRow(s, c, {
      status: 'REQUESTED',
      reminded: true,
      createdAt: hoursAgo(80),
    });

    const logs = quiet(returns);
    const spy = failFor(poison, 'return.auto_escalated');
    try {
      await returns.sweepOnce();
      const t1 = returns.lastTick.find((t) => t.step === 'autoEscalation')!;
      expect(t1).toMatchObject({
        candidates: 200,
        done: 0,
        failed: 200,
        newFailures: 200,
      });
      expect(
        (await prisma.return.findUniqueOrThrow({ where: { id: healthy } }))
          .status,
      ).toBe('REQUESTED');
      expect(logs.error).toHaveBeenCalledTimes(3);

      await returns.sweepOnce();
      const t2 = returns.lastTick.find((t) => t.step === 'autoEscalation')!;
      expect(t2).toMatchObject({
        deferred: 200,
        candidates: 6,
        done: 1,
        failed: 5,
      });
      expect(
        (await prisma.return.findUniqueOrThrow({ where: { id: healthy } }))
          .status,
      ).toBe('ESCALATED');
      expect(logs.error).toHaveBeenCalledTimes(6);
    } finally {
      spy.mockRestore();
      for (const l of Object.values(logs)) l.mockRestore();
    }
    expect(await auditCount('return.auto_escalated', [...poison])).toBe(0);
  });

  it('discounts: 250 already-notified active discounts no longer keep a new one out - it is notified on the first tick, the old ones are not reopened', async () => {
    const s = await store();
    // 250 active discounts, each already notified (bulk, as earlier ticks left them).
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendorId,
        titleAr: unique('عرض'),
        titleEn: unique('Offer'),
        status: 'ACTIVE',
      },
    });
    const tag = Date.now().toString(16).slice(-6);
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `33333333-${tag.slice(0, 4)}-4000-8000-${tag}${String(i).padStart(6, '0')}`,
      start: new Date(Date.now() - (600 - i) * 60_000),
    }));
    await prisma.offerVariant.createMany({
      data: rows.map((r) => ({
        id: r.id,
        vendorId: s.vendorId,
        vendorOfferId: offer.id,
        sellerSku: `sku-${r.id}`,
        storeInventoryBarcode: `sib-${r.id}`,
        basePrice: 20,
        discountPercent: 10,
        discountStartAt: r.start,
        discountEndAt: new Date(Date.now() + 86_400_000),
      })),
    });
    await prisma.outboxEvent.createMany({
      data: rows.map((r) => ({
        id: r.id.replace(/^33333333/, '44444444'),
        eventType: 'offer.discount_activated_for_followers',
        payload: { vendor_id: s.vendorId, offer_variant_id: r.id },
        status: 'PUBLISHED' as const,
      })),
    });
    await prisma.discountActivationNotice.createMany({
      data: rows.map((r) => ({
        offerVariantId: r.id,
        discountStartAt: r.start,
        outboxEventId: r.id.replace(/^33333333/, '44444444'),
      })),
    });
    const fresh = await activeDiscount(s, 1);
    const before = await prisma.outboxEvent.count({
      where: { eventType: 'offer.discount_activated_for_followers' },
    });

    expect(await discounts.sweepOnce()).toBe(1);
    expect(discounts.lastTick[0]).toMatchObject({
      candidates: 1,
      done: 1,
      failed: 0,
    });
    expect(
      await prisma.discountActivationNotice.count({
        where: { offerVariantId: fresh.variantId },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: 'offer.discount_activated_for_followers' },
      }),
    ).toBe(before + 1);
    expect(await discounts.sweepOnce()).toBe(0);
    expect(discounts.lastTick[0].candidates).toBe(0);
  });

  it('locks: an order another path holds is skipped at once (SKIP LOCKED), the others are done; it is done on the next tick', async () => {
    const s = await store();
    const c = await account();
    const held = await missedSlotOrder(s, c);
    const free = await missedSlotOrder(s, c);
    const x = new Client({ connectionString: process.env.DATABASE_URL });
    await x.connect();
    try {
      await x.query('BEGIN');
      await x.query('SELECT id FROM branch_orders WHERE id = $1 FOR UPDATE', [
        held,
      ]);
      const t0 = Date.now();
      const r = await exceptions.sweepOnce();
      expect(Date.now() - t0).toBeLessThan(2_500);
      expect(r.slotMissedDetected).toBe(1);
      expect(exceptions.lastTick[1]).toMatchObject({
        step: 'slotMissed',
        done: 1,
        notDone: 1,
        failed: 0,
      });
    } finally {
      await x.query('ROLLBACK').catch(() => undefined);
      await x.end();
    }
    expect(
      (await prisma.branchOrder.findUniqueOrThrow({ where: { id: held } }))
        .slotMissedAt,
    ).toBeNull();
    expect((await exceptions.sweepOnce()).slotMissedDetected).toBe(1);
    expect(
      (await prisma.branchOrder.findUniqueOrThrow({ where: { id: held } }))
        .slotMissedAt,
    ).not.toBeNull();
    expect(
      (await prisma.branchOrder.findUniqueOrThrow({ where: { id: free } }))
        .slotMissedAt,
    ).not.toBeNull();
    expect(
      await outboxFor('branch_order.slot_missed', 'branch_order_id', [
        held,
        free,
      ]),
    ).toBe(2);
  });

  it('lock_timeout: an item whose write waits on another transaction gives up after 3 s, is not deferred, and is done on the next tick - exactly once', async () => {
    const s = await store();
    const d = await activeDiscount(s);
    const other = await activeDiscount(s);
    const x = new Client({ connectionString: process.env.DATABASE_URL });
    await x.connect();
    try {
      // Another transaction is inserting the very same notice (not committed yet).
      await x.query('BEGIN');
      const ev = await x.query(
        `INSERT INTO outbox_events (id, "eventType", payload, status, "availableAt", "createdAt") VALUES (gen_random_uuid()::text, 'test.tb11', '{}'::jsonb, 'DEAD_LETTER', now(), now()) RETURNING id`,
      );
      await x.query(
        // The exact stored discountStartAt (read in SQL - a JS Date through pg would shift by the local offset).
        `INSERT INTO discount_activation_notices (id, "offerVariantId", "discountStartAt", "outboxEventId")
         SELECT gen_random_uuid()::text, id, "discountStartAt", $2 FROM offer_variants WHERE id = $1`,
        [d.variantId, ev.rows[0].id],
      );
      const t0 = Date.now();
      await discounts.sweepOnce();
      const took = Date.now() - t0;
      expect(took).toBeGreaterThanOrEqual(2_500);
      expect(took).toBeLessThan(8_000);
      expect(discounts.lastTick[0]).toMatchObject({
        done: 1,
        lockTimeouts: 1,
        failed: 0,
      });
      expect(
        (discounts as unknown as { backoff: SweepBackoff }).backoff.size,
      ).toBe(0);
    } finally {
      await x.query('ROLLBACK').catch(() => undefined);
      await x.end();
    }
    expect(
      await prisma.discountActivationNotice.count({
        where: { offerVariantId: other.variantId },
      }),
    ).toBe(1);
    expect(await discounts.sweepOnce()).toBe(1);
    expect(
      await prisma.discountActivationNotice.count({
        where: { offerVariantId: d.variantId },
      }),
    ).toBe(1);
  });

  it('two API instances sweeping at once: every reminder, escalation, slot-missed notice and discount notice exactly once, no deadlock', async () => {
    const before = await deadlocks();
    const s = await store();
    const c = await account();
    const due: string[] = [];
    for (let i = 0; i < 12; i++)
      due.push(await returnRow(s, c, { status: 'REQUESTED' }));
    const orders: string[] = [];
    for (let i = 0; i < 6; i++) orders.push(await missedSlotOrder(s, c));
    const disc: string[] = [];
    for (let i = 0; i < 8; i++) disc.push((await activeDiscount(s)).variantId);

    const second = <T>(cls: new (...a: never[]) => T, deps: unknown[]) =>
      new (cls as unknown as new (...a: unknown[]) => T)(...deps);
    const returns2 = second(ReturnSweepService, [
      prisma,
      app.get(OutboxEventService),
      app.get(AuditLogService),
      (returns as unknown as { alertRecipients: unknown }).alertRecipients,
    ]);
    const exceptions2 = second(FulfilmentExceptionSweepService, [
      prisma,
      (exceptions as unknown as { cancellation: unknown }).cancellation,
      app.get(OutboxEventService),
    ]);
    const discounts2 = second(DiscountActivationSweepService, [
      prisma,
      app.get(OutboxEventService),
    ]);
    const fulfil = app.get(FulfilmentSweepService);
    const fulfil2 = second(FulfilmentSweepService, [
      prisma,
      (fulfil as unknown as { reconciliation: unknown }).reconciliation,
      (fulfil as unknown as { integrity: unknown }).integrity,
    ]);
    await Promise.all([
      returns.sweepOnce(),
      returns2.sweepOnce(),
      exceptions.sweepOnce(),
      exceptions2.sweepOnce(),
      discounts.sweepOnce(),
      discounts2.sweepOnce(),
      fulfil.sweepOnce(),
      fulfil2.sweepOnce(),
    ]);
    // Whatever one instance skipped as held, the next round finishes.
    await Promise.all([
      returns.sweepOnce(),
      returns2.sweepOnce(),
      exceptions.sweepOnce(),
      exceptions2.sweepOnce(),
      discounts.sweepOnce(),
      discounts2.sweepOnce(),
    ]);

    expect(await outboxFor('return.vendor_reminder', 'return_id', due)).toBe(
      12,
    );
    expect(await auditCount('return.auto_escalated', due)).toBe(12);
    expect(await outboxFor('return.escalated', 'return_id', due)).toBe(12);
    expect(
      await outboxFor('branch_order.slot_missed', 'branch_order_id', orders),
    ).toBe(6);
    expect(
      await prisma.discountActivationNotice.count({
        where: { offerVariantId: { in: disc } },
      }),
    ).toBe(8);
    expect(
      await outboxFor(
        'offer.discount_activated_for_followers',
        'offer_variant_id',
        disc,
      ),
    ).toBe(8);
    expect(await deadlocks()).toBe(before);
  });

  it('relay: one tick drains up to 20 rows within its budget, dispatchOnce() still exactly one; every event delivered once', async () => {
    const u = await account();
    const s = await store();
    // Settle whatever earlier tests left, so the counts below are ours.
    while ((await relay.dispatchTick(500, 20_000)) > 0) {
      /* drain */
    }
    const outbox = app.get(OutboxEventService);
    for (let i = 0; i < 30; i++) {
      await outbox.enqueue({
        eventType: 'vendor.suspended',
        audience: 'STORE',
        payload: {
          vendor_id: s.vendorId,
          recipient_user_id: u.userId,
          reason_code: 'OTHER',
        },
      });
    }
    expect(await relay.dispatchOnce()).toBe(true);
    expect(
      await prisma.notification.count({ where: { recipientUserId: u.userId } }),
    ).toBe(1);
    // 29 of ours are due: one tick takes exactly the 20-row maximum (a
    // generous budget here, so the count - not the machine - decides) ...
    expect(await relay.dispatchTick(undefined, 20_000)).toBe(20);
    // ... and a tick never starts a row once its time budget is spent.
    expect(await relay.dispatchTick(undefined, 0)).toBe(0);
    while ((await relay.dispatchTick()) > 0) {
      /* drain */
    }
    expect(
      await prisma.notification.count({ where: { recipientUserId: u.userId } }),
    ).toBe(30);
    expect(await relay.dispatchTick()).toBe(0);
  });

  it('every sweep at once with checkout, POS and the relay on the same stock: no 500, no deadlock, the counter and stock add up, nothing duplicated', async () => {
    const before = await deadlocks();
    const s = await store();
    const v = await variant(s, 200);
    await prisma.featureFlag.upsert({
      where: { key: 'reservation_sweep_enabled' },
      create: {
        key: 'reservation_sweep_enabled',
        enabled: true,
        description: 't',
      },
      update: { enabled: true },
    });
    const resSweep = app.get(ReservationSweepService);
    const statuses: number[] = [];
    let posSold = 0;
    const timeoutOrders: string[] = [];

    for (let round = 0; round < 3; round++) {
      const shoppers = [await account(), await account(), await account()];
      const holds = [];
      for (const a of shoppers) {
        const line = await http()
          .post('/api/v1/cart/items')
          .set(auth(a.token))
          .set('Idempotency-Key', unique('cart'))
          .send({
            vendor_id: s.vendorId,
            offer_variant_id: v.variantId,
            quantity: 1,
          })
          .expect(201);
        const r = await http()
          .post('/api/v1/checkout/reserve')
          .set(auth(a.token))
          .set('Idempotency-Key', unique('reserve'))
          .send({
            terms_accepted: true,
            terms_version: '2026-10-v1',
            groups: [
              {
                cart_item_ids: [line.body.id],
                branch_id: s.branchId,
                fulfilment_method: 'PICKUP',
                payment_method: 'COD',
              },
            ],
          })
          .expect(201);
        holds.push({ a, id: r.body.reservation_id as string });
      }
      await prisma.$executeRaw`UPDATE checkout_reservations SET "expiresAt" = now() - interval '5 minutes' WHERE id = ${holds[2].id}`;
      const c = await account();
      for (let i = 0; i < 3; i++)
        await returnRow(s, c, { status: 'REQUESTED' });
      timeoutOrders.push(
        await missedSlotOrder(s, c, {
          slotMissedAt: hoursAgo(49),
          variantId: v.variantId,
        }),
      );
      await missedSlotOrder(s, c);
      await activeDiscount(s);

      const results = await Promise.all([
        http()
          .post('/api/v1/checkout/confirm')
          .set(auth(holds[0].a.token))
          .set('Idempotency-Key', unique('confirm'))
          .send({ reservation_id: holds[0].id }),
        http()
          .post(`/api/v1/checkout/reservations/${holds[1].id}/cancel`)
          .set(auth(holds[1].a.token)),
        http()
          .post(
            `/api/v1/vendors/${s.vendorId}/branches/${s.branchId}/stock/${v.variantId}/movements`,
          )
          .set(auth(s.owner.token))
          .set('Idempotency-Key', unique('pos'))
          .send({ reason: 'SALE', quantity_delta: -1, reason_note: 'بيع' }),
        returns.sweepOnce(),
        exceptions.sweepOnce(),
        discounts.sweepOnce(),
        app.get(FulfilmentSweepService).sweepOnce(),
        resSweep.sweepOnce(),
        relay.dispatchTick(),
      ]);
      for (const r of results.slice(0, 3) as { status: number }[])
        statuses.push(r.status);
      posSold += 1;
      expect(
        returns.lastTick.every((t) => t.failed === 0 && !t.stepFailed),
      ).toBe(true);
      expect(
        exceptions.lastTick.every((t) => t.failed === 0 && !t.stepFailed),
      ).toBe(true);
    }
    expect(statuses.every((st) => st < 500)).toBe(true);
    // Stock: the counter is exactly the live checkout holds, never above the quantity.
    const stock = await prisma.branchStock.findUniqueOrThrow({
      where: { id: v.stockId },
    });
    const held = await prisma.checkoutReservationItem.aggregate({
      where: { offerVariantId: v.variantId },
      _sum: { quantity: true },
    });
    expect(stock.reservedQuantity).toBe(held._sum.quantity ?? 0);
    expect(stock.quantity).toBeGreaterThanOrEqual(stock.reservedQuantity);
    expect(posSold).toBe(3);
    // Every 48 h timeout order was resolved (no longer PLACED), each item cancelled at most once.
    for (const id of timeoutOrders) {
      expect(
        (await prisma.branchOrder.findUniqueOrThrow({ where: { id } })).status,
      ).not.toBe('PLACED');
    }
    const timeoutItems = (
      await prisma.branchOrderItem.findMany({
        where: { branchOrderId: { in: timeoutOrders } },
        select: { id: true },
      })
    ).map((i) => i.id);
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'branch_order_item.cancelled',
          entityId: { in: timeoutItems },
        },
      }),
    ).toBeLessThanOrEqual(timeoutItems.length);
    expect(await deadlocks()).toBe(before);
    await prisma.featureFlag.update({
      where: { key: 'reservation_sweep_enabled' },
      data: { enabled: false },
    });
  });
});
