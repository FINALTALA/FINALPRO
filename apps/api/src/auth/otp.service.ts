import { Injectable } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { OtpPurpose, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from './sms.service';

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes, matching Part 4 H.3's "e.g. 5 minutes" idempotency window
const MAX_ATTEMPTS = 5;

function hashCode(code: string): string {
  // Not a password - single-use, 5-minute-lived, rate-limited by the
  // route's @Throttle() and by attemptCount below. A fast hash is fine
  // here; NFR-SEC-002's bcrypt/argon2 requirement is specifically for
  // passwords, a much longer-lived secret with a different threat model.
  return createHash('sha256').update(code).digest('hex');
}

const RECOVERY_WINDOW_MS = 5 * 60 * 1000; // matches the OTP-verify Idempotency-Key TTL - see consume()'s doc comment

export interface OtpClaim {
  id: string;
  expiresAt: Date;
  attemptCount: number;
}

export interface OtpConsumeOptions {
  tx?: Prisma.TransactionClient;
  /** Durably stored on the row alongside consumedAt - see findRecoverableToken(). */
  verificationToken?: string;
  /** The client's Idempotency-Key at the moment of consumption - required for findRecoverableToken() to ever recover this row. */
  idempotencyKey?: string;
}

// Flat, not a discriminated union - see idempotency.interceptor's
// OtpVerifyResult-shaped comment history: this tsconfig's
// strictNullChecks:false makes narrowing on a literal `ok` tag
// unreliable, so `reason`/`claim` being optional-but-always-accessible
// sidesteps that instead of fighting it.
export interface OtpCheckResult {
  ok: boolean;
  reason?: 'invalid' | 'expired' | 'too_many_attempts';
  claim?: OtpClaim;
}

/**
 * Issues and checks OTP codes (Part 4, H.3; FR-AUTH-003/005/006).
 *
 * Checking a code and *consuming* it are deliberately two separate
 * steps (checkCode / consume), not one atomic "verify". Two reasons:
 *
 * 1. Race safety: the original single-step verify() read the
 *    unconsumed row, validated it, then wrote consumedAt by id alone -
 *    two concurrent requests (different Idempotency-Keys, so the
 *    interceptor's own claim doesn't stop either of them) could both
 *    read the row before either wrote, and both would succeed. consume()
 *    closes this with an atomic compare-and-swap update, the same
 *    pattern IdempotencyInterceptor.attemptTakeover() already uses.
 *
 * 2. Consuming-before-the-dependent-operation-completes is itself a
 *    bug: if a caller consumed the OTP first and *then* the operation
 *    it gates failed (e.g. a password update, or issuing a Redis
 *    token), the OTP is burned with nothing to show for it, and an
 *    identical retry can never succeed since the OTP no longer exists
 *    to re-check. Splitting the two lets a caller check the code, do
 *    its own work, and consume() only once it's safe to commit to -
 *    e.g. inside the same Prisma transaction as the state change the
 *    OTP gates (see AuthController.confirmPasswordReset).
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  async issue(phone: string, purpose: OtpPurpose): Promise<void> {
    const code = randomInt(100_000, 1_000_000).toString();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await this.prisma.otpCode.create({
      data: { phone, purpose, codeHash: hashCode(code), expiresAt },
    });
    await this.sms.sendOtp(phone, code, expiresAt);
  }

  /**
   * Checks `code` against the most recent, not-yet-consumed OTP for
   * this phone+purpose, but does NOT consume it - callers get a
   * claim to consume() once (and only once) their dependent work can
   * commit to it. A wrong code increments attemptCount immediately
   * (this write is intentionally NOT deferred to any transaction - a
   * failed attempt must be recorded regardless of what the caller
   * does next) but does not consume the OTP, matching "consumption
   * happens exactly once, on first *successful* verification" (Part
   * 4, H.3).
   */
  async checkCode(
    phone: string,
    purpose: OtpPurpose,
    code: string,
  ): Promise<OtpCheckResult> {
    const latest = await this.prisma.otpCode.findFirst({
      where: { phone, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!latest) {
      return { ok: false, reason: 'invalid' };
    }
    if (latest.attemptCount >= MAX_ATTEMPTS) {
      return { ok: false, reason: 'too_many_attempts' };
    }
    if (latest.expiresAt.getTime() < Date.now()) {
      return { ok: false, reason: 'expired' };
    }
    if (latest.codeHash !== hashCode(code)) {
      await this.prisma.otpCode.update({
        where: { id: latest.id },
        data: { attemptCount: { increment: 1 } },
      });
      return { ok: false, reason: 'invalid' };
    }

    return {
      ok: true,
      claim: {
        id: latest.id,
        expiresAt: latest.expiresAt,
        attemptCount: latest.attemptCount,
      },
    };
  }

  /**
   * Atomically marks a checkCode()-returned claim as consumed. The
   * WHERE clause pins id + attemptCount to what checkCode() read, so -
   * exactly like the idempotency interceptor's attemptTakeover() - a
   * concurrent consume() for the same row can only have one winner;
   * Postgres re-evaluates the loser's predicate against the
   * now-consumed row and it affects zero rows.
   *
   * expiresAt is checked *fresh* (`{ gt: now }`), not pinned to the
   * value checkCode() read: a code that was still valid when checked
   * can expire in the (however small) gap before consume() runs, and
   * pinning the old value wouldn't have caught that - `expiresAt`
   * never changes after a row is created, so equality-matching it
   * would always succeed regardless of whether time had actually
   * passed. Re-checking freshness in the same atomic statement that
   * performs the write is what actually closes that gap.
   *
   * Pass `tx` to consume as part of a larger Prisma transaction (e.g.
   * bundled with the password update it gates), so a failure anywhere
   * in that transaction rolls the consumption back too, leaving the
   * OTP genuinely retryable rather than burned for nothing.
   *
   * Pass `verificationToken` to durably record it on this same write -
   * see findRecoverableToken() for why.
   */
  async consume(
    claim: OtpClaim,
    options: OtpConsumeOptions = {},
  ): Promise<boolean> {
    const client = options.tx ?? this.prisma;
    const result = await client.otpCode.updateMany({
      where: {
        id: claim.id,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        attemptCount: claim.attemptCount,
      },
      data: {
        consumedAt: new Date(),
        verificationToken: options.verificationToken,
        consumedByKey: options.idempotencyKey,
      },
    });
    return result.count === 1;
  }

  /**
   * Recovers a durably-stored verificationToken from an OTP consumption
   * whose Idempotency-Key exactly matches `idempotencyKey` - for when
   * IdempotencyInterceptor's own completion-bookkeeping write fails
   * *after* checkCode()+consume() already succeeded and a token was
   * already returned to the caller (Sprint 2 review fix round 2). A
   * retry with the same Idempotency-Key re-enters the handler, but the
   * OTP no longer looks "checkable" - checkCode() only ever looks at
   * unconsumed rows, so an already-consumed one is indistinguishable
   * from "never existed" without this.
   *
   * The exact-match on `idempotencyKey` (not just the code hash) is
   * load-bearing, not optional: two genuinely different, concurrent
   * requests for the same code (different Idempotency-Keys, e.g. a
   * double-submit) both reach this point after one wins the consume()
   * race - without the key check, the *loser* could recover the
   * *winner's* token by matching on code alone, defeating single-use
   * under exactly the concurrency case consume()'s CAS exists to
   * prevent. Only the request that was actually recorded as the
   * consumer can ever recover this row.
   */
  async findRecoverableToken(
    phone: string,
    purpose: OtpPurpose,
    code: string,
    idempotencyKey: string,
  ): Promise<{ token: string; consumedAt: Date } | null> {
    const row = await this.prisma.otpCode.findFirst({
      where: {
        phone,
        purpose,
        codeHash: hashCode(code),
        consumedByKey: idempotencyKey,
        consumedAt: {
          not: null,
          gte: new Date(Date.now() - RECOVERY_WINDOW_MS),
        },
        verificationToken: { not: null },
      },
      orderBy: { consumedAt: 'desc' },
    });
    if (!row || !row.verificationToken || !row.consumedAt) {
      return null;
    }
    return { token: row.verificationToken, consumedAt: row.consumedAt };
  }
}
