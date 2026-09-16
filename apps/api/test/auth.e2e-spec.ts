import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { OtpService } from './../src/auth/otp.service';
import { SessionService } from './../src/auth/session.service';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';

/** Test double for the OPEN-004 SMS fallback - captures codes instead of logging them. */
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

  sentCountFor(phone: string): number {
    return this.sent.filter((s) => s.phone === phone).length;
  }
}

// E.164-ish, unique per call within this test run so tests never
// collide on the users.phone unique constraint (a `.slice()`-based
// attempt at this using Date.now() truncated away the actual entropy
// and caused cross-test phone collisions - a plain counter is simpler
// and can't make that mistake).
// +970 59 XXXXXXX - a 9-digit national number (libphonenumber-js
// validates this shape for the PS region). The dev database isn't
// truncated between test runs, so a counter alone (restarting from 0
// on every run) would regenerate the same phone numbers - and the
// same deterministic `verify-${phone}` Idempotency-Key - as a *prior*
// run, colliding with its leftover rows (409, not the business-logic
// status each test expects). Seeding from the current time and only
// incrementing from there keeps numbers unique both within one run
// and across repeated runs against the same persistent database.
let phoneSeq = Date.now() % 1_000_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97059${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}

describe('Auth, customers, vendors (e2e) - Sprint 2, EPIC-AUTH', () => {
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

  async function signup(phone: string, password: string) {
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'signup' })
      .expect(202);

    const code = fakeSms.lastCodeFor(phone);

    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', `verify-${phone}`)
      .send({ phone, otp_code: code, purpose: 'signup' })
      .expect(200);

    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        phone,
        password,
        verification_token: verify.body.session_token,
      })
      .expect(201);

    return register.body.session_token as string;
  }

  describe('signup -> verify -> register -> login', () => {
    it('completes the full flow and the resulting session authenticates a protected route', async () => {
      const phone = uniquePhone();
      const sessionToken = await signup(phone, 'a-strong-password');

      const me = await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set('Authorization', `Bearer ${sessionToken}`)
        .expect(200);
      expect(me.body.phone).toBe(phone);
      expect(me.body.phone_verified_at).not.toBeNull();

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ phone, password: 'a-strong-password' })
        .expect(200);
      expect(typeof login.body.session_token).toBe('string');

      await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set('Authorization', `Bearer ${login.body.session_token}`)
        .expect(200);
    });

    it('rejects registration with the wrong OTP code (400 OTP_INVALID)', async () => {
      const phone = uniquePhone();
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone, purpose: 'signup' })
        .expect(202);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', `verify-wrong-${phone}`)
        .send({ phone, otp_code: '000000', purpose: 'signup' })
        .expect(400);
      expect(res.body.error.code).toBe('OTP_INVALID');
    });

    it('rejects verification of an expired OTP (409 OTP_EXPIRED)', async () => {
      const phone = uniquePhone();
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone, purpose: 'signup' })
        .expect(202);
      const code = fakeSms.lastCodeFor(phone);

      // Force expiry directly - the code is correct, but too late.
      await prisma.otpCode.updateMany({
        where: { phone, purpose: 'SIGNUP' },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', `verify-expired-${phone}`)
        .send({ phone, otp_code: code, purpose: 'signup' })
        .expect(409);
      expect(res.body.error.code).toBe('OTP_EXPIRED');
    });

    it('locks out after 5 wrong attempts (429 TOO_MANY_ATTEMPTS), even with the correct code on the 6th try', async () => {
      const phone = uniquePhone();
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone, purpose: 'signup' })
        .expect(202);
      const code = fakeSms.lastCodeFor(phone);

      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/otp/verify')
          .set('Idempotency-Key', `verify-attempt-${phone}-${i}`)
          .send({ phone, otp_code: '000000', purpose: 'signup' })
          .expect(400);
      }

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', `verify-attempt-${phone}-final`)
        .send({ phone, otp_code: code, purpose: 'signup' })
        .expect(429);
      expect(res.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    });

    it('replays the same session_token for a retried otp/verify with the same Idempotency-Key, without re-checking the (already-consumed) OTP - TC-AUTH-002', async () => {
      const phone = uniquePhone();
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone, purpose: 'signup' })
        .expect(202);
      const code = fakeSms.lastCodeFor(phone);
      const key = `verify-idem-${phone}`;

      const first = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', key)
        .send({ phone, otp_code: code, purpose: 'signup' })
        .expect(200);

      const second = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', key)
        .send({ phone, otp_code: code, purpose: 'signup' })
        .expect(200);

      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.session_token).toBe(first.body.session_token);
    });

    it('under two concurrent otp/verify calls for the same phone/code but different Idempotency-Keys, exactly one succeeds and the OTP is consumed exactly once', async () => {
      const phone = uniquePhone();
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone, purpose: 'signup' })
        .expect(202);
      const code = fakeSms.lastCodeFor(phone);

      const [a, b] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/auth/otp/verify')
          .set('Idempotency-Key', `race-a-${phone}`)
          .send({ phone, otp_code: code, purpose: 'signup' }),
        request(app.getHttpServer())
          .post('/api/v1/auth/otp/verify')
          .set('Idempotency-Key', `race-b-${phone}`)
          .send({ phone, otp_code: code, purpose: 'signup' }),
      ]);

      // The interceptor's own claim doesn't stop this race - the two
      // requests use different Idempotency-Keys, so both reach
      // OtpService independently. The atomic consume() compare-and-swap
      // is what guarantees only one wins.
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 400]);

      const rows = await prisma.otpCode.findMany({
        where: { phone, purpose: 'SIGNUP' },
      });
      const consumedRows = rows.filter((r) => r.consumedAt !== null);
      expect(consumedRows).toHaveLength(1);
    });

    it("consume() refuses to mark an OTP consumed if it's expired at the moment of consumption, even though the claim's other pinned fields still match (TOCTOU boundary, real DB)", async () => {
      const otpService = app.get(OtpService);
      const phone = uniquePhone();
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone, purpose: 'signup' })
        .expect(202);
      const code = fakeSms.lastCodeFor(phone);

      const check = await otpService.checkCode(phone, 'SIGNUP', code);
      expect(check.ok).toBe(true);

      // Simulate time passing between checkCode() and consume(): the
      // row's real expiresAt is now in the past, even though the claim
      // we're about to pass to consume() still remembers the original
      // (still-future, at the time it was read) value.
      await prisma.otpCode.updateMany({
        where: { id: check.claim!.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const consumed = await otpService.consume(check.claim!);
      expect(consumed).toBe(false);

      const row = await prisma.otpCode.findUnique({
        where: { id: check.claim!.id },
      });
      expect(row!.consumedAt).toBeNull();
    });

    it('recovers the same verification token on a retry whose Idempotency-Key record was left FAILED despite the OTP already having been consumed (simulated interceptor bookkeeping failure)', async () => {
      const phone = uniquePhone();
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone, purpose: 'signup' })
        .expect(202);
      const code = fakeSms.lastCodeFor(phone);
      const key = `verify-recover-${phone}`;

      const first = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', key)
        .send({ phone, otp_code: code, purpose: 'signup' })
        .expect(200);

      // Simulate IdempotencyInterceptor's own completion write having
      // failed right after the handler's work (Redis token + Postgres
      // OTP consumption) already committed - a real, if rare, failure
      // mode: the two are separate Postgres writes, not one transaction.
      await prisma.idempotencyKey.updateMany({
        where: { key, requestPath: '/api/v1/auth/otp/verify' },
        data: { status: 'FAILED' },
      });

      // An identical retry must recover the same token instead of
      // failing behind an OTP that now merely looks "already used".
      const second = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', key)
        .send({ phone, otp_code: code, purpose: 'signup' })
        .expect(200);

      expect(second.body.session_token).toBe(first.body.session_token);
    });

    it('scopes the Idempotency-Key on the pre-auth otp/verify route by phone, so two different users reusing the same key never collide', async () => {
      const phoneA = uniquePhone();
      const phoneB = uniquePhone();
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: phoneA, purpose: 'signup' })
        .expect(202);
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: phoneB, purpose: 'signup' })
        .expect(202);
      const codeA = fakeSms.lastCodeFor(phoneA);
      const codeB = fakeSms.lastCodeFor(phoneB);
      const sharedKey = 'shared-preauth-key';

      const resA = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', sharedKey)
        .send({ phone: phoneA, otp_code: codeA, purpose: 'signup' })
        .expect(200);

      const resB = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', sharedKey)
        .send({ phone: phoneB, otp_code: codeB, purpose: 'signup' })
        .expect(200);

      expect(resA.body.session_token).not.toBe(resB.body.session_token);
      expect(resA.headers['idempotent-replayed']).toBeUndefined();
      expect(resB.headers['idempotent-replayed']).toBeUndefined();
    });

    it('rejects registration with a missing/invalid verification_token (400 PHONE_NOT_VERIFIED)', async () => {
      const phone = uniquePhone();
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          phone,
          password: 'a-strong-password',
          verification_token: 'bogus',
        })
        .expect(400);
      expect(res.body.error.code).toBe('PHONE_NOT_VERIFIED');
    });

    it('rejects a second registration for an already-registered phone (409 PHONE_ALREADY_REGISTERED)', async () => {
      const phone = uniquePhone();
      await signup(phone, 'a-strong-password');

      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone, purpose: 'signup' })
        .expect(202);
      const code = fakeSms.lastCodeFor(phone);
      const verify = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', `verify-dup-${phone}`)
        .send({ phone, otp_code: code, purpose: 'signup' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          phone,
          password: 'a-different-password',
          verification_token: verify.body.session_token,
        })
        .expect(409);
      expect(res.body.error.code).toBe('PHONE_ALREADY_REGISTERED');
    });
  });

  describe('login', () => {
    it('rejects a wrong password (400 INVALID_CREDENTIALS)', async () => {
      const phone = uniquePhone();
      await signup(phone, 'correct-password');

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ phone, password: 'wrong-password' })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects an unregistered phone with the same code as a wrong password (no enumeration)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ phone: uniquePhone(), password: 'whatever' })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('password reset', () => {
    it('resets the password via OTP, revokes prior sessions, and the new password works', async () => {
      const phone = uniquePhone();
      const oldSessionToken = await signup(phone, 'old-password');

      await request(app.getHttpServer())
        .post('/api/v1/auth/password/reset-request')
        .send({ phone })
        .expect(202);
      const code = fakeSms.lastCodeFor(phone);

      const confirm = await request(app.getHttpServer())
        .post('/api/v1/auth/password/reset-confirm')
        .set('Idempotency-Key', `reset-${phone}`)
        .send({ phone, otp_code: code, new_password: 'new-password' })
        .expect(200);
      expect(typeof confirm.body.session_token).toBe('string');

      // Old session is revoked.
      await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set('Authorization', `Bearer ${oldSessionToken}`)
        .expect(401);

      // Old password no longer works; new one does.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ phone, password: 'old-password' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ phone, password: 'new-password' })
        .expect(200);
    });

    it("rejects an old session via sessionVersion even when its Redis key is never deleted at all - the fail-closed guarantee is independent of revokeAllForUser()'s Redis cleanup succeeding", async () => {
      const phone = uniquePhone();
      await signup(phone, 'old-password');

      await request(app.getHttpServer())
        .post('/api/v1/auth/password/reset-request')
        .send({ phone })
        .expect(202);
      const code = fakeSms.lastCodeFor(phone);
      await request(app.getHttpServer())
        .post('/api/v1/auth/password/reset-confirm')
        .set('Idempotency-Key', `reset-failclosed-${phone}`)
        .send({ phone, otp_code: code, new_password: 'new-password' })
        .expect(200);

      // Forge a session carrying the STALE (pre-reset) sessionVersion
      // directly - exactly what would be left behind if Redis deletion
      // had failed or been skipped entirely, regardless of whether the
      // real revokeAllForUser() call above actually succeeded. If the
      // guard's only protection were "the Redis key happens to be
      // gone," this forged session would still work; the sessionVersion
      // check must reject it purely from the Postgres side.
      const sessions = app.get(SessionService);
      const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
      const forgedStaleToken = await sessions.create({
        userId: user.id,
        phone,
        phoneVerifiedAt: new Date().toISOString(),
        sessionVersion: 0, // the pre-reset version
      });

      await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set('Authorization', `Bearer ${forgedStaleToken}`)
        .expect(401);
    });

    it('records OTP consumption, the password change, and the Idempotency-Key completion atomically - a retry with the same key replays instead of re-running the reset (Sprint 2 review round 4)', async () => {
      const phone = uniquePhone();
      await signup(phone, 'old-password');

      await request(app.getHttpServer())
        .post('/api/v1/auth/password/reset-request')
        .send({ phone })
        .expect(202);
      const code = fakeSms.lastCodeFor(phone);
      const key = `reset-atomic-${phone}`;

      const first = await request(app.getHttpServer())
        .post('/api/v1/auth/password/reset-confirm')
        .set('Idempotency-Key', key)
        .send({ phone, otp_code: code, new_password: 'new-password' })
        .expect(200);

      // The transaction itself writes the Idempotency-Key completion
      // record (AuthController.confirmPasswordReset, via
      // req.idempotencyClaimId) - not a separate post-handler step -
      // so it is already COMPLETED, with the exact response body, by
      // the time this HTTP response returns. Previously (Sprint 2
      // review round 3) that completion write was a second, separate
      // Postgres statement outside the transaction; if it failed after
      // the transaction had already committed, the client got an
      // error and a same-key retry could never recover, since
      // checkCode() only ever finds unconsumed OTPs and this route had
      // no Redis-backed recovery index the way otp/verify does.
      const idempotencyRow = await prisma.idempotencyKey.findFirst({
        where: { key, requestPath: '/api/v1/auth/password/reset-confirm' },
      });
      expect(idempotencyRow?.status).toBe('COMPLETED');
      expect(idempotencyRow?.responseBody).toEqual(first.body);

      // A retry with the same key replays that record directly - it
      // never re-enters the handler at all, so it cannot re-run the
      // password change or touch the (already-consumed) OTP again.
      const second = await request(app.getHttpServer())
        .post('/api/v1/auth/password/reset-confirm')
        .set('Idempotency-Key', key)
        .send({ phone, otp_code: code, new_password: 'new-password' })
        .expect(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);

      // The OTP itself was only ever consumed once - direct proof the
      // reset logic ran exactly once, not once per request.
      const otpRows = await prisma.otpCode.findMany({
        where: { phone, purpose: 'PASSWORD_RESET' },
      });
      expect(otpRows.filter((r) => r.consumedAt !== null)).toHaveLength(1);
    });

    it('does not send a real OTP for an unregistered phone, but still returns the same response shape', async () => {
      const phone = uniquePhone();
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/password/reset-request')
        .send({ phone })
        .expect(202);

      expect(res.body).toEqual({ expires_in_seconds: 300 });
      expect(fakeSms.sentCountFor(phone)).toBe(0);
    });
  });

  describe('protected routes require a valid session (FR-AUTH-004)', () => {
    it('rejects a request with no Authorization header', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .expect(401);
    });

    it('rejects a request with a garbage bearer token', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });
  });

  describe('address capture (BL-AUTH-004)', () => {
    it('creates an address for the authenticated customer', async () => {
      const phone = uniquePhone();
      const token = await signup(phone, 'a-strong-password');

      const res = await request(app.getHttpServer())
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', `Bearer ${token}`)
        .send({
          lat: 31.9,
          lng: 35.2,
          landmark_note: 'Near the main square',
          phone_number_1: '+970591111111',
          phone_number_2: '+970592222222',
        })
        .expect(201);

      expect(res.body.lat).toBe(31.9);
      expect(res.body.phone_number_1).toBe('+970591111111');
    });
  });

  describe('vendor application (BL-VEND-001)', () => {
    it('creates a vendor Applied with its branches', async () => {
      const phone = uniquePhone();
      const token = await signup(phone, 'a-strong-password');

      const res = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `vendor-apply-${phone}`)
        .send({
          legal_name: 'Test Store Ltd',
          branches: [{ name: 'Main branch', is_physical: true }],
        })
        .expect(201);

      expect(res.body.status).toBe('APPLIED');
      expect(res.body.branches).toHaveLength(1);
      expect(res.body.branches[0].name).toBe('Main branch');
    });

    it('rejects an application with zero branches', async () => {
      const phone = uniquePhone();
      const token = await signup(phone, 'a-strong-password');

      await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `vendor-apply-empty-${phone}`)
        .send({ legal_name: 'No Branches Ltd', branches: [] })
        .expect(400);
    });

    it('rejects an application with no session', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Idempotency-Key', 'vendor-apply-anon')
        .send({
          legal_name: 'Anonymous Ltd',
          branches: [{ name: 'Branch', is_physical: false }],
        })
        .expect(401);
    });

    it("scopes the Idempotency-Key to the authenticated user - two different users reusing the same client-chosen key never collide (the Sprint 1 review's deferred coverage)", async () => {
      const phoneA = uniquePhone();
      const phoneB = uniquePhone();
      const tokenA = await signup(phoneA, 'password-a');
      const tokenB = await signup(phoneB, 'password-b');
      const sharedKey = 'shared-client-chosen-key';

      const resA = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          legal_name: 'Vendor A',
          branches: [{ name: 'A Branch', is_physical: true }],
        })
        .expect(201);

      // Same literal Idempotency-Key, different user, different body -
      // must be treated as a completely independent request, not a
      // conflict or a replay of A's response.
      const resB = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${tokenB}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          legal_name: 'Vendor B',
          branches: [{ name: 'B Branch', is_physical: false }],
        })
        .expect(201);

      expect(resA.body.legal_name).toBe('Vendor A');
      expect(resB.body.legal_name).toBe('Vendor B');
      expect(resA.body.id).not.toBe(resB.body.id);
      expect(resA.headers['idempotent-replayed']).toBeUndefined();
      expect(resB.headers['idempotent-replayed']).toBeUndefined();
    });
  });
});
