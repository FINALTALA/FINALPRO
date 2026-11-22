import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import {
  ProductAudience,
  ProductSeason,
  StoreApplicableCategory,
} from '../generated/prisma/client';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// The public storefront catalogue: department -> detailed category ->
// smart collection -> search -> filter drawer, every step narrowing the
// previous one (AND), server-side, with counts and pagination; and the
// owner's department/category configuration.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}
const DAY = 86_400_000;

interface Combo {
  color: string | null;
  size: string | null;
  qty: number;
}

describe('Storefront catalogue filtering (e2e)', () => {
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

  async function user() {
    const phone = uniqueTestPhone();
    return prisma.user.create({
      data: { phone, passwordHash: 'not-used', phoneVerifiedAt: new Date() },
    });
  }
  async function session(u: Awaited<ReturnType<typeof user>>) {
    return app.get(SessionService).create({
      userId: u.id,
      phone: u.phone,
      phoneVerifiedAt: u.phoneVerifiedAt!.toISOString(),
      sessionVersion: u.sessionVersion,
    });
  }

  async function makeStore(
    types: StoreApplicableCategory[] = ['WOMEN', 'MEN', 'KIDS'],
  ) {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('cat-store'),
        legalName: unique('Legal'),
        displayName: 'متجر الكتالوج',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
        applicableCategories: {
          create: types.map((category) => ({ category })),
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
    const owner = await user();
    await prisma.vendorUser.create({
      data: { userId: owner.id, vendorId: vendor.id, role: 'OWNER' },
    });
    const employee = await user();
    await prisma.vendorUser.create({
      data: {
        userId: employee.id,
        vendorId: vendor.id,
        role: 'BRANCH_EMPLOYEE',
        branchId: branch.id,
      },
    });
    return {
      vendor,
      branch,
      owner: await session(owner),
      employee: await session(employee),
    };
  }

  type Store = Awaited<ReturnType<typeof makeStore>>;

  /** A classified, ACTIVE offer: one audience, one category, combinations. */
  async function product(
    s: Store,
    o: {
      title: string;
      audience: ProductAudience;
      category: string;
      season?: ProductSeason | null;
      combos: Combo[];
      price: number;
      salePrice?: number;
      addedAt?: Date;
    },
  ) {
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendor.id,
        titleAr: o.title,
        titleEn: o.title,
        status: 'DRAFT',
        season: o.season ?? null,
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
    return { id: offer.id, variants };
  }

  /** `quantity` units of a variant sold through a real order. */
  async function sell(
    s: Store,
    variantId: string,
    quantity: number,
    cancelled = false,
  ) {
    const buyer = await user();
    const profile = await prisma.customerProfile.create({
      data: { userId: buyer.id },
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
        ...(cancelled ? { cancelledAt: new Date() } : {}),
      },
    });
  }
  async function favorite(variantId: string) {
    const fan = await user();
    await prisma.favorite.create({
      data: { userId: fan.id, targetType: 'OFFER', offerVariantId: variantId },
    });
  }

  /**
   * The store every test uses:
   *   men jeans      : black M (trending: 2 sold), blue L, black-sold-out
   *   men jeans 2    : black L, on sale, not trending
   *   men shirt      : black M, trending (favourite)
   *   women dress    : new (today), red S, summer
   *   women dress old: 40 days old, black S
   *   women jeans    : blue M
   *   kids tshirt    : AGE_4_5Y + AGE_6_7Y, discounted
   *   kids shoes     : sale
   *   legacy offer   : unclassified (only under "all")
   */
  async function catalogue() {
    const s = await makeStore();
    const old = new Date(Date.now() - 40 * DAY);
    const p = {
      menJeans: await product(s, {
        title: 'Men jeans black',
        audience: 'MEN',
        category: 'JEANS',
        season: 'FALL',
        combos: [
          { color: 'BLACK', size: 'M', qty: 4 },
          { color: 'BLUE', size: 'L', qty: 2 },
        ],
        price: 150,
        addedAt: old,
      }),
      menJeansSale: await product(s, {
        title: 'Men jeans slim',
        audience: 'MEN',
        category: 'JEANS',
        season: 'FALL',
        combos: [{ color: 'BLACK', size: 'L', qty: 3 }],
        price: 200,
        salePrice: 160,
        addedAt: old,
      }),
      menJeansSoldOut: await product(s, {
        title: 'Men jeans black sold out',
        audience: 'MEN',
        category: 'JEANS',
        combos: [{ color: 'BLACK', size: 'S', qty: 0 }],
        price: 120,
        addedAt: old,
      }),
      menShirt: await product(s, {
        title: 'Men shirt',
        audience: 'MEN',
        category: 'SHIRTS',
        combos: [{ color: 'BLACK', size: 'M', qty: 3 }],
        price: 90,
        addedAt: old,
      }),
      womenDressNew: await product(s, {
        title: 'Women dress red',
        audience: 'WOMEN',
        category: 'DRESSES_WOMEN',
        season: 'SUMMER',
        combos: [{ color: 'RED', size: 'S', qty: 3 }],
        price: 220,
      }),
      womenDressOld: await product(s, {
        title: 'Women dress black',
        audience: 'WOMEN',
        category: 'DRESSES_WOMEN',
        combos: [{ color: 'BLACK', size: 'S', qty: 3 }],
        price: 180,
        addedAt: old,
      }),
      womenJeans: await product(s, {
        title: 'Women jeans',
        audience: 'WOMEN',
        category: 'JEANS',
        combos: [{ color: 'BLUE', size: 'M', qty: 3 }],
        price: 140,
        addedAt: old,
      }),
      kidsTshirt: await product(s, {
        title: 'Kids tshirt',
        audience: 'KIDS',
        category: 'TSHIRTS',
        season: 'SUMMER',
        combos: [
          { color: 'BLUE', size: 'AGE_4_5Y', qty: 5 },
          { color: 'BLUE', size: 'AGE_6_7Y', qty: 0 },
        ],
        price: 40,
        salePrice: 30,
        addedAt: old,
      }),
      kidsShoes: await product(s, {
        title: 'Kids shoes',
        audience: 'KIDS',
        category: 'SHOES',
        combos: [{ color: 'WHITE', size: null, qty: 2 }],
        price: 80,
        salePrice: 60,
        addedAt: old,
      }),
    };
    const legacy = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendor.id,
        titleAr: 'Legacy item',
        titleEn: 'Legacy item',
        status: 'ACTIVE',
        createdAt: old,
      },
    });
    await prisma.offerVariant.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: legacy.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 50,
      },
    });
    // Trending: 2 men's jeans sold (score 6), a cancelled sale (ignored),
    // one favourite on the shirt (score 1).
    await sell(s, p.menJeans.variants[0], 2);
    await sell(s, p.menJeansSale.variants[0], 5, true);
    await favorite(p.menShirt.variants[0]);
    return { s, p, legacyId: legacy.id };
  }

  const list = (slug: string, query: Record<string, string> = {}) =>
    request(http())
      .get(`/api/v1/storefronts/${slug}/products`)
      .query({ page_size: '50', ...query });
  const ids = (body: { items: { id: string }[] }) =>
    body.items.map((i) => i.id).sort();

  it('1-2. all products by default; women / men / kids each only their own', async () => {
    const { s, p, legacyId } = await catalogue();
    const all = await list(s.vendor.slug).expect(200);
    expect(all.body.total).toBe(10);
    expect(all.body.store_total).toBe(10);
    expect(ids(all.body)).toContain(legacyId);
    const allExplicit = await list(s.vendor.slug, { audience: 'ALL' }).expect(
      200,
    );
    expect(allExplicit.body.total).toBe(10);
    const women = await list(s.vendor.slug, { audience: 'WOMEN' }).expect(200);
    expect(ids(women.body)).toEqual(
      [p.womenDressNew.id, p.womenDressOld.id, p.womenJeans.id].sort(),
    );
    const men = await list(s.vendor.slug, { audience: 'MEN' }).expect(200);
    expect(ids(men.body)).toEqual(
      [
        p.menJeans.id,
        p.menJeansSale.id,
        p.menJeansSoldOut.id,
        p.menShirt.id,
      ].sort(),
    );
    const kids = await list(s.vendor.slug, { audience: 'KIDS' }).expect(200);
    expect(ids(kids.body)).toEqual([p.kidsTshirt.id, p.kidsShoes.id].sort());
    // The unclassified offer only shows under "all".
    expect([
      ...ids(women.body),
      ...ids(men.body),
      ...ids(kids.body),
    ]).not.toContain(legacyId);
  });

  it('3-5. men -> jeans -> trending -> black: each step narrows the previous one', async () => {
    const { s, p } = await catalogue();
    const jeans = await list(s.vendor.slug, {
      audience: 'MEN',
      category: 'JEANS',
    }).expect(200);
    expect(ids(jeans.body)).toEqual(
      [p.menJeans.id, p.menJeansSale.id, p.menJeansSoldOut.id].sort(),
    );
    // Women's jeans are jeans too, but never in the men's department.
    expect(ids(jeans.body)).not.toContain(p.womenJeans.id);
    const trending = await list(s.vendor.slug, {
      audience: 'MEN',
      category: 'JEANS',
      collection: 'TRENDING',
    }).expect(200);
    // The cancelled sale does not make the slim jeans trend.
    expect(ids(trending.body)).toEqual([p.menJeans.id]);
    const black = await list(s.vendor.slug, {
      audience: 'MEN',
      category: 'JEANS',
      collection: 'TRENDING',
      color: 'BLACK',
    }).expect(200);
    expect(ids(black.body)).toEqual([p.menJeans.id]);
    const blackL = await list(s.vendor.slug, {
      audience: 'MEN',
      category: 'JEANS',
      collection: 'TRENDING',
      color: 'BLACK',
      size: 'L',
    }).expect(200);
    expect(blackL.body.total).toBe(0); // its black is M, its L is blue
    // Trending across the whole store: the jeans (score 6) before the shirt (1).
    const storeTrend = await list(s.vendor.slug, {
      collection: 'TRENDING',
    }).expect(200);
    expect(storeTrend.body.items.map((i: { id: string }) => i.id)).toEqual([
      p.menJeans.id,
      p.menShirt.id,
    ]);
  });

  it('6. women + new arrivals; 7. kids + an age size; 8. discounts within a category', async () => {
    const { s, p } = await catalogue();
    const newWomen = await list(s.vendor.slug, {
      audience: 'WOMEN',
      collection: 'NEW',
    }).expect(200);
    expect(ids(newWomen.body)).toEqual([p.womenDressNew.id]);
    const kidsAge = await list(s.vendor.slug, {
      audience: 'KIDS',
      size: 'AGE_4_5Y',
    }).expect(200);
    expect(ids(kidsAge.body)).toEqual([p.kidsTshirt.id]);
    const kidsSoldOutSize = await list(s.vendor.slug, {
      audience: 'KIDS',
      size: 'AGE_6_7Y',
    }).expect(200);
    expect(kidsSoldOutSize.body.total).toBe(0);
    const shoeSale = await list(s.vendor.slug, {
      audience: 'KIDS',
      category: 'SHOES',
      collection: 'DISCOUNT',
    }).expect(200);
    expect(ids(shoeSale.body)).toEqual([p.kidsShoes.id]);
    const jeansSale = await list(s.vendor.slug, {
      audience: 'MEN',
      category: 'JEANS',
      collection: 'DISCOUNT',
    }).expect(200);
    expect(ids(jeansSale.body)).toEqual([p.menJeansSale.id]);
  });

  it('9. search combines with department, category and filters', async () => {
    const { s, p } = await catalogue();
    expect(
      ids((await list(s.vendor.slug, { q: 'jeans' }).expect(200)).body).length,
    ).toBe(4);
    expect(
      ids(
        (await list(s.vendor.slug, { q: 'JEANS', audience: 'MEN' }).expect(200))
          .body,
      ).length,
    ).toBe(3);
    const r = await list(s.vendor.slug, {
      q: 'black',
      audience: 'MEN',
      category: 'JEANS',
      available_only: 'true',
    }).expect(200);
    expect(ids(r.body)).toEqual([p.menJeans.id]); // the sold-out black jeans drop out
    const none = await list(s.vendor.slug, {
      q: 'jeans',
      audience: 'KIDS',
    }).expect(200);
    expect(none.body.total).toBe(0);
  });

  it('smart-button counts follow every other active filter; one collection at a time', async () => {
    const { s } = await catalogue();
    const men = await list(s.vendor.slug, { audience: 'MEN' }).expect(200);
    expect(men.body.collection_counts).toEqual({
      ALL: 4,
      TRENDING: 2,
      NEW: 0,
      DISCOUNT: 1,
    });
    const menJeansDiscount = await list(s.vendor.slug, {
      audience: 'MEN',
      category: 'JEANS',
      collection: 'DISCOUNT',
    }).expect(200);
    expect(menJeansDiscount.body.collection_counts).toEqual({
      ALL: 3,
      TRENDING: 1,
      NEW: 0,
      DISCOUNT: 1,
    });
    expect(menJeansDiscount.body.collection).toBe('DISCOUNT');
  });

  it('10. refuses invalid departments, collections and category/department contradictions', async () => {
    const { s } = await catalogue();
    for (const [query, code] of [
      [
        { audience: 'MEN', category: 'GIRLS_DRESSES' },
        'CATEGORY_NOT_IN_AUDIENCE',
      ],
      [
        { audience: 'KIDS', category: 'DRESSES_WOMEN' },
        'CATEGORY_NOT_IN_AUDIENCE',
      ],
      [{ audience: 'TEENS' }, 'UNKNOWN_AUDIENCE'],
      [{ category: 'NOT_A_CATEGORY' }, 'UNKNOWN_CATEGORY'],
      [{ collection: 'POPULAR' }, 'INVALID_COLLECTION'],
      [{ sort: 'random' }, 'INVALID_SORT'],
      [{ available_only: 'yes' }, 'INVALID_AVAILABLE_ONLY'],
      [{ min_price: '100', max_price: '10' }, 'INVALID_PRICE_FILTER'],
    ] as const) {
      const res = await list(
        s.vendor.slug,
        query as Record<string, string>,
      ).expect(400);
      expect(res.body.error.code).toBe(code);
    }
  });

  it('13. pagination and the total after combined filters; 14. no match never widens', async () => {
    const { s } = await catalogue();
    const page1 = await list(s.vendor.slug, {
      audience: 'MEN',
      page_size: '2',
      page: '1',
      sort: 'price_asc',
    }).expect(200);
    const page2 = await list(s.vendor.slug, {
      audience: 'MEN',
      page_size: '2',
      page: '2',
      sort: 'price_asc',
    }).expect(200);
    expect(page1.body.total).toBe(4);
    expect(page2.body.total).toBe(4);
    const prices = [...page1.body.items, ...page2.body.items].map(
      (i: { min_price: string }) => Number(i.min_price),
    );
    expect(prices).toEqual([90, 120, 150, 160]);
    const none = await list(s.vendor.slug, {
      audience: 'WOMEN',
      category: 'JEANS',
      collection: 'TRENDING',
      color: 'RED',
    }).expect(200);
    expect(none.body).toMatchObject({ total: 0, items: [] });
    expect(none.body.store_total).toBe(10);
  });

  it("the response lists the store's departments and the detailed categories it offers", async () => {
    const s = await makeStore(['WOMEN', 'KIDS', 'ACCESSORIES']);
    await prisma.storefrontCategory.createMany({
      data: [
        {
          vendorId: s.vendor.id,
          audience: 'WOMEN',
          categoryCode: 'JEANS',
          sortOrder: 1,
        },
        {
          vendorId: s.vendor.id,
          audience: 'WOMEN',
          categoryCode: 'DRESSES_WOMEN',
          sortOrder: 0,
        },
        {
          vendorId: s.vendor.id,
          audience: 'MEN',
          categoryCode: 'SHIRTS',
          sortOrder: 0,
        },
      ],
    });
    const res = await list(s.vendor.slug).expect(200);
    expect(
      res.body.departments.map((d: { audience: string }) => d.audience),
    ).toEqual(['WOMEN', 'KIDS']);
    expect(
      res.body.departments[0].categories.map((c: { code: string }) => c.code),
    ).toEqual(['DRESSES_WOMEN', 'JEANS']);
    expect(res.body.departments[0].categories[0].name_ar).toBe('فساتين');
    // The database itself refuses an incompatible pair.
    await expect(
      prisma.storefrontCategory.create({
        data: {
          vendorId: s.vendor.id,
          audience: 'MEN',
          categoryCode: 'GIRLS_DRESSES',
          sortOrder: 0,
        },
      }),
    ).rejects.toThrow();
  });

  it('11. the owner configures departments and categories; incompatible codes are refused', async () => {
    const s = await makeStore(['WOMEN', 'ACCESSORIES']);
    const put = (token: string, body: object) =>
      request(http())
        .put(`/api/v1/vendors/${s.vendor.id}/storefront/catalogue`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);
    const res = await put(s.owner, {
      departments: ['MEN', 'KIDS'],
      categories: { MEN: ['JEANS', 'SHIRTS'], KIDS: ['GIRLS_DRESSES'] },
    }).expect(200);
    expect(res.body.departments).toEqual([
      expect.objectContaining({
        audience: 'MEN',
        categories: [
          expect.objectContaining({ code: 'JEANS' }),
          expect.objectContaining({ code: 'SHIRTS' }),
        ],
      }),
      expect.objectContaining({
        audience: 'KIDS',
        categories: [expect.objectContaining({ code: 'GIRLS_DRESSES' })],
      }),
    ]);
    // WOMEN left the store's types, ACCESSORIES stayed (not a department).
    const types = (
      await prisma.vendorApplicableCategory.findMany({
        where: { vendorId: s.vendor.id },
      })
    )
      .map((t) => t.category)
      .sort();
    expect(types).toEqual(['ACCESSORIES', 'KIDS', 'MEN']);
    // The public page shows it straight away.
    const pub = await list(s.vendor.slug).expect(200);
    expect(
      pub.body.departments.map((d: { audience: string }) => d.audience),
    ).toEqual(['MEN', 'KIDS']);
    // The owner's own GET.
    const own = await request(http())
      .get(`/api/v1/vendors/${s.vendor.id}/storefront/catalogue`)
      .set('Authorization', `Bearer ${s.owner}`)
      .expect(200);
    expect(own.body.departments).toHaveLength(2);

    for (const [body, code] of [
      [
        { departments: ['MEN'], categories: { MEN: ['GIRLS_DRESSES'] } },
        'CATEGORY_NOT_IN_AUDIENCE',
      ],
      [
        { departments: ['MEN'], categories: { MEN: ['NOPE'] } },
        'UNKNOWN_CATEGORY',
      ],
      [
        { departments: ['MEN'], categories: { WOMEN: ['JEANS'] } },
        'DEPARTMENT_NOT_OFFERED',
      ],
      [
        { departments: ['MEN'], categories: { TEENS: ['JEANS'] } },
        'UNKNOWN_AUDIENCE',
      ],
      [
        { departments: ['MEN'], categories: { MEN: ['JEANS', 'JEANS'] } },
        'INVALID_CATEGORIES',
      ],
    ] as const) {
      const bad = await put(s.owner, body).expect(400);
      expect(bad.body.error.code).toBe(code);
    }
    await put(s.owner, { departments: ['ALIENS'] }).expect(400);
    // Nothing changed by the refused requests.
    const after = await list(s.vendor.slug).expect(200);
    expect(
      after.body.departments.map(
        (d: { audience: string; categories: unknown[] }) => [
          d.audience,
          d.categories.length,
        ],
      ),
    ).toEqual([
      ['MEN', 2],
      ['KIDS', 1],
    ]);
  });

  it('11-12. only the owner may configure it; at least one store type stays; the public endpoint is read-only', async () => {
    const s = await makeStore(['WOMEN']);
    const url = `/api/v1/vendors/${s.vendor.id}/storefront/catalogue`;
    const body = { departments: ['MEN'], categories: { MEN: ['JEANS'] } };
    const denied = await request(http())
      .put(url)
      .set('Authorization', `Bearer ${s.employee}`)
      .send(body)
      .expect(403);
    expect(denied.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    const stranger = await makeStore();
    await request(http())
      .put(url)
      .set('Authorization', `Bearer ${stranger.owner}`)
      .send(body)
      .expect(403);
    await request(http()).put(url).send(body).expect(401);
    await request(http())
      .get(url)
      .set('Authorization', `Bearer ${s.employee}`)
      .expect(403);
    const none = await request(http())
      .put(url)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ departments: [] })
      .expect(400);
    expect(none.body.error.code).toBe('STORE_TYPE_REQUIRED');
    for (const method of ['put', 'post', 'patch', 'delete'] as const) {
      const res = await request(http())
        [method](`/api/v1/storefronts/${s.vendor.slug}/products`)
        .send(body);
      expect(res.status).toBe(404);
    }
    const types = (
      await prisma.vendorApplicableCategory.findMany({
        where: { vendorId: s.vendor.id },
      })
    ).map((t) => t.category);
    expect(types).toEqual(['WOMEN']);
  });

  it("trending is scoped to this store: another store's sales never count", async () => {
    const a = await makeStore();
    const b = await makeStore();
    const pa = await product(a, {
      title: 'A jeans',
      audience: 'MEN',
      category: 'JEANS',
      combos: [{ color: 'BLACK', size: 'M', qty: 3 }],
      price: 100,
    });
    const pb = await product(b, {
      title: 'B jeans',
      audience: 'MEN',
      category: 'JEANS',
      combos: [{ color: 'BLACK', size: 'M', qty: 3 }],
      price: 100,
    });
    await sell(b, pb.variants[0], 9);
    expect(
      (await list(a.vendor.slug, { collection: 'TRENDING' }).expect(200)).body
        .total,
    ).toBe(0);
    expect(
      ids(
        (await list(b.vendor.slug, { collection: 'TRENDING' }).expect(200))
          .body,
      ),
    ).toEqual([pb.id]);
    expect(pa.id).toBeDefined();
  });
});
