import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { DeliveryZoneRegion } from '../generated/prisma/client';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { CURRENT_PLATFORM_TERMS_VERSION } from './../src/checkout/checkout.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// PD-2 (docs/srs/10-product-detail-enhancement-roadmap.md, PD-FR-004):
// the product page's delivery/pickup facts, every public availability and
// the cart come from ONE server-side source that agrees with checkout's
// quote and reserve - for every branch state, zone and variant.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}
const DAY = 86_400_000;

describe('PD-2 fulfilment facts = checkout (e2e)', () => {
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

  async function customer(zone: DeliveryZoneRegion | null = null) {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: 'not-used', phoneVerifiedAt: new Date() },
    });
    const profile = await prisma.customerProfile.create({
      data: { userId: user.id },
    });
    const address = zone
      ? await prisma.address.create({
          data: {
            customerId: profile.id,
            lat: 31.9,
            lng: 35.2,
            phoneNumber1: phone,
            zone,
            isDefault: true,
          },
        })
      : null;
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { token, addressId: address?.id ?? null };
  }

  /**
   * One store, every branch state:
   *   main      physical, approved, delivery windows  - X=2, Y=0
   *   pending   physical, NOT approved                - Y=5
   *   archived  physical, approved, archived          - Y=5
   *   closed    physical, approved, closure right now  - Z=3
   *   warehouse NOT physical, approved, windows       - W=4  (delivery only)
   *   shop      physical, approved, NO windows        - P=3  (pickup only)
   * Zones: WEST_BANK 15, JERUSALEM free, INSIDE disabled.
   */
  async function world(subscription: 'ACTIVE' | 'EXPIRED' = 'ACTIVE') {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('pd2-store'),
        legalName: unique('Legal'),
        displayName: 'متجر الحقائق',
        status: 'ACTIVE',
        subscriptionStatus: subscription,
        storefrontPublished: true,
      },
    });
    const branch = (name: string, extra: object = {}) =>
      prisma.storeBranch.create({
        data: {
          vendorId: vendor.id,
          name,
          isPhysical: true,
          verificationStatus: 'APPROVED',
          ...extra,
        },
      });
    const main = await branch('الفرع الرئيسي');
    const pending = await branch('فرع قيد الاعتماد', {
      verificationStatus: 'PENDING',
    });
    const archived = await branch('فرع مؤرشف', { archivedAt: new Date() });
    const closed = await branch('فرع مغلق مؤقتاً');
    const warehouse = await branch('المستودع', { isPhysical: false });
    const shop = await branch('محل بلا توصيل');
    const closer = await prisma.user.create({
      data: {
        phone: uniqueTestPhone(),
        passwordHash: 'not-used',
      },
    });
    await prisma.branchClosure.create({
      data: {
        vendorId: vendor.id,
        branchId: closed.id,
        startsAt: new Date(Date.now() - DAY),
        endsAt: new Date(Date.now() + DAY),
        reason: 'جرد',
        createdBy: closer.id,
      },
    });
    for (const b of [main, warehouse]) {
      for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
        await prisma.deliveryWindow.create({
          data: {
            vendorId: vendor.id,
            branchId: b.id,
            dayOfWeek,
            startMinute: 600,
            endMinute: 720,
            capacity: 5,
          },
        });
      }
    }
    await prisma.vendorDeliveryZone.createMany({
      data: [
        { vendorId: vendor.id, region: 'WEST_BANK', enabled: true, fee: 15 },
        { vendorId: vendor.id, region: 'JERUSALEM', enabled: true, fee: 0 },
        { vendorId: vendor.id, region: 'INSIDE', enabled: false, fee: 30 },
      ],
    });
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: vendor.id,
        titleAr: 'منتج',
        titleEn: 'Product',
        status: 'ACTIVE',
      },
    });
    const variant = async (stocks: [{ id: string }, number][]) => {
      const v = await prisma.offerVariant.create({
        data: {
          vendorId: vendor.id,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          storeInventoryBarcode: unique('sib'),
          basePrice: 40,
        },
      });
      for (const [b, quantity] of stocks) {
        await prisma.branchStock.create({
          data: {
            vendorId: vendor.id,
            branchId: b.id,
            offerVariantId: v.id,
            quantity,
          },
        });
      }
      return v.id;
    };
    const v = {
      X: await variant([[main, 2]]),
      Y: await variant([
        [main, 0],
        [pending, 5],
        [archived, 5],
      ]),
      Z: await variant([[closed, 3]]),
      W: await variant([[warehouse, 4]]),
      P: await variant([[shop, 3]]),
    };
    return {
      vendor,
      offer,
      v,
      branches: { main, pending, archived, closed, warehouse, shop },
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const detail = (
    w: World,
    query: Record<string, string> = {},
    token?: string,
  ) => {
    const r = request(http())
      .get(`/api/v1/storefronts/${w.vendor.slug}/offers/${w.offer.id}`)
      .query(query);
    return (token ? r.set('Authorization', `Bearer ${token}`) : r).expect(200);
  };
  const factsOf = (
    body: { variants: { id: string; fulfilment: unknown }[] },
    id: string,
  ) =>
    body.variants.find((x) => x.id === id)!.fulfilment as {
      availability: string;
      delivery: {
        status: string;
        fee: number | null;
        earliest_slot_date: string | null;
      };
      pickup: { status: string; branches: { name: string }[] };
    };

  async function quoteOne(
    w: World,
    who: { token: string; addressId: string | null },
    variantId: string,
  ) {
    const added = await request(http())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${who.token}`)
      .set('Idempotency-Key', unique('cart'))
      .send({
        vendor_id: w.vendor.id,
        offer_variant_id: variantId,
        quantity: 1,
      })
      .expect(201);
    const quote = await request(http())
      .post('/api/v1/checkout/quote')
      .set('Authorization', `Bearer ${who.token}`)
      .send({
        cart_item_ids: [added.body.id],
        ...(who.addressId ? { address_id: who.addressId } : {}),
      })
      .expect(201);
    await request(http())
      .delete(`/api/v1/cart/items/${added.body.id}`)
      .set('Authorization', `Bearer ${who.token}`);
    return { cartItemId: added.body.id as string, quote: quote.body };
  }

  it('the product page matches checkout quote for every variant and branch state', async () => {
    const w = await world();
    const shopper = await customer('WEST_BANK');
    const page = (await detail(w, {}, shopper.token)).body;
    expect(page.fulfilment_context).toMatchObject({
      zone: 'WEST_BANK',
      zone_source: 'DEFAULT_ADDRESS',
    });
    expect(page.purchasable).toBe(true);
    expect(page.delivery_zones).toEqual([
      { region: 'WEST_BANK', fee: 15 },
      { region: 'JERUSALEM', fee: 0 },
    ]);

    const expected: Record<
      string,
      { availability: string; delivery: string; pickup: string[] }
    > = {
      X: {
        availability: 'low_stock',
        delivery: 'AVAILABLE',
        pickup: ['الفرع الرئيسي'],
      },
      Y: {
        availability: 'sold_out',
        delivery: 'NO_ELIGIBLE_STOCK',
        pickup: [],
      }, // pending/archived stock never counts
      Z: {
        availability: 'sold_out',
        delivery: 'NO_ELIGIBLE_STOCK',
        pickup: [],
      }, // closed right now
      W: { availability: 'available', delivery: 'AVAILABLE', pickup: [] }, // delivery only
      P: {
        availability: 'low_stock',
        delivery: 'NO_UPCOMING_SLOTS',
        pickup: ['محل بلا توصيل'],
      }, // pickup only
    };
    for (const [key, want] of Object.entries(expected)) {
      const id = w.v[key as keyof typeof w.v];
      const f = factsOf(page, id);
      expect({
        key,
        availability: f.availability,
        delivery: f.delivery.status,
        pickup: f.pickup.branches.map((b) => b.name),
      }).toEqual({
        key,
        availability: want.availability,
        delivery: want.delivery,
        pickup: want.pickup,
      });

      // Checkout's own answer for the same variant and address.
      const { quote } = await quoteOne(w, shopper, id);
      const group = quote.groups[0];
      if (want.availability === 'sold_out') {
        expect(quote.unavailable_items).toHaveLength(1);
        expect(quote.groups).toHaveLength(0);
        continue;
      }
      const eligible = group.eligible_branches as {
        branch_name: string;
        is_physical: boolean;
        delivery_fee: number | null;
        blockers: { code: string }[];
        available_slots: unknown[];
      }[];
      // Pickup: exactly the physical branches checkout offers.
      expect(
        eligible
          .filter((b) => b.is_physical)
          .map((b) => b.branch_name)
          .sort(),
      ).toEqual([...want.pickup].sort());
      // Delivery: AVAILABLE only where checkout has a priced zone + a slot.
      const deliverable = eligible.filter(
        (b) =>
          b.delivery_fee !== null &&
          b.available_slots.length > 0 &&
          !b.blockers.some((x) => x.code === 'DELIVERY_NOT_AVAILABLE_IN_ZONE'),
      );
      expect(f.delivery.status === 'AVAILABLE').toBe(deliverable.length > 0);
      if (deliverable.length)
        expect(f.delivery.fee).toBe(deliverable[0].delivery_fee);
    }
  });

  it('reserve agrees: pickup-only refuses delivery, delivery-only refuses pickup, a sold-out branch never sells', async () => {
    const w = await world();
    const shopper = await customer('WEST_BANK');
    const add = async (variantId: string) =>
      (
        await request(http())
          .post('/api/v1/cart/items')
          .set('Authorization', `Bearer ${shopper.token}`)
          .set('Idempotency-Key', unique('cart'))
          .send({
            vendor_id: w.vendor.id,
            offer_variant_id: variantId,
            quantity: 1,
          })
          .expect(201)
      ).body.id as string;
    const reserve = (group: object) =>
      request(http())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${shopper.token}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [group],
          terms_accepted: true,
          terms_version: CURRENT_PLATFORM_TERMS_VERSION,
        });
    const p = await add(w.v.P);
    // P: no delivery window at its branch -> delivery can't be reserved.
    const slotless = await reserve({
      cart_item_ids: [p],
      branch_id: w.branches.shop.id,
      fulfilment_method: 'DELIVERY',
      payment_method: 'COD',
      address_id: shopper.addressId,
    });
    expect(slotless.status).toBe(409);
    const pickup = await reserve({
      cart_item_ids: [p],
      branch_id: w.branches.shop.id,
      fulfilment_method: 'PICKUP',
      payment_method: 'COD',
    });
    expect(pickup.status).toBe(201);
    await request(http())
      .post(
        `/api/v1/checkout/reservations/${pickup.body.reservation_id}/cancel`,
      )
      .set('Authorization', `Bearer ${shopper.token}`)
      .expect(201);
    // W: the warehouse is not physical -> pickup refused.
    const wItem = await add(w.v.W);
    const noPickup = await reserve({
      cart_item_ids: [wItem],
      branch_id: w.branches.warehouse.id,
      fulfilment_method: 'PICKUP',
      payment_method: 'COD',
    });
    expect(noPickup.body.error.code).toBe('PICKUP_REQUIRES_PHYSICAL_BRANCH');
    // Y's pending/archived stock: those branches can't take an order.
    const y = await add(w.v.Y);
    for (const b of [w.branches.pending, w.branches.archived]) {
      const r = await reserve({
        cart_item_ids: [y],
        branch_id: b.id,
        fulfilment_method: 'PICKUP',
        payment_method: 'COD',
      });
      expect(r.body.error.code).toBe('BRANCH_NOT_AVAILABLE_FOR_ORDERS');
    }
  });

  it('zone: default address, none without one, a manual choice or ALL overrides, guests and stale tokens get none', async () => {
    const w = await world();
    const withDefault = await customer('WEST_BANK');
    const without = await customer(null);
    expect(
      (await detail(w, {}, withDefault.token)).body.fulfilment_context,
    ).toEqual({
      zone: 'WEST_BANK',
      zone_source: 'DEFAULT_ADDRESS',
      default_zone: 'WEST_BANK',
    });
    expect(
      (await detail(w, {}, without.token)).body.fulfilment_context,
    ).toEqual({ zone: null, zone_source: 'NONE', default_zone: null });
    expect((await detail(w)).body.fulfilment_context.zone_source).toBe('NONE');
    expect(
      (await detail(w, {}, 'stale')).body.fulfilment_context.zone_source,
    ).toBe('NONE');
    const jerusalem = await detail(w, { zone: 'JERUSALEM' }, withDefault.token);
    expect(jerusalem.body.fulfilment_context).toEqual({
      zone: 'JERUSALEM',
      zone_source: 'REQUEST',
      default_zone: 'WEST_BANK',
    });
    expect(factsOf(jerusalem.body, w.v.X).delivery).toMatchObject({
      status: 'AVAILABLE',
      fee: 0,
    });
    // INSIDE is disabled: never deliverable, whatever its stored fee.
    expect(
      factsOf((await detail(w, { zone: 'INSIDE' })).body, w.v.X).delivery,
    ).toMatchObject({ status: 'NOT_IN_ZONE', fee: null });
    const all = await detail(w, { zone: 'ALL' }, withDefault.token);
    expect(all.body.fulfilment_context.zone).toBeNull();
    const x = factsOf(all.body, w.v.X).delivery;
    expect(x.status).toBe('NO_ZONE_SELECTED');
    expect(x.earliest_slot_date).toMatch(/^\d{4}-\d{2}-\d{2}/);
    const bad = await request(http())
      .get(`/api/v1/storefronts/${w.vendor.slug}/offers/${w.offer.id}`)
      .query({ zone: 'GAZA' })
      .expect(400);
    expect(bad.body.error.code).toBe('INVALID_ZONE');
  });

  it('race: live holds count at once; checkout stays the final word', async () => {
    const w = await world();
    const a = await customer('WEST_BANK');
    const b = await customer('WEST_BANK');
    const addFor = async (who: { token: string }, quantity: number) =>
      (
        await request(http())
          .post('/api/v1/cart/items')
          .set('Authorization', `Bearer ${who.token}`)
          .set('Idempotency-Key', unique('cart'))
          .send({ vendor_id: w.vendor.id, offer_variant_id: w.v.X, quantity })
          .expect(201)
      ).body.id as string;
    const bItem = await addFor(b, 1);
    expect(factsOf((await detail(w)).body, w.v.X).availability).toBe(
      'low_stock',
    );
    // A holds both units.
    const aItem = await addFor(a, 2);
    const held = await request(http())
      .post('/api/v1/checkout/reserve')
      .set('Authorization', `Bearer ${a.token}`)
      .set('Idempotency-Key', unique('reserve'))
      .send({
        groups: [
          {
            cart_item_ids: [aItem],
            branch_id: w.branches.main.id,
            fulfilment_method: 'PICKUP',
            payment_method: 'COD',
          },
        ],
        terms_accepted: true,
        terms_version: CURRENT_PLATFORM_TERMS_VERSION,
      })
      .expect(201);
    // Every surface now says sold out - product page, cart, store catalogue.
    const now = factsOf((await detail(w)).body, w.v.X);
    expect(now).toMatchObject({
      availability: 'sold_out',
      delivery: { status: 'NO_ELIGIBLE_STOCK' },
      pickup: { status: 'NO_PICKUP_BRANCH_WITH_STOCK' },
    });
    const cart = await request(http())
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${b.token}`)
      .expect(200);
    expect(cart.body.find((i: { id: string }) => i.id === bItem)).toMatchObject(
      { availability: 'sold_out', max_quantity: null },
    );
    // B, who saw it available a moment ago, is refused by reserve itself.
    const late = await request(http())
      .post('/api/v1/checkout/reserve')
      .set('Authorization', `Bearer ${b.token}`)
      .set('Idempotency-Key', unique('reserve'))
      .send({
        groups: [
          {
            cart_item_ids: [bItem],
            branch_id: w.branches.main.id,
            fulfilment_method: 'PICKUP',
            payment_method: 'COD',
          },
        ],
        terms_accepted: true,
        terms_version: CURRENT_PLATFORM_TERMS_VERSION,
      });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('INSUFFICIENT_STOCK');
    // Released -> available again everywhere.
    await request(http())
      .post(`/api/v1/checkout/reservations/${held.body.reservation_id}/cancel`)
      .set('Authorization', `Bearer ${a.token}`)
      .expect(201);
    expect(factsOf((await detail(w)).body, w.v.X).availability).toBe(
      'low_stock',
    );
  });

  it('privacy: no quantities, branch ids or internal branch states in the public answer', async () => {
    const w = await world();
    const body = JSON.stringify((await detail(w, { zone: 'WEST_BANK' })).body);
    for (const leaked of [
      'quantity',
      'verification',
      'archived',
      'closure',
      'PENDING',
      w.branches.main.id,
      w.branches.pending.id,
      'فرع قيد الاعتماد',
      'فرع مؤرشف',
      'فرع مغلق مؤقتاً',
    ]) {
      expect(body).not.toContain(leaked);
    }
  });

  it('every public card uses the same availability: store catalogue, sections, comparison card, cart', async () => {
    const w = await world();
    // Match Y (stock only in pending/archived branches) to a canonical product.
    const brand = await prisma.brand.create({
      data: { name: unique('B'), normalizedName: unique('b') },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('ف'), nameEn: unique('C') },
    });
    const product = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('M'),
        canonicalNameAr: 'م',
        canonicalNameEn: 'P',
        status: 'PUBLISHED',
      },
    });
    const cv = await prisma.canonicalProductVariant.create({
      data: {
        canonicalProductId: product.id,
        structuralAttributes: {},
        platformProductBarcode: unique('pb'),
      },
    });
    await prisma.offerVariant.update({
      where: { id: w.v.Y },
      data: { canonicalVariantId: cv.id },
    });
    const card = await request(http())
      .get(`/api/v1/canonical-products/${product.id}/comparison-card`)
      .expect(200);
    expect(card.body.lowest_price_availability).toBe('sold_out');
    const sections = await request(http())
      .get(`/api/v1/storefronts/${w.vendor.slug}/sections`)
      .expect(200);
    // X (2) + W (4) + P (3) sellable; Y and Z never count.
    expect(sections.body.all[0].availability).toBe('available');
    const shopper = await customer();
    const y = await request(http())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${shopper.token}`)
      .set('Idempotency-Key', unique('cart'))
      .send({ vendor_id: w.vendor.id, offer_variant_id: w.v.Y, quantity: 1 })
      .expect(201);
    const cart = await request(http())
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${shopper.token}`)
      .expect(200);
    expect(
      cart.body.find((i: { id: string }) => i.id === y.body.id),
    ).toMatchObject({
      availability: 'sold_out',
      max_quantity: null,
      purchasable: true,
    });
  });

  it('a store whose subscription lapsed shows nothing buyable', async () => {
    const w = await world('EXPIRED');
    const page = (await detail(w)).body;
    expect(page.purchasable).toBe(false);
    for (const id of Object.values(w.v)) {
      expect(factsOf(page, id)).toMatchObject({
        availability: 'sold_out',
        delivery: { status: 'NOT_PURCHASABLE' },
        pickup: { status: 'NOT_PURCHASABLE' },
      });
    }
  });
});
