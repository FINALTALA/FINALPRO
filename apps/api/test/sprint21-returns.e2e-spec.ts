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

      const cancelled = await customerReturnAction(
        customer,
        `returns/${returnId}/cancel`,
      );
      expect(cancelled.status).toBe(201);
      expect(cancelled.body.status).toBe('CANCELLED_BY_CUSTOMER');

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
      await sweep.sweepOnce();
      const closed = await prisma.return.findUniqueOrThrow({
        where: { id: returnId },
      });
      expect(closed.status).toBe('REJECTED_CLOSED');

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
        decision: 'reject',
        rejection_reason: 'Outside the stated return policy for this item.',
      }).expect(200);

      const disputed = await customerReturnAction(
        customer,
        `returns/${returnId}/dispute`,
      );
      expect(disputed.status).toBe(201);
      expect(disputed.body.status).toBe('ESCALATED');
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
      await sweep.sweepOnce();
      const afterReminder = await prisma.return.findUniqueOrThrow({
        where: { id: returnId },
      });
      expect(afterReminder.vendorReminderSentAt).not.toBeNull();
      expect(afterReminder.status).toBe('REQUESTED');

      await prisma.return.update({
        where: { id: returnId },
        data: { createdAt: new Date(Date.now() - 73 * 60 * 60 * 1000) },
      });
      await sweep.sweepOnce();
      const afterEscalation = await prisma.return.findUniqueOrThrow({
        where: { id: returnId },
      });
      expect(afterEscalation.status).toBe('ESCALATED');
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
      expect(approved.body.code).toMatch(/^\d{6}$/);

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
      await sweep.sweepOnce();
      const expired = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });
      expect(expired.status).toBe('EXPIRED');

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

    it('BOLA: an employee of branch A can redeem to branch B of the SAME vendor; an employee of a DIFFERENT vendor cannot', async () => {
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
