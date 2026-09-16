import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h, per Part 4 H.1

/**
 * Applied via `@UseInterceptors(IdempotencyInterceptor)` on mutating
 * endpoints that create a financial/order-affecting resource (Part 4,
 * H.1 - checkout, payment capture, import commit, etc.). Not global:
 * most endpoints (reads, idempotent-by-nature actions) don't need it.
 *
 * A request without an Idempotency-Key header is rejected outright on
 * a decorated endpoint - silently proceeding without one would defeat
 * the point. A request replaying a previously-seen key gets the exact
 * original response, never reprocessed.
 *
 * The stored-response write is awaited (`switchMap`, not a
 * fire-and-forget `tap`) before the HTTP response completes - the same
 * "durable before acknowledged" principle Part 4's webhook contract
 * uses, and for the same reason: a fire-and-forget write here would
 * race a fast retry sent immediately after the first response, letting
 * it slip through and reprocess before the row was actually saved.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const key = request.header('Idempotency-Key');

    if (!key || key.trim().length === 0) {
      throw new UnprocessableEntityException({
        message: 'Idempotency-Key header is required for this endpoint',
      });
    }

    return from(this.prisma.idempotencyKey.findUnique({ where: { key } })).pipe(
      switchMap((existing) => {
        if (existing && existing.expiresAt > new Date()) {
          response.status(existing.responseCode);
          response.setHeader('Idempotent-Replayed', 'true');
          return from(Promise.resolve(existing.responseBody));
        }
        return next.handle().pipe(
          switchMap((body) =>
            from(
              this.prisma.idempotencyKey
                .upsert({
                  where: { key },
                  create: {
                    key,
                    requestPath: request.path,
                    responseBody: (body ?? {}) as object,
                    responseCode: response.statusCode,
                    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
                  },
                  update: {
                    responseBody: (body ?? {}) as object,
                    responseCode: response.statusCode,
                    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
                  },
                })
                .then(() => body),
            ),
          ),
        );
      }),
    );
  }
}
