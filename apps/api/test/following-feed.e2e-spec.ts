import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { ProductAudience } from '../generated/prisma/client';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// «أتابعه» in /profile: GET /customers/me/following/feed (browse mode) -
// only the products of the stores the SESSION user follows, narrowed by
// department -> category -> smart collection -> search -> drawer filters,
// with counts, filter options and a cursor.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}
const DAY = 86_400_000;

describe('Following feed (e2e)', () => {
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

  async function account() {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: 'not-used', phoneVerifiedAt: new Date() },
    });
    await prisma.customerProfile.create({ data: { userId: user.id } });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { user, token };
  }

  async function store(published = true) {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('feed-store'),
        legalName: unique('Legal'),
        displayName: unique('متجر'),
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: published,
        applicableCategories: {
          create: [
            { category: 'WOMEN' },
            { category: 'MEN' },
            { category: 'KIDS' },
          ],
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
  type Store = Awaited<ReturnType<typeof store>>;

  async function brand(name: string) {
    return prisma.brand.create({
      data: { name, normalizedName: unique(name).toLowerCase() },
    });
  }
  const legacyCategory = () =>
    prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('Category') },
    });

  /**
   * A classified, confirmed-match, ACTIVE offer of a canonical product
   * (a new one unless `productId` is given - the same product in a
   * second store).
   */
  async function product(
    s: Store,
    o: {
      name: string;
      audience: ProductAudience;
      category: string;
      combos: { color: string; size: string; qty: number }[];
      price: number;
      salePrice?: number;
      brandId: string;
      addedAt?: Date;
      productId?: string;
    },
  ) {
    const productId =
      o.productId ??
      (
        await prisma.canonicalProduct.create({
          data: {
            brandId: o.brandId,
            categoryId: (await legacyCategory()).id,
            modelName: unique('Model'),
            canonicalNameAr: o.name,
            canonicalNameEn: o.name,
            status: 'PUBLISHED',
          },
        })
      ).id;
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendor.id,
        titleAr: o.name,
        titleEn: o.name,
        status: 'DRAFT',
        taxonomyVersion: 1,
        requiresTaxonomy: true,
        createdAt: o.addedAt ?? new Date(),
      },
    });
    await prisma.vendorOfferAudience.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: offer.id,
        audience: o.audience,
      },
    });
    await prisma.vendorOfferCategory.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: offer.id,
        categoryCode: o.category,
      },
    });
    const variants: string[] = [];
    for (const c of o.combos) {
      const canonicalVariant = await prisma.canonicalProductVariant.create({
        data: {
          canonicalProductId: productId,
          structuralAttributes: {
            color: c.color,
            size: c.size,
            n: unique('v'),
          },
          platformProductBarcode: unique('pb'),
        },
      });
      const v = await prisma.offerVariant.create({
        data: {
          vendorId: s.vendor.id,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          storeInventoryBarcode: unique('sib'),
          basePrice: o.price,
          salePrice: o.salePrice ?? null,
          isCombination: true,
          colorCode: c.color,
          sizeCode: c.size,
          canonicalVariantId: canonicalVariant.id,
        },
      });
      await prisma.branchStock.create({
        data: {
          vendorId: s.vendor.id,
          branchId: s.branch.id,
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
    return { productId, variants };
  }

  async function sell(s: Store, variantId: string, quantity: number) {
    const buyer = await account();
    const profile = await prisma.customerProfile.findUniqueOrThrow({
      where: { userId: buyer.user.id },
    });
    const order = await prisma.customerOrder.create({
      data: { customerId: profile.id },
    });
    const bo = await prisma.branchOrder.create({
      data: {
        customerOrderId: order.id,
        vendorId: s.vendor.id,
        branchId: s.branch.id,
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'COD',
        subtotal: 10,
        total: 10,
      },
    });
    await prisma.branchOrderItem.create({
      data: {
        vendorId: s.vendor.id,
        branchOrderId: bo.id,
        offerVariantId: variantId,
        quantity,
        unitPrice: 10,
      },
    });
  }

  const follow = (token: string, slug: string) =>
    request(http())
      .put(`/api/v1/customers/me/following/${slug}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  const feed = (token: string, query: Record<string, string> = {}) =>
    request(http())
      .get('/api/v1/customers/me/following/feed')
      .set('Authorization', `Bearer ${token}`)
      .query({ facets: 'all', page_size: '50', ...query });
  const ids = (body: { items: { canonical_product_id: string }[] }) =>
    body.items.map((i) => i.canonical_product_id).sort();

  /**
   * Stores A and B (followed), C (not followed), D (followed but
   * unpublished):
   *   A: men black jeans (trending: 2 sold), men blue jeans (sale),
   *      men shirt, women dress (new), kids tshirt (age size)
   *   B: women jeans; the men black jeans product again (2 stores)
   *   C: men jeans ; D: men jeans
   */
  async function world() {
    const me = await account();
    const [a, b, c, d] = [
      await store(),
      await store(),
      await store(),
      await store(false),
    ];
    const levis = await brand(unique('Levis'));
    const zara = await brand(unique('Zara'));
    const old = new Date(Date.now() - 40 * DAY);
    const p = {
      menBlackJeans: await product(a, {
        name: 'Men black jeans',
        audience: 'MEN',
        category: 'JEANS',
        combos: [{ color: 'BLACK', size: 'M', qty: 3 }],
        price: 150,
        brandId: levis.id,
        addedAt: old,
      }),
      menBlueJeans: await product(a, {
        name: 'Men blue jeans',
        audience: 'MEN',
        category: 'JEANS',
        combos: [{ color: 'BLUE', size: 'L', qty: 2 }],
        price: 200,
        salePrice: 160,
        brandId: levis.id,
        addedAt: old,
      }),
      menShirt: await product(a, {
        name: 'Men shirt',
        audience: 'MEN',
        category: 'SHIRTS',
        combos: [{ color: 'BLACK', size: 'L', qty: 2 }],
        price: 90,
        brandId: zara.id,
        addedAt: old,
      }),
      womenDress: await product(a, {
        name: 'Women dress',
        audience: 'WOMEN',
        category: 'DRESSES_WOMEN',
        combos: [{ color: 'RED', size: 'S', qty: 2 }],
        price: 220,
        brandId: zara.id,
      }),
      kidsTshirt: await product(a, {
        name: 'Kids tshirt',
        audience: 'KIDS',
        category: 'TSHIRTS',
        combos: [{ color: 'BLUE', size: 'AGE_4_5Y', qty: 4 }],
        price: 40,
        brandId: zara.id,
        addedAt: old,
      }),
      womenJeans: await product(b, {
        name: 'Women jeans',
        audience: 'WOMEN',
        category: 'JEANS',
        combos: [{ color: 'BLUE', size: 'M', qty: 0 }],
        price: 130,
        brandId: levis.id,
        addedAt: old,
      }),
      unfollowed: await product(c, {
        name: 'Men jeans elsewhere',
        audience: 'MEN',
        category: 'JEANS',
        combos: [{ color: 'BLACK', size: 'M', qty: 5 }],
        price: 99,
        brandId: levis.id,
      }),
      unpublished: await product(d, {
        name: 'Men jeans hidden',
        audience: 'MEN',
        category: 'JEANS',
        combos: [{ color: 'BLACK', size: 'M', qty: 5 }],
        price: 99,
        brandId: levis.id,
      }),
    };
    await product(b, {
      name: 'Men black jeans',
      audience: 'MEN',
      category: 'JEANS',
      combos: [{ color: 'BLACK', size: 'L', qty: 1 }],
      price: 170,
      brandId: levis.id,
      addedAt: old,
      productId: p.menBlackJeans.productId,
    });
    await sell(a, p.menBlackJeans.variants[0], 2);
    // Store C's sales never make anything trend in this feed.
    await sell(c, p.unfollowed.variants[0], 9);
    await follow(me.token, a.vendor.slug);
    await follow(me.token, b.vendor.slug);
    await prisma.storeFollow.create({
      data: { userId: me.user.id, vendorId: d.vendor.id },
    });
    return { me, a, b, c, d, p, levis, zara };
  }

  it('1. no followed store: an empty feed, zero counts, no options', async () => {
    const me = await account();
    const res = await feed(me.token).expect(200);
    expect(res.body).toMatchObject({
      followed_store_count: 0,
      total: 0,
      items: [],
      next_cursor: null,
      department_counts: { ALL: 0, WOMEN: 0, MEN: 0, KIDS: 0 },
      collection_counts: { ALL: 0, TRENDING: 0, NEW: 0, DISCOUNT: 0 },
      categories: [],
    });
    expect(res.body.filter_options.brands).toEqual([]);
  });

  it("2-3. only the followed, published stores' products - never another store's", async () => {
    const { me, p } = await world();
    const res = await feed(me.token).expect(200);
    expect(res.body.followed_store_count).toBe(2);
    expect(ids(res.body)).toEqual(
      [
        p.menBlackJeans,
        p.menBlueJeans,
        p.menShirt,
        p.womenDress,
        p.kidsTshirt,
        p.womenJeans,
      ]
        .map((x) => x.productId)
        .sort(),
    );
    const all = JSON.stringify(res.body);
    expect(all).not.toContain(p.unfollowed.productId);
    expect(all).not.toContain(p.unpublished.productId);
    // The card is built from the followed stores only (A + B for the shared product).
    const shared = res.body.items.find(
      (i: { canonical_product_id: string }) =>
        i.canonical_product_id === p.menBlackJeans.productId,
    );
    expect(shared.store_count).toBe(2);
    expect(Number(shared.lowest_price)).toBe(150);
    // Even a search that matches the unfollowed store's title shows nothing of it.
    const searched = await feed(me.token, { q: 'elsewhere' }).expect(200);
    expect(searched.body.total).toBe(0);
  });

  it('4. department -> category -> trending -> colour: each step narrows the previous one', async () => {
    const { me, p } = await world();
    const men = await feed(me.token, { department: 'MEN' }).expect(200);
    expect(ids(men.body)).toEqual(
      [p.menBlackJeans, p.menBlueJeans, p.menShirt]
        .map((x) => x.productId)
        .sort(),
    );
    const jeans = await feed(me.token, {
      department: 'MEN',
      category: 'JEANS',
    }).expect(200);
    expect(ids(jeans.body)).toEqual(
      [p.menBlackJeans, p.menBlueJeans].map((x) => x.productId).sort(),
    );
    expect(ids(jeans.body)).not.toContain(p.womenJeans.productId);
    const trending = await feed(me.token, {
      department: 'MEN',
      category: 'JEANS',
      collection: 'trending',
    }).expect(200);
    expect(ids(trending.body)).toEqual([p.menBlackJeans.productId]);
    const black = await feed(me.token, {
      department: 'MEN',
      category: 'JEANS',
      collection: 'TRENDING',
      color: 'BLACK',
    }).expect(200);
    expect(ids(black.body)).toEqual([p.menBlackJeans.productId]);
    const blackBlue = await feed(me.token, {
      department: 'MEN',
      category: 'JEANS',
      collection: 'TRENDING',
      color: 'BLUE',
    }).expect(200);
    expect(blackBlue.body.total).toBe(0); // no wider fallback
    expect(blackBlue.body.items).toEqual([]);
    // Discount and new within a department.
    expect(
      ids(
        (
          await feed(me.token, {
            department: 'MEN',
            collection: 'DISCOUNT',
          }).expect(200)
        ).body,
      ),
    ).toEqual([p.menBlueJeans.productId]);
    expect(
      ids(
        (
          await feed(me.token, {
            department: 'WOMEN',
            collection: 'NEW',
          }).expect(200)
        ).body,
      ),
    ).toEqual([p.womenDress.productId]);
    // Kids + an age size.
    expect(
      ids(
        (
          await feed(me.token, { department: 'KIDS', size: 'AGE_4_5Y' }).expect(
            200,
          )
        ).body,
      ),
    ).toEqual([p.kidsTshirt.productId]);
  });

  it('5. a category outside the department, and other bad values, are refused', async () => {
    const { me } = await world();
    for (const [query, code] of [
      [
        { department: 'MEN', category: 'GIRLS_DRESSES' },
        'CATEGORY_NOT_IN_AUDIENCE',
      ],
      [
        { department: 'KIDS', category: 'DRESSES_WOMEN' },
        'CATEGORY_NOT_IN_AUDIENCE',
      ],
      [{ department: 'TEENS' }, 'INVALID_DEPARTMENT'],
      [{ collection: 'popular' }, 'INVALID_COLLECTION'],
      [{ sort: 'random' }, 'INVALID_SORT'],
      [{ category: 'NOPE' }, 'UNKNOWN_CATEGORY'],
      [{ min_price: '100', max_price: '10' }, 'INVALID_PRICE_FILTER'],
      [{ available_only: 'yes' }, 'INVALID_AVAILABLE_ONLY'],
      [{ brand: "x' or 1=1" }, 'INVALID_BRAND'],
      [{ cursor: 'garbage' }, 'INVALID_CURSOR'],
    ] as const) {
      const res = await feed(me.token, query as Record<string, string>).expect(
        400,
      );
      expect(res.body.error.code).toBe(code);
    }
  });

  it('6. department, category and smart-button counts follow the other selections', async () => {
    const { me } = await world();
    const all = await feed(me.token).expect(200);
    expect(all.body.department_counts).toEqual({
      ALL: 6,
      WOMEN: 2,
      MEN: 3,
      KIDS: 1,
    });
    expect(all.body.collection_counts).toEqual({
      ALL: 6,
      TRENDING: 1,
      NEW: 1,
      DISCOUNT: 1,
    });
    expect(all.body.categories).toEqual([]); // only once a department is chosen
    const men = await feed(me.token, { department: 'MEN' }).expect(200);
    expect(
      men.body.categories
        .map((c: { code: string; count: number }) => [c.code, c.count])
        .sort(),
    ).toEqual([
      ['JEANS', 2],
      ['SHIRTS', 1],
    ]);
    expect(men.body.collection_counts).toEqual({
      ALL: 3,
      TRENDING: 1,
      NEW: 0,
      DISCOUNT: 1,
    });
    // A colour narrows every count with it.
    const black = await feed(me.token, { color: 'BLACK' }).expect(200);
    expect(black.body.department_counts).toEqual({
      ALL: 2,
      WOMEN: 0,
      MEN: 2,
      KIDS: 0,
    });
    const discount = await feed(me.token, { collection: 'DISCOUNT' }).expect(
      200,
    );
    expect(discount.body.department_counts).toEqual({
      ALL: 1,
      WOMEN: 0,
      MEN: 1,
      KIDS: 0,
    });
    // The drawer's options are only what these products really have.
    const options = men.body.filter_options;
    expect(options.colors.map((c: { code: string }) => c.code).sort()).toEqual([
      'BLACK',
      'BLUE',
    ]);
    expect(options.sizes.map((s: { code: string }) => s.code).sort()).toEqual([
      'L',
      'M',
    ]);
    expect(options.brands).toHaveLength(2);
    expect(options.price).toEqual({ min: 90, max: 160 });
  });

  it('7. search, brand, price, availability and the cursor', async () => {
    const { me, p, zara } = await world();
    expect(
      ids((await feed(me.token, { q: 'JEANS' }).expect(200)).body),
    ).toEqual(
      [p.menBlackJeans, p.menBlueJeans, p.womenJeans]
        .map((x) => x.productId)
        .sort(),
    );
    expect(
      ids(
        (await feed(me.token, { q: 'jeans', department: 'WOMEN' }).expect(200))
          .body,
      ),
    ).toEqual([p.womenJeans.productId]);
    expect(
      ids((await feed(me.token, { brand: zara.id }).expect(200)).body),
    ).toEqual(
      [p.menShirt, p.womenDress, p.kidsTshirt].map((x) => x.productId).sort(),
    );
    expect(
      ids(
        (
          await feed(me.token, { min_price: '100', max_price: '155' }).expect(
            200,
          )
        ).body,
      ),
    ).toEqual([p.menBlackJeans, p.womenJeans].map((x) => x.productId).sort());
    // The sold-out women's jeans drop out with available_only.
    expect(
      ids(
        (
          await feed(me.token, { available_only: 'true', q: 'jeans' }).expect(
            200,
          )
        ).body,
      ),
    ).not.toContain(p.womenJeans.productId);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await feed(me.token, {
        page_size: '4',
        sort: 'price-asc',
        ...(cursor ? { cursor } : {}),
      }).expect(200);
      expect(res.body.total).toBe(6);
      seen.push(
        ...res.body.items.map(
          (i: { canonical_product_id: string }) => i.canonical_product_id,
        ),
      );
      cursor = res.body.next_cursor;
      pages += 1;
    } while (cursor && pages < 5);
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(6);
    const prices = (
      await feed(me.token, { sort: 'price-asc' }).expect(200)
    ).body.items.map((i: { lowest_price: string }) => Number(i.lowest_price));
    expect(prices).toEqual([...prices].sort((x, y) => x - y));
    // A cursor never crosses into another filter set.
    const first = await feed(me.token, { page_size: '2' }).expect(200);
    const cross = await feed(me.token, {
      page_size: '2',
      department: 'MEN',
      cursor: first.body.next_cursor,
    }).expect(400);
    expect(cross.body.error.code).toBe('INVALID_CURSOR');
  });

  it('9. unfollowing a store removes its products at the next fetch', async () => {
    const { me, b, p } = await world();
    expect(ids((await feed(me.token).expect(200)).body)).toContain(
      p.womenJeans.productId,
    );
    await request(http())
      .delete(`/api/v1/customers/me/following/${b.vendor.slug}`)
      .set('Authorization', `Bearer ${me.token}`)
      .expect(200);
    const after = await feed(me.token).expect(200);
    expect(after.body.followed_store_count).toBe(1);
    expect(ids(after.body)).not.toContain(p.womenJeans.productId);
    // The shared product is now built from store A alone.
    const shared = after.body.items.find(
      (i: { canonical_product_id: string }) =>
        i.canonical_product_id === p.menBlackJeans.productId,
    );
    expect(shared.store_count).toBe(1);
  });

  it('10. a personal feed for every account (owner and employee included); signed-out is 401', async () => {
    const { a, p } = await world();
    const owner = await account();
    await prisma.vendorUser.create({
      data: { userId: owner.user.id, vendorId: a.vendor.id, role: 'OWNER' },
    });
    const employee = await account();
    await prisma.vendorUser.create({
      data: {
        userId: employee.user.id,
        vendorId: a.vendor.id,
        role: 'BRANCH_EMPLOYEE',
        branchId: a.branch.id,
      },
    });
    // Their own store is not followed: the feed is about THEIR follows.
    expect((await feed(owner.token).expect(200)).body.total).toBe(0);
    await follow(owner.token, a.vendor.slug);
    await follow(employee.token, a.vendor.slug);
    for (const token of [owner.token, employee.token]) {
      const res = await feed(token, { department: 'MEN' }).expect(200);
      expect(ids(res.body)).toEqual(
        [p.menBlackJeans, p.menBlueJeans, p.menShirt]
          .map((x) => x.productId)
          .sort(),
      );
    }
    await request(http())
      .get('/api/v1/customers/me/following/feed')
      .query({ facets: 'all' })
      .expect(401);
    // The classic (no browse parameter) response is unchanged.
    const classic = await request(http())
      .get('/api/v1/customers/me/following/feed')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(classic.body).toEqual(
      expect.objectContaining({ page: 1, page_size: 20, total: 5 }),
    );
    expect(classic.body.department_counts).toBeUndefined();
  });
});
