import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';

// Part 4, H.1. Kept as a single source of truth: idempotency.interceptor.ts
// imports this same constant for its own default, rather than each
// defining its own copy that could drift apart.
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Records an Idempotency-Key claim as COMPLETED from *inside* the same
 * Prisma transaction that created/changed the resource the request was
 * for - the generalized form of the pattern AuthController.
 * confirmPasswordReset() used for password reset (Sprint 2 review round
 * 4/7), now shared by every mutating, idempotent Sprint 3 endpoint.
 *
 * Why this matters: IdempotencyInterceptor's own post-handler write
 * (see its `switchMap`) happens in a *separate* Postgres statement
 * after the handler's transaction has already committed. If that
 * separate write then fails for any reason, the interceptor's
 * `catchError` marks the claim FAILED even though the resource was
 * genuinely created - and a retry with the same key re-runs the
 * handler, creating a *second* resource, for exactly the create-type
 * endpoints (categories, brands, canonical products/variants, vendor
 * offers/variants, ...) that have no other uniqueness constraint to
 * catch the duplicate. Calling this from inside the handler's own
 * transaction closes that gap: the resource and its "this Idempotency-
 * Key is done, here's the response" record either both commit or both
 * roll back together, and IdempotencyInterceptor's `current?.status ===
 * 'COMPLETED'` pre-check (already in place, added for password reset)
 * skips its own redundant write once it sees this one already landed.
 *
 * This is a real Nest provider - not a plain exported function - on
 * purpose (Sprint 3 review round 3): a plain function's Prisma call
 * runs through the *transaction-scoped* `tx` client, which is a
 * distinct object from the top-level `PrismaService` instance on every
 * call, so `jest.spyOn(prisma.idempotencyKey, 'update')` (the technique
 * already used elsewhere in this test suite for password reset) can
 * never intercept it - confirmed empirically, not assumed. Being an
 * injectable service instead makes it spy-able the same way
 * `AuditLogService.record` already is: `jest.spyOn(app.get(
 * IdempotencyCompletionService), 'complete')` intercepts at the method
 * boundary, before the call ever reaches `tx`.
 */
@Injectable()
export class IdempotencyCompletionService {
  /**
   * `responseBody` must be the exact, final, snake_case response shape
   * the route returns - a same-key replay serves this value verbatim,
   * not a re-derivation of it.
   *
   * A no-op when `claimId` is undefined (the route has no
   * IdempotencyInterceptor, or - defensively - this is called outside a
   * request that went through one).
   */
  async complete(
    tx: Prisma.TransactionClient,
    claimId: string | undefined,
    responseBody: unknown,
    responseCode: number,
    ttlMs: number = DEFAULT_IDEMPOTENCY_TTL_MS,
  ): Promise<void> {
    if (!claimId) {
      return;
    }
    await tx.idempotencyKey.update({
      where: { id: claimId },
      data: {
        status: 'COMPLETED',
        responseBody: (responseBody ?? {}) as Prisma.InputJsonValue,
        responseCode,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
  }
}
