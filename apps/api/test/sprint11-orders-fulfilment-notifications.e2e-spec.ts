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

let phoneSeq = (Date.now() % 1_000_000) + 300_000;
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

describe('Sprint 11 - Orders UI, fulfilment loop, notification dispatch (e2e)', () => {
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
        store_type: 'PHYSICAL',
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

  async function placePickupOrder(
    customer: string,
    vendorId: string,
    branchId: string,
    variantId: string,
  ): Promise<{ branchOrderId: string; pickupCode: string }> {
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
      branchOrderId: confirmed.body.branch_orders[0].id,
      pickupCode: confirmed.body.branch_orders[0].pickup_code,
    };
  }

  async function placeDeliveryOrder(
    owner: string,
    customer: string,
    vendorId: string,
    branchId: string,
    variantId: string,
  ): Promise<{ branchOrderId: string }> {
    const dow = dayOfWeekFor(1);
    const windowId = await createWindow(
      owner,
      vendorId,
      branchId,
      dow,
      '09:00',
      '18:00',
      5,
    );
    await setZoneFee(owner, vendorId, 'WEST_BANK', 10);
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
            branch_id: branchId,
            fulfilment_method: 'DELIVERY',
            payment_method: 'COD',
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
    return { branchOrderId: confirmed.body.branch_orders[0].id };
  }

  const staffAction = (
    token: string,
    vendorId: string,
    branchId: string,
    branchOrderId: string,
    action: string,
    body: Record<string, unknown> = {},
  ) =>
    request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/orders/${branchOrderId}/${action}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  // ============================================================
  // RB-ORD-005: customer Orders UI
  // ============================================================
  describe('Customer Orders UI (RB-ORD-005)', () => {
    it("lists the customer's own orders across vendors, one card per BranchOrder even within the same store", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId, branchBId } =
        await createVendorWithTwoBranches(owner);
      const variantA = await createOfferWithStock(vendorId, branchAId, 20, 5);
      const variantB = await createOfferWithStock(vendorId, branchBId, 15, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');

      const orderA = await placePickupOrder(
        customer,
        vendorId,
        branchAId,
        variantA,
      );
      const orderB = await placePickupOrder(
        customer,
        vendorId,
        branchBId,
        variantB,
      );

      const list = await request(app.getHttpServer())
        .get('/api/v1/customers/me/orders')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      expect(list.body).toHaveLength(2);
      const ids = list.body.map((o: { id: string }) => o.id).sort();
      expect(ids).toEqual([orderA.branchOrderId, orderB.branchOrderId].sort());
      // Both branch cards are distinct, never merged, even though they
      // share one vendor (PDR-026).
      const branchIds = list.body.map(
        (o: { branch_id: string }) => o.branch_id,
      );
      expect(new Set(branchIds).size).toBe(2);
    });

    it('exposes full order detail: items, price breakdown, fulfilment/payment method, and the reserved delivery window', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 30, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );

      const list = await request(app.getHttpServer())
        .get('/api/v1/customers/me/orders')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      const order = list.body.find(
        (o: { id: string }) => o.id === branchOrderId,
      );
      expect(order.items).toHaveLength(1);
      expect(order.items[0].quantity).toBe(1);
      expect(order.items[0].unit_price).toBe(30);
      expect(order.subtotal).toBe(30);
      expect(order.total).toBe(40);
      expect(order.fulfilment_method).toBe('DELIVERY');
      expect(order.payment_method).toBe('COD');
      expect(order.delivery_window).toBeTruthy();
      expect(order.address).toBeTruthy();
      expect(order.pickup_code).toBeNull();
    });

    it("BOLA: a customer cannot see another customer's order in their list or act on it directly", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customerA = await signup(uniquePhone(), 'a-strong-password');
      const customerB = await signup(uniquePhone(), 'a-strong-password');
      const orderA = await placePickupOrder(
        customerA,
        vendorId,
        branchAId,
        variantId,
      );

      const listB = await request(app.getHttpServer())
        .get('/api/v1/customers/me/orders')
        .set('Authorization', `Bearer ${customerB}`)
        .expect(200);
      expect(listB.body).toHaveLength(0);

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/customers/me/orders/${orderA.branchOrderId}/confirm-received`,
        )
        .set('Authorization', `Bearer ${customerB}`);
      expect(res.status).toBe(404);
    });
  });

  // ============================================================
  // RB-FUL-002: the fulfilment loop
  // ============================================================
  describe('Fulfilment loop - happy paths', () => {
    it('PICKUP: PLACED -> PREPARING -> pickup-handover (correct code) -> COMPLETED', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, pickupCode } = await placePickupOrder(
        customer,
        vendorId,
        branchAId,
        variantId,
      );

      const prep = await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      );
      expect(prep.status).toBe(201);
      expect(prep.body.status).toBe('PREPARING');

      const handover = await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'pickup-handover',
        { pickup_code: pickupCode },
      );
      expect(handover.status).toBe(201);
      expect(handover.body.status).toBe('COMPLETED');

      const final = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(final.status).toBe('COMPLETED');
    });

    it('DELIVERY: PLACED -> PREPARING -> SENT -> DELIVERED -> customer confirm-received -> COMPLETED', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );

      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-sent',
      ).expect(201);
      const delivered = await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-delivered',
      );
      expect(delivered.status).toBe(201);
      expect(delivered.body.status).toBe('DELIVERED');

      const afterDelivered = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(afterDelivered.deliveredAt).toBeTruthy();

      const confirmed = await request(app.getHttpServer())
        .post(`/api/v1/customers/me/orders/${branchOrderId}/confirm-received`)
        .set('Authorization', `Bearer ${customer}`)
        .expect(201);
      expect(confirmed.body.status).toBe('COMPLETED');
    });

    it('mark-delivered enqueues exactly one delivered_confirm_requested notification for the customer', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-sent',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-delivered',
      ).expect(201);

      const events = await prisma.outboxEvent.findMany({
        where: { eventType: 'branch_order.delivered_confirm_requested' },
      });
      const forThisOrder = events.filter(
        (e) =>
          (e.payload as { branch_order_id?: string }).branch_order_id ===
          branchOrderId,
      );
      expect(forThisOrder).toHaveLength(1);
    });

    it("a BRANCH_EMPLOYEE can drive the full loop for their own branch's order using only the employee DTO's own id/status/fulfilment_method fields", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const employeePhone = uniquePhone();
      const accepted = await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchAId,
        employeePhone,
        'employee-password',
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { pickupCode } = await placePickupOrder(
        customer,
        vendorId,
        branchAId,
        variantId,
      );

      const list = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/orders`)
        .set('Authorization', `Bearer ${accepted.session_token}`)
        .expect(200);
      const employeeOrder = list.body[0];
      expect(employeeOrder.id).toBeTruthy();
      expect(employeeOrder.status).toBe('PLACED');
      expect(employeeOrder.fulfilment_method).toBe('PICKUP');

      await staffAction(
        accepted.session_token,
        vendorId,
        branchAId,
        employeeOrder.id,
        'start-preparation',
      ).expect(201);
      const handover = await staffAction(
        accepted.session_token,
        vendorId,
        branchAId,
        employeeOrder.id,
        'pickup-handover',
        { pickup_code: pickupCode },
      );
      expect(handover.status).toBe(201);
      expect(handover.body.status).toBe('COMPLETED');
    });
  });

  // ============================================================
  // Invalid transitions
  // ============================================================
  describe('Invalid transitions are rejected, never silently applied', () => {
    it('rejects starting preparation twice', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placePickupOrder(
        customer,
        vendorId,
        branchAId,
        variantId,
      );

      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);
      const second = await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      );
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('INVALID_BRANCH_ORDER_TRANSITION');
    });

    it('rejects mark-sent on a PICKUP order', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placePickupOrder(
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);

      const res = await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-sent',
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_BRANCH_ORDER_TRANSITION');
    });

    it('rejects mark-delivered before mark-sent', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);

      const res = await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-delivered',
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_BRANCH_ORDER_TRANSITION');
    });

    it('rejects customer confirm-received on a PICKUP order', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placePickupOrder(
        customer,
        vendorId,
        branchAId,
        variantId,
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/customers/me/orders/${branchOrderId}/confirm-received`)
        .set('Authorization', `Bearer ${customer}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFIRM_NOT_APPLICABLE');
    });

    it('rejects customer confirm-received before the order is DELIVERED', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-sent',
      ).expect(201);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/customers/me/orders/${branchOrderId}/confirm-received`)
        .set('Authorization', `Bearer ${customer}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_BRANCH_ORDER_TRANSITION');
    });

    it('rejects pickup-handover on a DELIVERY order', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );

      const res = await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'pickup-handover',
        { pickup_code: '000000' },
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PICKUP_HANDOVER_NOT_APPLICABLE');
    });
  });

  // ============================================================
  // Pickup code correctness
  // ============================================================
  describe('Pickup handover code verification', () => {
    it('rejects a wrong pickup code and leaves the order in PREPARING', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, pickupCode } = await placePickupOrder(
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);

      const wrongCode = pickupCode === '000000' ? '111111' : '000000';
      const res = await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'pickup-handover',
        { pickup_code: wrongCode },
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('WRONG_PICKUP_CODE');

      const stillPreparing = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(stillPreparing.status).toBe('PREPARING');
    });

    it("rejects a DIFFERENT branch's own valid pickup code - codes never cross branch orders", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId, branchBId } =
        await createVendorWithTwoBranches(owner);
      const variantA = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const variantB = await createOfferWithStock(vendorId, branchBId, 10, 5);
      const customerA = await signup(uniquePhone(), 'a-strong-password');
      const customerB = await signup(uniquePhone(), 'a-strong-password');
      const orderA = await placePickupOrder(
        customerA,
        vendorId,
        branchAId,
        variantA,
      );
      const orderB = await placePickupOrder(
        customerB,
        vendorId,
        branchBId,
        variantB,
      );
      await staffAction(
        owner,
        vendorId,
        branchAId,
        orderA.branchOrderId,
        'start-preparation',
      ).expect(201);

      const res = await staffAction(
        owner,
        vendorId,
        branchAId,
        orderA.branchOrderId,
        'pickup-handover',
        { pickup_code: orderB.pickupCode },
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('WRONG_PICKUP_CODE');
    });

    it('validates the pickup_code format (must be exactly six digits)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placePickupOrder(
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);

      const res = await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'pickup-handover',
        { pickup_code: 'abc' },
      );
      expect(res.status).toBe(400);
    });
  });

  // ============================================================
  // BOLA: staff authorization
  // ============================================================
  describe('Staff authorization - no BOLA across branches or vendors', () => {
    it("a BRANCH_EMPLOYEE of branch A cannot act on branch B's order", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId, branchBId } =
        await createVendorWithTwoBranches(owner);
      const variantB = await createOfferWithStock(vendorId, branchBId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const orderB = await placePickupOrder(
        customer,
        vendorId,
        branchBId,
        variantB,
      );

      const employeePhone = uniquePhone();
      const accepted = await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchAId,
        employeePhone,
        'employee-password',
      );

      const res = await staffAction(
        accepted.session_token,
        vendorId,
        branchBId,
        orderB.branchOrderId,
        'start-preparation',
      );
      expect(res.status).toBe(403);
    });

    it("BOLA: an owner's own vendorId/branchId route cannot be used to reach a DIFFERENT vendor's branch order by id", async () => {
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const vendor1 = await createVendorWithTwoBranches(owner1);
      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const vendor2 = await createVendorWithTwoBranches(owner2);
      const variant2 = await createOfferWithStock(
        vendor2.vendorId,
        vendor2.branchAId,
        10,
        5,
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const orderVendor2 = await placePickupOrder(
        customer,
        vendor2.vendorId,
        vendor2.branchAId,
        variant2,
      );

      // owner1 calling their OWN vendor/branch route, but with vendor2's
      // real branchOrderId - must 404, not silently act on it.
      const res = await staffAction(
        owner1,
        vendor1.vendorId,
        vendor1.branchAId,
        orderVendor2.branchOrderId,
        'start-preparation',
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('BRANCH_ORDER_NOT_FOUND');

      const stillPlaced = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: orderVendor2.branchOrderId },
      });
      expect(stillPlaced.status).toBe('PLACED');
    });

    it('never leaks the delivery address to staff (owner or employee) - a DELIVERY order specifically', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const employeePhone = uniquePhone();
      const accepted = await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchAId,
        employeePhone,
        'employee-password',
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await placeDeliveryOrder(owner, customer, vendorId, branchAId, variantId);

      const ownerList = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/orders`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(ownerList.body[0]).not.toHaveProperty('address');

      const employeeList = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/orders`)
        .set('Authorization', `Bearer ${accepted.session_token}`)
        .expect(200);
      expect(employeeList.body[0]).not.toHaveProperty('address');
      expect(employeeList.body[0]).not.toHaveProperty('total');
      expect(employeeList.body[0]).not.toHaveProperty('payment_method');
      expect(employeeList.body[0]).not.toHaveProperty('created_at');
      // id/status/fulfilment_method/has_open_not_received_report are
      // legitimately present for the employee now - see
      // employeeOrderDto's own comment.
      expect(Object.keys(employeeList.body[0]).sort()).toEqual(
        [
          'id',
          'status',
          'fulfilment_method',
          'customer_name',
          'customer_phone',
          'pickup_code',
          'has_open_not_received_report',
        ].sort(),
      );
    });
  });

  // ============================================================
  // Customer-confirm vs auto-confirm race, and no duplicate
  // reminder/outbox events under concurrency.
  // ============================================================
  describe('Reconciliation: customer-confirm vs auto-confirm, and no duplicates under concurrency', () => {
    async function deliverAndBackdate(
      owner: string,
      vendorId: string,
      branchId: string,
      branchOrderId: string,
      hoursAgo: number,
    ): Promise<void> {
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
        'mark-sent',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchId,
        branchOrderId,
        'mark-delivered',
      ).expect(201);
      await prisma.branchOrder.update({
        where: { id: branchOrderId },
        data: { deliveredAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000) },
      });
    }

    it('a customer confirm racing the lazy auto-confirm sweep never double-completes or 500s', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await deliverAndBackdate(owner, vendorId, branchAId, branchOrderId, 80);

      const [confirmRes, listRes] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/customers/me/orders/${branchOrderId}/confirm-received`)
          .set('Authorization', `Bearer ${customer}`),
        request(app.getHttpServer())
          .get('/api/v1/customers/me/orders')
          .set('Authorization', `Bearer ${customer}`),
      ]);

      expect([confirmRes.status, listRes.status]).not.toContain(500);
      expect(listRes.status).toBe(200);

      const final = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(final.status).toBe('COMPLETED');

      // Exactly one completion audit row - never two.
      const completions = await prisma.auditLog.count({
        where: {
          entityType: 'BranchOrder',
          entityId: branchOrderId,
          action: 'branch_order.status_changed',
        },
      });
      // PLACED->PREPARING, PREPARING->SENT, SENT->DELIVERED, and
      // exactly ONE final ...->COMPLETED (never two).
      expect(completions).toBe(4);
    });

    it('never sends the 48h reminder twice under concurrent reconciliation sweeps', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await deliverAndBackdate(owner, vendorId, branchAId, branchOrderId, 50);

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .get('/api/v1/customers/me/orders')
          .set('Authorization', `Bearer ${customer}`),
        request(app.getHttpServer())
          .get('/api/v1/customers/me/orders')
          .set('Authorization', `Bearer ${customer}`),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);

      const events = await prisma.outboxEvent.findMany({
        where: { eventType: 'branch_order.confirm_reminder_48h' },
      });
      const forThisOrder = events.filter(
        (e) =>
          (e.payload as { branch_order_id?: string }).branch_order_id ===
          branchOrderId,
      );
      expect(forThisOrder).toHaveLength(1);

      const order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.confirmReminderSentAt).toBeTruthy();
      expect(order.status).toBe('DELIVERED');
    });
  });

  // ============================================================
  // "Not received" report + external contact, no dispute ticket
  // ============================================================
  describe('"Not received" report (PDR-026)', () => {
    it('requires a reason', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-sent',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-delivered',
      ).expect(201);

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/customers/me/orders/${branchOrderId}/report-not-received`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('rejects a whitespace-only reason (backend-enforced, not just the frontend) and creates no report, AuditLog, or Outbox event', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-sent',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-delivered',
      ).expect(201);

      const auditCountBefore = await prisma.auditLog.count({
        where: {
          entityType: 'BranchOrder',
          entityId: branchOrderId,
          action: 'branch_order.not_received_reported',
        },
      });
      const outboxCountBefore = await prisma.outboxEvent.count({
        where: { eventType: 'branch_order.not_received_reported' },
      });

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/customers/me/orders/${branchOrderId}/report-not-received`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .send({ reason: '   ' });
      expect(res.status).toBe(400);

      const order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.notReceivedReportedAt).toBeNull();
      expect(order.notReceivedReason).toBeNull();

      const auditCountAfter = await prisma.auditLog.count({
        where: {
          entityType: 'BranchOrder',
          entityId: branchOrderId,
          action: 'branch_order.not_received_reported',
        },
      });
      const outboxCountAfter = await prisma.outboxEvent.count({
        where: { eventType: 'branch_order.not_received_reported' },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
      expect(outboxCountAfter).toBe(outboxCountBefore);
    });

    it('rejects reporting on an order that is not DELIVERED/DELIVERY', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placePickupOrder(
        customer,
        vendorId,
        branchAId,
        variantId,
      );

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/customers/me/orders/${branchOrderId}/report-not-received`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .send({ reason: 'never arrived' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REPORT_NOT_APPLICABLE');
    });

    it('records the reason, freezes the reminder/auto-confirm clock, and notifies the owner exactly once - a second report is a benign replay', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-sent',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-delivered',
      ).expect(201);
      // Backdate well past 72h - if the report did NOT freeze the
      // clock, a subsequent list read would auto-confirm it.
      await prisma.branchOrder.update({
        where: { id: branchOrderId },
        data: { deliveredAt: new Date(Date.now() - 200 * 60 * 60 * 1000) },
      });

      const first = await request(app.getHttpServer())
        .post(
          `/api/v1/customers/me/orders/${branchOrderId}/report-not-received`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .send({ reason: 'the courier never came' })
        .expect(201);
      expect(first.body.already_reported).toBe(false);

      // Sweep-triggering read - must NOT auto-confirm despite being
      // far past 72h, because the report is open.
      await request(app.getHttpServer())
        .get('/api/v1/customers/me/orders')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      const frozen = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(frozen.status).toBe('DELIVERED');
      expect(frozen.notReceivedReason).toBe('the courier never came');

      const second = await request(app.getHttpServer())
        .post(
          `/api/v1/customers/me/orders/${branchOrderId}/report-not-received`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .send({ reason: 'still nothing' })
        .expect(201);
      expect(second.body.already_reported).toBe(true);

      const events = await prisma.outboxEvent.findMany({
        where: { eventType: 'branch_order.not_received_reported' },
      });
      const forThisOrder = events.filter(
        (e) =>
          (e.payload as { branch_order_id?: string }).branch_order_id ===
          branchOrderId,
      );
      expect(forThisOrder).toHaveLength(1);
      expect(
        (forThisOrder[0].payload as { recipient_user_id: string })
          .recipient_user_id,
      ).toBeTruthy();
    });

    it('staff rerequest-confirmation clears the report, restarts the clock, and re-notifies the customer; a second call without an open report is rejected', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-sent',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-delivered',
      ).expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/customers/me/orders/${branchOrderId}/report-not-received`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .send({ reason: 'missing package' })
        .expect(201);

      const rerequest = await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'rerequest-confirmation',
      );
      expect(rerequest.status).toBe(201);

      const resolved = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(resolved.notReceivedReportedAt).toBeNull();
      expect(resolved.notReceivedReason).toBeNull();
      expect(resolved.confirmReminderSentAt).toBeNull();
      expect(resolved.deliveredAt).toBeTruthy();

      const events = await prisma.outboxEvent.findMany({
        where: { eventType: 'branch_order.confirm_rerequested' },
      });
      expect(
        events.some(
          (e) =>
            (e.payload as { branch_order_id?: string }).branch_order_id ===
            branchOrderId,
        ),
      ).toBe(true);

      const second = await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'rerequest-confirmation',
      );
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('NO_PENDING_NOT_RECEIVED_REPORT');
    });

    it("the employee DTO's has_open_not_received_report toggles true only while a report is open, and never carries the reason/timestamp", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const variantId = await createOfferWithStock(vendorId, branchAId, 10, 5);
      const employeePhone = uniquePhone();
      const accepted = await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchAId,
        employeePhone,
        'employee-password',
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'start-preparation',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-sent',
      ).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'mark-delivered',
      ).expect(201);

      const beforeReport = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/orders`)
        .set('Authorization', `Bearer ${accepted.session_token}`)
        .expect(200);
      const beforeOrder = beforeReport.body.find(
        (o: { id: string }) => o.id === branchOrderId,
      );
      expect(beforeOrder.has_open_not_received_report).toBe(false);
      expect(beforeOrder).not.toHaveProperty('not_received_reported_at');
      expect(beforeOrder).not.toHaveProperty('not_received_reason');

      await request(app.getHttpServer())
        .post(
          `/api/v1/customers/me/orders/${branchOrderId}/report-not-received`,
        )
        .set('Authorization', `Bearer ${customer}`)
        .send({ reason: 'courier never showed up' })
        .expect(201);

      const duringReport = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/orders`)
        .set('Authorization', `Bearer ${accepted.session_token}`)
        .expect(200);
      const duringOrder = duringReport.body.find(
        (o: { id: string }) => o.id === branchOrderId,
      );
      expect(duringOrder.has_open_not_received_report).toBe(true);
      expect(duringOrder).not.toHaveProperty('not_received_reported_at');
      expect(duringOrder).not.toHaveProperty('not_received_reason');

      await staffAction(
        owner,
        vendorId,
        branchAId,
        branchOrderId,
        'rerequest-confirmation',
      ).expect(201);

      const afterResolve = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/orders`)
        .set('Authorization', `Bearer ${accepted.session_token}`)
        .expect(200);
      const afterOrder = afterResolve.body.find(
        (o: { id: string }) => o.id === branchOrderId,
      );
      expect(afterOrder.has_open_not_received_report).toBe(false);
    });
  });
});
