import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENCY_TTL_KEY = 'idempotency_ttl_ms';

/**
 * Overrides the default 24h idempotency-record retention window (Part
 * 4, H.1) for a specific route. `POST /auth/otp/verify` uses this for
 * a 5-minute window per Part 4, H.3: the OTP itself is single-use, so
 * there is no reason to keep replaying its result for a full day, and
 * a short window limits how long a captured session_token stays replayable.
 */
export const IdempotencyTtl = (ms: number) =>
  SetMetadata(IDEMPOTENCY_TTL_KEY, ms);
