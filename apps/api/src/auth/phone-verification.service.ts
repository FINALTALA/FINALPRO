import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { OtpPurpose } from '../../generated/prisma/client';
import { RedisService } from '../redis/redis.service';

const VERIFICATION_TTL_SECONDS = 15 * 60; // 15 minutes
const VERIFICATION_KEY_PREFIX = 'phone_verification:';

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
}
