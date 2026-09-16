import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Request, Response } from 'express';
import { Observable, from } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { IdempotencyKeyStatus, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h, per Part 4 H.1
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
  constructor(private readonly prisma: PrismaService) {}

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

    // Scope is the acting user once EPIC-AUTH lands (Sprint 2) and sets
    // req.user; "anonymous" is a deliberate, temporary placeholder for
    // Foundation's unauthenticated demo endpoint only - a real mutating
    // endpoint must not ship without a real scope here, since two
    // different anonymous callers would otherwise share one scope and
    // could collide on the same client-chosen key.
    const scope =
      (request as { user?: { id?: string } }).user?.id ?? 'anonymous';
    const requestPath = request.path;
    const requestHash = hashRequest(request.method, requestPath, request.body);

    const claim = await this.claimOrInspect(
      key,
      scope,
      requestPath,
      requestHash,
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
    return next.handle().pipe(
      switchMap((body) =>
        from(
          this.prisma.idempotencyKey
            .update({
              where: { id: claimId },
              data: {
                status: 'COMPLETED',
                responseBody: (body ?? {}) as Prisma.InputJsonValue,
                responseCode: response.statusCode,
                completedAt: new Date(),
                expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
              },
            })
            .then(() => body),
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
  ): Promise<ClaimResult> {
    try {
      const row = await this.prisma.idempotencyKey.create({
        data: {
          key,
          scope,
          requestPath,
          requestHash,
          status: 'IN_PROGRESS',
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
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
