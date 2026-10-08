import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
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
const uniquePhone = createUniquePhone('sprint20b-checkout-policy', '56');
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

const CURRENT_TERMS_VERSION = '2026-10-v1';

describe('Sprint 20b - checkout policy: minimum order, notes, terms, conflict blockers (e2e)', () => {
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

  function setBranchMinimum(
    owner: string,
    vendorId: string,
    branchId: string,
    value: number | null,
  ) {
    return request(app.getHttpServer())
      .put(`/api/v1/vendors/${vendorId}/branches/${branchId}/minimum-order`)
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('branch-minimum'))
      .send({ minimum_order_value: value });
  }

  function setZoneMinimum(
    owner: string,
    vendorId: string,
    zone: string,
    value: number | null,
  ) {
    return request(app.getHttpServer())
      .put(`/api/v1/vendors/${vendorId}/delivery-zones/${zone}/minimum-order`)
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('zone-minimum'))
      .send({ minimum_order_value: value });
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

  function quote(token: string, cartItemIds: string[], addressId?: string) {
    return request(app.getHttpServer())
      .post('/api/v1/checkout/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        cart_item_ids: cartItemIds,
        ...(addressId ? { address_id: addressId } : {}),
      });
  }

  function reserve(
    token: string,
    groups: Record<string, unknown>[],
    opts: { termsAccepted?: boolean; termsVersion?: string } = {},
  ) {
    return request(app.getHttpServer())
      .post('/api/v1/checkout/reserve')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('reserve'))
      .send({
        groups,
        terms_accepted: opts.termsAccepted ?? true,
        terms_version: opts.termsVersion ?? CURRENT_TERMS_VERSION,
      });
  }

  function confirm(token: string, reservationId: string) {
    return request(app.getHttpServer())
      .post('/api/v1/checkout/confirm')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('confirm'))
      .send({ reservation_id: reservationId });
  }

  // ============================================================
  // Minimum order value - branch default + zone override.
  // ============================================================
  describe('Minimum order value (FR-PRICE-006/FR-CART-003)', () => {
    it('owner sets/reads the branch default and the zone override; BRANCH_EMPLOYEE cannot write either', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);

      const setBranch = await setBranchMinimum(owner, vendorId, branchId, 50);
      expect(setBranch.status).toBe(200);
      expect(setBranch.body.minimum_order_value).toBe(50);

      const getBranch = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchId}/minimum-order`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(getBranch.body.minimum_order_value).toBe(50);

      const setZone = await setZoneMinimum(owner, vendorId, 'WEST_BANK', 80);
      expect(setZone.status).toBe(200);
      expect(setZone.body.minimum_order_value).toBe(80);

      const getZone = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/delivery-zones/WEST_BANK/minimum-order`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(getZone.body.minimum_order_value).toBe(80);

      // A BRANCH_EMPLOYEE of this exact branch may still not write
      // either - both endpoints are @RequireVendorRole('OWNER').
      const empPhone = uniquePhone();
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite'))
        .send({ phone: empPhone })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: empPhone, purpose: 'staff_invite' })
        .expect(202);
      const code = fakeSms.lastCodeFor(empPhone);
      const verify = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', unique('verify'))
        .send({ phone: empPhone, otp_code: code, purpose: 'staff_invite' })
        .expect(200);
      const accept = await request(app.getHttpServer())
        .post('/api/v1/auth/staff-invites/accept')
        .set('Idempotency-Key', unique('accept'))
        .send({
          phone: empPhone,
          verification_token: verify.body.session_token,
          password: 'a-strong-password',
        })
        .expect(200);
      const empToken = accept.body.session_token as string;

      const empBranchWrite = await setBranchMinimum(
        empToken,
        vendorId,
        branchId,
        999,
      );
      expect(empBranchWrite.status).toBe(403);
      const empZoneWrite = await setZoneMinimum(
        empToken,
        vendorId,
        'WEST_BANK',
        999,
      );
      expect(empZoneWrite.status).toBe(403);
    });

    it('a second PUT with the SAME value writes no new AuditLog row; Idempotency-Key replay of a real change never double-logs', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);

      await setBranchMinimum(owner, vendorId, branchId, 50).expect(200);
      const auditAfterFirst = await prisma.auditLog.count({
        where: {
          entityType: 'StoreBranch',
          entityId: branchId,
          action: 'store_branch.minimum_order_value_updated',
        },
      });
      expect(auditAfterFirst).toBe(1);

      // Same value again, DIFFERENT Idempotency-Key - a genuine no-op
      // call, never a replay. Must not write a second AuditLog row.
      await setBranchMinimum(owner, vendorId, branchId, 50).expect(200);
      const auditAfterNoop = await prisma.auditLog.count({
        where: {
          entityType: 'StoreBranch',
          entityId: branchId,
          action: 'store_branch.minimum_order_value_updated',
        },
      });
      expect(auditAfterNoop).toBe(1);

      // A real network-retry replay with the SAME Idempotency-Key must
      // never re-execute either.
      const key = unique('branch-minimum-retry');
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/branches/${branchId}/minimum-order`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .send({ minimum_order_value: 60 })
        .expect(200);
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/branches/${branchId}/minimum-order`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .send({ minimum_order_value: 60 })
        .expect(200);
      const auditAfterReplay = await prisma.auditLog.count({
        where: {
          entityType: 'StoreBranch',
          entityId: branchId,
          action: 'store_branch.minimum_order_value_updated',
        },
      });
      expect(auditAfterReplay).toBe(2); // the one genuine 50->60 change, once
    });

    // Review-round fix: two concurrent PUTs with DIFFERENT target
    // values must never both compute their `before` from the same
    // stale read - the AuditLog chain must reflect the real sequence
    // of changes (whichever request actually committed second must
    // show the FIRST request's new value as its own `before`, not the
    // original pre-test value again). This is checked by VALUE, not
    // by timestamp ordering, since both transactions can commit within
    // the same database-clock millisecond.
    it('deterministic concurrency: two concurrent branch-minimum PUTs with different values produce a real before/after chain in AuditLog, never two stale reads', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      await setBranchMinimum(owner, vendorId, branchId, 50).expect(200);

      const [resA, resB] = await Promise.all([
        setBranchMinimum(owner, vendorId, branchId, 80),
        setBranchMinimum(owner, vendorId, branchId, 100),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);

      const rows = await prisma.auditLog.findMany({
        where: {
          entityType: 'StoreBranch',
          entityId: branchId,
          action: 'store_branch.minimum_order_value_updated',
        },
      });
      // The initial 50 setup wrote its own row (null -> 50) - only the
      // two concurrent writes below are asserted on here.
      const concurrentRows = rows.filter(
        (r) =>
          (r.beforeState as { minimum_order_value: number })
            .minimum_order_value !== null,
      );
      expect(concurrentRows).toHaveLength(2);
      const firstRow = concurrentRows.find(
        (r) =>
          (r.beforeState as { minimum_order_value: number })
            .minimum_order_value === 50,
      );
      const secondRow = concurrentRows.find((r) => r !== firstRow);
      expect(firstRow).toBeDefined();
      expect(secondRow).toBeDefined();
      // The exact bug this test exists to catch: the second row's
      // `before` must chain from the first row's `after`, never from
      // the original 50 again.
      expect(
        (secondRow!.beforeState as { minimum_order_value: number })
          .minimum_order_value,
      ).toBe(
        (firstRow!.afterState as { minimum_order_value: number })
          .minimum_order_value,
      );

      const finalBranch = await prisma.storeBranch.findUniqueOrThrow({
        where: { id: branchId },
      });
      expect(Number(finalBranch.minimumOrderValue)).toBe(
        (secondRow!.afterState as { minimum_order_value: number })
          .minimum_order_value,
      );
    });

    // Same invariant, but for the harder case: a region with NO
    // VendorDeliveryZone row at all yet, where a plain `FOR UPDATE`
    // has nothing to lock. The advisory lock must still serialize the
    // two concurrent first-ever writes so the AuditLog chain is
    // correct AND exactly one row ends up persisted (the unique
    // constraint alone would prevent a true duplicate row, but not a
    // wrong/duplicated AuditLog trail).
    it('deterministic concurrency: two concurrent zone-minimum PUTs on a region with no row yet still produce a real before/after chain, and exactly one row', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      void branchId;

      const [resA, resB] = await Promise.all([
        setZoneMinimum(owner, vendorId, 'JERUSALEM', 80),
        setZoneMinimum(owner, vendorId, 'JERUSALEM', 100),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);

      const zoneRows = await prisma.vendorDeliveryZone.findMany({
        where: { vendorId, region: 'JERUSALEM' },
      });
      expect(zoneRows).toHaveLength(1);

      const rows = await prisma.auditLog.findMany({
        where: {
          entityType: 'VendorDeliveryZone',
          entityId: zoneRows[0].id,
          action: 'vendor_delivery_zone.minimum_order_value_updated',
        },
      });
      expect(rows).toHaveLength(2);
      const firstRow = rows.find(
        (r) =>
          (r.beforeState as { minimum_order_value: number | null })
            .minimum_order_value === null,
      );
      const secondRow = rows.find((r) => r !== firstRow);
      expect(firstRow).toBeDefined();
      expect(secondRow).toBeDefined();
      expect(
        (secondRow!.beforeState as { minimum_order_value: number })
          .minimum_order_value,
      ).toBe(
        (firstRow!.afterState as { minimum_order_value: number })
          .minimum_order_value,
      );
      expect(Number(zoneRows[0].minimumOrderValue)).toBe(
        (secondRow!.afterState as { minimum_order_value: number })
          .minimum_order_value,
      );
    });

    it('PICKUP uses the branch default only - a zone minimum never applies to it', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      await setBranchMinimum(owner, vendorId, branchId, 50).expect(200);
      // A huge zone minimum that must be IGNORED for pickup.
      await setZoneMinimum(owner, vendorId, 'WEST_BANK', 1000).expect(200);

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1); // 20 ILS, below branch min 50

      const res = await reserve(customer, [
        {
          cart_item_ids: [itemId],
          branch_id: branchId,
          fulfilment_method: 'PICKUP',
          payment_method: 'COD',
        },
      ]);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BELOW_MINIMUM_ORDER_VALUE');
      expect(res.body.error.details[0].required).toBe(50); // branch, not the 1000 zone value
      expect(res.body.error.details[0].fulfilment_method).toBe('PICKUP');
    });

    it('DELIVERY: the zone override takes precedence over the branch default', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 60, 5);
      await setBranchMinimum(owner, vendorId, branchId, 50).expect(200);
      await setZoneMinimum(owner, vendorId, 'WEST_BANK', 80).expect(200);
      await setZoneFee(owner, vendorId, 'WEST_BANK', 10);

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'WEST_BANK');
      const itemId = await addToCart(customer, vendorId, variantId, 1); // 60 ILS: >= branch 50, < zone 80
      const windowId = await createWindow(
        owner,
        vendorId,
        branchId,
        dayOfWeekFor(1),
        '09:00',
        '18:00',
        5,
      );

      const res = await reserve(customer, [
        {
          cart_item_ids: [itemId],
          branch_id: branchId,
          fulfilment_method: 'DELIVERY',
          payment_method: 'COD',
          address_id: addressId,
          delivery_window_id: windowId,
          scheduled_date: nextDateForDayOfWeek(1),
        },
      ]);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BELOW_MINIMUM_ORDER_VALUE');
      expect(res.body.error.details[0].required).toBe(80); // the zone override, not the branch 50
      expect(res.body.error.details[0].fulfilment_method).toBe('DELIVERY');
    });

    it('DELIVERY: falls back to the branch default when the zone has no override', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 60, 5);
      await setBranchMinimum(owner, vendorId, branchId, 50).expect(200);
      // No zone override set at all for WEST_BANK.
      await setZoneFee(owner, vendorId, 'WEST_BANK', 10);

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'WEST_BANK');
      const itemId = await addToCart(customer, vendorId, variantId, 1); // 60 >= 50
      const windowId = await createWindow(
        owner,
        vendorId,
        branchId,
        dayOfWeekFor(1),
        '09:00',
        '18:00',
        5,
      );

      const res = await reserve(customer, [
        {
          cart_item_ids: [itemId],
          branch_id: branchId,
          fulfilment_method: 'DELIVERY',
          payment_method: 'COD',
          address_id: addressId,
          delivery_window_id: windowId,
          scheduled_date: nextDateForDayOfWeek(1),
        },
      ]);
      expect(res.status).toBe(201); // accepted - 60 >= branch fallback of 50
    });

    it('never exceeded: accepting an order AT or ABOVE the minimum, computed on items-only subtotal (never delivery fee)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 50, 5);
      await setBranchMinimum(owner, vendorId, branchId, 50).expect(200);
      await setZoneFee(owner, vendorId, 'WEST_BANK', 1000); // huge delivery fee - must NOT count

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'WEST_BANK');
      const itemId = await addToCart(customer, vendorId, variantId, 1); // exactly 50
      const windowId = await createWindow(
        owner,
        vendorId,
        branchId,
        dayOfWeekFor(1),
        '09:00',
        '18:00',
        5,
      );

      const res = await reserve(customer, [
        {
          cart_item_ids: [itemId],
          branch_id: branchId,
          fulfilment_method: 'DELIVERY',
          payment_method: 'COD',
          address_id: addressId,
          delivery_window_id: windowId,
          scheduled_date: nextDateForDayOfWeek(1),
        },
      ]);
      expect(res.status).toBe(201); // exactly at the minimum is accepted
    });

    it('quote() shows a structured blocker for the specific branch below minimum, without affecting other eligible branches', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      await setBranchMinimum(owner, vendorId, branchId, 50).expect(200);

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1); // 20, below 50

      const res = await quote(customer, [itemId]).expect(201);
      const branch = res.body.groups[0].eligible_branches.find(
        (b: { branch_id: string }) => b.branch_id === branchId,
      );
      expect(branch.blockers).toHaveLength(1);
      expect(branch.blockers[0].code).toBe('BELOW_MINIMUM_ORDER_VALUE');
      expect(branch.blockers[0].fulfilment_method).toBe('PICKUP');
      expect(branch.blockers[0].required).toBe(50);
      expect(branch.minimum_order_value.pickup).toBe(50);

      // reserve() still enforces this for real - quote() is a preview only.
      const reserveRes = await reserve(customer, [
        {
          cart_item_ids: [itemId],
          branch_id: branchId,
          fulfilment_method: 'PICKUP',
          payment_method: 'COD',
        },
      ]);
      expect(reserveRes.status).toBe(409);
    });
  });

  // ============================================================
  // Conflict catalogue in quote() (FR-CART-015).
  //
  // Review-round fix: the catalogue built in this sprint is EXACTLY
  // the minimum-order-shortfall blocker above - nothing else. These
  // two tests lock in the rest of the design explicitly, matching the
  // corrected traceability row: (1) two independent groups never leak
  // a blocker across each other, and (2) delivery non-coverage for a
  // zone is represented through `delivery_fee`/`minimum_order_value`
  // being null, deliberately NOT as a `blockers[]` entry - it means
  // "DELIVERY isn't offered here" (same as `is_physical: false` for
  // PICKUP), not "a conflict to warn about".
  // ============================================================
  describe('Conflict catalogue in quote() (FR-CART-015)', () => {
    it('two separate groups in one quote(): a blocker in one group never appears on the other', async () => {
      const ownerBelow = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBelowId, branchId: branchBelowId } =
        await createVendorWithBranch(ownerBelow);
      const variantBelowId = await createOfferWithStock(
        vendorBelowId,
        branchBelowId,
        20,
        5,
      ); // 20 ILS
      await setBranchMinimum(
        ownerBelow,
        vendorBelowId,
        branchBelowId,
        50,
      ).expect(200); // 20 < 50 -> blocked

      const ownerOk = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorOkId, branchId: branchOkId } =
        await createVendorWithBranch(ownerOk);
      const variantOkId = await createOfferWithStock(
        vendorOkId,
        branchOkId,
        20,
        5,
      ); // 20 ILS, no minimum ever set -> never blocked

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemBelowId = await addToCart(
        customer,
        vendorBelowId,
        variantBelowId,
        1,
      );
      const itemOkId = await addToCart(customer, vendorOkId, variantOkId, 1);

      const res = await quote(customer, [itemBelowId, itemOkId]).expect(201);
      expect(res.body.groups).toHaveLength(2);

      const groupBelow = res.body.groups.find(
        (g: { vendor_id: string }) => g.vendor_id === vendorBelowId,
      );
      const groupOk = res.body.groups.find(
        (g: { vendor_id: string }) => g.vendor_id === vendorOkId,
      );
      const branchBelow = groupBelow.eligible_branches.find(
        (b: { branch_id: string }) => b.branch_id === branchBelowId,
      );
      const branchOk = groupOk.eligible_branches.find(
        (b: { branch_id: string }) => b.branch_id === branchOkId,
      );

      expect(branchBelow.blockers).toHaveLength(1);
      expect(branchBelow.blockers[0].code).toBe('BELOW_MINIMUM_ORDER_VALUE');
      // The OTHER group's branch must stay completely unaffected.
      expect(branchOk.blockers).toHaveLength(0);
    });

    it('a zone with no delivery coverage is reflected by delivery_fee/minimum_order_value.delivery being null, NOT as a blockers[] entry', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      // No setZoneFee() call at all for INSIDE - no VendorDeliveryZone
      // row exists for this (vendorId, region) pair, and no minimum
      // order is set on the branch either.

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'INSIDE');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const res = await quote(customer, [itemId], addressId).expect(201);
      const branch = res.body.groups[0].eligible_branches.find(
        (b: { branch_id: string }) => b.branch_id === branchId,
      );
      expect(branch.delivery_fee).toBeNull();
      expect(branch.minimum_order_value.delivery).toBeNull();
      // Deliberately not a blocker - see this describe block's comment.
      expect(
        branch.blockers.filter(
          (b: { fulfilment_method: string }) =>
            b.fulfilment_method === 'DELIVERY',
        ),
      ).toHaveLength(0);
      expect(branch.blockers).toHaveLength(0);
    });
  });

  // ============================================================
  // Customer note + internal store note (FR-CART-014).
  // ============================================================
  describe('Customer/internal notes (FR-CART-014)', () => {
    async function placeOrderWithNote(
      owner: string,
      customer: string,
      vendorId: string,
      branchId: string,
      variantId: string,
      customerNote?: string,
    ): Promise<string> {
      const itemId = await addToCart(customer, vendorId, variantId, 1);
      const reserved = await reserve(customer, [
        {
          cart_item_ids: [itemId],
          branch_id: branchId,
          fulfilment_method: 'PICKUP',
          payment_method: 'COD',
          ...(customerNote ? { customer_note: customerNote } : {}),
        },
      ]).expect(201);
      const confirmed = await confirm(
        customer,
        reserved.body.reservation_id,
      ).expect(201);
      return confirmed.body.branch_orders[0].id as string;
    }

    it('customer_note flows reserve -> confirm -> BranchOrder, visible to the customer and to staff, never in any Outbox payload', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const note = 'الرجاء الاتصال قبل الوصول';
      const branchOrderId = await placeOrderWithNote(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
        note,
      );

      const customerView = await request(app.getHttpServer())
        .get('/api/v1/customers/me/orders')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      const order = customerView.body.find(
        (o: { id: string }) => o.id === branchOrderId,
      );
      expect(order.customer_note).toBe(note);
      expect(order).not.toHaveProperty('internal_store_note');

      const staffView = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchId}/orders`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const staffOrder = staffView.body.find(
        (o: { id: string }) => o.id === branchOrderId,
      );
      expect(staffOrder.customer_note).toBe(note);

      const events = await prisma.outboxEvent.findMany();
      for (const e of events) {
        expect(JSON.stringify(e.payload)).not.toContain(note);
      }
    });

    it('internal_store_note: OWNER and the SAME branch employee can write it; a DIFFERENT branch employee cannot (BOLA)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const res = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
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
      const vendorId = res.body.id;
      const branchAId = res.body.branches[0].id;
      const branchBId = res.body.branches[1].id;
      const variantId = await createOfferWithStock(vendorId, branchAId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const branchOrderId = await placeOrderWithNote(
        owner,
        customer,
        vendorId,
        branchAId,
        variantId,
      );

      // OWNER writes it.
      const ownerWrite = await request(app.getHttpServer())
        .patch(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/orders/${branchOrderId}/internal-note`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('internal-note'))
        .send({ note: 'تحقق من الكمية قبل التسليم' })
        .expect(200);
      expect(ownerWrite.body.internal_store_note).toBe(
        'تحقق من الكمية قبل التسليم',
      );

      // Invite an employee to branch A and have them overwrite it.
      const empAPhone = uniquePhone();
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite'))
        .send({ phone: empAPhone })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: empAPhone, purpose: 'staff_invite' })
        .expect(202);
      const codeA = fakeSms.lastCodeFor(empAPhone);
      const verifyA = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', unique('verify'))
        .send({ phone: empAPhone, otp_code: codeA, purpose: 'staff_invite' })
        .expect(200);
      const acceptA = await request(app.getHttpServer())
        .post('/api/v1/auth/staff-invites/accept')
        .set('Idempotency-Key', unique('accept'))
        .send({
          phone: empAPhone,
          verification_token: verifyA.body.session_token,
          password: 'a-strong-password',
        })
        .expect(200);
      const empAToken = acceptA.body.session_token as string;

      const empAWrite = await request(app.getHttpServer())
        .patch(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/orders/${branchOrderId}/internal-note`,
        )
        .set('Authorization', `Bearer ${empAToken}`)
        .set('Idempotency-Key', unique('internal-note'))
        .send({ note: 'جاهز للتسليم' })
        .expect(200);
      expect(empAWrite.body.internal_store_note).toBe('جاهز للتسليم');

      // Invite a SECOND employee to branch B - must NOT be able to
      // touch an order belonging to branch A.
      const empBPhone = uniquePhone();
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchBId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite'))
        .send({ phone: empBPhone })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: empBPhone, purpose: 'staff_invite' })
        .expect(202);
      const codeB = fakeSms.lastCodeFor(empBPhone);
      const verifyB = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', unique('verify'))
        .send({ phone: empBPhone, otp_code: codeB, purpose: 'staff_invite' })
        .expect(200);
      const acceptB = await request(app.getHttpServer())
        .post('/api/v1/auth/staff-invites/accept')
        .set('Idempotency-Key', unique('accept'))
        .send({
          phone: empBPhone,
          verification_token: verifyB.body.session_token,
          password: 'a-strong-password',
        })
        .expect(200);
      const empBToken = acceptB.body.session_token as string;

      const empBWrite = await request(app.getHttpServer())
        .patch(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/orders/${branchOrderId}/internal-note`,
        )
        .set('Authorization', `Bearer ${empBToken}`)
        .set('Idempotency-Key', unique('internal-note'))
        .send({ note: 'لا يجب أن يصل هذا' });
      expect([403, 404]).toContain(empBWrite.status);

      // Never visible to the customer.
      const customerView = await request(app.getHttpServer())
        .get('/api/v1/customers/me/orders')
        .set('Authorization', `Bearer ${customer}`)
        .expect(200);
      const order = customerView.body.find(
        (o: { id: string }) => o.id === branchOrderId,
      );
      expect(order).not.toHaveProperty('internal_store_note');
    });

    it('AuditLog for the internal note records only that it changed and its length, never the text itself', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const branchOrderId = await placeOrderWithNote(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );
      const secretNote = 'نص سري لا يجب تسريبه في AuditLog';

      await request(app.getHttpServer())
        .patch(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/orders/${branchOrderId}/internal-note`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('internal-note'))
        .send({ note: secretNote })
        .expect(200);

      const auditRows = await prisma.auditLog.findMany({
        where: {
          entityType: 'BranchOrder',
          entityId: branchOrderId,
          action: 'branch_order.internal_note_updated',
        },
      });
      expect(auditRows).toHaveLength(1);
      const after = auditRows[0].afterState as Record<string, unknown>;
      expect(after.changed).toBe(true);
      expect(after.new_length).toBe(secretNote.length);
      expect(JSON.stringify(auditRows[0])).not.toContain(secretNote);
    });
  });

  // ============================================================
  // Platform terms acceptance (FR-CART-012, platform terms only).
  // ============================================================
  describe('Platform terms acceptance (FR-CART-012)', () => {
    it('rejects reserve() without accepting terms, and with a stale/wrong version', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customerPhone = uniquePhone();
      const customer = await signup(customerPhone, 'a-strong-password');
      const customerProfile = await prisma.customerProfile.findFirstOrThrow({
        where: { user: { phone: customerPhone } },
      });
      const itemId = await addToCart(customer, vendorId, variantId, 1);
      const group = {
        cart_item_ids: [itemId],
        branch_id: branchId,
        fulfilment_method: 'PICKUP',
        payment_method: 'COD',
      };

      const notAccepted = await reserve(customer, [group], {
        termsAccepted: false,
      });
      expect(notAccepted.status).toBe(409);
      expect(notAccepted.body.error.code).toBe('TERMS_NOT_ACCEPTED');

      const staleVersion = await reserve(customer, [group], {
        termsVersion: '2025-01-v0',
      });
      expect(staleVersion.status).toBe(409);
      expect(staleVersion.body.error.code).toBe('TERMS_VERSION_MISMATCH');

      // Scoped to THIS test's own customer - other tests in this same
      // file share one database and may have their own live
      // reservations at this point.
      expect(
        await prisma.checkoutReservation.count({
          where: { customerId: customerProfile.id },
        }),
      ).toBe(0);
    });

    it('a valid reserve() snapshots the version/timestamp on the reservation, and confirm() copies it verbatim to CustomerOrder', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const reserved = await reserve(customer, [
        {
          cart_item_ids: [itemId],
          branch_id: branchId,
          fulfilment_method: 'PICKUP',
          payment_method: 'COD',
        },
      ]).expect(201);

      const reservation = await prisma.checkoutReservation.findUniqueOrThrow({
        where: { id: reserved.body.reservation_id },
      });
      expect(reservation.platformTermsVersion).toBe(CURRENT_TERMS_VERSION);
      expect(reservation.termsAcceptedAt).toBeTruthy();

      const confirmed = await confirm(
        customer,
        reserved.body.reservation_id,
      ).expect(201);
      const branchOrder = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: confirmed.body.branch_orders[0].id },
        include: { customerOrder: true },
      });
      expect(branchOrder.customerOrder.platformTermsVersion).toBe(
        CURRENT_TERMS_VERSION,
      );
      expect(branchOrder.customerOrder.termsAcceptedAt?.getTime()).toBe(
        reservation.termsAcceptedAt!.getTime(),
      );
    });
  });
});
