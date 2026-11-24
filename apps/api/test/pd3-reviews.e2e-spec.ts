import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { CURRENT_PLATFORM_TERMS_VERSION } from './../src/checkout/checkout.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';
import { readyAfterStartPreparation } from './helpers/prep-ready-fixture';

// PD-3 (docs/srs/10-product-detail-enhancement-roadmap.md, PD-FR-002):
// enriched, purchase-verified product reviews - purchase snapshot,
// paginated/filtered reads, author edit/delete, helpful votes, review
// images and administrator moderation.
// Review images go to a throwaway directory, never the dev one.
process.env.REVIEW_MEDIA_DIR = mkdtempSync(path.join(tmpdir(), 'pd3-media-'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as typeof import('sharp/dist/index.cjs');

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('PD-3 enriched reviews (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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

  /** A signed-in account with a customer profile. */
  async function account(displayName: string | null = null) {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: 'not-used', phoneVerifiedAt: new Date() },
    });
    const profile = await prisma.customerProfile.create({
      data: { userId: user.id, displayName },
    });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { token, userId: user.id, customerId: profile.id, phone };
  }

  /** A selling store: owner account, one approved physical branch. */
  async function store(label: string) {
    const owner = await account(`صاحب ${label}`);
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique(label).toLowerCase(),
        legalName: unique('Legal'),
        displayName: `متجر ${label}`,
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    await prisma.vendorUser.create({
      data: { userId: owner.userId, vendorId: vendor.id, role: 'OWNER' },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('فرع'),
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
    return { vendor, branch, owner };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  /** A published canonical product with one canonical variant per combination. */
  async function product() {
    const brand = await prisma.brand.create({
      data: { name: unique('Brand'), normalizedName: unique('b') },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('C') },
    });
    return prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('M'),
        canonicalNameAr: 'فستان',
        canonicalNameEn: 'Dress',
        status: 'PUBLISHED',
      },
    });
  }

  /** A classified ACTIVE offer of `productId` in `s` with these combinations. */
  async function offer(
    s: Store,
    productId: string,
    combos: { color: string; size: string; qty?: number }[],
    titleAr = 'فستان صيفي',
  ) {
    const o = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendor.id,
        titleAr,
        titleEn: 'Summer dress',
        status: 'DRAFT',
        taxonomyVersion: 1,
        requiresTaxonomy: true,
      },
    });
    await prisma.vendorOfferAudience.create({
      data: { vendorId: s.vendor.id, vendorOfferId: o.id, audience: 'WOMEN' },
    });
    await prisma.vendorOfferCategory.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: o.id,
        categoryCode: 'DRESSES_WOMEN',
      },
    });
    const ids: Record<string, string> = {};
    for (const c of combos) {
      const cv = await prisma.canonicalProductVariant.create({
        data: {
          canonicalProductId: productId,
          structuralAttributes: { n: unique('v') },
          platformProductBarcode: unique('pb'),
        },
      });
      const v = await prisma.offerVariant.create({
        data: {
          vendorId: s.vendor.id,
          vendorOfferId: o.id,
          sellerSku: unique('sku'),
          storeInventoryBarcode: unique('sib'),
          basePrice: 100,
          isCombination: true,
          colorCode: c.color,
          sizeCode: c.size,
          canonicalVariantId: cv.id,
        },
      });
      await prisma.branchStock.create({
        data: {
          vendorId: s.vendor.id,
          branchId: s.branch.id,
          offerVariantId: v.id,
          quantity: c.qty ?? 20,
        },
      });
      ids[`${c.color}/${c.size}`] = v.id;
    }
    await prisma.vendorOffer.update({
      where: { id: o.id },
      data: { status: 'ACTIVE' },
    });
    return { offerId: o.id, ids };
  }

  const staff = (s: Store, branchOrderId: string, action: string, body = {}) =>
    // phase 2 fixture (see prep-ready-fixture.ts): started = prepared and ready
    readyAfterStartPreparation(
      request(http())
        .post(
          `/api/v1/vendors/${s.vendor.id}/branches/${s.branch.id}/orders/${branchOrderId}/${action}`,
        )
        .set('Authorization', `Bearer ${s.owner.token}`)
        .set('Idempotency-Key', unique('staff'))
        .send(body),
      action,
      () =>
        prisma.branchOrder.update({
          where: { id: branchOrderId },
          data: { readyAt: new Date() },
        }),
    );

  /** Buys one unit of `variantId` from `s` for pickup; `complete` hands it over. */
  async function buy(
    buyer: { token: string },
    s: Store,
    variantId: string,
    complete = true,
  ) {
    const cart = await request(http())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${buyer.token}`)
      .set('Idempotency-Key', unique('cart'))
      .send({
        vendor_id: s.vendor.id,
        offer_variant_id: variantId,
        quantity: 1,
      })
      .expect(201);
    const reserved = await request(http())
      .post('/api/v1/checkout/reserve')
      .set('Authorization', `Bearer ${buyer.token}`)
      .set('Idempotency-Key', unique('reserve'))
      .send({
        terms_accepted: true,
        terms_version: CURRENT_PLATFORM_TERMS_VERSION,
        groups: [
          {
            cart_item_ids: [cart.body.id],
            branch_id: s.branch.id,
            fulfilment_method: 'PICKUP',
            payment_method: 'COD',
          },
        ],
      })
      .expect(201);
    const confirmed = await request(http())
      .post('/api/v1/checkout/confirm')
      .set('Authorization', `Bearer ${buyer.token}`)
      .set('Idempotency-Key', unique('confirm'))
      .send({ reservation_id: reserved.body.reservation_id })
      .expect(201);
    const order = confirmed.body.branch_orders[0];
    if (complete) {
      await staff(s, order.id, 'start-preparation').expect(201);
      await staff(s, order.id, 'pickup-handover', {
        pickup_code: order.pickup_code,
      }).expect(201);
    }
    const item = await prisma.branchOrderItem.findFirstOrThrow({
      where: { branchOrderId: order.id },
    });
    return {
      branchOrderId: order.id as string,
      customerOrderId: confirmed.body.customer_order_id as string,
      itemId: item.id,
    };
  }

  describe('1. purchase snapshot', () => {
    it('checkout freezes title, colour and size onto the order item; later edits never rewrite it', async () => {
      const s = await store('snap');
      const p = await product();
      const o = await offer(s, p.id, [{ color: 'BLACK', size: 'M' }]);
      const buyer = await account();
      const { itemId } = await buy(buyer, s, o.ids['BLACK/M'], false);
      const item = await prisma.branchOrderItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      expect(item).toMatchObject({
        titleArSnapshot: 'فستان صيفي',
        titleEnSnapshot: 'Summer dress',
        colorCodeSnapshot: 'BLACK',
        sizeCodeSnapshot: 'M',
      });
      expect(item.colorLabelSnapshot).toBeTruthy();
      expect(item.colorLabelSnapshot).not.toBe('BLACK');
      expect(item.sizeLabelSnapshot).toBeTruthy();

      // The store renames the offer and re-classifies the variant.
      await prisma.vendorOffer.update({
        where: { id: o.offerId },
        data: { titleAr: 'اسم جديد' },
      });
      await prisma.offerVariant.update({
        where: { id: o.ids['BLACK/M'] },
        data: { colorCode: 'WHITE' },
      });
      const again = await prisma.branchOrderItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      expect(again.titleArSnapshot).toBe('فستان صيفي');
      expect(again.colorCodeSnapshot).toBe('BLACK');
    });

    it('an unclassified variant snapshots its title but no colour/size', async () => {
      const s = await store('legacy');
      const o = await prisma.vendorOffer.create({
        data: {
          vendorId: s.vendor.id,
          titleAr: 'كوب',
          titleEn: 'Mug',
          status: 'ACTIVE',
        },
      });
      const v = await prisma.offerVariant.create({
        data: {
          vendorId: s.vendor.id,
          vendorOfferId: o.id,
          sellerSku: unique('sku'),
          storeInventoryBarcode: unique('sib'),
          basePrice: 20,
        },
      });
      await prisma.branchStock.create({
        data: {
          vendorId: s.vendor.id,
          branchId: s.branch.id,
          offerVariantId: v.id,
          quantity: 5,
        },
      });
      const { itemId } = await buy(await account(), s, v.id, false);
      expect(
        await prisma.branchOrderItem.findUniqueOrThrow({
          where: { id: itemId },
        }),
      ).toMatchObject({
        titleArSnapshot: 'كوب',
        colorCodeSnapshot: null,
        colorLabelSnapshot: null,
        sizeCodeSnapshot: null,
        sizeLabelSnapshot: null,
      });
    });
  });

  // ------------------------------------------------------------------
  // Shared helpers for stages 2-6.
  // ------------------------------------------------------------------
  const write = (
    method: 'post' | 'patch' | 'delete',
    url: string,
    token: string | null,
  ) => {
    const r = request(http())
      [method](`/api/v1${url}`)
      .set('Idempotency-Key', unique('idem'));
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  const list = (productId: string, query = '', token?: string) => {
    const r = request(http()).get(
      `/api/v1/canonical-products/${productId}/reviews${query ? `?${query}` : ''}`,
    );
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  const review = (
    token: string,
    itemId: string,
    extra: Record<string, unknown> = {},
  ) =>
    write('post', '/reviews', token).send({
      source_branch_order_item_id: itemId,
      target_type: 'PRODUCT',
      rating: 5,
      body: 'منتج جميل',
      ...extra,
    });

  async function admin() {
    const a = await account();
    await prisma.user.update({
      where: { id: a.userId },
      data: { platformRole: 'PLATFORM_ADMIN' },
    });
    return a;
  }

  /** One product, two stores selling it, colours/sizes to buy. */
  async function market() {
    const p = await product();
    const a = await store('alpha');
    const b = await store('beta');
    const combos = [
      { color: 'BLACK', size: 'M' },
      { color: 'BLACK', size: 'L' },
      { color: 'WHITE', size: 'M' },
    ];
    const oa = await offer(a, p.id, combos);
    const ob = await offer(b, p.id, [{ color: 'WHITE', size: 'L' }]);
    return { p, a, b, oa, ob };
  }
  type Market = Awaited<ReturnType<typeof market>>;

  /** A buyer who bought `combo` from `s` (completed) and reviewed it. */
  async function reviewed(
    m: Market,
    combo: string,
    extra: Record<string, unknown> = {},
    s: 'a' | 'b' = 'a',
    displayName: string | null = null,
  ) {
    const buyer = await account(displayName);
    const ids = s === 'a' ? m.oa.ids : m.ob.ids;
    const { itemId, branchOrderId } = await buy(buyer, m[s], ids[combo]);
    const res = await review(buyer.token, itemId, extra).expect(201);
    return {
      buyer,
      itemId,
      branchOrderId,
      id: res.body.id as string,
      body: res.body,
    };
  }

  const jpeg = (opts: { w?: number; h?: number } = {}) =>
    sharp({
      create: {
        width: opts.w ?? 64,
        height: opts.h ?? 48,
        channels: 3,
        background: '#aa3344',
      },
    })
      .jpeg()
      .withExif({
        IFD0: { Copyright: 'Owner +970591234567', Artist: 'Sara Haddad' },
      })
      .toBuffer();
  const attach = (
    token: string,
    reviewId: string,
    file: Buffer,
    consent = true,
    name = 'a.jpg',
  ) => {
    const r = write('post', `/reviews/${reviewId}/media`, token).attach(
      'file',
      file,
      name,
    );
    return consent ? r.field('consent', 'true') : r;
  };
  const mediaPath = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

  describe('2. reads: summary, filters, pagination, privacy', () => {
    it('summary counts VISIBLE only and withholds each part below its minimum', async () => {
      const m = await market();
      await reviewed(m, 'BLACK/M', {
        rating: 5,
        fit_feedback: 'TRUE_TO_SIZE',
        tags: ['GOOD_QUALITY'],
      });
      await reviewed(m, 'BLACK/L', {
        rating: 4,
        fit_feedback: 'SMALL',
        tags: ['GOOD_QUALITY', 'COMFORTABLE'],
      });
      let res = await list(m.p.id).expect(200);
      expect(res.body.aggregate).toEqual({ average: null, count: 2 });
      expect(res.body.summary).toMatchObject({
        distribution: null,
        fit: null,
        tags: [],
      });
      expect(res.body.total).toBe(2);

      await reviewed(m, 'WHITE/M', {
        rating: 3,
        fit_feedback: 'TRUE_TO_SIZE',
        tags: ['GOOD_QUALITY'],
      });
      const reported = await reviewed(m, 'WHITE/M', {
        rating: 1,
        fit_feedback: 'LARGE',
        tags: ['GOOD_QUALITY'],
      });
      const reporter = await account();
      await write('post', `/reviews/${reported.id}/report`, reporter.token)
        .send({ reason: 'مخالف' })
        .expect(201);

      res = await list(m.p.id).expect(200);
      // The REPORTED one is listed (innocent until decided) but not summarised.
      expect(res.body.total).toBe(4);
      expect(res.body.aggregate).toEqual({ average: 4, count: 3 });
      expect(res.body.summary.distribution).toEqual({
        '5': 1,
        '4': 1,
        '3': 1,
        '2': 0,
        '1': 0,
      });
      expect(res.body.summary.fit).toEqual({
        answered: 3,
        SMALL: 1,
        TRUE_TO_SIZE: 2,
        LARGE: 0,
      });
      expect(res.body.summary.tags).toEqual([
        { tag: 'GOOD_QUALITY', count: 3 },
      ]);
      expect(res.body.summary.with_media).toBe(0);
    });

    it('filters by colour, size, rating, fit and store - one combined AND - with option counts', async () => {
      const m = await market();
      await reviewed(m, 'BLACK/M', { rating: 5, fit_feedback: 'TRUE_TO_SIZE' });
      await reviewed(m, 'BLACK/L', { rating: 2, fit_feedback: 'SMALL' });
      await reviewed(m, 'WHITE/M', { rating: 5 });
      await reviewed(m, 'WHITE/L', { rating: 4 }, 'b');
      const ids = async (q: string) =>
        (await list(m.p.id, q).expect(200)).body.reviews.map(
          (r: { purchased: { color_code: string; size_code: string } }) =>
            `${r.purchased.color_code}/${r.purchased.size_code}`,
        );
      expect((await ids('color=BLACK')).sort()).toEqual(['BLACK/L', 'BLACK/M']);
      expect(await ids('color=BLACK&size=M')).toEqual(['BLACK/M']);
      expect((await ids('rating=5')).sort()).toEqual(['BLACK/M', 'WHITE/M']);
      expect(await ids('fit=SMALL')).toEqual(['BLACK/L']);
      expect(await ids(`store=${m.b.vendor.slug}`)).toEqual(['WHITE/L']);
      expect(await ids(`store=${m.a.vendor.slug}&size=L`)).toEqual(['BLACK/L']);
      expect(await ids('store=no-such-store')).toEqual([]);

      const opts = (await list(m.p.id).expect(200)).body.summary.filter_options;
      expect(opts.colors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'BLACK', label: 'أسود', count: 2 }),
          expect.objectContaining({ code: 'WHITE', count: 2 }),
        ]),
      );
      expect(opts.sizes.map((s: { code: string }) => s.code)).toEqual([
        'M',
        'L',
      ]);
      expect(opts.stores).toEqual(
        expect.arrayContaining([
          { slug: m.a.vendor.slug, name: 'متجر alpha', count: 3 },
          { slug: m.b.vendor.slug, name: 'متجر beta', count: 1 },
        ]),
      );
      for (const bad of [
        'rating=6',
        'fit=HUGE',
        'color=black;drop',
        'sort=random',
        'has_media=yes',
      ]) {
        await list(m.p.id, bad).expect(400);
      }
    });

    it('cursor pagination walks every review once, in each sort order; bad cursors are 400', async () => {
      const m = await market();
      const made: { id: string; rating: number }[] = [];
      for (const rating of [3, 5, 1, 4, 2]) {
        const r = await reviewed(m, 'BLACK/M', { rating });
        made.push({ id: r.id, rating });
      }
      for (const sort of ['newest', 'rating_desc', 'rating_asc', 'helpful']) {
        const seen: { id: string; rating: number }[] = [];
        let cursor: string | null = null;
        do {
          const res = await list(
            m.p.id,
            `sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
          ).expect(200);
          expect(res.body.reviews.length).toBeLessThanOrEqual(2);
          seen.push(
            ...res.body.reviews.map((r: { id: string; rating: number }) => ({
              id: r.id,
              rating: r.rating,
            })),
          );
          cursor = res.body.next_cursor;
        } while (cursor);
        expect(seen.map((r) => r.id).sort()).toEqual(
          made.map((r) => r.id).sort(),
        );
        if (sort === 'rating_desc')
          expect(seen.map((r) => r.rating)).toEqual([5, 4, 3, 2, 1]);
        if (sort === 'rating_asc')
          expect(seen.map((r) => r.rating)).toEqual([1, 2, 3, 4, 5]);
        if (sort === 'newest')
          expect(seen.map((r) => r.id)).toEqual(
            [...made].reverse().map((r) => r.id),
          );
      }
      const first = await list(m.p.id, 'limit=2').expect(200);
      await list(m.p.id, 'cursor=not-a-cursor').expect(400);
      // A cursor from one sort order is refused by another.
      const bad = await list(
        m.p.id,
        `sort=helpful&cursor=${first.body.next_cursor}`,
      ).expect(400);
      expect(bad.body.error.code).toBe('INVALID_CURSOR');
    });

    it('privacy: a safe display name only - no phone, customer id, full name or quantity in any read', async () => {
      const m = await market();
      const named = await reviewed(
        m,
        'BLACK/M',
        { author_display: 'FIRST_NAME_INITIAL' },
        'a',
        'سارة محمد علي',
      );
      const anon = await reviewed(m, 'WHITE/M', {}, 'a', 'ليلى حداد');
      const res = await list(m.p.id).expect(200);
      const byId = (id: string) =>
        res.body.reviews.find((r: { id: string }) => r.id === id);
      expect(byId(named.id).author).toBe('سارة م.');
      expect(byId(anon.id).author).toBe('عميل موثّق');
      const raw = JSON.stringify(res.body);
      for (const secret of [
        named.buyer.phone,
        anon.buyer.phone,
        named.buyer.customerId,
        'محمد علي',
        'حداد',
        'quantity',
        'customerId',
        'customer_id',
      ]) {
        expect(raw).not.toContain(secret);
      }
      expect(byId(named.id)).toMatchObject({
        verified_purchase: true,
        purchased: {
          title: 'فستان صيفي',
          color_code: 'BLACK',
          color_label: 'أسود',
          size_code: 'M',
        },
        store: { slug: m.a.vendor.slug, name: 'متجر alpha' },
        returned: false,
      });
      // A guest gets no viewer block at all.
      expect(byId(named.id).viewer).toBeUndefined();
      // The store-review list uses the same safe label.
      const storeReview = await write('post', '/reviews', named.buyer.token)
        .send({
          source_branch_order_item_id: named.itemId,
          target_type: 'STORE',
          rating: 4,
          body: 'خدمة جيدة',
          author_display: 'FIRST_NAME_INITIAL',
        })
        .expect(201);
      const storeList = await request(http())
        .get(`/api/v1/storefronts/${m.a.vendor.slug}/reviews`)
        .expect(200);
      expect(
        storeList.body.reviews.find(
          (r: { id: string }) => r.id === storeReview.body.id,
        ).author,
      ).toBe('سارة م.');
      expect(JSON.stringify(storeList.body)).not.toContain(named.buyer.phone);
    });

    it('a review written before PD-3 (no snapshot, no metadata) still reads cleanly', async () => {
      const m = await market();
      const buyer = await account('قديم');
      const { itemId } = await buy(buyer, m.a, m.oa.ids['BLACK/M']);
      await prisma.branchOrderItem.update({
        where: { id: itemId },
        data: {
          titleArSnapshot: null,
          colorCodeSnapshot: null,
          colorLabelSnapshot: null,
          sizeCodeSnapshot: null,
          sizeLabelSnapshot: null,
        },
      });
      const old = await review(buyer.token, itemId).expect(201);
      const res = await list(m.p.id).expect(200);
      expect(res.body.reviews[0]).toMatchObject({
        id: old.body.id,
        purchased: null,
        fit: null,
        tags: [],
        media: [],
        helpful_count: 0,
        edited: false,
        author: 'عميل موثّق',
      });
      expect(res.body.summary.filter_options).toEqual({
        colors: [],
        sizes: [],
        stores: [expect.objectContaining({ count: 1 })],
      });
    });

    it("viewer flags: author, other customer, and the selling store's owner", async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M');
      const other = await account();
      const flags = async (token: string) =>
        (await list(m.p.id, '', token).expect(200)).body.reviews[0].viewer;
      expect(await flags(r.buyer.token)).toMatchObject({
        is_author: true,
        can_vote: false,
        can_report: false,
        can_edit: true,
      });
      expect(await flags(other.token)).toMatchObject({
        is_author: false,
        can_vote: true,
        can_report: true,
        can_edit: false,
        voted_helpful: false,
      });
      expect(await flags(m.a.owner.token)).toMatchObject({ can_vote: false });
      expect(await flags(m.b.owner.token)).toMatchObject({ can_vote: true });
      // A stale token is simply a guest, never a 401.
      const guest = await list(m.p.id, '', 'stale-token').expect(200);
      expect(guest.body.reviews[0].viewer).toBeUndefined();
    });
  });

  describe('3. create / edit / delete and the revision log', () => {
    it('create validates the structured signals', async () => {
      const m = await market();
      const buyer = await account();
      const { itemId } = await buy(buyer, m.a, m.oa.ids['BLACK/M']);
      for (const extra of [
        { tags: ['GOOD_QUALITY', 'GOOD_QUALITY'] },
        {
          tags: ['GOOD_QUALITY', 'COMFORTABLE', 'GOOD_VALUE', 'MATCHES_PHOTOS'],
        },
        { tags: ['AMAZING'] },
        { fit_feedback: 'HUGE' },
        { author_display: 'FULL_NAME' },
      ]) {
        await review(buyer.token, itemId, extra).expect(400);
      }
      const store = await write('post', '/reviews', buyer.token)
        .send({
          source_branch_order_item_id: itemId,
          target_type: 'STORE',
          rating: 4,
          body: 'x',
          fit_feedback: 'SMALL',
        })
        .expect(400);
      expect(store.body.error.code).toBe(
        'FIELD_NOT_APPLICABLE_TO_STORE_REVIEW',
      );
      // The colour/size can never be supplied by the client.
      const ok = await review(buyer.token, itemId, {
        purchased_color_code: 'WHITE',
        fit_feedback: 'LARGE',
        tags: ['MATCHES_PHOTOS'],
      }).expect(201);
      expect(ok.body).toMatchObject({
        fit: 'LARGE',
        tags: ['MATCHES_PHOTOS'],
        purchased: { color_code: 'BLACK' },
      });
      // Not yet completed: still not eligible.
      const pending = await buy(buyer, m.a, m.oa.ids['BLACK/L'], false);
      expect(
        (await review(buyer.token, pending.itemId).expect(409)).body.error.code,
      ).toBe('NOT_ELIGIBLE_FOR_REVIEW');
    });

    it('the author edits within 30 days: a revision is kept, "edited" shows, the audit log records it', async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M', {
        rating: 5,
        body: 'رائع',
        fit_feedback: 'TRUE_TO_SIZE',
      });
      const edited = await write('patch', `/reviews/${r.id}`, r.buyer.token)
        .send({
          rating: 3,
          body: 'بعد الغسيل تغيّر اللون',
          fit_feedback: null,
          tags: ['BELOW_EXPECTATIONS'],
        })
        .expect(200);
      expect(edited.body).toMatchObject({
        rating: 3,
        body: 'بعد الغسيل تغيّر اللون',
        fit: null,
        tags: ['BELOW_EXPECTATIONS'],
        edited: true,
      });
      const revisions = await prisma.reviewRevision.findMany({
        where: { reviewId: r.id },
      });
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({
        rating: 5,
        body: 'رائع',
        fitFeedback: 'TRUE_TO_SIZE',
      });
      expect(
        await prisma.auditLog.count({
          where: { entityId: r.id, action: 'review.edited' },
        }),
      ).toBe(1);
      // Public list shows the new values and the "edited" mark, never the old text.
      const res = await list(m.p.id).expect(200);
      expect(res.body.reviews[0]).toMatchObject({ rating: 3, edited: true });
      expect(JSON.stringify(res.body)).not.toContain('رائع');
      // Nothing to change -> 400.
      expect(
        (
          await write('patch', `/reviews/${r.id}`, r.buyer.token)
            .send({})
            .expect(400)
        ).body.error.code,
      ).toBe('NOTHING_TO_UPDATE');
    });

    it('edit rules: only the author (404 for anyone else), never after 30 days, never under an open report', async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M');
      const other = await account();
      expect(
        (
          await write('patch', `/reviews/${r.id}`, other.token)
            .send({ rating: 1 })
            .expect(404)
        ).body.error.code,
      ).toBe('REVIEW_NOT_FOUND');
      await write('patch', `/reviews/${r.id}`, m.a.owner.token)
        .send({ rating: 1 })
        .expect(404);
      await write('delete', `/reviews/${r.id}`, other.token).expect(404);
      await request(http())
        .get(`/api/v1/reviews/${r.id}`)
        .set('Authorization', `Bearer ${other.token}`)
        .expect(404);

      await write('post', `/reviews/${r.id}/report`, other.token)
        .send({ reason: 'سبام' })
        .expect(201);
      expect(
        (
          await write('patch', `/reviews/${r.id}`, r.buyer.token)
            .send({ rating: 1 })
            .expect(409)
        ).body.error.code,
      ).toBe('REVIEW_UNDER_MODERATION');

      const late = await reviewed(m, 'WHITE/M');
      await prisma.review.update({
        where: { id: late.id },
        data: { createdAt: new Date(Date.now() - 31 * 86_400_000) },
      });
      expect(
        (
          await write('patch', `/reviews/${late.id}`, late.buyer.token)
            .send({ body: 'متأخر' })
            .expect(409)
        ).body.error.code,
      ).toBe('REVIEW_EDIT_WINDOW_CLOSED');
      // The display choice alone is a privacy setting: allowed, not an "edit".
      const renamed = await write(
        'patch',
        `/reviews/${late.id}`,
        late.buyer.token,
      )
        .send({ author_display: 'FIRST_NAME_INITIAL' })
        .expect(200);
      expect(renamed.body.edited).toBe(false);
      expect(
        await prisma.reviewRevision.count({ where: { reviewId: late.id } }),
      ).toBe(0);
    });

    it('delete: gone from every read at once, text purged, open reports closed, no replacement review', async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M', {
        rating: 1,
        body: 'نص سيحذف',
        tags: ['BELOW_EXPECTATIONS'],
      });
      const reporter = await account();
      await write('post', `/reviews/${r.id}/report`, reporter.token)
        .send({ reason: 'x' })
        .expect(201);
      await write('delete', `/reviews/${r.id}`, r.buyer.token).expect(204);
      const res = await list(m.p.id).expect(200);
      expect(res.body.total).toBe(0);
      expect(res.body.aggregate.count).toBe(0);
      const row = await prisma.review.findUniqueOrThrow({
        where: { id: r.id },
      });
      expect(row.deletedAt).not.toBeNull();
      expect(row.body).not.toContain('نص سيحذف');
      expect(row.tags).toEqual([]);
      expect(
        await prisma.reviewReport.count({
          where: { reviewId: r.id, status: 'PENDING' },
        }),
      ).toBe(0);
      expect(
        await prisma.auditLog.count({
          where: { entityId: r.id, action: 'review.deleted' },
        }),
      ).toBe(1);
      expect(
        (await review(r.buyer.token, r.itemId).expect(409)).body.error.code,
      ).toBe('REVIEW_ALREADY_SUBMITTED');
      await write('delete', `/reviews/${r.id}`, r.buyer.token).expect(404);
      await write('post', `/reviews/${r.id}/report`, reporter.token)
        .send({ reason: 'y' })
        .expect(404);
      // Not in the admin queue either.
      const a = await admin();
      const queue = await request(http())
        .get('/api/v1/admin/reviews/reported')
        .set('Authorization', `Bearer ${a.token}`)
        .expect(200);
      expect(queue.body.map((q: { id: string }) => q.id)).not.toContain(r.id);
    });

    it('a returned item stays reviewable and is marked "returned"', async () => {
      const m = await market();
      const buyer = await account();
      const { itemId } = await buy(buyer, m.a, m.oa.ids['BLACK/M']);
      await prisma.return.create({
        data: {
          vendorId: m.a.vendor.id,
          branchOrderItemId: itemId,
          reason: 'CHANGE_OF_MIND',
          status: 'REFUNDED',
          vendorReviewDueAt: new Date(),
        },
      });
      const r = await review(buyer.token, itemId).expect(201);
      expect(r.body.returned).toBe(true);
      expect((await list(m.p.id).expect(200)).body.reviews[0].returned).toBe(
        true,
      );
    });
  });

  describe('4. helpful votes', () => {
    it('one vote per account, toggled off by DELETE; the count always equals the vote rows', async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M');
      const voters = [await account(), await account(), await account()];
      for (const v of voters) {
        expect(
          (await write('post', `/reviews/${r.id}/helpful`, v.token).expect(200))
            .body.voted,
        ).toBe(true);
      }
      // A repeat vote is a no-op, not a second count.
      expect(
        (
          await write(
            'post',
            `/reviews/${r.id}/helpful`,
            voters[0].token,
          ).expect(200)
        ).body.helpful_count,
      ).toBe(3);
      expect(
        (
          await write(
            'delete',
            `/reviews/${r.id}/helpful`,
            voters[1].token,
          ).expect(200)
        ).body,
      ).toEqual({ voted: false, helpful_count: 2 });
      expect(
        (
          await write(
            'delete',
            `/reviews/${r.id}/helpful`,
            voters[1].token,
          ).expect(200)
        ).body.helpful_count,
      ).toBe(2);
      const row = await prisma.review.findUniqueOrThrow({
        where: { id: r.id },
      });
      expect(row.helpfulCount).toBe(
        await prisma.reviewHelpfulVote.count({ where: { reviewId: r.id } }),
      );
      const seen = (await list(m.p.id, '', voters[0].token).expect(200)).body
        .reviews[0];
      expect(seen).toMatchObject({
        helpful_count: 2,
        viewer: { voted_helpful: true },
      });
    });

    it('concurrent votes by the same account count once', async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M');
      const v = await account();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          Promise.resolve(write('post', `/reviews/${r.id}/helpful`, v.token)),
        ),
      );
      expect(results.every((x) => x.status === 200)).toBe(true);
      expect(
        (await prisma.review.findUniqueOrThrow({ where: { id: r.id } }))
          .helpfulCount,
      ).toBe(1);
      expect(
        await prisma.reviewHelpfulVote.count({ where: { reviewId: r.id } }),
      ).toBe(1);
    });

    it("the author and the selling store's team may not vote; guests are 401; hidden reviews are 404", async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M');
      expect(
        (
          await write('post', `/reviews/${r.id}/helpful`, r.buyer.token).expect(
            409,
          )
        ).body.error.code,
      ).toBe('CANNOT_VOTE_OWN_REVIEW');
      expect(
        (
          await write(
            'post',
            `/reviews/${r.id}/helpful`,
            m.a.owner.token,
          ).expect(409)
        ).body.error.code,
      ).toBe('SELLER_CANNOT_VOTE');
      await write('post', `/reviews/${r.id}/helpful`, m.b.owner.token).expect(
        200,
      );
      await write('post', `/reviews/${r.id}/helpful`, null).expect(401);
      await prisma.review.update({
        where: { id: r.id },
        data: { moderationStatus: 'HIDDEN' },
      });
      await write(
        'post',
        `/reviews/${r.id}/helpful`,
        (await account()).token,
      ).expect(404);
    });

    it('"most helpful" sorts by votes', async () => {
      const m = await market();
      const low = await reviewed(m, 'BLACK/M');
      const high = await reviewed(m, 'BLACK/L');
      for (let i = 0; i < 2; i += 1) {
        await write(
          'post',
          `/reviews/${high.id}/helpful`,
          (await account()).token,
        ).expect(200);
      }
      const res = await list(m.p.id, 'sort=helpful').expect(200);
      expect(res.body.reviews.map((x: { id: string }) => x.id)).toEqual([
        high.id,
        low.id,
      ]);
    });
  });

  describe('5. review images', () => {
    it('uploads are re-encoded to WebP with every metadata block (EXIF/GPS) removed, and served only via the API', async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M');
      const original = await jpeg({ w: 3000, h: 1000 });
      expect((await sharp(original).metadata()).exif).toBeDefined();
      const up = await attach(r.buyer.token, r.id, original)
        .field('alt_text', 'الفستان من الأمام')
        .expect(201);
      expect(up.body).toMatchObject({
        alt_text: 'الفستان من الأمام',
        width: 2048,
        sort_order: 0,
      });
      const served = await request(http())
        .get(mediaPath(up.body.url))
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(served.headers['content-type']).toBe('image/webp');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      const meta = await sharp(served.body as Buffer).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect((served.body as Buffer).toString('latin1')).not.toContain(
        '970591234567',
      );
      // Never stored under the publicly served /uploads tree.
      const row = await prisma.reviewMedia.findUniqueOrThrow({
        where: { id: up.body.id },
      });
      expect(
        existsSync(
          path.join(process.env.REVIEW_MEDIA_DIR!, r.id, row.fileName),
        ),
      ).toBe(true);
      const listed = (await list(m.p.id, 'has_media=true').expect(200)).body;
      expect(listed.total).toBe(1);
      expect(listed.reviews[0].media).toEqual([
        expect.objectContaining({
          id: up.body.id,
          alt_text: 'الفستان من الأمام',
        }),
      ]);
      expect(listed.summary.with_media).toBe(1);
    });

    it('refuses: no consent, wrong type, disguised bytes, corrupt image, too large, too many, store review, someone else', async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M');
      const ok = await jpeg();
      expect(
        (await attach(r.buyer.token, r.id, ok, false).expect(400)).body.error
          .code,
      ).toBe('MEDIA_CONSENT_REQUIRED');
      const gif = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#000' },
      })
        .gif()
        .toBuffer();
      expect(
        (await attach(r.buyer.token, r.id, gif, true, 'a.gif').expect(400)).body
          .error.code,
      ).toBe('UNSUPPORTED_MEDIA_TYPE');
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      );
      expect(
        (await attach(r.buyer.token, r.id, svg, true, 'a.jpg').expect(400)).body
          .error.code,
      ).toBe('UNSUPPORTED_MEDIA_TYPE');
      const corrupt = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.alloc(200, 7),
      ]);
      expect(
        (await attach(r.buyer.token, r.id, corrupt).expect(400)).body.error
          .code,
      ).toBe('UNPROCESSABLE_IMAGE');
      const huge = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.alloc(5 * 1024 * 1024 + 10),
      ]);
      await attach(r.buyer.token, r.id, huge).expect(413);
      for (let i = 0; i < 5; i += 1)
        await attach(r.buyer.token, r.id, ok).expect(201);
      expect(
        (await attach(r.buyer.token, r.id, ok).expect(409)).body.error.code,
      ).toBe('REVIEW_MEDIA_LIMIT_REACHED');
      const other = await account();
      await attach(other.token, r.id, ok).expect(404);
      const storeReview = await write('post', '/reviews', r.buyer.token)
        .send({
          source_branch_order_item_id: r.itemId,
          target_type: 'STORE',
          rating: 4,
          body: 'x',
        })
        .expect(201);
      expect(
        (await attach(r.buyer.token, storeReview.body.id, ok).expect(409)).body
          .error.code,
      ).toBe('MEDIA_NOT_ALLOWED_ON_STORE_REVIEW');
      // Nothing half-written was left behind by the refusals.
      expect(
        readdirSync(path.join(process.env.REVIEW_MEDIA_DIR!, r.id)),
      ).toHaveLength(5);
    });

    it('the author deletes an image (file removed, URL 404); deleting the review removes every file', async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M');
      const a = await attach(r.buyer.token, r.id, await jpeg()).expect(201);
      const b = await attach(r.buyer.token, r.id, await jpeg()).expect(201);
      const other = await account();
      await write(
        'delete',
        `/reviews/${r.id}/media/${a.body.id}`,
        other.token,
      ).expect(404);
      await write(
        'delete',
        `/reviews/${r.id}/media/${a.body.id}`,
        r.buyer.token,
      ).expect(204);
      await request(http()).get(mediaPath(a.body.url)).expect(404);
      await request(http()).get(mediaPath(b.body.url)).expect(200);
      expect(
        readdirSync(path.join(process.env.REVIEW_MEDIA_DIR!, r.id)),
      ).toHaveLength(1);
      await write('delete', `/reviews/${r.id}`, r.buyer.token).expect(204);
      await request(http()).get(mediaPath(b.body.url)).expect(404);
      expect(existsSync(path.join(process.env.REVIEW_MEDIA_DIR!, r.id))).toBe(
        false,
      );
      await request(http()).get('/api/v1/review-media/not-a-uuid').expect(404);
    });
  });

  describe('6. moderation, audit log, notifications and the owner view', () => {
    it('uphold needs a reason; hides the review and its images at once; audited; the author is notified', async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M');
      const img = await attach(r.buyer.token, r.id, await jpeg()).expect(201);
      const reporter = await account();
      await write('post', `/reviews/${r.id}/report`, reporter.token)
        .send({ reason: 'صورة غير لائقة', media_id: img.body.id })
        .expect(201);
      const a = await admin();
      const queue = await request(http())
        .get('/api/v1/admin/reviews/reported')
        .set('Authorization', `Bearer ${a.token}`)
        .expect(200);
      const entry = queue.body.find((q: { id: string }) => q.id === r.id);
      expect(entry.pending_reports[0]).toMatchObject({
        reason: 'صورة غير لائقة',
        media_id: img.body.id,
      });
      expect(entry.media[0]).toMatchObject({
        id: img.body.id,
        status: 'VISIBLE',
      });

      const noReason = await write(
        'patch',
        `/admin/reviews/${r.id}/decision`,
        a.token,
      )
        .send({ decision: 'uphold' })
        .expect(400);
      expect(noReason.body.error.code).toBeDefined();
      await write('patch', `/admin/reviews/${r.id}/decision`, reporter.token)
        .send({ decision: 'uphold', reason: 'x' })
        .expect(403);
      await write('patch', `/admin/reviews/${r.id}/decision`, a.token)
        .send({ decision: 'uphold', reason: 'محتوى مخالف لسياسة الصور' })
        .expect(200);

      expect((await list(m.p.id).expect(200)).body.total).toBe(0);
      await request(http()).get(mediaPath(img.body.url)).expect(404);
      // The administrator can still see the file; nobody else can.
      await request(http())
        .get(`/api/v1/admin/review-media/${img.body.id}/file`)
        .set('Authorization', `Bearer ${a.token}`)
        .expect(200);
      await request(http())
        .get(`/api/v1/admin/review-media/${img.body.id}/file`)
        .set('Authorization', `Bearer ${reporter.token}`)
        .expect(403);
      const reports = await prisma.reviewReport.findMany({
        where: { reviewId: r.id },
      });
      expect(reports[0]).toMatchObject({
        status: 'UPHELD',
        decisionReason: 'محتوى مخالف لسياسة الصور',
        decidedByUserId: a.userId,
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: r.id, action: 'review.report.upheld' },
      });
      expect(audit.actorId).toBe(a.userId);
      expect(JSON.stringify(audit.afterState)).toContain(
        'محتوى مخالف لسياسة الصور',
      );
      const event = await prisma.outboxEvent.findFirstOrThrow({
        where: {
          eventType: 'review.hidden_product',
          payload: { path: ['review_id'], equals: r.id },
        },
      });
      expect(event.payload).toMatchObject({
        recipient_user_id: r.buyer.userId,
        canonical_product_id: m.p.id,
      });
      // A hidden review can no longer be edited or voted on.
      expect(
        (
          await write('patch', `/reviews/${r.id}`, r.buyer.token)
            .send({ rating: 2 })
            .expect(409)
        ).body.error.code,
      ).toBe('REVIEW_HIDDEN');
    });

    it('a hidden image is gone immediately: no shared caching, every display revalidates, hide -> 404 on the same URL', async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M');
      const img = await attach(r.buyer.token, r.id, await jpeg()).expect(201);
      const url = mediaPath(img.body.url);
      const a = await admin();

      const first = await request(http()).get(url).expect(200);
      const cache = String(first.headers['cache-control']);
      // No CDN/proxy may keep it, and a browser must ask before reuse.
      expect(cache).toContain('private');
      expect(cache).toContain('no-cache');
      expect(cache).toContain('must-revalidate');
      expect(cache).not.toMatch(/public|max-age=[1-9]|immutable/);
      const etag = first.headers['etag'];
      expect(etag).toBeTruthy();
      // Revalidating an unchanged visible image costs a body-less 304.
      await request(http()).get(url).set('If-None-Match', etag).expect(304);

      await write(
        'patch',
        `/admin/reviews/${r.id}/media/${img.body.id}/hide`,
        a.token,
      )
        .send({ reason: 'تظهر بيانات شخصية' })
        .expect(200);
      // Right after the hide: a fresh request AND a browser's
      // revalidation of its cached copy both get 404 - no copy is served.
      await request(http()).get(url).expect(404);
      await request(http()).get(url).set('If-None-Match', etag).expect(404);
      await request(http())
        .get(url)
        .set('If-Modified-Since', String(first.headers['last-modified']))
        .expect(404);

      // Hiding the whole review (uphold) has the same immediate effect.
      const other = await attach(r.buyer.token, r.id, await jpeg()).expect(201);
      const otherUrl = mediaPath(other.body.url);
      const seen = await request(http()).get(otherUrl).expect(200);
      const reporter = await account();
      await write('post', `/reviews/${r.id}/report`, reporter.token)
        .send({ reason: 'مخالف' })
        .expect(201);
      // Still public while the report is open (innocent until decided).
      await request(http()).get(otherUrl).expect(200);
      await write('patch', `/admin/reviews/${r.id}/decision`, a.token)
        .send({ decision: 'uphold', reason: 'مخالف للسياسة' })
        .expect(200);
      await request(http()).get(otherUrl).expect(404);
      await request(http())
        .get(otherUrl)
        .set('If-None-Match', seen.headers['etag'])
        .expect(404);
    });

    it("an author's deleted image or review is gone immediately too", async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M');
      const img = await attach(r.buyer.token, r.id, await jpeg()).expect(201);
      const url = mediaPath(img.body.url);
      const seen = await request(http()).get(url).expect(200);
      await write('delete', `/reviews/${r.id}`, r.buyer.token).expect(204);
      await request(http()).get(url).expect(404);
      await request(http())
        .get(url)
        .set('If-None-Match', seen.headers['etag'])
        .expect(404);
    });

    it('an administrator hides one image (the review stays), with a reason, audited; others cannot', async () => {
      const m = await market();
      const r = await reviewed(m, 'BLACK/M');
      const img = await attach(r.buyer.token, r.id, await jpeg()).expect(201);
      const a = await admin();
      await write(
        'patch',
        `/admin/reviews/${r.id}/media/${img.body.id}/hide`,
        r.buyer.token,
      )
        .send({ reason: 'x' })
        .expect(403);
      await write(
        'patch',
        `/admin/reviews/${r.id}/media/${img.body.id}/hide`,
        a.token,
      )
        .send({})
        .expect(400);
      await write(
        'patch',
        `/admin/reviews/${r.id}/media/${img.body.id}/hide`,
        a.token,
      )
        .send({ reason: 'تظهر بيانات شخصية' })
        .expect(200);
      await request(http()).get(mediaPath(img.body.url)).expect(404);
      const res = await list(m.p.id).expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.reviews[0].media).toEqual([]);
      expect(
        await prisma.auditLog.count({
          where: {
            entityId: r.id,
            action: 'review.media_hidden',
            actorId: a.userId,
          },
        }),
      ).toBe(1);
      expect(
        (
          await write(
            'patch',
            `/admin/reviews/${r.id}/media/${img.body.id}/hide`,
            a.token,
          )
            .send({ reason: 'مرة ثانية' })
            .expect(409)
        ).body.error.code,
      ).toBe('REVIEW_MEDIA_ALREADY_HIDDEN');
    });

    it('completing an order queues a review invitation for its customer, once', async () => {
      const m = await market();
      const buyer = await account();
      const { branchOrderId } = await buy(buyer, m.a, m.oa.ids['BLACK/M']);
      const events = await prisma.outboxEvent.findMany({
        where: {
          eventType: 'branch_order.review_invitation',
          payload: { path: ['branch_order_id'], equals: branchOrderId },
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        recipient_user_id: buyer.userId,
        vendor_id: m.a.vendor.id,
      });
      // An order that is not completed yet has none.
      const open = await buy(buyer, m.a, m.oa.ids['BLACK/L'], false);
      expect(
        await prisma.outboxEvent.count({
          where: {
            eventType: 'branch_order.review_invitation',
            payload: { path: ['branch_order_id'], equals: open.branchOrderId },
          },
        }),
      ).toBe(0);
    });

    it('the owner reads (only) the reviews of what their store sold - no write route exists for a store', async () => {
      const m = await market();
      const mine = await reviewed(m, 'BLACK/M', { rating: 4 });
      const theirs = await reviewed(m, 'WHITE/L', { rating: 2 }, 'b');
      const storeReview = await write('post', '/reviews', mine.buyer.token)
        .send({
          source_branch_order_item_id: mine.itemId,
          target_type: 'STORE',
          rating: 5,
          body: 'متجر ممتاز',
        })
        .expect(201);
      const res = await request(http())
        .get(`/api/v1/vendors/${m.a.vendor.id}/product-reviews`)
        .set('Authorization', `Bearer ${m.a.owner.token}`)
        .expect(200);
      const ids = res.body.reviews.map((r: { id: string }) => r.id).sort();
      expect(ids).toEqual([mine.id, storeReview.body.id].sort());
      expect(ids).not.toContain(theirs.id);
      expect(JSON.stringify(res.body)).not.toContain(mine.buyer.phone);
      const onlyProduct = await request(http())
        .get(`/api/v1/vendors/${m.a.vendor.id}/product-reviews?target=PRODUCT`)
        .set('Authorization', `Bearer ${m.a.owner.token}`)
        .expect(200);
      expect(onlyProduct.body.reviews.map((r: { id: string }) => r.id)).toEqual(
        [mine.id],
      );
      // Another store's owner, an employee and a customer cannot read it.
      await request(http())
        .get(`/api/v1/vendors/${m.a.vendor.id}/product-reviews`)
        .set('Authorization', `Bearer ${m.b.owner.token}`)
        .expect(403);
      const employee = await account();
      await prisma.vendorUser.create({
        data: {
          userId: employee.userId,
          vendorId: m.a.vendor.id,
          role: 'BRANCH_EMPLOYEE',
          branchId: m.a.branch.id,
        },
      });
      await request(http())
        .get(`/api/v1/vendors/${m.a.vendor.id}/product-reviews`)
        .set('Authorization', `Bearer ${employee.token}`)
        .expect(403);
      await request(http())
        .get(`/api/v1/vendors/${m.a.vendor.id}/product-reviews`)
        .set('Authorization', `Bearer ${mine.buyer.token}`)
        .expect(403);
      // The owner can't edit, delete or hide a customer's review.
      await write('patch', `/reviews/${mine.id}`, m.a.owner.token)
        .send({ rating: 1 })
        .expect(404);
      await write('delete', `/reviews/${mine.id}`, m.a.owner.token).expect(404);
      await write(
        'patch',
        `/admin/reviews/${mine.id}/decision`,
        m.a.owner.token,
      )
        .send({ decision: 'uphold', reason: 'x' })
        .expect(403);
    });
  });

  describe('7. «طلباتي»: each purchased item carries its review state', () => {
    it('eligible only once completed; shows the snapshot; tracks create, edit window and delete', async () => {
      const m = await market();
      const buyer = await account();
      const done = await buy(buyer, m.a, m.oa.ids['BLACK/M']);
      const open = await buy(buyer, m.a, m.oa.ids['BLACK/L'], false);
      const items = async () => {
        const res = await request(http())
          .get('/api/v1/customers/me/orders')
          .set('Authorization', `Bearer ${buyer.token}`)
          .expect(200);
        return res.body.flatMap(
          (o: { items: { id: string }[] }) => o.items,
        ) as {
          id: string;
          color_label: string | null;
          size_label: string | null;
          review: {
            eligible: boolean;
            product_reviewable: boolean;
            product: { id: string; deleted: boolean; can_edit: boolean } | null;
            store: unknown;
          };
        }[];
      };
      let all = await items();
      const doneItem = () => all.find((i) => i.id === done.itemId)!;
      expect(doneItem()).toMatchObject({
        color_label: 'أسود',
        size_label: 'M',
        review: {
          eligible: true,
          product_reviewable: true,
          product: null,
          store: null,
        },
      });
      expect(all.find((i) => i.id === open.itemId)!.review.eligible).toBe(
        false,
      );

      const created = await review(buyer.token, done.itemId).expect(201);
      all = await items();
      expect(doneItem().review.product).toMatchObject({
        id: created.body.id,
        deleted: false,
        can_edit: true,
      });
      await prisma.review.update({
        where: { id: created.body.id },
        data: { createdAt: new Date(Date.now() - 31 * 86_400_000) },
      });
      all = await items();
      expect(doneItem().review.product!.can_edit).toBe(false);
      await write('delete', `/reviews/${created.body.id}`, buyer.token).expect(
        204,
      );
      all = await items();
      expect(doneItem().review.product!.deleted).toBe(true);
      // Someone else's orders never show this customer's reviews.
      const other = await account();
      const theirs = await request(http())
        .get('/api/v1/customers/me/orders')
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);
      expect(theirs.body).toEqual([]);
    });
  });
});
