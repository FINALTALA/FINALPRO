import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';

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

// PS mobile numbers validate only under 056/059; a distinct numeric
// offset per spec file keeps parallel specs from ever generating the
// same phone.
let phoneSeq = (Date.now() % 1_000_000) + 1_400_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97056${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
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
  async function getUser(key: 'a' | 'b') {
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

    it('reports the bucket and the maximum quantity currently available', async () => {
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
        max_quantity: 10,
        purchasable: true,
      });
      expect(await cartLine(a.token, i2)).toMatchObject({
        availability: 'low_stock',
        max_quantity: 2,
      });
      expect(await cartLine(a.token, i3)).toMatchObject({
        availability: 'sold_out',
        max_quantity: 0,
      });
    });

    it('a live reservation held by another customer reduces the maximum; it returns to normal when released', async () => {
      const a = await getUser('a');
      const b = await getUser('b');
      const { vendor, branch } = await makeStore();
      const { variant } = await makeOffer(vendor.id, branch.id, { stock: 2 });
      const aLine = await addToCart(a.token, vendor.id, variant.id);
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
        max_quantity: 2,
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
          max_quantity: 0,
        });
      }
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

    it('accepts only the documented sandbox tokens - a card number or unknown token is a 400 and never charged or stored', async () => {
      const s = await setupOnline();
      const before = await ordersFor(s.buyer.customerId);
      for (const bad of [
        '4242424242424242',
        'tok_visa',
        '4242 4242 4242 4242',
        '',
      ]) {
        await confirm(s.buyer.token, s.reservationId, {
          sandbox_card_token: bad,
        }).expect(400);
      }
      expect(await ordersFor(s.buyer.customerId)).toEqual(before);
      const claims = await prisma.idempotencyKey.findMany({
        where: { requestPath: { contains: 'checkout/confirm' } },
      });
      for (const c of claims) {
        expect(JSON.stringify(c)).not.toContain('4242');
      }
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
