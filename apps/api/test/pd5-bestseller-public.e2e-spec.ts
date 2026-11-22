import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { ProductAudience } from '../generated/prisma/client';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { SalesRankService } from './../src/sales-rank/sales-rank.service';

// PD-5.3 (PD-FR-005): the public Bestseller mark and «الأكثر مبيعاً» sort
// - read from the snapshot only, behind the `bestseller_enabled` flag
// (off by default), never carrying a rank, unit or customer count; the
// owner's own view; and who may see what.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}
const FLAG = 'bestseller_enabled';

describe('PD-5.3 public bestseller (e2e)', () => {
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
    // Each test starts with the flag at its default (off).
    await prisma.featureFlag.deleteMany({ where: { key: FLAG } });
  });

  afterEach(async () => {
    await app.close();
  });

  const call = (method: 'get' | 'put', url: string, token: string | null) => {
    let r = request(app.getHttpServer())[method](`/api/v1${url}`);
    if (method !== 'get') r = r.set('Idempotency-Key', unique('idem'));
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  async function account(platformRole?: 'PLATFORM_ADMIN') {
    const phone = `+996${Date.now()}${(counter += 1)}`;
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'not-used',
        phoneVerifiedAt: new Date(),
        platformRole,
      },
    });
    const profile = await prisma.customerProfile.create({
      data: { userId: user.id },
    });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { token, userId: user.id, customerId: profile.id };
  }

  async function store() {
    const owner = await account();
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('best-store').toLowerCase(),
        legalName: unique('Legal'),
        displayName: 'متجر',
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
    const employee = await account();
    await prisma.vendorUser.create({
      data: {
        userId: employee.userId,
        vendorId: vendor.id,
        role: 'BRANCH_EMPLOYEE',
        branchId: branch.id,
      },
    });
    return { vendor, branch, owner, employee };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  /** A classified offer confirmed-matched to its own canonical product. */
  async function product(
    s: Store,
    scope: { category: string; audience: ProductAudience },
  ) {
    const brand = await prisma.brand.create({
      data: { name: unique('Brand'), normalizedName: unique('b') },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('C') },
    });
    const p = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('M'),
        canonicalNameAr: unique('منتج'),
        status: 'PUBLISHED',
      },
    });
    const cv = await prisma.canonicalProductVariant.create({
      data: {
        canonicalProductId: p.id,
        structuralAttributes: { n: unique('v') },
        platformProductBarcode: unique('pb'),
      },
    });
    const o = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendor.id,
        titleAr: unique('قطعة'),
        titleEn: 'Item',
        status: 'ACTIVE',
        canonicalProductId: p.id,
        taxonomyVersion: 1,
        requiresTaxonomy: true,
      },
    });
    await prisma.vendorOfferAudience.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: o.id,
        audience: scope.audience,
      },
    });
    await prisma.vendorOfferCategory.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: o.id,
        categoryCode: scope.category,
      },
    });
    const v = await prisma.offerVariant.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: o.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 70,
        isCombination: true,
        colorCode: 'BLACK',
        canonicalVariantId: cv.id,
      },
    });
    await prisma.branchStock.create({
      data: {
        vendorId: s.vendor.id,
        branchId: s.branch.id,
        offerVariantId: v.id,
        quantity: 50,
      },
    });
    return { productId: p.id, offerId: o.id, variantId: v.id };
  }

  /** `units` completed units spread over `customers` distinct buyers. */
  async function sell(
    s: Store,
    p: { variantId: string },
    units: number,
    customers: number,
  ) {
    const buyers = [];
    for (let i = 0; i < customers; i++) buyers.push(await account());
    for (let i = 0; i < units; i++) {
      const co = await prisma.customerOrder.create({
        data: { customerId: buyers[i % customers].customerId },
      });
      const bo = await prisma.branchOrder.create({
        data: {
          customerOrderId: co.id,
          vendorId: s.vendor.id,
          branchId: s.branch.id,
          fulfilmentMethod: 'PICKUP',
          paymentMethod: 'COD',
          status: 'COMPLETED',
          subtotal: 70,
          total: 70,
          pickupCode: String(200000 + (counter += 1)),
          pickedUpAt: new Date(Date.now() - 86_400_000),
        },
      });
      await prisma.branchOrderItem.create({
        data: {
          vendorId: s.vendor.id,
          branchOrderId: bo.id,
          offerVariantId: p.variantId,
          quantity: 1,
          unitPrice: 70,
        },
      });
    }
  }

  /** One store, one scope: 4 qualifying products, one below the bar, one unsold. */
  async function catalogue(scope: {
    category: string;
    audience: ProductAudience;
  }) {
    const s = await store();
    const top = [];
    for (const [units, customers] of [
      [9, 4],
      [8, 3],
      [7, 3],
      [6, 3],
    ] as const) {
      const p = await product(s, scope);
      await sell(s, p, units, customers);
      top.push(p);
    }
    const below = await product(s, scope);
    await sell(s, below, 4, 4);
    const unsold = await product(s, scope);
    await app.get(SalesRankService).rebuild({ trigger: 'SCHEDULED' });
    return { s, top, below, unsold };
  }

  async function setFlag(enabled: boolean) {
    const admin = await account('PLATFORM_ADMIN');
    await call('put', `/admin/feature-flags/${FLAG}`, admin.token)
      .send({ enabled })
      .expect(200);
  }

  const noNumbers = (body: unknown) =>
    expect(JSON.stringify(body)).not.toMatch(
      /"units"|"customers"|"rank"|qualified_rank|"position"|"qualified"/,
    );

  it('flag off (default): no mark anywhere and the sort is refused honestly', async () => {
    const scope = { category: 'SHIRTS', audience: 'MEN' as ProductAudience };
    const { s, top } = await catalogue(scope);

    const detail = await call(
      'get',
      `/storefronts/${s.vendor.slug}/offers/${top[0].offerId}`,
      null,
    ).expect(200);
    expect(detail.body.bestseller).toBeNull();

    const list = await call(
      'get',
      `/discovery/all?audience=MEN&category=SHIRTS&sort=newest`,
      null,
    ).expect(200);
    expect(list.body.bestseller_enabled).toBe(false);
    expect(
      list.body.items.every(
        (i: { bestseller: unknown }) => i.bestseller === null,
      ),
    ).toBe(true);

    const refused = await call(
      'get',
      `/discovery/all?audience=MEN&category=SHIRTS&sort=bestseller`,
      null,
    ).expect(404);
    expect(refused.body.error.code).toBe('FEATURE_DISABLED');
    const storeRefused = await call(
      'get',
      `/storefronts/${s.vendor.slug}/products?sort=bestseller`,
      null,
    ).expect(404);
    expect(storeRefused.body.error.code).toBe('FEATURE_DISABLED');
    expect(
      (
        await call(
          'get',
          `/storefronts/${s.vendor.slug}/products`,
          null,
        ).expect(200)
      ).body.bestseller_enabled,
    ).toBe(false);
  });

  it('flag on: the product page and discovery cards carry the mark (scope only), the sort puts qualified products first, nothing numeric leaks', async () => {
    const scope = { category: 'HOODIES', audience: 'WOMEN' as ProductAudience };
    const { s, top, below, unsold } = await catalogue(scope);
    await setFlag(true);

    const detail = await call(
      'get',
      `/storefronts/${s.vendor.slug}/offers/${top[0].offerId}`,
      null,
    ).expect(200);
    expect(detail.body.bestseller).toEqual({
      category_code: 'HOODIES',
      audience: 'WOMEN',
    });
    noNumbers(detail.body.bestseller);
    expect(
      (
        await call(
          'get',
          `/storefronts/${s.vendor.slug}/offers/${below.offerId}`,
          null,
        ).expect(200)
      ).body.bestseller,
    ).toBeNull();

    // Discovery, «الأكثر مبيعاً», paged by 3: the 4 qualified first (by
    // their order), then the rest newest first.
    const ids: string[] = [];
    const marked: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await call(
        'get',
        `/discovery/all?audience=WOMEN&category=HOODIES&sort=bestseller&page_size=3${cursor ? `&cursor=${cursor}` : ''}`,
        null,
      ).expect(200);
      expect(res.body.bestseller_enabled).toBe(true);
      for (const item of res.body.items) {
        ids.push(item.canonical_product_id);
        noNumbers(item);
        if (item.bestseller) {
          expect(item.bestseller).toEqual({
            category_code: 'HOODIES',
            audience: 'WOMEN',
          });
          marked.push(item.canonical_product_id);
        }
      }
      cursor = res.body.next_cursor;
    } while (cursor);
    expect(ids.slice(0, 4)).toEqual(top.map((p) => p.productId));
    expect(ids.slice(4)).toEqual([unsold.productId, below.productId]);
    expect(marked).toEqual(top.map((p) => p.productId));

    // Another sort still marks the qualified cards.
    const newest = await call(
      'get',
      `/discovery/all?audience=WOMEN&category=HOODIES&sort=newest`,
      null,
    ).expect(200);
    expect(
      newest.body.items.filter((i: { bestseller: unknown }) => i.bestseller)
        .length,
    ).toBe(4);
    // A listing scoped elsewhere doesn't borrow this scope's mark.
    const men = await call(
      'get',
      `/discovery/all?audience=MEN&sort=newest`,
      null,
    ).expect(200);
    expect(
      men.body.items.some(
        (i: { canonical_product_id: string; bestseller: unknown }) =>
          top.some(
            (p) => p.productId === i.canonical_product_id && i.bestseller,
          ),
      ),
    ).toBe(false);

    // The store page sort: same order for this store's offers.
    const storeList = await call(
      'get',
      `/storefronts/${s.vendor.slug}/products?sort=bestseller&page_size=50`,
      null,
    ).expect(200);
    expect(storeList.body.bestseller_enabled).toBe(true);
    expect(
      storeList.body.items.slice(0, 4).map((i: { id: string }) => i.id),
    ).toEqual(top.map((p) => p.offerId));
    noNumbers(storeList.body.items);

    // A stale snapshot (the job stopped) shows nothing rather than old data.
    await prisma.salesRankRun.updateMany({
      data: { computedAt: new Date(Date.now() - 30 * 60 * 60_000) },
    });
    expect(
      (
        await call(
          'get',
          `/storefronts/${s.vendor.slug}/offers/${top[0].offerId}`,
          null,
        ).expect(200)
      ).body.bestseller,
    ).toBeNull();
    await app.get(SalesRankService).rebuild({ trigger: 'SCHEDULED' });

    // Turning the flag off removes everything again.
    await setFlag(false);
    expect(
      (
        await call(
          'get',
          `/storefronts/${s.vendor.slug}/offers/${top[0].offerId}`,
          null,
        ).expect(200)
      ).body.bestseller,
    ).toBeNull();
  });

  it("the owner sees only their own store's figures; employees, other stores, customers and guests don't", async () => {
    const scope = {
      category: 'SWEATSHIRTS',
      audience: 'MEN' as ProductAudience,
    };
    const { s, top } = await catalogue(scope);
    const other = await catalogue({ category: 'SPORTSWEAR', audience: 'MEN' });
    const customer = await account();
    const path = `/vendors/${s.vendor.id}/sales-rank`;

    const own = await call('get', path, s.owner.token).expect(200);
    expect(own.body.computed_at).toEqual(expect.any(String));
    const offerIds = own.body.entries.map(
      (e: { offer_id: string }) => e.offer_id,
    );
    expect(offerIds).toEqual(expect.arrayContaining(top.map((p) => p.offerId)));
    expect(
      offerIds.some((id: string) => other.top.some((p) => p.offerId === id)),
    ).toBe(false);
    expect(own.body.entries[0]).toMatchObject({
      units: 9,
      customers: 4,
      bestseller: true,
      category_code: 'SWEATSHIRTS',
    });
    // No rank among other stores.
    expect(JSON.stringify(own.body)).not.toMatch(/"rank"|qualified_rank/);

    await call('get', path, s.employee.token).expect(403);
    await call('get', path, other.s.owner.token).expect(403);
    await call('get', path, customer.token).expect(403);
    await call('get', path, null).expect(401);
    // The admin ranking stays admin-only.
    await call('get', '/admin/sales-rank', s.owner.token).expect(403);
  });
});
