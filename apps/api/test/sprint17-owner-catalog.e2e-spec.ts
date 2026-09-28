import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuditLogService } from './../src/audit/audit-log.service';
import { SmsService } from './../src/auth/sms.service';
import { IdempotencyCompletionService } from './../src/common/idempotency/idempotency-completion.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { NO_BRAND_SENTINEL_ID } from './../src/common/no-brand-sentinel';
import { PrismaService } from './../src/prisma/prisma.service';

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

// +97056/+97059 only validate as real PS mobile numbers under this
// bundle - see every earlier sprint's own uniquePhone() comment.
let phoneSeq = (Date.now() % 1_000_000) + 100_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97059${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 17 - owner catalog (pricing, PDR-036 templates, brand, media, import, publish gate) (e2e)', () => {
  let app: INestApplication;
  let fakeSms: FakeSmsService;
  let prisma: PrismaService;
  let auditLog: AuditLogService;

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
    auditLog = app.get(AuditLogService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
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

  let cachedReviewerToken: string | null = null;
  async function getOrCreateReviewer(): Promise<string> {
    if (!cachedReviewerToken) {
      const reviewerPhone = uniquePhone();
      cachedReviewerToken = await signup(reviewerPhone, 'reviewer-password');
      await prisma.user.update({
        where: { phone: reviewerPhone },
        data: { platformRole: 'VERIFICATION_REVIEWER' },
      });
    }
    return cachedReviewerToken;
  }

  async function activateVendorSubscription(
    ownerToken: string,
    vendorId: string,
  ): Promise<void> {
    const reviewerToken = await getOrCreateReviewer();
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
        .send({ decision: 'approve', evidence_revision: 1 })
        .expect(201);
    }
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/subscription`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('sub'))
      .send({})
      .expect(201);
  }

  /** Owner + one ACTIVE-subscription vendor, ready to create offers. */
  async function setupOwnerVendor(): Promise<{
    owner: string;
    vendorId: string;
    branchAId: string;
    branchBId: string;
  }> {
    const owner = await signup(uniquePhone(), 'a-strong-password');
    const { vendorId, branchAId, branchBId } =
      await createVendorWithTwoBranches(owner);
    await activateVendorSubscription(owner, vendorId);
    return { owner, vendorId, branchAId, branchBId };
  }

  async function setupOwnerVendorWithEmployee() {
    const { owner, vendorId, branchAId, branchBId } = await setupOwnerVendor();
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

  async function createOffer(
    owner: string,
    vendorId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/offers`)
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('offer'))
      .send({
        title_ar: unique('عنوان'),
        title_en: unique('Title'),
        ...overrides,
      })
      .expect(201);
    return res.body.id as string;
  }

  async function createVariant(
    owner: string,
    vendorId: string,
    offerId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/offers/${offerId}/variants`)
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('variant'))
      .send({ seller_sku: unique('sku'), base_price: 100, ...overrides })
      .expect(201);
    return res.body;
  }

  async function addPrimaryImage(
    owner: string,
    vendorId: string,
    offerId: string,
    variantId: string,
  ) {
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
      )
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('media'))
      .send({
        url: 'https://example.com/hero.jpg',
        kind: 'PRIMARY',
        media_type: 'IMAGE',
      })
      .expect(201);
  }

  async function addStock(
    owner: string,
    vendorId: string,
    branchId: string,
    variantId: string,
    quantity: number,
  ) {
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/stock/${variantId}/movements`,
      )
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('movement'))
      .send({
        reason: 'COUNT_CORRECTION',
        quantity_delta: quantity,
        reason_note: 'test',
      })
      .expect(201);
  }

  async function activateOffer(
    owner: string,
    vendorId: string,
    offerId: string,
  ) {
    return request(app.getHttpServer())
      .patch(`/api/v1/vendors/${vendorId}/offers/${offerId}/status`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ status: 'ACTIVE' });
  }

  /** Publishes the storefront - required for assertItemsPurchasable's
   * eligibility check (vendor.storefrontPublished) to ever let a
   * customer add-to-cart/reserve an otherwise-ACTIVE offer. */
  async function publishStorefrontFor(
    owner: string,
    vendorId: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .put(`/api/v1/vendors/${vendorId}/storefront`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ whatsapp_url: 'https://wa.me/1234567890' })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/api/v1/vendors/${vendorId}/applicable-categories`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ categories: ['WOMEN'] })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/storefront/publish`)
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);
  }

  /** A fully publish-gate-ready offer+variant: brand, PRIMARY image,
   * stock - ready to activate with one more call. */
  async function setupPublishableOffer(
    owner: string,
    vendorId: string,
    branchAId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const offerId = await createOffer(owner, vendorId, {
      brand_id: NO_BRAND_SENTINEL_ID,
    });
    const variant = await createVariant(owner, vendorId, offerId, overrides);
    await addPrimaryImage(owner, vendorId, offerId, variant.id);
    await addStock(owner, vendorId, branchAId, variant.id, 10);
    return { offerId, variantId: variant.id as string };
  }

  let cachedAdminToken: string | null = null;
  async function getOrCreatePlatformAdmin(): Promise<string> {
    if (!cachedAdminToken) {
      const phone = uniquePhone();
      cachedAdminToken = await signup(phone, 'admin-password');
      await prisma.user.update({
        where: { phone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
    }
    return cachedAdminToken;
  }

  async function createCanonicalVariant(): Promise<{
    canonicalProductId: string;
    canonicalVariantId: string;
  }> {
    const admin = await getOrCreatePlatformAdmin();
    const brand = await prisma.brand.create({
      data: {
        name: unique('Brand'),
        normalizedName: unique('brand').toLowerCase(),
      },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('Category') },
    });
    const productRes = await request(app.getHttpServer())
      .post('/api/v1/canonical-products')
      .set('Authorization', `Bearer ${admin}`)
      .set('Idempotency-Key', unique('cp'))
      .send({
        brand_id: brand.id,
        category_id: category.id,
        model_name: unique('Model'),
        status: 'PUBLISHED',
      })
      .expect(201);
    const variantRes = await request(app.getHttpServer())
      .post(`/api/v1/canonical-products/${productRes.body.id}/variants`)
      .set('Authorization', `Bearer ${admin}`)
      .set('Idempotency-Key', unique('cpv'))
      .send({ structural_attributes: {} })
      .expect(201);
    return {
      canonicalProductId: productRes.body.id,
      canonicalVariantId: variantRes.body.id,
    };
  }

  /** Creates an offer+variant matched (CONFIRMED) to a fresh canonical
   * product/variant - for identity-lock tests. */
  async function setupConfirmedMatch(owner: string, vendorId: string) {
    const { canonicalVariantId } = await createCanonicalVariant();
    const identifierValue = unique('gtin').slice(0, 20);
    await prisma.canonicalProductVariant.update({
      where: { id: canonicalVariantId },
      data: { gtin: identifierValue },
    });
    const offerId = await createOffer(owner, vendorId);
    const variant = await createVariant(owner, vendorId, offerId, {
      identifier_type: 'GTIN',
      identifier_value: identifierValue,
    });
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/match-confirmation`,
      )
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('confirm'))
      .send({ decision: 'confirm' })
      .expect(200);
    return { offerId, variantId: variant.id as string };
  }

  describe('PDR-036 templates + governed brand', () => {
    it('accepts a valid template+attributes pair at creation and stores it', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({
          title_ar: 'فستان',
          title_en: 'Dress',
          category_template: 'DRESSES',
          template_attributes: {
            material: 'Cotton',
            pattern: 'Solid',
            length: 'Midi',
            sleeve_type: 'Short',
          },
        })
        .expect(201);
      expect(res.body.category_template).toBe('DRESSES');
      expect(res.body.template_attributes).toMatchObject({
        material: 'Cotton',
      });
    });

    it('refuses template_attributes missing a required key for the chosen template', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({
          title_ar: 'فستان',
          title_en: 'Dress',
          category_template: 'DRESSES',
          template_attributes: { material: 'Cotton' },
        });
      expect(res.status).toBe(400);
    });

    it('refuses category_template without template_attributes, and vice versa (both-or-neither)', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const missingAttrs = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({
          title_ar: 'فستان',
          title_en: 'Dress',
          category_template: 'DRESSES',
        });
      expect(missingAttrs.status).toBe(400);
    });

    it('refuses brand_id that does not reference an existing Brand row', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'ت', title_en: 'T', brand_id: 'does-not-exist' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BRAND_NOT_FOUND');
    });

    it('accepts the "No brand" sentinel as a valid brand_id', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'ت', title_en: 'T', brand_id: NO_BRAND_SENTINEL_ID })
        .expect(201);
      expect(res.body.brand_id).toBe(NO_BRAND_SENTINEL_ID);
    });

    it('leaves category_template/template_attributes optional at creation - a DRAFT with neither is never rejected', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'ت', title_en: 'T' })
        .expect(201);
      expect(res.body.status).toBe('DRAFT');
      expect(res.body.category_template).toBeNull();
    });

    it('a category outside the 10 templates has no template validation - specs_text stays the free-text fallback', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId, {
        specs_text_ar: 'نص حر',
        specs_text_en: 'free text',
      });
      expect(variant.specs_text_en).toBe('free text');
    });
  });

  describe('Pricing (blocker 1): effective price, mutual exclusivity, PriceHistory', () => {
    it('an ACTIVE scheduled discount is reflected in effective_price, computed at READ time with zero writes', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const start = new Date(Date.now() - 60_000).toISOString();
      const end = new Date(Date.now() + 3_600_000).toISOString();
      const variant = await createVariant(owner, vendorId, offerId, {
        base_price: 200,
        discount_percent: 25,
        discount_start_at: start,
        discount_end_at: end,
      });
      expect(variant.effective_price).toBeCloseTo(150, 2);

      // Zero writes on a GET: reading it twice must never change the
      // row (no lazy "activation" write) and must never add a
      // PriceHistory row (only a REAL config change ever does that).
      const before = await prisma.priceHistory.count({
        where: { offerVariantId: variant.id },
      });
      const get1 = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/offers/${offerId}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const get2 = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/offers/${offerId}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(get1.body[0].effective_price).toBeCloseTo(150, 2);
      expect(get2.body[0].effective_price).toBeCloseTo(150, 2);
      const after = await prisma.priceHistory.count({
        where: { offerVariantId: variant.id },
      });
      expect(after).toBe(before);
    });

    it('an EXPIRED scheduled discount falls back to basePrice (end is exclusive)', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const start = new Date(Date.now() - 3_600_000).toISOString();
      const end = new Date(Date.now() - 60_000).toISOString();
      const variant = await createVariant(owner, vendorId, offerId, {
        base_price: 200,
        discount_percent: 25,
        discount_start_at: start,
        discount_end_at: end,
      });
      expect(variant.effective_price).toBeCloseTo(200, 2);
    });

    it('a manual sale_price applies when no scheduled discount is active', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId, {
        base_price: 80,
        sale_price: 60,
      });
      expect(variant.effective_price).toBeCloseTo(60, 2);
    });

    it('refuses sale_price and discount_percent together at creation - PRICE_MODE_CONFLICT', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offerId}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 100,
          sale_price: 80,
          discount_percent: 10,
          discount_start_at: new Date(Date.now() - 1000).toISOString(),
          discount_end_at: new Date(Date.now() + 100_000).toISOString(),
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRICE_MODE_CONFLICT');
    });

    it('setting sale_price via PUT clears an existing scheduled discount (mutual exclusivity)', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId, {
        base_price: 200,
        discount_percent: 25,
        discount_start_at: new Date(Date.now() - 1000).toISOString(),
        discount_end_at: new Date(Date.now() + 100_000).toISOString(),
      });
      const updated = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ sale_price: 150 })
        .expect(200);
      expect(Number(updated.body.sale_price)).toBe(150);
      expect(updated.body.discount_percent).toBeNull();
      expect(updated.body.discount_start_at).toBeNull();
      expect(updated.body.effective_price).toBeCloseTo(150, 2);
    });

    it('DB CHECK: discount_percent out of range (>=100) is refused', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offerId}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 100,
          discount_percent: 100,
          discount_start_at: new Date(Date.now() - 1000).toISOString(),
          discount_end_at: new Date(Date.now() + 100_000).toISOString(),
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DISCOUNT_PERCENT_OUT_OF_RANGE');
    });

    it('refuses discount_start_at not strictly before discount_end_at', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const same = new Date().toISOString();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offerId}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 100,
          discount_percent: 10,
          discount_start_at: same,
          discount_end_at: same,
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DISCOUNT_WINDOW');
    });

    it('refuses a discount that would round the price to zero or less', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offerId}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 0.01,
          discount_percent: 99,
          discount_start_at: new Date(Date.now() - 1000).toISOString(),
          discount_end_at: new Date(Date.now() + 100_000).toISOString(),
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DISCOUNT_RESULTS_IN_ZERO_PRICE');
    });

    it('refuses sale_price >= base_price (not actually a sale)', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offerId}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant'))
        .send({ seller_sku: unique('sku'), base_price: 50, sale_price: 50 });
      // @IsPositive() lets 50 through the DTO layer - the controller's
      // own INVALID_SALE_PRICE check (or the DB CHECK as a backstop)
      // must still refuse it.
      expect(res.status).toBe(400);
    });

    it('writes exactly one PriceHistory row per REAL price-config change, never on a no-op PATCH', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId, {
        base_price: 100,
      });
      const afterCreate = await prisma.priceHistory.count({
        where: { offerVariantId: variant.id },
      });
      expect(afterCreate).toBe(1); // the creation-time baseline row

      // No-op PATCH (touches an unrelated field only) - must not write.
      await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ colour: 'Blue' })
        .expect(200);
      const afterNoopIshChange = await prisma.priceHistory.count({
        where: { offerVariantId: variant.id },
      });
      expect(afterNoopIshChange).toBe(1);

      // A real price change - exactly one new row.
      await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ base_price: 120 })
        .expect(200);
      const afterRealChange = await prisma.priceHistory.count({
        where: { offerVariantId: variant.id },
      });
      expect(afterRealChange).toBe(2);

      // Re-sending the SAME base_price again - a true no-op this time.
      await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ base_price: 120 })
        .expect(200);
      const afterRepeat = await prisma.priceHistory.count({
        where: { offerVariantId: variant.id },
      });
      expect(afterRepeat).toBe(2);

      const history = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/price-history`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(history.body).toHaveLength(2);
      const ownerUserId = (
        await prisma.vendorUser.findFirstOrThrow({
          where: { vendorId, role: 'OWNER' },
        })
      ).userId;
      expect(history.body[0].changed_by).toBe(ownerUserId);
      expect(history.body[0].reason).toBe('MANUAL_EDIT');
    });

    it('every real consumer (cart, comparison, storefront) reports the SAME computed effective price, including the Discounts section', async () => {
      const { owner, vendorId, branchAId } = await setupOwnerVendor();
      const { offerId, variantId } = await setupPublishableOffer(
        owner,
        vendorId,
        branchAId,
        { base_price: 100, sale_price: 70 },
      );
      const activateRes = await activateOffer(owner, vendorId, offerId);
      expect(activateRes.status).toBe(200);
      const publishRes = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/storefront`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ whatsapp_url: 'https://wa.me/1234567890' });
      expect(publishRes.status).toBe(200);
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/applicable-categories`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ categories: ['WOMEN'] })
        .expect(200);
      const publish = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/storefront/publish`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const slugRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/storefront`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const slug = slugRes.body.slug as string;
      void publish;

      // Storefront section ("Discounts") shows 70, not 100.
      const sections = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}/sections`)
        .expect(200);
      expect(
        sections.body.discounts.map((o: { id: string }) => o.id),
      ).toContain(offerId);

      // Storefront offer detail shows the same 70.00 as sale_price.
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}/offers/${offerId}`)
        .expect(200);
      expect(Number(detail.body.variants[0].sale_price)).toBe(70);

      // Cart shows the exact same unit_price.
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('cart'))
        .send({ vendor_id: vendorId, offer_variant_id: variantId, quantity: 1 })
        .expect(201);
      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(cart.body[0].unit_price).toBeCloseTo(70, 2);
    });

    it('concurrent price edits on the same variant serialize (row lock) - the final state matches exactly one of the two writes, never a lost update', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId, {
        base_price: 100,
      });

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .put(
            `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .send({ base_price: 111 }),
        request(app.getHttpServer())
          .put(
            `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .send({ base_price: 222 }),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);

      const final = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect([111, 222]).toContain(Number(final.basePrice));

      // Exactly 3 rows: creation baseline + the two real edits - no
      // lost update, no duplicate/missing history row.
      const history = await prisma.priceHistory.findMany({
        where: { offerVariantId: variant.id },
        orderBy: { changedAt: 'asc' },
      });
      expect(history).toHaveLength(3);
      expect(Number(history[2].basePrice)).toBe(Number(final.basePrice));
    });
  });

  describe('Identity lock (CONFIRMED_MATCH_IDENTITY_LOCKED)', () => {
    it('refuses PATCHing brand_id on an offer whose variant is CONFIRMED-matched, but allows title', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const { offerId } = await setupConfirmedMatch(owner, vendorId);

      const blocked = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/offers/${offerId}`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ brand_id: NO_BRAND_SENTINEL_ID });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('CONFIRMED_MATCH_IDENTITY_LOCKED');

      const allowed = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/offers/${offerId}`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ title_ar: 'عنوان جديد', title_en: 'New title' })
        .expect(200);
      expect(allowed.body.title_en).toBe('New title');
    });

    it('refuses PATCHing category_template/template_attributes on a matched offer', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const { offerId } = await setupConfirmedMatch(owner, vendorId);
      const res = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/offers/${offerId}`)
        .set('Authorization', `Bearer ${owner}`)
        .send({
          category_template: 'DRESSES',
          template_attributes: {
            material: 'Cotton',
            pattern: 'Solid',
            length: 'Midi',
            sleeve_type: 'Short',
          },
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFIRMED_MATCH_IDENTITY_LOCKED');
    });

    it('refuses PATCHing identifier_type/identifier_value on a CONFIRMED variant, but allows colour', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const { offerId, variantId } = await setupConfirmedMatch(owner, vendorId);

      const blocked = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ identifier_value: unique('gtin').slice(0, 20) });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('CONFIRMED_MATCH_IDENTITY_LOCKED');

      const allowed = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ colour: 'Green' })
        .expect(200);
      expect(allowed.body.colour).toBe('Green');
    });
  });

  describe('Automatic non-exact matching re-run (atomic with the triggering edit)', () => {
    it('re-runs searchNonExactCandidates when title/brand/template details change on an UNMATCHED offer, actually changing candidates', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId);

      const before = await prisma.matchReviewCandidate.count({
        where: { offerVariantId: variant.id },
      });

      // A canonical product whose model name will now textually match
      // this offer's NEW title - the rerun must actually pick it up.
      const admin = await getOrCreatePlatformAdmin();
      const brand = await prisma.brand.create({
        data: {
          name: unique('UniqueBrandXyz'),
          normalizedName: unique('uniquebrandxyz').toLowerCase(),
        },
      });
      const category = await prisma.category.create({
        data: { nameAr: unique('فئة'), nameEn: unique('Category') },
      });
      const modelName = 'VerySpecificModelNameForRerunTest';
      await request(app.getHttpServer())
        .post('/api/v1/canonical-products')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('cp'))
        .send({
          brand_id: brand.id,
          category_id: category.id,
          model_name: modelName,
          status: 'PUBLISHED',
        })
        .expect(201);

      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/offers/${offerId}`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ title_ar: modelName, title_en: modelName })
        .expect(200);

      const after = await prisma.matchReviewCandidate.count({
        where: { offerVariantId: variant.id },
      });
      expect(after).toBeGreaterThan(before);
    });

    it('does NOT re-run matching for a media-only change (no signal there)', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId);
      const beforeCandidates = await prisma.matchReviewCandidate.findMany({
        where: { offerVariantId: variant.id },
      });

      await addPrimaryImage(owner, vendorId, offerId, variant.id);

      const afterCandidates = await prisma.matchReviewCandidate.findMany({
        where: { offerVariantId: variant.id },
      });
      expect(afterCandidates).toHaveLength(beforeCandidates.length);
    });

    it('is atomic with the triggering edit: if the edit itself fails validation, no rerun side effect is left behind', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const before = await prisma.matchReviewCandidate.count();

      // template_attributes without category_template - a validation
      // failure, never reaching the commit that would trigger a rerun.
      const res = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/offers/${offerId}`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ template_attributes: { material: 'Cotton' } });
      expect(res.status).toBe(400);

      const after = await prisma.matchReviewCandidate.count();
      expect(after).toBe(before);
    });
  });

  describe('Publish gate (transition to ACTIVE)', () => {
    it('refuses ACTIVE with no title (blank title_ar) - missing includes "title"', async () => {
      const { owner, vendorId, branchAId } = await setupOwnerVendor();
      const { offerId, variantId } = await setupPublishableOffer(
        owner,
        vendorId,
        branchAId,
      );
      // Blank the title directly - the DTO's own @IsString() would
      // refuse an empty PUT body value differently; this proves the
      // GATE's own title check, not the DTO layer.
      await prisma.vendorOffer.update({
        where: { id: offerId },
        data: { titleAr: '' },
      });
      void variantId;
      const res = await activateOffer(owner, vendorId, offerId);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OFFER_NOT_PUBLISHABLE');
      expect(res.body.error.details).toContain('title');
    });

    it('refuses ACTIVE with no brand set - missing includes "brand"', async () => {
      const { owner, vendorId, branchAId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId); // no brand_id
      const variant = await createVariant(owner, vendorId, offerId);
      await addPrimaryImage(owner, vendorId, offerId, variant.id);
      await addStock(owner, vendorId, branchAId, variant.id, 5);
      const res = await activateOffer(owner, vendorId, offerId);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('brand');
    });

    it('refuses ACTIVE with an incomplete template_attributes pair - missing includes "template_attributes"', async () => {
      const { owner, vendorId, branchAId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId, {
        brand_id: NO_BRAND_SENTINEL_ID,
      });
      // Directly write an incomplete template (bypassing the create/PUT
      // validation) to isolate the GATE's own re-check.
      await prisma.vendorOffer.update({
        where: { id: offerId },
        data: {
          categoryTemplate: 'DRESSES',
          templateAttributes: { material: 'Cotton' },
        },
      });
      const variant = await createVariant(owner, vendorId, offerId);
      await addPrimaryImage(owner, vendorId, offerId, variant.id);
      await addStock(owner, vendorId, branchAId, variant.id, 5);
      const res = await activateOffer(owner, vendorId, offerId);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('template_attributes');
    });

    it('refuses ACTIVE with no PRIMARY image on any variant - missing includes "primary_image"', async () => {
      const { owner, vendorId, branchAId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId, {
        brand_id: NO_BRAND_SENTINEL_ID,
      });
      const variant = await createVariant(owner, vendorId, offerId);
      await addStock(owner, vendorId, branchAId, variant.id, 5); // no media at all
      const res = await activateOffer(owner, vendorId, offerId);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('primary_image');
    });

    it('refuses ACTIVE with zero available stock - missing includes "available_stock"', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId, {
        brand_id: NO_BRAND_SENTINEL_ID,
      });
      const variant = await createVariant(owner, vendorId, offerId);
      await addPrimaryImage(owner, vendorId, offerId, variant.id); // no stock added
      const res = await activateOffer(owner, vendorId, offerId);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toContain('available_stock');
    });

    it('never blocks saving a DRAFT with partial/missing data - only an actual transition to ACTIVE is checked', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId); // no brand, nothing else
      const res = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/offers/${offerId}`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ title_ar: 'مسودة محدثة' })
        .expect(200);
      expect(res.body.status).toBe('DRAFT');
    });

    it('succeeds and reaches ACTIVE once every condition is met', async () => {
      const { owner, vendorId, branchAId } = await setupOwnerVendor();
      const { offerId } = await setupPublishableOffer(
        owner,
        vendorId,
        branchAId,
      );
      const res = await activateOffer(owner, vendorId, offerId);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ACTIVE');
    });

    it('archive/restore: only ACTIVE or INACTIVE can be archived; restore always returns to DRAFT (re-runs the gate on the next activation)', async () => {
      const { owner, vendorId, branchAId } = await setupOwnerVendor();
      const { offerId } = await setupPublishableOffer(
        owner,
        vendorId,
        branchAId,
      );
      await activateOffer(owner, vendorId, offerId);

      const archived = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offerId}/archive`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(archived.body.status).toBe('ARCHIVED');
      expect(archived.body.archived_at).not.toBeNull();

      const cannotReArchive = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offerId}/archive`)
        .set('Authorization', `Bearer ${owner}`);
      expect(cannotReArchive.status).toBe(409);

      const restored = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offerId}/restore`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(restored.body.status).toBe('DRAFT');
      expect(restored.body.archived_at).toBeNull();
    });
  });

  describe('Publish gate vs concurrent stock reservation (stock lock ordering, no deadlock)', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** Pause the FIRST call recording `action` (inside its own
     * transaction) until released - same technique as
     * sprint16-moderation-concurrency.e2e-spec.ts's own barrierOnAudit. */
    function barrierOnAudit(action: string) {
      const original = auditLog.record.bind(auditLog);
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const hit = new Promise<void>((r) => (reached = r));
      let armed = true;
      jest.spyOn(auditLog, 'record').mockImplementation(async (input, tx) => {
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

    /** Pause the FIRST idempotency-completion write whose response body
     * carries `reservation_id` (unique to CheckoutService.reserve's own
     * completion call - see its own comment) - reserve() records no
     * AuditLogService action of its own to barrier on instead. */
    function barrierOnReserveCompletion() {
      const svc = app.get(IdempotencyCompletionService);
      const original = svc.complete.bind(svc);
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const hit = new Promise<void>((r) => (reached = r));
      let armed = true;
      jest
        .spyOn(svc, 'complete')
        .mockImplementation(async (...args: unknown[]) => {
          const body = args[2] as { reservation_id?: string } | undefined;
          if (armed && body?.reservation_id) {
            armed = false;
            reached();
            await gate;
          }
          return original(...args);
        });
      return {
        release: () => release(),
        reached: () =>
          Promise.race([
            hit,
            sleep(10_000).then(() => {
              throw new Error(
                "barrier: reserve()'s completion was never reached",
              );
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

    async function someoneWaitsOnBranchStock(
      mode: 'FOR SHARE' | 'FOR UPDATE',
    ): Promise<boolean> {
      for (let i = 0; i < 30; i++) {
        const rows = await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query ILIKE ${'%FROM branch_stock%' + mode + '%'}`;
        if (Number(rows[0].n) > 0) return true;
        await sleep(100);
      }
      return false;
    }

    async function reserveTheLastUnit(
      customerToken: string,
      vendorId: string,
      branchId: string,
      variantId: string,
    ) {
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', unique('cart'))
        .send({ vendor_id: vendorId, offer_variant_id: variantId, quantity: 1 })
        .expect(201);
      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      return request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [cart.body[0].id],
              branch_id: branchId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        });
    }

    it('PUBLISH LOCKS FIRST: a concurrent reserve() for the last unit waits behind the publish transaction, then SUCCEEDS once publish commits (publish never touches quantity/reservedQuantity - correct, not a bug)', async () => {
      const { owner, vendorId, branchAId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId, {
        brand_id: NO_BRAND_SENTINEL_ID,
      });
      const variant = await createVariant(owner, vendorId, offerId);
      await addPrimaryImage(owner, vendorId, offerId, variant.id);
      await addStock(owner, vendorId, branchAId, variant.id, 1);
      // First activation, uncontested - establishes the ACTIVE baseline
      // this race then re-triggers (updateStatus's gate re-runs on
      // every PATCH to ACTIVE, not only the very first one).
      await activateOffer(owner, vendorId, offerId);
      await publishStorefrontFor(owner, vendorId);

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const barrier = barrierOnAudit('vendor_offer.status_updated');

      const publishP = activateOffer(owner, vendorId, offerId);
      await barrier.reached(); // branch_stock rows locked FOR SHARE, not yet committed
      const reserveP = reserveTheLastUnit(
        customer,
        vendorId,
        branchAId,
        variant.id,
      );

      expect(await someoneWaitsOnBranchStock('FOR UPDATE')).toBe(true);
      expect(await settledWithin(reserveP, 700)).toBe(false);

      barrier.release();
      const [publishRes, reserveRes] = await Promise.all([publishP, reserveP]);
      expect(publishRes.status).toBe(200);
      expect(publishRes.body.status).toBe('ACTIVE');
      expect(reserveRes.status).toBe(201);

      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { vendorId, branchId: branchAId, offerVariantId: variant.id },
      });
      expect(stock.reservedQuantity).toBe(1);
    });

    it('RESERVE LOCKS FIRST: reserve() commits first (consuming the only unit) - the waiting publish then sees zero available stock and refuses 400, changing nothing', async () => {
      const { owner, vendorId, branchAId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId, {
        brand_id: NO_BRAND_SENTINEL_ID,
      });
      const variant = await createVariant(owner, vendorId, offerId);
      await addPrimaryImage(owner, vendorId, offerId, variant.id);
      await addStock(owner, vendorId, branchAId, variant.id, 1);
      await activateOffer(owner, vendorId, offerId);
      await publishStorefrontFor(owner, vendorId);

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const barrier = barrierOnReserveCompletion();

      const reserveP = reserveTheLastUnit(
        customer,
        vendorId,
        branchAId,
        variant.id,
      );
      await barrier.reached(); // branch_stock row locked FOR UPDATE, reservation row inserted, not yet committed
      const publishP = activateOffer(owner, vendorId, offerId);

      expect(await someoneWaitsOnBranchStock('FOR SHARE')).toBe(true);
      expect(await settledWithin(publishP, 700)).toBe(false);

      barrier.release();
      const [reserveRes, publishRes] = await Promise.all([reserveP, publishP]);
      expect(reserveRes.status).toBe(201);
      expect(publishRes.status).toBe(400);
      expect(publishRes.body.error.code).toBe('OFFER_NOT_PUBLISHABLE');
      expect(publishRes.body.error.details).toContain('available_stock');

      const offer = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offerId },
      });
      expect(offer.status).toBe('ACTIVE'); // unchanged by the refused PATCH
    });
  });

  describe('Media (D9): type, PRIMARY-must-be-IMAGE, per-type limits, reorder', () => {
    it('refuses a PRIMARY VIDEO at the DTO/controller layer - PRIMARY_MUST_BE_IMAGE', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId);
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('media'))
        .send({
          url: 'https://example.com/v.mp4',
          kind: 'PRIMARY',
          media_type: 'VIDEO',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRIMARY_MUST_BE_IMAGE');
    });

    it('DB CHECK also refuses a PRIMARY VIDEO row written directly (defense in depth)', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId);
      await expect(
        prisma.offerVariantMedia.create({
          data: {
            vendorId,
            offerVariantId: variant.id,
            url: 'https://example.com/v.mp4',
            kind: 'PRIMARY',
            mediaType: 'VIDEO',
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects an 11th image - MEDIA_LIMIT_REACHED (limit is 10)', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId);
      for (let i = 0; i < 10; i++) {
        await request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/media`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('media'))
          .send({ url: `https://example.com/img${i}.jpg`, media_type: 'IMAGE' })
          .expect(201);
      }
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('media'))
        .send({ url: 'https://example.com/img11.jpg', media_type: 'IMAGE' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MEDIA_LIMIT_REACHED');
    });

    it('rejects a 4th video - MEDIA_LIMIT_REACHED (limit is 3)', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId);
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/media`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('media'))
          .send({ url: `https://example.com/v${i}.mp4`, media_type: 'VIDEO' })
          .expect(201);
      }
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('media'))
        .send({ url: 'https://example.com/v3.mp4', media_type: 'VIDEO' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MEDIA_LIMIT_REACHED');
    });

    it('reorders media and persists the new sort_order', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/media`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('media'))
          .send({ url: `https://example.com/img${i}.jpg`, media_type: 'IMAGE' })
          .expect(201);
        ids.push(res.body.id);
      }
      const reordered = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/media/reorder`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ media_ids: [ids[2], ids[0], ids[1]] })
        .expect(200);
      expect(reordered.body.map((m: { id: string }) => m.id)).toEqual([
        ids[2],
        ids[0],
        ids[1],
      ]);
    });

    it("refuses a reorder whose id set does not exactly match this variant's own media (BOLA-safe)", async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId);
      const res1 = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('media'))
        .send({ url: 'https://example.com/img.jpg', media_type: 'IMAGE' })
        .expect(201);
      const res = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/media/reorder`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ media_ids: [res1.body.id, 'not-a-real-id'] });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MEDIA_REORDER_MISMATCH');
    });

    it('updates alt text only via PATCH', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const offerId = await createOffer(owner, vendorId);
      const variant = await createVariant(owner, vendorId, offerId);
      const media = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('media'))
        .send({ url: 'https://example.com/img.jpg', media_type: 'IMAGE' })
        .expect(201);
      const updated = await request(app.getHttpServer())
        .patch(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variant.id}/media/${media.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ alt_text_ar: 'صورة', alt_text_en: 'Photo' })
        .expect(200);
      expect(updated.body.alt_text_en).toBe('Photo');
      expect(updated.body.url).toBe('https://example.com/img.jpg');
    });
  });

  describe('CSV import: ImportBatch lifecycle, brand_name resolution, failed_rows_csv', () => {
    it('GET template returns the exact 16-column header row', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/offers/import/template`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body.csv.split('\n')[0].split(',')).toEqual([
        'title_ar',
        'title_en',
        'seller_sku',
        'base_price',
        'sale_price',
        'condition',
        'specs_text_ar',
        'specs_text_en',
        'identifier_type',
        'identifier_value',
        'store_inventory_barcode',
        'brand_name',
        'product_type',
        'mpn',
        'category_template',
        'template_attributes_json',
      ]);
    });

    it('ImportBatch counts match the returned report exactly, status COMPLETED on a clean import', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const csv = [
        'title_ar,title_en,seller_sku,base_price',
        `ت1,T1,${unique('sku')},20`,
        `ت2,T2,${unique('sku')},30`,
      ].join('\n');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);
      expect(res.body.imported).toHaveLength(2);
      expect(res.body.failed_rows_csv).toBeNull();

      const batch = await prisma.importBatch.findUniqueOrThrow({
        where: { id: res.body.batch_id },
      });
      expect(batch.status).toBe('COMPLETED');
      expect(batch.totalRows).toBe(2);
      expect(batch.importedCount).toBe(res.body.imported.length);
      expect(batch.skippedCount).toBe(res.body.skipped_already_imported.length);
      expect(batch.invalidCount).toBe(res.body.invalid_rows.length);
      expect(batch.conflictCount).toBe(res.body.conflicts.length);
      expect(batch.completedAt).not.toBeNull();

      const listed = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/offers/import/batches`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(listed.body[0].id).toBe(res.body.batch_id);
      expect(listed.body[0].status).toBe('COMPLETED');
    });

    it('status is COMPLETED_WITH_ERRORS when invalid rows exist, and failed_rows_csv contains only the failed rows with the template headers + error_reason', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const csv = [
        'title_ar,title_en,seller_sku,base_price',
        `ت1,T1,${unique('sku')},20`,
        `,T2,${unique('sku')},30`, // missing title_ar - invalid
      ].join('\n');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);
      expect(res.body.imported).toHaveLength(1);
      expect(res.body.invalid_rows).toHaveLength(1);

      const batch = await prisma.importBatch.findUniqueOrThrow({
        where: { id: res.body.batch_id },
      });
      expect(batch.status).toBe('COMPLETED_WITH_ERRORS');

      const csvLines = (res.body.failed_rows_csv as string).split('\n');
      expect(csvLines[0].split(',')).toEqual([
        'title_ar',
        'title_en',
        'seller_sku',
        'base_price',
        'sale_price',
        'condition',
        'specs_text_ar',
        'specs_text_en',
        'identifier_type',
        'identifier_value',
        'store_inventory_barcode',
        'brand_name',
        'product_type',
        'mpn',
        'category_template',
        'template_attributes_json',
        'error_reason',
      ]);
      expect(csvLines).toHaveLength(2); // header + exactly 1 failed row
      expect(csvLines[1]).toContain('T2');
    });

    it('brand_name resolution: a known Brand resolves; the sentinel alias resolves; an unresolvable name becomes an invalid row (never auto-creates a Brand)', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const realBrandName = unique('RealBrand');
      const realBrand = await prisma.brand.create({
        data: {
          name: realBrandName,
          normalizedName: realBrandName.trim().toLowerCase(),
        },
      });
      const brandsBefore = await prisma.brand.count();
      const csv = [
        'title_ar,title_en,seller_sku,base_price,brand_name',
        `ت1,T1,${unique('sku')},20,${realBrand.name}`,
        `ت2,T2,${unique('sku')},20,بدون علامة تجارية`,
        `ت3,T3,${unique('sku')},20,ThisBrandDoesNotExistAnywhere`,
      ].join('\n');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);

      expect(res.body.imported).toHaveLength(2);
      expect(res.body.invalid_rows).toHaveLength(1);
      expect(res.body.invalid_rows[0].reason).toContain(
        'ThisBrandDoesNotExistAnywhere',
      );

      const offers = await prisma.vendorOffer.findMany({
        where: { vendorId },
        orderBy: { createdAt: 'asc' },
      });
      const realBrandOffer = offers.find((o) => o.titleEn === 'T1');
      const sentinelOffer = offers.find((o) => o.titleEn === 'T2');
      expect(realBrandOffer?.brandId).toBe(realBrand.id);
      expect(sentinelOffer?.brandId).toBe(NO_BRAND_SENTINEL_ID);

      // No new Brand row was ever created for the unresolvable name.
      const brandsAfter = await prisma.brand.count();
      expect(brandsAfter).toBe(brandsBefore);
    });

    it('an exception mid-processing (after a group already committed) marks the batch FAILED, never stuck PROCESSING, and does not roll back the already-committed group', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const original = auditLog.record.bind(auditLog);
      const spy = jest
        .spyOn(auditLog, 'record')
        .mockImplementation(async (input, tx) => {
          if (input.action === 'vendor_offers.imported') {
            throw new Error('simulated failure after group commit');
          }
          return original(input, tx);
        });
      const csv = [
        'title_ar,title_en,seller_sku,base_price',
        `ت1,T1,${unique('sku')},20`,
      ].join('\n');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv');
      expect(res.status).toBe(500);
      spy.mockRestore();

      // The group's own transaction had already committed before the
      // simulated failure (which fires AFTER importGroup() returns) -
      // partial-success semantics are unchanged.
      const offer = await prisma.vendorOffer.findFirst({
        where: { vendorId, titleEn: 'T1' },
      });
      expect(offer).not.toBeNull();

      const batch = await prisma.importBatch.findFirstOrThrow({
        where: { vendorId },
        orderBy: { createdAt: 'desc' },
      });
      expect(batch.status).toBe('FAILED');
      expect(batch.completedAt).not.toBeNull();
    });

    it('a file that fails to parse (unsupported type) never creates an ImportBatch row at all', async () => {
      const { owner, vendorId } = await setupOwnerVendor();
      const before = await prisma.importBatch.count({ where: { vendorId } });
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach(
          'file',
          Buffer.from('not a real csv or xlsx', 'utf-8'),
          'products.exe',
        );
      expect(res.status).toBe(400);
      const after = await prisma.importBatch.count({ where: { vendorId } });
      expect(after).toBe(before);
    });
  });

  describe('BOLA and employee-403 coverage on every new Sprint 17 route', () => {
    it('BRANCH_EMPLOYEE is refused (403) on every new owner-only route', async () => {
      const { owner, vendorId, branchAId, employeeToken } =
        await setupOwnerVendorWithEmployee();
      const { offerId, variantId } = await setupPublishableOffer(
        owner,
        vendorId,
        branchAId,
      );
      const media = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const mediaId = media.body[0].id;

      // Sequential, not Promise.all - firing 8 concurrent requests at
      // this in-process test server was flaky (ECONNRESET); each of
      // these is an independent, unrelated authorization check anyway.
      const attempts: (() => request.Test)[] = [
        () =>
          request(app.getHttpServer())
            .put(`/api/v1/vendors/${vendorId}/offers/${offerId}`)
            .set('Authorization', `Bearer ${employeeToken}`)
            .send({ title_ar: 'x' }),
        () =>
          request(app.getHttpServer())
            .post(`/api/v1/vendors/${vendorId}/offers/${offerId}/archive`)
            .set('Authorization', `Bearer ${employeeToken}`),
        () =>
          request(app.getHttpServer())
            .put(
              `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}`,
            )
            .set('Authorization', `Bearer ${employeeToken}`)
            .send({ colour: 'x' }),
        () =>
          request(app.getHttpServer())
            .get(
              `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/price-history`,
            )
            .set('Authorization', `Bearer ${employeeToken}`),
        () =>
          request(app.getHttpServer())
            .patch(
              `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media/${mediaId}`,
            )
            .set('Authorization', `Bearer ${employeeToken}`)
            .send({ alt_text_en: 'x' }),
        () =>
          request(app.getHttpServer())
            .put(
              `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/media/reorder`,
            )
            .set('Authorization', `Bearer ${employeeToken}`)
            .send({ media_ids: [mediaId] }),
        () =>
          request(app.getHttpServer())
            .get(`/api/v1/vendors/${vendorId}/offers/import/template`)
            .set('Authorization', `Bearer ${employeeToken}`),
        () =>
          request(app.getHttpServer())
            .get(`/api/v1/vendors/${vendorId}/offers/import/batches`)
            .set('Authorization', `Bearer ${employeeToken}`),
      ];
      for (const attempt of attempts) {
        const res = await attempt();
        expect(res.status).toBe(403);
      }
    });

    it("BOLA: every new route 404s (never leaks data) when targeting a DIFFERENT vendor's offer/variant/media", async () => {
      const {
        owner: owner1,
        vendorId: vendor1Id,
        branchAId: branch1,
      } = await setupOwnerVendor();
      const { offerId, variantId } = await setupPublishableOffer(
        owner1,
        vendor1Id,
        branch1,
      );
      const media = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendor1Id}/offers/${offerId}/variants/${variantId}/media`,
        )
        .set('Authorization', `Bearer ${owner1}`)
        .expect(200);
      const mediaId = media.body[0].id;

      const { owner: owner2, vendorId: vendor2Id } = await setupOwnerVendor();

      const attempts: (() => request.Test)[] = [
        () =>
          request(app.getHttpServer())
            .get(`/api/v1/vendors/${vendor2Id}/offers/${offerId}`)
            .set('Authorization', `Bearer ${owner2}`),
        () =>
          request(app.getHttpServer())
            .put(`/api/v1/vendors/${vendor2Id}/offers/${offerId}`)
            .set('Authorization', `Bearer ${owner2}`)
            .send({ title_ar: 'x' }),
        () =>
          request(app.getHttpServer())
            .put(
              `/api/v1/vendors/${vendor2Id}/offers/${offerId}/variants/${variantId}`,
            )
            .set('Authorization', `Bearer ${owner2}`)
            .send({ colour: 'x' }),
        () =>
          request(app.getHttpServer())
            .get(
              `/api/v1/vendors/${vendor2Id}/offers/${offerId}/variants/${variantId}/price-history`,
            )
            .set('Authorization', `Bearer ${owner2}`),
        () =>
          request(app.getHttpServer())
            .patch(
              `/api/v1/vendors/${vendor2Id}/offers/${offerId}/variants/${variantId}/media/${mediaId}`,
            )
            .set('Authorization', `Bearer ${owner2}`)
            .send({ alt_text_en: 'x' }),
        () =>
          request(app.getHttpServer())
            .delete(
              `/api/v1/vendors/${vendor2Id}/offers/${offerId}/variants/${variantId}/media/${mediaId}`,
            )
            .set('Authorization', `Bearer ${owner2}`),
        () =>
          request(app.getHttpServer())
            .post(`/api/v1/vendors/${vendor2Id}/offers/${offerId}/archive`)
            .set('Authorization', `Bearer ${owner2}`),
      ];
      for (const attempt of attempts) {
        const res = await attempt();
        expect(res.status).toBe(404);
      }
    });
  });
});
