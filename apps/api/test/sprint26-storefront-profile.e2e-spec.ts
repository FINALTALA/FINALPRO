import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as request from 'supertest';
import { configureUploadServing } from './../src/uploads/uploads.util';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// Sprint 26: the customer store page's profile additions - the public
// follower count, the per-offer created_at/favorite_variant_id the
// page sorts and favorites by, and the owner's ability to clear a
// storefront field. No OTP flow is needed (and none is used, so this
// file takes no phone lane): users are inserted directly and given a
// session through SessionService, the same way auth.e2e-spec.ts forges
// one. Their phones use a +999 prefix no lane ever draws from.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

// Uploaded files go to a throwaway directory for this file's run only.
const UPLOADS_ROOT = mkdtempSync(path.join(os.tmpdir(), 'sprint26-uploads-'));
process.env.UPLOADS_DIR = UPLOADS_ROOT;

describe('Sprint 26 - storefront profile (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  afterAll(async () => {
    await rm(UPLOADS_ROOT, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // Before init(), exactly as main.ts does - Nest installs its 404
    // handler during init, so static serving must already be in place.
    configureUploadServing(app);
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

  async function makeUser() {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: 'not-used', phoneVerifiedAt: new Date() },
    });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { user, token };
  }

  async function makeStore() {
    return prisma.vendor.create({
      data: {
        slug: unique('store'),
        legalName: unique('Legal'),
        displayName: unique('متجر'),
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
        whatsappUrl: 'https://wa.me/970560000000',
      },
    });
  }

  async function makeCanonicalVariant() {
    const brand = await prisma.brand.create({
      data: { name: unique('Brand'), normalizedName: unique('brand') },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('Cat') },
    });
    const product = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('Model'),
        status: 'PUBLISHED',
        canonicalNameAr: unique('منتج'),
        canonicalNameEn: unique('Product'),
      },
    });
    const variant = await prisma.canonicalProductVariant.create({
      data: {
        canonicalProductId: product.id,
        structuralAttributes: {},
        gtin: unique('gtin'),
        platformProductBarcode: unique('PPB'),
      },
    });
    return { product, variant };
  }

  async function makeOffer(
    vendorId: string,
    variants: { price: number; canonicalVariantId: string | null }[],
  ) {
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId,
        titleAr: unique('عرض'),
        titleEn: unique('Offer'),
        status: 'ACTIVE',
      },
    });
    const created = [];
    for (const v of variants) {
      created.push(
        await prisma.offerVariant.create({
          data: {
            vendorId,
            vendorOfferId: offer.id,
            canonicalVariantId: v.canonicalVariantId,
            matchProposalStatus: v.canonicalVariantId ? 'CONFIRMED' : 'NONE',
            sellerSku: unique('sku'),
            basePrice: v.price,
            storeInventoryBarcode: unique('barcode'),
          },
        }),
      );
    }
    return { offer, variants: created };
  }

  it('the public storefront reports how many accounts follow it', async () => {
    const store = await makeStore();
    const before = await request(app.getHttpServer())
      .get(`/api/v1/storefronts/${store.slug}`)
      .expect(200);
    expect(before.body.follower_count).toBe(0);

    for (let i = 0; i < 2; i += 1) {
      const { token } = await makeUser();
      await request(app.getHttpServer())
        .put(`/api/v1/customers/me/following/${store.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    }
    const after = await request(app.getHttpServer())
      .get(`/api/v1/storefronts/${store.slug}`)
      .expect(200);
    expect(after.body.follower_count).toBe(2);
  });

  it('offer summaries carry created_at and the cheapest favoritable variant', async () => {
    const store = await makeStore();
    const a = await makeCanonicalVariant();
    const b = await makeCanonicalVariant();
    const matched = await makeOffer(store.id, [
      { price: 90, canonicalVariantId: a.variant.id },
      { price: 40, canonicalVariantId: b.variant.id },
      // Cheapest overall, but unmatched - FavoritesService would refuse it.
      { price: 10, canonicalVariantId: null },
    ]);
    const unmatched = await makeOffer(store.id, [
      { price: 20, canonicalVariantId: null },
    ]);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/storefronts/${store.slug}/sections`)
      .expect(200);
    const byId = new Map<string, Record<string, unknown>>(
      res.body.all.map((o: Record<string, unknown>) => [o.id, o]),
    );
    const matchedDto = byId.get(matched.offer.id)!;
    expect(matchedDto.favorite_variant_id).toBe(matched.variants[1].id);
    expect(matchedDto.created_at).toBe(matched.offer.createdAt.toISOString());
    expect(byId.get(unmatched.offer.id)!.favorite_variant_id).toBeNull();
  });

  it('the advertised favorite_variant_id is accepted by POST /favorites', async () => {
    const store = await makeStore();
    const { variant } = await makeCanonicalVariant();
    const { offer } = await makeOffer(store.id, [
      { price: 35, canonicalVariantId: variant.id },
    ]);
    const sections = await request(app.getHttpServer())
      .get(`/api/v1/storefronts/${store.slug}/sections`)
      .expect(200);
    const dto = sections.body.all.find(
      (o: { id: string }) => o.id === offer.id,
    );
    const { token } = await makeUser();
    await request(app.getHttpServer())
      .post('/api/v1/favorites')
      .set('Authorization', `Bearer ${token}`)
      .send({ target_type: 'OFFER', offer_variant_id: dto.favorite_variant_id })
      .expect(201);
  });

  describe('owner storefront settings', () => {
    async function makeOwnedStore() {
      const store = await makeStore();
      const owner = await makeUser();
      await prisma.vendorUser.create({
        data: { userId: owner.user.id, vendorId: store.id, role: 'OWNER' },
      });
      return { store, token: owner.token };
    }

    it('an empty string clears a field, on the owner and public reads alike', async () => {
      const { store, token } = await makeOwnedStore();
      const res = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${store.id}/storefront`)
        .set('Authorization', `Bearer ${token}`)
        .send({ whatsapp_url: '' })
        .expect(200);
      expect(res.body.whatsapp_url).toBeNull();
      const row = await prisma.vendor.findUniqueOrThrow({
        where: { id: store.id },
      });
      expect(row.whatsappUrl).toBeNull();
      const publicRes = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${store.slug}`)
        .expect(200);
      expect(publicRes.body.whatsapp_url).toBeNull();
    });

    it('cover_color accepts only a #rrggbb hex colour', async () => {
      const { store, token } = await makeOwnedStore();
      for (const cover_color of ['red', '#fff', 'url(x)', '#12345g']) {
        await request(app.getHttpServer())
          .put(`/api/v1/vendors/${store.id}/storefront`)
          .set('Authorization', `Bearer ${token}`)
          .send({ cover_color })
          .expect(400);
      }
      const ok = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${store.id}/storefront`)
        .set('Authorization', `Bearer ${token}`)
        .send({ cover_color: '#4a1626' })
        .expect(200);
      expect(ok.body.cover_color).toBe('#4a1626');
    });

    it('a non-empty invalid URL is still refused', async () => {
      const { store, token } = await makeOwnedStore();
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${store.id}/storefront`)
        .set('Authorization', `Bearer ${token}`)
        .send({ whatsapp_url: 'not a url' })
        .expect(400);
    });
  });

  describe('image uploads', () => {
    // Real file signatures only - the API never trusts the filename.
    const PNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 1),
    ]);
    const SVG = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
    );

    async function makeOwnedStore() {
      const store = await makeStore();
      const owner = await makeUser();
      await prisma.vendorUser.create({
        data: { userId: owner.user.id, vendorId: store.id, role: 'OWNER' },
      });
      return { store, token: owner.token };
    }

    function upload(
      vendorId: string,
      token: string,
      body: Buffer,
      name: string,
    ) {
      return request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/uploads`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', body, name);
    }

    it('stores a real image under the vendor and serves it back read-only', async () => {
      const { store, token } = await makeOwnedStore();
      const res = await upload(store.id, token, PNG, 'logo.png').expect(201);
      expect(res.body.content_type).toBe('image/png');
      expect(res.body.url).toMatch(
        new RegExp(`/uploads/vendors/${store.id}/[0-9a-f]{32}\\.png$`),
      );
      const served = await request(app.getHttpServer())
        .get(new URL(res.body.url).pathname)
        .expect(200);
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.compare(served.body as Buffer, PNG)).toBe(0);
    });

    it('refuses SVG/non-images whatever the filename says, and non-owners', async () => {
      const { store, token } = await makeOwnedStore();
      const svg = await upload(store.id, token, SVG, 'logo.png').expect(400);
      expect(svg.body.error.code).toBe('UNSUPPORTED_IMAGE_TYPE');
      await upload(store.id, token, Buffer.from('hello'), 'x.jpg').expect(400);
      const stranger = await makeUser();
      await upload(store.id, stranger.token, PNG, 'logo.png').expect(403);
    });

    it('an uploaded image can become the logo/cover and a product photo', async () => {
      const { store, token } = await makeOwnedStore();
      const { url } = (
        await upload(store.id, token, PNG, 'cover.png').expect(201)
      ).body;
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${store.id}/storefront`)
        .set('Authorization', `Bearer ${token}`)
        .send({ logo_url: url, cover_image_url: url })
        .expect(200);
      const pub = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${store.slug}`)
        .expect(200);
      expect(pub.body.cover_image_url).toBe(url);

      const { variant } = await makeCanonicalVariant();
      const { offer, variants } = await makeOffer(store.id, [
        { price: 50, canonicalVariantId: variant.id },
      ]);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${store.id}/offers/${offer.id}/variants/${variants[0].id}/media`,
        )
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', unique('media'))
        .send({ url, kind: 'PRIMARY', media_type: 'IMAGE' })
        .expect(201);
      const sections = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${store.slug}/sections`)
        .expect(200);
      expect(sections.body.all[0].image_url).toBe(url);
    });

    it('a SUSPENDED store cannot upload (same rule as its media/storefront edits), and nothing is written', async () => {
      const { store, token } = await makeOwnedStore();
      await prisma.vendor.update({
        where: { id: store.id },
        data: { status: 'SUSPENDED' },
      });
      const res = await upload(store.id, token, PNG, 'logo.png').expect(403);
      expect(res.body.error.code).toBe('VENDOR_SUSPENDED');
      expect(existsSync(path.join(UPLOADS_ROOT, 'vendors', store.id))).toBe(
        false,
      );
    });

    it("another store's upload, or a made-up upload URL, cannot be attached", async () => {
      const a = await makeOwnedStore();
      const b = await makeOwnedStore();
      const { url } = (
        await upload(a.store.id, a.token, PNG, 'a.png').expect(201)
      ).body;
      const res = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${b.store.id}/storefront`)
        .set('Authorization', `Bearer ${b.token}`)
        .send({ logo_url: url })
        .expect(400);
      expect(res.body.error.code).toBe('UPLOAD_NOT_USABLE');
      const fake = url.replace(/[0-9a-f]{32}/, 'f'.repeat(32));
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${a.store.id}/storefront`)
        .set('Authorization', `Bearer ${a.token}`)
        .send({ logo_url: fake })
        .expect(400);
    });
  });

  it('discounted offers carry the original price and the percentage off', async () => {
    const store = await makeStore();
    const { offer, variants } = await makeOffer(store.id, [
      { price: 200, canonicalVariantId: null },
    ]);
    await prisma.offerVariant.update({
      where: { id: variants[0].id },
      data: { salePrice: 150 },
    });
    const plain = await makeOffer(store.id, [
      { price: 80, canonicalVariantId: null },
    ]);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/storefronts/${store.slug}/sections`)
      .expect(200);
    const byId = new Map<string, Record<string, unknown>>(
      res.body.all.map((o: Record<string, unknown>) => [o.id, o]),
    );
    expect(byId.get(offer.id)).toMatchObject({
      min_price: '150.00',
      original_price: '200.00',
      discount_percent: 25,
    });
    expect(byId.get(plain.offer.id)).toMatchObject({
      original_price: null,
      discount_percent: null,
    });
  });

  describe('GET /storefronts/:slug/info', () => {
    it('lists branches with hours, only priced+enabled delivery regions, and the return policy', async () => {
      const store = await makeStore();
      await prisma.vendor.update({
        where: { id: store.id },
        data: {
          returnsEnabled: true,
          returnMode: 'BOTH',
          returnWindowDays: 14,
          returnFeeIls: 10,
        },
      });
      const branch = await prisma.storeBranch.create({
        data: { vendorId: store.id, name: 'فرع رام الله' },
      });
      await prisma.branchOperatingHours.create({
        data: {
          vendorId: store.id,
          branchId: branch.id,
          dayOfWeek: 0,
          openMinute: 9 * 60,
          closeMinute: 21 * 60,
        },
      });
      await prisma.storeBranch.create({
        data: { vendorId: store.id, name: 'مؤرشف', archivedAt: new Date() },
      });
      await prisma.vendorDeliveryZone.createMany({
        data: [
          {
            vendorId: store.id,
            region: 'WEST_BANK',
            fee: 20,
            minimumOrderValue: 50,
          },
          // Enabled but never priced: not deliverable, so not listed.
          { vendorId: store.id, region: 'JERUSALEM' },
          { vendorId: store.id, region: 'INSIDE', fee: 60, enabled: false },
        ],
      });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${store.slug}/info`)
        .expect(200);
      expect(res.body.branches).toHaveLength(1);
      expect(res.body.branches[0]).toMatchObject({
        name: 'فرع رام الله',
        is_physical: true,
        hours: [{ day_of_week: 0, open_minute: 540, close_minute: 1260 }],
      });
      expect(typeof res.body.branches[0].open_now).toBe('boolean');
      expect(res.body.branches[0]).not.toHaveProperty('lat');
      expect(res.body.delivery).toEqual([
        { region: 'WEST_BANK', fee_ils: 20, minimum_order_ils: 50 },
      ]);
      expect(res.body.returns).toMatchObject({
        mode: 'BOTH',
        window_days: 14,
        fee_ils: 10,
      });
    });

    it('an unavailable store answers with empty facts, never a 404', async () => {
      const store = await makeStore();
      await prisma.vendor.update({
        where: { id: store.id },
        data: { storefrontPublished: false },
      });
      const res = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${store.slug}/info`)
        .expect(200);
      expect(res.body).toEqual({
        is_available: false,
        branches: [],
        delivery: [],
        returns: null,
      });
    });
  });
});
