import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { lockOffersWideForRestock } from './../src/checkout/stock-lock.util';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { BranchOrderRefundInitiator } from './../generated/prisma/client';
import { BranchOrderCancellationService } from './../src/orders/branch-order-cancellation.service';
import { NO_BRAND_SENTINEL_ID } from './../src/common/no-brand-sentinel';
import { DiscountActivationSweepService } from './../src/offers/discount-activation-sweep.service';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { createUniquePhone } from './helpers/e2e-phone-lanes';

type Res = { status: number; body: any };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// supertest's Test object is lazy - force dispatch immediately so two
// requests built "at once" actually race (see sprint20b/sprint21b's
// own comment for the full history of this fix).
const run = (t: PromiseLike<Res>): Promise<Res> => Promise.resolve(t);

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const settledWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    sleep(ms).then(() => false),
  ]);

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

const uniquePhone = createUniquePhone(
  'sprint24-favorites-comparison-alerts',
  '56',
);
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 24 - favorites, saved comparison sets, cross-comparison, alerts (e2e)', () => {
  let app: INestApplication;
  let fakeSms: FakeSmsService;
  let prisma: PrismaService;
  let relay: OutboxRelayService;
  let sweep: DiscountActivationSweepService;

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
    relay = app.get(OutboxRelayService);
    sweep = app.get(DiscountActivationSweepService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  const http = () => app.getHttpServer();

  async function drainOutbox(): Promise<void> {
    let n = 0;
    while (n < 50 && (await relay.dispatchOnce())) n += 1;
  }

  /** OutboxRelayService's own background 3-second poll (started by
   * every fresh app's onModuleInit) can occasionally still be
   * mid-tick, racing this test's own manual drainOutbox() call for
   * the SAME row - never a correctness issue (the relay's own
   * createNotification() is idempotent either way), just a timing
   * window. Retried briefly rather than asserted once, since the
   * relay is explicitly documented as best-effort/asynchronous. */
  async function expectNotificationEventually(
    where: Record<string, unknown>,
    count: number,
  ): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await drainOutbox();
      const n = await prisma.notification.count({ where });
      if (n === count) return;
      await sleep(100);
    }
    expect(await prisma.notification.count({ where })).toBe(count);
  }

  // ---------------------------------------------------------------
  // Shared fixtures - same conventions as sprint8/sprint21b's own
  // e2e specs (createConfirmedOffer/activateOffer/addStock/
  // makeVendorEligible), kept self-contained in this file.
  // ---------------------------------------------------------------

  async function signup(phone: string, password: string): Promise<string> {
    await request(http())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'signup' })
      .expect(202);
    const code = fakeSms.lastCodeFor(phone);
    const verify = await request(http())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', `verify-${phone}`)
      .send({ phone, otp_code: code, purpose: 'signup' })
      .expect(200);
    const register = await request(http())
      .post('/api/v1/auth/register')
      .send({ phone, password, verification_token: verify.body.session_token })
      .expect(201);
    return register.body.session_token as string;
  }

  async function userIdForToken(token: string): Promise<string> {
    const res = await request(http())
      .get('/api/v1/customers/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body.id as string;
  }

  async function createVendorWithBranch(
    ownerToken: string,
    branchName = 'Branch A',
  ): Promise<{ vendorId: string; branchId: string }> {
    const res = await request(http())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        store_type: 'PHYSICAL',
        branches: [{ name: branchName, is_physical: true }],
        applicable_categories: ['WOMEN'],
        return_policy: { mode: 'NO_RETURN' },
      })
      .expect(201);
    return { vendorId: res.body.id, branchId: res.body.branches[0].id };
  }

  async function addBranch(
    owner: string,
    vendorId: string,
    name: string,
  ): Promise<string> {
    const res = await request(http())
      .post(`/api/v1/vendors/${vendorId}/branches`)
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('add-branch'))
      .send({ name, is_physical: true })
      .expect(201);
    return res.body.id;
  }

  async function makeVendorEligible(vendorId: string): Promise<void> {
    await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    await prisma.storeBranch.updateMany({
      where: { vendorId },
      data: { verificationStatus: 'APPROVED' },
    });
  }

  async function createCanonicalVariant(
    adminToken: string,
    brandName: string,
    modelName: string,
    structuralAttributes: Record<string, unknown> = {},
  ): Promise<{ canonicalProductId: string; variantId: string }> {
    const brand = await prisma.brand.create({
      data: {
        name: brandName,
        normalizedName: unique(brandName).toLowerCase(),
      },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('Category') },
    });
    const productRes = await request(http())
      .post('/api/v1/canonical-products')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', unique('cp'))
      .send({
        brand_id: brand.id,
        category_id: category.id,
        model_name: modelName,
        confirm_despite_duplicate_warning: true,
      })
      .expect(201);
    const variantRes = await request(http())
      .post(`/api/v1/canonical-products/${productRes.body.id}/variants`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', unique('cpv'))
      .send({ structural_attributes: structuralAttributes })
      .expect(201);
    return {
      canonicalProductId: productRes.body.id,
      variantId: variantRes.body.id,
    };
  }

  async function createConfirmedOffer(
    ownerToken: string,
    vendorId: string,
    canonicalVariantId: string,
    identifierValue: string,
    basePrice: number,
    salePrice?: number,
  ): Promise<{ offerId: string; variantId: string }> {
    await prisma.canonicalProductVariant.update({
      where: { id: canonicalVariantId },
      data: { gtin: identifierValue },
    });
    const offerRes = await request(http())
      .post(`/api/v1/vendors/${vendorId}/offers`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('offer'))
      .send({
        title_ar: unique('عنوان'),
        title_en: unique('Title'),
        brand_id: NO_BRAND_SENTINEL_ID,
      })
      .expect(201);
    const variantRes = await request(http())
      .post(`/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('variant'))
      .send({
        seller_sku: unique('sku'),
        base_price: basePrice,
        sale_price: salePrice,
        identifier_type: 'GTIN',
        identifier_value: identifierValue,
      })
      .expect(201);
    await request(http())
      .post(
        `/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants/${variantRes.body.id}/match-confirmation`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('confirm'))
      .send({ decision: 'confirm' })
      .expect(200);
    await request(http())
      .post(
        `/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants/${variantRes.body.id}/media`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('media'))
      .send({
        url: 'https://example.com/hero.jpg',
        kind: 'PRIMARY',
        media_type: 'IMAGE',
      })
      .expect(201);
    return { offerId: offerRes.body.id, variantId: variantRes.body.id };
  }

  async function activateOffer(
    ownerToken: string,
    vendorId: string,
    offerId: string,
  ): Promise<void> {
    await request(http())
      .patch(`/api/v1/vendors/${vendorId}/offers/${offerId}/status`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
  }

  async function addStock(
    ownerToken: string,
    vendorId: string,
    branchId: string,
    variantId: string,
    quantity: number,
  ): Promise<void> {
    await request(http())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/stock/${variantId}/movements`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('stock'))
      .send({
        quantity_delta: quantity,
        reason: 'COUNT_CORRECTION',
        reason_note: 'e2e fixture',
      })
      .expect(201);
  }

  /** One fully eligible (confirmed match, ACTIVE, published vendor,
   * in-stock) offer, ready to be favorited/compared. */
  async function createEligibleOffer(
    adminToken: string,
    ownerToken: string,
    vendorId: string,
    branchId: string,
    basePrice: number,
    quantity: number,
  ): Promise<{
    canonicalProductId: string;
    canonicalVariantId: string;
    offerId: string;
    offerVariantId: string;
  }> {
    await makeVendorEligible(vendorId);
    const { canonicalProductId, variantId: canonicalVariantId } =
      await createCanonicalVariant(
        adminToken,
        unique('Brand'),
        unique('Model'),
      );
    const { offerId, variantId: offerVariantId } = await createConfirmedOffer(
      ownerToken,
      vendorId,
      canonicalVariantId,
      unique('gtin'),
      basePrice,
    );
    await addStock(ownerToken, vendorId, branchId, offerVariantId, quantity);
    await activateOffer(ownerToken, vendorId, offerId);
    return { canonicalProductId, canonicalVariantId, offerId, offerVariantId };
  }

  /** A confirmed-match, ACTIVE, published-vendor offer with real
   * stock - built directly via Prisma (never the full HTTP match/
   * confirm/media flow, same speed shortcut
   * sprint21b-exchange.e2e-spec.ts's own createOfferWithTwoVariants
   * uses for checkout fixtures), but WITH a real canonicalVariantId
   * link - FavoritesService.add()'s own OFFER-eligibility check
   * (eligibleProductWhere/findEligibleOffers' shared definition)
   * requires a confirmed match, so a favoritable fixture needs this
   * even when the test itself only cares about locking/alerts. */
  async function createOfferWithStock(
    vendorId: string,
    branchId: string,
    price: number,
    quantity: number,
  ): Promise<string> {
    await makeVendorEligible(vendorId);
    const brand = await prisma.brand.create({
      data: {
        name: unique('Brand'),
        normalizedName: unique('brand').toLowerCase(),
      },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('Category') },
    });
    const canonicalProduct = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('Model'),
        canonicalNameAr: unique('اسم'),
        canonicalNameEn: unique('Name'),
        status: 'PUBLISHED',
      },
    });
    const canonicalVariant = await prisma.canonicalProductVariant.create({
      data: {
        canonicalProductId: canonicalProduct.id,
        structuralAttributes: {},
        platformProductBarcode: unique('platform-barcode'),
      },
    });
    const offer = await prisma.vendorOffer.create({
      data: { vendorId, titleAr: 'م', titleEn: 'P', status: 'ACTIVE' },
    });
    const variant = await prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique('sku'),
        basePrice: price,
        storeInventoryBarcode: unique('barcode'),
        canonicalVariantId: canonicalVariant.id,
      },
    });
    if (quantity > 0) {
      await prisma.branchStock.create({
        data: { vendorId, branchId, offerVariantId: variant.id, quantity },
      });
    }
    return variant.id;
  }

  async function createVendorWithBranchAndPolicy(
    ownerToken: string,
    returnPolicy: Record<string, unknown>,
  ): Promise<{ vendorId: string; branchId: string }> {
    const res = await request(http())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        store_type: 'PHYSICAL',
        branches: [{ name: 'Branch A', is_physical: true }],
        applicable_categories: ['WOMEN'],
        return_policy: returnPolicy,
      })
      .expect(201);
    return { vendorId: res.body.id, branchId: res.body.branches[0].id };
  }

  async function createOfferWithTwoVariants(
    vendorId: string,
    branchId: string,
    originalPrice: number,
    originalQty: number,
    replacementPrice: number,
    replacementQty: number,
  ): Promise<{ originalVariantId: string; replacementVariantId: string }> {
    await makeVendorEligible(vendorId);
    const offer = await prisma.vendorOffer.create({
      data: { vendorId, titleAr: 'م', titleEn: 'P', status: 'ACTIVE' },
    });
    const original = await prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique('sku-orig'),
        basePrice: originalPrice,
        storeInventoryBarcode: unique('barcode-orig'),
        size: 'M',
      },
    });
    const replacement = await prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique('sku-repl'),
        basePrice: replacementPrice,
        storeInventoryBarcode: unique('barcode-repl'),
        size: 'L',
      },
    });
    await prisma.branchStock.create({
      data: {
        vendorId,
        branchId,
        offerVariantId: original.id,
        quantity: originalQty,
      },
    });
    if (replacementQty > 0) {
      await prisma.branchStock.create({
        data: {
          vendorId,
          branchId,
          offerVariantId: replacement.id,
          quantity: replacementQty,
        },
      });
    }
    return {
      originalVariantId: original.id,
      replacementVariantId: replacement.id,
    };
  }

  async function addToCart(
    token: string,
    vendorId: string,
    offerVariantId: string,
    quantity: number,
  ): Promise<string> {
    const res = await request(http())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('cart-add'))
      .send({ vendor_id: vendorId, offer_variant_id: offerVariantId, quantity })
      .expect(201);
    return res.body.id;
  }

  /** Places (and leaves at PLACED/PREPARING - never picks up) a
   * single-branch PICKUP/ONLINE order covering one or more cart
   * items, for cancellation tests. */
  async function placeOrder(
    customer: string,
    vendorId: string,
    branchId: string,
    cartItemIds: string[],
  ): Promise<{ branchOrderId: string }> {
    const reserved = await request(http())
      .post('/api/v1/checkout/reserve')
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', unique('reserve'))
      .send({
        terms_accepted: true,
        terms_version: '2026-10-v1',
        groups: [
          {
            cart_item_ids: cartItemIds,
            branch_id: branchId,
            fulfilment_method: 'PICKUP',
            payment_method: 'ONLINE',
          },
        ],
      })
      .expect(201);
    const confirmed = await request(http())
      .post('/api/v1/checkout/confirm')
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', unique('confirm'))
      .send({ reservation_id: reserved.body.reservation_id })
      .expect(201);
    return { branchOrderId: confirmed.body.branch_orders[0].id as string };
  }

  async function placeAndPickUpOrder(
    owner: string,
    customer: string,
    vendorId: string,
    branchId: string,
    variantId: string,
    quantity = 1,
  ): Promise<{ branchOrderId: string; itemId: string }> {
    const cartItemId = await addToCart(customer, vendorId, variantId, quantity);
    const { branchOrderId } = await placeOrder(customer, vendorId, branchId, [
      cartItemId,
    ]);
    const confirmed = await prisma.branchOrder.findUniqueOrThrow({
      where: { id: branchOrderId },
    });
    const pickupCode = confirmed.pickupCode!;
    await staffAction(
      owner,
      vendorId,
      branchId,
      branchOrderId,
      'start-preparation',
    ).expect(201);
    await staffAction(
      owner,
      vendorId,
      branchId,
      branchOrderId,
      'pickup-handover',
      { pickup_code: pickupCode },
    ).expect(201);
    const item = await prisma.branchOrderItem.findFirstOrThrow({
      where: { branchOrderId },
    });
    return { branchOrderId, itemId: item.id };
  }

  const staffAction = (
    token: string,
    vendorId: string,
    branchId: string,
    branchOrderId: string,
    action: string,
    body: Record<string, unknown> = {},
  ) =>
    request(http())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/orders/${branchOrderId}/${action}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('staff-action'))
      .send(body);

  async function submitExchange(
    customer: string,
    branchOrderId: string,
    itemId: string,
    replacementOfferVariantId: string,
    replacementBranchId: string,
    reason = 'WRONG_ITEM',
  ): Promise<Res> {
    return run(
      request(http())
        .post(
          `/api/v1/customers/me/orders/${branchOrderId}/items/${itemId}/returns`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('customer-return'))
        .send({
          reason,
          desired_outcome: 'EXCHANGE',
          replacement_offer_variant_id: replacementOfferVariantId,
          replacement_branch_id: replacementBranchId,
        }),
    );
  }

  const decideReturn = (
    owner: string,
    vendorId: string,
    branchId: string,
    returnId: string,
    body: Record<string, unknown>,
  ) =>
    request(http())
      .patch(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/returns/${returnId}/decision`,
      )
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('decide'))
      .send(body);

  const redeemReturn = (
    staffToken: string,
    vendorId: string,
    body: Record<string, unknown>,
  ) =>
    request(http())
      .post(`/api/v1/vendors/${vendorId}/returns/redeem`)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('Idempotency-Key', unique('redeem'))
      .send(body);

  /** A real, already-expired CheckoutReservation (explicit id, so its
   * sort position relative to another reservation's id is
   * controllable) plus one CheckoutReservationItem on a single stock
   * key - same technique sprint21b-exchange.e2e-spec.ts's own helper
   * uses, needed because stock-lock.util.ts's primitives discover/
   * lock/sweep by CheckoutReservation.id. */
  async function createExpiredReservationItem(
    reservationId: string,
    customerId: string,
    vendorId: string,
    branchId: string,
    offerVariantId: string,
    quantity: number,
  ): Promise<void> {
    await prisma.checkoutReservation.create({
      data: {
        id: reservationId,
        customerId,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.checkoutReservationItem.create({
      data: {
        id: unique('res-item'),
        reservationId,
        vendorId,
        branchId,
        offerVariantId,
        quantity,
        unitPriceAtReserve: 10,
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'ONLINE',
      },
    });
  }

  async function someoneWaitsOnLock(queryPattern: string): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE $1`,
        queryPattern,
      );
      if (Number(rows[0].n) > 0) return true;
      await sleep(100);
    }
    return false;
  }

  // ------------------------------------------------------------
  // FR-FAV-001/002/005: favorites (product/offer) + notification
  // preferences.
  // ------------------------------------------------------------
  describe('Favorites', () => {
    it('favoriting an eligible PRODUCT and an eligible OFFER both succeed, idempotently, and list shows both', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const eligible = await createEligibleOffer(
        admin,
        owner,
        vendorId,
        branchId,
        100,
        5,
      );

      const customer = await signup(uniquePhone(), 'a-strong-password');

      const addProduct = await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          target_type: 'PRODUCT',
          canonical_product_id: eligible.canonicalProductId,
        })
        .expect(201);
      expect(addProduct.body.favorited).toBe(true);

      const addOffer = await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          target_type: 'OFFER',
          offer_variant_id: eligible.offerVariantId,
        })
        .expect(201);
      expect(addOffer.body.favorited).toBe(true);

      // Idempotent re-add: no duplicate row, no error.
      await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          target_type: 'PRODUCT',
          canonical_product_id: eligible.canonicalProductId,
        })
        .expect(201);

      const list = await request(http())
        .get('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(list.body).toHaveLength(2);

      const userId = await userIdForToken(customer);
      expect(
        await prisma.favorite.count({
          where: { userId, canonicalProductId: eligible.canonicalProductId },
        }),
      ).toBe(1);
    });

    it('favoriting an ineligible target (nonexistent product, unmatched/unpublished offer) is 404 FAVORITE_TARGET_NOT_FOUND', async () => {
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const res1 = await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          target_type: 'PRODUCT',
          canonical_product_id: 'does-not-exist',
        })
        .expect(404);
      expect(res1.body.error.code).toBe('FAVORITE_TARGET_NOT_FOUND');

      const res2 = await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({ target_type: 'OFFER', offer_variant_id: 'does-not-exist' })
        .expect(404);
      expect(res2.body.error.code).toBe('FAVORITE_TARGET_NOT_FOUND');
    });

    it("BOLA: a user cannot remove another user's favorite - 404 either way, the favorite is untouched", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const eligible = await createEligibleOffer(
        admin,
        owner,
        vendorId,
        branchId,
        100,
        5,
      );
      const victim = await signup(uniquePhone(), 'a-strong-password');
      const attacker = await signup(uniquePhone(), 'a-strong-password');
      const added = await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${victim}`)
        .send({
          target_type: 'OFFER',
          offer_variant_id: eligible.offerVariantId,
        })
        .expect(201);
      void added;
      const victimId = await userIdForToken(victim);
      const row = await prisma.favorite.findFirstOrThrow({
        where: { userId: victimId },
      });

      const attackRes = await request(http())
        .delete(`/api/v1/favorites/${row.id}`)
        .set('Authorization', `Bearer ${attacker}`)
        .expect(200);
      // DELETE is a plain idempotent delete scoped to the caller - a
      // non-owned id simply matches zero rows, same 200 shape as a
      // real deletion (deleteMany), never a distinguishing error.
      expect(attackRes.body.favorited).toBe(false);
      expect(await prisma.favorite.count({ where: { id: row.id } })).toBe(1);
    });

    it('FR-FAV-005: every alert type defaults to enabled=true with no row; set/get round-trips an opt-out', async () => {
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const initial = await request(http())
        .get('/api/v1/customers/me/notification-preferences')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(initial.body).toEqual(
        expect.arrayContaining([
          { alert_type: 'PRICE_DROP', enabled: true },
          { alert_type: 'BACK_IN_STOCK', enabled: true },
          { alert_type: 'NEW_OFFER', enabled: true },
        ]),
      );
      await request(http())
        .patch('/api/v1/customers/me/notification-preferences')
        .set('Authorization', `Bearer ${customer}`)
        .send({ alert_type: 'BACK_IN_STOCK', enabled: false })
        .expect(200);
      const after = await request(http())
        .get('/api/v1/customers/me/notification-preferences')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(
        after.body.find((p: any) => p.alert_type === 'BACK_IN_STOCK').enabled,
      ).toBe(false);
      expect(
        after.body.find((p: any) => p.alert_type === 'PRICE_DROP').enabled,
      ).toBe(true);
    });
  });

  // ------------------------------------------------------------
  // FR-COMP-001/002/007: saved, shareable comparison sets.
  // ------------------------------------------------------------
  describe('Comparison sets', () => {
    async function setupTwoEligibleProducts() {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const a = await createEligibleOffer(
        admin,
        owner,
        vendorId,
        branchId,
        100,
        5,
      );
      const b = await createEligibleOffer(
        admin,
        owner,
        vendorId,
        branchId,
        120,
        5,
      );
      return { owner, admin, vendorId, branchId, a, b };
    }

    it('create validates 1-4 ids, then owner can list/get/add/remove/delete; the public share route exposes the same items by slug only', async () => {
      const { a, b } = await setupTwoEligibleProducts();
      const customer = await signup(uniquePhone(), 'a-strong-password');

      await request(http())
        .post('/api/v1/customers/me/comparison-sets')
        .set('Authorization', `Bearer ${customer}`)
        .send({ canonical_product_ids: [] })
        .expect(400);

      const created = await request(http())
        .post('/api/v1/customers/me/comparison-sets')
        .set('Authorization', `Bearer ${customer}`)
        .send({ canonical_product_ids: [a.canonicalProductId] })
        .expect(201);
      const setId = created.body.id as string;
      const shareSlug = created.body.share_slug as string;
      expect(shareSlug).toBeTruthy();

      await request(http())
        .post(`/api/v1/customers/me/comparison-sets/${setId}/items`)
        .set('Authorization', `Bearer ${customer}`)
        .send({ canonical_product_id: b.canonicalProductId })
        .expect(201);

      const own = await request(http())
        .get(`/api/v1/customers/me/comparison-sets/${setId}`)
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(own.body.items).toHaveLength(2);
      expect(own.body.share_slug).toBe(shareSlug);

      // Public route: only the opaque slug works, never the internal id.
      const shared = await request(http())
        .get(`/api/v1/comparison-sets/shared/${shareSlug}`)
        .expect(200);
      expect(shared.body.items).toHaveLength(2);
      expect(shared.body.id).toBeUndefined();
      await request(http())
        .get(`/api/v1/comparison-sets/shared/${setId}`)
        .expect(404);

      await request(http())
        .delete(
          `/api/v1/customers/me/comparison-sets/${setId}/items/${a.canonicalProductId}`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      const afterRemove = await request(http())
        .get(`/api/v1/customers/me/comparison-sets/${setId}`)
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(afterRemove.body.items).toHaveLength(1);

      await request(http())
        .delete(`/api/v1/customers/me/comparison-sets/${setId}`)
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(await prisma.comparisonSet.count({ where: { id: setId } })).toBe(
        0,
      );
    });

    it("BOLA: another user cannot read, add to, remove from, or delete someone else's set - 404 either way, nothing changes", async () => {
      const { a, b } = await setupTwoEligibleProducts();
      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const attacker = await signup(uniquePhone(), 'a-strong-password');
      const created = await request(http())
        .post('/api/v1/customers/me/comparison-sets')
        .set('Authorization', `Bearer ${owner2}`)
        .send({ canonical_product_ids: [a.canonicalProductId] })
        .expect(201);
      const setId = created.body.id as string;

      await request(http())
        .get(`/api/v1/customers/me/comparison-sets/${setId}`)
        .set('Authorization', `Bearer ${attacker}`)
        .expect(404);
      await request(http())
        .post(`/api/v1/customers/me/comparison-sets/${setId}/items`)
        .set('Authorization', `Bearer ${attacker}`)
        .send({ canonical_product_id: b.canonicalProductId })
        .expect(404);
      await request(http())
        .delete(
          `/api/v1/customers/me/comparison-sets/${setId}/items/${a.canonicalProductId}`,
        )
        .set('Authorization', `Bearer ${attacker}`)
        .expect(404);
      await request(http())
        .delete(`/api/v1/customers/me/comparison-sets/${setId}`)
        .set('Authorization', `Bearer ${attacker}`)
        .expect(200); // deleteMany scoped to attacker's own userId: 0 rows, same 200 shape
      expect(await prisma.comparisonSet.count({ where: { id: setId } })).toBe(
        1,
      );
      expect(
        await prisma.comparisonSetItem.count({
          where: { comparisonSetId: setId },
        }),
      ).toBe(1);
    });

    it('a set sitting at 4 items refuses a 5th with 409 COMPARISON_SET_FULL', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const products = [];
      for (let i = 0; i < 5; i++) {
        products.push(
          await createEligibleOffer(
            admin,
            owner,
            vendorId,
            branchId,
            100 + i,
            5,
          ),
        );
      }
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const created = await request(http())
        .post('/api/v1/customers/me/comparison-sets')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          canonical_product_ids: products
            .slice(0, 4)
            .map((p) => p.canonicalProductId),
        })
        .expect(201);
      const res = await request(http())
        .post(`/api/v1/customers/me/comparison-sets/${created.body.id}/items`)
        .set('Authorization', `Bearer ${customer}`)
        .send({ canonical_product_id: products[4].canonicalProductId })
        .expect(409);
      expect(res.body.error.code).toBe('COMPARISON_SET_FULL');
    });

    it('CONCURRENCY: two simultaneous adds to a set sitting at 3 items - exactly one succeeds (201), the other is refused (409), the set never exceeds 4', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const products = [];
      for (let i = 0; i < 5; i++) {
        products.push(
          await createEligibleOffer(
            admin,
            owner,
            vendorId,
            branchId,
            100 + i,
            5,
          ),
        );
      }
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const created = await request(http())
        .post('/api/v1/customers/me/comparison-sets')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          canonical_product_ids: products
            .slice(0, 3)
            .map((p) => p.canonicalProductId),
        })
        .expect(201);
      const setId = created.body.id as string;

      const [r1, r2] = await Promise.all([
        run(
          request(http())
            .post(`/api/v1/customers/me/comparison-sets/${setId}/items`)
            .set('Authorization', `Bearer ${customer}`)
            .send({ canonical_product_id: products[3].canonicalProductId }),
        ),
        run(
          request(http())
            .post(`/api/v1/customers/me/comparison-sets/${setId}/items`)
            .set('Authorization', `Bearer ${customer}`)
            .send({ canonical_product_id: products[4].canonicalProductId }),
        ),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
      const winner = r1.status === 201 ? r1 : r2;
      void winner;
      expect(
        await prisma.comparisonSetItem.count({
          where: { comparisonSetId: setId },
        }),
      ).toBe(4);
    });

    it('an item that stops being eligible after being saved is never removed from the set, but is reported available:false on both the owner and public reads', async () => {
      const { owner, vendorId, a, b } = await setupTwoEligibleProducts();
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const created = await request(http())
        .post('/api/v1/customers/me/comparison-sets')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          canonical_product_ids: [a.canonicalProductId, b.canonicalProductId],
        })
        .expect(201);
      const shareSlug = created.body.share_slug as string;

      // Vendor loses its published storefront - a's own offer is no
      // longer eligible, but the saved item itself must survive.
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { storefrontPublished: false },
      });
      void owner;

      const own = await request(http())
        .get(`/api/v1/customers/me/comparison-sets/${created.body.id}`)
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(own.body.items).toHaveLength(2);
      const unavailable = own.body.items.find(
        (i: any) => i.canonical_product_id === a.canonicalProductId,
      );
      expect(unavailable.available).toBe(false);

      const shared = await request(http())
        .get(`/api/v1/comparison-sets/shared/${shareSlug}`)
        .expect(200);
      expect(
        shared.body.items.find(
          (i: any) => i.canonical_product_id === a.canonicalProductId,
        ).available,
      ).toBe(false);
    });
  });

  // ------------------------------------------------------------
  // FR-FAV-004: back-in-stock, offer-wide across every physical
  // branch of the vendor - never a single branch's local crossing.
  // ------------------------------------------------------------
  describe('Back-in-stock alerts and the lockOffersWideForRestock batch primitive', () => {
    it('restocking the ONLY branch that carries this offer (0 -> positive offer-wide) fires BACK_IN_STOCK for an OFFER favorite', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 50, 0);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({ target_type: 'OFFER', offer_variant_id: variantId })
        .expect(201);

      await addStock(owner, vendorId, branchId, variantId, 5);

      const userId = await userIdForToken(customer);
      await expectNotificationEventually(
        { recipientUserId: userId, type: 'FAVORITE_BACK_IN_STOCK' },
        1,
      );
      const notifications = await prisma.notification.findMany({
        where: { recipientUserId: userId, type: 'FAVORITE_BACK_IN_STOCK' },
      });
      expect(notifications[0].targetId).toBe(variantId);
    });

    it('restocking branch A while branch B of the SAME offer already has stock never fires (no offer-wide 0 -> positive crossing)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId: branchA } =
        await createVendorWithBranch(owner);
      await makeVendorEligible(vendorId);
      const branchB = await addBranch(owner, vendorId, 'Branch B');
      const variantId = await createOfferWithStock(vendorId, branchA, 50, 0);
      await prisma.branchStock.create({
        data: {
          vendorId,
          branchId: branchB,
          offerVariantId: variantId,
          quantity: 3,
        },
      });
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({ target_type: 'OFFER', offer_variant_id: variantId })
        .expect(201);

      await addStock(owner, vendorId, branchA, variantId, 5);
      await drainOutbox();

      const userId = await userIdForToken(customer);
      expect(
        await prisma.notification.count({
          where: { recipientUserId: userId, type: 'FAVORITE_BACK_IN_STOCK' },
        }),
      ).toBe(0);
    });

    it('FR-FAV-005: an opted-out customer never receives the back-in-stock Notification row (checked at snapshot time)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 50, 0);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({ target_type: 'OFFER', offer_variant_id: variantId })
        .expect(201);
      await request(http())
        .patch('/api/v1/customers/me/notification-preferences')
        .set('Authorization', `Bearer ${customer}`)
        .send({ alert_type: 'BACK_IN_STOCK', enabled: false })
        .expect(200);

      await addStock(owner, vendorId, branchId, variantId, 5);
      await drainOutbox();

      const userId = await userIdForToken(customer);
      expect(
        await prisma.notification.count({
          where: { recipientUserId: userId, type: 'FAVORITE_BACK_IN_STOCK' },
        }),
      ).toBe(0);
    });

    it('NO PHANTOM ROWS: a restock with sibling branches read for BEFORE/AFTER never creates a branch_stock row in a sibling that never sold this offer', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId: branchA } =
        await createVendorWithBranch(owner);
      await makeVendorEligible(vendorId);
      const branchB = await addBranch(owner, vendorId, 'Branch B');
      const variantId = await createOfferWithStock(vendorId, branchA, 50, 0);
      expect(
        await prisma.branchStock.count({
          where: { branchId: branchB, offerVariantId: variantId },
        }),
      ).toBe(0);

      await prisma.$transaction(async (tx) => {
        const results = await lockOffersWideForRestock(tx, [
          {
            vendorId,
            branchId: branchA,
            offerVariantId: variantId,
            quantityDelta: 5,
            siblingBranchIds: [branchB],
          },
        ]);
        expect(results.get(`${branchA}:${variantId}`)!.before).toBe(0);
        expect(results.get(`${branchA}:${variantId}`)!.after).toBe(5);
      });

      expect(
        await prisma.branchStock.count({
          where: { branchId: branchB, offerVariantId: variantId },
        }),
      ).toBe(0);
      const target = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId: branchA,
            offerVariantId: variantId,
          },
        },
      });
      expect(target.quantity).toBe(5);
    });

    // ============================================================
    // Deterministic concurrency: two batched lockOffersWideForRestock
    // calls touching the SAME two offer keys in REVERSED array order,
    // each with a genuine expired reservation positioned adversarially
    // (same R_HIGH/R_LOW technique sprint21b-exchange.e2e-spec.ts's
    // own regression test uses) - proving the internal global sort
    // (never the caller's own array order) is what actually decides
    // lock order, so two batches can never deadlock against each
    // other no matter which order either caller happened to list its
    // mutations in.
    // ============================================================
    describe('Deterministic concurrency: reversed mutation order never deadlocks', () => {
      // Deliberately a DIFFERENT prefix pair than
      // sprint21b-exchange.e2e-spec.ts's own identical-looking R_LOW/
      // R_HIGH helper: both files run against the SAME shared database
      // in a full regression pass (parallel jest workers, one
      // Postgres), so reusing its exact '00000000.../ffffffff...'
      // literal prefixes caused a real cross-file primary-key
      // collision on checkout_reservations (caught by the full
      // regression run, not by this file alone) - only the internal
      // "LOW sorts before HIGH" property matters here, not matching
      // that file's specific literal values.
      let idSeq = 0;
      const R_LOW = () =>
        `11111111-1111-1111-1111-${(++idSeq).toString().padStart(12, '0')}`;
      const R_HIGH = () =>
        `eeeeeeee-eeee-eeee-eeee-${(++idSeq).toString().padStart(12, '0')}`;

      it('batch A [keyLow, keyHigh] vs batch B [keyHigh, keyLow] on the same two keys: both complete, neither deadlocks, both sweeps apply exactly once', async () => {
        const rHigh = R_HIGH();
        const rLow = R_LOW();
        const owner = await signup(uniquePhone(), 'a-strong-password');
        const { vendorId, branchId } = await createVendorWithBranch(owner);
        const variantX = await createOfferWithStock(vendorId, branchId, 50, 10);
        const variantY = await createOfferWithStock(vendorId, branchId, 60, 10);
        const [keyLow, keyHigh] = [variantX, variantY].sort();

        await prisma.branchStock.update({
          where: {
            branchId_offerVariantId: { branchId, offerVariantId: keyLow },
          },
          data: { reservedQuantity: 1 },
        });
        await prisma.branchStock.update({
          where: {
            branchId_offerVariantId: { branchId, offerVariantId: keyHigh },
          },
          data: { reservedQuantity: 1 },
        });

        const customerPhone = uniquePhone();
        await signup(customerPhone, 'a-strong-password');
        const customerProfile = await prisma.customerProfile.findFirstOrThrow({
          where: { user: { phone: customerPhone } },
        });
        // rHigh (sorts after rLow) on keyLow; rLow (sorts before rHigh)
        // on keyHigh - the adversarial, reversed-order arrangement.
        await createExpiredReservationItem(
          rHigh,
          customerProfile.id,
          vendorId,
          branchId,
          keyLow,
          1,
        );
        await createExpiredReservationItem(
          rLow,
          customerProfile.id,
          vendorId,
          branchId,
          keyHigh,
          1,
        );

        const aDone = deferred();
        const releaseA = deferred();
        const batchA = prisma.$transaction(async (tx) => {
          await lockOffersWideForRestock(tx, [
            { vendorId, branchId, offerVariantId: keyLow, quantityDelta: 1 },
            { vendorId, branchId, offerVariantId: keyHigh, quantityDelta: 1 },
          ]);
          aDone.resolve();
          await releaseA.promise;
          return 'a-done';
        });
        await aDone.promise;

        const batchB = prisma.$transaction(async (tx) => {
          await lockOffersWideForRestock(tx, [
            { vendorId, branchId, offerVariantId: keyHigh, quantityDelta: 1 },
            { vendorId, branchId, offerVariantId: keyLow, quantityDelta: 1 },
          ]);
          return 'b-done';
        });

        // B must genuinely block behind A (A holds keyLow's advisory
        // lock first, by the shared global sort) - never proceed
        // independently just because its own array listed keyHigh
        // first.
        const bSettledEarly = await settledWithin(batchB, 500);
        expect(bSettledEarly).toBe(false);
        expect(await someoneWaitsOnLock('%pg_advisory_xact_lock%')).toBe(true);

        releaseA.resolve();
        const results = await Promise.allSettled([batchA, batchB]);
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

        const finalLow = await prisma.branchStock.findUniqueOrThrow({
          where: {
            branchId_offerVariantId: { branchId, offerVariantId: keyLow },
          },
        });
        const finalHigh = await prisma.branchStock.findUniqueOrThrow({
          where: {
            branchId_offerVariantId: { branchId, offerVariantId: keyHigh },
          },
        });
        // Each batch incremented quantity by 1 -> +2 total on each key;
        // each key's own expired reservation (quantity 1) was swept
        // exactly once (by whichever batch ran first for that key),
        // never double-released, never left unreleased.
        expect(finalLow.quantity).toBe(12);
        expect(finalHigh.quantity).toBe(12);
        expect(finalLow.reservedQuantity).toBe(0);
        expect(finalHigh.reservedQuantity).toBe(0);
      });
    });
  });

  // ------------------------------------------------------------
  // FR-FAV-004 / order cancellation's own stock-restore write path -
  // the 4th real quantity-increasing writer, now routed through the
  // same batched primitive as every other one.
  // ------------------------------------------------------------
  describe('Order cancellation stock restore (batched across every distinct offerVariant)', () => {
    it('cancelling a whole order with TWO distinct offerVariants restores both in ONE batch and fires BACK_IN_STOCK only for the one that crossed 0 -> positive', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      // variantSoldOut: exactly 1 in stock, about to be fully sold by
      // this order - restoring it on cancel is a genuine 0 -> positive
      // crossing. variantStillAvailable: plenty left after the sale,
      // so cancelling never crosses 0 -> positive for it.
      const variantSoldOut = await createOfferWithStock(
        vendorId,
        branchId,
        50,
        1,
      );
      const variantStillAvailable = await createOfferWithStock(
        vendorId,
        branchId,
        60,
        10,
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({ target_type: 'OFFER', offer_variant_id: variantSoldOut })
        .expect(201);
      await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({ target_type: 'OFFER', offer_variant_id: variantStillAvailable })
        .expect(201);

      const item1 = await addToCart(customer, vendorId, variantSoldOut, 1);
      const item2 = await addToCart(
        customer,
        vendorId,
        variantStillAvailable,
        1,
      );
      const { branchOrderId } = await placeOrder(customer, vendorId, branchId, [
        item1,
        item2,
      ]);

      expect(
        (
          await prisma.branchStock.findUniqueOrThrow({
            where: {
              branchId_offerVariantId: {
                branchId,
                offerVariantId: variantSoldOut,
              },
            },
          })
        ).quantity,
      ).toBe(0);

      await request(http())
        .post(`/api/v1/customers/me/orders/${branchOrderId}/cancel`)
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('cancel'))
        .send({})
        .expect(201);

      const soldOutStock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variantSoldOut },
        },
      });
      const availableStock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId,
            offerVariantId: variantStillAvailable,
          },
        },
      });
      expect(soldOutStock.quantity).toBe(1);
      expect(availableStock.quantity).toBe(10);

      await drainOutbox();
      const userId = await userIdForToken(customer);
      const alerts = await prisma.notification.findMany({
        where: { recipientUserId: userId, type: 'FAVORITE_BACK_IN_STOCK' },
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].targetId).toBe(variantSoldOut);
    });

    it('two active items of the SAME offerVariant in one order are merged into a single mutation before the batch call (no double-counted/lost quantity)', async () => {
      // Direct service-level test: checkout's own cart dedupes by
      // variant, so two BranchOrderItems sharing one offerVariantId is
      // not reachable through the real HTTP flow - constructed
      // directly via Prisma to exercise branch-order-cancellation.
      // service.ts's own defensive qtyByOffer merge (Sprint 24
      // correction: lockOffersWideForRestock's per-mutation loop reads
      // its snapshot once up front, so passing the same target key
      // twice in one batch would otherwise silently drop one item's
      // quantity).
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 50, 0);
      const customerPhone = uniquePhone();
      await signup(customerPhone, 'a-strong-password');
      const customerProfile = await prisma.customerProfile.findFirstOrThrow({
        where: { user: { phone: customerPhone } },
      });
      const branchOrder = await prisma.branchOrder.create({
        data: {
          vendorId,
          branchId,
          customerOrderId: (
            await prisma.customerOrder.create({
              data: { customerId: customerProfile.id },
            })
          ).id,
          status: 'PLACED',
          fulfilmentMethod: 'PICKUP',
          paymentMethod: 'ONLINE',
          subtotal: '20.00',
          total: '20.00',
          pickupCode: '000000',
        },
      });
      await prisma.branchOrderItem.createMany({
        data: [
          {
            branchOrderId: branchOrder.id,
            vendorId,
            offerVariantId: variantId,
            quantity: 1,
            unitPrice: '10.00',
          },
          {
            branchOrderId: branchOrder.id,
            vendorId,
            offerVariantId: variantId,
            quantity: 1,
            unitPrice: '10.00',
          },
        ],
      });

      const cancellation = app.get(BranchOrderCancellationService);
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM branch_orders WHERE id = ${branchOrder.id} FOR UPDATE`;
        await cancellation.cancelWholeOrder(
          tx,
          {
            id: branchOrder.id,
            vendorId,
            branchId,
            customerOrderId: branchOrder.customerOrderId,
            status: 'PLACED',
            fulfilmentMethod: 'PICKUP',
            paymentMethod: 'ONLINE',
            deliveryAttemptCount: 0,
            deliveryFee: null,
            total: '20.00',
            paymentTransactionId: null,
          },
          null,
          BranchOrderRefundInitiator.SYSTEM,
          null,
          unique('corr'),
        );
      });

      const stock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variantId },
        },
      });
      // Both items' quantity (1 + 1) must be restored - never just one.
      expect(stock.quantity).toBe(2);
    });

    it('CONCURRENCY: a cancellation restoring stock races an independent staff DAMAGE movement on the SAME offer - both apply, never a deadlock, final quantity reflects both', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 50, 3);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const item = await addToCart(customer, vendorId, variantId, 1);
      const { branchOrderId } = await placeOrder(customer, vendorId, branchId, [
        item,
      ]);
      // Stock after the sale: 3 - 1 = 2.

      const [cancelRes, damageRes] = await Promise.all([
        run(
          request(http())
            .post(`/api/v1/customers/me/orders/${branchOrderId}/cancel`)
            .set('Authorization', `Bearer ${customer}`)
            .set('Idempotency-Key', unique('cancel'))
            .send({}),
        ),
        run(
          request(http())
            .post(
              `/api/v1/vendors/${vendorId}/branches/${branchId}/stock/${variantId}/movements`,
            )
            .set('Authorization', `Bearer ${owner}`)
            .set('Idempotency-Key', unique('damage'))
            .send({
              quantity_delta: -1,
              reason: 'DAMAGE',
              reason_note: 'e2e fixture',
            }),
        ),
      ]);
      expect(cancelRes.status).toBe(201);
      expect(damageRes.status).toBe(201);

      const stock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variantId },
        },
      });
      // 2 (post-sale) + 1 (cancel restore) - 1 (damage) = 2, regardless
      // of which side's transaction actually committed first.
      expect(stock.quantity).toBe(2);
    });
  });

  // ------------------------------------------------------------
  // Sprint 24 correction round 4: the exchange replacement leg's own
  // DELIBERATE reservedQuantity release (reservedQuantityDelta) must
  // combine correctly with a genuinely independent expired-reservation
  // sweep on the SAME stock key within the same lockOffersWideForRestock
  // batch - neither release may be lost, doubled, or drive
  // reservedQuantity negative (the CHECK constraint).
  // ------------------------------------------------------------
  describe('Exchange replacement leg vs a real expired reservation on the same key', () => {
    it('redeeming an exchange whose replacement stock ALSO carries a genuine expired checkout hold: both releases apply, reservedQuantity lands at exactly 0, no CHECK violation, no phantom rows', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranchAndPolicy(
        owner,
        {
          mode: 'BOTH',
          window_days: 14,
          fee_ils: 5,
          exchange_fee_ils: 10,
        },
      );
      const { originalVariantId, replacementVariantId } =
        await createOfferWithTwoVariants(vendorId, branchId, 100, 10, 120, 10);
      const customerPhone = uniquePhone();
      const customer = await signup(customerPhone, 'a-strong-password');
      const order = await placeAndPickUpOrder(
        owner,
        customer,
        vendorId,
        branchId,
        originalVariantId,
      );
      const submitted = await submitExchange(
        customer,
        order.branchOrderId,
        order.itemId,
        replacementVariantId,
        branchId,
      );
      expect(submitted.status).toBe(201);
      await decideReturn(owner, vendorId, branchId, submitted.body.id, {
        decision: 'approve',
      }).expect(200);

      // Approval already incremented reservedQuantity on the
      // replacement key by item.quantity (1) - confirm that baseline
      // before layering a genuinely independent, already-expired
      // checkout hold (quantity 2) on top of it.
      const afterApproval = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId,
            offerVariantId: replacementVariantId,
          },
        },
      });
      expect(afterApproval.reservedQuantity).toBe(1);

      const customerProfile = await prisma.customerProfile.findFirstOrThrow({
        where: { user: { phone: customerPhone } },
      });
      const expiredReservationId = unique('expired-res');
      await createExpiredReservationItem(
        expiredReservationId,
        customerProfile.id,
        vendorId,
        branchId,
        replacementVariantId,
        2,
      );
      await prisma.branchStock.update({
        where: {
          branchId_offerVariantId: {
            branchId,
            offerVariantId: replacementVariantId,
          },
        },
        data: { reservedQuantity: { increment: 2 } },
      });

      const r = await prisma.return.findUniqueOrThrow({
        where: { id: submitted.body.id },
      });
      const redeemRes = await redeemReturn(owner, vendorId, {
        code: r.code,
        receiving_branch_id: branchId,
        item_condition: 'DAMAGED',
      });
      expect(redeemRes.status).toBe(201);

      const finalStock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId,
            offerVariantId: replacementVariantId,
          },
        },
      });
      // 3 (1 approval hold + 2 expired) - 2 (sweep) - 1 (deliberate
      // approval release) = 0, exactly - never negative (the CHECK
      // constraint would reject that), never left at a stale nonzero.
      expect(finalStock.reservedQuantity).toBe(0);
      expect(finalStock.quantity).toBe(9); // 10 - 1 (handed over)
      expect(
        await prisma.checkoutReservationItem.count({
          where: { reservationId: expiredReservationId },
        }),
      ).toBe(0); // the expired item was actually swept away
    });
  });

  // ------------------------------------------------------------
  // FR-FAV-003: price-drop alerts at BOTH choke points - the manual
  // PATCH/PUT price edit (immediate) and the scheduled-discount sweep
  // (deferred, fires only once real time catches up to
  // discountStartAt).
  // ------------------------------------------------------------
  describe('Price-drop alerts', () => {
    it('an immediate manual price cut (PUT .../variants/:id with a lower sale_price) fires PRICE_DROP for both a PRODUCT and an OFFER favorite of the same listing, deduped to one notification', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const eligible = await createEligibleOffer(
        admin,
        owner,
        vendorId,
        branchId,
        100,
        5,
      );
      // Favorites BOTH the product and the exact offer with the SAME
      // customer - enqueueFavoriteNotification's own dedup must still
      // deliver exactly one notification, never two.
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          target_type: 'PRODUCT',
          canonical_product_id: eligible.canonicalProductId,
        })
        .expect(201);
      await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          target_type: 'OFFER',
          offer_variant_id: eligible.offerVariantId,
        })
        .expect(201);

      await request(http())
        .put(
          `/api/v1/vendors/${vendorId}/offers/${eligible.offerId}/variants/${eligible.offerVariantId}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ sale_price: 70 })
        .expect(200);

      const userId = await userIdForToken(customer);
      await expectNotificationEventually(
        { recipientUserId: userId, type: 'FAVORITE_PRICE_DROP' },
        1,
      );
    });

    it('a SCHEDULED discount activating via the sweep (never the manual-PATCH check) also fires PRICE_DROP', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const eligible = await createEligibleOffer(
        admin,
        owner,
        vendorId,
        branchId,
        100,
        5,
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          target_type: 'OFFER',
          offer_variant_id: eligible.offerVariantId,
        })
        .expect(201);

      // Scheduled for the FUTURE at PUT time - the controller's own
      // immediate check sees "not active yet" and must NOT fire here.
      await request(http())
        .put(
          `/api/v1/vendors/${vendorId}/offers/${eligible.offerId}/variants/${eligible.offerVariantId}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          discount_percent: 20,
          discount_start_at: new Date(
            Date.now() + 60 * 60 * 1000,
          ).toISOString(),
          discount_end_at: new Date(
            Date.now() + 2 * 60 * 60 * 1000,
          ).toISOString(),
        })
        .expect(200);

      const userId = await userIdForToken(customer);
      expect(
        await prisma.notification.count({
          where: { recipientUserId: userId, type: 'FAVORITE_PRICE_DROP' },
        }),
      ).toBe(0);

      // Time has now "passed" - move discountStartAt into the past
      // directly (never through the controller, which would re-run
      // its own immediate check) and let the sweep discover it.
      await prisma.offerVariant.update({
        where: { id: eligible.offerVariantId },
        data: { discountStartAt: new Date(Date.now() - 60 * 1000) },
      });
      await sweep.sweepOnce();

      await expectNotificationEventually(
        { recipientUserId: userId, type: 'FAVORITE_PRICE_DROP' },
        1,
      );
    });

    it('FR-FAV-005: an opted-out customer never receives a PRICE_DROP Notification row', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const eligible = await createEligibleOffer(
        admin,
        owner,
        vendorId,
        branchId,
        100,
        5,
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          target_type: 'OFFER',
          offer_variant_id: eligible.offerVariantId,
        })
        .expect(201);
      await request(http())
        .patch('/api/v1/customers/me/notification-preferences')
        .set('Authorization', `Bearer ${customer}`)
        .send({ alert_type: 'PRICE_DROP', enabled: false })
        .expect(200);

      await request(http())
        .put(
          `/api/v1/vendors/${vendorId}/offers/${eligible.offerId}/variants/${eligible.offerVariantId}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ sale_price: 70 })
        .expect(200);
      await drainOutbox();

      const userId = await userIdForToken(customer);
      expect(
        await prisma.notification.count({
          where: { recipientUserId: userId, type: 'FAVORITE_PRICE_DROP' },
        }),
      ).toBe(0);
    });
  });

  // ------------------------------------------------------------
  // FR-FAV-006: a new matched offer on an already-favorited PRODUCT
  // fires NEW_OFFER exactly once per confirmation.
  // ------------------------------------------------------------
  describe('New-offer alerts', () => {
    it('a second vendor confirming a match to an already-favorited canonical product fires FAVORITE_NEW_OFFER exactly once', async () => {
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor1, branchId: branch1 } =
        await createVendorWithBranch(owner1);
      const eligible = await createEligibleOffer(
        admin,
        owner1,
        vendor1,
        branch1,
        100,
        5,
      );

      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          target_type: 'PRODUCT',
          canonical_product_id: eligible.canonicalProductId,
        })
        .expect(201);

      // A SECOND, independent vendor also lists and confirms a match
      // to the SAME canonical variant - the genuinely new-offer event.
      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2, branchId: branch2 } =
        await createVendorWithBranch(owner2);
      await makeVendorEligible(vendor2);
      await createConfirmedOffer(
        owner2,
        vendor2,
        eligible.canonicalVariantId,
        unique('gtin2'),
        90,
      );

      const userId = await userIdForToken(customer);
      await expectNotificationEventually(
        { recipientUserId: userId, type: 'FAVORITE_NEW_OFFER' },
        1,
      );
      const n = await prisma.notification.findFirstOrThrow({
        where: { recipientUserId: userId, type: 'FAVORITE_NEW_OFFER' },
      });
      expect(n.targetType).toBe('CANONICAL_PRODUCT');
      expect(n.targetId).toBe(eligible.canonicalProductId);
      void branch2;
    });

    it('FR-FAV-005: an opted-out customer never receives a NEW_OFFER Notification row', async () => {
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor1, branchId: branch1 } =
        await createVendorWithBranch(owner1);
      const eligible = await createEligibleOffer(
        admin,
        owner1,
        vendor1,
        branch1,
        100,
        5,
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(http())
        .post('/api/v1/favorites')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          target_type: 'PRODUCT',
          canonical_product_id: eligible.canonicalProductId,
        })
        .expect(201);
      await request(http())
        .patch('/api/v1/customers/me/notification-preferences')
        .set('Authorization', `Bearer ${customer}`)
        .send({ alert_type: 'NEW_OFFER', enabled: false })
        .expect(200);

      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2 } = await createVendorWithBranch(owner2);
      await makeVendorEligible(vendor2);
      await createConfirmedOffer(
        owner2,
        vendor2,
        eligible.canonicalVariantId,
        unique('gtin3'),
        90,
      );
      await drainOutbox();

      const userId = await userIdForToken(customer);
      expect(
        await prisma.notification.count({
          where: { recipientUserId: userId, type: 'FAVORITE_NEW_OFFER' },
        }),
      ).toBe(0);
    });
  });

  // ------------------------------------------------------------
  // FR-COMP-003/004/005/006: the per-product comparison endpoint -
  // zone-explicit delivery fee, warranty fallback, price-staleness
  // flag, diff computation, cheapest tag; plus mode-2 cross-comparison
  // validation.
  // ------------------------------------------------------------
  describe('Comparison endpoint', () => {
    it('zone validation: an invalid zone is 400; omitting zone yields NO_ZONE_SELECTED; a zone with no delivery row is NOT_AVAILABLE_IN_ZONE; a zone with an enabled, fee-set row is AVAILABLE', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const eligible = await createEligibleOffer(
        admin,
        owner,
        vendorId,
        branchId,
        100,
        5,
      );
      await prisma.vendorDeliveryZone.create({
        data: {
          vendorId,
          region: 'WEST_BANK',
          enabled: true,
          fee: '15.00',
        },
      });

      await request(http())
        .get(
          `/api/v1/canonical-products/${eligible.canonicalProductId}/comparison?zone=NOT_A_REAL_ZONE`,
        )
        .expect(400);

      const noZone = await request(http())
        .get(
          `/api/v1/canonical-products/${eligible.canonicalProductId}/comparison`,
        )
        .expect(200);
      expect(noZone.body.offers[0].delivery_fee_status).toBe(
        'NO_ZONE_SELECTED',
      );
      expect(noZone.body.offers[0].delivery_fee).toBeNull();

      const noRow = await request(http())
        .get(
          `/api/v1/canonical-products/${eligible.canonicalProductId}/comparison?zone=JERUSALEM`,
        )
        .expect(200);
      expect(noRow.body.offers[0].delivery_fee_status).toBe(
        'NOT_AVAILABLE_IN_ZONE',
      );

      const available = await request(http())
        .get(
          `/api/v1/canonical-products/${eligible.canonicalProductId}/comparison?zone=WEST_BANK`,
        )
        .expect(200);
      expect(available.body.offers[0].delivery_fee_status).toBe('AVAILABLE');
      expect(available.body.offers[0].delivery_fee).toBe(15);
    });

    it('warranty falls back to "غير متوفر" when genuinely unset; the cheapest offer is tagged; diff reports all_same correctly', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      await makeVendorEligible(vendorId);
      const { canonicalProductId, variantId: canonicalVariantId } =
        await createCanonicalVariant(admin, unique('Brand'), unique('Model'));
      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2, branchId: branch2 } =
        await createVendorWithBranch(owner2);
      await makeVendorEligible(vendor2);

      const { offerId: offer1, variantId: variant1 } =
        await createConfirmedOffer(
          owner,
          vendorId,
          canonicalVariantId,
          unique('gtin'),
          100,
        );
      await addStock(owner, vendorId, branchId, variant1, 5);
      await activateOffer(owner, vendorId, offer1);

      const { offerId: offer2, variantId: variant2 } =
        await createConfirmedOffer(
          owner2,
          vendor2,
          canonicalVariantId,
          unique('gtin'),
          80,
        );
      await addStock(owner2, vendor2, branch2, variant2, 5);
      await activateOffer(owner2, vendor2, offer2);

      const res = await request(http())
        .get(`/api/v1/canonical-products/${canonicalProductId}/comparison`)
        .expect(200);
      expect(res.body.offers).toHaveLength(2);
      expect(res.body.offers[0].price).toBe('80.00');
      expect(res.body.offers[0].is_cheapest).toBe(true);
      expect(res.body.offers[0].warranty_period).toBe('غير متوفر');
      expect(res.body.offers[0].warranty_type).toBe('غير متوفر');
      expect(res.body.offers[1].is_cheapest).toBeUndefined();

      const conditionDiff = res.body.diff.find(
        (d: any) => d.field === 'condition',
      );
      expect(conditionDiff.all_same).toBe(true);
      const warrantyDiff = res.body.diff.find(
        (d: any) => d.field === 'warranty_period',
      );
      expect(warrantyDiff.all_same).toBe(true);
    });

    it('price staleness: a recently-listed offer is not stale; a PriceHistory row older than 30 days makes it stale', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const eligible = await createEligibleOffer(
        admin,
        owner,
        vendorId,
        branchId,
        100,
        5,
      );
      const fresh = await request(http())
        .get(
          `/api/v1/canonical-products/${eligible.canonicalProductId}/comparison`,
        )
        .expect(200);
      expect(fresh.body.offers[0].is_price_stale).toBe(false);

      // Variant creation already wrote one PriceHistory row at
      // fixture-setup time (now) - the comparison endpoint's own
      // staleness proxy reads the LATEST row by changedAt, so
      // simulating "nothing has changed in 45 days" means moving
      // THAT row back, never inserting a second, older one (which
      // would simply never be picked as latest).
      await prisma.priceHistory.updateMany({
        where: { offerVariantId: eligible.offerVariantId },
        data: { changedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) },
      });
      const stale = await request(http())
        .get(
          `/api/v1/canonical-products/${eligible.canonicalProductId}/comparison`,
        )
        .expect(200);
      expect(stale.body.offers[0].is_price_stale).toBe(true);
    });

    it('cross-comparison (mode 2): validates 2-4 distinct ids, 404s a missing product, tags the cheapest product, reports availability for a product with no eligible offers', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const adminPhone = uniquePhone();
      const admin = await signup(adminPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: adminPhone },
        data: { platformRole: 'PLATFORM_ADMIN' },
      });
      const a = await createEligibleOffer(
        admin,
        owner,
        vendorId,
        branchId,
        100,
        5,
      );
      const b = await createEligibleOffer(
        admin,
        owner,
        vendorId,
        branchId,
        60,
        5,
      );
      const { canonicalProductId: unavailableId } =
        await createCanonicalVariant(admin, unique('Brand'), unique('Model'));

      await request(http())
        .get(`/api/v1/comparison/cross?products=${a.canonicalProductId}`)
        .expect(400);
      await request(http())
        .get(
          `/api/v1/comparison/cross?products=${a.canonicalProductId},${a.canonicalProductId}`,
        )
        .expect(400);
      await request(http())
        .get(
          `/api/v1/comparison/cross?products=${a.canonicalProductId},not-real`,
        )
        .expect(404);

      const res = await request(http())
        .get(
          `/api/v1/comparison/cross?products=${a.canonicalProductId},${b.canonicalProductId},${unavailableId}`,
        )
        .expect(200);
      expect(res.body.products).toHaveLength(3);
      const productA = res.body.products.find(
        (p: any) => p.canonical_product_id === a.canonicalProductId,
      );
      const productB = res.body.products.find(
        (p: any) => p.canonical_product_id === b.canonicalProductId,
      );
      const productUnavailable = res.body.products.find(
        (p: any) => p.canonical_product_id === unavailableId,
      );
      expect(productA.available).toBe(true);
      expect(productB.available).toBe(true);
      expect(productB.is_cheapest).toBe(true);
      expect(productA.is_cheapest).toBeUndefined();
      expect(productUnavailable.available).toBe(false);
    });
  });
});
