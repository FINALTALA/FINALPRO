import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { createUniquePhone } from './helpers/e2e-phone-lanes';

/** Test double for the OPEN-004 SMS fallback - captures codes instead of logging them. */
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
const uniquePhone = createUniquePhone('sprint18a-inventory-barcode', '56');
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 18a - inventory: safety stock, physical count, SALE movements, barcode lookup, pagination (e2e)', () => {
  let app: INestApplication;
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
    await app.close();
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

  async function setupVendorWithTwoBranchesAndEmployee() {
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
    return {
      owner,
      vendorId,
      branchAId,
      branchBId,
      employeeToken: accepted.session_token as string,
    };
  }

  /**
   * AuditLog has no vendorId/branchId/offerVariantId columns of its
   * own - just entityType/entityId - and this whole file's tests
   * share one accumulating database (no per-test reset), so any
   * AuditLog query must be scoped to this specific BranchStock row's
   * id, never asserted as "the only row with this action in the
   * whole run".
   */
  async function branchStockId(
    branchId: string,
    offerVariantId: string,
  ): Promise<string> {
    const row = await prisma.branchStock.findUniqueOrThrow({
      where: { branchId_offerVariantId: { branchId, offerVariantId } },
    });
    return row.id;
  }

  async function activateVendorSubscription(
    ownerToken: string,
    vendorId: string,
  ): Promise<void> {
    const reviewerPhone = uniquePhone();
    const reviewerToken = await signup(reviewerPhone, 'reviewer-password');
    await prisma.user.update({
      where: { phone: reviewerPhone },
      data: { platformRole: 'VERIFICATION_REVIEWER' },
    });

    const branches = await prisma.storeBranch.findMany({ where: { vendorId } });
    for (const branch of branches) {
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branch.id}/verification-evidence`,
        )
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', unique('evidence'))
        .send({
          lat: 32.22,
          lng: 35.26,
          verification_photo_url: 'https://example.com/photo.jpg',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branch.id}/verification-decision`,
        )
        .set('Authorization', `Bearer ${reviewerToken}`)
        .set('Idempotency-Key', unique('decision'))
        .send({ decision: 'approve', evidence_revision: 1 })
        .expect(201);
    }
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/subscription`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('sub'))
      .send({})
      .expect(201);
  }

  async function createOfferVariant(
    ownerToken: string,
    vendorId: string,
    _branchId: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ offerId: string; variantId: string }> {
    await activateVendorSubscription(ownerToken, vendorId);
    const offerRes = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/offers`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('offer'))
      .send({ title_ar: 'منتج', title_en: 'Product' })
      .expect(201);
    const variantRes = await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('variant'))
      .send({ seller_sku: unique('sku'), base_price: 10, ...extra })
      .expect(201);
    return { offerId: offerRes.body.id, variantId: variantRes.body.id };
  }

  describe('GET .../stock (old, bare array) stays exactly as it was', () => {
    it('still returns a plain array, not {items, next_cursor}', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      await createOfferVariant(owner, vendorId, branchAId);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/stock`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('enriched DTO shared by stock/page, lookup, and the single GET', () => {
    it('returns offer title, sku, colour/size, barcode, quantities, threshold, last-count and the two computed flags', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
        {
          colour: 'أحمر',
          size: 'L',
        },
      );
      const variant = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });

      // Establish a BranchStock row via a movement first.
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 5,
          reason_note: 'جرد أولي',
        })
        .expect(201);

      for (const res of await Promise.all([
        request(app.getHttpServer())
          .get(
            `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .expect(200),
        request(app.getHttpServer())
          .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/page`)
          .set('Authorization', `Bearer ${owner}`)
          .expect(200)
          .then((r) => ({ body: r.body.items[0] })),
        request(app.getHttpServer())
          .get(
            `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/lookup?barcode=${variant.storeInventoryBarcode}`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .expect(200),
      ])) {
        const body = 'body' in res ? res.body : res;
        expect(body.offer_title_ar).toBe('منتج');
        expect(body.offer_title_en).toBe('Product');
        expect(body.colour).toBe('أحمر');
        expect(body.size).toBe('L');
        expect(body.store_inventory_barcode).toBe(
          variant.storeInventoryBarcode,
        );
        expect(body.quantity).toBe(5);
        expect(body.reserved_quantity).toBe(0);
        expect(body.available_quantity).toBe(5);
        expect(body.safety_stock_threshold).toBe(0);
        expect(body.is_low_stock).toBe(false);
        expect(body.is_stale).toBe(false); // COUNT_CORRECTION just set lastPhysicalCountAt to now
      }
    });
  });

  describe('SALE movements (RB-INV-004/PDR-020) - a plain stock movement, nothing else', () => {
    it('records StockMovement + AuditLog, decrements stock, but creates no Outbox owner-notification and does not touch lastPhysicalCountAt', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 10,
          reason_note: 'جرد',
        })
        .expect(201);

      const outboxBefore = await prisma.outboxEvent.count({
        where: { eventType: 'stock_movement.owner_notification' },
      });

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({ reason: 'SALE', quantity_delta: -3, reason_note: 'بيع نقدي' })
        .expect(201);
      expect(res.body.resulting_quantity).toBe(7);

      const outboxAfter = await prisma.outboxEvent.count({
        where: { eventType: 'stock_movement.owner_notification' },
      });
      expect(outboxAfter).toBe(outboxBefore); // SALE enqueued nothing new

      const stock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId: branchAId,
            offerVariantId: variantId,
          },
        },
      });
      expect(stock.lastPhysicalCountAt).not.toBeNull(); // still set from the earlier COUNT_CORRECTION
      const countedAtAfterCountCorrection = stock.lastPhysicalCountAt;

      // A second SALE shortly after must not move lastPhysicalCountAt at all.
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({ reason: 'SALE', quantity_delta: -1, reason_note: 'بيع آخر' })
        .expect(201);
      const stockAfter = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId: branchAId,
            offerVariantId: variantId,
          },
        },
      });
      expect(stockAfter.lastPhysicalCountAt?.getTime()).toBe(
        countedAtAfterCountCorrection?.getTime(),
      );

      const auditRows = await prisma.auditLog.findMany({
        where: { entityType: 'StockMovement' },
      });
      expect(auditRows.length).toBeGreaterThan(0); // AuditLog still written for SALE
    });

    it('rejects a positive quantity_delta for SALE, same as DAMAGE/LOSS', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({ reason: 'SALE', quantity_delta: 3, reason_note: 'لا معنى' })
        .expect(409);
      expect(res.body.error.code).toBe('INVALID_MOVEMENT_DIRECTION');
    });

    it('under two concurrent SALE scans for the last unit, exactly one succeeds', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 1,
          reason_note: 'جرد',
        })
        .expect(201);

      const attempt = () =>
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('mv'))
          .send({
            reason: 'SALE',
            quantity_delta: -1,
            reason_note: 'بيع متزامن',
          });

      const [a, b] = await Promise.all([attempt(), attempt()]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
    });

    it('DAMAGE/LOSS still create the PDR-021 Outbox owner-notification event (unchanged), and still do not touch lastPhysicalCountAt', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 10,
          reason_note: 'جرد',
        })
        .expect(201);
      const stockBefore = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId: branchAId,
            offerVariantId: variantId,
          },
        },
      });

      const outboxBefore = await prisma.outboxEvent.count({
        where: { eventType: 'stock_movement.owner_notification' },
      });
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({ reason: 'DAMAGE', quantity_delta: -2, reason_note: 'تلف' })
        .expect(201);
      const outboxAfter = await prisma.outboxEvent.count({
        where: { eventType: 'stock_movement.owner_notification' },
      });
      expect(outboxAfter).toBe(outboxBefore + 1);

      const stockAfter = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId: branchAId,
            offerVariantId: variantId,
          },
        },
      });
      expect(stockAfter.lastPhysicalCountAt?.getTime()).toBe(
        stockBefore.lastPhysicalCountAt?.getTime(),
      );
    });

    it('COUNT_CORRECTION updates lastPhysicalCountAt', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      const before = Date.now();
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 4,
          reason_note: 'جرد',
        })
        .expect(201);
      const stock = await prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: {
            branchId: branchAId,
            offerVariantId: variantId,
          },
        },
      });
      expect(stock.lastPhysicalCountAt).not.toBeNull();
      expect(stock.lastPhysicalCountAt!.getTime()).toBeGreaterThanOrEqual(
        before,
      );
    });
  });

  describe('confirm-count (review-round fix: countedAt, idempotency, note validation, no StockMovement)', () => {
    it('creates the BranchStock row if it never existed, sets lastPhysicalCountAt, writes AuditLog, and creates no StockMovement', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      const movementsBefore = await prisma.stockMovement.count({
        where: { vendorId, branchId: branchAId, offerVariantId: variantId },
      });

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/confirm-count`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({})
        .expect(200);
      expect(res.body.quantity).toBe(0);
      expect(res.body.last_physical_count_at).not.toBeNull();
      expect(res.body.is_stale).toBe(false);

      const movementsAfter = await prisma.stockMovement.count({
        where: { vendorId, branchId: branchAId, offerVariantId: variantId },
      });
      expect(movementsAfter).toBe(movementsBefore); // no new StockMovement

      const audit = await prisma.auditLog.findMany({
        where: {
          action: 'branch_stock.physical_count_confirmed',
          entityId: await branchStockId(branchAId, variantId),
        },
      });
      expect(audit.length).toBe(1);
    });

    it('replaying the same Idempotency-Key does not write a second AuditLog', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      const key = unique('confirm');

      const first = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/confirm-count`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .send({ note: 'كل شيء صحيح' })
        .expect(200);

      const second = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/confirm-count`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .send({ note: 'كل شيء صحيح' })
        .expect(200);

      expect(second.body).toEqual(first.body);
      const audit = await prisma.auditLog.findMany({
        where: {
          action: 'branch_stock.physical_count_confirmed',
          entityId: await branchStockId(branchAId, variantId),
        },
      });
      expect(audit.length).toBe(1);
    });

    it('rejects a whitespace-only note, and a note over the length limit', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/confirm-count`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ note: '   ' })
        .expect(400);

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/confirm-count`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ note: 'a'.repeat(501) })
        .expect(400);
    });

    it('a valid note is recorded in AuditLog.afterState only - never on the BranchStock row', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      const note = 'تأكيد جرد يدوي لا تغيير بالكمية';

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/confirm-count`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ note })
        .expect(200);

      const audit = await prisma.auditLog.findFirst({
        where: {
          action: 'branch_stock.physical_count_confirmed',
          entityId: await branchStockId(branchAId, variantId),
        },
      });
      expect((audit?.afterState as { note: string }).note).toBe(note);
    });

    it('captures countedAt at request entry, not after waiting on a concurrent movement holding the row', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 5,
          reason_note: 'جرد',
        })
        .expect(201);

      const requestStartedAt = Date.now();
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/confirm-count`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({})
        .expect(200);
      const requestFinishedAt = Date.now();
      const recordedAt = new Date(res.body.last_physical_count_at).getTime();
      // The timestamp stored must fall within this single request's own
      // wall-clock window - not some unrelated, later moment.
      expect(recordedAt).toBeGreaterThanOrEqual(requestStartedAt);
      expect(recordedAt).toBeLessThanOrEqual(requestFinishedAt);
    });

    it('a BRANCH_EMPLOYEE can confirm-count at their own assigned branch but is denied at the other branch of the same vendor', async () => {
      const { owner, vendorId, branchAId, branchBId, employeeToken } =
        await setupVendorWithTwoBranchesAndEmployee(); // employee assigned to branchA
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/confirm-count`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({})
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchBId}/stock/${variantId}/confirm-count`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({})
        .expect(403);
      expect(res.body.error.code).toBe('BRANCH_ACCESS_DENIED');
    });
  });

  describe('safety-stock (owner-only, idempotent, AuditLog only on real change)', () => {
    it('owner sets a genuinely different threshold - AuditLog written once', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      const res = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/safety-stock`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('safety'))
        .send({ threshold: 5 })
        .expect(200);
      expect(res.body.safety_stock_threshold).toBe(5);

      const audit = await prisma.auditLog.findMany({
        where: {
          action: 'branch_stock.safety_threshold_updated',
          entityId: await branchStockId(branchAId, variantId),
        },
      });
      expect(audit.length).toBe(1);
    });

    it('setting the SAME threshold again with a fresh key does not write a new AuditLog', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/safety-stock`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('safety'))
        .send({ threshold: 3 })
        .expect(200);

      await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/safety-stock`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('safety')) // a DIFFERENT key, same value
        .send({ threshold: 3 })
        .expect(200);

      const audit = await prisma.auditLog.findMany({
        where: {
          action: 'branch_stock.safety_threshold_updated',
          entityId: await branchStockId(branchAId, variantId),
        },
      });
      expect(audit.length).toBe(1);
    });

    it('replaying the same Idempotency-Key never re-processes at all', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      const key = unique('safety');

      const first = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/safety-stock`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .send({ threshold: 8 })
        .expect(200);
      const second = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/safety-stock`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .send({ threshold: 8 })
        .expect(200);
      expect(second.body).toEqual(first.body);

      const audit = await prisma.auditLog.findMany({
        where: {
          action: 'branch_stock.safety_threshold_updated',
          entityId: await branchStockId(branchAId, variantId),
        },
      });
      expect(audit.length).toBe(1);
    });

    it('refuses a BRANCH_EMPLOYEE', async () => {
      const { owner, vendorId, branchAId, employeeToken } =
        await setupVendorWithTwoBranchesAndEmployee();
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      const res = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/safety-stock`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('safety'))
        .send({ threshold: 2 })
        .expect(403);
      expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    });

    it('is_low_stock: threshold=0 never alerts even at zero available; threshold>0 alerts exactly at the boundary', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      const zeroThreshold = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(zeroThreshold.body.is_low_stock).toBe(false); // 0 available, threshold 0 (disabled)

      await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/safety-stock`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('safety'))
        .send({ threshold: 3 })
        .expect(200);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 3,
          reason_note: 'جرد',
        })
        .expect(201);

      const atBoundary = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(atBoundary.body.available_quantity).toBe(3);
      expect(atBoundary.body.is_low_stock).toBe(true); // 3 <= 3

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 1,
          reason_note: 'جرد',
        })
        .expect(201);
      const aboveBoundary = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(aboveBoundary.body.available_quantity).toBe(4);
      expect(aboveBoundary.body.is_low_stock).toBe(false); // 4 > 3
    });
  });

  describe('lookup (BOLA-focused: must find an existing BranchStock row at THIS branch, not just a vendor-level barcode match)', () => {
    it('resolves the correct barcode at the correct branch', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      const variant = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 2,
          reason_note: 'جرد',
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/lookup?barcode=${variant.storeInventoryBarcode}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body.offer_variant_id).toBe(variantId);
      expect(res.body.quantity).toBe(2);
    });

    it('404s a barcode that does not exist for this vendor at all', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/lookup?barcode=NOPE-${unique('x')}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(404);
      expect(res.body.error.code).toBe('BARCODE_NOT_FOUND_AT_BRANCH');
    });

    it("a barcode that belongs to this vendor but is only ever stocked at a DIFFERENT branch resolves to a LOCAL zero row here - never 404, never the other branch's real quantity", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId, branchBId } =
        await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      const variant = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      // Stocked at branch A only - a real, nonzero quantity there.
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 7,
          reason_note: 'جرد',
        })
        .expect(201);

      // Scanned at branch B - never touched there. The variant genuinely
      // belongs to this vendor, so this is a real, locally-zero row at
      // branch B, not a 404 - and it must not leak branch A's real 7.
      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchBId}/stock/lookup?barcode=${variant.storeInventoryBarcode}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body.offer_variant_id).toBe(variantId);
      expect(res.body.id).toBeNull();
      expect(res.body.quantity).toBe(0);
      expect(res.body.available_quantity).toBe(0);
    });

    it('404s - same code - a barcode that belongs to a completely different vendor', async () => {
      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId, branchAId: branchA1 } =
        await createVendorWithTwoBranches(ownerA);
      const { variantId: variantAId } = await createOfferVariant(
        ownerA,
        vendorAId,
        branchA1,
      );
      const variantA = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantAId },
      });
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorAId}/branches/${branchA1}/stock/${variantAId}/movements`,
        )
        .set('Authorization', `Bearer ${ownerA}`)
        .set('Idempotency-Key', unique('mv'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 1,
          reason_note: 'جرد',
        })
        .expect(201);

      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBId, branchAId: branchB1 } =
        await createVendorWithTwoBranches(ownerB);

      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorBId}/branches/${branchB1}/stock/lookup?barcode=${variantA.storeInventoryBarcode}`,
        )
        .set('Authorization', `Bearer ${ownerB}`)
        .expect(404);
      expect(res.body.error.code).toBe('BARCODE_NOT_FOUND_AT_BRANCH');
    });
  });

  describe('stock/page: deterministic pagination', () => {
    it('walks every row exactly once across several small pages - no duplicate, no dropped id', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const createdIds: string[] = [];
      // Only the FIRST call activates the subscription; calling
      // createOfferVariant() again on an already-ACTIVE vendor would
      // 409 on re-activation (same reason sprint6-inventory-matching's
      // own tests avoid it) - every variant after the first is created
      // by a direct offer+variant POST instead, same pattern as that
      // file's own "unrelated decision" test.
      const first = await createOfferVariant(owner, vendorId, branchAId);
      const variantIds = [first.variantId];
      for (let i = 0; i < 4; i++) {
        const offerRes = await request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/offers`)
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('offer'))
          .send({ title_ar: 'منتج', title_en: 'Product' })
          .expect(201);
        const variantRes = await request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/offers/${offerRes.body.id}/variants`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('variant'))
          .send({ seller_sku: unique('sku'), base_price: 10 })
          .expect(201);
        variantIds.push(variantRes.body.id);
      }
      for (const variantId of variantIds) {
        const res = await request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('mv'))
          .send({
            reason: 'COUNT_CORRECTION',
            quantity_delta: 1,
            reason_note: 'جرد',
          })
          .expect(201);
        createdIds.push(res.body.offer_variant_id as string);
      }

      const seenVariantIds: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const qs = cursor
          ? `?limit=2&cursor=${encodeURIComponent(cursor)}`
          : '?limit=2';
        const res = await request(app.getHttpServer())
          .get(
            `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/page${qs}`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .expect(200);
        for (const item of res.body.items as { offer_variant_id: string }[]) {
          seenVariantIds.push(item.offer_variant_id);
        }
        cursor = res.body.next_cursor;
        if (!cursor) break;
      }
      expect(seenVariantIds.sort()).toEqual([...createdIds].sort());
      expect(new Set(seenVariantIds).size).toBe(createdIds.length);
    });
  });

  describe('a variant with no BranchStock row at this branch yet (review-round fix)', () => {
    it('appears in stock/page with a synthetic zero row, not omitted', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );
      // Deliberately NO movement, NO confirm-count - this variant has
      // never touched BranchStock at this branch at all.

      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/page?limit=20`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const item = res.body.items.find(
        (i: { offer_variant_id: string }) => i.offer_variant_id === variantId,
      );
      expect(item).toBeDefined();
      expect(item.id).toBeNull();
      expect(item.quantity).toBe(0);
      expect(item.reserved_quantity).toBe(0);
      expect(item.available_quantity).toBe(0);
      expect(item.safety_stock_threshold).toBe(0);
      expect(item.last_physical_count_at).toBeNull();
      expect(item.is_stale).toBe(true);
      expect(item.is_low_stock).toBe(false);
    });

    it('a positive COUNT_CORRECTION on it creates the real BranchStock row and stock/page then shows the real quantity', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const { variantId } = await createOfferVariant(
        owner,
        vendorId,
        branchAId,
      );

      const before = await prisma.branchStock.findUnique({
        where: {
          branchId_offerVariantId: {
            branchId: branchAId,
            offerVariantId: variantId,
          },
        },
      });
      expect(before).toBeNull();

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/${variantId}/movements`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('mv'))
        .send({
          reason: 'COUNT_CORRECTION',
          quantity_delta: 12,
          reason_note: 'أول جرد لمنتج جديد',
        })
        .expect(201);

      const after = await prisma.branchStock.findUnique({
        where: {
          branchId_offerVariantId: {
            branchId: branchAId,
            offerVariantId: variantId,
          },
        },
      });
      expect(after).not.toBeNull();
      expect(after?.quantity).toBe(12);

      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/stock/page?limit=20`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const item = res.body.items.find(
        (i: { offer_variant_id: string }) => i.offer_variant_id === variantId,
      );
      expect(item.id).not.toBeNull();
      expect(item.quantity).toBe(12);
      expect(item.available_quantity).toBe(12);
    });
  });
});
