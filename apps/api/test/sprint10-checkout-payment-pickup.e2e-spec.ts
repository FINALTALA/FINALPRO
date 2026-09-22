import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';

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

let phoneSeq = (Date.now() % 1_000_000) + 200_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97056${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

function nextDateForDayOfWeek(daysAhead: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}
function dayOfWeekFor(daysAhead: number): number {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.getUTCDay();
}

describe('Sprint 10 - checkout, sandbox payment, pay-at-pickup (e2e)', () => {
  let app: INestApplication | undefined;
  let fakeSms: FakeSmsService;
  let prisma: PrismaService;

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
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  async function signup(phone: string, password: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'signup' })
      .expect(202);
    const code = fakeSms.lastCodeFor(phone);
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', `verify-${phone}`)
      .send({ phone, otp_code: code, purpose: 'signup' })
      .expect(200);
    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ phone, password, verification_token: verify.body.session_token })
      .expect(201);
    return register.body.session_token as string;
  }

  async function createVendorWithTwoBranches(
    ownerToken: string,
  ): Promise<{ vendorId: string; branchAId: string; branchBId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        branches: [
          { name: 'Branch A', is_physical: true },
          { name: 'Branch B', is_physical: true },
        ],
        applicable_categories: ['WOMEN'],
      })
      .expect(201);
    return {
      vendorId: res.body.id,
      branchAId: res.body.branches[0].id,
      branchBId: res.body.branches[1].id,
    };
  }

  async function inviteAndAcceptAsNewUser(
    ownerToken: string,
    vendorId: string,
    branchId: string,
    phone: string,
    password: string,
  ) {
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('invite'))
      .send({ phone })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'staff_invite' })
      .expect(202);
    const code = fakeSms.lastCodeFor(phone);
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', unique('verify'))
      .send({ phone, otp_code: code, purpose: 'staff_invite' })
      .expect(200);
    const accept = await request(app.getHttpServer())
      .post('/api/v1/auth/staff-invites/accept')
      .set('Idempotency-Key', unique('accept'))
      .send({ phone, verification_token: verify.body.session_token, password })
      .expect(200);
    return accept.body;
  }

  // Codex review round 2 on commit d0ea80d (fix #3): checkout now
  // re-checks purchase eligibility (offer ACTIVE, vendor ACTIVE +
  // published, subscription ACTIVE) at every stage - a freshly-applied
  // test vendor (status: APPLIED, subscriptionStatus: NONE,
  // storefrontPublished: false by default) and a freshly-created offer
  // (status: DRAFT by default) would now correctly fail that check, so
  // this fixture explicitly makes the vendor/offer eligible, the same
  // way a real vendor would be after verification + subscribing +
  // publishing - none of which this sprint's own tests are about.
  async function makeVendorEligible(vendorId: string): Promise<void> {
    await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
  }

  async function createOfferWithStock(
    vendorId: string,
    branchId: string,
    price: number,
    quantity: number,
  ): Promise<string> {
    await makeVendorEligible(vendorId);
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
      },
    });
    await prisma.branchStock.create({
      data: { vendorId, branchId, offerVariantId: variant.id, quantity },
    });
    return variant.id;
  }

  async function createWindow(
    owner: string,
    vendorId: string,
    branchId: string,
    dayOfWeek: number,
    startTime: string,
    endTime: string,
    capacity: number,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/delivery-windows`)
      .set('Authorization', `Bearer ${owner}`)
      .send({
        day_of_week: dayOfWeek,
        start_time: startTime,
        end_time: endTime,
        capacity,
      })
      .expect(201);
    return res.body.id;
  }

  // Sprint 5's existing per-region endpoint (RB-STORE-002) - Sprint 10
  // only adds an optional `fee` to its existing body, one region at a
  // time (not the bulk 3-zone shape an earlier draft of this test
  // mistakenly assumed before the route collision was found).
  async function setZoneFee(
    owner: string,
    vendorId: string,
    zone: string,
    fee: number,
  ) {
    await request(app.getHttpServer())
      .put(`/api/v1/vendors/${vendorId}/delivery-zones/${zone}`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ enabled: true, fee })
      .expect(200);
  }

  async function createAddress(
    token: string,
    zone = 'WEST_BANK',
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/customers/me/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: 31.9, lng: 35.2, phone_number_1: '+970591111111', zone })
      .expect(201);
    return res.body.id;
  }

  async function addToCart(
    token: string,
    vendorId: string,
    offerVariantId: string,
    quantity: number,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('cart-add'))
      .send({ vendor_id: vendorId, offer_variant_id: offerVariantId, quantity })
      .expect(201);
    return res.body.id;
  }

  // ============================================================
  // Cart
  // ============================================================
  describe('Cart', () => {
    it('adds, lists, updates, and removes a cart item; a second add increments quantity', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 20, 10);
      const customer = await signup(uniquePhone(), 'a-strong-password');

      const added = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('cart-add'))
        .send({ vendor_id: vendorId, offer_variant_id: variantId, quantity: 2 })
        .expect(201);
      expect(added.body.quantity).toBe(2);
      expect(added.body.unit_price).toBe(20);

      const addedAgain = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('cart-add'))
        .send({ vendor_id: vendorId, offer_variant_id: variantId, quantity: 3 })
        .expect(201);
      expect(addedAgain.body.quantity).toBe(5);
      expect(addedAgain.body.id).toBe(added.body.id);

      const list = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(list.body).toHaveLength(1);

      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${added.body.id}`)
        .set('Authorization', `Bearer ${customer}`)
        .send({ quantity: 1 })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/api/v1/cart/items/${added.body.id}`)
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);

      const listAfter = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(listAfter.body).toHaveLength(0);
    });

    it("BOLA: a customer cannot update or delete ANOTHER customer's cart item", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 20, 10);
      const customerA = await signup(uniquePhone(), 'a-strong-password');
      const customerB = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customerA, vendorId, variantId, 1);

      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${itemId}`)
        .set('Authorization', `Bearer ${customerB}`)
        .send({ quantity: 5 })
        .expect(404);
      await request(app.getHttpServer())
        .delete(`/api/v1/cart/items/${itemId}`)
        .set('Authorization', `Bearer ${customerB}`)
        .expect(404);
    });
  });

  // ============================================================
  // Checkout quote
  // ============================================================
  describe('Checkout quote (read-only preview)', () => {
    it('groups items by vendor/branch and reports subtotal + eligible branches', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 15, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 2);

      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set('Authorization', `Bearer ${customer}`)
        .send({ cart_item_ids: [itemId] })
        .expect(201);
      expect(quote.body.groups).toHaveLength(1);
      expect(quote.body.groups[0].subtotal).toBe(30);
      expect(quote.body.groups[0].eligible_branches[0].branch_id).toBe(
        branchAId,
      );
      expect(quote.body.unavailable_items).toEqual([]);
    });

    it('surfaces an item as unavailable when requested quantity exceeds stock everywhere, without dropping it silently', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 15, 1);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 5);

      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set('Authorization', `Bearer ${customer}`)
        .send({ cart_item_ids: [itemId] })
        .expect(201);
      expect(quote.body.groups).toEqual([]);
      expect(quote.body.unavailable_items).toEqual([
        { cart_item_id: itemId, reason: 'NO_BRANCH_HAS_SUFFICIENT_STOCK' },
      ]);
    });

    it("BOLA: a customer cannot quote another customer's cart item", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 15, 5);
      const customerA = await signup(uniquePhone(), 'a-strong-password');
      const customerB = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customerA, vendorId, variantId, 1);

      await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set('Authorization', `Bearer ${customerB}`)
        .send({ cart_item_ids: [itemId] })
        .expect(404);
    });
  });

  // ============================================================
  // Checkout reserve
  // ============================================================
  describe('Checkout reserve (the real 10-minute hold)', () => {
    it('reserves stock for a PICKUP group - reservedQuantity rises, quantity stays untouched', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 15, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 3);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);
      expect(reserved.body.reservation_id).toBeTruthy();
      expect(reserved.body.items[0].quantity).toBe(3);

      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { offerVariantId: variantId },
      });
      expect(stock.quantity).toBe(5);
      expect(stock.reservedQuantity).toBe(3);
    });

    it('rejects reserving more than truly available (insufficient stock), never over-reserving', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 15, 2);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 5);

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { offerVariantId: variantId },
      });
      expect(stock.reservedQuantity).toBe(0);
    });

    it('rejects PICKUP for a non-physical branch', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const res0 = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          branches: [{ name: 'Warehouse', is_physical: false }],
          applicable_categories: ['WOMEN'],
        })
        .expect(201);
      const vendorId = res0.body.id;
      const branchId = res0.body.branches[0].id;
      const variantId = await createOfferWithStock(vendorId, branchId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PICKUP_REQUIRES_PHYSICAL_BRANCH');
    });

    it('reserves a DELIVERY group with a valid slot, snapshotting the delivery fee', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 15, 5);
      const dow = dayOfWeekFor(1);
      const windowId = await createWindow(
        owner,
        vendorId,
        branchAId,
        dow,
        '09:00',
        '18:00',
        2,
      );
      await setZoneFee(owner, vendorId, 'WEST_BANK', 12);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'WEST_BANK');
      const itemId = await addToCart(customer, vendorId, variantId, 2);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'DELIVERY',
              payment_method: 'ONLINE',
              address_id: addressId,
              delivery_window_id: windowId,
              scheduled_date: nextDateForDayOfWeek(1),
            },
          ],
        })
        .expect(201);
      expect(reserved.body.slots[0].delivery_fee).toBe(12);
    });

    it('rejects a DELIVERY reservation when the vendor does not deliver to that zone', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 15, 5);
      const dow = dayOfWeekFor(1);
      const windowId = await createWindow(
        owner,
        vendorId,
        branchAId,
        dow,
        '09:00',
        '18:00',
        2,
      );
      // No zone fee configured at all - vendor delivers nowhere yet.
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'WEST_BANK');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'DELIVERY',
              payment_method: 'ONLINE',
              address_id: addressId,
              delivery_window_id: windowId,
              scheduled_date: nextDateForDayOfWeek(1),
            },
          ],
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DELIVERY_NOT_AVAILABLE_IN_ZONE');
    });

    it('rejects a slot date more than 3 days out, and a date not matching the window day-of-week', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 15, 5);
      const dow = dayOfWeekFor(1);
      const windowId = await createWindow(
        owner,
        vendorId,
        branchAId,
        dow,
        '09:00',
        '18:00',
        2,
      );
      await setZoneFee(owner, vendorId, 'WEST_BANK', 10);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'WEST_BANK');

      const itemId1 = await addToCart(customer, vendorId, variantId, 1);
      const tooFar = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId1],
              branch_id: branchAId,
              fulfilment_method: 'DELIVERY',
              payment_method: 'ONLINE',
              address_id: addressId,
              delivery_window_id: windowId,
              scheduled_date: nextDateForDayOfWeek(10),
            },
          ],
        });
      expect(tooFar.status).toBe(409);
      expect(tooFar.body.error.code).toBe('INVALID_SLOT_DATE');

      const itemId2 = await addToCart(customer, vendorId, variantId, 1);
      const wrongDay = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId2],
              branch_id: branchAId,
              fulfilment_method: 'DELIVERY',
              payment_method: 'ONLINE',
              address_id: addressId,
              delivery_window_id: windowId,
              // one of the OTHER two days in the 3-day window, guaranteed
              // to differ from `dow` since dow only matches exactly one
              // of the three offsets.
              scheduled_date:
                dayOfWeekFor(0) !== dow
                  ? nextDateForDayOfWeek(0)
                  : nextDateForDayOfWeek(2),
            },
          ],
        });
      expect(wrongDay.status).toBe(409);
      expect(wrongDay.body.error.code).toBe('INVALID_SLOT_DATE');
    });

    it('rejects a duplicate branch across groups, and a cart item split across two groups', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId1 = await addToCart(customer, vendorId, variantId, 1);

      const dupBranch = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId1],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
            {
              cart_item_ids: [itemId1],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        });
      expect(dupBranch.status).toBe(409);
      expect(dupBranch.body.error.code).toBe('DUPLICATE_BRANCH_IN_CHECKOUT');
    });
  });

  // ============================================================
  // Checkout confirm
  // ============================================================
  describe('Checkout confirm', () => {
    it('creates a PICKUP BranchOrder with a pickup code, decrements real stock, and removes only the purchased cart line', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 20, 5);
      const variantIdUnselected = await createOfferWithStock(
        vendorId,
        branchAId,
        8,
        5,
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 2);
      const unselectedItemId = await addToCart(
        customer,
        vendorId,
        variantIdUnselected,
        1,
      );

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      const confirmed = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id })
        .expect(201);
      expect(confirmed.body.branch_orders).toHaveLength(1);
      expect(confirmed.body.branch_orders[0].pickup_code).toMatch(/^\d{6}$/);
      expect(confirmed.body.branch_orders[0].total).toBe(40);

      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { offerVariantId: variantId },
      });
      expect(stock.quantity).toBe(3);
      expect(stock.reservedQuantity).toBe(0);

      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(cart.body.map((c: { id: string }) => c.id)).toEqual([
        unselectedItemId,
      ]);

      const branchOrder = await prisma.branchOrder.findFirstOrThrow({
        where: { vendorId, branchId: branchAId },
      });
      expect(branchOrder.status).toBe('PLACED');
    });

    it('creates a DELIVERY BranchOrder with the correct address and consumed slot capacity', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 15, 5);
      const dow = dayOfWeekFor(1);
      const windowId = await createWindow(
        owner,
        vendorId,
        branchAId,
        dow,
        '09:00',
        '18:00',
        1,
      );
      await setZoneFee(owner, vendorId, 'WEST_BANK', 10);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'WEST_BANK');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'DELIVERY',
              payment_method: 'ONLINE',
              address_id: addressId,
              delivery_window_id: windowId,
              scheduled_date: nextDateForDayOfWeek(1),
            },
          ],
        })
        .expect(201);

      const confirmed = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id })
        .expect(201);
      expect(confirmed.body.branch_orders[0].total).toBe(25);

      const branchOrder = await prisma.branchOrder.findFirstOrThrow({
        where: { vendorId, branchId: branchAId },
      });
      expect(branchOrder.addressId).toBe(addressId);
      expect(branchOrder.paymentTransactionId).toBeTruthy();

      const transaction = await prisma.paymentTransaction.findFirstOrThrow({
        where: { id: branchOrder.paymentTransactionId! },
      });
      expect(Number(transaction.amount)).toBe(25);
      expect(transaction.status).toBe('SUCCEEDED');
    });

    it('combines multiple ONLINE BranchOrders in one checkout into a single PaymentTransaction (RB-ORD-003)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const vendor1 = await createVendorWithTwoBranches(owner);
      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const vendor2 = await createVendorWithTwoBranches(owner2);
      const v1 = await createOfferWithStock(
        vendor1.vendorId,
        vendor1.branchAId,
        10,
        5,
      );
      const v2 = await createOfferWithStock(
        vendor2.vendorId,
        vendor2.branchAId,
        20,
        5,
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const item1 = await addToCart(customer, vendor1.vendorId, v1, 1);
      const item2 = await addToCart(customer, vendor2.vendorId, v2, 1);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [item1],
              branch_id: vendor1.branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'ONLINE',
            },
            {
              cart_item_ids: [item2],
              branch_id: vendor2.branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'ONLINE',
            },
          ],
        })
        .expect(201);

      const confirmed = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id })
        .expect(201);
      expect(confirmed.body.branch_orders).toHaveLength(2);

      const orders = await prisma.branchOrder.findMany({
        where: { customerOrderId: confirmed.body.customer_order_id },
      });
      const txIds = new Set(orders.map((o) => o.paymentTransactionId));
      expect(txIds.size).toBe(1);
      const tx = await prisma.paymentTransaction.findFirstOrThrow({
        where: { id: [...txIds][0]! },
      });
      expect(Number(tx.amount)).toBe(30);
    });

    it('rejects confirm with a clear price-change error when the price changed after reserve, and never charges the new price silently', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      await prisma.offerVariant.update({
        where: { id: variantId },
        data: { basePrice: 99 },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CHECKOUT_PRICE_CHANGED');
      // The diff is encoded into the message text itself -
      // HttpExceptionFilter's fixed response shape drops any other
      // custom field (see CheckoutService.confirm's own comment).
      expect(res.body.error.message).toContain(variantId);
      expect(res.body.error.message).toContain('20 -> 99');

      const branchOrders = await prisma.branchOrder.findMany({
        where: { vendorId, branchId: branchAId },
      });
      expect(branchOrders).toHaveLength(0);
    });

    it('rejects confirm of an expired reservation and releases its held stock back', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 3);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 2);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      await prisma.checkoutReservation.update({
        where: { id: reserved.body.reservation_id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('RESERVATION_EXPIRED');

      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { offerVariantId: variantId },
      });
      expect(stock.reservedQuantity).toBe(0);
    });

    it("BOLA: a customer cannot confirm another customer's reservation", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 3);
      const customerA = await signup(uniquePhone(), 'a-strong-password');
      const customerB = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customerA, vendorId, variantId, 1);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customerA}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customerB}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id });
      expect(res.status).toBe(404);
    });
  });

  // ============================================================
  // Cancel reservation
  // ============================================================
  describe('Cancel reservation (idempotent early release)', () => {
    it('releases held stock immediately, and cancelling again (or an already-consumed one) is a benign no-op', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 3);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 2);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      const cancelled = await request(app.getHttpServer())
        .post(
          `/api/v1/checkout/reservations/${reserved.body.reservation_id}/cancel`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .expect(201);
      expect(cancelled.body.released).toBe(true);

      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { offerVariantId: variantId },
      });
      expect(stock.reservedQuantity).toBe(0);

      const cancelledAgain = await request(app.getHttpServer())
        .post(
          `/api/v1/checkout/reservations/${reserved.body.reservation_id}/cancel`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .expect(201);
      expect(cancelledAgain.body.released).toBe(false);
    });
  });

  // ============================================================
  // Concurrency
  // ============================================================
  describe('Checkout concurrency', () => {
    it('two customers racing to reserve the last unit of stock - exactly one succeeds', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 1);
      const customerA = await signup(uniquePhone(), 'a-strong-password');
      const customerB = await signup(uniquePhone(), 'a-strong-password');
      const itemA = await addToCart(customerA, vendorId, variantId, 1);
      const itemB = await addToCart(customerB, vendorId, variantId, 1);

      const body = {
        groups: [
          {
            branch_id: branchAId,
            fulfilment_method: 'PICKUP',
            payment_method: 'COD',
          },
        ],
      };
      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/checkout/reserve')
          .set('Authorization', `Bearer ${customerA}`)
          .set('Idempotency-Key', unique('reserve'))
          .send({ groups: [{ ...body.groups[0], cart_item_ids: [itemA] }] }),
        request(app.getHttpServer())
          .post('/api/v1/checkout/reserve')
          .set('Authorization', `Bearer ${customerB}`)
          .set('Idempotency-Key', unique('reserve'))
          .send({ groups: [{ ...body.groups[0], cart_item_ids: [itemB] }] }),
      ]);
      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { offerVariantId: variantId },
      });
      expect(stock.reservedQuantity).toBe(1);
    });

    it('two customers racing for the last delivery-slot capacity - exactly one succeeds', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 10);
      const dow = dayOfWeekFor(1);
      const windowId = await createWindow(
        owner,
        vendorId,
        branchAId,
        dow,
        '09:00',
        '18:00',
        1,
      );
      await setZoneFee(owner, vendorId, 'WEST_BANK', 5);
      const customerA = await signup(uniquePhone(), 'a-strong-password');
      const customerB = await signup(uniquePhone(), 'a-strong-password');
      const addressA = await createAddress(customerA, 'WEST_BANK');
      const addressB = await createAddress(customerB, 'WEST_BANK');
      const itemA = await addToCart(customerA, vendorId, variantId, 1);
      const itemB = await addToCart(customerB, vendorId, variantId, 1);
      const date = nextDateForDayOfWeek(1);

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/checkout/reserve')
          .set('Authorization', `Bearer ${customerA}`)
          .set('Idempotency-Key', unique('reserve'))
          .send({
            groups: [
              {
                cart_item_ids: [itemA],
                branch_id: branchAId,
                fulfilment_method: 'DELIVERY',
                payment_method: 'ONLINE',
                address_id: addressA,
                delivery_window_id: windowId,
                scheduled_date: date,
              },
            ],
          }),
        request(app.getHttpServer())
          .post('/api/v1/checkout/reserve')
          .set('Authorization', `Bearer ${customerB}`)
          .set('Idempotency-Key', unique('reserve'))
          .send({
            groups: [
              {
                cart_item_ids: [itemB],
                branch_id: branchAId,
                fulfilment_method: 'DELIVERY',
                payment_method: 'ONLINE',
                address_id: addressB,
                delivery_window_id: windowId,
                scheduled_date: date,
              },
            ],
          }),
      ]);
      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const activeSlots = await prisma.checkoutReservationSlot.count({
        where: { deliveryWindowId: windowId },
      });
      expect(activeSlots).toBe(1);
    });

    it('a physical/manual stock movement (POS) cannot eat stock already held by a live reservation', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 3);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 3);

      await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      // All 3 physical units are now reserved - a POS sale of even 1
      // unit must be refused, not allowed to eat the hold.
      const movement = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({ quantity_delta: -1, reason: 'DAMAGE', reason_note: 'test' });
      expect(movement.status).toBe(409);
      expect(movement.body.error.code).toBe('INSUFFICIENT_STOCK');

      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { offerVariantId: variantId },
      });
      expect(stock.quantity).toBe(3);
      expect(stock.reservedQuantity).toBe(3);
    });
  });

  // ============================================================
  // Delivery windows: a live reservation blocks edit/delete (extends
  // Sprint 9's DeliveryWindowsController).
  // ============================================================
  describe('Delivery window protection against a live reservation', () => {
    it('a window with a live (unexpired) reservation slot cannot be updated or deleted', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const dow = dayOfWeekFor(1);
      const windowId = await createWindow(
        owner,
        vendorId,
        branchAId,
        dow,
        '09:00',
        '18:00',
        2,
      );
      await setZoneFee(owner, vendorId, 'WEST_BANK', 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'WEST_BANK');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'DELIVERY',
              payment_method: 'ONLINE',
              address_id: addressId,
              delivery_window_id: windowId,
              scheduled_date: nextDateForDayOfWeek(1),
            },
          ],
        })
        .expect(201);

      const blockedUpdate = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${windowId}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: dow,
          start_time: '09:00',
          end_time: '19:00',
          capacity: 2,
        });
      expect(blockedUpdate.status).toBe(409);
      expect(blockedUpdate.body.error.code).toBe(
        'DELIVERY_WINDOW_HAS_ACTIVE_RESERVATION',
      );

      const blockedDelete = await request(app.getHttpServer())
        .delete(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${windowId}`,
        )
        .set('Authorization', `Bearer ${owner}`);
      expect(blockedDelete.status).toBe(409);
      expect(blockedDelete.body.error.code).toBe(
        'DELIVERY_WINDOW_HAS_ACTIVE_RESERVATION',
      );
    });
  });

  // ============================================================
  // Delivery zone settings (owner-only)
  // ============================================================
  describe('Delivery zone settings', () => {
    it('an owner can set and read zone fees; a BRANCH_EMPLOYEE is forbidden', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const employeePhone = uniquePhone();
      const accepted = await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchAId,
        employeePhone,
        'employee-password',
      );

      await setZoneFee(owner, vendorId, 'WEST_BANK', 15);
      const list = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/delivery-zones`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const wb = list.body.find(
        (z: { region: string }) => z.region === 'WEST_BANK',
      );
      expect(wb.fee).toBe(15);
      expect(wb.enabled).toBe(true);
      // Untouched regions still default enabled=true (Sprint 5's own
      // lazy-default convention, unchanged), but fee stays null - never
      // defaulted - until an owner explicitly prices them.
      const jerusalem = list.body.find(
        (z: { region: string }) => z.region === 'JERUSALEM',
      );
      expect(jerusalem.enabled).toBe(true);
      expect(jerusalem.fee).toBeNull();

      const forbidden = await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/delivery-zones/WEST_BANK`)
        .set('Authorization', `Bearer ${accepted.session_token}`)
        .send({ enabled: true, fee: 1 });
      expect(forbidden.status).toBe(403);
    });

    it('toggling enabled without a fee never wipes out a previously-set fee', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithTwoBranches(owner);
      await setZoneFee(owner, vendorId, 'WEST_BANK', 20);

      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/delivery-zones/WEST_BANK`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ enabled: false })
        .expect(200);

      const list = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/delivery-zones`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const wb = list.body.find(
        (z: { region: string }) => z.region === 'WEST_BANK',
      );
      expect(wb.enabled).toBe(false);
      expect(wb.fee).toBe(20);
    });
  });

  // ============================================================
  // Staff/owner order visibility (RB-ORD-004, PDR-009)
  // ============================================================
  describe('Staff/owner order visibility', () => {
    async function placeOnePickupOrder(
      owner: string,
      vendorId: string,
      branchId: string,
    ): Promise<{ orderId: string; pickupCode: string }> {
      const variantId = await createOfferWithStock(vendorId, branchId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);
      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);
      const confirmed = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id })
        .expect(201);
      return {
        orderId: confirmed.body.branch_orders[0].id,
        pickupCode: confirmed.body.branch_orders[0].pickup_code,
      };
    }

    it('a BRANCH_EMPLOYEE sees only their own branch orders (name, phone, pickup code - never an address field)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId, branchBId } =
        await createVendorWithTwoBranches(owner);
      const employeePhone = uniquePhone();
      const accepted = await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchAId,
        employeePhone,
        'employee-password',
      );
      const orderA = await placeOnePickupOrder(owner, vendorId, branchAId);
      await placeOnePickupOrder(owner, vendorId, branchBId);

      const list = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/orders`)
        .set('Authorization', `Bearer ${accepted.session_token}`)
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].id).toBe(orderA.orderId);
      expect(list.body[0].pickup_code).toBe(orderA.pickupCode);
      expect(list.body[0].customer_phone).toBeTruthy();
      expect(list.body[0]).not.toHaveProperty('address');
      expect(list.body[0]).not.toHaveProperty('customer_address');
      // Codex review round 2 (fix #6): the employee DTO must be
      // genuinely minimal, not just missing address - status, total,
      // payment_method, and created_at are all owner-only fields.
      expect(list.body[0]).not.toHaveProperty('status');
      expect(list.body[0]).not.toHaveProperty('total');
      expect(list.body[0]).not.toHaveProperty('payment_method');
      expect(list.body[0]).not.toHaveProperty('created_at');
      expect(Object.keys(list.body[0]).sort()).toEqual(
        ['customer_name', 'customer_phone', 'id', 'pickup_code'].sort(),
      );

      const forbiddenBranch = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchBId}/orders`)
        .set('Authorization', `Bearer ${accepted.session_token}`);
      expect(forbiddenBranch.status).toBe(403);

      const forbiddenVendorWide = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/orders`)
        .set('Authorization', `Bearer ${accepted.session_token}`);
      expect(forbiddenVendorWide.status).toBe(403);
    });

    it('the owner sees orders across ALL their branches via the vendor-wide endpoint', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId, branchBId } =
        await createVendorWithTwoBranches(owner);
      await placeOnePickupOrder(owner, vendorId, branchAId);
      await placeOnePickupOrder(owner, vendorId, branchBId);

      const list = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/orders`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(list.body).toHaveLength(2);
    });

    it("BOLA: an owner of a DIFFERENT vendor cannot list this vendor's branch orders", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      await placeOnePickupOrder(owner, vendorId, branchAId);

      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/orders`)
        .set('Authorization', `Bearer ${owner2}`);
      expect(res.status).toBe(403);
    });

    it('pickup_code is null for a DELIVERY order in the staff list', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const dow = dayOfWeekFor(1);
      const windowId = await createWindow(
        owner,
        vendorId,
        branchAId,
        dow,
        '09:00',
        '18:00',
        2,
      );
      await setZoneFee(owner, vendorId, 'WEST_BANK', 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'WEST_BANK');
      const itemId = await addToCart(customer, vendorId, variantId, 1);
      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'DELIVERY',
              payment_method: 'ONLINE',
              address_id: addressId,
              delivery_window_id: windowId,
              scheduled_date: nextDateForDayOfWeek(1),
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/orders`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(list.body[0].fulfilment_method).toBe('DELIVERY');
      expect(list.body[0].pickup_code).toBeNull();
    });
  });

  // ============================================================
  // Codex review round 2 on commit d0ea80d - fix #1: lazy expiry must
  // be swept everywhere availability is read or stock is decremented,
  // not only when a NEW reserve() attempt happens to touch the same
  // row.
  // ============================================================
  describe('Lazy expiry sweeping (Codex review round 2, fix #1)', () => {
    it('an expired reservation is swept by a POS movement with no new reserve attempt, and a fresh quote sees recovered availability', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 2);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 2);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      await prisma.checkoutReservation.update({
        where: { id: reserved.body.reservation_id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      // The stale reservedQuantity=2 must be swept by the movement path
      // itself (lockAndSweepStockRow) - no fresh reserve() call happens
      // anywhere in this test to clean it up first.
      const movement = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('movement'))
        .send({ quantity_delta: -2, reason: 'DAMAGE', reason_note: 'test' });
      expect(movement.status).toBe(201);

      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { offerVariantId: variantId },
      });
      expect(stock.quantity).toBe(0);
      expect(stock.reservedQuantity).toBe(0);

      const secondItem = await addToCart(customer, vendorId, variantId, 1);
      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set('Authorization', `Bearer ${customer}`)
        .send({ cart_item_ids: [secondItem] })
        .expect(201);
      expect(quote.body.groups).toEqual([]);
      expect(quote.body.unavailable_items).toEqual([
        { cart_item_id: secondItem, reason: 'NO_BRANCH_HAS_SUFFICIENT_STOCK' },
      ]);
    });

    it('quote shows availability recovered from an expired reservation even without any sweep ever running', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 1);
      const customerA = await signup(uniquePhone(), 'a-strong-password');
      const customerB = await signup(uniquePhone(), 'a-strong-password');
      const itemA = await addToCart(customerA, vendorId, variantId, 1);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customerA}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemA],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      await prisma.checkoutReservation.update({
        where: { id: reserved.body.reservation_id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      // BranchStock.reservedQuantity is still the stale, unswept value
      // of 1 here - quote() must ignore it and compute live
      // availability directly from unexpired CheckoutReservationItem
      // rows instead, entirely read-only.
      const itemB = await addToCart(customerB, vendorId, variantId, 1);
      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set('Authorization', `Bearer ${customerB}`)
        .send({ cart_item_ids: [itemB] })
        .expect(201);
      expect(quote.body.groups).toHaveLength(1);
      expect(quote.body.unavailable_items).toEqual([]);
    });
  });

  // ============================================================
  // Codex review round 2 on commit d0ea80d - fix #2: confirm() must
  // reconcile only the exact reserved quantity against the ORIGINAL
  // cart line, never bulk-delete it, so a customer who raises the same
  // line's quantity during the 10-minute hold keeps the extra units.
  // ============================================================
  describe('Cart reconciliation preserves concurrent edits (Codex review round 2, fix #2)', () => {
    it('reserving quantity 1 then raising the same cart line to 2 leaves exactly 1 unit in the cart after confirm', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${itemId}`)
        .set('Authorization', `Bearer ${customer}`)
        .send({ quantity: 2 })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id })
        .expect(201);

      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(cart.body).toHaveLength(1);
      expect(cart.body[0].id).toBe(itemId);
      expect(cart.body[0].quantity).toBe(1);
    });
  });

  // ============================================================
  // Codex review round 2 on commit d0ea80d - fix #3: a central
  // purchasability predicate re-checked at add-to-cart, quote, reserve,
  // AND confirm (state can change during the hold).
  // ============================================================
  describe('Purchase eligibility re-checked at every stage (Codex review round 2, fix #3)', () => {
    async function createIneligibleOffer(
      vendorId: string,
      branchId: string,
      opts: { vendorEligible: boolean; offerActive: boolean },
    ): Promise<string> {
      if (opts.vendorEligible) {
        await makeVendorEligible(vendorId);
      }
      const offer = await prisma.vendorOffer.create({
        data: {
          vendorId,
          titleAr: 'م',
          titleEn: 'P',
          status: opts.offerActive ? 'ACTIVE' : 'DRAFT',
        },
      });
      const variant = await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          basePrice: 10,
          storeInventoryBarcode: unique('barcode'),
        },
      });
      await prisma.branchStock.create({
        data: { vendorId, branchId, offerVariantId: variant.id, quantity: 5 },
      });
      return variant.id;
    }

    it('rejects add-to-cart when the offer is DRAFT (vendor otherwise eligible)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createIneligibleOffer(vendorId, branchAId, {
        vendorEligible: true,
        offerActive: false,
      });
      const customer = await signup(uniquePhone(), 'a-strong-password');

      const res = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('cart-add'))
        .send({
          vendor_id: vendorId,
          offer_variant_id: variantId,
          quantity: 1,
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ITEM_NOT_PURCHASABLE');
    });

    it('rejects add-to-cart when the vendor is unpublished/not ACTIVE (offer otherwise ACTIVE)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createIneligibleOffer(vendorId, branchAId, {
        vendorEligible: false,
        offerActive: true,
      });
      const customer = await signup(uniquePhone(), 'a-strong-password');

      const res = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('cart-add'))
        .send({
          vendor_id: vendorId,
          offer_variant_id: variantId,
          quantity: 1,
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ITEM_NOT_PURCHASABLE');
    });

    it('rejects quote when the item became ineligible after it was added to the cart', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      await prisma.vendor.update({
        where: { id: vendorId },
        data: { storefrontPublished: false },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set('Authorization', `Bearer ${customer}`)
        .send({ cart_item_ids: [itemId] });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ITEM_NOT_PURCHASABLE');
    });

    it('rejects reserve when the item became ineligible after quote', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set('Authorization', `Bearer ${customer}`)
        .send({ cart_item_ids: [itemId] })
        .expect(201);

      await prisma.vendorOffer.updateMany({
        where: { vendorId },
        data: { status: 'DRAFT' },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ITEM_NOT_PURCHASABLE');

      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { offerVariantId: variantId },
      });
      expect(stock.reservedQuantity).toBe(0);
    });

    it('rejects confirm when eligibility changes DURING the hold, and never creates an order', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      await prisma.vendor.update({
        where: { id: vendorId },
        data: { status: 'SUSPENDED' },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ITEM_NOT_PURCHASABLE');

      const branchOrders = await prisma.branchOrder.findMany({
        where: { vendorId, branchId: branchAId },
      });
      expect(branchOrders).toHaveLength(0);
    });
  });

  // ============================================================
  // Codex review round 2 on commit d0ea80d - fix #4: every stock/window
  // lock is taken in a single canonical order regardless of the order
  // the client's own groups happened to list them in, so two concurrent
  // multi-branch checkouts locking in opposite orders never deadlock.
  // ============================================================
  describe('Checkout concurrency: reversed lock order (Codex review round 2, fix #4)', () => {
    it('two concurrent multi-branch checkouts submitted with reversed group order never deadlock or 500', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId, branchBId } =
        await createVendorWithTwoBranches(owner);
      const variantA = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const variantB = await createOfferWithStock(vendorId, branchBId, 10, 5);
      const customerX = await signup(uniquePhone(), 'a-strong-password');
      const customerY = await signup(uniquePhone(), 'a-strong-password');

      const itemXA = await addToCart(customerX, vendorId, variantA, 1);
      const itemXB = await addToCart(customerX, vendorId, variantB, 1);
      const itemYA = await addToCart(customerY, vendorId, variantA, 1);
      const itemYB = await addToCart(customerY, vendorId, variantB, 1);

      const groupFor = (branchId: string, itemId: string) => ({
        cart_item_ids: [itemId],
        branch_id: branchId,
        fulfilment_method: 'PICKUP' as const,
        payment_method: 'COD' as const,
      });

      const [resX, resY] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/checkout/reserve')
          .set('Authorization', `Bearer ${customerX}`)
          .set('Idempotency-Key', unique('reserve'))
          .send({
            groups: [groupFor(branchAId, itemXA), groupFor(branchBId, itemXB)],
          }),
        request(app.getHttpServer())
          .post('/api/v1/checkout/reserve')
          .set('Authorization', `Bearer ${customerY}`)
          .set('Idempotency-Key', unique('reserve'))
          .send({
            groups: [groupFor(branchBId, itemYB), groupFor(branchAId, itemYA)],
          }),
      ]);
      expect(resX.status).toBe(201);
      expect(resY.status).toBe(201);
    });
  });

  // ============================================================
  // Codex review round 2 on commit d0ea80d - fix #5: a network retry of
  // a financial/reservation-creating endpoint must never double-create;
  // a different body under the same key must be rejected, not replayed
  // or silently re-executed.
  // ============================================================
  describe('Idempotency on cart-add, reserve, and confirm (Codex review round 2, fix #5)', () => {
    it('cart/items: same key + same body replays without doubling quantity; a different body under the same key is rejected', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const key = unique('cart-add-idem');

      const first = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', key)
        .send({ vendor_id: vendorId, offer_variant_id: variantId, quantity: 1 })
        .expect(201);

      const replay = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', key)
        .send({ vendor_id: vendorId, offer_variant_id: variantId, quantity: 1 })
        .expect(201);
      expect(replay.body).toEqual(first.body);

      const list = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(list.body[0].quantity).toBe(1);

      const conflicting = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', key)
        .send({
          vendor_id: vendorId,
          offer_variant_id: variantId,
          quantity: 99,
        });
      expect(conflicting.status).toBe(409);
    });

    it('checkout/reserve: same key + same body replays the same reservation without doubling the hold; a different body under the same key is rejected', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);
      const reserveKey = unique('reserve-idem');
      const reserveBody = {
        groups: [
          {
            cart_item_ids: [itemId],
            branch_id: branchAId,
            fulfilment_method: 'PICKUP',
            payment_method: 'COD',
          },
        ],
      };

      const firstReserve = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', reserveKey)
        .send(reserveBody)
        .expect(201);

      const replayReserve = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', reserveKey)
        .send(reserveBody)
        .expect(201);
      expect(replayReserve.body.reservation_id).toBe(
        firstReserve.body.reservation_id,
      );

      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { offerVariantId: variantId },
      });
      expect(stock.reservedQuantity).toBe(1);

      const conflictingReserve = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', reserveKey)
        .send({
          groups: [
            {
              ...reserveBody.groups[0],
              payment_method: 'ONLINE',
            },
          ],
        });
      expect(conflictingReserve.status).toBe(409);
    });

    it('checkout/confirm: same key + same body replays the same order without creating a duplicate; a different body under the same key is rejected', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      const confirmKey = unique('confirm-idem');
      const confirmBody = { reservation_id: reserved.body.reservation_id };

      const firstConfirm = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', confirmKey)
        .send(confirmBody)
        .expect(201);

      const replayConfirm = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', confirmKey)
        .send(confirmBody)
        .expect(201);
      expect(replayConfirm.body).toEqual(firstConfirm.body);

      const orders = await prisma.branchOrder.findMany({
        where: { vendorId, branchId: branchAId },
      });
      expect(orders).toHaveLength(1);

      const conflictingConfirm = await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', confirmKey)
        .send({
          reservation_id: '00000000-0000-0000-0000-000000000000',
        });
      expect(conflictingConfirm.status).toBe(409);
    });
  });

  // ============================================================
  // Codex review round 2 on commit d0ea80d - fix #7: a partial unique
  // index on (branchId, pickupCode) for active PICKUP orders makes a
  // collision a real (if rare) possibility - confirm() must retry with
  // a fresh code rather than surfacing the raw unique-violation or,
  // worse, letting two active orders at the same branch share a code.
  // ============================================================
  describe('Pickup code collision retry (Codex review round 2, fix #7)', () => {
    it('a partial unique index rejects a second simultaneously-active identical code at the same branch', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const customerPhone = uniquePhone();
      await signup(customerPhone, 'a-strong-password');
      const user = await prisma.user.findUniqueOrThrow({
        where: { phone: customerPhone },
      });
      const customerProfile = await prisma.customerProfile.findUniqueOrThrow({
        where: { userId: user.id },
      });
      const customerOrder = await prisma.customerOrder.create({
        data: { customerId: customerProfile.id },
      });
      await prisma.branchOrder.create({
        data: {
          customerOrderId: customerOrder.id,
          vendorId,
          branchId: branchAId,
          fulfilmentMethod: 'PICKUP',
          paymentMethod: 'COD',
          status: 'PLACED',
          subtotal: 1,
          total: 1,
          pickupCode: '000000',
        },
      });

      await expect(
        prisma.branchOrder.create({
          data: {
            customerOrderId: customerOrder.id,
            vendorId,
            branchId: branchAId,
            fulfilmentMethod: 'PICKUP',
            paymentMethod: 'COD',
            status: 'PLACED',
            subtotal: 1,
            total: 1,
            pickupCode: '000000',
          },
        }),
      ).rejects.toThrow();
    });

    it('confirm() retries with a fresh code when its first attempt collides with an existing active code at the branch', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customerPhone = uniquePhone();
      const customer = await signup(customerPhone, 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      // Pre-seed an existing ACTIVE PICKUP order at the same branch
      // holding the exact code generatePickupCode()'s first (mocked)
      // attempt will produce - Math.random() is the ONLY caller of
      // Math.random anywhere in apps/api/src, so pinning it here only
      // affects the pickup-code generator, nothing else in this request.
      const user = await prisma.user.findUniqueOrThrow({
        where: { phone: customerPhone },
      });
      const customerProfile = await prisma.customerProfile.findUniqueOrThrow({
        where: { userId: user.id },
      });
      const otherOrder = await prisma.customerOrder.create({
        data: { customerId: customerProfile.id },
      });
      await prisma.branchOrder.create({
        data: {
          customerOrderId: otherOrder.id,
          vendorId,
          branchId: branchAId,
          fulfilmentMethod: 'PICKUP',
          paymentMethod: 'COD',
          status: 'PLACED',
          subtotal: 1,
          total: 1,
          pickupCode: '000000',
        },
      });

      const randomSpy = jest
        .spyOn(Math, 'random')
        .mockReturnValueOnce(0) // first attempt -> '000000' -> collides
        .mockReturnValueOnce(0.5); // retry -> '500000' -> succeeds
      let confirmed: request.Response;
      try {
        confirmed = await request(app.getHttpServer())
          .post('/api/v1/checkout/confirm')
          .set('Authorization', `Bearer ${customer}`)
          .set('Idempotency-Key', unique('confirm'))
          .send({ reservation_id: reserved.body.reservation_id })
          .expect(201);
      } finally {
        randomSpy.mockRestore();
      }
      // The exact retry code depends on how many Math.random() calls
      // land before the colliding attempt (Prisma's own internals may
      // consume some) - what matters is that confirm() never 500s and
      // never lands on the code that was already active at this branch.
      expect(confirmed.body.branch_orders[0].pickup_code).not.toBe('000000');

      const activeCodes = await prisma.branchOrder.findMany({
        where: {
          branchId: branchAId,
          fulfilmentMethod: 'PICKUP',
          status: { notIn: ['COMPLETED', 'CANCELLED', 'REFUNDED'] },
        },
        select: { pickupCode: true },
      });
      const codeValues = activeCodes.map((c) => c.pickupCode);
      expect(new Set(codeValues).size).toBe(codeValues.length);
    });
  });

  // ============================================================
  // Codex review round 3 on commit 3d81c9b - fix #1: quote() must be
  // genuinely read-only - it must never lock a vendor row, persist the
  // lazy ACTIVE->EXPIRED subscription transition, or write an AuditLog
  // row just because someone previewed a cart.
  // ============================================================
  describe('quote() eligibility check is read-only (Codex review round 3, fix #1)', () => {
    it('rejects quote for a lapsed-trial vendor, but never mutates Vendor/VendorSubscription/AuditLog', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      // A lapsed trial that hasn't been lazily flipped yet -
      // Vendor.subscriptionStatus is still ACTIVE (as createOfferWithStock's
      // own makeVendorEligible() sets it), but the latest
      // VendorSubscription's periodEnd is already in the past.
      const subscription = await prisma.vendorSubscription.create({
        data: {
          vendorId,
          status: 'ACTIVE',
          periodStart: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
          periodEnd: new Date(Date.now() - 1000),
        },
      });
      const auditCountBefore = await prisma.auditLog.count({
        where: {
          entityType: 'VendorSubscription',
          action: 'vendor_subscription.expired',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set('Authorization', `Bearer ${customer}`)
        .send({ cart_item_ids: [itemId] });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ITEM_NOT_PURCHASABLE');

      const vendorAfter = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendorAfter.subscriptionStatus).toBe('ACTIVE');
      const subscriptionAfter =
        await prisma.vendorSubscription.findUniqueOrThrow({
          where: { id: subscription.id },
        });
      expect(subscriptionAfter.status).toBe('ACTIVE');
      const auditCountAfter = await prisma.auditLog.count({
        where: {
          entityType: 'VendorSubscription',
          action: 'vendor_subscription.expired',
        },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
    });
  });

  // ============================================================
  // Codex review round 3 on commit 3d81c9b - fix #2: eligibility's own
  // vendor-row locking (SubscriptionGateService.refreshStatus's FOR
  // UPDATE) must sort vendorIds canonically too, or a multi-VENDOR
  // checkout could deadlock against another one locking the same two
  // vendors in the opposite order - independent of the round-2 fix that
  // only covered stock/window locks within one vendor.
  // ============================================================
  describe('Multi-vendor eligibility locks in canonical order (Codex review round 3, fix #2)', () => {
    it('two concurrent multi-vendor checkouts submitted with reversed group order never deadlock or 500', async () => {
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const vendor1 = await createVendorWithTwoBranches(owner1);
      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const vendor2 = await createVendorWithTwoBranches(owner2);
      const variant1 = await createOfferWithStock(
        vendor1.vendorId,
        vendor1.branchAId,
        10,
        5,
      );
      const variant2 = await createOfferWithStock(
        vendor2.vendorId,
        vendor2.branchAId,
        10,
        5,
      );
      const customerX = await signup(uniquePhone(), 'a-strong-password');
      const customerY = await signup(uniquePhone(), 'a-strong-password');

      const itemX1 = await addToCart(customerX, vendor1.vendorId, variant1, 1);
      const itemX2 = await addToCart(customerX, vendor2.vendorId, variant2, 1);
      const itemY1 = await addToCart(customerY, vendor1.vendorId, variant1, 1);
      const itemY2 = await addToCart(customerY, vendor2.vendorId, variant2, 1);

      const groupFor = (branchId: string, itemId: string) => ({
        cart_item_ids: [itemId],
        branch_id: branchId,
        fulfilment_method: 'PICKUP' as const,
        payment_method: 'COD' as const,
      });

      const [resX, resY] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/checkout/reserve')
          .set('Authorization', `Bearer ${customerX}`)
          .set('Idempotency-Key', unique('reserve'))
          .send({
            groups: [
              groupFor(vendor1.branchAId, itemX1),
              groupFor(vendor2.branchAId, itemX2),
            ],
          }),
        request(app.getHttpServer())
          .post('/api/v1/checkout/reserve')
          .set('Authorization', `Bearer ${customerY}`)
          .set('Idempotency-Key', unique('reserve'))
          .send({
            groups: [
              groupFor(vendor2.branchAId, itemY2),
              groupFor(vendor1.branchAId, itemY1),
            ],
          }),
      ]);
      expect(resX.status).toBe(201);
      expect(resY.status).toBe(201);
    });
  });

  // ============================================================
  // Codex review round 3 on commit 3d81c9b - fix #3: consuming/
  // releasing a reservation's holds must be a single idempotent
  // transition, serialized on the CheckoutReservation row itself, so a
  // lazy sweep (lockAndSweepStockRow, triggered by an unrelated POS
  // movement) and an explicit cancel()/confirm() can never both
  // decrement the same reservedQuantity.
  // ============================================================
  describe('Reservation release is a single idempotent transition (Codex review round 3, fix #3)', () => {
    it('an expired reservation racing a POS sweep against an explicit cancel never double-releases or goes negative', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 2);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      await prisma.checkoutReservation.update({
        where: { id: reserved.body.reservation_id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const [posRes, cancelRes] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('movement'))
          .send({ quantity_delta: -1, reason: 'DAMAGE', reason_note: 'race' }),
        request(app.getHttpServer())
          .post(
            `/api/v1/checkout/reservations/${reserved.body.reservation_id}/cancel`,
          )
          .set('Authorization', `Bearer ${customer}`),
      ]);

      expect(posRes.status).toBe(201);
      expect(cancelRes.status).toBe(201);

      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { offerVariantId: variantId },
      });
      // The 2-unit hold is released EXACTLY once (never twice, never
      // left negative) regardless of which side won the race; the POS
      // movement separately took 1 real physical unit (5 -> 4).
      expect(stock.reservedQuantity).toBe(0);
      expect(stock.quantity).toBe(4);
    });

    it('confirm racing a concurrent cancel on the same live reservation never double-releases or 500s', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      const [confirmRes, cancelRes] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/checkout/confirm')
          .set('Authorization', `Bearer ${customer}`)
          .set('Idempotency-Key', unique('confirm'))
          .send({ reservation_id: reserved.body.reservation_id }),
        request(app.getHttpServer())
          .post(
            `/api/v1/checkout/reservations/${reserved.body.reservation_id}/cancel`,
          )
          .set('Authorization', `Bearer ${customer}`),
      ]);

      expect([confirmRes.status, cancelRes.status]).not.toContain(500);
      expect(cancelRes.status).toBe(201);
      // Exactly one side won: either confirm created the order (and
      // cancel's own lock-and-check correctly found nothing left to
      // release), or cancel released it first (and confirm correctly
      // reports the reservation gone) - never both "succeeding".
      if (confirmRes.status === 201) {
        expect(cancelRes.body.released).toBe(false);
      } else {
        expect(confirmRes.status).toBe(404);
        expect(cancelRes.body.released).toBe(true);
      }

      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { offerVariantId: variantId },
      });
      expect(stock.reservedQuantity).toBe(0);
    });
  });

  // ============================================================
  // Codex review round 3 on commit 3d81c9b - fix #4: every public
  // availability surface must subtract live reservedQuantity, not just
  // BranchStock.quantity - the last unit held by a live reservation
  // must never show as publicly available.
  // ============================================================
  describe('Public availability accounts for live reservations (Codex review round 3, fix #4)', () => {
    it('the last unit held by a live reservation shows sold_out publicly, and recovers after cancel releases it', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 1);
      const variant = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });

      const before = await request(app.getHttpServer())
        .get(
          `/api/v1/storefronts/${vendor.slug}/offers/${variant.vendorOfferId}`,
        )
        .expect(200);
      const beforeVariant = before.body.variants.find(
        (v: { id: string }) => v.id === variantId,
      );
      expect(beforeVariant.availability).not.toBe('sold_out');

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);
      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              cart_item_ids: [itemId],
              branch_id: branchAId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(201);

      const during = await request(app.getHttpServer())
        .get(
          `/api/v1/storefronts/${vendor.slug}/offers/${variant.vendorOfferId}`,
        )
        .expect(200);
      const duringVariant = during.body.variants.find(
        (v: { id: string }) => v.id === variantId,
      );
      expect(duringVariant.availability).toBe('sold_out');

      const duringSections = await request(app.getHttpServer())
        .get(`/api/v1/storefronts/${vendor.slug}/sections`)
        .expect(200);
      const duringOffer = duringSections.body.all.find(
        (o: { id: string }) => o.id === variant.vendorOfferId,
      );
      expect(duringOffer.availability).toBe('sold_out');

      await request(app.getHttpServer())
        .post(
          `/api/v1/checkout/reservations/${reserved.body.reservation_id}/cancel`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .expect(201);

      const after = await request(app.getHttpServer())
        .get(
          `/api/v1/storefronts/${vendor.slug}/offers/${variant.vendorOfferId}`,
        )
        .expect(200);
      const afterVariant = after.body.variants.find(
        (v: { id: string }) => v.id === variantId,
      );
      expect(afterVariant.availability).not.toBe('sold_out');
    });
  });
});
