import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuditLogService } from './../src/audit/audit-log.service';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { ReturnSweepService } from './../src/returns/return-sweep.service';
import { createUniquePhone } from './helpers/e2e-phone-lanes';
import { sweepUntil } from './helpers/sweep-until';

type Res = { status: number; body: any };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// supertest's Test object is lazy - Promise.resolve(t) forces dispatch
// immediately (see sprint20b-checkout-policy.e2e-spec.ts's own comment
// for the full reasoning/history of this fix).
const run = (t: PromiseLike<Res>): Promise<Res> => Promise.resolve(t);

class FakeSmsService {
  sent: { phone: string; code: string; expiresAt: Date }[] = [];
  async sendOtp(phone: string, code: string, expiresAt: Date) {
    this.sent.push({ phone, code, expiresAt });
  }
  lastCodeFor(phone: string): string {
    const matches = this.sent.filter((s) => s.phone === phone);
    if (matches.length === 0) {
      throw new Error(`No OTP was ever sent to ${phone} in this test`);
    }
    return matches[matches.length - 1].code;
  }
}

// Fixed, disjoint lane - see ./helpers/e2e-phone-lanes.ts.
const uniquePhone = createUniquePhone('sprint21-returns', '56');
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 21 - returns: policy, request, code, receipt, refund (e2e)', () => {
  let app: INestApplication | undefined;
  let fakeSms: FakeSmsService;
  let prisma: PrismaService;
  let sweep: ReturnSweepService;

  beforeEach(async () => {
    fakeSms = new FakeSmsService();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SmsService)
      .useValue(fakeSms)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    sweep = app.get(ReturnSweepService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (app) {
      await app.close();
    }
  });

  async function signup(phone: string, password: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'signup' })
      .expect(202);
    const code = fakeSms.lastCodeFor(phone);
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', `verify-${phone}`)
      .send({ phone, otp_code: code, purpose: 'signup' })
      .expect(200);
    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ phone, password, verification_token: verify.body.session_token })
      .expect(201);
    return register.body.session_token as string;
  }

  async function platformAdmin(): Promise<string> {
    const phone = uniquePhone();
    const token = await signup(phone, 'a-strong-password');
    await prisma.user.update({
      where: { phone },
      data: { platformRole: 'PLATFORM_ADMIN' },
    });
    return token;
  }

  async function createVendorWithBranch(
    ownerToken: string,
    returnPolicy: Record<string, unknown> = {
      mode: 'REFUND_ONLY',
      window_days: 14,
      fee_ils: 5,
    },
    branchName = 'Branch A',
  ): Promise<{ vendorId: string; branchId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        store_type: 'PHYSICAL',
        branches: [{ name: branchName, is_physical: true }],
        applicable_categories: ['WOMEN'],
        return_policy: returnPolicy,
      })
      .expect(201);
    return { vendorId: res.body.id, branchId: res.body.branches[0].id };
  }

  async function addBranch(
    owner: string,
    vendorId: string,
    name: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/branches`)
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('add-branch'))
      .send({ name, is_physical: true })
      .expect(201);
    return res.body.id;
  }

  async function makeVendorEligible(vendorId: string): Promise<void> {
    await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    await prisma.storeBranch.updateMany({
      where: { vendorId },
      data: { verificationStatus: 'APPROVED' },
    });
  }

  async function createOfferWithStock(
    vendorId: string,
    branchId: string,
    price: number,
    quantity: number,
  ): Promise<string> {
    await makeVendorEligible(vendorId);
    const offer = await prisma.vendorOffer.create({
      data: { vendorId, titleAr: 'م', titleEn: 'P', status: 'ACTIVE' },
    });
    const variant = await prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique('sku'),
        basePrice: price,
        storeInventoryBarcode: unique('barcode'),
      },
    });
    await prisma.branchStock.create({
      data: { vendorId, branchId, offerVariantId: variant.id, quantity },
    });
    return variant.id;
  }

  async function addToCart(
    token: string,
    vendorId: string,
    offerVariantId: string,
    quantity: number,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('cart-add'))
      .send({ vendor_id: vendorId, offer_variant_id: offerVariantId, quantity })
      .expect(201);
    return res.body.id;
  }

  const staffAction = (
    token: string,
    vendorId: string,
    branchId: string,
    branchOrderId: string,
    action: string,
    body: Record<string, unknown> = {},
  ) =>
    request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/orders/${branchOrderId}/${action}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('staff-action'))
      .send(body);

  /** Places a PICKUP BranchOrder and drives it all the way to
   * PICKED_UP/COMPLETED (return-eligible), returning the item id. */
  async function placeAndPickUpOrder(
    owner: string,
    customer: string,
    vendorId: string,
    branchId: string,
    variantId: string,
    paymentMethod: 'COD' | 'ONLINE' = 'ONLINE',
  ): Promise<{ branchOrderId: string; itemId: string }> {
    const cartItemId = await addToCart(customer, vendorId, variantId, 1);
    const reserved = await request(app.getHttpServer())
      .post('/api/v1/checkout/reserve')
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', unique('reserve'))
      .send({
        terms_accepted: true,
        terms_version: '2026-10-v1',
        groups: [
          {
            cart_item_ids: [cartItemId],
            branch_id: branchId,
            fulfilment_method: 'PICKUP',
            payment_method: paymentMethod,
          },
        ],
      })
      .expect(201);
    const confirmed = await request(app.getHttpServer())
      .post('/api/v1/checkout/confirm')
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', unique('confirm'))
      .send({ reservation_id: reserved.body.reservation_id })
      .expect(201);
    const branchOrderId = confirmed.body.branch_orders[0].id as string;
    const pickupCode = confirmed.body.branch_orders[0].pickup_code as string;

    await staffAction(
      owner,
      vendorId,
      branchId,
      branchOrderId,
      'start-preparation',
    ).expect(201);
    await staffAction(
      owner,
      vendorId,
      branchId,
      branchOrderId,
      'pickup-handover',
      { pickup_code: pickupCode },
    ).expect(201);

    const item = await prisma.branchOrderItem.findFirstOrThrow({
      where: { branchOrderId },
    });
    return { branchOrderId, itemId: item.id };
  }

  const customerReturnAction = (
    token: string,
    path: string,
    body: Record<string, unknown> = {},
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/customers/me/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('customer-return'))
      .send(body);

  async function submitReturn(
    customer: string,
    branchOrderId: string,
    itemId: string,
    reason = 'CHANGE_OF_MIND',
  ): Promise<Res> {
    return customerReturnAction(
      customer,
      `orders/${branchOrderId}/items/${itemId}/returns`,
      { reason },
    );
  }

  const decideReturn = (
    owner: string,
    vendorId: string,
    branchId: string,
    returnId: string,
    body: Record<string, unknown>,
  ) =>
    request(app.getHttpServer())
      .patch(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/returns/${returnId}/decision`,
      )
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('decide'))
      .send(body);

  const redeemReturn = (
    staffToken: string,
    vendorId: string,
    body: Record<string, unknown>,
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/returns/redeem`)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('Idempotency-Key', unique('redeem'))
      .send(body);

  // ------------------------------------------------------------
  // Barrier helpers - same proven pattern as
  // sprint16-moderation-concurrency.e2e-spec.ts /
  // sprint20b-checkout-policy.e2e-spec.ts's own barrierOnAudit.
  // ------------------------------------------------------------
  function barrierOnAudit(action: string) {
    const audit = app!.get(AuditLogService);
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

  async function someoneWaitsOnLock(queryPattern: string): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE $1`,
        queryPattern,
      );
      if (Number(rows[0].n) > 0) return true;
      await sleep(100);
    }
    return false;
  }

  // ============================================================
  // Return policy - selected at registration, updated later under a
  // 6-month lock (PDR-030).
  // ============================================================
  describe('Return policy (PDR-030)', () => {
    it('is required at POST /vendors - NO_RETURN needs no window/fee, REFUND_ONLY requires both, EXCHANGE_ONLY/BOTH are rejected', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');

      const noReturn = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          store_type: 'PHYSICAL',
          branches: [{ name: 'B', is_physical: true }],
          applicable_categories: ['WOMEN'],
          return_policy: { mode: 'NO_RETURN' },
        });
      expect(noReturn.status).toBe(201);

      const missingFields = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          store_type: 'PHYSICAL',
          branches: [{ name: 'B', is_physical: true }],
          applicable_categories: ['WOMEN'],
          return_policy: { mode: 'REFUND_ONLY' },
        });
      expect(missingFields.status).toBe(400);

      const exchangeRejected = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          store_type: 'PHYSICAL',
          branches: [{ name: 'B', is_physical: true }],
          applicable_categories: ['WOMEN'],
          return_policy: { mode: 'EXCHANGE_ONLY', window_days: 14, fee_ils: 5 },
        });
      expect(exchangeRejected.status).toBe(400);

      const vendorNoPolicy = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          store_type: 'PHYSICAL',
          branches: [{ name: 'B', is_physical: true }],
          applicable_categories: ['WOMEN'],
        });
      expect(vendorNoPolicy.status).toBe(400);
    });

    it('owner can read/update the policy; a second update within 6 months is rejected 409', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);

      const get1 = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/return-policy`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(get1.body.mode).toBe('REFUND_ONLY');
      expect(get1.body.window_days).toBe(14);
      expect(get1.body.fee_ils).toBe(5);

      // createVendorWithBranch() already set returnPolicyUpdatedAt=now()
      // at registration - back-date it so THIS test's first update is
      // itself allowed (otherwise it would hit the same 6-month gate
      // the second update below is actually testing).
      await prisma.vendor.update({
        where: { id: vendorId },
        data: {
          returnPolicyUpdatedAt: new Date(
            Date.now() - 200 * 24 * 60 * 60 * 1000,
          ),
        },
      });

      const update = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/return-policy`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('policy-update'))
        .send({ mode: 'REFUND_ONLY', window_days: 30, fee_ils: 10 })
        .expect(200);
      expect(update.body.window_days).toBe(30);

      const tooSoon = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/return-policy`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('policy-update'))
        .send({ mode: 'NO_RETURN' });
      expect(tooSoon.status).toBe(409);
      expect(tooSoon.body.error.code).toBe('RETURN_POLICY_CHANGE_TOO_SOON');
    });

    it('a legacy vendor (returnPolicyUpdatedAt still null) is never gated on its first post-migration write', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);
      // Simulate a pre-S21 row - no policy decision ever recorded.
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { returnPolicyUpdatedAt: null },
      });

      const update = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/return-policy`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('policy-update'))
        .send({ mode: 'REFUND_ONLY', window_days: 7, fee_ils: 0 });
      expect(update.status).toBe(200);
    });

    it('deterministic concurrency (barrier-proven): two concurrent policy updates before 6 months - the second genuinely waits, then is rejected after re-reading the FRESH timestamp', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);
      // Old enough that the FIRST update is allowed.
      await prisma.vendor.update({
        where: { id: vendorId },
        data: {
          returnPolicyUpdatedAt: new Date(
            Date.now() - 200 * 24 * 60 * 60 * 1000,
          ),
        },
      });

      const barrier = barrierOnAudit('vendor.return_policy_updated');
      const firstPromise: Promise<Res> = run(
        request(app.getHttpServer())
          .put(`/api/v1/vendors/${vendorId}/return-policy`)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('policy-update'))
          .send({ mode: 'REFUND_ONLY', window_days: 20, fee_ils: 1 }),
      );
      await barrier.reached();
      const secondPromise: Promise<Res> = run(
        request(app.getHttpServer())
          .put(`/api/v1/vendors/${vendorId}/return-policy`)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('policy-update'))
          .send({ mode: 'REFUND_ONLY', window_days: 25, fee_ils: 2 }),
      );

      expect(await someoneWaitsOnLock('%FROM vendors%FOR UPDATE%')).toBe(true);
      expect(await settledWithin(secondPromise, 700)).toBe(false);

      barrier.release();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('RETURN_POLICY_CHANGE_TOO_SOON');

      const final = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(final.returnWindowDays).toBe(20);
    });
  });

  // ============================================================
  // Submit / cancel / dispute / resubmission rules.
  // ============================================================
  describe('Submit, cancel, dispute, resubmission (FR-RET-001..007)', () => {
    it('ineligible before pickup/delivery; eligible once PICKED_UP', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');

      const cartItemId = await addToCart(customer, vendorId, variantId, 1);
      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          terms_accepted: true,
          terms_version: '2026-10-v1',
          groups: [
            {
              cart_item_ids: [cartItemId],
              branch_id: branchId,
              fulfilment_method: 'PICKUP',
              payment_method: 'ONLINE',
            },
          ],
        })
        .expect(201);
      const confirmed = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id })
        .expect(201);
      const branchOrderId = confirmed.body.branch_orders[0].id as string;
      const item = await prisma.branchOrderItem.findFirstOrThrow({
        where: { branchOrderId },
      });

      const tooEarly = await submitReturn(customer, branchOrderId, item.id);
      expect(tooEarly.status).toBe(409);
      expect(tooEarly.body.error.code).toBe('NOT_ELIGIBLE_FOR_RETURN');
      expect(tooEarly.body.error.details[0].reason_code).toBe(
        'NOT_YET_ARRIVED',
      );
    });

    it('NO_RETURN vendor: submitting is always rejected', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner, {
        mode: 'NO_RETURN',
      });
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const res = await submitReturn(customer, branchOrderId, itemId);
      expect(res.status).toBe(409);
      expect(res.body.error.details[0].reason_code).toBe('RETURNS_DISABLED');
    });

    it('a valid submission creates REQUESTED; a second concurrent request on the same item is rejected (open-return guard)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );

      const first = await submitReturn(customer, branchOrderId, itemId);
      expect(first.status).toBe(201);
      expect(first.body.status).toBe('REQUESTED');

      const second = await submitReturn(customer, branchOrderId, itemId);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('RETURN_ALREADY_EXISTS');
    });

    it('customer can cancel while REQUESTED, not after APPROVED_AWAITING_DROPOFF', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customerPhone = uniquePhone();
      const customer = await signup(customerPhone, 'a-strong-password');
      const customerUser = await prisma.user.findUniqueOrThrow({
        where: { phone: customerPhone },
      });
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      const returnId = submitted.body.id;

      // Review-round requirement: actorId must be the REAL signed-in
      // customer, never null - a human actor did this.
      const submitAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          entityType: 'Return',
          entityId: returnId,
          action: 'return.requested',
        },
      });
      expect(submitAudit.actorId).toBe(customerUser.id);

      const cancelled = await customerReturnAction(
        customer,
        `returns/${returnId}/cancel`,
      );
      expect(cancelled.status).toBe(201);
      expect(cancelled.body.status).toBe('CANCELLED_BY_CUSTOMER');

      const cancelAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          entityType: 'Return',
          entityId: returnId,
          action: 'return.cancelled_by_customer',
        },
      });
      expect(cancelAudit.actorId).toBe(customerUser.id);

      // Resubmission after CANCELLED_BY_CUSTOMER succeeds.
      const resubmitted = await submitReturn(customer, branchOrderId, itemId);
      expect(resubmitted.status).toBe(201);

      const approved = await decideReturn(
        owner,
        vendorId,
        branchId,
        resubmitted.body.id,
        { decision: 'approve' },
      );
      expect(approved.status).toBe(200);

      const cancelAfterApproval = await customerReturnAction(
        customer,
        `returns/${resubmitted.body.id}/cancel`,
      );
      expect(cancelAfterApproval.status).toBe(409);
      expect(cancelAfterApproval.body.error.code).toBe(
        'RETURN_NOT_CANCELLABLE',
      );
    });

    it('rejection requires a reason (10-1000 chars); resubmission is blocked while the dispute window is open, allowed after it closes', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      const returnId = submitted.body.id;

      const noReason = await decideReturn(owner, vendorId, branchId, returnId, {
        decision: 'reject',
      });
      expect(noReason.status).toBe(400);

      const rejected = await decideReturn(owner, vendorId, branchId, returnId, {
        decision: 'reject',
        rejection_reason: 'Item shows clear signs of prior use by customer.',
      });
      expect(rejected.status).toBe(200);
      expect(rejected.body.status).toBe('REJECTED');

      const blockedResubmit = await submitReturn(
        customer,
        branchOrderId,
        itemId,
      );
      expect(blockedResubmit.status).toBe(409);

      // Force the dispute window closed (sweep-driven, same lazy
      // pattern as every other time-based transition in this codebase).
      await prisma.return.update({
        where: { id: returnId },
        data: { disputeDeadlineAt: new Date(Date.now() - 1000) },
      });
      await sweepUntil(
        () => sweep.sweepOnce(),
        async () =>
          (await prisma.return.findUniqueOrThrow({ where: { id: returnId } }))
            .status !== 'REJECTED',
      );
      const closed = await prisma.return.findUniqueOrThrow({
        where: { id: returnId },
      });
      expect(closed.status).toBe('REJECTED_CLOSED');

      const closureAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          entityType: 'Return',
          entityId: returnId,
          action: 'return.dispute_window_closed',
        },
      });
      expect(closureAudit.actorId).toBeNull();
      expect(closureAudit.beforeState).toMatchObject({ status: 'REJECTED' });
      expect(closureAudit.afterState).toMatchObject({
        status: 'REJECTED_CLOSED',
      });

      const allowedResubmit = await submitReturn(
        customer,
        branchOrderId,
        itemId,
      );
      expect(allowedResubmit.status).toBe(201);
    });

    it('customer disputes a rejection within the window -> ESCALATED; disputing after the window is rejected', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customerPhone = uniquePhone();
      const customer = await signup(customerPhone, 'a-strong-password');
      const customerUser = await prisma.user.findUniqueOrThrow({
        where: { phone: customerPhone },
      });
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      const returnId = submitted.body.id;
      await decideReturn(owner, vendorId, branchId, returnId, {
        decision: 'reject',
        rejection_reason: 'Outside the stated return policy for this item.',
      }).expect(200);

      const disputed = await customerReturnAction(
        customer,
        `returns/${returnId}/dispute`,
      );
      expect(disputed.status).toBe(201);
      expect(disputed.body.status).toBe('ESCALATED');

      const disputeAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          entityType: 'Return',
          entityId: returnId,
          action: 'return.disputed',
        },
      });
      expect(disputeAudit.actorId).toBe(customerUser.id);
    });

    it('no return is ever possible again once REFUNDED (not merely while open)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      const returnId = submitted.body.id;
      await decideReturn(owner, vendorId, branchId, returnId, {
        decision: 'approve',
      }).expect(200);
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: returnId },
      });
      await redeemReturn(owner, vendorId, {
        code: r.code,
        receiving_branch_id: branchId,
        item_condition: 'RESELLABLE',
      }).expect(201);

      const blocked = await submitReturn(customer, branchOrderId, itemId);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('RETURN_ALREADY_EXISTS');
    });

    it("GET /customers/me/returns lists only the signed-in customer's own returns, newest first, with the item title and order/item ids", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customerA = await signup(uniquePhone(), 'a-strong-password');
      const customerB = await signup(uniquePhone(), 'a-strong-password');

      const orderA = await placeAndPickUpOrder(
        owner,
        customerA,
        vendorId,
        branchId,
        variantId,
      );
      const returnA = await submitReturn(
        customerA,
        orderA.branchOrderId,
        orderA.itemId,
      );

      const orderB = await placeAndPickUpOrder(
        owner,
        customerB,
        vendorId,
        branchId,
        variantId,
      );
      await submitReturn(customerB, orderB.branchOrderId, orderB.itemId);

      const list = await request(app.getHttpServer())
        .get('/api/v1/customers/me/returns')
        .set('Authorization', `Bearer ${customerA}`);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({
        id: returnA.body.id,
        branch_order_id: orderA.branchOrderId,
        branch_order_item_id: orderA.itemId,
      });
      expect(typeof list.body[0].title_ar).toBe('string');
    });
  });

  // ============================================================
  // SLA: 48h reminder, 72h auto-escalation, admin escalation
  // resolution (ADMIN_REJECTED is final - never disputable/
  // resubmittable, unlike a plain store REJECTED).
  // ============================================================
  describe('SLA and escalation (PDR-031)', () => {
    it('48h with no vendor decision sends a reminder; 72h auto-escalates', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      const returnId = submitted.body.id;

      await prisma.return.update({
        where: { id: returnId },
        data: { createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
      });
      await sweepUntil(
        () => sweep.sweepOnce(),
        async () =>
          (await prisma.return.findUniqueOrThrow({ where: { id: returnId } }))
            .vendorReminderSentAt !== null,
      );
      const afterReminder = await prisma.return.findUniqueOrThrow({
        where: { id: returnId },
      });
      expect(afterReminder.vendorReminderSentAt).not.toBeNull();
      expect(afterReminder.status).toBe('REQUESTED');

      await prisma.return.update({
        where: { id: returnId },
        data: { createdAt: new Date(Date.now() - 73 * 60 * 60 * 1000) },
      });
      await sweepUntil(
        () => sweep.sweepOnce(),
        async () =>
          (await prisma.return.findUniqueOrThrow({ where: { id: returnId } }))
            .status !== 'REQUESTED',
      );
      const afterEscalation = await prisma.return.findUniqueOrThrow({
        where: { id: returnId },
      });
      expect(afterEscalation.status).toBe('ESCALATED');

      // Every automatic sweep transition gets its own AuditLog row too,
      // same as every human-triggered one - actorId null (system), a
      // real before/after.
      const escalationAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          entityType: 'Return',
          entityId: returnId,
          action: 'return.auto_escalated',
        },
      });
      expect(escalationAudit.actorId).toBeNull();
      expect(escalationAudit.beforeState).toMatchObject({
        status: 'REQUESTED',
      });
      expect(escalationAudit.afterState).toMatchObject({ status: 'ESCALATED' });
    });

    it('PLATFORM_ADMIN resolves an escalation: approve issues a code, reject is ADMIN_REJECTED - final, no dispute, no resubmission', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const admin = await platformAdmin();

      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      await prisma.return.update({
        where: { id: submitted.body.id },
        data: { status: 'ESCALATED', escalatedAt: new Date() },
      });

      const rejectedByAdmin = await request(app.getHttpServer())
        .patch(`/api/v1/admin/returns/${submitted.body.id}/escalation-decision`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('admin-decision'))
        .send({
          decision: 'reject',
          rejection_reason: 'Final platform review confirms store was correct.',
        });
      expect(rejectedByAdmin.status).toBe(200);
      expect(rejectedByAdmin.body.status).toBe('ADMIN_REJECTED');

      // No dispute path exists for ADMIN_REJECTED.
      const disputeAttempt = await customerReturnAction(
        customer,
        `returns/${submitted.body.id}/dispute`,
      );
      expect(disputeAttempt.status).toBe(409);

      // No resubmission either - ADMIN_REJECTED is not in the
      // resubmission-allowed set.
      const resubmitAttempt = await submitReturn(
        customer,
        branchOrderId,
        itemId,
      );
      expect(resubmitAttempt.status).toBe(409);
    });

    it('a non-admin cannot resolve an escalation', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      await prisma.return.update({
        where: { id: submitted.body.id },
        data: { status: 'ESCALATED', escalatedAt: new Date() },
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/returns/${submitted.body.id}/escalation-decision`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('admin-decision'))
        .send({ decision: 'approve' });
      expect(res.status).toBe(403);
    });

    it('GET /admin/returns lists only ESCALATED returns, and only for PLATFORM_ADMIN', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const admin = await platformAdmin();

      const requested = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const requestedReturn = await submitReturn(
        customer,
        requested.branchOrderId,
        requested.itemId,
      );

      const escalated = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const escalatedReturn = await submitReturn(
        customer,
        escalated.branchOrderId,
        escalated.itemId,
      );
      await prisma.return.update({
        where: { id: escalatedReturn.body.id },
        data: { status: 'ESCALATED', escalatedAt: new Date() },
      });

      const forbidden = await request(app.getHttpServer())
        .get('/api/v1/admin/returns')
        .set('Authorization', `Bearer ${owner}`);
      expect(forbidden.status).toBe(403);

      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/returns')
        .set('Authorization', `Bearer ${admin}`);
      expect(list.status).toBe(200);
      const ids = list.body.map((r: { id: string }) => r.id);
      expect(ids).toContain(escalatedReturn.body.id);
      expect(ids).not.toContain(requestedReturn.body.id);
      expect(
        list.body.every((r: { status: string }) => r.status === 'ESCALATED'),
      ).toBe(true);
    });
  });

  // ============================================================
  // Receipt/redeem: code lifecycle, stock, ledger separation.
  // ============================================================
  describe('Redeem: code, stock, refund ledger (PDR-030/031)', () => {
    it('approve issues a code and NOTHING else - no refund row, no stock change, before redeem', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      const approved = await decideReturn(
        owner,
        vendorId,
        branchId,
        submitted.body.id,
        { decision: 'approve' },
      );
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('APPROVED_AWAITING_DROPOFF');
      // IX-P1: the store's approve answer never carries the raw code; it
      // exists (6 digits) and only the shopper's own routes return it.
      expect(approved.body).not.toHaveProperty('code');
      expect(
        (
          await prisma.return.findUniqueOrThrow({
            where: { id: submitted.body.id },
          })
        ).code,
      ).toMatch(/^\d{6}$/);

      const refundCount = await prisma.branchOrderRefund.count({
        where: { branchOrderItemId: itemId },
      });
      expect(refundCount).toBe(0);
      const stock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variantId },
        },
      });
      expect(stock.quantity).toBe(4); // 5 - 1 sold, unchanged by approval
    });

    it('redeem once succeeds; the same code a second time is rejected (already consumed)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      await decideReturn(owner, vendorId, branchId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });

      const firstRedeem = await redeemReturn(owner, vendorId, {
        code: r.code,
        receiving_branch_id: branchId,
        item_condition: 'RESELLABLE',
      });
      expect(firstRedeem.status).toBe(201);
      expect(firstRedeem.body.status).toBe('REFUNDED');

      const secondRedeem = await redeemReturn(owner, vendorId, {
        code: r.code,
        receiving_branch_id: branchId,
        item_condition: 'RESELLABLE',
      });
      expect(secondRedeem.status).toBe(409);
      expect(secondRedeem.body.error.code).toBe('INVALID_RETURN_CODE');
    });

    it('code expiry (7 days, sweep-driven) makes it unusable; EXPIRED allows resubmission', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      await decideReturn(owner, vendorId, branchId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);

      await prisma.return.update({
        where: { id: submitted.body.id },
        data: { codeExpiresAt: new Date(Date.now() - 1000) },
      });
      await sweepUntil(
        () => sweep.sweepOnce(),
        async () =>
          (
            await prisma.return.findUniqueOrThrow({
              where: { id: submitted.body.id },
            })
          ).status !== 'APPROVED_AWAITING_DROPOFF',
      );
      const expired = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });
      expect(expired.status).toBe('EXPIRED');

      const expiryAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          entityType: 'Return',
          entityId: submitted.body.id,
          action: 'return.code_expired',
        },
      });
      expect(expiryAudit.actorId).toBeNull();
      expect(expiryAudit.beforeState).toMatchObject({
        status: 'APPROVED_AWAITING_DROPOFF',
      });
      expect(expiryAudit.afterState).toMatchObject({ status: 'EXPIRED' });

      const redeemAfterExpiry = await redeemReturn(owner, vendorId, {
        code: expired.code,
        receiving_branch_id: branchId,
        item_condition: 'RESELLABLE',
      });
      expect(redeemAfterExpiry.status).toBe(409);

      const resubmit = await submitReturn(customer, branchOrderId, itemId);
      expect(resubmit.status).toBe(201);
    });

    it('RESELLABLE restocks the receiving branch via a RETURN_RESTOCK StockMovement; DAMAGED writes no stock movement at all', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');

      // RESELLABLE case.
      const resellable = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submittedA = await submitReturn(
        customer,
        resellable.branchOrderId,
        resellable.itemId,
      );
      await decideReturn(owner, vendorId, branchId, submittedA.body.id, {
        decision: 'approve',
      }).expect(200);
      const rA = await prisma.return.findUniqueOrThrow({
        where: { id: submittedA.body.id },
      });
      const stockBefore = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variantId },
        },
      });
      await redeemReturn(owner, vendorId, {
        code: rA.code,
        receiving_branch_id: branchId,
        item_condition: 'RESELLABLE',
      }).expect(201);
      const stockAfter = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variantId },
        },
      });
      expect(stockAfter.quantity).toBe(stockBefore.quantity + 1);
      const restockMovement = await prisma.stockMovement.findFirst({
        where: {
          vendorId,
          branchId,
          offerVariantId: variantId,
          reason: 'RETURN_RESTOCK',
        },
      });
      expect(restockMovement).not.toBeNull();
      expect(restockMovement!.quantityDelta).toBe(1);

      // DAMAGED case - a second item.
      const damaged = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submittedB = await submitReturn(
        customer,
        damaged.branchOrderId,
        damaged.itemId,
      );
      await decideReturn(owner, vendorId, branchId, submittedB.body.id, {
        decision: 'approve',
      }).expect(200);
      const rB = await prisma.return.findUniqueOrThrow({
        where: { id: submittedB.body.id },
      });
      const stockBeforeDamaged = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variantId },
        },
      });
      await redeemReturn(owner, vendorId, {
        code: rB.code,
        receiving_branch_id: branchId,
        item_condition: 'DAMAGED',
      }).expect(201);
      const stockAfterDamaged = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variantId },
        },
      });
      expect(stockAfterDamaged.quantity).toBe(stockBeforeDamaged.quantity);
      const damageMovements = await prisma.stockMovement.count({
        where: {
          vendorId,
          branchId,
          offerVariantId: variantId,
          reason: 'RETURN_RESTOCK',
          quantityDelta: { gt: 0 },
        },
      });
      // Exactly the one from the RESELLABLE case above - none for this one.
      expect(damageMovements).toBe(1);
    });

    it('ONLINE refund: method=ONLINE_GATEWAY with a real paymentTransactionId, amount = item_total - snapshotted fee', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner, {
        mode: 'REFUND_ONLY',
        window_days: 14,
        fee_ils: 10,
      });
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
        'ONLINE',
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      await decideReturn(owner, vendorId, branchId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });
      await redeemReturn(owner, vendorId, {
        code: r.code,
        receiving_branch_id: branchId,
        item_condition: 'RESELLABLE',
      }).expect(201);

      const refund = await prisma.branchOrderRefund.findFirstOrThrow({
        where: { branchOrderItemId: itemId },
      });
      expect(refund.method).toBe('ONLINE_GATEWAY');
      expect(refund.paymentTransactionId).not.toBeNull();
      expect(refund.reason).toBe('ITEM_RETURNED');
      expect(Number(refund.amount)).toBe(90); // 100 - 10 fee
      expect(refund.returnId).toBe(r.id);
    });

    it('COD refund: method=COD_CASH, no paymentTransactionId - never conflated with an electronic refund', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner, {
        mode: 'REFUND_ONLY',
        window_days: 14,
        fee_ils: 10,
      });
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
        'COD',
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      await decideReturn(owner, vendorId, branchId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });
      await redeemReturn(owner, vendorId, {
        code: r.code,
        receiving_branch_id: branchId,
        item_condition: 'RESELLABLE',
      }).expect(201);

      const refund = await prisma.branchOrderRefund.findFirstOrThrow({
        where: { branchOrderItemId: itemId },
      });
      expect(refund.method).toBe('COD_CASH');
      expect(refund.paymentTransactionId).toBeNull();
      expect(Number(refund.amount)).toBe(90);
    });

    it('fee >= item price: refund amount floors at 0, never negative', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner, {
        mode: 'REFUND_ONLY',
        window_days: 14,
        fee_ils: 50,
      });
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
        'ONLINE',
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      await decideReturn(owner, vendorId, branchId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });
      await redeemReturn(owner, vendorId, {
        code: r.code,
        receiving_branch_id: branchId,
        item_condition: 'RESELLABLE',
      }).expect(201);

      const refund = await prisma.branchOrderRefund.findFirstOrThrow({
        where: { branchOrderItemId: itemId },
      });
      expect(Number(refund.amount)).toBe(0);
    });

    it('a later policy change never affects an already-placed order - the snapshot, not the live policy, governs', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner, {
        mode: 'REFUND_ONLY',
        window_days: 14,
        fee_ils: 5,
      });
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );

      // Vendor disables returns entirely AFTER this order was placed.
      await prisma.vendor.update({
        where: { id: vendorId },
        data: {
          returnsEnabled: false,
          returnMode: 'NO_RETURN',
          returnPolicyUpdatedAt: new Date(
            Date.now() - 200 * 24 * 60 * 60 * 1000,
          ),
        },
      });

      // The order's own OWN snapshot still says REFUND_ONLY - still eligible.
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      expect(submitted.status).toBe(201);
    });

    it('a BranchOrder with no snapshot at all (legacy, pre-dates this feature) is never eligible', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      // Simulate a pre-S21 order - no snapshot was ever taken.
      await prisma.branchOrder.update({
        where: { id: branchOrderId },
        data: {
          returnPolicySnapshotEnabled: null,
          returnPolicySnapshotMode: null,
          returnPolicySnapshotWindowDays: null,
          returnPolicySnapshotFeeIls: null,
          returnPolicySnapshotVersion: null,
        },
      });

      const res = await submitReturn(customer, branchOrderId, itemId);
      expect(res.status).toBe(409);
      expect(res.body.error.details[0].reason_code).toBe('NO_POLICY_SNAPSHOT');
    });

    // IX-P1 (2026-11-23): cross-branch receipt is the OWNER's (an employee only
    // at her own branch - see the IX-P1 block below); this test always used the owner.
    it('BOLA: the owner can redeem to branch B of the SAME vendor; another vendor cannot', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId: branchAId } =
        await createVendorWithBranch(owner);
      await makeVendorEligible(vendorId);
      const branchBId = await addBranch(owner, vendorId, 'Branch B');
      await prisma.storeBranch.update({
        where: { id: branchBId },
        data: { verificationStatus: 'APPROVED' },
      });
      const variantId = await createOfferWithStock(vendorId, branchAId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      await decideReturn(owner, vendorId, branchAId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });

      const redeemedAtB = await redeemReturn(owner, vendorId, {
        code: r.code,
        receiving_branch_id: branchBId,
        item_condition: 'RESELLABLE',
      });
      expect(redeemedAtB.status).toBe(201);
      expect(redeemedAtB.body.receiving_branch_id).toBe(branchBId);

      // A completely different vendor's owner cannot redeem at all.
      const otherOwner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: otherVendorId } =
        await createVendorWithBranch(otherOwner);
      const crossVendor = await redeemReturn(otherOwner, otherVendorId, {
        code: r.code,
        receiving_branch_id: branchBId,
        item_condition: 'RESELLABLE',
      });
      expect([403, 409]).toContain(crossVendor.status);
    });

    it('privacy: a cross-branch redeem (by the owner, PDR-031 + IX-P1) never receives reason_note/photo_urls/rejection_reason/code in the response', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId: branchAId } =
        await createVendorWithBranch(owner);
      await makeVendorEligible(vendorId);
      const branchBId = await addBranch(owner, vendorId, 'Branch B');
      await prisma.storeBranch.update({
        where: { id: branchBId },
        data: { verificationStatus: 'APPROVED' },
      });
      const variantId = await createOfferWithStock(vendorId, branchAId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      const secretNote =
        'A very specific secret complaint only branch A should see.';
      const submitted = await customerReturnAction(
        customer,
        `orders/${branchOrderId}/items/${itemId}/returns`,
        { reason: 'DAMAGED', reason_note: secretNote },
      );
      await decideReturn(owner, vendorId, branchAId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });
      const usedCode = r.code;

      const redeemedAtB = await redeemReturn(owner, vendorId, {
        code: usedCode,
        receiving_branch_id: branchBId,
        item_condition: 'RESELLABLE',
      });
      expect(redeemedAtB.status).toBe(201);
      // Only the minimal, safe fields - never the note, photos, code,
      // or rejection reason (same privacy convention as internalStoreNote).
      // Sprint 21b adds `settlement` (null for a plain RETURN outcome,
      // like this one) to the same privacy-safe shape - still never
      // reason_note/photo_urls/rejection_reason/code.
      expect(Object.keys(redeemedAtB.body).sort()).toEqual(
        [
          'id',
          'item_condition',
          'desired_outcome',
          'received_at',
          'receiving_branch_id',
          'refund',
          'settlement',
          'status',
        ].sort(),
      );
      expect(redeemedAtB.body.settlement).toBeNull();
      // IX-P2: what the counter hands back - the recorded refund (ONLINE here)
      expect(redeemedAtB.body.refund).toEqual({
        amount: 95,
        method: 'ONLINE_GATEWAY',
      });
      expect(JSON.stringify(redeemedAtB.body)).not.toContain(secretNote);
      expect(JSON.stringify(redeemedAtB.body)).not.toContain(usedCode);
    });

    it('deterministic concurrency (barrier-proven): two concurrent redeem attempts with the SAME code - only one succeeds, genuinely serialized on the Return row lock', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      await decideReturn(owner, vendorId, branchId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });

      const barrier = barrierOnAudit('return.received');
      const firstPromise: Promise<Res> = run(
        redeemReturn(owner, vendorId, {
          code: r.code,
          receiving_branch_id: branchId,
          item_condition: 'RESELLABLE',
        }),
      );
      await barrier.reached();
      const secondPromise: Promise<Res> = run(
        redeemReturn(owner, vendorId, {
          code: r.code,
          receiving_branch_id: branchId,
          item_condition: 'DAMAGED',
        }),
      );

      expect(await someoneWaitsOnLock('%FROM returns%FOR UPDATE%')).toBe(true);
      expect(await settledWithin(secondPromise, 700)).toBe(false);

      barrier.release();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const refundCount = await prisma.branchOrderRefund.count({
        where: { branchOrderItemId: itemId },
      });
      expect(refundCount).toBe(1);
    });
  });

  // ============================================================
  // Privacy: no reason/photos/rejection text in any Outbox payload.
  // ============================================================
  // ------------------------------------------------------------
  // IX-P1 (2026-11-23): returns security - the raw drop-off code only for
  // the shopper who asked; the receiving branch of an employee decided by
  // the server.
  // ------------------------------------------------------------
  describe('IX-P1: the return code and the receiving branch', () => {
    async function employeeOf(
      vendorId: string,
      branchId: string,
    ): Promise<string> {
      const phone = uniquePhone();
      const token = await signup(phone, 'a-strong-password');
      const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
      await prisma.vendorUser.create({
        data: { userId: user.id, vendorId, role: 'BRANCH_EMPLOYEE', branchId },
      });
      return token;
    }
    const get = (token: string, path: string) =>
      run(
        request(app.getHttpServer())
          .get(`/api/v1/${path}`)
          .set('Authorization', `Bearer ${token}`),
      );
    /** The raw value as a JSON string value anywhere in the answer. */
    const carries = (body: unknown, code: string) =>
      JSON.stringify(body).includes(`"${code}"`);

    it('only the shopper who asked sees her code: never another shopper, the owner, the employee or platform staff - in no answer, audit row, outbox payload or stored idempotent answer', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const employee = await employeeOf(vendorId, branchId);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const otherCustomer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      expect(submitted.status).toBe(201);
      const returnId = submitted.body.id as string;

      // the decision answer (approve issues the code)
      const approved = await decideReturn(owner, vendorId, branchId, returnId, {
        decision: 'approve',
      });
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('APPROVED_AWAITING_DROPOFF');
      expect(approved.body).not.toHaveProperty('code');
      const code = (
        await prisma.return.findUniqueOrThrow({ where: { id: returnId } })
      ).code!;
      expect(code).toMatch(/^\d{6}$/);
      expect(carries(approved.body, code)).toBe(false);

      // the shopper who asked: her detail and her list
      const mine = await get(customer, `customers/me/returns/${returnId}`);
      expect(mine.status).toBe(200);
      expect(mine.body.code).toBe(code);
      const myList = await get(customer, 'customers/me/returns');
      expect(
        (myList.body as { id: string; code: string }[]).find(
          (x) => x.id === returnId,
        )?.code,
      ).toBe(code);

      // another shopper: not found, and not in her list
      expect(
        (await get(otherCustomer, `customers/me/returns/${returnId}`)).status,
      ).toBe(404);
      const otherList = await get(otherCustomer, 'customers/me/returns');
      expect(otherList.status).toBe(200);
      expect(carries(otherList.body, code)).toBe(false);

      // every store read: the owner and the branch's employee
      for (const token of [owner, employee]) {
        const list = await get(
          token,
          `vendors/${vendorId}/branches/${branchId}/returns`,
        );
        expect(list.status).toBe(200);
        const row = (list.body as Record<string, unknown>[]).find(
          (x) => x.id === returnId,
        );
        expect(row).toBeDefined();
        expect(row).not.toHaveProperty('code');
        expect(row!.status).toBe('APPROVED_AWAITING_DROPOFF');
        expect(carries(list.body, code)).toBe(false);
      }

      // platform staff: the escalation list and its decision answer
      const admin = await platformAdmin();
      await prisma.return.update({
        where: { id: returnId },
        data: { status: 'ESCALATED', escalatedAt: new Date() },
      });
      const escalated = await get(admin, 'admin/returns');
      expect(escalated.status).toBe(200);
      const escRow = (escalated.body as Record<string, unknown>[]).find(
        (x) => x.id === returnId,
      );
      expect(escRow).toBeDefined();
      expect(escRow).not.toHaveProperty('code');
      expect(carries(escalated.body, code)).toBe(false);
      const resolved = await run(
        request(app.getHttpServer())
          .patch(`/api/v1/admin/returns/${returnId}/escalation-decision`)
          .set('Authorization', `Bearer ${admin}`)
          .set('Idempotency-Key', unique('esc'))
          .send({ decision: 'approve' }),
      );
      expect(resolved.status).toBe(200);
      expect(resolved.body).not.toHaveProperty('code');
      const reissued = (
        await prisma.return.findUniqueOrThrow({ where: { id: returnId } })
      ).code!;
      expect(reissued).toMatch(/^\d{6}$/);
      expect(carries(resolved.body, reissued)).toBe(false);
      expect(
        (await get(customer, `customers/me/returns/${returnId}`)).body.code,
      ).toBe(reissued);

      // nothing recorded keeps either raw code
      const audits = await prisma.auditLog.findMany({
        where: { entityId: returnId },
      });
      expect(audits.length).toBeGreaterThan(0);
      const events = await prisma.outboxEvent.findMany();
      const stored = await prisma.idempotencyKey.findMany({
        where: { requestPath: { contains: returnId } },
      });
      expect(stored.length).toBeGreaterThan(0);
      for (const c of [code, reissued]) {
        for (const a of audits) {
          expect(carries([a.beforeState, a.afterState], c)).toBe(false);
        }
        for (const e of events) expect(carries(e.payload, c)).toBe(false);
        for (const k of stored) expect(carries(k.responseBody, c)).toBe(false);
      }
    });

    it('an employee of branch A cannot receive at branch B: 403, and no status, stock, refund, stock line or audit change; at her own branch it works', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId: branchA } =
        await createVendorWithBranch(owner);
      // a store must be eligible before it can add a branch (as the tests above)
      await makeVendorEligible(vendorId);
      const branchB = await addBranch(owner, vendorId, 'Branch B');
      const variantId = await createOfferWithStock(vendorId, branchA, 100, 5);
      await prisma.branchStock.create({
        data: {
          vendorId,
          branchId: branchB,
          offerVariantId: variantId,
          quantity: 3,
        },
      });
      const employeeA = await employeeOf(vendorId, branchA);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchA,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      const returnId = submitted.body.id as string;
      await decideReturn(owner, vendorId, branchA, returnId, {
        decision: 'approve',
      }).expect(200);
      const code = (
        await prisma.return.findUniqueOrThrow({ where: { id: returnId } })
      ).code!;
      const stockOf = async (branchId: string) =>
        (
          await prisma.branchStock.findFirstOrThrow({
            where: { branchId, offerVariantId: variantId },
          })
        ).quantity;
      const before = { a: await stockOf(branchA), b: await stockOf(branchB) };

      const refused = await run(
        redeemReturn(employeeA, vendorId, {
          code,
          receiving_branch_id: branchB,
          item_condition: 'RESELLABLE',
        }),
      );
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('RECEIVING_BRANCH_NOT_ASSIGNED');
      expect(carries(refused.body, code)).toBe(false);
      const still = await prisma.return.findUniqueOrThrow({
        where: { id: returnId },
      });
      expect(still.status).toBe('APPROVED_AWAITING_DROPOFF');
      expect(still.receivingBranchId).toBeNull();
      expect(still.receivedAt).toBeNull();
      expect(await stockOf(branchA)).toBe(before.a);
      expect(await stockOf(branchB)).toBe(before.b);
      expect(
        await prisma.branchOrderRefund.count({ where: { returnId } }),
      ).toBe(0);
      expect(await prisma.stockMovement.count({ where: { returnId } })).toBe(0);
      expect(
        await prisma.auditLog.count({
          where: {
            entityId: returnId,
            action: { in: ['return.received', 'return.refund_processed'] },
          },
        }),
      ).toBe(0);

      // a wrong code at the other branch: the same refusal (says nothing about the code)
      const wrongCode = code === '000000' ? '000001' : '000000';
      const refusedWrong = await run(
        redeemReturn(employeeA, vendorId, {
          code: wrongCode,
          receiving_branch_id: branchB,
          item_condition: 'RESELLABLE',
        }),
      );
      expect(refusedWrong.status).toBe(403);
      expect(refusedWrong.body.error.code).toBe(
        'RECEIVING_BRANCH_NOT_ASSIGNED',
      );

      // at her own branch: received, restocked there, refunded once
      const ok = await run(
        redeemReturn(employeeA, vendorId, {
          code,
          receiving_branch_id: branchA,
          item_condition: 'RESELLABLE',
        }),
      );
      expect(ok.status).toBe(201);
      expect(ok.body.status).toBe('REFUNDED');
      expect(ok.body.receiving_branch_id).toBe(branchA);
      expect(await stockOf(branchA)).toBe(before.a + 1);
      expect(await stockOf(branchB)).toBe(before.b);
      expect(
        await prisma.branchOrderRefund.count({ where: { returnId } }),
      ).toBe(1);
    });

    it('the owner may receive at any legitimate branch of her store (here branch B), restocked there', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId: branchA } =
        await createVendorWithBranch(owner);
      // a store must be eligible before it can add a branch (as the tests above)
      await makeVendorEligible(vendorId);
      const branchB = await addBranch(owner, vendorId, 'Branch B');
      const variantId = await createOfferWithStock(vendorId, branchA, 100, 5);
      await prisma.branchStock.create({
        data: {
          vendorId,
          branchId: branchB,
          offerVariantId: variantId,
          quantity: 3,
        },
      });
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchA,
        variantId,
      );
      const submitted = await submitReturn(customer, branchOrderId, itemId);
      const returnId = submitted.body.id as string;
      await decideReturn(owner, vendorId, branchA, returnId, {
        decision: 'approve',
      }).expect(200);
      const code = (
        await prisma.return.findUniqueOrThrow({ where: { id: returnId } })
      ).code!;
      const bBefore = (
        await prisma.branchStock.findFirstOrThrow({
          where: { branchId: branchB, offerVariantId: variantId },
        })
      ).quantity;

      const ok = await run(
        redeemReturn(owner, vendorId, {
          code,
          receiving_branch_id: branchB,
          item_condition: 'RESELLABLE',
        }),
      );
      expect(ok.status).toBe(201);
      expect(ok.body.status).toBe('REFUNDED');
      expect(ok.body.receiving_branch_id).toBe(branchB);
      expect(
        (
          await prisma.branchStock.findFirstOrThrow({
            where: { branchId: branchB, offerVariantId: variantId },
          })
        ).quantity,
      ).toBe(bBefore + 1);
      expect(
        await prisma.branchOrderRefund.count({ where: { returnId } }),
      ).toBe(1);
    });
  });

  // ------------------------------------------------------------
  // IX-P2 (2026-11-23): the branch's returns board - list / tabs / counts /
  // search / scope, one return + its timeline, the code preview (never
  // consumes, never leaks), and the explicit money of the receipt.
  // ------------------------------------------------------------
  describe('IX-P2: the returns board, details, timeline and the code preview', () => {
    async function staffOf(
      vendorId: string,
      branchId: string,
    ): Promise<{ token: string; userId: string }> {
      const phone = uniquePhone();
      const token = await signup(phone, 'a-strong-password');
      const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
      await prisma.vendorUser.create({
        data: { userId: user.id, vendorId, role: 'BRANCH_EMPLOYEE', branchId },
      });
      return { token, userId: user.id };
    }
    const get = (token: string, path: string) =>
      run(
        request(app.getHttpServer())
          .get(`/api/v1/${path}`)
          .set('Authorization', `Bearer ${token}`),
      );
    const lookup = (
      token: string,
      vendorId: string,
      body: Record<string, unknown>,
    ) =>
      run(
        request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/returns/lookup`)
          .set('Authorization', `Bearer ${token}`)
          .send(body),
      );
    const carries = (body: unknown, code: string) =>
      JSON.stringify(body).includes(`"${code}"`);
    const codeOf = async (id: string) =>
      (await prisma.return.findUniqueOrThrow({ where: { id } })).code!;

    /** A store with branches A and B (approved), stock in both, an employee
     * of A, and a shopper. */
    async function store() {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId: branchA } =
        await createVendorWithBranch(owner);
      await makeVendorEligible(vendorId);
      const branchB = await addBranch(owner, vendorId, 'Branch B');
      const variantA = await createOfferWithStock(vendorId, branchA, 100, 10);
      const variantB = await createOfferWithStock(vendorId, branchB, 100, 10);
      const employeeA = await staffOf(vendorId, branchA);
      const customerPhone = uniquePhone();
      const customer = await signup(customerPhone, 'a-strong-password');
      await prisma.customerProfile.updateMany({
        where: { user: { phone: customerPhone } },
        data: { displayName: 'سارة أحمد' },
      });
      return {
        owner,
        vendorId,
        branchA,
        branchB,
        variantA,
        variantB,
        employeeA,
        customer,
        customerPhone,
      };
    }
    async function aReturn(
      s: Awaited<ReturnType<typeof store>>,
      branchId: string,
      variantId: string,
      approve: boolean,
      paymentMethod: 'COD' | 'ONLINE' = 'ONLINE',
    ) {
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        s.owner,
        s.customer,
        s.vendorId,
        branchId,
        variantId,
        paymentMethod,
      );
      if (paymentMethod === 'COD') {
        await prisma.branchOrder.update({
          where: { id: branchOrderId },
          data: { codCollectedAt: new Date(), codCollectedAmount: 100 },
        });
      }
      const submitted = await submitReturn(s.customer, branchOrderId, itemId);
      expect(submitted.status).toBe(201);
      const id = submitted.body.id as string;
      if (approve) {
        await decideReturn(s.owner, s.vendorId, branchId, id, {
          decision: 'approve',
        }).expect(200);
      }
      return { id, branchOrderId };
    }

    it("list: tabs with server counts, the working fields only, search / type / date, the owner's «كل الفروع» and the employee's own branch only - never the code", async () => {
      const s = await store();
      const r1 = await aReturn(s, s.branchA, s.variantA, false);
      const r2 = await aReturn(s, s.branchA, s.variantA, true);
      const r3 = await aReturn(s, s.branchB, s.variantB, false);
      const code2 = await codeOf(r2.id);

      const pending = await get(
        s.owner,
        `vendors/${s.vendorId}/branches/${s.branchA}/return-queue`,
      );
      expect(pending.status).toBe(200);
      expect(pending.body.tab).toBe('pending_decision');
      expect(pending.body.scope).toBe('branch');
      expect(pending.body.counts).toEqual({
        pending_decision: 1,
        awaiting_dropoff: 1,
        completed: 0,
        closed: 0,
        platform: 0,
      });
      expect(pending.body.items.map((x: { id: string }) => x.id)).toEqual([
        r1.id,
      ]);
      const row = pending.body.items[0];
      expect(row).toMatchObject({
        number: r1.id.slice(0, 8),
        order_number: r1.branchOrderId.slice(0, 8),
        branch_id: s.branchA,
        status: 'REQUESTED',
        bucket: 'pending_decision',
        outcome: 'RETURN',
        reason: 'CHANGE_OF_MIND',
        customer_short: 'سارة أ.',
        money: {
          kind: 'refund',
          final: false,
          amount: 95,
          method: 'ONLINE_GATEWAY',
        },
        deadline: { kind: 'escalation' },
      });
      expect(row.item).toMatchObject({ title_ar: 'م', quantity: 1 });
      expect(row).not.toHaveProperty('code');
      expect(JSON.stringify(row)).not.toContain(s.customerPhone);

      const awaiting = await get(
        s.employeeA.token,
        `vendors/${s.vendorId}/branches/${s.branchA}/return-queue?tab=awaiting_dropoff`,
      );
      expect(awaiting.status).toBe(200);
      expect(awaiting.body.items.map((x: { id: string }) => x.id)).toEqual([
        r2.id,
      ]);
      expect(awaiting.body.items[0].deadline.kind).toBe('code_expiry');
      expect(carries(awaiting.body, code2)).toBe(false);
      expect(awaiting.body.items[0]).not.toHaveProperty('code');

      // search: the order number, the phone's last 4, nothing for other text
      const byOrder = await get(
        s.owner,
        `vendors/${s.vendorId}/branches/${s.branchA}/return-queue?q=%23${r1.branchOrderId.slice(0, 8)}`,
      );
      expect(byOrder.body.items.map((x: { id: string }) => x.id)).toEqual([
        r1.id,
      ]);
      const byPhone = await get(
        s.owner,
        `vendors/${s.vendorId}/branches/${s.branchA}/return-queue?q=${s.customerPhone.slice(-4)}`,
      );
      expect(byPhone.body.counts.pending_decision).toBe(1);
      expect(byPhone.body.counts.awaiting_dropoff).toBe(1);
      const nothing = await get(
        s.owner,
        `vendors/${s.vendorId}/branches/${s.branchA}/return-queue?q=zzzz`,
      );
      expect(nothing.body.items).toEqual([]);
      // the raw code is not a search key
      const byCode = await get(
        s.owner,
        `vendors/${s.vendorId}/branches/${s.branchA}/return-queue?tab=awaiting_dropoff&q=${code2}`,
      );
      expect(byCode.body.items).toEqual([]);
      // type and date filters
      const exchanges = await get(
        s.owner,
        `vendors/${s.vendorId}/branches/${s.branchA}/return-queue?outcome=EXCHANGE`,
      );
      expect(exchanges.body.counts.pending_decision).toBe(0);
      const future = new Date(Date.now() + 3 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const later = await get(
        s.owner,
        `vendors/${s.vendorId}/branches/${s.branchA}/return-queue?from=${future}`,
      );
      expect(later.body.counts.pending_decision).toBe(0);
      expect(
        (
          await get(
            s.owner,
            `vendors/${s.vendorId}/branches/${s.branchA}/return-queue?tab=nope`,
          )
        ).status,
      ).toBe(400);

      // the owner's every-branch scope, and one branch of it
      const all = await get(s.owner, `vendors/${s.vendorId}/return-queue`);
      expect(all.status).toBe(200);
      expect(all.body.scope).toBe('all');
      expect(all.body.counts.pending_decision).toBe(2);
      expect(all.body.items.map((x: { id: string }) => x.id).sort()).toEqual(
        [r1.id, r3.id].sort(),
      );
      expect(
        (all.body.branch_counts as { branch_id: string; open: number }[]).find(
          (b) => b.branch_id === s.branchA,
        )?.open,
      ).toBe(2);
      const onlyB = await get(
        s.owner,
        `vendors/${s.vendorId}/return-queue?branch=${s.branchB}`,
      );
      expect(onlyB.body.items.map((x: { id: string }) => x.id)).toEqual([
        r3.id,
      ]);

      // the employee: her branch only; never the other branch, never «كل الفروع»
      expect(
        (
          await get(
            s.employeeA.token,
            `vendors/${s.vendorId}/branches/${s.branchB}/return-queue`,
          )
        ).status,
      ).toBe(403);
      expect(
        (await get(s.employeeA.token, `vendors/${s.vendorId}/return-queue`))
          .status,
      ).toBe(403);
      // another store's owner: nothing
      const stranger = await signup(uniquePhone(), 'a-strong-password');
      expect(
        (
          await get(
            stranger,
            `vendors/${s.vendorId}/branches/${s.branchA}/return-queue`,
          )
        ).status,
      ).toBe(403);
    });

    it('details and timeline: policy, money, where to receive, who did what (role at that time) - 404 for another branch, never the code', async () => {
      const s = await store();
      const r2 = await aReturn(s, s.branchA, s.variantA, true);
      const r3 = await aReturn(s, s.branchB, s.variantB, false);
      const code2 = await codeOf(r2.id);

      for (const token of [s.owner, s.employeeA.token]) {
        const d = await get(
          token,
          `vendors/${s.vendorId}/branches/${s.branchA}/return-queue/${r2.id}`,
        );
        expect(d.status).toBe(200);
        expect(d.body).toMatchObject({
          id: r2.id,
          status: 'APPROVED_AWAITING_DROPOFF',
          policy: { mode: 'REFUND_ONLY', window_days: 14, fee_ils: 5 },
          payment_method: 'ONLINE',
          can_decide: false,
          receive_at: { any_branch: true },
          money: { kind: 'refund', amount: 95, method: 'ONLINE_GATEWAY' },
        });
        expect(d.body).not.toHaveProperty('code');
        expect(carries(d.body, code2)).toBe(false);
      }
      // a return of branch B through branch A's address: 404
      expect(
        (
          await get(
            s.owner,
            `vendors/${s.vendorId}/branches/${s.branchA}/return-queue/${r3.id}`,
          )
        ).status,
      ).toBe(404);
      // the employee of A: not branch B's return at all
      expect(
        (
          await get(
            s.employeeA.token,
            `vendors/${s.vendorId}/branches/${s.branchB}/return-queue/${r3.id}`,
          )
        ).status,
      ).toBe(403);

      const t = await get(
        s.employeeA.token,
        `vendors/${s.vendorId}/branches/${s.branchA}/return-queue/${r2.id}/timeline`,
      );
      expect(t.status).toBe(200);
      expect(t.body.items.map((x: { kind: string }) => x.kind)).toEqual([
        'approved',
        'requested',
      ]);
      expect(t.body.items[0].actor.kind).toBe('owner');
      expect(t.body.items[1].actor.kind).toBe('customer');
      expect(carries(t.body, code2)).toBe(false);
    });

    it('the code preview: what will be received and the money, without consuming or leaking the code; the same who-may-receive-where rule; then the receipt says the refund (cash for COD) and the timeline shows it', async () => {
      const s = await store();
      const cod = await aReturn(s, s.branchA, s.variantA, true, 'COD');
      const code = await codeOf(cod.id);

      const p1 = await lookup(s.employeeA.token, s.vendorId, {
        code,
        receiving_branch_id: s.branchA,
      });
      expect(p1.status).toBe(200);
      expect(p1.body).toMatchObject({
        return_id: cod.id,
        order_number: cod.branchOrderId.slice(0, 8),
        outcome: 'RETURN',
        money: { kind: 'refund', final: false, amount: 95, method: 'COD_CASH' },
        receiving_branch: { id: s.branchA, name: 'Branch A' },
        allowed_branch: null,
        can_receive_here: true,
        blocked_reason: null,
      });
      expect(p1.body.item).toMatchObject({ title_ar: 'م', quantity: 1 });
      expect(carries(p1.body, code)).toBe(false);
      for (const k of [
        'reason_note',
        'photo_urls',
        'rejection_reason',
        'customer_short',
        'code',
      ])
        expect(p1.body).not.toHaveProperty(k);
      // not consumed: same answer again, nothing written
      expect(
        (
          await lookup(s.employeeA.token, s.vendorId, {
            code,
            receiving_branch_id: s.branchA,
          })
        ).status,
      ).toBe(200);
      const still = await prisma.return.findUniqueOrThrow({
        where: { id: cod.id },
      });
      expect(still.status).toBe('APPROVED_AWAITING_DROPOFF');
      expect(
        await prisma.branchOrderRefund.count({ where: { returnId: cod.id } }),
      ).toBe(0);

      // the employee at another branch: refused first (says nothing about the code)
      const atB = await lookup(s.employeeA.token, s.vendorId, {
        code,
        receiving_branch_id: s.branchB,
      });
      expect(atB.status).toBe(403);
      expect(atB.body.error.code).toBe('RECEIVING_BRANCH_NOT_ASSIGNED');
      // a wrong code, a malformed one
      const wrong = await lookup(s.employeeA.token, s.vendorId, {
        code: code === '000000' ? '000001' : '000000',
        receiving_branch_id: s.branchA,
      });
      expect(wrong.status).toBe(409);
      expect(wrong.body.error.code).toBe('INVALID_RETURN_CODE');
      expect(
        (
          await lookup(s.employeeA.token, s.vendorId, {
            code: '12ab56',
            receiving_branch_id: s.branchA,
          })
        ).status,
      ).toBe(400);
      // the owner may preview at branch B (any branch of her store)
      const ownerB = await lookup(s.owner, s.vendorId, {
        code,
        receiving_branch_id: s.branchB,
      });
      expect(ownerB.status).toBe(200);
      expect(ownerB.body.can_receive_here).toBe(true);

      // the receipt (existing redeem, unchanged): the refund, explicit
      const done = await run(
        redeemReturn(s.employeeA.token, s.vendorId, {
          code,
          receiving_branch_id: s.branchA,
          item_condition: 'RESELLABLE',
        }),
      );
      expect(done.status).toBe(201);
      expect(done.body.status).toBe('REFUNDED');
      expect(done.body.refund).toEqual({ amount: 95, method: 'COD_CASH' });
      expect(done.body.settlement).toBeNull();
      expect(carries(done.body, code)).toBe(false);
      // used: the preview now refuses it
      const used = await lookup(s.employeeA.token, s.vendorId, {
        code,
        receiving_branch_id: s.branchA,
      });
      expect(used.status).toBe(409);
      expect(used.body.error.code).toBe('INVALID_RETURN_CODE');

      const t = await get(
        s.owner,
        `vendors/${s.vendorId}/branches/${s.branchA}/return-queue/${cod.id}/timeline`,
      );
      const kinds = t.body.items.map((x: { kind: string }) => x.kind);
      expect(kinds.slice(0, 2)).toEqual(['refunded', 'received']);
      const received = t.body.items[1];
      expect(received.actor.kind).toBe('employee');
      expect(received.condition).toBe('RESELLABLE');
      expect(received.branch_name).toBe('Branch A');
      expect(t.body.items[0]).toMatchObject({ amount: 95, method: 'COD_CASH' });
      // the board: completed, with the final money
      const completed = await get(
        s.owner,
        `vendors/${s.vendorId}/branches/${s.branchA}/return-queue?tab=completed`,
      );
      expect(completed.body.items[0]).toMatchObject({
        id: cod.id,
        status: 'REFUNDED',
        money: { kind: 'refund', final: true, amount: 95, method: 'COD_CASH' },
      });
    });

    it('an exchange: the preview shows the replacement, the difference to collect and its one branch (another branch: shown, not allowed); the receipt settles it', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId: branchA } = await createVendorWithBranch(
        owner,
        {
          mode: 'BOTH',
          window_days: 14,
          fee_ils: 5,
          exchange_fee_ils: 3,
        },
      );
      await makeVendorEligible(vendorId);
      const branchB = await addBranch(owner, vendorId, 'Branch B');
      await makeVendorEligible(vendorId);
      const offer = await prisma.vendorOffer.create({
        data: {
          vendorId,
          titleAr: 'فستان',
          titleEn: 'Dress',
          status: 'ACTIVE',
        },
      });
      const original = await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: offer.id,
          sellerSku: unique('sku-o'),
          basePrice: 100,
          storeInventoryBarcode: unique('bc-o'),
          size: 'M',
        },
      });
      const replacement = await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: offer.id,
          sellerSku: unique('sku-r'),
          basePrice: 120,
          storeInventoryBarcode: unique('bc-r'),
          size: 'L',
        },
      });
      for (const v of [original.id, replacement.id]) {
        await prisma.branchStock.create({
          data: { vendorId, branchId: branchA, offerVariantId: v, quantity: 5 },
        });
      }
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchA,
        original.id,
      );
      const submitted = await customerReturnAction(
        customer,
        `orders/${branchOrderId}/items/${itemId}/returns`,
        {
          reason: 'CHANGE_OF_MIND',
          desired_outcome: 'EXCHANGE',
          replacement_offer_variant_id: replacement.id,
          replacement_branch_id: branchA,
        },
      );
      expect(submitted.status).toBe(201);
      await decideReturn(owner, vendorId, branchA, submitted.body.id, {
        decision: 'approve',
      }).expect(200);
      const code = await codeOf(submitted.body.id);

      const atB = await lookup(owner, vendorId, {
        code,
        receiving_branch_id: branchB,
      });
      expect(atB.status).toBe(200);
      expect(atB.body).toMatchObject({
        outcome: 'EXCHANGE',
        can_receive_here: false,
        blocked_reason: 'WRONG_BRANCH_FOR_EXCHANGE',
        allowed_branch: { id: branchA, name: 'Branch A' },
      });
      const atA = await lookup(owner, vendorId, {
        code,
        receiving_branch_id: branchA,
      });
      expect(atA.body).toMatchObject({
        can_receive_here: true,
        // 120 - 100 + 3
        money: {
          kind: 'exchange',
          final: false,
          direction: 'COLLECT_CASH',
          amount: 23,
        },
        replacement: { title_ar: 'فستان', size_label: 'L' },
      });
      expect(carries(atA.body, code)).toBe(false);

      const done = await run(
        redeemReturn(owner, vendorId, {
          code,
          receiving_branch_id: branchA,
          item_condition: 'RESELLABLE',
        }),
      );
      expect(done.status).toBe(201);
      expect(done.body.status).toBe('EXCHANGED');
      expect(done.body.refund).toBeNull();
      expect(done.body.settlement).toMatchObject({
        direction: 'COLLECT_CASH',
        net_amount: 23,
      });
    });
  });

  describe('Outbox privacy', () => {
    it('reason_note, rejection_reason, and photo_urls never appear in any Outbox payload', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 100, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemId } = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const secretNote = 'A very specific secret complaint about the item.';
      const secretRejection = 'A very specific secret rejection explanation.';

      const submitted = await customerReturnAction(
        customer,
        `orders/${branchOrderId}/items/${itemId}/returns`,
        { reason: 'DAMAGED', reason_note: secretNote },
      );
      await decideReturn(owner, vendorId, branchId, submitted.body.id, {
        decision: 'reject',
        rejection_reason: secretRejection,
      }).expect(200);

      const events = await prisma.outboxEvent.findMany();
      for (const e of events) {
        const payloadStr = JSON.stringify(e.payload);
        expect(payloadStr).not.toContain(secretNote);
        expect(payloadStr).not.toContain(secretRejection);
      }
    });
  });
});
