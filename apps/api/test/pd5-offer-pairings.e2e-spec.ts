import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';

// PD-5.4 («نسّقي معه»): an owner's offer-to-offer pairings - same store
// only, never itself, at most 6 (server AND database), owner-only writes
// (no employee, suspended store or inactive subscription), audited - and
// the public read: only eligible picks for the shopper's zone, at least
// two or nothing, no branch/stock detail.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('PD-5.4 offer pairings (e2e)', () => {
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

  const call = (
    method: 'get' | 'put' | 'post',
    url: string,
    token: string | null,
  ) => {
    let r = request(app.getHttpServer())[method](`/api/v1${url}`);
    if (method !== 'get') r = r.set('Idempotency-Key', unique('idem'));
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  async function account() {
    const phone = `+995${Date.now()}${(counter += 1)}`;
    const user = await prisma.user.create({
      data: { phone, passwordHash: 'not-used', phoneVerifiedAt: new Date() },
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
    return { token, userId: user.id, customerId: profile.id };
  }

  /** A sellable store: a physical branch (+ employee) and an online-only
   * branch that delivers to WEST_BANK tomorrow. */
  async function store() {
    const owner = await account();
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('pair-store').toLowerCase(),
        legalName: unique('Legal'),
        displayName: 'متجر التنسيق',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    await prisma.vendorUser.create({
      data: { userId: owner.userId, vendorId: vendor.id, role: 'OWNER' },
    });
    const shop = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('محل'),
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
    const online = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('مستودع'),
        isPhysical: false,
        verificationStatus: 'APPROVED',
      },
    });
    const tomorrow = new Date(Date.now() + 86_400_000);
    const weekday = new Date(
      `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hebron' }).format(tomorrow)}T00:00:00Z`,
    ).getUTCDay();
    await prisma.deliveryWindow.create({
      data: {
        vendorId: vendor.id,
        branchId: online.id,
        dayOfWeek: weekday,
        startMinute: 720,
        endMinute: 840,
        capacity: 5,
      },
    });
    await prisma.vendorDeliveryZone.create({
      data: {
        vendorId: vendor.id,
        region: 'WEST_BANK',
        enabled: true,
        fee: 10,
      },
    });
    const employee = await account();
    await prisma.vendorUser.create({
      data: {
        userId: employee.userId,
        vendorId: vendor.id,
        role: 'BRANCH_EMPLOYEE',
        branchId: shop.id,
      },
    });
    return { vendor, shop, online, owner, employee };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  async function offer(
    s: Store,
    opts: {
      stockAt?: 'shop' | 'online' | null;
      status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
    } = {},
  ) {
    const o = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendor.id,
        titleAr: unique('قطعة'),
        titleEn: 'Piece',
        status: opts.status ?? 'ACTIVE',
        ...(opts.status === 'ARCHIVED' ? { archivedAt: new Date() } : {}),
      },
    });
    const v = await prisma.offerVariant.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: o.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 60,
      },
    });
    const at = opts.stockAt === undefined ? 'shop' : opts.stockAt;
    if (at) {
      await prisma.branchStock.create({
        data: {
          vendorId: s.vendor.id,
          branchId: at === 'shop' ? s.shop.id : s.online.id,
          offerVariantId: v.id,
          quantity: 7,
        },
      });
    }
    return o.id;
  }

  const pairPath = (s: Store, offerId: string) =>
    `/vendors/${s.vendor.id}/offers/${offerId}/pairings`;
  const setPairs = (
    s: Store,
    offerId: string,
    ids: string[],
    token = s.owner.token,
  ) => call('put', pairPath(s, offerId), token).send({ paired_offer_ids: ids });
  const publicPairs = (
    s: Store,
    offerId: string,
    query = '',
    token: string | null = null,
  ) =>
    call(
      'get',
      `/storefronts/${s.vendor.slug}/offers/${offerId}/pairings${query}`,
      token,
    );

  describe('owner management', () => {
    it('owner sets, reorders and removes pairings (audited); same store only, never itself, at most 6', async () => {
      const s = await store();
      const other = await store();
      const main = await offer(s);
      const [a, b, c] = [await offer(s), await offer(s), await offer(s)];

      const set = await setPairs(s, main, [a, b]).expect(200);
      expect(
        set.body.items.map((i: { offer_id: string }) => i.offer_id),
      ).toEqual([a, b]);
      expect(set.body.max).toBe(6);
      await setPairs(s, main, [b, a, c]).expect(200);
      await setPairs(s, main, [b, c]).expect(200);
      const actions = (
        await prisma.auditLog.findMany({
          where: { entityId: main, action: { startsWith: 'offer_pairing.' } },
          orderBy: { occurredAt: 'asc' },
        })
      ).map((r) => r.action);
      expect(actions).toEqual([
        'offer_pairing.created',
        'offer_pairing.created',
        'offer_pairing.reordered',
        'offer_pairing.deleted',
      ]);
      // The same list again: nothing changes, nothing is logged.
      await setPairs(s, main, [b, c]).expect(200);
      expect(
        await prisma.auditLog.count({
          where: { entityId: main, action: { startsWith: 'offer_pairing.' } },
        }),
      ).toBe(4);

      const self = await setPairs(s, main, [a, main]).expect(400);
      expect(self.body.error.code).toBe('OFFER_PAIRING_SELF');
      const foreign = await setPairs(s, main, [a, await offer(other)]).expect(
        404,
      );
      expect(foreign.body.error.code).toBe('PAIRED_OFFER_NOT_FOUND');
      const seven = [];
      for (let i = 0; i < 7; i++) seven.push(await offer(s));
      await setPairs(s, main, seven).expect(400);
      await setPairs(s, main, [a, a]).expect(400);
      await setPairs(s, main, seven.slice(0, 6)).expect(200);
      const archived = await offer(s, { status: 'ARCHIVED' });
      expect(
        (await setPairs(s, main, [a, archived]).expect(409)).body.error.code,
      ).toBe('PAIRED_OFFER_ARCHIVED');
      await setPairs(s, main, []).expect(200);
      expect(
        await prisma.offerPairing.count({ where: { offerId: main } }),
      ).toBe(0);

      // The database refuses the same things on its own.
      await expect(
        prisma.offerPairing.create({
          data: {
            vendorId: s.vendor.id,
            offerId: main,
            pairedOfferId: main,
            sortOrder: 0,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.offerPairing.create({
          data: {
            vendorId: s.vendor.id,
            offerId: main,
            pairedOfferId: await offer(other),
            sortOrder: 0,
          },
        }),
      ).rejects.toThrow();
      for (let i = 0; i < 6; i++) {
        await prisma.offerPairing.create({
          data: {
            vendorId: s.vendor.id,
            offerId: main,
            pairedOfferId: seven[i],
            sortOrder: i,
          },
        });
      }
      await expect(
        prisma.offerPairing.create({
          data: {
            vendorId: s.vendor.id,
            offerId: main,
            pairedOfferId: seven[6],
            sortOrder: 5,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO offer_pairings (id, "vendorId", "offerId", "pairedOfferId", "sortOrder") VALUES (gen_random_uuid()::text, $1, $2, $3, 5)`,
          s.vendor.id,
          main,
          seven[6],
        ),
      ).rejects.toThrow(
        /OFFER_PAIRING_LIMIT|offer_pairings_offerId_sortOrder_key|duplicate/,
      );
    });

    it('employees read only; other stores, customers and guests get nothing; a suspended store or an inactive subscription cannot change them', async () => {
      const s = await store();
      const other = await store();
      const customer = await account();
      const main = await offer(s);
      const [a, b] = [await offer(s), await offer(s)];
      await setPairs(s, main, [a, b]).expect(200);

      expect(
        (await call('get', pairPath(s, main), s.employee.token).expect(200))
          .body.items,
      ).toHaveLength(2);
      await setPairs(s, main, [a], s.employee.token).expect(403);
      await call('get', pairPath(s, main), other.owner.token).expect(403);
      await setPairs(s, main, [a], other.owner.token).expect(403);
      await call('get', pairPath(s, main), customer.token).expect(403);
      await call('get', pairPath(s, main), null).expect(401);
      // Another store's offer under this store's path: not found.
      await call('get', pairPath(s, await offer(other)), s.owner.token).expect(
        404,
      );
      await setPairs(s, await offer(other), [a]).expect(404);

      await prisma.vendor.update({
        where: { id: s.vendor.id },
        data: { subscriptionStatus: 'EXPIRED' },
      });
      expect((await setPairs(s, main, [a]).expect(403)).body.error.code).toBe(
        'SUBSCRIPTION_INACTIVE',
      );
      await prisma.vendor.update({
        where: { id: s.vendor.id },
        data: { subscriptionStatus: 'ACTIVE', status: 'SUSPENDED' },
      });
      expect((await setPairs(s, main, [a]).expect(403)).body.error.code).toBe(
        'VENDOR_SUSPENDED',
      );
      await call('get', pairPath(s, main), s.owner.token).expect(200);
      expect(
        await prisma.offerPairing.count({ where: { offerId: main } }),
      ).toBe(2);
    });
  });

  describe('public «نسّقي معه»', () => {
    it('shows only eligible picks for the zone, in the owner order, with no branch or stock detail', async () => {
      const s = await store();
      const main = await offer(s);
      const inShop = await offer(s);
      const inShop2 = await offer(s);
      const inactive = await offer(s, { status: 'INACTIVE' });
      const soldOut = await offer(s, { stockAt: null });
      const deliveryOnly = await offer(s, { stockAt: 'online' });
      await setPairs(s, main, [
        inactive,
        inShop,
        soldOut,
        deliveryOnly,
        inShop2,
      ]).expect(200);

      const ids = (res: request.Response) =>
        res.body.items.map((i: { id: string }) => i.id);
      // No zone: delivery-only counts (zone still to choose).
      const guest = await publicPairs(s, main).expect(200);
      expect(ids(guest)).toEqual([inShop, deliveryOnly, inShop2]);
      expect(Object.keys(guest.body.items[0]).sort()).toEqual(
        [
          'availability',
          'discount_percent',
          'favorite_variant_id',
          'id',
          'image_url',
          'min_price',
          'original_price',
          'title_ar',
          'title_en',
        ].sort(),
      );
      expect(JSON.stringify(guest.body)).not.toMatch(
        /"(branch\w*|quantity|available|stock\w*|vendor_id)":/,
      );
      // A zone the store delivers to keeps it; one it doesn't drops it.
      expect(
        ids(await publicPairs(s, main, '?zone=WEST_BANK').expect(200)),
      ).toEqual([inShop, deliveryOnly, inShop2]);
      expect(
        ids(await publicPairs(s, main, '?zone=INSIDE').expect(200)),
      ).toEqual([inShop, inShop2]);
      // A signed-in shopper's default address zone applies (here: INSIDE).
      const shopper = await account();
      await call('post', '/customers/me/addresses', shopper.token)
        .send({
          lat: 31.8,
          lng: 35.2,
          phone_number_1: '+970591111111',
          zone: 'INSIDE',
        })
        .expect(201);
      expect(
        ids(await publicPairs(s, main, '', shopper.token).expect(200)),
      ).toEqual([inShop, inShop2]);
      // The owner or an employee browsing as a shopper: the same public answer.
      expect(
        ids(await publicPairs(s, main, '', s.employee.token).expect(200)),
      ).toEqual([inShop, deliveryOnly, inShop2]);
    });

    it('fewer than two eligible picks, an unsellable store or an unknown offer: no section', async () => {
      const s = await store();
      const main = await offer(s);
      const ok = await offer(s);
      const inactive = await offer(s, { status: 'INACTIVE' });
      await setPairs(s, main, [ok, inactive]).expect(200);
      expect((await publicPairs(s, main).expect(200)).body.items).toEqual([]);
      // No pairings at all.
      const lonely = await offer(s);
      expect((await publicPairs(s, lonely).expect(200)).body.items).toEqual([]);

      const two = await offer(s);
      await setPairs(s, main, [ok, two]).expect(200);
      expect((await publicPairs(s, main).expect(200)).body.items).toHaveLength(
        2,
      );
      // Becomes unbuyable -> hidden again.
      await prisma.vendor.update({
        where: { id: s.vendor.id },
        data: { subscriptionStatus: 'EXPIRED' },
      });
      expect((await publicPairs(s, main).expect(200)).body.items).toEqual([]);
      await prisma.vendor.update({
        where: { id: s.vendor.id },
        data: { subscriptionStatus: 'ACTIVE' },
      });
      await prisma.branchStock.updateMany({
        where: { offerVariant: { vendorOfferId: two } },
        data: { quantity: 0 },
      });
      expect((await publicPairs(s, main).expect(200)).body.items).toEqual([]);
      // An inactive main offer, or a suspended store, is simply not found.
      await prisma.vendorOffer.update({
        where: { id: main },
        data: { status: 'INACTIVE' },
      });
      await publicPairs(s, main).expect(404);
      await prisma.vendorOffer.update({
        where: { id: main },
        data: { status: 'ACTIVE' },
      });
      await prisma.vendor.update({
        where: { id: s.vendor.id },
        data: { status: 'SUSPENDED' },
      });
      await publicPairs(s, main).expect(404);
    });
  });
});
