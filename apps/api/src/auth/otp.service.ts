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

export interface OtpClaim {
  id: string;
  expiresAt: Date;
  attemptCount: number;
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
   * WHERE clause pins the exact id/expiresAt/attemptCount checkCode()
   * read, so - exactly like the idempotency interceptor's
   * attemptTakeover() - a concurrent consume() for the same row can
   * only have one winner; Postgres re-evaluates the loser's predicate
   * against the now-consumed row and it affects zero rows.
   *
   * Pass `tx` to consume as part of a larger Prisma transaction (e.g.
   * bundled with the password update it gates), so a failure anywhere
   * in that transaction rolls the consumption back too, leaving the
   * OTP genuinely retryable rather than burned for nothing.
   */
  async consume(
    claim: OtpClaim,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? this.prisma;
    const result = await client.otpCode.updateMany({
      where: {
        id: claim.id,
        consumedAt: null,
        expiresAt: claim.expiresAt,
        attemptCount: claim.attemptCount,
      },
      data: { consumedAt: new Date() },
    });
    return result.count === 1;
  }
}
