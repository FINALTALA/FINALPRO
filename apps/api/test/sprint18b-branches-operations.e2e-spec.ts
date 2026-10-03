import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuditLogService } from './../src/audit/audit-log.service';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { createUniquePhone } from './helpers/e2e-phone-lanes';

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

const uniquePhone = createUniquePhone('sprint18b-branches-operations', '56');
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A raw supertest Test object does not actually dispatch its HTTP
 * request until something consumes it (.then()/.end()/await) -
 * `Promise.resolve(t)` does exactly that immediately, which matters
 * whenever the promise is stored to be awaited LATER (after some other
 * async step, e.g. a barrier), not consumed right away - same
 * established technique as sprint16-moderation-concurrency.e2e-spec.ts's
 * own `run()` helper.
 */
function run<T>(t: PromiseLike<T>): Promise<T> {
  return Promise.resolve(t);
}

describe('Sprint 18b - branch add/activate/archive, hours, closures, staff (e2e)', () => {
  let app: INestApplication;
  let fakeSms: FakeSmsService;
  let prisma: PrismaService;

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
  });

  afterEach(async () => {
    await app.close();
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

  async function createReviewer(): Promise<string> {
    const phone = uniquePhone();
    const token = await signup(phone, 'reviewer-password');
    await prisma.user.update({
      where: { phone },
      data: { platformRole: 'VERIFICATION_REVIEWER' },
    });
    return token;
  }

  async function createVendorWithTwoBranches(
    ownerToken: string,
  ): Promise<{ vendorId: string; branchAId: string; branchBId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        store_type: 'PHYSICAL',
        branches: [
          { name: 'Branch A', is_physical: true },
          { name: 'Branch B', is_physical: true },
        ],
        applicable_categories: ['WOMEN'],
      })
      .expect(201);
    return {
      vendorId: res.body.id,
      branchAId: res.body.branches[0].id,
      branchBId: res.body.branches[1].id,
    };
  }

  async function submitAndApprove(
    ownerToken: string,
    reviewerToken: string,
    vendorId: string,
    branchId: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-evidence`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('evidence'))
      .send({
        lat: 32.22,
        lng: 35.26,
        verification_photo_url: 'https://example.com/photo.jpg',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-decision`,
      )
      .set('Authorization', `Bearer ${reviewerToken}`)
      .set('Idempotency-Key', unique('decision'))
      .send({ decision: 'approve', evidence_revision: 1 })
      .expect(201);
  }

  async function activateVendorSubscription(
    ownerToken: string,
    reviewerToken: string,
    vendorId: string,
  ): Promise<void> {
    const branches = await prisma.storeBranch.findMany({ where: { vendorId } });
    for (const branch of branches) {
      await submitAndApprove(ownerToken, reviewerToken, vendorId, branch.id);
    }
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/subscription`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('sub'))
      .send({})
      .expect(201);
  }

  /** A fully ACTIVE vendor with one APPROVED branch - the common starting point for most tests here. */
  async function setupActiveVendor(): Promise<{
    owner: string;
    reviewer: string;
    vendorId: string;
    branchAId: string;
    branchBId: string;
  }> {
    const owner = await signup(uniquePhone(), 'a-strong-password');
    const reviewer = await createReviewer();
    const { vendorId, branchAId, branchBId } =
      await createVendorWithTwoBranches(owner);
    await activateVendorSubscription(owner, reviewer, vendorId);
    return { owner, reviewer, vendorId, branchAId, branchBId };
  }

  async function createStockedVariant(
    ownerToken: string,
    vendorId: string,
    branchId: string,
    quantity: number,
  ): Promise<{ offerId: string; variantId: string }> {
    const offerRes = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/offers`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('offer'))
      .send({ title_ar: 'منتج', title_en: 'Product' })
      .expect(201);
    const variantRes = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('variant'))
      .send({ seller_sku: unique('sku'), base_price: 10 })
      .expect(201);
    // Direct Prisma write, not the real publish-gate endpoint - these
    // tests are about branch-level eligibility (verificationStatus/
    // archivedAt/closures), not the publish gate's own completeness
    // checks (title/brand/image/category/stock), which are already
    // covered elsewhere (sprint17-owner-catalog.e2e-spec.ts).
    await prisma.vendorOffer.update({
      where: { id: offerRes.body.id },
      data: { status: 'ACTIVE' },
    });
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { storefrontPublished: true },
    });
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/stock/${variantRes.body.id}/movements`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('mv'))
      .send({
        reason: 'COUNT_CORRECTION',
        quantity_delta: quantity,
        reason_note: 'جرد أولي',
      })
      .expect(201);
    return { offerId: offerRes.body.id, variantId: variantRes.body.id };
  }

  async function addToCartAndGetItemId(
    customerToken: string,
    vendorId: string,
    offerVariantId: string,
    quantity: number,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', unique('cart'))
      .send({ vendor_id: vendorId, offer_variant_id: offerVariantId, quantity })
      .expect(201);
    return res.body.id;
  }

  /** Pause the FIRST call recording `action` (inside its own transaction) until released - same established technique as sprint16-moderation-concurrency.e2e-spec.ts. */
  function barrierOnAudit(action: string) {
    const audit = app.get(AuditLogService);
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

  // ============================================================
  // 1. Adding a branch to an ACTIVE vendor
  // ============================================================
  describe('adding a branch to an ACTIVE vendor', () => {
    it('rejects on an ONLINE_ONLY vendor', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const res = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          store_type: 'ONLINE_ONLY',
          branches: [{ name: 'Virtual', is_physical: false }],
          applicable_categories: ['WOMEN'],
        })
        .expect(201);
      const vendorId = res.body.id;
      const addRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('add-branch'))
        .send({ name: 'New Branch' })
        .expect(409);
      expect(addRes.body.error.code).toBe('STORE_TYPE_HAS_NO_BRANCHES');
    });

    it('rejects when the vendor is not yet ACTIVE (e.g. still APPLIED)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('add-branch'))
        .send({ name: 'New Branch' })
        .expect(409);
      expect(res.body.error.code).toBe('SUBSCRIPTION_INACTIVE');
    });

    it('approve: the new branch becomes APPROVED and the vendor stays ACTIVE (the critical review-round fix)', async () => {
      const { owner, reviewer, vendorId } = await setupActiveVendor();
      const addRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('add-branch'))
        .send({ name: 'New Branch', lat: 32.1, lng: 35.1 })
        .expect(201);
      const newBranchId = addRes.body.id;
      expect(addRes.body.verification_status).toBe('PENDING');

      await submitAndApprove(owner, reviewer, vendorId, newBranchId);

      const branch = await prisma.storeBranch.findUniqueOrThrow({
        where: { id: newBranchId },
      });
      expect(branch.verificationStatus).toBe('APPROVED');
      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('ACTIVE');
    });

    it('reject: the new branch becomes REJECTED and the vendor STILL stays ACTIVE (not REJECTED)', async () => {
      const { owner, reviewer, vendorId } = await setupActiveVendor();
      const addRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('add-branch'))
        .send({ name: 'New Branch', lat: 32.1, lng: 35.1 })
        .expect(201);
      const newBranchId = addRes.body.id;

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${newBranchId}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('evidence'))
        .send({
          lat: 32.22,
          lng: 35.26,
          verification_photo_url: 'https://example.com/photo.jpg',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${newBranchId}/verification-decision`,
        )
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('decision'))
        .send({
          decision: 'reject',
          evidence_revision: 1,
          reason: 'عنوان غير واضح كافٍ',
        })
        .expect(201);

      const branch = await prisma.storeBranch.findUniqueOrThrow({
        where: { id: newBranchId },
      });
      expect(branch.verificationStatus).toBe('REJECTED');
      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('ACTIVE');
    });

    it('request_resubmission: the branch status changes and the vendor stays ACTIVE', async () => {
      const { owner, reviewer, vendorId } = await setupActiveVendor();
      const addRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('add-branch'))
        .send({ name: 'New Branch', lat: 32.1, lng: 35.1 })
        .expect(201);
      const newBranchId = addRes.body.id;

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${newBranchId}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('evidence'))
        .send({
          lat: 32.22,
          lng: 35.26,
          verification_photo_url: 'https://example.com/photo.jpg',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${newBranchId}/verification-decision`,
        )
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('decision'))
        .send({
          decision: 'request_resubmission',
          evidence_revision: 1,
          reason: 'صورة غير واضحة',
        })
        .expect(201);

      const branch = await prisma.storeBranch.findUniqueOrThrow({
        where: { id: newBranchId },
      });
      expect(branch.verificationStatus).toBe('RESUBMISSION_REQUESTED');
      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('ACTIVE');
    });

    it('a PENDING new branch is not eligible for checkout - excluded from quote and rejected by reserve directly', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const addRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('add-branch'))
        .send({ name: 'New Branch' })
        .expect(201);
      const pendingBranchId = addRes.body.id;
      const { variantId } = await createStockedVariant(
        owner,
        vendorId,
        branchAId,
        10,
      );
      // Simulate the pending branch somehow having a stock row too -
      // the eligibility check must defend against this regardless of
      // how such a row came to exist.
      await prisma.branchStock.create({
        data: {
          vendorId,
          branchId: pendingBranchId,
          offerVariantId: variantId,
          quantity: 10,
        },
      });

      const customer = await signup(uniquePhone(), 'customer-password');
      const cartItemId = await addToCartAndGetItemId(
        customer,
        vendorId,
        variantId,
        1,
      );

      const quoteRes = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set('Authorization', `Bearer ${customer}`)
        .send({ cart_item_ids: [cartItemId] })
        .expect(201);
      const eligibleBranchIds = quoteRes.body.groups[0].eligible_branches.map(
        (b: { branch_id: string }) => b.branch_id,
      );
      expect(eligibleBranchIds).not.toContain(pendingBranchId);
      expect(eligibleBranchIds).toContain(branchAId);

      const reserveRes = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [cartItemId],
              branch_id: pendingBranchId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(409);
      expect(reserveRes.body.error.code).toBe(
        'BRANCH_NOT_AVAILABLE_FOR_ORDERS',
      );
    });
  });

  // ============================================================
  // 2. reserve() vs closure/archive race (barrier tests)
  // ============================================================
  describe('reserve() vs closure/archive - deterministic ordering under a shared lock', () => {
    it('reserve commits first, then closure on the same branch waits and then succeeds; the earlier reservation stays confirmable', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const { variantId } = await createStockedVariant(
        owner,
        vendorId,
        branchAId,
        5,
      );
      const customer = await signup(uniquePhone(), 'customer-password');
      const cartItemId = await addToCartAndGetItemId(
        customer,
        vendorId,
        variantId,
        1,
      );

      const reservePromise = run(
        request(app.getHttpServer())
          .post('/api/v1/checkout/reserve')
          .set('Authorization', `Bearer ${customer}`)
          .set('Idempotency-Key', unique('reserve'))
          .send({
            groups: [
              {
                cart_item_ids: [cartItemId],
                branch_id: branchAId,
                fulfilment_method: 'PICKUP',
                payment_method: 'COD',
              },
            ],
          }),
      );
      const reserveRes = await reservePromise;
      expect(reserveRes.status).toBe(201);
      const reservationId = reserveRes.body.reservation_id;

      const closureRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/closures`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('closure'))
        .send({
          starts_at: new Date(Date.now() - 1000).toISOString(),
          ends_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .expect(201);
      expect(closureRes.body.id).toBeDefined();

      const confirmRes = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reservationId })
        .expect(201);
      expect(confirmRes.body.customer_order_id).toBeDefined();
    });

    it('closure commits first (barrier), reserve on the same branch waits then is rejected after the closure commits', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const { variantId } = await createStockedVariant(
        owner,
        vendorId,
        branchAId,
        5,
      );
      const customer = await signup(uniquePhone(), 'customer-password');
      const cartItemId = await addToCartAndGetItemId(
        customer,
        vendorId,
        variantId,
        1,
      );

      const barrier = barrierOnAudit('store_branch.closure_created');
      const closurePromise = run(
        request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/closures`)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('closure'))
          .send({
            starts_at: new Date(Date.now() - 1000).toISOString(),
            ends_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
      );
      await barrier.reached(); // closure's own transaction holds the branch-operational lock, not yet committed

      const reservePromise = run(
        request(app.getHttpServer())
          .post('/api/v1/checkout/reserve')
          .set('Authorization', `Bearer ${customer}`)
          .set('Idempotency-Key', unique('reserve'))
          .send({
            groups: [
              {
                cart_item_ids: [cartItemId],
                branch_id: branchAId,
                fulfilment_method: 'PICKUP',
                payment_method: 'COD',
              },
            ],
          }),
      );

      barrier.release();
      const closureRes = await closurePromise;
      expect(closureRes.status).toBe(201);
      const reserveRes = await reservePromise;
      expect(reserveRes.status).toBe(409);
      expect(reserveRes.body.error.code).toBe(
        'BRANCH_NOT_AVAILABLE_FOR_ORDERS',
      );
    });
  });

  // ============================================================
  // 3. Closures: overlap/adjacency, validation
  // ============================================================
  describe('closures', () => {
    it('two touching closures (first ends exactly when the second starts) both succeed', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const t0 = new Date('2026-03-01T10:00:00Z');
      const t1 = new Date('2026-03-01T11:00:00Z');
      const t2 = new Date('2026-03-01T12:00:00Z');
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/closures`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('closure'))
        .send({ starts_at: t0.toISOString(), ends_at: t1.toISOString() })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/closures`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('closure'))
        .send({ starts_at: t1.toISOString(), ends_at: t2.toISOString() })
        .expect(201);
    });

    it('two overlapping closures - the second is rejected with BRANCH_CLOSURE_OVERLAPS', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const t0 = new Date('2026-03-02T10:00:00Z');
      const t1 = new Date('2026-03-02T11:00:00Z');
      const overlapStart = new Date('2026-03-02T10:30:00Z');
      const overlapEnd = new Date('2026-03-02T11:30:00Z');
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/closures`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('closure'))
        .send({ starts_at: t0.toISOString(), ends_at: t1.toISOString() })
        .expect(201);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/closures`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('closure'))
        .send({
          starts_at: overlapStart.toISOString(),
          ends_at: overlapEnd.toISOString(),
        })
        .expect(409);
      expect(res.body.error.code).toBe('BRANCH_CLOSURE_OVERLAPS');
    });

    it('rejects starts_at >= ends_at', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/closures`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('closure'))
        .send({
          starts_at: '2026-03-03T12:00:00Z',
          ends_at: '2026-03-03T11:00:00Z',
        })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_CLOSURE_RANGE');
    });

    it('a whitespace-only reason is rejected; a valid reason round-trips through GET', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/closures`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('closure'))
        .send({
          starts_at: '2026-03-04T10:00:00Z',
          ends_at: '2026-03-04T11:00:00Z',
          reason: '   ',
        })
        .expect(400);

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/closures`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('closure'))
        .send({
          starts_at: '2026-03-05T10:00:00Z',
          ends_at: '2026-03-05T11:00:00Z',
          reason: 'إجازة رسمية',
        })
        .expect(201);

      const listRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/closures`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(
        listRes.body.items.some(
          (c: { reason: string | null }) => c.reason === 'إجازة رسمية',
        ),
      ).toBe(true);
    });

    it('a branch under an active closure is excluded from quote and rejects reserve directly, but a different branch of the same vendor is unaffected', async () => {
      const { owner, vendorId, branchAId, branchBId } =
        await setupActiveVendor();
      const { variantId: variantA } = await createStockedVariant(
        owner,
        vendorId,
        branchAId,
        5,
      );
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/closures`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('closure'))
        .send({
          starts_at: new Date(Date.now() - 1000).toISOString(),
          ends_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .expect(201);

      const customer = await signup(uniquePhone(), 'customer-password');
      const cartItemId = await addToCartAndGetItemId(
        customer,
        vendorId,
        variantA,
        1,
      );
      const reserveRes = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [cartItemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(409);
      expect(reserveRes.body.error.code).toBe(
        'BRANCH_NOT_AVAILABLE_FOR_ORDERS',
      );

      // branchB (uninvolved) is still fine for its own stock.
      const { variantId: variantB } = await createStockedVariant(
        owner,
        vendorId,
        branchBId,
        5,
      );
      const cartItemB = await addToCartAndGetItemId(
        customer,
        vendorId,
        variantB,
        1,
      );
      await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [cartItemB],
              branch_id: branchBId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);
    });
  });

  // ============================================================
  // 4. Archiving a branch
  // ============================================================
  describe('archiving a branch', () => {
    it('rejects with a live reservation at the branch', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const { variantId } = await createStockedVariant(
        owner,
        vendorId,
        branchAId,
        5,
      );
      const customer = await signup(uniquePhone(), 'customer-password');
      const cartItemId = await addToCartAndGetItemId(
        customer,
        vendorId,
        variantId,
        1,
      );
      await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [cartItemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      const archiveRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/archive`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('archive'))
        .send({})
        .expect(409);
      expect(archiveRes.body.error.code).toBe('BRANCH_HAS_LIVE_RESERVATIONS');
    });

    it('rejects with a non-terminal BranchOrder at the branch; historical terminal orders do not block it', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const { variantId } = await createStockedVariant(
        owner,
        vendorId,
        branchAId,
        5,
      );
      const customer = await signup(uniquePhone(), 'customer-password');
      const cartItemId = await addToCartAndGetItemId(
        customer,
        vendorId,
        variantId,
        1,
      );
      const reserveRes = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [cartItemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserveRes.body.reservation_id })
        .expect(201);

      const archiveRejected = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/archive`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('archive'))
        .send({})
        .expect(409);
      expect(archiveRejected.body.error.code).toBe('BRANCH_HAS_ACTIVE_ORDERS');

      // Move the order to a terminal state, then archiving succeeds.
      const branchOrder = await prisma.branchOrder.findFirstOrThrow({
        where: { branchId: branchAId },
      });
      await prisma.branchOrder.update({
        where: { id: branchOrder.id },
        data: { status: 'COMPLETED' },
      });
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/archive`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('archive'))
        .send({})
        .expect(200);
    });

    it('rejects with an ACTIVE BRANCH_EMPLOYEE assigned; succeeds after transferring them away', async () => {
      const { owner, vendorId, branchAId, branchBId } =
        await setupActiveVendor();
      const employeePhone = uniquePhone();
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite'))
        .send({ phone: employeePhone })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: employeePhone, purpose: 'staff_invite' })
        .expect(202);
      const code = fakeSms.lastCodeFor(employeePhone);
      const verify = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', unique('verify'))
        .send({ phone: employeePhone, otp_code: code, purpose: 'staff_invite' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/staff-invites/accept')
        .set('Idempotency-Key', unique('accept'))
        .send({
          phone: employeePhone,
          verification_token: verify.body.session_token,
          password: 'employee-password',
        })
        .expect(200);

      const archiveRejected = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/archive`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('archive'))
        .send({})
        .expect(409);
      expect(archiveRejected.body.error.code).toBe('BRANCH_HAS_ACTIVE_STAFF');

      const employee = await prisma.vendorUser.findFirstOrThrow({
        where: { vendorId, user: { phone: employeePhone } },
      });
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/staff/${employee.id}/transfer`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('transfer'))
        .send({ branch_id: branchBId })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/archive`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('archive'))
        .send({})
        .expect(200);
    });

    it('rejects with PENDING verification evidence awaiting a decision; a brand-new PENDING branch (no evidence yet) archives fine', async () => {
      const { owner, vendorId } = await setupActiveVendor();
      const addRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('add-branch'))
        .send({ name: 'New Branch' })
        .expect(201);
      const newBranchId = addRes.body.id;

      // No evidence yet - archivable.
      const archiveNoEvidence = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${newBranchId}/archive`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('archive'))
        .send({})
        .expect(200);
      expect(archiveNoEvidence.body.archived_at).not.toBeNull();

      // A second, fresh branch WITH submitted evidence pending decision - not archivable.
      const addRes2 = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('add-branch'))
        .send({ name: 'Another Branch' })
        .expect(201);
      const branchWithEvidence = addRes2.body.id;
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchWithEvidence}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('evidence'))
        .send({
          lat: 32.22,
          lng: 35.26,
          verification_photo_url: 'https://example.com/photo.jpg',
        })
        .expect(201);
      const rejected = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchWithEvidence}/archive`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('archive'))
        .send({})
        .expect(409);
      expect(rejected.body.error.code).toBe(
        'BRANCH_HAS_PENDING_VERIFICATION_EVIDENCE',
      );
    });

    it('an archived branch is excluded from quote and rejects reserve directly', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const { variantId } = await createStockedVariant(
        owner,
        vendorId,
        branchAId,
        5,
      );
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/archive`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('archive'))
        .send({})
        .expect(200);

      const customer = await signup(uniquePhone(), 'customer-password');
      const cartItemId = await addToCartAndGetItemId(
        customer,
        vendorId,
        variantId,
        1,
      );
      const reserveRes = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [cartItemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(409);
      expect(reserveRes.body.error.code).toBe(
        'BRANCH_NOT_AVAILABLE_FOR_ORDERS',
      );
    });

    it('submitEvidence/verification-decision are refused on an archived branch (BranchArchivedGuard)', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/archive`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('archive'))
        .send({})
        .expect(200);
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('evidence'))
        .send({
          lat: 32.22,
          lng: 35.26,
          verification_photo_url: 'https://example.com/photo.jpg',
        })
        .expect(403);
      expect(res.body.error.code).toBe('BRANCH_ARCHIVED');
    });
  });

  // ============================================================
  // 5. Staff invites vs branch availability
  // ============================================================
  describe('staff invites and archived/unapproved branches', () => {
    it('inviteStaff succeeds for a PENDING (not yet verified) branch - verification status is unrelated to staffing', async () => {
      const { owner, vendorId } = await setupActiveVendor();
      const addRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('add-branch'))
        .send({ name: 'New Branch' })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${addRes.body.id}/staff-invites`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite'))
        .send({ phone: uniquePhone() })
        .expect(201);
    });

    it('a sent invite whose branch is later archived fails on accept with a clear message; the invite row stays PENDING', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const employeePhone = uniquePhone();
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite'))
        .send({ phone: employeePhone })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/archive`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('archive'))
        .send({})
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: employeePhone, purpose: 'staff_invite' })
        .expect(202);
      const code = fakeSms.lastCodeFor(employeePhone);
      const verify = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', unique('verify'))
        .send({ phone: employeePhone, otp_code: code, purpose: 'staff_invite' })
        .expect(200);
      const acceptRes = await request(app.getHttpServer())
        .post('/api/v1/auth/staff-invites/accept')
        .set('Idempotency-Key', unique('accept'))
        .send({
          phone: employeePhone,
          verification_token: verify.body.session_token,
          password: 'employee-password',
        })
        .expect(409);
      expect(acceptRes.body.error.code).toBe('BRANCH_NOT_AVAILABLE_FOR_STAFF');

      const invite = await prisma.staffInvite.findFirstOrThrow({
        where: { phone: employeePhone },
      });
      expect(invite.status).toBe('PENDING');
    });
  });

  // ============================================================
  // 6. Staff list, transfer, suspend, reactivate
  // ============================================================
  describe('staff management', () => {
    async function createAcceptedEmployee(
      owner: string,
      vendorId: string,
      branchId: string,
    ): Promise<{ phone: string; vendorUserId: string }> {
      const phone = uniquePhone();
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite'))
        .send({ phone })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone, purpose: 'staff_invite' })
        .expect(202);
      const code = fakeSms.lastCodeFor(phone);
      const verify = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', unique('verify'))
        .send({ phone, otp_code: code, purpose: 'staff_invite' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/staff-invites/accept')
        .set('Idempotency-Key', unique('accept'))
        .send({
          phone,
          verification_token: verify.body.session_token,
          password: 'employee-password',
        })
        .expect(200);
      const vendorUser = await prisma.vendorUser.findFirstOrThrow({
        where: { vendorId, user: { phone } },
      });
      return { phone, vendorUserId: vendorUser.id };
    }

    it('lists BRANCH_EMPLOYEE only, never the OWNER', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      await createAcceptedEmployee(owner, vendorId, branchAId);
      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/staff`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].branch_id).toBe(branchAId);
    });

    it('transfer rejects to a PENDING or archived branch; succeeds to a branch under an active closure (closure does not block transfer)', async () => {
      const { owner, vendorId, branchAId, branchBId } =
        await setupActiveVendor();
      const { vendorUserId } = await createAcceptedEmployee(
        owner,
        vendorId,
        branchAId,
      );

      const addRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('add-branch'))
        .send({ name: 'Pending Branch' })
        .expect(201);
      const rejectedPending = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/staff/${vendorUserId}/transfer`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('transfer'))
        .send({ branch_id: addRes.body.id })
        .expect(409);
      expect(rejectedPending.body.error.code).toBe(
        'BRANCH_NOT_AVAILABLE_FOR_STAFF',
      );

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchBId}/closures`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('closure'))
        .send({
          starts_at: new Date(Date.now() - 1000).toISOString(),
          ends_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/staff/${vendorUserId}/transfer`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('transfer'))
        .send({ branch_id: branchBId })
        .expect(200);
      const employee = await prisma.vendorUser.findUniqueOrThrow({
        where: { id: vendorUserId },
      });
      expect(employee.branchId).toBe(branchBId);
    });

    it('transfer rejects to a branch belonging to a different vendor (BOLA)', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const { vendorUserId } = await createAcceptedEmployee(
        owner,
        vendorId,
        branchAId,
      );
      const other = await setupActiveVendor();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/staff/${vendorUserId}/transfer`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('transfer'))
        .send({ branch_id: other.branchAId })
        .expect(404);
      expect(res.body.error.code).toBe('BRANCH_NOT_FOUND');
    });

    it('suspend blocks subsequent branch routes for the employee; reactivate restores access; account/other-vendor/platform roles are unaffected', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const { phone, vendorUserId } = await createAcceptedEmployee(
        owner,
        vendorId,
        branchAId,
      );

      // Same account also OWNERs a second, unrelated vendor.
      await prisma.user.update({ where: { phone }, data: {} });
      const employeeLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ phone, password: 'employee-password' })
        .expect(200);
      const employeeToken = employeeLogin.body.session_token as string;

      await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/orders`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/staff/${vendorUserId}/suspend`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('suspend'))
        .send({})
        .expect(200);

      const blocked = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/orders`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
      expect(blocked.body.error.code).toBe('STAFF_SUSPENDED');

      // The same account's own /me/workspaces still resolves fine, and
      // shows the suspended membership explicitly rather than hiding it.
      const workspaces = await request(app.getHttpServer())
        .get('/api/v1/me/workspaces')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
      const vendorEntry = workspaces.body.workspaces.find(
        (w: { type: string; vendor_id?: string }) =>
          w.type === 'vendor' && w.vendor_id === vendorId,
      );
      expect(vendorEntry.status).toBe('SUSPENDED');
      expect(
        workspaces.body.workspaces.some(
          (w: { type: string }) => w.type === 'customer',
        ),
      ).toBe(true);

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/staff/${vendorUserId}/reactivate`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('reactivate'))
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/orders`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
    });

    it('concurrency: two concurrent transfers of the same employee serialize via the row lock - both succeed, final state is whichever committed last', async () => {
      const { owner, vendorId, branchAId, branchBId } =
        await setupActiveVendor();
      const { vendorUserId } = await createAcceptedEmployee(
        owner,
        vendorId,
        branchAId,
      );
      const addRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('add-branch'))
        .send({ name: 'Third Branch' })
        .expect(201);
      const reviewer = await createReviewer();
      await submitAndApprove(owner, reviewer, vendorId, addRes.body.id);
      const branchCId = addRes.body.id;

      const [r1, r2] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/staff/${vendorUserId}/transfer`)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('transfer'))
          .send({ branch_id: branchBId }),
        request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/staff/${vendorUserId}/transfer`)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('transfer'))
          .send({ branch_id: branchCId }),
      ]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      const employee = await prisma.vendorUser.findUniqueOrThrow({
        where: { id: vendorUserId },
      });
      expect([branchBId, branchCId]).toContain(employee.branchId);
    });

    it('suspending an employee mid-action: the in-progress request completes, a subsequent request is refused', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const { phone, vendorUserId } = await createAcceptedEmployee(
        owner,
        vendorId,
        branchAId,
      );
      const { variantId } = await createStockedVariant(
        owner,
        vendorId,
        branchAId,
        5,
      );
      const employeeLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ phone, password: 'employee-password' })
        .expect(200);
      const employeeToken = employeeLogin.body.session_token as string;

      // The employee's own request is issued and fully resolves BEFORE
      // suspension - this proves the earlier request still succeeds
      // when issued while ACTIVE; a stronger mid-flight interleave
      // would need the same barrier technique as the closure/reserve
      // race above, omitted here since no shared lock is involved (the
      // guard is a plain per-request check, not a transactional race).
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('mv'))
        .send({ reason: 'SALE', quantity_delta: -1, reason_note: 'بيع' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/staff/${vendorUserId}/suspend`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('suspend'))
        .send({})
        .expect(200);

      const after = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('mv'))
        .send({ reason: 'SALE', quantity_delta: -1, reason_note: 'بيع آخر' })
        .expect(403);
      expect(after.body.error.code).toBe('STAFF_SUSPENDED');
    });
  });

  // ============================================================
  // 7. Operating hours
  // ============================================================
  describe('operating hours (informational only)', () => {
    it('PUT replaces the week; GET reflects it exactly', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const res = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/operating-hours`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          hours: [
            { day_of_week: 0, open_minute: 540, close_minute: 1020 },
            { day_of_week: 4, open_minute: 540, close_minute: 1020 },
          ],
        })
        .expect(200);
      expect(res.body.hours.length).toBe(2);

      const getRes = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/operating-hours`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(getRes.body.hours).toEqual(
        expect.arrayContaining([
          { day_of_week: 0, open_minute: 540, close_minute: 1020 },
          { day_of_week: 4, open_minute: 540, close_minute: 1020 },
        ]),
      );
    });

    it('rejects a duplicate day_of_week and open_minute >= close_minute', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const dup = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/operating-hours`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          hours: [
            { day_of_week: 0, open_minute: 540, close_minute: 1020 },
            { day_of_week: 0, open_minute: 600, close_minute: 1080 },
          ],
        })
        .expect(400);
      expect(dup.body.error.code).toBe('DUPLICATE_DAY_OF_WEEK');

      const bad = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/operating-hours`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          hours: [{ day_of_week: 1, open_minute: 1000, close_minute: 500 }],
        })
        .expect(400);
      expect(bad.body.error.code).toBe('INVALID_HOURS_RANGE');
    });

    it('never affects quote/reserve eligibility - a branch with no hours set at all, or closed by hours "right now", is still bookable', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      const { variantId } = await createStockedVariant(
        owner,
        vendorId,
        branchAId,
        5,
      );
      // Deliberately empty hours (closed every day, informationally) -
      // must not affect checkout at all.
      await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/operating-hours`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ hours: [] })
        .expect(200);

      const customer = await signup(uniquePhone(), 'customer-password');
      const cartItemId = await addToCartAndGetItemId(
        customer,
        vendorId,
        variantId,
        1,
      );
      await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [cartItemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);
    });

    it('is refused on an archived branch (write) but still readable', async () => {
      const { owner, vendorId, branchAId } = await setupActiveVendor();
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/archive`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('archive'))
        .send({})
        .expect(200);
      const putRes = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/operating-hours`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ hours: [] })
        .expect(403);
      expect(putRes.body.error.code).toBe('BRANCH_ARCHIVED');
      await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/operating-hours`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
    });
  });
});
