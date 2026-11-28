import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  localMidnightUtc,
  parsePeriod,
} from './../src/platform-admin/analytics-period.util';
import { uniqueTestPhone } from './helpers/test-phone';

// VIA phase 4 - Dashboard and Analytics. Fixtures are written straight to
// the (isolated) database with chosen timestamps, each test in its own
// historic local-day window, so every figure is asserted exactly:
// completed merchandise GMV from line snapshots, pre-completion
// cancellations not subtracted twice, later refunds, merchandise vs
// delivery-fee refunds, returns without refunds, multi-branch checkouts,
// POS kept apart, Asia/Hebron day boundaries, repeat buyers, exports,
// authorization.

let seq = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++seq}`;
const at = (iso: string) => new Date(iso);

describe('Phase 4 - Dashboard and Analytics (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { id: string; token: string };

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
    admin = await account('PLATFORM_ADMIN');
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function account(
    platformRole: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER' | null = null,
    createdAt?: Date,
  ) {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'x',
        phoneVerifiedAt: new Date(),
        platformRole,
        ...(createdAt ? { createdAt } : {}),
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

  async function store(name = unique('متجر')) {
    const owner = await account();
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('an').toLowerCase(),
        legalName: unique('legal'),
        displayName: name,
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('فرع'),
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: vendor.id,
        titleAr: unique('قطعة'),
        titleEn: 'Item',
        status: 'ACTIVE',
      },
    });
    const variant = await prisma.offerVariant.create({
      data: {
        vendorId: vendor.id,
        vendorOfferId: offer.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 1,
      },
    });
    return { owner, vendor, branch, offer, variant };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  async function checkout(customerProfileId: string, createdAt: Date) {
    return prisma.customerOrder.create({
      data: { customerId: customerProfileId, createdAt },
    });
  }

  /** A BranchOrder with lines; amounts consistent with the DB checks. */
  async function branchOrder(
    s: Store,
    customerOrderId: string,
    o: {
      createdAt: Date;
      completedAt?: Date;
      status?: 'PLACED' | 'COMPLETED' | 'CANCELLED';
      deliveryFee?: number;
      lines: { price: number; qty: number; cancelledAt?: Date }[];
    },
  ) {
    const subtotal = o.lines.reduce((n, l) => n + l.price * l.qty, 0);
    const bo = await prisma.branchOrder.create({
      data: {
        customerOrderId,
        vendorId: s.vendor.id,
        branchId: s.branch.id,
        fulfilmentMethod: o.deliveryFee ? 'DELIVERY' : 'PICKUP',
        paymentMethod: 'ONLINE',
        status: o.status ?? (o.completedAt ? 'COMPLETED' : 'PLACED'),
        subtotal,
        deliveryFee: o.deliveryFee ?? null,
        total: subtotal + (o.deliveryFee ?? 0),
        createdAt: o.createdAt,
        completedAt: o.completedAt ?? null,
      },
    });
    const items = [];
    for (const l of o.lines) {
      items.push(
        await prisma.branchOrderItem.create({
          data: {
            vendorId: s.vendor.id,
            branchOrderId: bo.id,
            offerVariantId: s.variant.id,
            quantity: l.qty,
            unitPrice: l.price,
            titleArSnapshot: 'لقطة',
            createdAt: o.createdAt,
            cancelledAt: l.cancelledAt ?? null,
          },
        }),
      );
    }
    return { bo, items };
  }

  async function refund(
    branchOrderId: string,
    amount: number,
    reason: 'ITEM_CANCELLED' | 'DELIVERY_FEE' | 'ITEM_RETURNED',
    createdAt: Date,
    itemId: string | null = null,
  ) {
    return prisma.branchOrderRefund.create({
      data: {
        branchOrderId,
        branchOrderItemId: itemId,
        amount,
        reason,
        initiatedBy: 'SYSTEM',
        method: 'ONLINE_GATEWAY',
        createdAt,
      },
    });
  }

  let saleNo = 1000;
  async function posSale(
    s: Store,
    total: number,
    createdAt: Date,
    voided = false,
  ) {
    saleNo += 1;
    return prisma.storeSale.create({
      data: {
        vendorId: s.vendor.id,
        branchId: s.branch.id,
        saleNumber: saleNo,
        status: voided ? 'VOIDED' : 'COMPLETED',
        paymentMethod: 'CASH',
        total,
        currency: 'ILS',
        soldById: s.owner.id,
        createdAt,
        ...(voided
          ? {
              voidedAt: createdAt,
              voidedById: s.owner.id,
              voidReason: 'خطأ في البيع',
            }
          : {}),
      },
    });
  }

  const report = (from: string, to: string) =>
    request(http())
      .get('/api/v1/admin/analytics/report')
      .query({ from, to })
      .set(auth(admin.token));

  it('authorization: dashboard, report and every export are PLATFORM_ADMIN only', async () => {
    const customer = await account();
    const reviewer = await account('VERIFICATION_REVIEWER');
    for (const path of [
      '/api/v1/admin/analytics/dashboard',
      '/api/v1/admin/analytics/report',
      '/api/v1/admin/analytics/export?section=overview&format=csv',
      '/api/v1/admin/analytics/export?section=stores&format=xlsx',
    ]) {
      await request(http()).get(path).expect(401);
      for (const who of [customer, reviewer]) {
        await request(http()).get(path).set(auth(who.token)).expect(403);
      }
      await request(http()).get(path).set(auth(admin.token)).expect(200);
    }
  });

  it('periods: Asia/Hebron local days as half-open UTC intervals (DST aware); equal-length previous period; bad input refused', async () => {
    // Winter (UTC+2) and summer (UTC+3) local midnights.
    expect(localMidnightUtc('2025-01-15').toISOString()).toBe(
      '2025-01-14T22:00:00.000Z',
    );
    expect(localMidnightUtc('2025-07-15').toISOString()).toBe(
      '2025-07-14T21:00:00.000Z',
    );
    const { current, previous } = parsePeriod('2025-01-10', '2025-01-16');
    expect(current.days).toBe(7);
    // Across a month end and across a DST change: still whole days.
    expect(parsePeriod('2026-10-28', '2026-11-26').current.days).toBe(30);
    expect(parsePeriod('2025-02-27', '2025-03-02').current.days).toBe(4);
    const dst = parsePeriod('2025-10-20', '2025-11-02').current;
    expect(dst.days).toBe(14);
    expect(dst.start.toISOString()).toBe('2025-10-19T21:00:00.000Z'); // UTC+3
    expect(dst.end.toISOString()).toBe('2025-11-02T22:00:00.000Z'); // UTC+2
    expect(previous).toMatchObject({
      from: '2025-01-03',
      to: '2025-01-09',
      days: 7,
    });
    expect(previous.end.toISOString()).toBe(current.start.toISOString());

    for (const q of [
      { from: '2025-02-30', to: '2025-03-01' },
      { from: '2025-03-02', to: '2025-03-01' },
      { from: '2024-01-01', to: '2025-12-31' },
      { from: 'yesterday', to: '2025-01-01' },
    ]) {
      const r = await report(q.from, q.to).expect(400);
      expect(r.body.error.code).toBe('INVALID_PERIOD');
    }
  });

  it('money: completed merchandise GMV from line snapshots; pre-completion cancellations not subtracted twice; later refunds; fee vs merchandise refunds; returns without refunds; multi-branch checkouts; POS apart', async () => {
    // Window: the local day 2024-02-10 (UTC+2): [2024-02-09T22:00Z, 2024-02-10T22:00Z).
    const day = '2024-02-10';
    const s1 = await store(unique('متجر أ'));
    const s2 = await store(unique('متجر ب'));
    const buyer = await account();
    const other = await account();
    const t = (h: string) => at(`2024-02-10T${h}:00.000Z`);

    // One checkout over two stores (two branch orders).
    const co = await checkout(buyer.profileId, t('08:00'));
    const a = await branchOrder(s1, co.id, {
      createdAt: t('08:00'),
      completedAt: t('12:00'),
      deliveryFee: 10,
      lines: [
        { price: 100, qty: 2 },
        { price: 50, qty: 1, cancelledAt: t('09:00') }, // before completion
      ],
    });
    const b = await branchOrder(s2, co.id, {
      createdAt: t('08:00'),
      completedAt: t('13:00'),
      lines: [{ price: 30, qty: 1 }],
    });
    // Another checkout, placed only.
    const co2 = await checkout(other.profileId, t('10:00'));
    await branchOrder(s1, co2.id, {
      createdAt: t('10:00'),
      lines: [{ price: 999, qty: 1 }],
    });

    // Refunds: the pre-completion cancellation (in the window), the fee,
    // and a later return refund (after completion, days later).
    await refund(a.bo.id, 50, 'ITEM_CANCELLED', t('09:00'), a.items[1].id);
    await refund(a.bo.id, 10, 'DELIVERY_FEE', t('09:30'));
    await refund(
      a.bo.id,
      100,
      'ITEM_RETURNED',
      at('2024-02-15T10:00:00.000Z'),
      a.items[0].id,
    );
    // A return case opened in the window, with no refund recorded for it.
    await prisma.return.create({
      data: {
        vendorId: s2.vendor.id,
        branchOrderItemId: b.items[0].id,
        reason: 'DAMAGED',
        desiredOutcome: 'RETURN',
        vendorReviewDueAt: t('20:00'),
        createdAt: t('15:00'),
      },
    });
    // In-store POS: never in marketplace figures.
    await posSale(s1, 999, t('11:00'));
    await posSale(s1, 500, t('11:30'), true);

    const r = (await report(day, day).expect(200)).body;
    expect(r.overview).toEqual({
      branch_orders: 3,
      checkouts: 2,
      completed_orders: 2,
      completed_units: 3,
      gmv: '230.00',
      later_merchandise_refunds: '100.00',
      net_completed: '130.00',
      merchandise_refunds: '50.00',
      delivery_fee_refunds: '10.00',
      refund_rows: 2,
      returns_opened: 1,
      cancelled_lines: 1,
      cancelled_value: '50.00',
      cancelled_orders: 0,
      buyers: 2,
      registrations: 0,
      pos_sales: 1,
      pos_total: '999.00',
    });
    expect(r.meta).toMatchObject({
      from: day,
      to: day,
      time_zone: 'Asia/Hebron',
      currency: 'ILS',
      via_revenue: null,
      interval_utc: {
        start: '2024-02-09T22:00:00.000Z',
        end: '2024-02-10T22:00:00.000Z',
      },
    });
    expect(r.daily).toEqual([
      expect.objectContaining({
        day,
        branch_orders: 3,
        checkouts: 2,
        gmv: '230.00',
        pos_total: '999.00',
      }),
    ]);
    const s1Row = r.stores.find(
      (x: { store_id: string }) => x.store_id === s1.vendor.id,
    );
    expect(s1Row).toMatchObject({
      branch_orders: 2,
      completed_orders: 1,
      gmv: '200.00',
      net_completed: '100.00',
    });
    const s2Row = r.stores.find(
      (x: { store_id: string }) => x.store_id === s2.vendor.id,
    );
    expect(s2Row).toMatchObject({ gmv: '30.00', returns_opened: 1 });
    expect(r.refunds_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'DELIVERY_FEE',
          kind: 'DELIVERY_FEE',
          amount: '10.00',
        }),
        expect.objectContaining({
          reason: 'ITEM_CANCELLED',
          kind: 'MERCHANDISE',
          amount: '50.00',
        }),
      ]),
    );
    expect(r.pos).toEqual([
      expect.objectContaining({
        store_id: s1.vendor.id,
        sales: 1,
        total: '999.00',
        voided: 1,
      }),
    ]);
    expect(
      r.products.offers.find(
        (x: { offer_id: string }) => x.offer_id === s1.offer.id,
      ),
    ).toMatchObject({
      units: 2,
      gmv: '200.00',
    });

    // The later refund falls in its own day's cash view.
    const later = (await report('2024-02-15', '2024-02-15').expect(200)).body;
    expect(later.overview).toMatchObject({
      merchandise_refunds: '100.00',
      gmv: '0.00',
    });

    // Comparison: the previous equal-length period is empty -> no %.
    expect(r.previous_overview.gmv).toBe('0.00');
    expect(r.change_pct.gmv).toBeNull();
    const two = (await report('2024-02-10', '2024-02-11').expect(200)).body;
    expect(two.meta.previous).toMatchObject({
      from: '2024-02-08',
      to: '2024-02-09',
    });
  });

  it('day boundaries: an order completed just after local midnight belongs to the new local day, not the UTC one', async () => {
    const s = await store();
    const buyer = await account();
    const co = await checkout(buyer.profileId, at('2024-03-01T10:00:00.000Z'));
    // 2024-03-12 local starts at 2024-03-11T22:00Z (UTC+2).
    await branchOrder(s, co.id, {
      createdAt: at('2024-03-11T21:30:00.000Z'), // 23:30 local on the 11th
      completedAt: at('2024-03-11T22:30:00.000Z'), // 00:30 local on the 12th
      lines: [{ price: 40, qty: 1 }],
    });
    const d11 = (await report('2024-03-11', '2024-03-11').expect(200)).body;
    const d12 = (await report('2024-03-12', '2024-03-12').expect(200)).body;
    expect(d11.overview).toMatchObject({ branch_orders: 1, gmv: '0.00' });
    expect(d12.overview).toMatchObject({
      branch_orders: 0,
      gmv: '40.00',
      completed_orders: 1,
    });
  });

  it('customers: registrations; new vs returning (previous COMPLETED checkout); repeat = 2+ checkouts, not branches', async () => {
    const day = '2024-04-20';
    const t = (h: string) => at(`2024-04-20T${h}:00.000Z`);
    const s1 = await store();
    const s2 = await store();
    // Returning: a completed checkout before the period.
    const returning = await account(null, t('05:00'));
    const old = await checkout(
      returning.profileId,
      at('2024-04-01T10:00:00.000Z'),
    );
    await branchOrder(s1, old.id, {
      createdAt: at('2024-04-01T10:00:00.000Z'),
      completedAt: at('2024-04-02T10:00:00.000Z'),
      lines: [{ price: 10, qty: 1 }],
    });
    const now1 = await checkout(returning.profileId, t('09:00'));
    await branchOrder(s1, now1.id, {
      createdAt: t('09:00'),
      lines: [{ price: 10, qty: 1 }],
    });
    // Not returning: an earlier checkout that never completed.
    const cancelledBefore = await account();
    const oldC = await checkout(
      cancelledBefore.profileId,
      at('2024-04-02T10:00:00.000Z'),
    );
    await branchOrder(s1, oldC.id, {
      createdAt: at('2024-04-02T10:00:00.000Z'),
      status: 'CANCELLED',
      lines: [{ price: 10, qty: 1 }],
    });
    const nowC = await checkout(cancelledBefore.profileId, t('10:00'));
    await branchOrder(s1, nowC.id, {
      createdAt: t('10:00'),
      lines: [{ price: 10, qty: 1 }],
    });
    // One checkout over two branches: NOT a repeat buyer.
    const multi = await account();
    const m = await checkout(multi.profileId, t('11:00'));
    await branchOrder(s1, m.id, {
      createdAt: t('11:00'),
      lines: [{ price: 10, qty: 1 }],
    });
    await branchOrder(s2, m.id, {
      createdAt: t('11:00'),
      lines: [{ price: 10, qty: 1 }],
    });
    // Two checkouts in the period: a repeat buyer.
    const twice = await account();
    for (const h of ['12:00', '13:00']) {
      const c = await checkout(twice.profileId, t(h));
      await branchOrder(s2, c.id, {
        createdAt: t(h),
        lines: [{ price: 10, qty: 1 }],
      });
    }

    const r = (await report(day, day).expect(200)).body;
    expect(r.customers).toEqual({
      registrations: 1,
      buyers: 4,
      checkouts: 5,
      new_buyers: 3,
      returning_buyers: 1,
      repeat_buyers_in_period: 1,
    });
    expect(r.overview.branch_orders).toBe(6);
    expect(r.overview.checkouts).toBe(5);
  });

  it('exports: CSV and Excel carry the same figures and metadata; text is formula-safe; bad section/format refused', async () => {
    const day = '2024-05-05';
    const t = (h: string) => at(`2024-05-05T${h}:00.000Z`);
    const s = await store('=HYPERLINK("http://x","y")');
    const buyer = await account();
    const co = await checkout(buyer.profileId, t('08:00'));
    await branchOrder(s, co.id, {
      createdAt: t('08:00'),
      completedAt: t('09:00'),
      lines: [{ price: 12.5, qty: 2 }],
    });
    const r = (await report(day, day).expect(200)).body;
    expect(r.overview.gmv).toBe('25.00');

    const csv = await request(http())
      .get('/api/v1/admin/analytics/export')
      .query({ section: 'stores', format: 'csv', from: day, to: day })
      .set(auth(admin.token))
      .expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const text = csv.text;
    expect(text).toContain('"# time_zone","Asia/Hebron"');
    expect(text).toContain('"# currency","ILS"');
    expect(text).toContain('"# channel","MARKETPLACE"');
    expect(text).toContain('2024-05-04T21:00:00.000Z'); // UTC+3 in May
    expect(text).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(text).toContain('"25.00"');

    const overviewCsv = await request(http())
      .get('/api/v1/admin/analytics/export')
      .query({ section: 'overview', format: 'csv', from: day, to: day })
      .set(auth(admin.token))
      .expect(200);
    expect(overviewCsv.text).toContain('"gmv","25.00","0.00",""');

    const xlsx = await request(http())
      .get('/api/v1/admin/analytics/export')
      .query({ section: 'stores', format: 'xlsx', from: day, to: day })
      .set(auth(admin.token))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('stores')!;
    expect(sheet.getRow(1).getCell(2).value).toBe('store_name');
    expect(sheet.getRow(2).getCell(2).value).toBe(
      '\'=HYPERLINK("http://x","y")',
    );
    expect(sheet.getRow(2).getCell(6).value).toBe('25.00');
    const about = wb.getWorksheet('about')!;
    const meta = Object.fromEntries(
      about
        .getSheetValues()
        .slice(1)
        .map((row) => [(row as string[])[1], (row as string[])[2]]),
    );
    expect(meta).toMatchObject({
      from: day,
      to: day,
      time_zone: 'Asia/Hebron',
      currency: 'ILS',
    });

    await request(http())
      .get('/api/v1/admin/analytics/export')
      .query({ section: 'secrets', format: 'csv' })
      .set(auth(admin.token))
      .expect(400);
    await request(http())
      .get('/api/v1/admin/analytics/export')
      .query({ section: 'stores', format: 'pdf' })
      .set(auth(admin.token))
      .expect(400);
  });

  it('dashboard: stores registered/active/published apart; enabled accounts only; public offers follow eligibility incl. platform hold', async () => {
    const read = async () =>
      (
        await request(http())
          .get('/api/v1/admin/analytics/dashboard')
          .set(auth(admin.token))
          .expect(200)
      ).body;
    const before = await read();

    // A live store with one public, one held and one inactive offer.
    const s = await store();
    const held = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendor.id,
        titleAr: 'محجوب',
        titleEn: 'Held',
        status: 'ACTIVE',
      },
    });
    await prisma.offerPlatformHold.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: held.id,
        action: 'HIDE',
        reason: 'مراجعة',
        placedById: admin.id,
      },
    });
    await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendor.id,
        titleAr: 'متوقف',
        titleEn: 'Off',
        status: 'INACTIVE',
      },
    });
    // A registered store that is not active (and not published).
    await prisma.vendor.create({
      data: {
        slug: unique('ap').toLowerCase(),
        legalName: unique('l'),
        displayName: 'قيد المراجعة',
        status: 'UNDER_REVIEW',
      },
    });
    // Accounts: one enabled customer; a suspended one and a deactivated
    // one; a platform admin - none of the last three count.
    await account();
    const suspended = await account();
    await prisma.user.update({
      where: { id: suspended.id },
      data: {
        suspendedAt: new Date(),
        suspensionReason: 'مخالفة',
        suspendedById: admin.id,
      },
    });
    const gone = await account();
    await prisma.user.update({
      where: { id: gone.id },
      data: { deactivatedAt: new Date() },
    });
    await account('PLATFORM_ADMIN');

    const after = await read();
    expect(after.stores.registered - before.stores.registered).toBe(2);
    expect(after.stores.active - before.stores.active).toBe(1);
    expect(after.stores.published - before.stores.published).toBe(1);
    expect(after.catalog.public_offers - before.catalog.public_offers).toBe(1);
    // store() made one enabled owner-account (with a customer profile) +
    // the one enabled customer above.
    expect(
      after.accounts.enabled_customers - before.accounts.enabled_customers,
    ).toBe(2);
    expect(
      after.accounts.enabled_distinct - before.accounts.enabled_distinct,
    ).toBe(2);
    expect(after.meta.via_revenue).toBeNull();
    expect(after.daily).toHaveLength(30);
    expect(Array.isArray(after.recent_admin_activity)).toBe(true);
  });
});
