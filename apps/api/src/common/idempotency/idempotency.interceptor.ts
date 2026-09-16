import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { Request, Response } from 'express';
import { Observable, from } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { IdempotencyKeyStatus, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IDEMPOTENCY_TTL_KEY } from './idempotency-ttl.decorator';

const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h, per Part 4 H.1
const STALE_IN_PROGRESS_MS = 30_000; // abandon a claim if its owner never finished (e.g. crashed)
const MAX_TAKEOVER_ATTEMPTS = 5; // bound retries if takeover attempts keep losing the CAS race

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({ method, path, body: body ?? null }))
    .digest('hex');
}

declare module 'express' {
  interface Request {
    /**
     * The current Idempotency-Key claim's row id, set right after a
     * successful claim/takeover, before the handler runs. Lets a
     * handler whose own success can't be captured by a simple return
     * value alone (e.g. one that must record completion inside its own
     * Prisma transaction - see AuthController.confirmPasswordReset)
     * write directly to this same IdempotencyKey row as part of that
     * transaction, rather than relying solely on this interceptor's own
     * separate post-handler write.
     */
    idempotencyClaimId?: string;
  }
}

/**
 * Scope for a mutating, idempotent endpoint that runs before a session
 * exists (POST /auth/otp/verify, POST /auth/password/reset-confirm -
 * both carry `phone` in their body). Hashed, not stored as plain text,
 * for the same reason correlation ids and idempotency keys don't
 * embed raw PII directly into an index key. Falls back to "anonymous"
 * only when the body has no phone at all (a route with neither a
 * session nor an identity-bearing body, e.g. health.echo).
 */
function derivePreAuthScope(body: unknown): string {
  const record = body as { phone?: unknown; purpose?: unknown } | undefined;
  const rawPhone = typeof record?.phone === 'string' ? record.phone : undefined;
  if (!rawPhone) {
    return 'anonymous';
  }
  const normalizedPhone = rawPhone.replace(/[\s-]/g, '');
  const purpose = typeof record?.purpose === 'string' ? record.purpose : '';
  return (
    'phone:' +
    createHash('sha256').update(`${normalizedPhone}:${purpose}`).digest('hex')
  );
}

interface IdempotencyRow {
  id: string;
  status: IdempotencyKeyStatus;
  createdAt: Date;
  requestHash: string;
  responseBody?: unknown;
  responseCode?: number | null;
}

type ClaimResult =
  | { outcome: 'claimed'; row: { id: string } }
  | {
      outcome: 'replay';
      row: { responseBody: unknown; responseCode: number | null };
    }
  | { outcome: 'conflict'; message: string };

