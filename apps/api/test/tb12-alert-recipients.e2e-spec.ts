import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { FulfilmentSweepService } from './../src/orders/fulfilment-sweep.service';
import { PlatformAlertRecipientsService } from './../src/platform-alerts/platform-alert-recipients.service';
import { PrismaService } from './../src/prisma/prisma.service';

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

// TB-12.2: who receives each category of platform alert. Explicit
// subscriptions per (administrator, category), managed by platform
// administrators only; at send time a subscriber counts only while
// still an active PLATFORM_ADMIN; with no active subscriber the alert
// goes to every active administrator (logged). ORDER_INTEGRITY_ALERT
// is the one sender wired to it so far.
describe('TB-12.2 platform alert recipients (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let recipients: PlatformAlertRecipientsService;
  let sweep: FulfilmentSweepService;
  const created: string[] = [];

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
    recipients = app.get(PlatformAlertRecipientsService);
    sweep = app.get(FulfilmentSweepService);
  });

  // Subscriptions are global state - other files' alerts read them - so
  // every test leaves none of its own behind.
  afterEach(async () => {
    await prisma.platformAlertRecipient.deleteMany({
      where: { userId: { in: created } },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());
  const base = '/api/v1/admin/alert-recipients';

  async function account(
    platformRole?: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER',
  ) {
    const phone = `+993${Date.now()}${(counter += 1)}`;
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'x',
        phoneVerifiedAt: new Date(),
        platformRole: platformRole ?? null,
      },
    });
    await prisma.customerProfile.create({ data: { userId: user.id } });
    created.push(user.id);
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { token, id: user.id, phone };
  }
  type Account = Awaited<ReturnType<typeof account>>;

  const put = (
    actor: Account,
    category: string,
    userId: string,
    key = unique('k'),
  ) =>
    http()
      .put(`${base}/${category}/${userId}`)
      .set(auth(actor.token))
      .set('Idempotency-Key', key);
  const del = (
    actor: Account,
    category: string,
    userId: string,
    key = unique('k'),
  ) =>
    http()
      .delete(`${base}/${category}/${userId}`)
      .set(auth(actor.token))
      .set('Idempotency-Key', key);
  const audits = (userId: string, action: string) =>
    prisma.auditLog.findMany({ where: { entityId: userId, action } });
  const activeAdminIds = async () =>
    (
      await prisma.user.findMany({
        where: { platformRole: 'PLATFORM_ADMIN', deactivatedAt: null },
        select: { id: true },
      })
    ).map((u) => u.id);

  /** An invalid branch order (PICKUP in DELIVERED), flagged by one sweep
   * tick; returns who its ORDER_INTEGRITY_ALERT went to. */
  async function flagInvalidOrder(): Promise<string[]> {
    const owner = await account();
    const customer = await account();
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('tb12-store').toLowerCase(),
        legalName: unique('L'),
        displayName: 'متجر',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
      },
    });
    await prisma.vendorUser.create({
      data: { userId: owner.id, vendorId: vendor.id, role: 'OWNER' },
    });
    const branch = await prisma.storeBranch.create({
      data: { vendorId: vendor.id, name: unique('محل'), isPhysical: true },
    });
    const profile = await prisma.customerProfile.findUniqueOrThrow({
      where: { userId: customer.id },
    });
    const customerOrder = await prisma.customerOrder.create({
      data: { customerId: profile.id },
    });
    const order = await prisma.branchOrder.create({
      data: {
        customerOrderId: customerOrder.id,
        vendorId: vendor.id,
        branchId: branch.id,
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'COD',
        subtotal: 10,
        total: 10,
        status: 'DELIVERED',
        deliveredAt: new Date(Date.now() - 100 * 3600 * 1000),
        pickupCode: String(100000 + (counter % 899999)),
      },
    });
    await sweep.sweepOnce();
    const rows = await prisma.outboxEvent.findMany({
      where: {
        eventType: 'branch_order.integrity_flagged',
        payload: { path: ['branch_order_id'], equals: order.id },
      },
    });
    const ids = rows.map(
      (r) => (r.payload as Record<string, string>).recipient_user_id,
    );
    // Never the store or the customer.
    expect(ids).not.toContain(owner.id);
    expect(ids).not.toContain(customer.id);
    expect(new Set(ids).size).toBe(ids.length);
    return ids;
  }

  describe('permissions', () => {
    it('only a PLATFORM_ADMIN may read or change recipients; nobody else learns who the administrators are', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const target = await account('PLATFORM_ADMIN');
      const reviewer = await account('VERIFICATION_REVIEWER');
      const customer = await account();
      const owner = await account();
      const vendor = await prisma.vendor.create({
        data: {
          slug: unique('tb12-owner').toLowerCase(),
          legalName: unique('L'),
          status: 'ACTIVE',
        },
      });
      await prisma.vendorUser.create({
        data: { userId: owner.id, vendorId: vendor.id, role: 'OWNER' },
      });

      for (const who of [reviewer, customer, owner]) {
        for (const res of [
          await http().get(base).set(auth(who.token)),
          await put(who, 'ORDER_INTEGRITY', target.id),
          await del(who, 'ORDER_INTEGRITY', target.id),
        ]) {
          expect(res.status).toBe(403);
          expect(JSON.stringify(res.body)).not.toContain(target.id);
          expect(JSON.stringify(res.body)).not.toContain(admin.id);
        }
      }
      await http().get(base).expect(401);
      await http()
        .put(`${base}/ORDER_INTEGRITY/${target.id}`)
        .set('Idempotency-Key', unique('k'))
        .expect(401);
      expect(
        await prisma.platformAlertRecipient.count({
          where: { userId: target.id },
        }),
      ).toBe(0);

      await http().get(base).set(auth(admin.token)).expect(200);
    });

    it('a change needs an Idempotency-Key (422); bad category or id is a 400', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const target = await account('PLATFORM_ADMIN');
      await http()
        .put(`${base}/ORDER_INTEGRITY/${target.id}`)
        .set(auth(admin.token))
        .expect(422);
      expect(
        (await put(admin, 'NOT_A_CATEGORY', target.id).expect(400)).body.error
          .code,
      ).toBe('INVALID_ALERT_CATEGORY');
      expect(
        (await put(admin, 'ORDER_INTEGRITY', 'not-a-uuid').expect(400)).body
          .error.code,
      ).toBe('INVALID_USER_ID');
    });

    it('BOLA: a missing account, a customer, a reviewer and a deactivated admin all get the same 404 - no way to probe which accounts exist', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const customer = await account();
      const reviewer = await account('VERIFICATION_REVIEWER');
      const gone = await account('PLATFORM_ADMIN');
      await prisma.user.update({
        where: { id: gone.id },
        data: { deactivatedAt: new Date() },
      });
      const bodies: unknown[] = [];
      for (const id of [
        '00000000-0000-4000-8000-000000000000',
        customer.id,
        reviewer.id,
        gone.id,
      ]) {
        const res = await put(admin, 'ORDER_INTEGRITY', id).expect(404);
        bodies.push({
          code: res.body.error.code,
          message: res.body.error.message,
        });
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(bodies[0]).toEqual({
        code: 'ALERT_RECIPIENT_NOT_ELIGIBLE',
        message: 'No active platform administrator with this id',
      });
      expect(
        await prisma.platformAlertRecipient.count({
          where: { userId: { in: [customer.id, reviewer.id, gone.id] } },
        }),
      ).toBe(0);
    });
  });

  describe('add and remove', () => {
    it('subscribes with one data-minimal audit row; repeating it changes nothing; the same key replays the same answer', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const target = await account('PLATFORM_ADMIN');

      const first = await put(
        admin,
        'order_integrity',
        target.id,
        'same-key-1',
      );
      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        category: 'ORDER_INTEGRITY',
        user_id: target.id,
        subscribed: true,
        changed: true,
      });
      const replay = await put(
        admin,
        'order_integrity',
        target.id,
        'same-key-1',
      );
      expect(replay.body).toEqual(first.body);
      const again = await put(admin, 'ORDER_INTEGRITY', target.id).expect(200);
      expect(again.body.changed).toBe(false);

      const rows = await audits(target.id, 'platform_alert_recipient.added');
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBe(admin.id);
      expect(rows[0].entityType).toBe('User');
      // The recipient by internal UUID, and nothing else about them.
      expect(rows[0].afterState).toEqual({
        category: 'ORDER_INTEGRITY',
        recipient_user_id: target.id,
      });
      expect(rows[0].beforeState).toBeNull();
      // Privacy: no phone (or any personal data) in the audit trail.
      expect(JSON.stringify(rows[0])).not.toContain(target.phone);
      expect(JSON.stringify(rows[0])).not.toContain(admin.phone);

      const sub = await prisma.platformAlertRecipient.findUniqueOrThrow({
        where: {
          userId_category: { userId: target.id, category: 'ORDER_INTEGRITY' },
        },
      });
      expect(sub.addedByUserId).toBe(admin.id);
    });

    it('unsubscribes with one audit row; removing again changes nothing', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const target = await account('PLATFORM_ADMIN');
      await put(admin, 'ORDER_INTEGRITY', target.id).expect(200);

      const first = await del(admin, 'ORDER_INTEGRITY', target.id).expect(200);
      expect(first.body).toEqual({
        category: 'ORDER_INTEGRITY',
        user_id: target.id,
        subscribed: false,
        changed: true,
      });
      expect(
        (await del(admin, 'ORDER_INTEGRITY', target.id).expect(200)).body
          .changed,
      ).toBe(false);
      const rows = await audits(target.id, 'platform_alert_recipient.removed');
      expect(rows).toHaveLength(1);
      expect(rows[0].beforeState).toEqual({
        category: 'ORDER_INTEGRITY',
        recipient_user_id: target.id,
      });
      expect(rows[0].afterState).toBeNull();
      expect(JSON.stringify(rows[0])).not.toContain(target.phone);
      expect(JSON.stringify(rows[0])).not.toContain(admin.phone);
      // Categories are independent.
      await put(admin, 'RETURN_ESCALATION', target.id).expect(200);
      expect(
        await prisma.platformAlertRecipient.findMany({
          where: { userId: target.id },
          select: { category: true },
        }),
      ).toEqual([{ category: 'RETURN_ESCALATION' }]);
    });

    it('concurrency: five simultaneous adds of the same pair make one row, one audit row and one "changed"', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const target = await account('PLATFORM_ADMIN');
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          put(admin, 'ORDER_INTEGRITY', target.id),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(results.filter((r) => r.body.changed === true)).toHaveLength(1);
      expect(
        await prisma.platformAlertRecipient.count({
          where: { userId: target.id },
        }),
      ).toBe(1);
      expect(
        await audits(target.id, 'platform_alert_recipient.added'),
      ).toHaveLength(1);
    });

    it("the overview shows active administrators by id and the last three phone digits only, and each category's delivery mode", async () => {
      const admin = await account('PLATFORM_ADMIN');
      const target = await account('PLATFORM_ADMIN');
      await put(admin, 'RETURN_ESCALATION', target.id).expect(200);

      const res = await http().get(base).set(auth(admin.token)).expect(200);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(target.phone);
      expect(raw).not.toContain(admin.phone);
      expect(res.body.administrators).toEqual(
        expect.arrayContaining([
          { user_id: target.id, phone_hint: `•••${target.phone.slice(-3)}` },
        ]),
      );
      for (const a of res.body.administrators) {
        expect(Object.keys(a).sort()).toEqual(['phone_hint', 'user_id']);
      }
      const byCategory = Object.fromEntries(
        res.body.categories.map((c: { category: string }) => [c.category, c]),
      );
      expect(byCategory.RETURN_ESCALATION.recipient_user_ids).toContain(
        target.id,
      );
      expect(byCategory.RETURN_ESCALATION.delivery).toBe('SUBSCRIBED');
    });
  });

  describe('who receives ORDER_INTEGRITY_ALERT', () => {
    it('only the subscribed active administrators - not other administrators, reviewers, the store or the customer', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const a = await account('PLATFORM_ADMIN');
      const b = await account('PLATFORM_ADMIN');
      const reviewer = await account('VERIFICATION_REVIEWER');
      await put(admin, 'ORDER_INTEGRITY', a.id).expect(200);
      await put(admin, 'ORDER_INTEGRITY', b.id).expect(200);
      // Subscribed to another category only: not a recipient here.
      await put(admin, 'RETURN_ESCALATION', admin.id).expect(200);

      const sent = await flagInvalidOrder();
      expect(sent.sort()).toEqual([a.id, b.id].sort());
      expect(sent).not.toContain(admin.id);
      expect(sent).not.toContain(reviewer.id);
    });

    it('a subscriber whose role is revoked, or whose account is deactivated, stops receiving at once; with nobody active left it falls back to every active administrator, logged by count only', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const a = await account('PLATFORM_ADMIN');
      const b = await account('PLATFORM_ADMIN');
      await put(admin, 'ORDER_INTEGRITY', a.id).expect(200);
      await put(admin, 'ORDER_INTEGRITY', b.id).expect(200);

      await prisma.user.update({
        where: { id: a.id },
        data: { platformRole: null },
      });
      expect(await flagInvalidOrder()).toEqual([b.id]);

      await prisma.user.update({
        where: { id: b.id },
        data: { deactivatedAt: new Date() },
      });
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const before = await activeAdminIds();
      const sent = await flagInvalidOrder();
      const after = await activeAdminIds();
      // Every active administrator (others may be created meanwhile in
      // a parallel run) - never the revoked or the deactivated one.
      expect(sent).toEqual(expect.arrayContaining(before));
      expect(after).toEqual(expect.arrayContaining(sent));
      expect(sent).not.toContain(a.id);
      expect(sent).not.toContain(b.id);
      expect(sent).toContain(admin.id);
      const logged = warn.mock.calls
        .map((c) => String(c[0]))
        .find((m) =>
          m.includes(
            'No active administrator is subscribed to ORDER_INTEGRITY',
          ),
        );
      warn.mockRestore();
      expect(logged).toMatch(
        /sending to all \d+ active platform administrators instead/,
      );
      for (const id of [admin.id, a.id, b.id]) expect(logged).not.toContain(id);
      expect(logged).not.toContain(admin.phone);
    });

    it('concurrency: a role revoked while being subscribed never leaves a non-administrator receiving', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const x = await account('PLATFORM_ADMIN');
      const keeper = await account('PLATFORM_ADMIN');
      await put(admin, 'ORDER_INTEGRITY', keeper.id).expect(200);

      const [res] = await Promise.all([
        put(admin, 'ORDER_INTEGRITY', x.id),
        prisma.user.update({
          where: { id: x.id },
          data: { platformRole: null },
        }),
      ]);
      // Either the add ran first (then the revocation) or it saw the
      // revoked role and refused - both are fine; x never receives.
      expect([200, 404]).toContain(res.status);
      const resolved = await recipients.resolve(prisma, 'ORDER_INTEGRITY');
      expect(resolved.mode).toBe('SUBSCRIBED');
      expect(resolved.userIds).toEqual([keeper.id]);
      expect(await flagInvalidOrder()).toEqual([keeper.id]);
    });
  });
});
