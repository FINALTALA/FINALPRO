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

// Same collision-avoidance rationale as auth.e2e-spec.ts's uniquePhone().
let phoneSeq = (Date.now() % 1_000_000) + 500_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97056${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 3 - catalog, matching, vendor verification, subscription (e2e)', () => {
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

  /** Out-of-band role grant, standing in for the seed script (see
   * scripts/seed-platform-staff.ts) - there is no self-service way to
   * acquire a PlatformRole, so tests grant it directly the same way. */
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

  async function createCategory(
    adminToken: string,
    nameEn: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', unique('cat'))
      .send({ name_ar: `تصنيف ${nameEn}`, name_en: nameEn })
      .expect(201);
    return res.body.id;
  }

  async function createBrand(
    adminToken: string,
    name: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/brands')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', unique('brand'))
      .send({ name })
      .expect(201);
    return res.body.id;
  }

  async function createVendorWithPhysicalBranch(
    ownerToken: string,
  ): Promise<{ vendorId: string; branchId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        branches: [{ name: 'Main branch', is_physical: true }],
      })
      .expect(201);
    return { vendorId: res.body.id, branchId: res.body.branches[0].id };
  }

  /** Full happy-path onboarding: apply -> evidence -> approve -> subscribe -> ACTIVE. */
  async function activateVendor(
    ownerToken: string,
    reviewerToken: string,
  ): Promise<string> {
    const { vendorId, branchId } =
      await createVendorWithPhysicalBranch(ownerToken);
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
      .send({ decision: 'approve' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/subscription`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('sub'))
      .send({ plan: 'BASIC' })
      .expect(201);
    return vendorId;
  }

  describe('categories (BL-CAT-001)', () => {
    it('a platform admin creates a category tree; reads are public', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const rootId = await createCategory(admin, unique('Phones'));

      const child = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('cat-child'))
        .send({
          name_ar: 'هواتف ذكية',
          name_en: 'Smartphones',
          parent_id: rootId,
        })
        .expect(201);

      const got = await request(app.getHttpServer())
        .get(`/api/v1/categories/${rootId}`)
        .expect(200);
      expect(got.body.children).toHaveLength(1);
      expect(got.body.children[0].id).toBe(child.body.id);
    });

    it('rejects a non-admin (customer) trying to create a category', async () => {
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('cat-forbidden'))
        .send({ name_ar: 'x', name_en: 'x' })
        .expect(403);
    });

    it('refuses to delete a category that has canonical products (409 CATEGORY_IN_USE)', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const categoryId = await createCategory(admin, unique('DeleteMe'));
      const brandId = await createBrand(admin, unique('Brand'));
      await request(app.getHttpServer())
        .post('/api/v1/canonical-products')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('cp'))
        .send({ brand_id: brandId, category_id: categoryId, model_name: 'X1' })
        .expect(201);

      await request(app.getHttpServer())
        .delete(`/api/v1/categories/${categoryId}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(409);
    });
  });

  describe('brands (FK-satisfying minimum for BL-MATCH-001)', () => {
    it('rejects a duplicate brand name (mechanical collision guard, not fuzzy detection)', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const name = unique('UniqueBrand');
      await createBrand(admin, name);
      await request(app.getHttpServer())
        .post('/api/v1/brands')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('brand-dup'))
        .send({ name: name.toUpperCase() }) // normalizedName collision despite different casing
        .expect(409);
    });
  });

  describe('canonical products/variants (BL-MATCH-001, FR-MATCH-008)', () => {
    it('creates a canonical product and a variant with a gtin', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const categoryId = await createCategory(admin, unique('Cat'));
      const brandId = await createBrand(admin, unique('Brand'));

      const product = await request(app.getHttpServer())
        .post('/api/v1/canonical-products')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('cp'))
        .send({
          brand_id: brandId,
          category_id: categoryId,
          model_name: 'Model X',
        })
        .expect(201);
      expect(product.body.status).toBe('DRAFT');

      const gtin = unique('gtin')
        .replace(/[^0-9]/g, '')
        .padEnd(12, '0');
      const variant = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${product.body.id}/variants`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('variant'))
        .send({ structural_attributes: { storage: '256GB' }, gtin })
        .expect(201);
      expect(variant.body.gtin).toBe(gtin);

      const got = await request(app.getHttpServer())
        .get(`/api/v1/canonical-products/${product.body.id}`)
        .expect(200);
      expect(got.body.variants).toHaveLength(1);
    });

    it('rejects a second variant reusing the same gtin (globally unique)', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const categoryId = await createCategory(admin, unique('Cat'));
      const brandId = await createBrand(admin, unique('Brand'));
      const p1 = await request(app.getHttpServer())
        .post('/api/v1/canonical-products')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('cp1'))
        .send({ brand_id: brandId, category_id: categoryId, model_name: 'M1' })
        .expect(201);
      const p2 = await request(app.getHttpServer())
        .post('/api/v1/canonical-products')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('cp2'))
        .send({ brand_id: brandId, category_id: categoryId, model_name: 'M2' })
        .expect(201);

      const gtin = unique('gtin')
        .replace(/[^0-9]/g, '')
        .padEnd(12, '0');
      await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${p1.body.id}/variants`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('v1'))
        .send({ structural_attributes: {}, gtin })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${p2.body.id}/variants`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('v2'))
        .send({ structural_attributes: {}, gtin })
        .expect(409);
    });
  });

  describe('vendor branch verification (BL-VEND-002/003)', () => {
    it('a reviewer approves the only physical branch and the vendor auto-advances to APPROVED', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const { vendorId, branchId } =
        await createVendorWithPhysicalBranch(owner);

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('evidence'))
        .send({
          lat: 32.0,
          lng: 35.0,
          verification_photo_url: 'https://example.com/p.jpg',
        })
        .expect(201);

      const decision = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-decision`,
        )
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('decision'))
        .send({ decision: 'approve' })
        .expect(201);

      expect(decision.body.verification_status).toBe('APPROVED');
      expect(decision.body.vendor_approved).toBe(true);

      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('APPROVED');
    });

    it('rejects a decision from a plain customer (no platform role) with 403', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const notReviewer = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } =
        await createVendorWithPhysicalBranch(owner);

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-decision`,
        )
        .set('Authorization', `Bearer ${notReviewer}`)
        .set('Idempotency-Key', unique('decision-forbidden'))
        .send({ decision: 'approve' })
        .expect(403);
    });

    it('request_resubmission records a reason and lets the owner resubmit, resetting status to PENDING', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const { vendorId, branchId } =
        await createVendorWithPhysicalBranch(owner);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('evidence'))
        .send({
          lat: 32.0,
          lng: 35.0,
          verification_photo_url: 'https://example.com/blurry.jpg',
        })
        .expect(201);

      const decision = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-decision`,
        )
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('decision'))
        .send({
          decision: 'request_resubmission',
          reason: 'Photo is too blurry',
        })
        .expect(201);
      expect(decision.body.verification_status).toBe('RESUBMISSION_REQUESTED');
      expect(decision.body.review_note).toBe('Photo is too blurry');
      expect(decision.body.vendor_approved).toBe(false);

      const resubmit = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('resubmit'))
        .send({
          lat: 32.0,
          lng: 35.0,
          verification_photo_url: 'https://example.com/clear.jpg',
        })
        .expect(201);
      expect(resubmit.body.verification_status).toBe('PENDING');
      expect(resubmit.body.review_note).toBeNull();
    });

    it('under two branches approved concurrently, the vendor is promoted to APPROVED exactly once (no lost update)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');

      const applyRes = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-2branch'))
        .send({
          legal_name: unique('TwoBranchVendor'),
          branches: [
            { name: 'Branch A', is_physical: true },
            { name: 'Branch B', is_physical: true },
          ],
        })
        .expect(201);
      const vendorId = applyRes.body.id;
      const [branchA, branchB] = applyRes.body.branches;

      for (const b of [branchA, branchB]) {
        await request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${b.id}/verification-evidence`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique(`evidence-${b.id}`))
          .send({
            lat: 32.0,
            lng: 35.0,
            verification_photo_url: 'https://example.com/p.jpg',
          })
          .expect(201);
      }

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchA.id}/verification-decision`,
          )
          .set('Authorization', `Bearer ${reviewer}`)
          .set('Idempotency-Key', unique('decision-a'))
          .send({ decision: 'approve' }),
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchB.id}/verification-decision`,
          )
          .set('Authorization', `Bearer ${reviewer}`)
          .set('Idempotency-Key', unique('decision-b'))
          .send({ decision: 'approve' }),
      ]);

      expect(resA.status).toBe(201);
      expect(resB.status).toBe(201);
      // Exactly one of the two decisions should be the one that observed
      // "all physical branches now approved" and flipped the vendor -
      // the row lock in the transaction serializes them, so this can
      // never be [false, false] even though both branches end up
      // APPROVED (the lost-update this test exists to catch).
      const approvedFlags = [
        resA.body.vendor_approved,
        resB.body.vendor_approved,
      ];
      expect(approvedFlags.filter(Boolean)).toHaveLength(1);

      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('APPROVED');
    });
  });

  describe('vendor subscription (BL-VEND-004, sandboxed - OPEN-003)', () => {
    it('rejects plan selection before the vendor is APPROVED', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithPhysicalBranch(owner);

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/subscription`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('sub-too-early'))
        .send({ plan: 'BASIC' })
        .expect(403);
    });

    it('an approved vendor selecting a plan activates immediately (simulated) and flips vendor.status to ACTIVE', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const vendorId = await activateVendor(owner, reviewer);

      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('ACTIVE');
      expect(vendor.subscriptionStatus).toBe('ACTIVE');

      const current = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/subscription`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(current.body.simulated).toBe(true);
      expect(current.body.plan).toBe('BASIC');
    });

    it('under two concurrent plan-selection requests for the same approved vendor, exactly one VendorSubscription row is created', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const { vendorId, branchId } =
        await createVendorWithPhysicalBranch(owner);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('evidence'))
        .send({
          lat: 32.0,
          lng: 35.0,
          verification_photo_url: 'https://example.com/p.jpg',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-decision`,
        )
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('decision'))
        .send({ decision: 'approve' })
        .expect(201);

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/subscription`)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('sub-race-a'))
          .send({ plan: 'BASIC' }),
        request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/subscription`)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('sub-race-b'))
          .send({ plan: 'STANDARD' }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      // One creates it (201); the other observes it's already active for
      // this vendor and is told so explicitly (409) - never both 201,
      // which would mean two VendorSubscription rows for one vendor.
      expect(statuses).toEqual([201, 409]);

      const subs = await prisma.vendorSubscription.findMany({
        where: { vendorId },
      });
      expect(subs).toHaveLength(1);
    });
  });

  describe('vendor offers + exact-match auto-link (BL-CAT-004b, BL-MATCH-002, BR-014, TC-MATCH-001)', () => {
    it('rejects offer creation while the vendor has no active subscription (BR-014)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithPhysicalBranch(owner);

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-too-early'))
        .send({ title_ar: 'منتج', title_en: 'Product' })
        .expect(403);
    });

    it('auto-links an offer variant whose gtin exactly matches an existing canonical variant (TC-MATCH-001)', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const vendorId = await activateVendor(owner, reviewer);

      const categoryId = await createCategory(admin, unique('Cat'));
      const brandId = await createBrand(admin, unique('Brand'));
      const product = await request(app.getHttpServer())
        .post('/api/v1/canonical-products')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('cp'))
        .send({
          brand_id: brandId,
          category_id: categoryId,
          model_name: 'Match Model',
        })
        .expect(201);
      const gtin = unique('gtin')
        .replace(/[^0-9]/g, '')
        .padEnd(12, '0');
      const canonicalVariant = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${product.body.id}/variants`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('variant'))
        .send({ structural_attributes: { storage: '128GB' }, gtin })
        .expect(201);

      const offer = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'منتج مطابق', title_en: 'Matching Product' })
        .expect(201);
      expect(offer.body.canonical_product_id).toBeNull();

      const variant = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 100,
          identifier_type: 'GTIN',
          identifier_value: gtin,
        })
        .expect(201);

      expect(variant.body.canonical_variant_id).toBe(canonicalVariant.body.id);

      const offerAfter = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const linked = offerAfter.body.find(
        (o: { id: string }) => o.id === offer.body.id,
      );
      expect(linked.canonical_product_id).toBe(product.body.id);
    });

    it('leaves an offer variant unmatched when its identifier matches nothing (FR-MATCH-009)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const vendorId = await activateVendor(owner, reviewer);

      const offer = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-unique'))
        .send({ title_ar: 'منتج فريد', title_en: 'Unique Product' })
        .expect(201);

      const variant = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-variant-unique'))
        .send({
          seller_sku: unique('sku'),
          base_price: 50,
          identifier_type: 'GTIN',
          identifier_value: '000000000000',
        })
        .expect(201);

      expect(variant.body.canonical_variant_id).toBeNull();
    });

    it('rejects a second offer variant reusing the same seller_sku for the same vendor (409)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const vendorId = await activateVendor(owner, reviewer);

      const offer = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-sku'))
        .send({ title_ar: 'منتج', title_en: 'Product' })
        .expect(201);

      const sku = unique('dup-sku');
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant-1'))
        .send({ seller_sku: sku, base_price: 10 })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant-2'))
        .send({ seller_sku: sku, base_price: 20 })
        .expect(409);
    });
  });
});