/**
 * Applied via `@UseInterceptors(IdempotencyInterceptor)` on mutating
 * endpoints that create a financial/order-affecting resource (Part 4,
 * H.1). Not global: most endpoints (reads, idempotent-by-nature
 * actions) don't need it.
 *
 * The previous version of this interceptor did findUnique -> run
 * handler -> upsert. Two concurrent requests with the same key could
 * both pass the findUnique ("no existing row") before either reached
 * upsert, and both would run the handler - the exact race the
 * mechanism exists to prevent. Fixed here by making the *claim* atomic:
 * the request attempts to INSERT a row for (key, scope, requestPath)
 * and lets the database's unique constraint decide who wins when two
 * requests race. Only the winner runs the handler; the loser inspects
 * the winning row instead of proceeding.
 *
 * The initial claim being atomic wasn't sufficient on its own: the
 * *recovery* paths (taking over a stale IN_PROGRESS claim, or retrying
 * a FAILED one) were still read-then-write, so two requests racing to
 * take over the same abandoned claim could both succeed and both run
 * the handler. `attemptTakeover()` fixes this with a compare-and-swap
 * UPDATE instead. Those recovery paths also now check the payload hash
 * before taking over anything - a different payload against a stale or
 * failed claim is a conflict, not something to silently overwrite.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const key = request.header('Idempotency-Key');

    if (!key || key.trim().length === 0) {
      throw new UnprocessableEntityException({
        message: 'Idempotency-Key header is required for this endpoint',
      });
    }

    // Scope is the authenticated user where one exists (SessionAuthGuard
    // sets req.user, Part 4 H.1/EPIC-AUTH) so two different users can
    // never collide on the same client-chosen key. A handful of
    // mutating, idempotent endpoints run *before* a session exists
    // (POST /auth/otp/verify, POST /auth/password/reset-confirm) - for
    // those, falling back to a single "anonymous" scope would let two
    // unrelated callers who happen to reuse the same client-chosen key
    // collide with each other, which is exactly the bug Sprint 1's
    // move away from a global-only key was meant to prevent. derivePreAuthScope()
    // instead scopes by the request's own phone+purpose, so it isolates
    // callers by the identity they're establishing even before login.
    // "anonymous" only remains for a route with neither a session nor a
    // phone in its body (e.g. health.echo's demo endpoint).
    const authenticatedUserId = (request as { user?: { id?: string } }).user
      ?.id;
    const scope = authenticatedUserId ?? derivePreAuthScope(request.body);
    const requestPath = request.path;
    const requestHash = hashRequest(request.method, requestPath, request.body);
    const ttlMs =
      this.reflector.get<number>(IDEMPOTENCY_TTL_KEY, context.getHandler()) ??
      DEFAULT_IDEMPOTENCY_TTL_MS;

    const claim = await this.claimOrInspect(
      key,
      scope,
      requestPath,
      requestHash,
      ttlMs,
    );

    if (claim.outcome === 'replay') {
      response.status(claim.row.responseCode ?? 200);
      response.setHeader('Idempotent-Replayed', 'true');
      return from(Promise.resolve(claim.row.responseBody));
    }

    if (claim.outcome === 'conflict') {
      throw new ConflictException({ message: claim.message });
    }

    // We hold the claim (claim.outcome === 'claimed'): run the handler,
    // then durably record the result before the response completes -
    // same "durable before acknowledged" principle as Part 4's webhook
    // contract, and for the same reason: a fire-and-forget write here
    // would let a fast retry slip past an unrecorded completion.
    const claimId = claim.row.id;
    request.idempotencyClaimId = claimId;
    return next.handle().pipe(
      switchMap((body) =>
        from(
          this.prisma.idempotencyKey
            .findUnique({ where: { id: claimId }, select: { status: true } })
            .then((current) => {
              if (current?.status === 'COMPLETED') {
                // The handler already recorded its own completion as
                // part of a transaction it controlled (see
                // request.idempotencyClaimId's doc comment) - nothing
                // left for us to do. Writing again here would be
                // redundant at best; if THIS write then failed, the
                // catchError below would mark an already-legitimately-
                // COMPLETED record FAILED, reintroducing the exact
                // "retry can't recover" bug this whole mechanism exists
                // to prevent.
                return body;
              }
              return this.prisma.idempotencyKey
                .update({
                  where: { id: claimId },
                  data: {
                    status: 'COMPLETED',
                    responseBody: (body ?? {}) as Prisma.InputJsonValue,
                    responseCode: response.statusCode,
                    completedAt: new Date(),
                    expiresAt: new Date(Date.now() + ttlMs),
                  },
                })
                .then(() => body);
            }),
        ),
      ),
      catchError((err) =>
        from(
          this.prisma.idempotencyKey
            .update({ where: { id: claimId }, data: { status: 'FAILED' } })
            .catch(() => undefined) // don't let a bookkeeping failure mask the real error
            .then(() => {
              throw err;
            }),
        ),
      ),
    );
  }

  private async claimOrInspect(
    key: string,
    scope: string,
    requestPath: string,
    requestHash: string,
    ttlMs: number,
  ): Promise<ClaimResult> {
    try {
      const row = await this.prisma.idempotencyKey.create({
        data: {
          key,
          scope,
          requestPath,
          requestHash,
          status: 'IN_PROGRESS',
          expiresAt: new Date(Date.now() + ttlMs),
        },
      });
      return { outcome: 'claimed', row };
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
    }

    // Lost the race (or this key/scope/path was already used before) -
    // look at what's actually there now.
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { idempotency_lookup: { key, scope, requestPath } },
    });

    if (!existing) {
      // Vanishingly unlikely (the row that caused our unique-violation
      // was deleted between the failed insert and this read) - safest
      // is to say try again rather than silently double-processing.
      return {
        outcome: 'conflict',
        message: 'Could not resolve this Idempotency-Key, please retry',
      };
    }

    return this.evaluateExisting(existing, requestHash, 0);
  }

  /**
   * Decides what to do with whatever row currently sits at this
   * (key, scope, requestPath): replay it, reject it as a conflict, or -
   * only for a stale IN_PROGRESS or FAILED row whose payload matches -
   * take it over and run the handler again.
   *
   * The payload check (requestHash) happens BEFORE any takeover, for
   * every non-fresh status, not only COMPLETED. A stale or failed claim
   * still belongs to whichever request originally created it; a
   * *different* payload arriving under the same key is a genuine
   * conflict (Part 4, H.1's "same key, different payload = 409" rule)
   * regardless of what state that original claim is in - it is never
   * grounds to overwrite it.
   */
  private async evaluateExisting(
    existing: IdempotencyRow,
    requestHash: string,
    attempt: number,
  ): Promise<ClaimResult> {
    const hashMatches = existing.requestHash === requestHash;

    if (existing.status === 'IN_PROGRESS') {
      const ageMs = Date.now() - existing.createdAt.getTime();
      const isStale = ageMs >= STALE_IN_PROGRESS_MS;

      if (!isStale) {
        // A genuinely concurrent request for the *same* payload isn't a
        // conflict, just a race that hasn't resolved yet - say so
        // explicitly so the caller knows to retry unchanged rather than
        // treat this like a real conflict. A different payload while
        // the original is still in flight is a real conflict.
        return {
          outcome: 'conflict',
          message: hashMatches
            ? 'A request with this Idempotency-Key is already being processed. Retry this identical request after a few seconds.'
            : 'This Idempotency-Key is currently being processed with a different request body. Wait for it to complete, or use a new Idempotency-Key.',
        };
      }

      if (!hashMatches) {
        return {
          outcome: 'conflict',
          message:
            'This Idempotency-Key was already used with a different request',
        };
      }

      // The original claimant never finished (crashed, timed out) and
      // the payload matches - take over the claim rather than blocking
      // this key forever.
      return this.attemptTakeover(existing, requestHash, attempt);
    }

    if (existing.status === 'FAILED') {
      if (!hashMatches) {
        return {
          outcome: 'conflict',
          message:
            'This Idempotency-Key was already used with a different request',
        };
      }
      return this.attemptTakeover(existing, requestHash, attempt);
    }

    // status === 'COMPLETED'
    if (!hashMatches) {
      return {
        outcome: 'conflict',
        message:
          'This Idempotency-Key was already used with a different request',
      };
    }

    return {
      outcome: 'replay',
      row: {
        responseBody: existing.responseBody,
        responseCode: existing.responseCode ?? null,
      },
    };
  }

  /**
   * Retakes a stale IN_PROGRESS or FAILED claim atomically. The
   * UPDATE's WHERE clause pins the row's id *and* the exact status and
   * createdAt we just read, so Postgres only applies it if nothing else
   * has touched the row since - a compare-and-swap, not a read-then-
   * write. Two requests racing to take over the same stale claim can
   * both read it, but only the first UPDATE to actually reach Postgres
   * changes the row; the second's WHERE clause is re-evaluated against
   * the now-changed row, no longer matches, and affects zero rows.
   */
  private async attemptTakeover(
    existing: IdempotencyRow,
    requestHash: string,
    attempt: number,
  ): Promise<ClaimResult> {
    const result = await this.prisma.idempotencyKey.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
        createdAt: existing.createdAt,
      },
      data: { status: 'IN_PROGRESS', requestHash, createdAt: new Date() },
    });

    if (result.count === 1) {
      return { outcome: 'claimed', row: { id: existing.id } };
    }

    // Lost the compare-and-swap to another concurrent takeover attempt.
    // Don't assume what changed - re-read the row and re-evaluate
    // against whatever is actually there now.
    if (attempt >= MAX_TAKEOVER_ATTEMPTS) {
      return {
        outcome: 'conflict',
        message: 'Could not resolve this Idempotency-Key claim, please retry',
      };
    }

    const fresh = await this.prisma.idempotencyKey.findUnique({
      where: { id: existing.id },
    });
    if (!fresh) {
      return {
        outcome: 'conflict',
        message: 'Could not resolve this Idempotency-Key, please retry',
      };
    }
    return this.evaluateExisting(fresh, requestHash, attempt + 1);
  }
}
