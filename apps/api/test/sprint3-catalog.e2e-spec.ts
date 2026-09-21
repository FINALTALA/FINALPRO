import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { IdempotencyCompletionService } from './../src/common/idempotency/idempotency-completion.service';
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
        applicable_categories: ['WOMEN'],
      })
      .expect(201);
    return { vendorId: res.body.id, branchId: res.body.branches[0].id };
  }

  /** Evidence -> approve -> subscribe -> ACTIVE, for an already-applied
   * vendor/branch pair (lets tests keep the same branchId to act on
   * afterwards). */
  async function activateVendorGivenBranch(
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
      .send({ decision: 'approve' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/subscription`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('sub'))
      .send({})
      .expect(201);
  }

  /** Full happy-path onboarding: apply -> evidence -> approve -> subscribe -> ACTIVE. */
  async function activateVendor(
    ownerToken: string,
    reviewerToken: string,
  ): Promise<string> {
    const { vendorId, branchId } =
      await createVendorWithPhysicalBranch(ownerToken);
    await activateVendorGivenBranch(
      ownerToken,
      reviewerToken,
      vendorId,
      branchId,
    );
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

    it('rejects updating a category with a parent_id that does not exist (404, not a raw DB 500)', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const categoryId = await createCategory(admin, unique('LonelyCategory'));

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/categories/${categoryId}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ parent_id: '00000000-0000-0000-0000-000000000000' })
        .expect(404);
      expect(res.body.error.code).toBe('PARENT_CATEGORY_NOT_FOUND');

      const unchanged = await prisma.category.findUniqueOrThrow({
        where: { id: categoryId },
      });
      expect(unchanged.parentId).toBeNull();
    });

    it('rejects an update that would create a cycle in the category tree - direct self-parenting and an indirect ancestor loop', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const a = await createCategory(admin, unique('A'));
      const b = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('cat-b'))
        .send({ name_ar: 'ب', name_en: unique('B'), parent_id: a })
        .expect(201);
      const bId = b.body.id;

      // Direct: A can't become its own parent.
      const directRes = await request(app.getHttpServer())
        .patch(`/api/v1/categories/${a}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ parent_id: a })
        .expect(400);
      expect(directRes.body.error.code).toBe('CATEGORY_CYCLE');

      // Indirect: A is B's parent (A -> B). Making B the parent of A
      // would close the loop A -> B -> A.
      const indirectRes = await request(app.getHttpServer())
        .patch(`/api/v1/categories/${a}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ parent_id: bId })
        .expect(400);
      expect(indirectRes.body.error.code).toBe('CATEGORY_CYCLE');

      // Neither rejected attempt actually changed the tree.
      const aRow = await prisma.category.findUniqueOrThrow({
        where: { id: a },
      });
      expect(aRow.parentId).toBeNull();
      const bRow = await prisma.category.findUniqueOrThrow({
        where: { id: bId },
      });
      expect(bRow.parentId).toBe(a);
    });

    it('under two concurrent, mutually-opposite re-parenting requests (X -> parent Y and Y -> parent X, fired at once), exactly one succeeds and the tree never ends up with a 2-node cycle', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      // Two independent roots - neither is an ancestor of the other
      // when both requests start, so a *non-serialized* cycle check on
      // either side would read "no cycle" and let both through.
      const x = await createCategory(admin, unique('X'));
      const y = await createCategory(admin, unique('Y'));

      const [resXtoY, resYtoX] = await Promise.all([
        request(app.getHttpServer())
          .patch(`/api/v1/categories/${x}`)
          .set('Authorization', `Bearer ${admin}`)
          .send({ parent_id: y }),
        request(app.getHttpServer())
          .patch(`/api/v1/categories/${y}`)
          .set('Authorization', `Bearer ${admin}`)
          .send({ parent_id: x }),
      ]);

      const statuses = [resXtoY.status, resYtoX.status].sort();
      // Whichever request's transaction wins the advisory lock commits
      // first; the other, evaluated strictly after under the same lock,
      // sees the winner's already-committed change and correctly
      // detects the cycle it would otherwise close.
      expect(statuses).toEqual([200, 400]);
      const failed = resXtoY.status === 400 ? resXtoY : resYtoX;
      expect(failed.body.error.code).toBe('CATEGORY_CYCLE');

      const xRow = await prisma.category.findUniqueOrThrow({
        where: { id: x },
      });
      const yRow = await prisma.category.findUniqueOrThrow({
        where: { id: y },
      });
      // Never both - that would be the 2-node cycle this test exists to
      // rule out.
      expect(xRow.parentId === y && yRow.parentId === x).toBe(false);
      // Exactly one direction actually applied.
      expect(xRow.parentId === y || yRow.parentId === x).toBe(true);
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

      const afterEvidence = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(afterEvidence.status).toBe('UNDER_REVIEW');

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

    it('rejects approving a physical branch that never received evidence (BR-022) even while the vendor is under review via a sibling branch', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');

      const applyRes = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-no-evidence'))
        .send({
          legal_name: unique('NoEvidenceVendor'),
          branches: [
            { name: 'Branch A', is_physical: true },
            { name: 'Branch B (no evidence)', is_physical: true },
          ],
          applicable_categories: ['WOMEN'],
        })
        .expect(201);
      const vendorId = applyRes.body.id;
      const [branchA, branchB] = applyRes.body.branches;

      // Only branch A ever gets evidence - this is what moves the
      // vendor to UNDER_REVIEW at all. Branch B stays PENDING with no
      // pin/photo, exactly the state BR-022 says must never be approved.
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchA.id}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('evidence-a'))
        .send({
          lat: 32.0,
          lng: 35.0,
          verification_photo_url: 'https://example.com/a.jpg',
        })
        .expect(201);

      const rejected = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchB.id}/verification-decision`,
        )
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('decision-no-evidence'))
        .send({ decision: 'approve' })
        .expect(400);
      expect(rejected.body.error.code).toBe('BRANCH_EVIDENCE_INCOMPLETE');

      const branchBRow = await prisma.storeBranch.findUniqueOrThrow({
        where: { id: branchB.id },
      });
      expect(branchBRow.verificationStatus).toBe('PENDING');
      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('UNDER_REVIEW');
    });

    it('rejecting a branch rejects the whole vendor application (UNDER_REVIEW -> REJECTED)', async () => {
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
          verification_photo_url: 'https://example.com/fake.jpg',
        })
        .expect(201);

      const decision = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-decision`,
        )
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('decision'))
        .send({ decision: 'reject', reason: 'Photo does not match the pin' })
        .expect(201);
      expect(decision.body.verification_status).toBe('REJECTED');
      expect(decision.body.vendor_approved).toBe(false);

      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('REJECTED');

      // An already-decided branch can't be decided again (BRANCH_NOT_PENDING).
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-decision`,
        )
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('decision-again'))
        .send({ decision: 'approve' })
        .expect(409);
    });

    it('refuses to resubmit evidence once the vendor application has been rejected - the branch and vendor states are left unchanged (a REJECTED application is closed; reapplication is a new POST /vendors application, PDR-010)', async () => {
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
          verification_photo_url: 'https://example.com/fake.jpg',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-decision`,
        )
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('decision'))
        .send({ decision: 'reject', reason: 'Fraudulent evidence' })
        .expect(201);

      const resubmit = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('resubmit-after-reject'))
        .send({
          lat: 32.1,
          lng: 35.1,
          verification_photo_url: 'https://example.com/new.jpg',
        })
        .expect(409);
      expect(resubmit.body.error.code).toBe('VENDOR_NOT_REVIEWABLE');

      const branchRow = await prisma.storeBranch.findUniqueOrThrow({
        where: { id: branchId },
      });
      expect(branchRow.verificationStatus).toBe('REJECTED');
      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('REJECTED');
    });

    it('lets the same account submit a new, corrected application after a rejection - a fresh Vendor with its own id, APPLIED, while the rejected one is untouched (OPEN-010, PDR-010)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const { vendorId: rejectedVendorId, branchId: rejectedBranchId } =
        await createVendorWithPhysicalBranch(owner);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${rejectedVendorId}/branches/${rejectedBranchId}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('evidence'))
        .send({
          lat: 32.0,
          lng: 35.0,
          verification_photo_url: 'https://example.com/fake.jpg',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${rejectedVendorId}/branches/${rejectedBranchId}/verification-decision`,
        )
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('decision'))
        .send({ decision: 'reject', reason: 'Photo does not match the pin' })
        .expect(201);

      // The reapplication path is not a resubmission endpoint - it's the
      // same POST /vendors the first application used, called again
      // under the same account with a fresh Idempotency-Key.
      const reapplied = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-reapply'))
        .send({
          legal_name: unique('Vendor'),
          branches: [{ name: 'Corrected main branch', is_physical: true }],
          applicable_categories: ['WOMEN'],
        })
        .expect(201);
      expect(reapplied.body.status).toBe('APPLIED');
      expect(reapplied.body.id).not.toBe(rejectedVendorId);

      const newVendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: reapplied.body.id },
      });
      expect(newVendor.status).toBe('APPLIED');

      // The rejected application is left exactly as it was - closed,
      // not reopened or reset, and its audit trail is retained.
      const rejectedVendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: rejectedVendorId },
      });
      expect(rejectedVendor.status).toBe('REJECTED');
      const rejectedBranch = await prisma.storeBranch.findUniqueOrThrow({
        where: { id: rejectedBranchId },
      });
      expect(rejectedBranch.verificationStatus).toBe('REJECTED');
      const rejectionAudit = await prisma.auditLog.findMany({
        where: { entityType: 'Vendor', entityId: rejectedVendorId },
      });
      const auditActions = rejectionAudit.map((row) => row.action);
      expect(auditActions).toEqual(
        expect.arrayContaining(['vendor.applied', 'vendor.rejected']),
      );
    });

    it('refuses to resubmit evidence for a branch already APPROVED once the vendor itself is ACTIVE - it cannot be reset back to PENDING', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const { vendorId, branchId } =
        await createVendorWithPhysicalBranch(owner);
      await activateVendorGivenBranch(owner, reviewer, vendorId, branchId);

      const resubmit = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('resubmit-after-approve'))
        .send({
          lat: 32.2,
          lng: 35.2,
          verification_photo_url: 'https://example.com/newer.jpg',
        })
        .expect(409);
      expect(resubmit.body.error.code).toBe('VENDOR_NOT_REVIEWABLE');

      const branchRow = await prisma.storeBranch.findUniqueOrThrow({
        where: { id: branchId },
      });
      expect(branchRow.verificationStatus).toBe('APPROVED');
      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('ACTIVE');
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
          applicable_categories: ['WOMEN'],
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

  describe('vendor subscription (BL-VEND-004, PDR-033 unified sandbox trial)', () => {
    it('rejects trial activation before the vendor is APPROVED', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithPhysicalBranch(owner);

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/subscription`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('sub-too-early'))
        .send({})
        .expect(403);
    });

    it('an approved vendor activating its trial (no plan parameter) activates immediately (simulated) and flips vendor.status to ACTIVE', async () => {
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
      expect(current.body.status).toBe('ACTIVE');
      // PDR-033: no Basic/Pro/tier logic - the response has no plan field.
      expect(current.body.plan).toBeUndefined();
    });

    it('under two concurrent activation requests for the same approved vendor, exactly one VendorSubscription row is created', async () => {
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
          .send({}),
        request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/subscription`)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('sub-race-b'))
          .send({}),
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

    it('a trial past its periodEnd lazily expires on read, blocks new offers, and mock-renewal (PDR-033) restores it', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const vendorId = await activateVendor(owner, reviewer);

      // Simulate the one-month trial having elapsed - directly, the
      // same way this test suite already simulates other kinds of
      // elapsed time (there is no real clock to fast-forward).
      const sub = await prisma.vendorSubscription.findFirstOrThrow({
        where: { vendorId },
      });
      await prisma.vendorSubscription.update({
        where: { id: sub.id },
        data: { periodEnd: new Date(Date.now() - 1000) },
      });

      // Lazily discovered on read - GET itself triggers the transition.
      const expired = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/subscription`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(expired.body.status).toBe('EXPIRED');
      const vendorAfterExpiry = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendorAfterExpiry.subscriptionStatus).toBe('EXPIRED');
      // PDR-033: the vendor's own account/lifecycle is unaffected by an
      // expired trial - only new-listing creation is blocked.
      expect(vendorAfterExpiry.status).toBe('ACTIVE');

      // Review-round finding: the ACTIVE -> EXPIRED transition must be
      // audited (Part 4, H.1) - written atomically inside the same
      // transaction as the status change itself.
      const expiryAuditRows = await prisma.auditLog.findMany({
        where: {
          entityType: 'VendorSubscription',
          entityId: sub.id,
          action: 'vendor_subscription.expired',
        },
      });
      expect(expiryAuditRows).toHaveLength(1);

      // New offer creation is blocked while expired (BR-014).
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-while-expired'))
        .send({ title_ar: 'عرض', title_en: 'Offer' })
        .expect(403);

      // Mock renewal (PDR-033: "renewal restores automatically" - here,
      // simulated as an explicit sandbox action) restores ACTIVE with a
      // fresh one-month period.
      const renewed = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/subscription/renew`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('renew'))
        .send({})
        .expect(200);
      expect(renewed.body.status).toBe('ACTIVE');
      expect(new Date(renewed.body.period_end).getTime()).toBeGreaterThan(
        Date.now(),
      );

      const vendorAfterRenewal = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendorAfterRenewal.subscriptionStatus).toBe('ACTIVE');

      // Offer creation works again post-renewal.
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-after-renewal'))
        .send({ title_ar: 'عرض', title_en: 'Offer' })
        .expect(201);
    });

    it('refuses to renew a trial that is not expired (409)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const vendorId = await activateVendor(owner, reviewer);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/subscription/renew`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('renew-too-early'))
        .send({})
        .expect(409);
      expect(res.body.error.code).toBe('SUBSCRIPTION_NOT_EXPIRED');
    });

    it('concurrent checks of an already-lapsed trial write exactly one expiry audit row (review-round finding)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const vendorId = await activateVendor(owner, reviewer);

      const sub = await prisma.vendorSubscription.findFirstOrThrow({
        where: { vendorId },
      });
      await prisma.vendorSubscription.update({
        where: { id: sub.id },
        data: { periodEnd: new Date(Date.now() - 1000) },
      });

      // Several concurrent reads all race to be the one that observes
      // the lapsed trial and performs the ACTIVE -> EXPIRED transition.
      // `SubscriptionGateService.refreshStatus` row-locks the vendor
      // first, so only one of these should actually write the
      // transition (and its audit row) - the rest must see the
      // already-EXPIRED status and return early.
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app.getHttpServer())
            .get(`/api/v1/vendors/${vendorId}/subscription`)
            .set('Authorization', `Bearer ${owner}`),
        ),
      );
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('EXPIRED');
      }

      const expiryAuditRows = await prisma.auditLog.findMany({
        where: {
          entityType: 'VendorSubscription',
          entityId: sub.id,
          action: 'vendor_subscription.expired',
        },
      });
      expect(expiryAuditRows).toHaveLength(1);
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

    it('an exact gtin match is stored as a pending proposal, never an immediate link - the offer does not enter comparison until the store owner confirms it (FR-MATCH-012, TC-MATCH-001, S3-B03)', async () => {
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

      // The exact match is a *proposal* only - not entered comparison
      // yet (no canonical_variant_id), and the parent offer is still
      // unlinked too.
      expect(variant.body.canonical_variant_id).toBeNull();
      expect(variant.body.proposed_canonical_variant_id).toBe(
        canonicalVariant.body.id,
      );
      expect(variant.body.match_proposal_status).toBe('PENDING');
      const offerStillUnlinked = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(
        offerStillUnlinked.body.find(
          (o: { id: string }) => o.id === offer.body.id,
        ).canonical_product_id,
      ).toBeNull();

      // The store owner explicitly confirms it - only now does it link.
      const confirmed = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants/${variant.body.id}/match-confirmation`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ decision: 'confirm' })
        .expect(200);
      expect(confirmed.body.canonical_variant_id).toBe(
        canonicalVariant.body.id,
      );
      expect(confirmed.body.match_proposal_status).toBe('CONFIRMED');

      const offerAfter = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const linked = offerAfter.body.find(
        (o: { id: string }) => o.id === offer.body.id,
      );
      expect(linked.canonical_product_id).toBe(product.body.id);
    });

    it('a rejected match proposal stays unmatched permanently and cannot be re-confirmed (FR-MATCH-012)', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const vendorId = await activateVendor(owner, reviewer);

      const categoryId = await createCategory(admin, unique('Cat'));
      const brandId = await createBrand(admin, unique('Brand'));
      const product = await request(app.getHttpServer())
        .post('/api/v1/canonical-products')
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('cp-reject'))
        .send({
          brand_id: brandId,
          category_id: categoryId,
          model_name: 'Reject Model',
        })
        .expect(201);
      const gtin = unique('gtin-reject')
        .replace(/[^0-9]/g, '')
        .padEnd(12, '0');
      await request(app.getHttpServer())
        .post(`/api/v1/canonical-products/${product.body.id}/variants`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('variant-reject'))
        .send({ structural_attributes: {}, gtin })
        .expect(201);

      const offer = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-reject'))
        .send({ title_ar: 'منتج', title_en: 'Product' })
        .expect(201);
      const variant = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-variant-reject'))
        .send({
          seller_sku: unique('sku'),
          base_price: 100,
          identifier_type: 'GTIN',
          identifier_value: gtin,
        })
        .expect(201);

      const rejected = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants/${variant.body.id}/match-confirmation`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('reject'))
        .send({ decision: 'reject' })
        .expect(200);
      expect(rejected.body.canonical_variant_id).toBeNull();
      expect(rejected.body.match_proposal_status).toBe('REJECTED');

      // Already decided - cannot confirm after rejecting.
      const reconfirm = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants/${variant.body.id}/match-confirmation`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('reconfirm'))
        .send({ decision: 'confirm' })
        .expect(409);
      expect(reconfirm.body.error.code).toBe('NO_PENDING_MATCH_PROPOSAL');
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
      expect(variant.body.match_proposal_status).toBe('NONE');
    });

    it('rejects a non-ILS currency outright (PDR-001, S3-B01)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const vendorId = await activateVendor(owner, reviewer);

      const offer = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-ils'))
        .send({ title_ar: 'منتج', title_en: 'Product' })
        .expect(201);

      const rejected = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-variant-usd'))
        .send({ seller_sku: unique('sku'), base_price: 10, currency: 'USD' })
        .expect(400);
      expect(rejected.body.error.details.join(' ')).toContain('ILS');

      // Omitting currency (the only real use case) still works and is
      // always ILS.
      const ok = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-variant-ils'))
        .send({ seller_sku: unique('sku'), base_price: 10 })
        .expect(201);
      expect(ok.body.currency).toBe('ILS');
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

    it('under two concurrent match confirmations for the same offer proposing different canonical products, the offer never ends up linked to a product one of its own variants disagrees with', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const vendorId = await activateVendor(owner, reviewer);

      const categoryId = await createCategory(admin, unique('Cat'));
      const brandId = await createBrand(admin, unique('Brand'));
      const [productA, productB] = await Promise.all(
        ['A', 'B'].map((label) =>
          request(app.getHttpServer())
            .post('/api/v1/canonical-products')
            .set('Authorization', `Bearer ${admin}`)
            .set('Idempotency-Key', unique(`cp-race-${label}`))
            .send({
              brand_id: brandId,
              category_id: categoryId,
              model_name: `Race Model ${label}`,
            })
            .expect(201),
        ),
      );
      const gtinA = unique('gtin-a')
        .replace(/[^0-9]/g, '')
        .padEnd(12, '0');
      const gtinB = unique('gtin-b')
        .replace(/[^0-9]/g, '')
        .padEnd(12, '1');
      const [variantA, variantB] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/canonical-products/${productA.body.id}/variants`)
          .set('Authorization', `Bearer ${admin}`)
          .set('Idempotency-Key', unique('cv-race-a'))
          .send({ structural_attributes: {}, gtin: gtinA })
          .expect(201),
        request(app.getHttpServer())
          .post(`/api/v1/canonical-products/${productB.body.id}/variants`)
          .set('Authorization', `Bearer ${admin}`)
          .set('Idempotency-Key', unique('cv-race-b'))
          .send({ structural_attributes: {}, gtin: gtinB })
          .expect(201),
      ]);

      const offer = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('offer-race'))
        .send({ title_ar: 'منتج للسباق', title_en: 'Race Offer' })
        .expect(201);

      // Both variants are created first (sequentially - creation itself
      // no longer contends for any lock, see createVariant()'s comment)
      // with different proposed matches, each still PENDING.
      const variantOfferA = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant-race-a'))
        .send({
          seller_sku: unique('sku-race-a'),
          base_price: 10,
          identifier_type: 'GTIN',
          identifier_value: gtinA,
        })
        .expect(201);
      const variantOfferB = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant-race-b'))
        .send({
          seller_sku: unique('sku-race-b'),
          base_price: 20,
          identifier_type: 'GTIN',
          identifier_value: gtinB,
        })
        .expect(201);
      expect(variantOfferA.body.match_proposal_status).toBe('PENDING');
      expect(variantOfferB.body.match_proposal_status).toBe('PENDING');

      // The race is at *confirmation* time now - both proposals
      // confirmed concurrently, proposing different canonical products.
      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants/${variantOfferA.body.id}/match-confirmation`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('confirm-race-a'))
          .send({ decision: 'confirm' }),
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/offers/${offer.body.id}/variants/${variantOfferB.body.id}/match-confirmation`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('confirm-race-b'))
          .send({ decision: 'confirm' }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      // Whichever request's transaction wins the advisory-style
      // VendorOffer row lock commits first; the other, evaluated
      // strictly after under that same lock, sees the winner's already-
      // committed canonicalProductId and correctly refuses the conflict
      // (409 MATCH_CONFLICTS_WITH_OFFER) instead of forcing it through -
      // exactly what would corrupt Part 3's tightened invariant if the
      // offer's row weren't locked during this decision.
      expect(statuses).toEqual([200, 409]);
      const conflicted = resA.status === 409 ? resA : resB;
      expect(conflicted.body.error.code).toBe('MATCH_CONFLICTS_WITH_OFFER');

      const finalOffer = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offer.body.id },
      });
      expect(finalOffer.canonicalProductId).not.toBeNull();
      const winningVariantId =
        resA.status === 200 ? variantA.body.id : variantB.body.id;
      const winningProductId =
        winningVariantId === variantA.body.id
          ? productA.body.id
          : productB.body.id;
      expect(finalOffer.canonicalProductId).toBe(winningProductId);

      // The conflicted proposal was never confirmed - it stays exactly
      // as it was (PENDING), not silently forced or auto-rejected.
      const losingVariant = await prisma.offerVariant.findUniqueOrThrow({
        where: {
          id:
            resA.status === 409 ? variantOfferA.body.id : variantOfferB.body.id,
        },
      });
      expect(losingVariant.matchProposalStatus).toBe('PENDING');
      expect(losingVariant.canonicalVariantId).toBeNull();
    });

    it('when the idempotency-completion write fails right after a real offer creation, nothing is left half-done - the failed attempt creates no offer, and a same-key retry creates exactly one (Sprint 3 review round 3)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const vendorId = await activateVendor(owner, reviewer);

      // IdempotencyCompletionService.complete() is called *inside* the
      // same transaction as the resource create (see
      // vendor-offers.controller.ts's create()) - failing it here must
      // roll back the whole transaction, not just skip the completion
      // bookkeeping. Before this fix, the resource create and the
      // interceptor's own completion write were two separate Postgres
      // statements, so a failure here left the offer created but the
      // Idempotency-Key claim FAILED/re-claimable - a same-key retry
      // would re-run the handler and create a *second* offer, since
      // VendorOffer has no uniqueness constraint of its own to catch it.
      const completeSpy = jest
        .spyOn(app.get(IdempotencyCompletionService), 'complete')
        .mockRejectedValueOnce(
          new Error('simulated Postgres blip recording completion'),
        );

      const key = unique('offer-completion-blip');
      const distinctiveTitle = unique('CompletionBlipOffer');
      const body = { title_ar: 'عرض الاختبار', title_en: distinctiveTitle };

      const first = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .send(body);

      completeSpy.mockRestore();

      // The transaction rolled back - the handler's own error (not an
      // HttpException) surfaces as a 500, and *nothing* was created.
      expect(first.status).toBe(500);
      const afterFirstAttempt = await prisma.vendorOffer.findMany({
        where: { vendorId, titleEn: distinctiveTitle },
      });
      expect(afterFirstAttempt).toHaveLength(0);

      // A same-key retry (identical payload) re-claims the now-FAILED
      // key and re-runs the handler cleanly - this time it succeeds.
      const second = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect(second.body.title_en).toBe(distinctiveTitle);

      const offers = await prisma.vendorOffer.findMany({
        where: { vendorId, titleEn: distinctiveTitle },
      });
      expect(offers).toHaveLength(1);
      expect(offers[0].id).toBe(second.body.id);
    });
  });
});
