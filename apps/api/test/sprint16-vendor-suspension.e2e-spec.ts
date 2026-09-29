import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { SUSPENDED_DENY_ROUTES } from './../src/auth/vendor-route-classification';
import { SUSPENDED_ALLOW_ROUTES } from './../src/auth/vendor-route-classification';
import { OutboxEventService } from './../src/outbox/outbox-event.service';
import {
  Sprint16Ctx,
  bootApp,
  createFixtures,
} from './helpers/sprint16-fixtures';

const REASON = 'Repeated policy violations reported by customers';
const REACTIVATION = 'Issues resolved after review with the owner';

// Sprint 16 (FR-VEND-009, FR-VEND-008, L-23, D1/D2): platform ADMIN
// suspend / reactivate, the vendor list/detail, the deny/allow behaviour
// of a SUSPENDED store, outbox events and DB-level invariants.
describe('Sprint 16 - vendor suspension and reactivation (e2e)', () => {
  const ctx = {} as Sprint16Ctx;
  let f: ReturnType<typeof createFixtures>;

  beforeEach(async () => {
    await bootApp(ctx);
    f = createFixtures(ctx, 'sprint16-vendor-suspension');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ctx.app.close();
  });

  const http = () => ctx.app.getHttpServer();

  /** owner + admin + an ACTIVE vendor reached through the real path. */
  async function activeVendor() {
    const admin = await f.platformUser('PLATFORM_ADMIN');
    const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
    const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
    const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
    await f.activateViaApi(owner, reviewer.token, vendorId, branchIds[0]);
    // Publishing is a separate owner step; set it directly so the public
    // and checkout surfaces treat this vendor as fully live.
    const vendor = await ctx.prisma.vendor.update({
      where: { id: vendorId },
      data: { storefrontPublished: true },
    });
    expect(vendor.status).toBe('ACTIVE');
    return {
      admin,
      reviewer,
      owner,
      vendorId,
      branchId: branchIds[0],
      slug: vendor.slug,
    };
  }

  const outboxFor = async (eventType: string, vendorId: string) =>
    (await ctx.prisma.outboxEvent.findMany({ where: { eventType } })).filter(
      (e) => (e.payload as { vendor_id?: string }).vendor_id === vendorId,
    );

  // ---------------------------------------------------------------
  describe('suspend / reactivate lifecycle', () => {
    it('suspends an ACTIVE vendor with a captured reason, and reactivates it with one', async () => {
      const { admin, vendorId } = await activeVendor();
      const res = await f
        .suspend(admin.token, vendorId, {
          reason_code: 'NON_PAYMENT',
          reason: `  ${REASON}  `,
        })
        .expect(201);
      expect(res.body).toMatchObject({
        vendor_id: vendorId,
        reason_code: 'NON_PAYMENT',
        reason: REASON,
        suspended_by: admin.userId,
        reactivated_at: null,
        reactivated_by: null,
        reactivation_reason: null,
      });
      expect(
        (await ctx.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } }))
          .status,
      ).toBe('SUSPENDED');

      const back = await f
        .reactivate(admin.token, vendorId, {
          reason: `  ${REACTIVATION}  `,
        })
        .expect(201);
      expect(back.body).toMatchObject({
        id: res.body.id,
        reactivated_by: admin.userId,
        reactivation_reason: REACTIVATION,
      });
      expect(typeof back.body.reactivated_at).toBe('string');
      expect(
        (await ctx.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } }))
          .status,
      ).toBe('ACTIVE');
    });

    it('is a repeatable cycle: suspend -> reactivate -> suspend again, and the history keeps every episode', async () => {
      const { admin, vendorId } = await activeVendor();
      await f.suspend(admin.token, vendorId).expect(201);
      await f.reactivate(admin.token, vendorId).expect(201);
      await f
        .suspend(admin.token, vendorId, {
          reason_code: 'OTHER',
          reason: 'A second, unrelated violation was found',
        })
        .expect(201);

      const detail = await request(http())
        .get(`/api/v1/admin/vendors/${vendorId}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect(detail.body.status).toBe('SUSPENDED');
      expect(detail.body.suspensions).toHaveLength(2);
      const [latest, earlier] = detail.body.suspensions;
      expect(latest.reactivated_at).toBeNull();
      expect(latest.reason_code).toBe('OTHER');
      expect(earlier.reactivated_at).not.toBeNull();
    });

    it('enforces the state rules: only ACTIVE can be suspended, only SUSPENDED reactivated, an unknown vendor is 404', async () => {
      const { admin, vendorId } = await activeVendor();
      const notSuspended = await f
        .reactivate(admin.token, vendorId)
        .expect(409);
      expect(notSuspended.body.error.code).toBe('VENDOR_NOT_SUSPENDED');

      await f.suspend(admin.token, vendorId).expect(201);
      const twice = await f.suspend(admin.token, vendorId).expect(409);
      expect(twice.body.error.code).toBe('VENDOR_ALREADY_SUSPENDED');

      const otherOwner = await f.signup(f.uniquePhone(), 'a-strong-password');
      for (const status of [
        'APPLIED',
        'UNDER_REVIEW',
        'APPROVED',
        'REJECTED',
      ] as const) {
        const { vendorId: other } = await f.createPhysicalVendor(otherOwner, 1);
        await ctx.prisma.vendor.update({
          where: { id: other },
          data: { status },
        });
        const res = await f.suspend(admin.token, other).expect(409);
        expect(res.body.error.code).toBe('VENDOR_NOT_ACTIVE');
      }

      await f.suspend(admin.token, randomUUID()).expect(404);
      await f.reactivate(admin.token, randomUUID()).expect(404);
      await f.suspend(admin.token, 'not-a-uuid').expect(404);
    });

    it('rejects a missing, blank, too-short, too-long or wrongly-typed reason and an unknown reason_code (400) without changing anything', async () => {
      const { admin, vendorId } = await activeVendor();
      const bad: Record<string, unknown>[] = [
        {},
        { reason_code: 'POLICY_VIOLATION' },
        { reason: REASON },
        { reason_code: 'POLICY_VIOLATION', reason: '' },
        { reason_code: 'POLICY_VIOLATION', reason: '     ' },
        { reason_code: 'POLICY_VIOLATION', reason: 'too short' },
        { reason_code: 'POLICY_VIOLATION', reason: 'x'.repeat(1001) },
        { reason_code: 'POLICY_VIOLATION', reason: 123456789012 },
        { reason_code: 'NOT_A_CODE', reason: REASON },
        { reason_code: 'policy_violation', reason: REASON },
      ];
      for (const body of bad) {
        await f.suspend(admin.token, vendorId, body).expect(400);
      }
      expect(
        (await ctx.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } }))
          .status,
      ).toBe('ACTIVE');
      expect(
        await ctx.prisma.vendorSuspension.count({ where: { vendorId } }),
      ).toBe(0);

      await f.suspend(admin.token, vendorId).expect(201);
      for (const body of [
        {},
        { reason: '' },
        { reason: '   ' },
        { reason: 'too short' },
        { reason: 'x'.repeat(1001) },
      ]) {
        await f.reactivate(admin.token, vendorId, body).expect(400);
      }
      expect(
        (await ctx.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } }))
          .status,
      ).toBe('SUSPENDED');
    });

    it('writes AuditLog rows and Outbox events (D2) that never carry the free-text reason', async () => {
      const { admin, vendorId } = await activeVendor();
      const s = await f
        .suspend(admin.token, vendorId, {
          reason_code: 'POLICY_VIOLATION',
          reason: 'reason-canary-text-do-not-leak',
        })
        .expect(201);
      const r = await f
        .reactivate(admin.token, vendorId, {
          reason: 'reactivation-canary-text-do-not-leak',
        })
        .expect(201);

      const audits = await ctx.prisma.auditLog.findMany({
        where: {
          entityType: 'Vendor',
          entityId: vendorId,
          action: { in: ['vendor.suspended', 'vendor.reactivated'] },
        },
        orderBy: { occurredAt: 'asc' },
      });
      expect(audits.map((a) => a.action).sort()).toEqual([
        'vendor.reactivated',
        'vendor.suspended',
      ]);
      expect(audits.every((a) => a.actorId === admin.userId)).toBe(true);
      const suspendedAudit = audits.find(
        (a) => a.action === 'vendor.suspended',
      )!;
      expect(suspendedAudit.beforeState).toEqual({ status: 'ACTIVE' });
      expect(suspendedAudit.afterState).toEqual({
        status: 'SUSPENDED',
        suspension_id: s.body.id,
        reason_code: 'POLICY_VIOLATION',
      });
      expect(JSON.stringify(audits)).not.toContain('canary');

      const sEvents = await outboxFor('vendor.suspended', vendorId);
      const rEvents = await outboxFor('vendor.reactivated', vendorId);
      expect(sEvents).toHaveLength(1);
      expect(rEvents).toHaveLength(1);
      expect(sEvents[0].status).toBe('PENDING');
      expect(Object.keys(sEvents[0].payload as object).sort()).toEqual([
        'occurred_at',
        'reason_code',
        'suspension_id',
        'vendor_id',
      ]);
      expect(Object.keys(rEvents[0].payload as object).sort()).toEqual([
        'occurred_at',
        'suspension_id',
        'vendor_id',
      ]);
      expect(
        (rEvents[0].payload as { suspension_id: string }).suspension_id,
      ).toBe(r.body.id);
      expect(JSON.stringify([sEvents, rEvents])).not.toContain('canary');
    });

    it('rolls the whole suspension back if the outbox write fails: vendor still ACTIVE, no suspension row, no audit row', async () => {
      const { admin, vendorId } = await activeVendor();
      jest
        .spyOn(ctx.app.get(OutboxEventService), 'enqueue')
        .mockRejectedValueOnce(new Error('outbox down'));
      await f.suspend(admin.token, vendorId).expect(500);
      expect(
        (await ctx.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } }))
          .status,
      ).toBe('ACTIVE');
      expect(
        await ctx.prisma.vendorSuspension.count({ where: { vendorId } }),
      ).toBe(0);
      expect(
        await ctx.prisma.auditLog.count({
          where: { entityId: vendorId, action: 'vendor.suspended' },
        }),
      ).toBe(0);
      // A retry then succeeds normally.
      await f.suspend(admin.token, vendorId).expect(201);
    });

    it('is idempotent: replaying the same Idempotency-Key returns the same body and writes one suspension, one audit row and one event', async () => {
      const { admin, vendorId } = await activeVendor();
      const key = f.unique('suspend-replay');
      const body = { reason_code: 'POLICY_VIOLATION', reason: REASON };
      const first = await f
        .suspend(admin.token, vendorId, body, key)
        .expect(201);
      const replay = await f
        .suspend(admin.token, vendorId, body, key)
        .expect(201);
      expect(replay.body).toEqual(first.body);
      expect(
        await ctx.prisma.vendorSuspension.count({ where: { vendorId } }),
      ).toBe(1);
      expect(
        await ctx.prisma.auditLog.count({
          where: { entityId: vendorId, action: 'vendor.suspended' },
        }),
      ).toBe(1);
      expect(await outboxFor('vendor.suspended', vendorId)).toHaveLength(1);

      const different = await f.suspend(
        admin.token,
        vendorId,
        { ...body, reason: 'A completely different reason text' },
        key,
      );
      expect(different.status).toBeGreaterThanOrEqual(400);
      expect(different.status).toBeLessThan(500);

      const rKey = f.unique('reactivate-replay');
      const r1 = await f
        .reactivate(admin.token, vendorId, { reason: REACTIVATION }, rKey)
        .expect(201);
      const r2 = await f
        .reactivate(admin.token, vendorId, { reason: REACTIVATION }, rKey)
        .expect(201);
      expect(r2.body).toEqual(r1.body);
      expect(await outboxFor('vendor.reactivated', vendorId)).toHaveLength(1);
    });

    it('is PLATFORM_ADMIN only: a reviewer, a store owner and a customer are refused everywhere under /admin/vendors, and a session is required', async () => {
      const { admin, reviewer, owner, vendorId } = await activeVendor();
      const customer = await f.signup(f.uniquePhone(), 'a-strong-password');
      for (const token of [reviewer.token, owner, customer]) {
        await f.suspend(token, vendorId).expect(403);
        await f.reactivate(token, vendorId).expect(403);
        await request(http())
          .get('/api/v1/admin/vendors')
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
        await request(http())
          .get(`/api/v1/admin/vendors/${vendorId}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
      }
      await request(http())
        .post(`/api/v1/admin/vendors/${vendorId}/suspend`)
        .send({})
        .expect(401);
      await request(http()).get('/api/v1/admin/vendors').expect(401);
      expect(
        (await ctx.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } }))
          .status,
      ).toBe('ACTIVE');
      await f.suspend(admin.token, vendorId).expect(201);
    });

    it('refuses an admin who is a member of the store (PLATFORM_VENDOR_CONFLICT_OF_INTEREST) for both suspend and reactivate, changing nothing', async () => {
      const { admin, vendorId } = await activeVendor();
      const conflicted = await f.platformUser('PLATFORM_ADMIN');
      await ctx.prisma.vendorUser.create({
        data: { userId: conflicted.userId, vendorId, role: 'OWNER' },
      });
      const s = await f.suspend(conflicted.token, vendorId).expect(403);
      expect(s.body.error.code).toBe('PLATFORM_VENDOR_CONFLICT_OF_INTEREST');
      expect(
        await ctx.prisma.vendorSuspension.count({ where: { vendorId } }),
      ).toBe(0);

      await f.suspend(admin.token, vendorId).expect(201);
      const r = await f.reactivate(conflicted.token, vendorId).expect(403);
      expect(r.body.error.code).toBe('PLATFORM_VENDOR_CONFLICT_OF_INTEREST');
      expect(
        (await ctx.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } }))
          .status,
      ).toBe('SUSPENDED');
    });
  });

  // ---------------------------------------------------------------
  describe('database invariants (raw SQL, bypassing the application)', () => {
    it('a second OPEN suspension for the same vendor is rejected by the partial unique index; closed ones do not count', async () => {
      const { admin, vendorId } = await activeVendor();
      await f.suspend(admin.token, vendorId).expect(201);
      await expect(
        ctx.prisma.vendorSuspension.create({
          data: {
            vendorId,
            reasonCode: 'OTHER',
            reason: 'A duplicate open suspension',
            suspendedBy: admin.userId,
          },
        }),
      ).rejects.toThrow(/vendor_suspensions_vendor_open_key|Unique constraint/);
      await f.reactivate(admin.token, vendorId).expect(201);
      // Now closed: a fresh open one is allowed again.
      await ctx.prisma.vendorSuspension.create({
        data: {
          vendorId,
          reasonCode: 'OTHER',
          reason: 'A new, separate episode',
          suspendedBy: admin.userId,
        },
      });
    });

    it('a half-closed row (reactivatedAt without reactivatedBy/reason, or the reverse) violates the CHECK constraint', async () => {
      const { admin, vendorId } = await activeVendor();
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `INSERT INTO vendor_suspensions (id, "vendorId", "reasonCode", reason, "suspendedBy", "reactivatedAt")
           VALUES ('${randomUUID()}', '${vendorId}', 'OTHER', 'half closed row', '${admin.userId}', NOW())`,
        ),
      ).rejects.toThrow(
        /vendor_suspensions_reactivation_all_or_none_check|check constraint/i,
      );
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `INSERT INTO vendor_suspensions (id, "vendorId", "reasonCode", reason, "suspendedBy", "reactivatedBy")
           VALUES ('${randomUUID()}', '${vendorId}', 'OTHER', 'half closed row', '${admin.userId}', '${admin.userId}')`,
        ),
      ).rejects.toThrow(
        /vendor_suspensions_reactivation_all_or_none_check|check constraint/i,
      );
    });
  });

  // ---------------------------------------------------------------
  describe('what a SUSPENDED store can and cannot do (L-23)', () => {
    /** Path for a classification key with placeholders filled in. */
    function urlFor(key: string, vendorId: string) {
      const [method, path] = key.split(' ');
      const filled = path
        .replace(':vendorId', vendorId)
        .replace(/:[A-Za-z]+/g, () => randomUUID());
      return {
        method: method.toLowerCase() as
          'get' | 'post' | 'put' | 'patch' | 'delete',
        url: `/api/v1/${filled}`,
      };
    }

    it("blocks EVERY denylisted route for a suspended store's owner with 403 VENDOR_SUSPENDED, and none of the allowlisted routes is blocked by suspension", async () => {
      const { admin, owner, vendorId } = await activeVendor();
      await f.suspend(admin.token, vendorId).expect(201);

      for (const key of SUSPENDED_DENY_ROUTES) {
        const { method, url } = urlFor(key, vendorId);
        const res = await request(http())
          [method](url)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', f.unique('deny'))
          .send({});
        expect({
          key,
          status: res.status,
          code: res.body?.error?.code,
        }).toEqual({
          key,
          status: 403,
          code: 'VENDOR_SUSPENDED',
        });
      }
      for (const key of SUSPENDED_ALLOW_ROUTES) {
        const { method, url } = urlFor(key, vendorId);
        const res = await request(http())
          [method](url)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', f.unique('allow'))
          .send({});
        expect({ key, code: res.body?.error?.code }).not.toEqual({
          key,
          code: 'VENDOR_SUSPENDED',
        });
      }
    });

    it('never tells a non-member (or a signed-out caller) that a store is suspended: NOT_VENDOR_MEMBER / 401', async () => {
      const { admin, vendorId } = await activeVendor();
      await f.suspend(admin.token, vendorId).expect(201);
      const stranger = await f.signup(f.uniquePhone(), 'a-strong-password');
      const res = await request(http())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${stranger}`)
        .set('Idempotency-Key', f.unique('stranger'))
        .send({ title_ar: 'م', title_en: 'P' })
        .expect(403);
      expect(res.body.error.code).toBe('NOT_VENDOR_MEMBER');
      await request(http())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .send({})
        .expect(401);
    });

    it('keeps in-flight orders moving: the owner and an employee can still prepare an already-placed order and read the order queues', async () => {
      const { admin, owner, vendorId, branchId } = await activeVendor();
      const variantId = await f.createOfferWithStock(vendorId, branchId, 10, 5);
      const orderId = await f.seedInFlightOrder(vendorId, branchId, variantId);
      const invite = await f.prepareStaffInvite(
        owner,
        vendorId,
        branchId,
        f.uniquePhone(),
      );
      const accepted = await f
        .acceptStaffInvite(invite.phone, invite.verificationToken)
        .send({ password: 'a-strong-password' })
        .expect(200);
      const employee = accepted.body.session_token as string;

      await f.suspend(admin.token, vendorId).expect(201);

      // Catalog write blocked for the employee too (their role check
      // comes first for an owner-only route; a route open to employees
      // reports the suspension).
      const prepare = await request(http())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/orders/${orderId}/start-preparation`,
        )
        .set('Authorization', `Bearer ${employee}`)
        .expect(201);
      expect(prepare.body.status).toBe('PREPARING');
      await request(http())
        .get(`/api/v1/vendors/${vendorId}/orders`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      await request(http())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchId}/orders`)
        .set('Authorization', `Bearer ${employee}`)
        .expect(200);
      const order = await ctx.prisma.branchOrder.findUniqueOrThrow({
        where: { id: orderId },
      });
      expect(order.status).toBe('PREPARING');
    });

    it('hides the store publicly (is_available false, no suspension detail anywhere) and restores it on reactivation', async () => {
      const { admin, vendorId, slug } = await activeVendor();
      const readStore = () =>
        request(http()).get(`/api/v1/storefronts/${slug}`).expect(200);
      expect((await readStore()).body.is_available).toBe(true);

      await f
        .suspend(admin.token, vendorId, {
          reason_code: 'POLICY_VIOLATION',
          reason: 'public-canary-suspension-reason',
        })
        .expect(201);
      const hidden = await readStore();
      expect(hidden.body.is_available).toBe(false);
      const serialized = JSON.stringify(hidden.body).toLowerCase();
      expect(serialized).not.toContain('public-canary');
      expect(serialized).not.toContain('suspen');

      await f.reactivate(admin.token, vendorId).expect(201);
      expect((await readStore()).body.is_available).toBe(true);
    });

    it('a suspension between reserve and confirm makes confirm fail (409 ITEM_NOT_PURCHASABLE) and creates no order; a new cart add is refused', async () => {
      const { admin, vendorId, branchId } = await activeVendor();
      const variantId = await f.createOfferWithStock(vendorId, branchId, 10, 5);
      const customer = await f.signup(f.uniquePhone(), 'a-strong-password');
      const itemId = await f.addToCart(customer, vendorId, variantId, 1);
      const reserved = await f
        .reserve(customer, branchId, [itemId])
        .expect(201);

      await f.suspend(admin.token, vendorId).expect(201);

      const res = await f.confirm(customer, reserved.body.reservation_id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ITEM_NOT_PURCHASABLE');
      expect(
        await ctx.prisma.branchOrder.count({ where: { vendorId, branchId } }),
      ).toBe(0);

      const add = await request(http())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', f.unique('cart-add'))
        .send({
          vendor_id: vendorId,
          offer_variant_id: variantId,
          quantity: 1,
        });
      expect(add.status).toBeGreaterThanOrEqual(400);
      expect(add.status).toBeLessThan(500);
    });

    it('subscription renewal stays available and never reactivates the store; activating a subscription on a suspended store is refused', async () => {
      const { admin, owner, vendorId } = await activeVendor();
      await f.suspend(admin.token, vendorId).expect(201);
      await ctx.prisma.vendor.update({
        where: { id: vendorId },
        data: { subscriptionStatus: 'EXPIRED' },
      });
      await ctx.prisma.vendorSubscription.updateMany({
        where: { vendorId },
        data: { status: 'EXPIRED' },
      });

      await request(http())
        .post(`/api/v1/vendors/${vendorId}/subscription/renew`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', f.unique('renew'))
        .send({})
        .expect(200);
      const vendor = await ctx.prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('SUSPENDED');
      expect(vendor.subscriptionStatus).toBe('ACTIVE');

      const activate = await request(http())
        .post(`/api/v1/vendors/${vendorId}/subscription`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', f.unique('sub'))
        .send({})
        .expect(403);
      expect(activate.body.error.code).toBe('VENDOR_NOT_APPROVED');
    });

    it('lifts the block on reactivation: the same catalog write that was 403 VENDOR_SUSPENDED now succeeds', async () => {
      const { admin, owner, vendorId } = await activeVendor();
      const create = () =>
        request(http())
          .post(`/api/v1/vendors/${vendorId}/offers`)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', f.unique('offer'))
          .send({ title_ar: 'م', title_en: 'Blocked while suspended' });
      await create().expect(201);
      await f.suspend(admin.token, vendorId).expect(201);
      const blocked = await create().expect(403);
      expect(blocked.body.error.code).toBe('VENDOR_SUSPENDED');
      await f.reactivate(admin.token, vendorId).expect(201);
      await create().expect(201);
    });

    it('lets the owner read their suspension and its reason (owner only), and shows it cleared after reactivation', async () => {
      const { admin, owner, vendorId, branchId } = await activeVendor();
      const invite = await f.prepareStaffInvite(
        owner,
        vendorId,
        branchId,
        f.uniquePhone(),
      );
      const accepted = await f
        .acceptStaffInvite(invite.phone, invite.verificationToken)
        .send({ password: 'a-strong-password' })
        .expect(200);
      await f
        .suspend(admin.token, vendorId, {
          reason_code: 'NON_PAYMENT',
          reason: REASON,
        })
        .expect(201);

      const read = () =>
        request(http())
          .get(`/api/v1/vendors/${vendorId}/verification-status`)
          .set('Authorization', `Bearer ${owner}`);
      const res = await read().expect(200);
      expect(res.body.vendor.status).toBe('SUSPENDED');
      expect(res.body.suspension).toEqual({
        reason_code: 'NON_PAYMENT',
        reason: REASON,
        suspended_at: expect.any(String),
      });
      await request(http())
        .get(`/api/v1/vendors/${vendorId}/verification-status`)
        .set('Authorization', `Bearer ${accepted.body.session_token as string}`)
        .expect(403);
      // The employee sees only the generic vendor status, no reason.
      const summary = await request(http())
        .get(`/api/v1/vendors/${vendorId}`)
        .set('Authorization', `Bearer ${accepted.body.session_token as string}`)
        .expect(200);
      expect(summary.body.status).toBe('SUSPENDED');
      expect(JSON.stringify(summary.body)).not.toContain(REASON);

      await f.reactivate(admin.token, vendorId).expect(201);
      expect((await read().expect(200)).body.suspension).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  describe('admin vendor list and detail', () => {
    it('filters by status and searches legal_name literally (LIKE wildcards in q are not wildcards), ordered by created_at then id with a stable opaque cursor', async () => {
      const admin = await f.platformUser('PLATFORM_ADMIN');
      const token = f.unique('Zq').replace(/-/g, '');
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
        const res = await request(http())
          .post('/api/v1/vendors')
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', f.unique('apply'))
          .send({
            legal_name: `${token} Store ${i}%_`,
            store_type: 'PHYSICAL',
            branches: [{ name: 'B', is_physical: true }],
            applicable_categories: ['WOMEN'],
          })
          .expect(201);
        ids.push(res.body.id);
        // Review-round fix (clean-room flake, unrelated to Sprint 17's
        // own changes): `createdAt` is TIMESTAMP(3) - millisecond
        // resolution - and this loop's three sequential POST requests
        // can complete within the same millisecond on a fast/lightly-
        // loaded run, tying on `created_at` and falling through to the
        // (id-based, not insertion-order) tie-break this test doesn't
        // expect. A 5ms pause is far below anything a human would
        // notice and far above what's needed to guarantee three
        // distinct millisecond timestamps.
        await new Promise((r) => setTimeout(r, 5));
      }
      const list = (qs: string) =>
        request(http())
          .get(`/api/v1/admin/vendors?${qs}`)
          .set('Authorization', `Bearer ${admin.token}`);

      const all = await list(`q=${token}&limit=50`).expect(200);
      expect(all.body.items.map((i: { id: string }) => i.id)).toEqual(ids);
      expect(all.body.next_cursor).toBeNull();

      // Walk with limit=2: page boundaries never skip or repeat.
      const p1 = await list(`q=${token}&limit=2`).expect(200);
      expect(p1.body.items.map((i: { id: string }) => i.id)).toEqual(
        ids.slice(0, 2),
      );
      const p2 = await list(
        `q=${token}&limit=2&cursor=${p1.body.next_cursor as string}`,
      ).expect(200);
      expect(p2.body.items.map((i: { id: string }) => i.id)).toEqual(
        ids.slice(2),
      );
      expect(p2.body.next_cursor).toBeNull();

      // % and _ are literal characters, not wildcards.
      const literal = await list(
        `q=${encodeURIComponent(`${token} Store 0%_`)}`,
      ).expect(200);
      expect(literal.body.items.map((i: { id: string }) => i.id)).toEqual([
        ids[0],
      ]);
      const wildcard = await list(`q=${encodeURIComponent('%%')}`).expect(200);
      expect(
        wildcard.body.items.every((i: { legal_name: string }) =>
          i.legal_name.includes('%%'),
        ),
      ).toBe(true);
      // An unescaped '_' would match the '0' in 'Store 0'; escaped, it matches nothing.
      const underscore = await list(
        `q=${encodeURIComponent(`${token} Store _`)}`,
      ).expect(200);
      expect(underscore.body.items).toEqual([]);

      await ctx.prisma.vendor.update({
        where: { id: ids[1] },
        data: { status: 'REJECTED' },
      });
      const rejected = await list(`q=${token}&status=REJECTED`).expect(200);
      expect(rejected.body.items.map((i: { id: string }) => i.id)).toEqual([
        ids[1],
      ]);
      expect(rejected.body.items[0]).toMatchObject({
        status: 'REJECTED',
        store_type: 'PHYSICAL',
        is_member: false,
      });
    });

    it('rejects bad inputs with 400 (status, q shorter than 2, limit, cursor) and reports is_member for stores the admin belongs to', async () => {
      const admin = await f.platformUser('PLATFORM_ADMIN');
      const get = (qs: string) =>
        request(http())
          .get(`/api/v1/admin/vendors?${qs}`)
          .set('Authorization', `Bearer ${admin.token}`);
      expect((await get('status=BOGUS').expect(400)).body.error.code).toBe(
        'INVALID_STATUS_FILTER',
      );
      expect((await get('q=a').expect(400)).body.error.code).toBe(
        'INVALID_SEARCH',
      );
      expect((await get('limit=0').expect(400)).body.error.code).toBe(
        'INVALID_LIMIT',
      );
      expect((await get('limit=51').expect(400)).body.error.code).toBe(
        'INVALID_LIMIT',
      );
      expect((await get('cursor=%25%25%25').expect(400)).body.error.code).toBe(
        'INVALID_CURSOR',
      );

      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId } = await f.createPhysicalVendor(owner, 1);
      await ctx.prisma.vendorUser.create({
        data: { userId: admin.userId, vendorId, role: 'OWNER' },
      });
      const detail = await request(http())
        .get(`/api/v1/admin/vendors/${vendorId}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect(detail.body.is_member).toBe(true);
      await request(http())
        .get(`/api/v1/admin/vendors/${randomUUID()}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(404);
    });

    it('detail reports active (non-terminal) BranchOrders for the L-23 warning and the full suspension history', async () => {
      const { admin, vendorId, branchId } = await activeVendor();
      const variantId = await f.createOfferWithStock(vendorId, branchId, 10, 5);
      const active = await f.seedInFlightOrder(vendorId, branchId, variantId);
      const done = await f.seedInFlightOrder(vendorId, branchId, variantId);
      await ctx.prisma.branchOrder.update({
        where: { id: done },
        data: { status: 'COMPLETED' },
      });
      expect(active).not.toBe(done);

      const res = await request(http())
        .get(`/api/v1/admin/vendors/${vendorId}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect(res.body.active_branch_orders_count).toBe(1);
      expect(res.body.suspensions).toEqual([]);
    });
  });
});
