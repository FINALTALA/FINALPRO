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

// PS mobile numbers validate only under 056/059. Fixed, disjoint lane
// - see ./helpers/e2e-phone-lanes.ts.
const uniquePhone = createUniquePhone('sprint14-delivery-checkout', '56');
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

const PASSWORD = 'a-strong-password';

describe('Sprint 14 - delivery checkout completeness (e2e)', () => {
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

  // POST /auth/otp/request is throttled to 5/60s across the whole file
  // run, so accounts are signed up once and reused.
  const cached: Record<
    string,
    { phone: string; token: string; userId: string; customerId: string }
  > = {};
  async function getUser(key: 'a' | 'b' | 'c' | 'owner' | 'employee') {
    if (!cached[key]) {
      const phone = uniquePhone();
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone, purpose: 'signup' })
        .expect(202);
      const verify = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', `verify-${phone}`)
        .send({
          phone,
          otp_code: fakeSms.lastCodeFor(phone),
          purpose: 'signup',
        })
        .expect(200);
      const register = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          phone,
          password: PASSWORD,
          verification_token: verify.body.session_token,
        })
        .expect(201);
      const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
      const profile = await prisma.customerProfile.findUniqueOrThrow({
        where: { userId: user.id },
      });
      cached[key] = {
        phone,
        token: register.body.session_token as string,
        userId: user.id,
        customerId: profile.id,
      };
    }
    return cached[key];
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function makeStore(opts: { published?: boolean } = {}) {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('store'),
        legalName: unique('Legal'),
        displayName: unique('متجر'),
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: opts.published ?? true,
        instagramUrl: 'https://instagram.com/example',
      },
    });
    await prisma.vendorSubscription.create({
      data: {
        vendorId: vendor.id,
        status: 'ACTIVE',
        periodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: 'Main',
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
    return { vendor, branch };
  }

  async function makeOffer(
    vendorId: string,
    branchId: string,
    opts: {
      stock: number;
      price?: number;
      offerStatus?: 'ACTIVE' | 'INACTIVE';
    },
  ) {
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId,
        titleAr: unique('عرض'),
        titleEn: unique('Offer'),
        status: opts.offerStatus ?? 'ACTIVE',
      },
    });
    const variant = await prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique('sku'),
        basePrice: opts.price ?? 20,
        storeInventoryBarcode: unique('barcode'),
      },
    });
    await prisma.branchStock.create({
      data: {
        vendorId,
        branchId,
        offerVariantId: variant.id,
        quantity: opts.stock,
      },
    });
    return { offer, variant };
  }

  async function addToCart(
    token: string,
    vendorId: string,
    offerVariantId: string,
    quantity = 1,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set(auth(token))
      .set('Idempotency-Key', unique('cart'))
      .send({
        vendor_id: vendorId,
        offer_variant_id: offerVariantId,
        quantity,
      })
      .expect(201);
    return res.body.id as string;
  }

  async function reservePickup(
    token: string,
    branchId: string,
    cartItemIds: string[],
    paymentMethod: 'ONLINE' | 'COD',
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout/reserve')
      .set(auth(token))
      .set('Idempotency-Key', unique('reserve'))
      .send({
        terms_accepted: true,
        terms_version: '2026-10-v1',
        groups: [
          {
            cart_item_ids: cartItemIds,
            branch_id: branchId,
            fulfilment_method: 'PICKUP',
            payment_method: paymentMethod,
          },
        ],
      })
      .expect(201);
    return res.body.reservation_id as string;
  }

  function confirm(
    token: string,
    reservationId: string,
    body: Record<string, unknown> = {},
    key = unique('confirm'),
  ) {
    return request(app.getHttpServer())
      .post('/api/v1/checkout/confirm')
      .set(auth(token))
      .set('Idempotency-Key', key)
      .send({ reservation_id: reservationId, ...body });
  }

  async function ordersFor(customerId: string) {
    return {
      customerOrders: await prisma.customerOrder.count({
        where: { customerId },
      }),
      payments: await prisma.paymentTransaction.count({
        where: { customerOrder: { customerId } },
      }),
    };
  }

  describe('POST /auth/logout', () => {
    async function login(phone: string): Promise<string> {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ phone, password: PASSWORD })
        .expect(200);
      return res.body.session_token as string;
    }

    it('revokes the calling session; the same token is refused afterwards', async () => {
      const user = await getUser('a');
      const token = await login(user.phone);
      await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set(auth(token))
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set(auth(token))
        .expect(200);
      expect(res.body.logged_out).toBe(true);

      const after = await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set(auth(token))
        .expect(401);
      expect(after.body.error.code).toBe('SESSION_INVALID');

      // A repeat logout with the now-revoked token is a clean 401, never
      // a 500 and never a side effect.
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set(auth(token))
        .expect(401);
    });

    it("revokes only that session: the same user's other sessions and other users' sessions keep working", async () => {
      const a = await getUser('a');
      const b = await getUser('b');
      const s1 = await login(a.phone);
      const s2 = await login(a.phone);

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set(auth(s1))
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set(auth(s1))
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set(auth(s2))
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set(auth(b.token))
        .expect(200);
    });

    it('needs a valid session and writes an audit record', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set(auth('not-a-real-token'))
        .expect(401);

      const a = await getUser('a');
      const token = await login(a.phone);
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set(auth(token))
        .expect(200);
      const audit = await prisma.auditLog.findFirst({
        where: { actorId: a.userId, action: 'user.logout' },
      });
      expect(audit).not.toBeNull();
    });
  });

  describe('customer addresses (delivery checkout prerequisite)', () => {
    it('creates an address from manual lat/lng, landmark, phones and zone; lists only own', async () => {
      const a = await getUser('a');
      const b = await getUser('b');
      const created = await request(app.getHttpServer())
        .post('/api/v1/customers/me/addresses')
        .set(auth(a.token))
        .send({
          label: 'البيت',
          lat: 31.9,
          lng: 35.2,
          landmark_note: 'بجانب الدوار',
          phone_number_1: '+970591234567',
          phone_number_2: '+970561234567',
          zone: 'WEST_BANK',
        })
        .expect(201);
      expect(created.body.zone).toBe('WEST_BANK');

      const aList = await request(app.getHttpServer())
        .get('/api/v1/customers/me/addresses')
        .set(auth(a.token))
        .expect(200);
      expect(aList.body.map((x: { id: string }) => x.id)).toContain(
        created.body.id,
      );
      const bList = await request(app.getHttpServer())
        .get('/api/v1/customers/me/addresses')
        .set(auth(b.token))
        .expect(200);
      expect(bList.body.map((x: { id: string }) => x.id)).not.toContain(
        created.body.id,
      );
    });

    it('rejects out-of-range coordinates, a missing zone and an invalid phone', async () => {
      const a = await getUser('a');
      const base = {
        lat: 31.9,
        lng: 35.2,
        phone_number_1: '+970591234567',
        zone: 'WEST_BANK',
      };
      for (const bad of [
        { ...base, lat: 91 },
        { ...base, lng: 181 },
        { ...base, zone: undefined },
        { ...base, zone: 'MARS' },
        { ...base, phone_number_1: '12345' },
      ]) {
        await request(app.getHttpServer())
          .post('/api/v1/customers/me/addresses')
          .set(auth(a.token))
          .send(bad)
          .expect(400);
      }
    });

    it("BOLA: another customer's address id is refused at checkout quote", async () => {
      const a = await getUser('a');
      const b = await getUser('b');
      const address = await request(app.getHttpServer())
        .post('/api/v1/customers/me/addresses')
        .set(auth(a.token))
        .send({
          lat: 31.9,
          lng: 35.2,
          phone_number_1: '+970591234567',
          zone: 'WEST_BANK',
        })
        .expect(201);
      const { vendor, branch } = await makeStore();
      const { variant } = await makeOffer(vendor.id, branch.id, { stock: 5 });
      const item = await addToCart(b.token, vendor.id, variant.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set(auth(b.token))
        .send({ cart_item_ids: [item], address_id: address.body.id })
        .expect(404);
      expect(res.body.error.code).toBe('ADDRESS_NOT_FOUND');
    });
  });

  describe('cart availability and max quantity', () => {
    async function cartLine(token: string, id: string) {
      const res = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set(auth(token))
        .expect(200);
      return res.body.find((l: { id: string }) => l.id === id);
    }

    it('reports the bucket and the purchase limit; no maximum while the quantity is fine (TB-1)', async () => {
      const a = await getUser('a');
      const { vendor, branch } = await makeStore();
      const plenty = await makeOffer(vendor.id, branch.id, { stock: 10 });
      const few = await makeOffer(vendor.id, branch.id, { stock: 2 });
      const none = await makeOffer(vendor.id, branch.id, { stock: 0 });
      const i1 = await addToCart(a.token, vendor.id, plenty.variant.id);
      const i2 = await addToCart(a.token, vendor.id, few.variant.id);
      const i3 = await addToCart(a.token, vendor.id, none.variant.id);

      expect(await cartLine(a.token, i1)).toMatchObject({
        availability: 'available',
        max_quantity: null,
        purchase_limit: 10,
        purchasable: true,
      });
      expect(await cartLine(a.token, i2)).toMatchObject({
        availability: 'low_stock',
        max_quantity: null,
      });
      expect(await cartLine(a.token, i3)).toMatchObject({
        availability: 'sold_out',
        max_quantity: null,
      });
    });

    it('a live reservation held by another customer reduces the maximum; it returns to normal when released', async () => {
      const a = await getUser('a');
      const b = await getUser('b');
      const { vendor, branch } = await makeStore();
      const { variant } = await makeOffer(vendor.id, branch.id, { stock: 2 });
      // A asks for both units, so the maximum is reported once B holds one.
      const aLine = await addToCart(a.token, vendor.id, variant.id, 2);
      const bLine = await addToCart(b.token, vendor.id, variant.id);

      const reservationId = await reservePickup(
        b.token,
        branch.id,
        [bLine],
        'COD',
      );
      expect(await cartLine(a.token, aLine)).toMatchObject({
        max_quantity: 1,
      });

      await request(app.getHttpServer())
        .post(`/api/v1/checkout/reservations/${reservationId}/cancel`)
        .set(auth(b.token))
        .expect(201);
      expect(await cartLine(a.token, aLine)).toMatchObject({
        max_quantity: null,
      });
    });

    it('an unpublished store or an inactive offer makes the line unpurchasable and sold out', async () => {
      const a = await getUser('a');
      const hidden = await makeStore();
      const off = await makeStore();
      const inHidden = await makeOffer(hidden.vendor.id, hidden.branch.id, {
        stock: 9,
      });
      const inactive = await makeOffer(off.vendor.id, off.branch.id, {
        stock: 9,
      });
      // Cart-add refuses non-purchasable items, so add while purchasable
      // and change eligibility afterwards (the real-world sequence).
      const idHidden = await addToCart(
        a.token,
        hidden.vendor.id,
        inHidden.variant.id,
      );
      await prisma.vendor.update({
        where: { id: hidden.vendor.id },
        data: { storefrontPublished: false },
      });
      const idInactive = await addToCart(
        a.token,
        off.vendor.id,
        inactive.variant.id,
      );
      await prisma.vendorOffer.update({
        where: { id: inactive.offer.id },
        data: { status: 'INACTIVE' },
      });

      for (const id of [idHidden, idInactive]) {
        expect(await cartLine(a.token, id)).toMatchObject({
          purchasable: false,
          availability: 'sold_out',
          max_quantity: null,
        });
      }
    });

    async function addSecondBranchWithStock(
      vendorId: string,
      variantId: string,
      quantity: number,
    ) {
      const second = await prisma.storeBranch.create({
        data: {
          vendorId,
          name: 'Second',
          isPhysical: true,
          verificationStatus: 'APPROVED',
        },
      });
      await prisma.branchStock.create({
        data: {
          vendorId,
          branchId: second.id,
          offerVariantId: variantId,
          quantity,
        },
      });
      return second;
    }

    it('max_quantity is what ONE branch can fulfil, not the sum across branches (checkout never splits a line)', async () => {
      const a = await getUser('a');
      const { vendor, branch } = await makeStore();
      const { variant } = await makeOffer(vendor.id, branch.id, { stock: 5 });
      await addSecondBranchWithStock(vendor.id, variant.id, 5);
      const line = await addToCart(a.token, vendor.id, variant.id, 5);

      expect(await cartLine(a.token, line)).toMatchObject({
        max_quantity: null,
        purchasable: true,
      });

      // 6 is more than either branch can supply on its own: the cart
      // reports the limit up front (5), and checkout agrees - the line is
      // not offered, so there is no late checkout surprise.
      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${line}`)
        .set(auth(a.token))
        .send({ quantity: 6 })
        .expect(200);
      const over = await cartLine(a.token, line);
      expect(over.max_quantity).toBe(5);
      expect(over.quantity).toBeGreaterThan(over.max_quantity);
      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set(auth(a.token))
        .send({ cart_item_ids: [line] })
        .expect(201);
      expect(quote.body.groups).toEqual([]);
      expect(
        quote.body.unavailable_items.map(
          (u: { cart_item_id: string }) => u.cart_item_id,
        ),
      ).toContain(line);

      // Adjusted to the reported maximum, the same line is quotable.
      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${line}`)
        .set(auth(a.token))
        .send({ quantity: over.max_quantity })
        .expect(200);
      const ok = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set(auth(a.token))
        .send({ cart_item_ids: [line] })
        .expect(201);
      expect(ok.body.groups).toHaveLength(1);
      expect(ok.body.unavailable_items).toEqual([]);
    });

    it('live holds are subtracted per branch: the best single branch decides the maximum', async () => {
      const a = await getUser('a');
      const b = await getUser('b');
      const { vendor, branch } = await makeStore();
      const { variant } = await makeOffer(vendor.id, branch.id, { stock: 5 });
      const second = await addSecondBranchWithStock(vendor.id, variant.id, 5);
      const aLine = await addToCart(a.token, vendor.id, variant.id, 3);

      // Other customers hold 3 at the first branch and all 5 at the
      // second: 5-3=2 and 5-5=0, so the best single branch offers 2.
      // (Two different customers - TB-5: one customer holds one live
      // reservation, a second reserve would replace the first.)
      const c = await getUser('c');
      const bLine1 = await addToCart(b.token, vendor.id, variant.id, 3);
      await reservePickup(b.token, branch.id, [bLine1], 'COD');
      const cLine = await addToCart(c.token, vendor.id, variant.id, 5);
      await reservePickup(c.token, second.id, [cLine], 'COD');

      expect(await cartLine(a.token, aLine)).toMatchObject({
        max_quantity: 2,
      });
    });

    it("never shows another customer's lines", async () => {
      const a = await getUser('a');
      const b = await getUser('b');
      const { vendor, branch } = await makeStore();
      const { variant } = await makeOffer(vendor.id, branch.id, { stock: 5 });
      const line = await addToCart(a.token, vendor.id, variant.id);
      expect(await cartLine(b.token, line)).toBeUndefined();
    });
  });

  describe('TB-1: the cart never reveals stock above the public purchase limit', () => {
    async function cartBody(token: string) {
      return (
        await request(app.getHttpServer())
          .get('/api/v1/cart')
          .set(auth(token))
          .expect(200)
      ).body as Record<string, unknown>[];
    }
    /** Every number anywhere in a response body. */
    function numbersIn(value: unknown, out: number[] = []): number[] {
      if (typeof value === 'number') out.push(value);
      else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
      else if (value && typeof value === 'object') {
        Object.values(value).forEach((v) => numbersIn(v, out));
      }
      return out;
    }
    const put = (token: string, id: string, quantity: number) =>
      request(app.getHttpServer())
        .put(`/api/v1/cart/items/${id}`)
        .set(auth(token))
        .send({ quantity });
    const add = (
      token: string,
      vendorId: string,
      variantId: string,
      quantity: number,
    ) =>
      request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set(auth(token))
        .set('Idempotency-Key', unique('cart'))
        .send({ vendor_id: vendorId, offer_variant_id: variantId, quantity });
    const reserveBody = (cartItemId: string, branchId: string) => ({
      terms_accepted: true,
      terms_version: '2026-10-v1',
      groups: [
        {
          cart_item_ids: [cartItemId],
          branch_id: branchId,
          fulfilment_method: 'PICKUP',
          payment_method: 'COD',
        },
      ],
    });
    /** A customer, or the owner/employee of another store browsing as a shopper. */
    async function shopper(key: 'a' | 'owner' | 'employee') {
      const u = await getUser(key);
      if (
        key !== 'a' &&
        !(await prisma.vendorUser.findFirst({ where: { userId: u.userId } }))
      ) {
        const own = await makeStore();
        await prisma.vendorUser.create({
          data: {
            userId: u.userId,
            vendorId: own.vendor.id,
            role: key === 'owner' ? 'OWNER' : 'BRANCH_EMPLOYEE',
            branchId: key === 'owner' ? null : own.branch.id,
          },
        });
      }
      await prisma.cartItem.deleteMany({ where: { customerId: u.customerId } });
      return u;
    }

    for (const who of ['a', 'owner', 'employee'] as const) {
      it(`stock 47 is never in the cart, the limit refusal, the quote or a reserve refusal - at 1 or 999 (${who})`, async () => {
        const u = await shopper(who);
        const { vendor, branch } = await makeStore();
        const { variant } = await makeOffer(vendor.id, branch.id, {
          stock: 47,
        });
        const line = await addToCart(u.token, vendor.id, variant.id, 1);
        let cart = await cartBody(u.token);
        expect(cart.find((l) => l.id === line)).toMatchObject({
          availability: 'available',
          max_quantity: null,
          purchase_limit: 10,
        });
        expect(numbersIn(cart)).not.toContain(47);

        // 999: refused by the public limit - only { limit: 10 }.
        for (const res of [
          await put(u.token, line, 999),
          await add(u.token, vendor.id, variant.id, 999),
        ]) {
          expect(res.status).toBe(422);
          expect(res.body.error.code).toBe('CART_LINE_LIMIT_EXCEEDED');
          expect(res.body.error.details).toEqual([{ limit: 10 }]);
          expect(numbersIn(res.body)).not.toContain(47);
          expect(res.body.error.message).not.toMatch(/47/);
        }
        cart = await cartBody(u.token);
        expect(cart.find((l) => l.id === line)).toMatchObject({ quantity: 1 });

        // At the limit: quotable, and nothing reveals 47.
        await put(u.token, line, 10).expect(200);
        const quote = await request(app.getHttpServer())
          .post('/api/v1/checkout/quote')
          .set(auth(u.token))
          .send({ cart_item_ids: [line] })
          .expect(201);
        expect(quote.body.groups).toHaveLength(1);
        expect(numbersIn(quote.body)).not.toContain(47);
        expect(numbersIn(await cartBody(u.token))).not.toContain(47);

        // Stock drops below the line after the quote: reserve still
        // refuses under its lock, without naming the branch's quantity.
        await prisma.branchStock.updateMany({
          where: { branchId: branch.id, offerVariantId: variant.id },
          data: { quantity: 4 },
        });
        const refused = await request(app.getHttpServer())
          .post('/api/v1/checkout/reserve')
          .set(auth(u.token))
          .set('Idempotency-Key', unique('reserve'))
          .send(reserveBody(line, branch.id))
          .expect(409);
        expect(refused.body.error.code).toBe('INSUFFICIENT_STOCK');
        expect(refused.body.error.message).not.toMatch(/\d/);
        expect(numbersIn(refused.body)).toEqual([]);
      });
    }

    it('stock 7, asking 9: the cart reports 7 only once the quantity fails; a line over the limit reports the limit, is refused by quote and reserve, and can be lowered', async () => {
      const a = await shopper('a');
      const { vendor, branch } = await makeStore();
      const seven = await makeOffer(vendor.id, branch.id, { stock: 7 });
      const many = await makeOffer(vendor.id, branch.id, { stock: 47 });
      const line = await addToCart(a.token, vendor.id, seven.variant.id, 7);
      let cart = await cartBody(a.token);
      expect(cart.find((l) => l.id === line)).toMatchObject({
        max_quantity: null,
      });
      await put(a.token, line, 9).expect(200);
      cart = await cartBody(a.token);
      expect(cart.find((l) => l.id === line)).toMatchObject({
        quantity: 9,
        max_quantity: 7,
        purchase_limit: 10,
      });

      // A line above the limit from before TB-1.
      const old = await addToCart(a.token, vendor.id, many.variant.id, 1);
      await prisma.cartItem.update({
        where: { id: old },
        data: { quantity: 15 },
      });
      cart = await cartBody(a.token);
      expect(cart.find((l) => l.id === old)).toMatchObject({
        quantity: 15,
        max_quantity: 10,
      });
      expect(numbersIn(cart)).not.toContain(47);
      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set(auth(a.token))
        .send({ cart_item_ids: [old] })
        .expect(422);
      expect(quote.body.error.code).toBe('CART_LINE_LIMIT_EXCEEDED');
      const reserve = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set(auth(a.token))
        .set('Idempotency-Key', unique('reserve'))
        .send(reserveBody(old, branch.id))
        .expect(422);
      expect(reserve.body.error.code).toBe('CART_LINE_LIMIT_EXCEEDED');
      await put(a.token, old, 8).expect(200);
      cart = await cartBody(a.token);
      expect(cart.find((l) => l.id === old)).toMatchObject({
        quantity: 8,
        max_quantity: null,
      });
    });

    it('the limit is per offer variant: 10 black/S and 10 white/M of one offer are fine; an 11th of the same variant is refused', async () => {
      const a = await shopper('a');
      const { vendor, branch } = await makeStore();
      const { offer, variant: blackS } = await makeOffer(vendor.id, branch.id, {
        stock: 47,
      });
      await prisma.offerVariant.update({
        where: { id: blackS.id },
        data: { colour: 'أسود', size: 'S' },
      });
      // A second variant of the SAME offer.
      const whiteM = await prisma.offerVariant.create({
        data: {
          vendorId: vendor.id,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          basePrice: 20,
          storeInventoryBarcode: unique('barcode'),
          colour: 'أبيض',
          size: 'M',
        },
      });
      await prisma.branchStock.create({
        data: {
          vendorId: vendor.id,
          branchId: branch.id,
          offerVariantId: whiteM.id,
          quantity: 47,
        },
      });

      const black = await add(a.token, vendor.id, blackS.id, 10);
      const white = await add(a.token, vendor.id, whiteM.id, 10);
      expect([black.status, white.status]).toEqual([201, 201]);
      const lines = await prisma.cartItem.findMany({
        where: { customerId: a.customerId },
        include: { offerVariant: { select: { vendorOfferId: true } } },
      });
      const ofOffer = lines.filter(
        (l) => l.offerVariant.vendorOfferId === offer.id,
      );
      expect(ofOffer.map((l) => l.quantity).sort()).toEqual([10, 10]);

      // Both lines together (20 of one offer) are quotable: 10 per variant.
      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set(auth(a.token))
        .send({ cart_item_ids: [black.body.id, white.body.id] })
        .expect(201);
      expect(quote.body.groups).toHaveLength(1);

      // An 11th of the same variant: refused by add and by update.
      const more = await add(a.token, vendor.id, blackS.id, 1);
      expect(more.status).toBe(422);
      expect(more.body.error.code).toBe('CART_LINE_LIMIT_EXCEEDED');
      const eleven = await put(a.token, black.body.id, 11);
      expect(eleven.status).toBe(422);
      expect(eleven.body.error.code).toBe('CART_LINE_LIMIT_EXCEEDED');
      const after = await prisma.cartItem.findUniqueOrThrow({
        where: { id: black.body.id },
      });
      expect(after.quantity).toBe(10);
    });

    it('concurrent adds and updates of one variant never total more than 10, and never make a second line', async () => {
      const a = await shopper('a');
      const { vendor, branch } = await makeStore();
      const { variant } = await makeOffer(vendor.id, branch.id, { stock: 47 });
      const lines = () =>
        prisma.cartItem.findMany({
          where: { customerId: a.customerId, offerVariantId: variant.id },
        });

      const adds = await Promise.all([
        add(a.token, vendor.id, variant.id, 6),
        add(a.token, vendor.id, variant.id, 6),
        add(a.token, vendor.id, variant.id, 6),
      ]);
      expect(adds.map((r) => r.status).sort()).toEqual([201, 422, 422]);
      expect(await lines()).toHaveLength(1);
      const [line] = await lines();
      expect(line.quantity).toBe(6);

      // An add of 4 racing an update to 9: never both (9 + 4 > 10).
      const [added, updated] = await Promise.all([
        add(a.token, vendor.id, variant.id, 4),
        put(a.token, line.id, 9),
      ]);
      const after = await lines();
      expect(after).toHaveLength(1);
      expect(after[0].quantity).toBeLessThanOrEqual(10);
      if (added.status === 201 && updated.status === 200) {
        // add first (6+4=10), then the update set 9.
        expect(after[0].quantity).toBe(9);
      } else {
        expect([added.status, updated.status]).toContain(422);
      }

      // A second line for the same variant can't exist at all.
      await expect(
        prisma.cartItem.create({
          data: {
            customerId: a.customerId,
            vendorId: vendor.id,
            offerVariantId: variant.id,
            quantity: 1,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('sandbox card payment on confirm', () => {
    async function setupOnline(stock = 5, price = 20) {
      const buyer = await getUser('a');
      const { vendor, branch } = await makeStore();
      const { variant } = await makeOffer(vendor.id, branch.id, {
        stock,
        price,
      });
      const item = await addToCart(buyer.token, vendor.id, variant.id);
      const reservationId = await reservePickup(
        buyer.token,
        branch.id,
        [item],
        'ONLINE',
      );
      return { buyer, vendor, branch, variant, item, reservationId };
    }

    async function stockOf(branchId: string, variantId: string) {
      return prisma.branchStock.findUniqueOrThrow({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variantId },
        },
      });
    }

    it('a declined card fails with PAYMENT_FAILED and changes nothing: no order, no payment, stock hold and cart intact', async () => {
      const s = await setupOnline();
      const before = await ordersFor(s.buyer.customerId);
      const stockBefore = await stockOf(s.branch.id, s.variant.id);

      const res = await confirm(s.buyer.token, s.reservationId, {
        sandbox_card_token: 'tok_sandbox_declined',
      }).expect(409);
      expect(res.body.error.code).toBe('PAYMENT_FAILED');
      expect(res.body.error.details).toEqual([
        { decline_code: 'card_declined' },
      ]);

      expect(await ordersFor(s.buyer.customerId)).toEqual(before);
      const stockAfter = await stockOf(s.branch.id, s.variant.id);
      expect(stockAfter.quantity).toBe(stockBefore.quantity);
      expect(stockAfter.reservedQuantity).toBe(stockBefore.reservedQuantity);
      expect(
        await prisma.checkoutReservation.findUnique({
          where: { id: s.reservationId },
        }),
      ).not.toBeNull();
      expect(
        await prisma.cartItem.findUnique({ where: { id: s.item } }),
      ).not.toBeNull();
    });

    it('insufficient funds is reported as its own decline code', async () => {
      const s = await setupOnline();
      const res = await confirm(s.buyer.token, s.reservationId, {
        sandbox_card_token: 'tok_sandbox_insufficient_funds',
      }).expect(409);
      expect(res.body.error.code).toBe('PAYMENT_FAILED');
      expect(res.body.error.details).toEqual([
        { decline_code: 'insufficient_funds' },
      ]);
    });

    it('after a decline the customer can retry with another card inside the same hold: exactly one order and one payment, stock decremented once', async () => {
      const s = await setupOnline(5, 20);
      await confirm(s.buyer.token, s.reservationId, {
        sandbox_card_token: 'tok_sandbox_declined',
      }).expect(409);

      const ok = await confirm(s.buyer.token, s.reservationId, {
        sandbox_card_token: 'tok_sandbox_visa',
      });
      expect([200, 201]).toContain(ok.status);

      const stock = await stockOf(s.branch.id, s.variant.id);
      expect(stock.quantity).toBe(4);
      expect(stock.reservedQuantity).toBe(0);
      const payments = await prisma.paymentTransaction.findMany({
        where: { customerOrder: { customerId: s.buyer.customerId } },
      });
      expect(
        payments.filter((p) => p.status === 'SUCCEEDED').length,
      ).toBeGreaterThanOrEqual(1);
      const branchOrders = await prisma.branchOrder.findMany({
        where: {
          vendorId: s.vendor.id,
          customerOrder: { customerId: s.buyer.customerId },
        },
      });
      expect(branchOrders).toHaveLength(1);
      expect(
        await prisma.checkoutReservation.findUnique({
          where: { id: s.reservationId },
        }),
      ).toBeNull();
    });

    it('idempotency: the same key + same card replays the decline without side effects; the same key with a different card is a conflict; a success replays the one order', async () => {
      const s = await setupOnline();
      const key = unique('confirm');
      const before = await ordersFor(s.buyer.customerId);

      await confirm(
        s.buyer.token,
        s.reservationId,
        { sandbox_card_token: 'tok_sandbox_declined' },
        key,
      ).expect(409);
      const again = await confirm(
        s.buyer.token,
        s.reservationId,
        { sandbox_card_token: 'tok_sandbox_declined' },
        key,
      );
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('PAYMENT_FAILED');
      expect(await ordersFor(s.buyer.customerId)).toEqual(before);

      const different = await confirm(
        s.buyer.token,
        s.reservationId,
        { sandbox_card_token: 'tok_sandbox_visa' },
        key,
      );
      expect(different.status).toBe(409);
      expect(different.body.error.code).not.toBe('PAYMENT_FAILED');
      expect(await ordersFor(s.buyer.customerId)).toEqual(before);

      const okKey = unique('confirm');
      const first = await confirm(
        s.buyer.token,
        s.reservationId,
        { sandbox_card_token: 'tok_sandbox_visa' },
        okKey,
      );
      const replay = await confirm(
        s.buyer.token,
        s.reservationId,
        { sandbox_card_token: 'tok_sandbox_visa' },
        okKey,
      );
      expect(replay.status).toBe(first.status);
      expect(replay.body).toEqual(first.body);
      const orders = await prisma.branchOrder.count({
        where: {
          vendorId: s.vendor.id,
          customerOrder: { customerId: s.buyer.customerId },
        },
      });
      expect(orders).toBe(1);
    });

    it('accepts only the documented sandbox tokens - an invalid token is a 400 that charges nothing and consumes nothing', async () => {
      const s = await setupOnline();
      const stockBefore = await stockOf(s.branch.id, s.variant.id);
      const ordersBefore = await ordersFor(s.buyer.customerId);
      const branchOrdersBefore = await prisma.branchOrder.count({
        where: { vendorId: s.vendor.id },
      });

      for (const bad of [
        '4242424242424242',
        'tok_visa',
        '4242 4242 4242 4242',
        '',
      ]) {
        const key = unique('confirm-invalid');
        await confirm(
          s.buyer.token,
          s.reservationId,
          { sandbox_card_token: bad },
          key,
        ).expect(400);

        // Nothing was charged or created...
        expect(await ordersFor(s.buyer.customerId)).toEqual(ordersBefore);
        expect(
          await prisma.branchOrder.count({ where: { vendorId: s.vendor.id } }),
        ).toBe(branchOrdersBefore);
        // ...and nothing was consumed: stock, hold and cart line intact.
        const stock = await stockOf(s.branch.id, s.variant.id);
        expect(stock.quantity).toBe(stockBefore.quantity);
        expect(stock.reservedQuantity).toBe(stockBefore.reservedQuantity);
        expect(
          await prisma.checkoutReservation.findUnique({
            where: { id: s.reservationId },
          }),
        ).not.toBeNull();
        expect(
          await prisma.cartItem.findUnique({ where: { id: s.item } }),
        ).not.toBeNull();

        // The idempotency interceptor runs before request validation, so
        // a claim for this key may exist - but it must never be a
        // completed one and must hold no stored response.
        const claims = await prisma.idempotencyKey.findMany({
          where: { key },
        });
        expect(claims.length).toBeLessThanOrEqual(1);
        for (const claim of claims) {
          expect(claim.status).not.toBe('COMPLETED');
          expect(claim.responseBody).toBeNull();
        }
      }

      // Nothing was consumed, so the same reservation still pays normally
      // with a valid sandbox token.
      const ok = await confirm(s.buyer.token, s.reservationId, {
        sandbox_card_token: 'tok_sandbox_visa',
      });
      expect([200, 201]).toContain(ok.status);
      const ordersAfter = await ordersFor(s.buyer.customerId);
      expect(ordersAfter.customerOrders).toBe(ordersBefore.customerOrders + 1);
      expect(ordersAfter.payments).toBe(ordersBefore.payments + 1);
    });

    it('a COD-only checkout ignores the card token entirely (nothing is charged, even with a declining token)', async () => {
      const buyer = await getUser('a');
      const { vendor, branch } = await makeStore();
      const { variant } = await makeOffer(vendor.id, branch.id, { stock: 3 });
      const item = await addToCart(buyer.token, vendor.id, variant.id);
      const reservationId = await reservePickup(
        buyer.token,
        branch.id,
        [item],
        'COD',
      );
      const paymentsBefore = (await ordersFor(buyer.customerId)).payments;
      const res = await confirm(buyer.token, reservationId, {
        sandbox_card_token: 'tok_sandbox_declined',
      });
      expect([200, 201]).toContain(res.status);
      expect((await ordersFor(buyer.customerId)).payments).toBe(paymentsBefore);
    });

    it("BOLA: another customer cannot confirm (or charge) someone else's reservation", async () => {
      const s = await setupOnline();
      const b = await getUser('b');
      const before = await ordersFor(s.buyer.customerId);
      const res = await confirm(b.token, s.reservationId, {
        sandbox_card_token: 'tok_sandbox_visa',
      }).expect(404);
      expect(res.body.error.code).toBe('RESERVATION_NOT_FOUND');
      expect(await ordersFor(s.buyer.customerId)).toEqual(before);
      expect(
        await prisma.checkoutReservation.findUnique({
          where: { id: s.reservationId },
        }),
      ).not.toBeNull();
    });

    it('two simultaneous confirms of the same reservation create exactly one order', async () => {
      const s = await setupOnline(5);
      const results = await Promise.all([
        confirm(s.buyer.token, s.reservationId, {
          sandbox_card_token: 'tok_sandbox_visa',
        }),
        confirm(s.buyer.token, s.reservationId, {
          sandbox_card_token: 'tok_sandbox_visa',
        }),
      ]);
      const ok = results.filter((r) => r.status === 200 || r.status === 201);
      expect(ok.length).toBe(1);
      const orders = await prisma.branchOrder.count({
        where: {
          vendorId: s.vendor.id,
          customerOrder: { customerId: s.buyer.customerId },
        },
      });
      expect(orders).toBe(1);
      expect((await stockOf(s.branch.id, s.variant.id)).quantity).toBe(4);
    });
  });

  describe('online-only branch fulfilment (Sprint 14 review)', () => {
    async function onlineOnlyStore(withWindows: boolean) {
      const { vendor, branch } = await makeStore();
      await prisma.storeBranch.update({
        where: { id: branch.id },
        data: { isPhysical: false },
      });
      if (withWindows) {
        for (let day = 0; day <= 6; day++) {
          await prisma.deliveryWindow.create({
            data: {
              vendorId: vendor.id,
              branchId: branch.id,
              dayOfWeek: day,
              startMinute: 9 * 60,
              endMinute: 18 * 60,
              capacity: 5,
            },
          });
        }
        await prisma.vendorDeliveryZone.create({
          data: {
            vendorId: vendor.id,
            region: 'WEST_BANK',
            enabled: true,
            fee: 10,
          },
        });
      }
      const { variant } = await makeOffer(vendor.id, branch.id, { stock: 5 });
      return { vendor, branch, variant };
    }

    it('reports is_physical=false with delivery slots; pick-up is refused and delivery is reservable', async () => {
      const buyer = await getUser('a');
      const { vendor, branch, variant } = await onlineOnlyStore(true);
      const address = await request(app.getHttpServer())
        .post('/api/v1/customers/me/addresses')
        .set(auth(buyer.token))
        .send({
          lat: 31.9,
          lng: 35.2,
          phone_number_1: '+970591234567',
          zone: 'WEST_BANK',
        })
        .expect(201);
      const line = await addToCart(buyer.token, vendor.id, variant.id);

      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set(auth(buyer.token))
        .send({ cart_item_ids: [line], address_id: address.body.id })
        .expect(201);
      const eligible = quote.body.groups[0].eligible_branches.find(
        (b: { branch_id: string }) => b.branch_id === branch.id,
      );
      expect(eligible.is_physical).toBe(false);
      expect(eligible.available_slots.length).toBeGreaterThan(0);
      const slot = eligible.available_slots[0];

      // The exact 409 the old PICKUP default led to.
      const pickup = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set(auth(buyer.token))
        .set('Idempotency-Key', unique('reserve'))
        .send({
          terms_accepted: true,
          terms_version: '2026-10-v1',
          groups: [
            {
              cart_item_ids: [line],
              branch_id: branch.id,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
            },
          ],
        })
        .expect(409);
      expect(pickup.body.error.code).toBe('PICKUP_REQUIRES_PHYSICAL_BRANCH');

      // The valid default for this branch (DELIVERY) succeeds.
      await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set(auth(buyer.token))
        .set('Idempotency-Key', unique('reserve'))
        .send({
          terms_accepted: true,
          terms_version: '2026-10-v1',
          groups: [
            {
              cart_item_ids: [line],
              branch_id: branch.id,
              fulfilment_method: 'DELIVERY',
              payment_method: 'COD',
              address_id: address.body.id,
              delivery_window_id: slot.delivery_window_id,
              scheduled_date: slot.date,
            },
          ],
        })
        .expect(201);
    });

    it('an online-only branch without delivery slots offers no fulfilment method at all', async () => {
      const buyer = await getUser('a');
      const { vendor, branch, variant } = await onlineOnlyStore(false);
      const line = await addToCart(buyer.token, vendor.id, variant.id);
      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set(auth(buyer.token))
        .send({ cart_item_ids: [line] })
        .expect(201);
      const eligible = quote.body.groups[0].eligible_branches.find(
        (b: { branch_id: string }) => b.branch_id === branch.id,
      );
      expect(eligible.is_physical).toBe(false);
      expect(eligible.available_slots).toEqual([]);
    });
  });

  describe('price change at confirm (CHECKOUT_PRICE_CHANGED)', () => {
    it('returns a structured old -> new diff for every changed line, keeps the message, and creates nothing', async () => {
      const buyer = await getUser('a');
      const { vendor, branch } = await makeStore();
      const { variant } = await makeOffer(vendor.id, branch.id, {
        stock: 5,
        price: 20,
      });
      const item = await addToCart(buyer.token, vendor.id, variant.id);
      const reservationId = await reservePickup(
        buyer.token,
        branch.id,
        [item],
        'COD',
      );
      await prisma.offerVariant.update({
        where: { id: variant.id },
        data: { basePrice: 99 },
      });
      const before = await ordersFor(buyer.customerId);

      const res = await confirm(buyer.token, reservationId).expect(409);
      expect(res.body.error.code).toBe('CHECKOUT_PRICE_CHANGED');
      expect(res.body.error.message).toContain('20 -> 99');
      expect(res.body.error.details).toEqual([
        {
          type: 'price_change',
          offer_variant_id: variant.id,
          old_price: 20,
          new_price: 99,
        },
      ]);
      expect(await ordersFor(buyer.customerId)).toEqual(before);
      // The hold survives so the customer can review and decide.
      expect(
        await prisma.checkoutReservation.findUnique({
          where: { id: reservationId },
        }),
      ).not.toBeNull();
    });
  });
});
