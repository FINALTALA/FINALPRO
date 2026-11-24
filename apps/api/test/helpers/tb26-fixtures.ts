import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { SessionService } from '../../src/auth/session.service';
import { CURRENT_PLATFORM_TERMS_VERSION } from '../../src/checkout/checkout.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { uniqueTestPhone } from './test-phone';

/**
 * TB-26/27/28 fixtures: signed-in accounts, stores with branches, a
 * classified product, a real cart -> reserve -> confirm purchase, and
 * entering a workspace. Every write goes through the app or straight
 * into the test's own database - never anything shared.
 */
export function tb26Fixtures(getApp: () => INestApplication) {
  let counter = 0;
  const unique = (label: string) => {
    counter += 1;
    // the process id too: two Jest workers can start a suite in the same millisecond
    return `${label}-${Date.now()}-${process.pid}-${counter}`;
  };
  const prisma = () => getApp().get(PrismaService);
  const http = () => request(getApp().getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function account(platformRole?: 'PLATFORM_ADMIN') {
    const phone = uniqueTestPhone();
    const user = await prisma().user.create({
      data: {
        phone,
        passwordHash: 'x',
        phoneVerifiedAt: new Date(),
        platformRole: platformRole ?? null,
      },
    });
    const profile = await prisma().customerProfile.create({
      data: { userId: user.id, displayName: 'TB26 Customer' },
    });
    const token = await newSession(user.id);
    return { token, userId: user.id, customerId: profile.id, phone };
  }
  type Account = Awaited<ReturnType<typeof account>>;

  /** Another session of the same user (a second sign-in). */
  async function newSession(userId: string): Promise<string> {
    const user = await prisma().user.findUniqueOrThrow({
      where: { id: userId },
    });
    return getApp().get(SessionService).create({
      userId,
      phone: user.phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
  }

  /** A published store with two approved physical branches (A, B) and an
   * owner. */
  async function store(owner?: Account) {
    const o = owner ?? (await account());
    const vendor = await prisma().vendor.create({
      data: {
        slug: unique('tb26-store').toLowerCase(),
        legalName: unique('L'),
        displayName: 'متجر',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    await prisma().vendorSubscription.create({
      data: {
        vendorId: vendor.id,
        status: 'ACTIVE',
        periodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });
    const branch = (name: string) =>
      prisma().storeBranch.create({
        data: {
          vendorId: vendor.id,
          name: unique(name),
          isPhysical: true,
          verificationStatus: 'APPROVED',
        },
      });
    const a = await branch('A');
    const b = await branch('B');
    await member(vendor.id, o, 'OWNER', null);
    return { vendorId: vendor.id, branchA: a.id, branchB: b.id, owner: o };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  async function member(
    vendorId: string,
    who: Account,
    role: 'OWNER' | 'BRANCH_EMPLOYEE',
    branchId: string | null,
    status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
  ) {
    await prisma().vendorUser.create({
      data: { userId: who.userId, vendorId, role, branchId, status },
    });
    return who;
  }

  /** A classified ACTIVE offer with stock in branch A; returns a variant
   * id. */
  async function offer(s: Store, qty = 20) {
    const brand = await prisma().brand.create({
      data: { name: unique('Brand'), normalizedName: unique('b') },
    });
    const category = await prisma().category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('C') },
    });
    const product = await prisma().canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('M'),
        canonicalNameAr: 'فستان',
        canonicalNameEn: 'Dress',
        status: 'PUBLISHED',
      },
    });
    const o = await prisma().vendorOffer.create({
      data: {
        vendorId: s.vendorId,
        titleAr: 'فستان',
        titleEn: 'Dress',
        status: 'DRAFT',
        taxonomyVersion: 1,
        requiresTaxonomy: true,
      },
    });
    await prisma().vendorOfferAudience.create({
      data: { vendorId: s.vendorId, vendorOfferId: o.id, audience: 'WOMEN' },
    });
    await prisma().vendorOfferCategory.create({
      data: {
        vendorId: s.vendorId,
        vendorOfferId: o.id,
        categoryCode: 'DRESSES_WOMEN',
      },
    });
    const cv = await prisma().canonicalProductVariant.create({
      data: {
        canonicalProductId: product.id,
        structuralAttributes: { n: unique('v') },
        platformProductBarcode: unique('pb'),
      },
    });
    const v = await prisma().offerVariant.create({
      data: {
        vendorId: s.vendorId,
        vendorOfferId: o.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 100,
        isCombination: true,
        colorCode: 'BLACK',
        sizeCode: 'M',
        canonicalVariantId: cv.id,
      },
    });
    await prisma().branchStock.create({
      data: {
        vendorId: s.vendorId,
        branchId: s.branchA,
        offerVariantId: v.id,
        quantity: qty,
      },
    });
    await prisma().vendorOffer.update({
      where: { id: o.id },
      data: { status: 'ACTIVE' },
    });
    return v.id;
  }

  /** Enters a workspace; returns the token. */
  async function enter(
    who: { token: string },
    body: { type: 'vendor'; vendor_id: string } | { type: 'platform' },
  ): Promise<string> {
    const res = await http()
      .post('/api/v1/me/workspace-sessions')
      .set(bearer(who.token))
      .send(body)
      .expect(201);
    return res.body.workspace_token as string;
  }

  /** Headers for a store-staff call: the session, plus the workspace token
   * when one is given. */
  const staffHeaders = (who: { token: string }, workspace?: string) => ({
    ...bearer(who.token),
    ...(workspace ? { 'X-Workspace-Token': workspace } : {}),
    'Idempotency-Key': unique('staff'),
  });

  const staff = (
    s: Store,
    who: { token: string },
    branchOrderId: string,
    action: string,
    body: object = {},
    workspace?: string,
  ) =>
    http()
      .post(
        `/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/orders/${branchOrderId}/${action}`,
      )
      .set(staffHeaders(who, workspace))
      .send(body);

  /** Ticks / un-ticks one prep checklist item of a branch-A order. */
  const prepCheck = (
    s: Store,
    who: { token: string },
    branchOrderId: string,
    item: string,
    done = true,
    workspace?: string,
  ) =>
    http()
      .patch(
        `/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/orders/${branchOrderId}/prep-checklist/${item}`,
      )
      .set(staffHeaders(who, workspace))
      .send({ done });

  /** «إدارة طلبات الفرع v2» phase 2: the two mandatory items, then «جاهز» -
   * through the real endpoints, as `who`. */
  async function prepareAndReady(
    s: Store,
    who: { token: string },
    branchOrderId: string,
    workspace?: string,
  ) {
    for (const item of ['ITEMS_VERIFIED', 'PACKED']) {
      await prepCheck(s, who, branchOrderId, item, true, workspace).expect(200);
    }
    await staff(s, who, branchOrderId, 'mark-ready', {}, workspace).expect(201);
  }

  /** Buys one unit for pickup from branch A as `buyer` (a SHOPPING call -
   * the session alone). `complete` hands it over (staff `by`, with their
   * workspace token when given). */
  async function buy(
    buyer: Account,
    s: Store,
    variantId: string,
    complete?: { by: { token: string }; workspace?: string },
  ) {
    const cart = await http()
      .post('/api/v1/cart/items')
      .set(bearer(buyer.token))
      .set('Idempotency-Key', unique('cart'))
      .send({ vendor_id: s.vendorId, offer_variant_id: variantId, quantity: 1 })
      .expect(201);
    const reserved = await http()
      .post('/api/v1/checkout/reserve')
      .set(bearer(buyer.token))
      .set('Idempotency-Key', unique('reserve'))
      .send({
        terms_accepted: true,
        terms_version: CURRENT_PLATFORM_TERMS_VERSION,
        groups: [
          {
            cart_item_ids: [cart.body.id],
            branch_id: s.branchA,
            fulfilment_method: 'PICKUP',
            payment_method: 'COD',
          },
        ],
      })
      .expect(201);
    const confirmed = await http()
      .post('/api/v1/checkout/confirm')
      .set(bearer(buyer.token))
      .set('Idempotency-Key', unique('confirm'))
      .send({ reservation_id: reserved.body.reservation_id })
      .expect(201);
    const order = confirmed.body.branch_orders[0];
    if (complete) {
      await staff(
        s,
        complete.by,
        order.id,
        'start-preparation',
        {},
        complete.workspace,
      ).expect(201);
      // «إدارة طلبات الفرع v2» phase 2: the mandatory checklist and «جاهز»
      // (the real endpoints) before the hand-over
      await prepareAndReady(s, complete.by, order.id, complete.workspace);
      await staff(
        s,
        complete.by,
        order.id,
        'pickup-handover',
        { pickup_code: order.pickup_code },
        complete.workspace,
      ).expect(201);
    }
    const item = await prisma().branchOrderItem.findFirstOrThrow({
      where: { branchOrderId: order.id },
    });
    return { branchOrderId: order.id as string, itemId: item.id };
  }

  return {
    unique,
    http,
    bearer,
    account,
    newSession,
    store,
    member,
    offer,
    enter,
    staffHeaders,
    staff,
    prepCheck,
    prepareAndReady,
    buy,
  };
}
