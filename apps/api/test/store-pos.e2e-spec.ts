import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { tb26Fixtures } from './helpers/tb26-fixtures';

// Barcodes and in-store sales (2026-11-20): product-level barcodes (external
// EAN-13 / UPC-A / EAN-8 / Code 128 or generated "29..." EAN-13), unique per
// store, up to 10 with one primary; the cashier's card (a product barcode,
// or a legacy SIB- label with its colour x size chosen); a real in-store
// sale - the right colour x size x branch, price snapshot, SALE movements,
// audit, low-stock alert, all-or-none, idempotent; the owner's same-day
// whole-sale void; everything behind store_cashier_enabled; nothing of it
// in a shopper response.
describe('Barcodes and in-store sales (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const f = tb26Fixtures(() => app);

  async function setFlag(enabled: boolean) {
    await prisma.featureFlag.upsert({
      where: { key: 'store_cashier_enabled' },
      create: { key: 'store_cashier_enabled', enabled, description: 'test' },
      update: { enabled },
    });
  }

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
    // one real listener for the whole file: supertest otherwise opens and closes a temporary
    // one per request, and requests sent in parallel then race on it (ECONNRESET)
    await app.listen(0);
    prisma = app.get(PrismaService);
    app.get(OutboxRelayService).onModuleDestroy();
    await setFlag(true);
  });
  afterAll(async () => {
    await setFlag(false);
    await app.close();
  });

  type Store = Awaited<ReturnType<typeof f.store>>;
  type Who = { token: string };

  /** Headers of a store-staff call (session + this store's workspace token + a fresh idempotency key). */
  async function h(who: Who, s: Store, key?: string) {
    const ws = await f.enter(who, { type: 'vendor', vendor_id: s.vendorId });
    return {
      ...f.bearer(who.token),
      'X-Workspace-Token': ws,
      'Idempotency-Key': key ?? f.unique('k'),
    };
  }

  /**
   * A classified product (status `status`) with a named colour «أسود» and the
   * sizes given, each with its quantity in branch A (and B when given).
   */
  async function product(
    s: Store,
    sizes: Record<string, { a: number; b?: number }>,
    status: 'ACTIVE' | 'INACTIVE' | 'DRAFT' = 'ACTIVE',
    price = 100,
    /** a store barcode of its own (a product without one is not sold at the cashier) */
    withCode = true,
  ) {
    const o = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendorId,
        titleAr: `فستان ${f.unique('p').slice(-5)}`,
        titleEn: 'Dress',
        status: 'DRAFT',
        taxonomyVersion: 1,
        requiresTaxonomy: true,
      },
    });
    await prisma.vendorOfferAudience.create({
      data: { vendorId: s.vendorId, vendorOfferId: o.id, audience: 'WOMEN' },
    });
    await prisma.vendorOfferCategory.create({
      data: {
        vendorId: s.vendorId,
        vendorOfferId: o.id,
        categoryCode: 'DRESSES_WOMEN',
      },
    });
    const color = await prisma.offerColor.create({
      data: {
        vendorId: s.vendorId,
        vendorOfferId: o.id,
        familyCode: 'BLACK',
        nameAr: 'أسود',
        nameEn: 'Black',
        sortOrder: 0,
      },
    });
    const variants: Record<string, string> = {};
    for (const [size, qty] of Object.entries(sizes)) {
      const v = await prisma.offerVariant.create({
        data: {
          vendorId: s.vendorId,
          vendorOfferId: o.id,
          sellerSku: f.unique('sku'),
          storeInventoryBarcode: `SIB-${f
            .unique('x')
            .replace(/[^0-9]/g, '')
            .padEnd(32, '0')
            .slice(0, 32)}`,
          basePrice: price,
          isCombination: true,
          colorCode: 'BLACK',
          sizeCode: size,
          offerColorId: color.id,
        },
      });
      variants[size] = v.id;
      await prisma.branchStock.create({
        data: {
          vendorId: s.vendorId,
          branchId: s.branchA,
          offerVariantId: v.id,
          quantity: qty.a,
        },
      });
      if (qty.b !== undefined) {
        await prisma.branchStock.create({
          data: {
            vendorId: s.vendorId,
            branchId: s.branchB,
            offerVariantId: v.id,
            quantity: qty.b,
          },
        });
      }
    }
    if (status !== 'DRAFT') {
      await prisma.vendorOffer.update({
        where: { id: o.id },
        data: { status: 'ACTIVE' },
      });
      if (status === 'INACTIVE') {
        await prisma.vendorOffer.update({
          where: { id: o.id },
          data: { status: 'INACTIVE' },
        });
      }
    }
    if (withCode) {
      await prisma.offerBarcode.create({
        data: {
          vendorId: s.vendorId,
          vendorOfferId: o.id,
          code: `AUTO${f
            .unique('c')
            .replace(/[^0-9]/g, '')
            .slice(-12)}`,
          format: 'CODE128',
          source: 'EXTERNAL',
          isPrimary: true,
          createdById: s.owner.userId,
        },
      });
    }
    return { offerId: o.id, variants };
  }

  const qty = async (branchId: string, variantId: string) =>
    (
      await prisma.branchStock.findUnique({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variantId },
        },
      })
    )?.quantity ?? 0;

  async function addCode(
    s: Store,
    offerId: string,
    code: string,
    status = 201,
  ) {
    return f
      .http()
      .post(`/api/v1/vendors/${s.vendorId}/offers/${offerId}/barcodes`)
      .set(await h(s.owner, s))
      .send({ code })
      .expect(status);
  }

  async function sell(
    s: Store,
    who: Who,
    branchId: string,
    lines: {
      offer_variant_id: string;
      quantity: number;
      expected_unit_price: number;
      scanned_code?: string;
    }[],
    status: number,
    key?: string,
  ) {
    return f
      .http()
      .post(`/api/v1/vendors/${s.vendorId}/branches/${branchId}/store-sales`)
      .set(await h(who, s, key))
      .send({ payment_method: 'CASH', lines })
      .expect(status);
  }

  it('is invisible while store_cashier_enabled is off', async () => {
    const s = await f.store();
    const p = await product(s, { M: { a: 3 } });
    await setFlag(false);
    try {
      const r1 = await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/offers/${p.offerId}/barcodes`)
        .set(await h(s.owner, s))
        .expect(404);
      expect(r1.body.error.code).toBe('FEATURE_DISABLED');
      const r2 = await f
        .http()
        .get(
          `/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/cashier/lookup?code=4006381333931`,
        )
        .set(await h(s.owner, s))
        .expect(404);
      expect(r2.body.error.code).toBe('FEATURE_DISABLED');
    } finally {
      await setFlag(true);
    }
  });

  it('attaches, generates, makes primary, removes and limits product barcodes (owner only, audited)', async () => {
    const s = await f.store();
    const p1 = await product(s, { M: { a: 3 } }, 'ACTIVE', 100, false);
    const p2 = await product(s, { M: { a: 3 } }, 'ACTIVE', 100, false);
    const base = `/api/v1/vendors/${s.vendorId}/offers/${p1.offerId}/barcodes`;

    const first = await addCode(s, p1.offerId, '4006381333931');
    expect(first.body.items).toEqual([
      expect.objectContaining({
        code: '4006381333931',
        format: 'EAN13',
        source: 'EXTERNAL',
        is_primary: true,
      }),
    ]);
    // a UPC-A is one code in both of its scanner forms
    const upc = await addCode(s, p1.offerId, '036000291452');
    expect(upc.body.items[1]).toEqual(
      expect.objectContaining({
        code: '0036000291452',
        display_code: '036000291452',
        format: 'UPCA',
        is_primary: false,
      }),
    );
    expect(
      (await addCode(s, p1.offerId, '0036000291452', 409)).body.error.code,
    ).toBe('BARCODE_ALREADY_ON_PRODUCT');
    // the same code on ANOTHER product of the same store: refused, naming the product
    const other = await addCode(s, p2.offerId, '4006381333931', 409);
    expect(other.body.error.code).toBe('BARCODE_ALREADY_USED');
    expect(other.body.error.details[0].offer_id).toBe(p1.offerId);
    // a misread and an internal code
    expect(
      (await addCode(s, p1.offerId, '4006381333932', 400)).body.error.code,
    ).toBe('BARCODE_CHECK_DIGIT');
    expect(
      (await addCode(s, p1.offerId, 'SIB-ABCD', 400)).body.error.code,
    ).toBe('BARCODE_RESERVED');
    // ANOTHER store may use the same manufacturer code
    const s2 = await f.store();
    const q = await product(s2, { M: { a: 1 } });
    await addCode(s2, q.offerId, '4006381333931');

    const gen = await f
      .http()
      .post(`${base}/generate`)
      .set(await h(s.owner, s))
      .expect(201);
    const generated = gen.body.items.find(
      (b: { source: string }) => b.source === 'GENERATED',
    );
    expect(generated.code).toMatch(/^29\d{11}$/);
    expect(generated.format).toBe('EAN13');

    const made = await f
      .http()
      .patch(`${base}/${generated.id}/primary`)
      .set(await h(s.owner, s))
      .expect(200);
    expect(
      made.body.items
        .filter((b: { is_primary: boolean }) => b.is_primary)
        .map((b: { id: string }) => b.id),
    ).toEqual([generated.id]);
    const removed = await f
      .http()
      .delete(`${base}/${generated.id}`)
      .set(await h(s.owner, s))
      .expect(200);
    // removing the primary promotes the oldest remaining code
    expect(
      removed.body.items.find((b: { is_primary: boolean }) => b.is_primary)
        .code,
    ).toBe('4006381333931');

    // up to 10 per product
    for (let i = 0; i < 8; i++)
      await addCode(
        s,
        p1.offerId,
        `ITEM-${f
          .unique('c')
          .replace(/[^0-9]/g, '')
          .slice(-10)}${i}`,
      );
    expect(
      (await addCode(s, p1.offerId, 'ONE-TOO-MANY', 409)).body.error.code,
    ).toBe('BARCODE_LIMIT');

    // an employee does not manage barcodes
    const employee = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      s.branchA,
    );
    const denied = await f
      .http()
      .get(base)
      .set(await h(employee, s))
      .expect(403);
    expect(denied.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');

    const actions = (
      await prisma.auditLog.findMany({
        where: { entityType: 'OfferBarcode', actorId: s.owner.userId },
      })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'offer_barcode.added',
        'offer_barcode.primary_set',
        'offer_barcode.removed',
      ]),
    );

    // an archived product takes no new code
    await prisma.vendorOffer.update({
      where: { id: p2.offerId },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    expect(
      (await addCode(s, p2.offerId, '96385074', 409)).body.error.code,
    ).toBe('PRODUCT_ARCHIVED');
  });

  it('keeps a code unique per store under concurrency, and generated codes distinct', async () => {
    const s = await f.store();
    const p1 = await product(s, { M: { a: 1 } });
    const p2 = await product(s, { M: { a: 1 } });
    const headers = await h(s.owner, s);
    const [a, b] = await Promise.all(
      [p1, p2].map((p) =>
        f
          .http()
          .post(`/api/v1/vendors/${s.vendorId}/offers/${p.offerId}/barcodes`)
          .set(headers)
          .send({ code: '96385074' }),
      ),
    );
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const gens = await Promise.all(
      [0, 1, 2, 3].map(async (i) =>
        f
          .http()
          .post(
            `/api/v1/vendors/${s.vendorId}/offers/${i % 2 ? p1.offerId : p2.offerId}/barcodes/generate`,
          )
          .set(await h(s.owner, s)),
      ),
    );
    expect(gens.map((g) => g.status)).toEqual([201, 201, 201, 201]);
    const codes = await prisma.offerBarcode.findMany({
      where: { vendorId: s.vendorId, source: 'GENERATED' },
    });
    expect(new Set(codes.map((c) => c.code)).size).toBe(4);
  });

  it('gives the label page the store name, product name, primary code and price', async () => {
    const s = await f.store();
    const p = await product(s, { M: { a: 1 } }, 'ACTIVE', 149.5, false);
    const none = await product(s, { M: { a: 1 } }, 'ACTIVE', 100, false);
    await addCode(s, p.offerId, '4006381333931');
    const res = await f
      .http()
      .get(
        `/api/v1/vendors/${s.vendorId}/barcode-labels?offer_ids=${p.offerId},${none.offerId}`,
      )
      .set(await h(s.owner, s))
      .expect(200);
    expect(res.body.store_name).toBe('متجر');
    expect(res.body.items[0]).toEqual(
      expect.objectContaining({
        offer_id: p.offerId,
        price: 149.5,
        barcode: expect.objectContaining({ code: '4006381333931' }),
      }),
    );
    expect(res.body.items[1]).toEqual(
      expect.objectContaining({ offer_id: none.offerId, barcode: null }),
    );
  });

  it('opens the product card by product barcode or a legacy SIB label, and explains what it cannot open', async () => {
    const s = await f.store();
    const p = await product(s, { S: { a: 5 }, M: { a: 0, b: 7 }, L: { a: 2 } });
    await addCode(s, p.offerId, '4006381333931');
    const lookup = async (who: Who, code: string, branchId = s.branchA) =>
      f
        .http()
        .get(
          `/api/v1/vendors/${s.vendorId}/branches/${branchId}/cashier/lookup?code=${encodeURIComponent(code)}`,
        )
        .set(await h(who, s));

    const card = (await lookup(s.owner, ' 4006381333931 ')).body;
    expect(card.matched_by).toBe('PRODUCT_BARCODE');
    expect(card.offer.id).toBe(p.offerId);
    expect(card.preselect_variant_id).toBeNull();
    const bySize = Object.fromEntries(
      card.options.map((o: { size_code: string; available: number }) => [
        o.size_code,
        o.available,
      ]),
    );
    // THIS branch's stock (M has 7 in branch B, none here)
    expect(bySize).toEqual({ S: 5, M: 0, L: 2 });
    expect(card.options[0]).toEqual(
      expect.objectContaining({ color_name_ar: 'أسود', unit_price: '100.00' }),
    );

    const sib = (
      await prisma.offerVariant.findUniqueOrThrow({
        where: { id: p.variants.L },
      })
    ).storeInventoryBarcode;
    const legacy = (await lookup(s.owner, sib.toLowerCase())).body;
    expect(legacy.matched_by).toBe('LEGACY_VARIANT_CODE');
    expect(legacy.preselect_variant_id).toBe(p.variants.L);

    const unknown = await lookup(s.owner, '96385074');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('BARCODE_UNKNOWN');
    expect((await lookup(s.owner, '4006381333932')).body.error.code).toBe(
      'BARCODE_CHECK_DIGIT',
    );

    // another store's code is simply unknown here
    const s2 = await f.store();
    const q = await product(s2, { M: { a: 1 } });
    await addCode(s2, q.offerId, '96385074');
    expect((await lookup(s.owner, '96385074')).status).toBe(404);

    // a draft cannot be sold
    const draft = await product(s, { M: { a: 3 } }, 'DRAFT');
    await addCode(s, draft.offerId, 'DRAFT-0001');
    const d = await lookup(s.owner, 'DRAFT-0001');
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe('PRODUCT_NOT_SELLABLE');
    expect(d.body.error.details[0].status).toBe('DRAFT');

    // an employee works at their own branch only
    const employee = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      s.branchB,
    );
    expect((await lookup(employee, '4006381333931', s.branchB)).status).toBe(
      200,
    );
    expect(
      (await lookup(employee, '4006381333931', s.branchA)).body.error.code,
    ).toBe('BRANCH_ACCESS_DENIED');
  });

  it('records a real multi-line sale on the exact colour x size x branch, atomically, with audit and the low-stock alert', async () => {
    const s = await f.store();
    const p = await product(s, { S: { a: 5, b: 9 }, M: { a: 6 }, L: { a: 4 } });
    const res = await sell(
      s,
      s.owner,
      s.branchA,
      [
        {
          offer_variant_id: p.variants.S,
          quantity: 2,
          expected_unit_price: 100,
          scanned_code: '4006381333931',
        },
        {
          offer_variant_id: p.variants.M,
          quantity: 3,
          expected_unit_price: 100,
        },
        {
          offer_variant_id: p.variants.S,
          quantity: 1,
          expected_unit_price: 100,
        },
      ],
      201,
    );
    const sale = res.body;
    expect(sale).toEqual(
      expect.objectContaining({
        status: 'COMPLETED',
        payment_method: 'CASH',
        total: '600.00',
        units: 6,
        voidable: true,
      }),
    );
    expect(sale.sale_label).toMatch(/^S-\d{6}$/);
    // repeated colour x size lines are one line
    expect(sale.lines).toHaveLength(2);
    expect(sale.lines[0]).toEqual(
      expect.objectContaining({
        offer_variant_id: p.variants.S,
        quantity: 3,
        unit_price: '100.00',
        line_total: '300.00',
        color_name_ar: 'أسود',
        size_code: 'S',
        scanned_code: '4006381333931',
      }),
    );
    // only branch A's S and M changed
    expect(await qty(s.branchA, p.variants.S)).toBe(2);
    expect(await qty(s.branchA, p.variants.M)).toBe(3);
    expect(await qty(s.branchA, p.variants.L)).toBe(4);
    expect(await qty(s.branchB, p.variants.S)).toBe(9);

    const movements = await prisma.stockMovement.findMany({
      where: { vendorId: s.vendorId, reason: 'SALE' },
    });
    expect(movements.map((m) => m.quantityDelta).sort()).toEqual([-3, -3]);
    expect(movements[0].reasonNote).toBe(`بيع من المحل ${sale.sale_label}`);
    const items = await prisma.storeSaleItem.findMany({
      where: { storeSaleId: sale.id },
    });
    expect(new Set(items.map((i) => i.saleMovementId))).toEqual(
      new Set(movements.map((m) => m.id)),
    );
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: sale.id, action: 'store_sale.recorded' },
    });
    expect(audit.actorId).toBe(s.owner.userId);

    // S went 5 -> 2 and M 6 -> 3: both crossed into the 1-3 band -> the existing alert, owner + branch staff
    const alerts = await prisma.outboxEvent.findMany({
      where: {
        eventType: 'checkout.low_stock_after_reserve',
        payload: { path: ['vendor_id'], equals: s.vendorId },
      },
    });
    expect(
      alerts
        .map(
          (a) => (a.payload as { offer_variant_id: string }).offer_variant_id,
        )
        .sort(),
    ).toEqual([p.variants.S, p.variants.M].sort());

    // a second sale gets the next number
    const next = await sell(
      s,
      s.owner,
      s.branchA,
      [
        {
          offer_variant_id: p.variants.L,
          quantity: 1,
          expected_unit_price: 100,
        },
      ],
      201,
    );
    expect(next.body.sale_number).toBe(sale.sale_number + 1);
  });

  it('sells a hidden (INACTIVE) product, never a draft or an archived one', async () => {
    const s = await f.store();
    const hidden = await product(s, { M: { a: 2 } }, 'INACTIVE');
    await sell(
      s,
      s.owner,
      s.branchA,
      [
        {
          offer_variant_id: hidden.variants.M,
          quantity: 1,
          expected_unit_price: 100,
        },
      ],
      201,
    );
    expect(await qty(s.branchA, hidden.variants.M)).toBe(1);

    const draft = await product(s, { M: { a: 2 } }, 'DRAFT');
    const d = await sell(
      s,
      s.owner,
      s.branchA,
      [
        {
          offer_variant_id: draft.variants.M,
          quantity: 1,
          expected_unit_price: 100,
        },
      ],
      409,
    );
    expect(d.body.error.code).toBe('PRODUCT_NOT_SELLABLE');

    const archived = await product(s, { M: { a: 2 } });
    await prisma.vendorOffer.update({
      where: { id: archived.offerId },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    await sell(
      s,
      s.owner,
      s.branchA,
      [
        {
          offer_variant_id: archived.variants.M,
          quantity: 1,
          expected_unit_price: 100,
        },
      ],
      409,
    );
    expect(await qty(s.branchA, archived.variants.M)).toBe(2);
  });

  it('refuses the whole sale when one line is short, respects online holds, and never charges a changed price', async () => {
    const s = await f.store();
    const p = await product(s, { S: { a: 5 }, M: { a: 1 } });
    const short = await sell(
      s,
      s.owner,
      s.branchA,
      [
        {
          offer_variant_id: p.variants.S,
          quantity: 1,
          expected_unit_price: 100,
        },
        {
          offer_variant_id: p.variants.M,
          quantity: 2,
          expected_unit_price: 100,
        },
      ],
      409,
    );
    expect(short.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(short.body.error.details).toEqual([
      { offer_variant_id: p.variants.M, available: 1, requested: 2 },
    ]);
    expect(await qty(s.branchA, p.variants.S)).toBe(5);
    expect(
      await prisma.storeSale.count({ where: { vendorId: s.vendorId } }),
    ).toBe(0);

    // 4 of S's 5 held by a live online checkout: only 1 can be sold here
    const shopper = await f.account();
    const reservation = await prisma.checkoutReservation.create({
      data: {
        customerId: shopper.customerId,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    await prisma.checkoutReservationItem.create({
      data: {
        reservationId: reservation.id,
        vendorId: s.vendorId,
        branchId: s.branchA,
        offerVariantId: p.variants.S,
        quantity: 4,
        unitPriceAtReserve: 100,
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'COD',
      },
    });
    await prisma.branchStock.update({
      where: {
        branchId_offerVariantId: {
          branchId: s.branchA,
          offerVariantId: p.variants.S,
        },
      },
      data: { reservedQuantity: 4 },
    });
    expect(
      (
        await sell(
          s,
          s.owner,
          s.branchA,
          [
            {
              offer_variant_id: p.variants.S,
              quantity: 2,
              expected_unit_price: 100,
            },
          ],
          409,
        )
      ).body.error.details[0].available,
    ).toBe(1);

    const changed = await sell(
      s,
      s.owner,
      s.branchA,
      [
        {
          offer_variant_id: p.variants.S,
          quantity: 1,
          expected_unit_price: 90,
        },
      ],
      409,
    );
    expect(changed.body.error.code).toBe('PRICE_CHANGED');
    expect(changed.body.error.details[0].unit_price).toBe('100.00');
    expect(await qty(s.branchA, p.variants.S)).toBe(5);
  });

  it('is idempotent on retry and sells the last unit only once under concurrency', async () => {
    const s = await f.store();
    const p = await product(s, { M: { a: 3 }, L: { a: 1 } });
    const key = f.unique('retry');
    const line = [
      { offer_variant_id: p.variants.M, quantity: 2, expected_unit_price: 100 },
    ];
    const one = await sell(s, s.owner, s.branchA, line, 201, key);
    const again = await sell(s, s.owner, s.branchA, line, 201, key);
    expect(again.body.id).toBe(one.body.id);
    expect(await qty(s.branchA, p.variants.M)).toBe(1);

    const last = [
      { offer_variant_id: p.variants.L, quantity: 1, expected_unit_price: 100 },
    ];
    const [a, b] = await Promise.all([
      f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/store-sales`)
        .set(await h(s.owner, s))
        .send({ payment_method: 'CARD', lines: last }),
      f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/store-sales`)
        .set(await h(s.owner, s))
        .send({ payment_method: 'CASH', lines: last }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await qty(s.branchA, p.variants.L)).toBe(0);
  });

  it('lets an employee sell at their own branch only; blocks a suspended store and an archived branch', async () => {
    const s = await f.store();
    const p = await product(s, { M: { a: 3, b: 3 } });
    const employee = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      s.branchB,
    );
    const line = [
      { offer_variant_id: p.variants.M, quantity: 1, expected_unit_price: 100 },
    ];
    const sold = await sell(s, employee, s.branchB, line, 201);
    expect(sold.body.sold_by.id).toBe(employee.userId);
    expect(
      (await sell(s, employee, s.branchA, line, 403)).body.error.code,
    ).toBe('BRANCH_ACCESS_DENIED');

    await prisma.storeBranch.update({
      where: { id: s.branchB },
      data: { archivedAt: new Date() },
    });
    // the existing archived-branch guard answers first (403, as for every stock movement)
    expect((await sell(s, s.owner, s.branchB, line, 403)).body.error.code).toBe(
      'BRANCH_ARCHIVED',
    );
    await prisma.vendor.update({
      where: { id: s.vendorId },
      data: { status: 'SUSPENDED' },
    });
    expect((await sell(s, s.owner, s.branchA, line, 403)).body.error.code).toBe(
      'VENDOR_SUSPENDED',
    );
  });

  it('lists the store sales (owner: every branch; employee: own branch) with the day totals', async () => {
    const s = await f.store();
    const p = await product(s, { M: { a: 5, b: 5 } });
    const employee = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      s.branchB,
    );
    const line = (n: number) => [
      { offer_variant_id: p.variants.M, quantity: n, expected_unit_price: 100 },
    ];
    const a = (await sell(s, s.owner, s.branchA, line(2), 201)).body;
    const b = (await sell(s, employee, s.branchB, line(1), 201)).body;
    const list = async (who: Who, qs = '') =>
      f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/store-sales${qs}`)
        .set(await h(who, s));

    const all = (await list(s.owner)).body;
    expect(all.items.map((x: { id: string }) => x.id)).toEqual([b.id, a.id]);
    expect(all.summary).toEqual({
      sales_count: 2,
      total: '300.00',
      units: 3,
      voided_count: 0,
    });
    expect(
      (await list(s.owner, `?branch_id=${s.branchA}`)).body.items.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([a.id]);

    const own = (await list(employee)).body;
    expect(own.items.map((x: { id: string }) => x.id)).toEqual([b.id]);
    expect((await list(employee, `?branch_id=${s.branchA}`)).status).toBe(403);
    const other = await f
      .http()
      .get(`/api/v1/vendors/${s.vendorId}/store-sales/${a.id}`)
      .set(await h(employee, s));
    expect(other.status).toBe(404);
  });

  it('lets the owner void a whole sale on its own day with a reason, putting every unit back', async () => {
    const s = await f.store();
    const p = await product(s, { S: { a: 4 }, M: { a: 4 } });
    const employee = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      s.branchA,
    );
    const sale = (
      await sell(
        s,
        employee,
        s.branchA,
        [
          {
            offer_variant_id: p.variants.S,
            quantity: 4,
            expected_unit_price: 100,
          },
          {
            offer_variant_id: p.variants.M,
            quantity: 1,
            expected_unit_price: 100,
          },
        ],
        201,
      )
    ).body;
    expect(await qty(s.branchA, p.variants.S)).toBe(0);
    const voidUrl = `/api/v1/vendors/${s.vendorId}/store-sales/${sale.id}/void`;

    expect(
      (
        await f
          .http()
          .post(voidUrl)
          .set(await h(employee, s))
          .send({ reason: 'خطأ' })
      ).body.error.code,
    ).toBe('VENDOR_ROLE_FORBIDDEN');
    expect(
      (
        await f
          .http()
          .post(voidUrl)
          .set(await h(s.owner, s))
          .send({ reason: '   ' })
      ).status,
    ).toBe(400);

    const voided = await f
      .http()
      .post(voidUrl)
      .set(await h(s.owner, s))
      .send({ reason: 'سُجّل المقاس خطأ' })
      .expect(201);
    expect(voided.body).toEqual(
      expect.objectContaining({
        status: 'VOIDED',
        void_reason: 'سُجّل المقاس خطأ',
        voidable: false,
      }),
    );
    expect(await qty(s.branchA, p.variants.S)).toBe(4);
    expect(await qty(s.branchA, p.variants.M)).toBe(4);
    const back = await prisma.stockMovement.findMany({
      where: { vendorId: s.vendorId, reason: 'STORE_SALE_VOID' },
    });
    expect(back.map((m) => m.quantityDelta).sort()).toEqual([1, 4]);
    const items = await prisma.storeSaleItem.findMany({
      where: { storeSaleId: sale.id },
    });
    expect(items.every((i) => i.voidMovementId)).toBe(true);
    expect(
      await prisma.auditLog.count({
        where: { entityId: sale.id, action: 'store_sale.voided' },
      }),
    ).toBe(1);

    expect(
      (
        await f
          .http()
          .post(voidUrl)
          .set(await h(s.owner, s))
          .send({ reason: 'مرة ثانية' })
      ).body.error.code,
    ).toBe('STORE_SALE_ALREADY_VOIDED');
    const list = (
      await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/store-sales`)
        .set(await h(s.owner, s))
    ).body;
    expect(list.summary).toEqual({
      sales_count: 0,
      total: '0.00',
      units: 0,
      voided_count: 1,
    });

    // yesterday's sale stays
    const old = (
      await sell(
        s,
        s.owner,
        s.branchA,
        [
          {
            offer_variant_id: p.variants.M,
            quantity: 1,
            expected_unit_price: 100,
          },
        ],
        201,
      )
    ).body;
    await prisma.storeSale.update({
      where: { id: old.id },
      data: { createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) },
    });
    const late = await f
      .http()
      .post(`/api/v1/vendors/${s.vendorId}/store-sales/${old.id}/void`)
      .set(await h(s.owner, s))
      .send({ reason: 'متأخر' });
    expect(late.body.error.code).toBe('VOID_WINDOW_CLOSED');
  });

  it('starts the cashier with the branches this person may sell at', async () => {
    const s = await f.store();
    const employee = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      s.branchB,
    );
    const start = async (who: Who) =>
      (
        await f
          .http()
          .get(`/api/v1/vendors/${s.vendorId}/cashier`)
          .set(await h(who, s))
          .expect(200)
      ).body;
    const owner = await start(s.owner);
    expect(owner.branches.map((b: { id: string }) => b.id)).toEqual([
      s.branchA,
      s.branchB,
    ]);
    expect(owner.can_void).toBe(true);
    const own = await start(employee);
    expect(own.branches.map((b: { id: string }) => b.id)).toEqual([s.branchB]);
    expect(own.can_void).toBe(false);
    await prisma.storeBranch.update({
      where: { id: s.branchA },
      data: { archivedAt: new Date() },
    });
    expect(
      (await start(s.owner)).branches.map((b: { id: string }) => b.id),
    ).toEqual([s.branchB]);
  });

  it('never shows a barcode or an SKU to a shopper', async () => {
    const s = await f.store();
    const p = await product(s, { M: { a: 3 } });
    await addCode(s, p.offerId, '4006381333931');
    const slug = (
      await prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } })
    ).slug;
    const sib = (
      await prisma.offerVariant.findUniqueOrThrow({
        where: { id: p.variants.M },
      })
    ).storeInventoryBarcode;
    for (const url of [
      `/api/v1/storefronts/${slug}/offers/${p.offerId}`,
      `/api/v1/storefronts/${slug}/offers/${p.offerId}/options`,
      `/api/v1/storefronts/${slug}/products`,
    ]) {
      const body = JSON.stringify((await f.http().get(url).expect(200)).body);
      expect(body).not.toContain('4006381333931');
      expect(body).not.toContain(sib);
      expect(body).not.toContain('seller_sku');
      expect(body).not.toContain('barcode');
    }
  });

  it('sells one basket of several colours and sizes of one product, each line from its own colour x size x branch; one short line refuses all', async () => {
    const s = await f.store();
    const o = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendorId,
        titleAr: 'فستان ألوان',
        titleEn: 'Dress',
        status: 'DRAFT',
        taxonomyVersion: 1,
        requiresTaxonomy: true,
      },
    });
    await prisma.vendorOfferAudience.create({
      data: { vendorId: s.vendorId, vendorOfferId: o.id, audience: 'WOMEN' },
    });
    await prisma.vendorOfferCategory.create({
      data: {
        vendorId: s.vendorId,
        vendorOfferId: o.id,
        categoryCode: 'DRESSES_WOMEN',
      },
    });
    const v: Record<string, string> = {};
    for (const [i, [family, name]] of [
      ['BLUE', 'أزرق'],
      ['RED', 'أحمر'],
    ].entries()) {
      const color = await prisma.offerColor.create({
        data: {
          vendorId: s.vendorId,
          vendorOfferId: o.id,
          familyCode: family,
          nameAr: name,
          sortOrder: i,
        },
      });
      for (const size of ['S', 'M']) {
        const row = await prisma.offerVariant.create({
          data: {
            vendorId: s.vendorId,
            vendorOfferId: o.id,
            sellerSku: f.unique('sku'),
            storeInventoryBarcode: f.unique('sib'),
            basePrice: 100,
            isCombination: true,
            colorCode: family,
            sizeCode: size,
            offerColorId: color.id,
          },
        });
        v[`${family}|${size}`] = row.id;
        await prisma.branchStock.create({
          data: {
            vendorId: s.vendorId,
            branchId: s.branchA,
            offerVariantId: row.id,
            quantity: 5,
          },
        });
        await prisma.branchStock.create({
          data: {
            vendorId: s.vendorId,
            branchId: s.branchB,
            offerVariantId: row.id,
            quantity: 5,
          },
        });
      }
    }
    await prisma.vendorOffer.update({
      where: { id: o.id },
      data: { status: 'ACTIVE' },
    });
    await addCode(s, o.id, '4006381333931');

    // the card offers every colour x size of THIS branch
    const card = (
      await f
        .http()
        .get(
          `/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/cashier/lookup?code=4006381333931`,
        )
        .set(await h(s.owner, s))
        .expect(200)
    ).body;
    expect(
      card.options.map(
        (x: { color_name_ar: string; size_code: string }) =>
          `${x.color_name_ar}|${x.size_code}`,
      ),
    ).toEqual(['أزرق|S', 'أزرق|M', 'أحمر|S', 'أحمر|M']);

    const line = (key: string, quantity: number) => ({
      offer_variant_id: v[key],
      quantity,
      expected_unit_price: 100,
      scanned_code: '4006381333931',
    });
    const sale = (
      await sell(
        s,
        s.owner,
        s.branchA,
        [line('BLUE|M', 3), line('BLUE|S', 2), line('RED|S', 4)],
        201,
      )
    ).body;
    expect(
      sale.lines.map(
        (l: { color_name_ar: string; size_code: string; quantity: number }) => [
          l.color_name_ar,
          l.size_code,
          l.quantity,
        ],
      ),
    ).toEqual([
      ['أزرق', 'M', 3],
      ['أزرق', 'S', 2],
      ['أحمر', 'S', 4],
    ]);
    expect(sale.total).toBe('900.00');
    expect(await qty(s.branchA, v['BLUE|M'])).toBe(2);
    expect(await qty(s.branchA, v['BLUE|S'])).toBe(3);
    expect(await qty(s.branchA, v['RED|S'])).toBe(1);
    expect(await qty(s.branchA, v['RED|M'])).toBe(5);
    for (const key of Object.keys(v))
      expect(await qty(s.branchB, v[key])).toBe(5);

    // RED|S has 1 left: the whole basket is refused, nothing moves
    const refused = await sell(
      s,
      s.owner,
      s.branchA,
      [line('BLUE|M', 1), line('RED|S', 2)],
      409,
    );
    expect(refused.body.error.details).toEqual([
      { offer_variant_id: v['RED|S'], available: 1, requested: 2 },
    ]);
    expect(await qty(s.branchA, v['BLUE|M'])).toBe(2);
  });

  it('a product without a store barcode is not sold at the cashier (an old SIB label opens nothing); an old ACTIVE product stays online; putting an INACTIVE one back needs a barcode', async () => {
    const s = await f.store();
    const bare = await product(s, { M: { a: 3 } }, 'ACTIVE', 100, false);
    const sib = (
      await prisma.offerVariant.findUniqueOrThrow({
        where: { id: bare.variants.M },
      })
    ).storeInventoryBarcode;
    const lookup = await f
      .http()
      .get(
        `/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/cashier/lookup?code=${sib}`,
      )
      .set(await h(s.owner, s))
      .expect(409);
    expect(lookup.body.error.code).toBe('PRODUCT_NEEDS_BARCODE');
    const sale = await sell(
      s,
      s.owner,
      s.branchA,
      [
        {
          offer_variant_id: bare.variants.M,
          quantity: 1,
          expected_unit_price: 100,
        },
      ],
      409,
    );
    expect(sale.body.error.code).toBe('PRODUCT_NEEDS_BARCODE');
    expect(await qty(s.branchA, bare.variants.M)).toBe(3);
    // still online, untouched
    expect(
      (
        await prisma.vendorOffer.findUniqueOrThrow({
          where: { id: bare.offerId },
        })
      ).status,
    ).toBe('ACTIVE');
    expect(
      await prisma.offerBarcode.count({
        where: { vendorOfferId: bare.offerId },
      }),
    ).toBe(0);

    // INACTIVE -> ACTIVE: refused without a barcode, named; fine once it has one
    await prisma.vendorOffer.update({
      where: { id: bare.offerId },
      data: { status: 'INACTIVE' },
    });
    const status = async (body: object) =>
      f
        .http()
        .patch(`/api/v1/vendors/${s.vendorId}/offers/${bare.offerId}/status`)
        .set(await h(s.owner, s))
        .send(body);
    const check = await f
      .http()
      .get(`/api/v1/vendors/${s.vendorId}/offers/${bare.offerId}/publish-check`)
      .set(await h(s.owner, s))
      .expect(200);
    expect(check.body.missing).toContain('barcode');
    const refused = await status({ status: 'ACTIVE' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('OFFER_NOT_PUBLISHABLE');
    expect(refused.body.error.details).toContain('barcode');
    await addCode(s, bare.offerId, '4006381333931');
    // the barcode is no longer what holds it back (this bare test product lacks other things, like images)
    const after = await f
      .http()
      .get(`/api/v1/vendors/${s.vendorId}/offers/${bare.offerId}/publish-check`)
      .set(await h(s.owner, s))
      .expect(200);
    expect(after.body.missing).not.toContain('barcode');
    const again = await status({ status: 'ACTIVE' });
    if (again.status !== 200)
      expect(again.body.error.details).not.toContain('barcode');
  });
});
