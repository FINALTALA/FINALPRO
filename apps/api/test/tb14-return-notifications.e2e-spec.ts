import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { Prisma } from '../generated/prisma/client';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxEventService } from './../src/outbox/outbox-event.service';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { ReturnSweepService } from './../src/returns/return-sweep.service';
import { sweepUntil } from './helpers/sweep-until';

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SECRET_NOTE = 'TB14 secret customer note';
const SECRET_REJECTION = 'TB14 secret rejection explanation';

// TB-14: every return.* event the returns code enqueues becomes a
// notification - the store's (request, 48h reminder), the customer's
// (decisions and outcomes on their own return) and the platform's: one
// RETURN_ESCALATION_ALERT per escalation (72h without a store decision,
// or a customer dispute) to the RETURN_ESCALATION subscribers who are
// still active administrators. Each carries the return id and nothing
// else - the escalation alert also a fixed reason code. Platform alerts
// disappear from an account that is no longer an active administrator.
describe('TB-14 return notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let relay: OutboxRelayService;
  let outbox: OutboxEventService;
  let sweep: ReturnSweepService;

  beforeAll(async () => {
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
    relay = app.get(OutboxRelayService);
    outbox = app.get(OutboxEventService);
    sweep = app.get(ReturnSweepService);
  });

  afterAll(async () => {
    await prisma.platformAlertRecipient.deleteMany({
      where: { userId: { in: subscribed } },
    });
    await app.close();
  });

  const subscribed: string[] = [];
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function account(platformRole?: 'PLATFORM_ADMIN') {
    const phone = `+97059${String((Date.now() + (counter += 1) * 7919) % 1e7).padStart(7, '0')}`;
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'x',
        phoneVerifiedAt: new Date(),
        platformRole: platformRole ?? null,
      },
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

  /** A subscribed RETURN_ESCALATION recipient (active administrator). */
  async function subscribedAdmin() {
    const a = await account('PLATFORM_ADMIN');
    await prisma.platformAlertRecipient.create({
      data: { userId: a.userId, category: 'RETURN_ESCALATION' },
    });
    subscribed.push(a.userId);
    return a;
  }

  /** A store with two branches: its owner, an employee of branch A, a
   * suspended employee of branch A, and an employee of branch B. */
  async function store() {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('tb14-store').toLowerCase(),
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
    const branch = (name: string) =>
      prisma.storeBranch.create({
        data: {
          vendorId: vendor.id,
          name: unique(name),
          isPhysical: true,
          verificationStatus: 'APPROVED',
        },
      });
    const a = await branch('A');
    const b = await branch('B');
    const member = async (
      role: 'OWNER' | 'BRANCH_EMPLOYEE',
      branchId: string | null,
      status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
    ) => {
      const acc = await account();
      await prisma.vendorUser.create({
        data: {
          userId: acc.userId,
          vendorId: vendor.id,
          role,
          branchId,
          status,
        },
      });
      return acc;
    };
    return {
      vendorId: vendor.id,
      branchId: a.id,
      otherBranchId: b.id,
      owner: await member('OWNER', null),
      employee: await member('BRANCH_EMPLOYEE', a.id),
      suspended: await member('BRANCH_EMPLOYEE', a.id, 'SUSPENDED'),
      otherBranchEmployee: await member('BRANCH_EMPLOYEE', b.id),
    };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  /** A collected COD pickup bought yesterday from branch A under a
   * 14-day refund policy - eligible for a return. */
  async function purchase(s: Store, customer: Account) {
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendorId,
        titleAr: unique('قطعة'),
        titleEn: 'Item',
        status: 'ACTIVE',
      },
    });
    const variant = await prisma.offerVariant.create({
      data: {
        vendorId: s.vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 50,
      },
    });
    const customerOrder = await prisma.customerOrder.create({
      data: { customerId: customer.customerId },
    });
    const order = await prisma.branchOrder.create({
      data: {
        customerOrderId: customerOrder.id,
        vendorId: s.vendorId,
        branchId: s.branchId,
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'COD',
        status: 'COMPLETED',
        subtotal: 50,
        total: 50,
        pickupCode: String(100000 + (counter += 1)),
        pickedUpAt: hoursAgo(24),
        codCollectedAt: hoursAgo(24),
        returnPolicySnapshotEnabled: true,
        returnPolicySnapshotMode: 'REFUND_ONLY',
        returnPolicySnapshotWindowDays: 14,
        returnPolicySnapshotFeeIls: 0,
      },
    });
    const item = await prisma.branchOrderItem.create({
      data: {
        vendorId: s.vendorId,
        branchOrderId: order.id,
        offerVariantId: variant.id,
        quantity: 1,
        unitPrice: 50,
      },
    });
    return { orderId: order.id, itemId: item.id };
  }

  async function requestReturn(
    customer: Account,
    p: { orderId: string; itemId: string },
  ) {
    const res = await http()
      .post(
        `/api/v1/customers/me/orders/${p.orderId}/items/${p.itemId}/returns`,
      )
      .set(auth(customer.token))
      .set('Idempotency-Key', unique('tb14-submit'))
      .send({ reason: 'DAMAGED', reason_note: SECRET_NOTE })
      .expect(201);
    return res.body.id as string;
  }

  const decide = (
    s: Store,
    returnId: string,
    body: { decision: 'approve' | 'reject'; rejection_reason?: string },
  ) =>
    http()
      .patch(
        `/api/v1/vendors/${s.vendorId}/branches/${s.branchId}/returns/${returnId}/decision`,
      )
      .set(auth(s.owner.token))
      .set('Idempotency-Key', unique('tb14-decide'))
      .send(body);

  const dispute = (customer: Account, returnId: string) =>
    http()
      .post(`/api/v1/customers/me/returns/${returnId}/dispute`)
      .set(auth(customer.token))
      .set('Idempotency-Key', unique('tb14-dispute'))
      .send({});

  /** Runs the relay until the whole backlog (every file's) is drained. */
  async function drain() {
    while (await relay.dispatchOnce()) {
      /* drain */
    }
  }

  /** Drains until none of the matching outbox rows is still due or in
   * flight. In a parallel run every file's app has its own relay timer,
   * and a row another relay holds is SKIP LOCKED here - an empty drain
   * alone does not mean that row's notification has been committed. */
  async function settle(where: Prisma.OutboxEventWhereInput) {
    for (let i = 0; i < 100; i++) {
      await drain();
      const open = await prisma.outboxEvent.count({
        where: {
          AND: [
            where,
            {
              OR: [
                { status: { in: ['PENDING', 'PROCESSING'] } },
                { status: 'FAILED', availableAt: { lte: new Date() } },
              ],
            },
          ],
        },
      });
      if (open === 0) return;
      await sleep(100);
    }
    throw new Error('outbox rows still in flight after 10 s');
  }
  const ofReturn = (returnId: string): Prisma.OutboxEventWhereInput => ({
    payload: { path: ['return_id'], equals: returnId },
  });

  /** This return's notifications, once its outbox rows are dispatched. */
  async function notificationsFor(returnId: string) {
    await settle(ofReturn(returnId));
    return prisma.notification.findMany({
      where: { targetType: 'RETURN', targetId: returnId },
      orderBy: { createdAt: 'asc' },
    });
  }
  const recipientsOf = (
    rows: { type: string; recipientUserId: string }[],
    type: string,
  ) =>
    rows
      .filter((n) => n.type === type)
      .map((n) => n.recipientUserId)
      .sort();

  /** The return's outbox rows: everything an event could carry. */
  const outboxRowsFor = (returnId: string) =>
    prisma.outboxEvent.findMany({
      where: { payload: { path: ['return_id'], equals: returnId } },
    });

  function expectNoPersonalData(rows: unknown[], phones: string[]) {
    const text = JSON.stringify(rows);
    expect(text).not.toContain(SECRET_NOTE);
    expect(text).not.toContain(SECRET_REJECTION);
    for (const phone of phones) expect(text).not.toContain(phone);
  }

  it('request -> store, approval -> customer, receipt + refund -> customer: one notification each, the return id only, to exactly the right people', async () => {
    const s = await store();
    const customer = await account();
    const p = await purchase(s, customer);
    const returnId = await requestReturn(customer, p);

    let rows = await notificationsFor(returnId);
    expect(recipientsOf(rows, 'RETURN_REQUESTED')).toEqual(
      [s.owner.userId, s.employee.userId].sort(),
    );
    for (const n of rows) {
      expect(n).toMatchObject({
        targetType: 'RETURN',
        targetId: returnId,
        vendorId: s.vendorId,
        branchId: s.branchId,
        data: {},
      });
    }

    await decide(s, returnId, { decision: 'approve' }).expect(200);
    rows = await notificationsFor(returnId);
    const approved = rows.filter((n) => n.type === 'RETURN_APPROVED');
    expect(approved.map((n) => n.recipientUserId)).toEqual([customer.userId]);
    expect(approved[0]).toMatchObject({
      data: {},
      vendorId: null,
      branchId: null,
    });

    const r = await prisma.return.findUniqueOrThrow({
      where: { id: returnId },
    });
    await http()
      .post(`/api/v1/vendors/${s.vendorId}/returns/redeem`)
      .set(auth(s.employee.token))
      .set('Idempotency-Key', unique('tb14-redeem'))
      .send({
        code: r.code,
        receiving_branch_id: s.branchId,
        item_condition: 'RESELLABLE',
      })
      .expect(201);
    rows = await notificationsFor(returnId);
    expect(recipientsOf(rows, 'RETURN_REFUNDED')).toEqual([customer.userId]);
    expect(rows.find((n) => n.type === 'RETURN_REFUNDED')!.data).toEqual({});

    // Nobody else ever heard about this return; no platform alert.
    expect(new Set(rows.map((n) => n.recipientUserId))).toEqual(
      new Set([s.owner.userId, s.employee.userId, customer.userId]),
    );
    expect(rows.some((n) => n.type === 'RETURN_ESCALATION_ALERT')).toBe(false);
    expectNoPersonalData(
      [rows, await outboxRowsFor(returnId)],
      [customer.phone],
    );
  });

  it("rejection -> customer; the customer's dispute alerts the subscribed active administrators (CUSTOMER_DISPUTE) and nobody else; the admin's final rejection -> customer", async () => {
    const admin = await subscribedAdmin();
    const unsubscribed = await account('PLATFORM_ADMIN');
    const deactivated = await subscribedAdmin();
    await prisma.user.update({
      where: { id: deactivated.userId },
      data: { deactivatedAt: new Date() },
    });
    const revoked = await subscribedAdmin();
    await prisma.user.update({
      where: { id: revoked.userId },
      data: { platformRole: null },
    });
    const s = await store();
    const customer = await account();
    const returnId = await requestReturn(customer, await purchase(s, customer));

    await decide(s, returnId, {
      decision: 'reject',
      rejection_reason: SECRET_REJECTION,
    }).expect(200);
    let rows = await notificationsFor(returnId);
    expect(recipientsOf(rows, 'RETURN_REJECTED')).toEqual([customer.userId]);

    await dispute(customer, returnId).expect(201);
    rows = await notificationsFor(returnId);
    const alerts = rows.filter((n) => n.type === 'RETURN_ESCALATION_ALERT');
    const alerted = alerts.map((n) => n.recipientUserId);
    expect(alerted).toContain(admin.userId);
    for (const id of [
      unsubscribed,
      deactivated,
      revoked,
      customer,
      s.owner,
      s.employee,
    ]) {
      expect(alerted).not.toContain(id.userId);
    }
    // Every recipient is a subscribed, active administrator, once.
    const activeSubscribers = await prisma.platformAlertRecipient.findMany({
      where: {
        category: 'RETURN_ESCALATION',
        user: { platformRole: 'PLATFORM_ADMIN', deactivatedAt: null },
      },
      select: { userId: true },
    });
    expect(activeSubscribers.map((r) => r.userId)).toEqual(
      expect.arrayContaining(alerted),
    );
    expect(new Set(alerted).size).toBe(alerted.length);
    for (const a of alerts) {
      expect(a).toMatchObject({
        targetId: returnId,
        data: { reason: 'CUSTOMER_DISPUTE' },
        vendorId: null,
        branchId: null,
      });
    }
    // The customer filed the dispute themselves - nothing new for them.
    expect(recipientsOf(rows, 'RETURN_ESCALATED')).toEqual([]);

    await http()
      .patch(`/api/v1/admin/returns/${returnId}/escalation-decision`)
      .set(auth(admin.token))
      .set('Idempotency-Key', unique('tb14-admin'))
      .send({ decision: 'reject', rejection_reason: SECRET_REJECTION })
      .expect(200);
    rows = await notificationsFor(returnId);
    expect(recipientsOf(rows, 'RETURN_ADMIN_REJECTED')).toEqual([
      customer.userId,
    ]);
    expectNoPersonalData(
      [rows, await outboxRowsFor(returnId)],
      [customer.phone, admin.phone],
    );
  });

  it('the sweep: a 48h reminder to the branch; 72h without a decision escalates once (SLA_TIMEOUT to the subscribers, RETURN_ESCALATED to the customer), even when two sweeps race', async () => {
    const admin = await subscribedAdmin();
    const s = await store();
    const customer = await account();
    const late = await requestReturn(customer, await purchase(s, customer));
    const reminded = await requestReturn(customer, await purchase(s, customer));
    await prisma.return.update({
      where: { id: late },
      data: { createdAt: hoursAgo(73) },
    });
    await prisma.return.update({
      where: { id: reminded },
      data: { vendorReviewDueAt: hoursAgo(1), createdAt: hoursAgo(49) },
    });

    await Promise.all([sweep.sweepOnce(), sweep.sweepOnce()]);
    await sweepUntil(
      () => sweep.sweepOnce(),
      async () =>
        (await prisma.return.findUniqueOrThrow({ where: { id: late } }))
          .status === 'ESCALATED' &&
        (await prisma.return.findUniqueOrThrow({ where: { id: reminded } }))
          .vendorReminderSentAt !== null,
    );

    const reminder = await notificationsFor(reminded);
    expect(recipientsOf(reminder, 'RETURN_VENDOR_REMINDER')).toEqual(
      [s.owner.userId, s.employee.userId].sort(),
    );
    expect(
      reminder.find((n) => n.type === 'RETURN_VENDOR_REMINDER'),
    ).toMatchObject({
      vendorId: s.vendorId,
      branchId: s.branchId,
      data: {},
    });

    const rows = await notificationsFor(late);
    expect(
      (await prisma.return.findUniqueOrThrow({ where: { id: late } })).status,
    ).toBe('ESCALATED');
    const alerts = rows.filter((n) => n.type === 'RETURN_ESCALATION_ALERT');
    const alerted = alerts.map((n) => n.recipientUserId);
    expect(alerted).toContain(admin.userId);
    expect(new Set(alerted).size).toBe(alerted.length);
    for (const a of alerts) expect(a.data).toEqual({ reason: 'SLA_TIMEOUT' });
    expect(recipientsOf(rows, 'RETURN_ESCALATED')).toEqual([customer.userId]);
    expect(
      await prisma.auditLog.count({
        where: { entityId: late, action: 'return.auto_escalated' },
      }),
    ).toBe(1);
    // One outbox row per recipient - no duplicates from the race.
    const alertRows = (await outboxRowsFor(late)).filter(
      (e) => e.eventType === 'return.escalation_alert',
    );
    expect(alertRows).toHaveLength(alerts.length);
    expectNoPersonalData([rows, alertRows], [customer.phone, admin.phone]);
  });

  it('an expired drop-off code -> customer (RETURN_CODE_EXPIRED)', async () => {
    const s = await store();
    const customer = await account();
    const returnId = await requestReturn(customer, await purchase(s, customer));
    await decide(s, returnId, { decision: 'approve' }).expect(200);
    await prisma.return.update({
      where: { id: returnId },
      data: { codeExpiresAt: hoursAgo(1) },
    });
    await sweepUntil(
      () => sweep.sweepOnce(),
      async () =>
        (await prisma.return.findUniqueOrThrow({ where: { id: returnId } }))
          .status === 'EXPIRED',
    );
    const rows = await notificationsFor(returnId);
    expect(recipientsOf(rows, 'RETURN_CODE_EXPIRED')).toEqual([
      customer.userId,
    ]);
  });

  it("the relay maps all ten return events, whitelists their data (the escalation reason only, and only a known one) and keeps the store link only on the branch's", async () => {
    const recipient = await account();
    const returnId = (
      await prisma.$queryRaw<
        { id: string }[]
      >`SELECT gen_random_uuid()::text AS id`
    )[0].id;
    const extras = {
      reason_note: SECRET_NOTE,
      rejection_reason: SECRET_REJECTION,
      amount: 50,
      phone: recipient.phone,
    };
    const cases: [
      string,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ][] = [
      [
        'return.requested',
        'RETURN_REQUESTED',
        { vendor_id: 'v1', branch_id: 'b1' },
        {},
      ],
      [
        'return.vendor_reminder',
        'RETURN_VENDOR_REMINDER',
        { vendor_id: 'v1', branch_id: 'b1' },
        {},
      ],
      ['return.approved', 'RETURN_APPROVED', {}, {}],
      ['return.rejected', 'RETURN_REJECTED', {}, {}],
      ['return.admin_rejected', 'RETURN_ADMIN_REJECTED', {}, {}],
      ['return.escalated', 'RETURN_ESCALATED', {}, {}],
      ['return.refunded', 'RETURN_REFUNDED', {}, {}],
      ['return.exchanged', 'RETURN_EXCHANGED', {}, {}],
      ['return.code_expired', 'RETURN_CODE_EXPIRED', {}, {}],
      [
        'return.escalation_alert',
        'RETURN_ESCALATION_ALERT',
        { reason: 'SLA_TIMEOUT' },
        { reason: 'SLA_TIMEOUT' },
      ],
      [
        'return.escalation_alert',
        'RETURN_ESCALATION_ALERT',
        { reason: 'something else' },
        {},
      ],
    ];
    const ids: string[] = [];
    for (const [eventType, type, payload] of cases) {
      const row = await prisma.$transaction((tx) =>
        outbox.enqueue(
          {
            eventType,
            audience:
              type === 'RETURN_ESCALATION_ALERT'
                ? 'PLATFORM'
                : payload.vendor_id
                  ? 'STORE'
                  : 'CUSTOMER',
            payload: {
              ...extras,
              ...payload,
              return_id: returnId,
              recipient_user_id: recipient.userId,
            },
          },
          tx,
        ),
      );
      ids.push((row as { id: string }).id);
    }
    await settle({ id: { in: ids } });
    const events = await prisma.outboxEvent.findMany({
      where: { id: { in: ids } },
    });
    expect(events.every((e) => e.status === 'PUBLISHED')).toBe(true);
    for (const [i, [, type, payload, data]] of cases.entries()) {
      const n = await prisma.notification.findUniqueOrThrow({
        where: {
          outboxEventId_recipientUserId: {
            outboxEventId: ids[i],
            recipientUserId: recipient.userId,
          },
        },
      });
      expect(n).toMatchObject({
        type,
        targetType: 'RETURN',
        targetId: returnId,
        data,
        vendorId: (payload.vendor_id as string) ?? null,
        branchId: (payload.branch_id as string) ?? null,
      });
    }
    const all = await prisma.notification.findMany({
      where: { outboxEventId: { in: ids } },
    });
    expectNoPersonalData(all, [recipient.phone]);
  });

  it('retries never duplicate: a published row run again adds nothing; a dead-lettered return row is never picked up; an unknown type still fails', async () => {
    const recipient = await account();
    const enqueue = (eventType: string) =>
      prisma.$transaction((tx) =>
        outbox.enqueue(
          {
            eventType,
            audience: 'CUSTOMER',
            payload: {
              return_id: unique('r'),
              recipient_user_id: recipient.userId,
            },
          },
          tx,
        ),
      ) as Promise<{ id: string }>;

    const published = await enqueue('return.approved');
    await settle({ id: published.id });
    // A crash after the notification committed but before PUBLISHED.
    await prisma.outboxEvent.update({
      where: { id: published.id },
      data: { status: 'FAILED', availableAt: new Date(0), publishedAt: null },
    });
    await settle({ id: published.id });
    expect(
      (
        await prisma.outboxEvent.findUniqueOrThrow({
          where: { id: published.id },
        })
      ).status,
    ).toBe('PUBLISHED');
    expect(
      await prisma.notification.count({
        where: { outboxEventId: published.id },
      }),
    ).toBe(1);

    // Written straight as DEAD_LETTER (an old row from before TB-14),
    // so the app's own relay timer cannot pick it up first.
    const dead = await prisma.outboxEvent.create({
      data: {
        eventType: 'return.approved',
        payload: {
          return_id: unique('r'),
          recipient_user_id: recipient.userId,
        },
        status: 'DEAD_LETTER',
        attemptCount: 5,
        lastError: 'OutboxRelayService: unknown eventType "return.approved"',
      },
    });
    const unknown = await enqueue('return.not_a_real_event');
    await settle({ id: { in: [dead.id, unknown.id] } });
    expect(
      (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: dead.id } }))
        .status,
    ).toBe('DEAD_LETTER');
    expect(
      await prisma.notification.count({ where: { outboxEventId: dead.id } }),
    ).toBe(0);
    const failed = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: unknown.id },
    });
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError).toContain('unknown eventType');
  });

  it('platform alerts (return escalation and order integrity) are shown and counted only in the platform inbox, only while the account is an active PLATFORM_ADMIN - never in the shopping bell (TB-26)', async () => {
    const admin = await account('PLATFORM_ADMIN');
    const make = async (
      eventType: string,
      type:
        'RETURN_ESCALATION_ALERT' | 'ORDER_INTEGRITY_ALERT' | 'RETURN_APPROVED',
    ) => {
      const e = await prisma.outboxEvent.create({
        data: { eventType, payload: {}, status: 'PUBLISHED' },
      });
      return prisma.notification.create({
        data: {
          outboxEventId: e.id,
          recipientUserId: admin.userId,
          type,
          targetType:
            type === 'ORDER_INTEGRITY_ALERT' ? 'BRANCH_ORDER' : 'RETURN',
          targetId: unique('t'),
          data: {},
          audience: type === 'RETURN_APPROVED' ? 'CUSTOMER' : 'PLATFORM',
        },
      });
    };
    const returnAlert = await make(
      'return.escalation_alert',
      'RETURN_ESCALATION_ALERT',
    );
    const integrityAlert = await make(
      'branch_order.integrity_flagged',
      'ORDER_INTEGRITY_ALERT',
    );
    const own = await make('return.approved', 'RETURN_APPROVED');

    const view = async (base: string) => {
      const list = await http().get(base).set(auth(admin.token)).expect(200);
      const count = await http()
        .get(`${base}/unread-count`)
        .set(auth(admin.token))
        .expect(200);
      return {
        ids: (list.body.items as { id: string }[]).map((n) => n.id).sort(),
        unread: count.body.unread_count as number,
      };
    };
    const bell = () => view('/api/v1/me/notifications');
    const inbox = () => view('/api/v1/admin/notifications');
    const alerts = [returnAlert.id, integrityAlert.id].sort();

    // The shopping bell: the account's own notification only - always.
    expect(await bell()).toEqual({ ids: [own.id], unread: 1 });
    expect(await inbox()).toEqual({ ids: alerts, unread: 2 });
    await http()
      .post(`/api/v1/me/notifications/${returnAlert.id}/read`)
      .set(auth(admin.token))
      .expect(404);

    // Role revoked: the platform inbox is closed; the alerts cannot be
    // marked read; the bell is unchanged.
    await prisma.user.update({
      where: { id: admin.userId },
      data: { platformRole: null },
    });
    await http()
      .get('/api/v1/admin/notifications')
      .set(auth(admin.token))
      .expect(403);
    await http()
      .post(`/api/v1/admin/notifications/${returnAlert.id}/read`)
      .set(auth(admin.token))
      .expect(403);
    expect(await bell()).toEqual({ ids: [own.id], unread: 1 });
    await http()
      .post(`/api/v1/me/notifications/${own.id}/read`)
      .set(auth(admin.token))
      .expect(200);
    expect(
      (
        await prisma.notification.findUniqueOrThrow({
          where: { id: returnAlert.id },
        })
      ).readAt,
    ).toBeNull();

    // Role back but the account deactivated (the session stays valid
    // here because sessionVersion is untouched): still hidden.
    await prisma.user.update({
      where: { id: admin.userId },
      data: { platformRole: 'PLATFORM_ADMIN', deactivatedAt: new Date() },
    });
    expect(await inbox()).toEqual({ ids: [], unread: 0 });
    expect(await bell()).toEqual({ ids: [own.id], unread: 0 });

    // An active administrator again: they reappear, still unread - in
    // the platform inbox only.
    await prisma.user.update({
      where: { id: admin.userId },
      data: { deactivatedAt: null },
    });
    expect(await inbox()).toEqual({ ids: alerts, unread: 2 });
    expect(await bell()).toEqual({ ids: [own.id], unread: 0 });
  });

  it('the escalated-returns queue is for platform administrators only', async () => {
    const admin = await account('PLATFORM_ADMIN');
    const s = await store();
    const customer = await account();
    for (const who of [s.owner, s.employee, customer]) {
      await http()
        .get('/api/v1/admin/returns')
        .set(auth(who.token))
        .expect(403);
    }
    await http()
      .get('/api/v1/admin/returns')
      .set(auth(admin.token))
      .expect(200);
    await http().get('/api/v1/admin/returns').expect(401);
  });
});
