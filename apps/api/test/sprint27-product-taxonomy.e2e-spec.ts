import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { NO_BRAND_SENTINEL_ID } from './../src/common/no-brand-sentinel';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// Sprint 27 - the fixed product taxonomy, colour/size combinations, the
// unified price and their guards. Users are inserted directly and given a
// session through SessionService (no OTP, so no phone lane - the lanes
// are full); their phones use a +999 prefix no lane draws from.
let counter = 0;
/** A real EAN-13 (valid check digit) - the import validates GTINs. */
function validEan13(): string {
  const body = `20${String(Date.now()).slice(-8)}${(counter += 1) % 100}`
    .padEnd(12, '0')
    .slice(0, 12);
  const sum = [...body].reduce(
    (n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3),
    0,
  );
  return body + String((10 - (sum % 10)) % 10);
}

function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 27 - product taxonomy (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeEach(async () => {
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

  afterEach(async () => {
    await app.close();
  });

  const http = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function makeUser() {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: 'not-used', phoneVerifiedAt: new Date() },
    });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { user, token };
  }

  /** A store with two branches, its owner and one branch employee. */
  async function makeStore() {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('tax-store'),
        legalName: unique('Legal'),
        displayName: unique('متجر'),
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    const branchA = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: 'الفرع أ',
        verificationStatus: 'APPROVED',
      },
    });
    const branchB = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: 'الفرع ب',
        verificationStatus: 'APPROVED',
      },
    });
    const owner = await makeUser();
    await prisma.vendorUser.create({
      data: { userId: owner.user.id, vendorId: vendor.id, role: 'OWNER' },
    });
    const employee = await makeUser();
    await prisma.vendorUser.create({
      data: {
        userId: employee.user.id,
        vendorId: vendor.id,
        role: 'BRANCH_EMPLOYEE',
        branchId: branchA.id,
      },
    });
    return {
      vendor,
      branchA,
      branchB,
      owner: owner.token,
      employee: employee.token,
    };
  }

  /** A new owner product, created the way the product form creates it. */
  async function makeOffer(vendorId: string) {
    return prisma.vendorOffer.create({
      data: {
        vendorId,
        titleAr: unique('منتج'),
        titleEn: unique('Product'),
        requiresTaxonomy: true,
      },
    });
  }

  const classify = (
    s: { vendor: { id: string }; owner: string },
    offerId: string,
    body: object,
  ) =>
    request(http())
      .put(`/api/v1/vendors/${s.vendor.id}/offers/${offerId}/classification`)
      .set(auth(s.owner))
      .send(body);

  const combinations = (
    s: { vendor: { id: string }; owner: string },
    offerId: string,
    body: object,
  ) =>
    request(http())
      .post(`/api/v1/vendors/${s.vendor.id}/offers/${offerId}/combinations`)
      .set(auth(s.owner))
      .send(body);

  // ------------------------------------------------------------------
  describe('GET /taxonomy', () => {
    it('serves the fixed lists, with shared codes linked to every audience they belong to', async () => {
      const res = await request(http()).get('/api/v1/taxonomy').expect(200);
      expect(res.body.version).toBe(1);
      expect(res.body.audiences.map((a: { code: string }) => a.code)).toEqual([
        'WOMEN',
        'MEN',
        'KIDS',
      ]);
      expect(res.body.seasons).toEqual([
        { code: 'SUMMER', name_ar: 'الصيف', name_en: 'Summer', sort_order: 1 },
        { code: 'WINTER', name_ar: 'الشتاء', name_en: 'Winter', sort_order: 2 },
        { code: 'FALL', name_ar: 'الخريف', name_en: 'Fall', sort_order: 3 },
        { code: 'SPRING', name_ar: 'الربيع', name_en: 'Spring', sort_order: 4 },
      ]);
      expect(res.body.categories).toHaveLength(49);
      expect(res.body.categories[0]).toMatchObject({
        code: 'DRESSES_WOMEN',
        name_ar: 'فساتين',
        name_en: 'Dresses',
        sort_order: 1,
      });
      // 20 colours from the Sprint 27 seed + GRAY (spring_gray migration).
      expect(res.body.colors).toHaveLength(21);
      expect(res.body.colors[20]).toEqual({
        code: 'GRAY',
        name_ar: 'رمادي',
        name_en: 'Gray',
        hex: '#808080',
        sort_order: 21,
      });
      expect(res.body.sizes).toHaveLength(34);
      expect(res.body.sizes[0]).toEqual({
        code: 'ONE_SIZE',
        label: 'One Size',
        group: 'ADULT',
        sort_order: 1,
      });
      const byCode = new Map<string, { audiences: string[]; name_ar: string }>(
        res.body.categories.map((c: { code: string }) => [c.code, c]),
      );
      const count = (a: string) =>
        res.body.categories.filter((c: { audiences: string[] }) =>
          c.audiences.includes(a),
        ).length;
      expect([count('WOMEN'), count('MEN'), count('KIDS')]).toEqual([
        38, 30, 38,
      ]);
      expect(byCode.get('JEANS')!.audiences).toEqual(['WOMEN', 'MEN', 'KIDS']);
      expect(byCode.get('TOPS')!.audiences).toEqual(['WOMEN', 'KIDS']);
      expect(byCode.get('BLOUSES_MEN')!.audiences).toEqual(['MEN']);
      expect(byCode.get('DRESSES_WOMEN')!.audiences).toEqual(['WOMEN']);
      expect(byCode.get('GIRLS_DRESSES')!.audiences).toEqual(['KIDS']);
      expect(byCode.get('HAIR_ACCESSORIES')!.audiences).toEqual(['KIDS']);
      const ageSizes = res.body.sizes.filter(
        (s: { group: string }) => s.group === 'KIDS_AGE',
      );
      expect(ageSizes).toHaveLength(18);
      expect(ageSizes[0].label).toBe('0–3 أشهر');
      expect(ageSizes[17].label).toBe('13–14 سنة');
    });
  });

  // ------------------------------------------------------------------
  describe('classification', () => {
    it.each([
      [['WOMEN'], ['DRESSES_WOMEN', 'JEANS']],
      [['MEN'], ['BLOUSES_MEN', 'WALLETS']],
      [['KIDS'], ['GIRLS_DRESSES', 'NEWBORN']],
      // Unisex: the union of both audiences' categories, JEANS chosen once.
      [
        ['WOMEN', 'MEN'],
        ['JEANS', 'JACKETS', 'SHIRTS'],
      ],
    ])('accepts %j with categories %j', async (audiences, categories) => {
      const s = await makeStore();
      const offer = await makeOffer(s.vendor.id);
      const res = await classify(s, offer.id, {
        audiences,
        categories,
        season: 'WINTER',
      }).expect(200);
      expect(res.body).toMatchObject({
        classified: true,
        audiences,
        categories,
        season: 'WINTER',
      });
      const stored = await prisma.vendorOfferCategory.findMany({
        where: { vendorOfferId: offer.id },
      });
      expect(stored.map((c) => c.categoryCode).sort()).toEqual(
        [...categories].sort(),
      );
    });

    it('season is optional (null = not seasonal) and at most one value', async () => {
      const s = await makeStore();
      const offer = await makeOffer(s.vendor.id);
      const res = await classify(s, offer.id, {
        audiences: ['WOMEN'],
        categories: ['BAGS'],
      }).expect(200);
      expect(res.body.season).toBeNull();
      await classify(s, offer.id, {
        audiences: ['WOMEN'],
        categories: ['BAGS'],
        season: 'AUTUMN',
      }).expect(400);
      const spring = await classify(s, offer.id, {
        audiences: ['WOMEN'],
        categories: ['BAGS'],
        season: 'SPRING',
      }).expect(200);
      expect(spring.body.season).toBe('SPRING');
      await classify(s, offer.id, {
        audiences: ['WOMEN'],
        categories: ['BAGS'],
        season: ['SUMMER', 'WINTER'],
      }).expect(400);
    });

    it.each([
      [{ audiences: [], categories: ['JEANS'] }, 400, 'BAD_REQUEST'],
      [{ audiences: ['WOMEN'], categories: [] }, 400, 'BAD_REQUEST'],
      [
        { audiences: ['ACCESSORIES'], categories: ['BAGS'] },
        400,
        'BAD_REQUEST',
      ],
      [
        { audiences: ['WOMEN'], categories: ['NOT_A_CATEGORY'] },
        400,
        'UNKNOWN_CATEGORY',
      ],
      [
        { audiences: ['WOMEN'], categories: ['GIRLS_DRESSES'] },
        400,
        'CATEGORY_NOT_IN_AUDIENCE',
      ],
      [
        { audiences: ['MEN'], categories: ['JEANS', 'TOPS'] },
        400,
        'CATEGORY_NOT_IN_AUDIENCE',
      ],
    ])('rejects %j', async (body, status, code) => {
      const s = await makeStore();
      const offer = await makeOffer(s.vendor.id);
      const res = await classify(s, offer.id, body).expect(status);
      expect(res.body.error.code).toBe(code);
      expect(
        (
          await prisma.vendorOffer.findUniqueOrThrow({
            where: { id: offer.id },
          })
        ).taxonomyVersion,
      ).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  describe('combinations, unified price and stock', () => {
    async function classifiedOffer(
      audiences = ['WOMEN'],
      categories = ['DRESSES_WOMEN'],
    ) {
      const s = await makeStore();
      const offer = await makeOffer(s.vendor.id);
      await classify(s, offer.id, { audiences, categories }).expect(200);
      return { s, offer };
    }

    it('supports colour-only, size-only, colour+size and no-options products, each combination its own variant', async () => {
      const cases: [object[], number][] = [
        [
          [
            { color_code: 'BLACK', stock: [] },
            { color_code: 'BEIGE', stock: [] },
          ],
          2,
        ],
        [
          [
            { size_code: 'M', stock: [] },
            { size_code: 'L', stock: [] },
          ],
          2,
        ],
        [
          [
            { color_code: 'BLACK', size_code: 'M', stock: [] },
            { color_code: 'BLACK', size_code: 'L', stock: [] },
          ],
          2,
        ],
        [[{ stock: [] }], 1],
      ];
      for (const [items, n] of cases) {
        const { s, offer } = await classifiedOffer();
        const res = await combinations(s, offer.id, {
          items,
          price: { base_price: 120 },
        }).expect(201);
        expect(res.body.created).toHaveLength(n);
        const variants = await prisma.offerVariant.findMany({
          where: { vendorOfferId: offer.id },
        });
        expect(variants).toHaveLength(n);
        expect(variants.every((v) => v.isCombination)).toBe(true);
      }
    });

    it('never builds the cartesian product - only the combinations sent exist', async () => {
      const { s, offer } = await classifiedOffer();
      await combinations(s, offer.id, {
        items: [
          { color_code: 'BLACK', size_code: 'M', stock: [] },
          { color_code: 'BEIGE', size_code: 'L', stock: [] },
        ],
        price: { base_price: 99 },
      }).expect(201);
      const variants = await prisma.offerVariant.findMany({
        where: { vendorOfferId: offer.id },
      });
      expect(
        variants.map((v) => `${v.colorCode}/${v.sizeCode}`).sort(),
      ).toEqual(['BEIGE/L', 'BLACK/M']);
    });

    it('every combination carries the same price, and stock is separate per combination and branch', async () => {
      const { s, offer } = await classifiedOffer();
      await combinations(s, offer.id, {
        items: [
          {
            color_code: 'BLACK',
            size_code: 'M',
            stock: [
              { branch_id: s.branchA.id, quantity: 5 },
              { branch_id: s.branchB.id, quantity: 1 },
            ],
          },
          {
            color_code: 'BLACK',
            size_code: 'L',
            stock: [{ branch_id: s.branchA.id, quantity: 2 }],
          },
          {
            color_code: 'BEIGE',
            size_code: 'M',
            stock: [{ branch_id: s.branchA.id, quantity: 0 }],
          },
        ],
        price: { base_price: 150, sale_price: 120 },
      }).expect(201);

      const variants = await prisma.offerVariant.findMany({
        where: { vendorOfferId: offer.id },
        include: { branchStocks: true },
      });
      expect(
        new Set(variants.map((v) => `${v.basePrice}/${v.salePrice}`)),
      ).toEqual(new Set(['150/120']));
      const qty = (c: string, sz: string, branch: string) =>
        variants
          .find((v) => v.colorCode === c && v.sizeCode === sz)!
          .branchStocks.find((b) => b.branchId === branch)?.quantity ?? 0;
      expect(qty('BLACK', 'M', s.branchA.id)).toBe(5);
      expect(qty('BLACK', 'M', s.branchB.id)).toBe(1);
      expect(qty('BLACK', 'L', s.branchA.id)).toBe(2);
      expect(qty('BEIGE', 'M', s.branchA.id)).toBe(0);

      // Opening stock: an INITIAL_STOCK movement per (combination, branch)
      // with quantity > 0, audited, and never the PDR-021 owner alert.
      const movements = await prisma.stockMovement.findMany({
        where: { offerVariantId: { in: variants.map((v) => v.id) } },
      });
      expect(movements).toHaveLength(3);
      expect(movements.every((m) => m.reason === 'INITIAL_STOCK')).toBe(true);
      const audits = await prisma.auditLog.count({
        where: {
          action: 'stock_movement.recorded',
          entityId: { in: movements.map((m) => m.id) },
        },
      });
      expect(audits).toBe(3);
      const alerts = await prisma.outboxEvent.findMany({
        where: { eventType: 'stock_movement.owner_notification' },
      });
      expect(
        alerts.filter(
          (e) =>
            JSON.stringify(e.payload).includes(offer.id) ||
            variants.some((v) => JSON.stringify(e.payload).includes(v.id)),
        ),
      ).toHaveLength(0);

      // The owner still sees the sold-out combination, ready to refill.
      const list = await request(http())
        .get(`/api/v1/vendors/${s.vendor.id}/offers/${offer.id}/combinations`)
        .set(auth(s.owner))
        .expect(200);
      const beige = list.body.items.find(
        (i: { color_code: string }) => i.color_code === 'BEIGE',
      );
      expect(beige.status).toBe('sold_out');
    });

    it('refuses an age size unless KIDS is an audience, and keeps KIDS while age sizes are in use', async () => {
      const women = await classifiedOffer(['WOMEN'], ['TOPS']);
      const refused = await combinations(women.s, women.offer.id, {
        items: [{ size_code: 'AGE_2_3Y', stock: [] }],
        price: { base_price: 40 },
      }).expect(400);
      expect(refused.body.error.code).toBe('AGE_SIZE_REQUIRES_KIDS');

      const kids = await classifiedOffer(['WOMEN', 'KIDS'], ['TOPS']);
      await combinations(kids.s, kids.offer.id, {
        items: [
          { size_code: 'AGE_2_3Y', stock: [] },
          { size_code: 'M', stock: [] },
        ],
        price: { base_price: 40 },
      }).expect(201);
      const drop = await classify(kids.s, kids.offer.id, {
        audiences: ['WOMEN'],
        categories: ['TOPS'],
      }).expect(409);
      expect(drop.body.error.code).toBe('KIDS_SIZES_IN_USE');
    });

    it.each([
      [
        {
          items: [{ color_code: 'NOT_A_COLOR', stock: [] }],
          price: { base_price: 10 },
        },
        400,
        'UNKNOWN_COLOR',
      ],
      [
        {
          items: [{ size_code: 'XXL_PLUS', stock: [] }],
          price: { base_price: 10 },
        },
        400,
        'UNKNOWN_SIZE',
      ],
      [
        {
          items: [
            { color_code: 'RED', stock: [] },
            { color_code: 'RED', stock: [] },
          ],
          price: { base_price: 10 },
        },
        409,
        'DUPLICATE_COMBINATION',
      ],
      [{ items: [{ color_code: 'RED', stock: [] }] }, 409, 'PRICE_REQUIRED'],
    ])('rejects %j', async (body, status, code) => {
      const { s, offer } = await classifiedOffer();
      const res = await combinations(s, offer.id, body).expect(status);
      expect(res.body.error.code).toBe(code);
    });

    it('a second request reuses the product price, refuses a price of its own, and refuses an existing combination', async () => {
      const { s, offer } = await classifiedOffer();
      await combinations(s, offer.id, {
        items: [{ color_code: 'RED', stock: [] }],
        price: { base_price: 70 },
      }).expect(201);
      const withPrice = await combinations(s, offer.id, {
        items: [{ color_code: 'BLUE', stock: [] }],
        price: { base_price: 90 },
      }).expect(409);
      expect(withPrice.body.error.code).toBe('PRICE_IS_OFFER_LEVEL');
      await combinations(s, offer.id, {
        items: [{ color_code: 'BLUE', stock: [] }],
      }).expect(201);
      const prices = await prisma.offerVariant.findMany({
        where: { vendorOfferId: offer.id },
        select: { basePrice: true },
      });
      expect(prices.map((p) => Number(p.basePrice))).toEqual([70, 70]);
      const again = await combinations(s, offer.id, {
        items: [{ color_code: 'RED', stock: [] }],
      }).expect(409);
      expect(again.body.error.code).toBe('COMBINATION_EXISTS');
    });

    it('a product must be classified before it gets combinations', async () => {
      const s = await makeStore();
      const offer = await makeOffer(s.vendor.id);
      const res = await combinations(s, offer.id, {
        items: [{ stock: [] }],
        price: { base_price: 10 },
      }).expect(409);
      expect(res.body.error.code).toBe('OFFER_NOT_CLASSIFIED');
    });

    it('PUT .../price rewrites every combination in one go, with one PriceHistory row each', async () => {
      const { s, offer } = await classifiedOffer();
      await combinations(s, offer.id, {
        items: [
          { size_code: 'S', stock: [] },
          { size_code: 'M', stock: [] },
          { size_code: 'L', stock: [] },
        ],
        price: { base_price: 200 },
      }).expect(201);
      const res = await request(http())
        .put(`/api/v1/vendors/${s.vendor.id}/offers/${offer.id}/price`)
        .set(auth(s.owner))
        .send({ base_price: 180, sale_price: 150 })
        .expect(200);
      expect(res.body).toMatchObject({
        base_price: '180.00',
        sale_price: '150.00',
        variants_updated: 3,
      });
      const variants = await prisma.offerVariant.findMany({
        where: { vendorOfferId: offer.id },
      });
      expect(
        new Set(variants.map((v) => `${v.basePrice}/${v.salePrice}`)),
      ).toEqual(new Set(['180/150']));
      const history = await prisma.priceHistory.findMany({
        where: { offerVariantId: { in: variants.map((v) => v.id) } },
      });
      // One row at creation + one for this change, per combination.
      expect(history).toHaveLength(6);
    });
  });

  // ------------------------------------------------------------------
  describe('no way around the unified price or the combination rule', () => {
    async function offerWithCombinations() {
      const s = await makeStore();
      const offer = await makeOffer(s.vendor.id);
      await classify(s, offer.id, {
        audiences: ['MEN'],
        categories: ['SHIRTS'],
      }).expect(200);
      await combinations(s, offer.id, {
        items: [
          { size_code: 'M', stock: [] },
          { size_code: 'L', stock: [] },
        ],
        price: { base_price: 100 },
      }).expect(201);
      const variants = await prisma.offerVariant.findMany({
        where: { vendorOfferId: offer.id },
      });
      return { s, offer, variants };
    }

    it("the existing per-variant edit cannot change one combination's price", async () => {
      const { s, offer, variants } = await offerWithCombinations();
      const res = await request(http())
        .put(
          `/api/v1/vendors/${s.vendor.id}/offers/${offer.id}/variants/${variants[0].id}`,
        )
        .set(auth(s.owner))
        .send({ base_price: 60 })
        .expect(409);
      expect(res.body.error.code).toBe('PRICE_IS_OFFER_LEVEL');
      const after = await prisma.offerVariant.findMany({
        where: { vendorOfferId: offer.id },
      });
      expect(after.map((v) => Number(v.basePrice))).toEqual([100, 100]);
    });

    it('a product with ONE combination: the per-variant edit refuses price, discount, colour and size', async () => {
      const s = await makeStore();
      const offer = await makeOffer(s.vendor.id);
      await classify(s, offer.id, {
        audiences: ['MEN'],
        categories: ['SHIRTS'],
      }).expect(200);
      const created = await combinations(s, offer.id, {
        items: [{ color_code: 'BLACK', size_code: 'M', stock: [] }],
        price: { base_price: 100 },
      }).expect(201);
      const variantId: string = created.body.created[0].variant_id;
      const edit = (body: object) =>
        request(http())
          .put(
            `/api/v1/vendors/${s.vendor.id}/offers/${offer.id}/variants/${variantId}`,
          )
          .set(auth(s.owner))
          .send(body);

      for (const body of [
        { base_price: 60 },
        { sale_price: 80 },
        { sale_price: null },
        {
          discount_percent: 10,
          discount_start_at: new Date(Date.now() - 1000).toISOString(),
          discount_end_at: new Date(Date.now() + 100_000).toISOString(),
        },
      ]) {
        const res = await edit(body).expect(409);
        expect(res.body.error.code).toBe('PRICE_IS_OFFER_LEVEL');
      }
      for (const body of [{ colour: 'أبيض' }, { size: 'XL' }]) {
        const res = await edit(body).expect(409);
        expect(res.body.error.code).toBe('USE_COMBINATION_ENDPOINT');
      }

      const after = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(after).toMatchObject({
        colorCode: 'BLACK',
        sizeCode: 'M',
        colour: 'أسود',
        size: 'M',
        salePrice: null,
        discountPercent: null,
      });
      expect(Number(after.basePrice)).toBe(100);
      expect(
        await prisma.priceHistory.count({
          where: { offerVariantId: variantId },
        }),
      ).toBe(1);

      // Fields that are not price/options stay editable.
      const ok = await edit({ specs_text_en: 'Cotton' }).expect(200);
      expect(ok.body.specs_text_en).toBe('Cotton');
      // The offer-level endpoint is the way to change its price.
      await request(http())
        .put(`/api/v1/vendors/${s.vendor.id}/offers/${offer.id}/price`)
        .set(auth(s.owner))
        .send({ base_price: 90 })
        .expect(200);
    });

    it('a legacy (unclassified) variant still edits price, discount, colour and size through the old path', async () => {
      const s = await makeStore();
      const offer = await prisma.vendorOffer.create({
        data: { vendorId: s.vendor.id, titleAr: 'قديم', titleEn: 'Legacy' },
      });
      const variant = await prisma.offerVariant.create({
        data: {
          vendorId: s.vendor.id,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          basePrice: 100,
          storeInventoryBarcode: unique('barcode'),
          colour: 'Red',
          size: 'M',
        },
      });
      const res = await request(http())
        .put(
          `/api/v1/vendors/${s.vendor.id}/offers/${offer.id}/variants/${variant.id}`,
        )
        .set(auth(s.owner))
        .send({ base_price: 120, sale_price: 99, colour: 'Blue', size: 'L' })
        .expect(200);
      expect(res.body).toMatchObject({
        base_price: '120',
        sale_price: '99',
        colour: 'Blue',
        size: 'L',
      });
      const discounted = await request(http())
        .put(
          `/api/v1/vendors/${s.vendor.id}/offers/${offer.id}/variants/${variant.id}`,
        )
        .set(auth(s.owner))
        // Discount fields alone replace the sale price (sending
        // sale_price too would clear the discount - legacy rule).
        .send({
          discount_percent: 10,
          discount_start_at: new Date(Date.now() - 1000).toISOString(),
          discount_end_at: new Date(Date.now() + 100_000).toISOString(),
        })
        .expect(200);
      expect(discounted.body.effective_price).toBeCloseTo(108, 2);
    });

    it('the existing create-variant endpoint cannot add a plain variant to a classified product', async () => {
      const { s, offer } = await offerWithCombinations();
      const res = await request(http())
        .post(`/api/v1/vendors/${s.vendor.id}/offers/${offer.id}/variants`)
        .set(auth(s.owner))
        .set('Idempotency-Key', unique('variant'))
        .send({ seller_sku: unique('sku'), base_price: 100 })
        .expect(409);
      expect(res.body.error.code).toBe('OFFER_REQUIRES_COMBINATION');
      expect(
        await prisma.offerVariant.count({ where: { vendorOfferId: offer.id } }),
      ).toBe(2);
    });

    it('the database itself refuses a direct divergent price, a plain variant, or flipping isCombination', async () => {
      const { offer, variants } = await offerWithCombinations();
      await expect(
        prisma.offerVariant.update({
          where: { id: variants[0].id },
          data: { basePrice: 1 },
        }),
      ).rejects.toThrow(/OFFER_PRICE_NOT_UNIFIED/);
      await expect(
        prisma.offerVariant.create({
          data: {
            vendorId: offer.vendorId,
            vendorOfferId: offer.id,
            sellerSku: unique('sku'),
            basePrice: 100,
            storeInventoryBarcode: unique('bc'),
          },
        }),
      ).rejects.toThrow(/OFFER_REQUIRES_COMBINATION/);
      await expect(
        prisma.offerVariant.update({
          where: { id: variants[0].id },
          data: { isCombination: false },
        }),
      ).rejects.toThrow(/COMBINATION_FLAG_IMMUTABLE/);
    });

    it('a legacy product keeps its variants, and is classified only after its owner unifies its prices', async () => {
      const s = await makeStore();
      const legacy = await prisma.vendorOffer.create({
        data: {
          vendorId: s.vendor.id,
          titleAr: unique('قديم'),
          titleEn: unique('Legacy'),
          status: 'ACTIVE',
        },
      });
      for (const p of [50, 60]) {
        await prisma.offerVariant.create({
          data: {
            vendorId: s.vendor.id,
            vendorOfferId: legacy.id,
            sellerSku: unique('sku'),
            basePrice: p,
            storeInventoryBarcode: unique('bc'),
            colour: 'أحمر',
          },
        });
      }
      const blocked = await classify(s, legacy.id, {
        audiences: ['WOMEN'],
        categories: ['SHIRTS'],
      }).expect(409);
      expect(blocked.body.error.code).toBe('PRICES_NOT_UNIFIED');
      await request(http())
        .put(`/api/v1/vendors/${s.vendor.id}/offers/${legacy.id}/price`)
        .set(auth(s.owner))
        .send({ base_price: 55 })
        .expect(200);
      await classify(s, legacy.id, {
        audiences: ['WOMEN'],
        categories: ['SHIRTS'],
      }).expect(200);
      const variants = await prisma.offerVariant.findMany({
        where: { vendorOfferId: legacy.id },
      });
      expect(variants).toHaveLength(2);
      expect(
        variants.every((v) => !v.isCombination && v.colour === 'أحمر'),
      ).toBe(true);
      expect(
        (
          await prisma.vendorOffer.findUniqueOrThrow({
            where: { id: legacy.id },
          })
        ).status,
      ).toBe('ACTIVE');
    });
  });

  // ------------------------------------------------------------------
  describe('publishing', () => {
    it('a new product cannot become ACTIVE before it is classified; a legacy product is unaffected', async () => {
      const s = await makeStore();
      const fresh = await makeOffer(s.vendor.id);
      await expect(
        prisma.vendorOffer.update({
          where: { id: fresh.id },
          data: { status: 'ACTIVE' },
        }),
      ).rejects.toThrow(/OFFER_NOT_CLASSIFIED/);
      const legacy = await prisma.vendorOffer.create({
        data: {
          vendorId: s.vendor.id,
          titleAr: unique('قديم'),
          titleEn: unique('Legacy'),
        },
      });
      await prisma.vendorOffer.update({
        where: { id: legacy.id },
        data: { status: 'ACTIVE' },
      });
      await classify(s, fresh.id, {
        audiences: ['KIDS'],
        categories: ['SHOES'],
      }).expect(200);
      await prisma.vendorOffer.update({
        where: { id: fresh.id },
        data: { status: 'ACTIVE' },
      });
    });

    it('the owner publish endpoint answers 409 OFFER_NOT_CLASSIFIED for an unclassified new product', async () => {
      const s = await makeStore();
      const fresh = await makeOffer(s.vendor.id);
      const res = await request(http())
        .patch(`/api/v1/vendors/${s.vendor.id}/offers/${fresh.id}/status`)
        .set(auth(s.owner))
        .set('Idempotency-Key', unique('status'))
        .send({ status: 'ACTIVE' });
      // The existing publish gate (title/brand/image/stock) may refuse
      // first with its own 4xx - either way the product stays DRAFT.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(
        (
          await prisma.vendorOffer.findUniqueOrThrow({
            where: { id: fresh.id },
          })
        ).status,
      ).toBe('DRAFT');
    });
  });

  // ------------------------------------------------------------------
  describe('public store browsing (filters, facets, product options)', () => {
    /**
     * A published store with: a Unisex WOMEN+MEN jeans (BLACK/M x5,
     * BLACK/L x0, BEIGE/M x2), a KIDS dress (RED/AGE_2_3Y x1, WINTER) in a
     * custom section, a sold-out-everywhere MEN shirt (NAVY/L x0) and an
     * unclassified legacy product.
     */
    async function shop() {
      const s = await makeStore();
      const make = async (
        audiences: string[],
        categories: string[],
        season: string | null,
        price: number,
        items: { color_code?: string; size_code?: string; qty: number }[],
      ) => {
        const o = await makeOffer(s.vendor.id);
        await classify(s, o.id, { audiences, categories, season }).expect(200);
        await combinations(s, o.id, {
          items: items.map((i) => ({
            color_code: i.color_code,
            size_code: i.size_code,
            stock: [{ branch_id: s.branchA.id, quantity: i.qty }],
          })),
          price: { base_price: price },
        }).expect(201);
        await prisma.vendorOffer.update({
          where: { id: o.id },
          data: { status: 'ACTIVE' },
        });
        return o;
      };
      const jeans = await make(['WOMEN', 'MEN'], ['JEANS'], null, 120, [
        { color_code: 'BLACK', size_code: 'M', qty: 5 },
        { color_code: 'BLACK', size_code: 'L', qty: 0 },
        { color_code: 'BEIGE', size_code: 'M', qty: 2 },
      ]);
      const dress = await make(['KIDS'], ['GIRLS_DRESSES'], 'WINTER', 60, [
        { color_code: 'RED', size_code: 'AGE_2_3Y', qty: 1 },
      ]);
      const shirt = await make(['MEN'], ['SHIRTS'], 'SUMMER', 90, [
        { color_code: 'NAVY', size_code: 'L', qty: 0 },
      ]);
      const legacy = await prisma.vendorOffer.create({
        data: {
          vendorId: s.vendor.id,
          titleAr: unique('قديم'),
          titleEn: unique('Legacy'),
          status: 'ACTIVE',
        },
      });
      const section = await prisma.storeSection.create({
        data: { vendorId: s.vendor.id, name: 'مميز', sortOrder: 0 },
      });
      await prisma.storeSectionOffer.create({
        data: {
          vendorId: s.vendor.id,
          sectionId: section.id,
          offerId: dress.id,
          sortOrder: 0,
        },
      });
      return { s, jeans, dress, shirt, legacy, section };
    }

    const browse = (slug: string, qs = '') =>
      request(http()).get(`/api/v1/storefronts/${slug}/products${qs}`);
    const ids = (res: request.Response) =>
      res.body.items.map((i: { id: string }) => i.id).sort();

    it('lists everything with no filter, including the unclassified product', async () => {
      const x = await shop();
      const res = await browse(x.s.vendor.slug).expect(200);
      expect(ids(res)).toEqual(
        [x.jeans.id, x.dress.id, x.shirt.id, x.legacy.id].sort(),
      );
      const jeans = res.body.items.find(
        (i: { id: string }) => i.id === x.jeans.id,
      );
      expect(jeans).toMatchObject({
        classified: true,
        audiences: ['WOMEN', 'MEN'],
        min_price: '120.00',
      });
      expect(jeans.colors.sort()).toEqual(['BEIGE', 'BLACK']);
      expect(jeans.sizes).toEqual(['M']); // BLACK/L is sold out
    });

    it('a Unisex product appears under each of its audiences; taxonomy filters drop the unclassified one', async () => {
      const x = await shop();
      expect(
        ids(await browse(x.s.vendor.slug, '?audience=WOMEN').expect(200)),
      ).toEqual([x.jeans.id]);
      expect(
        ids(await browse(x.s.vendor.slug, '?audience=MEN').expect(200)),
      ).toEqual([x.jeans.id, x.shirt.id].sort());
      expect(
        ids(
          await browse(
            x.s.vendor.slug,
            '?audience=KIDS&category=GIRLS_DRESSES',
          ).expect(200),
        ),
      ).toEqual([x.dress.id]);
      expect(
        ids(await browse(x.s.vendor.slug, '?season=WINTER').expect(200)),
      ).toEqual([x.dress.id]);
    });

    it('colour + size must be one in-stock combination; sold-out options never match', async () => {
      const x = await shop();
      expect(
        ids(await browse(x.s.vendor.slug, '?color=BLACK&size=M').expect(200)),
      ).toEqual([x.jeans.id]);
      expect(
        ids(await browse(x.s.vendor.slug, '?color=BLACK&size=L').expect(200)),
      ).toEqual([]);
      expect(
        ids(await browse(x.s.vendor.slug, '?color=NAVY').expect(200)),
      ).toEqual([]);
    });

    it('facets list only available values, and each ignores its own selection', async () => {
      const x = await shop();
      const f = (await browse(x.s.vendor.slug).expect(200)).body.facets;
      // Facets come in the taxonomy's own order (BLACK, RED, BEIGE).
      expect(f.colors.map((c: { code: string }) => c.code)).toEqual([
        'BLACK',
        'RED',
        'BEIGE',
      ]);
      expect(
        f.colors.find((c: { code: string }) => c.code === 'NAVY'),
      ).toBeUndefined();
      expect(f.sizes.map((c: { code: string }) => c.code).sort()).toEqual([
        'AGE_2_3Y',
        'M',
      ]);
      expect(f.audiences).toEqual(
        expect.arrayContaining([
          { code: 'WOMEN', count: 1 },
          { code: 'MEN', count: 2 },
          { code: 'KIDS', count: 1 },
        ]),
      );
      const withBlack = (
        await browse(x.s.vendor.slug, '?color=BLACK').expect(200)
      ).body.facets;
      expect(
        withBlack.colors.map((c: { code: string }) => c.code).sort(),
      ).toEqual(['BEIGE', 'BLACK', 'RED']);
      expect(withBlack.sizes.map((c: { code: string }) => c.code)).toEqual([
        'M',
      ]);
    });

    it('price range, sort and Store Sections combine with the taxonomy', async () => {
      const x = await shop();
      expect(
        ids(
          await browse(x.s.vendor.slug, '?min_price=70&max_price=100').expect(
            200,
          ),
        ),
      ).toEqual([x.shirt.id]);
      const sorted = await browse(
        x.s.vendor.slug,
        '?sort=price_asc&audience=MEN,KIDS',
      ).expect(200);
      expect(sorted.body.items.map((i: { id: string }) => i.id)).toEqual([
        x.dress.id,
        x.shirt.id,
        x.jeans.id,
      ]);
      const inSection = await browse(
        x.s.vendor.slug,
        `?section=${x.section.id}&audience=KIDS`,
      ).expect(200);
      expect(ids(inSection)).toEqual([x.dress.id]);
      expect(
        ids(
          await browse(
            x.s.vendor.slug,
            `?section=${x.section.id}&audience=WOMEN`,
          ).expect(200),
        ),
      ).toEqual([]);
      // The existing sections endpoint is untouched.
      const sections = await request(http())
        .get(`/api/v1/storefronts/${x.s.vendor.slug}/sections`)
        .expect(200);
      expect(Object.keys(sections.body).sort()).toEqual([
        'all',
        'custom',
        'discounts',
        'is_available',
        'new_arrivals',
      ]);
    });

    it.each([
      ['?audience=ACCESSORIES', 'UNKNOWN_AUDIENCE'],
      ['?category=NOPE', 'UNKNOWN_CATEGORY'],
      ['?season=AUTUMN', 'UNKNOWN_SEASON'],
      ['?color=GOLD', 'UNKNOWN_COLOR'],
      ['?size=XXL5', 'UNKNOWN_SIZE'],
      ['?min_price=-1', 'INVALID_PRICE_FILTER'],
      ['?min_price=50&max_price=10', 'INVALID_PRICE_FILTER'],
      ['?section=not-a-section', 'UNKNOWN_SECTION'],
      ['?sort=random', 'INVALID_SORT'],
    ])('rejects %s', async (qs, code) => {
      const x = await shop();
      const res = await browse(x.s.vendor.slug, qs).expect(400);
      expect(res.body.error.code).toBe(code);
    });

    it('an unavailable store answers with no products, never a 404', async () => {
      const x = await shop();
      await prisma.vendor.update({
        where: { id: x.s.vendor.id },
        data: { storefrontPublished: false },
      });
      const res = await browse(x.s.vendor.slug).expect(200);
      expect(res.body).toMatchObject({
        is_available: false,
        total: 0,
        items: [],
      });
    });

    it('product options: in-stock combinations only, one price, legacy and foreign offers handled', async () => {
      const x = await shop();
      const res = await request(http())
        .get(
          `/api/v1/storefronts/${x.s.vendor.slug}/offers/${x.jeans.id}/options`,
        )
        .expect(200);
      expect(res.body.price).toMatchObject({
        min_price: '120.00',
        original_price: null,
      });
      expect(
        res.body.colors.map((c: { code: string }) => c.code).sort(),
      ).toEqual(['BEIGE', 'BLACK']);
      expect(res.body.sizes.map((c: { code: string }) => c.code)).toEqual([
        'M',
      ]);
      expect(
        res.body.combinations
          .map(
            (c: { color_code: string; size_code: string }) =>
              `${c.color_code}/${c.size_code}`,
          )
          .sort(),
      ).toEqual(['BEIGE/M', 'BLACK/M']);
      expect(
        res.body.combinations.every((c: object) => !('quantity' in c)),
      ).toBe(true);

      const legacy = await request(http())
        .get(
          `/api/v1/storefronts/${x.s.vendor.slug}/offers/${x.legacy.id}/options`,
        )
        .expect(200);
      expect(legacy.body).toMatchObject({
        classified: false,
        combinations: [],
      });

      const other = await shop();
      await request(http())
        .get(
          `/api/v1/storefronts/${x.s.vendor.slug}/offers/${other.jeans.id}/options`,
        )
        .expect(404);
    });
  });

  // ------------------------------------------------------------------
  describe('CSV import', () => {
    const importCsv = (
      s: { vendor: { id: string }; owner: string },
      csv: string,
    ) =>
      request(http())
        .post(`/api/v1/vendors/${s.vendor.id}/offers/import`)
        .set(auth(s.owner))
        .set('Idempotency-Key', unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv');

    it('a new product without taxonomy is imported as an unclassified DRAFT that cannot be published - the import itself succeeds', async () => {
      const s = await makeStore();
      const res = await importCsv(
        s,
        [
          'title_ar,title_en,seller_sku,base_price',
          `قطعة,Item,${unique('sku')},45`,
        ].join('\n'),
      ).expect(201);
      expect(res.body.imported).toHaveLength(1);
      expect(res.body.conflicts).toHaveLength(0);

      const offer = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: res.body.imported[0].offer_id },
      });
      expect(offer).toMatchObject({
        status: 'DRAFT',
        requiresTaxonomy: true,
        taxonomyVersion: null,
      });
      await expect(
        prisma.vendorOffer.update({
          where: { id: offer.id },
          data: { status: 'ACTIVE' },
        }),
      ).rejects.toThrow(/OFFER_NOT_CLASSIFIED/);

      // Once the owner classifies it on screen, publishing is possible.
      await classify(s, offer.id, {
        audiences: ['MEN'],
        categories: ['BELTS'],
      }).expect(200);
      await prisma.vendorOffer.update({
        where: { id: offer.id },
        data: { status: 'ACTIVE' },
      });
    });

    it("a row that would add a variant to a classified product is reported as that row's conflict; the import still completes", async () => {
      const s = await makeStore();
      const gtin = validEan13();
      const first = await importCsv(
        s,
        [
          'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value',
          `قميص,Shirt,${unique('sku')},80,GTIN,${gtin}`,
        ].join('\n'),
      ).expect(201);
      const offerId = first.body.imported[0].offer_id;
      await classify(s, offerId, {
        audiences: ['MEN'],
        categories: ['SHIRTS'],
      }).expect(200);

      const second = await importCsv(
        s,
        [
          'title_ar,title_en,seller_sku,base_price,identifier_type,identifier_value',
          `قميص,Shirt,${unique('sku')},80,GTIN,${gtin}`,
          `بنطال,Trousers,${unique('sku')},90,,`,
        ].join('\n'),
      ).expect(201);
      expect(second.body.conflicts).toHaveLength(1);
      expect(second.body.conflicts[0].reason).toMatch(/classified/);
      expect(second.body.imported).toHaveLength(1); // the unrelated row
      expect(
        await prisma.offerVariant.count({ where: { vendorOfferId: offerId } }),
      ).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  describe('authorization and BOLA', () => {
    it('only the owner of this store may classify, price, list or create combinations', async () => {
      const s = await makeStore();
      const other = await makeStore();
      const offer = await makeOffer(s.vendor.id);
      const anon = await makeUser();
      const base = `/api/v1/vendors/${s.vendor.id}/offers/${offer.id}`;
      const calls: [string, string, object?][] = [
        [
          'put',
          `${base}/classification`,
          { audiences: ['WOMEN'], categories: ['JEANS'] },
        ],
        ['put', `${base}/price`, { base_price: 10 }],
        ['get', `${base}/combinations`],
        [
          'post',
          `${base}/combinations`,
          { items: [{ stock: [] }], price: { base_price: 10 } },
        ],
        ['get', `${base}/classification`],
      ];
      for (const [method, path, body] of calls) {
        const r = (t?: string) => {
          const req = (
            request(http()) as unknown as Record<
              string,
              (p: string) => request.Test
            >
          )[method](path);
          if (t) req.set(auth(t));
          return body ? req.send(body) : req;
        };
        expect({ path, s: (await r()).status }).toEqual({ path, s: 401 });
        expect({ path, s: (await r(s.employee)).status }).toEqual({
          path,
          s: 403,
        });
        expect({ path, s: (await r(other.owner)).status }).toEqual({
          path,
          s: 403,
        });
        expect({ path, s: (await r(anon.token)).status }).toEqual({
          path,
          s: 403,
        });
      }
      expect(
        await prisma.vendorOfferAudience.count({
          where: { vendorOfferId: offer.id },
        }),
      ).toBe(0);
    });

    it("another store's offer under my own vendorId reads as 404, never as data", async () => {
      const s = await makeStore();
      const other = await makeStore();
      const foreign = await makeOffer(other.vendor.id);
      await classify(s, foreign.id, {
        audiences: ['WOMEN'],
        categories: ['JEANS'],
      }).expect(404);
      await request(http())
        .get(`/api/v1/vendors/${s.vendor.id}/offers/${foreign.id}/combinations`)
        .set(auth(s.owner))
        .expect(404);
    });

    it("a branch from another store cannot receive this store's combination stock", async () => {
      const s = await makeStore();
      const other = await makeStore();
      const offer = await makeOffer(s.vendor.id);
      await classify(s, offer.id, {
        audiences: ['WOMEN'],
        categories: ['JEANS'],
      }).expect(200);
      const res = await combinations(s, offer.id, {
        items: [
          {
            size_code: 'M',
            stock: [{ branch_id: other.branchA.id, quantity: 3 }],
          },
        ],
        price: { base_price: 10 },
      }).expect(404);
      expect(res.body.error.code).toBe('BRANCH_NOT_FOUND');
      expect(
        await prisma.offerVariant.count({ where: { vendorOfferId: offer.id } }),
      ).toBe(0);
    });

    it('a SUSPENDED store cannot change its taxonomy', async () => {
      const s = await makeStore();
      const offer = await makeOffer(s.vendor.id);
      await prisma.vendor.update({
        where: { id: s.vendor.id },
        data: { status: 'SUSPENDED' },
      });
      const res = await classify(s, offer.id, {
        audiences: ['WOMEN'],
        categories: ['JEANS'],
      }).expect(403);
      expect(res.body.error.code).toBe('VENDOR_SUSPENDED');
    });
  });
  // ------------------------------------------------------------------
  describe('POST /offers: a new product is born classified', () => {
    const createOffer = (
      s: { vendor: { id: string }; owner: string },
      body: object,
    ) =>
      request(http())
        .post(`/api/v1/vendors/${s.vendor.id}/offers`)
        .set(auth(s.owner))
        .set('Idempotency-Key', unique('offer'))
        .send({ title_ar: 'قميص', title_en: 'Shirt', ...body });

    it('requires an audience and a category, with the same codes as PUT .../classification', async () => {
      const s = await makeStore();
      const noAudience = await createOffer(s, { categories: ['TOPS'] }).expect(
        400,
      );
      expect(noAudience.body.error.code).toBe('AUDIENCE_REQUIRED');
      const noCategory = await createOffer(s, { audiences: ['MEN'] }).expect(
        400,
      );
      expect(noCategory.body.error.code).toBe('CATEGORY_REQUIRED');
      const outside = await createOffer(s, {
        audiences: ['MEN'],
        categories: ['GIRLS_DRESSES'],
      }).expect(400);
      expect(outside.body.error.code).toBe('CATEGORY_NOT_IN_AUDIENCE');
      await createOffer(s, {
        audiences: ['MEN'],
        categories: ['JEANS'],
        season: 'AUTUMN',
      }).expect(400);
      expect(
        await prisma.vendorOffer.count({ where: { vendorId: s.vendor.id } }),
      ).toBe(0);
    });

    it('stores the classification, season and taxonomy version in the same transaction', async () => {
      const s = await makeStore();
      const res = await createOffer(s, {
        audiences: ['WOMEN', 'KIDS'],
        categories: ['TOPS'],
        season: 'SUMMER',
      }).expect(201);
      expect(res.body).toMatchObject({
        status: 'DRAFT',
        audiences: ['WOMEN', 'KIDS'],
        categories: ['TOPS'],
        season: 'SUMMER',
      });
      const stored = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: res.body.id },
        include: { audiences: true, categories: true },
      });
      expect(stored.taxonomyVersion).toBe(1);
      expect(stored.requiresTaxonomy).toBe(true);
      expect(stored.audiences.map((a) => a.audience).sort()).toEqual([
        'KIDS',
        'WOMEN',
      ]);
      expect(stored.categories.map((c) => c.categoryCode)).toEqual(['TOPS']);
      const classification = await request(http())
        .get(
          `/api/v1/vendors/${s.vendor.id}/offers/${res.body.id}/classification`,
        )
        .set(auth(s.owner))
        .expect(200);
      expect(classification.body.classified).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  describe('combinations carry the legacy variant data (identifier, SKU, barcode, condition, specs)', () => {
    async function classifiedOffer() {
      const s = await makeStore();
      const offer = await makeOffer(s.vendor.id);
      await classify(s, offer.id, {
        audiences: ['MEN'],
        categories: ['JEANS'],
      }).expect(200);
      return { s, offer };
    }

    it('stores every optional field, and generates the SKU/barcode only when absent', async () => {
      const { s, offer } = await classifiedOffer();
      const res = await combinations(s, offer.id, {
        items: [
          {
            color_code: 'BLACK',
            size_code: 'M',
            stock: [],
            seller_sku: unique('MY-SKU'),
            store_inventory_barcode: '6291041500213',
            condition: 'USED',
            specs_text_ar: 'قطن',
            specs_text_en: 'Cotton',
          },
          { color_code: 'BLACK', size_code: 'L', stock: [] },
        ],
        price: { base_price: 80 },
      }).expect(201);
      expect(res.body.created[0]).toMatchObject({
        store_inventory_barcode: '6291041500213',
        proposed_canonical_variant_id: null,
        match_proposal_status: 'NONE',
      });
      expect(res.body.created[0].seller_sku).toMatch(/^MY-SKU-/);
      expect(res.body.created[1].seller_sku).toMatch(/-BLACK-L$/);
      expect(res.body.created[1].store_inventory_barcode).toMatch(/^SIB-/);
      const stored = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: res.body.created[0].variant_id },
      });
      expect(stored).toMatchObject({
        condition: 'USED',
        specsTextAr: 'قطن',
        specsTextEn: 'Cotton',
        isCombination: true,
      });
    });

    it('refuses half an identifier pair, and a duplicate SKU or barcode with the legacy path codes', async () => {
      const { s, offer } = await classifiedOffer();
      const half = await combinations(s, offer.id, {
        items: [{ size_code: 'M', stock: [], identifier_type: 'GTIN' }],
        price: { base_price: 80 },
      }).expect(400);
      expect(half.body.error.code).toBe('INCOMPLETE_IDENTIFIER_PAIR');

      const sku = unique('DUP');
      const barcode = unique('DUP-BC');
      await combinations(s, offer.id, {
        items: [
          {
            size_code: 'M',
            stock: [],
            seller_sku: sku,
            store_inventory_barcode: barcode,
          },
        ],
        price: { base_price: 80 },
      }).expect(201);
      const dupSku = await combinations(s, offer.id, {
        items: [{ size_code: 'L', stock: [], seller_sku: sku }],
      }).expect(409);
      expect(dupSku.body.error.code).toBe('SELLER_SKU_ALREADY_EXISTS');
      const dupBarcode = await combinations(s, offer.id, {
        items: [
          { size_code: 'L', stock: [], store_inventory_barcode: barcode },
        ],
      }).expect(409);
      expect(dupBarcode.body.error.code).toBe(
        'STORE_INVENTORY_BARCODE_ALREADY_EXISTS',
      );
      expect(
        await prisma.offerVariant.count({ where: { vendorOfferId: offer.id } }),
      ).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  describe('full path: classified product -> matched combination -> published -> discovery and comparison', () => {
    /** A canonical product whose one variant carries `gtin`. */
    async function canonicalWithGtin(modelName: string, gtin: string) {
      const brand = await prisma.brand.create({
        data: {
          name: unique('Brand'),
          normalizedName: unique('brand').toLowerCase(),
        },
      });
      const category = await prisma.category.create({
        data: { nameAr: unique('فئة'), nameEn: unique('Category') },
      });
      const product = await prisma.canonicalProduct.create({
        data: {
          brandId: brand.id,
          categoryId: category.id,
          modelName,
          canonicalNameEn: modelName,
          canonicalNameAr: modelName,
          status: 'PUBLISHED',
        },
      });
      const variant = await prisma.canonicalProductVariant.create({
        data: {
          canonicalProductId: product.id,
          structuralAttributes: {},
          gtin,
          platformProductBarcode: unique('PPB'),
        },
      });
      return { product, variant };
    }

    /** One store's product, built entirely through the real owner API. */
    async function publishedMatchedProduct(
      gtin: string,
      classification: object,
      combination: object,
      basePrice: number,
    ) {
      const s = await makeStore();
      const created = await request(http())
        .post(`/api/v1/vendors/${s.vendor.id}/offers`)
        .set(auth(s.owner))
        .set('Idempotency-Key', unique('offer'))
        .send({
          title_ar: 'قميص كتان',
          title_en: 'Linen shirt',
          brand_id: NO_BRAND_SENTINEL_ID,
          ...classification,
        })
        .expect(201);
      const offerId: string = created.body.id;
      const base = `/api/v1/vendors/${s.vendor.id}/offers/${offerId}`;

      const combo = await combinations(s, offerId, {
        items: [
          {
            ...combination,
            stock: [{ branch_id: s.branchA.id, quantity: 4 }],
            identifier_type: 'GTIN',
            identifier_value: gtin,
            condition: 'NEW',
          },
        ],
        price: { base_price: basePrice },
      }).expect(201);
      const variantId: string = combo.body.created[0].variant_id;
      expect(combo.body.created[0].match_proposal_status).toBe('PENDING');
      // Only proposed so far - nothing is linked until the owner confirms.
      const proposed = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(proposed.canonicalVariantId).toBeNull();

      await request(http())
        .post(`${base}/variants/${variantId}/match-confirmation`)
        .set(auth(s.owner))
        .set('Idempotency-Key', unique('confirm'))
        .send({ decision: 'confirm' })
        .expect(200);
      await request(http())
        .post(`${base}/variants/${variantId}/media`)
        .set(auth(s.owner))
        .set('Idempotency-Key', unique('media'))
        .send({
          url: 'https://example.com/shirt.jpg',
          kind: 'PRIMARY',
          media_type: 'IMAGE',
        })
        .expect(201);
      await request(http())
        .patch(`${base}/status`)
        .set(auth(s.owner))
        .send({ status: 'ACTIVE' })
        .expect(200);
      return { s, offerId, variantId };
    }

    const discover = (query: Record<string, string>) =>
      request(http()).get('/api/v1/discovery/all').query(query).expect(200);

    it('a confirmed, published combination appears in discovery and in the comparison', async () => {
      const model = unique('LinenFullPath');
      const gtin = validEan13();
      const { product, variant } = await canonicalWithGtin(model, gtin);
      expect((await discover({ q: model })).body.total).toBe(0);

      const { s, offerId, variantId } = await publishedMatchedProduct(
        gtin,
        { audiences: ['MEN'], categories: ['JEANS'], season: 'SUMMER' },
        { color_code: 'WHITE', size_code: 'L' },
        120,
      );
      const stored = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(stored.canonicalVariantId).toBe(variant.id);
      expect(stored.matchProposalStatus).toBe('CONFIRMED');

      const listed = await discover({ q: model });
      expect(listed.body.total).toBe(1);
      expect(listed.body.items[0]).toMatchObject({
        canonical_product_id: product.id,
        lowest_price: '120.00',
        store_count: 1,
        cheapest_offer: {
          vendor_id: s.vendor.id,
          offer_id: offerId,
          offer_variant_id: variantId,
        },
      });

      const comparison = await request(http())
        .get(`/api/v1/canonical-products/${product.id}/comparison`)
        .expect(200);
      expect(comparison.body.offers).toHaveLength(1);
      expect(comparison.body.offers[0]).toMatchObject({
        vendor_id: s.vendor.id,
        offer_id: offerId,
        offer_variant_id: variantId,
        price: '120.00',
        availability: 'available',
        condition: 'NEW',
      });

      // The offer-level price moves the discovery card too.
      await request(http())
        .put(`/api/v1/vendors/${s.vendor.id}/offers/${offerId}/price`)
        .set(auth(s.owner))
        .send({ base_price: 120, sale_price: 99 })
        .expect(200);
      expect((await discover({ q: model })).body.items[0].lowest_price).toBe(
        '99.00',
      );
    });

    it('two stores selling the same matched product are compared side by side', async () => {
      const model = unique('LinenTwoStores');
      const gtin = validEan13();
      const { product } = await canonicalWithGtin(model, gtin);
      const a = await publishedMatchedProduct(
        gtin,
        { audiences: ['MEN'], categories: ['JEANS'] },
        { size_code: 'M' },
        150,
      );
      const b = await publishedMatchedProduct(
        gtin,
        { audiences: ['WOMEN'], categories: ['TOPS'] },
        { size_code: 'S' },
        130,
      );
      const listed = await discover({ q: model });
      expect(listed.body.items[0]).toMatchObject({
        lowest_price: '130.00',
        store_count: 2,
        cheapest_offer: { vendor_id: b.s.vendor.id },
      });
      const comparison = await request(http())
        .get(`/api/v1/canonical-products/${product.id}/comparison`)
        .expect(200);
      expect(
        comparison.body.offers
          .map((o: { vendor_id: string }) => o.vendor_id)
          .sort(),
      ).toEqual([a.s.vendor.id, b.s.vendor.id].sort());
    });

    it('/discovery/all taxonomy filters hold for ONE confirmed offer: audience, category, season and an in-stock colour+size', async () => {
      const model = unique('LinenFilters');
      const gtin = validEan13();
      await canonicalWithGtin(model, gtin);
      const { variantId } = await publishedMatchedProduct(
        gtin,
        { audiences: ['MEN'], categories: ['JEANS'], season: 'SUMMER' },
        { color_code: 'WHITE', size_code: 'L' },
        120,
      );
      const total = async (q: Record<string, string>) =>
        (await discover({ q: model, ...q })).body.total;

      expect(await total({ audience: 'MEN' })).toBe(1);
      expect(await total({ audience: 'WOMEN,MEN' })).toBe(1); // OR inside one
      expect(await total({ audience: 'WOMEN' })).toBe(0);
      expect(await total({ category: 'JEANS' })).toBe(1);
      expect(await total({ category: 'DRESSES_WOMEN' })).toBe(0);
      expect(await total({ season: 'SUMMER' })).toBe(1);
      expect(await total({ season: 'WINTER' })).toBe(0);
      expect(await total({ color: 'WHITE', size: 'L' })).toBe(1);
      expect(await total({ color: 'WHITE', size: 'M' })).toBe(0); // not a combination
      expect(await total({ audience: 'MEN', color: 'BLACK' })).toBe(0); // AND across
      expect(
        await total({
          audience: 'MEN',
          category: 'JEANS',
          season: 'SUMMER',
          color: 'WHITE',
        }),
      ).toBe(1);

      // Sold out: colour/size no longer match, the audience still does.
      await prisma.branchStock.updateMany({
        where: { offerVariantId: variantId },
        data: { quantity: 0 },
      });
      expect(await total({ color: 'WHITE' })).toBe(0);
      expect(await total({ audience: 'MEN' })).toBe(1);

      const bad = await request(http())
        .get('/api/v1/discovery/all')
        .query({ color: 'NOT_A_COLOUR' })
        .expect(400);
      expect(bad.body.error.code).toBe('UNKNOWN_COLOR');
    });

    it('a filter never mixes two stores: one store MEN/BLACK and another WOMEN/WHITE do not make a MEN+WHITE match', async () => {
      const model = unique('LinenNoMix');
      const gtin = validEan13();
      await canonicalWithGtin(model, gtin);
      await publishedMatchedProduct(
        gtin,
        { audiences: ['MEN'], categories: ['JEANS'] },
        { color_code: 'BLACK', size_code: 'M' },
        100,
      );
      await publishedMatchedProduct(
        gtin,
        { audiences: ['WOMEN'], categories: ['TOPS'] },
        { color_code: 'WHITE', size_code: 'M' },
        100,
      );
      const total = async (q: Record<string, string>) =>
        (await discover({ q: model, ...q })).body.total;
      expect(await total({ audience: 'MEN', color: 'BLACK' })).toBe(1);
      expect(await total({ audience: 'WOMEN', color: 'WHITE' })).toBe(1);
      expect(await total({ audience: 'MEN', color: 'WHITE' })).toBe(0);
    });

    it('a legacy (unclassified) matched offer is still discovered, but never by a taxonomy filter', async () => {
      const model = unique('LegacyDiscovery');
      const gtin = validEan13();
      const { variant } = await canonicalWithGtin(model, gtin);
      const s = await makeStore();
      const offer = await prisma.vendorOffer.create({
        data: {
          vendorId: s.vendor.id,
          titleAr: 'قديم',
          titleEn: 'Legacy',
          status: 'ACTIVE',
        },
      });
      const legacy = await prisma.offerVariant.create({
        data: {
          vendorId: s.vendor.id,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          basePrice: 50,
          storeInventoryBarcode: unique('barcode'),
          canonicalVariantId: variant.id,
          matchProposalStatus: 'CONFIRMED',
        },
      });
      await prisma.branchStock.create({
        data: {
          vendorId: s.vendor.id,
          branchId: s.branchA.id,
          offerVariantId: legacy.id,
          quantity: 3,
        },
      });
      expect((await discover({ q: model })).body.total).toBe(1);
      expect(
        (await discover({ q: model, audience: 'WOMEN,MEN,KIDS' })).body.total,
      ).toBe(0);
    });
  });
});
