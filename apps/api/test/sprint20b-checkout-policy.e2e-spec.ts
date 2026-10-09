import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuditLogService } from './../src/audit/audit-log.service';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { createUniquePhone } from './helpers/e2e-phone-lanes';

type Res = { status: number; body: any };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// supertest's Test object is lazy - it only actually dispatches the
// HTTP request once something calls .then()/.end() on it. A bare
// `Promise.all([testA, testB])` happens to trigger both immediately
// (Promise.all adopts each thenable via its own .then() call in the
// same tick), but firing one request, awaiting a barrier, and only
// THEN firing the second does NOT - the first request would never
// actually be sent before the await, so a barrier on anything inside
// its handler would hang forever. Promise.resolve(t) forces the
// dispatch immediately (same fix as sprint16-moderation-concurrency's
// own `run()` helper).
const run = (t: PromiseLike<Res>): Promise<Res> => Promise.resolve(t);

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
    jest.restoreAllMocks();
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
        return_policy: { mode: 'NO_RETURN' },
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

  // ------------------------------------------------------------
  // Review-round fix: genuine lock-contention proof, same pattern
  // as sprint16-moderation-concurrency.e2e-spec.ts's own
  // barrierOnAudit/someoneWaitsOnVendorLock - a bare Promise.all
  // proves nothing about actual serialization (both the locked and
  // the unlocked version can produce the same final rows if the two
  // requests merely happen to run sequentially on the event loop).
  // These pause the FIRST call's AuditLogService.record() - which
  // runs AFTER the row/advisory lock is taken and the update/upsert
  // has executed, but BEFORE that transaction commits - so the
  // second request's genuine wait on the SAME lock can be observed
  // directly in pg_stat_activity before release.
  // ------------------------------------------------------------
  function barrierOnAudit(action: string) {
    const audit = app!.get(AuditLogService);
    const original = audit.record.bind(audit);
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hit = new Promise<void>((r) => (reached = r));
    let armed = true;
    jest.spyOn(audit, 'record').mockImplementation(async (input, tx) => {
      if (armed && input.action === action) {
        armed = false;
        reached();
        await gate;
      }
      return original(input, tx);
    });
    return {
      release: () => release(),
      reached: () =>
        Promise.race([
          hit,
          sleep(10_000).then(() => {
            throw new Error(`barrier: '${action}' was never reached`);
          }),
        ]),
    };
  }

  const settledWithin = (p: Promise<unknown>, ms: number) =>
    Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      sleep(ms).then(() => false),
    ]);

  /** A session is genuinely blocked right now waiting on a lock whose query text matches `queryPattern` (an ILIKE fragment, e.g. '%FROM store_branches%FOR UPDATE%'). */
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

    // Review-round fix: a bare Promise.all proves nothing - both the
    // buggy unlocked version and the fixed version can leave behind
    // the exact same final rows if the two requests merely happen to
    // run sequentially on the event loop rather than genuinely
    // contending on the lock. This barrier PROVES real serialization:
    // A is paused (via its own AuditLogService.record() call) AFTER
    // taking `FOR UPDATE` and running its update, but BEFORE commit;
    // B is then fired and shown to be truly blocked in Postgres itself
    // (pg_stat_activity, wait_event_type = 'Lock') - not merely slow -
    // before A is released. Run across three independent cycles
    // (fresh barrier each time) so this isn't a one-off.
    it('deterministic concurrency (barrier-proven): a second branch-minimum PUT genuinely waits on the FIRST ones row lock, then chains before/after correctly - repeated 3x', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      await setBranchMinimum(owner, vendorId, branchId, 50).expect(200);

      let currentValue = 50;
      const cycles: [number, number][] = [
        [80, 100],
        [60, 70],
        [90, 110],
      ];
      for (const [targetA, targetB] of cycles) {
        const barrier = barrierOnAudit(
          'store_branch.minimum_order_value_updated',
        );
        const resAPromise: Promise<Res> = run(
          setBranchMinimum(owner, vendorId, branchId, targetA),
        );
        await barrier.reached(); // A holds the row lock, update ran, NOT yet committed
        const resBPromise: Promise<Res> = run(
          setBranchMinimum(owner, vendorId, branchId, targetB),
        );

        expect(
          await someoneWaitsOnLock('%FROM store_branches%FOR UPDATE%'),
        ).toBe(true);
        expect(await settledWithin(resBPromise, 700)).toBe(false);
        // Proof, not inference: while A is held, the row must still
        // read as the PRE-cycle value - B has made no progress at all.
        const whileHeld = await prisma.storeBranch.findUniqueOrThrow({
          where: { id: branchId },
        });
        expect(
          whileHeld.minimumOrderValue == null
            ? null
            : Number(whileHeld.minimumOrderValue),
        ).toBe(currentValue);

        barrier.release();
        const [resA, resB] = await Promise.all([resAPromise, resBPromise]);
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);

        const rows = await prisma.auditLog.findMany({
          where: {
            entityType: 'StoreBranch',
            entityId: branchId,
            action: 'store_branch.minimum_order_value_updated',
          },
        });
        const rowA = rows.find(
          (r) =>
            (r.afterState as { minimum_order_value: number })
              .minimum_order_value === targetA,
        );
        const rowB = rows.find(
          (r) =>
            (r.afterState as { minimum_order_value: number })
              .minimum_order_value === targetB,
        );
        expect(rowA).toBeDefined();
        expect(rowB).toBeDefined();
        // A (released first, since the barrier held it) committed
        // from the pre-cycle value; B - genuinely blocked until A
        // committed - must chain from A's own new value, never a
        // stale re-read of the pre-cycle value.
        expect(
          (rowA!.beforeState as { minimum_order_value: number | null })
            .minimum_order_value,
        ).toBe(currentValue);
        expect(
          (rowB!.beforeState as { minimum_order_value: number })
            .minimum_order_value,
        ).toBe(targetA);

        const finalBranch = await prisma.storeBranch.findUniqueOrThrow({
          where: { id: branchId },
        });
        expect(Number(finalBranch.minimumOrderValue)).toBe(targetB);

        currentValue = targetB;
        jest.restoreAllMocks();
      }
    });

    // Same proof, for the harder case: a region with NO
    // VendorDeliveryZone row at all yet, where a plain `FOR UPDATE`
    // has nothing to lock - the advisory lock must be what B is
    // genuinely waiting on instead.
    it('deterministic concurrency (barrier-proven): a second zone-minimum PUT on a region with no row yet genuinely waits on the advisory lock, then chains before/after correctly - repeated 3x', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);

      let currentValue: number | null = null;
      const cycles: [number, number][] = [
        [80, 100],
        [60, 70],
        [90, 110],
      ];
      for (const [targetA, targetB] of cycles) {
        const barrier = barrierOnAudit(
          'vendor_delivery_zone.minimum_order_value_updated',
        );
        const resAPromise: Promise<Res> = run(
          setZoneMinimum(owner, vendorId, 'JERUSALEM', targetA),
        );
        await barrier.reached(); // A holds the advisory lock, upsert ran, NOT yet committed
        const resBPromise: Promise<Res> = run(
          setZoneMinimum(owner, vendorId, 'JERUSALEM', targetB),
        );

        expect(
          await someoneWaitsOnLock(
            '%pg_advisory_xact_lock%delivery_zone_minimum%',
          ),
        ).toBe(true);
        expect(await settledWithin(resBPromise, 700)).toBe(false);

        barrier.release();
        const [resA, resB] = await Promise.all([resAPromise, resBPromise]);
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);

        const zoneRows = await prisma.vendorDeliveryZone.findMany({
          where: { vendorId, region: 'JERUSALEM' },
        });
        expect(zoneRows).toHaveLength(1); // never a duplicate row

        const rows = await prisma.auditLog.findMany({
          where: {
            entityType: 'VendorDeliveryZone',
            entityId: zoneRows[0].id,
            action: 'vendor_delivery_zone.minimum_order_value_updated',
          },
        });
        const rowA = rows.find(
          (r) =>
            (r.afterState as { minimum_order_value: number })
              .minimum_order_value === targetA,
        );
        const rowB = rows.find(
          (r) =>
            (r.afterState as { minimum_order_value: number })
              .minimum_order_value === targetB,
        );
        expect(rowA).toBeDefined();
        expect(rowB).toBeDefined();
        expect(
          (rowA!.beforeState as { minimum_order_value: number | null })
            .minimum_order_value,
        ).toBe(currentValue);
        expect(
          (rowB!.beforeState as { minimum_order_value: number })
            .minimum_order_value,
        ).toBe(targetA);
        expect(Number(zoneRows[0].minimumOrderValue)).toBe(targetB);

        currentValue = targetB;
        jest.restoreAllMocks();
      }
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
  // Review-round fix: the catalogue now has TWO structured blocker
  // codes - BELOW_MINIMUM_ORDER_VALUE (above) and
  // DELIVERY_NOT_AVAILABLE_IN_ZONE (below) - both surfaced explicitly
  // in `blockers[]`, never only as an implicit null on
  // `delivery_fee`/`minimum_order_value`. A branch that is itself
  // ineligible (closed/archived/suspended/out of stock) never appears
  // in `eligible_branches` at all - there is no row to attach a
  // blocker to - and a cart item left with NO eligible branch anywhere
  // already surfaces through the existing, safe, structured
  // `unavailable_items[].reason` (pre-existing Sprint 10/18b behavior,
  // unchanged here - it names no branch and no stock figure, so it
  // leaks nothing a customer isn't entitled to know).
  // ============================================================
  describe('Conflict catalogue in quote() (FR-CART-015)', () => {
    it('two separate groups in one quote(): a minimum-order blocker in one group never appears on the other', async () => {
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

    it('a zone with no delivery coverage is now a real structured DELIVERY_NOT_AVAILABLE_IN_ZONE blocker, not just a null field', async () => {
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
      // The null fields still carry the raw numbers (unchanged) -
      // but the UI must not rely on them as an implicit signal any
      // more, since a real blocker is now also present.
      expect(branch.delivery_fee).toBeNull();
      expect(branch.minimum_order_value.delivery).toBeNull();
      expect(branch.blockers).toHaveLength(1);
      expect(branch.blockers[0].code).toBe('DELIVERY_NOT_AVAILABLE_IN_ZONE');
      expect(branch.blockers[0].fulfilment_method).toBe('DELIVERY');
      // Discloses nothing branch/zone/stock-specific.
      expect(branch.blockers[0]).not.toHaveProperty('region');
      expect(branch.blockers[0]).not.toHaveProperty('fee');
    });

    it('a zone the vendor explicitly disabled (not just "never configured") is the same blocker', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      await request(app.getHttpServer())
        .put(`/api/v1/vendors/${vendorId}/delivery-zones/WEST_BANK`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ enabled: false, fee: 10 })
        .expect(200);

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'WEST_BANK');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const res = await quote(customer, [itemId], addressId).expect(201);
      const branch = res.body.groups[0].eligible_branches.find(
        (b: { branch_id: string }) => b.branch_id === branchId,
      );
      expect(branch.blockers).toHaveLength(1);
      expect(branch.blockers[0].code).toBe('DELIVERY_NOT_AVAILABLE_IN_ZONE');
    });

    it('no address supplied yet -> no delivery-coverage blocker at all (no delivery intent stated, nothing to warn about)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      // No zone ever configured, but also no address supplied.

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const res = await quote(customer, [itemId]).expect(201);
      const branch = res.body.groups[0].eligible_branches.find(
        (b: { branch_id: string }) => b.branch_id === branchId,
      );
      expect(branch.blockers).toHaveLength(0);
    });

    it('a zone that IS covered never gets the blocker (no false positive)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 20, 5);
      await setZoneFee(owner, vendorId, 'WEST_BANK', 10);

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'WEST_BANK');
      const itemId = await addToCart(customer, vendorId, variantId, 1);

      const res = await quote(customer, [itemId], addressId).expect(201);
      const branch = res.body.groups[0].eligible_branches.find(
        (b: { branch_id: string }) => b.branch_id === branchId,
      );
      expect(branch.delivery_fee).toBe(10);
      expect(branch.blockers).toHaveLength(0);
    });

    it('two separate groups in one quote(): a delivery-coverage blocker in one group never appears on the other', async () => {
      const ownerNoCoverage = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorNoCoverageId, branchId: branchNoCoverageId } =
        await createVendorWithBranch(ownerNoCoverage);
      const variantNoCoverageId = await createOfferWithStock(
        vendorNoCoverageId,
        branchNoCoverageId,
        20,
        5,
      );
      // No setZoneFee() for this vendor at all - INSIDE is not covered.

      const ownerCovered = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorCoveredId, branchId: branchCoveredId } =
        await createVendorWithBranch(ownerCovered);
      const variantCoveredId = await createOfferWithStock(
        vendorCoveredId,
        branchCoveredId,
        20,
        5,
      );
      await setZoneFee(ownerCovered, vendorCoveredId, 'INSIDE', 5);

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const addressId = await createAddress(customer, 'INSIDE');
      const itemNoCoverageId = await addToCart(
        customer,
        vendorNoCoverageId,
        variantNoCoverageId,
        1,
      );
      const itemCoveredId = await addToCart(
        customer,
        vendorCoveredId,
        variantCoveredId,
        1,
      );

      const res = await quote(
        customer,
        [itemNoCoverageId, itemCoveredId],
        addressId,
      ).expect(201);
      expect(res.body.groups).toHaveLength(2);

      const groupNoCoverage = res.body.groups.find(
        (g: { vendor_id: string }) => g.vendor_id === vendorNoCoverageId,
      );
      const groupCovered = res.body.groups.find(
        (g: { vendor_id: string }) => g.vendor_id === vendorCoveredId,
      );
      const branchNoCoverage = groupNoCoverage.eligible_branches.find(
        (b: { branch_id: string }) => b.branch_id === branchNoCoverageId,
      );
      const branchCovered = groupCovered.eligible_branches.find(
        (b: { branch_id: string }) => b.branch_id === branchCoveredId,
      );

      expect(branchNoCoverage.blockers).toHaveLength(1);
      expect(branchNoCoverage.blockers[0].code).toBe(
        'DELIVERY_NOT_AVAILABLE_IN_ZONE',
      );
      // The OTHER group's covered branch must stay completely unaffected.
      expect(branchCovered.blockers).toHaveLength(0);
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
          return_policy: { mode: 'NO_RETURN' },
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
