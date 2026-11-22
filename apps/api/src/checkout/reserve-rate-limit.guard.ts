import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const WINDOW_SECONDS = 60;
const DEFAULT_LIMIT = 10;

/**
 * TB-5 (D4): at most 10 NEW reserve attempts per signed-in user per
 * minute - a light brake on scripted re-reserving. Runs after
 * SessionAuthGuard, so it counts per user (the global throttler only
 * sees the IP). A retry of a request this user already sent (same
 * Idempotency-Key on this path - the interceptor replays it, or reports
 * it still in progress) is never counted or refused: the limit only
 * applies to attempts that could create a reservation.
 *
 * RESERVE_RATE_LIMIT_PER_MINUTE overrides the limit (the e2e suites,
 * which reserve far more often than any shopper, raise it).
 */
@Injectable()
export class ReserveRateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = (request as { user?: { id?: string } }).user?.id;
    if (!userId) return true; // SessionAuthGuard already decided.

    const key = request.header('Idempotency-Key')?.trim();
    if (key) {
      const seen = await this.prisma.idempotencyKey.findUnique({
        where: {
          idempotency_lookup: { key, scope: userId, requestPath: request.path },
        },
        select: { id: true },
      });
      if (seen) return true;
    }

    const limit =
      Number(process.env.RESERVE_RATE_LIMIT_PER_MINUTE) || DEFAULT_LIMIT;
    const bucket = `rate:checkout-reserve:${userId}`;
    const attempts = await this.redis.incr(bucket);
    if (attempts === 1) await this.redis.expire(bucket, WINDOW_SECONDS);
    if (attempts > limit) {
      throw new HttpException(
        {
          code: 'RESERVE_RATE_LIMITED',
          message: 'Too many checkout attempts - please wait a minute',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
