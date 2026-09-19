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

// Same +97056 prefix as sprint3-catalog/sprint4-roles's own uniquePhone()
// (the only PS mobile prefixes class-validator's IsPhoneNumber accepts
// under libphonenumber-js/max - see sprint4-roles.e2e-spec.ts's own
// comment) - a distinct numeric offset avoids collisions between files.
let phoneSeq = (Date.now() % 1_000_000) + 400_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97056${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 5 - store type/warehouse/pickup points, delivery zones, barcode split (e2e)', () => {
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

  async function createVendorWithBranch(
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

  /** Owner invites `phone` to `branchId`, requests + verifies the OTP,
   * and accepts - returns the invitee's session and the raw accept body. */
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

  async function createOwnerVendorAndEmployee() {
    const owner = await signup(uniquePhone(), 'a-strong-password');
    const { vendorId, branchId } = await createVendorWithBranch(owner);
    const employeePhone = uniquePhone();
    const accepted = await inviteAndAcceptAsNewUser(
      owner,
      vendorId,
      branchId,
      employeePhone,
      'employee-password',
    );
    return {
      owner,
      vendorId,
      branchId,
      employeeToken: accepted.session_token as string,
    };
  }

  /** Creates a CanonicalProduct + one variant as a seeded PLATFORM_ADMIN. */
  async function createCanonicalVariant(): Promise<{
    canonicalProductId: string;
    variantId: string;
    adminToken: string;
  }> {
    const adminPhone = uniquePhone();
    const adminToken = await signup(adminPhone, 'admin-password');
    await prisma.user.update({
      where: { phone: adminPhone },
      data: { platformRole: 'PLATFORM_ADMIN' },
    });

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
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', unique('cp'))
      .send({
        brand_id: brand.id,
        category_id: category.id,
        model_name: 'Model X',
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
      adminToken,
    };
  }

  /** Full happy-path onboarding (same flow as sprint3-catalog's own
   * activateVendorGivenBranch): evidence -> reviewer-approve -> subscribe
   * -> ACTIVE. Needed here only because VendorOffersController.create()
   * requires an ACTIVE subscription (FR-VEND-004/BR-014) - a rule that
   * pre-dates this sprint and has nothing to do with barcodes, but the
   * RB-INV-001 tests below still have to create a real offer to create a
   * variant under it. */
  async function activateVendorSubscription(
    ownerToken: string,
    vendorId: string,
    branchId: string,
  ): Promise<void> {
    const reviewerPhone = uniquePhone();
    const reviewerToken = await signup(reviewerPhone, 'reviewer-password');
    await prisma.user.update({
      where: { phone: reviewerPhone },
      data: { platformRole: 'VERIFICATION_REVIEWER' },
    });

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

  describe('RB-STORE-001: store type (physical/online-only/hybrid)', () => {
    it('defaults every new vendor to PHYSICAL', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body.store_type).toBe('PHYSICAL');
    });

    it('lets the owner switch store type to ONLINE_ONLY, persisted', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);

      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/store-type`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ store_type: 'ONLINE_ONLY' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body.store_type).toBe('ONLINE_ONLY');
    });

    it('refuses a BRANCH_EMPLOYEE from changing store type - store configuration is owner-only (PDR-009)', async () => {
      const { vendorId, employeeToken } = await createOwnerVendorAndEmployee();

      const res = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/store-type`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ store_type: 'HYBRID' })
        .expect(403);
      expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    });

    it('rejects an outsider entirely (BOLA) - never leaks store type to a non-member', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);
      const outsider = await signup(uniquePhone(), 'outsider-password');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}`)
        .set('Authorization', `Bearer ${outsider}`)
        .expect(403);
      expect(res.body.error.code).toBe('NOT_VENDOR_MEMBER');
    });
  });

  describe('RB-STORE-001: hidden warehouse (PDR-010) - never exposed in any vendor-facing response', () => {
    it('refuses to set a warehouse while store type is still PHYSICAL', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/warehouse`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ lat: 31.9, lng: 35.2, address_note: 'Behind the old mill' })
        .expect(400);
      expect(res.body.error.code).toBe('STORE_NOT_ONLINE_CAPABLE');
    });

    it('lets the owner set a warehouse once ONLINE_ONLY, saves it, but the response never echoes back its address - and the vendor summary/offers surfaces never include it either', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/store-type`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ store_type: 'ONLINE_ONLY' })
        .expect(200);

      const putRes = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/warehouse`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ lat: 31.9, lng: 35.2, address_note: 'Behind the old mill' })
        .expect(200);
      // Privacy requirement (PDR-010: "hidden"): the ack confirms the
      // write happened but never echoes the address back over HTTP.
      expect(Object.keys(putRes.body).sort()).toEqual(['id', 'vendor_id']);
      const bodyText = JSON.stringify(putRes.body);
      expect(bodyText).not.toContain('old mill');
      expect(bodyText).not.toContain('31.9');

      // It really was saved though - proven by reading straight from
      // the database, never through any HTTP response.
      const stored = await prisma.warehouse.findUnique({ where: { vendorId } });
      expect(stored?.addressNote).toBe('Behind the old mill');
      expect(stored?.lat).toBe(31.9);

      // And the vendor summary endpoint - the one general-purpose
      // vendor read in this controller - never leaks it either.
      const vendorRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(JSON.stringify(vendorRes.body)).not.toContain('old mill');
      expect(vendorRes.body.warehouse).toBeUndefined();
    });

    it('refuses a BRANCH_EMPLOYEE from setting the warehouse', async () => {
      const { vendorId, employeeToken, owner } =
        await createOwnerVendorAndEmployee();
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/store-type`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ store_type: 'HYBRID' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/warehouse`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ lat: 31.9, lng: 35.2 })
        .expect(403);
      expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    });

    it('rejects a direct write giving the same vendor two warehouses (one hidden execution location per store)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);
      await prisma.warehouse.create({ data: { vendorId } });

      await expect(
        prisma.warehouse.create({ data: { vendorId } }),
      ).rejects.toThrow();
    });
  });

  describe('RB-STORE-001: pickup points (public entity, holds no stock)', () => {
    it('lets the owner create a pickup point; any member (owner or employee) can list it', async () => {
      const { vendorId, employeeToken, owner } =
        await createOwnerVendorAndEmployee();

      const created = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/pickup-points`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('pickup'))
        .send({ name: 'Downtown Kiosk', lat: 31.9, lng: 35.2 })
        .expect(201);
      expect(created.body.is_active).toBe(true);

      const asOwner = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/pickup-points`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(asOwner.body).toHaveLength(1);

      const asEmployee = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/pickup-points`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
      expect(asEmployee.body).toHaveLength(1);
    });

    it('refuses a BRANCH_EMPLOYEE from creating a pickup point', async () => {
      const { vendorId, employeeToken } = await createOwnerVendorAndEmployee();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/pickup-points`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('pickup'))
        .send({ name: 'Rogue Kiosk' })
        .expect(403);
      expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    });

    it('404s a pickup point that belongs to a DIFFERENT vendor (BOLA)', async () => {
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor1Id } = await createVendorWithBranch(owner1);
      const created = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendor1Id}/pickup-points`)
        .set('Authorization', `Bearer ${owner1}`)
        .set('Idempotency-Key', unique('pickup'))
        .send({ name: 'Vendor 1 Kiosk' })
        .expect(201);

      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2Id } = await createVendorWithBranch(owner2);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendor2Id}/pickup-points/${created.body.id}`)
        .set('Authorization', `Bearer ${owner2}`)
        .expect(404);
      expect(res.body.error.code).toBe('PICKUP_POINT_NOT_FOUND');
    });
  });

  describe('RB-STORE-002: store-wide delivery zones (West Bank/Jerusalem/Inside, PDR-022)', () => {
    it('reports all three regions enabled by default, with no rows actually created yet (lazy default)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/delivery-zones`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(
        res.body.sort((a: { region: string }, b: { region: string }) =>
          a.region.localeCompare(b.region),
        ),
      ).toEqual(
        [
          { region: 'INSIDE', enabled: true },
          { region: 'JERUSALEM', enabled: true },
          { region: 'WEST_BANK', enabled: true },
        ].sort((a, b) => a.region.localeCompare(b.region)),
      );

      const rows = await prisma.vendorDeliveryZone.findMany({
        where: { vendorId },
      });
      expect(rows).toHaveLength(0);
    });

    it('lets the owner disable one zone without affecting the others, and re-enable it later', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);

      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/delivery-zones/JERUSALEM`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ enabled: false })
        .expect(200);

      const afterDisable = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/delivery-zones`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const jerusalem = afterDisable.body.find(
        (z: { region: string }) => z.region === 'JERUSALEM',
      );
      const westBank = afterDisable.body.find(
        (z: { region: string }) => z.region === 'WEST_BANK',
      );
      expect(jerusalem.enabled).toBe(false);
      expect(westBank.enabled).toBe(true);

      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/delivery-zones/JERUSALEM`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ enabled: true })
        .expect(200);
      const afterReenable = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/delivery-zones`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(
        afterReenable.body.find(
          (z: { region: string }) => z.region === 'JERUSALEM',
        ).enabled,
      ).toBe(true);
    });

    it('refuses a BRANCH_EMPLOYEE from changing a delivery zone', async () => {
      const { vendorId, employeeToken } = await createOwnerVendorAndEmployee();

      const res = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/delivery-zones/INSIDE`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ enabled: false })
        .expect(403);
      expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    });

    it('rejects an invalid region name (no geocoding, static placeholder list only - OPEN-012)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/delivery-zones/MARS`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ enabled: false })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_DELIVERY_ZONE_REGION');
    });
  });

  describe('RB-INV-001: barcode split (store_inventory_barcode vs platform_product_barcode, PDR-018)', () => {
    async function createOffer(
      ownerToken: string,
      vendorId: string,
      branchId: string,
    ): Promise<string> {
      // FR-VEND-004/BR-014: offer creation is gated on an ACTIVE
      // subscription, unrelated to barcodes but unavoidable to reach
      // the endpoint under test - see activateVendorSubscription.
      await activateVendorSubscription(ownerToken, vendorId, branchId);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'منتج', title_en: 'Product' })
        .expect(201);
      return res.body.id;
    }

    it('auto-generates a store_inventory_barcode when omitted, and keeps a vendor-supplied one as-is', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerId = await createOffer(owner, vendorId, branchId);

      const autoGenerated = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offerId}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant'))
        .send({ seller_sku: unique('sku'), base_price: 10 })
        .expect(201);
      expect(autoGenerated.body.store_inventory_barcode).toMatch(/^SIB-/);

      const supplied = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers/${offerId}/variants`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 10,
          store_inventory_barcode: '6291041500213',
        })
        .expect(201);
      expect(supplied.body.store_inventory_barcode).toBe('6291041500213');
    });

    it('enforces store_inventory_barcode uniqueness per vendor, but allows the SAME value across two different vendors', async () => {
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor1Id, branchId: branch1Id } =
        await createVendorWithBranch(owner1);
      const offer1Id = await createOffer(owner1, vendor1Id, branch1Id);

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendor1Id}/offers/${offer1Id}/variants`)
        .set('Authorization', `Bearer ${owner1}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 10,
          store_inventory_barcode: 'SHARED-CODE',
        })
        .expect(201);

      const conflict = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendor1Id}/offers/${offer1Id}/variants`)
        .set('Authorization', `Bearer ${owner1}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 10,
          store_inventory_barcode: 'SHARED-CODE',
        })
        .expect(409);
      expect(conflict.body.error.code).toBe(
        'STORE_INVENTORY_BARCODE_ALREADY_EXISTS',
      );

      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2Id, branchId: branch2Id } =
        await createVendorWithBranch(owner2);
      const offer2Id = await createOffer(owner2, vendor2Id, branch2Id);
      const otherVendor = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendor2Id}/offers/${offer2Id}/variants`)
        .set('Authorization', `Bearer ${owner2}`)
        .set('Idempotency-Key', unique('variant'))
        .send({
          seller_sku: unique('sku'),
          base_price: 10,
          store_inventory_barcode: 'SHARED-CODE',
        })
        .expect(201);
      expect(otherVendor.body.store_inventory_barcode).toBe('SHARED-CODE');
    });

    it('rejects a direct write creating two OfferVariants for the SAME vendor with the same store_inventory_barcode (database-layer integrity)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const offerId = await createOffer(owner, vendorId, branchId);

      await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: offerId,
          sellerSku: unique('sku'),
          basePrice: 10,
          storeInventoryBarcode: 'DIRECT-DUP',
        },
      });

      await expect(
        prisma.offerVariant.create({
          data: {
            vendorId,
            vendorOfferId: offerId,
            sellerSku: unique('sku'),
            basePrice: 10,
            storeInventoryBarcode: 'DIRECT-DUP',
          },
        }),
      ).rejects.toThrow();
    });

    it('auto-generates a globally-unique platformProductBarcode for every CanonicalProductVariant, and it never appears in the PUBLIC canonical-products responses', async () => {
      const { canonicalProductId, variantId } = await createCanonicalVariant();

      const stored = await prisma.canonicalProductVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(stored.platformProductBarcode).toMatch(/^PPB-/);

      // These GET routes are deliberately public/unauthenticated
      // (CanonicalProductsController) - no Authorization header at all.
      const productRes = await request(app.getHttpServer())
        .get(`/api/v1/canonical-products/${canonicalProductId}`)
        .expect(200);
      expect(JSON.stringify(productRes.body)).not.toMatch(/platform.*barcode/i);
      expect(JSON.stringify(productRes.body)).not.toContain(
        stored.platformProductBarcode,
      );

      const variantsRes = await request(app.getHttpServer())
        .get(`/api/v1/canonical-products/${canonicalProductId}/variants`)
        .expect(200);
      expect(JSON.stringify(variantsRes.body)).not.toMatch(
        /platform.*barcode/i,
      );
      expect(JSON.stringify(variantsRes.body)).not.toContain(
        stored.platformProductBarcode,
      );
    });

    it('rejects a direct write creating two CanonicalProductVariants with the same platformProductBarcode (global database-layer integrity)', async () => {
      const brand = await prisma.brand.create({
        data: {
          name: unique('Brand'),
          normalizedName: unique('brand').toLowerCase(),
        },
      });
      const category = await prisma.category.create({
        data: { nameAr: unique('فئة'), nameEn: unique('Category') },
      });
      const product = await prisma.canonicalProduct.create({
        data: { brandId: brand.id, categoryId: category.id, modelName: 'X' },
      });
      // platformProductBarcode is globally unique (not scoped to this
      // product/brand/category, all freshly created above) - unique()
      // avoids colliding with a leftover row from a previous run of
      // this same test against a not-yet-reset database.
      const duplicateBarcode = unique('PPB-DIRECT-DUP');
      await prisma.canonicalProductVariant.create({
        data: {
          canonicalProductId: product.id,
          structuralAttributes: {},
          platformProductBarcode: duplicateBarcode,
        },
      });

      await expect(
        prisma.canonicalProductVariant.create({
          data: {
            canonicalProductId: product.id,
            structuralAttributes: {},
            platformProductBarcode: duplicateBarcode,
          },
        }),
      ).rejects.toThrow();
    });
  });
});
