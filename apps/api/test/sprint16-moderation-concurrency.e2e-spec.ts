import * as request from 'supertest';
import { AuditLogService } from './../src/audit/audit-log.service';
import {
  PlatformRoleName,
  Sprint16Ctx,
  bootApp,
  createFixtures,
} from './helpers/sprint16-fixtures';

type Res = { status: number; body: any };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Sprint 16 (D4, review round on the plan): the platform-moderation
// actions (verification decisions, suspend, reactivate) and
// acceptStaffInvite() are serialized on the SAME `vendors ... FOR
// UPDATE` row. These tests PROVE that ordering with barriers rather than
// inferring it from the final state: a bare Promise.all cannot tell "the
// decision committed, then the membership" (safe) from "both ran
// concurrently and the decision never saw the membership" (the bug),
// because both leave identical rows behind. A barrier pauses one
// transaction while it holds the vendor lock and shows the other one is
// genuinely blocked behind it.
describe('Sprint 16 - moderation concurrency and conflict-of-interest serialization (e2e)', () => {
  const ctx = {} as Sprint16Ctx;
  let f: ReturnType<typeof createFixtures>;

  beforeEach(async () => {
    await bootApp(ctx);
    f = createFixtures(ctx, 'sprint16-moderation-concurrency');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ctx.app.close();
  });

  const http = () => ctx.app.getHttpServer();
  const run = (t: PromiseLike<Res>): Promise<Res> => Promise.resolve(t);

  /** Pause the FIRST call recording `action` (inside its transaction) until released. */
  function barrierOnAudit(action: string) {
    const audit = ctx.app.get(AuditLogService);
    const original = audit.record.bind(audit);
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hit = new Promise<void>((r) => (reached = r));
    let armed = true;
    jest.spyOn(audit, 'record').mockImplementation(async (input, tx) => {
      if (armed && input.action === action) {
        armed = false;
        reached();
        await gate;
      }
      return original(input, tx);
    });
    return {
      release: () => release(),
      reached: () =>
        Promise.race([
          hit,
          sleep(10_000).then(() => {
            throw new Error(`barrier: '${action}' was never reached`);
          }),
        ]),
    };
  }

  const settledWithin = (p: Promise<unknown>, ms: number) =>
    Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      sleep(ms).then(() => false),
    ]);

  /**
   * A transaction is genuinely waiting on the vendor-serializing lock
   * chain right now. Sprint 18b: decide()/acceptStaffInvite() both now
   * take the branch-operational-status advisory lock BEFORE the
   * `vendors ... FOR UPDATE` row (see branch-operational-lock.util.ts's
   * own comment on the fixed lock order) - for these two branch-scoped
   * scenarios that advisory lock is the first, and therefore the real,
   * contention point between them, so it must be detected here too, not
   * only the (now strictly later) vendors-row lock.
   */
  async function someoneWaitsOnVendorLock(): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
      const rows = await ctx.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND (
             query ILIKE '%FROM vendors%FOR UPDATE%'
             OR query ILIKE '%pg_advisory_xact_lock%branch_operational_status%'
           )`;
      if (Number(rows[0].n) > 0) return true;
      await sleep(100);
    }
    return false;
  }

  interface Scenario {
    name: string;
    role: PlatformRoleName;
    /** AuditLog action recorded inside the moderation transaction. */
    action: string;
    setup: () => Promise<{
      actor: { token: string; phone: string; userId: string };
      owner: string;
      vendorId: string;
      branchId: string;
      act: () => Promise<Res>;
      assertApplied: () => Promise<void>;
      assertNotApplied: () => Promise<void>;
    }>;
  }

  const scenarios: Scenario[] = [
    {
      name: 'branch verification decision',
      role: 'VERIFICATION_REVIEWER',
      action: 'store_branch.verification_decided',
      async setup() {
        const actor = await f.platformUser('VERIFICATION_REVIEWER');
        const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
        const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
        await f.submitBranchEvidence(owner, vendorId, branchIds[0]).expect(201);
        return {
          actor,
          owner,
          vendorId,
          branchId: branchIds[0],
          act: () =>
            run(
              f.decideBranch(actor.token, vendorId, branchIds[0], {
                decision: 'approve',
                evidence_revision: 1,
              }),
            ),
          assertApplied: async () => {
            const v = await ctx.prisma.vendor.findUniqueOrThrow({
              where: { id: vendorId },
            });
            expect(v.status).toBe('APPROVED');
          },
          assertNotApplied: async () => {
            const b = await ctx.prisma.storeBranch.findUniqueOrThrow({
              where: { id: branchIds[0] },
            });
            const v = await ctx.prisma.vendor.findUniqueOrThrow({
              where: { id: vendorId },
            });
            expect(b.verificationStatus).toBe('PENDING');
            expect(v.status).toBe('UNDER_REVIEW');
            expect(
              await ctx.prisma.auditLog.count({
                where: {
                  action: 'store_branch.verification_decided',
                  entityId: branchIds[0],
                },
              }),
            ).toBe(0);
          },
        };
      },
    },
    {
      name: 'warehouse verification decision',
      role: 'VERIFICATION_REVIEWER',
      action: 'warehouse_verification_evidence.decided',
      async setup() {
        const actor = await f.platformUser('VERIFICATION_REVIEWER');
        const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
        const { vendorId } = await f.createOnlineOnlyVendor(owner);
        await f.setWarehouse(owner, vendorId);
        const ev = await f.submitWarehouseEvidence(owner, vendorId).expect(201);
        const branch = await ctx.prisma.storeBranch.findFirstOrThrow({
          where: { vendorId },
        });
        return {
          actor,
          owner,
          vendorId,
          branchId: branch.id,
          act: () =>
            run(
              f.decideWarehouse(actor.token, vendorId, {
                evidence_id: ev.body.id,
                decision: 'approve',
              }),
            ),
          assertApplied: async () => {
            const row =
              await ctx.prisma.warehouseVerificationEvidence.findUniqueOrThrow({
                where: { id: ev.body.id },
              });
            expect(row.status).toBe('APPROVED');
          },
          assertNotApplied: async () => {
            const row =
              await ctx.prisma.warehouseVerificationEvidence.findUniqueOrThrow({
                where: { id: ev.body.id },
              });
            expect(row.status).toBe('PENDING');
            const v = await ctx.prisma.vendor.findUniqueOrThrow({
              where: { id: vendorId },
            });
            expect(v.status).toBe('UNDER_REVIEW');
          },
        };
      },
    },
    {
      name: 'suspend',
      role: 'PLATFORM_ADMIN',
      action: 'vendor.suspended',
      async setup() {
        const actor = await f.platformUser('PLATFORM_ADMIN');
        const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
        const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
        await f.makeVendorActive(vendorId);
        return {
          actor,
          owner,
          vendorId,
          branchId: branchIds[0],
          act: () => run(f.suspend(actor.token, vendorId)),
          assertApplied: async () => {
            const v = await ctx.prisma.vendor.findUniqueOrThrow({
              where: { id: vendorId },
            });
            expect(v.status).toBe('SUSPENDED');
          },
          assertNotApplied: async () => {
            const v = await ctx.prisma.vendor.findUniqueOrThrow({
              where: { id: vendorId },
            });
            expect(v.status).toBe('ACTIVE');
            expect(
              await ctx.prisma.vendorSuspension.count({ where: { vendorId } }),
            ).toBe(0);
          },
        };
      },
    },
    {
      name: 'reactivate',
      role: 'PLATFORM_ADMIN',
      action: 'vendor.reactivated',
      async setup() {
        const actor = await f.platformUser('PLATFORM_ADMIN');
        const other = await f.platformUser('PLATFORM_ADMIN');
        const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
        const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
        await f.makeVendorActive(vendorId);
        await f.suspend(other.token, vendorId).expect(201);
        return {
          actor,
          owner,
          vendorId,
          branchId: branchIds[0],
          act: () => run(f.reactivate(actor.token, vendorId)),
          assertApplied: async () => {
            const v = await ctx.prisma.vendor.findUniqueOrThrow({
              where: { id: vendorId },
            });
            expect(v.status).toBe('ACTIVE');
          },
          assertNotApplied: async () => {
            const v = await ctx.prisma.vendor.findUniqueOrThrow({
              where: { id: vendorId },
            });
            expect(v.status).toBe('SUSPENDED');
            expect(
              await ctx.prisma.vendorSuspension.count({
                where: { vendorId, reactivatedAt: null },
              }),
            ).toBe(1);
          },
        };
      },
    },
  ];

  // ---------------------------------------------------------------
  describe.each(scenarios)(
    '$name vs a platform user accepting a staff invite for the same store',
    (sc) => {
      it('ACTION FIRST: while the action holds the vendor lock the membership is NOT created (accept is blocked behind it); the action commits, then the membership is created', async () => {
        const s = await sc.setup();
        const invite = await f.prepareStaffInvite(
          s.owner,
          s.vendorId,
          s.branchId,
          s.actor.phone,
        );
        const barrier = barrierOnAudit(sc.action);

        const actP = s.act();
        await barrier.reached(); // the action is inside its transaction, vendor row locked
        const acceptP = run(
          f.acceptStaffInvite(invite.phone, invite.verificationToken),
        );

        expect(await someoneWaitsOnVendorLock()).toBe(true);
        expect(await settledWithin(acceptP, 700)).toBe(false);
        expect(
          await ctx.prisma.vendorUser.count({
            where: { userId: s.actor.userId, vendorId: s.vendorId },
          }),
        ).toBe(0);

        barrier.release();
        const [actRes, acceptRes] = await Promise.all([actP, acceptP]);
        expect(actRes.status).toBe(201);
        expect(acceptRes.status).toBe(200);
        await s.assertApplied();
        expect(
          await ctx.prisma.vendorUser.count({
            where: { userId: s.actor.userId, vendorId: s.vendorId },
          }),
        ).toBe(1);
      });

      it('ACCEPT FIRST: while the accept holds the vendor lock (membership uncommitted) the action is blocked; once the membership commits the action is refused 403 PLATFORM_VENDOR_CONFLICT_OF_INTEREST and changes nothing', async () => {
        const s = await sc.setup();
        const invite = await f.prepareStaffInvite(
          s.owner,
          s.vendorId,
          s.branchId,
          s.actor.phone,
        );
        const barrier = barrierOnAudit('vendor_user.staff_invite_accepted');

        const acceptP = run(
          f.acceptStaffInvite(invite.phone, invite.verificationToken),
        );
        await barrier.reached(); // vendorUser.create has run, vendor row locked, not committed
        const actP = s.act();

        expect(await someoneWaitsOnVendorLock()).toBe(true);
        expect(await settledWithin(actP, 700)).toBe(false);
        await s.assertNotApplied();

        barrier.release();
        const [acceptRes, actRes] = await Promise.all([acceptP, actP]);
        expect(acceptRes.status).toBe(200);
        expect(actRes.status).toBe(403);
        expect(actRes.body.error.code).toBe(
          'PLATFORM_VENDOR_CONFLICT_OF_INTEREST',
        );
        await s.assertNotApplied();
        expect(
          await ctx.prisma.vendorUser.count({
            where: { userId: s.actor.userId, vendorId: s.vendorId },
          }),
        ).toBe(1);
      });

      it('UNCOORDINATED RACE (x6): only the two safe serial outcomes ever occur - never a 500, never a deadlock, never a decision by someone who was a member when it was made', async () => {
        const seen = new Set<string>();
        for (let i = 0; i < 6; i++) {
          const s = await sc.setup();
          const invite = await f.prepareStaffInvite(
            s.owner,
            s.vendorId,
            s.branchId,
            s.actor.phone,
          );
          const [actRes, acceptRes] = await Promise.all([
            s.act(),
            run(f.acceptStaffInvite(invite.phone, invite.verificationToken)),
          ]);
          expect(acceptRes.status).toBe(200); // the accept never fails because of moderation
          if (actRes.status === 201) {
            seen.add('action-then-accept');
            await s.assertApplied();
          } else {
            expect(actRes.status).toBe(403);
            expect(actRes.body.error.code).toBe(
              'PLATFORM_VENDOR_CONFLICT_OF_INTEREST',
            );
            seen.add('accept-then-refused');
            await s.assertNotApplied();
          }
          expect(
            await ctx.prisma.vendorUser.count({
              where: { userId: s.actor.userId, vendorId: s.vendorId },
            }),
          ).toBe(1);
        }
        expect(seen.size).toBeGreaterThanOrEqual(1);
      }, 120_000);

      it('a SEQUENTIAL accept-then-action is refused too (no barrier needed once the membership is committed)', async () => {
        const s = await sc.setup();
        const invite = await f.prepareStaffInvite(
          s.owner,
          s.vendorId,
          s.branchId,
          s.actor.phone,
        );
        await f
          .acceptStaffInvite(invite.phone, invite.verificationToken)
          .expect(200);
        const res = await s.act();
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe(
          'PLATFORM_VENDOR_CONFLICT_OF_INTEREST',
        );
        await s.assertNotApplied();
      });
    },
  );

  // ---------------------------------------------------------------
  describe('suspension concurrency', () => {
    async function activeVendor() {
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
      await f.makeVendorActive(vendorId);
      return { owner, vendorId, branchId: branchIds[0] };
    }

    it('two admins suspending the same store at once: exactly one wins (201), the other gets 409 VENDOR_ALREADY_SUSPENDED, one open suspension, one audit row', async () => {
      const a1 = await f.platformUser('PLATFORM_ADMIN');
      const a2 = await f.platformUser('PLATFORM_ADMIN');
      const { vendorId } = await activeVendor();
      const [r1, r2] = await Promise.all([
        run(f.suspend(a1.token, vendorId)),
        run(f.suspend(a2.token, vendorId)),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
      const loser = r1.status === 409 ? r1 : r2;
      expect(loser.body.error.code).toBe('VENDOR_ALREADY_SUSPENDED');
      expect(
        await ctx.prisma.vendorSuspension.count({
          where: { vendorId, reactivatedAt: null },
        }),
      ).toBe(1);
      expect(
        await ctx.prisma.auditLog.count({
          where: { entityId: vendorId, action: 'vendor.suspended' },
        }),
      ).toBe(1);
    });

    it('suspend racing reactivate on an ACTIVE store: the end state is always consistent (SUSPENDED <=> exactly one open suspension), no 500', async () => {
      const a1 = await f.platformUser('PLATFORM_ADMIN');
      const a2 = await f.platformUser('PLATFORM_ADMIN');
      const { vendorId } = await activeVendor();
      const [s, r] = await Promise.all([
        run(f.suspend(a1.token, vendorId)),
        run(f.reactivate(a2.token, vendorId)),
      ]);
      expect(s.status).toBe(201);
      expect([201, 409]).toContain(r.status);
      const vendor = await ctx.prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      const open = await ctx.prisma.vendorSuspension.count({
        where: { vendorId, reactivatedAt: null },
      });
      if (r.status === 201) {
        // reactivate ran after the suspend committed
        expect(vendor.status).toBe('ACTIVE');
        expect(open).toBe(0);
      } else {
        expect(r.body.error.code).toBe('VENDOR_NOT_SUSPENDED');
        expect(vendor.status).toBe('SUSPENDED');
        expect(open).toBe(1);
      }
    });

    it('suspend racing a subscription renewal never deadlocks or 500s; the store ends SUSPENDED with an ACTIVE subscription', async () => {
      const admin = await f.platformUser('PLATFORM_ADMIN');
      const { owner, vendorId } = await activeVendor();
      await ctx.prisma.vendorSubscription.create({
        data: {
          vendorId,
          status: 'EXPIRED',
          periodStart: new Date(Date.now() - 40 * 86400_000),
          periodEnd: new Date(Date.now() - 10 * 86400_000),
        },
      });
      await ctx.prisma.vendor.update({
        where: { id: vendorId },
        data: { subscriptionStatus: 'EXPIRED' },
      });
      const [s, r] = await Promise.all([
        run(f.suspend(admin.token, vendorId)),
        run(
          request(http())
            .post(`/api/v1/vendors/${vendorId}/subscription/renew`)
            .set('Authorization', `Bearer ${owner}`)
            .set('Idempotency-Key', f.unique('renew'))
            .send({}),
        ),
      ]);
      expect(s.status).toBe(201);
      expect(r.status).toBe(200);
      const vendor = await ctx.prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('SUSPENDED');
      expect(vendor.subscriptionStatus).toBe('ACTIVE');
    });

    it('DETERMINISTIC: while a suspension holds the vendor lock, a checkout confirm for that store waits, then fails ITEM_NOT_PURCHASABLE and creates NO order', async () => {
      const admin = await f.platformUser('PLATFORM_ADMIN');
      const { vendorId, branchId } = await activeVendor();
      const variantId = await f.createOfferWithStock(vendorId, branchId, 10, 5);
      const customer = await f.signup(f.uniquePhone(), 'a-strong-password');
      const itemId = await f.addToCart(customer, vendorId, variantId, 1);
      const reserved = await f
        .reserve(customer, branchId, [itemId])
        .expect(201);
      const barrier = barrierOnAudit('vendor.suspended');

      const suspendP = run(f.suspend(admin.token, vendorId));
      await barrier.reached();
      const confirmP = run(f.confirm(customer, reserved.body.reservation_id));

      expect(await settledWithin(confirmP, 700)).toBe(false);
      expect(await ctx.prisma.branchOrder.count({ where: { vendorId } })).toBe(
        0,
      );

      barrier.release();
      const [s, c] = await Promise.all([suspendP, confirmP]);
      expect(s.status).toBe(201);
      expect(c.status).toBe(409);
      expect(c.body.error.code).toBe('ITEM_NOT_PURCHASABLE');
      expect(await ctx.prisma.branchOrder.count({ where: { vendorId } })).toBe(
        0,
      );
    });

    it('UNCOORDINATED suspend vs confirm (x5): confirm succeeds iff an order exists, never a 500/deadlock, and once suspended no further order can be confirmed', async () => {
      const admin = await f.platformUser('PLATFORM_ADMIN');
      for (let i = 0; i < 5; i++) {
        const { vendorId, branchId } = await activeVendor();
        const variantId = await f.createOfferWithStock(
          vendorId,
          branchId,
          10,
          5,
        );
        const customer = await f.signup(f.uniquePhone(), 'a-strong-password');
        const itemId = await f.addToCart(customer, vendorId, variantId, 1);
        const reserved = await f
          .reserve(customer, branchId, [itemId])
          .expect(201);

        const [s, c] = await Promise.all([
          run(f.suspend(admin.token, vendorId)),
          run(f.confirm(customer, reserved.body.reservation_id)),
        ]);
        expect(s.status).toBe(201);
        const orders = await ctx.prisma.branchOrder.count({
          where: { vendorId },
        });
        if (c.status === 201) {
          expect(orders).toBe(1);
        } else {
          expect(c.status).toBe(409);
          expect(c.body.error.code).toBe('ITEM_NOT_PURCHASABLE');
          expect(orders).toBe(0);
        }
        // After the suspension is committed no new confirm can succeed.
        const item2 = await ctx.prisma.cartItem.findFirst({
          where: { vendorId },
        });
        if (item2) {
          const again = await f.reserve(customer, branchId, [item2.id]);
          expect(again.status).toBeGreaterThanOrEqual(400);
        }
      }
    }, 120_000);
  });

  // ---------------------------------------------------------------
  describe('verification decision concurrency', () => {
    it('a reviewer decision racing an owner resubmission: never both succeed, never a decision on evidence the reviewer did not see', async () => {
      for (let i = 0; i < 4; i++) {
        const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
        const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
        const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
        await f.submitBranchEvidence(owner, vendorId, branchIds[0]).expect(201);

        const [d, r] = await Promise.all([
          run(
            f.decideBranch(reviewer.token, vendorId, branchIds[0], {
              decision: 'approve',
              evidence_revision: 1,
            }),
          ),
          run(
            f.submitBranchEvidence(owner, vendorId, branchIds[0], {
              verification_photo_url: 'https://example.com/replacement.jpg',
            }),
          ),
        ]);
        expect([d.status, r.status]).not.toContain(500);
        const branch = await ctx.prisma.storeBranch.findUniqueOrThrow({
          where: { id: branchIds[0] },
        });
        if (d.status === 201) {
          // Decided on revision 1: the resubmission came after and was refused.
          expect(r.status).toBe(409);
          expect(branch.evidenceRevision).toBe(1);
          expect(branch.verificationStatus).toBe('APPROVED');
        } else {
          // The resubmission won: the decision was stale.
          expect(d.status).toBe(409);
          expect(d.body.error.code).toBe('BRANCH_EVIDENCE_STALE');
          expect(r.status).toBe(201);
          expect(branch.evidenceRevision).toBe(2);
          expect(branch.verificationStatus).toBe('PENDING');
        }
      }
    }, 120_000);

    it('two reviewers deciding the same branch evidence at once: exactly one decision is recorded', async () => {
      const r1 = await f.platformUser('VERIFICATION_REVIEWER');
      const r2 = await f.platformUser('PLATFORM_ADMIN');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
      await f.submitBranchEvidence(owner, vendorId, branchIds[0]).expect(201);
      const [a, b] = await Promise.all([
        run(
          f.decideBranch(r1.token, vendorId, branchIds[0], {
            decision: 'approve',
            evidence_revision: 1,
          }),
        ),
        run(
          f.decideBranch(r2.token, vendorId, branchIds[0], {
            decision: 'reject',
            evidence_revision: 1,
            reason: 'The photo does not match the pin',
          }),
        ),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            action: 'store_branch.verification_decided',
            entityId: branchIds[0],
          },
        }),
      ).toBe(1);
    });

    it('two reviewers deciding the same warehouse evidence at once: exactly one decision is recorded', async () => {
      const r1 = await f.platformUser('VERIFICATION_REVIEWER');
      const r2 = await f.platformUser('PLATFORM_ADMIN');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId } = await f.createOnlineOnlyVendor(owner);
      await f.setWarehouse(owner, vendorId);
      const ev = await f.submitWarehouseEvidence(owner, vendorId).expect(201);
      const [a, b] = await Promise.all([
        run(
          f.decideWarehouse(r1.token, vendorId, {
            evidence_id: ev.body.id,
            decision: 'approve',
          }),
        ),
        run(
          f.decideWarehouse(r2.token, vendorId, {
            evidence_id: ev.body.id,
            decision: 'reject',
            reason: 'The address cannot be verified',
          }),
        ),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            action: 'warehouse_verification_evidence.decided',
            entityId: ev.body.id,
          },
        }),
      ).toBe(1);
    });

    it('the same Idempotency-Key sent twice at the same instant produces one suspension, never two and never a 500', async () => {
      const admin = await f.platformUser('PLATFORM_ADMIN');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId } = await f.createPhysicalVendor(owner, 1);
      await f.makeVendorActive(vendorId);
      const key = f.unique('same-key');
      const [a, b] = await Promise.all([
        run(f.suspend(admin.token, vendorId, undefined, key)),
        run(f.suspend(admin.token, vendorId, undefined, key)),
      ]);
      expect(a.status).toBeLessThan(500);
      expect(b.status).toBeLessThan(500);
      expect([a.status, b.status]).toContain(201);
      expect(
        await ctx.prisma.vendorSuspension.count({ where: { vendorId } }),
      ).toBe(1);
    });
  });
});
