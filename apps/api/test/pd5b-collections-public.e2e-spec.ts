import { execFileSync } from 'child_process';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { API_ROOT } from './helpers/seed-demo-db';
import {
  createDisposableDatabase,
  dropDisposableDatabase,
} from './helpers/test-databases';

// PD-5b.2: the public read of platform collections - live only (published
// and inside the window), each product only while a shopper can buy it
// now for their zone (the shared FulfilmentEligibilityService rule),
// merged products through their survivor (once), placements' limits and
// threshold, and no operational data.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('PD-5b.2 platform collections public read (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  // TB-13: placements rank EVERY live collection in the database, and this
  // file clears them before each test - on the shared database that archived
  // other files' collections mid-test (PD-5b.1's reopen answered 200) and let
  // their collections into this file's home list. It runs on a database of
  // its own (created marked, dropped after its marker is checked).
  const sharedUrl = process.env.DATABASE_URL!;
  const dbName = `finalpro_pd5bpublic_test_${process.pid}`;

  beforeAll(async () => {
    const url = await createDisposableDatabase(sharedUrl, dbName);
    execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        'prisma7.config.ts',
      ],
      {
        cwd: API_ROOT,
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
      },
    );
    process.env.DATABASE_URL = url;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = sharedUrl;
    await dropDisposableDatabase(sharedUrl, dbName);
  });

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
    // Placements rank every live collection in the database: start clean
    // (this file's own database - see above).
    await prisma.platformCollection.updateMany({
      where: { status: 'PUBLISHED' },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const call = (
    method: 'get' | 'post' | 'put',
    url: string,
    token: string | null,
  ) => {
    let r = request(app.getHttpServer())[method](`/api/v1${url}`);
    if (method !== 'get') r = r.set('Idempotency-Key', unique('idem'));
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  async function account(platformRole?: 'PLATFORM_ADMIN') {
    const phone = `+993${Date.now()}${(counter += 1)}`;
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'x',
        phoneVerifiedAt: new Date(),
        platformRole,
      },
    });
    await prisma.customerProfile.create({ data: { userId: user.id } });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { token, userId: user.id };
  }

  /** A sellable store: a physical shop and an online-only branch that delivers to WEST_BANK tomorrow. */
  async function store() {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('col-store').toLowerCase(),
        legalName: unique('L'),
        displayName: 'متجر',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    const shop = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('محل'),
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
    const online = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('مستودع'),
        isPhysical: false,
        verificationStatus: 'APPROVED',
      },
    });
    const weekday = new Date(
      `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hebron' }).format(new Date(Date.now() + 86_400_000))}T00:00:00Z`,
    ).getUTCDay();
    await prisma.deliveryWindow.create({
      data: {
        vendorId: vendor.id,
        branchId: online.id,
        dayOfWeek: weekday,
        startMinute: 720,
        endMinute: 840,
        capacity: 5,
      },
    });
    await prisma.vendorDeliveryZone.create({
      data: {
        vendorId: vendor.id,
        region: 'WEST_BANK',
        enabled: true,
        fee: 10,
      },
    });
    return { vendor, shop, online };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  /** A canonical product sold by `s` (confirmed match), stocked at the shop, the online branch, or nowhere. */
  async function product(
    s: Store,
    opts: {
      at?: 'shop' | 'online' | null;
      offer?: 'ACTIVE' | 'INACTIVE';
      status?: 'PUBLISHED' | 'DRAFT';
    } = {},
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
        status: opts.status ?? 'PUBLISHED',
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
        status: opts.offer ?? 'ACTIVE',
        canonicalProductId: p.id,
      },
    });
    const v = await prisma.offerVariant.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: o.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 75,
        canonicalVariantId: cv.id,
      },
    });
    const at = opts.at === undefined ? 'shop' : opts.at;
    if (at) {
      await prisma.branchStock.create({
        data: {
          vendorId: s.vendor.id,
          branchId: at === 'shop' ? s.shop.id : s.online.id,
          offerVariantId: v.id,
          quantity: 6,
        },
      });
    }
    return p.id;
  }

  async function collection(
    admin: { token: string },
    productIds: string[],
    extra: Record<string, unknown> = {},
    publish = true,
  ) {
    const c = await call('post', '/admin/collections', admin.token)
      .send({
        slug: unique('c').toLowerCase(),
        title_ar: 'مختارات',
        title_en: 'Picks',
        ...extra,
      })
      .expect(201);
    await call('put', `/admin/collections/${c.body.id}/items`, admin.token)
      .send({ canonical_product_ids: productIds })
      .expect(200);
    if (publish)
      await call(
        'post',
        `/admin/collections/${c.body.id}/publish`,
        admin.token,
      ).expect(200);
    return c.body as { id: string; slug: string };
  }

  const ids = (body: { products: { canonical_product_id: string }[] }) =>
    body.products.map((p) => p.canonical_product_id);

  it('a live collection shows only products a shopper can buy now, in the admin order, through merges, with no operational data', async () => {
    const admin = await account('PLATFORM_ADMIN');
    const s = await store();
    const ok1 = await product(s);
    const ok2 = await product(s);
    const inactive = await product(s, { offer: 'INACTIVE' });
    const soldOut = await product(s, { at: null });
    const draftProduct = await product(s, { status: 'DRAFT' });
    const survivor = await product(s);
    const loser = await product(s);
    const c = await collection(admin, [
      ok2,
      inactive,
      loser,
      soldOut,
      ok1,
      draftProduct,
      survivor,
    ]);
    // After it was built, `loser` is merged into `survivor` (already listed).
    await prisma.canonicalProduct.update({
      where: { id: loser },
      data: { status: 'MERGED', mergedIntoId: survivor },
    });

    const res = await call('get', `/collections/${c.slug}`, null).expect(200);
    // loser -> survivor at loser's position, and survivor's own entry is not repeated.
    expect(ids(res.body)).toEqual([ok2, survivor, ok1]);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'audience',
        'description_ar',
        'description_en',
        'fulfilment_context',
        'products',
        'slug',
        'title_ar',
        'title_en',
      ].sort(),
    );
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(
      /"(status|sort_order|sortOrder|live|createdById|published_at|publish_from|publish_until|quantity|branch\w*|stock\w*|available)":/,
    );
    // The standard discovery card.
    expect(res.body.products[0]).toMatchObject({
      canonical_product_id: ok2,
      store_count: 1,
    });

    // An archived product is hidden too.
    await prisma.canonicalProduct.update({
      where: { id: ok1 },
      data: { status: 'ARCHIVED' },
    });
    expect(
      ids((await call('get', `/collections/${c.slug}`, null).expect(200)).body),
    ).toEqual([ok2, survivor]);
    // A store that can't sell (suspended / subscription inactive): its products go.
    await prisma.vendor.update({
      where: { id: s.vendor.id },
      data: { subscriptionStatus: 'EXPIRED' },
    });
    expect(
      (await call('get', `/collections/${c.slug}`, null).expect(200)).body
        .products,
    ).toEqual([]);
    await prisma.vendor.update({
      where: { id: s.vendor.id },
      data: { subscriptionStatus: 'ACTIVE', status: 'SUSPENDED' },
    });
    expect(
      (await call('get', `/collections/${c.slug}`, null).expect(200)).body
        .products,
    ).toEqual([]);
  });

  it('only live collections exist publicly: draft, scheduled, expired and archived ones are not found', async () => {
    const admin = await account('PLATFORM_ADMIN');
    const s = await store();
    const p = await product(s);
    const draft = await collection(admin, [p], {}, false);
    await call('get', `/collections/${draft.slug}`, null).expect(404);
    const later = await collection(admin, [p], {
      publish_from: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await call('get', `/collections/${later.slug}`, null).expect(404);
    const live = await collection(admin, [p], {
      publish_until: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await call('get', `/collections/${live.slug}`, null).expect(200);
    // The window closes -> gone; archived -> gone; reopened (a draft) -> gone.
    await prisma.platformCollection.update({
      where: { id: live.id },
      data: {
        publishFrom: new Date(Date.now() - 2 * 86_400_000),
        publishUntil: new Date(Date.now() - 1000),
      },
    });
    await call('get', `/collections/${live.slug}`, null).expect(404);
    const archived = await collection(admin, [p]);
    await call(
      'post',
      `/admin/collections/${archived.id}/archive`,
      admin.token,
    ).expect(200);
    await call('get', `/collections/${archived.slug}`, null).expect(404);
    await call(
      'post',
      `/admin/collections/${archived.id}/reopen`,
      admin.token,
    ).expect(200);
    await call('get', `/collections/${archived.slug}`, null).expect(404);
    await call('get', '/collections/no-such-collection', null).expect(404);
  });

  it("the shopper's zone decides delivery-only products: request zone, default address, or none", async () => {
    const admin = await account('PLATFORM_ADMIN');
    const s = await store();
    const inShop = await product(s);
    const deliveryOnly = await product(s, { at: 'online' });
    const c = await collection(admin, [deliveryOnly, inShop]);
    const at = async (query: string, token: string | null = null) =>
      ids(
        (await call('get', `/collections/${c.slug}${query}`, token).expect(200))
          .body,
      );
    expect(await at('')).toEqual([deliveryOnly, inShop]);
    expect(await at('?zone=WEST_BANK')).toEqual([deliveryOnly, inShop]);
    expect(await at('?zone=INSIDE')).toEqual([inShop]);
    const shopper = await account();
    await call('post', '/customers/me/addresses', shopper.token)
      .send({
        lat: 31.8,
        lng: 35.2,
        phone_number_1: '+970591111111',
        zone: 'INSIDE',
      })
      .expect(201);
    expect(await at('', shopper.token)).toEqual([inShop]);
    expect(await at('?zone=WEST_BANK', shopper.token)).toEqual([
      deliveryOnly,
      inShop,
    ]);
    // The applied zone, as the product page reports it (PD-2).
    const context = async (query: string, token: string | null = null) =>
      (await call('get', `/collections/${c.slug}${query}`, token).expect(200))
        .body.fulfilment_context;
    expect(await context('')).toEqual({
      zone: null,
      zone_source: 'NONE',
      default_zone: null,
    });
    expect(await context('', shopper.token)).toEqual({
      zone: 'INSIDE',
      zone_source: 'DEFAULT_ADDRESS',
      default_zone: 'INSIDE',
    });
    expect(await context('?zone=ALL', shopper.token)).toEqual({
      zone: null,
      zone_source: 'REQUEST',
      default_zone: 'INSIDE',
    });
    await call('get', `/collections/${c.slug}?zone=MARS`, null).expect(400);
  });

  it('placements: home shows up to 2 with show_on_home, a department up to 1, each needs 4 eligible products and previews 4', async () => {
    const admin = await account('PLATFORM_ADMIN');
    const s = await store();
    const five: string[] = [];
    for (let i = 0; i < 5; i++) five.push(await product(s));
    const three = five.slice(0, 3);
    const soldOut = await product(s, { at: null });

    const tooFew = await collection(admin, [...three, soldOut], {
      show_on_home: true,
    });
    const first = await collection(admin, five, {
      show_on_home: true,
      audience: 'WOMEN',
    });
    const second = await collection(admin, five.slice(0, 4), {
      show_on_home: true,
    });
    const third = await collection(admin, five, { show_on_home: true });
    const notHome = await collection(admin, five);
    await collection(admin, five, { show_on_home: true }, false); // a draft

    const home = await call('get', '/collections?placement=HOME', null).expect(
      200,
    );
    expect(home.body.items.map((c: { slug: string }) => c.slug)).toEqual([
      first.slug,
      second.slug,
    ]);
    expect(home.body.items[0].products).toHaveLength(4);
    expect(
      home.body.items[0].products.map(
        (p: { canonical_product_id: string }) => p.canonical_product_id,
      ),
    ).toEqual(five.slice(0, 4));
    expect(JSON.stringify(home.body)).not.toMatch(
      /"(status|sort_order|live|count|total)":/,
    );
    void tooFew;
    void third;
    void notHome;

    // The admin's order decides which two.
    const all = (
      await call('get', '/admin/collections', admin.token).expect(200)
    ).body.map((c: { id: string }) => c.id);
    const reordered = [
      third.id,
      ...all.filter((id: string) => id !== third.id),
    ];
    await call('put', '/admin/collections/order', admin.token)
      .send({ collection_ids: reordered })
      .expect(200);
    expect(
      (
        await call('get', '/collections?placement=HOME', null).expect(200)
      ).body.items.map((c: { slug: string }) => c.slug),
    ).toEqual([third.slug, first.slug]);

    const women = await call(
      'get',
      '/collections?placement=AUDIENCE&audience=WOMEN',
      null,
    ).expect(200);
    expect(women.body.items.map((c: { slug: string }) => c.slug)).toEqual([
      first.slug,
    ]);
    expect(
      (
        await call(
          'get',
          '/collections?placement=AUDIENCE&audience=MEN',
          null,
        ).expect(200)
      ).body.items,
    ).toEqual([]);
    // Below the threshold for this zone -> not placed (here: nothing qualifies).
    await prisma.branchStock.updateMany({
      where: { vendorId: s.vendor.id },
      data: { quantity: 0 },
    });
    expect(
      (await call('get', '/collections?placement=HOME', null).expect(200)).body
        .items,
    ).toEqual([]);

    await call('get', '/collections', null).expect(400);
    await call('get', '/collections?placement=SIDEBAR', null).expect(400);
    expect(
      (await call('get', '/collections?placement=AUDIENCE', null).expect(400))
        .body.error.code,
    ).toBe('AUDIENCE_REQUIRED');
    await call(
      'get',
      '/collections?placement=AUDIENCE&audience=PETS',
      null,
    ).expect(400);
  });
});
