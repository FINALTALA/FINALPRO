import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
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

// Palestinian mobile numbers validate (via class-validator's
// IsPhoneNumber -> libphonenumber-js/max) only under the 056/059
// prefixes - 057/058 parse but are not valid PS mobile numbers under
// that bundle (already found and documented once, in sprint4-roles.
// e2e-spec.ts's own uniquePhone() comment - the exact same mistake,
// independently repeated here and now fixed the same way: reuse "56"
// with a distinct numeric offset, not a distinct prefix).
let phoneSeq = (Date.now() % 1_000_000) + 900_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97056${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 8 - store sections, public discovery, comparison (e2e)', () => {
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

  // POST /auth/otp/request is throttled to 5/60s (FR-AUTH-011, stricter
  // than the 100/min global default) - observed empirically to apply
  // across this whole spec file's run, not reset per test, so a file
  // with many vendor setups (this one, uniquely among the e2e suite,
  // needs several INDEPENDENT vendors per test for price comparison)
  // can exceed it even though no single earlier sprint's spec file
  // ever needed to. Reviewer identity is otherwise interchangeable
  // across every vendor's verification decision (nothing ties a
  // decision to a specific reviewer account), so this cache lets many
  // vendors share ONE reviewer signup instead of one each - see also
  // getOrCreatePlatformAdmin() and the "share one owner across several
  // vendors" pattern used by the heavier comparison/discovery tests
  // below (one user may legitimately own multiple vendors).
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

  // Sprint 8's own helper (not reused from Sprint 7's confirmExactMatch,
  // which hardcodes base_price: 10) - comparison/discovery tests need
  // distinct, controllable prices across vendors.
  async function createConfirmedOffer(
    ownerToken: string,
    vendorId: string,
    canonicalVariantId: string,
    identifierValue: string,
    basePrice: number,
    salePrice?: number,
  ): Promise<{ offerId: string; variantId: string }> {
    // findExactMatch() (BR-001/FR-MATCH-002) only proposes a match when
    // identifier_value resolves to a REAL CanonicalProductVariant.gtin -
    // createCanonicalVariant() never sets one (structural_attributes
    // only), so it must be set here to this exact call's identifierValue
    // right before creating the offer (each call is self-contained: a
    // later call retargeting the same canonicalVariantId to a different
    // gtin never affects an earlier call's ALREADY-created/confirmed
    // offer, since matching resolves once at variant-creation time, not
    // live at confirm time - see vendor-offers.controller.ts's own
    // comment on proposedCanonicalVariantId). Same requirement already
    // established in Sprint 7's own e2e spec (see its confirmExactMatch
    // call sites, each preceded by this exact same update()).
    await prisma.canonicalProductVariant.update({
      where: { id: canonicalVariantId },
      data: { gtin: identifierValue },
    });
    const offerRes = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/offers`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('offer'))
      .send({ title_ar: unique('عنوان'), title_en: unique('Title') })
      .expect(201);
    const variantRes = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('variant'))
      .send({
        seller_sku: unique('sku'),
        base_price: basePrice,
        sale_price: salePrice,
        identifier_type: 'GTIN',
        identifier_value: identifierValue,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants/${variantRes.body.id}/match-confirmation`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('confirm'))
      .send({ decision: 'confirm' })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/status`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
    return { offerId: offerRes.body.id, variantId: variantRes.body.id };
  }

  async function addStock(
    ownerToken: string,
    vendorId: string,
    branchId: string,
    variantId: string,
    quantity: number,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/stock/${variantId}/movements`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('movement'))
      .send({
        reason: 'COUNT_CORRECTION',
        quantity_delta: quantity,
        reason_note: 'test setup',
      })
      .expect(201);
  }

  async function publishStorefront(
    ownerToken: string,
    vendorId: string,
  ): Promise<string> {
    await request(app.getHttpServer())
      .put(`/api/v1/vendors/${vendorId}/storefront`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ whatsapp_url: 'https://wa.me/1234567890' })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/api/v1/vendors/${vendorId}/applicable-categories`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ categories: ['WOMEN'] })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/storefront/publish`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const settings = await request(app.getHttpServer())
      .get(`/api/v1/vendors/${vendorId}/storefront`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return settings.body.slug as string;
  }

  // Same 5/60s OTP-request throttle reasoning as getOrCreateReviewer()
  // above - PLATFORM_ADMIN identity is also interchangeable across
  // every canonical-product/variant it creates.
  let cachedAdminToken: string | null = null;
  async function getOrCreatePlatformAdmin(): Promise<string> {
    if (!cachedAdminToken) {
      cachedAdminToken = await signupWithPlatformRole('PLATFORM_ADMIN');
    }
    return cachedAdminToken;
  }

  /** Full happy-path setup: one vendor, ACTIVE, published, subscribed,
   * with one confirmed+ACTIVE+in-stock offer against a fresh canonical
   * product - the baseline every comparison/discovery test builds on.
   * Pass ownerToken to attach this vendor to an ALREADY-signed-up owner
   * (one user may legitimately own several vendors) - callers that need
   * several vendors in one test use this to stay under the OTP-request
   * throttle instead of signing up a fresh owner per vendor. */
  async function setupEligibleOffer(basePrice = 100, ownerToken?: string) {
    const admin = await getOrCreatePlatformAdmin();
    const { canonicalProductId, variantId: canonicalVariantId } =
      await createCanonicalVariant(admin, unique('Brand'), unique('Model'), {
        color: 'Red',
      });
    const owner =
      ownerToken ?? (await signup(uniquePhone(), 'a-strong-password'));
    const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
    await activateVendorSubscription(owner, vendorId);
    const gtin = unique('gtin').slice(0, 20);
    const { offerId, variantId } = await createConfirmedOffer(
      owner,
      vendorId,
      canonicalVariantId,
      gtin,
      basePrice,
    );
    await addStock(owner, vendorId, branchAId, variantId, 10);
    const slug = await publishStorefront(owner, vendorId);
    return {
      admin,
      owner,
      vendorId,
      branchAId,
      slug,
      canonicalProductId,
      canonicalVariantId,
      offerId,
      variantId,
      gtin,
    };
  }

  describe('RB-STOREF-002: store sections (owner CRUD)', () => {
    it('an owner can create, rename, and delete a custom section', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ name: 'صيف 2026' })
        .expect(201);
      expect(created.body.name).toBe('صيف 2026');
      expect(created.body.sort_order).toBe(0);

      const renamed = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/sections/${created.body.id}`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ name: 'شتاء 2026' })
        .expect(200);
      expect(renamed.body.name).toBe('شتاء 2026');

      await request(app.getHttpServer())
        .delete(`/api/v1/vendors/${vendorId}/sections/${created.body.id}`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);

      const list = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(list.body).toHaveLength(0);
    });

    it('refuses a BRANCH_EMPLOYEE from creating, renaming, or deleting a section', async () => {
      const { vendorId, employeeToken } =
        await setupVendorWithTwoBranchesAndEmployee();

      const createRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ name: 'X' });
      expect(createRes.status).toBe(403);
      expect(createRes.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');

      const listRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${employeeToken}`);
      expect(listRes.status).toBe(403);
    });

    it("BOLA: an owner cannot rename or delete a DIFFERENT vendor's section", async () => {
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor1Id } = await createVendorWithTwoBranches(owner1);
      const section = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendor1Id}/sections`)
        .set('Authorization', `Bearer ${owner1}`)
        .send({ name: 'قسم المتجر الأول' })
        .expect(201);

      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2Id } = await createVendorWithTwoBranches(owner2);

      const renameRes = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendor2Id}/sections/${section.body.id}`)
        .set('Authorization', `Bearer ${owner2}`)
        .send({ name: 'مسروق' });
      expect(renameRes.status).toBe(404);
      expect(renameRes.body.error.code).toBe('STORE_SECTION_NOT_FOUND');

      const deleteRes = await request(app.getHttpServer())
        .delete(`/api/v1/vendors/${vendor2Id}/sections/${section.body.id}`)
        .set('Authorization', `Bearer ${owner2}`);
      expect(deleteRes.status).toBe(404);

      // Untouched - still exists for its real owner.
      const stillThere = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendor1Id}/sections`)
        .set('Authorization', `Bearer ${owner1}`)
        .expect(200);
      expect(stillThere.body).toHaveLength(1);
    });

    it('enforces the 20-custom-section limit, including under concurrency', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);

      for (let i = 0; i < 20; i += 1) {
        await request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/sections`)
          .set('Authorization', `Bearer ${owner}`)
          .send({ name: `Section ${i}` })
          .expect(201);
      }

      const overLimit = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ name: 'Section 21' });
      expect(overLimit.status).toBe(403);
      expect(overLimit.body.error.code).toBe('STORE_SECTION_LIMIT_REACHED');

      const count = await prisma.storeSection.count({ where: { vendorId } });
      expect(count).toBe(20);
    });

    it('two concurrent creates at the 19-section mark never both succeed past the 20 cap', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      for (let i = 0; i < 19; i += 1) {
        await request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/sections`)
          .set('Authorization', `Bearer ${owner}`)
          .send({ name: `Section ${i}` })
          .expect(201);
      }

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/sections`)
          .set('Authorization', `Bearer ${owner}`)
          .send({ name: 'Race A' }),
        request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/sections`)
          .set('Authorization', `Bearer ${owner}`)
          .send({ name: 'Race B' }),
      ]);
      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 403]);

      const count = await prisma.storeSection.count({ where: { vendorId } });
      expect(count).toBe(20);
    });

    it("reorder rejects a set that does not exactly match this vendor's own custom sections", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      const a = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ name: 'A' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ name: 'B' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections/reorder`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ section_ids: [a.body.id, 'not-a-real-id'] });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('STORE_SECTION_REORDER_MISMATCH');
    });

    it('reorder reassigns sort_order to match the submitted order', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      const a = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ name: 'A' })
        .expect(201);
      const b = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ name: 'B' })
        .expect(201);

      const reordered = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections/reorder`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ section_ids: [b.body.id, a.body.id] })
        .expect(200);
      expect(reordered.body[0].id).toBe(b.body.id);
      expect(reordered.body[0].sort_order).toBe(0);
      expect(reordered.body[1].id).toBe(a.body.id);
      expect(reordered.body[1].sort_order).toBe(1);
    });

    it('PDR-012: deleting a section removes only the grouping - the offer itself is untouched', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);
      const offerRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'منتج', title_en: 'Product' })
        .expect(201);
      const section = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ name: 'قسم' })
        .expect(201);
      await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/sections/${section.body.id}/offers/${offerRes.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/api/v1/vendors/${vendorId}/sections/${section.body.id}`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);

      const offerStillExists = await prisma.vendorOffer.findUnique({
        where: { id: offerRes.body.id },
      });
      expect(offerStillExists).not.toBeNull();
      const membershipGone = await prisma.storeSectionOffer.findMany({
        where: { sectionId: section.body.id },
      });
      expect(membershipGone).toHaveLength(0);
    });

    it('PDR-012: a single offer can belong to several custom sections at once', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);
      const offerRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'منتج', title_en: 'Product' })
        .expect(201);
      const sectionA = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ name: 'A' })
        .expect(201);
      const sectionB = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ name: 'B' })
        .expect(201);

      await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/sections/${sectionA.body.id}/offers/${offerRes.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/sections/${sectionB.body.id}/offers/${offerRes.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);

      const list = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(
        list.body.find((s: { id: string }) => s.id === sectionA.body.id)
          .offer_ids,
      ).toContain(offerRes.body.id);
      expect(
        list.body.find((s: { id: string }) => s.id === sectionB.body.id)
          .offer_ids,
      ).toContain(offerRes.body.id);
    });

    it("BOLA: cannot add a DIFFERENT vendor's offer to a section", async () => {
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor1Id } = await createVendorWithTwoBranches(owner1);
      const section = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendor1Id}/sections`)
        .set('Authorization', `Bearer ${owner1}`)
        .send({ name: 'قسم' })
        .expect(201);

      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2Id } = await createVendorWithTwoBranches(owner2);
      await activateVendorSubscription(owner2, vendor2Id);
      const foreignOffer = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendor2Id}/offers`)
        .set('Authorization', `Bearer ${owner2}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'منتج', title_en: 'Product' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendor1Id}/sections/${section.body.id}/offers/${foreignOffer.body.id}`,
        )
        .set('Authorization', `Bearer ${owner1}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('VENDOR_OFFER_NOT_FOUND');
    });
  });

  describe('RB-STOREF-002: public sections read', () => {
    it('the public sections endpoint returns All, New arrivals, Discounts, and custom sections', async () => {
      const { owner, vendorId, branchAId, slug } = await setupEligibleOffer();
      // A second offer, discounted, to land in "Discounts".
      const discountedOffer = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'مخفض', title_en: 'Discounted' })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${discountedOffer.body.id}/variants`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant'))
        .send({ seller_sku: unique('sku'), base_price: 50, sale_price: 30 })
        .expect(201);
      await request(app.getHttpServer())
        .patch(
          `/api/v1/vendors/${vendorId}/offers/${discountedOffer.body.id}/status`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ status: 'ACTIVE' })
        .expect(200);

      const section = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/sections`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ name: 'مميز' })
        .expect(201);
      await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/sections/${section.body.id}/offers/${discountedOffer.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}/sections`)
        .expect(200);
      expect(res.body.is_available).toBe(true);
      expect(res.body.all).toHaveLength(2);
      expect(res.body.new_arrivals).toHaveLength(2);
      expect(res.body.discounts).toHaveLength(1);
      expect(res.body.discounts[0].id).toBe(discountedOffer.body.id);
      expect(res.body.custom).toHaveLength(1);
      expect(res.body.custom[0].name).toBe('مميز');
      expect(res.body.custom[0].offers).toHaveLength(1);
      void branchAId;
    });

    it('an unavailable store reports empty sections, never a stale catalog', async () => {
      const { vendorId, slug, owner } = await setupEligibleOffer();
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/storefront/unpublish`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}/sections`)
        .expect(200);
      expect(res.body.is_available).toBe(false);
      expect(res.body.all).toHaveLength(0);
    });

    it('never exposes exact stock quantities - only the availability bucket', async () => {
      const { slug } = await setupEligibleOffer();
      const res = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}/sections`)
        .expect(200);
      expect(res.body.all[0].availability).toBe('available');
      expect(JSON.stringify(res.body)).not.toMatch(/quantity/i);
    });
  });

  describe('RB-STOREF-004/RB-COMP-001: public offer detail inside a store', () => {
    it("returns an ACTIVE offer's variants with price and availability, never exact stock", async () => {
      const { slug, offerId } = await setupEligibleOffer();
      const res = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}/offers/${offerId}`)
        .expect(200);
      expect(res.body.id).toBe(offerId);
      expect(res.body.variants[0].availability).toBe('available');
      expect(res.body.variants[0].base_price).toBe('100');
      expect(JSON.stringify(res.body)).not.toMatch(/quantity/i);
    });

    // Round 4 review fix (RB-COMP-001, PDR-015): the "compare prices"
    // link the store product page now shows for a matched variant needs
    // canonical_product_id in this exact response - this proves the
    // data is actually there for a CONFIRMED match, and absent (never
    // guessed from canonical_variant_id) for a genuinely unmatched one.
    it('reports canonical_product_id for a confirmed-match variant, and null for an unmatched one', async () => {
      const matched = await setupEligibleOffer();
      const matchedRes = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${matched.slug}/offers/${matched.offerId}`)
        .expect(200);
      expect(matchedRes.body.variants[0].canonical_variant_id).toBe(
        matched.canonicalVariantId,
      );
      expect(matchedRes.body.variants[0].canonical_product_id).toBe(
        matched.canonicalProductId,
      );

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);
      const unmatchedOffer = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'غير مطابق', title_en: 'Unmatched' })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${unmatchedOffer.body.id}/variants`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant'))
        .send({ seller_sku: unique('sku'), base_price: 50 })
        .expect(201);
      await request(app.getHttpServer())
        .patch(
          `/api/v1/vendors/${vendorId}/offers/${unmatchedOffer.body.id}/status`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ status: 'ACTIVE' })
        .expect(200);
      const slug = await publishStorefront(owner, vendorId);

      const unmatchedRes = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}/offers/${unmatchedOffer.body.id}`)
        .expect(200);
      expect(unmatchedRes.body.variants[0].canonical_variant_id).toBeNull();
      expect(unmatchedRes.body.variants[0].canonical_product_id).toBeNull();
    });

    it("404s for another vendor's offer id, an INACTIVE offer, or a nonexistent offer", async () => {
      const setupA = await setupEligibleOffer();
      const setupB = await setupEligibleOffer();

      const crossVendor = await request(app.getHttpServer()).get(
        `/api/v1/storefronts/${setupA.slug}/offers/${setupB.offerId}`,
      );
      expect(crossVendor.status).toBe(404);

      await request(app.getHttpServer())
        .patch(
          `/api/v1/vendors/${setupA.vendorId}/offers/${setupA.offerId}/status`,
        )
        .set('Authorization', `Bearer ${setupA.owner}`)
        .send({ status: 'INACTIVE' })
        .expect(200);
      const inactive = await request(app.getHttpServer()).get(
        `/api/v1/storefronts/${setupA.slug}/offers/${setupA.offerId}`,
      );
      expect(inactive.status).toBe(404);

      const missing = await request(app.getHttpServer()).get(
        `/api/v1/storefronts/${setupA.slug}/offers/does-not-exist`,
      );
      expect(missing.status).toBe(404);
    });
  });

  describe('RB-STOREF-004: applicable categories', () => {
    it('owner-only get/put; a vendor is registered WITH a category already (PDR-013 requires it at registration, not just before publish), and can edit WHICH categories apply', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);

      // createVendorWithTwoBranches() already registers with ['WOMEN'] -
      // confirm that landed for real, not just accepted and dropped.
      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/applicable-categories`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(getRes.body.categories).toEqual(['WOMEN']);

      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/applicable-categories`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ categories: ['WOMEN', 'KIDS'] })
        .expect(200);

      const getAfter = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/applicable-categories`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(getAfter.body.categories.sort()).toEqual(['KIDS', 'WOMEN']);

      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/storefront`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ whatsapp_url: 'https://wa.me/1234567890' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/storefront/publish`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
    });

    // Round 3 review fix: a store is ALWAYS required to hold >=1
    // category from registration onward - editing may change WHICH
    // categories apply, never clear the set to none. Round 2 left the
    // edit endpoint accepting an empty array, which would have let an
    // owner of an ALREADY-PUBLISHED store clear every category and
    // stay published with none (publish()'s own >=1 check only ever
    // runs at the moment of publishing, not continuously).
    it('rejects clearing applicable_categories to empty via the edit endpoint - the previous categories are left unchanged in the database', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/applicable-categories`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ categories: ['WOMEN', 'KIDS'] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/applicable-categories`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ categories: [] });
      expect(res.status).toBe(400);

      const stillThere = await prisma.vendorApplicableCategory.findMany({
        where: { vendorId },
      });
      expect(stillThere.map((r) => r.category).sort()).toEqual([
        'KIDS',
        'WOMEN',
      ]);
    });

    it('the publish-time >=1 check still backstops a vendor with zero categories (e.g. historical data predating the registration-time requirement)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      // Simulate pre-existing data from before this requirement existed
      // - direct DB manipulation, not reachable through any endpoint
      // anymore (registration always creates >=1; the edit endpoint can
      // no longer clear to zero either, per the fix above).
      await prisma.vendorApplicableCategory.deleteMany({ where: { vendorId } });

      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/storefront`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ whatsapp_url: 'https://wa.me/1234567890' })
        .expect(200);
      const failRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/storefront/publish`)
        .set('Authorization', `Bearer ${owner}`);
      expect(failRes.status).toBe(403);
      expect(failRes.body.error.code).toBe('APPLICABLE_CATEGORY_REQUIRED');

      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/applicable-categories`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ categories: ['ACCESSORIES'] })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/storefront/publish`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
    });

    it('PDR-013 round 2: registering WITHOUT applicable_categories is refused with a clear 400, registering WITH them persists exactly that set, and duplicates/invalid values are refused', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');

      const missingLegalName = unique('Vendor');
      const missingRes = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: missingLegalName,
          store_type: 'PHYSICAL',
          branches: [{ name: 'Main branch', is_physical: true }],
          applicable_categories: [],
        });
      expect(missingRes.status).toBe(400);
      // The whole transaction (vendor + branches + categories) must
      // never partially land - confirms this isn't validated too late
      // to matter.
      expect(
        await prisma.vendor.findFirst({
          where: { legalName: missingLegalName },
        }),
      ).toBeNull();

      const missingFieldRes = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          store_type: 'PHYSICAL',
          branches: [{ name: 'Main branch', is_physical: true }],
        });
      expect(missingFieldRes.status).toBe(400);

      const duplicateRes = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          store_type: 'PHYSICAL',
          branches: [{ name: 'Main branch', is_physical: true }],
          applicable_categories: ['WOMEN', 'WOMEN'],
        });
      expect(duplicateRes.status).toBe(400);

      const invalidValueRes = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          store_type: 'PHYSICAL',
          branches: [{ name: 'Main branch', is_physical: true }],
          applicable_categories: ['NOT_A_REAL_CATEGORY'],
        });
      expect(invalidValueRes.status).toBe(400);

      const successRes = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          store_type: 'PHYSICAL',
          branches: [{ name: 'Main branch', is_physical: true }],
          applicable_categories: ['MEN', 'ACCESSORIES'],
        })
        .expect(201);
      expect(successRes.body.applicable_categories.sort()).toEqual([
        'ACCESSORIES',
        'MEN',
      ]);

      const persisted = await prisma.vendorApplicableCategory.findMany({
        where: { vendorId: successRes.body.id },
      });
      expect(persisted.map((r) => r.category).sort()).toEqual([
        'ACCESSORIES',
        'MEN',
      ]);

      // Readable straight away via the owner-only endpoint too.
      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${successRes.body.id}/applicable-categories`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(getRes.body.categories.sort()).toEqual(['ACCESSORIES', 'MEN']);
    });

    it('refuses a BRANCH_EMPLOYEE from reading or editing applicable categories', async () => {
      const { vendorId, employeeToken } =
        await setupVendorWithTwoBranchesAndEmployee();
      const readRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/applicable-categories`)
        .set('Authorization', `Bearer ${employeeToken}`);
      expect(readRes.status).toBe(403);
      const writeRes = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/applicable-categories`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ categories: ['MEN'] });
      expect(writeRes.status).toBe(403);
    });
  });

  describe('Offer status endpoint (prerequisite plumbing)', () => {
    it('owner can move an offer to ACTIVE and back; a BRANCH_EMPLOYEE cannot', async () => {
      const { vendorId, employeeToken, owner } =
        await setupVendorWithTwoBranchesAndEmployee();
      await activateVendorSubscription(owner, vendorId);
      const offerRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'منتج', title_en: 'Product' })
        .expect(201);
      expect(offerRes.body.status).toBe('DRAFT');

      const forbidden = await request(app.getHttpServer())
        .patch(`/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/status`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ status: 'ACTIVE' });
      expect(forbidden.status).toBe(403);

      const activated = await request(app.getHttpServer())
        .patch(`/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/status`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ status: 'ACTIVE' })
        .expect(200);
      expect(activated.body.status).toBe('ACTIVE');
    });

    it("BOLA: cannot update a DIFFERENT vendor's offer status", async () => {
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor1Id } = await createVendorWithTwoBranches(owner1);
      await activateVendorSubscription(owner1, vendor1Id);
      const offer = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendor1Id}/offers`)
        .set('Authorization', `Bearer ${owner1}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'منتج', title_en: 'Product' })
        .expect(201);

      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2Id } = await createVendorWithTwoBranches(owner2);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/vendors/${vendor2Id}/offers/${offer.body.id}/status`)
        .set('Authorization', `Bearer ${owner2}`)
        .send({ status: 'ACTIVE' });
      expect(res.status).toBe(404);
    });
  });

  describe('RB-COMP-001: comparison card', () => {
    it('shows the lowest available price and the cheapest offer as the click target', async () => {
      const setup = await setupEligibleOffer(100);
      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/canonical-products/${setup.canonicalProductId}/comparison-card`,
        )
        .expect(200);
      expect(res.body.lowest_price).toBe('100.00');
      expect(res.body.lowest_price_availability).toBe('available');
      expect(res.body.cheapest_offer.vendor_slug).toBe(setup.slug);
      expect(res.body.cheapest_offer.offer_id).toBe(setup.offerId);
      expect(res.body.store_logos).toHaveLength(1);
    });

    it('ranks by price and returns up to 5 distinct-vendor logos, cheapest first', async () => {
      const admin = await getOrCreatePlatformAdmin();
      const { canonicalProductId, variantId: canonicalVariantId } =
        await createCanonicalVariant(admin, unique('Brand'), unique('Model'));

      // One shared owner account owning 7 DISTINCT vendors - legitimate
      // (VendorUser only forbids the SAME user/vendor pair twice, never
      // one user owning several vendors) and necessary to stay under
      // the 5/60s OTP-request throttle (FR-AUTH-011) this many vendor
      // setups would otherwise exceed.
      const sharedOwner = await signup(uniquePhone(), 'a-strong-password');
      const prices = [500, 100, 300, 200, 400, 600, 700];
      const slugs: string[] = [];
      for (const price of prices) {
        const owner = sharedOwner;
        const { vendorId, branchAId } =
          await createVendorWithTwoBranches(owner);
        await activateVendorSubscription(owner, vendorId);
        const gtin = unique('gtin').slice(0, 20);
        const { variantId } = await createConfirmedOffer(
          owner,
          vendorId,
          canonicalVariantId,
          gtin,
          price,
        );
        await addStock(owner, vendorId, branchAId, variantId, 10);
        const slug = await publishStorefront(owner, vendorId);
        slugs.push(slug);
      }

      const res = await request(app.getHttpServer())
        .get(`/api/v1/canonical-products/${canonicalProductId}/comparison-card`)
        .expect(200);
      expect(res.body.lowest_price).toBe('100.00');
      expect(res.body.store_logos).toHaveLength(5);
      const logoPrices = res.body.store_logos.map(
        (l: { price: string }) => l.price,
      );
      expect(logoPrices).toEqual([
        '100.00',
        '200.00',
        '300.00',
        '400.00',
        '500.00',
      ]);
    });

    it('excludes sold-out offers from the lowest-price figure when a cheaper available offer exists', async () => {
      const admin = await getOrCreatePlatformAdmin();
      const { canonicalProductId, variantId: canonicalVariantId } =
        await createCanonicalVariant(admin, unique('Brand'), unique('Model'));

      // Cheaper but sold out.
      const soldOutOwner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: soldOutVendorId } =
        await createVendorWithTwoBranches(soldOutOwner);
      await activateVendorSubscription(soldOutOwner, soldOutVendorId);
      await createConfirmedOffer(
        soldOutOwner,
        soldOutVendorId,
        canonicalVariantId,
        unique('gtin').slice(0, 20),
        50,
      );
      await publishStorefront(soldOutOwner, soldOutVendorId);

      // Pricier but actually available.
      const availableOwner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: availableVendorId, branchAId } =
        await createVendorWithTwoBranches(availableOwner);
      await activateVendorSubscription(availableOwner, availableVendorId);
      const { variantId } = await createConfirmedOffer(
        availableOwner,
        availableVendorId,
        canonicalVariantId,
        unique('gtin').slice(0, 20),
        80,
      );
      await addStock(
        availableOwner,
        availableVendorId,
        branchAId,
        variantId,
        10,
      );
      const availableSlug = await publishStorefront(
        availableOwner,
        availableVendorId,
      );

      const res = await request(app.getHttpServer())
        .get(`/api/v1/canonical-products/${canonicalProductId}/comparison-card`)
        .expect(200);
      expect(res.body.lowest_price).toBe('80.00');
      expect(res.body.lowest_price_availability).toBe('available');
      expect(res.body.cheapest_offer.vendor_slug).toBe(availableSlug);
    });

    it('falls back to the lowest price among ALL eligible offers when every one is sold out (documented fallback)', async () => {
      const setup = await setupEligibleOffer(150);
      // Deplete the stock the setup helper added.
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${setup.vendorId}/branches/${setup.branchAId}/stock/${setup.variantId}/movements`,
        )
        .set('Authorization', `Bearer ${setup.owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({ reason: 'DAMAGE', quantity_delta: -10, reason_note: 'test' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/canonical-products/${setup.canonicalProductId}/comparison-card`,
        )
        .expect(200);
      expect(res.body.lowest_price).toBe('150.00');
      expect(res.body.lowest_price_availability).toBe('sold_out');
    });

    it('excludes an unconfirmed (merely proposed) match and an INACTIVE offer from eligibility', async () => {
      const admin = await getOrCreatePlatformAdmin();
      const { canonicalProductId, variantId: canonicalVariantId } =
        await createCanonicalVariant(admin, unique('Brand'), unique('Model'));

      // Proposed, never confirmed.
      const proposer = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: proposerVendorId } =
        await createVendorWithTwoBranches(proposer);
      await activateVendorSubscription(proposer, proposerVendorId);
      const gtin = unique('gtin').slice(0, 20);
      // Create the canonical variant's own gtin so the exact-match
      // proposal fires, but never confirm it.
      await prisma.canonicalProductVariant.update({
        where: { id: canonicalVariantId },
        data: { gtin },
      });
      const offerRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${proposerVendorId}/offers`)
        .set('Authorization', `Bearer ${proposer}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'منتج', title_en: 'Product' })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${proposerVendorId}/offers/${offerRes.body.id}/variants`,
        )
        .set('Authorization', `Bearer ${proposer}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 10,
          identifier_type: 'GTIN',
          identifier_value: gtin,
        })
        .expect(201);
      await publishStorefront(proposer, proposerVendorId);

      const noEligibleRes = await request(app.getHttpServer()).get(
        `/api/v1/canonical-products/${canonicalProductId}/comparison-card`,
      );
      expect(noEligibleRes.status).toBe(404);
      expect(noEligibleRes.body.error.code).toBe('NO_ELIGIBLE_OFFERS');

      // Now a second vendor confirms a match but leaves the offer
      // DRAFT (never activated) - still not eligible.
      const draftOwner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: draftVendorId } =
        await createVendorWithTwoBranches(draftOwner);
      await activateVendorSubscription(draftOwner, draftVendorId);
      const draftOfferRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${draftVendorId}/offers`)
        .set('Authorization', `Bearer ${draftOwner}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'م', title_en: 'P' })
        .expect(201);
      const draftVariantRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${draftVendorId}/offers/${draftOfferRes.body.id}/variants`,
        )
        .set('Authorization', `Bearer ${draftOwner}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 10,
          identifier_type: 'GTIN',
          identifier_value: gtin,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${draftVendorId}/offers/${draftOfferRes.body.id}/variants/${draftVariantRes.body.id}/match-confirmation`,
        )
        .set('Authorization', `Bearer ${draftOwner}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ decision: 'confirm' })
        .expect(200);
      // Deliberately never PATCHed to ACTIVE.
      await publishStorefront(draftOwner, draftVendorId);

      const stillNoneRes = await request(app.getHttpServer()).get(
        `/api/v1/canonical-products/${canonicalProductId}/comparison-card`,
      );
      expect(stillNoneRes.status).toBe(404);
    });

    it('excludes an offer from an unpublished/unavailable store', async () => {
      const setup = await setupEligibleOffer();
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${setup.vendorId}/storefront/unpublish`)
        .set('Authorization', `Bearer ${setup.owner}`)
        .expect(200);

      const res = await request(app.getHttpServer()).get(
        `/api/v1/canonical-products/${setup.canonicalProductId}/comparison-card`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('RB-COMP-001: full comparison page', () => {
    it('lists every eligible offer cheapest to priciest and never exposes exact stock', async () => {
      const admin = await getOrCreatePlatformAdmin();
      const { canonicalProductId, variantId: canonicalVariantId } =
        await createCanonicalVariant(admin, unique('Brand'), unique('Model'));
      const sharedOwner = await signup(uniquePhone(), 'a-strong-password');
      for (const price of [300, 100, 200]) {
        const owner = sharedOwner;
        const { vendorId, branchAId } =
          await createVendorWithTwoBranches(owner);
        await activateVendorSubscription(owner, vendorId);
        const { variantId } = await createConfirmedOffer(
          owner,
          vendorId,
          canonicalVariantId,
          unique('gtin').slice(0, 20),
          price,
        );
        await addStock(owner, vendorId, branchAId, variantId, 10);
        await publishStorefront(owner, vendorId);
      }

      const res = await request(app.getHttpServer())
        .get(`/api/v1/canonical-products/${canonicalProductId}/comparison`)
        .expect(200);
      expect(res.body.offers.map((o: { price: string }) => o.price)).toEqual([
        '100.00',
        '200.00',
        '300.00',
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/quantity/i);
    });

    it('canonical_variant_id filters the list to matching offers only, while the variant picker stays complete', async () => {
      const admin = await getOrCreatePlatformAdmin();
      const { canonicalProductId, variantId: redVariantId } =
        await createCanonicalVariant(admin, unique('Brand'), unique('Model'), {
          color: 'Red',
        });
      const blueVariantRes = await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${canonicalProductId}/variants`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('cpv'))
        .send({ structural_attributes: { color: 'Blue' } })
        .expect(201);
      const blueVariantId = blueVariantRes.body.id;

      const sharedOwner = await signup(uniquePhone(), 'a-strong-password');
      const redOwner = sharedOwner;
      const { vendorId: redVendorId, branchAId: redBranchId } =
        await createVendorWithTwoBranches(redOwner);
      await activateVendorSubscription(redOwner, redVendorId);
      const { variantId: redOfferVariantId } = await createConfirmedOffer(
        redOwner,
        redVendorId,
        redVariantId,
        unique('gtin').slice(0, 20),
        100,
      );
      await addStock(redOwner, redVendorId, redBranchId, redOfferVariantId, 10);
      await publishStorefront(redOwner, redVendorId);

      const blueOwner = sharedOwner;
      const { vendorId: blueVendorId, branchAId: blueBranchId } =
        await createVendorWithTwoBranches(blueOwner);
      await activateVendorSubscription(blueOwner, blueVendorId);
      const { variantId: blueOfferVariantId } = await createConfirmedOffer(
        blueOwner,
        blueVendorId,
        blueVariantId,
        unique('gtin').slice(0, 20),
        120,
      );
      await addStock(
        blueOwner,
        blueVendorId,
        blueBranchId,
        blueOfferVariantId,
        10,
      );
      await publishStorefront(blueOwner, blueVendorId);

      const unfiltered = await request(app.getHttpServer())
        .get(`/api/v1/canonical-products/${canonicalProductId}/comparison`)
        .expect(200);
      expect(unfiltered.body.offers).toHaveLength(2);
      expect(unfiltered.body.variants).toHaveLength(2);

      const filtered = await request(app.getHttpServer())
        .get(
          `/api/v1/canonical-products/${canonicalProductId}/comparison?canonical_variant_id=${redVariantId}`,
        )
        .expect(200);
      expect(filtered.body.offers).toHaveLength(1);
      expect(filtered.body.offers[0].canonical_variant_id).toBe(redVariantId);
      // The picker itself still shows BOTH options even while filtered.
      expect(filtered.body.variants).toHaveLength(2);
    });

    it('reports availability buckets correctly: available, low_stock (1-3), sold_out', async () => {
      const admin = await getOrCreatePlatformAdmin();
      const { canonicalProductId, variantId: canonicalVariantId } =
        await createCanonicalVariant(admin, unique('Brand'), unique('Model'));

      const buckets: { qty: number; expected: string }[] = [
        { qty: 10, expected: 'available' },
        { qty: 2, expected: 'low_stock' },
        { qty: 0, expected: 'sold_out' },
      ];
      const sharedOwner = await signup(uniquePhone(), 'a-strong-password');
      for (const b of buckets) {
        const owner = sharedOwner;
        const { vendorId, branchAId } =
          await createVendorWithTwoBranches(owner);
        await activateVendorSubscription(owner, vendorId);
        const { variantId } = await createConfirmedOffer(
          owner,
          vendorId,
          canonicalVariantId,
          unique('gtin').slice(0, 20),
          100,
        );
        if (b.qty > 0) {
          await addStock(owner, vendorId, branchAId, variantId, b.qty);
        }
        await publishStorefront(owner, vendorId);
      }

      const res = await request(app.getHttpServer())
        .get(`/api/v1/canonical-products/${canonicalProductId}/comparison`)
        .expect(200);
      const availabilities = res.body.offers
        .map((o: { availability: string }) => o.availability)
        .sort();
      expect(availabilities).toEqual(['available', 'low_stock', 'sold_out']);
    });

    it('404s when the canonical product has no eligible offers, and 404s for a nonexistent product', async () => {
      const admin = await getOrCreatePlatformAdmin();
      const { canonicalProductId } = await createCanonicalVariant(
        admin,
        unique('Brand'),
        unique('Model'),
      );
      const noneRes = await request(app.getHttpServer()).get(
        `/api/v1/canonical-products/${canonicalProductId}/comparison`,
      );
      expect(noneRes.status).toBe(404);
      expect(noneRes.body.error.code).toBe('NO_ELIGIBLE_OFFERS');

      const missingRes = await request(app.getHttpServer()).get(
        '/api/v1/canonical-products/does-not-exist/comparison',
      );
      expect(missingRes.status).toBe(404);
      expect(missingRes.body.error.code).toBe('CANONICAL_PRODUCT_NOT_FOUND');
    });
  });

  describe('RB-STOREF-004: discovery All page', () => {
    it('lists only canonical products with at least one eligible offer, newest-first', async () => {
      const sharedOwner = await signup(uniquePhone(), 'a-strong-password');
      const older = await setupEligibleOffer(100, sharedOwner);
      // Ensure a strictly later createdAt for deterministic ordering.
      await prisma.canonicalProduct.update({
        where: { id: older.canonicalProductId },
        data: { createdAt: new Date(Date.now() - 60_000) },
      });
      const newer = await setupEligibleOffer(200, sharedOwner);

      // A third canonical product with NO eligible offer at all - must
      // never appear.
      const admin = await getOrCreatePlatformAdmin();
      const { canonicalProductId: noOfferProductId } =
        await createCanonicalVariant(admin, unique('Brand'), unique('Model'));

      // Sprint 8 review note: discovery is deliberately GLOBAL, not
      // vendor/tenant-scoped (that's the whole point of the feature),
      // so unlike every other e2e spec in this suite, this test cannot
      // assume it's the only data in the DB - other tests in this same
      // file (and any prior spec run against the same test DB) may
      // already have their own eligible canonical products present.
      // Assertions below only ever check RELATIVE ordering and
      // presence/absence of the specific ids this test itself created,
      // never an exact total count.
      const res = await request(app.getHttpServer())
        .get('/api/v1/discovery/all?page_size=50')
        .expect(200);
      const ids = res.body.items.map(
        (i: { canonical_product_id: string }) => i.canonical_product_id,
      );
      expect(ids.indexOf(newer.canonicalProductId)).toBeLessThan(
        ids.indexOf(older.canonicalProductId),
      );
      expect(ids).not.toContain(noOfferProductId);
    });

    it('paginates with page/page_size', async () => {
      // Same "discovery is global, don't assume an empty DB" note as
      // the test above - captures the total BEFORE creating anything,
      // then asserts the total grew by exactly 3 and that pagination's
      // own mechanics (no overlap, no gap between consecutive pages)
      // hold, rather than asserting an absolute total.
      const before = await request(app.getHttpServer())
        .get('/api/v1/discovery/all?page=1&page_size=1')
        .expect(200);
      const totalBefore = before.body.total as number;

      const sharedOwner = await signup(uniquePhone(), 'a-strong-password');
      const createdIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const setup = await setupEligibleOffer(100 + i, sharedOwner);
        createdIds.push(setup.canonicalProductId);
      }

      const page1 = await request(app.getHttpServer())
        .get('/api/v1/discovery/all?page=1&page_size=2')
        .expect(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.total).toBe(totalBefore + 3);

      const page2 = await request(app.getHttpServer())
        .get('/api/v1/discovery/all?page=2&page_size=2')
        .expect(200);
      const page1Ids = page1.body.items.map(
        (i: { canonical_product_id: string }) => i.canonical_product_id,
      );
      const page2Ids = page2.body.items.map(
        (i: { canonical_product_id: string }) => i.canonical_product_id,
      );
      expect(
        page1Ids.filter((id: string) => page2Ids.includes(id)),
      ).toHaveLength(0);

      const full = await request(app.getHttpServer())
        .get(`/api/v1/discovery/all?page=1&page_size=${totalBefore + 3}`)
        .expect(200);
      const fullIds = full.body.items.map(
        (i: { canonical_product_id: string }) => i.canonical_product_id,
      );
      for (const id of createdIds) {
        expect(fullIds).toContain(id);
      }
    });

    it('never shows an inactive offer or an unavailable store as a discovery item', async () => {
      const setup = await setupEligibleOffer();
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${setup.vendorId}/storefront/unpublish`)
        .set('Authorization', `Bearer ${setup.owner}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/discovery/all')
        .expect(200);
      const ids = res.body.items.map(
        (i: { canonical_product_id: string }) => i.canonical_product_id,
      );
      expect(ids).not.toContain(setup.canonicalProductId);
    });
  });
});
