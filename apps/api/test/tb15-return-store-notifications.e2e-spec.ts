import { execFileSync } from 'child_process';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { API_ROOT } from './helpers/seed-demo-db';
import {
  createDisposableDatabase,
  dropDisposableDatabase,
} from './helpers/test-databases';
import { uniqueTestPhone } from './helpers/test-phone';

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

const FLAG = 'return_store_notifications_enabled';
const SECRET_NOTE = 'TB15 secret customer note';
const SECRET_REJECTION = 'TB15 secret rejection explanation';
const CUSTOMER_NAME = 'TB15 Customer Fullname';
const STORE_TYPES = [
  'RETURN_PLATFORM_APPROVED',
  'RETURN_PLATFORM_REJECTED',
  'RETURN_CANCELLED_BY_CUSTOMER',
];
const STORE_EVENTS = [
  'return.platform_approved_for_store',
  'return.platform_rejected_for_store',
  'return.cancelled_for_store',
];

// TB-15: the store is told when the platform makes its final decision on
// an escalated return, and when the customer cancels a REQUESTED one -
// ONE outbox event per transition carrying only the return id; the relay
// picks the recipients when it sends (active owners + active employees of
// the order's branch, never the person who made the change). Behind
// return_store_notifications_enabled, which stops NEW events only.
//
// Own database: the flag is global, and switching it on in the shared
// test database would change what other files' returns produce. The
// relay timer is stopped so the test decides exactly when an event is
// sent (the send-time membership check depends on that).
describe('TB-15 store notifications for platform decisions and customer cancellations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let relay: OutboxRelayService;
  const sharedUrl = process.env.DATABASE_URL!;
  const dbName = `finalpro_tb15_test_${process.pid}`;

  beforeAll(async () => {
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
    relay = app.get(OutboxRelayService);
    relay.onModuleDestroy(); // stop the timer; this file dispatches itself
  });

  afterAll(async () => {
    await app.close();
    process.env.DATABASE_URL = sharedUrl;
    await dropDisposableDatabase(sharedUrl, dbName);
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const setFlag = (enabled: boolean) =>
    prisma.featureFlag.upsert({
      where: { key: FLAG },
      create: { key: FLAG, enabled, description: 'test' },
      update: { enabled },
    });
  async function drain() {
    while (await relay.dispatchOnce()) {
      /* drain */
    }
  }

  async function account(platformRole?: 'PLATFORM_ADMIN') {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'x',
        phoneVerifiedAt: new Date(),
        platformRole: platformRole ?? null,
      },
    });
    const profile = await prisma.customerProfile.create({
      data: { userId: user.id, displayName: CUSTOMER_NAME },
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

  /** A store with branches A and B: an owner, a second owner whose account
   * is deactivated, an employee of A, a suspended employee of A and an
   * employee of B. */
  async function store() {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('tb15-store').toLowerCase(),
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
      acc?: Account,
    ) => {
      const who = acc ?? (await account());
      await prisma.vendorUser.create({
        data: {
          userId: who.userId,
          vendorId: vendor.id,
          role,
          branchId,
          status,
        },
      });
      return who;
    };
    const deactivatedOwner = await member('OWNER', null);
    await prisma.user.update({
      where: { id: deactivatedOwner.userId },
      data: { deactivatedAt: new Date() },
    });
    return {
      vendorId: vendor.id,
      branchId: a.id,
      otherBranchId: b.id,
      owner: await member('OWNER', null),
      deactivatedOwner,
      employee: await member('BRANCH_EMPLOYEE', a.id),
      suspended: await member('BRANCH_EMPLOYEE', a.id, 'SUSPENDED'),
      otherBranchEmployee: await member('BRANCH_EMPLOYEE', b.id),
      member,
    };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  /** A collected pickup from branch A, bought yesterday, returnable. For
   * an EXCHANGE: a replacement variant with stock in branch A. */
  async function purchase(s: Store, customer: Account, exchange = false) {
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendorId,
        titleAr: unique('قطعة'),
        titleEn: 'Item',
        status: 'ACTIVE',
      },
    });
    const variant = (size: string) =>
      prisma.offerVariant.create({
        data: {
          vendorId: s.vendorId,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          storeInventoryBarcode: unique('sib'),
          basePrice: 50,
          size,
        },
      });
    const original = await variant('M');
    const replacement = exchange ? await variant('L') : null;
    if (replacement) {
      await prisma.branchStock.create({
        data: {
          vendorId: s.vendorId,
          branchId: s.branchId,
          offerVariantId: replacement.id,
          quantity: 5,
        },
      });
    }
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
        returnPolicySnapshotMode: exchange ? 'BOTH' : 'REFUND_ONLY',
        returnPolicySnapshotWindowDays: 14,
        returnPolicySnapshotFeeIls: 0,
        returnPolicySnapshotExchangeFeeIls: exchange ? 0 : null,
      },
    });
    const item = await prisma.branchOrderItem.create({
      data: {
        vendorId: s.vendorId,
        branchOrderId: order.id,
        offerVariantId: original.id,
        quantity: 1,
        unitPrice: 50,
      },
    });
    return {
      orderId: order.id,
      itemId: item.id,
      replacementId: replacement?.id,
    };
  }

  async function requestReturn(
    s: Store,
    customer: Account,
    exchange = false,
  ): Promise<string> {
    const p = await purchase(s, customer, exchange);
    const res = await http()
      .post(
        `/api/v1/customers/me/orders/${p.orderId}/items/${p.itemId}/returns`,
      )
      .set(auth(customer.token))
      .set('Idempotency-Key', unique('tb15-submit'))
      .send({
        reason: 'DAMAGED',
        reason_note: SECRET_NOTE,
        ...(exchange
          ? {
              desired_outcome: 'EXCHANGE',
              replacement_offer_variant_id: p.replacementId,
              replacement_branch_id: s.branchId,
            }
          : {}),
      })
      .expect(201);
    return res.body.id as string;
  }

  /** Escalated the SLA way (72h without a store decision). */
  const escalate = (returnId: string) =>
    prisma.return.update({
      where: { id: returnId },
      data: { status: 'ESCALATED', escalatedAt: new Date() },
    });

  /** Rejected by the store, then disputed by the customer. */
  async function rejectAndDispute(
    s: Store,
    customer: Account,
    returnId: string,
  ) {
    await http()
      .patch(
        `/api/v1/vendors/${s.vendorId}/branches/${s.branchId}/returns/${returnId}/decision`,
      )
      .set(auth(s.owner.token))
      .set('Idempotency-Key', unique('tb15-decide'))
      .send({ decision: 'reject', rejection_reason: SECRET_REJECTION })
      .expect(200);
    await http()
      .post(`/api/v1/customers/me/returns/${returnId}/dispute`)
      .set(auth(customer.token))
      .set('Idempotency-Key', unique('tb15-dispute'))
      .send({})
      .expect(201);
  }

  const resolve = (
    admin: Account,
    returnId: string,
    decision: 'approve' | 'reject',
    key = unique('tb15-admin'),
  ) =>
    http()
      .patch(`/api/v1/admin/returns/${returnId}/escalation-decision`)
      .set(auth(admin.token))
      .set('Idempotency-Key', key)
      .send(
        decision === 'reject'
          ? { decision, rejection_reason: SECRET_REJECTION }
          : { decision },
      );

  const cancel = (customer: Account, returnId: string, key = unique('c')) =>
    http()
      .post(`/api/v1/customers/me/returns/${returnId}/cancel`)
      .set(auth(customer.token))
      .set('Idempotency-Key', key)
      .send({});

  const storeEvents = (returnId: string) =>
    prisma.outboxEvent.findMany({
      where: {
        eventType: { in: STORE_EVENTS },
        payload: { path: ['return_id'], equals: returnId },
      },
    });
  const notes = (returnId: string) =>
    prisma.notification.findMany({
      where: { targetType: 'RETURN', targetId: returnId },
    });
  const to = (rows: { type: string; recipientUserId: string }[], t: string) =>
    rows
      .filter((n) => n.type === t)
      .map((n) => n.recipientUserId)
      .sort();
  const ids = (...a: Account[]) => a.map((x) => x.userId).sort();

  function expectNoPrivateData(rows: unknown[], customer: Account) {
    const text = JSON.stringify(rows);
    for (const secret of [
      SECRET_NOTE,
      SECRET_REJECTION,
      CUSTOMER_NAME,
      customer.phone,
      customer.userId,
      customer.customerId,
    ]) {
      expect(text).not.toContain(secret);
    }
  }

  it('flag off (the default): no store event for a cancellation or a platform decision; the customer side is unchanged; the approval now records who resolved it and when', async () => {
    await setFlag(false);
    const s = await store();
    const customer = await account();
    const admin = await account('PLATFORM_ADMIN');

    const cancelled = await requestReturn(s, customer);
    await cancel(customer, cancelled).expect(201);
    const approved = await requestReturn(s, customer);
    await escalate(approved);
    await resolve(admin, approved, 'approve').expect(200);
    await drain();

    expect(await storeEvents(cancelled)).toHaveLength(0);
    expect(await storeEvents(approved)).toHaveLength(0);
    const rows = await notes(approved);
    expect(to(rows, 'RETURN_APPROVED')).toEqual([customer.userId]);
    expect(rows.filter((n) => STORE_TYPES.includes(n.type))).toHaveLength(0);
    const r = await prisma.return.findUniqueOrThrow({
      where: { id: approved },
    });
    expect(r.status).toBe('APPROVED_AWAITING_DROPOFF');
    expect(r.escalationResolvedByUserId).toBe(admin.userId);
    expect(r.escalationResolvedAt).toBeInstanceOf(Date);
  });

  it('platform approval after a dispute: ONE event with the return id only; the active owner and the branch-A employee are told (outcome RETURN) - nobody else, and no private data anywhere', async () => {
    await setFlag(true);
    const s = await store();
    const customer = await account();
    const admin = await account('PLATFORM_ADMIN');
    const returnId = await requestReturn(s, customer);
    await rejectAndDispute(s, customer, returnId);

    await resolve(admin, returnId, 'approve').expect(200);
    const events = await storeEvents(returnId);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('return.platform_approved_for_store');
    // TB-26: plus the audience the sender sets.
    expect(events[0].payload).toEqual({
      return_id: returnId,
      audience: 'STORE',
    });
    await drain();

    const rows = await notes(returnId);
    expect(to(rows, 'RETURN_PLATFORM_APPROVED')).toEqual(
      ids(s.owner, s.employee),
    );
    for (const n of rows.filter((x) => x.type === 'RETURN_PLATFORM_APPROVED')) {
      expect(n).toMatchObject({
        targetType: 'RETURN',
        targetId: returnId,
        vendorId: s.vendorId,
        branchId: s.branchId,
        data: { outcome: 'RETURN' },
        outboxEventId: events[0].id,
      });
    }
    // The customer side is unchanged.
    expect(to(rows, 'RETURN_APPROVED')).toEqual([customer.userId]);
    const r = await prisma.return.findUniqueOrThrow({
      where: { id: returnId },
    });
    expect(r.escalationResolvedByUserId).toBe(admin.userId);
    expect(r.escalationResolvedAt).toBeInstanceOf(Date);

    // TB-26: a STORE notification - the store workspace's inbox has it,
    // the owner's shopping bell never does.
    const ownerView = await http()
      .get(`/api/v1/vendors/${s.vendorId}/notifications`)
      .set(auth(s.owner.token))
      .expect(200);
    expect(
      ownerView.body.items.filter(
        (n: { type: string }) => n.type === 'RETURN_PLATFORM_APPROVED',
      ),
    ).toHaveLength(1);
    const ownerBell = await http()
      .get('/api/v1/me/notifications')
      .set(auth(s.owner.token))
      .expect(200);
    expect(
      ownerBell.body.items.filter(
        (n: { audience: string }) => n.audience !== 'CUSTOMER',
      ),
    ).toHaveLength(0);
    expectNoPrivateData(
      [
        await storeEvents(returnId),
        rows.filter((n) => STORE_TYPES.includes(n.type)),
        ownerView.body,
      ],
      customer,
    );
  });

  it('platform rejection after an SLA escalation: RETURN_PLATFORM_REJECTED with no data, the rejection text nowhere on the store side; the customer still gets RETURN_ADMIN_REJECTED', async () => {
    await setFlag(true);
    const s = await store();
    const customer = await account();
    const admin = await account('PLATFORM_ADMIN');
    const returnId = await requestReturn(s, customer);
    await escalate(returnId);

    await resolve(admin, returnId, 'reject').expect(200);
    const events = await storeEvents(returnId);
    expect(events.map((e) => e.eventType)).toEqual([
      'return.platform_rejected_for_store',
    ]);
    // TB-26: plus the audience the sender sets.
    expect(events[0].payload).toEqual({
      return_id: returnId,
      audience: 'STORE',
    });
    await drain();
    const rows = await notes(returnId);
    expect(to(rows, 'RETURN_PLATFORM_REJECTED')).toEqual(
      ids(s.owner, s.employee),
    );
    for (const n of rows.filter((x) => x.type === 'RETURN_PLATFORM_REJECTED')) {
      expect(n.data).toEqual({});
    }
    expect(to(rows, 'RETURN_ADMIN_REJECTED')).toEqual([customer.userId]);
    expectNoPrivateData(
      [events, rows.filter((n) => STORE_TYPES.includes(n.type))],
      customer,
    );
  });

  it('platform approval of an EXCHANGE: outcome EXCHANGE; a replacement that is no longer available answers 409 and writes no event', async () => {
    await setFlag(true);
    const s = await store();
    const customer = await account();
    const admin = await account('PLATFORM_ADMIN');
    const ok = await requestReturn(s, customer, true);
    await escalate(ok);
    await resolve(admin, ok, 'approve').expect(200);
    await drain();
    const rows = await notes(ok);
    expect(to(rows, 'RETURN_PLATFORM_APPROVED')).toEqual(
      ids(s.owner, s.employee),
    );
    expect(
      rows.find((n) => n.type === 'RETURN_PLATFORM_APPROVED')!.data,
    ).toEqual({ outcome: 'EXCHANGE' });

    const blocked = await requestReturn(s, customer, true);
    const r = await prisma.return.findUniqueOrThrow({ where: { id: blocked } });
    await prisma.branchStock.updateMany({
      where: { offerVariantId: r.replacementOfferVariantId! },
      data: { quantity: 0 },
    });
    await escalate(blocked);
    const res = await resolve(admin, blocked, 'approve').expect(409);
    expect(res.body.error.code).toBe('REPLACEMENT_NOT_AVAILABLE');
    expect(await storeEvents(blocked)).toHaveLength(0);
    const after = await prisma.return.findUniqueOrThrow({
      where: { id: blocked },
    });
    expect(after.status).toBe('ESCALATED');
    expect(after.escalationResolvedAt).toBeNull();
  });

  it('customer cancellation: ONE event; owner and branch-A employee are told, the customer is not; a repeat answers 409 (or the saved reply for the same key) and adds no event', async () => {
    await setFlag(true);
    const s = await store();
    const customer = await account();
    const returnId = await requestReturn(s, customer);
    const key = unique('tb15-cancel');
    await cancel(customer, returnId, key).expect(201);
    await cancel(customer, returnId, key).expect(201); // replayed
    const again = await cancel(customer, returnId).expect(409);
    expect(again.body.error.code).toBe('RETURN_NOT_CANCELLABLE');

    const events = await storeEvents(returnId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'return.cancelled_for_store',
      payload: { return_id: returnId },
    });
    await drain();
    const rows = await notes(returnId);
    expect(to(rows, 'RETURN_CANCELLED_BY_CUSTOMER')).toEqual(
      ids(s.owner, s.employee),
    );
    expect(
      rows.filter((n) => n.recipientUserId === customer.userId),
    ).toHaveLength(0);
    expect(
      rows.find((n) => n.type === 'RETURN_CANCELLED_BY_CUSTOMER')!.data,
    ).toEqual({});
    expectNoPrivateData(
      [events, rows.filter((n) => STORE_TYPES.includes(n.type))],
      customer,
    );
  });

  it('a second platform decision answers 409 and adds no event; the same key replays without a new one', async () => {
    await setFlag(true);
    const s = await store();
    const customer = await account();
    const admin = await account('PLATFORM_ADMIN');
    const returnId = await requestReturn(s, customer);
    await escalate(returnId);
    const key = unique('tb15-admin-key');
    await resolve(admin, returnId, 'reject', key).expect(200);
    await resolve(admin, returnId, 'reject', key).expect(200); // replayed
    const second = await resolve(admin, returnId, 'approve').expect(409);
    expect(second.body.error.code).toBe('RETURN_NOT_ESCALATED');
    expect(await storeEvents(returnId)).toHaveLength(1);
  });

  it('a cancellation racing the store decision: exactly one wins, and only the winner produces store events', async () => {
    await setFlag(true);
    for (let i = 0; i < 3; i += 1) {
      const s = await store();
      const customer = await account();
      const returnId = await requestReturn(s, customer);
      const [c, d] = await Promise.all([
        cancel(customer, returnId),
        http()
          .patch(
            `/api/v1/vendors/${s.vendorId}/branches/${s.branchId}/returns/${returnId}/decision`,
          )
          .set(auth(s.owner.token))
          .set('Idempotency-Key', unique('tb15-race'))
          .send({ decision: 'approve' }),
      ]);
      expect([c.status, d.status].sort()).toEqual(
        c.status === 201 ? [201, 409] : [200, 409],
      );
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: returnId },
      });
      const events = await storeEvents(returnId);
      if (r.status === 'CANCELLED_BY_CUSTOMER') {
        expect(events.map((e) => e.eventType)).toEqual([
          'return.cancelled_for_store',
        ]);
      } else {
        expect(r.status).toBe('APPROVED_AWAITING_DROPOFF');
        expect(events).toHaveLength(0);
      }
    }
  });

  it('send time decides: a member suspended, moved away or deactivated after the event is not told; one moved INTO the branch is', async () => {
    await setFlag(true);
    const s = await store();
    const customer = await account();
    const returnId = await requestReturn(s, customer);
    await cancel(customer, returnId).expect(201); // event written, not sent
    expect(await storeEvents(returnId)).toHaveLength(1);

    await prisma.vendorUser.updateMany({
      where: { vendorId: s.vendorId, userId: s.employee.userId },
      data: { status: 'SUSPENDED' },
    });
    await prisma.vendorUser.updateMany({
      where: { vendorId: s.vendorId, userId: s.otherBranchEmployee.userId },
      data: { branchId: s.branchId }, // B -> A
    });
    await prisma.user.update({
      where: { id: s.owner.userId },
      data: { deactivatedAt: new Date() },
    });
    const secondOwner = await s.member('OWNER', null);
    await drain();

    const rows = await notes(returnId);
    expect(to(rows, 'RETURN_CANCELLED_BY_CUSTOMER')).toEqual(
      ids(s.otherBranchEmployee, secondOwner),
    );
  });

  it('a SUSPENDED store: only its active owner is told - the active employee is not, nor a suspended membership or a deactivated account (events written before and after the suspension)', async () => {
    await setFlag(true);
    // (A SUSPENDED owner membership cannot exist: the database allows
    // SUSPENDED for branch employees only - check constraint
    // vendor_users_suspended_only_for_branch_employee. A suspended owner
    // account is covered by the deactivated owner below.)
    const s = await store();
    const customer = await account();
    const admin = await account('PLATFORM_ADMIN');
    const cancelledBefore = await requestReturn(s, customer);
    const approved = await requestReturn(s, customer);
    const rejected = await requestReturn(s, customer);
    const cancelledAfter = await requestReturn(s, customer);
    await escalate(approved);
    await escalate(rejected);
    // Written while the store is still ACTIVE, sent after it is suspended:
    // the store's status when the relay sends decides.
    await cancel(customer, cancelledBefore).expect(201);

    await prisma.vendor.update({
      where: { id: s.vendorId },
      data: { status: 'SUSPENDED' },
    });
    await resolve(admin, approved, 'approve').expect(200);
    await resolve(admin, rejected, 'reject').expect(200);
    await cancel(customer, cancelledAfter).expect(201);
    await drain();

    const cases: [string, string][] = [
      [cancelledBefore, 'RETURN_CANCELLED_BY_CUSTOMER'],
      [approved, 'RETURN_PLATFORM_APPROVED'],
      [rejected, 'RETURN_PLATFORM_REJECTED'],
      [cancelledAfter, 'RETURN_CANCELLED_BY_CUSTOMER'],
    ];
    for (const [returnId, type] of cases) {
      const rows = await notes(returnId);
      expect(to(rows, type)).toEqual([s.owner.userId]);
      // TB-15 types only: the return's earlier TB-14 RETURN_REQUESTED
      // rightly reached the employee when the store was still active.
      const told = rows
        .filter((n) => STORE_TYPES.includes(n.type))
        .map((n) => n.recipientUserId);
      for (const notTold of [
        s.employee, // active employee of the order's branch
        s.suspended, // suspended membership
        s.deactivatedOwner, // deactivated account
        s.otherBranchEmployee,
      ]) {
        expect(told).not.toContain(notTold.userId);
      }
    }
  });

  it('the person who made the change is never told about it: an administrator who also owns the store, a customer who also works at the branch', async () => {
    await setFlag(true);
    const s = await store();
    const admin = await account('PLATFORM_ADMIN');
    await s.member('OWNER', null, 'ACTIVE', admin);
    const customer = await account();
    const decided = await requestReturn(s, customer);
    await escalate(decided);
    const staffCustomer = await s.member('BRANCH_EMPLOYEE', s.branchId);
    const cancelled = await requestReturn(s, staffCustomer);

    await resolve(admin, decided, 'approve').expect(200);
    await cancel(staffCustomer, cancelled).expect(201);
    await drain();

    expect(to(await notes(decided), 'RETURN_PLATFORM_APPROVED')).toEqual(
      ids(s.owner, s.employee, staffCustomer),
    );
    expect(to(await notes(cancelled), 'RETURN_CANCELLED_BY_CUSTOMER')).toEqual(
      ids(s.owner, s.employee, admin),
    );
  });

  it('one person, one notification: a second membership of the same user in the same store is impossible, and a retried event never doubles a notification', async () => {
    await setFlag(true);
    const s = await store();
    await expect(
      prisma.vendorUser.create({
        data: {
          userId: s.owner.userId,
          vendorId: s.vendorId,
          role: 'BRANCH_EMPLOYEE',
          branchId: s.branchId,
        },
      }),
    ).rejects.toThrow(/Unique constraint/);

    const customer = await account();
    const returnId = await requestReturn(s, customer);
    await cancel(customer, returnId).expect(201);
    await drain();
    const [event] = await storeEvents(returnId);
    expect(event.status).toBe('PUBLISHED');
    const before = await notes(returnId);
    // A crash after the notifications were committed but before the row
    // was marked: the relay runs the same event again.
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: 'PENDING', publishedAt: null, availableAt: new Date() },
    });
    await drain();
    const after = await notes(returnId);
    expect(after.map((n) => n.id).sort()).toEqual(
      before.map((n) => n.id).sort(),
    );
    expect(to(after, 'RETURN_CANCELLED_BY_CUSTOMER')).toEqual(
      ids(s.owner, s.employee),
    );
    expect(
      (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }))
        .status,
    ).toBe('PUBLISHED');
  });

  it('the flag stops FUTURE events only: an event written while it was on is still sent after it is switched off, and notifications already created stay', async () => {
    await setFlag(true);
    const s = await store();
    const customer = await account();
    const first = await requestReturn(s, customer);
    const second = await requestReturn(s, customer);
    await cancel(customer, first).expect(201); // flag on: event written
    await setFlag(false);
    await cancel(customer, second).expect(201); // flag off: no event
    await drain();

    expect(await storeEvents(second)).toHaveLength(0);
    expect(to(await notes(first), 'RETURN_CANCELLED_BY_CUSTOMER')).toEqual(
      ids(s.owner, s.employee),
    );
    const view = await http()
      .get(`/api/v1/vendors/${s.vendorId}/notifications`)
      .set(auth(s.owner.token))
      .expect(200);
    expect(
      view.body.items.filter(
        (n: { type: string; target_id: string }) =>
          n.type === 'RETURN_CANCELLED_BY_CUSTOMER',
      ),
    ).toEqual([expect.objectContaining({ target_id: first })]);
    const bell = await http()
      .get('/api/v1/me/notifications')
      .set(auth(s.owner.token))
      .expect(200);
    expect(
      bell.body.items.filter(
        (n: { type: string }) => n.type === 'RETURN_CANCELLED_BY_CUSTOMER',
      ),
    ).toHaveLength(0);
  });
});
