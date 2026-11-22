import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { tb26Fixtures } from './helpers/tb26-fixtures';

// TB-27 / TB-28: buying from one's own store stays allowed (it is
// shopping), but the conflict of interest is refused by the API itself:
//  - TB-27: a person who is or was a member of the selling store cannot
//    write or change a review of that purchase (product or store review);
//  - TB-28: the person who placed an order cannot decide its return or
//    refund - as owner, employee or platform administrator - including
//    two parallel attempts.
// Runs on the shared test database with workspace_scoping_enabled off
// (its default), so staff calls need no workspace token here.
describe('TB-27/TB-28 no self-review, no self-decision (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const f = tb26Fixtures(() => app);

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
  });

  afterAll(async () => {
    await app.close();
  });

  const write = (
    method: 'post' | 'patch' | 'delete',
    url: string,
    who: { token: string },
  ) =>
    f
      .http()
      [method](`/api/v1${url}`)
      .set(f.bearer(who.token))
      .set('Idempotency-Key', f.unique('idem'));
  const code = (res: { body: { error?: { code?: string } } }) =>
    res.body.error?.code;

  /** A store with an owner and an employee of branch A, and one product. */
  async function shop() {
    const s = await f.store();
    const employee = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      s.branchA,
    );
    const variant = await f.offer(s, 50);
    return { s, employee, variant };
  }
  type Shop = Awaited<ReturnType<typeof shop>>;

  /** `buyer` buys (shopping) and the employee - or `by` - hands it over;
   * the order then allows a refund return for 14 days. */
  async function completedPurchase(
    sh: Shop,
    buyer: Awaited<ReturnType<typeof f.account>>,
    by: { token: string } = sh.employee,
  ) {
    const p = await f.buy(buyer, sh.s, sh.variant, { by });
    await prisma.branchOrder.update({
      where: { id: p.branchOrderId },
      data: {
        returnPolicySnapshotEnabled: true,
        returnPolicySnapshotMode: 'REFUND_ONLY',
        returnPolicySnapshotWindowDays: 14,
        returnPolicySnapshotFeeIls: 0,
      },
    });
    return p;
  }

  const review = (
    who: { token: string },
    itemId: string,
    target: 'PRODUCT' | 'STORE',
  ) =>
    write('post', '/reviews', who).send({
      source_branch_order_item_id: itemId,
      target_type: target,
      rating: 5,
      body: 'ممتاز',
    });

  async function requestReturn(
    who: { token: string },
    p: { branchOrderId: string; itemId: string },
  ): Promise<string> {
    const res = await write(
      'post',
      `/customers/me/orders/${p.branchOrderId}/items/${p.itemId}/returns`,
      who,
    )
      .send({ reason: 'DAMAGED' })
      .expect(201);
    return res.body.id as string;
  }
  const decide = (
    sh: Shop,
    who: { token: string },
    returnId: string,
    decision: 'approve' | 'reject',
  ) =>
    write(
      'patch',
      `/vendors/${sh.s.vendorId}/branches/${sh.s.branchA}/returns/${returnId}/decision`,
      who,
    ).send(
      decision === 'reject'
        ? { decision, rejection_reason: 'القطعة لا تطابق شروط الإرجاع' }
        : { decision },
    );

  describe('TB-27 reviews', () => {
    it('the owner buying from their own store is allowed (shopping) but cannot review the product or the store', async () => {
      const sh = await shop();
      const p = await completedPurchase(sh, sh.s.owner);
      const product = await review(sh.s.owner, p.itemId, 'PRODUCT').expect(403);
      expect(code(product)).toBe('STORE_MEMBER_CANNOT_REVIEW');
      const store = await review(sh.s.owner, p.itemId, 'STORE').expect(403);
      expect(code(store)).toBe('STORE_MEMBER_CANNOT_REVIEW');
      expect(
        await prisma.review.count({
          where: { sourceBranchOrderItemId: p.itemId },
        }),
      ).toBe(0);
    });

    it('an employee - and a former (suspended) employee - is refused too; a member of ANOTHER store reviews normally', async () => {
      const sh = await shop();
      const employeePurchase = await completedPurchase(
        sh,
        sh.employee,
        sh.s.owner,
      );
      expect(
        code(
          await review(sh.employee, employeePurchase.itemId, 'PRODUCT').expect(
            403,
          ),
        ),
      ).toBe('STORE_MEMBER_CANNOT_REVIEW');

      const former = await f.member(
        sh.s.vendorId,
        await f.account(),
        'BRANCH_EMPLOYEE',
        sh.s.branchA,
        'SUSPENDED',
      );
      const formerPurchase = await completedPurchase(sh, former);
      expect(
        code(await review(former, formerPurchase.itemId, 'STORE').expect(403)),
      ).toBe('STORE_MEMBER_CANNOT_REVIEW');

      const elsewhere = await f.store();
      const otherOwner = elsewhere.owner;
      const ok = await completedPurchase(sh, otherOwner);
      await review(otherOwner, ok.itemId, 'PRODUCT').expect(201);
    });

    it('a review written before the person joined the store stays as it is (never hidden or deleted automatically), but can no longer be edited or given an image; deleting it is still allowed', async () => {
      const sh = await shop();
      const customer = await f.account();
      const p = await completedPurchase(sh, customer);
      const written = await review(customer, p.itemId, 'PRODUCT').expect(201);
      await f.member(sh.s.vendorId, customer, 'BRANCH_EMPLOYEE', sh.s.branchB);

      const edit = await write('patch', `/reviews/${written.body.id}`, customer)
        .send({ rating: 1 })
        .expect(403);
      expect(code(edit)).toBe('STORE_MEMBER_CANNOT_REVIEW');
      const still = await prisma.review.findUniqueOrThrow({
        where: { id: written.body.id },
      });
      expect(still.rating).toBe(5);
      expect(still.moderationStatus).toBe('VISIBLE');
      expect(still.deletedAt).toBeNull();
      await write('delete', `/reviews/${written.body.id}`, customer).expect(
        204,
      );
    });
  });

  describe('TB-28 returns and refunds', () => {
    it('the owner cannot approve or reject their own return, nor accept its code; the employee can', async () => {
      const sh = await shop();
      const p = await completedPurchase(sh, sh.s.owner);
      const returnId = await requestReturn(sh.s.owner, p);

      expect(
        code(await decide(sh, sh.s.owner, returnId, 'approve').expect(403)),
      ).toBe('SELF_DECISION_FORBIDDEN');
      expect(
        code(await decide(sh, sh.s.owner, returnId, 'reject').expect(403)),
      ).toBe('SELF_DECISION_FORBIDDEN');
      expect(
        (await prisma.return.findUniqueOrThrow({ where: { id: returnId } }))
          .status,
      ).toBe('REQUESTED');

      await decide(sh, sh.employee, returnId, 'approve').expect(200);
      const approved = await prisma.return.findUniqueOrThrow({
        where: { id: returnId },
      });
      const redeem = (who: { token: string }) =>
        write('post', `/vendors/${sh.s.vendorId}/returns/redeem`, who).send({
          code: approved.code,
          receiving_branch_id: sh.s.branchA,
          item_condition: 'RESELLABLE',
        });
      expect(code(await redeem(sh.s.owner).expect(403))).toBe(
        'SELF_DECISION_FORBIDDEN',
      );
      expect(
        (await prisma.return.findUniqueOrThrow({ where: { id: returnId } }))
          .status,
      ).toBe('APPROVED_AWAITING_DROPOFF');
      await redeem(sh.employee).expect(201);
    });

    it('an employee cannot decide their own return; the owner can', async () => {
      const sh = await shop();
      const p = await completedPurchase(sh, sh.employee, sh.s.owner);
      const returnId = await requestReturn(sh.employee, p);
      expect(
        code(await decide(sh, sh.employee, returnId, 'approve').expect(403)),
      ).toBe('SELF_DECISION_FORBIDDEN');
      await decide(sh, sh.s.owner, returnId, 'reject').expect(200);
    });

    it('a platform administrator cannot decide their own escalated return; another administrator can', async () => {
      const sh = await shop();
      const admin = await f.account('PLATFORM_ADMIN');
      const otherAdmin = await f.account('PLATFORM_ADMIN');
      const p = await completedPurchase(sh, admin);
      const returnId = await requestReturn(admin, p);
      await prisma.return.update({
        where: { id: returnId },
        data: { status: 'ESCALATED', escalatedAt: new Date() },
      });
      const resolve = (who: { token: string }) =>
        write(
          'patch',
          `/admin/returns/${returnId}/escalation-decision`,
          who,
        ).send({ decision: 'approve' });
      expect(code(await resolve(admin).expect(403))).toBe(
        'SELF_DECISION_FORBIDDEN',
      );
      expect(
        (await prisma.return.findUniqueOrThrow({ where: { id: returnId } }))
          .status,
      ).toBe('ESCALATED');
      await resolve(otherAdmin).expect(200);
    });

    it('race: two parallel self-decisions both fail and change nothing; a parallel legitimate decision and a self-decision - exactly one decision, the legitimate one', async () => {
      const sh = await shop();
      const p = await completedPurchase(sh, sh.s.owner);
      const returnId = await requestReturn(sh.s.owner, p);

      const both = await Promise.all([
        decide(sh, sh.s.owner, returnId, 'approve'),
        decide(sh, sh.s.owner, returnId, 'reject'),
      ]);
      expect(both.map((r) => [r.status, code(r)])).toEqual([
        [403, 'SELF_DECISION_FORBIDDEN'],
        [403, 'SELF_DECISION_FORBIDDEN'],
      ]);
      expect(
        (await prisma.return.findUniqueOrThrow({ where: { id: returnId } }))
          .status,
      ).toBe('REQUESTED');

      const mixed = await Promise.all([
        decide(sh, sh.s.owner, returnId, 'reject'),
        decide(sh, sh.employee, returnId, 'approve'),
      ]);
      expect(mixed.map((r) => r.status)).toEqual([403, 200]);
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: returnId },
      });
      expect(r.status).toBe('APPROVED_AWAITING_DROPOFF');
      expect(r.rejectedAt).toBeNull();
      const decisions = await prisma.auditLog.findMany({
        where: {
          entityType: 'Return',
          entityId: returnId,
          action: {
            in: [
              'return.approved',
              'return.exchange_approved',
              'return.rejected',
            ],
          },
        },
      });
      expect(decisions.map((d) => [d.action, d.actorId])).toEqual([
        ['return.approved', sh.employee.userId],
      ]);
    });

    it("money decisions on one's own order are refused: staff cancellation, item cancellation, refund approval and an administrator's forced cancellation", async () => {
      const sh = await shop();
      const admin = await f.account('PLATFORM_ADMIN');
      const own = await f.buy(sh.s.owner, sh.s, sh.variant);
      const staffCall = (
        who: { token: string },
        orderId: string,
        action: string,
        body: object = {},
      ) => f.staff(sh.s, who, orderId, action, body);

      expect(
        code(
          await staffCall(sh.s.owner, own.branchOrderId, 'cancel').expect(403),
        ),
      ).toBe('SELF_DECISION_FORBIDDEN');
      expect(
        code(
          await staffCall(
            sh.s.owner,
            own.branchOrderId,
            `items/${own.itemId}/cancel`,
          ).expect(403),
        ),
      ).toBe('SELF_DECISION_FORBIDDEN');
      expect(
        (
          await prisma.branchOrder.findUniqueOrThrow({
            where: { id: own.branchOrderId },
          })
        ).status,
      ).toBe('PLACED');
      await staffCall(sh.employee, own.branchOrderId, 'cancel').expect(201);

      const adminOwn = await f.buy(admin, sh.s, sh.variant);
      const force = (who: { token: string }) =>
        write(
          'post',
          `/admin/branch-orders/${adminOwn.branchOrderId}/cancel`,
          who,
        ).send({ reason: 'سبب إداري للاختبار' });
      expect(code(await force(admin).expect(403))).toBe(
        'SELF_DECISION_FORBIDDEN',
      );
      expect(
        (
          await prisma.branchOrder.findUniqueOrThrow({
            where: { id: adminOwn.branchOrderId },
          })
        ).status,
      ).toBe('PLACED');

      const refund = await f.buy(sh.employee, sh.s, sh.variant);
      await prisma.branchOrder.update({
        where: { id: refund.branchOrderId },
        data: { status: 'REFUND_REQUESTED' },
      });
      expect(
        code(
          await staffCall(
            sh.employee,
            refund.branchOrderId,
            'approve-refund',
          ).expect(403),
        ),
      ).toBe('SELF_DECISION_FORBIDDEN');
      expect(
        (
          await prisma.branchOrder.findUniqueOrThrow({
            where: { id: refund.branchOrderId },
          })
        ).status,
      ).toBe('REFUND_REQUESTED');
    });
  });
  describe('TB-28 self-fulfilment is allowed and audited', () => {
    const selfAudits = (orderId: string) =>
      prisma.auditLog.findMany({
        where: {
          entityType: 'BranchOrder',
          entityId: orderId,
          action: 'branch_order.self_fulfilment',
        },
        orderBy: { occurredAt: 'asc' },
      });

    it('the owner (even as the only member) prepares and hands over their own order and records the cash; each step is audited as a self-fulfilment', async () => {
      const s = await f.store();
      const variant = await f.offer(s, 10);
      const own = await f.buy(s.owner, s, variant);
      const order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: own.branchOrderId },
      });
      await f
        .staff(s, s.owner, own.branchOrderId, 'start-preparation')
        .expect(201);
      await f
        .staff(s, s.owner, own.branchOrderId, 'pickup-handover', {
          pickup_code: order.pickupCode,
        })
        .expect(201);
      const done = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: own.branchOrderId },
      });
      expect(done.codCollectedAt).not.toBeNull();
      const audits = await selfAudits(own.branchOrderId);
      expect(
        audits.map((a) => [
          a.actorId,
          (a.afterState as Record<string, unknown>).step,
          (a.afterState as Record<string, unknown>).self_fulfilment,
        ]),
      ).toEqual([
        [s.owner.userId, 'START_PREPARATION', true],
        [s.owner.userId, 'PICKUP_HANDOVER', true],
      ]);
    });

    it('the same rule for an employee; fulfilling another customer order writes no self-fulfilment record', async () => {
      const sh = await shop();
      const own = await f.buy(sh.employee, sh.s, sh.variant);
      await f
        .staff(sh.s, sh.employee, own.branchOrderId, 'start-preparation')
        .expect(201);
      expect(
        (await selfAudits(own.branchOrderId)).map((a) => a.actorId),
      ).toEqual([sh.employee.userId]);
      const customer = await f.account();
      const theirs = await f.buy(customer, sh.s, sh.variant);
      await f
        .staff(sh.s, sh.employee, theirs.branchOrderId, 'start-preparation')
        .expect(201);
      expect(await selfAudits(theirs.branchOrderId)).toEqual([]);
    });

    it('parallel self-fulfilment of the same step: one succeeds, one is refused by the order state, and there is exactly one self-fulfilment record for it', async () => {
      const s = await f.store();
      const variant = await f.offer(s, 10);
      const own = await f.buy(s.owner, s, variant);
      const results = await Promise.all([
        f.staff(s, s.owner, own.branchOrderId, 'start-preparation'),
        f.staff(s, s.owner, own.branchOrderId, 'start-preparation'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await selfAudits(own.branchOrderId)).toHaveLength(1);
      expect(
        (
          await prisma.branchOrder.findUniqueOrThrow({
            where: { id: own.branchOrderId },
          })
        ).status,
      ).toBe('PREPARING');
    });

    it('in parallel with a refused decision: the owner prepares their own order while trying to cancel it - the preparation goes through, the cancellation is refused', async () => {
      const s = await f.store();
      const variant = await f.offer(s, 10);
      const own = await f.buy(s.owner, s, variant);
      const [prep, cancel] = await Promise.all([
        f.staff(s, s.owner, own.branchOrderId, 'start-preparation'),
        f.staff(s, s.owner, own.branchOrderId, 'cancel', {
          reason: 'إلغاء ذاتي للاختبار',
        }),
      ]);
      expect(prep.status).toBe(201);
      expect([cancel.status, code(cancel)]).toEqual([
        403,
        'SELF_DECISION_FORBIDDEN',
      ]);
      expect(
        (
          await prisma.branchOrder.findUniqueOrThrow({
            where: { id: own.branchOrderId },
          })
        ).status,
      ).toBe('PREPARING');
    });
  });
});
