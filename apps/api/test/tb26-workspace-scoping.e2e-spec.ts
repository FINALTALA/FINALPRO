import { execFileSync } from 'child_process';
import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PlatformRoleGuard } from './../src/auth/platform-role.guard';
import { PLATFORM_ROLES_KEY } from './../src/auth/platform-role.decorator';
import { VendorMembershipGuard } from './../src/auth/vendor-membership.guard';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxEventService } from './../src/outbox/outbox-event.service';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { RedisService } from './../src/redis/redis.service';
import { WORKSPACE_NEUTRAL_KEY } from './../src/auth/workspace-session';
import { API_ROOT } from './helpers/seed-demo-db';
import { NOTIFICATION_AUDIENCE_BY_TYPE } from './helpers/notification-audience-table';
import { tb26Fixtures } from './helpers/tb26-fixtures';
import {
  createDisposableDatabase,
  dropDisposableDatabase,
} from './helpers/test-databases';

const FLAG = 'workspace_scoping_enabled';

/**
 * Routes under vendors/:vendorId that are deliberately NOT store-workspace
 * routes - public reads, nothing a member does. Every other one must run
 * VendorMembershipGuard (which, with the flag on, needs the workspace).
 */
const PUBLIC_VENDOR_ROUTES = ['GET vendors/:vendorId/reviews'];

