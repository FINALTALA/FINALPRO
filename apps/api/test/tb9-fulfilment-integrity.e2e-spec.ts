import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import {
  parseRepairArgs,
  runRepair,
} from '../scripts/repair-branch-order-integrity';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { FulfilmentSweepService } from './../src/orders/fulfilment-sweep.service';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { sweepUntil } from './helpers/sweep-until';

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

// TB-9: one branch order in a state the order state machine never
// produces (a PICKUP order in DELIVERED - finalpro had one, an old
// Sprint 19 fixture) made the 72h auto-confirm throw, and since the
// sweep took candidates oldest-first with no per-order isolation it
// blocked every reminder and auto-confirm after it, on every tick, and
// failed its customer's and store's order lists. Now: every order is
// isolated, only DELIVERY orders are reminded/auto-confirmed, and an
// invalid order is left unchanged and flagged once (one audit row, one
// alert per platform administrator).
describe('TB-9 fulfilment sweep isolation and order integrity (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sweep: FulfilmentSweepService;

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
    sweep = app.get(FulfilmentSweepService);
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function account(platformRole?: 'PLATFORM_ADMIN') {
    const phone = `+993${Date.now()}${(counter += 1)}`;
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
    return { token, userId: user.id, customerId: profile.id };
  }
  type Account = Awaited<ReturnType<typeof account>>;

  /** An active store with one branch, its owner and a branch employee. */
  async function store() {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('tb9-store').toLowerCase(),
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
    const employee = await account();
    await prisma.vendorUser.create({
      data: {
        userId: employee.userId,
        vendorId: vendor.id,
        role: 'BRANCH_EMPLOYEE',
        branchId: branch.id,
      },
    });
    return { vendorId: vendor.id, branchId: branch.id, owner, employee };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  /** A branch order written straight into a given state (as the old
   * fixture did) - PICKUP + DELIVERED is the invalid one. */
  async function order(
    s: Store,
    customer: Account,
    data: {
      fulfilmentMethod: 'DELIVERY' | 'PICKUP';
      status: 'DELIVERED' | 'PICKED_UP' | 'COMPLETED';
      deliveredAt?: Date | null;
    },
  ) {
    const customerOrder = await prisma.customerOrder.create({
      data: { customerId: customer.customerId },
    });
    const row = await prisma.branchOrder.create({
      data: {
        customerOrderId: customerOrder.id,
        vendorId: s.vendorId,
        branchId: s.branchId,
        paymentMethod: 'COD',
        subtotal: 10,
        total: 10,
        pickupCode:
          data.fulfilmentMethod === 'PICKUP'
            ? String(100000 + (counter += 1))
            : null,
        ...data,
      },
    });
    return row.id;
  }

  const statusOf = async (id: string) =>
    (await prisma.branchOrder.findUniqueOrThrow({ where: { id } })).status;
  const flagAudits = (id: string) =>
    prisma.auditLog.count({
      where: { entityId: id, action: 'branch_order.integrity_flagged' },
    });
  const alerts = (id: string) =>
    prisma.outboxEvent.findMany({
      where: {
        eventType: 'branch_order.integrity_flagged',
        payload: { path: ['branch_order_id'], equals: id },
      },
    });
  const eventsFor = (id: string, eventType: string) =>
    prisma.outboxEvent.count({
      where: { eventType, payload: { path: ['branch_order_id'], equals: id } },
    });
  const activeAdminIds = async () =>
    (
      await prisma.user.findMany({
        where: { platformRole: 'PLATFORM_ADMIN', deactivatedAt: null },
        select: { id: true },
      })
    ).map((u) => u.id);
  /** Alert recipients: at least one, active administrators only, each
   * once. WHICH administrators (subscribers, or every active one as the
   * fallback) is TB-12.2's policy, proven in
   * tb12-alert-recipients.e2e-spec.ts - and in a parallel run another
   * file may hold a subscription or create administrators meanwhile. */
  async function expectAlertedAdmins(recipients: string[]) {
    expect(recipients.length).toBeGreaterThan(0);
    expect(await activeAdminIds()).toEqual(expect.arrayContaining(recipients));
    expect(new Set(recipients).size).toBe(recipients.length);
  }

  it('a tick whose OLDEST due order is invalid still reminds and auto-completes every valid DELIVERY order; the invalid one is left as it is and flagged once', async () => {
    await account('PLATFORM_ADMIN');
    await account('PLATFORM_ADMIN');
    const s = await store();
    const customer = await account();
    // Oldest of all, so it sorts first - exactly the finalpro shape.
    const bad = await order(s, customer, {
      fulfilmentMethod: 'PICKUP',
      status: 'DELIVERED',
      deliveredAt: hoursAgo(10_000),
    });
    const due1 = await order(s, customer, {
      fulfilmentMethod: 'DELIVERY',
      status: 'DELIVERED',
      deliveredAt: hoursAgo(9_000),
    });
    const due2 = await order(s, customer, {
      fulfilmentMethod: 'DELIVERY',
      status: 'DELIVERED',
      deliveredAt: hoursAgo(80),
    });
    const remind = await order(s, customer, {
      fulfilmentMethod: 'DELIVERY',
      status: 'DELIVERED',
      deliveredAt: hoursAgo(50),
    });
    // (Another file's sweep may reach these orders first when the suite
    // runs in parallel - the outcome below is what matters.)
    await expect(sweep.sweepOnce()).resolves.toEqual(expect.any(Number));
    await sweepUntil(
      () => sweep.sweepOnce(),
      async () =>
        (await statusOf(due1)) === 'COMPLETED' &&
        (await statusOf(due2)) === 'COMPLETED',
    );

    expect(await statusOf(due1)).toBe('COMPLETED');
    expect(await statusOf(due2)).toBe('COMPLETED');
    expect(await eventsFor(due1, 'branch_order.auto_confirmed_72h')).toBe(1);
    expect(await eventsFor(due2, 'branch_order.review_invitation')).toBe(1);
    expect(
      (await prisma.branchOrder.findUniqueOrThrow({ where: { id: remind } }))
        .confirmReminderSentAt,
    ).not.toBeNull();
    expect(await eventsFor(remind, 'branch_order.confirm_reminder_48h')).toBe(
      1,
    );

    // The invalid order: unchanged, never notified to its customer,
    // never moved through the state machine - flagged once instead.
    expect(await statusOf(bad)).toBe('DELIVERED');
    expect(await eventsFor(bad, 'branch_order.auto_confirmed_72h')).toBe(0);
    expect(await eventsFor(bad, 'branch_order.confirm_reminder_48h')).toBe(0);
    expect(await eventsFor(bad, 'branch_order.review_invitation')).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { entityId: bad, action: 'branch_order.status_changed' },
      }),
    ).toBe(0);
    expect(await flagAudits(bad)).toBe(1);
    const flag = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: bad, action: 'branch_order.integrity_flagged' },
    });
    expect(flag.actorId).toBeNull();
    expect(flag.afterState).toEqual({
      fulfilment_method: 'PICKUP',
      status: 'DELIVERED',
      issue: 'PICKUP_IN_DELIVERY_STATUS',
    });
    // One alert per platform administrator - and only to them.
    const sent = await alerts(bad);
    await expectAlertedAdmins(
      sent.map((e) => (e.payload as Record<string, string>).recipient_user_id),
    );
    for (const e of sent) {
      expect(Object.keys(e.payload as object).sort()).toEqual([
        'audience', // TB-26: set by the sender
        'branch_order_id',
        'issue',
        'recipient_user_id',
      ]);
    }

    // Later ticks repeat nothing.
    await sweep.sweepOnce();
    await sweep.sweepOnce();
    expect(await flagAudits(bad)).toBe(1);
    expect(await alerts(bad)).toHaveLength(sent.length);
    expect(await statusOf(bad)).toBe('DELIVERED');
    expect(await eventsFor(due1, 'branch_order.auto_confirmed_72h')).toBe(1);
    expect(await eventsFor(remind, 'branch_order.confirm_reminder_48h')).toBe(
      1,
    );
  });

  it('the relay turns the alert into an ORDER_INTEGRITY_ALERT notification for each platform administrator only, carrying only the issue', async () => {
    await account('PLATFORM_ADMIN');
    const s = await store();
    const customer = await account();
    const bad = await order(s, customer, {
      fulfilmentMethod: 'DELIVERY',
      status: 'PICKED_UP',
    });
    await sweep.sweepOnce();
    const sent = await alerts(bad);
    await expectAlertedAdmins(
      sent.map((e) => (e.payload as Record<string, string>).recipient_user_id),
    );

    // The relay always takes the oldest claimable row first, so on a
    // shared database these alerts can sit behind other files' backlog
    // indefinitely. Backdating this order's own alert rows makes them
    // the oldest and claimable now (also sidestepping the row stamp
    // being this process's clock and the claim the database's), so the
    // drain below is bounded by this order's alerts alone.
    await prisma.outboxEvent.updateMany({
      where: {
        eventType: 'branch_order.integrity_flagged',
        payload: { path: ['branch_order_id'], equals: bad },
      },
      data: {
        createdAt: new Date('2000-01-01T00:00:00Z'),
        availableAt: new Date('2000-01-01T00:00:00Z'),
      },
    });
    const relay = app.get(OutboxRelayService);
    const delivered = () =>
      prisma.notification.count({
        where: { targetType: 'BRANCH_ORDER', targetId: bad },
      });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await delivered()) < sent.length) {
      if (!(await relay.dispatchOnce())) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    const notes = await prisma.notification.findMany({
      where: { targetType: 'BRANCH_ORDER', targetId: bad },
    });
    // One notification per alert, to exactly the alerted administrators.
    expect(notes.map((n) => n.recipientUserId).sort()).toEqual(
      sent
        .map((e) => (e.payload as Record<string, string>).recipient_user_id)
        .sort(),
    );
    for (const n of notes) {
      expect(n.type).toBe('ORDER_INTEGRITY_ALERT');
      expect(n.data).toEqual({ issue: 'DELIVERY_IN_PICKUP_STATUS' });
      expect(n.vendorId).toBeNull();
    }
    for (const id of [customer.userId, s.owner.userId, s.employee.userId]) {
      expect(notes.some((n) => n.recipientUserId === id)).toBe(false);
    }
  });

  it("the customer's, the store's and the branch's order lists all load with an invalid order among them - every order shown, no technical message", async () => {
    const s = await store();
    const customer = await account();
    const bad = await order(s, customer, {
      fulfilmentMethod: 'PICKUP',
      status: 'DELIVERED',
      deliveredAt: hoursAgo(10_000),
    });
    const good = await order(s, customer, {
      fulfilmentMethod: 'DELIVERY',
      status: 'DELIVERED',
      deliveredAt: hoursAgo(80),
    });

    const mine = await request(app.getHttpServer())
      .get('/api/v1/customers/me/orders')
      .set(auth(customer.token))
      .expect(200);
    expect(JSON.stringify(mine.body)).not.toMatch(
      /Cannot move|INVALID_BRANCH_ORDER_TRANSITION|integrity/i,
    );
    const ids = (mine.body as { id: string; status: string }[]).map(
      (o) => o.id,
    );
    expect(ids).toEqual(expect.arrayContaining([bad, good]));
    // The valid one was still auto-completed on this read.
    expect(
      (mine.body as { id: string; status: string }[]).find(
        (o) => o.id === good,
      )!.status,
    ).toBe('COMPLETED');

    for (const [token, path] of [
      [s.owner.token, `/api/v1/vendors/${s.vendorId}/orders`],
      [
        s.employee.token,
        `/api/v1/vendors/${s.vendorId}/branches/${s.branchId}/orders`,
      ],
    ]) {
      const res = await request(app.getHttpServer())
        .get(path)
        .set(auth(token))
        .expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(
        /Cannot move|INVALID_BRANCH_ORDER_TRANSITION|integrity/i,
      );
      expect((res.body as { id: string }[]).map((o) => o.id)).toEqual(
        expect.arrayContaining([bad, good]),
      );
    }
    // Three reads, one flag.
    expect(await flagAudits(bad)).toBe(1);
    expect(await statusOf(bad)).toBe('DELIVERED');
  });

  it('concurrency: the sweep and two list reads racing on the same invalid order flag it exactly once; the sweep and the customer confirming a valid order complete it exactly once', async () => {
    const s = await store();
    const customer = await account();
    const bad = await order(s, customer, {
      fulfilmentMethod: 'PICKUP',
      status: 'DELIVERED',
      deliveredAt: hoursAgo(10_000),
    });
    const good = await order(s, customer, {
      fulfilmentMethod: 'DELIVERY',
      status: 'DELIVERED',
      deliveredAt: hoursAgo(80),
    });
    const list = () =>
      request(app.getHttpServer())
        .get('/api/v1/customers/me/orders')
        .set(auth(customer.token));
    const confirm = () =>
      request(app.getHttpServer())
        .post(`/api/v1/customers/me/orders/${good}/confirm-received`)
        .set(auth(customer.token))
        .set('Idempotency-Key', unique('confirm'));

    const [, l1, l2, c] = await Promise.all([
      sweep.sweepOnce(),
      list(),
      list(),
      confirm(),
    ]);
    expect(l1.status).toBe(200);
    expect(l2.status).toBe(200);
    // Whoever got there first completed it; the other saw it already done.
    expect([200, 201, 409]).toContain(c.status);
    if (c.status === 409) {
      expect(c.body.error.code).toBe('INVALID_BRANCH_ORDER_TRANSITION');
    }

    expect(await flagAudits(bad)).toBe(1);
    expect(await statusOf(good)).toBe('COMPLETED');
    expect(
      await prisma.auditLog.count({
        where: { entityId: good, action: 'branch_order.status_changed' },
      }),
    ).toBe(1);
    expect(await eventsFor(good, 'branch_order.review_invitation')).toBe(1);
  });

  it('BOLA: another customer and another store never see the invalid order; a guest is refused', async () => {
    const s = await store();
    const other = await store();
    const customer = await account();
    const stranger = await account();
    const bad = await order(s, customer, {
      fulfilmentMethod: 'PICKUP',
      status: 'DELIVERED',
      deliveredAt: hoursAgo(10_000),
    });

    const theirs = await request(app.getHttpServer())
      .get('/api/v1/customers/me/orders')
      .set(auth(stranger.token))
      .expect(200);
    expect(JSON.stringify(theirs.body)).not.toContain(bad);

    const otherStore = await request(app.getHttpServer())
      .get(`/api/v1/vendors/${other.vendorId}/orders`)
      .set(auth(other.owner.token))
      .expect(200);
    expect(JSON.stringify(otherStore.body)).not.toContain(bad);
    // Another store's owner cannot read this store's list at all.
    const cross = await request(app.getHttpServer())
      .get(`/api/v1/vendors/${s.vendorId}/orders`)
      .set(auth(other.owner.token));
    expect(cross.status).toBe(403);
    expect(JSON.stringify(cross.body)).not.toContain(bad);

    await request(app.getHttpServer())
      .get('/api/v1/customers/me/orders')
      .expect(401);
  });

  describe('fixture repair CLI (dry-run and explicit-id apply)', () => {
    const run = async (argv: string[]) => {
      const lines: string[] = [];
      const code = await runRepair(argv, prisma as never, (l) => lines.push(l));
      return { code, out: lines.join('\n') };
    };

    it('rejects --apply without explicit ids or an actor, and any argument that is not a full UUID', () => {
      const id = '55c962ed-0d9f-46a2-8f55-2f96c40f2d65';
      expect(() => parseRepairArgs(['--apply', '--actor', id])).toThrow(
        /at least one explicit --id/,
      );
      expect(() => parseRepairArgs(['--apply', '--id', id])).toThrow(/--actor/);
      expect(() => parseRepairArgs(['--id', '55c962ed'])).toThrow(/full UUID/);
      expect(() => parseRepairArgs(['--all'])).toThrow(/Unknown argument/);
      expect(parseRepairArgs([])).toEqual({
        apply: false,
        actor: null,
        ids: [],
      });
    });

    it('dry-run marks only the stale-fixture shape eligible (PICKUP + DELIVERED, no items, never moved by the state machine) and writes nothing', async () => {
      const s = await store();
      const customer = await account();
      const fixture = await order(s, customer, {
        fulfilmentMethod: 'PICKUP',
        status: 'DELIVERED',
        deliveredAt: hoursAgo(50),
      });
      const withItem = await order(s, customer, {
        fulfilmentMethod: 'PICKUP',
        status: 'DELIVERED',
        deliveredAt: hoursAgo(50),
      });
      const offer = await prisma.vendorOffer.create({
        data: {
          vendorId: s.vendorId,
          titleAr: 'م',
          titleEn: 'P',
          status: 'ACTIVE',
        },
      });
      const variant = await prisma.offerVariant.create({
        data: {
          vendorId: s.vendorId,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          basePrice: 10,
          storeInventoryBarcode: unique('barcode'),
        },
      });
      await prisma.branchOrderItem.create({
        data: {
          vendorId: s.vendorId,
          branchOrderId: withItem,
          offerVariantId: variant.id,
          quantity: 1,
          unitPrice: 10,
        },
      });
      const moved = await order(s, customer, {
        fulfilmentMethod: 'PICKUP',
        status: 'DELIVERED',
        deliveredAt: hoursAgo(50),
      });
      await prisma.auditLog.create({
        data: {
          correlationId: unique('c'),
          action: 'branch_order.status_changed',
          entityType: 'BranchOrder',
          entityId: moved,
        },
      });
      const valid = await order(s, customer, {
        fulfilmentMethod: 'DELIVERY',
        status: 'DELIVERED',
        deliveredAt: hoursAgo(50),
      });
      // Scoped to these orders, and to the repair: the app's background
      // sweep may flag them meanwhile (an integrity audit), which is not
      // a write by the dry-run.
      const repairAudits = () =>
        prisma.auditLog.count({
          where: {
            entityId: { in: [fixture, withItem, moved, valid] },
            action: { not: 'branch_order.integrity_flagged' },
          },
        });
      const auditsBefore = await repairAudits();

      const { code, out } = await run([
        '--id',
        fixture,
        '--id',
        withItem,
        '--id',
        moved,
        '--id',
        valid,
      ]);
      expect(code).toBe(0);
      const line = (id: string) => out.split('\n').find((l) => l.includes(id))!;
      expect(line(fixture)).toMatch(/PICKUP\/DELIVERED .*items=0 .*ELIGIBLE$/);
      expect(line(withItem)).toMatch(/NOT ELIGIBLE \(has 1 item/);
      expect(line(moved)).toMatch(
        /NOT ELIGIBLE \(was moved through the order state machine/,
      );
      expect(line(valid)).toMatch(/NOT ELIGIBLE \(not a PICKUP order/);
      expect(out).toMatch(/Eligible: 1\. Nothing was written\./);

      // The listing without ids shows every PICKUP order in DELIVERED.
      const all = await run([]);
      expect(all.out).toContain(fixture);
      expect(all.out).not.toContain(valid);

      expect(await repairAudits()).toBe(auditsBefore);
      for (const id of [fixture, withItem, moved])
        expect(await statusOf(id)).toBe('DELIVERED');
    });

    it('apply: refuses a non-admin actor; an ineligible id rolls the whole run back; an eligible fixture becomes COMPLETED with one data-minimal audit row and no notification', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const notAdmin = await account();
      const s = await store();
      const customer = await account();
      const fixture = await order(s, customer, {
        fulfilmentMethod: 'PICKUP',
        status: 'DELIVERED',
        deliveredAt: hoursAgo(50),
      });
      const valid = await order(s, customer, {
        fulfilmentMethod: 'DELIVERY',
        status: 'DELIVERED',
        deliveredAt: hoursAgo(50),
      });

      const refused = await run([
        '--apply',
        '--actor',
        notAdmin.userId,
        '--id',
        fixture,
      ]);
      expect(refused.code).toBe(2);
      expect(refused.out).toMatch(/PLATFORM_ADMIN/);

      const mixed = await run([
        '--apply',
        '--actor',
        admin.userId,
        '--id',
        fixture,
        '--id',
        valid,
      ]);
      expect(mixed.code).toBe(1);
      expect(mixed.out).toMatch(/not eligible.*not a PICKUP order/);
      expect(mixed.out).toMatch(/rolled back/);
      expect(await statusOf(fixture)).toBe('DELIVERED');
      expect(await statusOf(valid)).toBe('DELIVERED');
      expect(
        await prisma.auditLog.count({
          where: { action: 'branch_order.integrity_repaired' },
        }),
      ).toBe(0);

      const ok = await run([
        '--apply',
        '--actor',
        admin.userId,
        '--id',
        fixture,
      ]);
      expect(ok.code).toBe(0);
      expect(ok.out).toContain(`${fixture}  now PICKUP/COMPLETED`);
      expect(await statusOf(fixture)).toBe('COMPLETED');
      expect(await statusOf(valid)).toBe('DELIVERED');

      const audits = await prisma.auditLog.findMany({
        where: { entityId: fixture, action: 'branch_order.integrity_repaired' },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].actorId).toBe(admin.userId);
      expect(audits[0].beforeState).toEqual({ status: 'DELIVERED' });
      const after = audits[0].afterState as Record<string, unknown>;
      expect(Object.keys(after).sort()).toEqual(
        [
          'delivered_at',
          'fulfilment_method',
          'new_status',
          'old_status',
          'order_id',
          'reason',
          'repaired_by',
        ].sort(),
      );
      expect(after).toMatchObject({
        order_id: fixture,
        fulfilment_method: 'PICKUP',
        old_status: 'DELIVERED',
        new_status: 'COMPLETED',
        reason: 'STALE_TEST_FIXTURE_PICKUP_DELIVERED',
        repaired_by: admin.userId,
      });
      // No notification and no review invitation of any kind.
      // (The background sweep may have flagged the fixture before the
      // repair - that alert is the integrity flag, not the repair's.)
      expect(
        await prisma.outboxEvent.count({
          where: {
            payload: { path: ['branch_order_id'], equals: fixture },
            eventType: { not: 'branch_order.integrity_flagged' },
          },
        }),
      ).toBe(0);
      expect(
        await prisma.auditLog.count({
          where: { entityId: fixture, action: 'branch_order.status_changed' },
        }),
      ).toBe(0);

      // Re-running it is refused - the row is no longer the fixture shape.
      const again = await run([
        '--apply',
        '--actor',
        admin.userId,
        '--id',
        fixture,
      ]);
      expect(again.code).toBe(1);
      expect(again.out).toMatch(/status is COMPLETED/);
    });
  });
});
