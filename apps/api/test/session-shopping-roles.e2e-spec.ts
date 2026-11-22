import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';

// A store owner and a branch employee are shoppers too: with the same
// session token they use favourites, store follows, the cart, saved
// comparisons and the shopping profile exactly like a customer - and
// moving between their workspaces (reading /me/workspaces, a vendor
// route) never invalidates that token.
class FakeSmsService {
  sent: { phone: string; code: string }[] = [];
  async sendOtp(phone: string, code: string) {
    this.sent.push({ phone, code });
  }
  lastCodeFor(phone: string): string {
    const match = [...this.sent].reverse().find((s) => s.phone === phone);
    if (!match) throw new Error(`No OTP was sent to ${phone}`);
    return match.code;
  }
}

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}
// Palestinian mobile prefix (see the e2e phone conventions).
function phone(): string {
  counter += 1;
  return `+97059${String(Date.now() * 10 + (counter % 10)).slice(-7)}`;
}

describe('Signed-in owners and employees shop as customers (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sms: FakeSmsService;

  beforeEach(async () => {
    sms = new FakeSmsService();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SmsService)
      .useValue(sms)
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

  const http = () => app.getHttpServer();

  async function verified(p: string, purpose: string): Promise<string> {
    await request(http())
      .post('/api/v1/auth/otp/request')
      .send({ phone: p, purpose })
      .expect(202);
    const res = await request(http())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', unique('verify'))
      .send({ phone: p, otp_code: sms.lastCodeFor(p), purpose })
      .expect(200);
    return res.body.session_token as string;
  }

  async function signIn(p: string, password: string): Promise<string> {
    const res = await request(http())
      .post('/api/v1/auth/login')
      .send({ phone: p, password })
      .expect(200);
    return res.body.session_token as string;
  }

  /** An owner (real sign-up + store application), a published store with
   * one purchasable, favouritable product, and an invited employee. */
  async function setup() {
    const ownerPhone = phone();
    const register = await request(http())
      .post('/api/v1/auth/register')
      .send({
        phone: ownerPhone,
        password: 'owner-password',
        verification_token: await verified(ownerPhone, 'signup'),
      })
      .expect(201);
    const owner = register.body.session_token as string;
    const vendorRes = await request(http())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('vendor'))
      .send({
        legal_name: unique('Vendor'),
        store_type: 'PHYSICAL',
        branches: [{ name: 'الفرع', is_physical: true }],
        applicable_categories: ['WOMEN'],
        return_policy: { mode: 'NO_RETURN' },
      })
      .expect(201);
    const vendorId = vendorRes.body.id as string;
    const branchId = vendorRes.body.branches[0].id as string;
    const vendor = await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
        instagramUrl: 'https://instagram.com/store',
      },
    });
    await prisma.storeBranch.updateMany({
      where: { vendorId },
      data: { verificationStatus: 'APPROVED' },
    });

    const brand = await prisma.brand.create({
      data: { name: unique('Brand'), normalizedName: unique('brand') },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('Category') },
    });
    const product = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('Model'),
        canonicalNameAr: unique('اسم'),
        canonicalNameEn: unique('Name'),
        status: 'PUBLISHED',
      },
    });
    const canonicalVariant = await prisma.canonicalProductVariant.create({
      data: {
        canonicalProductId: product.id,
        structuralAttributes: {},
        platformProductBarcode: unique('platform-barcode'),
      },
    });
    const offer = await prisma.vendorOffer.create({
      data: { vendorId, titleAr: 'م', titleEn: 'P', status: 'ACTIVE' },
    });
    const variant = await prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique('sku'),
        basePrice: 50,
        storeInventoryBarcode: unique('barcode'),
        canonicalVariantId: canonicalVariant.id,
      },
    });
    await prisma.branchStock.create({
      data: { vendorId, branchId, offerVariantId: variant.id, quantity: 9 },
    });

    const employeePhone = phone();
    await request(http())
      .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('invite'))
      .send({ phone: employeePhone })
      .expect(201);
    await request(http())
      .post('/api/v1/auth/staff-invites/accept')
      .set('Idempotency-Key', unique('accept'))
      .send({
        phone: employeePhone,
        verification_token: await verified(employeePhone, 'staff_invite'),
        password: 'employee-password',
      })
      .expect(200);
    const employee = await signIn(employeePhone, 'employee-password');
    return {
      owner,
      employee,
      vendorId,
      branchId,
      slug: vendor.slug,
      productId: product.id,
      variantId: variant.id,
    };
  }

  async function shopsAsCustomer(
    token: string,
    s: Awaited<ReturnType<typeof setup>>,
  ) {
    const as = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    await as(request(http()).get('/api/v1/customers/me')).expect(200);

    // Favourites: add, list, remove.
    await as(request(http()).post('/api/v1/favorites'))
      .send({ target_type: 'PRODUCT', canonical_product_id: s.productId })
      .expect(201);
    const list = await as(request(http()).get('/api/v1/favorites')).expect(200);
    const fav = list.body.find(
      (f: { canonical_product_id: string }) =>
        f.canonical_product_id === s.productId,
    );
    expect(fav).toBeDefined();
    await as(request(http()).delete(`/api/v1/favorites/${fav.id}`)).expect(
      (r) => expect([200, 204]).toContain(r.status),
    );
    const after = await as(request(http()).get('/api/v1/favorites')).expect(
      200,
    );
    expect(
      after.body.some(
        (f: { canonical_product_id: string }) =>
          f.canonical_product_id === s.productId,
      ),
    ).toBe(false);

    // Follow the store, read it back, unfollow.
    const follow = await as(
      request(http()).put(`/api/v1/customers/me/following/${s.slug}`),
    ).expect(200);
    expect(follow.body.following).toBe(true);
    const status = await as(
      request(http()).get(`/api/v1/customers/me/following/${s.slug}`),
    ).expect(200);
    expect(status.body.following).toBe(true);
    await as(
      request(http()).delete(`/api/v1/customers/me/following/${s.slug}`),
    ).expect(200);

    // Cart and a saved comparison.
    await as(request(http()).post('/api/v1/cart/items'))
      .set('Idempotency-Key', unique('cart'))
      .send({
        vendor_id: s.vendorId,
        offer_variant_id: s.variantId,
        quantity: 1,
      })
      .expect(201);
    const cart = await as(request(http()).get('/api/v1/cart')).expect(200);
    expect(cart.body.length).toBeGreaterThan(0);
    await as(request(http()).post('/api/v1/customers/me/comparison-sets'))
      .send({ canonical_product_ids: [s.productId] })
      .expect(201);
    await as(
      request(http()).get('/api/v1/me/notifications/unread-count'),
    ).expect(200);
  }

  it('the store owner favourites, follows, fills a cart and saves a comparison with the same token', async () => {
    const s = await setup();
    await shopsAsCustomer(s.owner, s);
  });

  it('a branch employee does the same as a shopper', async () => {
    const s = await setup();
    await shopsAsCustomer(s.employee, s);
  });

  it('moving between workspaces never invalidates the session', async () => {
    const s = await setup();
    for (const token of [s.owner, s.employee]) {
      const ws = await request(http())
        .get('/api/v1/me/workspaces')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const types = ws.body.workspaces.map((w: { type: string }) => w.type);
      expect(types).toEqual(expect.arrayContaining(['customer', 'vendor']));
    }
    // Owner: store workspace, then shopping again, same token.
    await request(http())
      .get(`/api/v1/vendors/${s.vendorId}/storefront`)
      .set('Authorization', `Bearer ${s.owner}`)
      .expect(200);
    // Employee: their branch, then shopping again, same token.
    await request(http())
      .get(`/api/v1/vendors/${s.vendorId}/branches/${s.branchId}/stock`)
      .set('Authorization', `Bearer ${s.employee}`)
      .expect((r) => expect(r.status).toBeLessThan(400));
    for (const token of [s.owner, s.employee]) {
      await request(http())
        .get('/api/v1/favorites')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    }
    // Only signing out ends it.
    await request(http())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${s.employee}`)
      .expect((r) => expect(r.status).toBeLessThan(300));
    await request(http())
      .get('/api/v1/favorites')
      .set('Authorization', `Bearer ${s.employee}`)
      .expect(401);
    await request(http())
      .get('/api/v1/favorites')
      .set('Authorization', `Bearer ${s.owner}`)
      .expect(200);
  });

  it('without a token every shopping action is 401 (the web app then offers sign-in)', async () => {
    for (const [method, path] of [
      ['get', '/api/v1/favorites'],
      ['post', '/api/v1/favorites'],
      ['get', '/api/v1/cart'],
      ['put', '/api/v1/customers/me/following/any-store'],
      ['get', '/api/v1/customers/me'],
    ] as const) {
      await request(http())[method](path).send({}).expect(401);
    }
  });
});
