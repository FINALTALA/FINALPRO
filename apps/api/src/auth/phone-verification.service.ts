import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { OtpPurpose } from '../../generated/prisma/client';
import { RedisService } from '../redis/redis.service';

const VERIFICATION_TTL_SECONDS = 15 * 60; // 15 minutes
const VERIFICATION_KEY_PREFIX = 'phone_verification:';
const RECOVERY_INDEX_KEY_PREFIX = 'phone_verification_recovery:';

export interface PhoneVerificationData {
  phone: string;
  purpose: OtpPurpose;
}

/**
 * The `session_token` `POST /auth/otp/verify` returns (Part 4, H.3) is
 * explicitly "scoped to the verified phone only" - not a full account
 * session. It proves "this phone was just OTP-verified for this
 * purpose" to whichever endpoint consumes it next (POST /auth/register
 * for SIGNUP), nothing more. Kept in its own Redis namespace, separate
 * from SessionService, because the consumption semantics differ: this
 * is single-use (GETDEL) and short-lived; a login session is reusable
 * and long-lived.
 */
@Injectable()
export class PhoneVerificationService {
  constructor(private readonly redis: RedisService) {}

  async create(data: PhoneVerificationData): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.redis.set(
      VERIFICATION_KEY_PREFIX + token,
      JSON.stringify(data),
      'EX',
      VERIFICATION_TTL_SECONDS,
    );
    return token;
  }

  /** One-time read: the token is gone whether or not the caller uses the result. */
  async consume(token: string): Promise<PhoneVerificationData | null> {
    const raw = await this.redis.getdel(VERIFICATION_KEY_PREFIX + token);
    return raw ? (JSON.parse(raw) as PhoneVerificationData) : null;
  }

  /**
   * A second, minimal Redis entry - keyed by the OtpCode row's id AND
   * the exact Idempotency-Key that's about to attempt consuming it,
   * not by the token itself - letting a retry recover an already-
   * issued token by (otpId, idempotencyKey) alone (Sprint 2 review
   * round 4; AuthController.verifyOtp). Shares the main entry's exact
   * TTL, so recovery is naturally possible only within the same window
   * the token itself would still have been usable anyway - no separate
   * cleanup policy to define or forget, and nothing durably persisted.
   *
   * The Idempotency-Key is part of the Redis key itself (not just an
   * argument used to look the row up in Postgres, as consumedByKey is)
   * because this method is called *before* consume() now (Sprint 2
   * review round 5 - see verifyOtp's ordering comment): two genuinely
   * concurrent verifies for the same code, under two different keys,
   * would otherwise both write to the *same* recovery-index entry
   * before either has won the consume() race, and whichever write
   * landed last would silently overwrite the other's - a losing
   * request's retry could then recover a token it was never issued (or
   * vice versa). Scoping the Redis key itself by idempotencyKey keeps
   * each request's index entry - and its own eventual recovery lookup,
   * gated by findConsumedRecord()'s exact consumedByKey match - fully
   * isolated from every other concurrent request's.
   */
  async createRecoveryIndex(
    otpId: string,
    idempotencyKey: string,
    token: string,
  ): Promise<void> {
    await this.redis.set(
      RECOVERY_INDEX_KEY_PREFIX + otpId + ':' + idempotencyKey,
      token,
      'EX',
      VERIFICATION_TTL_SECONDS,
    );
  }

  async recoverToken(
    otpId: string,
    idempotencyKey: string,
  ): Promise<string | null> {
    return this.redis.get(
      RECOVERY_INDEX_KEY_PREFIX + otpId + ':' + idempotencyKey,
    );
  }
}
