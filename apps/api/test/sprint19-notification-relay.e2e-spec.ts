import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { FulfilmentSweepService } from './../src/orders/fulfilment-sweep.service';
import { DiscountActivationSweepService } from './../src/offers/discount-activation-sweep.service';
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

const uniquePhone = createUniquePhone('sprint19-notification-relay', '56');
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 19 - notification relay, sweeps, API (e2e)', () => {
  let app: INestApplication | undefined;
  let fakeSms: FakeSmsService;
  let prisma: PrismaService;
  let relay: OutboxRelayService;
  let fulfilmentSweep: FulfilmentSweepService;
  let discountSweep: DiscountActivationSweepService;

  beforeEach(async () => {
    fakeSms = new FakeSmsService();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SmsService)
      .useValue(fakeSms)
      // Several of this file's own tests sign up many users in quick
      // succession (a follower set, an owner + reviewer + customer in
      // one test) - well past the real 5/60s OTP throttle. Same
      // override sprint16-fixtures.ts's own bootApp() already
      // established for exactly this reason.
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

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    relay = app.get(OutboxRelayService);
    fulfilmentSweep = app.get(FulfilmentSweepService);
    discountSweep = app.get(DiscountActivationSweepService);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  async function signup(phone: string, password: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'signup' })
      .expect(202);
    const code = fakeSms.lastCodeFor(phone);
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', unique('verify'))
      .send({ phone, otp_code: code, purpose: 'signup' })
      .expect(200);
    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ phone, password, verification_token: verify.body.session_token })
      .expect(201);
    return register.body.session_token as string;
  }

  async function signupWithPlatformRole(
    role: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER',
  ): Promise<{ token: string; phone: string }> {
    const phone = uniquePhone();
    const token = await signup(phone, 'reviewer-password');
    await prisma.user.update({
      where: { phone },
      data: { platformRole: role },
    });
    return { token, phone };
  }

  // Minimal active vendor + one APPROVED physical branch, via the real
  // evidence/decision/subscription flow - same pattern every prior
  // sprint's own test files already use.
  async function setupActiveVendor(): Promise<{
    owner: string;
    ownerPhone: string;
    vendorId: string;
    branchId: string;
  }> {
    const ownerPhone = uniquePhone();
    const owner = await signup(ownerPhone, 'a-strong-password');
    const vendorRes = await request(app.getHttpServer())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('S19 Vendor'),
        store_type: 'PHYSICAL',
        branches: [{ name: 'Main', is_physical: true }],
        applicable_categories: ['WOMEN'],
      })
      .expect(201);
    const vendorId = vendorRes.body.id as string;
    const branchId = vendorRes.body.branches[0].id as string;

    const { token: reviewerToken } = await signupWithPlatformRole(
      'VERIFICATION_REVIEWER',
    );
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-evidence`,
      )
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('evidence'))
      .send({
        lat: 32.22,
        lng: 35.26,
        verification_photo_url: 'https://example.com/p.jpg',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchId}/verification-decision`,
      )
      .set('Authorization', `Bearer ${reviewerToken}`)
      .set('Idempotency-Key', unique('decision'))
      .send({ decision: 'approve', evidence_revision: 1 })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/subscription`)
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('sub'))
      .send({})
      .expect(201);
    // Cart-add/checkout purchase-eligibility also requires
    // storefrontPublished (purchase-eligibility.util.ts) - set
    // directly, the same established test-fixture shortcut every
    // prior sprint's own checkout-adjacent test file already uses
    // (e.g. sprint10-checkout-payment-pickup's makeVendorEligible()),
    // since publishing for real is an unrelated storefront-PATCH flow.
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { storefrontPublished: true },
    });

    return { owner, ownerPhone, vendorId, branchId };
  }

  async function createAcceptedEmployee(
    owner: string,
    vendorId: string,
    branchId: string,
  ): Promise<{ phone: string; token: string; vendorUserId: string }> {
    const phone = uniquePhone();
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('invite'))
      .send({ phone })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'staff_invite' })
      .expect(202);
    const code = fakeSms.lastCodeFor(phone);
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', unique('verify'))
      .send({ phone, otp_code: code, purpose: 'staff_invite' })
      .expect(200);
    const accept = await request(app.getHttpServer())
      .post('/api/v1/auth/staff-invites/accept')
      .set('Idempotency-Key', unique('accept'))
      .send({
        phone,
        verification_token: verify.body.session_token,
        password: 'employee-password',
      })
      .expect(200);
    const vendorUser = await prisma.vendorUser.findFirstOrThrow({
      where: { vendorId, user: { phone } },
    });
    return {
      phone,
      token: accept.body.session_token as string,
      vendorUserId: vendorUser.id,
    };
  }

  // This file's own tests share ONE live database with every other
  // e2e spec file running concurrently in the full regression suite
  // (the project's established convention - no per-test database).
  // dispatchOnce() claims the GLOBALLY oldest claimable row, not "the
  // row this test cares about" - so a single call, or even a fixed
  // small drain, can legitimately spend itself on another file's
  // unrelated outbox rows under real parallel load. A generous cap
  // (not "one call = my row") is what makes this robust rather than
  // flaky under that load, not a sign anything is actually broken.
  async function drainRelay(maxIterations = 2000): Promise<number> {
    let n = 0;
    while (n < maxIterations && (await relay.dispatchOnce())) n += 1;
    return n;
  }

  /** Keeps claiming/processing (anyone's) outbox rows until `check()`
   * reports the SPECIFIC row/condition this test cares about has
   * changed - the only way to deterministically observe a single
   * dispatchOnce() claim-and-process cycle's effect on a known row
   * while other parallel test files keep adding unrelated noise to
   * the same claim queue. As long as there is still ANY claimable row
   * anywhere, iterate immediately with no delay (bounded generously,
   * since draining real cross-file noise is fast); only once the
   * queue goes genuinely empty does a short, separately-bounded
   * wait-and-retry phase kick in (another file's request committing a
   * fresh row is the only thing that phase is for) - capped low so a
   * real bug (the row this test created was never actually enqueued)
   * fails fast instead of silently eating the whole test timeout. */
  async function dispatchUntil(
    check: () => Promise<boolean>,
    maxBusyIterations = 5000,
    maxEmptyRetries = 25,
  ): Promise<void> {
    let emptyRetries = 0;
    for (let i = 0; i < maxBusyIterations; i++) {
      if (await check()) return;
      const didWork = await relay.dispatchOnce();
      if (!didWork) {
        emptyRetries += 1;
        if (emptyRetries > maxEmptyRetries) {
          throw new Error(
            'dispatchUntil: queue is empty and the condition never became true',
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error(
      'dispatchUntil: condition never became true within maxBusyIterations',
    );
  }

  // ============================================================
  // 1. Claim/lease: crashed worker, reclaim, no double-delivery
  // ============================================================
  describe('claim/lease state machine', () => {
    it('a row stuck in PROCESSING past its lease is reclaimed by a later dispatchOnce() and completed exactly once', async () => {
      const { owner, vendorId, branchId } = await setupActiveVendor();
      void branchId;
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const suspendRes = await request(app.getHttpServer())
        .post(`/api/v1/admin/vendors/${vendorId}/suspend`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('Idempotency-Key', unique('suspend'))
        .send({
          reason_code: 'POLICY_VIOLATION',
          reason: 'Policy violation reported by customers',
        })
        .expect(201);
      void suspendRes;

      const outboxRow = await prisma.outboxEvent.findFirstOrThrow({
        where: {
          eventType: 'vendor.suspended',
          payload: { path: ['vendor_id'], equals: vendorId },
        },
      });
      // Simulate a worker that claimed this row and then crashed before
      // ever reaching the processing transaction: PROCESSING, a real
      // lockToken, but lockedAt far enough in the past to be past the
      // 2-minute lease.
      await prisma.$executeRaw`
        UPDATE outbox_events
        SET status = 'PROCESSING', "lockedAt" = now() - interval '5 minutes',
            "lockToken" = 'zombie-token', "attemptCount" = 1
        WHERE id = ${outboxRow.id}
      `;

      await dispatchUntil(async () => {
        const row = await prisma.outboxEvent.findUniqueOrThrow({
          where: { id: outboxRow.id },
        });
        return row.status !== 'PROCESSING' || row.lockToken !== 'zombie-token';
      });

      const after = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: outboxRow.id },
      });
      expect(after.status).toBe('PUBLISHED');
      expect(after.attemptCount).toBe(2); // bumped exactly once at the reclaim

      const notifications = await prisma.notification.findMany({
        where: { outboxEventId: outboxRow.id },
      });
      expect(notifications).toHaveLength(1);
      void owner;
    });

    it('a zombie worker that wakes up after its lease expired and was reclaimed by someone else creates no Notification and writes nothing', async () => {
      const { vendorId } = await setupActiveVendor();
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      await request(app.getHttpServer())
        .post(`/api/v1/admin/vendors/${vendorId}/suspend`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('Idempotency-Key', unique('suspend'))
        .send({
          reason_code: 'POLICY_VIOLATION',
          reason: 'Policy violation reported by customers',
        })
        .expect(201);

      const outboxRow = await prisma.outboxEvent.findFirstOrThrow({
        where: {
          eventType: 'vendor.suspended',
          payload: { path: ['vendor_id'], equals: vendorId },
        },
      });
      // A genuine claim (zombie-owned), already reclaimed/published by
      // someone else since - simulate by setting PUBLISHED directly
      // with a DIFFERENT lockToken than the one the zombie still holds.
      await prisma.$executeRaw`
        UPDATE outbox_events SET status = 'PUBLISHED', "lockToken" = 'someone-elses-token' WHERE id = ${outboxRow.id}
      `;
      // This exact row is already PUBLISHED - it matches neither claim
      // condition (not PENDING/FAILED, not a stuck PROCESSING row), so
      // no dispatchOnce() call, no matter what else it finds to do
      // elsewhere, can ever touch it again. Drain everything claimable
      // (there may be other unrelated rows from other tests sharing
      // this same database) and assert THIS row specifically.
      await drainRelay();
      const afterRow = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: outboxRow.id },
      });
      expect(afterRow.status).toBe('PUBLISHED');
      expect(afterRow.lockToken).toBe('someone-elses-token');
      const notifications = await prisma.notification.findMany({
        where: { outboxEventId: outboxRow.id },
      });
      expect(notifications).toHaveLength(0);
    });
  });

  // ============================================================
  // 2. Retry/backoff -> DEAD_LETTER, admin visibility
  // ============================================================
  describe('retry, backoff, dead-letter', () => {
    it('a forced failure increments attemptCount only once per claim, backs off availableAt, and eventually reaches DEAD_LETTER after MAX_ATTEMPTS', async () => {
      const { vendorId } = await setupActiveVendor();
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      await request(app.getHttpServer())
        .post(`/api/v1/admin/vendors/${vendorId}/suspend`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('Idempotency-Key', unique('suspend'))
        .send({
          reason_code: 'POLICY_VIOLATION',
          reason: 'Policy violation reported by customers',
        })
        .expect(201);
      const outboxRow = await prisma.outboxEvent.findFirstOrThrow({
        where: {
          eventType: 'vendor.suspended',
          payload: { path: ['vendor_id'], equals: vendorId },
        },
      });
      // Corrupt the recipient so dispatch always throws, deterministically.
      await prisma.$executeRaw`
        UPDATE outbox_events SET payload = payload - 'recipient_user_id' WHERE id = ${outboxRow.id}
      `;

      for (let attempt = 1; attempt <= 5; attempt++) {
        await prisma.$executeRaw`UPDATE outbox_events SET "availableAt" = now() WHERE id = ${outboxRow.id}`;
        await dispatchUntil(async () => {
          const row = await prisma.outboxEvent.findUniqueOrThrow({
            where: { id: outboxRow.id },
          });
          return row.attemptCount >= attempt;
        });
        const row = await prisma.outboxEvent.findUniqueOrThrow({
          where: { id: outboxRow.id },
        });
        expect(row.attemptCount).toBe(attempt);
        if (attempt < 5) {
          expect(row.status).toBe('FAILED');
          expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
        } else {
          expect(row.status).toBe('DEAD_LETTER');
        }
      }
    });

    it('a DEAD_LETTER row is visible to a PLATFORM_ADMIN via the dead-letter endpoint and hidden from a non-admin', async () => {
      const { vendorId } = await setupActiveVendor();
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      await request(app.getHttpServer())
        .post(`/api/v1/admin/vendors/${vendorId}/suspend`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('Idempotency-Key', unique('suspend'))
        .send({
          reason_code: 'POLICY_VIOLATION',
          reason: 'Policy violation reported by customers',
        })
        .expect(201);
      const outboxRow = await prisma.outboxEvent.findFirstOrThrow({
        where: {
          eventType: 'vendor.suspended',
          payload: { path: ['vendor_id'], equals: vendorId },
        },
      });
      await prisma.$executeRaw`
        UPDATE outbox_events SET status = 'DEAD_LETTER', "lastError" = 'forced test failure' WHERE id = ${outboxRow.id}
      `;

      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/outbox/dead-letter')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect(
        res.body.items.some((i: { id: string }) => i.id === outboxRow.id),
      ).toBe(true);

      await request(app.getHttpServer())
        .get('/api/v1/admin/outbox/dead-letter')
        .set('Authorization', `Bearer ${owner2}`)
        .expect(403);
    });
  });

  // ============================================================
  // 3. No-duplicate-notification (unique constraint as checkpoint)
  // ============================================================
  describe('no duplicate notification', () => {
    it('reprocessing an already-PUBLISHED-with-a-Notification outbox row via a forced re-run does not create a second Notification', async () => {
      const { vendorId } = await setupActiveVendor();
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      await request(app.getHttpServer())
        .post(`/api/v1/admin/vendors/${vendorId}/suspend`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('Idempotency-Key', unique('suspend'))
        .send({
          reason_code: 'POLICY_VIOLATION',
          reason: 'Policy violation reported by customers',
        })
        .expect(201);
      await drainRelay();
      const outboxRow = await prisma.outboxEvent.findFirstOrThrow({
        where: {
          eventType: 'vendor.suspended',
          payload: { path: ['vendor_id'], equals: vendorId },
        },
      });
      expect(outboxRow.status).toBe('PUBLISHED');
      const before = await prisma.notification.count({
        where: { outboxEventId: outboxRow.id },
      });
      expect(before).toBe(1);

      // Simulate a retry attempt reaching the processing step again
      // (e.g. a crash after Notification create but before PUBLISHED,
      // replayed) by resetting to PROCESSING with the same shape and
      // re-dispatching.
      await prisma.$executeRaw`
        UPDATE outbox_events SET status = 'PROCESSING', "lockedAt" = now() - interval '5 minutes', "lockToken" = 'retry-token' WHERE id = ${outboxRow.id}
      `;
      await dispatchUntil(async () => {
        const row = await prisma.outboxEvent.findUniqueOrThrow({
          where: { id: outboxRow.id },
        });
        return row.status !== 'PROCESSING' || row.lockToken !== 'retry-token';
      });
      const after = await prisma.notification.count({
        where: { outboxEventId: outboxRow.id },
      });
      expect(after).toBe(1);
      const finalRow = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: outboxRow.id },
      });
      expect(finalRow.status).toBe('PUBLISHED');
    });
  });

  // ============================================================
  // 4. Recipient snapshot correctness (not a lookup)
  // ============================================================
  describe('recipient snapshot, not lookup', () => {
    it('an owner removed after the event was enqueued still gets notified; an owner added after does not get it retroactively', async () => {
      const { owner, vendorId } = await setupActiveVendor();
      const ownerRow = await prisma.vendorUser.findFirstOrThrow({
        where: { vendorId, role: 'OWNER' },
      });
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      await request(app.getHttpServer())
        .post(`/api/v1/admin/vendors/${vendorId}/suspend`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('Idempotency-Key', unique('suspend'))
        .send({
          reason_code: 'POLICY_VIOLATION',
          reason: 'Policy violation reported by customers',
        })
        .expect(201);

      // A brand-new user becomes a VendorUser OWNER AFTER the event
      // already happened - simulated directly (no real multi-owner UI
      // exists) since the snapshot guarantee is about timing, not
      // about how a second owner would normally be added.
      const laterOwnerPhone = uniquePhone();
      await signup(laterOwnerPhone, 'a-strong-password');
      const laterUser = await prisma.user.findUniqueOrThrow({
        where: { phone: laterOwnerPhone },
      });
      await prisma.vendorUser.create({
        data: { userId: laterUser.id, vendorId, role: 'OWNER' },
      });

      await drainRelay();

      const notifications = await prisma.notification.findMany({
        where: { type: 'VENDOR_SUSPENDED', targetId: vendorId },
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0].recipientUserId).toBe(ownerRow.userId);
      expect(
        notifications.some((n) => n.recipientUserId === laterUser.id),
      ).toBe(false);
      void owner;
    });
  });

  // ============================================================
  // 5. BOLA + data sensitivity
  // ============================================================
  describe('BOLA and sensitive-data exclusion', () => {
    it('marking another user notification as read 404s; the list never returns another user row', async () => {
      const { vendorId } = await setupActiveVendor();
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      await request(app.getHttpServer())
        .post(`/api/v1/admin/vendors/${vendorId}/suspend`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('Idempotency-Key', unique('suspend'))
        .send({
          reason_code: 'POLICY_VIOLATION',
          reason: 'Policy violation reported by customers',
        })
        .expect(201);
      await drainRelay();
      const ownerNotification = await prisma.notification.findFirstOrThrow({
        where: { type: 'VENDOR_SUSPENDED', targetId: vendorId },
      });

      const stranger = await signup(uniquePhone(), 'a-strong-password');
      await request(app.getHttpServer())
        .post(`/api/v1/me/notifications/${ownerNotification.id}/read`)
        .set('Authorization', `Bearer ${stranger}`)
        .expect(404);

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/me/notifications')
        .set('Authorization', `Bearer ${stranger}`)
        .expect(200);
      expect(
        listRes.body.items.some(
          (i: { id: string }) => i.id === ownerNotification.id,
        ),
      ).toBe(false);
    });

    it('a NOT_RECEIVED_REPORTED notification never carries the free-text reason, and a STOCK_ADJUSTMENT one never carries reason_note', async () => {
      const notReceivedPayload = { reason: 'ثوب غير مطابق ومتسخ للغاية' };
      void notReceivedPayload;
      // Direct, minimal assertion against buildSafeData's own contract:
      // seed a fake outbox row carrying a free-text field under each
      // sensitive key and confirm the resulting Notification.data never
      // contains it, for both event types this sprint explicitly
      // flagged.
      const recipientPhone = uniquePhone();
      const token = await signup(recipientPhone, 'a-strong-password');
      const user = await prisma.user.findUniqueOrThrow({
        where: { phone: recipientPhone },
      });

      const ev1 = await prisma.outboxEvent.create({
        data: {
          eventType: 'branch_order.not_received_reported',
          payload: {
            branch_order_id: 'bo-1',
            vendor_id: 'v-1',
            recipient_user_id: user.id,
            reason: 'very sensitive free text the customer wrote',
          },
        },
      });
      const ev2 = await prisma.outboxEvent.create({
        data: {
          eventType: 'stock_movement.owner_notification',
          payload: {
            offer_variant_id: 'ov-1',
            vendor_id: 'v-1',
            recipient_user_id: user.id,
            reason: 'DAMAGE',
            reason_note: 'another very sensitive free text note',
          },
        },
      });
      await drainRelay();

      const n1 = await prisma.notification.findUniqueOrThrow({
        where: {
          outboxEventId_recipientUserId: {
            outboxEventId: ev1.id,
            recipientUserId: user.id,
          },
        },
      });
      expect(JSON.stringify(n1.data)).not.toContain('sensitive free text');
      const n2 = await prisma.notification.findUniqueOrThrow({
        where: {
          outboxEventId_recipientUserId: {
            outboxEventId: ev2.id,
            recipientUserId: user.id,
          },
        },
      });
      expect(JSON.stringify(n2.data)).not.toContain('sensitive free text note');
      expect(n2.data).toMatchObject({ reason: 'DAMAGE' });
      void token;
    });
  });

  // ============================================================
  // 6. The three new triggers
  // ============================================================
  describe('new triggers', () => {
    it('a new order notifies only the branch employee, never the owner', async () => {
      const { owner, vendorId, branchId } = await setupActiveVendor();
      const employee = await createAcceptedEmployee(owner, vendorId, branchId);
      const variant = await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: (
            await prisma.vendorOffer.create({
              data: { vendorId, titleAr: 'م', titleEn: 'P', status: 'ACTIVE' },
            })
          ).id,
          sellerSku: unique('sku'),
          basePrice: 30,
          storeInventoryBarcode: unique('barcode'),
        },
      });
      await prisma.branchStock.create({
        data: { vendorId, branchId, offerVariantId: variant.id, quantity: 10 },
      });
      const customerToken = await signup(uniquePhone(), 'a-strong-password');
      const addRes = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', unique('cart'))
        .send({
          vendor_id: vendorId,
          offer_variant_id: variant.id,
          quantity: 1,
        })
        .expect(201);
      const reserved = await request(app.getHttpServer())
        .post('/api/v1/checkout/reserve')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', unique('reserve'))
        .send({
          groups: [
            {
              branch_id: branchId,
              fulfilment_method: 'PICKUP',
              payment_method: 'COD',
              cart_item_ids: [addRes.body.id],
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/checkout/confirm')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id })
        .expect(201);

      await drainRelay();
      const notifications = await prisma.notification.findMany({
        where: { type: 'NEW_ORDER_FOR_EMPLOYEE', vendorId },
      });
      expect(notifications).toHaveLength(1);
      const employeeUser = await prisma.user.findUniqueOrThrow({
        where: { phone: employee.phone },
      });
      expect(notifications[0].recipientUserId).toBe(employeeUser.id);
    });

    it('low stock fires exactly on the crossing into 1-3, not again while it stays low, and again after a restock-then-redrop', async () => {
      const { owner, vendorId, branchId } = await setupActiveVendor();
      await createAcceptedEmployee(owner, vendorId, branchId);
      const offer = await prisma.vendorOffer.create({
        data: { vendorId, titleAr: 'م', titleEn: 'P', status: 'ACTIVE' },
      });
      const variant = await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          basePrice: 10,
          storeInventoryBarcode: unique('barcode'),
        },
      });
      await prisma.branchStock.create({
        data: { vendorId, branchId, offerVariantId: variant.id, quantity: 5 },
      });

      async function reserveOne(): Promise<void> {
        const customerToken = await signup(uniquePhone(), 'a-strong-password');
        const addRes = await request(app.getHttpServer())
          .post('/api/v1/cart/items')
          .set('Authorization', `Bearer ${customerToken}`)
          .set('Idempotency-Key', unique('cart'))
          .send({
            vendor_id: vendorId,
            offer_variant_id: variant.id,
            quantity: 1,
          })
          .expect(201);
        await request(app.getHttpServer())
          .post('/api/v1/checkout/reserve')
          .set('Authorization', `Bearer ${customerToken}`)
          .set('Idempotency-Key', unique('reserve'))
          .send({
            groups: [
              {
                branch_id: branchId,
                fulfilment_method: 'PICKUP',
                payment_method: 'COD',
                cart_item_ids: [addRes.body.id],
              },
            ],
          })
          .expect(201);
      }

      // quantity 5 -> reserve 1 (available 5->4): no crossing yet (4 > 3)
      await reserveOne();
      let count = await prisma.outboxEvent.count({
        where: {
          eventType: 'checkout.low_stock_after_reserve',
          payload: { path: ['offer_variant_id'], equals: variant.id },
        },
      });
      expect(count).toBe(0);

      // available 4->3: crossing into the low band - fires
      await reserveOne();
      count = await prisma.outboxEvent.count({
        where: {
          eventType: 'checkout.low_stock_after_reserve',
          payload: { path: ['offer_variant_id'], equals: variant.id },
        },
      });
      expect(count).toBeGreaterThan(0);
      const firstFireCount = count;

      // available 3->2: still low, but no NEW crossing - must not fire again
      await reserveOne();
      count = await prisma.outboxEvent.count({
        where: {
          eventType: 'checkout.low_stock_after_reserve',
          payload: { path: ['offer_variant_id'], equals: variant.id },
        },
      });
      expect(count).toBe(firstFireCount);

      // At this point 3 reserveOne() calls have run: reserved=3,
      // quantity=5, available=2 (still low, correctly not re-fired on
      // the 3rd call above). Restock by exactly +2 -> available =
      // 7 - 3 = 4, genuinely back above the threshold. The very next
      // reserve (available 4 -> 3) crosses again immediately and must
      // fire exactly once more - precise arithmetic, not "reserve a
      // few times and hope".
      await prisma.branchStock.update({
        where: {
          branchId_offerVariantId: { branchId, offerVariantId: variant.id },
        },
        data: { quantity: { increment: 2 } },
      });
      await reserveOne(); // available 4 -> 3: crosses again - fires
      count = await prisma.outboxEvent.count({
        where: {
          eventType: 'checkout.low_stock_after_reserve',
          payload: { path: ['offer_variant_id'], equals: variant.id },
        },
      });
      expect(count).toBeGreaterThan(firstFireCount);
    });
  });

  // ============================================================
  // 7. FulfilmentSweepService - genuinely periodic, not lazy
  // ============================================================
  describe('FulfilmentSweepService', () => {
    it('sweepOnce() creates a reminder outbox event for a DELIVERED order nobody ever revisited', async () => {
      const { owner, vendorId, branchId } = await setupActiveVendor();
      void owner;
      const customerPhone = uniquePhone();
      await signup(customerPhone, 'a-strong-password');
      const customer = await prisma.customerProfile.findFirstOrThrow({
        where: { user: { phone: customerPhone } },
      });
      const customerOrder = await prisma.customerOrder.create({
        data: { customerId: customer.id },
      });
      const branchOrder = await prisma.branchOrder.create({
        data: {
          customerOrderId: customerOrder.id,
          vendorId,
          branchId,
          fulfilmentMethod: 'PICKUP',
          paymentMethod: 'COD',
          subtotal: 10,
          total: 10,
          status: 'DELIVERED',
          deliveredAt: new Date(Date.now() - 50 * 60 * 60 * 1000),
          pickupCode: '123456',
        },
      });

      const swept = await fulfilmentSweep.sweepOnce();
      expect(swept).toBeGreaterThanOrEqual(1);

      const row = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrder.id },
      });
      expect(row.confirmReminderSentAt).not.toBeNull();
      const outboxRows = await prisma.outboxEvent.count({
        where: { eventType: 'branch_order.confirm_reminder_48h' },
      });
      expect(outboxRows).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================
  // 8. DiscountActivationSweepService - scheduled discount + dedup
  // ============================================================
  describe('DiscountActivationSweepService', () => {
    it('does not notify for a future-scheduled discount; notifies exactly once once discountStartAt is reached, never again on a later tick', async () => {
      const { owner, vendorId } = await setupActiveVendor();
      const followerPhone = uniquePhone();
      await signup(followerPhone, 'a-strong-password');
      const followerUser = await prisma.user.findUniqueOrThrow({
        where: { phone: followerPhone },
      });
      await prisma.storeFollow.create({
        data: { userId: followerUser.id, vendorId },
      });

      const offer = await prisma.vendorOffer.create({
        data: { vendorId, titleAr: 'م', titleEn: 'P', status: 'ACTIVE' },
      });
      const variant = await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          basePrice: 100,
          storeInventoryBarcode: unique('barcode'),
          discountPercent: 10,
          discountStartAt: new Date(Date.now() + 60 * 60 * 1000), // 1h in the future
          discountEndAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        },
      });

      // discountSweep.sweepOnce()'s own return value is a GLOBAL count
      // across every vendor currently active in this shared database
      // (other parallel test files may legitimately have their own
      // active discounts right now) - never asserted directly here.
      // Only THIS variant's own DiscountActivationNotice row is what
      // actually proves the behavior.
      await discountSweep.sweepOnce();
      let notices = await prisma.discountActivationNotice.count({
        where: { offerVariantId: variant.id },
      });
      expect(notices).toBe(0);

      // The window is now active.
      await prisma.offerVariant.update({
        where: { id: variant.id },
        data: {
          discountStartAt: new Date(Date.now() - 60 * 1000),
          discountEndAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      // A bounded number of ticks, not one - BATCH_LIMIT=200 candidates
      // per tick, ordered by discountStartAt, so another file's own
      // active discounts could, in principle, crowd this variant out
      // of a single tick's batch.
      for (let i = 0; i < 20; i++) {
        await discountSweep.sweepOnce();
        notices = await prisma.discountActivationNotice.count({
          where: { offerVariantId: variant.id },
        });
        if (notices > 0) break;
      }
      expect(notices).toBe(1);

      // A later tick, same still-active discount: no re-notification.
      await discountSweep.sweepOnce();
      notices = await prisma.discountActivationNotice.count({
        where: { offerVariantId: variant.id },
      });
      expect(notices).toBe(1);

      await drainRelay();
      const followerNotifications = await prisma.notification.findMany({
        where: {
          recipientUserId: followerUser.id,
          type: 'FOLLOWED_STORE_DISCOUNT',
        },
      });
      expect(followerNotifications).toHaveLength(1);
      void owner;
    });
  });

  // ============================================================
  // 9. Follower fan-out across multiple relay batches
  // ============================================================
  describe('follower fan-out', () => {
    it('a new-product publish notifies every follower exactly once, even when it takes more than one relay batch to drain', async () => {
      const { owner, vendorId, branchId } = await setupActiveVendor();
      const followerCount = 5; // small but real multi-follower set
      const followerUserIds: string[] = [];
      for (let i = 0; i < followerCount; i++) {
        const phone = uniquePhone();
        await signup(phone, 'a-strong-password');
        const u = await prisma.user.findUniqueOrThrow({ where: { phone } });
        await prisma.storeFollow.create({ data: { userId: u.id, vendorId } });
        followerUserIds.push(u.id);
      }

      const offer = await prisma.vendorOffer.create({
        data: {
          vendorId,
          titleAr: 'منتج جديد',
          titleEn: 'New product',
          status: 'DRAFT',
          brandId: (
            await prisma.brand.findFirstOrThrow({
              where: { isNoBrandSentinel: true },
            })
          ).id,
        },
      });
      const variant = await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          basePrice: 50,
          storeInventoryBarcode: unique('barcode'),
        },
      });
      // assertPublishGate() also requires a PRIMARY image and live
      // available stock - both genuinely missing from a bare variant.
      await prisma.offerVariantMedia.create({
        data: {
          vendorId,
          offerVariantId: variant.id,
          url: 'https://example.com/photo.jpg',
          kind: 'PRIMARY',
          mediaType: 'IMAGE',
        },
      });
      await prisma.branchStock.create({
        data: { vendorId, branchId, offerVariantId: variant.id, quantity: 10 },
      });

      await request(app.getHttpServer())
        .patch(`/api/v1/vendors/${vendorId}/offers/${offer.id}/status`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ status: 'ACTIVE' })
        .expect((r) => expect([200, 201]).toContain(r.status));

      await drainRelay();

      const notifications = await prisma.notification.findMany({
        where: { type: 'FOLLOWED_STORE_NEW_PRODUCT' },
      });
      expect(notifications).toHaveLength(followerCount);
      const notifiedIds = notifications.map((n) => n.recipientUserId).sort();
      expect(notifiedIds).toEqual([...followerUserIds].sort());

      // A later ACTIVE<->INACTIVE toggle never re-fires it.
      await request(app.getHttpServer())
        .patch(`/api/v1/vendors/${vendorId}/offers/${offer.id}/status`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ status: 'INACTIVE' })
        .expect((r) => expect([200, 201]).toContain(r.status));
      await request(app.getHttpServer())
        .patch(`/api/v1/vendors/${vendorId}/offers/${offer.id}/status`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ status: 'ACTIVE' })
        .expect((r) => expect([200, 201]).toContain(r.status));
      await drainRelay();
      const after = await prisma.notification.count({
        where: { type: 'FOLLOWED_STORE_NEW_PRODUCT' },
      });
      expect(after).toBe(followerCount);
    });
  });

  // ============================================================
  // 10. The notification-center API itself
  // ============================================================
  describe('/me/notifications API', () => {
    it('lists, counts unread, and marks read idempotently', async () => {
      const { vendorId } = await setupActiveVendor();
      const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
      const owner2Phone = uniquePhone();
      const owner2 = await signup(owner2Phone, 'a-strong-password');
      void owner2;
      await request(app.getHttpServer())
        .post(`/api/v1/admin/vendors/${vendorId}/suspend`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('Idempotency-Key', unique('suspend'))
        .send({
          reason_code: 'POLICY_VIOLATION',
          reason: 'Policy violation reported by customers',
        })
        .expect(201);
      await drainRelay();
      const ownerRow = await prisma.vendorUser.findFirstOrThrow({
        where: { vendorId, role: 'OWNER' },
      });
      const ownerUser = await prisma.user.findUniqueOrThrow({
        where: { id: ownerRow.userId },
      });
      const ownerLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ phone: ownerUser.phone, password: 'a-strong-password' })
        .expect(200);
      const ownerToken = ownerLogin.body.session_token as string;

      const unreadBefore = await request(app.getHttpServer())
        .get('/api/v1/me/notifications/unread-count')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(unreadBefore.body.unread_count).toBe(1);

      const list = await request(app.getHttpServer())
        .get('/api/v1/me/notifications')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].type).toBe('VENDOR_SUSPENDED');
      expect(list.body.items[0].read_at).toBeNull();

      const notificationId = list.body.items[0].id as string;
      await request(app.getHttpServer())
        .post(`/api/v1/me/notifications/${notificationId}/read`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      // Idempotent second call.
      await request(app.getHttpServer())
        .post(`/api/v1/me/notifications/${notificationId}/read`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const unreadAfter = await request(app.getHttpServer())
        .get('/api/v1/me/notifications/unread-count')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(unreadAfter.body.unread_count).toBe(0);
    });
  });
});
