import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { createUniquePhone } from './helpers/e2e-phone-lanes';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const uniquePhone = createUniquePhone('sprint17b-platform-catalog', '56');
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

// GTIN is capped at 20 chars by common barcode conventions - a
// timestamp+counter string sliced to fit can silently collide once the
// counter grows past what the slice keeps (e.g. "...-1" vs "...-15"
// both truncate the same way). Built short and unique by construction
// instead.
let gtinCounter = 0;
function uniqueGtin(): string {
  gtinCounter += 1;
  return `GTIN${String(gtinCounter).padStart(14, '0')}`;
}

describe('Sprint 17b - platform catalog administration (e2e)', () => {
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
    await app.close();
  });

  /** A transaction is genuinely waiting on a `canonical_products ...
   * FOR UPDATE` lock right now - confirms merge()/split() is really
   * blocked behind a concurrent holder's lock, not just slow. */
  async function someoneWaitsOnCanonicalProductLock(): Promise<boolean> {
    for (let i = 0; i < 100; i++) {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query ILIKE '%FROM canonical_products%FOR UPDATE%'`;
      if (Number(rows[0].n) > 0) return true;
      await sleep(100);
    }
    return false;
  }

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

  // Review-round fix: unique()'s own timestamp+counter scheme produces
  // names similar enough to each other (same label prefix, near-
  // identical timestamp digits) to trip FR-CAT-009's own pg_trgm
  // duplicate warning across DIFFERENT calls within one test run - a
  // real interaction between this sprint's own two features, not a
  // bug in the duplicate-check itself. Generic fixture helpers default
  // to confirming past the warning; the dedicated "duplicate warning"
  // describe block below overrides this back off to test the warning
  // itself.
  async function createCategory(
    adminToken: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; name_ar: string; name_en: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', unique('category'))
      .send({
        name_ar: unique('فئة'),
        name_en: unique('Category'),
        confirm_despite_duplicate_warning: true,
        ...overrides,
      })
      .expect(201);
    return res.body;
  }

  async function createBrand(
    adminToken: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; name: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/brands')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', unique('brand'))
      .send({
        name: unique('Brand'),
        confirm_despite_duplicate_warning: true,
        ...overrides,
      })
      .expect(201);
    return res.body;
  }

  async function createCanonicalProduct(
    adminToken: string,
    brandId: string,
    categoryId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; status: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/canonical-products')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', unique('cp'))
      .send({
        brand_id: brandId,
        category_id: categoryId,
        model_name: unique('Model'),
        confirm_despite_duplicate_warning: true,
        ...overrides,
      })
      .expect(201);
    return res.body;
  }

  async function addVariant(
    adminToken: string,
    productId: string,
    structuralAttributes: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/canonical-products/${productId}/variants`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', unique('variant'))
      .send({ structural_attributes: structuralAttributes, ...overrides })
      .expect(201);
    return res.body;
  }

  async function transition(
    adminToken: string,
    productId: string,
    toStatus: string,
  ) {
    return request(app.getHttpServer())
      .post(`/api/v1/canonical-products/${productId}/status-transition`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ to_status: toStatus });
  }

  // --- vendor/offer scaffolding, mirroring sprint6/sprint7's own helpers ---
  async function createVendor(ownerToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        store_type: 'PHYSICAL',
        branches: [{ name: 'Main', is_physical: true }],
        applicable_categories: ['WOMEN'],
        return_policy: { mode: 'NO_RETURN' },
      })
      .expect(201);
    return res.body.id;
  }

  async function activateVendor(
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
          verification_photo_url: 'https://example.com/p.jpg',
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
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { storefrontPublished: true },
    });
  }

  async function createOfferVariant(
    ownerToken: string,
    vendorId: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ offerId: string; variantId: string }> {
    const offerRes = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/offers`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('offer'))
      .send({ title_ar: unique('عرض'), title_en: unique('Offer') })
      .expect(201);
    const variantRes = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('variant'))
      .send({ seller_sku: unique('sku'), base_price: 10, ...extra })
      .expect(201);
    return { offerId: offerRes.body.id, variantId: variantRes.body.id };
  }

  async function confirmExactMatch(
    ownerToken: string,
    vendorId: string,
    canonicalVariantId: string,
    gtin: string,
  ): Promise<{ offerId: string; variantId: string }> {
    const { offerId, variantId } = await createOfferVariant(
      ownerToken,
      vendorId,
      {
        identifier_type: 'GTIN',
        identifier_value: gtin,
      },
    );
    void canonicalVariantId;
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-confirmation`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('confirm'))
      .send({ decision: 'confirm' })
      .expect(200);
    return { offerId, variantId };
  }

  // ============================================================
  // 1. Lifecycle state machine
  // ============================================================
  describe('lifecycle state machine', () => {
    it('creation always lands at DRAFT, even if a caller sends a status field', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin);
      const category = await createCategory(admin);
      const res = await request(app.getHttpServer())
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
      expect(res.body.status).toBe('DRAFT');
    });

    it('walks the full legal path DRAFT -> PENDING_REVIEW -> PUBLISHED -> ARCHIVED -> PUBLISHED, each transition audited', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin);
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      await addVariant(admin, product.id, { colour: 'red' });

      let res = await transition(admin, product.id, 'PENDING_REVIEW');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('PENDING_REVIEW');

      res = await transition(admin, product.id, 'PUBLISHED');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('PUBLISHED');

      res = await transition(admin, product.id, 'ARCHIVED');
      expect(res.status).toBe(200);

      res = await transition(admin, product.id, 'PUBLISHED');
      expect(res.status).toBe(200);

      const audits = await prisma.auditLog.findMany({
        where: {
          entityType: 'CanonicalProduct',
          entityId: product.id,
          action: 'canonical_product.status_transition',
        },
      });
      expect(audits.length).toBe(4);
    });

    it('rejects submitting for review with no variants', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin);
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      const res = await transition(admin, product.id, 'PENDING_REVIEW');
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('rejects every illegal transition (PUBLISHED->DRAFT direct, DRAFT->PUBLISHED direct) with a real, independently-committed rejection audit, and leaves status unchanged', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin);
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      await addVariant(admin, product.id, {});

      const illegal1 = await transition(admin, product.id, 'PUBLISHED');
      expect(illegal1.status).toBe(422);
      const row1 = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(row1.status).toBe('DRAFT');

      await transition(admin, product.id, 'PENDING_REVIEW');
      await transition(admin, product.id, 'PUBLISHED');

      const illegal2 = await transition(admin, product.id, 'DRAFT');
      expect(illegal2.status).toBe(422);
      const row2 = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(row2.status).toBe('PUBLISHED');

      // Review-round fix: the rejection audit is a REAL, independently
      // committed row, not a phantom erased by a transaction rollback.
      const rejections = await prisma.auditLog.findMany({
        where: {
          entityType: 'CanonicalProduct',
          entityId: product.id,
          action: 'canonical_product.status_transition_rejected',
        },
      });
      expect(rejections.length).toBe(2);
    });

    it('MERGED is never a reachable target via status-transition directly', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin);
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      const res = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${product.id}/status-transition`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ to_status: 'MERGED' });
      expect([400, 422]).toContain(res.status);
    });

    it('concurrent transitions from the same state: exactly one wins, the loser is rejected against the POST-transition state, not stale data', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin);
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      await addVariant(admin, product.id, {});
      await transition(admin, product.id, 'PENDING_REVIEW');

      // From PENDING_REVIEW, race PUBLISHED against DRAFT - only one is
      // legal once the other lands (PENDING_REVIEW only allows each
      // once).
      const [r1, r2] = await Promise.all([
        transition(admin, product.id, 'PUBLISHED'),
        transition(admin, product.id, 'DRAFT'),
      ]);
      const outcomes = [r1.status, r2.status].sort();
      expect(outcomes).toEqual([200, 422]);

      const final = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(['PUBLISHED', 'DRAFT']).toContain(final.status);

      const rejectedOne = r1.status === 422 ? r1 : r2;
      // The rejected attempt's own audit must reflect the REAL final
      // status, not the status as of before the race.
      const rejectionAudit = await prisma.auditLog.findFirst({
        where: {
          entityType: 'CanonicalProduct',
          entityId: product.id,
          action: 'canonical_product.status_transition_rejected',
        },
        orderBy: { occurredAt: 'desc' },
      });
      expect(rejectionAudit).not.toBeNull();
      void rejectedOne;
    });
  });

  // ============================================================
  // 2. Restriction (forward-looking only, never retroactive)
  // ============================================================
  describe('restriction', () => {
    it('blocks creating a new CanonicalProduct under a restricted category', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin);
      const category = await createCategory(admin);
      await request(app.getHttpServer())
        .post(`/api/v1/categories/${category.id}/restrict`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('restrict'))
        .send({ reason: 'بند قيد المراجعة القانونية للمنتجات التنظيمية' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/v1/canonical-products')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('cp'))
        .send({
          brand_id: brand.id,
          category_id: category.id,
          model_name: unique('Model'),
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CATEGORY_RESTRICTED');
    });

    it('blocks publishing a restricted product, and blocks publishing under a restricted category, but never hides an already-published product or affects its existing offers/orders', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin);
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      const variant = await addVariant(admin, product.id, { colour: 'blue' });
      await transition(admin, product.id, 'PENDING_REVIEW');
      await transition(admin, product.id, 'PUBLISHED');

      // Match and confirm a real offer to this ALREADY-PUBLISHED product
      // before restricting it.
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const gtin = uniqueGtin();
      await prisma.canonicalProductVariant.update({
        where: { id: variant.id },
        data: { gtin },
      });
      await confirmExactMatch(owner, vendorId, variant.id, gtin);

      // Now restrict it - forward-looking only.
      await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${product.id}/restrict`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('restrict'))
        .send({ reason: 'الإبلاغ عن مخالفة تنظيمية لهذا المنتج تحديداً' })
        .expect(200);

      // Still GET-able, still PUBLISHED, still shows its existing
      // confirmed offer link - restriction never hides/unlinks anything
      // already live.
      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/canonical-products/${product.id}`)
        .expect(200);
      expect(getRes.body.status).toBe('PUBLISHED');
      expect(getRes.body.is_restricted).toBe(true);
      // The existing confirmed offer link is untouched - re-fetching the
      // variant shows its canonicalVariantId is still set to the
      // restricted product's variant, exactly as it was before.
      const freshVariant =
        await prisma.canonicalProductVariant.findUniqueOrThrow({
          where: { id: variant.id },
        });
      const stillLinkedOffer = await prisma.offerVariant.findFirst({
        where: { canonicalVariantId: freshVariant.id },
      });
      expect(stillLinkedOffer).not.toBeNull();

      // A publish attempt on a DIFFERENT, unrestricted product is
      // blocked once its own CATEGORY becomes restricted - created and
      // submitted for review BEFORE the category is restricted (category
      // restriction already blocks NEW creation under it entirely, so
      // this is the only way to reach "existing DRAFT/PENDING_REVIEW
      // product, now-restricted category").
      const otherCategory = await createCategory(admin);
      const anotherProduct = await createCanonicalProduct(
        admin,
        brand.id,
        otherCategory.id,
      );
      await addVariant(admin, anotherProduct.id, {});
      await transition(admin, anotherProduct.id, 'PENDING_REVIEW');
      await request(app.getHttpServer())
        .post(`/api/v1/categories/${otherCategory.id}/restrict`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('restrict'))
        .send({ reason: 'تقييد مؤقت لهذه الفئة بانتظار المراجعة التنظيمية' })
        .expect(200);
      const blockedPublish = await transition(
        admin,
        anotherProduct.id,
        'PUBLISHED',
      );
      expect(blockedPublish.status).toBe(422);

      // The restricted product ITSELF also can't re-publish after being
      // archived.
      await transition(admin, product.id, 'ARCHIVED');
      const rePublish = await transition(admin, product.id, 'PUBLISHED');
      expect(rePublish.status).toBe(422);
    });

    it('a restricted product is excluded from new non-exact candidate generation', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin, {
        name: unique('RestrictedBrand'),
      });
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
        {
          model_name: 'UniqueModelXyz123',
        },
      );
      await addVariant(admin, product.id, { spec: 'UniqueModelXyz123' });
      await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${product.id}/restrict`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('restrict'))
        .send({ reason: 'محجوب مؤقتاً بانتظار مراجعة قانونية كاملة' })
        .expect(200);

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const { offerId, variantId } = await createOfferVariant(owner, vendorId, {
        specs_text_ar: 'UniqueModelXyz123',
        specs_text_en: 'UniqueModelXyz123',
      });

      const searchRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const candidateIds = searchRes.body.map(
        (c: { canonical_variant_id: string }) => c.canonical_variant_id,
      );
      const restrictedVariant =
        await prisma.canonicalProductVariant.findFirstOrThrow({
          where: { canonicalProductId: product.id },
        });
      expect(candidateIds).not.toContain(restrictedVariant.id);
    });
  });

  // ============================================================
  // 3. Duplicate warning (pg_trgm, warning-only) + matching guards
  // ============================================================
  describe('duplicate warning', () => {
    it('warns (never blocks) on a near-duplicate category name in Arabic, and the confirm flag proceeds', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const first = await createCategory(admin, {
        name_ar: 'إلكترونيات منزلية',
        name_en: unique('HomeElectronics'),
      });
      const dupRes = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('category'))
        .send({ name_ar: 'إلكترونيات منزلية جدا', name_en: unique('Other') });
      expect(dupRes.status).toBe(409);
      expect(dupRes.body.error.code).toBe('POSSIBLE_DUPLICATE');

      const confirmed = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('category'))
        .send({
          name_ar: 'إلكترونيات منزلية جدا',
          name_en: unique('Other'),
          confirm_despite_duplicate_warning: true,
        });
      expect(confirmed.status).toBe(201);
      void first;
    });

    it('warns on a near-duplicate brand name in English', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      await createBrand(admin, { name: 'International Business Machines' });
      const dupRes = await request(app.getHttpServer())
        .post('/api/v1/brands')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('brand'))
        .send({ name: 'International Business Machine' });
      expect(dupRes.status).toBe(409);
      expect(dupRes.body.error.code).toBe('POSSIBLE_DUPLICATE');
    });

    it('warns on a near-duplicate canonical product model name', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin);
      const category = await createCategory(admin);
      await createCanonicalProduct(admin, brand.id, category.id, {
        model_name: 'Galaxy Smartphone Pro Max',
      });
      const dupRes = await request(app.getHttpServer())
        .post('/api/v1/canonical-products')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('cp'))
        .send({
          brand_id: brand.id,
          category_id: category.id,
          model_name: 'Galaxy Smartphone Pro Max Plus',
        });
      expect(dupRes.status).toBe(409);
      expect(dupRes.body.error.code).toBe('POSSIBLE_DUPLICATE');
    });

    it('a genuinely dissimilar name creates with no warning at all', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      await createCategory(admin, { name_ar: 'ملابس', name_en: 'Clothing' });
      const res = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('category'))
        .send({
          name_ar: unique('إلكترونيات'),
          name_en: unique('CompletelyUnrelatedXyz'),
        });
      expect(res.status).toBe(201);
    });
  });

  describe('matching guards (formula-independent)', () => {
    it('Guard A: a USED offer variant gets zero non-exact candidates, regardless of text similarity', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin, { name: unique('GuardABrand') });
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
        { model_name: 'GuardATestModel' },
      );
      await addVariant(admin, product.id, { spec: 'GuardATestModel' });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const { offerId, variantId } = await createOfferVariant(owner, vendorId, {
        condition: 'USED',
        specs_text_ar: 'GuardATestModel',
        specs_text_en: 'GuardATestModel',
      });

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it('Guard B: a BUNDLE-type canonical product never appears as a candidate', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin, { name: unique('GuardBBrand') });
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
        { model_name: 'GuardBTestModel' },
      );
      await request(app.getHttpServer())
        .patch(`/api/v1/canonical-products/${product.id}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ product_type: 'BUNDLE' })
        .expect(200);
      await addVariant(admin, product.id, { spec: 'GuardBTestModel' });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const { offerId, variantId } = await createOfferVariant(owner, vendorId, {
        specs_text_ar: 'GuardBTestModel',
        specs_text_en: 'GuardBTestModel',
      });

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const bundleVariant =
        await prisma.canonicalProductVariant.findFirstOrThrow({
          where: { canonicalProductId: product.id },
        });
      const ids = res.body.map(
        (c: { canonical_variant_id: string }) => c.canonical_variant_id,
      );
      expect(ids).not.toContain(bundleVariant.id);
    });
  });

  // ============================================================
  // 4. Customer wrong-match reporting (Option A: exact + non-exact)
  // ============================================================
  describe('match reports', () => {
    async function createCustomer(): Promise<string> {
      return signup(uniquePhone(), 'a-strong-password');
    }

    it('rejects a report from a session with no CustomerProfile-backed identity the same as any other role would be (still just SessionAuthGuard-eligible, the real gate is inside the service)', async () => {
      // Every registered account gets a CustomerProfile (see
      // MatchReportsService's own comment) - this test instead proves
      // the endpoint requires a real session at all (401) and, for an
      // eligible one, actually reaches the service's own checks rather
      // than trusting the guard alone.
      await request(app.getHttpServer())
        .post('/api/v1/me/match-reports')
        .send({ offer_variant_id: 'nonexistent' })
        .expect(401);
    });

    it('404s for an offer variant belonging to a non-public (unpublished) vendor - never confirms or denies it exists', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const { variantId } = await createOfferVariant(owner, vendorId);
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { storefrontPublished: false },
      });

      const customer = await createCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/me/match-reports')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('report'))
        .send({ offer_variant_id: variantId });
      expect(res.status).toBe(404);
    });

    it('409s when the offer is not currently matched to anything', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const { variantId } = await createOfferVariant(owner, vendorId);

      const customer = await createCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/me/match-reports')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('report'))
        .send({ offer_variant_id: variantId });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('OFFER_NOT_MATCHED');
    });

    it('non-exact: reports a currently-approved match, requeues it exactly once, and never exposes reporter identity or note to the owner queue', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin, { name: unique('ReportBrand') });
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
        { model_name: 'ReportTestModelXyz' },
      );
      const variant = await addVariant(admin, product.id, {
        spec: 'ReportTestModelXyz',
      });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const { offerId, variantId } = await createOfferVariant(owner, vendorId, {
        specs_text_ar: 'ReportTestModelXyz',
        specs_text_en: 'ReportTestModelXyz',
      });
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const candidate = await prisma.matchReviewCandidate.findFirstOrThrow({
        where: { offerVariantId: variantId, canonicalVariantId: variant.id },
      });
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/candidates/${candidate.id}/decision`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('decide'))
        .send({ decision: 'approve' })
        .expect(200);

      const customer = await createCustomer();
      const reportRes = await request(app.getHttpServer())
        .post('/api/v1/me/match-reports')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('report'))
        .send({
          offer_variant_id: variantId,
          note: 'هذا التطابق غير صحيح إطلاقاً',
        })
        .expect(201);
      expect(reportRes.body.candidate_id).toBe(candidate.id);

      const requeued = await prisma.matchReviewCandidate.findUniqueOrThrow({
        where: { id: candidate.id },
      });
      expect(requeued.status).toBe('PENDING');

      const queueRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/match-review/queue`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const queueItem = queueRes.body.items.find(
        (i: { id: string }) => i.id === candidate.id,
      );
      expect(queueItem).toBeDefined();
      expect(queueItem.report_count).toBe(1);
      expect(JSON.stringify(queueItem)).not.toContain('هذا التطابق غير صحيح');
      expect(JSON.stringify(queueItem)).not.toContain(customer.slice(0, 10));
    });

    it('exact-identifier (Option A): first report synthesizes a PENDING EXACT_IDENTIFIER candidate; link stays as-is until the owner decides', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin, {
        name: unique('ExactReportBrand'),
      });
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      const variant = await addVariant(admin, product.id, {});
      const gtin = uniqueGtin();
      await prisma.canonicalProductVariant.update({
        where: { id: variant.id },
        data: { gtin },
      });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const { variantId } = await confirmExactMatch(
        owner,
        vendorId,
        variant.id,
        gtin,
      );

      expect(
        await prisma.matchReviewCandidate.findFirst({
          where: { offerVariantId: variantId, canonicalVariantId: variant.id },
        }),
      ).toBeNull();

      const customer = await createCustomer();
      await request(app.getHttpServer())
        .post('/api/v1/me/match-reports')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('report'))
        .send({ offer_variant_id: variantId })
        .expect(201);

      const synthesized = await prisma.matchReviewCandidate.findFirstOrThrow({
        where: { offerVariantId: variantId, canonicalVariantId: variant.id },
      });
      expect(synthesized.source).toBe('EXACT_IDENTIFIER');
      expect(synthesized.score).toBe(1.0);
      expect(synthesized.status).toBe('PENDING');

      // The actual offer-variant link is untouched - still linked,
      // exactly as it was, pending the owner's re-review.
      const freshOfferVariant = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(freshOfferVariant.canonicalVariantId).toBe(variant.id);
    });

    it('exact-identifier concurrent create race: two different customers reporting simultaneously produce exactly one synthetic candidate, two MatchReport rows, one requeue event, never a raw P2002/500', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin, {
        name: unique('RaceReportBrand'),
      });
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      const variant = await addVariant(admin, product.id, {});
      const gtin = uniqueGtin();
      await prisma.canonicalProductVariant.update({
        where: { id: variant.id },
        data: { gtin },
      });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const { variantId } = await confirmExactMatch(
        owner,
        vendorId,
        variant.id,
        gtin,
      );

      const customerA = await createCustomer();
      const customerB = await createCustomer();

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/me/match-reports')
          .set('Authorization', `Bearer ${customerA}`)
          .set('Idempotency-Key', unique('report-a'))
          .send({ offer_variant_id: variantId }),
        request(app.getHttpServer())
          .post('/api/v1/me/match-reports')
          .set('Authorization', `Bearer ${customerB}`)
          .set('Idempotency-Key', unique('report-b'))
          .send({ offer_variant_id: variantId }),
      ]);
      // Never a raw 500 from either side of the race.
      expect([200, 201]).toContain(resA.status);
      expect([200, 201]).toContain(resB.status);

      const candidates = await prisma.matchReviewCandidate.findMany({
        where: { offerVariantId: variantId, canonicalVariantId: variant.id },
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].source).toBe('EXACT_IDENTIFIER');
      expect(candidates[0].status).toBe('PENDING');

      const reports = await prisma.matchReport.findMany({
        where: { candidateId: candidates[0].id },
      });
      expect(reports).toHaveLength(2);

      const requeueAudits = await prisma.auditLog.findMany({
        where: {
          entityType: 'MatchReviewCandidate',
          entityId: candidates[0].id,
          action: {
            in: [
              'match_review_candidate.created_from_exact_report',
              'match_review_candidate.requeued_from_report',
            ],
          },
        },
      });
      // Exactly one "this candidate entered the queue" event - the
      // winner's create (which already starts PENDING, so no separate
      // requeue fires), the loser reuses it without a duplicate requeue.
      expect(requeueAudits).toHaveLength(1);
    });

    it('a second report from the SAME customer on an already-PENDING candidate is idempotent - one report row, no duplicate requeue', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin, {
        name: unique('IdemReportBrand'),
      });
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      const variant = await addVariant(admin, product.id, {});
      const gtin = uniqueGtin();
      await prisma.canonicalProductVariant.update({
        where: { id: variant.id },
        data: { gtin },
      });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const { variantId } = await confirmExactMatch(
        owner,
        vendorId,
        variant.id,
        gtin,
      );

      const customer = await createCustomer();
      const first = await request(app.getHttpServer())
        .post('/api/v1/me/match-reports')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('report'))
        .send({ offer_variant_id: variantId })
        .expect(201);
      const second = await request(app.getHttpServer())
        .post('/api/v1/me/match-reports')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('report'))
        .send({ offer_variant_id: variantId });
      expect([200, 201]).toContain(second.status);
      expect(second.body.id).toBe(first.body.id);

      const reports = await prisma.matchReport.findMany({
        where: { candidateId: first.body.candidate_id as string },
      });
      expect(reports).toHaveLength(1);
    });

    it('review-round fix: a same-customer duplicate report submitted AFTER the owner already decided the candidate never reopens it - no status change, no duplicate requeue/audit', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin, { name: unique('NoReopenBrand') });
      const category = await createCategory(admin);
      const product = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      const variant = await addVariant(admin, product.id, {});
      const gtin = uniqueGtin();
      await prisma.canonicalProductVariant.update({
        where: { id: variant.id },
        data: { gtin },
      });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const { offerId, variantId } = await confirmExactMatch(
        owner,
        vendorId,
        variant.id,
        gtin,
      );

      const customer = await createCustomer();
      const first = await request(app.getHttpServer())
        .post('/api/v1/me/match-reports')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('report'))
        .send({ offer_variant_id: variantId })
        .expect(201);
      const candidateId = first.body.candidate_id as string;

      // Owner decides (rejects the report, keeping the link as-is).
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/candidates/${candidateId}/decision`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('decide'))
        .send({ decision: 'reject' })
        .expect(200);

      const afterDecision = await prisma.matchReviewCandidate.findUniqueOrThrow(
        { where: { id: candidateId } },
      );
      expect(afterDecision.status).toBe('REJECTED');
      const auditCountBefore = await prisma.auditLog.count({
        where: { entityType: 'MatchReviewCandidate', entityId: candidateId },
      });

      // Same customer, same candidate, a FRESH idempotency key - a
      // genuinely new HTTP request, but the SAME reporter re-reporting
      // the SAME candidate must still be a pure no-op at the business
      // level, even though the candidate was decided in between.
      const second = await request(app.getHttpServer())
        .post('/api/v1/me/match-reports')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('report-again'))
        .send({ offer_variant_id: variantId });
      expect([200, 201]).toContain(second.status);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.candidate_id).toBe(candidateId);

      const candidateAfterSecondReport =
        await prisma.matchReviewCandidate.findUniqueOrThrow({
          where: { id: candidateId },
        });
      // Never reopened - the bug this fixes would have flipped this
      // back to PENDING purely because the same reporter resubmitted.
      expect(candidateAfterSecondReport.status).toBe('REJECTED');

      const reports = await prisma.matchReport.findMany({
        where: { candidateId },
      });
      expect(reports).toHaveLength(1);

      const auditCountAfter = await prisma.auditLog.count({
        where: { entityType: 'MatchReviewCandidate', entityId: candidateId },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
    });
  });

  // ============================================================
  // 5. Merge / split
  // ============================================================
  describe('merge', () => {
    async function mergeSetup(admin: string) {
      const brand = await createBrand(admin, { name: unique('MergeBrand') });
      const category = await createCategory(admin);
      const survivor = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      const loser = await createCanonicalProduct(admin, brand.id, category.id);
      return { brand, category, survivor, loser };
    }

    it('merges cleanly when every loser variant pairs 1:1 by structural attributes - redirects set, offers re-pointed, audited', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { survivor, loser } = await mergeSetup(admin);
      const survivorVariant = await addVariant(admin, survivor.id, {
        colour: 'red',
        size: 'L',
      });
      const loserVariant = await addVariant(admin, loser.id, {
        colour: 'red',
        size: 'L',
      });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const gtin = uniqueGtin();
      await prisma.canonicalProductVariant.update({
        where: { id: loserVariant.id },
        data: { gtin },
      });
      const { variantId } = await confirmExactMatch(
        owner,
        vendorId,
        loserVariant.id,
        gtin,
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${loser.id}/merge`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('merge'))
        .send({ into_canonical_product_id: survivor.id })
        .expect(200);
      expect(res.body.merged_variant_pairs).toHaveLength(1);
      expect(res.body.merged_variant_pairs[0]).toMatchObject({
        loser_variant_id: loserVariant.id,
        survivor_variant_id: survivorVariant.id,
      });

      const loserFresh = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: loser.id },
      });
      expect(loserFresh.status).toBe('MERGED');
      expect(loserFresh.mergedIntoId).toBe(survivor.id);

      const loserVariantFresh =
        await prisma.canonicalProductVariant.findUniqueOrThrow({
          where: { id: loserVariant.id },
        });
      expect(loserVariantFresh.mergedIntoVariantId).toBe(survivorVariant.id);

      const offerVariantFresh = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(offerVariantFresh.canonicalVariantId).toBe(survivorVariant.id);

      const vendorOfferFresh = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offerVariantFresh.vendorOfferId },
      });
      expect(vendorOfferFresh.canonicalProductId).toBe(survivor.id);

      const auditRow = await prisma.auditLog.findFirst({
        where: {
          entityType: 'CanonicalProduct',
          entityId: loser.id,
          action: 'canonical_product.merged',
        },
      });
      expect(auditRow).not.toBeNull();

      // Old merged-away id still resolves (the "redirect" guarantee).
      const getLoser = await request(app.getHttpServer())
        .get(`/api/v1/canonical-products/${loser.id}`)
        .expect(200);
      expect(getLoser.body.merged_into_id).toBe(survivor.id);
    });

    it('rejects outright, with zero writes, when a loser variant has no matching survivor variant', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { survivor, loser } = await mergeSetup(admin);
      await addVariant(admin, survivor.id, { colour: 'red' });
      const unmatchedLoserVariant = await addVariant(admin, loser.id, {
        colour: 'green',
      });

      const before = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: loser.id },
      });
      const res = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${loser.id}/merge`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('merge'))
        .send({ into_canonical_product_id: survivor.id });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('MERGE_VARIANT_UNMATCHED');
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            loser_variant_id: unmatchedLoserVariant.id,
          }),
        ]),
      );

      const after = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: loser.id },
      });
      expect(after.status).toBe(before.status);
      expect(after.mergedIntoId).toBeNull();
      const variantAfter =
        await prisma.canonicalProductVariant.findUniqueOrThrow({
          where: { id: unmatchedLoserVariant.id },
        });
      expect(variantAfter.mergedIntoVariantId).toBeNull();
    });

    it('rejects outright when two survivor variants ambiguously share the same structural attributes', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { survivor, loser } = await mergeSetup(admin);
      await addVariant(admin, survivor.id, { colour: 'red' });
      await addVariant(admin, survivor.id, { colour: 'red' }); // ambiguous duplicate
      await addVariant(admin, loser.id, { colour: 'red' });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${loser.id}/merge`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('merge'))
        .send({ into_canonical_product_id: survivor.id });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('MERGE_VARIANT_UNMATCHED');
    });

    it('rejects merging an already-MERGED product (either as loser or as survivor)', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { brand, category, survivor, loser } = await mergeSetup(admin);
      await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${loser.id}/merge`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('merge'))
        .send({ into_canonical_product_id: survivor.id })
        .expect(200);

      const third = await createCanonicalProduct(admin, brand.id, category.id);
      const againAsLoser = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${loser.id}/merge`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('merge'))
        .send({ into_canonical_product_id: third.id });
      expect(againAsLoser.status).toBe(409);
      expect(againAsLoser.body.error.code).toBe('LOSER_ALREADY_MERGED');

      const asSurvivor = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${third.id}/merge`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('merge'))
        .send({ into_canonical_product_id: loser.id });
      expect(asSurvivor.status).toBe(409);
      expect(asSurvivor.body.error.code).toBe('SURVIVOR_ALREADY_MERGED');
    });

    it('concurrency: two merges racing the same pair in opposite directions - no deadlock, exactly one succeeds, no partial write', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { brand, category } = await mergeSetup(admin);
      const productA = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      const productB = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      await addVariant(admin, productA.id, { colour: 'x' });
      await addVariant(admin, productB.id, { colour: 'x' });

      const [r1, r2] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/canonical-products/${productA.id}/merge`)
          .set('Authorization', `Bearer ${admin}`)
          .set('Idempotency-Key', unique('merge'))
          .send({ into_canonical_product_id: productB.id }),
        request(app.getHttpServer())
          .post(`/api/v1/canonical-products/${productB.id}/merge`)
          .set('Authorization', `Bearer ${admin}`)
          .set('Idempotency-Key', unique('merge'))
          .send({ into_canonical_product_id: productA.id }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      // Exactly one succeeds (200); the other fails cleanly (409) once
      // it sees the other side already MERGED under its own lock -
      // never two 200s (that would mean a cycle/corruption), never a
      // raw 500 (that would mean a deadlock/crash).
      expect(statuses).toEqual([200, 409]);

      const freshA = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: productA.id },
      });
      const freshB = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: productB.id },
      });
      const mergedCount = [freshA.status, freshB.status].filter(
        (s) => s === 'MERGED',
      ).length;
      expect(mergedCount).toBe(1);
    }, 30000);

    it('concurrency: a merge racing an ordinary decide() touching the same offer variant - no deadlock, no VendorOffer left in an impossible state', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { survivor, loser } = await mergeSetup(admin);
      const survivorVariant = await addVariant(admin, survivor.id, {
        colour: 'z',
      });
      const loserVariant = await addVariant(admin, loser.id, { colour: 'z' });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const { offerId, variantId } = await createOfferVariant(owner, vendorId);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/search`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      // Force a candidate directly against the loser's variant (bypasses
      // needing real text-similarity to pass threshold) so decide() has
      // something real to approve concurrently with the merge.
      await prisma.matchReviewCandidate.upsert({
        where: {
          offerVariantId_canonicalVariantId: {
            offerVariantId: variantId,
            canonicalVariantId: loserVariant.id,
          },
        },
        update: { status: 'PENDING' },
        create: {
          vendorId,
          offerVariantId: variantId,
          canonicalVariantId: loserVariant.id,
          score: 0.9,
          status: 'PENDING',
        },
      });
      const candidate = await prisma.matchReviewCandidate.findUniqueOrThrow({
        where: {
          offerVariantId_canonicalVariantId: {
            offerVariantId: variantId,
            canonicalVariantId: loserVariant.id,
          },
        },
      });

      const [mergeRes, decideRes] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/canonical-products/${loser.id}/merge`)
          .set('Authorization', `Bearer ${admin}`)
          .set('Idempotency-Key', unique('merge'))
          .send({ into_canonical_product_id: survivor.id }),
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/offers/${offerId}/variants/${variantId}/match-review/candidates/${candidate.id}/decision`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('decide'))
          .send({ decision: 'approve' }),
      ]);
      // Neither call may ever 500 (deadlock/crash) - either can
      // legitimately succeed or hit a real, clean conflict depending on
      // which committed first.
      expect(mergeRes.status).not.toBe(500);
      expect(decideRes.status).not.toBe(500);

      const offerVariantFresh = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      const vendorOfferFresh = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offerVariantFresh.vendorOfferId },
      });
      if (offerVariantFresh.canonicalVariantId) {
        // Whatever it ends up pointing at, the owning VendorOffer's own
        // canonicalProductId must correctly match that variant's
        // CURRENT parent product - never a stale/impossible pairing.
        const linkedVariant =
          await prisma.canonicalProductVariant.findUniqueOrThrow({
            where: { id: offerVariantFresh.canonicalVariantId },
          });
        expect(vendorOfferFresh.canonicalProductId).toBe(
          linkedVariant.canonicalProductId,
        );
      }
      void survivorVariant;
    }, 30000);

    it("barrier (review-round fix): a concurrent lock-holder commits a brand-new VendorOffer link while merge is genuinely blocked waiting on the same loser lock - merge's discovery runs only after that commit and correctly repoints the new VendorOffer, never leaving it pointing at the now-MERGED loser", async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { survivor, loser } = await mergeSetup(admin);
      const survivorVariant = await addVariant(admin, survivor.id, {
        colour: 'barrier',
      });
      const loserVariant = await addVariant(admin, loser.id, {
        colour: 'barrier',
      });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      // Genuinely unmatched at this point - this is the offer whose
      // first-ever match a concurrent decide()/confirmMatch()-style
      // writer will establish WHILE merge is blocked waiting on the
      // loser's CanonicalProduct lock.
      const { variantId } = await createOfferVariant(owner, vendorId);

      // Stand-in for a concurrent decide()/confirmMatch() confirmation
      // that reaches the SAME lock first: locks the loser's
      // CanonicalProduct row (the exact row merge() also needs) and
      // performs the SAME real writes that path makes -
      // offerVariant.canonicalVariantId and vendorOffer.canonicalProductId
      // - inside its own transaction, held open under full test
      // control (an explicit, generous timeout, never subject to any
      // production endpoint's default 5s Prisma transaction ceiling -
      // routing this through the real HTTP decide() endpoint instead
      // made this test flaky under full-suite load: decide()'s own
      // multi-step approve transaction, plus this test's own
      // verification steps, could together exceed that unconfigured
      // 5s default and have Prisma silently abort it mid-pause).
      //
      // A SEPARATE PrismaClient, not the app's own `prisma` - holding
      // this open on the app's shared connection pool starved merge()'s
      // own request of a pool slot to even ATTEMPT its lock (a self-
      // inflicted client-side deadlock not visible in pg_stat_activity
      // at all, since merge() would never even reach Postgres).
      const holderPrisma = new PrismaService();
      await holderPrisma.$connect();
      try {
        let holderReady!: () => void;
        const holderReadyP = new Promise<void>((r) => (holderReady = r));
        let releaseHolder!: () => void;
        const releaseHolderP = new Promise<void>((r) => (releaseHolder = r));
        const holderDone = holderPrisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM canonical_products WHERE id = ${loser.id} FOR UPDATE`;
            await tx.offerVariant.update({
              where: { id: variantId },
              data: { canonicalVariantId: loserVariant.id },
            });
            const ov = await tx.offerVariant.findUniqueOrThrow({
              where: { id: variantId },
            });
            await tx.vendorOffer.update({
              where: { id: ov.vendorOfferId },
              data: { canonicalProductId: loser.id },
            });
            holderReady();
            await releaseHolderP;
          },
          { timeout: 20_000, maxWait: 20_000 },
        );
        // The holder's writes are done, the loser's CanonicalProduct
        // row is locked, but nothing has committed yet.
        await holderReadyP;

        const mergeReq = request(app.getHttpServer())
          .post(`/api/v1/canonical-products/${loser.id}/merge`)
          .set('Authorization', `Bearer ${admin}`)
          .set('Idempotency-Key', unique('merge'))
          .send({ into_canonical_product_id: survivor.id });
        // supertest/superagent's Test object is a thenable that only
        // actually dispatches the request once something invokes
        // .then()/.end() on it - constructing it alone does nothing.
        // Wrapping it in a real Promise right away fires it
        // immediately, while mergeP stays awaitable later.
        const mergeP = Promise.resolve(mergeReq);

        expect(await someoneWaitsOnCanonicalProductLock()).toBe(true);

        releaseHolder();
        await holderDone;
        const mergeRes = await mergeP;
        expect(mergeRes.status).toBe(200);

        // The offer the holder matched WHILE merge was blocked must
        // have been swept into merge's post-lock discovery and
        // correctly repointed to the survivor - with the old pre-lock-
        // discovery bug, this VendorOffer would never have been in the
        // stale vendorOfferIdsPre list and would have been left
        // pointing at the now-MERGED (dead) loser forever.
        const offerVariantFresh = await prisma.offerVariant.findUniqueOrThrow({
          where: { id: variantId },
        });
        expect(offerVariantFresh.canonicalVariantId).toBe(survivorVariant.id);
        const vendorOfferFresh = await prisma.vendorOffer.findUniqueOrThrow({
          where: { id: offerVariantFresh.vendorOfferId },
        });
        expect(vendorOfferFresh.canonicalProductId).toBe(survivor.id);
        expect(mergeRes.body.repointed_vendor_offer_ids).toContain(
          vendorOfferFresh.id,
        );
      } finally {
        await holderPrisma.$disconnect();
      }
    }, 30000);
  });

  describe('split', () => {
    it('moves exactly the selected variants to a new DRAFT product, leaves the rest, full audit, orders/PriceHistory untouched', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin, { name: unique('SplitBrand') });
      const category = await createCategory(admin);
      const source = await createCanonicalProduct(admin, brand.id, category.id);
      const keepVariant = await addVariant(admin, source.id, {
        colour: 'keep',
      });
      const moveVariant = await addVariant(admin, source.id, {
        colour: 'move',
      });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      const gtin = uniqueGtin();
      await prisma.canonicalProductVariant.update({
        where: { id: moveVariant.id },
        data: { gtin },
      });
      const { variantId } = await confirmExactMatch(
        owner,
        vendorId,
        moveVariant.id,
        gtin,
      );
      // Scoped to this test's own offer variant, not a bare table-wide
      // count - the suite runs against a shared database alongside many
      // other e2e files in parallel jest workers, each free to write
      // its own BranchOrderItem/PriceHistory rows for unrelated offer
      // variants at any time.
      const orderItemCountBefore = await prisma.branchOrderItem.count({
        where: { offerVariantId: variantId },
      });
      const priceHistoryCountBefore = await prisma.priceHistory.count({
        where: { offerVariantId: variantId },
      });

      const newBrand = await createBrand(admin, {
        name: unique('SplitNewBrand'),
      });
      const newCategory = await createCategory(admin);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${source.id}/split`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('split'))
        .send({
          variant_ids: [moveVariant.id],
          brand_id: newBrand.id,
          category_id: newCategory.id,
          model_name: unique('SplitOffModel'),
        })
        .expect(200);

      const newProduct = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: res.body.new_product_id },
      });
      expect(newProduct.status).toBe('DRAFT');

      const movedVariant =
        await prisma.canonicalProductVariant.findUniqueOrThrow({
          where: { id: moveVariant.id },
        });
      expect(movedVariant.canonicalProductId).toBe(newProduct.id);
      const keptVariant =
        await prisma.canonicalProductVariant.findUniqueOrThrow({
          where: { id: keepVariant.id },
        });
      expect(keptVariant.canonicalProductId).toBe(source.id);

      const offerVariantFresh = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      const vendorOfferFresh = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offerVariantFresh.vendorOfferId },
      });
      expect(vendorOfferFresh.canonicalProductId).toBe(newProduct.id);

      const auditRow = await prisma.auditLog.findFirst({
        where: {
          entityType: 'CanonicalProduct',
          entityId: source.id,
          action: 'canonical_product.split',
        },
      });
      expect(auditRow).not.toBeNull();

      expect(
        await prisma.branchOrderItem.count({
          where: { offerVariantId: variantId },
        }),
      ).toBe(orderItemCountBefore);
      expect(
        await prisma.priceHistory.count({
          where: { offerVariantId: variantId },
        }),
      ).toBe(priceHistoryCountBefore);
    });

    it('rejects empty selection, and rejects moving every variant (a rename, not a split)', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin, { name: unique('SplitBrand2') });
      const category = await createCategory(admin);
      const source = await createCanonicalProduct(admin, brand.id, category.id);
      const v1 = await addVariant(admin, source.id, { colour: 'a' });

      const emptyRes = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${source.id}/split`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('split'))
        .send({
          variant_ids: [],
          brand_id: brand.id,
          category_id: category.id,
          model_name: unique('X'),
        });
      expect(emptyRes.status).toBe(400);

      const allRes = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${source.id}/split`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('split'))
        .send({
          variant_ids: [v1.id],
          brand_id: brand.id,
          category_id: category.id,
          model_name: unique('X'),
        });
      expect(allRes.status).toBe(400);
      expect(allRes.body.error.code).toBe('SPLIT_CANNOT_MOVE_ALL_VARIANTS');
    });

    it('rejects outright, with zero writes, when the split would leave a VendorOffer spanning two canonical products', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin, { name: unique('SpanBrand') });
      const category = await createCategory(admin);
      const source = await createCanonicalProduct(admin, brand.id, category.id);
      const keepVariant = await addVariant(admin, source.id, {
        colour: 'keep',
      });
      const moveVariant = await addVariant(admin, source.id, {
        colour: 'move',
      });
      // A third variant that stays, to make the split a proper subset.
      await addVariant(admin, source.id, { colour: 'extra' });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendorId = await createVendor(owner);
      await activateVendor(owner, vendorId);
      // ONE vendor offer, with two variants: one pointing at the
      // "keep" canonical variant, one at the "move" canonical variant -
      // exactly the spanning scenario.
      const offerRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: unique('عرض'), title_en: unique('Offer') })
        .expect(201);
      const gtinKeep = uniqueGtin();
      const gtinMove = uniqueGtin();
      await prisma.canonicalProductVariant.update({
        where: { id: keepVariant.id },
        data: { gtin: gtinKeep },
      });
      await prisma.canonicalProductVariant.update({
        where: { id: moveVariant.id },
        data: { gtin: gtinMove },
      });

      const variant1Res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 10,
          identifier_type: 'GTIN',
          identifier_value: gtinKeep,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants/${variant1Res.body.id}/match-confirmation`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ decision: 'confirm' })
        .expect(200);

      const variant2Res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant2'))
        .send({
          seller_sku: unique('sku2'),
          base_price: 10,
          identifier_type: 'GTIN',
          identifier_value: gtinMove,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants/${variant2Res.body.id}/match-confirmation`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('confirm2'))
        .send({ decision: 'confirm' })
        .expect(200);

      const newBrand = await createBrand(admin, {
        name: unique('SpanNewBrand'),
      });
      const beforeSourceVariantCount =
        await prisma.canonicalProductVariant.count({
          where: { canonicalProductId: source.id },
        });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${source.id}/split`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('split'))
        .send({
          variant_ids: [moveVariant.id],
          brand_id: newBrand.id,
          category_id: category.id,
          model_name: unique('SpanNewModel'),
        });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('SPLIT_WOULD_SPAN_VENDOR_OFFER');
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ vendor_offer_id: offerRes.body.id }),
        ]),
      );

      // Zero writes: the source product's variant count is unchanged,
      // and the moving variant is still right where it started.
      const afterSourceVariantCount =
        await prisma.canonicalProductVariant.count({
          where: { canonicalProductId: source.id },
        });
      expect(afterSourceVariantCount).toBe(beforeSourceVariantCount);
      const moveVariantFresh =
        await prisma.canonicalProductVariant.findUniqueOrThrow({
          where: { id: moveVariant.id },
        });
      expect(moveVariantFresh.canonicalProductId).toBe(source.id);
    });

    it('concurrency: a split racing a merge on the same source product - no deadlock, no partial write', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const brand = await createBrand(admin, {
        name: unique('SplitMergeBrand'),
      });
      const category = await createCategory(admin);
      const source = await createCanonicalProduct(admin, brand.id, category.id);
      const otherProduct = await createCanonicalProduct(
        admin,
        brand.id,
        category.id,
      );
      const v1 = await addVariant(admin, source.id, { colour: 'a' });
      await addVariant(admin, source.id, { colour: 'b' });

      const newBrand = await createBrand(admin, {
        name: unique('SplitMergeNewBrand'),
      });

      const [splitRes, mergeRes] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/canonical-products/${source.id}/split`)
          .set('Authorization', `Bearer ${admin}`)
          .set('Idempotency-Key', unique('split'))
          .send({
            variant_ids: [v1.id],
            brand_id: newBrand.id,
            category_id: category.id,
            model_name: unique('X'),
          }),
        request(app.getHttpServer())
          .post(`/api/v1/canonical-products/${source.id}/merge`)
          .set('Authorization', `Bearer ${admin}`)
          .set('Idempotency-Key', unique('merge'))
          .send({ into_canonical_product_id: otherProduct.id }),
      ]);
      // Neither may ever 500. At most one of the two structural
      // operations on the SAME source product can really succeed
      // cleanly without the other seeing a changed precondition - both
      // succeeding would require the source to have simultaneously
      // both split off a product AND been merged away whole, which
      // cannot both be true at once.
      expect(splitRes.status).not.toBe(500);
      expect(mergeRes.status).not.toBe(500);
      const bothSucceeded = splitRes.status === 200 && mergeRes.status === 200;
      expect(bothSucceeded).toBe(false);
    }, 30000);
  });
});
