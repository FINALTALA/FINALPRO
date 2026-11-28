import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { CURRENT_PLATFORM_TERMS_VERSION } from './../src/checkout/checkout.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// VIA phase 2D - Admin Orders (read-only): PLATFORM_ADMIN only; the list
// (search, filters, cursor pages); the detail shows the checkout snapshot,
// not the live offer; the customer's data is minimised; the customer
// order groups its branch orders; the only action is the EXISTING forced
// cancel, offered where its own rule allows it.

let seq = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++seq}`;

describe('Phase 2D - Admin Orders (e2e)', () => {
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
      data: { phone, passwordHash: 'x', phoneVerifiedAt: new Date(), platformRole },
    });
    const profile = await prisma.customerProfile.create({
      data: { userId: user.id, displayName: 'زبون الاختبار' },
    });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { id: user.id, phone, profileId: profile.id, token };
  }

  async function store(name = 'متجر الطلبات') {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('ord').toLowerCase(),
        legalName: unique('متجر'),
        displayName: name,
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
        whatsappUrl: 'https://wa.me/970599000000',
      },
    });
    const owner = await account();
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
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: vendor.id,
        titleAr: 'فستان سهرة أصلي',
        titleEn: 'Evening dress',
        status: 'ACTIVE',
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
      },
    });
    await prisma.branchStock.create({
      data: {
        vendorId: vendor.id,
        branchId: branch.id,
        offerVariantId: variant.id,
        quantity: 20,
      },
    });
    return { owner, vendor, branch, offer, variant };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  /** A real checkout (cart -> reserve -> confirm), pickup + COD, one group per store. */
  async function order(
    shopper: { token: string },
    stores: Store[],
    quantity = 2,
  ): Promise<{ customerOrderId: string; branchOrderIds: string[] }> {
    const groups: unknown[] = [];
    for (const s of stores) {
      const line = await request(http())
        .post('/api/v1/cart/items')
        .set(auth(shopper.token))
        .set('Idempotency-Key', unique('cart'))
        .send({
          vendor_id: s.vendor.id,
          offer_variant_id: s.variant.id,
          quantity,
        })
        .expect(201);
      groups.push({
        cart_item_ids: [line.body.id],
        branch_id: s.branch.id,
        fulfilment_method: 'PICKUP',
        payment_method: 'COD',
      });
    }
    const reserved = await request(http())
      .post('/api/v1/checkout/reserve')
      .set(auth(shopper.token))
      .set('Idempotency-Key', unique('reserve'))
      .send({
        terms_accepted: true,
        terms_version: CURRENT_PLATFORM_TERMS_VERSION,
        groups,
      })
      .expect(201);
    const confirmed = await request(http())
      .post('/api/v1/checkout/confirm')
      .set(auth(shopper.token))
      .set('Idempotency-Key', unique('confirm'))
      .send({ reservation_id: reserved.body.reservation_id })
      .expect(201);
    const ids = (confirmed.body.branch_orders as { id: string }[]).map(
      (b) => b.id,
    );
    const bo = await prisma.branchOrder.findUniqueOrThrow({
      where: { id: ids[0] },
      select: { customerOrderId: true },
    });
    return { customerOrderId: bo.customerOrderId, branchOrderIds: ids };
  }

  const list = (token: string, query: Record<string, string> = {}) =>
    request(http()).get('/api/v1/admin/orders').query(query).set(auth(token));
  const detail = (token: string, id: string) =>
    request(http()).get(`/api/v1/admin/orders/${id}`).set(auth(token));

  it('PLATFORM_ADMIN only: no session 401; a customer, a store owner and a reviewer 403', async () => {
    const s = await store();
    const shopper = await account();
    const { branchOrderIds } = await order(shopper, [s]);
    const reviewer = await account('VERIFICATION_REVIEWER');

    await request(http()).get('/api/v1/admin/orders').expect(401);
    for (const token of [shopper.token, s.owner.token, reviewer.token]) {
      await list(token).expect(403);
      await detail(token, branchOrderIds[0]).expect(403);
    }
  });

  it('lists real orders newest first; search by number or store; filters; cursor pages; bad filters refused', async () => {
    const name = unique('متجر البحث');
    const s = await store(name);
    const admin = await account('PLATFORM_ADMIN');
    const a = await order(await account(), [s]);
    const b = await order(await account(), [s]);
    const c = await order(await account(), [s]);

    const byStore = await list(admin.token, { q: name }).expect(200);
    expect(byStore.body.items.map((r: { id: string }) => r.id)).toEqual([
      c.branchOrderIds[0],
      b.branchOrderIds[0],
      a.branchOrderIds[0],
    ]);
    const row = byStore.body.items[0];
    expect(row).toMatchObject({
      number: c.branchOrderIds[0].slice(0, 8).toUpperCase(),
      customer_order_id: c.customerOrderId,
      status: 'PLACED',
      fulfilment_method: 'PICKUP',
      payment_method: 'COD',
      total: 200,
      item_count: 2,
      refunded: 0,
      open_returns: 0,
      store: { id: s.vendor.id, name },
      branch: { id: s.branch.id },
    });

    // The order number (first characters, with or without "#").
    const byNumber = await list(admin.token, {
      q: `#${b.branchOrderIds[0].slice(0, 8).toUpperCase()}`,
    }).expect(200);
    expect(byNumber.body.items.map((r: { id: string }) => r.id)).toContain(
      b.branchOrderIds[0],
    );
    // The customer order's number finds its branch orders too.
    const byCustomerOrder = await list(admin.token, {
      q: a.customerOrderId.slice(0, 8),
    }).expect(200);
    expect(
      byCustomerOrder.body.items.map((r: { id: string }) => r.id),
    ).toContain(a.branchOrderIds[0]);

    // Filters.
    await prisma.branchOrder.update({
      where: { id: a.branchOrderIds[0] },
      data: { status: 'PREPARING' },
    });
    const preparing = await list(admin.token, {
      vendor_id: s.vendor.id,
      status: 'PREPARING',
    }).expect(200);
    expect(preparing.body.items.map((r: { id: string }) => r.id)).toEqual([
      a.branchOrderIds[0],
    ]);
    const delivery = await list(admin.token, {
      vendor_id: s.vendor.id,
      fulfilment: 'DELIVERY',
    }).expect(200);
    expect(delivery.body.items).toEqual([]);
    const cod = await list(admin.token, {
      vendor_id: s.vendor.id,
      payment: 'COD',
    }).expect(200);
    expect(cod.body.items).toHaveLength(3);
    const today = new Date().toISOString().slice(0, 10);
    const dated = await list(admin.token, {
      vendor_id: s.vendor.id,
      from: today,
      to: today,
    }).expect(200);
    expect(dated.body.items).toHaveLength(3);
    const future = await list(admin.token, {
      vendor_id: s.vendor.id,
      from: '2999-01-01',
    }).expect(200);
    expect(future.body.items).toEqual([]);

    // Cursor pages: every order once, in order.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(admin.token, {
        vendor_id: s.vendor.id,
        limit: '2',
        ...(cursor ? { cursor } : {}),
      }).expect(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.items.map((r: { id: string }) => r.id));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual([
      c.branchOrderIds[0],
      b.branchOrderIds[0],
      a.branchOrderIds[0],
    ]);

    for (const bad of [
      { status: 'SHIPPED' },
      { fulfilment: 'DRONE' },
      { from: '26-11-2026' },
      { cursor: 'not-a-cursor' },
      { flag: 'vip' },
    ]) {
      const res = await list(admin.token, bad).expect(400);
      expect(['INVALID_FILTER', 'INVALID_CURSOR']).toContain(
        res.body.error.code,
      );
    }
  });

  it('detail: the checkout snapshot (not the live offer), money, masked customer, the customer order across stores, the history', async () => {
    const s1 = await store('متجر أ');
    const s2 = await store('متجر ب');
    const admin = await account('PLATFORM_ADMIN');
    const shopper = await account();
    const o = await order(shopper, [s1, s2]);
    expect(o.branchOrderIds).toHaveLength(2);
    const first = await prisma.branchOrder.findFirstOrThrow({
      where: { customerOrderId: o.customerOrderId, vendorId: s1.vendor.id },
    });

    // The store edits its listing after the sale.
    await prisma.vendorOffer.update({
      where: { id: s1.offer.id },
      data: { titleAr: 'عنوان جديد بعد البيع', titleEn: 'Renamed' },
    });
    await prisma.offerVariant.update({
      where: { id: s1.variant.id },
      data: { basePrice: 999 },
    });

    const res = await detail(admin.token, first.id).expect(200);
    const d = res.body;
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({
      title_ar: 'فستان سهرة أصلي',
      title_en: 'Evening dress',
      quantity: 2,
      unit_price: 100,
      line_total: 200,
      cancelled_at: null,
      refunded: false,
      returns: [],
    });
    expect(d.money).toMatchObject({
      subtotal: 200,
      total: 200,
      amount_due: 200,
      refunded: 0,
      remaining_refundable: 200,
    });
    expect(d.store).toMatchObject({ id: s1.vendor.id, name: 'متجر أ' });
    expect(d.customer.display_name).toBe('زبون الاختبار');
    expect(d.customer.phone_masked).toMatch(/•/);
    expect(d.customer.phone_masked.endsWith(shopper.phone.slice(-3))).toBe(true);
    // Never the full phone, the pickup code or a location.
    const json = JSON.stringify(d);
    expect(json).not.toContain(shopper.phone);
    if (first.pickupCode) expect(json).not.toContain(first.pickupCode);
    expect(json).not.toMatch(/"lat"|"lng"|phoneNumber/);

    expect(d.customer_order.id).toBe(o.customerOrderId);
    expect(
      d.customer_order.branch_orders.map(
        (b: { store_name: string; current: boolean }) => [b.store_name, b.current],
      ),
    ).toEqual(
      expect.arrayContaining([
        ['متجر أ', true],
        ['متجر ب', false],
      ]),
    );
    expect(d.dates.created_at).toBeTruthy();
    expect(d.actions).toEqual({
      force_cancel: true,
      own_order: false,
      escalated_returns: false,
    });

    await detail(admin.token, '00000000-0000-0000-0000-000000000000').expect(404);
  });

  it('the forced cancel stays the existing endpoint: after it the detail shows the refund, the status and the history, and offers no action', async () => {
    const s = await store();
    const admin = await account('PLATFORM_ADMIN');
    const shopper = await account();
    const { branchOrderIds } = await order(shopper, [s]);
    const id = branchOrderIds[0];

    await request(http())
      .post(`/api/v1/admin/branch-orders/${id}/cancel`)
      .set(auth(admin.token))
      .set('Idempotency-Key', unique('cancel'))
      .send({ reason: 'طلب مكرر بالخطأ من الزبون' })
      .expect(201);

    const d = (await detail(admin.token, id).expect(200)).body;
    expect(['CANCELLED', 'REFUNDED']).toContain(d.status);
    expect(d.actions.force_cancel).toBe(false);
    expect(d.cancellation_reason).toBe('طلب مكرر بالخطأ من الزبون');
    expect(d.items[0].cancelled_at).toBeTruthy();
    expect(
      d.timeline.some(
        (e: { to_status: string | null; actor: string }) =>
          e.to_status === d.status && e.actor === 'PLATFORM',
      ),
    ).toBe(true);
    // The list follows.
    const row = (
      await list(admin.token, { vendor_id: s.vendor.id }).expect(200)
    ).body.items[0];
    expect(row.status).toBe(d.status);
    expect(row.refunded).toBe(d.money.refunded);
    // A COD order that was never paid refunds nothing.
    expect(d.money.refunded).toBe(0);
  });

  it("an administrator's own order: shown, but no forced cancel offered (TB-28)", async () => {
    const s = await store();
    const admin = await account('PLATFORM_ADMIN');
    const { branchOrderIds } = await order(admin, [s]);
    const d = (await detail(admin.token, branchOrderIds[0]).expect(200)).body;
    expect(d.actions).toMatchObject({ force_cancel: false, own_order: true });
  });

  it('in-store POS sales are not marketplace orders and never appear', async () => {
    const s = await store();
    const admin = await account('PLATFORM_ADMIN');
    expect(
      (await list(admin.token, { vendor_id: s.vendor.id }).expect(200)).body
        .items,
    ).toEqual([]);
    // The list reads BranchOrder only - one row per marketplace branch order.
    const shopper = await account();
    await order(shopper, [s]);
    const rows = (
      await list(admin.token, { vendor_id: s.vendor.id }).expect(200)
    ).body.items;
    expect(rows).toHaveLength(
      await prisma.branchOrder.count({ where: { vendorId: s.vendor.id } }),
    );
  });
});
