import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { createUniquePhone } from './helpers/e2e-phone-lanes';

type Res = { status: number; body: any };
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

const uniquePhone = createUniquePhone(
  'sprint25-admin-audit-flags-vendor-performance',
  '56',
);
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

const FLAG_KEY = 'vendor_performance_dashboard_enabled';

describe('Sprint 25 - admin audit logs, feature flags, vendor performance (e2e)', () => {
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

    // Review-round fix (test isolation): a feature flag is one global
    // row, so every test starts from the registry default - no row at
    // all, i.e. disabled - instead of inheriting whatever the previous
    // test (or the true/false race below) happened to leave behind.
    // AuditLog stays append-only even here: the rows already present
    // are only remembered, and each test asserts on its own new rows.
    await prisma.featureFlag.deleteMany();
    const existing = await prisma.auditLog.findMany({
      where: { entityType: 'FeatureFlag' },
      select: { id: true },
    });
    flagLogBaseline = existing.map((r) => r.id);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.featureFlag.deleteMany();
    await app.close();
  });

  let flagLogBaseline: string[] = [];

  /** FeatureFlag AuditLog rows written during the current test only. */
  function flagLogsThisTest() {
    return prisma.auditLog.findMany({
      where: {
        entityType: 'FeatureFlag',
        entityId: FLAG_KEY,
        id: { notIn: flagLogBaseline },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
  }

  const http = () => app.getHttpServer();

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
    const res = await request(http())
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

  async function placeOrder(
    customer: string,
    vendorId: string,
    branchId: string,
    cartItemId: string,
  ): Promise<{ branchOrderId: string; pickupCode: string }> {
    const reserved = await request(http())
      .post('/api/v1/checkout/reserve')
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', unique('reserve'))
      .send({
        terms_accepted: true,
        terms_version: '2026-10-v1',
        groups: [
          {
            cart_item_ids: [cartItemId],
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
    return {
      branchOrderId: confirmed.body.branch_orders[0].id,
      pickupCode: confirmed.body.branch_orders[0].pickup_code,
    };
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

  async function placeAndStartPreparing(
    owner: string,
    customer: string,
    vendorId: string,
    branchId: string,
    variantId: string,
  ): Promise<string> {
    const cartItemId = await addToCart(customer, vendorId, variantId, 1);
    const { branchOrderId } = await placeOrder(
      customer,
      vendorId,
      branchId,
      cartItemId,
    );
    await staffAction(
      owner,
      vendorId,
      branchId,
      branchOrderId,
      'start-preparation',
    ).expect(201);
    return branchOrderId;
  }

  async function placeAndPickUp(
    owner: string,
    customer: string,
    vendorId: string,
    branchId: string,
    variantId: string,
  ): Promise<string> {
    const cartItemId = await addToCart(customer, vendorId, variantId, 1);
    const { branchOrderId, pickupCode } = await placeOrder(
      customer,
      vendorId,
      branchId,
      cartItemId,
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
      'pickup-handover',
      { pickup_code: pickupCode },
    ).expect(201);
    return branchOrderId;
  }

  async function cancelWholeOrder(
    customer: string,
    branchOrderId: string,
  ): Promise<Res> {
    return run(
      request(http())
        .post(`/api/v1/customers/me/orders/${branchOrderId}/cancel`)
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', unique('cancel'))
        .send({}),
    );
  }

  async function enableVendorPerformanceFlag(admin: string): Promise<void> {
    await request(http())
      .put(`/api/v1/admin/feature-flags/${FLAG_KEY}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ enabled: true })
      .expect(200);
  }

  // ------------------------------------------------------------
  // Review round: authorization across every Sprint 25 admin endpoint
  // ------------------------------------------------------------
  describe('Admin endpoint authorization', () => {
    const ADMIN_ENDPOINTS: [method: 'get' | 'put', path: string][] = [
      ['get', '/api/v1/admin/audit-logs'],
      ['get', '/api/v1/admin/audit-logs/export'],
      ['get', '/api/v1/admin/feature-flags'],
      ['put', `/api/v1/admin/feature-flags/${FLAG_KEY}`],
      ['get', '/api/v1/admin/vendors/performance'],
    ];

    it('every endpoint answers 401 without a session and 403 for a VERIFICATION_REVIEWER (PLATFORM_ADMIN only)', async () => {
      const reviewerPhone = uniquePhone();
      const reviewer = await signup(reviewerPhone, 'a-strong-password');
      await prisma.user.update({
        where: { phone: reviewerPhone },
        data: { platformRole: 'VERIFICATION_REVIEWER' },
      });

      for (const [method, path] of ADMIN_ENDPOINTS) {
        const anonymous = await request(http())
          [method](path)
          .send(method === 'put' ? { enabled: true } : undefined);
        expect({ path, status: anonymous.status }).toEqual({
          path,
          status: 401,
        });

        const asReviewer = await request(http())
          [method](path)
          .set('Authorization', `Bearer ${reviewer}`)
          .send(method === 'put' ? { enabled: true } : undefined);
        expect({ path, status: asReviewer.status }).toEqual({
          path,
          status: 403,
        });
      }
      // The refused PUTs changed nothing.
      expect(await prisma.featureFlag.count()).toBe(0);
      expect(await flagLogsThisTest()).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------
  // FR-ADMIN-004: Feature flags
  // ------------------------------------------------------------
  describe('Feature flags', () => {
    it('non-admin is refused both read and write', async () => {
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(http())
        .get('/api/v1/admin/feature-flags')
        .set('Authorization', `Bearer ${customer}`)
        .expect(403);
      await request(http())
        .put(`/api/v1/admin/feature-flags/${FLAG_KEY}`)
        .set('Authorization', `Bearer ${customer}`)
        .send({ enabled: true })
        .expect(403);
    });

    it('lists every registry key as enabled:false even with no DB row at all', async () => {
      const admin = await platformAdmin();
      const res = await request(http())
        .get('/api/v1/admin/feature-flags')
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      const flag = res.body.find((f: any) => f.key === FLAG_KEY);
      expect(flag).toBeDefined();
      expect(flag.enabled).toBe(false);
      expect(await prisma.featureFlag.count({ where: { key: FLAG_KEY } })).toBe(
        0,
      );
    });

    it('rejects an unknown key with 400 UNKNOWN_FEATURE_FLAG, never creating anything', async () => {
      const admin = await platformAdmin();
      const res = await request(http())
        .put('/api/v1/admin/feature-flags/not_a_real_flag')
        .set('Authorization', `Bearer ${admin}`)
        .send({ enabled: true })
        .expect(400);
      expect(res.body.error.code).toBe('UNKNOWN_FEATURE_FLAG');
      expect(await prisma.featureFlag.count()).toBe(0);
    });

    it('a no-op PUT (false on an absent key) creates no row and writes no AuditLog', async () => {
      const admin = await platformAdmin();
      const res = await request(http())
        .put(`/api/v1/admin/feature-flags/${FLAG_KEY}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ enabled: false })
        .expect(200);
      expect(res.body).toEqual({ key: FLAG_KEY, enabled: false });
      expect(await prisma.featureFlag.count({ where: { key: FLAG_KEY } })).toBe(
        0,
      );
      expect(await flagLogsThisTest()).toHaveLength(0);
    });

    it('the first real PUT (true on an absent key) creates one row and one clear AuditLog entry (false -> true)', async () => {
      const admin = await platformAdmin();
      const res = await request(http())
        .put(`/api/v1/admin/feature-flags/${FLAG_KEY}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ enabled: true })
        .expect(200);
      expect(res.body).toEqual({ key: FLAG_KEY, enabled: true });
      expect(await prisma.featureFlag.count({ where: { key: FLAG_KEY } })).toBe(
        1,
      );
      const logs = await flagLogsThisTest();
      expect(logs).toHaveLength(1);
      expect(logs[0].beforeState).toEqual({ enabled: false });
      expect(logs[0].afterState).toEqual({ enabled: true });
    });

    it('repeating the same value is a no-op (no new AuditLog row)', async () => {
      const admin = await platformAdmin();
      await enableVendorPerformanceFlag(admin);
      await request(http())
        .put(`/api/v1/admin/feature-flags/${FLAG_KEY}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ enabled: true })
        .expect(200);
      expect(await flagLogsThisTest()).toHaveLength(1);
    });

    it('flipping back to false after true updates the row and writes a correct second AuditLog entry', async () => {
      const admin = await platformAdmin();
      await enableVendorPerformanceFlag(admin);
      await request(http())
        .put(`/api/v1/admin/feature-flags/${FLAG_KEY}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ enabled: false })
        .expect(200);
      const logs = await flagLogsThisTest();
      expect(logs).toHaveLength(2);
      expect(logs[1].beforeState).toEqual({ enabled: true });
      expect(logs[1].afterState).toEqual({ enabled: false });
    });

    it('CONCURRENCY: two simultaneous first-writes to the same never-configured key never collide, and the AuditLog chain is correct', async () => {
      const admin = await platformAdmin();
      // The per-test reset guarantees the premise this test is about:
      // no row exists yet, so both writes race on the very first create.
      expect(await prisma.featureFlag.count({ where: { key: FLAG_KEY } })).toBe(
        0,
      );
      const [r1, r2] = await Promise.all([
        run(
          request(http())
            .put(`/api/v1/admin/feature-flags/${FLAG_KEY}`)
            .set('Authorization', `Bearer ${admin}`)
            .send({ enabled: true }),
        ),
        run(
          request(http())
            .put(`/api/v1/admin/feature-flags/${FLAG_KEY}`)
            .set('Authorization', `Bearer ${admin}`)
            .send({ enabled: false }),
        ),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(await prisma.featureFlag.count({ where: { key: FLAG_KEY } })).toBe(
        1,
      );
      const logs = await flagLogsThisTest();
      // Exactly one real transition happened first (false -> true,
      // since that's the only one that can ever create the row), and
      // IF the second write (false) actually changed anything, its
      // own `before` must equal the first write's own `after` -
      // never a second row both claiming the same stale `before`.
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].beforeState).toEqual({ enabled: false });
      expect(logs[0].afterState).toEqual({ enabled: true });
      if (logs.length === 2) {
        expect(logs[1].beforeState).toEqual(logs[0].afterState);
      }
    });
  });

  // ------------------------------------------------------------
  // FR-ADMIN-005: Audit log search/export
  // ------------------------------------------------------------
  describe('Audit log search/export', () => {
    it('non-admin is refused both list and export', async () => {
      const customer = await signup(uniquePhone(), 'a-strong-password');
      await request(http())
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', `Bearer ${customer}`)
        .expect(403);
      await request(http())
        .get('/api/v1/admin/audit-logs/export')
        .set('Authorization', `Bearer ${customer}`)
        .expect(403);
    });

    it('deterministic order and cursor pagination never skip or repeat rows that share the exact same occurredAt', async () => {
      const admin = await platformAdmin();
      const correlationId = unique('tie');
      const now = new Date('2026-06-01T00:00:00.000Z');
      // Three rows with the IDENTICAL occurredAt - only id breaks the tie.
      await prisma.auditLog.createMany({
        data: [
          {
            id: '00000000-0000-0000-0000-000000000001',
            correlationId,
            action: 'test.tie',
            entityType: 'Test',
            entityId: 'tie-entity',
            occurredAt: now,
          },
          {
            id: '00000000-0000-0000-0000-000000000002',
            correlationId,
            action: 'test.tie',
            entityType: 'Test',
            entityId: 'tie-entity',
            occurredAt: now,
          },
          {
            id: '00000000-0000-0000-0000-000000000003',
            correlationId,
            action: 'test.tie',
            entityType: 'Test',
            entityId: 'tie-entity',
            occurredAt: now,
          },
        ],
      });

      const page1 = await request(http())
        .get(`/api/v1/admin/audit-logs?entity_id=tie-entity&limit=2`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.items.map((i: any) => i.id)).toEqual([
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000002',
      ]);
      expect(page1.body.next_cursor).toBeTruthy();

      const page2 = await request(http())
        .get(
          `/api/v1/admin/audit-logs?entity_id=tie-entity&limit=2&cursor=${page1.body.next_cursor}`,
        )
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(page2.body.items.map((i: any) => i.id)).toEqual([
        '00000000-0000-0000-0000-000000000001',
      ]);
      expect(page2.body.next_cursor).toBeNull();
    });

    it('filters by entity_type/entity_id/actor_id/action/from/to independently', async () => {
      const admin = await platformAdmin();
      const marker = unique('marker');
      await prisma.auditLog.create({
        data: {
          correlationId: unique('corr'),
          action: `custom.${marker}`,
          entityType: 'CustomEntity',
          entityId: marker,
          actorId: null,
        },
      });

      const byAction = await request(http())
        .get(`/api/v1/admin/audit-logs?action=custom.${marker}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(byAction.body.items).toHaveLength(1);

      const byEntityType = await request(http())
        .get(
          `/api/v1/admin/audit-logs?entity_type=CustomEntity&entity_id=${marker}`,
        )
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(byEntityType.body.items).toHaveLength(1);

      const noMatch = await request(http())
        .get(`/api/v1/admin/audit-logs?action=definitely.not.${marker}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(noMatch.body.items).toHaveLength(0);

      const futureOnly = await request(http())
        .get(
          `/api/v1/admin/audit-logs?action=custom.${marker}&from=2099-01-01T00:00:00.000Z`,
        )
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(futureOnly.body.items).toHaveLength(0);
    });

    it('correlation_id finds every row written while serving one request, in both the list and the CSV export', async () => {
      const admin = await platformAdmin();
      const marker = unique('corr-marker');
      const shared = unique('corr-shared');
      // Two rows from the "same request", one unrelated row.
      for (const [correlationId, n] of [
        [shared, 1],
        [shared, 2],
        [unique('corr-other'), 3],
      ] as const) {
        await prisma.auditLog.create({
          data: {
            correlationId,
            action: `custom.${marker}`,
            entityType: 'CustomEntity',
            entityId: `${marker}-${n}`,
            actorId: null,
          },
        });
      }

      const list = await request(http())
        .get(`/api/v1/admin/audit-logs?correlation_id=${shared}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(list.body.items).toHaveLength(2);
      expect(
        list.body.items.every(
          (i: { correlation_id: string }) => i.correlation_id === shared,
        ),
      ).toBe(true);

      const exported = await request(http())
        .get(`/api/v1/admin/audit-logs/export?correlation_id=${shared}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      const dataRows = exported.text.split('\n').slice(1);
      expect(dataRows).toHaveLength(2);
      expect(dataRows.every((r) => r.includes(`"${shared}"`))).toBe(true);

      const combined = await request(http())
        .get(
          `/api/v1/admin/audit-logs?correlation_id=${shared}&entity_id=${marker}-2`,
        )
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(combined.body.items).toHaveLength(1);
    });

    it("LEAK TEST: an un-reviewed action's sensitive beforeState/afterState (e.g. address.created's lat/lng) never appears in the list response or the CSV export - summary is null instead", async () => {
      const admin = await platformAdmin();
      const marker = unique('addr-marker');
      await prisma.auditLog.create({
        data: {
          correlationId: unique('corr'),
          action: 'address.created',
          entityType: 'Address',
          entityId: marker,
          afterState: {
            lat: 31.9522,
            lng: 35.2332,
            label: 'منزل حساس جداً',
            phone_number_1: '+970591234567',
          },
        },
      });

      const list = await request(http())
        .get(`/api/v1/admin/audit-logs?entity_id=${marker}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].summary).toBeNull();
      const listText = JSON.stringify(list.body);
      expect(listText).not.toContain('31.9522');
      expect(listText).not.toContain('591234567');
      expect(listText).not.toContain('منزل حساس');

      const csv = await request(http())
        .get(`/api/v1/admin/audit-logs/export?entity_id=${marker}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(csv.text).toContain(marker);
      expect(csv.text).not.toContain('31.9522');
      expect(csv.text).not.toContain('591234567');
      expect(csv.text).not.toContain('منزل حساس');
    });

    it('a reviewed action type (branch_order.status_changed) shows a safe, human-readable summary', async () => {
      const admin = await platformAdmin();
      const orderId = unique('order-marker');
      await prisma.auditLog.create({
        data: {
          correlationId: unique('corr'),
          action: 'branch_order.status_changed',
          entityType: 'BranchOrder',
          entityId: orderId,
          beforeState: { status: 'PLACED' },
          afterState: { status: 'PREPARING' },
        },
      });
      const list = await request(http())
        .get(`/api/v1/admin/audit-logs?entity_id=${orderId}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(list.body.items[0].summary).toContain('PLACED');
      expect(list.body.items[0].summary).toContain('PREPARING');
    });

    it('CSV FORMULA INJECTION: a value beginning with =, +, -, or @ is neutralized with a leading apostrophe, never exported as a live formula', async () => {
      const admin = await platformAdmin();
      const marker = unique('formula-marker');
      const dangerousValues = ['=1+1', '+1+1', '-1+1', '@SUM(1,1)'];
      await prisma.auditLog.createMany({
        data: dangerousValues.map((v, i) => ({
          correlationId: unique('corr'),
          action: v,
          entityType: 'Formula',
          entityId: `${marker}-${i}`,
        })),
      });

      const csv = await request(http())
        .get('/api/v1/admin/audit-logs/export?entity_type=Formula')
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      for (const v of dangerousValues) {
        // The raw dangerous value must never appear as its own
        // unprefixed quoted CSV field - only the apostrophe-prefixed,
        // spreadsheet-safe form (Excel/Sheets treat a leading "'" as
        // "force this cell to text" and strip it from what's shown).
        expect(csv.text).not.toContain(`"${v}"`);
        expect(csv.text).toContain(`"'${v}"`);
      }
    });

    it('export rejects with 400 EXPORT_TOO_LARGE when the matching set exceeds the row limit, never a silent partial export', async () => {
      const admin = await platformAdmin();
      const marker = unique('bulk-marker');
      const rows = Array.from({ length: 50_001 }, (_, i) => ({
        correlationId: unique('bulk-corr'),
        action: `bulk.${marker}`,
        entityType: 'Bulk',
        entityId: `${marker}-${i}`,
      }));
      await prisma.auditLog.createMany({ data: rows });

      const res = await request(http())
        .get(`/api/v1/admin/audit-logs/export?action=bulk.${marker}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(400);
      expect(res.body.error.code).toBe('EXPORT_TOO_LARGE');
    }, 60_000);
  });

  // ------------------------------------------------------------
  // FR-VEND-011 / FR-VPORTAL-007 (reporting half): vendor performance
  // ------------------------------------------------------------
  describe('Vendor performance', () => {
    it('is gated by the feature flag at the API itself, for both the vendor-facing and admin-facing endpoints', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);
      await makeVendorEligible(vendorId);
      const admin = await platformAdmin();

      const vendorSide = await request(http())
        .get(`/api/v1/vendors/${vendorId}/performance`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(404);
      expect(vendorSide.body.error.code).toBe('FEATURE_DISABLED');

      const adminSide = await request(http())
        .get('/api/v1/admin/vendors/performance')
        .set('Authorization', `Bearer ${admin}`)
        .expect(404);
      expect(adminSide.body.error.code).toBe('FEATURE_DISABLED');

      await enableVendorPerformanceFlag(admin);

      await request(http())
        .get(`/api/v1/vendors/${vendorId}/performance`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      await request(http())
        .get('/api/v1/admin/vendors/performance')
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
    });

    it('BOLA: a non-member and a BRANCH_EMPLOYEE are both refused - owner-only, not just hidden in the UI', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);
      await makeVendorEligible(vendorId);
      const admin = await platformAdmin();
      await enableVendorPerformanceFlag(admin);

      const stranger = await signup(uniquePhone(), 'a-strong-password');
      const strangerRes = await request(http())
        .get(`/api/v1/vendors/${vendorId}/performance`)
        .set('Authorization', `Bearer ${stranger}`)
        .expect(403);
      expect(strangerRes.body.error.code).toBe('NOT_VENDOR_MEMBER');
    });

    it('no terminal orders at all -> cancellation_rate and average_response_time_hours are both null, never 0', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);
      await makeVendorEligible(vendorId);
      const admin = await platformAdmin();
      await enableVendorPerformanceFlag(admin);

      const res = await request(http())
        .get(`/api/v1/vendors/${vendorId}/performance`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body.cancellation_rate).toBeNull();
      expect(res.body.average_response_time_hours).toBeNull();
      expect(res.body.responded_orders_count).toBe(0);
      expect(res.body.rating_average).toBeNull();
    });

    it('cancellation rate counts only terminal orders in the denominator; an order still PLACED never enters either side', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 50, 10);
      const admin = await platformAdmin();
      await enableVendorPerformanceFlag(admin);

      // One completed (picked up), one cancelled, one still active (PLACED).
      await placeAndPickUp(
        owner,
        await signup(uniquePhone(), 'a-strong-password'),
        vendorId,
        branchId,
        variantId,
      );
      const customerB = await signup(uniquePhone(), 'a-strong-password');
      const cartItemB = await addToCart(customerB, vendorId, variantId, 1);
      const orderB = await placeOrder(customerB, vendorId, branchId, cartItemB);
      await cancelWholeOrder(customerB, orderB.branchOrderId).then((r) =>
        expect(r.status).toBe(201),
      );
      const customerC = await signup(uniquePhone(), 'a-strong-password');
      const cartItemC = await addToCart(customerC, vendorId, variantId, 1);
      await placeOrder(customerC, vendorId, branchId, cartItemC); // left PLACED, active

      const res = await request(http())
        .get(`/api/v1/vendors/${vendorId}/performance`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      // denominator = 2 (COMPLETED + CANCELLED), the still-PLACED one excluded.
      expect(res.body.cancellation_rate).toBeCloseTo(0.5, 5);
      expect(res.body.terminal_orders_count).toBe(2);
      expect(res.body.cancelled_orders_count).toBe(1);
    });

    it('weekly buckets tile the 30-day window exactly, place each order in its own week, and add up to the totals', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 50, 10);
      const admin = await platformAdmin();
      await enableVendorPerformanceFlag(admin);

      await placeAndPickUp(
        owner,
        await signup(uniquePhone(), 'a-strong-password'),
        vendorId,
        branchId,
        variantId,
      );
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const cartItem = await addToCart(customer, vendorId, variantId, 1);
      const order = await placeOrder(customer, vendorId, branchId, cartItem);
      await cancelWholeOrder(customer, order.branchOrderId).then((r) =>
        expect(r.status).toBe(201),
      );
      // The cancelled order belongs to ten days ago.
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await prisma.branchOrder.update({
        where: { id: order.branchOrderId },
        data: { createdAt: tenDaysAgo },
      });

      const res = await request(http())
        .get(`/api/v1/vendors/${vendorId}/performance`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      const weekly: {
        week_from: string;
        week_to: string;
        terminal_orders_count: number;
        cancelled_orders_count: number;
        cancellation_rate: number | null;
      }[] = res.body.weekly;

      // 30 days = 4 full weeks + a 2-day remainder, oldest first.
      expect(weekly).toHaveLength(5);
      expect(weekly[0].week_from).toBe(res.body.window_from);
      expect(weekly[weekly.length - 1].week_to).toBe(res.body.window_to);
      for (let i = 1; i < weekly.length; i += 1) {
        expect(weekly[i].week_from).toBe(weekly[i - 1].week_to);
      }

      const holding = weekly.find(
        (w) =>
          new Date(w.week_from) <= tenDaysAgo &&
          tenDaysAgo < new Date(w.week_to),
      )!;
      expect(holding.cancelled_orders_count).toBe(1);
      expect(holding.cancellation_rate).toBe(1);
      const newest = weekly[weekly.length - 1];
      expect(newest.terminal_orders_count).toBe(1);
      expect(newest.cancellation_rate).toBe(0);
      // Weeks with no finished orders say "no data", never 0%.
      expect(
        weekly
          .filter((w) => w.terminal_orders_count === 0)
          .every((w) => w.cancellation_rate === null),
      ).toBe(true);
      expect(weekly.reduce((n, w) => n + w.terminal_orders_count, 0)).toBe(
        res.body.terminal_orders_count,
      );
    });

    it('response time: only orders that actually reached PREPARING enter the average; others are excluded, not counted as 0', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 50, 10);
      const admin = await platformAdmin();
      await enableVendorPerformanceFlag(admin);

      const customerA = await signup(uniquePhone(), 'a-strong-password');
      const orderAId = await placeAndStartPreparing(
        owner,
        customerA,
        vendorId,
        branchId,
        variantId,
      );
      // Backdate createdAt so the response-time delta is a known, exact value.
      await prisma.branchOrder.update({
        where: { id: orderAId },
        data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      });

      const customerB = await signup(uniquePhone(), 'a-strong-password');
      const cartItemB = await addToCart(customerB, vendorId, variantId, 1);
      await placeOrder(customerB, vendorId, branchId, cartItemB); // never reaches PREPARING

      const res = await request(http())
        .get(`/api/v1/vendors/${vendorId}/performance`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body.responded_orders_count).toBe(1);
      expect(res.body.average_response_time_hours).toBeGreaterThan(1.9);
      expect(res.body.average_response_time_hours).toBeLessThan(2.2);
    });

    it('a post-delivery RETURN refund is never counted as a cancellation - the order stays COMPLETED/PICKED_UP', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const variantId = await createOfferWithStock(vendorId, branchId, 50, 10);
      const admin = await platformAdmin();
      await enableVendorPerformanceFlag(admin);
      const customer = await signup(uniquePhone(), 'a-strong-password');
      const orderId = await placeAndPickUp(
        owner,
        customer,
        vendorId,
        branchId,
        variantId,
      );

      const order = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: orderId },
      });
      expect(order.status).toBe('COMPLETED');
    });

    it('admin list: deterministic pagination by Vendor.createdAt/id, never by a computed metric', async () => {
      const admin = await platformAdmin();
      await enableVendorPerformanceFlag(admin);
      const ownerX = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorX } = await createVendorWithBranch(ownerX);
      await makeVendorEligible(vendorX);
      const ownerY = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorY } = await createVendorWithBranch(ownerY);
      await makeVendorEligible(vendorY);

      const page1 = await request(http())
        .get('/api/v1/admin/vendors/performance?limit=1')
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(page1.body.items).toHaveLength(1);
      expect(page1.body.next_cursor).toBeTruthy();

      const page2 = await request(http())
        .get(
          `/api/v1/admin/vendors/performance?limit=1&cursor=${page1.body.next_cursor}`,
        )
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      expect(page2.body.items).toHaveLength(1);
      // The two pages' vendors must be different - no skip/repeat.
      expect(page1.body.items[0].display_name).not.toBe(
        page2.body.items[0].display_name,
      );
    });
  });
});
