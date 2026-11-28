import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { CURRENT_PLATFORM_TERMS_VERSION } from './../src/checkout/checkout.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
// POST /auth/login accepts Palestinian mobile numbers only (helpers/
// test-phone's +999 numbers cannot sign in). Like admin-account-me, this
// file takes numbers no e2e-phone-lane uses: +97059 999xxxx.
const RUN_STAMP = Date.now() % 100;
let phoneSeq = 0;
function uniqueTestPhone(): string {
  phoneSeq += 1;
  if (phoneSeq >= 99)
    throw new Error('users-settings-3: phone budget exhausted');
  return `+97059${9_990_000 + RUN_STAMP * 99 + phoneSeq}`;
}

// VIA phase 3 - Users Management + Settings & Team:
//  - every admin API is PLATFORM_ADMIN only (a reviewer keeps their own
//    account and the verification queue);
//  - suspend / lift / force sign-out: reasons, audit, sessionVersion, the
//    login and every other session issuance refused while suspended;
//  - PLATFORM_ADMIN accounts protected; the sole enabled owner of a
//    non-cancelled store never suspended - also under concurrency;
//  - the user's own deactivation respected (lifting never undoes it);
//  - the read-only team; alert recipients with their fallback.

const PASSWORD = 'a-strong-password';
let seq = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++seq}`;

describe('Phase 3 - Users Management + Settings & Team (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwordHash: string;

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
    passwordHash = await bcrypt.hash(PASSWORD, 10);
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function account(
    platformRole: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER' | null = null,
    displayName = 'حساب الاختبار',
  ) {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash, phoneVerifiedAt: new Date(), platformRole },
    });
    const profile = await prisma.customerProfile.create({
      data: { userId: user.id, displayName },
    });
    // A fixture session through the one issuance point (SessionService);
    // the real login is exercised where a test is about it.
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { id: user.id, phone, profileId: profile.id, token };
  }

  /** The real password login (POST /auth/login). */
  async function login(phone: string): Promise<string> {
    const res = await request(http())
      .post('/api/v1/auth/login')
      .send({ phone, password: PASSWORD });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(
        `login failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return res.body.session_token as string;
  }

  async function storeOwnedBy(
    ownerIds: string[],
    status: 'ACTIVE' | 'CANCELLED' = 'ACTIVE',
  ) {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('usr').toLowerCase(),
        legalName: unique('متجر'),
        displayName: unique('متجر المستخدمين'),
        status,
        subscriptionStatus: 'ACTIVE',
      },
    });
    for (const userId of ownerIds) {
      await prisma.vendorUser.create({
        data: { vendorId: vendor.id, userId, role: 'OWNER' },
      });
    }
    return vendor;
  }

  const me = (token: string) =>
    request(http()).get('/api/v1/customers/me').set(auth(token));
  const post = (token: string, path: string, body: object) =>
    request(http())
      .post(`/api/v1/admin/users/${path}`)
      .set(auth(token))
      .set('Idempotency-Key', unique('k'))
      .send(body);
  const suspend = (
    token: string,
    id: string,
    reason = 'مخالفة شروط الاستخدام',
  ) => post(token, `${id}/suspend`, { reason });
  const lift = (token: string, id: string) =>
    post(token, `${id}/lift-suspension`, { note: 'تمت مراجعة الحالة' });
  const signOut = (token: string, id: string) =>
    post(token, `${id}/force-sign-out`, { reason: 'جهاز مفقود' });
  const auditCount = (entityId: string, action: string) =>
    prisma.auditLog.count({ where: { entityId, action } });

  describe('authorization (every API, not only the screens)', () => {
    it('admin APIs: 401 without a session; 403 for a customer, a store owner and a reviewer; 200 for an admin', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const reviewer = await account('VERIFICATION_REVIEWER');
      const customer = await account();
      const owner = await account();
      await storeOwnedBy([owner.id]);
      const target = await account();

      const reads = [
        '/api/v1/admin/users',
        `/api/v1/admin/users/${target.id}`,
        '/api/v1/admin/team',
        '/api/v1/admin/feature-flags',
        '/api/v1/admin/alert-recipients',
        '/api/v1/admin/audit-logs',
      ];
      for (const path of reads) {
        await request(http()).get(path).expect(401);
        for (const who of [customer, owner, reviewer]) {
          await request(http()).get(path).set(auth(who.token)).expect(403);
        }
        await request(http()).get(path).set(auth(admin.token)).expect(200);
      }
      for (const action of ['suspend', 'lift-suspension', 'force-sign-out']) {
        const body =
          action === 'lift-suspension'
            ? { note: 'ملاحظة كافية' }
            : { reason: 'سبب كافٍ للاختبار' };
        await request(http())
          .post(`/api/v1/admin/users/${target.id}/${action}`)
          .send(body)
          .expect(401);
        for (const who of [customer, owner, reviewer]) {
          await post(who.token, `${target.id}/${action}`, body).expect(403);
        }
      }
      // Nothing happened to the target.
      const t = await prisma.user.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(t.suspendedAt).toBeNull();
      await me(target.token).expect(200);

      // A reviewer keeps their own account and the verification queue.
      await me(reviewer.token).expect(200);
      await request(http())
        .get('/api/v1/admin/verification-queue')
        .set(auth(reviewer.token))
        .expect(200);
    });
  });

  describe('directory and detail', () => {
    it('filters by role, membership and state; phone digits search; phones always masked; cursor pages', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const name = unique('ريم');
      const customer = await account(null, name);
      const owner = await account(null, `${name}-مالكة`);
      const co = await account();
      await storeOwnedBy([owner.id, co.id]);

      const byName = await request(http())
        .get('/api/v1/admin/users')
        .query({ q: name })
        .set(auth(admin.token))
        .expect(200);
      expect(byName.body.items.map((u: { id: string }) => u.id).sort()).toEqual(
        [customer.id, owner.id].sort(),
      );
      const json = JSON.stringify(byName.body);
      expect(json).not.toContain(customer.phone);
      expect(json).not.toContain(owner.phone);

      const byPhone = await request(http())
        .get('/api/v1/admin/users')
        .query({ q: customer.phone.slice(-7) })
        .set(auth(admin.token))
        .expect(200);
      expect(byPhone.body.items.map((u: { id: string }) => u.id)).toContain(
        customer.id,
      );

      const owners = await request(http())
        .get('/api/v1/admin/users')
        .query({ q: name, role: 'store_owner' })
        .set(auth(admin.token))
        .expect(200);
      expect(owners.body.items.map((u: { id: string }) => u.id)).toEqual([
        owner.id,
      ]);
      const customersOnly = await request(http())
        .get('/api/v1/admin/users')
        .query({ q: name, role: 'customer' })
        .set(auth(admin.token))
        .expect(200);
      expect(customersOnly.body.items.map((u: { id: string }) => u.id)).toEqual(
        [customer.id],
      );

      await suspend(admin.token, customer.id).expect(201);
      const suspended = await request(http())
        .get('/api/v1/admin/users')
        .query({ q: name, status: 'SUSPENDED' })
        .set(auth(admin.token))
        .expect(200);
      expect(suspended.body.items.map((u: { id: string }) => u.id)).toEqual([
        customer.id,
      ]);

      // Cursor pages over the two matches.
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await request(http())
          .get('/api/v1/admin/users')
          .query({ q: name, limit: '1', ...(cursor ? { cursor } : {}) })
          .set(auth(admin.token))
          .expect(200);
        seen.push(...page.body.items.map((u: { id: string }) => u.id));
        cursor = page.body.next_cursor;
      } while (cursor);
      expect(seen.sort()).toEqual([customer.id, owner.id].sort());

      for (const bad of [
        { role: 'god' },
        { status: 'BANNED' },
        { cursor: 'x' },
      ]) {
        await request(http())
          .get('/api/v1/admin/users')
          .query(bad)
          .set(auth(admin.token))
          .expect(400);
      }
    });

    it('detail: a dual-role account shows its store work (memberships) apart from its own purchases (orders)', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const dual = await account(null, 'مالكة وزبونة');
      const co = await account();
      const ownStore = await storeOwnedBy([dual.id, co.id]);

      // A purchase from another store, through the real checkout.
      const seller = await account();
      const shop = await storeOwnedBy([seller.id]);
      const branch = await prisma.storeBranch.create({
        data: {
          vendorId: shop.id,
          name: unique('فرع'),
          isPhysical: true,
          verificationStatus: 'APPROVED',
        },
      });
      await prisma.vendor.update({
        where: { id: shop.id },
        data: {
          storefrontPublished: true,
          whatsappUrl: 'https://wa.me/970599000000',
        },
      });
      const offer = await prisma.vendorOffer.create({
        data: {
          vendorId: shop.id,
          titleAr: 'حذاء',
          titleEn: 'Shoe',
          status: 'ACTIVE',
          firstPublishedAt: new Date(),
        },
      });
      const variant = await prisma.offerVariant.create({
        data: {
          vendorId: shop.id,
          vendorOfferId: offer.id,
          sellerSku: unique('s'),
          storeInventoryBarcode: unique('b'),
          basePrice: 50,
        },
      });
      await prisma.branchStock.create({
        data: {
          vendorId: shop.id,
          branchId: branch.id,
          offerVariantId: variant.id,
          quantity: 5,
        },
      });
      const line = await request(http())
        .post('/api/v1/cart/items')
        .set(auth(dual.token))
        .set('Idempotency-Key', unique('cart'))
        .send({ vendor_id: shop.id, offer_variant_id: variant.id, quantity: 1 })
        .expect(201);
      const reserved = await request(http())
        .post('/api/v1/checkout/reserve')
        .set(auth(dual.token))
        .set('Idempotency-Key', unique('reserve'))
        .send({
          terms_accepted: true,
          terms_version: CURRENT_PLATFORM_TERMS_VERSION,
          groups: [
            {
              cart_item_ids: [line.body.id],
              branch_id: branch.id,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);
      const confirmed = await request(http())
        .post('/api/v1/checkout/confirm')
        .set(auth(dual.token))
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id })
        .expect(201);

      const d = (
        await request(http())
          .get(`/api/v1/admin/users/${dual.id}`)
          .set(auth(admin.token))
          .expect(200)
      ).body;
      expect(d.memberships).toEqual([
        expect.objectContaining({ store_id: ownStore.id, role: 'OWNER' }),
      ]);
      expect(d.recent_orders).toEqual([
        expect.objectContaining({
          id: confirmed.body.branch_orders[0].id,
          store_name: shop.displayName,
          total: 50,
        }),
      ]);
      expect(d.counts.orders).toBe(1);
      expect(d.phone_masked).toMatch(/•/);
      expect(JSON.stringify(d)).not.toContain(dual.phone);
      expect(d.actions).toMatchObject({
        protected: false,
        sole_owner_of: [],
        can_suspend: true,
      });
      await request(http())
        .get('/api/v1/admin/users/00000000-0000-0000-0000-000000000000')
        .set(auth(admin.token))
        .expect(404);
    });
  });

  describe('suspend, lift, force sign-out', () => {
    it('suspension: reason required; every session ends; login and every other issuance refused; audited once even when retried', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const u = await account();
      const second = await login(u.phone); // a second device
      await me(u.token).expect(200);

      await post(admin.token, `${u.id}/suspend`, { reason: ' ' }).expect(400);
      await post(admin.token, `${u.id}/suspend`, {}).expect(400);

      const key = unique('suspend');
      const first = await request(http())
        .post(`/api/v1/admin/users/${u.id}/suspend`)
        .set(auth(admin.token))
        .set('Idempotency-Key', key)
        .send({ reason: 'احتيال في الطلبات' })
        .expect(201);
      // The same request retried: the same answer, nothing done twice.
      const retry = await request(http())
        .post(`/api/v1/admin/users/${u.id}/suspend`)
        .set(auth(admin.token))
        .set('Idempotency-Key', key)
        .send({ reason: 'احتيال في الطلبات' });
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
      expect(await auditCount(u.id, 'user.suspended_by_platform')).toBe(1);

      // Both devices are out.
      for (const token of [u.token, second]) {
        const r = await me(token).expect(401);
        expect(['SESSION_INVALID', 'ACCOUNT_SUSPENDED']).toContain(
          r.body.error.code,
        );
      }
      expect(await app.get(SessionService).get(u.token)).toBeNull();
      // The login refuses, and so does any other issuance path.
      const l = await request(http())
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: PASSWORD })
        .expect(403);
      expect(l.body.error.code).toBe('ACCOUNT_SUSPENDED');
      const fresh = await prisma.user.findUniqueOrThrow({
        where: { id: u.id },
      });
      await expect(
        app.get(SessionService).create({
          userId: u.id,
          phone: u.phone,
          phoneVerifiedAt: null,
          sessionVersion: fresh.sessionVersion,
        }),
      ).rejects.toMatchObject({ response: { code: 'ACCOUNT_SUSPENDED' } });
      expect(fresh.suspensionReason).toBe('احتيال في الطلبات');
      expect(fresh.suspendedById).toBe(admin.id);

      const again = await suspend(admin.token, u.id).expect(409);
      expect(again.body.error.code).toBe('ALREADY_SUSPENDED');

      // Lift: they can sign in again; audited.
      await lift(admin.token, u.id).expect(201);
      expect(await auditCount(u.id, 'user.suspension_lifted')).toBe(1);
      const back = await login(u.phone);
      await me(back).expect(200);
      const notAgain = await lift(admin.token, u.id).expect(409);
      expect(notAgain.body.error.code).toBe('NOT_SUSPENDED');
    });

    it('a session issued in the race window dies too: the guard re-checks suspension on every request', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const u = await account();
      await suspend(admin.token, u.id).expect(201);
      // A token written straight to Redis with the CURRENT sessionVersion
      // (as if issued just before the check committed) is still refused.
      const fresh = await prisma.user.findUniqueOrThrow({
        where: { id: u.id },
      });
      const redisToken = 'race-' + unique('t');
      await (
        app.get(SessionService) as unknown as {
          redis: {
            set: (
              k: string,
              v: string,
              ex: 'EX',
              s: number,
            ) => Promise<unknown>;
          };
        }
      ).redis.set(
        'session:' + redisToken,
        JSON.stringify({
          userId: u.id,
          phone: u.phone,
          phoneVerifiedAt: null,
          sessionVersion: fresh.sessionVersion,
        }),
        'EX',
        60,
      );
      const r = await me(redisToken).expect(401);
      expect(r.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it("lifting a suspension never undoes the user's own deactivation", async () => {
      const admin = await account('PLATFORM_ADMIN');
      const u = await account();
      await request(http())
        .delete('/api/v1/customers/me')
        .set(auth(u.token))
        .set('Idempotency-Key', unique('deact'))
        .expect(200);
      await suspend(admin.token, u.id).expect(201);
      const lifted = await lift(admin.token, u.id).expect(201);
      expect(lifted.body.status).toBe('DEACTIVATED');
      const l = await request(http())
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: PASSWORD })
        .expect(403);
      expect(l.body.error.code).toBe('ACCOUNT_DEACTIVATED');
    });

    it('force sign-out ends every session at once (sessionVersion + Redis); they can sign in again; audited', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const u = await account();
      const second = await login(u.phone);
      await signOut(admin.token, u.id).expect(201);
      for (const token of [u.token, second]) await me(token).expect(401);
      expect(await app.get(SessionService).get(second)).toBeNull();
      expect(await auditCount(u.id, 'user.sessions_revoked_by_platform')).toBe(
        1,
      );
      await me(await login(u.phone)).expect(200);
    });

    it('PLATFORM_ADMIN accounts are protected: neither admin can suspend or sign out the other, or themselves', async () => {
      const a = await account('PLATFORM_ADMIN');
      const b = await account('PLATFORM_ADMIN');
      for (const [actor, target] of [
        [a, b],
        [b, a],
        [a, a],
      ] as const) {
        const s = await suspend(actor.token, target.id).expect(403);
        expect(s.body.error.code).toBe('PROTECTED_ACCOUNT');
        const o = await signOut(actor.token, target.id).expect(403);
        expect(o.body.error.code).toBe('PROTECTED_ACCOUNT');
      }
      for (const x of [a, b]) {
        await me(x.token).expect(200);
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: x.id } }))
            .suspendedAt,
        ).toBeNull();
      }
      const d = (
        await request(http())
          .get(`/api/v1/admin/users/${b.id}`)
          .set(auth(a.token))
          .expect(200)
      ).body;
      expect(d.actions).toMatchObject({
        protected: true,
        can_suspend: false,
        can_force_sign_out: false,
      });
      // A reviewer is not protected.
      const reviewer = await account('VERIFICATION_REVIEWER');
      await suspend(a.token, reviewer.id).expect(201);
    });
  });

  describe('store ownership', () => {
    it('never suspends the sole enabled owner of a store that is not cancelled', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const sole = await account();
      const store = await storeOwnedBy([sole.id]);
      const r = await suspend(admin.token, sole.id).expect(409);
      expect(r.body.error.code).toBe('SOLE_STORE_OWNER');
      expect(r.body.error.details).toEqual([
        { store_id: store.id, store_name: store.displayName },
      ]);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: sole.id } }))
          .suspendedAt,
      ).toBeNull();
      expect(await auditCount(sole.id, 'user.suspended_by_platform')).toBe(0);

      // A co-owner who deactivated their account, or whom the platform
      // suspended, is not an enabled owner (an OWNER membership itself is
      // never SUSPENDED - a database rule).
      const coDeactivated = await account();
      await prisma.vendorUser.create({
        data: { vendorId: store.id, userId: coDeactivated.id, role: 'OWNER' },
      });
      await prisma.user.update({
        where: { id: coDeactivated.id },
        data: { deactivatedAt: new Date() },
      });
      const coSuspended = await account();
      await prisma.vendorUser.create({
        data: { vendorId: store.id, userId: coSuspended.id, role: 'OWNER' },
      });
      await prisma.user.update({
        where: { id: coSuspended.id },
        data: {
          suspendedAt: new Date(),
          suspensionReason: 'إيقاف سابق',
          suspendedById: admin.id,
        },
      });
      await suspend(admin.token, sole.id).expect(409);

      // An enabled co-owner: now allowed; memberships untouched.
      const co = await account();
      await prisma.vendorUser.create({
        data: { vendorId: store.id, userId: co.id, role: 'OWNER' },
      });
      await suspend(admin.token, sole.id).expect(201);
      expect(
        await prisma.vendorUser.count({
          where: {
            vendorId: store.id,
            userId: sole.id,
            role: 'OWNER',
            status: 'ACTIVE',
          },
        }),
      ).toBe(1);
      // And now the co-owner is the sole enabled owner.
      expect(
        (await suspend(admin.token, co.id).expect(409)).body.error.code,
      ).toBe('SOLE_STORE_OWNER');

      // A cancelled store does not protect its owner.
      const closedOwner = await account();
      await storeOwnedBy([closedOwner.id], 'CANCELLED');
      await suspend(admin.token, closedOwner.id).expect(201);
    });

    it('concurrency: two admins suspending the two co-owners at once - exactly one wins, one enabled owner remains', async () => {
      const a1 = await account('PLATFORM_ADMIN');
      const a2 = await account('PLATFORM_ADMIN');
      for (let round = 0; round < 3; round++) {
        const x = await account();
        const y = await account();
        const store = await storeOwnedBy([x.id, y.id]);
        const results = await Promise.all([
          suspend(a1.token, x.id),
          suspend(a2.token, y.id),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(results.find((r) => r.status === 409)!.body.error.code).toBe(
          'SOLE_STORE_OWNER',
        );
        expect(
          await prisma.vendorUser.count({
            where: {
              vendorId: store.id,
              role: 'OWNER',
              user: { suspendedAt: null, deactivatedAt: null },
            },
          }),
        ).toBe(1);
      }
    });

    it("concurrency: a suspension against the co-owner's own deactivation - never both", async () => {
      const admin = await account('PLATFORM_ADMIN');
      for (let round = 0; round < 3; round++) {
        const x = await account();
        const y = await account();
        const store = await storeOwnedBy([x.id, y.id]);
        const [s, d] = await Promise.all([
          suspend(admin.token, x.id),
          request(http())
            .delete('/api/v1/customers/me')
            .set(auth(y.token))
            .set('Idempotency-Key', unique('deact')),
        ]);
        expect([s.status, d.status].filter((c) => c < 300)).toHaveLength(1);
        expect(
          await prisma.vendorUser.count({
            where: {
              vendorId: store.id,
              role: 'OWNER',
              user: { suspendedAt: null, deactivatedAt: null },
            },
          }),
        ).toBe(1);
      }
    });
  });

  describe('Settings & Team', () => {
    it('the team: platform roles only, read-only, masked; reviewers restricted', async () => {
      const admin = await account('PLATFORM_ADMIN', 'مديرة');
      const reviewer = await account('VERIFICATION_REVIEWER', 'مراجع');
      const customer = await account();
      const team = (
        await request(http())
          .get('/api/v1/admin/team')
          .set(auth(admin.token))
          .expect(200)
      ).body.members as {
        id: string;
        platform_role: string;
        phone_masked: string;
      }[];
      const ids = team.map((m) => m.id);
      expect(ids).toEqual(expect.arrayContaining([admin.id, reviewer.id]));
      expect(ids).not.toContain(customer.id);
      expect(team.every((m) => m.platform_role)).toBe(true);
      expect(JSON.stringify(team)).not.toContain(admin.phone);
      // No role management endpoints exist.
      await request(http())
        .post(`/api/v1/admin/team/${reviewer.id}/role`)
        .set(auth(admin.token))
        .send({ role: 'PLATFORM_ADMIN' })
        .expect(404);
    });

    it('alert recipients: with no subscriber a category falls back to every active admin; a subscription takes over', async () => {
      const admin = await account('PLATFORM_ADMIN');
      // Isolated test database: start the category from no subscribers.
      await prisma.platformAlertRecipient.deleteMany({
        where: { category: 'RETURN_ESCALATION' },
      });
      const before = (
        await request(http())
          .get('/api/v1/admin/alert-recipients')
          .set(auth(admin.token))
          .expect(200)
      ).body.categories.find(
        (c: { category: string }) => c.category === 'RETURN_ESCALATION',
      );
      expect(before.delivery).toBe('FALLBACK_ALL_ACTIVE_ADMINS');
      // No subscriber: the resolver's fallback (every active admin) applies.
      expect(before.recipient_user_ids).toEqual([]);

      await request(http())
        .put(`/api/v1/admin/alert-recipients/RETURN_ESCALATION/${admin.id}`)
        .set(auth(admin.token))
        .set('Idempotency-Key', unique('alert'))
        .expect(200);
      const after = (
        await request(http())
          .get('/api/v1/admin/alert-recipients')
          .set(auth(admin.token))
          .expect(200)
      ).body.categories.find(
        (c: { category: string }) => c.category === 'RETURN_ESCALATION',
      );
      expect(after.delivery).toBe('SUBSCRIBED');
      expect(after.recipient_user_ids).toEqual([admin.id]);
      const categories = (
        await request(http())
          .get('/api/v1/admin/alert-recipients')
          .set(auth(admin.token))
          .expect(200)
      ).body.categories.map((c: { category: string }) => c.category);
      expect(categories.sort()).toEqual([
        'ORDER_INTEGRITY',
        'RETURN_ESCALATION',
      ]);
    });
  });
});
