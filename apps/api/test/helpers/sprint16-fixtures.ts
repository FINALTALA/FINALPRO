import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { SmsService } from '../../src/auth/sms.service';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createUniquePhone, PhoneLane } from './e2e-phone-lanes';

/** Test double for the OPEN-004 SMS fallback - captures codes. */
export class FakeSmsService {
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

export interface Sprint16Ctx {
  app: INestApplication;
  prisma: PrismaService;
  fakeSms: FakeSmsService;
}

/**
 * Boots the full app for a Sprint 16 spec. The per-route @Throttle limits
 * (e.g. 5 OTP requests / 60s) are deliberately neutralised here: these
 * specs create many users and invites per test, and the throttling
 * behaviour itself is covered by the auth specs, not by these.
 */
export async function bootApp(ctx: Sprint16Ctx): Promise<void> {
  ctx.fakeSms = new FakeSmsService();
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(SmsService)
    .useValue(ctx.fakeSms)
    .overrideProvider(ThrottlerStorage)
    .useValue({
      increment: () =>
        Promise.resolve({
          totalHits: 1,
          timeToExpire: 60,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
    })
    .compile();
  ctx.app = moduleFixture.createNestApplication();
  ctx.app.setGlobalPrefix('api/v1');
  ctx.app.useGlobalFilters(new HttpExceptionFilter());
  ctx.app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  await ctx.app.init();
  ctx.prisma = ctx.app.get(PrismaService);
}

export type PlatformRoleName = 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER';

// Review-round fix (a further round, after the crypto.randomInt() one
// described below stopped being accepted as "determinism" - it only
// reduces collision probability, it doesn't eliminate it): each of
// this helper's 3 calling spec files passes its own fixed, disjoint
// PhoneLane (see ./e2e-phone-lanes.ts). The generator is built lazily,
// on the FIRST createFixtures() call in a given spec file's own Jest
// module registry, and cached at module scope - createFixtures() runs
// fresh in every beforeEach (a new app per TEST), so caching is what
// makes the underlying counter keep incrementing across a whole
// file's tests instead of restarting (and colliding with itself) on
// every single one; every call from the same file passes the same
// lane, so the cached generator is always the right one to reuse.
let cachedUniquePhone: (() => string) | null = null;

/**
 * Shared helpers for the Sprint 16 e2e specs. `ctx` is mutated by each
 * spec's beforeEach (a new app per test), so every helper reads
 * `ctx.app` lazily.
 *
 * `phoneLane` is this calling spec file's own fixed, disjoint slice of
 * the +97056 phone-number space (project convention - never
 * +97057/58) - see ./e2e-phone-lanes.ts.
 */
export function createFixtures(ctx: Sprint16Ctx, phoneLane: PhoneLane) {
  let counter = 0;

  const http = () => ctx.app.getHttpServer();

  if (!cachedUniquePhone) {
    cachedUniquePhone = createUniquePhone(phoneLane, '56');
  }
  const uniquePhone = cachedUniquePhone;

  function unique(label: string): string {
    counter += 1;
    return `${label}-${Date.now()}-${counter}`;
  }

  async function signup(phone: string, password: string): Promise<string> {
    await request(http())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'signup' })
      .expect(202);
    const code = ctx.fakeSms.lastCodeFor(phone);
    const verify = await request(http())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', `verify-${phone}`)
      .send({ phone, otp_code: code, purpose: 'signup' })
      .expect(200);
    const register = await request(http())
      .post('/api/v1/auth/register')
      .send({ phone, password, verification_token: verify.body.session_token })
      .expect(201);
    return register.body.session_token as string;
  }

  /** A user with a platform role, plus the ids the conflict tests need. */
  async function platformUser(role: PlatformRoleName) {
    const phone = uniquePhone();
    const token = await signup(phone, 'a-strong-password');
    const user = await ctx.prisma.user.update({
      where: { phone },
      data: { platformRole: role },
    });
    return { token, phone, userId: user.id };
  }

  async function createPhysicalVendor(
    ownerToken: string,
    branchCount = 1,
    storeType: 'PHYSICAL' | 'HYBRID' = 'PHYSICAL',
  ): Promise<{ vendorId: string; branchIds: string[] }> {
    const res = await request(http())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        store_type: storeType,
        branches: Array.from({ length: branchCount }, (_, i) => ({
          name: `Branch ${i + 1}`,
          is_physical: true,
        })),
        applicable_categories: ['WOMEN'],
      })
      .expect(201);
    return {
      vendorId: res.body.id as string,
      branchIds: (res.body.branches as { id: string }[]).map((b) => b.id),
    };
  }

  async function createOnlineOnlyVendor(
    ownerToken: string,
  ): Promise<{ vendorId: string }> {
    const res = await request(http())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('OnlineVendor'),
        store_type: 'ONLINE_ONLY',
        branches: [{ name: 'Warehouse branch', is_physical: false }],
        applicable_categories: ['WOMEN'],
      })
      .expect(201);
    return { vendorId: res.body.id as string };
  }

  async function setWarehouse(
    ownerToken: string,
    vendorId: string,
    overrides: Partial<{ lat: number; lng: number; address_note: string }> = {},
  ) {
    await request(http())
      .put(`/api/v1/vendors/${vendorId}/warehouse`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        lat: 31.9,
        lng: 35.2,
        address_note: 'Industrial zone, unit 4',
        ...overrides,
      })
      .expect(200);
  }

  function submitBranchEvidence(
    ownerToken: string,
    vendorId: string,
    branchId: string,
    overrides: Partial<{
      lat: number;
      lng: number;
      verification_photo_url: string;
    }> = {},
  ) {
    return request(http())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-evidence`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('evidence'))
      .send({
        lat: 32.22,
        lng: 35.26,
        verification_photo_url: 'https://example.com/photo.jpg',
        ...overrides,
      });
  }

  function decideBranch(
    token: string,
    vendorId: string,
    branchId: string,
    body: Record<string, unknown>,
    key = unique('decision'),
  ) {
    return request(http())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-decision`,
      )
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body);
  }

  function getBranchEvidence(
    token: string,
    vendorId: string,
    branchId: string,
  ) {
    return request(http())
      .get(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-evidence`,
      )
      .set('Authorization', `Bearer ${token}`);
  }

  function submitWarehouseEvidence(ownerToken: string, vendorId: string) {
    return request(http())
      .post(`/api/v1/vendors/${vendorId}/warehouse/verification-evidence`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('wh-evidence'))
      .send({});
  }

  function getWarehouseEvidence(token: string, vendorId: string) {
    return request(http())
      .get(`/api/v1/vendors/${vendorId}/warehouse/verification-evidence`)
      .set('Authorization', `Bearer ${token}`);
  }

  function decideWarehouse(
    token: string,
    vendorId: string,
    body: Record<string, unknown>,
    key = unique('wh-decision'),
  ) {
    return request(http())
      .post(`/api/v1/vendors/${vendorId}/warehouse/verification-decision`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body);
  }

  function suspend(
    token: string,
    vendorId: string,
    body: Record<string, unknown> = {
      reason_code: 'POLICY_VIOLATION',
      reason: 'Repeated policy violations reported by customers',
    },
    key = unique('suspend'),
  ) {
    return request(http())
      .post(`/api/v1/admin/vendors/${vendorId}/suspend`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body);
  }

  function reactivate(
    token: string,
    vendorId: string,
    body: Record<string, unknown> = {
      reason: 'Issues resolved after review with the owner',
    },
    key = unique('reactivate'),
  ) {
    return request(http())
      .post(`/api/v1/admin/vendors/${vendorId}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body);
  }

  /** Straight to an ACTIVE, published, subscribed vendor (DB-level). */
  async function makeVendorActive(vendorId: string) {
    await ctx.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
  }

  /** The real path: evidence -> approve -> subscription -> ACTIVE. */
  async function activateViaApi(
    ownerToken: string,
    reviewerToken: string,
    vendorId: string,
    branchId: string,
  ) {
    await submitBranchEvidence(ownerToken, vendorId, branchId).expect(201);
    await decideBranch(reviewerToken, vendorId, branchId, {
      decision: 'approve',
      evidence_revision: 1,
    }).expect(201);
    await request(http())
      .post(`/api/v1/vendors/${vendorId}/subscription`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('sub'))
      .send({})
      .expect(201);
  }

  /** Owner invites `phone` and the invitee gets a verified OTP token. */
  async function prepareStaffInvite(
    ownerToken: string,
    vendorId: string,
    branchId: string,
    phone: string,
  ): Promise<{ phone: string; verificationToken: string }> {
    await request(http())
      .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('invite'))
      .send({ phone })
      .expect(201);
    await request(http())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'staff_invite' })
      .expect(202);
    const code = ctx.fakeSms.lastCodeFor(phone);
    const verify = await request(http())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', unique('verify'))
      .send({ phone, otp_code: code, purpose: 'staff_invite' })
      .expect(200);
    return { phone, verificationToken: verify.body.session_token as string };
  }

  function acceptStaffInvite(phone: string, verificationToken: string) {
    return request(http())
      .post('/api/v1/auth/staff-invites/accept')
      .set('Idempotency-Key', unique('accept'))
      .send({ phone, verification_token: verificationToken });
  }

  // ---- checkout helpers (mirrors sprint10's, for the L-23 checks) ----

  async function createOfferWithStock(
    vendorId: string,
    branchId: string,
    price: number,
    quantity: number,
  ): Promise<string> {
    const offer = await ctx.prisma.vendorOffer.create({
      data: { vendorId, titleAr: 'م', titleEn: 'P', status: 'ACTIVE' },
    });
    const variant = await ctx.prisma.offerVariant.create({
      data: {
        vendorId,
        vendorOfferId: offer.id,
        sellerSku: unique('sku'),
        basePrice: price,
        storeInventoryBarcode: unique('barcode'),
      },
    });
    await ctx.prisma.branchStock.create({
      data: { vendorId, branchId, offerVariantId: variant.id, quantity },
    });
    return variant.id;
  }

  async function addToCart(
    token: string,
    vendorId: string,
    offerVariantId: string,
    quantity: number,
  ): Promise<string> {
    const res = await request(http())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('cart-add'))
      .send({ vendor_id: vendorId, offer_variant_id: offerVariantId, quantity })
      .expect(201);
    return res.body.id as string;
  }

  function reserve(token: string, branchId: string, cartItemIds: string[]) {
    return request(http())
      .post('/api/v1/checkout/reserve')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('reserve'))
      .send({
        groups: [
          {
            cart_item_ids: cartItemIds,
            branch_id: branchId,
            fulfilment_method: 'PICKUP',
            payment_method: 'COD',
          },
        ],
      });
  }

  function confirm(token: string, reservationId: string) {
    return request(http())
      .post('/api/v1/checkout/confirm')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', unique('confirm'))
      .send({ reservation_id: reservationId });
  }

  /** A PLACED BranchOrder + item written directly (in-flight order). */
  async function seedInFlightOrder(
    vendorId: string,
    branchId: string,
    variantId: string,
  ): Promise<string> {
    const customer = await ctx.prisma.customerProfile.create({
      data: { user: { create: { phone: uniquePhone(), passwordHash: 'x' } } },
    });
    const customerOrder = await ctx.prisma.customerOrder.create({
      data: { customerId: customer.id },
    });
    const branchOrder = await ctx.prisma.branchOrder.create({
      data: {
        customerOrderId: customerOrder.id,
        vendorId,
        branchId,
        fulfilmentMethod: 'DELIVERY',
        paymentMethod: 'COD',
        subtotal: 20,
        deliveryFee: 5,
        total: 25,
      },
    });
    await ctx.prisma.branchOrderItem.create({
      data: {
        vendorId,
        branchOrderId: branchOrder.id,
        offerVariantId: variantId,
        quantity: 2,
        unitPrice: 10,
      },
    });
    return branchOrder.id;
  }

  return {
    uniquePhone,
    unique,
    signup,
    platformUser,
    createPhysicalVendor,
    createOnlineOnlyVendor,
    setWarehouse,
    submitBranchEvidence,
    decideBranch,
    getBranchEvidence,
    submitWarehouseEvidence,
    getWarehouseEvidence,
    decideWarehouse,
    suspend,
    reactivate,
    makeVendorActive,
    activateViaApi,
    prepareStaffInvite,
    acceptStaffInvite,
    createOfferWithStock,
    addToCart,
    reserve,
    confirm,
    seedInFlightOrder,
  };
}
