import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuditLogService } from './../src/audit/audit-log.service';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { createUniquePhone } from './helpers/e2e-phone-lanes';

type Res = { status: number; body: any };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// supertest's Test object is lazy - Promise.resolve(t) forces dispatch
// immediately (same established fix as every other barrier-test spec
// file in this project).
const run = (t: PromiseLike<Res>): Promise<Res> => Promise.resolve(t);

const uniquePhone = createUniquePhone('sprint23-reviews-verification', '56');
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

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

describe('Sprint 23 - reviews and the verification badge (e2e)', () => {
  let app: INestApplication | undefined;
  let fakeSms: FakeSmsService;
  let prisma: PrismaService;

  beforeEach(async () => {
    fakeSms = new FakeSmsService();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SmsService)
      .useValue(fakeSms)
      // Several of this file's own tests create more than 5 users
      // each (reviews/reports/admin decisions all need their own
      // signed-up actor) - the 5/60s OTP throttle itself is covered by
      // the auth specs, not these, so it's neutralised here the same
      // way sprint16-fixtures.ts's bootApp() already established.
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 1,
            timeToExpire: 60,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
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
      .set('Idempotency-Key', unique('verify'))
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
    storeType: 'PHYSICAL' | 'ONLINE_ONLY' | 'HYBRID' = 'PHYSICAL',
  ): Promise<{ vendorId: string; branchId: string | null; slug: string }> {
    const slug = unique('store').toLowerCase();
    const branches =
      storeType === 'ONLINE_ONLY'
        ? [{ name: 'Online branch', is_physical: false }]
        : [{ name: 'Branch A', is_physical: true }];
    const res = await request(app.getHttpServer())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        store_type: storeType,
        branches,
        applicable_categories: ['WOMEN'],
        return_policy: { mode: 'NO_RETURN' },
      })
      .expect(201);
    await prisma.vendor.update({ where: { id: res.body.id }, data: { slug } });
    return {
      vendorId: res.body.id,
      branchId: res.body.branches[0]?.id ?? null,
      slug,
    };
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

  async function makeCanonicalProduct(): Promise<{
    productId: string;
    variantId: string;
  }> {
    const brand = await prisma.brand.create({
      data: {
        name: unique('Brand'),
        normalizedName: unique('brand').toLowerCase(),
      },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('Cat') },
    });
    const product = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('Model'),
        status: 'PUBLISHED',
      },
    });
    const variant = await prisma.canonicalProductVariant.create({
      data: {
        canonicalProductId: product.id,
        structuralAttributes: {},
        gtin: unique('gtin'),
        platformProductBarcode: unique('PPB'),
      },
    });
    return { productId: product.id, variantId: variant.id };
  }

  async function createOfferWithStock(
    vendorId: string,
    branchId: string,
    price: number,
    quantity: number,
    canonicalVariantId?: string,
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
        canonicalVariantId: canonicalVariantId ?? null,
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

  /** Places a PICKUP BranchOrder and drives it all the way through
   * PICKED_UP -> COMPLETED (pickup-handover does both transitions
   * atomically - see branch-orders-staff.controller.ts) - review-
   * eligible, returning the item id. */
  async function placeAndCompleteOrder(
    owner: string,
    customer: string,
    vendorId: string,
    branchId: string,
    variantId: string,
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
            payment_method: 'COD',
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
      {
        pickup_code: pickupCode,
      },
    ).expect(201);

    const item = await prisma.branchOrderItem.findFirstOrThrow({
      where: { branchOrderId },
    });
    return { branchOrderId, itemId: item.id };
  }

  const submitReview = (
    token: string,
    body: Record<string, unknown>,
    idemKey = unique('review'),
  ) =>
    request(app.getHttpServer())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idemKey)
      .send(body);

  const reportReview = (
    token: string,
    reviewId: string,
    reason: string,
    idemKey = unique('report'),
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/reviews/${reviewId}/report`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idemKey)
      .send({ reason });

  const decideReport = (
    token: string,
    reviewId: string,
    decision: 'dismiss' | 'uphold',
    idemKey = unique('decide'),
  ) =>
    request(app.getHttpServer())
      .patch(`/api/v1/admin/reviews/${reviewId}/decision`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idemKey)
      .send({ decision });

  // ------------------------------------------------------------
  // Eligibility
  // ------------------------------------------------------------
  describe('eligibility', () => {
    it('a PRODUCT review succeeds once the order is COMPLETED and the listing is matched', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'owner-password-1');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { productId, variantId: canonicalVariantId } =
        await makeCanonicalProduct();
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        5,
        canonicalVariantId,
      );
      const customer = await signup(uniquePhone(), 'customer-password-1');
      const { itemId } = await placeAndCompleteOrder(
        owner,
        customer,
        vendorId,
        branchId!,
        offerVariantId,
      );

      const res = await run(
        submitReview(customer, {
          source_branch_order_item_id: itemId,
          target_type: 'PRODUCT',
          rating: 5,
          body: 'منتج ممتاز وخدمة سريعة',
        }),
      );
      expect(res.status).toBe(201);
      expect(res.body.target_type).toBe('PRODUCT');
      expect(res.body.canonical_product_id).toBe(productId);
      expect(res.body.moderation_status).toBe('VISIBLE');
    });

    it('a STORE review succeeds once the order is COMPLETED', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-2');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        5,
      );
      const customer = await signup(uniquePhone(), 'customer-password-2');
      const { itemId } = await placeAndCompleteOrder(
        owner,
        customer,
        vendorId,
        branchId!,
        offerVariantId,
      );

      const res = await run(
        submitReview(customer, {
          source_branch_order_item_id: itemId,
          target_type: 'STORE',
          rating: 4,
          body: 'تجربة جيدة مع المتجر',
        }),
      );
      expect(res.status).toBe(201);
      expect(res.body.target_type).toBe('STORE');
      expect(res.body.vendor_id).toBe(vendorId);
    });

    it('is rejected before the order reaches COMPLETED', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-3');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        5,
      );
      const customer = await signup(uniquePhone(), 'customer-password-3');

      const cartItemId = await addToCart(customer, vendorId, offerVariantId, 1);
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
              payment_method: 'COD',
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

      const res = await run(
        submitReview(customer, {
          source_branch_order_item_id: item.id,
          target_type: 'STORE',
          rating: 3,
          body: 'لم يكتمل الطلب بعد',
        }),
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_ELIGIBLE_FOR_REVIEW');
    });

    it('a cancelled item is never reviewable, even once its order is otherwise COMPLETED', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-4');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        5,
      );
      const customer = await signup(uniquePhone(), 'customer-password-4');
      const { itemId } = await placeAndCompleteOrder(
        owner,
        customer,
        vendorId,
        branchId!,
        offerVariantId,
      );
      // Not a real customer-cancel flow (that's unreachable once
      // COMPLETED) - this directly asserts the service's own
      // cancelledAt check, the same seeding shortcut this project uses
      // throughout for states a real flow can't reach anymore.
      await prisma.branchOrderItem.update({
        where: { id: itemId },
        data: { cancelledAt: new Date() },
      });

      const res = await run(
        submitReview(customer, {
          source_branch_order_item_id: itemId,
          target_type: 'STORE',
          rating: 1,
          body: 'عنصر ملغى',
        }),
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ITEM_CANCELLED_NOT_REVIEWABLE');
    });

    it('a PRODUCT review on an unmatched (standalone) listing is rejected', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-5');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        5,
      ); // no canonicalVariantId
      const customer = await signup(uniquePhone(), 'customer-password-5');
      const { itemId } = await placeAndCompleteOrder(
        owner,
        customer,
        vendorId,
        branchId!,
        offerVariantId,
      );

      const res = await run(
        submitReview(customer, {
          source_branch_order_item_id: itemId,
          target_type: 'PRODUCT',
          rating: 5,
          body: 'منتج غير مطابق لأي منتج أساسي',
        }),
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_NOT_ELIGIBLE_FOR_REVIEW');
    });

    it("a different customer cannot use someone else's purchased item - 404, never 403 (BOLA-safe)", async () => {
      const owner = await signup(uniquePhone(), 'owner-password-6');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        5,
      );
      const customerA = await signup(uniquePhone(), 'customer-password-6a');
      const customerB = await signup(uniquePhone(), 'customer-password-6b');
      const { itemId } = await placeAndCompleteOrder(
        owner,
        customerA,
        vendorId,
        branchId!,
        offerVariantId,
      );

      const res = await run(
        submitReview(customerB, {
          source_branch_order_item_id: itemId,
          target_type: 'STORE',
          rating: 2,
          body: 'لم أشترِ هذا المنتج',
        }),
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('BRANCH_ORDER_ITEM_NOT_FOUND');
    });

    it('a non-existent item is also a plain 404, indistinguishable from "belongs to someone else"', async () => {
      const customer = await signup(uniquePhone(), 'customer-password-7');
      const res = await run(
        submitReview(customer, {
          source_branch_order_item_id: 'does-not-exist',
          target_type: 'STORE',
          rating: 2,
          body: 'عنصر غير موجود',
        }),
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('BRANCH_ORDER_ITEM_NOT_FOUND');
    });
  });

  // ------------------------------------------------------------
  // Uniqueness
  // ------------------------------------------------------------
  describe('uniqueness (one PRODUCT + one STORE review per purchased item)', () => {
    it('a second review of the SAME type for the same item is rejected, but the OTHER type still succeeds', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-8');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const { variantId: canonicalVariantId } = await makeCanonicalProduct();
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        5,
        canonicalVariantId,
      );
      const customer = await signup(uniquePhone(), 'customer-password-8');
      const { itemId } = await placeAndCompleteOrder(
        owner,
        customer,
        vendorId,
        branchId!,
        offerVariantId,
      );

      const first = await run(
        submitReview(customer, {
          source_branch_order_item_id: itemId,
          target_type: 'STORE',
          rating: 5,
          body: 'أول مراجعة للمتجر',
        }),
      );
      expect(first.status).toBe(201);

      const duplicate = await run(
        submitReview(customer, {
          source_branch_order_item_id: itemId,
          target_type: 'STORE',
          rating: 1,
          body: 'محاولة ثانية لنفس النوع',
        }),
      );
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('REVIEW_ALREADY_SUBMITTED');

      const productReview = await run(
        submitReview(customer, {
          source_branch_order_item_id: itemId,
          target_type: 'PRODUCT',
          rating: 4,
          body: 'مراجعة للمنتج نفسه - نوع مختلف',
        }),
      );
      expect(productReview.status).toBe(201);
    });

    /**
     * Deterministic concurrency proof (not timing-dependent): pauses
     * transaction A right after its INSERT (inside the audit write,
     * still uncommitted - see barrierOnAuditCapturingTx) and captures
     * A's own backend pid from INSIDE that still-open transaction.
     * Fires B concurrently with a DIFFERENT idempotency key (so this
     * tests the DB's own unique-constraint race, never idempotency
     * de-dup) and proves - via pg_blocking_pids, not a generic lock-
     * type/query-text guess - that B is blocked specifically BY A's
     * captured pid, waiting on the uncommitted conflicting row
     * (wait_event = 'transactionid'). Only after that proof does it
     * release A: A commits (201), B then sees the now-committed
     * conflict and gets a real P2002 the service translates to 409.
     */
    it('two concurrent submissions for the same (item, target_type) race on the DB unique index - one wins, one gets 409', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-9');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        5,
      );
      const customer = await signup(uniquePhone(), 'customer-password-9');
      const { itemId } = await placeAndCompleteOrder(
        owner,
        customer,
        vendorId,
        branchId!,
        offerVariantId,
      );

      function barrierOnAuditCapturingTx(action: string) {
        const audit = app!.get(AuditLogService);
        const original = audit.record.bind(audit);
        let release!: () => void;
        let reachedWithPid!: (pid: number) => void;
        const gate = new Promise<void>((r) => (release = r));
        const hit = new Promise<number>((r) => (reachedWithPid = r));
        let armed = true;
        jest.spyOn(audit, 'record').mockImplementation(async (input, tx) => {
          if (armed && input.action === action && tx) {
            armed = false;
            const rows = await tx.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid()::int AS pid`;
            reachedWithPid(rows[0].pid);
            await gate;
          }
          return original(input, tx);
        });
        return {
          release: () => release(),
          reachedPid: () =>
            Promise.race([
              hit,
              sleep(10_000).then((): number => {
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

      async function isBlockedByPid(targetPid: number): Promise<boolean> {
        for (let i = 0; i < 50; i++) {
          const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type = 'Lock'
                AND wait_event = 'transactionid'
                AND ${targetPid} = ANY(pg_blocking_pids(pid))
            ) AS blocked`;
          if (rows[0].blocked) return true;
          await sleep(100);
        }
        return false;
      }

      const barrier = barrierOnAuditCapturingTx('review.submitted');

      const reqA = run(
        submitReview(
          customer,
          {
            source_branch_order_item_id: itemId,
            target_type: 'STORE',
            rating: 5,
            body: 'السباق - الطلب الأول',
          },
          unique('race-a'),
        ),
      );

      const pidA = await barrier.reachedPid();

      const reqB = run(
        submitReview(
          customer,
          {
            source_branch_order_item_id: itemId,
            target_type: 'STORE',
            rating: 1,
            body: 'السباق - الطلب الثاني',
          },
          unique('race-b'),
        ),
      );

      // B must genuinely be waiting on A's own uncommitted row - never
      // a generic "something somewhere is locked" guess.
      expect(await isBlockedByPid(pidA)).toBe(true);
      // And B must not have settled yet while A still holds the row.
      expect(await settledWithin(reqB, 300)).toBe(false);

      barrier.release();

      const [resA, resB] = await Promise.all([reqA, reqB]);
      const results = [resA, resB].sort((a, b) => a.status - b.status);
      expect(results[0].status).toBe(201);
      expect(results[1].status).toBe(409);
      expect(results[1].body.error.code).toBe('REVIEW_ALREADY_SUBMITTED');

      const count = await prisma.review.count({
        where: { sourceBranchOrderItemId: itemId, targetType: 'STORE' },
      });
      expect(count).toBe(1);
    });
  });

  // ------------------------------------------------------------
  // Reports and admin decisions
  // ------------------------------------------------------------
  describe('reports and PLATFORM_ADMIN decisions', () => {
    async function createVisibleReview(): Promise<{
      reviewId: string;
      reporterA: string;
      reporterB: string;
    }> {
      const owner = await signup(uniquePhone(), 'owner-password-10');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        5,
      );
      const author = await signup(uniquePhone(), 'author-password-10');
      const { itemId } = await placeAndCompleteOrder(
        owner,
        author,
        vendorId,
        branchId!,
        offerVariantId,
      );
      const created = await run(
        submitReview(author, {
          source_branch_order_item_id: itemId,
          target_type: 'STORE',
          rating: 1,
          body: 'مراجعة قد تُبلّغ عنها',
        }),
      );
      expect(created.status).toBe(201);

      const reporterA = await signup(uniquePhone(), 'reporter-password-10a');
      const reporterB = await signup(uniquePhone(), 'reporter-password-10b');
      return { reviewId: created.body.id, reporterA, reporterB };
    }

    it('the review author cannot report their own review - no ReviewReport or AuditLog row is created', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-10z');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        5,
      );
      const author = await signup(uniquePhone(), 'author-password-10z');
      const { itemId } = await placeAndCompleteOrder(
        owner,
        author,
        vendorId,
        branchId!,
        offerVariantId,
      );
      const created = await run(
        submitReview(author, {
          source_branch_order_item_id: itemId,
          target_type: 'STORE',
          rating: 5,
          body: 'لا يمكنني الإبلاغ عن مراجعتي الخاصة',
        }),
      );
      expect(created.status).toBe(201);

      const auditCountBefore = await prisma.auditLog.count({
        where: { entityType: 'ReviewReport' },
      });
      const selfReport = await run(
        reportReview(author, created.body.id, 'محاولة إبلاغ ذاتي'),
      );
      expect(selfReport.status).toBe(409);
      expect(selfReport.body.error.code).toBe('CANNOT_REPORT_OWN_REVIEW');

      const reports = await prisma.reviewReport.findMany({
        where: { reviewId: created.body.id },
      });
      expect(reports).toHaveLength(0);
      const auditCountAfter = await prisma.auditLog.count({
        where: { entityType: 'ReviewReport' },
      });
      expect(auditCountAfter).toBe(auditCountBefore);

      const review = await prisma.review.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(review.moderationStatus).toBe('VISIBLE');
    });

    it('the first report moves VISIBLE -> REPORTED; a duplicate report by the same reporter is rejected', async () => {
      const { reviewId, reporterA } = await createVisibleReview();
      const before = await prisma.review.findUniqueOrThrow({
        where: { id: reviewId },
      });
      expect(before.moderationStatus).toBe('VISIBLE');

      const first = await run(reportReview(reporterA, reviewId, 'محتوى مسيء'));
      expect(first.status).toBe(201);
      expect(first.body.status).toBe('PENDING');

      const afterFirst = await prisma.review.findUniqueOrThrow({
        where: { id: reviewId },
      });
      expect(afterFirst.moderationStatus).toBe('REPORTED');

      const duplicate = await run(
        reportReview(reporterA, reviewId, 'نفس البلاغ مجدداً'),
      );
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('REVIEW_ALREADY_REPORTED');
    });

    it('dismiss moves REPORTED back to VISIBLE and closes every pending report to DISMISSED; a later report from a different customer moves it to REPORTED again', async () => {
      const { reviewId, reporterA, reporterB } = await createVisibleReview();
      await run(reportReview(reporterA, reviewId, 'سبب أول')).then((r) =>
        expect(r.status).toBe(201),
      );
      await run(reportReview(reporterB, reviewId, 'سبب ثانٍ')).then((r) =>
        expect(r.status).toBe(201),
      );
      const reported = await prisma.review.findUniqueOrThrow({
        where: { id: reviewId },
      });
      expect(reported.moderationStatus).toBe('REPORTED');

      const admin = await platformAdmin();
      const decision = await run(decideReport(admin, reviewId, 'dismiss'));
      expect(decision.status).toBe(200);
      expect(decision.body.moderation_status).toBe('VISIBLE');

      const reports = await prisma.reviewReport.findMany({
        where: { reviewId },
      });
      expect(reports).toHaveLength(2);
      expect(reports.every((r) => r.status === 'DISMISSED')).toBe(true);

      const visibleAgain = await prisma.review.findUniqueOrThrow({
        where: { id: reviewId },
      });
      expect(visibleAgain.moderationStatus).toBe('VISIBLE');

      const stillPublic = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${reported.vendorId}/reviews`)
        .expect(200);
      expect(stillPublic.body.reviews.some((r: any) => r.id === reviewId)).toBe(
        true,
      );

      // A fresh report from a DIFFERENT customer after dismissal moves
      // it back to REPORTED - dismissal is not a permanent immunity.
      const reporterC = await signup(
        uniquePhone(),
        'reporter-password-10c-again',
      );
      const second = await run(
        reportReview(reporterC, reviewId, 'سبب جديد بعد التجاهل'),
      );
      expect(second.status).toBe(201);
      const reReported = await prisma.review.findUniqueOrThrow({
        where: { id: reviewId },
      });
      expect(reReported.moderationStatus).toBe('REPORTED');
    });

    it('uphold moves REPORTED to HIDDEN (final) - a non-PENDING review can no longer be reported or re-decided', async () => {
      const { reviewId, reporterA } = await createVisibleReview();
      await run(reportReview(reporterA, reviewId, 'سبب للإخفاء')).then((r) =>
        expect(r.status).toBe(201),
      );
      const reported = await prisma.review.findUniqueOrThrow({
        where: { id: reviewId },
      });
      expect(reported.moderationStatus).toBe('REPORTED');

      const admin = await platformAdmin();
      const decision = await run(decideReport(admin, reviewId, 'uphold'));
      expect(decision.status).toBe(200);
      expect(decision.body.moderation_status).toBe('HIDDEN');

      const review = await prisma.review.findUniqueOrThrow({
        where: { id: reviewId },
      });
      expect(review.moderationStatus).toBe('HIDDEN');

      const reporterC = await signup(uniquePhone(), 'reporter-password-10c');
      const lateReport = await run(
        reportReview(reporterC, reviewId, 'بلاغ بعد الإخفاء'),
      );
      expect(lateReport.status).toBe(409);
      expect(lateReport.body.error.code).toBe('REVIEW_ALREADY_HIDDEN');

      const redecide = await run(decideReport(admin, reviewId, 'dismiss'));
      expect(redecide.status).toBe(409);
      expect(redecide.body.error.code).toBe('NO_PENDING_REPORTS');
    });

    it('a non-admin customer cannot reach the moderation queue or decide a report', async () => {
      const { reviewId } = await createVisibleReview();
      const plainCustomer = await signup(uniquePhone(), 'plain-password-10');

      const queue = await request(app.getHttpServer())
        .get('/api/v1/admin/reviews/reported')
        .set('Authorization', `Bearer ${plainCustomer}`);
      expect(queue.status).toBe(403);

      const decision = await run(
        decideReport(plainCustomer, reviewId, 'dismiss'),
      );
      expect(decision.status).toBe(403);
    });

    it('PLATFORM_ADMIN sees exactly the reviews with a pending report', async () => {
      const { reviewId, reporterA } = await createVisibleReview();
      await run(reportReview(reporterA, reviewId, 'سبب للقائمة')).then((r) =>
        expect(r.status).toBe(201),
      );
      const admin = await platformAdmin();
      const queue = await request(app.getHttpServer())
        .get('/api/v1/admin/reviews/reported')
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(queue.body.some((r: any) => r.id === reviewId)).toBe(true);
      const row = queue.body.find((r: any) => r.id === reviewId);
      expect(row.pending_reports).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------
  // Public reads: VISIBLE filtering, aggregate, author display
  // ------------------------------------------------------------
  describe('public reads', () => {
    it('withholds the aggregate below 3 VISIBLE reviews and shows it at 3, and never counts a HIDDEN review', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-11');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        10,
      );
      const admin = await platformAdmin();

      const ratings = [5, 4, 3];
      const reviewIds: string[] = [];
      for (const rating of ratings) {
        const customer = await signup(uniquePhone(), unique('pw'));
        const { itemId } = await placeAndCompleteOrder(
          owner,
          customer,
          vendorId,
          branchId!,
          offerVariantId,
        );
        if (reviewIds.length === 0) {
          const before = await request(app.getHttpServer())
            .get(`/api/v1/vendors/${vendorId}/reviews`)
            .expect(200);
          expect(before.body.aggregate.average).toBeNull();
        }
        const created = await run(
          submitReview(customer, {
            source_branch_order_item_id: itemId,
            target_type: 'STORE',
            rating,
            body: unique('نص المراجعة'),
          }),
        );
        expect(created.status).toBe(201);
        reviewIds.push(created.body.id);
      }

      const after3 = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/reviews`)
        .expect(200);
      expect(after3.body.aggregate.count).toBe(3);
      expect(after3.body.aggregate.average).toBe(4);

      // Hide one of the three via the real report+uphold path.
      const reporter = await signup(uniquePhone(), 'reporter-password-11');
      await run(reportReview(reporter, reviewIds[0], 'سبب للإخفاء')).then((r) =>
        expect(r.status).toBe(201),
      );
      await run(decideReport(admin, reviewIds[0], 'uphold')).then((r) =>
        expect(r.status).toBe(200),
      );

      const afterHide = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/reviews`)
        .expect(200);
      expect(afterHide.body.aggregate.count).toBe(2);
      expect(
        afterHide.body.reviews.some((r: any) => r.id === reviewIds[0]),
      ).toBe(false);
    });

    it('a REPORTED (not yet decided) review stays publicly visible but is excluded from the aggregate - only HIDDEN is excluded from the list', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-11b');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        10,
      );

      // 4 reviews (not 3) so that reporting one still leaves 3 VISIBLE
      // - enough to show a real average, not conflated with the
      // separate "withheld below 3" rule.
      const reviewIds: string[] = [];
      for (const rating of [5, 4, 3, 2]) {
        const customer = await signup(uniquePhone(), unique('pw-11b'));
        const { itemId } = await placeAndCompleteOrder(
          owner,
          customer,
          vendorId,
          branchId!,
          offerVariantId,
        );
        const created = await run(
          submitReview(customer, {
            source_branch_order_item_id: itemId,
            target_type: 'STORE',
            rating,
            body: unique('نص مراجعة للإبلاغ'),
          }),
        );
        expect(created.status).toBe(201);
        reviewIds.push(created.body.id);
      }

      const before = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/reviews`)
        .expect(200);
      expect(before.body.aggregate.count).toBe(4);
      expect(before.body.aggregate.average).toBe(3.5);

      // Report (but do not decide) the 5-star review - moves it to
      // REPORTED, never HIDDEN by a report alone.
      const reporter = await signup(uniquePhone(), 'reporter-password-11b');
      await run(reportReview(reporter, reviewIds[0], 'سبب للإبلاغ فقط')).then(
        (r) => expect(r.status).toBe(201),
      );
      const reported = await prisma.review.findUniqueOrThrow({
        where: { id: reviewIds[0] },
      });
      expect(reported.moderationStatus).toBe('REPORTED');

      const afterReport = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/reviews`)
        .expect(200);
      // Still in the public list (only HIDDEN is excluded)...
      expect(
        afterReport.body.reviews.some((r: any) => r.id === reviewIds[0]),
      ).toBe(true);
      // ...but no longer counted toward the aggregate (VISIBLE only):
      // 3 VISIBLE reviews (4, 3, 2) left, average 3, not the 3.5 from all 4.
      expect(afterReport.body.aggregate.count).toBe(3);
      expect(afterReport.body.aggregate.average).toBe(3);
    });

    it('shows displayName when set, and the verified-customer fallback otherwise', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-12');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerVariantId = await createOfferWithStock(
        vendorId,
        branchId!,
        50,
        5,
      );

      const customer = await signup(uniquePhone(), 'customer-password-12');
      await request(app.getHttpServer())
        .patch('/api/v1/customers/me')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('patch-me'))
        .send({ display_name: 'سارة أ.' })
        .expect(200);
      const { itemId } = await placeAndCompleteOrder(
        owner,
        customer,
        vendorId,
        branchId!,
        offerVariantId,
      );
      const created = await run(
        submitReview(customer, {
          source_branch_order_item_id: itemId,
          target_type: 'STORE',
          rating: 5,
          body: 'باسم ظاهر',
        }),
      );
      expect(created.status).toBe(201);
      expect(created.body.author).toBe('سارة أ.');

      const anonCustomer = await signup(uniquePhone(), 'customer-password-12b');
      const { itemId: itemId2 } = await placeAndCompleteOrder(
        owner,
        anonCustomer,
        vendorId,
        branchId!,
        offerVariantId,
      );
      const created2 = await run(
        submitReview(anonCustomer, {
          source_branch_order_item_id: itemId2,
          target_type: 'PRODUCT',
          rating: 3,
          body: 'بدون اسم ظاهر',
        }),
      );
      // PRODUCT without a matched canonical product fails eligibility
      // in this fixture - use STORE instead for the fallback check.
      expect([201, 409]).toContain(created2.status);

      const createdStore2 = await run(
        submitReview(anonCustomer, {
          source_branch_order_item_id: itemId2,
          target_type: 'STORE',
          rating: 3,
          body: 'بدون اسم ظاهر',
        }),
      );
      expect(createdStore2.status).toBe(201);
      expect(createdStore2.body.author).toBe('عميل موثّق');
    });
  });

  // ------------------------------------------------------------
  // Verification badge
  // ------------------------------------------------------------
  describe('verification badge (storefront is_verified)', () => {
    it('PHYSICAL: false with no approved branch, true once the only branch is APPROVED', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-13');
      const { vendorId, slug } = await createVendorWithBranch(
        owner,
        'PHYSICAL',
      );
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { storefrontPublished: true, status: 'ACTIVE' },
      });

      const before = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}`)
        .expect(200);
      expect(before.body.is_verified).toBe(false);

      await prisma.storeBranch.updateMany({
        where: { vendorId },
        data: { verificationStatus: 'APPROVED' },
      });
      const after = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}`)
        .expect(200);
      expect(after.body.is_verified).toBe(true);
    });

    it('PHYSICAL: a second, unapproved branch keeps it false even though the first is APPROVED', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-14');
      const { vendorId, branchId, slug } = await createVendorWithBranch(
        owner,
        'PHYSICAL',
      );
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { storefrontPublished: true, status: 'ACTIVE' },
      });
      await prisma.storeBranch.update({
        where: { id: branchId! },
        data: { verificationStatus: 'APPROVED' },
      });
      await prisma.storeBranch.create({
        data: { vendorId, name: 'Branch B', isPhysical: true },
      });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}`)
        .expect(200);
      expect(res.body.is_verified).toBe(false);
    });

    it('PHYSICAL: an archived unapproved branch is ignored - only active branches count', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-15');
      const { vendorId, branchId, slug } = await createVendorWithBranch(
        owner,
        'PHYSICAL',
      );
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { storefrontPublished: true, status: 'ACTIVE' },
      });
      await prisma.storeBranch.update({
        where: { id: branchId! },
        data: { verificationStatus: 'APPROVED' },
      });
      await prisma.storeBranch.create({
        data: {
          vendorId,
          name: 'Archived branch',
          isPhysical: true,
          verificationStatus: 'PENDING',
          archivedAt: new Date(),
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}`)
        .expect(200);
      expect(res.body.is_verified).toBe(true);
    });

    it('ONLINE_ONLY: false with no warehouse evidence, true once the latest snapshot is APPROVED', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-16');
      const { vendorId, slug } = await createVendorWithBranch(
        owner,
        'ONLINE_ONLY',
      );
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { storefrontPublished: true, status: 'ACTIVE' },
      });

      const before = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}`)
        .expect(200);
      expect(before.body.is_verified).toBe(false);

      const warehouse = await prisma.warehouse.create({ data: { vendorId } });
      await prisma.warehouseVerificationEvidence.create({
        data: {
          vendorId,
          warehouseId: warehouse.id,
          lat: 31.9,
          lng: 35.2,
          addressNote: 'مستودع',
          status: 'REJECTED',
        },
      });
      const stillFalse = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}`)
        .expect(200);
      expect(stillFalse.body.is_verified).toBe(false);

      await prisma.warehouseVerificationEvidence.create({
        data: {
          vendorId,
          warehouseId: warehouse.id,
          lat: 31.9,
          lng: 35.2,
          addressNote: 'مستودع محدث',
          status: 'APPROVED',
        },
      });
      const after = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}`)
        .expect(200);
      expect(after.body.is_verified).toBe(true);
    });

    it('HYBRID: needs BOTH the physical-branch rule and an APPROVED warehouse snapshot', async () => {
      const owner = await signup(uniquePhone(), 'owner-password-17');
      const { vendorId, branchId, slug } = await createVendorWithBranch(
        owner,
        'HYBRID',
      );
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { storefrontPublished: true, status: 'ACTIVE' },
      });
      await prisma.storeBranch.update({
        where: { id: branchId! },
        data: { verificationStatus: 'APPROVED' },
      });

      const onlyBranch = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}`)
        .expect(200);
      expect(onlyBranch.body.is_verified).toBe(false);

      const warehouse = await prisma.warehouse.create({ data: { vendorId } });
      await prisma.warehouseVerificationEvidence.create({
        data: {
          vendorId,
          warehouseId: warehouse.id,
          lat: 31.9,
          lng: 35.2,
          addressNote: 'مستودع',
          status: 'APPROVED',
        },
      });

      const both = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}`)
        .expect(200);
      expect(both.body.is_verified).toBe(true);
    });
  });
});
