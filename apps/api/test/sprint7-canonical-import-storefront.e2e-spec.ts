import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { generateVendorSlug } from './../src/common/slug.util';
import { randomUUID } from 'crypto';

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

let phoneSeq = (Date.now() % 1_000_000) + 1_100_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97056${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 7 - canonical naming, CSV/XLSX import, public storefront (e2e)', () => {
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

  async function createCanonicalVariant(
    adminToken: string,
    brandName: string,
    modelName: string,
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
      .send({ structural_attributes: {} })
      .expect(201);
    return {
      canonicalProductId: productRes.body.id,
      variantId: variantRes.body.id,
    };
  }

  async function confirmExactMatch(
    ownerToken: string,
    vendorId: string,
    canonicalVariantId: string,
    identifierValue: string,
    titleAr: string,
    titleEn: string,
  ): Promise<{ offerId: string; variantId: string }> {
    await activateVendorSubscription(ownerToken, vendorId);
    const offerRes = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/offers`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('offer'))
      .send({ title_ar: titleAr, title_en: titleEn })
      .expect(201);
    const variantRes = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('variant'))
      .send({
        seller_sku: unique('sku'),
        base_price: 10,
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
    return { offerId: offerRes.body.id, variantId: variantRes.body.id };
  }

  describe('RB-MATCH-003: canonical naming', () => {
    it('the first confirming offer sets the provisional canonical name', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { canonicalProductId, variantId: canonicalVariantId } =
        await createCanonicalVariant(admin, 'Samsung', 'Galaxy S24');
      const gtin = unique('gtin').slice(0, 20);
      await prisma.canonicalProductVariant.update({
        where: { id: canonicalVariantId },
        data: { gtin },
      });

      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await confirmExactMatch(
        owner,
        vendorId,
        canonicalVariantId,
        gtin,
        'سامسونج جالاكسي اس 24',
        'Samsung Galaxy S24',
      );

      const product = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: canonicalProductId },
      });
      expect(product.canonicalNameAr).toBe('سامسونج جالاكسي اس 24');
      expect(product.canonicalNameEn).toBe('Samsung Galaxy S24');
    });

    it('a later confirming vendor adopts the existing canonical name - their own offer title is overwritten', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { variantId: canonicalVariantId } = await createCanonicalVariant(
        admin,
        'Apple',
        'iPhone 15',
      );
      const gtin = unique('gtin').slice(0, 20);
      await prisma.canonicalProductVariant.update({
        where: { id: canonicalVariantId },
        data: { gtin },
      });

      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor1Id } = await createVendorWithTwoBranches(owner1);
      await confirmExactMatch(
        owner1,
        vendor1Id,
        canonicalVariantId,
        gtin,
        'ابل ايفون 15',
        'Apple iPhone 15',
      );

      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2Id } = await createVendorWithTwoBranches(owner2);
      const { offerId: offer2Id } = await confirmExactMatch(
        owner2,
        vendor2Id,
        canonicalVariantId,
        gtin,
        'ايفون 15 الجديد - سعر مغري',
        'Brand New iPhone 15 - Great Price',
      );

      const offer2 = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offer2Id },
      });
      expect(offer2.titleAr).toBe('ابل ايفون 15');
      expect(offer2.titleEn).toBe('Apple iPhone 15');
    });

    it('under two concurrent first-confirmations for the same canonical product, exactly one provisional name wins and both offers end up consistent', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { canonicalProductId, variantId: canonicalVariantId } =
        await createCanonicalVariant(admin, 'Dell', 'XPS 13');
      const gtin = unique('gtin').slice(0, 20);
      await prisma.canonicalProductVariant.update({
        where: { id: canonicalVariantId },
        data: { gtin },
      });

      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId } = await createVendorWithTwoBranches(ownerA);
      await activateVendorSubscription(ownerA, vendorAId);
      const offerAres = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorAId}/offers`)
        .set('Authorization', `Bearer ${ownerA}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'ديل اكس بي اس', title_en: 'Dell XPS Store A' })
        .expect(201);
      const variantAres = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorAId}/offers/${offerAres.body.id}/variants`,
        )
        .set('Authorization', `Bearer ${ownerA}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 10,
          identifier_type: 'GTIN',
          identifier_value: gtin,
        })
        .expect(201);

      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBId } = await createVendorWithTwoBranches(ownerB);
      await activateVendorSubscription(ownerB, vendorBId);
      const offerBres = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorBId}/offers`)
        .set('Authorization', `Bearer ${ownerB}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'ديل اكس بي اس 13', title_en: 'Dell XPS Store B' })
        .expect(201);
      const variantBres = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorBId}/offers/${offerBres.body.id}/variants`,
        )
        .set('Authorization', `Bearer ${ownerB}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 10,
          identifier_type: 'GTIN',
          identifier_value: gtin,
        })
        .expect(201);

      const [confirmA, confirmB] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorAId}/offers/${offerAres.body.id}/variants/${variantAres.body.id}/match-confirmation`,
          )
          .set('Authorization', `Bearer ${ownerA}`)
          .set('Idempotency-Key', unique('confirm-a'))
          .send({ decision: 'confirm' }),
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorBId}/offers/${offerBres.body.id}/variants/${variantBres.body.id}/match-confirmation`,
          )
          .set('Authorization', `Bearer ${ownerB}`)
          .set('Idempotency-Key', unique('confirm-b'))
          .send({ decision: 'confirm' }),
      ]);
      expect(confirmA.status).toBe(200);
      expect(confirmB.status).toBe(200);

      const product = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: canonicalProductId },
      });
      expect(product.canonicalNameAr).not.toBeNull();

      const offerA = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offerAres.body.id },
      });
      const offerB = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offerBres.body.id },
      });
      // Whichever offer won the race, BOTH must end up with the exact
      // same title as the canonical product - no two different names
      // remain for the same matched product, the invariant this whole
      // requirement exists to guarantee.
      expect(offerA.titleAr).toBe(product.canonicalNameAr);
      expect(offerB.titleAr).toBe(product.canonicalNameAr);
      expect(offerA.titleEn).toBe(product.canonicalNameEn);
      expect(offerB.titleEn).toBe(product.canonicalNameEn);
    });

    it('lets a matched owner request a name change, PLATFORM_ADMIN approves it, and the new name propagates to every matched offer', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { canonicalProductId, variantId: canonicalVariantId } =
        await createCanonicalVariant(admin, 'Sony', 'WH-1000XM5');
      const gtin = unique('gtin').slice(0, 20);
      await prisma.canonicalProductVariant.update({
        where: { id: canonicalVariantId },
        data: { gtin },
      });

      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor1Id } = await createVendorWithTwoBranches(owner1);
      await confirmExactMatch(
        owner1,
        vendor1Id,
        canonicalVariantId,
        gtin,
        'سوني هيدفون',
        'Sony Headphones',
      );
      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2Id } = await createVendorWithTwoBranches(owner2);
      const { offerId: offer2Id } = await confirmExactMatch(
        owner2,
        vendor2Id,
        canonicalVariantId,
        gtin,
        'سوني هيدفون آخر',
        'Sony Headphones Other',
      );

      const requestRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendor1Id}/canonical-products/${canonicalProductId}/name-change-requests`,
        )
        .set('Authorization', `Bearer ${owner1}`)
        .set('Idempotency-Key', unique('rename'))
        .send({
          requested_name_ar: 'سوني WH-1000XM5 الأصلي',
          requested_name_en: 'Sony WH-1000XM5 (Official)',
          reason: 'More accurate model name',
        })
        .expect(201);
      expect(requestRes.body.status).toBe('PENDING');

      const queueRes = await request(app.getHttpServer())
        .get('/api/v1/canonical-products/name-change-requests')
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(
        queueRes.body.some((r: { id: string }) => r.id === requestRes.body.id),
      ).toBe(true);

      const decisionRes = await request(app.getHttpServer())
        .post(
          `/api/v1/canonical-products/name-change-requests/${requestRes.body.id}/decision`,
        )
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', unique('decide'))
        .send({ decision: 'approve' })
        .expect(200);
      expect(decisionRes.body.status).toBe('APPROVED');

      const product = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: canonicalProductId },
      });
      expect(product.canonicalNameAr).toBe('سوني WH-1000XM5 الأصلي');
      expect(product.canonicalNameEn).toBe('Sony WH-1000XM5 (Official)');

      const offer2 = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offer2Id },
      });
      expect(offer2.titleEn).toBe('Sony WH-1000XM5 (Official)');

      const publicView = await request(app.getHttpServer())
        .get(`/api/v1/canonical-products/${canonicalProductId}`)
        .expect(200);
      expect(publicView.body.canonical_name_en).toBe(
        'Sony WH-1000XM5 (Official)',
      );
    });

    it('refuses a name-change request from a vendor with no confirmed match to the product', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { canonicalProductId } = await createCanonicalVariant(
        admin,
        'LG',
        'OLED55',
      );
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/canonical-products/${canonicalProductId}/name-change-requests`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('rename'))
        .send({ requested_name_ar: 'اسم', requested_name_en: 'Name' })
        .expect(403);
      expect(res.body.error.code).toBe('NOT_A_MATCHED_VENDOR');
    });

    it('refuses a BRANCH_EMPLOYEE from requesting a name change or deciding one', async () => {
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const { canonicalProductId, variantId: canonicalVariantId } =
        await createCanonicalVariant(admin, 'HP', 'Spectre');
      const gtin = unique('gtin').slice(0, 20);
      await prisma.canonicalProductVariant.update({
        where: { id: canonicalVariantId },
        data: { gtin },
      });
      const { vendorId, employeeToken, owner } =
        await setupVendorWithTwoBranchesAndEmployee();
      await confirmExactMatch(
        owner,
        vendorId,
        canonicalVariantId,
        gtin,
        'اتش بي سبكتر',
        'HP Spectre',
      );

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/canonical-products/${canonicalProductId}/name-change-requests`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('rename'))
        .send({ requested_name_ar: 'اسم', requested_name_en: 'Name' })
        .expect(403);
      expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');

      const nonAdminRes = await request(app.getHttpServer())
        .get('/api/v1/canonical-products/name-change-requests')
        .set('Authorization', `Bearer ${owner}`)
        .expect(403);
      expect(nonAdminRes.body.error.code).toBeDefined();
    });
  });

  describe('RB-MATCH-004: CSV/Excel import', () => {
    it('imports valid CSV rows, auto-generates barcodes, and reports the count', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const sku1 = unique('sku');
      const sku2 = unique('sku');
      const csv = [
        'title_ar,title_en,seller_sku,base_price,condition',
        `منتج ١,Product One,${sku1},25,NEW`,
        `منتج ٢,Product Two,${sku2},40,USED`,
      ].join('\n');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);

      expect(res.body.total_rows).toBe(2);
      expect(res.body.imported).toHaveLength(2);
      expect(res.body.invalid_rows).toHaveLength(0);
      expect(res.body.conflicts).toHaveLength(0);

      const variant = await prisma.offerVariant.findFirstOrThrow({
        where: { vendorId, sellerSku: sku1 },
      });
      expect(variant.storeInventoryBarcode).toMatch(/^SIB-/);
      expect(variant.basePrice.toString()).toBe('25');
    });

    it('reports a clear reason for invalid rows without aborting the rest of the import', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const goodSku = unique('sku');
      const csv = [
        'title_ar,title_en,seller_sku,base_price',
        `,Missing Arabic Title,${unique('sku')},10`,
        `عنوان,Negative Price,${unique('sku')},-5`,
        `عنوان جيد,Good Product,${goodSku},15`,
      ].join('\n');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);

      expect(res.body.total_rows).toBe(3);
      expect(res.body.imported).toHaveLength(1);
      expect(res.body.invalid_rows).toHaveLength(2);
      expect(
        res.body.invalid_rows.some((r: { reason: string }) =>
          r.reason.includes('title_ar'),
        ),
      ).toBe(true);
      expect(
        res.body.invalid_rows.some((r: { reason: string }) =>
          r.reason.includes('base_price'),
        ),
      ).toBe(true);
    });

    it('PDR-019: same identifier_value with consistent brand/type/mpn is additive (multiple variants under one new offer), not a conflict', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const sharedGtin = unique('gtin').slice(0, 20);
      const skuRed = unique('sku');
      const skuBlue = unique('sku');
      const csv = [
        'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value,brand_name,product_type,specs_text_en',
        `تيشيرت,T-Shirt,${skuRed},20,GTIN,${sharedGtin},Acme,Apparel,Red`,
        `تيشيرت,T-Shirt,${skuBlue},20,GTIN,${sharedGtin},Acme,Apparel,Blue`,
      ].join('\n');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);

      expect(res.body.imported).toHaveLength(2);
      expect(res.body.conflicts).toHaveLength(0);
      expect(res.body.imported[0].offer_id).toBe(res.body.imported[1].offer_id);
    });

    it('PDR-019: same identifier_value with differing brand is a mandatory-review conflict, not silently resolved', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const sharedGtin = unique('gtin').slice(0, 20);
      const csv = [
        'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value,brand_name',
        `أ,A,${unique('sku')},20,GTIN,${sharedGtin},BrandOne`,
        `ب,B,${unique('sku')},20,GTIN,${sharedGtin},BrandTwo`,
      ].join('\n');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);

      expect(res.body.imported).toHaveLength(0);
      expect(res.body.conflicts).toHaveLength(2);
      expect(res.body.conflicts[0].reason).toContain('brandName');
    });

    // Review-round fix (Blocker 3): PDR-019's additive rule must hold
    // across separate import REQUESTS, not just within one file - a
    // second import referencing an identifier a prior import already
    // used (compatible brand/type/mpn, a new seller_sku) must attach as
    // a new variant on the SAME VendorOffer the first import created,
    // never spawn a second offer for what is the same real-world
    // product.
    it('PDR-019 across imports: a second import with the same identifier_type/value and a new seller_sku becomes an additional variant on the SAME offer as the first import', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const sharedGtin = unique('gtin').slice(0, 20);
      const skuRed = unique('sku');
      const firstCsv = [
        'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value,brand_name,product_type,specs_text_en',
        `تيشيرت,T-Shirt,${skuRed},20,GTIN,${sharedGtin},Acme,Apparel,Red`,
      ].join('\n');
      const firstRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(firstCsv, 'utf-8'), 'products.csv')
        .expect(201);
      expect(firstRes.body.imported).toHaveLength(1);
      const firstOfferId = firstRes.body.imported[0].offer_id;

      const skuBlue = unique('sku');
      const secondCsv = [
        'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value,brand_name,product_type,specs_text_en',
        `تيشيرت,T-Shirt,${skuBlue},20,GTIN,${sharedGtin},Acme,Apparel,Blue`,
      ].join('\n');
      const secondRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(secondCsv, 'utf-8'), 'products.csv')
        .expect(201);

      expect(secondRes.body.imported).toHaveLength(1);
      expect(secondRes.body.conflicts).toHaveLength(0);
      expect(secondRes.body.imported[0].offer_id).toBe(firstOfferId);

      const offers = await prisma.vendorOffer.findMany({
        where: { vendorId },
      });
      expect(offers).toHaveLength(1);
    });

    it('PDR-019 across imports: different identifier_types sharing the same raw value never merge into one offer', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const sharedValue = unique('code').slice(0, 20);
      const firstCsv = [
        'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value',
        `أ,A,${unique('sku')},20,GTIN,${sharedValue}`,
      ].join('\n');
      const firstRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(firstCsv, 'utf-8'), 'products.csv')
        .expect(201);
      const firstOfferId = firstRes.body.imported[0].offer_id;

      const secondCsv = [
        'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value',
        `ب,B,${unique('sku')},20,MPN,${sharedValue}`,
      ].join('\n');
      const secondRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(secondCsv, 'utf-8'), 'products.csv')
        .expect(201);

      expect(secondRes.body.imported).toHaveLength(1);
      expect(secondRes.body.imported[0].offer_id).not.toBe(firstOfferId);

      const offers = await prisma.vendorOffer.findMany({
        where: { vendorId },
      });
      expect(offers).toHaveLength(2);
    });

    // Round-4 review fix: persisting ImportIdentifierRecord's evidence
    // from firstRow alone under-reported it - a group of [brand empty,
    // brand "Nike"] has no in-file conflict (nothing differs), but
    // firstRow.brandName is null, so the record used to silently
    // remember NULL instead of "Nike". A later import with a genuinely
    // conflicting brand_name would then pass the null-tolerant
    // comparison undetected. collectGroupEvidence() now derives the
    // record's brand/type/mpn from the WHOLE group, not row 0.
    it('PDR-019 evidence: brand_name provided by a LATER row in the same group (not the first) is still persisted and still catches a later conflict', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const sharedGtin = unique('gtin').slice(0, 20);
      const firstCsv = [
        'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value,brand_name',
        `أ,A,${unique('sku')},20,GTIN,${sharedGtin},`,
        `ب,B,${unique('sku')},20,GTIN,${sharedGtin},Nike`,
      ].join('\n');
      const firstRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(firstCsv, 'utf-8'), 'products.csv')
        .expect(201);
      expect(firstRes.body.imported).toHaveLength(2);
      expect(firstRes.body.conflicts).toHaveLength(0);

      const record = await prisma.importIdentifierRecord.findUnique({
        where: {
          vendorId_identifierType_identifierValue: {
            vendorId,
            identifierType: 'GTIN',
            identifierValue: sharedGtin,
          },
        },
      });
      expect(record?.brandName).toBe('Nike');

      const secondCsv = [
        'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value,brand_name',
        `ج,C,${unique('sku')},20,GTIN,${sharedGtin},Adidas`,
      ].join('\n');
      const secondRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(secondCsv, 'utf-8'), 'products.csv')
        .expect(201);

      expect(secondRes.body.imported).toHaveLength(0);
      expect(secondRes.body.conflicts).toHaveLength(1);
      expect(secondRes.body.conflicts[0].reason).toContain('brandName');

      const variantsAfter = await prisma.offerVariant.findMany({
        where: { vendorId },
      });
      expect(variantsAfter).toHaveLength(2);
    });

    // Round-3 review fix (Blocker 1): ImportIdentifierRecord starts
    // empty for every vendor - a pre-Sprint-7 (or simply not-yet-
    // imported-through) OfferVariant already carrying an identifier
    // must still be found and reused by a later import, not silently
    // duplicated into a second offer for the same real-world product.
    it('PDR-019 legacy data: a pre-existing OfferVariant with no ImportIdentifierRecord yet is found and reused, not duplicated into a second offer', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const gtin = unique('gtin').slice(0, 20);
      const legacyOffer = await prisma.vendorOffer.create({
        data: { vendorId, titleAr: 'قديم', titleEn: 'Legacy' },
      });
      await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: legacyOffer.id,
          sellerSku: unique('sku'),
          basePrice: 10,
          identifierType: 'GTIN',
          identifierValue: gtin,
          storeInventoryBarcode: unique('barcode'),
        },
      });

      const csv = [
        'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value',
        `جديد,New,${unique('sku')},20,GTIN,${gtin}`,
      ].join('\n');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);

      expect(res.body.imported).toHaveLength(1);
      expect(res.body.conflicts).toHaveLength(0);
      expect(res.body.imported[0].offer_id).toBe(legacyOffer.id);

      const offers = await prisma.vendorOffer.findMany({
        where: { vendorId },
      });
      expect(offers).toHaveLength(1);

      const record = await prisma.importIdentifierRecord.findUnique({
        where: {
          vendorId_identifierType_identifierValue: {
            vendorId,
            identifierType: 'GTIN',
            identifierValue: gtin,
          },
        },
      });
      expect(record?.vendorOfferId).toBe(legacyOffer.id);
    });

    it('PDR-019 legacy data: more than one pre-existing offer already using the same identifier is a manual-review conflict, never auto-linked', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const gtin = unique('gtin').slice(0, 20);
      const legacyOfferA = await prisma.vendorOffer.create({
        data: { vendorId, titleAr: 'أ', titleEn: 'A' },
      });
      await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: legacyOfferA.id,
          sellerSku: unique('sku'),
          basePrice: 10,
          identifierType: 'GTIN',
          identifierValue: gtin,
          storeInventoryBarcode: unique('barcode'),
        },
      });
      const legacyOfferB = await prisma.vendorOffer.create({
        data: { vendorId, titleAr: 'ب', titleEn: 'B' },
      });
      await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: legacyOfferB.id,
          sellerSku: unique('sku'),
          basePrice: 10,
          identifierType: 'GTIN',
          identifierValue: gtin,
          storeInventoryBarcode: unique('barcode'),
        },
      });

      const csv = [
        'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value',
        `جديد,New,${unique('sku')},20,GTIN,${gtin}`,
      ].join('\n');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);

      expect(res.body.imported).toHaveLength(0);
      expect(res.body.conflicts).toHaveLength(1);
      expect(res.body.conflicts[0].reason).toContain(
        'Multiple existing offers',
      );

      const offers = await prisma.vendorOffer.findMany({
        where: { vendorId },
      });
      expect(offers).toHaveLength(2);
      const record = await prisma.importIdentifierRecord.findUnique({
        where: {
          vendorId_identifierType_identifierValue: {
            vendorId,
            identifierType: 'GTIN',
            identifierValue: gtin,
          },
        },
      });
      expect(record).toBeNull();
    });

    // Round-3 review fix (Blocker 2): ImportIdentifierRecord.vendorOffer
    // is now a COMPOSITE FK on (vendorId, vendorOfferId), not
    // vendorOfferId alone - a cross-vendor link (this record's vendorId
    // paired with a DIFFERENT vendor's offer) must be rejected by
    // Postgres itself, not just by application code, since raw SQL
    // bypasses the app entirely.
    it('DB-level: a cross-vendor ImportIdentifierRecord link is rejected by the composite foreign key', async () => {
      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId } = await createVendorWithTwoBranches(ownerA);
      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBId } = await createVendorWithTwoBranches(ownerB);

      const offerB = await prisma.vendorOffer.create({
        data: { vendorId: vendorBId, titleAr: 'ب', titleEn: 'B' },
      });

      await expect(
        prisma.$executeRaw`INSERT INTO import_identifier_records (id, "vendorId", "identifierType", "identifierValue", "vendorOfferId", "updatedAt")
          VALUES (${randomUUID()}, ${vendorAId}, 'GTIN', ${unique('gtin')}, ${offerB.id}, now())`,
      ).rejects.toThrow();
    });

    // Round-3 review fix (Blocker 3): two concurrent imports referencing
    // the same identifier with different, valid, new seller_skus must
    // both succeed and merge into the SAME offer - not race, and not
    // report a misleading "seller_sku conflict" for a SKU that never
    // actually collided.
    it('PDR-019 concurrency: two concurrent imports with the same identifier and different new seller_skus both succeed and merge into one offer', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const sharedGtin = unique('gtin').slice(0, 20);
      const csvA = [
        'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value',
        `أ,A,${unique('sku')},20,GTIN,${sharedGtin}`,
      ].join('\n');
      const csvB = [
        'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value',
        `ب,B,${unique('sku')},20,GTIN,${sharedGtin}`,
      ].join('\n');

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/offers/import`)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('import-a'))
          .attach('file', Buffer.from(csvA, 'utf-8'), 'a.csv'),
        request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/offers/import`)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('import-b'))
          .attach('file', Buffer.from(csvB, 'utf-8'), 'b.csv'),
      ]);

      expect(resA.status).toBe(201);
      expect(resB.status).toBe(201);
      expect(resA.body.imported).toHaveLength(1);
      expect(resB.body.imported).toHaveLength(1);
      expect(resA.body.imported[0].offer_id).toBe(
        resB.body.imported[0].offer_id,
      );

      const offers = await prisma.vendorOffer.findMany({
        where: { vendorId },
      });
      expect(offers).toHaveLength(1);
      const variants = await prisma.offerVariant.findMany({
        where: { vendorId },
      });
      expect(variants).toHaveLength(2);
      const records = await prisma.importIdentifierRecord.findMany({
        where: {
          vendorId,
          identifierType: 'GTIN',
          identifierValue: sharedGtin,
        },
      });
      expect(records).toHaveLength(1);
    });

    it('a duplicate seller_sku within the same file is reported, not silently overwritten', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const dupSku = unique('sku');
      const csv = [
        'title_ar,title_en,seller_sku,base_price',
        `اول,First,${dupSku},10`,
        `ثاني,Second,${dupSku},20`,
      ].join('\n');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);

      // Rows are processed sequentially (each identifier_value=null row
      // is its own single-row group) - the first creates the variant,
      // and by the time the second row's own pre-check runs, that
      // seller_sku already exists (from the first row, within this
      // same request), so it is correctly reported as
      // skipped_already_imported rather than a hard failure - the same
      // outcome a genuine retry would produce, which is exactly the
      // point: a duplicate is a duplicate regardless of whether it
      // came from this file or a prior import.
      expect(res.body.imported).toHaveLength(1);
      expect(res.body.skipped_already_imported).toHaveLength(1);
      expect(res.body.invalid_rows).toHaveLength(0);
    });

    it('retrying the exact same import (same Idempotency-Key, same file) replays the same report and creates nothing twice', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const sku = unique('sku');
      const csv = [
        'title_ar,title_en,seller_sku,base_price',
        `منتج,Product,${sku},10`,
      ].join('\n');
      const key = unique('import');

      const first = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);

      const second = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);

      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replayed']).toBe('true');

      const variants = await prisma.offerVariant.findMany({
        where: { vendorId, sellerSku: sku },
      });
      expect(variants).toHaveLength(1);
    });

    it('the same Idempotency-Key with a DIFFERENT file is rejected as a conflict, not silently processed', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);
      const key = unique('import');

      const csv1 = [
        'title_ar,title_en,seller_sku,base_price',
        `منتج,Product,${unique('sku')},10`,
      ].join('\n');
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .attach('file', Buffer.from(csv1, 'utf-8'), 'products.csv')
        .expect(201);

      const csv2 = [
        'title_ar,title_en,seller_sku,base_price',
        `مختلف,Different,${unique('sku')},99`,
      ].join('\n');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .attach('file', Buffer.from(csv2, 'utf-8'), 'products.csv');
      expect(res.status).toBe(409);
    });

    it('refuses a BRANCH_EMPLOYEE from importing - owner-only', async () => {
      const { vendorId, employeeToken, owner } =
        await setupVendorWithTwoBranchesAndEmployee();
      await activateVendorSubscription(owner, vendorId);
      const csv = [
        'title_ar,title_en,seller_sku,base_price',
        `منتج,Product,${unique('sku')},10`,
      ].join('\n');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    });

    it("refuses an owner from importing into a DIFFERENT vendor's account (BOLA)", async () => {
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      await createVendorWithTwoBranches(owner1);
      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2Id } = await createVendorWithTwoBranches(owner2);
      await activateVendorSubscription(owner2, vendor2Id);

      const csv = [
        'title_ar,title_en,seller_sku,base_price',
        `منتج,Product,${unique('sku')},10`,
      ].join('\n');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendor2Id}/offers/import`)
        .set('Authorization', `Bearer ${owner1}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('NOT_VENDOR_MEMBER');
    });

    it('never imports media - image/video columns in the file are ignored entirely', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);
      const sku = unique('sku');
      const csv = [
        'title_ar,title_en,seller_sku,base_price,image_url,video_url',
        `منتج,Product,${sku},10,https://example.com/x.jpg,https://example.com/x.mp4`,
      ].join('\n');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);
      expect(res.body.imported).toHaveLength(1);

      const variantId = res.body.imported[0].variant_id;
      const media = await prisma.offerVariantMedia.findMany({
        where: { offerVariantId: variantId },
      });
      expect(media).toHaveLength(0);
    });

    // Review-round fix (Blocker 2): a file over the byte-size limit must
    // be rejected by multer's own limits check, which runs inside the
    // FileInterceptor before the controller method body (and therefore
    // before parseImportFile()/groupImportRows() ever run) - proven here
    // by asserting no VendorOffer was created for this vendor at all,
    // not just by the HTTP status. @nestjs/platform-express's
    // FileInterceptor already maps multer's LIMIT_FILE_SIZE to its own
    // PayloadTooLargeException (413, standard for "request body too
    // large") before the error ever reaches HttpExceptionFilter, so
    // there is nothing else to wire up for a clean, documented 4xx here.
    it('refuses a file exceeding the upload size limit, without ever reaching the parser/import logic', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await activateVendorSubscription(owner, vendorId);

      const oversized = Buffer.alloc(11 * 1024 * 1024, 'a');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/import`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('import'))
        .attach('file', oversized, 'huge.csv');

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');

      const offers = await prisma.vendorOffer.findMany({ where: { vendorId } });
      expect(offers).toHaveLength(0);
    });
  });

  describe('RB-STOREF-001: public storefront foundation', () => {
    it('defaults display_name to legal_name and generates a stable, unique slug at vendor creation', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const legalName = unique('Vendor');
      const res = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: legalName,
          branches: [{ name: 'A', is_physical: true }],
          applicable_categories: ['WOMEN'],
        })
        .expect(201);
      const vendorId = res.body.id;

      const settings = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/storefront`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(settings.body.display_name).toBe(legalName);
      expect(settings.body.slug).toBeTruthy();
      expect(settings.body.is_published).toBe(false);
    });

    // Review-round fix: migration 20260922100000's SQL backfill must
    // derive the exact same slug as generateVendorSlug() (slug.util.ts)
    // for the same inputs, including for a legalName that is entirely
    // non-ASCII (e.g. Arabic) and collapses to nothing under the
    // slugify regexes - an earlier version of the backfill SQL produced
    // SQL NULL in that case instead of falling back to the bare id, see
    // slug.util.spec.ts and the migration file's own comment. This runs
    // the migration's exact backfill expression directly against
    // Postgres (not through the application) and compares it to the
    // TypeScript function's output for both an ASCII and an Arabic
    // legalName.
    it('the migration backfill SQL produces the exact same slug as generateVendorSlug(), including for an Arabic legalName, with no leading dash', async () => {
      const id = 'cccccccc-dddd-eeee-ffff-000000000000';
      for (const legalName of ['My Test Store', 'متجر الأمل']) {
        const rows = await prisma.$queryRaw<{ slug: string }[]>`
          SELECT COALESCE(
            NULLIF(regexp_replace(lower(regexp_replace(${legalName}::text, '[^a-zA-Z0-9]+', '-', 'g')), '(^-+|-+$)', '', 'g'), '')
              || '-' || replace(${id}::text, '-', ''),
            replace(${id}::text, '-', '')
          ) AS slug
        `;
        const sqlSlug = rows[0].slug;
        expect(sqlSlug).toBe(generateVendorSlug(legalName, id));
        expect(sqlSlug.startsWith('-')).toBe(false);
        expect(sqlSlug).toMatch(/^[a-z0-9-]+$/);
      }
    });

    it('lets the owner update storefront settings', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/storefront`)
        .set('Authorization', `Bearer ${owner}`)
        .send({
          display_name: 'اسم جديد للمتجر',
          bio: 'نبذة عن المتجر',
          instagram_url: 'https://instagram.com/mystore',
        })
        .expect(200);
      expect(res.body.display_name).toBe('اسم جديد للمتجر');
      expect(res.body.bio).toBe('نبذة عن المتجر');
      expect(res.body.instagram_url).toBe('https://instagram.com/mystore');
    });

    it('PDR-007: refuses to publish without at least one contact method, then succeeds once one is set', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);

      const failRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/storefront/publish`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(403);
      expect(failRes.body.error.code).toBe('CONTACT_METHOD_REQUIRED');

      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/storefront`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ whatsapp_url: 'https://wa.me/1234567890' })
        .expect(200);
      // Sprint 8 (RB-STOREF-004, PDR-013) round 1: publish() now also
      // requires >=1 applicable category - see the dedicated Sprint 8
      // e2e spec for that requirement's own failure/success coverage;
      // this test only needs to satisfy it to keep exercising its own
      // original PDR-007 contact-method assertion below.
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/applicable-categories`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ categories: ['WOMEN'] })
        .expect(200);

      const publishRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/storefront/publish`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(publishRes.body.is_published).toBe(true);

      const unpublishRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/storefront/unpublish`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(unpublishRes.body.is_published).toBe(false);
    });

    it('refuses a BRANCH_EMPLOYEE from reading or editing storefront settings', async () => {
      const { vendorId, employeeToken } =
        await setupVendorWithTwoBranchesAndEmployee();

      const readRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/storefront`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
      expect(readRes.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');

      const writeRes = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/storefront`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ display_name: 'x' })
        .expect(403);
      expect(writeRes.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    });

    it('the public GET by slug returns identity/contacts, is unauthenticated, and never exposes the warehouse', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/storefront`)
        .set('Authorization', `Bearer ${owner}`)
        .send({
          display_name: 'متجر تجريبي',
          bio: 'نبيع كل شيء',
          whatsapp_url: 'https://wa.me/1234567890',
        })
        .expect(200);
      // Sprint 8 (RB-STOREF-004, PDR-013) round 1: publish() now also
      // requires >=1 applicable category.
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/applicable-categories`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ categories: ['WOMEN'] })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/storefront/publish`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);

      // Not yet ACTIVE (no subscription) - published but not available.
      const settings = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/storefront`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const slug = settings.body.slug;

      const publicRes = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}`)
        .expect(200);
      expect(publicRes.body.display_name).toBe('متجر تجريبي');
      expect(publicRes.body.bio).toBe('نبيع كل شيء');
      expect(publicRes.body.whatsapp_url).toBe('https://wa.me/1234567890');
      expect(publicRes.body.is_available).toBe(false);
      expect(JSON.stringify(publicRes.body)).not.toMatch(/warehouse/i);
      expect(publicRes.body.legal_name).toBeUndefined();

      // Now activate - published AND ACTIVE => available.
      await activateVendorSubscription(owner, vendorId);
      const availableRes = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${slug}`)
        .expect(200);
      expect(availableRes.body.is_available).toBe(true);
    });

    it('reports "unavailable" (never 404) for an existing but unpublished store - identity still shows', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      const settings = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/storefront`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);

      const publicRes = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${settings.body.slug}`)
        .expect(200);
      expect(publicRes.body.is_available).toBe(false);
      expect(publicRes.body.display_name).toBeTruthy();
    });

    it('404s a slug that does not exist at all', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/storefronts/this-slug-does-not-exist-at-all')
        .expect(404);
      expect(res.body.error.code).toBe('STOREFRONT_NOT_FOUND');
    });
  });
});
