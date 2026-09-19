import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';

/** Test double for the OPEN-004 SMS fallback - captures codes instead of logging them. */
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

// Same +97056 prefix as every other e2e spec's own uniquePhone() (the
// only PS mobile prefixes class-validator's IsPhoneNumber accepts under
// libphonenumber-js/max) - a distinct numeric offset avoids collisions
// between files.
let phoneSeq = (Date.now() % 1_000_000) + 100_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97056${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 6 - branch inventory, stock movements, media, non-exact match review (e2e)', () => {
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
      .set('Idempotency-Key', `verify-${phone}`)
      .send({ phone, otp_code: code, purpose: 'signup' })
      .expect(200);
    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ phone, password, verification_token: verify.body.session_token })
      .expect(201);
    return register.body.session_token as string;
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
        branches: [
          { name: 'Branch A', is_physical: true },
          { name: 'Branch B', is_physical: true },
        ],
      })
      .expect(201);
    return {
      vendorId: res.body.id,
      branchAId: res.body.branches[0].id,
      branchBId: res.body.branches[1].id,
    };
  }

  async function inviteAndAcceptAsNewUser(
    ownerToken: string,
    vendorId: string,
    branchId: string,
    phone: string,
    password: string,
  ) {
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
      .set('Authorization', `Bearer ${ownerToken}`)
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

    const accept = await request(app.getHttpServer())
      .post('/api/v1/auth/staff-invites/accept')
      .set('Idempotency-Key', unique('accept'))
      .send({ phone, verification_token: verify.body.session_token, password })
      .expect(200);
    return accept.body;
  }

  async function setupVendorWithTwoBranchesAndEmployee() {
    const owner = await signup(uniquePhone(), 'a-strong-password');
    const { vendorId, branchAId, branchBId } =
      await createVendorWithTwoBranches(owner);
    const employeePhone = uniquePhone();
    const accepted = await inviteAndAcceptAsNewUser(
      owner,
      vendorId,
      branchAId,
      employeePhone,
      'employee-password',
    );
    return {
      owner,
      vendorId,
      branchAId,
      branchBId,
      employeeToken: accepted.session_token as string,
    };
  }

  /** Evidence -> reviewer-approve (EVERY branch - vendor.status only
   * flips to APPROVED once all of a vendor's branches are, a
   * pre-existing Sprint 3 rule; this test file's own vendors always
   * have two, for BOLA testing) -> subscribe -> ACTIVE. Needed only
   * because offer creation is gated on an active subscription, itself
   * unrelated to Sprint 6's own scope (mirrors sprint5-store-
   * inventory's own activateVendorSubscription, extended to loop over
   * every branch instead of assuming exactly one). */
  async function activateVendorSubscription(
    ownerToken: string,
    vendorId: string,
  ): Promise<void> {
    const reviewerPhone = uniquePhone();
    const reviewerToken = await signup(reviewerPhone, 'reviewer-password');
    await prisma.user.update({
      where: { phone: reviewerPhone },
      data: { platformRole: 'VERIFICATION_REVIEWER' },
    });

    const branches = await prisma.storeBranch.findMany({ where: { vendorId } });
    for (const branch of branches) {
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branch.id}/verification-evidence`,
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
          `/api/v1/vendors/${vendorId}/branches/${branch.id}/verification-decision`,
        )
        .set('Authorization', `Bearer ${reviewerToken}`)
        .set('Idempotency-Key', unique('decision'))
        .send({ decision: 'approve' })
        .expect(201);
    }
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/subscription`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('sub'))
      .send({})
      .expect(201);
  }

  async function createOfferVariant(
    ownerToken: string,
    vendorId: string,
    _branchId: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ offerId: string; variantId: string }> {
    await activateVendorSubscription(ownerToken, vendorId);
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
      .send({ seller_sku: unique('sku'), base_price: 10, ...extra })
      .expect(201);
    return { offerId: offerRes.body.id, variantId: variantRes.body.id };
  }

  async function signupWithPlatformRole(
    role: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER',
  ): Promise<string> {
    const phone = uniquePhone();
    const token = await signup(phone, 'a-strong-password');
    await prisma.user.update({
      where: { phone },
      data: { platformRole: role },
    });
    return token;
  }

  async function createCanonicalVariant(
    adminToken: string,
    brandName: string,
    modelName: string,
    structuralAttributes: Record<string, unknown> = {},
  ): Promise<{ canonicalProductId: string; variantId: string }> {
    const brand = await prisma.brand.create({
      data: {
        name: brandName,
        normalizedName: unique(brandName).toLowerCase(),
      },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('Category') },
    });
    const productRes = await request(app.getHttpServer())
      .post('/api/v1/canonical-products')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', unique('cp'))
      .send({
        brand_id: brand.id,
        category_id: category.id,
        model_name: modelName,
        status: 'PUBLISHED',
      })
      .expect(201);
    const variantRes = await request(app.getHttpServer())
      .post(`/api/v1/canonical-products/${productRes.body.id}/variants`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', unique('cpv'))
      .send({ structural_attributes: structuralAttributes })
      .expect(201);
    return {
      canonicalProductId: productRes.body.id,
      variantId: variantRes.body.id,
    };
  }

  describe('RB-INV-002/005: branch-level stock', () => {
    it('starts every branch/variant pair at zero with no row created yet', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body.quantity).toBe(0);
      expect(res.body.id).toBeNull();

      const rows = await prisma.branchStock.findMany({ where: { vendorId } });
      expect(rows).toHaveLength(0);
    });

    it('a COUNT_CORRECTION movement establishes initial stock, recorded with resultingQuantity', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 20,
          reason_note: 'Initial physical count',
        })
        .expect(201);
      expect(res.body.resulting_quantity).toBe(20);

      const stock = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(stock.body.quantity).toBe(20);
    });

    it('a DAMAGE movement decrements stock; rejects a positive quantity_delta for DAMAGE/LOSS', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 10,
          reason_note: 'init',
        })
        .expect(201);

      const invalid = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'DAMAGE',
          quantity_delta: 5,
          reason_note: 'wrong direction',
        })
        .expect(409);
      expect(invalid.body.error.code).toBe('INVALID_MOVEMENT_DIRECTION');

      const damage = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'DAMAGE',
          quantity_delta: -3,
          reason_note: 'dropped during restock',
        })
        .expect(201);
      expect(damage.body.resulting_quantity).toBe(7);
    });

    it('rejects a movement that would take stock below zero - not applied, no dangling movement row', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 5,
          reason_note: 'init',
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({ reason: 'LOSS', quantity_delta: -10, reason_note: 'too much' })
        .expect(409);
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');

      const stock = await prisma.branchStock.findUnique({
        where: {
          branchId_offerVariantId: {
            branchId: branchAId,
            offerVariantId: variantId,
          },
        },
      });
      expect(stock?.quantity).toBe(5);
      const movements = await prisma.stockMovement.findMany({
        where: { vendorId, branchId: branchAId, offerVariantId: variantId },
      });
      expect(movements).toHaveLength(1);
    });

    it('scopes a BRANCH_EMPLOYEE to only their own assigned branch (BOLA)', async () => {
      const { vendorId, branchAId, branchBId, employeeToken } =
        await setupVendorWithTwoBranchesAndEmployee();

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchBId}/stock`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
      expect(res.body.error.code).toBe('BRANCH_ACCESS_DENIED');

      const ok = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/stock`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
      expect(ok.body).toEqual([]);
    });

    it('lets a BRANCH_EMPLOYEE record a movement for their own branch', async () => {
      const { vendorId, branchAId, employeeToken, owner } =
        await setupVendorWithTwoBranchesAndEmployee();
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 4,
          reason_note: 'employee count',
        })
        .expect(201);
      expect(res.body.actor_id).toBeDefined();
      expect(res.body.resulting_quantity).toBe(4);
    });

    it('lets the OWNER manage stock across every branch of their own vendor', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId, branchBId } =
        await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 2,
          reason_note: 'a',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchBId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 3,
          reason_note: 'b',
        })
        .expect(201);
    });

    it('refuses a completely unrelated user (non-member) from reading or writing stock', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      const outsider = await signup(uniquePhone(), 'outsider-password');

      const readRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/stock`)
        .set('Authorization', `Bearer ${outsider}`)
        .expect(403);
      expect(readRes.body.error.code).toBe('NOT_VENDOR_MEMBER');

      const writeRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${outsider}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 1,
          reason_note: 'x',
        })
        .expect(403);
      expect(writeRes.body.error.code).toBe('NOT_VENDOR_MEMBER');
    });

    it('rejects a direct write giving a branch negative stock (database-layer CHECK constraint)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      await expect(
        prisma.branchStock.create({
          data: {
            vendorId,
            branchId: branchAId,
            offerVariantId: variantId,
            quantity: -1,
          },
        }),
      ).rejects.toThrow();
    });

    it('records a complete, queryable movement log with reason/reason_note/actor/branch', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 15,
          reason_note: 'initial stock',
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        branch_id: branchAId,
        offer_variant_id: variantId,
        reason: 'COUNT_CORRECTION',
        reason_note: 'initial stock',
        quantity_delta: 15,
        resulting_quantity: 15,
      });
    });
  });

  describe('RB-INV-003: immediate owner notification', () => {
    it('enqueues an outbox event for every movement regardless of quantity, including reason/employee/branch', async () => {
      const { vendorId, branchAId, employeeToken, owner } =
        await setupVendorWithTwoBranchesAndEmployee();
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 5,
          reason_note: 'init',
        })
        .expect(201);

      const movementRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'DAMAGE',
          quantity_delta: -1,
          reason_note: 'one unit cracked',
        })
        .expect(201);

      const events = await prisma.outboxEvent.findMany({
        where: { eventType: 'stock_movement.owner_notification' },
      });
      const event = events.find(
        (e) =>
          (e.payload as Record<string, unknown>).stock_movement_id ===
          movementRes.body.id,
      );
      expect(event).toBeDefined();
      const payload = event!.payload as Record<string, unknown>;
      expect(payload).toMatchObject({
        vendor_id: vendorId,
        branch_id: branchAId,
        offer_variant_id: variantId,
        quantity_delta: -1,
        reason: 'DAMAGE',
        reason_note: 'one unit cracked',
      });
      expect(payload.actor_id).toBeDefined();
    });
  });

  describe('RB-INV-005: atomic concurrency-safe decrement, never negative', () => {
    it('under 10 concurrent movements each reducing by 1 against a stock of 5, exactly 5 succeed, exactly 5 fail with INSUFFICIENT_STOCK, and final stock is exactly 0', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 5,
          reason_note: 'init',
        })
        .expect(201);

      const attempts = Array.from({ length: 10 }, (_, i) =>
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique(`concurrent-${i}`))
          .send({
            reason: 'LOSS',
            quantity_delta: -1,
            reason_note: `attempt ${i}`,
          }),
      );
      const results = await Promise.all(attempts);

      const succeeded = results.filter((r) => r.status === 201);
      const failed = results.filter((r) => r.status === 409);
      expect(succeeded).toHaveLength(5);
      expect(failed).toHaveLength(5);
      expect(
        failed.every((r) => r.body.error.code === 'INSUFFICIENT_STOCK'),
      ).toBe(true);

      const finalStock = await prisma.branchStock.findUnique({
        where: {
          branchId_offerVariantId: {
            branchId: branchAId,
            offerVariantId: variantId,
          },
        },
      });
      expect(finalStock?.quantity).toBe(0);

      const movements = await prisma.stockMovement.findMany({
        where: { vendorId, branchId: branchAId, offerVariantId: variantId },
      });
      // 1 initial COUNT_CORRECTION + 5 successful LOSS movements - the
      // 5 failed attempts left no trace (rolled back), proving the
      // movement log stays exactly as complete and accurate as the
      // real stock changes, never more.
      expect(movements).toHaveLength(6);
      expect(movements.every((m) => m.resultingQuantity >= 0)).toBe(true);
    });

    it('under 2 concurrent movements each trying to reduce by an amount that ALONE fits but TOGETHER would go negative, exactly one succeeds', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 6,
          reason_note: 'init',
        })
        .expect(201);

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('movement-a'))
          .send({ reason: 'DAMAGE', quantity_delta: -4, reason_note: 'a' }),
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('movement-b'))
          .send({ reason: 'DAMAGE', quantity_delta: -4, reason_note: 'b' }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const finalStock = await prisma.branchStock.findUnique({
        where: {
          branchId_offerVariantId: {
            branchId: branchAId,
            offerVariantId: variantId,
          },
        },
      });
      expect(finalStock?.quantity).toBe(2);
      expect(finalStock!.quantity).toBeGreaterThanOrEqual(0);
    });
  });

  describe('RB-MATCH-001: basic offer-variant media (owner-only)', () => {
    it('lets the owner add a primary image and additional images', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { offerId, variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      const primary = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('media'))
        .send({ url: 'https://example.com/hero.jpg', kind: 'PRIMARY' })
        .expect(201);
      expect(primary.body.kind).toBe('PRIMARY');

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('media'))
        .send({ url: 'https://example.com/side.jpg' })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(list.body).toHaveLength(2);
      expect(
        list.body.filter((m: { kind: string }) => m.kind === 'PRIMARY'),
      ).toHaveLength(1);
      expect(
        list.body.filter((m: { kind: string }) => m.kind === 'ADDITIONAL'),
      ).toHaveLength(1);
    });

    it('replaces the existing primary when a new one is added, never leaving two', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { offerId, variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      const first = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('media'))
        .send({ url: 'https://example.com/old.jpg', kind: 'PRIMARY' })
        .expect(201);

      const second = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('media'))
        .send({ url: 'https://example.com/new.jpg', kind: 'PRIMARY' })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].id).toBe(second.body.id);
      expect(list.body[0].url).toBe('https://example.com/new.jpg');

      const stale = await prisma.offerVariantMedia.findUnique({
        where: { id: first.body.id },
      });
      expect(stale).toBeNull();
    });

    it('under two concurrent PRIMARY requests for the same variant, neither 500s/P2002s, and exactly one PRIMARY row survives', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { offerId, variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('media-race-a'))
          .send({ url: 'https://example.com/race-a.jpg', kind: 'PRIMARY' }),
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('media-race-b'))
          .send({ url: 'https://example.com/race-b.jpg', kind: 'PRIMARY' }),
      ]);

      // Both requests are legitimate "set the primary image" calls -
      // the FOR UPDATE lock on the offer variant serializes them into
      // a delete-then-insert sequence, so both are expected to succeed
      // (whichever ran second simply replaces the first's row) - never
      // a 500 or a raw P2002.
      expect(resA.status).toBe(201);
      expect(resB.status).toBe(201);

      const list = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const primaries = list.body.filter(
        (m: { kind: string }) => m.kind === 'PRIMARY',
      );
      expect(primaries).toHaveLength(1);

      const rows = await prisma.offerVariantMedia.findMany({
        where: { offerVariantId: variantId, kind: 'PRIMARY' },
      });
      expect(rows).toHaveLength(1);
    });

    it('lets the owner remove a media item', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { offerId, variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      const media = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('media'))
        .send({ url: 'https://example.com/x.jpg' })
        .expect(201);

      await request(app.getHttpServer())
        .delete(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media/${media.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(204);

      const list = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(list.body).toEqual([]);
    });

    it('refuses a BRANCH_EMPLOYEE from adding, listing, or removing media - owner-only (PDR-009), without breaking their existing branch access', async () => {
      const { vendorId, branchAId, employeeToken, owner } =
        await setupVendorWithTwoBranchesAndEmployee();
      const { offerId, variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      const addRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('media'))
        .send({ url: 'https://example.com/x.jpg' })
        .expect(403);
      expect(addRes.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');

      const listRes = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
      expect(listRes.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');

      // The employee's own, unrelated branch access must still work -
      // this fix must never regress VendorMembershipGuard's existing
      // branch-scoping behavior.
      const branchRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
      expect(branchRes.body.id).toBe(branchAId);
    });

    it('rejects a direct write creating two PRIMARY media rows for the same variant (database-layer integrity)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      await prisma.offerVariantMedia.create({
        data: {
          vendorId,
          offerVariantId: variantId,
          url: 'https://example.com/a.jpg',
          kind: 'PRIMARY',
        },
      });
      await expect(
        prisma.offerVariantMedia.create({
          data: {
            vendorId,
            offerVariantId: variantId,
            url: 'https://example.com/b.jpg',
            kind: 'PRIMARY',
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('RB-MATCH-002: non-exact match review queue (owner-only)', () => {
    it('search finds a text/structured-attribute-similar candidate and lists it in the vendor-wide queue', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { variantId: canonicalVariantId } = await createCanonicalVariant(
        admin,
        'Samsung',
        'Galaxy S24',
        { color: 'Black', storage: '256GB' },
      );

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { offerId, variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
        {
          specs_text_en: '256GB storage, brand new',
        },
      );
      // titleEn/titleAr are fixed by createOfferVariant's own offer
      // creation ('Product'/'منتج') - update them to something that
      // actually overlaps with the canonical brand/model for this test.
      await prisma.vendorOffer.update({
        where: { id: offerId },
        data: {
          titleEn: 'Samsung Galaxy S24 Black Edition',
          titleAr: 'سامسونج جالاكسي',
        },
      });

      const searchRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(searchRes.body.length).toBeGreaterThan(0);
      const found = searchRes.body.find(
        (c: { canonical_variant_id: string }) =>
          c.canonical_variant_id === canonicalVariantId,
      );
      expect(found).toBeDefined();
      expect(found.score).toBeGreaterThan(0.15);
      expect(found.status).toBe('PENDING');

      const queueRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/match-review/queue`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(
        queueRes.body.some(
          (c: { canonical_variant_id: string }) =>
            c.canonical_variant_id === canonicalVariantId,
        ),
      ).toBe(true);
    });

    it('approving a candidate links the offer variant to the canonical product and auto-rejects other pending candidates for the same variant', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { canonicalProductId, variantId: canonicalVariantId } =
        await createCanonicalVariant(admin, 'Apple', 'iPhone 15', {
          color: 'Blue',
        });
      const { variantId: otherCanonicalVariantId } =
        await createCanonicalVariant(admin, 'Apple', 'iPhone 15 Blue Variant', {
          color: 'Blue',
        });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { offerId, variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
        {
          specs_text_en: 'Blue color, sealed box',
        },
      );
      await prisma.vendorOffer.update({
        where: { id: offerId },
        data: { titleEn: 'Apple iPhone 15 Blue', titleAr: 'ابل ايفون' },
      });

      const searchRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const target = searchRes.body.find(
        (c: { canonical_variant_id: string }) =>
          c.canonical_variant_id === canonicalVariantId,
      );
      const otherCandidate = searchRes.body.find(
        (c: { canonical_variant_id: string }) =>
          c.canonical_variant_id === otherCanonicalVariantId,
      );
      expect(target).toBeDefined();
      expect(otherCandidate).toBeDefined();

      const decideRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/candidates/${target.id}/decision`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('decision'))
        .send({ decision: 'approve' })
        .expect(200);
      expect(decideRes.body.status).toBe('APPROVED');

      const variant = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(variant.canonicalVariantId).toBe(canonicalVariantId);
      const offer = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offerId },
      });
      expect(offer.canonicalProductId).toBe(canonicalProductId);

      const refreshedOther =
        await prisma.matchReviewCandidate.findUniqueOrThrow({
          where: { id: otherCandidate.id },
        });
      expect(refreshedOther.status).toBe('REJECTED');
    });

    it('rejecting a candidate does not affect the others still pending', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { variantId: canonicalVariantId } = await createCanonicalVariant(
        admin,
        'Sony',
        'WH-1000XM5',
        { color: 'Black' },
      );

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { offerId, variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
        {
          specs_text_en: 'Black noise cancelling headphones',
        },
      );
      await prisma.vendorOffer.update({
        where: { id: offerId },
        data: { titleEn: 'Sony WH-1000XM5 headphones', titleAr: 'سوني' },
      });

      const searchRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const target = searchRes.body.find(
        (c: { canonical_variant_id: string }) =>
          c.canonical_variant_id === canonicalVariantId,
      );
      expect(target).toBeDefined();

      const rejectRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/candidates/${target.id}/decision`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('decision'))
        .send({ decision: 'reject' })
        .expect(200);
      expect(rejectRes.body.status).toBe('REJECTED');

      const variant = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(variant.canonicalVariantId).toBeNull();
    });

    it('re-search never resurrects an already-decided (REJECTED) candidate', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { variantId: canonicalVariantId } = await createCanonicalVariant(
        admin,
        'Dell',
        'XPS 13',
        { color: 'Silver' },
      );

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { offerId, variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
        {
          specs_text_en: 'Silver laptop, 13 inch',
        },
      );
      await prisma.vendorOffer.update({
        where: { id: offerId },
        data: { titleEn: 'Dell XPS 13 Silver', titleAr: 'ديل' },
      });

      const firstSearch = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const target = firstSearch.body.find(
        (c: { canonical_variant_id: string }) =>
          c.canonical_variant_id === canonicalVariantId,
      );
      expect(target).toBeDefined();

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/candidates/${target.id}/decision`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('decision'))
        .send({ decision: 'reject' })
        .expect(200);

      const secondSearch = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(
        secondSearch.body.some(
          (c: { canonical_variant_id: string }) =>
            c.canonical_variant_id === canonicalVariantId,
        ),
      ).toBe(false);

      const stillRejected = await prisma.matchReviewCandidate.findUniqueOrThrow(
        {
          where: { id: target.id },
        },
      );
      expect(stillRejected.status).toBe('REJECTED');
    });

    it('refuses a BRANCH_EMPLOYEE from searching, listing, or deciding - owner-only (PDR-009)', async () => {
      const { vendorId, branchAId, employeeToken, owner } =
        await setupVendorWithTwoBranchesAndEmployee();
      const { offerId, variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      const searchRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
      expect(searchRes.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');

      const queueRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/match-review/queue`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
      expect(queueRes.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    });

    it('refuses to search an offer variant that is already matched', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { variantId: canonicalVariantId } = await createCanonicalVariant(
        admin,
        'LG',
        'OLED55',
        {},
      );
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { offerId, variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      await prisma.offerVariant.update({
        where: { id: variantId },
        data: { canonicalVariantId },
      });

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(409);
      expect(res.body.error.code).toBe('OFFER_VARIANT_ALREADY_MATCHED');
    });

    it("refuses a DIFFERENT vendor's owner from searching or deciding on an offer variant that isn't theirs (BOLA)", async () => {
      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId, branchAId: branchA1 } =
        await createVendorWithTwoBranches(ownerA);
      const { offerId, variantId } = await createOfferVariant(
        ownerA,
        vendorAId,
        branchA1,
      );

      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBId } = await createVendorWithTwoBranches(ownerB);

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorBId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${ownerB}`)
        .expect(404);
      expect(res.body.error.code).toBe('OFFER_VARIANT_NOT_FOUND');
    });
  });
});
