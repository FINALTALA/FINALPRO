import { Injectable } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { OtpPurpose } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from './sms.service';

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes, matching Part 4 H.3's "e.g. 5 minutes" idempotency window
const MAX_ATTEMPTS = 5;

// A flat shape (not a discriminated union) on purpose: this tsconfig
// has strictNullChecks off, under which TypeScript's control-flow
// narrowing on a discriminated union's literal tag isn't reliable -
// `if (!result.ok) { use(result.reason) }` failed to narrow in
// practice. `reason` being optional and always accessible sidesteps
// the whole class of narrowing issue instead of fighting it.
export interface OtpVerifyResult {
  ok: boolean;
  reason?: 'invalid' | 'expired' | 'too_many_attempts';
}

function hashCode(code: string): string {
  // Not a password - single-use, 5-minute-lived, rate-limited by the
  // route's @Throttle() and by attemptCount below. A fast hash is fine
  // here; NFR-SEC-002's bcrypt/argon2 requirement is specifically for
  // passwords, a much longer-lived secret with a different threat model.
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Issues and verifies OTP codes (Part 4, H.3; FR-AUTH-003/005/006).
 * Shared by `POST /auth/otp/request`, `POST /auth/otp/verify`, and
 * `POST /auth/password/reset-confirm` - one place enforces "single
 * code per phone+purpose active at a time" and the attempt-count/
 * expiry rules, rather than three endpoints each reimplementing them.
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
   * this phone+purpose. A wrong code increments attemptCount but does
   * NOT consume the OTP - the caller gets to keep trying (up to
   * MAX_ATTEMPTS) against the same code, matching "consumption happens
   * exactly once, on first *successful* verification" (Part 4, H.3).
   */
  async verify(
    phone: string,
    purpose: OtpPurpose,
    code: string,
  ): Promise<OtpVerifyResult> {
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

    await this.prisma.otpCode.update({
      where: { id: latest.id },
      data: { consumedAt: new Date() },
    });
    return { ok: true };
  }
}
