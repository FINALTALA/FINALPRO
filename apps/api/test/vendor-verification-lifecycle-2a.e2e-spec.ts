import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { CURRENT_PLATFORM_TERMS_VERSION } from './../src/checkout/checkout.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// VIA Control Center phase 2A - store verification and selling
// eligibility, through the real HTTP flows:
//  - ONLINE_ONLY: a warehouse-approved store can sell from its
//    non-physical branch (which no branch decision can ever approve);
//  - HYBRID: branch and warehouse evidence in either order, the vendor
//    APPROVED only when both are; one type's approval keeps it
//    UNDER_REVIEW; an explicit rejection of either closes the
//    application and takes the sibling out of decidable work;
//  - PHYSICAL: unchanged;
//  - a late branch of an ACTIVE store is in the reviewer queue, cannot
//    sell until approved, and its rejection touches nothing else;
//  - re-publishing an ACTIVE store's storefront needs a verified path.

let counter = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++counter}`;
const DAY = 86_400_000;

describe('Phase 2A - store verification and selling eligibility (e2e)', () => {
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
    platformRole: 'VERIFICATION_REVIEWER' | 'PLATFORM_ADMIN' | null = null,
  ) {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'not-used',
        phoneVerifiedAt: new Date(),
        platformRole,
      },
    });
    if (!platformRole) {
      await prisma.customerProfile.create({ data: { userId: user.id } });
    }
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { id: user.id, token };
  }

  async function apply(
    owner: string,
    storeType: 'PHYSICAL' | 'ONLINE_ONLY' | 'HYBRID',
    physicalBranches = 1,
  ) {
    const branches =
      storeType === 'ONLINE_ONLY'
        ? [{ name: 'المستودع', is_physical: false }]
        : Array.from({ length: physicalBranches }, (_, i) => ({
            name: `فرع ${i + 1}`,
            is_physical: true,
          }));
    const res = await request(http())
      .post('/api/v1/vendors')
      .set(auth(owner))
      .set('Idempotency-Key', unique('apply'))
      .send({
        legal_name: unique('متجر'),
        store_type: storeType,
        branches,
        applicable_categories: ['WOMEN'],
        return_policy: { mode: 'NO_RETURN' },
      })
      .expect(201);
    return {
      vendorId: res.body.id as string,
      branchIds: (res.body.branches as { id: string }[]).map((b) => b.id),
    };
  }

  const vendorStatus = async (vendorId: string) =>
    (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).status;

  const submitBranch = (owner: string, vendorId: string, branchId: string) =>
    request(http())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-evidence`,
      )
      .set(auth(owner))
      .set('Idempotency-Key', unique('evidence'))
      .send({
        lat: 32.22,
        lng: 35.26,
        verification_photo_url: 'https://example.com/photo.jpg',
      });

  async function decideBranch(
    reviewer: string,
    vendorId: string,
    branchId: string,
    decision: 'approve' | 'reject' | 'request_resubmission',
  ) {
    const branch = await prisma.storeBranch.findUniqueOrThrow({
      where: { id: branchId },
    });
    return request(http())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-decision`,
      )
      .set(auth(reviewer))
      .set('Idempotency-Key', unique('decision'))
      .send({
        decision,
        evidence_revision: branch.evidenceRevision,
        ...(decision === 'approve' ? {} : { reason: 'الصورة غير واضحة' }),
      });
  }

  async function submitWarehouse(owner: string, vendorId: string) {
    await request(http())
      .put(`/api/v1/vendors/${vendorId}/warehouse`)
      .set(auth(owner))
      .send({ lat: 31.9, lng: 35.2, address_note: 'المنطقة الصناعية' })
      .expect(200);
    return request(http())
      .post(`/api/v1/vendors/${vendorId}/warehouse/verification-evidence`)
      .set(auth(owner))
      .set('Idempotency-Key', unique('wh-evidence'))
      .send({});
  }

  const getWarehouse = (reviewer: string, vendorId: string) =>
    request(http())
      .get(`/api/v1/vendors/${vendorId}/warehouse/verification-evidence`)
      .set(auth(reviewer));

  async function decideWarehouse(
    reviewer: string,
    vendorId: string,
    decision: 'approve' | 'reject' | 'request_resubmission',
  ) {
    const pending = await prisma.warehouseVerificationEvidence.findFirst({
      where: { vendorId, status: 'PENDING' },
    });
    return request(http())
      .post(`/api/v1/vendors/${vendorId}/warehouse/verification-decision`)
      .set(auth(reviewer))
      .set('Idempotency-Key', unique('wh-decision'))
      .send({
        evidence_id: pending?.id ?? '00000000-0000-4000-8000-000000000000',
        decision,
        ...(decision === 'approve' ? {} : { reason: 'العنوان غير مكتمل' }),
      });
  }

  const activate = (owner: string, vendorId: string) =>
    request(http())
      .post(`/api/v1/vendors/${vendorId}/subscription`)
      .set(auth(owner))
      .set('Idempotency-Key', unique('sub'))
      .send({})
      .expect(201);

  async function queue(reviewer: string) {
    const items: {
      kind: string;
      item_id: string;
      vendor_id: string;
      vendor_status: string;
    }[] = [];
    let cursor: string | null = null;
    do {
      const res = await request(http())
        .get('/api/v1/admin/verification-queue')
        .query({ limit: '50', ...(cursor ? { cursor } : {}) })
        .set(auth(reviewer))
        .expect(200);
      items.push(...res.body.items);
      cursor = res.body.next_cursor;
    } while (cursor);
    return items;
  }

  /** Operational setup only (contact, windows, zones, stock) - never a
   * verification state: those always come from the real decisions. */
  async function sellableSetup(vendorId: string, branchId: string) {
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { whatsappUrl: 'https://wa.me/970599000000' },
    });
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
      await prisma.deliveryWindow.create({
        data: {
          vendorId,
          branchId,
          dayOfWeek,
          startMinute: 600,
          endMinute: 720,
          capacity: 5,
        },
      });
    }
    await prisma.vendorDeliveryZone.create({
      data: { vendorId, region: 'WEST_BANK', enabled: true, fee: 15 },
    });
    const offer = await prisma.vendorOffer.create({
      data: { vendorId, titleAr: 'منتج', titleEn: 'Product', status: 'ACTIVE' },
    });
    const variant = await prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 40,
      },
    });
    await prisma.branchStock.create({
      data: { vendorId, branchId, offerVariantId: variant.id, quantity: 4 },
    });
    return { offerId: offer.id, variantId: variant.id };
  }

  async function shopper() {
    const who = await account();
    const profile = await prisma.customerProfile.findUniqueOrThrow({
      where: { userId: who.id },
    });
    const address = await prisma.address.create({
      data: {
        customerId: profile.id,
        lat: 31.9,
        lng: 35.2,
        phoneNumber1: uniqueTestPhone(),
        zone: 'WEST_BANK',
        isDefault: true,
      },
    });
    return { token: who.token, addressId: address.id };
  }

  async function productFacts(
    slug: string,
    offerId: string,
    variantId: string,
  ) {
    const res = await request(http())
      .get(`/api/v1/storefronts/${slug}/offers/${offerId}`)
      // A guest has no default address: the zone is chosen manually.
      .query({ zone: 'WEST_BANK' })
      .expect(200);
    const v = (res.body.variants as { id: string; fulfilment: any }[]).find(
      (x) => x.id === variantId,
    )!;
    return v.fulfilment as {
      availability: string;
      delivery: { status: string };
      pickup: { branches: { name: string }[] };
    };
  }

  async function reserve(
    who: { token: string; addressId: string },
    vendorId: string,
    variantId: string,
    branchId: string,
    method: 'DELIVERY' | 'PICKUP',
  ) {
    const added = await request(http())
      .post('/api/v1/cart/items')
      .set(auth(who.token))
      .set('Idempotency-Key', unique('cart'))
      .send({ vendor_id: vendorId, offer_variant_id: variantId, quantity: 1 })
      .expect(201);
    let slot: { delivery_window_id: string; date: string } | undefined;
    if (method === 'DELIVERY') {
      const quote = await request(http())
        .post('/api/v1/checkout/quote')
        .set(auth(who.token))
        .send({ cart_item_ids: [added.body.id], address_id: who.addressId })
        .expect(201);
      const eligible = (quote.body.groups[0]?.eligible_branches ?? []) as {
        branch_id: string;
        available_slots: { delivery_window_id: string; date: string }[];
      }[];
      slot = eligible.find((b) => b.branch_id === branchId)?.available_slots[0];
    }
    return request(http())
      .post('/api/v1/checkout/reserve')
      .set(auth(who.token))
      .set('Idempotency-Key', unique('reserve'))
      .send({
        terms_accepted: true,
        terms_version: CURRENT_PLATFORM_TERMS_VERSION,
        groups: [
          {
            cart_item_ids: [added.body.id],
            branch_id: branchId,
            fulfilment_method: method,
            payment_method: 'COD',
            ...(method === 'DELIVERY'
              ? {
                  address_id: who.addressId,
                  delivery_window_id: slot?.delivery_window_id,
                  scheduled_date: slot?.date,
                }
              : {}),
          },
        ],
      });
  }

  // ------------------------------------------------------------------
  describe('ONLINE_ONLY - the warehouse review verifies the non-physical branch', () => {
    it('a warehouse-approved store sells from its non-physical branch; its branch row is never rewritten', async () => {
      const owner = await account();
      const reviewer = await account('VERIFICATION_REVIEWER');
      const { vendorId, branchIds } = await apply(owner.token, 'ONLINE_ONLY');
      const [warehouseBranch] = branchIds;

      await submitWarehouse(owner.token, vendorId).then((r) =>
        expect(r.status).toBe(201),
      );
      expect(await vendorStatus(vendorId)).toBe('UNDER_REVIEW');
      const approved = await decideWarehouse(
        reviewer.token,
        vendorId,
        'approve',
      );
      expect(approved.status).toBe(201);
      expect(approved.body.vendor_approved).toBe(true);
      await activate(owner.token, vendorId);
      expect(await vendorStatus(vendorId)).toBe('ACTIVE');

      const { offerId, variantId } = await sellableSetup(
        vendorId,
        warehouseBranch,
      );
      await request(http())
        .post(`/api/v1/vendors/${vendorId}/storefront/publish`)
        .set(auth(owner.token))
        .expect(200);
      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });

      const facts = await productFacts(vendor.slug, offerId, variantId);
      expect(facts.availability).toBe('available');
      expect(facts.delivery.status).toBe('AVAILABLE');
      expect(facts.pickup.branches).toEqual([]);

      const buyer = await shopper();
      const res = await reserve(
        buyer,
        vendorId,
        variantId,
        warehouseBranch,
        'DELIVERY',
      );
      expect(res.status).toBe(201);
      expect(res.body.reservation_id).toEqual(expect.any(String));

      // Derived from the warehouse review - the branch itself is untouched.
      const branch = await prisma.storeBranch.findUniqueOrThrow({
        where: { id: warehouseBranch },
      });
      expect(branch.verificationStatus).toBe('PENDING');
      expect(branch.reviewedBy).toBeNull();
    });

    it('without an approved latest warehouse review the non-physical branch still cannot sell', async () => {
      // An ACTIVE store whose latest warehouse evidence is not APPROVED
      // cannot be reached through the API; it is written directly to
      // prove the predicate itself refuses it.
      const owner = await account();
      const { vendorId, branchIds } = await apply(owner.token, 'ONLINE_ONLY');
      const [warehouseBranch] = branchIds;
      const warehouse = await prisma.warehouse.upsert({
        where: { vendorId },
        create: { vendorId, lat: 31.9, lng: 35.2, addressNote: 'x' },
        update: {},
      });
      await prisma.warehouseVerificationEvidence.create({
        data: {
          vendorId,
          warehouseId: warehouse.id,
          lat: 31.9,
          lng: 35.2,
          addressNote: 'x',
          status: 'APPROVED',
          submittedAt: new Date(Date.now() - DAY),
        },
      });
      await prisma.warehouseVerificationEvidence.create({
        data: {
          vendorId,
          warehouseId: warehouse.id,
          lat: 31.9,
          lng: 35.2,
          addressNote: 'x',
          status: 'RESUBMISSION_REQUESTED',
        },
      });
      await prisma.vendor.update({
        where: { id: vendorId },
        data: {
          status: 'ACTIVE',
          subscriptionStatus: 'ACTIVE',
          storefrontPublished: true,
        },
      });
      await prisma.vendorSubscription.create({
        data: {
          vendorId,
          status: 'ACTIVE',
          periodStart: new Date(),
          periodEnd: new Date(Date.now() + 30 * DAY),
        },
      });
      const { variantId } = await sellableSetup(vendorId, warehouseBranch);
      const buyer = await shopper();
      const res = await reserve(
        buyer,
        vendorId,
        variantId,
        warehouseBranch,
        'DELIVERY',
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BRANCH_NOT_AVAILABLE_FOR_ORDERS');
    });
  });

  // ------------------------------------------------------------------
  describe('HYBRID - branch and warehouse evidence, either order', () => {
    it('branch first: the branch approval keeps the store UNDER_REVIEW; the warehouse approval completes it', async () => {
      const owner = await account();
      const reviewer = await account('VERIFICATION_REVIEWER');
      const { vendorId, branchIds } = await apply(owner.token, 'HYBRID');
      expect(await vendorStatus(vendorId)).toBe('APPLIED');

      await submitBranch(owner.token, vendorId, branchIds[0]).expect(201);
      expect(await vendorStatus(vendorId)).toBe('UNDER_REVIEW');
      const branchOk = await decideBranch(
        reviewer.token,
        vendorId,
        branchIds[0],
        'approve',
      );
      expect(branchOk.status).toBe(201);
      expect(branchOk.body.vendor_approved).toBe(false);
      expect(await vendorStatus(vendorId)).toBe('UNDER_REVIEW');

      expect((await submitWarehouse(owner.token, vendorId)).status).toBe(201);
      expect(await vendorStatus(vendorId)).toBe('UNDER_REVIEW');
      const detail = await getWarehouse(reviewer.token, vendorId).expect(200);
      expect(detail.body.store).toMatchObject({
        store_type: 'HYBRID',
        vendor_status: 'UNDER_REVIEW',
        physical_required: true,
        warehouse_required: true,
        branches: [{ branch_id: branchIds[0], state: 'APPROVED' }],
        warehouse: { state: 'PENDING_REVIEW' },
        complete: false,
        next_step: 'REVIEW',
      });

      const whOk = await decideWarehouse(reviewer.token, vendorId, 'approve');
      expect(whOk.status).toBe(201);
      expect(whOk.body.vendor_approved).toBe(true);
      expect(await vendorStatus(vendorId)).toBe('APPROVED');
      // Approval is not activation: the owner activates next.
      await activate(owner.token, vendorId);
      expect(await vendorStatus(vendorId)).toBe('ACTIVE');
    });

    it('warehouse first: the warehouse submission opens the review, its approval keeps it UNDER_REVIEW until the branch is approved', async () => {
      const owner = await account();
      const reviewer = await account('VERIFICATION_REVIEWER');
      const { vendorId, branchIds } = await apply(owner.token, 'HYBRID');

      expect((await submitWarehouse(owner.token, vendorId)).status).toBe(201);
      expect(await vendorStatus(vendorId)).toBe('UNDER_REVIEW');
      const whOk = await decideWarehouse(reviewer.token, vendorId, 'approve');
      expect(whOk.status).toBe(201);
      expect(whOk.body.vendor_approved).toBe(false);
      expect(await vendorStatus(vendorId)).toBe('UNDER_REVIEW');

      await submitBranch(owner.token, vendorId, branchIds[0]).expect(201);
      const branchDetail = await request(http())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchIds[0]}/verification-evidence`,
        )
        .set(auth(reviewer.token))
        .expect(200);
      expect(branchDetail.body.store).toMatchObject({
        warehouse: { state: 'APPROVED' },
        branches: [{ branch_id: branchIds[0], state: 'PENDING_REVIEW' }],
        complete: false,
        next_step: 'REVIEW',
      });
      const branchOk = await decideBranch(
        reviewer.token,
        vendorId,
        branchIds[0],
        'approve',
      );
      expect(branchOk.body.vendor_approved).toBe(true);
      expect(await vendorStatus(vendorId)).toBe('APPROVED');
    });

    it('every physical branch counts: one of two approved plus the warehouse is not enough', async () => {
      const owner = await account();
      const reviewer = await account('VERIFICATION_REVIEWER');
      const { vendorId, branchIds } = await apply(owner.token, 'HYBRID', 2);
      await submitWarehouse(owner.token, vendorId);
      await decideWarehouse(reviewer.token, vendorId, 'approve');
      await submitBranch(owner.token, vendorId, branchIds[0]).expect(201);
      await decideBranch(reviewer.token, vendorId, branchIds[0], 'approve');
      expect(await vendorStatus(vendorId)).toBe('UNDER_REVIEW');
      await submitBranch(owner.token, vendorId, branchIds[1]).expect(201);
      const last = await decideBranch(
        reviewer.token,
        vendorId,
        branchIds[1],
        'approve',
      );
      expect(last.body.vendor_approved).toBe(true);
      expect(await vendorStatus(vendorId)).toBe('APPROVED');
    });

    it('a resubmission request keeps the store UNDER_REVIEW and returns the item to the owner; a new submission can complete it', async () => {
      const owner = await account();
      const reviewer = await account('VERIFICATION_REVIEWER');
      const { vendorId, branchIds } = await apply(owner.token, 'HYBRID');
      await submitWarehouse(owner.token, vendorId);
      await submitBranch(owner.token, vendorId, branchIds[0]).expect(201);

      const again = await decideWarehouse(
        reviewer.token,
        vendorId,
        'request_resubmission',
      );
      expect(again.status).toBe(201);
      expect(await vendorStatus(vendorId)).toBe('UNDER_REVIEW');
      await decideBranch(reviewer.token, vendorId, branchIds[0], 'approve');
      expect(await vendorStatus(vendorId)).toBe('UNDER_REVIEW');
      const branchItems = (await queue(reviewer.token)).filter(
        (i) => i.vendor_id === vendorId,
      );
      expect(branchItems).toEqual([]); // nothing to decide: the owner resubmits

      expect((await submitWarehouse(owner.token, vendorId)).status).toBe(201);
      const done = await decideWarehouse(reviewer.token, vendorId, 'approve');
      expect(done.body.vendor_approved).toBe(true);
      expect(await vendorStatus(vendorId)).toBe('APPROVED');
    });

    it('rejecting the branch closes the application: the warehouse evidence is kept but is no longer decidable', async () => {
      const owner = await account();
      const reviewer = await account('VERIFICATION_REVIEWER');
      const { vendorId, branchIds } = await apply(owner.token, 'HYBRID');
      await submitBranch(owner.token, vendorId, branchIds[0]).expect(201);
      await submitWarehouse(owner.token, vendorId);
      const pendingBefore = (await queue(reviewer.token)).filter(
        (i) => i.vendor_id === vendorId,
      );
      expect(pendingBefore.map((i) => i.kind).sort()).toEqual([
        'BRANCH',
        'WAREHOUSE',
      ]);

      const rejected = await decideBranch(
        reviewer.token,
        vendorId,
        branchIds[0],
        'reject',
      );
      expect(rejected.status).toBe(201);
      expect(await vendorStatus(vendorId)).toBe('REJECTED');

      // Kept as history, untouched...
      const evidence = await prisma.warehouseVerificationEvidence.findMany({
        where: { vendorId },
      });
      expect(evidence.map((e) => e.status)).toEqual(['PENDING']);
      // ...but out of decidable work everywhere.
      expect(
        (await queue(reviewer.token)).filter((i) => i.vendor_id === vendorId),
      ).toEqual([]);
      const read = await getWarehouse(reviewer.token, vendorId);
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe('NO_PENDING_WAREHOUSE_EVIDENCE');
      const decide = await decideWarehouse(reviewer.token, vendorId, 'approve');
      expect(decide.status).toBe(409);
      expect(decide.body.error.code).toBe('VENDOR_NOT_UNDER_REVIEW');
      expect(await vendorStatus(vendorId)).toBe('REJECTED');
    });

    it('rejecting the warehouse closes the application: the pending branch is kept but is no longer decidable', async () => {
      const owner = await account();
      const reviewer = await account('VERIFICATION_REVIEWER');
      const { vendorId, branchIds } = await apply(owner.token, 'HYBRID');
      await submitBranch(owner.token, vendorId, branchIds[0]).expect(201);
      await submitWarehouse(owner.token, vendorId);

      const rejected = await decideWarehouse(
        reviewer.token,
        vendorId,
        'reject',
      );
      expect(rejected.status).toBe(201);
      expect(await vendorStatus(vendorId)).toBe('REJECTED');
      const branch = await prisma.storeBranch.findUniqueOrThrow({
        where: { id: branchIds[0] },
      });
      expect(branch.verificationStatus).toBe('PENDING');
      expect(branch.evidenceRevision).toBe(1);
      expect(
        (await queue(reviewer.token)).filter((i) => i.vendor_id === vendorId),
      ).toEqual([]);
      const decide = await decideBranch(
        reviewer.token,
        vendorId,
        branchIds[0],
        'approve',
      );
      expect(decide.status).toBe(409);
      expect(decide.body.error.code).toBe('VENDOR_NOT_UNDER_REVIEW');
    });

    it('a PHYSICAL store still cannot submit warehouse evidence', async () => {
      const owner = await account();
      const { vendorId } = await apply(owner.token, 'PHYSICAL');
      // (A PHYSICAL store cannot even set a warehouse; the submission
      // itself is refused on the store type.)
      const res = await request(http())
        .post(`/api/v1/vendors/${vendorId}/warehouse/verification-evidence`)
        .set(auth(owner.token))
        .set('Idempotency-Key', unique('wh-evidence'))
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('STORE_NOT_ONLINE_ONLY');
    });
  });

  // ------------------------------------------------------------------
  describe('PHYSICAL - unchanged lifecycle', () => {
    it('APPROVED only once every physical branch is approved; a rejection rejects the application', async () => {
      const owner = await account();
      const reviewer = await account('VERIFICATION_REVIEWER');
      const { vendorId, branchIds } = await apply(owner.token, 'PHYSICAL', 2);
      for (const id of branchIds) {
        await submitBranch(owner.token, vendorId, id).expect(201);
      }
      const first = await decideBranch(
        reviewer.token,
        vendorId,
        branchIds[0],
        'approve',
      );
      expect(first.body.vendor_approved).toBe(false);
      expect(await vendorStatus(vendorId)).toBe('UNDER_REVIEW');
      const second = await decideBranch(
        reviewer.token,
        vendorId,
        branchIds[1],
        'approve',
      );
      expect(second.body.vendor_approved).toBe(true);
      expect(await vendorStatus(vendorId)).toBe('APPROVED');

      const other = await apply(owner.token, 'PHYSICAL', 2);
      for (const id of other.branchIds) {
        await submitBranch(owner.token, other.vendorId, id).expect(201);
      }
      await decideBranch(
        reviewer.token,
        other.vendorId,
        other.branchIds[0],
        'reject',
      );
      expect(await vendorStatus(other.vendorId)).toBe('REJECTED');
    });
  });

  // ------------------------------------------------------------------
  describe('a late branch of an ACTIVE store', () => {
    async function liveStore() {
      const owner = await account();
      const reviewer = await account('VERIFICATION_REVIEWER');
      const { vendorId, branchIds } = await apply(owner.token, 'PHYSICAL');
      await submitBranch(owner.token, vendorId, branchIds[0]).expect(201);
      await decideBranch(reviewer.token, vendorId, branchIds[0], 'approve');
      await activate(owner.token, vendorId);
      const { offerId, variantId } = await sellableSetup(
        vendorId,
        branchIds[0],
      );
      await request(http())
        .post(`/api/v1/vendors/${vendorId}/storefront/publish`)
        .set(auth(owner.token))
        .expect(200);
      const added = await request(http())
        .post(`/api/v1/vendors/${vendorId}/branches`)
        .set(auth(owner.token))
        .set('Idempotency-Key', unique('add-branch'))
        .send({ name: 'الفرع الجديد', lat: 32.0, lng: 35.3 })
        .expect(201);
      const lateId = added.body.id as string;
      await prisma.branchStock.create({
        data: {
          vendorId,
          branchId: lateId,
          offerVariantId: variantId,
          quantity: 3,
        },
      });
      const slug = (
        await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })
      ).slug;
      return {
        owner,
        reviewer,
        vendorId,
        mainId: branchIds[0],
        lateId,
        offerId,
        variantId,
        slug,
      };
    }

    it('its submitted evidence is in the reviewer queue, with the store ACTIVE', async () => {
      const s = await liveStore();
      expect(
        (await queue(s.reviewer.token)).filter(
          (i) => i.vendor_id === s.vendorId,
        ),
      ).toEqual([]); // nothing submitted yet
      await submitBranch(s.owner.token, s.vendorId, s.lateId).expect(201);
      const items = (await queue(s.reviewer.token)).filter(
        (i) => i.vendor_id === s.vendorId,
      );
      expect(items).toEqual([
        expect.objectContaining({
          kind: 'BRANCH',
          item_id: s.lateId,
          vendor_status: 'ACTIVE',
        }),
      ]);
      const detail = await request(http())
        .get(
          `/api/v1/vendors/${s.vendorId}/branches/${s.lateId}/verification-evidence`,
        )
        .set(auth(s.reviewer.token))
        .expect(200);
      expect(detail.body.store).toMatchObject({
        vendor_status: 'ACTIVE',
        next_step: 'REVIEW',
      });
    });

    it('it cannot sell or be picked up until approved; then it can', async () => {
      const s = await liveStore();
      await submitBranch(s.owner.token, s.vendorId, s.lateId).expect(201);
      const before = await productFacts(s.slug, s.offerId, s.variantId);
      expect(before.pickup.branches.map((b) => b.name)).toEqual(['فرع 1']);
      const buyer = await shopper();
      const refused = await reserve(
        buyer,
        s.vendorId,
        s.variantId,
        s.lateId,
        'PICKUP',
      );
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('BRANCH_NOT_AVAILABLE_FOR_ORDERS');

      const ok = await decideBranch(
        s.reviewer.token,
        s.vendorId,
        s.lateId,
        'approve',
      );
      expect(ok.status).toBe(201);
      expect(ok.body.vendor_approved).toBe(false); // no lifecycle change
      expect(await vendorStatus(s.vendorId)).toBe('ACTIVE');
      const after = await productFacts(s.slug, s.offerId, s.variantId);
      expect(after.pickup.branches.map((b) => b.name).sort()).toEqual(
        ['الفرع الجديد', 'فرع 1'].sort(),
      );
    });

    it('rejecting or returning it touches only it: the store stays ACTIVE and published, the approved branch keeps selling', async () => {
      const s = await liveStore();
      await submitBranch(s.owner.token, s.vendorId, s.lateId).expect(201);
      const back = await decideBranch(
        s.reviewer.token,
        s.vendorId,
        s.lateId,
        'request_resubmission',
      );
      expect(back.status).toBe(201);
      await submitBranch(s.owner.token, s.vendorId, s.lateId).expect(201);
      const rejected = await decideBranch(
        s.reviewer.token,
        s.vendorId,
        s.lateId,
        'reject',
      );
      expect(rejected.status).toBe(201);

      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: s.vendorId },
      });
      expect(vendor.status).toBe('ACTIVE');
      expect(vendor.storefrontPublished).toBe(true);
      const main = await prisma.storeBranch.findUniqueOrThrow({
        where: { id: s.mainId },
      });
      expect(main.verificationStatus).toBe('APPROVED');
      const facts = await productFacts(s.slug, s.offerId, s.variantId);
      expect(facts.pickup.branches.map((b) => b.name)).toEqual(['فرع 1']);
      const buyer = await shopper();
      const res = await reserve(
        buyer,
        s.vendorId,
        s.variantId,
        s.mainId,
        'PICKUP',
      );
      expect(res.status).toBe(201);
    });
  });

  // ------------------------------------------------------------------
  describe('re-publishing an ACTIVE store needs a verified path', () => {
    async function activeStore(
      storeType: 'PHYSICAL' | 'HYBRID',
      branchStatuses: ('APPROVED' | 'PENDING')[],
      warehouse: 'APPROVED' | 'PENDING' | null,
    ) {
      const owner = await account();
      const vendor = await prisma.vendor.create({
        data: {
          slug: unique('p2a').toLowerCase(),
          legalName: unique('Legal'),
          status: 'ACTIVE',
          subscriptionStatus: 'ACTIVE',
          storeType,
          storefrontPublished: false,
          whatsappUrl: 'https://wa.me/970599000001',
        },
      });
      await prisma.vendorUser.create({
        data: { userId: owner.id, vendorId: vendor.id, role: 'OWNER' },
      });
      await prisma.vendorApplicableCategory.create({
        data: { vendorId: vendor.id, category: 'WOMEN' },
      });
      for (const [i, verificationStatus] of branchStatuses.entries()) {
        await prisma.storeBranch.create({
          data: {
            vendorId: vendor.id,
            name: `فرع ${i}`,
            isPhysical: true,
            verificationStatus,
          },
        });
      }
      if (warehouse) {
        const w = await prisma.warehouse.create({
          data: { vendorId: vendor.id, lat: 31.9, lng: 35.2, addressNote: 'x' },
        });
        await prisma.warehouseVerificationEvidence.create({
          data: {
            vendorId: vendor.id,
            warehouseId: w.id,
            lat: 31.9,
            lng: 35.2,
            addressNote: 'x',
            status: warehouse,
          },
        });
      }
      const publish = () =>
        request(http())
          .post(`/api/v1/vendors/${vendor.id}/storefront/publish`)
          .set(auth(owner.token));
      return { publish };
    }

    it('PHYSICAL: refused with no approved branch; a pending late branch neither blocks nor counts', async () => {
      const none = await activeStore('PHYSICAL', ['PENDING'], null);
      const refused = await none.publish();
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('STOREFRONT_VERIFICATION_REQUIRED');

      const mixed = await activeStore(
        'PHYSICAL',
        ['APPROVED', 'PENDING'],
        null,
      );
      expect((await mixed.publish()).status).toBe(200);
    });

    it('HYBRID: also needs the latest warehouse evidence approved', async () => {
      const noWarehouse = await activeStore('HYBRID', ['APPROVED'], 'PENDING');
      const refused = await noWarehouse.publish();
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('STOREFRONT_VERIFICATION_REQUIRED');

      const both = await activeStore('HYBRID', ['APPROVED'], 'APPROVED');
      expect((await both.publish()).status).toBe(200);
    });
  });
});
