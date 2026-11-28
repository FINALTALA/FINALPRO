import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { CURRENT_PLATFORM_TERMS_VERSION } from './../src/checkout/checkout.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';
import { OfferModerationService } from './../src/offer-moderation/offer-moderation.service';
import {
  RESERVATION_SWEEP_AUDIT_ACTION,
  ReservationSweepService,
} from './../src/checkout/reservation-sweep.service';

// VIA Control Center phase 2C - Platform Hold (offer moderation), through
// the real HTTP endpoints: who may act, one open hold, every public
// surface, the cart, quote/reserve/confirm, reservation release (stock
// back exactly once), confirmed orders untouched, the owner's correction
// cycle, restore rules, and a hold racing a checkout confirmation.

let seq = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++seq}`;

describe('Phase 2C - Platform Hold (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
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

  afterAll(async () => {
    await app?.close();
  });

  const http = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function account(
    platformRole: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER' | null = null,
  ) {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'x',
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
    return { id: user.id, profileId: profile.id, token };
  }

  /** A live store selling one matched product (discovery, comparison, collections). */
  async function world(stock = 20) {
    const owner = await account();
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('mod').toLowerCase(),
        legalName: unique('متجر'),
        displayName: 'متجر الاختبار',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
        whatsappUrl: 'https://wa.me/970599000000',
      },
    });
    await prisma.vendorUser.create({
      data: { vendorId: vendor.id, userId: owner.id, role: 'OWNER' },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('فرع'),
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
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
        canonicalNameAr: unique('فستان'),
        status: 'PUBLISHED',
      },
    });
    const cv = await prisma.canonicalProductVariant.create({
      data: {
        canonicalProductId: product.id,
        structuralAttributes: { n: unique('v') },
        platformProductBarcode: unique('pb'),
      },
    });
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: vendor.id,
        titleAr: unique('فستان سهرة'),
        titleEn: 'Evening dress',
        status: 'ACTIVE',
        canonicalProductId: product.id,
        firstPublishedAt: new Date(),
      },
    });
    const variant = await prisma.offerVariant.create({
      data: {
        vendorId: vendor.id,
        vendorOfferId: offer.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 100,
        canonicalVariantId: cv.id,
      },
    });
    await prisma.branchStock.create({
      data: {
        vendorId: vendor.id,
        branchId: branch.id,
        offerVariantId: variant.id,
        quantity: stock,
      },
    });
    return { owner, vendor, branch, product, offer, variant };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const stockOf = (w: World) =>
    prisma.branchStock.findFirstOrThrow({
      where: { branchId: w.branch.id, offerVariantId: w.variant.id },
      select: { quantity: true, reservedQuantity: true },
    });

  const place = (
    token: string,
    offerId: string,
    action: 'HIDE' | 'REQUEST_CHANGES',
    reason = 'صور مضللة للمنتج',
  ) =>
    request(http())
      .post(`/api/v1/admin/offers/${offerId}/hold`)
      .set(auth(token))
      .set('Idempotency-Key', unique('hold'))
      .send({ action, reason });

  const restore = (token: string, offerId: string, revision: number) =>
    request(http())
      .post(`/api/v1/admin/offers/${offerId}/hold/restore`)
      .set(auth(token))
      .set('Idempotency-Key', unique('restore'))
      .send({ note: 'تمت المراجعة', offer_revision: revision });

  const revisionOf = async (offerId: string) =>
    (
      await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offerId },
        select: { contentRevision: true },
      })
    ).contentRevision;

  async function addToCart(token: string, w: World, quantity = 1) {
    return request(http())
      .post('/api/v1/cart/items')
      .set(auth(token))
      .set('Idempotency-Key', unique('cart'))
      .send({
        vendor_id: w.vendor.id,
        offer_variant_id: w.variant.id,
        quantity,
      });
  }

  async function reservePickup(token: string, w: World, cartItemId: string) {
    return request(http())
      .post('/api/v1/checkout/reserve')
      .set(auth(token))
      .set('Idempotency-Key', unique('reserve'))
      .send({
        terms_accepted: true,
        terms_version: CURRENT_PLATFORM_TERMS_VERSION,
        groups: [
          {
            cart_item_ids: [cartItemId],
            branch_id: w.branch.id,
            fulfilment_method: 'PICKUP',
            payment_method: 'COD',
          },
        ],
      });
  }

  const confirm = (token: string, reservationId: string) =>
    request(http())
      .post('/api/v1/checkout/confirm')
      .set(auth(token))
      .set('Idempotency-Key', unique('confirm'))
      .send({ reservation_id: reservationId });

  // ------------------------------------------------------------------
  describe('who may moderate', () => {
    it('only a PLATFORM_ADMIN; a reviewer, a customer, the owner and a visitor are refused', async () => {
      const w = await world();
      const reviewer = await account('VERIFICATION_REVIEWER');
      const customer = await account();
      for (const t of [reviewer.token, customer.token, w.owner.token]) {
        expect((await place(t, w.offer.id, 'HIDE')).status).toBe(403);
        expect(
          (
            await request(http())
              .get(`/api/v1/admin/offers/${w.offer.id}`)
              .set(auth(t))
          ).status,
        ).toBe(403);
      }
      expect((await request(http()).get('/api/v1/admin/offers')).status).toBe(
        401,
      );
    });

    it('an admin who is a member of the store is refused (conflict of interest)', async () => {
      const w = await world();
      const admin = await account('PLATFORM_ADMIN');
      await prisma.vendorUser.create({
        data: {
          vendorId: w.vendor.id,
          userId: admin.id,
          role: 'BRANCH_EMPLOYEE',
          branchId: w.branch.id,
        },
      });
      const res = await place(admin.token, w.offer.id, 'HIDE');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLATFORM_VENDOR_CONFLICT_OF_INTEREST');
    });

    it('the reason is required', async () => {
      const w = await world();
      const admin = await account('PLATFORM_ADMIN');
      const res = await place(admin.token, w.offer.id, 'HIDE', ' ');
      expect(res.status).toBe(400);
    });
  });

  // ------------------------------------------------------------------
  describe('one open hold per offer', () => {
    it('two admins at once: exactly one hold opens, the other gets 409', async () => {
      const w = await world();
      const a1 = await account('PLATFORM_ADMIN');
      const a2 = await account('PLATFORM_ADMIN');
      const results = await Promise.all([
        place(a1.token, w.offer.id, 'HIDE'),
        place(a2.token, w.offer.id, 'REQUEST_CHANGES'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await prisma.offerPlatformHold.count({
          where: { vendorOfferId: w.offer.id, releasedAt: null },
        }),
      ).toBe(1);
      const conflict = results.find((r) => r.status === 409)!;
      expect(conflict.body.error.code).toBe('OFFER_ALREADY_HELD');
    });
  });

  // ------------------------------------------------------------------
  describe('public surfaces', () => {
    it('a held offer leaves the store, the product page, discovery, comparison, collections, favourites and its size guide; restore brings it back', async () => {
      const w = await world();
      const admin = await account('PLATFORM_ADMIN');
      const shopper = await account();
      const slug = w.vendor.slug;
      const collection = await request(http())
        .post('/api/v1/admin/collections')
        .set(auth(admin.token))
        .set('Idempotency-Key', unique('idem'))
        .send({
          slug: unique('c').toLowerCase(),
          title_ar: 'مختارات',
          title_en: 'Picks',
        })
        .expect(201);
      await request(http())
        .put(`/api/v1/admin/collections/${collection.body.id}/items`)
        .set(auth(admin.token))
        .set('Idempotency-Key', unique('idem'))
        .send({ canonical_product_ids: [w.product.id] })
        .expect(200);
      await request(http())
        .post(`/api/v1/admin/collections/${collection.body.id}/publish`)
        .set(auth(admin.token))
        .set('Idempotency-Key', unique('idem'))
        .expect(200);
      await request(http())
        .post('/api/v1/favorites')
        .set(auth(shopper.token))
        .set('Idempotency-Key', unique('idem'))
        .send({ target_type: 'OFFER', offer_variant_id: w.variant.id })
        .expect((r) => expect([200, 201]).toContain(r.status));

      const surfaces = async () => {
        const g = (path: string, token?: string) => {
          const r = request(http()).get(`/api/v1${path}`);
          return token ? r.set(auth(token)) : r;
        };
        const [store, products, detail, discovery, comparison, coll, favs] =
          await Promise.all([
            g(`/storefronts/${slug}/sections`),
            g(`/storefronts/${slug}/products`),
            g(`/storefronts/${slug}/offers/${w.offer.id}`),
            g(
              `/discovery/all?q=${encodeURIComponent(w.product.canonicalNameAr)}`,
            ),
            g(`/canonical-products/${w.product.id}/comparison`),
            g(`/collections/${collection.body.slug}`),
            g('/favorites', shopper.token),
          ]);
        const has = (r: request.Response, id: string) =>
          JSON.stringify(r.body).includes(id);
        return {
          store: has(store, w.offer.id),
          products: has(products, w.offer.id),
          detail: detail.status,
          discovery: has(discovery, w.product.id),
          comparison: has(comparison, w.offer.id),
          collection: has(coll, w.product.id),
          favourites: has(favs, w.variant.id),
        };
      };

      expect(await surfaces()).toEqual({
        store: true,
        products: true,
        detail: 200,
        discovery: true,
        comparison: true,
        collection: true,
        favourites: true,
      });

      const held = await place(admin.token, w.offer.id, 'HIDE');
      expect(held.status).toBe(201);
      expect(await surfaces()).toEqual({
        store: false,
        products: false,
        detail: 404,
        discovery: false,
        comparison: false,
        collection: false,
        favourites: false,
      });
      // New favourites and availability alerts are refused too.
      const fav = await request(http())
        .post('/api/v1/favorites')
        .set(auth((await account()).token))
        .set('Idempotency-Key', unique('idem'))
        .send({ target_type: 'OFFER', offer_variant_id: w.variant.id });
      expect(fav.status).toBe(404);
      const size = await request(http()).get(
        `/api/v1/storefronts/${slug}/offers/${w.offer.id}/size-guide`,
      );
      expect(size.status).toBe(404);

      // The hold never touched the owner's status.
      const offer = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: w.offer.id },
      });
      expect(offer.status).toBe('ACTIVE');

      expect(
        (await restore(admin.token, w.offer.id, await revisionOf(w.offer.id)))
          .status,
      ).toBe(201);
      expect(await surfaces()).toEqual({
        store: true,
        products: true,
        detail: 200,
        discovery: true,
        comparison: true,
        collection: true,
        favourites: true,
      });
      // The size-guide read answers again (the 404 above was the hold).
      const sizeAfter = await request(http()).get(
        `/api/v1/storefronts/${slug}/offers/${w.offer.id}/size-guide`,
      );
      expect(sizeAfter.status).toBe(200);
    });
  });

  // ------------------------------------------------------------------
  describe('cart and checkout', () => {
    it('a cart line stays (unavailable, removable), cannot be added to or grown; quote and reserve refuse it', async () => {
      const w = await world();
      const admin = await account('PLATFORM_ADMIN');
      const shopper = await account();
      const line = await addToCart(shopper.token, w, 2);
      expect(line.status).toBe(201);
      await place(admin.token, w.offer.id, 'HIDE').expect(201);

      const cart = await request(http())
        .get('/api/v1/cart')
        .set(auth(shopper.token))
        .expect(200);
      const item = cart.body.find((i: { id: string }) => i.id === line.body.id);
      expect(item).toMatchObject({
        purchasable: false,
        unavailable_reason: 'PLATFORM_HOLD',
      });

      const add = await addToCart((await account()).token, w);
      expect(add.status).toBe(409);
      expect(add.body.error.code).toBe('ITEM_NOT_PURCHASABLE');

      const grow = await request(http())
        .put(`/api/v1/cart/items/${line.body.id}`)
        .set(auth(shopper.token))
        .send({ quantity: 3 });
      expect(grow.status).toBe(409);
      await request(http())
        .put(`/api/v1/cart/items/${line.body.id}`)
        .set(auth(shopper.token))
        .send({ quantity: 1 })
        .expect(200);

      const quote = await request(http())
        .post('/api/v1/checkout/quote')
        .set(auth(shopper.token))
        .send({ cart_item_ids: [line.body.id] });
      expect(quote.status).toBe(409);
      expect(quote.body.error.code).toBe('ITEM_NOT_PURCHASABLE');
      const reserve = await reservePickup(shopper.token, w, line.body.id);
      expect(reserve.status).toBe(409);

      await request(http())
        .delete(`/api/v1/cart/items/${line.body.id}`)
        .set(auth(shopper.token))
        .expect(200);
    });

    it('a hold releases unconfirmed reservations (stock back exactly once); confirming one afterwards fails and orders nothing', async () => {
      const w = await world(10);
      const admin = await account('PLATFORM_ADMIN');
      const shopper = await account();
      const line = await addToCart(shopper.token, w, 2);
      const reserved = await reservePickup(shopper.token, w, line.body.id);
      expect(reserved.status).toBe(201);
      expect(await stockOf(w)).toEqual({ quantity: 10, reservedQuantity: 2 });

      const held = await place(admin.token, w.offer.id, 'HIDE');
      expect(held.status).toBe(201);
      expect(held.body.released_reservations).toBe(1);
      expect(await stockOf(w)).toEqual({ quantity: 10, reservedQuantity: 0 });
      expect(
        await prisma.checkoutReservation.count({
          where: { id: reserved.body.reservation_id },
        }),
      ).toBe(0);
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'checkout.reservation_released_platform_hold',
            entityId: reserved.body.reservation_id,
          },
        }),
      ).toBe(1);

      const late = await confirm(shopper.token, reserved.body.reservation_id);
      expect(late.status).toBe(404);
      expect(
        await prisma.branchOrder.count({ where: { vendorId: w.vendor.id } }),
      ).toBe(0);
      // Nothing was given back twice.
      expect(await stockOf(w)).toEqual({ quantity: 10, reservedQuantity: 0 });
    });

    it('a confirmation waiting on the store lock while a hold commits re-checks, is refused, orders nothing and releases its reservation once', async () => {
      const w = await world(10);
      const admin = await account('PLATFORM_ADMIN');
      const shopper = await account();
      const line = await addToCart(shopper.token, w, 2);
      const reserved = await reservePickup(shopper.token, w, line.body.id);
      expect(reserved.status).toBe(201);

      // A hold in progress: the store row is locked (as placeHold does) and
      // the hold row written, then the confirmation arrives and must wait.
      let confirmRes: request.Response | undefined;
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${w.vendor.id} FOR UPDATE`;
          await tx.offerPlatformHold.create({
            data: {
              vendorId: w.vendor.id,
              vendorOfferId: w.offer.id,
              action: 'HIDE',
              reason: 'مراجعة جارية',
              placedById: admin.id,
            },
          });
          const pending = confirm(
            shopper.token,
            reserved.body.reservation_id,
          ).then((r) => {
            confirmRes = r;
            return r;
          });
          void pending;
          await new Promise((r) => setTimeout(r, 1200));
          expect(confirmRes).toBeUndefined(); // still waiting on the lock
        },
        { timeout: 20_000 },
      );
      for (let i = 0; i < 100 && !confirmRes; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(confirmRes?.status).toBe(409);
      expect(confirmRes?.body.error.code).toBe('ITEM_NOT_PURCHASABLE');
      expect(confirmRes?.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: 'PLATFORM_HOLD' }),
        ]),
      );
      expect(
        await prisma.branchOrder.count({ where: { vendorId: w.vendor.id } }),
      ).toBe(0);
      // The refused confirmation released its own reservation, once.
      expect(await stockOf(w)).toEqual({ quantity: 10, reservedQuantity: 0 });
      expect(
        await prisma.checkoutReservation.count({
          where: { id: reserved.body.reservation_id },
        }),
      ).toBe(0);
    });

    it('if a held offer is still in a reservation (no cleanup ran), confirm refuses and releases it', async () => {
      const w = await world(10);
      const admin = await account('PLATFORM_ADMIN');
      const shopper = await account();
      const line = await addToCart(shopper.token, w, 1);
      const reserved = await reservePickup(shopper.token, w, line.body.id);
      await prisma.offerPlatformHold.create({
        data: {
          vendorId: w.vendor.id,
          vendorOfferId: w.offer.id,
          action: 'REQUEST_CHANGES',
          reason: 'مراجعة',
          placedById: admin.id,
        },
      });
      const res = await confirm(shopper.token, reserved.body.reservation_id);
      expect(res.status).toBe(409);
      expect(await stockOf(w)).toEqual({ quantity: 10, reservedQuantity: 0 });
      expect(
        await prisma.branchOrder.count({ where: { vendorId: w.vendor.id } }),
      ).toBe(0);
    });

    it('recovery: reservations left behind by a failed release are released exactly once, even racing itself and the expiry sweep; others are untouched', async () => {
      const w = await world(10);
      const other = await world(10);
      const admin = await account('PLATFORM_ADMIN');
      const a = await account();
      const b = await account();
      const c = await account();
      const ra = await reservePickup(
        a.token,
        w,
        (await addToCart(a.token, w, 2)).body.id,
      );
      const rb = await reservePickup(
        b.token,
        w,
        (await addToCart(b.token, w, 1)).body.id,
      );
      const rc = await reservePickup(
        c.token,
        other,
        (await addToCart(c.token, other, 1)).body.id,
      );
      expect([ra.status, rb.status, rc.status]).toEqual([201, 201, 201]);
      expect(await stockOf(w)).toEqual({ quantity: 10, reservedQuantity: 3 });
      // The hold committed but its release never ran (crash/timeout).
      await prisma.offerPlatformHold.create({
        data: {
          vendorId: w.vendor.id,
          vendorOfferId: w.offer.id,
          action: 'HIDE',
          reason: 'مراجعة',
          placedById: admin.id,
        },
      });
      // One of them is also expired: the expiry sweep competes for it.
      await prisma.checkoutReservation.update({
        where: { id: rb.body.reservation_id },
        data: { expiresAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      const moderation = app.get(OfferModerationService);
      const sweep = app.get(ReservationSweepService);
      await Promise.all([
        moderation.recoverHeldReservations(),
        moderation.recoverHeldReservations(),
        sweep.sweepOnce(),
      ]);

      expect(await stockOf(w)).toEqual({ quantity: 10, reservedQuantity: 0 });
      const ids = [ra.body.reservation_id, rb.body.reservation_id];
      expect(
        await prisma.checkoutReservation.count({ where: { id: { in: ids } } }),
      ).toBe(0);
      // Exactly one release record per reservation, whoever won.
      const audits = await prisma.auditLog.findMany({
        where: {
          entityId: { in: ids },
          action: {
            in: [
              'checkout.reservation_released_platform_hold',
              RESERVATION_SWEEP_AUDIT_ACTION,
            ],
          },
        },
        select: { entityId: true },
      });
      expect(audits.map((x) => x.entityId).sort()).toEqual([...ids].sort());

      // Running again gives nothing back twice.
      await moderation.recoverHeldReservations();
      expect(await stockOf(w)).toEqual({ quantity: 10, reservedQuantity: 0 });
      // A reservation on an offer that is not held is never touched.
      expect(await stockOf(other)).toEqual({
        quantity: 10,
        reservedQuantity: 1,
      });
      expect(
        await prisma.checkoutReservation.count({
          where: { id: rc.body.reservation_id },
        }),
      ).toBe(1);
    });

    it('a confirmed order is untouched by a later hold (order, stock, status)', async () => {
      const w = await world(10);
      const admin = await account('PLATFORM_ADMIN');
      const shopper = await account();
      const line = await addToCart(shopper.token, w, 1);
      const reserved = await reservePickup(shopper.token, w, line.body.id);
      const placed = await confirm(shopper.token, reserved.body.reservation_id);
      expect(placed.status).toBe(201);
      const orderId = placed.body.branch_orders[0].id as string;
      const before = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true },
      });
      const stockBefore = await stockOf(w);

      await place(admin.token, w.offer.id, 'HIDE').expect(201);

      const after = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true },
      });
      expect(after.status).toBe(before.status);
      expect(after.items).toEqual(before.items);
      expect(await stockOf(w)).toEqual(stockBefore);
      const mine = await request(http())
        .get('/api/v1/customers/me/orders')
        .set(auth(shopper.token))
        .expect(200);
      expect(JSON.stringify(mine.body)).toContain(orderId);
    });

    it('a hold racing a confirmation: either the order stands, or nothing is ordered and the hold is released exactly once', async () => {
      const w = await world(30);
      const admin = await account('PLATFORM_ADMIN');
      for (let round = 0; round < 4; round++) {
        const shopper = await account();
        const line = await addToCart(shopper.token, w, 1);
        expect(line.status).toBe(201);
        const reserved = await reservePickup(shopper.token, w, line.body.id);
        expect(reserved.status).toBe(201);
        const before = await stockOf(w);
        const [holdRes, confirmRes] = await Promise.all([
          place(admin.token, w.offer.id, 'HIDE'),
          confirm(shopper.token, reserved.body.reservation_id),
        ]);
        expect(holdRes.status).toBe(201);
        const after = await stockOf(w);
        const orders = await prisma.branchOrder.count({
          where: {
            vendorId: w.vendor.id,
            customerOrder: { customerId: shopper.profileId },
          },
        });
        if (confirmRes.status === 201) {
          // Confirm won: the order stands, its unit left stock.
          expect(orders).toBe(1);
          expect(after).toEqual({
            quantity: before.quantity - 1,
            reservedQuantity: before.reservedQuantity - 1,
          });
        } else {
          // Hold won: refused, nothing ordered, the unit released once.
          expect([404, 409]).toContain(confirmRes.status);
          expect(orders).toBe(0);
          expect(after).toEqual({
            quantity: before.quantity,
            reservedQuantity: before.reservedQuantity - 1,
          });
        }
        expect(
          await prisma.checkoutReservation.count({
            where: { id: reserved.body.reservation_id },
          }),
        ).toBe(0);
        await restore(
          admin.token,
          w.offer.id,
          await revisionOf(w.offer.id),
        ).expect(201);
      }
    });
  });

  // ------------------------------------------------------------------
  describe('the owner and the correction cycle', () => {
    it('the owner sees the reason; editing or republishing never lifts the hold', async () => {
      const w = await world();
      const admin = await account('PLATFORM_ADMIN');
      await place(
        admin.token,
        w.offer.id,
        'REQUEST_CHANGES',
        'الوصف لا يطابق الصور',
      ).expect(201);
      const view = await request(http())
        .get(
          `/api/v1/vendors/${w.vendor.id}/offers/${w.offer.id}/platform-hold`,
        )
        .set(auth(w.owner.token))
        .expect(200);
      expect(view.body.hold).toMatchObject({
        action: 'REQUEST_CHANGES',
        reason: 'الوصف لا يطابق الصور',
        can_submit_correction: true,
        correction: null,
      });
      expect(JSON.stringify(view.body)).not.toContain(admin.id);
      const list = await request(http())
        .get(`/api/v1/vendors/${w.vendor.id}/offers`)
        .set(auth(w.owner.token))
        .expect(200);
      expect(
        list.body.find((o: { id: string }) => o.id === w.offer.id)
          .platform_hold,
      ).toBe('REQUEST_CHANGES');

      await request(http())
        .put(`/api/v1/vendors/${w.vendor.id}/offers/${w.offer.id}`)
        .set(auth(w.owner.token))
        .send({ title_ar: 'فستان سهرة مصحح' })
        .expect(200);
      await request(http())
        .patch(`/api/v1/vendors/${w.vendor.id}/offers/${w.offer.id}/status`)
        .set(auth(w.owner.token))
        .send({ status: 'INACTIVE' });
      await request(http())
        .patch(`/api/v1/vendors/${w.vendor.id}/offers/${w.offer.id}/status`)
        .set(auth(w.owner.token))
        .send({ status: 'ACTIVE' });
      expect(
        await prisma.offerPlatformHold.count({
          where: { vendorOfferId: w.offer.id, releasedAt: null },
        }),
      ).toBe(1);
      const page = await request(http()).get(
        `/api/v1/storefronts/${w.vendor.slug}/offers/${w.offer.id}`,
      );
      expect(page.status).toBe(404);
    });

    it('a specific revision is submitted; a later edit makes it stale; restore needs a current correction and the reviewed revision', async () => {
      const w = await world();
      const admin = await account('PLATFORM_ADMIN');
      await place(admin.token, w.offer.id, 'REQUEST_CHANGES').expect(201);
      const submit = (revision: number) =>
        request(http())
          .post(
            `/api/v1/vendors/${w.vendor.id}/offers/${w.offer.id}/platform-hold/correction`,
          )
          .set(auth(w.owner.token))
          .set('Idempotency-Key', unique('corr'))
          .send({ offer_revision: revision, note: 'تم تعديل الصور' });

      // Restore before any correction: refused.
      const early = await restore(
        admin.token,
        w.offer.id,
        await revisionOf(w.offer.id),
      );
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('CORRECTION_REQUIRED');

      // Edit, then submit the CURRENT revision (an outdated one is refused).
      const r1 = await revisionOf(w.offer.id);
      await request(http())
        .put(`/api/v1/vendors/${w.vendor.id}/offers/${w.offer.id}`)
        .set(auth(w.owner.token))
        .send({ title_ar: unique('فستان معدل') })
        .expect(200);
      const r2 = await revisionOf(w.offer.id);
      expect(r2).toBeGreaterThan(r1);
      const outdated = await submit(r1);
      expect(outdated.status).toBe(409);
      expect(outdated.body.error.code).toBe('OFFER_REVISION_CHANGED');
      const ok = await submit(r2);
      expect(ok.status).toBe(201);
      expect(ok.body.hold.correction).toMatchObject({
        revision: r2,
        stale: false,
      });

      // A later edit: the submission is visibly stale, and restore refuses it.
      await request(http())
        .put(`/api/v1/vendors/${w.vendor.id}/offers/${w.offer.id}`)
        .set(auth(w.owner.token))
        .send({ title_ar: unique('فستان معدل مرة أخرى') })
        .expect(200);
      const r3 = await revisionOf(w.offer.id);
      const detail = await request(http())
        .get(`/api/v1/admin/offers/${w.offer.id}`)
        .set(auth(admin.token))
        .expect(200);
      expect(detail.body.hold.correction).toMatchObject({
        revision: r2,
        stale: true,
      });
      const stale = await restore(admin.token, w.offer.id, r3);
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('CORRECTION_STALE');

      // Resubmit the current version; restoring an older reviewed revision is refused.
      await submit(r3).expect(201);
      const wrongReview = await restore(admin.token, w.offer.id, r2);
      expect(wrongReview.status).toBe(409);
      expect(wrongReview.body.error.code).toBe('OFFER_CHANGED_SINCE_REVIEW');

      const done = await restore(admin.token, w.offer.id, r3);
      expect(done.status).toBe(201);
      expect(done.body.hold).toMatchObject({
        open: false,
        released: expect.objectContaining({ revision: r3 }),
      });
      await request(http())
        .get(`/api/v1/storefronts/${w.vendor.slug}/offers/${w.offer.id}`)
        .expect(200);
      // History is kept, and every step was audited.
      const history = await request(http())
        .get(`/api/v1/admin/offers/${w.offer.id}`)
        .set(auth(admin.token))
        .expect(200);
      expect(history.body.hold).toBeNull();
      expect(history.body.history).toHaveLength(1);
      const actions = (
        await prisma.auditLog.findMany({
          where: { entityType: 'VendorOffer', entityId: w.offer.id },
          select: { action: true },
        })
      ).map((a) => a.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'offer.platform_hold_placed',
          'offer.platform_hold_correction_submitted',
          'offer.platform_hold_released',
        ]),
      );
    });

    it('an admin can send a correction back; a HIDE hold takes no correction; another store cannot touch it', async () => {
      const w = await world();
      const other = await world();
      const admin = await account('PLATFORM_ADMIN');
      await place(admin.token, w.offer.id, 'REQUEST_CHANGES').expect(201);
      const rev = await revisionOf(w.offer.id);
      await request(http())
        .post(
          `/api/v1/vendors/${w.vendor.id}/offers/${w.offer.id}/platform-hold/correction`,
        )
        .set(auth(w.owner.token))
        .set('Idempotency-Key', unique('corr'))
        .send({ offer_revision: rev })
        .expect(201);
      const back = await request(http())
        .post(`/api/v1/admin/offers/${w.offer.id}/hold/return-correction`)
        .set(auth(admin.token))
        .set('Idempotency-Key', unique('back'))
        .send({ note: 'الصورة الثانية ما زالت غير واضحة' });
      expect(back.status).toBe(201);
      const view = await request(http())
        .get(
          `/api/v1/vendors/${w.vendor.id}/offers/${w.offer.id}/platform-hold`,
        )
        .set(auth(w.owner.token))
        .expect(200);
      expect(view.body.hold).toMatchObject({
        correction: null,
        last_return: { note: 'الصورة الثانية ما زالت غير واضحة' },
      });

      await place(admin.token, other.offer.id, 'HIDE').expect(201);
      const hide = await request(http())
        .post(
          `/api/v1/vendors/${other.vendor.id}/offers/${other.offer.id}/platform-hold/correction`,
        )
        .set(auth(other.owner.token))
        .set('Idempotency-Key', unique('corr'))
        .send({ offer_revision: await revisionOf(other.offer.id) });
      expect(hide.status).toBe(409);
      expect(hide.body.error.code).toBe('CORRECTION_NOT_REQUESTED');

      // The other store's owner cannot read or submit for this offer.
      const foreign = await request(http())
        .get(
          `/api/v1/vendors/${w.vendor.id}/offers/${w.offer.id}/platform-hold`,
        )
        .set(auth(other.owner.token));
      expect(foreign.status).toBe(403);
    });

    it('restore lifts only the hold: an offer the owner had paused stays hidden', async () => {
      const w = await world();
      const admin = await account('PLATFORM_ADMIN');
      await place(admin.token, w.offer.id, 'HIDE').expect(201);
      await prisma.vendorOffer.update({
        where: { id: w.offer.id },
        data: { status: 'INACTIVE' },
      });
      await restore(
        admin.token,
        w.offer.id,
        await revisionOf(w.offer.id),
      ).expect(201);
      const page = await request(http()).get(
        `/api/v1/storefronts/${w.vendor.slug}/offers/${w.offer.id}`,
      );
      expect(page.status).toBe(404);
      expect(
        (
          await prisma.vendorOffer.findUniqueOrThrow({
            where: { id: w.offer.id },
          })
        ).status,
      ).toBe('INACTIVE');
    });
  });

  // ------------------------------------------------------------------
  describe('admin list', () => {
    it('search and hold filters', async () => {
      const w = await world();
      const admin = await account('PLATFORM_ADMIN');
      await place(admin.token, w.offer.id, 'REQUEST_CHANGES').expect(201);
      const list = (query: string) =>
        request(http())
          .get(`/api/v1/admin/offers?${query}`)
          .set(auth(admin.token))
          .expect(200);
      const byTitle = await list(`q=${encodeURIComponent(w.offer.titleAr)}`);
      expect(byTitle.body.items.map((i: { id: string }) => i.id)).toEqual([
        w.offer.id,
      ]);
      expect(byTitle.body.items[0].hold).toMatchObject({
        action: 'REQUEST_CHANGES',
      });
      const held = await list(`hold=REQUEST_CHANGES&vendor_id=${w.vendor.id}`);
      expect(held.body.items).toHaveLength(1);
      const none = await list(`hold=none&vendor_id=${w.vendor.id}`);
      expect(none.body.items).toHaveLength(0);
      const bad = await request(http())
        .get('/api/v1/admin/offers?hold=nope')
        .set(auth(admin.token));
      expect(bad.status).toBe(400);
    });
  });
});
