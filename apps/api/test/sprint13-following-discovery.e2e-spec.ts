import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { StoreApplicableCategory } from './../generated/prisma/client';
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

// PS mobile numbers validate only under 056/059 (see the same note in
// the Sprint 8 spec); a distinct numeric offset keeps every test's
// phone unique without using the invalid 057/058 prefixes.
let phoneSeq = (Date.now() % 1_000_000) + 1_700_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97056${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 13 - following, segments, search, card enrichment (e2e)', () => {
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

  beforeEach(async () => {
    const ids = Object.values(cachedUsers).map((u) => u.userId);
    if (ids.length > 0) {
      await prisma.storeFollow.deleteMany({ where: { userId: { in: ids } } });
    }
  });

  // POST /auth/otp/request is throttled to 5/60s across the whole file
  // run, so two accounts are signed up once and reused; their follows
  // are cleared before every test so no state bleeds between tests.
  const cachedUsers: Record<string, { token: string; userId: string }> = {};
  async function getUser(key: 'a' | 'b') {
    if (!cachedUsers[key]) cachedUsers[key] = await signupNew();
    return cachedUsers[key];
  }

  async function signupNew(): Promise<{ token: string; userId: string }> {
    const phone = uniquePhone();
    const password = 'a-strong-password';
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'signup' })
      .expect(202);
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', `verify-${phone}`)
      .send({
        phone,
        otp_code: fakeSms.lastCodeFor(phone),
        purpose: 'signup',
      })
      .expect(200);
    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ phone, password, verification_token: verify.body.session_token })
      .expect(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    return { token: register.body.session_token as string, userId: user.id };
  }

  async function makeStore(
    opts: {
      published?: boolean;
      status?: 'ACTIVE' | 'SUSPENDED';
      categories?: StoreApplicableCategory[];
      displayName?: string;
      logoUrl?: string;
    } = {},
  ) {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('store'),
        legalName: unique('Legal'),
        displayName: opts.displayName ?? unique('متجر'),
        logoUrl: opts.logoUrl,
        status: opts.status ?? 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: opts.published ?? true,
        instagramUrl: 'https://instagram.com/example',
      },
    });
    for (const category of opts.categories ?? ['WOMEN']) {
      await prisma.vendorApplicableCategory.create({
        data: { vendorId: vendor.id, category },
      });
    }
    return vendor;
  }

  async function makeProduct(opts: {
    nameAr: string;
    nameEn: string;
    brand?: string;
    categoryAr?: string;
    attributes?: Record<string, string>;
  }) {
    const brand = await prisma.brand.create({
      data: {
        name: opts.brand ?? unique('Brand'),
        normalizedName: unique('brand').toLowerCase(),
      },
    });
    const category = await prisma.category.create({
      data: { nameAr: opts.categoryAr ?? unique('فئة'), nameEn: unique('Cat') },
    });
    const product = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('Model'),
        status: 'PUBLISHED',
        canonicalNameAr: opts.nameAr,
        canonicalNameEn: opts.nameEn,
      },
    });
    const variant = await prisma.canonicalProductVariant.create({
      data: {
        canonicalProductId: product.id,
        structuralAttributes: opts.attributes ?? {},
        gtin: unique('gtin'),
        platformProductBarcode: unique('PPB'),
      },
    });
    return { product, variant };
  }

  async function makeOffer(
    vendorId: string,
    productId: string,
    variantId: string,
    price: number,
    imageUrl?: string,
    offerStatus: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
  ) {
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId,
        canonicalProductId: productId,
        titleAr: unique('عرض'),
        titleEn: unique('Offer'),
        status: offerStatus,
      },
    });
    const offerVariant = await prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        canonicalVariantId: variantId,
        matchProposalStatus: 'CONFIRMED',
        sellerSku: unique('sku'),
        basePrice: price,
        storeInventoryBarcode: unique('barcode'),
      },
    });
    if (imageUrl) {
      await prisma.offerVariantMedia.create({
        data: {
          vendorId,
          offerVariantId: offerVariant.id,
          url: imageUrl,
          kind: 'PRIMARY',
        },
      });
    }
    return { offer, offerVariant };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  describe('follow / unfollow', () => {
    it('requires a signed-in session for every following route', async () => {
      const store = await makeStore();
      await request(app.getHttpServer())
        .put(`/api/v1/customers/me/following/${store.slug}`)
        .expect(401);
      await request(app.getHttpServer())
        .delete(`/api/v1/customers/me/following/${store.slug}`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/api/v1/customers/me/following/${store.slug}`)
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/customers/me/following')
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/customers/me/following/feed')
        .expect(401);
    });

    it('follow is idempotent and persisted; unfollow removes it (also idempotent)', async () => {
      const { token, userId } = await getUser('a');
      const store = await makeStore();

      const status0 = await request(app.getHttpServer())
        .get(`/api/v1/customers/me/following/${store.slug}`)
        .set(auth(token))
        .expect(200);
      expect(status0.body.following).toBe(false);

      for (let i = 0; i < 2; i++) {
        const res = await request(app.getHttpServer())
          .put(`/api/v1/customers/me/following/${store.slug}`)
          .set(auth(token))
          .expect(200);
        expect(res.body.following).toBe(true);
      }
      expect(await prisma.storeFollow.count({ where: { userId } })).toBe(1);

      const status1 = await request(app.getHttpServer())
        .get(`/api/v1/customers/me/following/${store.slug}`)
        .set(auth(token))
        .expect(200);
      expect(status1.body.following).toBe(true);

      for (let i = 0; i < 2; i++) {
        const res = await request(app.getHttpServer())
          .delete(`/api/v1/customers/me/following/${store.slug}`)
          .set(auth(token))
          .expect(200);
        expect(res.body.following).toBe(false);
      }
      expect(await prisma.storeFollow.count({ where: { userId } })).toBe(0);
    });

    it('the database itself rejects a duplicate (user, store) follow', async () => {
      const { userId } = await getUser('a');
      const store = await makeStore();
      await prisma.storeFollow.create({
        data: { userId, vendorId: store.id },
      });
      await expect(
        prisma.storeFollow.create({ data: { userId, vendorId: store.id } }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('unknown store is 404; unpublished or suspended store cannot be followed (409)', async () => {
      const { token, userId } = await getUser('a');
      await request(app.getHttpServer())
        .put('/api/v1/customers/me/following/no-such-store-slug')
        .set(auth(token))
        .expect(404);

      const unpublished = await makeStore({ published: false });
      const suspended = await makeStore({ status: 'SUSPENDED' });
      for (const store of [unpublished, suspended]) {
        const res = await request(app.getHttpServer())
          .put(`/api/v1/customers/me/following/${store.slug}`)
          .set(auth(token))
          .expect(409);
        expect(res.body.error.code).toBe('STORE_UNAVAILABLE');
      }
      expect(await prisma.storeFollow.count({ where: { userId } })).toBe(0);
    });

    it("BOLA: one account can never see or remove another account's follows", async () => {
      const a = await getUser('a');
      const b = await getUser('b');
      const store = await makeStore();
      await request(app.getHttpServer())
        .put(`/api/v1/customers/me/following/${store.slug}`)
        .set(auth(a.token))
        .expect(200);

      const bList = await request(app.getHttpServer())
        .get('/api/v1/customers/me/following')
        .set(auth(b.token))
        .expect(200);
      expect(bList.body.items).toEqual([]);
      const bStatus = await request(app.getHttpServer())
        .get(`/api/v1/customers/me/following/${store.slug}`)
        .set(auth(b.token))
        .expect(200);
      expect(bStatus.body.following).toBe(false);

      await request(app.getHttpServer())
        .delete(`/api/v1/customers/me/following/${store.slug}`)
        .set(auth(b.token))
        .expect(200);
      expect(
        await prisma.storeFollow.count({ where: { userId: a.userId } }),
      ).toBe(1);

      const aList = await request(app.getHttpServer())
        .get('/api/v1/customers/me/following')
        .set(auth(a.token))
        .expect(200);
      expect(aList.body.items.map((s: { slug: string }) => s.slug)).toEqual([
        store.slug,
      ]);
    });
  });

  describe('following list and feed', () => {
    it('lists only followed, available stores; an unpublished or suspended store disappears but the follow is kept and returns when available again', async () => {
      const { token, userId } = await getUser('a');
      const keep = await makeStore({ logoUrl: '/demo-assets/keep.svg' });
      const flaky = await makeStore();
      const other = await makeStore();
      for (const s of [keep, flaky]) {
        await request(app.getHttpServer())
          .put(`/api/v1/customers/me/following/${s.slug}`)
          .set(auth(token))
          .expect(200);
      }

      const slugs = async () =>
        (
          await request(app.getHttpServer())
            .get('/api/v1/customers/me/following')
            .set(auth(token))
            .expect(200)
        ).body.items.map((s: { slug: string }) => s.slug);

      expect((await slugs()).sort()).toEqual([keep.slug, flaky.slug].sort());
      expect(await slugs()).not.toContain(other.slug);

      await prisma.vendor.update({
        where: { id: flaky.id },
        data: { storefrontPublished: false },
      });
      expect(await slugs()).toEqual([keep.slug]);

      await prisma.vendor.update({
        where: { id: flaky.id },
        data: { storefrontPublished: true, status: 'SUSPENDED' },
      });
      expect(await slugs()).toEqual([keep.slug]);
      expect(await prisma.storeFollow.count({ where: { userId } })).toBe(2);

      await prisma.vendor.update({
        where: { id: flaky.id },
        data: { status: 'ACTIVE' },
      });
      expect((await slugs()).sort()).toEqual([keep.slug, flaky.slug].sort());

      const list = await request(app.getHttpServer())
        .get('/api/v1/customers/me/following')
        .set(auth(token))
        .expect(200);
      const keepItem = list.body.items.find(
        (s: { slug: string }) => s.slug === keep.slug,
      );
      expect(keepItem.logo_url).toBe('/demo-assets/keep.svg');
      expect(keepItem.display_name).toBeTruthy();
    });

    it('feed contains only eligible products that have an offer from a followed store, as global cards', async () => {
      const { token } = await getUser('a');
      const followed = await makeStore();
      const notFollowed = await makeStore();
      const unpublishedFollowed = await makeStore();

      const shared = await makeProduct({ nameAr: 'مشترك', nameEn: 'Shared' });
      await makeOffer(followed.id, shared.product.id, shared.variant.id, 100);
      await makeOffer(notFollowed.id, shared.product.id, shared.variant.id, 80);

      const onlyFollowed = await makeProduct({
        nameAr: 'للمتابَع فقط',
        nameEn: 'FollowedOnly',
      });
      await makeOffer(
        followed.id,
        onlyFollowed.product.id,
        onlyFollowed.variant.id,
        50,
      );

      const onlyOther = await makeProduct({
        nameAr: 'لغير المتابَع',
        nameEn: 'OtherOnly',
      });
      await makeOffer(
        notFollowed.id,
        onlyOther.product.id,
        onlyOther.variant.id,
        40,
      );

      const fromUnpublished = await makeProduct({
        nameAr: 'من متجر غير منشور',
        nameEn: 'FromUnpublished',
      });
      await makeOffer(
        unpublishedFollowed.id,
        fromUnpublished.product.id,
        fromUnpublished.variant.id,
        30,
      );

      for (const s of [followed, unpublishedFollowed]) {
        await request(app.getHttpServer())
          .put(`/api/v1/customers/me/following/${s.slug}`)
          .set(auth(token))
          .expect(200);
      }
      await prisma.vendor.update({
        where: { id: unpublishedFollowed.id },
        data: { storefrontPublished: false },
      });

      const feed = await request(app.getHttpServer())
        .get('/api/v1/customers/me/following/feed')
        .set(auth(token))
        .expect(200);
      const ids = feed.body.items.map(
        (c: { canonical_product_id: string }) => c.canonical_product_id,
      );
      expect(ids.sort()).toEqual(
        [shared.product.id, onlyFollowed.product.id].sort(),
      );
      const sharedCard = feed.body.items.find(
        (c: { canonical_product_id: string }) =>
          c.canonical_product_id === shared.product.id,
      );
      // A global card: it still compares against the non-followed store.
      expect(sharedCard.store_count).toBe(2);
      expect(sharedCard.lowest_price).toBe('80.00');
    });

    it('an account following nobody has an empty feed and list', async () => {
      const { token } = await getUser('a');
      const feed = await request(app.getHttpServer())
        .get('/api/v1/customers/me/following/feed')
        .set(auth(token))
        .expect(200);
      expect(feed.body.items).toEqual([]);
      expect(feed.body.total).toBe(0);
    });

    it('feed never crosses accounts', async () => {
      const a = await getUser('a');
      const b = await getUser('b');
      const store = await makeStore();
      const p = await makeProduct({ nameAr: 'منتج', nameEn: 'Prod' });
      await makeOffer(store.id, p.product.id, p.variant.id, 10);
      await request(app.getHttpServer())
        .put(`/api/v1/customers/me/following/${store.slug}`)
        .set(auth(a.token))
        .expect(200);
      const bFeed = await request(app.getHttpServer())
        .get('/api/v1/customers/me/following/feed')
        .set(auth(b.token))
        .expect(200);
      expect(bFeed.body.items).toEqual([]);
    });
  });

  describe('discovery segments, search and card enrichment', () => {
    it('segment narrows to products sold by stores of that applicable category', async () => {
      const womenStore = await makeStore({ categories: ['WOMEN'] });
      const menStore = await makeStore({ categories: ['MEN', 'ACCESSORIES'] });
      const tag = unique('seg');
      const w = await makeProduct({
        nameAr: `${tag}-نساء`,
        nameEn: `${tag}-w`,
      });
      const m = await makeProduct({
        nameAr: `${tag}-رجال`,
        nameEn: `${tag}-m`,
      });
      await makeOffer(womenStore.id, w.product.id, w.variant.id, 10);
      await makeOffer(menStore.id, m.product.id, m.variant.id, 10);

      const ids = async (segment: string) =>
        (
          await request(app.getHttpServer())
            .get(
              `/api/v1/discovery/all?segment=${segment}&q=${encodeURIComponent(tag)}`,
            )
            .expect(200)
        ).body.items.map(
          (c: { canonical_product_id: string }) => c.canonical_product_id,
        );

      expect(await ids('women')).toEqual([w.product.id]);
      expect(await ids('men')).toEqual([m.product.id]);
      expect(await ids('accessories')).toEqual([m.product.id]);
      expect(await ids('kids')).toEqual([]);
      expect((await ids('all')).sort()).toEqual(
        [w.product.id, m.product.id].sort(),
      );
    });

    it('rejects an unknown segment', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/discovery/all?segment=pets')
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_SEGMENT');
    });

    it('search matches name, brand and category (case-insensitive) and never lists an unavailable store product', async () => {
      const store = await makeStore();
      const hidden = await makeStore({ published: false });
      const tag = unique('needle');
      const visible = await makeProduct({
        nameAr: 'قميص',
        nameEn: 'Plain',
        brand: `${tag}-Brand`,
      });
      const byCategory = await makeProduct({
        nameAr: 'بنطال',
        nameEn: 'Trouser',
        categoryAr: `${tag}-cat`,
      });
      const invisible = await makeProduct({
        nameAr: `${tag}-مخفي`,
        nameEn: 'Hidden',
      });
      await makeOffer(store.id, visible.product.id, visible.variant.id, 10);
      await makeOffer(
        store.id,
        byCategory.product.id,
        byCategory.variant.id,
        10,
      );
      await makeOffer(
        hidden.id,
        invisible.product.id,
        invisible.variant.id,
        10,
      );

      const res = await request(app.getHttpServer())
        .get(`/api/v1/discovery/all?q=${encodeURIComponent(tag.toUpperCase())}`)
        .expect(200);
      expect(
        res.body.items
          .map((c: { canonical_product_id: string }) => c.canonical_product_id)
          .sort(),
      ).toEqual([visible.product.id, byCategory.product.id].sort());

      const none = await request(app.getHttpServer())
        .get('/api/v1/discovery/all?q=zzzz-no-such-thing-zzzz')
        .expect(200);
      expect(none.body.items).toEqual([]);
    });

    it('cards carry real image, brand, category, store count, colours and sizes', async () => {
      const s1 = await makeStore({ logoUrl: '/demo-assets/a.svg' });
      const s2 = await makeStore();
      const tag = unique('card');
      const p = await makeProduct({
        nameAr: `${tag}-قميص`,
        nameEn: `${tag}-shirt`,
        brand: 'Acme',
        categoryAr: 'قمصان',
        attributes: { color: 'أبيض', size: 'M' },
      });
      await makeOffer(s1.id, p.product.id, p.variant.id, 120, '/img/one.png');
      await makeOffer(s2.id, p.product.id, p.variant.id, 135);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/discovery/all?q=${encodeURIComponent(tag)}`)
        .expect(200);
      expect(res.body.items).toHaveLength(1);
      const card = res.body.items[0];
      expect(card.image_url).toBe('/img/one.png');
      expect(card.brand_name).toBe('Acme');
      expect(card.category_name).toBe('قمصان');
      expect(card.store_count).toBe(2);
      expect(card.colors).toEqual(['أبيض']);
      expect(card.sizes).toEqual(['M']);
      expect(card.lowest_price).toBe('120.00');
      expect(card.store_logos).toHaveLength(2);
    });

    it('a product with no media has a null image (never a placeholder), and no options when it has none', async () => {
      const s = await makeStore();
      const tag = unique('bare');
      const p = await makeProduct({ nameAr: `${tag}-س`, nameEn: `${tag}-s` });
      await makeOffer(s.id, p.product.id, p.variant.id, 5);
      const res = await request(app.getHttpServer())
        .get(`/api/v1/discovery/all?q=${encodeURIComponent(tag)}`)
        .expect(200);
      expect(res.body.items[0].image_url).toBeNull();
      expect(res.body.items[0].colors).toEqual([]);
      expect(res.body.items[0].sizes).toEqual([]);
    });

    it('store search lists only published ACTIVE stores and honours q and segment', async () => {
      const tag = unique('shop');
      const good = await makeStore({
        displayName: `${tag} Good`,
        categories: ['KIDS'],
      });
      await makeStore({ displayName: `${tag} Hidden`, published: false });
      await makeStore({ displayName: `${tag} Susp`, status: 'SUSPENDED' });
      await makeStore({ displayName: `${tag} Other`, categories: ['MEN'] });

      const all = await request(app.getHttpServer())
        .get(`/api/v1/discovery/stores?q=${encodeURIComponent(tag)}`)
        .expect(200);
      expect(
        all.body.items
          .map((s: { display_name: string }) => s.display_name)
          .sort(),
      ).toEqual([`${tag} Good`, `${tag} Other`].sort());
      const kids = await request(app.getHttpServer())
        .get(
          `/api/v1/discovery/stores?segment=kids&q=${encodeURIComponent(tag)}`,
        )
        .expect(200);
      expect(kids.body.items.map((s: { slug: string }) => s.slug)).toEqual([
        good.slug,
      ]);
    });
  });

  describe('public media on store pages', () => {
    it('section offers expose image_url; offer detail exposes images and the real option values', async () => {
      const store = await makeStore();
      const p = await makeProduct({
        nameAr: 'منتج',
        nameEn: 'Prod',
        attributes: { color: 'أسود', size: 'L' },
      });
      const { offer } = await makeOffer(
        store.id,
        p.product.id,
        p.variant.id,
        99,
        '/img/primary.png',
      );

      const sections = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${store.slug}/sections`)
        .expect(200);
      expect(sections.body.all[0].image_url).toBe('/img/primary.png');

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${store.slug}/offers/${offer.id}`)
        .expect(200);
      expect(detail.body.images).toEqual(['/img/primary.png']);
      expect(detail.body.variants[0].structural_attributes).toEqual({
        color: 'أسود',
        size: 'L',
      });
    });

    it('an offer without media returns null / empty, not a placeholder', async () => {
      const store = await makeStore();
      const p = await makeProduct({ nameAr: 'ب', nameEn: 'B' });
      const { offer } = await makeOffer(
        store.id,
        p.product.id,
        p.variant.id,
        1,
      );
      const sections = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${store.slug}/sections`)
        .expect(200);
      expect(sections.body.all[0].image_url).toBeNull();
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${store.slug}/offers/${offer.id}`)
        .expect(200);
      expect(detail.body.images).toEqual([]);
    });
  });
});