// TB-26: shopping, store and platform contexts. Own database (the flag is
// global). The relay timer is stopped; the file dispatches itself.
describe('TB-26 workspace tokens and notification scoping (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let relay: OutboxRelayService;
  const sharedUrl = process.env.DATABASE_URL!;
  const dbName = `finalpro_tb26_ws_${process.pid}`;
  const f = tb26Fixtures(() => app);

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
    relay.onModuleDestroy();
  });

  afterAll(async () => {
    await app.close();
    process.env.DATABASE_URL = sharedUrl;
    await dropDisposableDatabase(sharedUrl, dbName);
  });

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
  const ws = (token: string, workspace?: string) => ({
    ...f.bearer(token),
    ...(workspace ? { 'X-Workspace-Token': workspace } : {}),
  });

  /** A notification row straight into the table, as the relay writes it. */
  let seq = 0;
  async function note(
    recipient: { userId: string },
    audience: 'CUSTOMER' | 'STORE' | 'PLATFORM',
    type: string,
    vendorId: string | null = null,
    branchId: string | null = null,
  ) {
    seq += 1;
    const e = await prisma.outboxEvent.create({
      data: { eventType: 'test.tb26', payload: {}, status: 'PUBLISHED' },
    });
    return prisma.notification.create({
      data: {
        outboxEventId: e.id,
        recipientUserId: recipient.userId,
        type: type as never,
        targetType: 'BRANCH_ORDER',
        targetId: `t-${seq}`,
        data: {},
        vendorId,
        branchId,
        audience,
        createdAt: new Date(Date.now() - seq * 1000),
      },
    });
  }
  const listIds = async (path: string, headers: Record<string, string>) => {
    const res = await f.http().get(`/api/v1/${path}`).set(headers).expect(200);
    return (res.body.items as { id: string }[]).map((i) => i.id).sort();
  };
  const count = async (path: string, headers: Record<string, string>) =>
    (
      await f
        .http()
        .get(`/api/v1/${path}/unread-count`)
        .set(headers)
        .expect(200)
    ).body.unread_count as number;
  const markRead = (
    path: string,
    id: string,
    headers: Record<string, string>,
  ) => f.http().post(`/api/v1/${path}/${id}/read`).set(headers);
  const sorted = (...ids: string[]) => [...ids].sort();

  describe('workspace tokens (flag on)', () => {
    beforeAll(() => setFlag(true));

    it('signing in is SHOPPING only: store and platform routes refuse the session alone (WORKSPACE_REQUIRED); shopping works with no workspace', async () => {
      const s = await f.store();
      const admin = await f.account('PLATFORM_ADMIN');
      await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/notifications`)
        .set(ws(s.owner.token))
        .expect(403)
        .expect((r) => expect(r.body.error.code).toBe('WORKSPACE_REQUIRED'));
      await f
        .http()
        .get('/api/v1/admin/notifications')
        .set(ws(admin.token))
        .expect(403)
        .expect((r) => expect(r.body.error.code).toBe('WORKSPACE_REQUIRED'));
      // The bell and the cart are shopping - no workspace needed.
      await f
        .http()
        .get('/api/v1/me/notifications')
        .set(ws(s.owner.token))
        .expect(200);
      await f.http().get('/api/v1/cart').set(ws(s.owner.token)).expect(200);
    });

    it('a store token opens exactly that store; not another store of the same owner, not the platform, not with another session, not from a query string', async () => {
      const owner = await f.account('PLATFORM_ADMIN');
      const s1 = await f.store(owner);
      const s2 = await f.store(owner);
      const t1 = await f.enter(owner, {
        type: 'vendor',
        vendor_id: s1.vendorId,
      });
      await f
        .http()
        .get(`/api/v1/vendors/${s1.vendorId}/notifications`)
        .set(ws(owner.token, t1))
        .expect(200);
      await f
        .http()
        .get(`/api/v1/vendors/${s2.vendorId}/notifications`)
        .set(ws(owner.token, t1))
        .expect(403);
      await f
        .http()
        .get('/api/v1/admin/notifications')
        .set(ws(owner.token, t1))
        .expect(403);
      // Same user, another sign-in: the token is bound to its session.
      const other = await f.newSession(owner.userId);
      await f
        .http()
        .get(`/api/v1/vendors/${s1.vendorId}/notifications`)
        .set(ws(other, t1))
        .expect(403);
      // Never accepted outside the header.
      await f
        .http()
        .get(
          `/api/v1/vendors/${s1.vendorId}/notifications?workspace_token=${t1}`,
        )
        .set(ws(owner.token))
        .expect(403);
      // A platform token opens the platform only.
      const p = await f.enter(owner, { type: 'platform' });
      await f
        .http()
        .get('/api/v1/admin/notifications')
        .set(ws(owner.token, p))
        .expect(200);
      await f
        .http()
        .get(`/api/v1/vendors/${s1.vendorId}/notifications`)
        .set(ws(owner.token, p))
        .expect(403);
    });

    it('entering checks the permission: a non-member, a suspended member and a non-admin are refused; nothing is issued', async () => {
      const s = await f.store();
      const stranger = await f.account();
      const suspended = await f.member(
        s.vendorId,
        await f.account(),
        'BRANCH_EMPLOYEE',
        s.branchA,
        'SUSPENDED',
      );
      const enter = (who: { token: string }, body: object) =>
        f
          .http()
          .post('/api/v1/me/workspace-sessions')
          .set(f.bearer(who.token))
          .send(body);
      await enter(stranger, { type: 'vendor', vendor_id: s.vendorId })
        .expect(403)
        .expect((r) => expect(r.body.error.code).toBe('NOT_VENDOR_MEMBER'));
      await enter(suspended, { type: 'vendor', vendor_id: s.vendorId })
        .expect(403)
        .expect((r) => expect(r.body.error.code).toBe('STAFF_SUSPENDED'));
      await enter(stranger, { type: 'platform' }).expect(403);
      await enter(stranger, { type: 'vendor' }).expect(400);
    });

    it('the membership / role is re-checked on every request: suspending the member or removing the role closes a live token at once', async () => {
      const s = await f.store();
      const employee = await f.member(
        s.vendorId,
        await f.account(),
        'BRANCH_EMPLOYEE',
        s.branchA,
      );
      const t = await f.enter(employee, {
        type: 'vendor',
        vendor_id: s.vendorId,
      });
      await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/notifications`)
        .set(ws(employee.token, t))
        .expect(200);
      await prisma.vendorUser.updateMany({
        where: { userId: employee.userId, vendorId: s.vendorId },
        data: { status: 'SUSPENDED' },
      });
      await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/notifications`)
        .set(ws(employee.token, t))
        .expect(403)
        .expect((r) => expect(r.body.error.code).toBe('STAFF_SUSPENDED'));

      const admin = await f.account('PLATFORM_ADMIN');
      const p = await f.enter(admin, { type: 'platform' });
      await f
        .http()
        .get('/api/v1/admin/notifications')
        .set(ws(admin.token, p))
        .expect(200);
      await prisma.user.update({
        where: { id: admin.userId },
        data: { platformRole: null },
      });
      await f
        .http()
        .get('/api/v1/admin/notifications')
        .set(ws(admin.token, p))
        .expect(403)
        .expect((r) => expect(r.body.error.code).toBe('FORBIDDEN'));
    });

    it('leaving, logout and the hard lifetime end a token; two tabs with two stores are independent', async () => {
      const owner = await f.account();
      const s1 = await f.store(owner);
      const s2 = await f.store(owner);
      const tab1 = await f.enter(owner, {
        type: 'vendor',
        vendor_id: s1.vendorId,
      });
      const tab2 = await f.enter(owner, {
        type: 'vendor',
        vendor_id: s2.vendorId,
      });
      // Both tabs at the same time, each in its own store only.
      const [a, b, c, d] = await Promise.all([
        f
          .http()
          .get(`/api/v1/vendors/${s1.vendorId}/notifications`)
          .set(ws(owner.token, tab1)),
        f
          .http()
          .get(`/api/v1/vendors/${s2.vendorId}/notifications`)
          .set(ws(owner.token, tab2)),
        f
          .http()
          .get(`/api/v1/vendors/${s2.vendorId}/notifications`)
          .set(ws(owner.token, tab1)),
        f
          .http()
          .get(`/api/v1/vendors/${s1.vendorId}/notifications`)
          .set(ws(owner.token, tab2)),
      ]);
      expect([a.status, b.status, c.status, d.status]).toEqual([
        200, 200, 403, 403,
      ]);
      // Leaving tab 1 does not touch tab 2.
      await f
        .http()
        .delete('/api/v1/me/workspace-sessions/current')
        .set(ws(owner.token, tab1))
        .expect(204);
      await f
        .http()
        .get(`/api/v1/vendors/${s1.vendorId}/notifications`)
        .set(ws(owner.token, tab1))
        .expect(403);
      await f
        .http()
        .get(`/api/v1/vendors/${s2.vendorId}/notifications`)
        .set(ws(owner.token, tab2))
        .expect(200);
      // Leaving again is a no-op; another session cannot revoke it.
      await f
        .http()
        .delete('/api/v1/me/workspace-sessions/current')
        .set(ws(owner.token, tab1))
        .expect(204);
      const other = await f.newSession(owner.userId);
      await f
        .http()
        .delete('/api/v1/me/workspace-sessions/current')
        .set(ws(other, tab2))
        .expect(204);
      await f
        .http()
        .get(`/api/v1/vendors/${s2.vendorId}/notifications`)
        .set(ws(owner.token, tab2))
        .expect(200);

      // The hard cap from issue (8h), however active the tab.
      const redis = app.get(RedisService);
      const key = `workspace_session:${tab2}`;
      const rec = JSON.parse((await redis.get(key))!);
      rec.issuedAt = new Date(Date.now() - 9 * 3600 * 1000).toISOString();
      await redis.set(key, JSON.stringify(rec), 'EX', 600);
      await f
        .http()
        .get(`/api/v1/vendors/${s2.vendorId}/notifications`)
        .set(ws(owner.token, tab2))
        .expect(403);
      // The idle lifetime is 30 minutes, extended by use.
      const tab3 = await f.enter(owner, {
        type: 'vendor',
        vendor_id: s2.vendorId,
      });
      const ttl = await redis.ttl(`workspace_session:${tab3}`);
      expect(ttl).toBeGreaterThan(29 * 60);
      expect(ttl).toBeLessThanOrEqual(30 * 60);

      // Logout ends the session and every workspace entered under it.
      await f
        .http()
        .post('/api/v1/auth/logout')
        .set(f.bearer(owner.token))
        .expect(200);
      expect(await redis.get(`workspace_session:${tab3}`)).toBeNull();
    });

    it('with the flag off, nothing needs a workspace (the current web app keeps working)', async () => {
      await setFlag(false);
      try {
        const s = await f.store();
        await f
          .http()
          .get(`/api/v1/vendors/${s.vendorId}/notifications`)
          .set(ws(s.owner.token))
          .expect(200);
      } finally {
        await setFlag(true);
      }
    });
  });

  // Regression (2026-11-18): a STORE «المخزون منخفض» (LOW_STOCK_AFTER_RESERVE)
  // showed in an owner's SHOPPING bell on a database where
  // workspace_scoping_enabled had never been switched on - the shopping
  // bell then fell back to "every notification of the user". The bell is
  // CUSTOMER-only now whatever the flag; these cases run both ways.
  describe('the shopping bell is CUSTOMER-only with the flag off or on (low-stock regression)', () => {
    afterAll(() => setFlag(true));

    for (const flagOn of [false, true]) {
      const mode = flagOn ? 'flag on' : 'flag off';

      it(`${mode}: a customer who owns a store - the STORE low-stock notice is never listed, counted or markable in the shopping bell (even with a workspace open in another tab; its token on the bell is refused); the store inbox has it`, async () => {
        await setFlag(flagOn);
        const s = await f.store();
        const owner = s.owner;
        const lowStock = await note(
          owner,
          'STORE',
          'LOW_STOCK_AFTER_RESERVE',
          s.vendorId,
          s.branchA,
        );
        const mine = await note(owner, 'CUSTOMER', 'RETURN_APPROVED');
        const bell = ws(owner.token);
        const inbox = `vendors/${s.vendorId}/notifications`;

        const shopping = async (headers: Record<string, string>) => {
          expect(await listIds('me/notifications', headers)).toEqual([mine.id]);
          expect(await count('me/notifications', headers)).toBe(1);
          const unreadOnly = await f
            .http()
            .get('/api/v1/me/notifications?unread_only=true')
            .set(headers)
            .expect(200);
          expect(
            (unreadOnly.body.items as { audience: string }[]).every(
              (i) => i.audience === 'CUSTOMER',
            ),
          ).toBe(true);
          await markRead('me/notifications', lowStock.id, headers).expect(404);
        };
        await shopping(bell);

        // A store workspace opened in another tab - and even its token
        // sent along by mistake - does not change the shopping bell.
        const tab = await f.enter(owner, {
          type: 'vendor',
          vendor_id: s.vendorId,
        });
        await shopping(bell);
        // its token sent to a shopping route is refused outright - never a
        // store row in the bell
        const refused = await f
          .http()
          .get('/api/v1/me/notifications')
          .set(ws(owner.token, tab))
          .expect(403);
        expect(refused.body.error?.code ?? refused.body.code).toBe(
          'SHOPPING_REQUIRED',
        );
        expect(await listIds(inbox, ws(owner.token, tab))).toEqual([
          lowStock.id,
        ]);
        // Leaving the workspace does not change it either.
        await f
          .http()
          .delete('/api/v1/me/workspace-sessions/current')
          .set(ws(owner.token, tab))
          .expect(204);
        await shopping(bell);

        // The notice stayed unread: nothing in the bell touched it.
        expect(
          (
            await prisma.notification.findUniqueOrThrow({
              where: { id: lowStock.id },
            })
          ).readAt,
        ).toBeNull();
      });

      it(`${mode}: an employee who is also a customer - no STORE row in the shopping bell; in the workspace only their own branch`, async () => {
        await setFlag(flagOn);
        const s = await f.store();
        const employee = await f.member(
          s.vendorId,
          await f.account(),
          'BRANCH_EMPLOYEE',
          s.branchA,
        );
        const ownBranch = await note(
          employee,
          'STORE',
          'LOW_STOCK_AFTER_RESERVE',
          s.vendorId,
          s.branchA,
        );
        const otherBranch = await note(
          employee,
          'STORE',
          'LOW_STOCK_AFTER_RESERVE',
          s.vendorId,
          s.branchB,
        );
        const mine = await note(employee, 'CUSTOMER', 'FAVORITE_PRICE_DROP');
        const bell = ws(employee.token);
        expect(await listIds('me/notifications', bell)).toEqual([mine.id]);
        expect(await count('me/notifications', bell)).toBe(1);
        for (const id of [ownBranch.id, otherBranch.id]) {
          await markRead('me/notifications', id, bell).expect(404);
        }

        const tab = await f.enter(employee, {
          type: 'vendor',
          vendor_id: s.vendorId,
        });
        const store = ws(employee.token, tab);
        const inbox = `vendors/${s.vendorId}/notifications`;
        expect(await listIds(inbox, store)).toEqual([ownBranch.id]);
        expect(await count(inbox, store)).toBe(1);
        await markRead(inbox, otherBranch.id, store).expect(404);
        await markRead(inbox, mine.id, store).expect(404);
        await markRead(inbox, ownBranch.id, store).expect(200);
        // The shopping bell never moved.
        expect(await listIds('me/notifications', bell)).toEqual([mine.id]);
        expect(await count('me/notifications', bell)).toBe(1);
      });
    }
  });

  describe('notification scoping (flag on)', () => {
    beforeAll(() => setFlag(true));

    it('multi-store owner who is also a platform admin: the bell shows CUSTOMER only, each store workspace its own STORE rows only, the platform workspace PLATFORM only - list, count and mark-read alike; nothing of another context opens by id', async () => {
      const owner = await f.account('PLATFORM_ADMIN');
      const s1 = await f.store(owner);
      const s2 = await f.store(owner);
      const n = {
        customer: await note(
          owner,
          'CUSTOMER',
          'RETURN_APPROVED',
          s1.vendorId,
          s1.branchA,
        ),
        s1a: await note(
          owner,
          'STORE',
          'NEW_ORDER_FOR_EMPLOYEE',
          s1.vendorId,
          s1.branchA,
        ),
        s1b: await note(
          owner,
          'STORE',
          'RETURN_REQUESTED',
          s1.vendorId,
          s1.branchB,
        ),
        s1wide: await note(
          owner,
          'STORE',
          'VENDOR_SUSPENDED',
          s1.vendorId,
          null,
        ),
        s2: await note(
          owner,
          'STORE',
          'NEW_ORDER_FOR_EMPLOYEE',
          s2.vendorId,
          s2.branchA,
        ),
        platform: await note(owner, 'PLATFORM', 'ORDER_INTEGRITY_ALERT'),
        // ORDER_CANCELLED to the same person in both roles: one per context.
        cancelledAsCustomer: await note(
          owner,
          'CUSTOMER',
          'ORDER_CANCELLED',
          s1.vendorId,
          s1.branchA,
        ),
        cancelledAsStore: await note(
          owner,
          'STORE',
          'ORDER_CANCELLED',
          s1.vendorId,
          s1.branchA,
        ),
      };
      const t1 = await f.enter(owner, {
        type: 'vendor',
        vendor_id: s1.vendorId,
      });
      const t2 = await f.enter(owner, {
        type: 'vendor',
        vendor_id: s2.vendorId,
      });
      const p = await f.enter(owner, { type: 'platform' });
      const bell = ws(owner.token);
      const store1 = ws(owner.token, t1);
      const store2 = ws(owner.token, t2);
      const platform = ws(owner.token, p);
      const v1 = `vendors/${s1.vendorId}/notifications`;
      const v2 = `vendors/${s2.vendorId}/notifications`;

      expect(await listIds('me/notifications', bell)).toEqual(
        sorted(n.customer.id, n.cancelledAsCustomer.id),
      );
      expect(await listIds(v1, store1)).toEqual(
        sorted(n.s1a.id, n.s1b.id, n.s1wide.id, n.cancelledAsStore.id),
      );
      expect(await listIds(v2, store2)).toEqual([n.s2.id]);
      expect(await listIds('admin/notifications', platform)).toEqual([
        n.platform.id,
      ]);
      expect(await count('me/notifications', bell)).toBe(2);
      expect(await count(v1, store1)).toBe(4);
      expect(await count(v2, store2)).toBe(1);
      expect(await count('admin/notifications', platform)).toBe(1);

      // Every row of another context is a 404 - and stays unread.
      for (const id of [n.s1a.id, n.s2.id, n.platform.id]) {
        await markRead('me/notifications', id, bell).expect(404);
      }
      for (const id of [n.customer.id, n.s2.id, n.platform.id]) {
        await markRead(v1, id, store1).expect(404);
      }
      for (const id of [n.customer.id, n.s1a.id]) {
        await markRead('admin/notifications', id, platform).expect(404);
      }
      const unread = await prisma.notification.count({
        where: { recipientUserId: owner.userId, readAt: null },
      });
      expect(unread).toBe(8);
      // In its own context: marked, idempotently.
      await markRead(v1, n.s1a.id, store1).expect(200);
      await markRead(v1, n.s1a.id, store1).expect(200);
      expect(await count(v1, store1)).toBe(3);
      expect(await count('me/notifications', bell)).toBe(2);
      await markRead('me/notifications', n.customer.id, bell).expect(200);
      expect(await count('me/notifications', bell)).toBe(1);
      expect(await count(v1, store1)).toBe(3);

      // Links: every listed row belongs to the workspace it was listed in.
      const res = await f.http().get(`/api/v1/${v1}`).set(store1).expect(200);
      for (const item of res.body.items) {
        expect(item.audience).toBe('STORE');
        expect(item.vendor_id).toBe(s1.vendorId);
      }
    });

    it('employees: only their own branch of their own store - not branch B, not the store-wide owner notices, not another store; an employee of a different store sees only theirs', async () => {
      const s1 = await f.store();
      const s2 = await f.store();
      const employee = await f.member(
        s1.vendorId,
        await f.account(),
        'BRANCH_EMPLOYEE',
        s1.branchA,
      );
      // An employee belongs to ONE store (vendor_users_employee_userId_key
      // - the database refuses a second), so "employee elsewhere" is a
      // different person.
      await expect(
        f.member(s2.vendorId, employee, 'BRANCH_EMPLOYEE', s2.branchB),
      ).rejects.toThrow(/vendor_users_employee_userId_key/);
      const employee2 = await f.member(
        s2.vendorId,
        await f.account(),
        'BRANCH_EMPLOYEE',
        s2.branchB,
      );
      const other = await f.member(
        s1.vendorId,
        await f.account(),
        'BRANCH_EMPLOYEE',
        s1.branchB,
      );
      const n = {
        s1a: await note(
          employee,
          'STORE',
          'NEW_ORDER_FOR_EMPLOYEE',
          s1.vendorId,
          s1.branchA,
        ),
        s1b: await note(
          employee,
          'STORE',
          'NEW_ORDER_FOR_EMPLOYEE',
          s1.vendorId,
          s1.branchB,
        ),
        s1wide: await note(
          employee,
          'STORE',
          'VENDOR_SUSPENDED',
          s1.vendorId,
          null,
        ),
        s2b: await note(
          employee,
          'STORE',
          'RETURN_REQUESTED',
          s2.vendorId,
          s2.branchB,
        ),
        s2a: await note(
          employee,
          'STORE',
          'RETURN_REQUESTED',
          s2.vendorId,
          s2.branchA,
        ),
        customer: await note(
          employee,
          'CUSTOMER',
          'REVIEW_INVITATION',
          s1.vendorId,
          s1.branchA,
        ),
        otherB: await note(
          other,
          'STORE',
          'NEW_ORDER_FOR_EMPLOYEE',
          s1.vendorId,
          s1.branchB,
        ),
      };
      const t1 = await f.enter(employee, {
        type: 'vendor',
        vendor_id: s1.vendorId,
      });
      const e2b = await note(
        employee2,
        'STORE',
        'RETURN_REQUESTED',
        s2.vendorId,
        s2.branchB,
      );
      const t2 = await f.enter(employee2, {
        type: 'vendor',
        vendor_id: s2.vendorId,
      });
      const v1 = `vendors/${s1.vendorId}/notifications`;
      const v2 = `vendors/${s2.vendorId}/notifications`;
      expect(await listIds(v1, ws(employee.token, t1))).toEqual([n.s1a.id]);
      expect(await listIds(v2, ws(employee2.token, t2))).toEqual([e2b.id]);
      // Rows about store 2 addressed to the store-1 employee never open:
      // store 2 is not their workspace at all.
      await f
        .http()
        .get(`/api/v1/${v2}`)
        .set(ws(employee.token, t1))
        .expect(403);
      await markRead(v2, e2b.id, ws(employee.token, t1)).expect(403);
      expect(await count(v1, ws(employee.token, t1))).toBe(1);
      for (const id of [
        n.s1b.id,
        n.s1wide.id,
        n.s2b.id,
        n.s2a.id,
        e2b.id,
        n.customer.id,
        n.otherB.id,
      ]) {
        await markRead(v1, id, ws(employee.token, t1)).expect(404);
      }
      expect(await listIds('me/notifications', ws(employee.token))).toEqual([
        n.customer.id,
      ]);
      // The other employee's own row never shows to this one, and vice versa.
      const t3 = await f.enter(other, {
        type: 'vendor',
        vendor_id: s1.vendorId,
      });
      expect(await listIds(v1, ws(other.token, t3))).toEqual([n.otherB.id]);
      // Not a member of a store at all: refused before any notification is read.
      const stranger = await f.account();
      await f
        .http()
        .get(`/api/v1/${v1}`)
        .set(ws(stranger.token))
        .expect(403)
        .expect((r) => expect(r.body.error.code).toBe('NOT_VENDOR_MEMBER'));
    });

    it('a platform alert is listed in the platform workspace, never in the admin shopping bell; a deactivated account sees none', async () => {
      const admin = await f.account('PLATFORM_ADMIN');
      const row = await note(admin, 'PLATFORM', 'RETURN_ESCALATION_ALERT');
      const p = await f.enter(admin, { type: 'platform' });
      expect(await listIds('admin/notifications', ws(admin.token, p))).toEqual([
        row.id,
      ]);
      expect(await listIds('me/notifications', ws(admin.token))).toEqual([]);
      await prisma.user.update({
        where: { id: admin.userId },
        data: { deactivatedAt: new Date() },
      });
      expect(await listIds('admin/notifications', ws(admin.token, p))).toEqual(
        [],
      );
      await markRead('admin/notifications', row.id, ws(admin.token, p)).expect(
        404,
      );
    });

    // 2026-11-18: no flag-off fallback any more - the bell is CUSTOMER-only
    // with the flag off too (the low-stock regression; see the describe above).
    it('with the flag off the bell is still CUSTOMER-only (no pre-TB-26 fallback): no STORE or PLATFORM row', async () => {
      await setFlag(false);
      try {
        const owner = await f.account();
        const s = await f.store(owner);
        const c = await note(owner, 'CUSTOMER', 'RETURN_APPROVED');
        const st = await note(
          owner,
          'STORE',
          'NEW_ORDER_FOR_EMPLOYEE',
          s.vendorId,
          s.branchA,
        );
        await note(owner, 'PLATFORM', 'ORDER_INTEGRITY_ALERT');
        expect(await listIds('me/notifications', ws(owner.token))).toEqual([
          c.id,
        ]);
        await markRead('me/notifications', st.id, ws(owner.token)).expect(404);
      } finally {
        await setFlag(true);
      }
    });
  });

  describe('senders set the audience', () => {
    beforeAll(() => setFlag(true));

    it('real flows write the audience the sender means: the customer cancelling notifies the branch team as STORE; a self-purchase is shopping (no workspace) and its cancellation is still a STORE notice to the team; staff cancelling notifies the customer as CUSTOMER', async () => {
      const owner = await f.account();
      const s = await f.store(owner);
      const employee = await f.member(
        s.vendorId,
        await f.account(),
        'BRANCH_EMPLOYEE',
        s.branchA,
      );
      const variant = await f.offer(s);
      const customer = await f.account();

      const placed = await f.buy(customer, s, variant);
      await f
        .http()
        .post(`/api/v1/customers/me/orders/${placed.branchOrderId}/cancel`)
        .set(f.bearer(customer.token))
        .set('Idempotency-Key', f.unique('c'))
        .send({})
        .expect(201);
      // The owner buys from their own store - SHOPPING, the session alone.
      const own = await f.buy(owner, s, variant);
      await f
        .http()
        .post(`/api/v1/customers/me/orders/${own.branchOrderId}/cancel`)
        .set(f.bearer(owner.token))
        .set('Idempotency-Key', f.unique('c'))
        .send({})
        .expect(201);
      // Staff cancels the customer's next order (in the workspace).
      const third = await f.buy(customer, s, variant);
      const t = await f.enter(employee, {
        type: 'vendor',
        vendor_id: s.vendorId,
      });
      await f
        .staff(s, employee, third.branchOrderId, 'cancel', {}, t)
        .expect(201);
      await drain();

      const rows = await prisma.notification.findMany({
        where: {
          targetId: {
            in: [placed.branchOrderId, own.branchOrderId, third.branchOrderId],
          },
          type: 'ORDER_CANCELLED',
        },
      });
      const of = (orderId: string) =>
        rows
          .filter((r) => r.targetId === orderId)
          .map(
            (r) =>
              `${r.recipientUserId === owner.userId ? 'owner' : r.recipientUserId === employee.userId ? 'employee' : 'customer'}:${r.audience}`,
          )
          .sort();
      expect(of(placed.branchOrderId)).toEqual([
        'employee:STORE',
        'owner:STORE',
      ]);
      expect(of(own.branchOrderId)).toEqual(['employee:STORE', 'owner:STORE']);
      expect(of(third.branchOrderId)).toEqual(['customer:CUSTOMER']);
      // Other types: each row's audience is the one its type has.
      const all = await prisma.notification.findMany({
        where: { vendorId: s.vendorId },
      });
      for (const r of all.filter((x) => x.type !== 'ORDER_CANCELLED')) {
        expect(`${r.type}:${r.audience}`).toBe(
          `${r.type}:${NOTIFICATION_AUDIENCE_BY_TYPE[r.type]}`,
        );
      }
      // The owner's own customer bell shows none of the store notices.
      expect(await listIds('me/notifications', ws(owner.token))).toEqual(
        (
          await prisma.notification.findMany({
            where: { recipientUserId: owner.userId, audience: 'CUSTOMER' },
          })
        )
          .map((r) => r.id)
          .sort(),
      );
    });

    it('an event without an audience is refused by the relay (an error, never a guess from its type)', async () => {
      const u = await f.account();
      const e = await prisma.outboxEvent.create({
        data: {
          eventType: 'return.approved',
          payload: { return_id: 'r', recipient_user_id: u.userId },
        },
      });
      await drain();
      const row = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: e.id },
      });
      expect(row.status).toBe('FAILED');
      expect(row.lastError).toContain('missing or invalid audience');
      expect(
        await prisma.notification.count({ where: { outboxEventId: e.id } }),
      ).toBe(0);
      // And the enqueue API itself always writes it.
      const written = await app.get(OutboxEventService).enqueue({
        eventType: 'return.approved',
        audience: 'CUSTOMER',
        payload: { return_id: 'r', recipient_user_id: u.userId },
      });
      expect((written.payload as Record<string, unknown>).audience).toBe(
        'CUSTOMER',
      );
    });
  });

  describe('SHOPPING_REQUIRED', () => {
    beforeAll(() => setFlag(true));

    const shoppingCalls = (who: { token: string }, workspace?: string) => [
      f.http().get('/api/v1/cart').set(ws(who.token, workspace)),
      f.http().get('/api/v1/favorites').set(ws(who.token, workspace)),
      f.http().get('/api/v1/customers/me/orders').set(ws(who.token, workspace)),
      f
        .http()
        .get('/api/v1/customers/me/returns')
        .set(ws(who.token, workspace)),
      f.http().get('/api/v1/me/notifications').set(ws(who.token, workspace)),
      f
        .http()
        .get('/api/v1/me/notifications/unread-count')
        .set(ws(who.token, workspace)),
      f
        .http()
        .post('/api/v1/cart/items')
        .set(ws(who.token, workspace))
        .set('Idempotency-Key', f.unique('cart'))
        .send({ vendor_id: 'x', offer_variant_id: 'x', quantity: 1 }),
    ];

    it('the session alone is shopping: cart, favorites, orders, returns and the customer bell work with no workspace token', async () => {
      const s = await f.store();
      const results = await Promise.all(shoppingCalls(s.owner).slice(0, 6));
      expect(results.map((r) => r.status)).toEqual([
        200, 200, 200, 200, 200, 200,
      ]);
    });

    it('a live store or platform workspace token on a shopping route is refused with SHOPPING_REQUIRED - reads and writes alike - while the same token still opens its workspace', async () => {
      const owner = await f.account('PLATFORM_ADMIN');
      const s = await f.store(owner);
      const store = await f.enter(owner, {
        type: 'vendor',
        vendor_id: s.vendorId,
      });
      const platform = await f.enter(owner, { type: 'platform' });
      for (const token of [store, platform]) {
        const results = await Promise.all(shoppingCalls(owner, token));
        expect(results.map((r) => [r.status, r.body.error?.code])).toEqual(
          results.map(() => [403, 'SHOPPING_REQUIRED']),
        );
      }
      expect(
        await prisma.cartItem.count({
          where: { customerId: owner.customerId },
        }),
      ).toBe(0);
      await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/notifications`)
        .set(ws(owner.token, store))
        .expect(200);
      await f
        .http()
        .get('/api/v1/admin/notifications')
        .set(ws(owner.token, platform))
        .expect(200);
    });

    it('also with workspace_scoping_enabled off', async () => {
      await setFlag(false);
      try {
        const s = await f.store();
        const t = await f.enter(s.owner, {
          type: 'vendor',
          vendor_id: s.vendorId,
        });
        await f
          .http()
          .get('/api/v1/cart')
          .set(ws(s.owner.token, t))
          .expect(403)
          .expect((r) => expect(r.body.error.code).toBe('SHOPPING_REQUIRED'));
      } finally {
        await setFlag(true);
      }
    });

    it('a token that is not a live token of THIS session changes nothing (left, expired, another session, made up): the request is shopping', async () => {
      const owner = await f.account();
      const s = await f.store(owner);
      const left = await f.enter(owner, {
        type: 'vendor',
        vendor_id: s.vendorId,
      });
      await f
        .http()
        .delete('/api/v1/me/workspace-sessions/current')
        .set(ws(owner.token, left))
        .expect(204);
      const other = await f.newSession(owner.userId);
      const otherToken = await f.enter(
        { token: other },
        { type: 'vendor', vendor_id: s.vendorId },
      );
      for (const token of [left, otherToken, 'made-up-token']) {
        await f
          .http()
          .get('/api/v1/cart')
          .set(ws(owner.token, token))
          .expect(200);
      }
    });

    it('the neutral routes accept a workspace request: the workspace list, entering another workspace, leaving, logout', async () => {
      const owner = await f.account();
      const s1 = await f.store(owner);
      const s2 = await f.store(owner);
      const t = await f.enter(owner, {
        type: 'vendor',
        vendor_id: s1.vendorId,
      });
      await f
        .http()
        .get('/api/v1/me/workspaces')
        .set(ws(owner.token, t))
        .expect(200);
      await f
        .http()
        .post('/api/v1/me/workspace-sessions')
        .set(ws(owner.token, t))
        .send({ type: 'vendor', vendor_id: s2.vendorId })
        .expect(201);
      await f
        .http()
        .delete('/api/v1/me/workspace-sessions/current')
        .set(ws(owner.token, t))
        .expect(204);
      const t2 = await f.enter(owner, {
        type: 'vendor',
        vendor_id: s1.vendorId,
      });
      await f
        .http()
        .post('/api/v1/auth/logout')
        .set(ws(owner.token, t2))
        .expect(200);
    });
  });

  describe('route inventory', () => {
    function routes() {
      const container = app.get(ModulesContainer);
      const out: {
        key: string;
        guards: unknown[];
        platformRoles: unknown;
        neutral: boolean;
      }[] = [];
      for (const module of container.values()) {
        for (const wrapper of module.controllers.values()) {
          const metatype = wrapper.metatype as
            (new (...a: never[]) => object) | null;
          if (!metatype) continue;
          const base = Reflect.getMetadata(PATH_METADATA, metatype) as
            string | string[];
          const classGuards =
            (Reflect.getMetadata(GUARDS_METADATA, metatype) as unknown[]) ?? [];
          for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
            const handler = (metatype.prototype as Record<string, unknown>)[
              name
            ];
            if (name === 'constructor' || typeof handler !== 'function')
              continue;
            const method = Reflect.getMetadata(METHOD_METADATA, handler) as
              RequestMethod | undefined;
            if (method === undefined) continue;
            const sub = Reflect.getMetadata(PATH_METADATA, handler) as
              string | string[];
            const path = [base, sub]
              .map((p) => (Array.isArray(p) ? p[0] : p) ?? '')
              .map((p) => p.replace(/^\/+|\/+$/g, ''))
              .filter(Boolean)
              .join('/');
            out.push({
              key: `${RequestMethod[method]} ${path}`,
              guards: [
                ...classGuards,
                ...((Reflect.getMetadata(
                  GUARDS_METADATA,
                  handler,
                ) as unknown[]) ?? []),
              ],
              platformRoles: Reflect.getMetadata(PLATFORM_ROLES_KEY, handler),
              neutral:
                Reflect.getMetadata(WORKSPACE_NEUTRAL_KEY, handler) === true ||
                Reflect.getMetadata(WORKSPACE_NEUTRAL_KEY, metatype) === true,
            });
          }
        }
      }
      return out;
    }

    it('every vendors/:vendorId route is a store-workspace route (VendorMembershipGuard) or a platform-workspace route (PlatformRoleGuard with a role - the verification decisions), except the listed public reads', () => {
      const vendor = routes().filter((r) =>
        r.key.split(' ')[1].startsWith('vendors/:vendorId'),
      );
      expect(vendor.length).toBeGreaterThan(50);
      const open = vendor
        .filter(
          (r) =>
            !r.guards.includes(VendorMembershipGuard) &&
            !(
              r.guards.includes(PlatformRoleGuard) &&
              Array.isArray(r.platformRoles) &&
              (r.platformRoles as unknown[]).length > 0
            ),
        )
        .map((r) => r.key)
        .sort();
      expect(open).toEqual([...PUBLIC_VENDOR_ROUTES].sort());
    });

    it('the routes a workspace request may reach besides workspace routes are exactly the listed neutral ones', () => {
      const neutral = routes()
        .filter((r) => r.neutral)
        .map((r) => r.key)
        .sort();
      expect(neutral).toEqual(
        [
          'GET me/workspaces',
          'POST me/workspace-sessions',
          'DELETE me/workspace-sessions/current',
          'POST auth/logout',
        ].sort(),
      );
    });

    it('every admin/* route is a platform-workspace route (PlatformRoleGuard with a required role)', () => {
      const admin = routes().filter((r) =>
        r.key.split(' ')[1].startsWith('admin'),
      );
      expect(admin.length).toBeGreaterThan(20);
      const open = admin
        .filter(
          (r) =>
            !r.guards.includes(PlatformRoleGuard) ||
            !Array.isArray(r.platformRoles) ||
            (r.platformRoles as unknown[]).length === 0,
        )
        .map((r) => r.key);
      expect(open).toEqual([]);
    });
  });
});
