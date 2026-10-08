import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { FulfilmentExceptionSweepService } from './../src/orders/fulfilment-exception-sweep.service';
import { createUniquePhone } from './helpers/e2e-phone-lanes';

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

// Fixed, disjoint lane - see ./helpers/e2e-phone-lanes.ts.
const uniquePhone = createUniquePhone('sprint20a-fulfilment-exceptions', '56');
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

const REASON = 'A real, 10+ character cancellation reason for this test.';

describe('Sprint 20a - fulfilment exceptions: cancellation, reschedule, refund (e2e)', () => {
  let app: INestApplication | undefined;
  let fakeSms: FakeSmsService;
  let prisma: PrismaService;
  let sweep: FulfilmentExceptionSweepService;

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
    sweep = app.get(FulfilmentExceptionSweepService);
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

  async function platformAdmin(): Promise<string> {
    const phone = uniquePhone();
    const token = await signup(phone, 'a-strong-password');
    await prisma.user.update({
      where: { phone },
      data: { platformRole: 'PLATFORM_ADMIN' },
    });
    return token;
  }

  async function createVendorWithBranch(
    ownerToken: string,
  ): Promise<{ vendorId: string; branchId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        store_type: 'PHYSICAL',
        branches: [{ name: 'Branch A', is_physical: true }],
        applicable_categories: ['WOMEN'],
      })
      .expect(201);
    return { vendorId: res.body.id, branchId: res.body.branches[0].id };
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

  /** Places a DELIVERY BranchOrder with 1 or 2 items, any payment
   * method, returning enough to drive every S20a action on it. */
  async function placeDeliveryOrder(
    owner: string,
    customer: string,
    vendorId: string,
    branchId: string,
    variantIds: string[],
    paymentMethod: 'COD' | 'ONLINE',
    opts: { daysAhead?: number; capacity?: number; windowId?: string } = {},
  ): Promise<{
    branchOrderId: string;
    deliveryWindowId: string;
    scheduledDate: string;
    itemIds: string[];
  }> {
    const daysAhead = opts.daysAhead ?? 1;
    const dow = dayOfWeekFor(daysAhead);
    // A caller that already created its own window for this exact
    // (branch, day-of-week) slot (e.g. to control capacity precisely)
    // passes it here - creating a SECOND window on the same day/time
    // range would otherwise collide with DeliveryWindow's own
    // non-overlapping EXCLUDE constraint.
    const windowId =
      opts.windowId ??
      (await createWindow(
        owner,
        vendorId,
        branchId,
        dow,
        '09:00',
        '18:00',
        opts.capacity ?? 5,
      ));
    await setZoneFee(owner, vendorId, 'WEST_BANK', 10);
    const addressId = await createAddress(customer, 'WEST_BANK');
    const cartItemIds = await Promise.all(
      variantIds.map((v) => addToCart(customer, vendorId, v, 1)),
    );
    const reserved = await request(app.getHttpServer())
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
            fulfilment_method: 'DELIVERY',
            payment_method: paymentMethod,
            address_id: addressId,
            delivery_window_id: windowId,
            scheduled_date: nextDateForDayOfWeek(daysAhead),
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
    const branchOrderId = confirmed.body.branch_orders[0].id as string;
    const items = await prisma.branchOrderItem.findMany({
      where: { branchOrderId },
      orderBy: { id: 'asc' },
    });
    return {
      branchOrderId,
      deliveryWindowId: windowId,
      scheduledDate: nextDateForDayOfWeek(daysAhead),
      itemIds: items.map((i) => i.id),
    };
  }

  const customerAction = (
    token: string,
    branchOrderId: string,
    action: string,
    body: Record<string, unknown> = {},
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/customers/me/orders/${branchOrderId}/${action}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('customer-action'))
      .send(body);

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
      .set('Idempotency-Key', unique('staff-action'))
      .send(body);

  const adminAction = (
    token: string,
    branchOrderId: string,
    action: string,
    body: Record<string, unknown> = {},
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/branch-orders/${branchOrderId}/${action}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('admin-action'))
      .send(body);

  // ============================================================
  // PDR-028: cancellation - whole order vs single item, COD vs ONLINE
  // ============================================================
  describe('Cancellation (PDR-028)', () => {
    it('customer cancels a whole COD order while PLACED: items cancelled, stock released, no refund rows, CANCELLED', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
      );

      const res = await customerAction(
        customer,
        branchOrderId,
        'cancel',
      ).expect(201);
      expect(res.body.order_closed).toBe(true);
      expect(res.body.refunded_amount).toBe(0);

      const order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.status).toBe('CANCELLED');

      const refunds = await prisma.branchOrderRefund.findMany({
        where: { branchOrderId },
      });
      expect(refunds).toHaveLength(0);

      // quantity was permanently decremented at checkout confirm -
      // cancelling must restore it back to the original 5 (never
      // touching reservedQuantity, which checkout already released at
      // confirm time).
      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { vendorId, branchId, offerVariantId: variantId },
      });
      expect(stock.quantity).toBe(5);
      expect(stock.reservedQuantity).toBe(0);

      const events = await prisma.outboxEvent.findMany({
        where: { eventType: 'branch_order.cancelled' },
      });
      expect(
        events.some(
          (e) =>
            (e.payload as { branch_order_id?: string }).branch_order_id ===
            branchOrderId,
        ),
      ).toBe(true);
    });

    it('customer cancels a whole ONLINE order while PLACED: every item + the delivery fee refunded, REFUNDED', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'ONLINE',
      );

      const res = await customerAction(
        customer,
        branchOrderId,
        'cancel',
      ).expect(201);
      expect(res.body.order_closed).toBe(true);
      expect(res.body.refunded_amount).toBe(30); // 20 item + 10 delivery fee

      const order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.status).toBe('REFUNDED');
      // Immutable originals, never rewritten.
      expect(Number(order.total)).toBe(30);
      expect(Number(order.subtotal)).toBe(20);

      const refunds = await prisma.branchOrderRefund.findMany({
        where: { branchOrderId },
      });
      expect(refunds).toHaveLength(2); // 1 item + 1 delivery fee
      expect(refunds.map((r) => r.reason).sort()).toEqual(
        ['DELIVERY_FEE', 'ITEM_CANCELLED'].sort(),
      );
    });

    it('cancelling ONE of two items leaves BranchOrder.status untouched; cancelling the last item closes the order', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantA = await createOfferWithStock(vendorId, branchId, 20, 5);
      const variantB = await createOfferWithStock(vendorId, branchId, 15, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemIds } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantA, variantB],
        'ONLINE',
      );
      expect(itemIds).toHaveLength(2);

      const first = await customerAction(
        customer,
        branchOrderId,
        `items/${itemIds[0]}/cancel`,
      ).expect(201);
      expect(first.body.order_closed).toBe(false);

      const midOrder = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      // The whole-order status is COMPLETELY untouched - still PLACED,
      // never any intermediate "partially cancelled" status.
      expect(midOrder.status).toBe('PLACED');
      const otherItem = await prisma.branchOrderItem.findUniqueOrThrow({
        where: { id: itemIds[1] },
      });
      expect(otherItem.cancelledAt).toBeNull();

      const second = await customerAction(
        customer,
        branchOrderId,
        `items/${itemIds[1]}/cancel`,
      ).expect(201);
      expect(second.body.order_closed).toBe(true);

      const finalOrder = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(finalOrder.status).toBe('REFUNDED');
      const refunds = await prisma.branchOrderRefund.findMany({
        where: { branchOrderId },
      });
      // 2 items + exactly 1 delivery fee (not 2 - only charged once at
      // the moment the LAST item closes the order).
      expect(refunds).toHaveLength(3);
      expect(refunds.filter((r) => r.reason === 'DELIVERY_FEE')).toHaveLength(
        1,
      );
    });

    it('staff cancel while PREPARING requires a reason; while PLACED it does not', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
      );
      await staffAction(
        owner,
        vendorId,
        branchId,
        branchOrderId,
        'start-preparation',
      ).expect(201);

      const noReason = await staffAction(
        owner,
        vendorId,
        branchId,
        branchOrderId,
        'cancel',
      );
      expect(noReason.status).toBe(409);
      expect(noReason.body.error.code).toBe('CANCELLATION_REASON_REQUIRED');

      const withReason = await staffAction(
        owner,
        vendorId,
        branchId,
        branchOrderId,
        'cancel',
        { reason: REASON },
      );
      expect(withReason.status).toBe(201);
    });
  });

  // ============================================================
  // Refund ledger DB-level invariants - a real partial unique index,
  // not just application logic.
  // ============================================================
  describe('Refund ledger DB-level invariants', () => {
    async function seedOnlineOrder(): Promise<{
      branchOrderId: string;
      itemId: string;
      paymentTransactionId: string;
    }> {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId, itemIds } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'ONLINE',
      );
      const order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      return {
        branchOrderId,
        itemId: itemIds[0],
        paymentTransactionId: order.paymentTransactionId!,
      };
    }

    it('rejects a second refund row for the same item (plain unique constraint)', async () => {
      const { branchOrderId, itemId, paymentTransactionId } =
        await seedOnlineOrder();
      await prisma.branchOrderRefund.create({
        data: {
          branchOrderId,
          branchOrderItemId: itemId,
          paymentTransactionId,
          amount: '20.00',
          reason: 'ITEM_CANCELLED',
          initiatedBy: 'SYSTEM',
        },
      });
      await expect(
        prisma.branchOrderRefund.create({
          data: {
            branchOrderId,
            branchOrderItemId: itemId,
            paymentTransactionId,
            amount: '20.00',
            reason: 'ITEM_CANCELLED',
            initiatedBy: 'SYSTEM',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('rejects a second DELIVERY_FEE refund row for the same order (hand-written partial unique index)', async () => {
      const { branchOrderId, paymentTransactionId } = await seedOnlineOrder();
      await prisma.branchOrderRefund.create({
        data: {
          branchOrderId,
          branchOrderItemId: null,
          paymentTransactionId,
          amount: '10.00',
          reason: 'DELIVERY_FEE',
          initiatedBy: 'SYSTEM',
        },
      });
      await expect(
        prisma.branchOrderRefund.create({
          data: {
            branchOrderId,
            branchOrderItemId: null,
            paymentTransactionId,
            amount: '10.00',
            reason: 'DELIVERY_FEE',
            initiatedBy: 'SYSTEM',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('allows a DELIVERY_FEE refund row for two DIFFERENT orders (index is scoped per order, not global)', async () => {
      const first = await seedOnlineOrder();
      const second = await seedOnlineOrder();
      await prisma.branchOrderRefund.create({
        data: {
          branchOrderId: first.branchOrderId,
          branchOrderItemId: null,
          paymentTransactionId: first.paymentTransactionId,
          amount: '10.00',
          reason: 'DELIVERY_FEE',
          initiatedBy: 'SYSTEM',
        },
      });
      await expect(
        prisma.branchOrderRefund.create({
          data: {
            branchOrderId: second.branchOrderId,
            branchOrderItemId: null,
            paymentTransactionId: second.paymentTransactionId,
            amount: '10.00',
            reason: 'DELIVERY_FEE',
            initiatedBy: 'SYSTEM',
          },
        }),
      ).resolves.toBeTruthy();
    });
  });

  // ============================================================
  // Reschedule - BOLA, capacity, success, and a real concurrency race.
  // ============================================================
  describe('Reschedule (PDR-025/027)', () => {
    async function markSlotMissed(branchOrderId: string): Promise<void> {
      await prisma.branchOrder.update({
        where: { id: branchOrderId },
        data: { slotMissedAt: new Date() },
      });
    }

    it('404s (BOLA) when the target window belongs to a different branch', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
      );
      await markSlotMissed(branchOrderId);

      // A second, unrelated vendor/branch's own window.
      const otherOwner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: otherVendorId, branchId: otherBranchId } =
        await createVendorWithBranch(otherOwner);
      const foreignWindowId = await createWindow(
        otherOwner,
        otherVendorId,
        otherBranchId,
        dayOfWeekFor(1),
        '09:00',
        '18:00',
        5,
      );

      const res = await customerAction(customer, branchOrderId, 'reschedule', {
        delivery_window_id: foreignWindowId,
        scheduled_date: nextDateForDayOfWeek(1),
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('DELIVERY_WINDOW_NOT_FOUND');
    });

    it('409s when the target slot is already at capacity', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
        { daysAhead: 1, capacity: 5 },
      );
      await markSlotMissed(branchOrderId);

      // A second, full-capacity (1) window on a different day to
      // reschedule into.
      const fullDow = dayOfWeekFor(2);
      const fullWindowId = await createWindow(
        owner,
        vendorId,
        branchId,
        fullDow,
        '09:00',
        '18:00',
        1,
      );
      // Occupy the only slot with another order, in the SAME window
      // (never a second one on the same day/time - see
      // placeDeliveryOrder's own comment on opts.windowId).
      const otherCustomer = await signup(uniquePhone(), 'a-strong-password');
      await placeDeliveryOrder(
        owner,
        otherCustomer,
        vendorId,
        branchId,
        [variantId],
        'COD',
        { daysAhead: 2, windowId: fullWindowId },
      );

      const res = await customerAction(customer, branchOrderId, 'reschedule', {
        delivery_window_id: fullWindowId,
        scheduled_date: nextDateForDayOfWeek(2),
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SLOT_CAPACITY_EXCEEDED');
    });

    it('succeeds and clears slotMissedAt/deliveryFailedAt, re-arming the prep reminder for the new slot', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
        { daysAhead: 1 },
      );
      await markSlotMissed(branchOrderId);
      await prisma.branchOrder.update({
        where: { id: branchOrderId },
        data: {
          prepReminderSentForWindowId: 'stale-window',
          prepReminderSentForDate: new Date(nextDateForDayOfWeek(1)),
        },
      });

      const newDow = dayOfWeekFor(2);
      const newWindowId = await createWindow(
        owner,
        vendorId,
        branchId,
        newDow,
        '09:00',
        '18:00',
        5,
      );
      const res = await customerAction(customer, branchOrderId, 'reschedule', {
        delivery_window_id: newWindowId,
        scheduled_date: nextDateForDayOfWeek(2),
      });
      expect(res.status).toBe(201);
      expect(res.body.delivery_window_id).toBe(newWindowId);

      const order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.slotMissedAt).toBeNull();
      expect(order.deliveryFailedAt).toBeNull();
      expect(order.deliveryWindowId).toBe(newWindowId);
      // Stale dedup key from the OLD slot stays as-is (it is simply no
      // longer equal to the order's current window/date, so the sweep
      // will treat the new slot as needing its own fresh reminder).
      expect(order.prepReminderSentForWindowId).toBe('stale-window');
    });

    it('under a race for the LAST slot, exactly one of two concurrent reschedules succeeds', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);

      const customerA = await signup(uniquePhone(), 'a-strong-password');
      const customerB = await signup(uniquePhone(), 'a-strong-password');
      const orderA = await placeDeliveryOrder(
        owner,
        customerA,
        vendorId,
        branchId,
        [variantId],
        'COD',
        { daysAhead: 1 },
      );
      // Same origin window as orderA (capacity 5 easily fits both) -
      // never a second window on the same day/time, which would
      // collide with DeliveryWindow's own non-overlapping constraint.
      const orderB = await placeDeliveryOrder(
        owner,
        customerB,
        vendorId,
        branchId,
        [variantId],
        'COD',
        { daysAhead: 1, windowId: orderA.deliveryWindowId },
      );
      await markSlotMissed(orderA.branchOrderId);
      await markSlotMissed(orderB.branchOrderId);

      // Exactly ONE free slot for both to race over - day 2, the
      // furthest day the reschedule service's own 3-day window
      // (diffDays 0-2) still allows.
      const targetDow = dayOfWeekFor(2);
      const targetWindowId = await createWindow(
        owner,
        vendorId,
        branchId,
        targetDow,
        '09:00',
        '18:00',
        1,
      );
      const targetDate = nextDateForDayOfWeek(2);

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/api/v1/customers/me/orders/${orderA.branchOrderId}/reschedule`,
          )
          .set('Authorization', `Bearer ${customerA}`)
          .set('Idempotency-Key', unique('reschedule-race'))
          .send({
            delivery_window_id: targetWindowId,
            scheduled_date: targetDate,
          }),
        request(app.getHttpServer())
          .post(
            `/api/v1/customers/me/orders/${orderB.branchOrderId}/reschedule`,
          )
          .set('Authorization', `Bearer ${customerB}`)
          .set('Idempotency-Key', unique('reschedule-race'))
          .send({
            delivery_window_id: targetWindowId,
            scheduled_date: targetDate,
          }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const winner = (resA.status === 201 ? orderA : orderB).branchOrderId;
      const loser = (resA.status === 201 ? orderB : orderA).branchOrderId;
      const winnerOrder = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: winner },
      });
      const loserOrder = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: loser },
      });
      expect(winnerOrder.deliveryWindowId).toBe(targetWindowId);
      expect(loserOrder.deliveryWindowId).not.toBe(targetWindowId);
    });
  });

  // ============================================================
  // PDR-027: deliveryAttemptCount boundary, COD vs ONLINE second
  // failure, request-refund/approve-refund.
  // ============================================================
  describe('Delivery failure (PDR-027)', () => {
    async function toSent(
      owner: string,
      vendorId: string,
      branchId: string,
      branchOrderId: string,
    ) {
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
    }

    it('COD: 0 -> 1 (DELIVERY_FAILED) -> reschedule back to SENT -> 2 (CANCELLED, items released, no refund)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
        { daysAhead: 1 },
      );
      await toSent(owner, vendorId, branchId, branchOrderId);

      let order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.deliveryAttemptCount).toBe(0);

      const fail1 = await staffAction(
        owner,
        vendorId,
        branchId,
        branchOrderId,
        'mark-delivery-failed',
      );
      expect(fail1.status).toBe(201);
      expect(fail1.body.status).toBe('DELIVERY_FAILED');
      order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.deliveryAttemptCount).toBe(1);

      const newWindowId = await createWindow(
        owner,
        vendorId,
        branchId,
        dayOfWeekFor(2),
        '09:00',
        '18:00',
        5,
      );
      const resched = await customerAction(
        customer,
        branchOrderId,
        'reschedule',
        {
          delivery_window_id: newWindowId,
          scheduled_date: nextDateForDayOfWeek(2),
        },
      );
      expect(resched.status).toBe(201);
      order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.status).toBe('SENT');
      expect(order.deliveryAttemptCount).toBe(1);

      const fail2 = await staffAction(
        owner,
        vendorId,
        branchId,
        branchOrderId,
        'mark-delivery-failed',
      );
      expect(fail2.status).toBe(201);
      expect(fail2.body.status).toBe('CANCELLED');
      order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.deliveryAttemptCount).toBe(2);
      expect(order.status).toBe('CANCELLED');

      const item = await prisma.branchOrderItem.findFirstOrThrow({
        where: { branchOrderId },
      });
      expect(item.cancelledAt).toBeTruthy();
      const refunds = await prisma.branchOrderRefund.findMany({
        where: { branchOrderId },
      });
      expect(refunds).toHaveLength(0); // COD - nothing was ever charged
      const stock = await prisma.branchStock.findFirstOrThrow({
        where: { vendorId, branchId, offerVariantId: variantId },
      });
      expect(stock.quantity).toBe(5);
      expect(stock.reservedQuantity).toBe(0);
    });

    it('ONLINE: second failure rests at DELIVERY_FAILED(count=2); customer requests refund; staff approves it', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'ONLINE',
        { daysAhead: 1 },
      );
      await toSent(owner, vendorId, branchId, branchOrderId);
      await staffAction(
        owner,
        vendorId,
        branchId,
        branchOrderId,
        'mark-delivery-failed',
      ).expect(201);

      // Can't reschedule twice with the same slot/window pair that's
      // already past - just force the count to 1 and status back to
      // SENT via a direct reschedule, matching the COD test's shape.
      const midWindowId = await createWindow(
        owner,
        vendorId,
        branchId,
        dayOfWeekFor(2),
        '09:00',
        '18:00',
        5,
      );
      await customerAction(customer, branchOrderId, 'reschedule', {
        delivery_window_id: midWindowId,
        scheduled_date: nextDateForDayOfWeek(2),
      }).expect(201);

      const fail2 = await staffAction(
        owner,
        vendorId,
        branchId,
        branchOrderId,
        'mark-delivery-failed',
      );
      expect(fail2.status).toBe(201);
      expect(fail2.body.status).toBe('DELIVERY_FAILED');
      let order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.deliveryAttemptCount).toBe(2);
      expect(order.status).toBe('DELIVERY_FAILED');
      // No refund/stock change yet - still just resting, awaiting the
      // customer's own explicit request.
      expect(
        await prisma.branchOrderRefund.count({ where: { branchOrderId } }),
      ).toBe(0);

      // Rescheduling is now closed - attempt count is already 2.
      const closedReschedule = await customerAction(
        customer,
        branchOrderId,
        'reschedule',
        {
          delivery_window_id: midWindowId,
          scheduled_date: nextDateForDayOfWeek(2),
        },
      );
      expect(closedReschedule.status).toBe(409);
      expect(closedReschedule.body.error.code).toBe('RESCHEDULE_WINDOW_CLOSED');

      const requestRefund = await customerAction(
        customer,
        branchOrderId,
        'request-refund',
      );
      expect(requestRefund.status).toBe(201);
      expect(requestRefund.body.status).toBe('REFUND_REQUESTED');

      const approve = await staffAction(
        owner,
        vendorId,
        branchId,
        branchOrderId,
        'approve-refund',
      );
      expect(approve.status).toBe(201);
      expect(approve.body.order_closed).toBe(true);
      expect(approve.body.refunded_amount).toBe(30);

      order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.status).toBe('REFUNDED');
      const refunds = await prisma.branchOrderRefund.findMany({
        where: { branchOrderId },
      });
      expect(refunds).toHaveLength(2);
      expect(
        refunds.every(
          (r) =>
            r.reason === 'DELIVERY_FAILED_TWICE' || r.reason === 'DELIVERY_FEE',
        ),
      ).toBe(true);
    });

    it('rejects a refund request before count reaches 2, and for a COD order', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'ONLINE',
        { daysAhead: 1 },
      );
      await toSent(owner, vendorId, branchId, branchOrderId);
      await staffAction(
        owner,
        vendorId,
        branchId,
        branchOrderId,
        'mark-delivery-failed',
      ).expect(201); // count = 1

      const tooEarly = await customerAction(
        customer,
        branchOrderId,
        'request-refund',
      );
      expect(tooEarly.status).toBe(409);
      expect(tooEarly.body.error.code).toBe('REFUND_REQUEST_NOT_APPLICABLE');
    });
  });

  // ============================================================
  // COD collection, folded into mark-delivered/pickup-handover.
  // ============================================================
  describe('COD collection recording (FR-PAY-001/FR-FUL-012)', () => {
    it('records the server-computed amount due atomically with mark-delivered, and Idempotency-Key replay never double-processes', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
        { daysAhead: 1 },
      );
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

      const key = unique('mark-delivered');
      const first = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/orders/${branchOrderId}/mark-delivered`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .send({})
        .expect(201);

      const order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(Number(order.codCollectedAmount)).toBe(30); // 20 item + 10 fee
      expect(order.codCollectedAt).toBeTruthy();

      // Replay with the SAME Idempotency-Key - must return the same
      // completed result, never a second status transition attempt.
      const replay = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/orders/${branchOrderId}/mark-delivered`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .send({});
      expect(replay.status).toBe(first.status);
      expect(replay.body).toEqual(first.body);
    });
  });

  // ============================================================
  // PLATFORM_ADMIN overrides (BR-019).
  // ============================================================
  // ============================================================
  // Review-round fix (2026-10-08): the admin manual-refund endpoint
  // (unallocated, independent of cancelling anything) is REMOVED
  // entirely - it broke computeRemainingRefundable()'s own ceiling,
  // since nothing stopped a later item cancellation from refunding on
  // top of it, past BranchOrder.total. Forced cancel itself is now
  // PLACED/PREPARING only, never "any non-terminal status" - past
  // that point the physical goods may already be out of the branch or
  // in the customer's hands, so restoring stock would be unsafe
  // without a real, confirmed stock-return event (genuine S21 scope).
  // ============================================================
  describe('Admin forced cancel (PLACED/PREPARING only, no manual refund)', () => {
    it('forced cancel on PLACED: COD closes to CANCELLED with no refund; ONLINE refunds everything (never more than total) and closes to REFUNDED', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customerCod = await signup(uniquePhone(), 'a-strong-password');
      const codOrder = await placeDeliveryOrder(
        owner,
        customerCod,
        vendorId,
        branchId,
        [variantId],
        'COD',
      );
      const customerOnline = await signup(uniquePhone(), 'a-strong-password');
      const onlineOrder = await placeDeliveryOrder(
        owner,
        customerOnline,
        vendorId,
        branchId,
        [variantId],
        'ONLINE',
        { daysAhead: 2 },
      );
      const admin = await platformAdmin();

      const codRes = await adminAction(
        admin,
        codOrder.branchOrderId,
        'cancel',
        {
          reason: REASON,
        },
      );
      expect(codRes.status).toBe(201);
      expect(codRes.body.refunded_amount).toBe(0);
      const codFinal = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: codOrder.branchOrderId },
      });
      expect(codFinal.status).toBe('CANCELLED');

      const onlineRes = await adminAction(
        admin,
        onlineOrder.branchOrderId,
        'cancel',
        { reason: REASON },
      );
      expect(onlineRes.status).toBe(201);
      expect(onlineRes.body.refunded_amount).toBe(30); // == total, never more
      const onlineFinal = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: onlineOrder.branchOrderId },
      });
      expect(onlineFinal.status).toBe('REFUNDED');
      const onlineRefundsSum = (
        await prisma.branchOrderRefund.findMany({
          where: { branchOrderId: onlineOrder.branchOrderId },
        })
      ).reduce((sum, r) => sum + Number(r.amount), 0);
      expect(onlineRefundsSum).toBeLessThanOrEqual(30);

      // Already-terminal: a second forced cancel is refused.
      const again = await adminAction(admin, codOrder.branchOrderId, 'cancel', {
        reason: REASON,
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('INVALID_BRANCH_ORDER_TRANSITION');
    });

    it('forced cancel on PREPARING still works', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
      );
      await staffAction(
        owner,
        vendorId,
        branchId,
        branchOrderId,
        'start-preparation',
      ).expect(201);
      const admin = await platformAdmin();

      const res = await adminAction(admin, branchOrderId, 'cancel', {
        reason: REASON,
      });
      expect(res.status).toBe(201);
      const order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.status).toBe('CANCELLED');
    });

    /** Snapshots status/items/stock/refunds, attempts a forced cancel,
     * asserts it is rejected with NO change to any of them. */
    async function expectForceCancelRejected(
      admin: string,
      branchOrderId: string,
      vendorId: string,
      branchId: string,
      variantId: string,
    ) {
      const before = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      const itemsBefore = await prisma.branchOrderItem.findMany({
        where: { branchOrderId },
        orderBy: { id: 'asc' },
      });
      const stockBefore = await prisma.branchStock.findFirstOrThrow({
        where: { vendorId, branchId, offerVariantId: variantId },
      });
      const refundsBefore = await prisma.branchOrderRefund.count({
        where: { branchOrderId },
      });

      const res = await adminAction(admin, branchOrderId, 'cancel', {
        reason: REASON,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_BRANCH_ORDER_TRANSITION');

      const after = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(after.status).toBe(before.status);
      const itemsAfter = await prisma.branchOrderItem.findMany({
        where: { branchOrderId },
        orderBy: { id: 'asc' },
      });
      expect(itemsAfter.map((i) => i.cancelledAt)).toEqual(
        itemsBefore.map((i) => i.cancelledAt),
      );
      const stockAfter = await prisma.branchStock.findFirstOrThrow({
        where: { vendorId, branchId, offerVariantId: variantId },
      });
      expect(stockAfter.quantity).toBe(stockBefore.quantity);
      expect(
        await prisma.branchOrderRefund.count({ where: { branchOrderId } }),
      ).toBe(refundsBefore);
    }

    it('rejects forced cancel on SENT, with no change to stock/refunds/status', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
      );
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
      const admin = await platformAdmin();
      await expectForceCancelRejected(
        admin,
        branchOrderId,
        vendorId,
        branchId,
        variantId,
      );
    });

    it('rejects forced cancel on DELIVERED, with no change to stock/refunds/status', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
      );
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
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/orders/${branchOrderId}/mark-delivered`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mark-delivered'))
        .send({})
        .expect(201);
      const admin = await platformAdmin();
      await expectForceCancelRejected(
        admin,
        branchOrderId,
        vendorId,
        branchId,
        variantId,
      );
    });

    it('rejects forced cancel on PICKED_UP, with no change to stock/refunds/status', async () => {
      // PICKED_UP is never a resting status in the real flow - pickup-
      // handover transitions PICKED_UP->COMPLETED in the SAME request
      // (see BranchOrdersStaffController.pickupHandover). Set it
      // directly to exercise the admin guard against this status on
      // its own terms, independent of real-flow reachability.
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);
      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          terms_accepted: true,
          terms_version: '2026-10-v1',
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
      const branchOrderId = confirmed.body.branch_orders[0].id as string;
      await prisma.branchOrder.update({
        where: { id: branchOrderId },
        data: { status: 'PICKED_UP' },
      });
      const admin = await platformAdmin();
      await expectForceCancelRejected(
        admin,
        branchOrderId,
        vendorId,
        branchId,
        variantId,
      );
    });

    it('rejects forced cancel on DELIVERY_FAILED, with no change to stock/refunds/status', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
      );
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
        'mark-delivery-failed',
      ).expect(201);
      const admin = await platformAdmin();
      await expectForceCancelRejected(
        admin,
        branchOrderId,
        vendorId,
        branchId,
        variantId,
      );
    });

    it('rejects forced cancel on REFUND_REQUESTED, with no change to stock/refunds/status', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'ONLINE',
        { daysAhead: 1 },
      );
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
        'mark-delivery-failed',
      ).expect(201); // count=1
      const midWindowId = await createWindow(
        owner,
        vendorId,
        branchId,
        dayOfWeekFor(2),
        '09:00',
        '18:00',
        5,
      );
      await customerAction(customer, branchOrderId, 'reschedule', {
        delivery_window_id: midWindowId,
        scheduled_date: nextDateForDayOfWeek(2),
      }).expect(201);
      await staffAction(
        owner,
        vendorId,
        branchId,
        branchOrderId,
        'mark-delivery-failed',
      ).expect(201); // count=2, ONLINE -> rests at DELIVERY_FAILED
      await customerAction(customer, branchOrderId, 'request-refund').expect(
        201,
      ); // -> REFUND_REQUESTED

      const admin = await platformAdmin();
      await expectForceCancelRejected(
        admin,
        branchOrderId,
        vendorId,
        branchId,
        variantId,
      );
    });

    it('the manual-refund endpoint no longer exists', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'ONLINE',
      );
      const admin = await platformAdmin();
      const res = await adminAction(admin, branchOrderId, 'refund', {
        reason: REASON,
      });
      expect(res.status).toBe(404);
    });

    it('refuses the admin cancel route to a non-PLATFORM_ADMIN caller', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
      );
      const res = await adminAction(owner, branchOrderId, 'cancel', {
        reason: REASON,
      });
      expect([401, 403]).toContain(res.status);
    });
  });

  // ============================================================
  // FulfilmentExceptionSweepService - genuinely periodic sweeps.
  // ============================================================
  describe('FulfilmentExceptionSweepService (PDR-025/027)', () => {
    it('detects a missed slot (sets slotMissedAt, notifies the customer) once the slot start has passed', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'COD',
        { daysAhead: 1 },
      );
      // Force the order's own slot into the past without touching the
      // checkout-time validation this test isn't exercising.
      await prisma.branchOrder.update({
        where: { id: branchOrderId },
        data: { scheduledDate: new Date(Date.now() - 2 * 86_400_000) },
      });

      await sweep.sweepOnce();

      const order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.slotMissedAt).toBeTruthy();
      const events = await prisma.outboxEvent.findMany({
        where: { eventType: 'branch_order.slot_missed' },
      });
      expect(
        events.some(
          (e) =>
            (e.payload as { branch_order_id?: string }).branch_order_id ===
            branchOrderId,
        ),
      ).toBe(true);
    });

    it('resolves a 48h slot-missed timeout automatically: COD cancels, ONLINE refunds', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);

      const codCustomer = await signup(uniquePhone(), 'a-strong-password');
      const codOrder = await placeDeliveryOrder(
        owner,
        codCustomer,
        vendorId,
        branchId,
        [variantId],
        'COD',
        { daysAhead: 1 },
      );
      await prisma.branchOrder.update({
        where: { id: codOrder.branchOrderId },
        data: { slotMissedAt: new Date(Date.now() - 49 * 3_600_000) },
      });

      const onlineCustomer = await signup(uniquePhone(), 'a-strong-password');
      const onlineOrder = await placeDeliveryOrder(
        owner,
        onlineCustomer,
        vendorId,
        branchId,
        [variantId],
        'ONLINE',
        { daysAhead: 2 },
      );
      await prisma.branchOrder.update({
        where: { id: onlineOrder.branchOrderId },
        data: { slotMissedAt: new Date(Date.now() - 49 * 3_600_000) },
      });

      await sweep.sweepOnce();

      const codFinal = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: codOrder.branchOrderId },
      });
      expect(codFinal.status).toBe('CANCELLED');
      const onlineFinal = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: onlineOrder.branchOrderId },
      });
      expect(onlineFinal.status).toBe('REFUNDED');

      const autoEvents = await prisma.outboxEvent.findMany({
        where: { eventType: 'branch_order.refund_automatic' },
      });
      expect(
        autoEvents.some(
          (e) =>
            (e.payload as { branch_order_id?: string }).branch_order_id ===
            onlineOrder.branchOrderId,
        ),
      ).toBe(true);
    });

    it('resolves a 48h first-delivery-failure timeout the same way, only for count===1', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const { branchOrderId } = await placeDeliveryOrder(
        owner,
        customer,
        vendorId,
        branchId,
        [variantId],
        'ONLINE',
        { daysAhead: 1 },
      );
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
        'mark-delivery-failed',
      ).expect(201);
      await prisma.branchOrder.update({
        where: { id: branchOrderId },
        data: { deliveryFailedAt: new Date(Date.now() - 49 * 3_600_000) },
      });

      await sweep.sweepOnce();

      const order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      expect(order.status).toBe('REFUNDED');
    });
  });
});
