import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { DeliveryZoneRegion } from '../generated/prisma/client';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// /compare/:id compares STORES: GET /canonical-products/:id/store-comparison
// returns one row per store (never per colour/size variant), with that
// store's best offer for the filters - colour AND size on the same
// variant - and the delivery zone defaulting to the customer's own
// default address.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Store comparison (e2e)', () => {
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

  async function customer(zone: DeliveryZoneRegion | null) {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: 'not-used', phoneVerifiedAt: new Date() },
    });
    const profile = await prisma.customerProfile.create({
      data: { userId: user.id },
    });
    if (zone) {
      await prisma.address.create({
        data: {
          customerId: profile.id,
          lat: 31.9,
          lng: 35.2,
          phoneNumber1: phone,
          zone,
          isDefault: true,
        },
      });
    }
    return app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
  }

  async function store(o: {
    physical: boolean;
    storeType: 'PHYSICAL' | 'ONLINE_ONLY';
    zones: [DeliveryZoneRegion, number][];
    returns?: boolean;
    published?: boolean;
  }) {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('cmp-store'),
        legalName: unique('Legal'),
        displayName: unique('متجر'),
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: o.published ?? true,
        storeType: o.storeType,
        returnsEnabled: o.returns ?? false,
        returnMode: o.returns ? 'BOTH' : 'NO_RETURN',
        returnWindowDays: o.returns ? 14 : null,
      },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('فرع'),
        isPhysical: o.physical,
        verificationStatus: 'APPROVED',
      },
    });
    // Delivery is only offered with an upcoming slot (PD-2).
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
      await prisma.deliveryWindow.create({
        data: {
          vendorId: vendor.id,
          branchId: branch.id,
          dayOfWeek,
          startMinute: 600,
          endMinute: 720,
          capacity: 5,
        },
      });
    }
    for (const [region, fee] of o.zones) {
      await prisma.vendorDeliveryZone.create({
        data: { vendorId: vendor.id, region, enabled: true, fee },
      });
    }
    return { vendor, branch };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  /** One classified offer in `s` of `productId` with these combinations. */
  async function offer(
    s: Store,
    productId: string,
    combos: {
      color: string;
      size: string;
      qty: number;
      price: number;
      sale?: number;
    }[],
  ) {
    const o = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendor.id,
        titleAr: 'قميص',
        titleEn: 'Shirt',
        status: 'DRAFT',
        taxonomyVersion: 1,
        requiresTaxonomy: true,
      },
    });
    await prisma.vendorOfferAudience.create({
      data: { vendorId: s.vendor.id, vendorOfferId: o.id, audience: 'MEN' },
    });
    await prisma.vendorOfferCategory.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: o.id,
        categoryCode: 'SHIRTS',
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
          basePrice: c.price,
          salePrice: c.sale ?? null,
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
          quantity: c.qty,
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

  /**
   *   A: black/M 100 + white/L 90 (physical, WEST_BANK fee 15, returns)
   *   B: white/M 120 -> sale 110 (online-only, JERUSALEM free delivery)
   *   C: white/M 95 but sold out (physical, WEST_BANK fee 20)
   *   D: unpublished, white/M 50 - never shown
   */
  async function world() {
    const brand = await prisma.brand.create({
      data: { name: unique('Brand'), normalizedName: unique('b') },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('C') },
    });
    const product = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('M'),
        canonicalNameAr: 'قميص',
        canonicalNameEn: 'Shirt',
        status: 'PUBLISHED',
        warrantyPeriod: '6 أشهر',
      },
    });
    const a = await store({
      physical: true,
      storeType: 'PHYSICAL',
      zones: [['WEST_BANK', 15]],
      returns: true,
    });
    const b = await store({
      physical: false,
      storeType: 'ONLINE_ONLY',
      zones: [['JERUSALEM', 0]],
    });
    const c = await store({
      physical: true,
      storeType: 'PHYSICAL',
      zones: [['WEST_BANK', 20]],
    });
    const d = await store({
      physical: true,
      storeType: 'PHYSICAL',
      zones: [['WEST_BANK', 5]],
      published: false,
    });
    // Prices are offer-level (S27), so A's two prices are two offers.
    const a1 = await offer(a, product.id, [
      { color: 'BLACK', size: 'M', qty: 3, price: 100 },
    ]);
    const a2 = await offer(a, product.id, [
      { color: 'WHITE', size: 'L', qty: 2, price: 90 },
    ]);
    const oa = {
      ids: { ...a1.ids, ...a2.ids },
      offerByVariant: { 'BLACK/M': a1.offerId, 'WHITE/L': a2.offerId },
    };
    const ob = await offer(b, product.id, [
      { color: 'WHITE', size: 'M', qty: 4, price: 120, sale: 110 },
    ]);
    const oc = await offer(c, product.id, [
      { color: 'WHITE', size: 'M', qty: 0, price: 95 },
    ]);
    await offer(d, product.id, [
      { color: 'WHITE', size: 'M', qty: 9, price: 50 },
    ]);
    return { product, a, b, c, d, oa, ob, oc };
  }

  const compare = (
    id: string,
    query: Record<string, string> = {},
    token?: string,
  ) => {
    const r = request(http())
      .get(`/api/v1/canonical-products/${id}/store-comparison`)
      .query(query);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  const slugs = (body: { stores: { vendor_slug: string }[] }) =>
    body.stores.map((s) => s.vendor_slug).sort();

  it('1/8. each store once, however many variants; logos and cards never repeat', async () => {
    const w = await world();
    const res = await compare(w.product.id).expect(200);
    expect(res.body.store_count).toBe(3);
    expect(slugs(res.body)).toEqual(
      [w.a.vendor.slug, w.b.vendor.slug, w.c.vendor.slug].sort(),
    );
    expect(
      new Set(res.body.stores.map((s: { vendor_id: string }) => s.vendor_id))
        .size,
    ).toBe(3);
    expect(JSON.stringify(res.body)).not.toContain(w.d.vendor.slug);
    const a = res.body.stores.find(
      (s: { vendor_slug: string }) => s.vendor_slug === w.a.vendor.slug,
    );
    // Without colour/size: the store's cheapest offer in stock, with its own info.
    expect(a).toMatchObject({
      offer_variant_id: w.oa.ids['WHITE/L'],
      offer_id: w.oa.offerByVariant['WHITE/L'],
      price: '90.00',
      color: 'WHITE',
      size: 'L',
      matching_variant_count: 2,
    });
    expect(a.colors.sort()).toEqual(['BLACK', 'WHITE']);
    expect(a.returns).toEqual({ mode: 'BOTH', window_days: 14 });
    expect(a.warranty_period).toBe('6 أشهر');
    // Options: only what this product really has, across every store.
    expect(
      res.body.filter_options.colors
        .map((c: { code: string }) => c.code)
        .sort(),
    ).toEqual(['BLACK', 'WHITE']);
    expect(
      res.body.filter_options.sizes.map((s: { code: string }) => s.code),
    ).toEqual(['M', 'L']);
    // Cheapest available first, the sold-out store last.
    expect(res.body.stores[0].vendor_slug).toBe(w.a.vendor.slug);
    expect(res.body.stores[0].is_cheapest).toBe(true);
    expect(res.body.stores.at(-1).vendor_slug).toBe(w.c.vendor.slug);
    expect(res.body.lowest_price).toBe('90.00');
  });

  it('2/3. colour and size must be one variant together; the chosen offer and its link follow the filters', async () => {
    const w = await world();
    // A has black/M and white/L - never white/M.
    const whiteM = await compare(w.product.id, {
      color: 'WHITE',
      size: 'M',
    }).expect(200);
    expect(slugs(whiteM.body)).toEqual(
      [w.b.vendor.slug, w.c.vendor.slug].sort(),
    );
    const black = await compare(w.product.id, { color: 'BLACK' }).expect(200);
    expect(slugs(black.body)).toEqual([w.a.vendor.slug]);
    expect(black.body.stores[0]).toMatchObject({
      offer_variant_id: w.oa.ids['BLACK/M'],
      offer_id: w.oa.offerByVariant['BLACK/M'],
      price: '100.00',
    });
    expect(black.body.lowest_price).toBe('100.00');
    const sizeM = await compare(w.product.id, {
      size: 'M',
      available_only: 'true',
    }).expect(200);
    expect(slugs(sizeM.body)).toEqual(
      [w.a.vendor.slug, w.b.vendor.slug].sort(),
    );
    expect(
      sizeM.body.stores.find(
        (s: { vendor_slug: string }) => s.vendor_slug === w.a.vendor.slug,
      ).offer_variant_id,
    ).toBe(w.oa.ids['BLACK/M']);
    const none = await compare(w.product.id, { color: 'RED' }).expect(200);
    expect(none.body).toMatchObject({
      store_count: 0,
      stores: [],
      lowest_price: null,
    });
  });

  it('4-6. the zone defaults to the default address, none without one, and a choice overrides it', async () => {
    const w = await world();
    const westBank = await customer('WEST_BANK');
    const def = await compare(w.product.id, {}, westBank).expect(200);
    expect(def.body.applied).toMatchObject({
      zone: 'WEST_BANK',
      zone_source: 'DEFAULT_ADDRESS',
      default_zone: 'WEST_BANK',
    });
    expect(slugs(def.body)).toEqual([w.a.vendor.slug, w.c.vendor.slug].sort());
    expect(
      def.body.stores.find(
        (s: { vendor_slug: string }) => s.vendor_slug === w.a.vendor.slug,
      ).delivery,
    ).toMatchObject({ zone: 'WEST_BANK', fee: 15, status: 'AVAILABLE' });

    const noAddress = await customer(null);
    const plain = await compare(w.product.id, {}, noAddress).expect(200);
    expect(plain.body.applied).toMatchObject({
      zone: null,
      zone_source: 'NONE',
      default_zone: null,
    });
    expect(plain.body.store_count).toBe(3);
    // Guests and stale tokens: no default, never a 401.
    expect(
      (await compare(w.product.id).expect(200)).body.applied.zone_source,
    ).toBe('NONE');
    expect(
      (await compare(w.product.id, {}, 'stale-token').expect(200)).body
        .store_count,
    ).toBe(3);

    const jerusalem = await compare(
      w.product.id,
      { zone: 'JERUSALEM' },
      westBank,
    ).expect(200);
    expect(jerusalem.body.applied).toMatchObject({
      zone: 'JERUSALEM',
      zone_source: 'REQUEST',
      default_zone: 'WEST_BANK',
    });
    expect(slugs(jerusalem.body)).toEqual([w.b.vendor.slug]);
    const all = await compare(w.product.id, { zone: 'all' }, westBank).expect(
      200,
    );
    expect(all.body.applied.zone).toBeNull();
    expect(all.body.store_count).toBe(3);
  });

  it('7. delivery / pickup / availability / discount / free delivery / verified / returns', async () => {
    const w = await world();
    const pickup = await compare(w.product.id, { fulfilment: 'PICKUP' }).expect(
      200,
    );
    // B has no physical branch; C's only variant is sold out.
    expect(slugs(pickup.body)).toEqual([w.a.vendor.slug]);
    expect(pickup.body.stores[0].pickup.available).toBe(true);
    expect(pickup.body.stores[0].pickup.branches).toHaveLength(1);
    expect(
      (await compare(w.product.id, { fulfilment: 'DELIVERY' }).expect(200)).body
        .store_count,
    ).toBe(3);
    expect(
      slugs(
        (await compare(w.product.id, { available_only: 'true' }).expect(200))
          .body,
      ),
    ).toEqual([w.a.vendor.slug, w.b.vendor.slug].sort());
    const sale = await compare(w.product.id, {
      discounted_only: 'true',
    }).expect(200);
    expect(slugs(sale.body)).toEqual([w.b.vendor.slug]);
    expect(sale.body.stores[0]).toMatchObject({
      price: '110.00',
      original_price: '120.00',
      is_discounted: true,
    });
    expect(
      slugs(
        (
          await compare(w.product.id, { free_delivery_only: 'true' }).expect(
            200,
          )
        ).body,
      ),
    ).toEqual([w.b.vendor.slug]);
    expect(
      slugs(
        (await compare(w.product.id, { verified_only: 'true' }).expect(200))
          .body,
      ),
    ).toEqual([w.a.vendor.slug, w.c.vendor.slug].sort());
    expect(
      slugs(
        (await compare(w.product.id, { returns_only: 'true' }).expect(200))
          .body,
      ),
    ).toEqual([w.a.vendor.slug]);
    const price = await compare(w.product.id, {
      min_price: '95',
      max_price: '105',
    }).expect(200);
    expect(slugs(price.body)).toEqual(
      [w.a.vendor.slug, w.c.vendor.slug].sort(),
    );
    expect(
      price.body.stores.find(
        (s: { vendor_slug: string }) => s.vendor_slug === w.a.vendor.slug,
      ).offer_variant_id,
    ).toBe(w.oa.ids['BLACK/M']);
    const flags = (await compare(w.product.id).expect(200)).body.filter_options;
    expect(flags).toMatchObject({
      has_discount: true,
      has_free_delivery: true,
      has_verified: true,
      has_returns: true,
      has_pickup: true,
    });
    // Everything stacks.
    const stacked = await compare(w.product.id, {
      color: 'WHITE',
      size: 'M',
      zone: 'WEST_BANK',
      available_only: 'true',
    }).expect(200);
    expect(stacked.body.store_count).toBe(0);
  });

  it('refuses bad filter values', async () => {
    const w = await world();
    for (const [query, code] of [
      [{ zone: 'GAZA' }, 'INVALID_ZONE'],
      [{ fulfilment: 'DRONE' }, 'INVALID_FULFILMENT'],
      [{ available_only: 'yes' }, 'INVALID_AVAILABLE_ONLY'],
      [{ min_price: '50', max_price: '10' }, 'INVALID_PRICE_FILTER'],
    ] as const) {
      const res = await compare(
        w.product.id,
        query as Record<string, string>,
      ).expect(400);
      expect(res.body.error.code).toBe(code);
    }
    await request(http())
      .get(
        '/api/v1/canonical-products/00000000-0000-0000-0000-000000000000/store-comparison',
      )
      .expect(404);
  });
});
