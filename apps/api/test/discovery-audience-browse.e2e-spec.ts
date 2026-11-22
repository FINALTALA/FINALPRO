import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { ProductAudience, ProductSeason } from '../generated/prisma/client';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// The /women, /men and /kids listings: /discovery/all in browse mode
// with the product's own taxonomy (audience, category, season, colour,
// size), price range, live availability, sort, cursor and taxonomy
// category counts. Every fixture is inserted directly (a classified
// offer whose variants are confirmed combinations, exactly the shape
// the owner's combinations endpoint creates) and every query is scoped
// with `q=<tag>` to this test's own products.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

interface Combo {
  color: string | null;
  size: string | null;
  qty: number;
}

describe('Discovery browse - audience/taxonomy filters (e2e)', () => {
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

  async function makeStore(segments: ProductAudience[] = []) {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('browse-store'),
        legalName: unique('Legal'),
        displayName: unique('متجر'),
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
        applicableCategories: {
          create: segments.map((category) => ({ category })),
        },
      },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: 'الفرع',
        verificationStatus: 'APPROVED',
      },
    });
    return { vendor, branch };
  }

  /** One store's classified, confirmed, ACTIVE offer of a new product. */
  async function product(o: {
    tag: string;
    store: { vendor: { id: string }; branch: { id: string } };
    audience: ProductAudience;
    category: string;
    season?: ProductSeason | null;
    combos: Combo[];
    price: number;
    salePrice?: number;
    addedAt?: Date;
  }) {
    const brand = await prisma.brand.create({
      data: { name: unique('Brand'), normalizedName: unique('brand') },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('Category') },
    });
    const canonical = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('Model'),
        canonicalNameEn: `${o.tag} ${unique('item')}`,
        canonicalNameAr: o.tag,
        status: 'PUBLISHED',
      },
    });
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: o.store.vendor.id,
        canonicalProductId: canonical.id,
        titleAr: o.tag,
        titleEn: o.tag,
        status: 'DRAFT',
        season: o.season ?? null,
        taxonomyVersion: 1,
        requiresTaxonomy: true,
        ...(o.addedAt ? { createdAt: o.addedAt } : {}),
      },
    });
    await prisma.vendorOfferAudience.create({
      data: {
        vendorId: o.store.vendor.id,
        vendorOfferId: offer.id,
        audience: o.audience,
      },
    });
    await prisma.vendorOfferCategory.create({
      data: {
        vendorId: o.store.vendor.id,
        vendorOfferId: offer.id,
        categoryCode: o.category,
      },
    });
    const variants: string[] = [];
    for (const c of o.combos) {
      const cv = await prisma.canonicalProductVariant.create({
        data: {
          canonicalProductId: canonical.id,
          structuralAttributes: {},
          platformProductBarcode: unique('PPB'),
        },
      });
      const v = await prisma.offerVariant.create({
        data: {
          vendorId: o.store.vendor.id,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          storeInventoryBarcode: unique('sib'),
          basePrice: o.price,
          salePrice: o.salePrice ?? null,
          isCombination: true,
          colorCode: c.color,
          sizeCode: c.size,
          canonicalVariantId: cv.id,
          matchProposalStatus: 'CONFIRMED',
        },
      });
      await prisma.branchStock.create({
        data: {
          vendorId: o.store.vendor.id,
          branchId: o.store.branch.id,
          offerVariantId: v.id,
          quantity: c.qty,
        },
      });
      variants.push(v.id);
    }
    await prisma.vendorOffer.update({
      where: { id: offer.id },
      data: { status: 'ACTIVE' },
    });
    return { canonicalId: canonical.id, offerId: offer.id, variants };
  }

  const browse = (tag: string, query: Record<string, string>) =>
    request(app.getHttpServer())
      .get('/api/v1/discovery/all')
      .query({ q: tag, sort: 'newest', ...query });

  const ids = (body: { items: { canonical_product_id: string }[] }) =>
    body.items.map((i) => i.canonical_product_id);

  it('audience=WOMEN|MEN|KIDS uses the product audience; segment keeps its store-level meaning', async () => {
    const tag = unique('Audience');
    const womenStore = await makeStore(['WOMEN']);
    const women = await product({
      tag,
      store: womenStore,
      audience: 'WOMEN',
      category: 'JEANS',
      combos: [{ color: 'BLACK', size: 'M', qty: 3 }],
      price: 100,
    });
    // A MEN product sold by a store that only declared the WOMEN segment.
    const men = await product({
      tag,
      store: womenStore,
      audience: 'MEN',
      category: 'JEANS',
      combos: [{ color: 'BLACK', size: 'M', qty: 3 }],
      price: 100,
    });
    const kids = await product({
      tag,
      store: await makeStore(['KIDS']),
      audience: 'KIDS',
      category: 'JEANS',
      combos: [{ color: 'BLACK', size: 'AGE_4_5Y', qty: 3 }],
      price: 100,
    });

    expect(
      ids((await browse(tag, { audience: 'WOMEN' }).expect(200)).body),
    ).toEqual([women.canonicalId]);
    expect(
      ids((await browse(tag, { audience: 'MEN' }).expect(200)).body),
    ).toEqual([men.canonicalId]);
    expect(
      ids((await browse(tag, { audience: 'KIDS' }).expect(200)).body),
    ).toEqual([kids.canonicalId]);
    // Old meaning untouched: segment=women = the store declared WOMEN.
    expect(
      ids((await browse(tag, { segment: 'women' }).expect(200)).body).sort(),
    ).toEqual([women.canonicalId, men.canonicalId].sort());
    // Browse responses are cursor pages; the classic call keeps `page`.
    const classic = await request(app.getHttpServer())
      .get('/api/v1/discovery/all')
      .query({ q: tag, audience: 'WOMEN' })
      .expect(200);
    expect(classic.body).toMatchObject({ page: 1, total: 1 });
    expect(classic.body.next_cursor).toBeUndefined();
  });

  it('category and season: OR inside one filter, AND across filters; SPRING is a season', async () => {
    const tag = unique('CatSeason');
    const s = await makeStore();
    const jeansSummer = await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'JEANS',
      season: 'SUMMER',
      combos: [{ color: 'BLUE', size: 'M', qty: 2 }],
      price: 90,
    });
    const dressSpring = await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'DRESSES_WOMEN',
      season: 'SPRING',
      combos: [{ color: 'RED', size: 'S', qty: 2 }],
      price: 150,
    });
    await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'SKIRTS',
      season: null,
      combos: [{ color: 'BLACK', size: 'L', qty: 2 }],
      price: 70,
    });

    const q = async (query: Record<string, string>) =>
      ids(
        (await browse(tag, { audience: 'WOMEN', ...query }).expect(200)).body,
      ).sort();
    expect(await q({ category: 'JEANS,DRESSES_WOMEN' })).toEqual(
      [jeansSummer.canonicalId, dressSpring.canonicalId].sort(),
    );
    expect(await q({ season: 'SPRING' })).toEqual([dressSpring.canonicalId]);
    expect(await q({ season: 'SUMMER,SPRING' })).toHaveLength(2);
    expect(await q({ category: 'JEANS', season: 'SPRING' })).toEqual([]);
    expect(await q({ category: 'SKIRTS' })).toHaveLength(1);
  });

  it('the category scopes every other filter (AND): yellow jewellery never brings in a yellow jacket', async () => {
    const tag = unique('CatAnd');
    const s = await makeStore();
    const goldRing = await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'JEWELLERY',
      season: null,
      combos: [{ color: 'YELLOW', size: null, qty: 3 }],
      price: 120,
    });
    await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'JEWELLERY',
      season: null,
      combos: [{ color: 'GRAY', size: null, qty: 3 }],
      price: 90,
    });
    await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'JACKETS',
      season: 'FALL',
      combos: [{ color: 'YELLOW', size: 'M', qty: 3 }],
      price: 250,
    });
    const blueJeans = await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'JEANS',
      season: 'SUMMER',
      combos: [{ color: 'BLUE', size: 'EU_42', qty: 2 }],
      price: 150,
    });
    await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'SHOES',
      season: 'SUMMER',
      combos: [{ color: 'BLUE', size: 'EU_40', qty: 2 }],
      price: 180,
    });

    const q = async (query: Record<string, string>) =>
      ids(
        (await browse(tag, { audience: 'WOMEN', ...query }).expect(200)).body,
      );
    expect(await q({ color: 'YELLOW' })).toHaveLength(2); // no category: every category
    expect(await q({ category: 'JEWELLERY', color: 'YELLOW' })).toEqual([
      goldRing.canonicalId,
    ]);
    expect(
      await q({ category: 'JEWELLERY', color: 'YELLOW', max_price: '100' }),
    ).toEqual([]);
    expect(
      await q({
        category: 'JEWELLERY',
        color: 'YELLOW',
        available_only: 'true',
      }),
    ).toEqual([goldRing.canonicalId]);
    expect(await q({ category: 'JEANS', color: 'BLUE' })).toEqual([
      blueJeans.canonicalId,
    ]);
    expect(
      await q({ category: 'JEANS', size: 'EU_42', season: 'SUMMER' }),
    ).toEqual([blueJeans.canonicalId]);
    expect(await q({ category: 'SHOES', size: 'EU_42' })).toEqual([]); // the 42 is a pair of jeans
    // Counts never widen the listing: the active category's total stands.
    const counted = await browse(tag, {
      audience: 'WOMEN',
      category: 'JEWELLERY',
      color: 'YELLOW',
      facets: 'categories',
    }).expect(200);
    expect(counted.body.total).toBe(1);
    expect(counted.body.category_counts.JACKETS).toBe(1);
    expect(counted.body.category_counts.JEWELLERY).toBe(1);
  });

  it('colour + size must be ONE in-stock combination of the same offer variant', async () => {
    const tag = unique('Combo');
    const s = await makeStore();
    const p = await product({
      tag,
      store: s,
      audience: 'MEN',
      category: 'SHIRTS',
      combos: [
        { color: 'BLACK', size: 'M', qty: 4 },
        { color: 'WHITE', size: 'L', qty: 4 },
        { color: 'GRAY', size: 'XL', qty: 0 },
      ],
      price: 120,
    });
    const total = async (query: Record<string, string>) =>
      (await browse(tag, { audience: 'MEN', ...query }).expect(200)).body.total;
    expect(await total({ color: 'BLACK', size: 'M' })).toBe(1);
    expect(await total({ color: 'BLACK', size: 'L' })).toBe(0); // BLACK and L exist, never together
    expect(await total({ color: 'BLACK,WHITE', size: 'L' })).toBe(1); // OR inside colour
    expect(await total({ color: 'GRAY' })).toBe(0); // sold out
    expect(await total({ size: 'XL' })).toBe(0);
    expect(p.variants).toHaveLength(3);
  });

  it('min_price / max_price and both price sorts use the price the card shows (server-side)', async () => {
    const tag = unique('Price');
    const s = await makeStore();
    const cheap = await product({
      tag,
      store: s,
      audience: 'KIDS',
      category: 'TSHIRTS',
      combos: [{ color: 'BLUE', size: 'AGE_2_3Y', qty: 5 }],
      price: 40,
    });
    const mid = await product({
      tag,
      store: s,
      audience: 'KIDS',
      category: 'TSHIRTS',
      combos: [{ color: 'BLUE', size: 'AGE_2_3Y', qty: 5 }],
      price: 120,
      salePrice: 80,
    });
    const dear = await product({
      tag,
      store: s,
      audience: 'KIDS',
      category: 'TSHIRTS',
      combos: [{ color: 'BLUE', size: 'AGE_2_3Y', qty: 5 }],
      price: 200,
    });

    const asc = await browse(tag, {
      audience: 'KIDS',
      sort: 'price-asc',
    }).expect(200);
    expect(ids(asc.body)).toEqual([
      cheap.canonicalId,
      mid.canonicalId,
      dear.canonicalId,
    ]);
    expect(
      asc.body.items.map((i: { lowest_price: string }) => i.lowest_price),
    ).toEqual(['40.00', '80.00', '200.00']);
    const desc = await browse(tag, {
      audience: 'KIDS',
      sort: 'price-desc',
    }).expect(200);
    expect(ids(desc.body)).toEqual([
      dear.canonicalId,
      mid.canonicalId,
      cheap.canonicalId,
    ]);
    // The sale price (80), not the base price (120), is what is filtered.
    const ranged = await browse(tag, {
      audience: 'KIDS',
      min_price: '50',
      max_price: '100',
    }).expect(200);
    expect(ids(ranged.body)).toEqual([mid.canonicalId]);
    expect(
      (await browse(tag, { audience: 'KIDS', max_price: '40' }).expect(200))
        .body.total,
    ).toBe(1);
  });

  it('newest sorts by when the product was added by a store', async () => {
    const tag = unique('Newest');
    const s = await makeStore();
    const day = 86_400_000;
    const old = await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'TOPS',
      combos: [{ color: 'WHITE', size: 'S', qty: 1 }],
      price: 50,
      addedAt: new Date(Date.now() - 3 * day),
    });
    const recent = await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'TOPS',
      combos: [{ color: 'WHITE', size: 'S', qty: 1 }],
      price: 50,
      addedAt: new Date(Date.now() - day),
    });
    const middle = await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'TOPS',
      combos: [{ color: 'WHITE', size: 'S', qty: 1 }],
      price: 50,
      addedAt: new Date(Date.now() - 2 * day),
    });
    expect(
      ids(
        (await browse(tag, { audience: 'WOMEN', sort: 'newest' }).expect(200))
          .body,
      ),
    ).toEqual([recent.canonicalId, middle.canonicalId, old.canonicalId]);
  });

  it('available_only uses live stock: sold out, and fully held by a live reservation, are excluded', async () => {
    const tag = unique('Avail');
    const s = await makeStore();
    const inStock = await product({
      tag,
      store: s,
      audience: 'MEN',
      category: 'JEANS',
      combos: [{ color: 'BLACK', size: 'M', qty: 2 }],
      price: 100,
    });
    await product({
      tag,
      store: s,
      audience: 'MEN',
      category: 'JEANS',
      combos: [{ color: 'BLACK', size: 'L', qty: 0 }],
      price: 100,
    });
    const held = await product({
      tag,
      store: s,
      audience: 'MEN',
      category: 'JEANS',
      combos: [{ color: 'BLACK', size: 'S', qty: 1 }],
      price: 100,
    });

    expect(
      (await browse(tag, { audience: 'MEN' }).expect(200)).body.total,
    ).toBe(3);
    expect(
      (
        await browse(tag, { audience: 'MEN', available_only: 'false' }).expect(
          200,
        )
      ).body.total,
    ).toBe(3);
    // A live checkout hold on the last unit of `held`.
    const customer = await prisma.user.create({
      data: {
        phone: uniqueTestPhone(),
        passwordHash: 'x',
        phoneVerifiedAt: new Date(),
      },
    });
    const profile = await prisma.customerProfile.create({
      data: { userId: customer.id },
    });
    const reservation = await prisma.checkoutReservation.create({
      data: {
        customerId: profile.id,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    await prisma.checkoutReservationItem.create({
      data: {
        reservationId: reservation.id,
        vendorId: s.vendor.id,
        branchId: s.branch.id,
        offerVariantId: held.variants[0],
        quantity: 1,
        unitPriceAtReserve: 100,
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'ONLINE',
      },
    });
    const available = await browse(tag, {
      audience: 'MEN',
      available_only: 'true',
    }).expect(200);
    expect(ids(available.body)).toEqual([inStock.canonicalId]);
  });

  it('category_counts come from the taxonomy, honour every other filter, and ignore the category selection itself', async () => {
    const tag = unique('Counts');
    const s = await makeStore();
    await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'JEANS',
      season: 'WINTER',
      combos: [{ color: 'BLUE', size: 'M', qty: 2 }],
      price: 100,
    });
    await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'JEANS',
      season: 'SUMMER',
      combos: [{ color: 'BLUE', size: 'M', qty: 2 }],
      price: 100,
    });
    await product({
      tag,
      store: s,
      audience: 'WOMEN',
      category: 'DRESSES_WOMEN',
      season: 'SUMMER',
      combos: [{ color: 'RED', size: 'M', qty: 2 }],
      price: 100,
    });
    // A MEN product never counts on the women's listing.
    await product({
      tag,
      store: s,
      audience: 'MEN',
      category: 'JEANS',
      season: 'SUMMER',
      combos: [{ color: 'BLUE', size: 'M', qty: 2 }],
      price: 100,
    });

    const all = await browse(tag, {
      audience: 'WOMEN',
      facets: 'categories',
    }).expect(200);
    expect(all.body.all_count).toBe(3);
    expect(all.body.category_counts.JEANS).toBe(2);
    expect(all.body.category_counts.DRESSES_WOMEN).toBe(1);
    expect(all.body.category_counts.SKIRTS).toBe(0);
    // Only the audience's own categories are counted.
    expect(all.body.category_counts.BLOUSES_MEN).toBeUndefined();

    const summer = await browse(tag, {
      audience: 'WOMEN',
      season: 'SUMMER',
      category: 'JEANS',
      facets: 'categories',
    }).expect(200);
    expect(summer.body.total).toBe(1); // the listing honours the category
    expect(summer.body.all_count).toBe(2); // the counts do not
    expect(summer.body.category_counts.JEANS).toBe(1);
    expect(summer.body.category_counts.DRESSES_WOMEN).toBe(1);
  });

  it('cursor pagination returns every product exactly once, and a cursor never crosses into another filter set', async () => {
    const tag = unique('Cursor');
    const s = await makeStore();
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      made.push(
        (
          await product({
            tag,
            store: s,
            audience: 'KIDS',
            category: 'HOODIES',
            combos: [{ color: 'GRAY', size: 'AGE_6_7Y', qty: 3 }],
            price: 50 + i * 10,
          })
        ).canonicalId,
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string> = {
        audience: 'KIDS',
        sort: 'price-asc',
        page_size: '2',
      };
      if (cursor) query.cursor = cursor;
      const res = await browse(tag, query).expect(200);
      expect(res.body.total).toBe(5);
      seen.push(...ids(res.body));
      cursor = res.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(made);

    const first = await browse(tag, {
      audience: 'KIDS',
      sort: 'price-asc',
      page_size: '2',
    }).expect(200);
    const crossed = await browse(tag, {
      audience: 'KIDS',
      sort: 'price-asc',
      page_size: '2',
      color: 'GRAY',
      cursor: first.body.next_cursor,
    }).expect(400);
    expect(crossed.body.error.code).toBe('INVALID_CURSOR');
  });

  it('refuses invalid parameters with clear codes', async () => {
    const tag = unique('Invalid');
    const cases: [Record<string, string>, string][] = [
      [{ sort: 'cheapest' }, 'INVALID_SORT'],
      [{ min_price: '-1' }, 'INVALID_PRICE_FILTER'],
      [{ min_price: '100', max_price: '50' }, 'INVALID_PRICE_FILTER'],
      [{ available_only: 'yes' }, 'INVALID_AVAILABLE_ONLY'],
      [{ season: 'AUTUMN' }, 'UNKNOWN_SEASON'],
      [{ color: 'GREY' }, 'UNKNOWN_COLOR'],
      [{ size: '2XL' }, 'UNKNOWN_SIZE'],
      [{ audience: 'TEENS' }, 'UNKNOWN_AUDIENCE'],
      [{ category: 'dresses' }, 'UNKNOWN_CATEGORY'],
      [{ facets: 'colors' }, 'INVALID_FACETS'],
    ];
    for (const [query, code] of cases) {
      const res = await browse(tag, query).expect(400);
      expect(res.body.error.code).toBe(code);
    }
    // The new values are accepted.
    await browse(tag, { season: 'SPRING', color: 'GRAY', size: 'XXL' }).expect(
      200,
    );
  });
});
