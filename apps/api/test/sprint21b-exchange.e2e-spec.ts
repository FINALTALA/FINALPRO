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

const uniquePhone = createUniquePhone('sprint21b-exchange', '56');
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 21b - exchange within a real branch (e2e)', () => {
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
      mode: 'BOTH',
      window_days: 14,
      fee_ils: 5,
      exchange_fee_ils: 10,
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

  /** One VendorOffer with two variants (original + a swap-eligible
   * replacement), stock for BOTH optionally seeded at a given branch. */
  async function createOfferWithTwoVariants(
    vendorId: string,
    branchId: string,
    originalPrice: number,
    originalQty: number,
    replacementPrice: number,
    replacementQty: number,
  ): Promise<{ originalVariantId: string; replacementVariantId: string }> {
    await makeVendorEligible(vendorId);
    const offer = await prisma.vendorOffer.create({
      data: { vendorId, titleAr: 'م', titleEn: 'P', status: 'ACTIVE' },
    });
    const original = await prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique('sku-orig'),
        basePrice: originalPrice,
        storeInventoryBarcode: unique('barcode-orig'),
        size: 'M',
      },
    });
    const replacement = await prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique('sku-repl'),
        basePrice: replacementPrice,
        storeInventoryBarcode: unique('barcode-repl'),
        size: 'L',
      },
    });
    await prisma.branchStock.create({
      data: {
        vendorId,
        branchId,
        offerVariantId: original.id,
        quantity: originalQty,
      },
    });
    if (replacementQty > 0) {
      await prisma.branchStock.create({
        data: {
          vendorId,
          branchId,
          offerVariantId: replacement.id,
          quantity: replacementQty,
        },
      });
    }
    return {
      originalVariantId: original.id,
      replacementVariantId: replacement.id,
    };
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

  async function placeAndPickUpOrder(
    owner: string,
    customer: string,
    vendorId: string,
    branchId: string,
    variantId: string,
    quantity = 1,
  ): Promise<{ branchOrderId: string; itemId: string }> {
    const cartItemId = await addToCart(customer, vendorId, variantId, quantity);
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

  async function submitExchange(
    customer: string,
    branchOrderId: string,
    itemId: string,
    replacementOfferVariantId: string,
    replacementBranchId: string,
    reason = 'WRONG_ITEM',
  ): Promise<Res> {
    return customerReturnAction(
      customer,
      `orders/${branchOrderId}/items/${itemId}/returns`,
      {
        reason,
        desired_outcome: 'EXCHANGE',
        replacement_offer_variant_id: replacementOfferVariantId,
        replacement_branch_id: replacementBranchId,
      },
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

  const resolveEscalation = (
    admin: string,
    returnId: string,
    body: Record<string, unknown>,
  ) =>
    request(app.getHttpServer())
      .patch(`/api/v1/admin/returns/${returnId}/escalation-decision`)
      .set('Authorization', `Bearer ${admin}`)
      .set('Idempotency-Key', unique('admin-decision'))
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

  const archiveBranch = (owner: string, vendorId: string, branchId: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/archive`)
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('archive'))
      .send({});

  // ------------------------------------------------------------
  // Barrier helpers - same proven pattern as
  // sprint16-moderation-concurrency.e2e-spec.ts /
  // sprint21-returns.e2e-spec.ts's own barrierOnAudit.
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
  // Policy: EXCHANGE_ONLY/BOTH, the new exchange fee, outcome vs.
  // the ORDER's own snapshot (never the vendor's live policy).
  // ============================================================
  describe('Policy and outcome-vs-snapshot validation', () => {
    it('REFUND_ONLY rejects an EXCHANGE outcome; EXCHANGE_ONLY rejects a RETURN outcome; BOTH allows either', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');

      const { vendorId: v1, branchId: b1 } = await createVendorWithBranch(
        owner,
        { mode: 'REFUND_ONLY', window_days: 14, fee_ils: 5 },
      );
      const { originalVariantId: ov1, replacementVariantId: rv1 } =
        await createOfferWithTwoVariants(v1, b1, 100, 5, 120, 5);
      const customer1 = await signup(uniquePhone(), 'a-strong-password');
      const order1 = await placeAndPickUpOrder(owner, customer1, v1, b1, ov1);
      const blocked = await submitExchange(
        customer1,
        order1.branchOrderId,
        order1.itemId,
        rv1,
        b1,
      );
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('OUTCOME_NOT_ALLOWED_BY_POLICY');

      const { vendorId: v2, branchId: b2 } = await createVendorWithBranch(
        owner,
        { mode: 'EXCHANGE_ONLY', window_days: 14, exchange_fee_ils: 10 },
      );
      const { originalVariantId: ov2 } = await createOfferWithTwoVariants(
        v2,
        b2,
        100,
        5,
        120,
        5,
      );
      const customer2 = await signup(uniquePhone(), 'a-strong-password');
      const order2 = await placeAndPickUpOrder(owner, customer2, v2, b2, ov2);
      const blockedRefund = await customerReturnAction(
        customer2,
        `orders/${order2.branchOrderId}/items/${order2.itemId}/returns`,
        { reason: 'WRONG_ITEM' },
      );
      expect(blockedRefund.status).toBe(409);
      expect(blockedRefund.body.error.code).toBe(
        'OUTCOME_NOT_ALLOWED_BY_POLICY',
      );

      const { vendorId: v3, branchId: b3 } =
        await createVendorWithBranch(owner);
      const { originalVariantId: ov3, replacementVariantId: rv3 } =
        await createOfferWithTwoVariants(v3, b3, 100, 5, 120, 5);
      const customer3 = await signup(uniquePhone(), 'a-strong-password');
      const order3 = await placeAndPickUpOrder(owner, customer3, v3, b3, ov3);
      const allowed = await submitExchange(
        customer3,
        order3.branchOrderId,
        order3.itemId,
        rv3,
        b3,
      );
      expect(allowed.status).toBe(201);
      expect(allowed.body.desired_outcome).toBe('EXCHANGE');
    });
  });

  // ============================================================
  // Replacement validation - §4's full server-side checklist,
  // never trusted from the client.
  // ============================================================
  describe('Replacement validation (submit)', () => {
    it('rejects the original item itself as its own replacement', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId } = await createOfferWithTwoVariants(
        vendorId,
        branchId,
        100,
        5,
        120,
        5,
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const res = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        originalVariantId,
        branchId,
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('REPLACEMENT_SAME_AS_ORIGINAL');
    });

    it('rejects a variant from a DIFFERENT VendorOffer entirely', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId } = await createOfferWithTwoVariants(
        vendorId,
        branchId,
        100,
        5,
        120,
        5,
      );
      // An unrelated second offer/variant, same vendor.
      const otherOffer = await prisma.vendorOffer.create({
        data: { vendorId, titleAr: 'آخر', titleEn: 'Other', status: 'ACTIVE' },
      });
      const unrelatedVariant = await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: otherOffer.id,
          sellerSku: unique('sku-unrelated'),
          basePrice: 90,
          storeInventoryBarcode: unique('barcode-unrelated'),
        },
      });
      await prisma.branchStock.create({
        data: {
          vendorId,
          branchId,
          offerVariantId: unrelatedVariant.id,
          quantity: 5,
        },
      });
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const res = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        unrelatedVariant.id,
        branchId,
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('REPLACEMENT_VARIANT_NOT_FOUND');
    });

    it('rejects an archived replacement branch', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 5, 120, 5);
      const branch2 = await addBranch(owner, vendorId, 'Branch B');
      await prisma.storeBranch.update({
        where: { id: branch2 },
        data: { verificationStatus: 'APPROVED', archivedAt: new Date() },
      });
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const res = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        replacementVariantId,
        branch2,
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REPLACEMENT_BRANCH_NOT_AVAILABLE');
    });
  });

  // ============================================================
  // Unified approval - §1: decide() and resolveEscalation() both go
  // through the SAME approveReturn() helper, which alone reserves the
  // replacement and issues a 24h code.
  // ============================================================
  describe('Unified approval (decide vs. admin escalation)', () => {
    it('a branch employee approval reserves the replacement and issues a 24h code', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 5, 120, 3);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const submitted = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        replacementVariantId,
        branchId,
      );
      await decideReturn(owner, vendorId, branchId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);

      const stock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId,
            offerVariantId: replacementVariantId,
          },
        },
      });
      expect(stock.reservedQuantity).toBe(1);

      const r = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });
      expect(r.status).toBe('APPROVED_AWAITING_DROPOFF');
      const validityMs = r.codeExpiresAt!.getTime() - r.createdAt.getTime();
      expect(validityMs).toBeLessThan(2 * 24 * 60 * 60 * 1000);
      expect(validityMs).toBeGreaterThan(20 * 60 * 60 * 1000);
    });

    it('PLATFORM_ADMIN resolving an escalated exchange ALSO reserves the replacement, via the same helper', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 5, 120, 3);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const admin = await platformAdmin();
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const submitted = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        replacementVariantId,
        branchId,
      );
      await prisma.return.update({
        where: { id: submitted.body.id },
        data: { status: 'ESCALATED', escalatedAt: new Date() },
      });

      await resolveEscalation(admin, submitted.body.id, {
        decision: 'approve',
      }).expect(200);

      const stock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId,
            offerVariantId: replacementVariantId,
          },
        },
      });
      expect(stock.reservedQuantity).toBe(1);
    });

    it('approval fails cleanly with REPLACEMENT_NOT_AVAILABLE if stock dropped below the needed quantity before approval', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 5, 120, 2);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
        3,
      );
      const submitted = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        replacementVariantId,
        branchId,
      );
      const res = await decideReturn(
        owner,
        vendorId,
        branchId,
        submitted.body.id,
        { decision: 'approve' },
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REPLACEMENT_NOT_AVAILABLE');
    });
  });

  // ============================================================
  // Redemption: branch-scoped (never vendor-wide for EXCHANGE),
  // the exact settlement formula, and stock movements.
  // ============================================================
  describe('Exchange redemption', () => {
    async function requestAndApprove(
      owner: string,
      vendorId: string,
      branchId: string,
      customer: string,
      originalPrice: number,
      originalQty: number,
      replacementPrice: number,
      replacementQty: number,
    ) {
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(
          vendorId,
          branchId,
          originalPrice,
          originalQty,
          replacementPrice,
          replacementQty,
        );
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const submitted = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        replacementVariantId,
        branchId,
      );
      await decideReturn(owner, vendorId, branchId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });
      return {
        returnId: r.id,
        code: r.code!,
        originalVariantId,
        replacementVariantId,
      };
    }

    it('redeeming at a branch OTHER than the reserved replacement branch is rejected', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      // addBranch() requires an ACTIVE subscription - makeVendorEligible()
      // normally only runs inside createOfferWithTwoVariants(), called
      // later via requestAndApprove() below; call it explicitly here
      // first (same gotcha S21a's own BOLA test hit).
      await makeVendorEligible(vendorId);
      const otherBranch = await addBranch(owner, vendorId, 'Branch B');
      await prisma.storeBranch.update({
        where: { id: otherBranch },
        data: { verificationStatus: 'APPROVED' },
      });
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { code } = await requestAndApprove(
        owner,
        vendorId,
        branchId,
        customer,
        100,
        5,
        120,
        5,
      );
      const res = await redeemReturn(owner, vendorId, {
        code,
        receiving_branch_id: otherBranch,
        item_condition: 'RESELLABLE',
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('WRONG_BRANCH_FOR_EXCHANGE');
    });

    it('pricier replacement: customer pays the difference plus the exchange fee, settlement recorded, stock moves both ways', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { returnId, code, originalVariantId, replacementVariantId } =
        await requestAndApprove(
          owner,
          vendorId,
          branchId,
          customer,
          100,
          5,
          130,
          5,
        );

      const res = await redeemReturn(owner, vendorId, {
        code,
        receiving_branch_id: branchId,
        item_condition: 'RESELLABLE',
      }).expect(201);
      expect(res.body.status).toBe('EXCHANGED');
      expect(res.body.settlement.direction).toBe('COLLECT_CASH');
      // net = 130 - 100 + 10 = 40
      expect(res.body.settlement.net_amount).toBe(40);

      const settlement = await prisma.exchangeSettlement.findUniqueOrThrow({
        where: { returnId },
      });
      expect(Number(settlement.netAmount)).toBe(40);
      expect(settlement.method).toBe('CASH');

      const originalStock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId,
            offerVariantId: originalVariantId,
          },
        },
      });
      // Started at 5, checkout's own purchase flow already decremented
      // it to 4 when the order was placed - the exchange's restock
      // brings it back up by 1, to 5 (never back to the original 6 -
      // there is no "original 6" at all, this item was only ever
      // bought once).
      expect(originalStock.quantity).toBe(5);
      const replacementStock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId,
            offerVariantId: replacementVariantId,
          },
        },
      });
      expect(replacementStock.quantity).toBe(4); // 5 - 1 handed over
      expect(replacementStock.reservedQuantity).toBe(0); // released

      const movements = await prisma.stockMovement.findMany({
        where: {
          OR: [
            { offerVariantId: originalVariantId },
            { offerVariantId: replacementVariantId },
          ],
        },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        movements.some(
          (m) => m.reason === 'RETURN_RESTOCK' && m.quantityDelta === 1,
        ),
      ).toBe(true);
      expect(
        movements.some(
          (m) => m.reason === 'EXCHANGE_FULFILLED' && m.quantityDelta === -1,
        ),
      ).toBe(true);
    });

    it('cheaper replacement: customer is refunded the difference (fee does not fully offset it)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { code } = await requestAndApprove(
        owner,
        vendorId,
        branchId,
        customer,
        100,
        5,
        70,
        5,
      );
      const res = await redeemReturn(owner, vendorId, {
        code,
        receiving_branch_id: branchId,
        item_condition: 'RESELLABLE',
      }).expect(201);
      // net = 70 - 100 + 10 = -20 => refund 20
      expect(res.body.settlement.direction).toBe('REFUND_CASH');
      expect(res.body.settlement.net_amount).toBe(20);
    });

    it('DAMAGED original item: replacement still handed over, but the original is never restocked', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { code, originalVariantId } = await requestAndApprove(
        owner,
        vendorId,
        branchId,
        customer,
        100,
        5,
        120,
        5,
      );
      await redeemReturn(owner, vendorId, {
        code,
        receiving_branch_id: branchId,
        item_condition: 'DAMAGED',
      }).expect(201);
      const originalStock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId,
            offerVariantId: originalVariantId,
          },
        },
      });
      // Started at 5, checkout's own purchase already brought it to 4
      // - DAMAGED means no restock, so it stays at 4.
      expect(originalStock.quantity).toBe(4);
    });

    it('a RESELLABLE exchange succeeds even when the receiving branch never had a BranchStock row for the ORIGINAL variant before - one row, one movement', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      // Place/pick up the order at a FIRST branch (so the original item
      // has stock history there), but request/approve/redeem the
      // exchange at a SECOND branch that has never sold this variant.
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 5, 120, 5);
      const branch2 = await addBranch(owner, vendorId, 'Branch B');
      await prisma.storeBranch.update({
        where: { id: branch2 },
        data: { verificationStatus: 'APPROVED' },
      });
      await prisma.branchStock.create({
        data: {
          vendorId,
          branchId: branch2,
          offerVariantId: replacementVariantId,
          quantity: 5,
        },
      });
      const noRow = await prisma.branchStock.findUnique({
        where: {
          branchId_offerVariantId: {
            branchId: branch2,
            offerVariantId: originalVariantId,
          },
        },
      });
      expect(noRow).toBeNull();

      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const submitted = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        replacementVariantId,
        branch2,
      );
      await decideReturn(owner, vendorId, branchId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });

      await redeemReturn(owner, vendorId, {
        code: r.code,
        receiving_branch_id: branch2,
        item_condition: 'RESELLABLE',
      }).expect(201);

      const createdRow = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId: branch2,
            offerVariantId: originalVariantId,
          },
        },
      });
      expect(createdRow.quantity).toBe(1);
      const movements = await prisma.stockMovement.findMany({
        where: { branchId: branch2, offerVariantId: originalVariantId },
      });
      expect(movements).toHaveLength(1);
      expect(movements[0].reason).toBe('RETURN_RESTOCK');
    });
  });

  // ============================================================
  // SLA: the 24h reservation expiry sweep, resubmission after it.
  // ============================================================
  describe('Reservation expiry (sweep)', () => {
    it('an unreedemed exchange expires after 24h, releases the reservation, and allows resubmission', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 5, 120, 3);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const submitted = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        replacementVariantId,
        branchId,
      );
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
      const stock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId,
            offerVariantId: replacementVariantId,
          },
        },
      });
      expect(stock.reservedQuantity).toBe(0);

      const resubmitted = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        replacementVariantId,
        branchId,
      );
      expect(resubmitted.status).toBe(201);
    });
  });

  // ============================================================
  // Branch archive vs. active exchange reservations - §1's three
  // required barrier scenarios, all proven via real pg_stat_activity
  // lock contention, never Promise.all.
  // ============================================================
  describe('Branch archive vs. exchange reservation (barrier-proven)', () => {
    it('rejects archiving a branch with a live exchange reservation; allowed once it is gone', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 5, 120, 3);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const submitted = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        replacementVariantId,
        branchId,
      );
      await decideReturn(owner, vendorId, branchId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);

      const blocked = await archiveBranch(owner, vendorId, branchId);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe(
        'BRANCH_HAS_ACTIVE_EXCHANGE_RESERVATION',
      );

      // Redeem it away, then archiving succeeds.
      const r = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });
      await redeemReturn(owner, vendorId, {
        code: r.code,
        receiving_branch_id: branchId,
        item_condition: 'RESELLABLE',
      }).expect(201);
      await archiveBranch(owner, vendorId, branchId).expect(200);
    });

    it('deterministic concurrency: approval reserves first (holds the lock) - a concurrent archive genuinely waits, then is rejected', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 5, 120, 3);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const submitted = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        replacementVariantId,
        branchId,
      );

      const barrier = barrierOnAudit('return.exchange_approved');
      const approvalPromise = run(
        decideReturn(owner, vendorId, branchId, submitted.body.id, {
          decision: 'approve',
        }),
      );
      await barrier.reached();

      let archiveResult: Res;
      try {
        const archivePromise = run(archiveBranch(owner, vendorId, branchId));
        const archiveSettledEarly = await settledWithin(archivePromise, 500);
        expect(archiveSettledEarly).toBe(false);
        expect(
          await someoneWaitsOnLock(
            '%pg_advisory_xact_lock%branch_operational_status%',
          ),
        ).toBe(true);
        barrier.release();
        archiveResult = await archivePromise;
      } finally {
        barrier.release();
      }
      const approvalResult = await approvalPromise;

      expect(approvalResult.status).toBe(200);
      expect(archiveResult.status).toBe(409);
      expect(archiveResult.body.error.code).toBe(
        'BRANCH_HAS_ACTIVE_EXCHANGE_RESERVATION',
      );
    });

    it('deterministic concurrency: archive commits first (holds the lock) - a concurrent approval genuinely waits, then is rejected because the branch is now archived', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 5, 120, 3);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const submitted = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        replacementVariantId,
        branchId,
      );

      const barrier = barrierOnAudit('store_branch.archived');
      const archivePromise = run(archiveBranch(owner, vendorId, branchId));
      await barrier.reached();

      let approvalResult: Res;
      try {
        const approvalPromise = run(
          decideReturn(owner, vendorId, branchId, submitted.body.id, {
            decision: 'approve',
          }),
        );
        const approvalSettledEarly = await settledWithin(approvalPromise, 500);
        expect(approvalSettledEarly).toBe(false);
        expect(
          await someoneWaitsOnLock(
            '%pg_advisory_xact_lock%branch_operational_status%',
          ),
        ).toBe(true);
        barrier.release();
        approvalResult = await approvalPromise;
      } finally {
        barrier.release();
      }
      const archiveResult = await archivePromise;

      expect(archiveResult.status).toBe(200);
      expect(approvalResult.status).toBe(409);
      expect(approvalResult.body.error.code).toBe(
        'REPLACEMENT_BRANCH_NOT_AVAILABLE',
      );
    });
  });

  // ============================================================
  // Concurrency: two approvals racing for the last reservable unit.
  // ============================================================
  describe('Deterministic concurrency: last unit of the replacement', () => {
    it('two concurrent exchange approvals both wanting the LAST unit of the same replacement - only one succeeds', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 5, 120, 1);
      const customerA = await signup(uniquePhone(), 'a-strong-password');
      const customerB = await signup(uniquePhone(), 'a-strong-password');
      const orderA = await placeAndPickUpOrder(
        owner,
        customerA,
        vendorId,
        branchId,
        originalVariantId,
      );
      const orderB = await placeAndPickUpOrder(
        owner,
        customerB,
        vendorId,
        branchId,
        originalVariantId,
      );
      const submittedA = await submitExchange(
        customerA,
        orderA.branchOrderId,
        orderA.itemId,
        replacementVariantId,
        branchId,
      );
      const submittedB = await submitExchange(
        customerB,
        orderB.branchOrderId,
        orderB.itemId,
        replacementVariantId,
        branchId,
      );

      const barrier = barrierOnAudit('return.exchange_approved');
      const firstApproval = run(
        decideReturn(owner, vendorId, branchId, submittedA.body.id, {
          decision: 'approve',
        }),
      );
      await barrier.reached();

      // approveReturn() takes lockBranchOperationalStatus(branchId)
      // BEFORE it ever reaches the branch_stock advisory lock - since
      // both approvals target the SAME branch, the second call is
      // genuinely blocked there first (never even reaching the stock
      // lock while the first transaction is still open) - this IS the
      // real, correct serialization point for two concurrent approvals
      // at one branch, not a weaker substitute for it.
      let secondResult: Res;
      try {
        const secondApproval = run(
          decideReturn(owner, vendorId, branchId, submittedB.body.id, {
            decision: 'approve',
          }),
        );
        const secondSettledEarly = await settledWithin(secondApproval, 500);
        expect(secondSettledEarly).toBe(false);
        expect(
          await someoneWaitsOnLock(
            '%pg_advisory_xact_lock%branch_operational_status%',
          ),
        ).toBe(true);
        barrier.release();
        secondResult = await secondApproval;
      } finally {
        // Never leave the first transaction paused forever on a
        // release() that an assertion above might have skipped - a
        // second call is harmless (resolving an already-resolved
        // promise is a no-op).
        barrier.release();
      }
      const firstResult = await firstApproval;

      const results = [firstResult.status, secondResult.status].sort();
      expect(results).toEqual([200, 409]);
      const failed = firstResult.status === 409 ? firstResult : secondResult;
      expect(failed.body.error.code).toBe('REPLACEMENT_NOT_AVAILABLE');
    });
  });

  // ============================================================
  // Deterministic concurrency: redeem touching TWO stock keys, raced
  // against a DIFFERENT transaction that touches only ONE of them -
  // the review-round lock-order fix. fulfillExchange() used to call
  // the SINGLE-key lockSweepOrCreateStockRow() twice sequentially (once
  // per key), each independently discovering-and-locking its own
  // expired-reservation set - a real deadlock risk against any other
  // caller touching one of the same keys. The fix
  // (lockSweepOrCreateStockRowsSorted) takes every key's advisory lock
  // up front in one deterministic sorted order instead.
  //
  // Two redemptions at the SAME branch can't actually exercise this at
  // the stock layer in isolation - redeem() already takes
  // lockBranchOperationalStatus for the branch BEFORE reaching
  // fulfillExchange, which alone fully serializes them (same
  // established finding as the "last unit" test above). The sweep's
  // own expiry release, by contrast, deliberately does NOT take that
  // branch lock (it only locks the Return row - see
  // return-sweep.service.ts's own comment), so a redeem's multi-key
  // lock and a DIFFERENT return's sweep-expiry single-key lock CAN
  // reach the branch_stock advisory lock concurrently - this is the
  // one pairing in this codebase that actually proves the fix at the
  // stock layer itself, not merely behind an earlier, coarser lock.
  // ============================================================
  describe('Deterministic concurrency: redeem (multi-key) vs. sweep expiry (single-key) on a shared stock key', () => {
    it('redeeming R1 (keys A+B) and sweep-expiring R2 (key B only) race on the shared key B - one waits, then both complete with correct final stock', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId: variantA, replacementVariantId: variantB } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 5, 120, 2);
      const offerForA = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantA },
        select: { vendorOfferId: true },
      });
      const variantC = await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: offerForA.vendorOfferId,
          sellerSku: unique('sku-c'),
          basePrice: 110,
          storeInventoryBarcode: unique('barcode-c'),
        },
      });
      await prisma.branchStock.create({
        data: { vendorId, branchId, offerVariantId: variantC.id, quantity: 5 },
      });

      // R1: bought A, exchanges for B - will be REDEEMED (touches A+B).
      const customer1 = await signup(uniquePhone(), 'a-strong-password');
      const order1 = await placeAndPickUpOrder(
        owner,
        customer1,
        vendorId,
        branchId,
        variantA,
      );
      const submitted1 = await submitExchange(
        customer1,
        order1.branchOrderId,
        order1.itemId,
        variantB,
        branchId,
      );
      await decideReturn(owner, vendorId, branchId, submitted1.body.id, {
        decision: 'approve',
      }).expect(200);
      const r1 = await prisma.return.findUniqueOrThrow({
        where: { id: submitted1.body.id },
      });

      // R2: bought C, exchanges for B too (the SHARED key) - will
      // EXPIRE via the sweep instead of being redeemed (touches only B).
      const customer2 = await signup(uniquePhone(), 'a-strong-password');
      const order2 = await placeAndPickUpOrder(
        owner,
        customer2,
        vendorId,
        branchId,
        variantC.id,
      );
      const submitted2 = await submitExchange(
        customer2,
        order2.branchOrderId,
        order2.itemId,
        variantB,
        branchId,
      );
      await decideReturn(owner, vendorId, branchId, submitted2.body.id, {
        decision: 'approve',
      }).expect(200);
      await prisma.return.update({
        where: { id: submitted2.body.id },
        data: { codeExpiresAt: new Date(Date.now() - 1000) },
      });

      // Pause R1's redeem deep inside fulfillExchange (after it has
      // already acquired both stock locks and mutated both rows, right
      // before the final audit write) - the concurrent sweep, wanting
      // B's advisory lock too, must then genuinely wait, never deadlock
      // or corrupt either row.
      const barrier = barrierOnAudit('return.exchange_fulfilled');
      const firstRedeem = run(
        redeemReturn(owner, vendorId, {
          code: r1.code,
          receiving_branch_id: branchId,
          item_condition: 'RESELLABLE',
        }),
      );
      await barrier.reached();

      try {
        const sweepPromise = sweep.sweepOnce();
        const sweepSettledEarly = await settledWithin(sweepPromise, 500);
        expect(sweepSettledEarly).toBe(false);
        expect(
          await someoneWaitsOnLock('%pg_advisory_xact_lock%branch_stock%'),
        ).toBe(true);
        barrier.release();
        await sweepPromise;
      } finally {
        barrier.release();
      }
      const firstResult = await firstRedeem;
      expect(firstResult.status).toBe(201);

      const stockA = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variantA },
        },
      });
      const stockB = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variantB },
        },
      });
      // A: 5 bought-down to 4, restocked by R1's redeem back to 5.
      expect(stockA.quantity).toBe(5);
      expect(stockA.reservedQuantity).toBe(0);
      // B: started at 2, never bought, R1's redeem hands one over (1
      // left) and releases its own reservation; R2's sweep releases its
      // OWN reservation too (never a hand-over) - reservedQuantity ends
      // at 0 either way, proving neither release was lost to the race.
      expect(stockB.quantity).toBe(1);
      expect(stockB.reservedQuantity).toBe(0);

      const final1 = await prisma.return.findUniqueOrThrow({
        where: { id: r1.id },
      });
      const final2 = await prisma.return.findUniqueOrThrow({
        where: { id: submitted2.body.id },
      });
      expect(final1.status).toBe('EXCHANGED');
      expect(final2.status).toBe('EXPIRED');
    });
  });

  // ============================================================
  // Exchange-options endpoint - review-round requirement §2.
  // ============================================================
  describe('GET exchange-options (customer replacement picker)', () => {
    it('lists other variants of the same offer at eligible branches, excludes the original variant, archived/unapproved branches, and insufficient stock', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 5, 120, 3);

      // A third variant with ZERO stock anywhere - must not appear.
      const offer = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: originalVariantId },
        select: { vendorOfferId: true },
      });
      const zeroStockVariant = await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: offer.vendorOfferId,
          sellerSku: unique('sku-zero'),
          basePrice: 110,
          storeInventoryBarcode: unique('barcode-zero'),
        },
      });

      // An archived branch with stock of the replacement - must not
      // contribute an availability entry.
      const archivedBranch = await addBranch(
        owner,
        vendorId,
        'Archived Branch',
      );
      await prisma.storeBranch.update({
        where: { id: archivedBranch },
        data: { verificationStatus: 'APPROVED', archivedAt: new Date() },
      });
      await prisma.branchStock.create({
        data: {
          vendorId,
          branchId: archivedBranch,
          offerVariantId: replacementVariantId,
          quantity: 9,
        },
      });

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );

      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/customers/me/orders/${order.branchOrderId}/items/${order.itemId}/exchange-options`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);

      const variantIds = res.body.variants.map((v: { id: string }) => v.id);
      expect(variantIds).toContain(replacementVariantId);
      expect(variantIds).not.toContain(originalVariantId);
      expect(variantIds).not.toContain(zeroStockVariant.id);

      const replacementEntry = res.body.variants.find(
        (v: { id: string }) => v.id === replacementVariantId,
      );
      const branchIdsForReplacement =
        replacementEntry.available_at_branches.map(
          (b: { branch_id: string }) => b.branch_id,
        );
      expect(branchIdsForReplacement).toContain(branchId);
      expect(branchIdsForReplacement).not.toContain(archivedBranch);

      const returnedBranchIds = res.body.branches.map(
        (b: { id: string }) => b.id,
      );
      expect(returnedBranchIds).toContain(branchId);
      expect(returnedBranchIds).not.toContain(archivedBranch);
    });

    it("BOLA: a different customer cannot read another customer's exchange-options", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { originalVariantId } = await createOfferWithTwoVariants(
        vendorId,
        branchId,
        100,
        5,
        120,
        3,
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const stranger = await signup(uniquePhone(), 'a-strong-password');
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/customers/me/orders/${order.branchOrderId}/items/${order.itemId}/exchange-options`,
        )
        .set('Authorization', `Bearer ${stranger}`);
      expect(res.status).toBe(404);
    });
  });
});
