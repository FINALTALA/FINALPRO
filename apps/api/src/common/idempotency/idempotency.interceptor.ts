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
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h, per Part 4 H.1
const STALE_IN_PROGRESS_MS = 30_000; // abandon a claim if its owner never finished (e.g. crashed)

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
  ): Promise<
    | { outcome: 'claimed'; row: { id: string } }
    | {
        outcome: 'replay';
        row: { responseBody: unknown; responseCode: number | null };
      }
    | { outcome: 'conflict'; message: string }
  > {
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

    if (existing.status === 'IN_PROGRESS') {
      const ageMs = Date.now() - existing.createdAt.getTime();
      if (ageMs < STALE_IN_PROGRESS_MS) {
        return {
          outcome: 'conflict',
          message:
            'A request with this Idempotency-Key is already being processed',
        };
      }
      // The original claimant never finished (crashed, timed out) -
      // take over the claim rather than blocking this key forever.
      const takenOver = await this.prisma.idempotencyKey.update({
        where: { id: existing.id },
        data: { status: 'IN_PROGRESS', requestHash, createdAt: new Date() },
      });
      return { outcome: 'claimed', row: takenOver };
    }

    // status === 'COMPLETED' (or 'FAILED', which behaves the same as a
    // fresh claim attempt below since it never got a real response).
    if (existing.status === 'FAILED') {
      const retried = await this.prisma.idempotencyKey.update({
        where: { id: existing.id },
        data: { status: 'IN_PROGRESS', requestHash, createdAt: new Date() },
      });
      return { outcome: 'claimed', row: retried };
    }

    if (existing.requestHash !== requestHash) {
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
        responseCode: existing.responseCode,
      },
    };
  }
}
