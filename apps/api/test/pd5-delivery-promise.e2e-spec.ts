import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { CURRENT_PLATFORM_TERMS_VERSION } from './../src/checkout/checkout.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';

// PD-5.1 (docs/srs/10-product-detail-enhancement-roadmap.md, PD-FR-004):
// delivery windows in Palestine time, never offering a window that
// already started or is closer than the branch's preparation time - the
// same rule in the slot list (quote, product page, comparison) and in
// reserve; the owner-only preparation-time setting.
//
// These run on the real clock, so windows are placed relative to "now"
// in Asia/Hebron with wide margins (and a window starting at 00:00 today
// has always started by the time the test runs).
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

const DAY_MS = 86_400_000;
function palestineNow() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Hebron',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  const today = new Date(`${p.year}-${p.month}-${p.day}T00:00:00.000Z`);
  const day = (offset: number) => new Date(today.getTime() + offset * DAY_MS);
  return {
    minute: Number(p.hour) * 60 + Number(p.minute),
    day,
    date: (offset: number) => day(offset).toISOString().slice(0, 10),
    weekday: (offset: number) => day(offset).getUTCDay(),
  };
}

describe('PD-5.1 delivery promise (e2e)', () => {
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
    method: 'get' | 'post' | 'put',
    url: string,
    token: string | null,
  ) => {
    let r = request(app.getHttpServer())[method](`/api/v1${url}`);
    if (method !== 'get') r = r.set('Idempotency-Key', unique('idem'));
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  async function account() {
    const phone = `+998${Date.now()}${(counter += 1)}`;
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

  /** A sellable store with one physical branch, an employee, a WEST_BANK
   * delivery zone and one in-stock offer. */
  async function store() {
    const owner = await account();
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('pd5-store').toLowerCase(),
        legalName: unique('Legal'),
        displayName: 'متجر المواعيد',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    await prisma.vendorUser.create({
      data: { userId: owner.userId, vendorId: vendor.id, role: 'OWNER' },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('فرع'),
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
    const employee = await account();
    await prisma.vendorUser.create({
      data: {
        userId: employee.userId,
        vendorId: vendor.id,
        role: 'BRANCH_EMPLOYEE',
        branchId: branch.id,
      },
    });
    await prisma.vendorDeliveryZone.create({
      data: {
        vendorId: vendor.id,
        region: 'WEST_BANK',
        enabled: true,
        fee: 12,
      },
    });
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: vendor.id,
        titleAr: 'قطعة',
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
        basePrice: 80,
      },
    });
    await prisma.branchStock.create({
      data: {
        vendorId: vendor.id,
        branchId: branch.id,
        offerVariantId: variant.id,
        quantity: 10,
      },
    });
    return { owner, employee, vendor, branch, offer, variant };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  async function window(s: Store, dayOffset: number, startMinute: number) {
    const now = palestineNow();
    return prisma.deliveryWindow.create({
      data: {
        vendorId: s.vendor.id,
        branchId: s.branch.id,
        dayOfWeek: now.weekday(dayOffset),
        startMinute,
        endMinute: startMinute + 60,
        capacity: 5,
      },
    });
  }

  async function buyerWithCart(s: Store) {
    const buyer = await account();
    const address = await call('post', '/customers/me/addresses', buyer.token)
      .send({
        lat: 31.9,
        lng: 35.2,
        phone_number_1: '+970591234567',
        zone: 'WEST_BANK',
      })
      .expect(201);
    const line = await call('post', '/cart/items', buyer.token)
      .send({
        vendor_id: s.vendor.id,
        offer_variant_id: s.variant.id,
        quantity: 1,
      })
      .expect(201);
    return {
      buyer,
      addressId: address.body.id as string,
      lineId: line.body.id as string,
    };
  }

  async function quoteSlots(
    s: Store,
    b: { buyer: { token: string }; addressId: string; lineId: string },
  ) {
    const quote = await call('post', '/checkout/quote', b.buyer.token)
      .send({ cart_item_ids: [b.lineId], address_id: b.addressId })
      .expect(201);
    return quote.body.groups[0].eligible_branches.find(
      (x: { branch_id: string }) => x.branch_id === s.branch.id,
    ).available_slots as {
      delivery_window_id: string;
      date: string;
      start_time: string;
    }[];
  }

  function reserve(
    s: Store,
    b: { buyer: { token: string }; addressId: string; lineId: string },
    windowId: string,
    date: string,
  ) {
    return call('post', '/checkout/reserve', b.buyer.token).send({
      terms_accepted: true,
      terms_version: CURRENT_PLATFORM_TERMS_VERSION,
      groups: [
        {
          cart_item_ids: [b.lineId],
          branch_id: s.branch.id,
          fulfilment_method: 'DELIVERY',
          payment_method: 'COD',
          address_id: b.addressId,
          delivery_window_id: windowId,
          scheduled_date: date,
        },
      ],
    });
  }

  const detail = (s: Store, zone?: string) =>
    call(
      'get',
      `/storefronts/${s.vendor.slug}/offers/${s.offer.id}${zone ? `?zone=${zone}` : ''}`,
      null,
    ).expect(200);

  describe('the preparation-time setting (OWNER only)', () => {
    it('owner reads and sets it with an audit row; employee reads only; range, BOLA and suspension are enforced', async () => {
      const s = await store();
      const other = await store();
      const path = `/vendors/${s.vendor.id}/branches/${s.branch.id}/delivery-lead-time`;

      expect((await call('get', path, s.owner.token).expect(200)).body).toEqual(
        { delivery_lead_minutes: 0 },
      );
      expect(
        (await call('get', path, s.employee.token).expect(200)).body,
      ).toEqual({ delivery_lead_minutes: 0 });

      const set = await call('put', path, s.owner.token)
        .send({ delivery_lead_minutes: 90 })
        .expect(200);
      expect(set.body).toEqual({ delivery_lead_minutes: 90 });
      const audit = await prisma.auditLog.findMany({
        where: {
          entityId: s.branch.id,
          action: 'store_branch.delivery_lead_time_updated',
        },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].beforeState).toEqual({ delivery_lead_minutes: 0 });
      expect(audit[0].afterState).toEqual({ delivery_lead_minutes: 90 });
      // Same value again: no second audit row.
      await call('put', path, s.owner.token)
        .send({ delivery_lead_minutes: 90 })
        .expect(200);
      expect(
        await prisma.auditLog.count({
          where: {
            entityId: s.branch.id,
            action: 'store_branch.delivery_lead_time_updated',
          },
        }),
      ).toBe(1);

      // Employee: read only.
      await call('put', path, s.employee.token)
        .send({ delivery_lead_minutes: 10 })
        .expect(403);
      // Out of range / not an integer.
      for (const bad of [-1, 2881, 12.5, '30']) {
        await call('put', path, s.owner.token)
          .send({ delivery_lead_minutes: bad })
          .expect(400);
      }
      // Another store's owner, and an anonymous caller.
      await call('get', path, other.owner.token).expect(403);
      await call('put', path, other.owner.token)
        .send({ delivery_lead_minutes: 10 })
        .expect(403);
      await call('get', path, null).expect(401);
      // A branch of another vendor under this vendor's path.
      await call(
        'get',
        `/vendors/${s.vendor.id}/branches/${other.branch.id}/delivery-lead-time`,
        s.owner.token,
      ).expect(404);
      // The database refuses an out-of-range value too.
      await expect(
        prisma.storeBranch.update({
          where: { id: s.branch.id },
          data: { deliveryLeadMinutes: 5000 },
        }),
      ).rejects.toThrow();

      // A suspended store can't change it (still readable).
      await prisma.vendor.update({
        where: { id: s.vendor.id },
        data: { status: 'SUSPENDED' },
      });
      const blocked = await call('put', path, s.owner.token)
        .send({ delivery_lead_minutes: 30 })
        .expect(403);
      expect(blocked.body.error.code).toBe('VENDOR_SUSPENDED');
      await call('get', path, s.owner.token).expect(200);
      expect(
        (
          await prisma.storeBranch.findUniqueOrThrow({
            where: { id: s.branch.id },
          })
        ).deliveryLeadMinutes,
      ).toBe(90);
    });
  });

  describe('the slot rule, shared by quote, reserve and the product page', () => {
    it('a window that already started today is not offered, and reserve refuses it', async () => {
      const s = await store();
      const now = palestineNow();
      // 00:00 today has always started; tomorrow 12:00 is open.
      const started = await window(s, 0, 0);
      const tomorrow = await window(s, 1, 720);
      const b = await buyerWithCart(s);

      const slots = await quoteSlots(s, b);
      if (now.minute > 0) {
        expect(
          slots.find((x) => x.delivery_window_id === started.id),
        ).toBeUndefined();
      }
      expect(slots[0]).toMatchObject({
        delivery_window_id: tomorrow.id,
        date: now.date(1),
        start_time: '12:00',
      });
      if (now.minute > 0) {
        const refused = await reserve(s, b, started.id, now.date(0)).expect(
          409,
        );
        expect(refused.body.error.code).toBe('SLOT_NO_LONGER_AVAILABLE');
      }

      // The product page promises exactly the slot quote offers first.
      const d = await detail(s, 'WEST_BANK');
      const delivery = d.body.variants[0].fulfilment.delivery;
      expect(delivery.status).toBe('AVAILABLE');
      expect(delivery.earliest_slot).toEqual({
        date: now.date(1),
        start_time: '12:00',
        end_time: '13:00',
      });
      expect(delivery.earliest_slot_date).toBe(now.date(1));
      expect(delivery.latest_slot_date).toBeNull();

      await reserve(s, b, tomorrow.id, now.date(1)).expect(201);
    });

    it("the branch's preparation time removes windows that are too close - everywhere at once", async () => {
      const s = await store();
      const now = palestineNow();
      const near = await window(s, 1, 720); // tomorrow 12:00
      const far = await window(s, 2, 1200); // day after tomorrow 20:00
      // Minutes until tomorrow 12:00 (wall clock; ±60 on a DST day).
      const untilNear = 1440 + 720 - now.minute;
      const b = await buyerWithCart(s);

      // Preparation just short of it: still offered, and the page says
      // "and other windows until <day after tomorrow>".
      await prisma.storeBranch.update({
        where: { id: s.branch.id },
        data: { deliveryLeadMinutes: untilNear - 120 },
      });
      expect((await quoteSlots(s, b))[0].delivery_window_id).toBe(near.id);
      const before = (await detail(s, 'WEST_BANK')).body.variants[0].fulfilment
        .delivery;
      expect(before.earliest_slot.date).toBe(now.date(1));
      expect(before.latest_slot_date).toBe(now.date(2));

      // Preparation longer than that: the near window disappears from the
      // quote, the product page and reserve; the far one remains.
      await prisma.storeBranch.update({
        where: { id: s.branch.id },
        data: { deliveryLeadMinutes: untilNear + 120 },
      });
      const slots = await quoteSlots(s, b);
      expect(slots.map((x) => x.delivery_window_id)).toEqual([far.id]);
      const after = (await detail(s, 'WEST_BANK')).body.variants[0].fulfilment
        .delivery;
      expect(after.earliest_slot).toEqual({
        date: now.date(2),
        start_time: '20:00',
        end_time: '21:00',
      });
      expect(after.latest_slot_date).toBeNull();
      const refused = await reserve(s, b, near.id, now.date(1)).expect(409);
      expect(refused.body.error.code).toBe('SLOT_NO_LONGER_AVAILABLE');
      await reserve(s, b, far.id, now.date(2)).expect(201);
    });

    it("no bookable window: no date at all; guest without a zone still gets the honest earliest date; pickup shows today's real hours", async () => {
      const s = await store();
      const now = palestineNow();
      // No delivery windows yet. No opening hours at all: nothing is
      // claimed about them ("not set" is not "closed").
      const unset = (await detail(s, 'WEST_BANK')).body.variants[0].fulfilment;
      expect(unset.pickup.branches[0]).toMatchObject({
        hours_set: false,
        hours_today: [],
        opening: null,
      });
      // Hours for tomorrow only: closed today.
      await prisma.branchOperatingHours.create({
        data: {
          vendorId: s.vendor.id,
          branchId: s.branch.id,
          dayOfWeek: now.weekday(1),
          openMinute: 10 * 60,
          closeMinute: 14 * 60,
        },
      });
      expect(
        (await detail(s, 'WEST_BANK')).body.variants[0].fulfilment.pickup
          .branches[0],
      ).toMatchObject({ hours_set: true, hours_today: [] });
      // And today's hours.
      await prisma.branchOperatingHours.create({
        data: {
          vendorId: s.vendor.id,
          branchId: s.branch.id,
          dayOfWeek: now.weekday(0),
          openMinute: 9 * 60,
          closeMinute: 21 * 60,
        },
      });
      const none = (await detail(s, 'WEST_BANK')).body.variants[0].fulfilment;
      expect(none.delivery.status).toBe('NO_UPCOMING_SLOTS');
      expect(none.delivery.earliest_slot).toBeNull();
      expect(none.delivery.earliest_slot_date).toBeNull();
      expect(none.pickup.status).toBe('AVAILABLE');
      expect(none.pickup.branches[0].hours_today).toEqual([
        { open: '09:00', close: '21:00' },
      ]);

      await window(s, 1, 600);
      // A guest with no zone: the real earliest window, zone still to choose.
      const guest = (await detail(s)).body;
      expect(guest.fulfilment_context.zone_source).toBe('NONE');
      expect(guest.variants[0].fulfilment.delivery.status).toBe(
        'NO_ZONE_SELECTED',
      );
      expect(guest.variants[0].fulfilment.delivery.earliest_slot).toMatchObject(
        { date: now.date(1), start_time: '10:00' },
      );
      // Outside the store's zones: no promise.
      const outside = (await detail(s, 'INSIDE')).body.variants[0].fulfilment
        .delivery;
      expect(outside.status).toBe('NOT_IN_ZONE');
      expect(outside.earliest_slot).toBeNull();
    });
  });
});
