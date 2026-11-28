import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days - a reasonable default; not specified by the SRS
const SESSION_KEY_PREFIX = 'session:';
const USER_SESSIONS_KEY_PREFIX = 'user_sessions:';

export interface SessionData {
  userId: string;
  phone: string;
  phoneVerifiedAt: string | null;
  /**
   * The user's User.sessionVersion at the moment this session was
   * issued. SessionAuthGuard compares this against the user's CURRENT
   * version on every request and rejects a mismatch - this is what
   * makes session invalidation on password reset actually
   * security-guaranteed rather than best-effort: it holds even if
   * revokeAllForUser() below never ran (e.g. Redis was down at reset
   * time), because the guard's check is a Postgres read, not a Redis
   * lookup for a deleted key.
   */
  sessionVersion: number;
}

/**
 * Server-side sessions in Redis (Part 6, M.2's architecture table
 * assigns "session storage" to Redis, not a stateless JWT) - chosen
 * deliberately over JWT so a password reset can actually revoke a
 * user's other sessions (revokeAllForUser), which a stateless token
 * can't do without a separate blocklist anyway.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly redis: RedisService,
    // VIA phase 3: optional only so the Redis-only unit spec can build it
    // by hand; Nest always injects the (global) PrismaService.
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async create(data: SessionData): Promise<string> {
    // VIA phase 3: every sign-in path (login, sign-up, password reset,
    // reactivation, phone change) issues its session here, so a platform
    // suspension is refused at the one issuance point. A suspension that
    // commits just after this check still ends the session: it bumps
    // sessionVersion, and SessionAuthGuard re-checks both on each request.
    if (this.prisma) {
      const account = await this.prisma.user.findUnique({
        where: { id: data.userId },
        select: { suspendedAt: true },
      });
      if (account?.suspendedAt) {
        throw new ForbiddenException({
          code: 'ACCOUNT_SUSPENDED',
          message: 'This account is suspended by the platform',
        });
      }
    }
    const token = randomBytes(32).toString('base64url');
    await this.redis
      .multi()
      .set(
        SESSION_KEY_PREFIX + token,
        JSON.stringify(data),
        'EX',
        SESSION_TTL_SECONDS,
      )
      .sadd(USER_SESSIONS_KEY_PREFIX + data.userId, token)
      .expire(USER_SESSIONS_KEY_PREFIX + data.userId, SESSION_TTL_SECONDS)
      .exec();
    return token;
  }

  async get(token: string): Promise<SessionData | null> {
    const raw = await this.redis.get(SESSION_KEY_PREFIX + token);
    return raw ? (JSON.parse(raw) as SessionData) : null;
  }

  /**
   * Revokes exactly one session (logout). Other sessions of the same
   * user, and every other user's sessions, are untouched. Deleting an
   * already-absent key is a harmless no-op, so this is naturally
   * idempotent.
   */
  async revoke(token: string, userId: string): Promise<void> {
    await this.redis
      .multi()
      .del(SESSION_KEY_PREFIX + token)
      .srem(USER_SESSIONS_KEY_PREFIX + userId, token)
      .exec();
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const setKey = USER_SESSIONS_KEY_PREFIX + userId;
    const tokens = await this.redis.smembers(setKey);
    if (tokens.length === 0) {
      return;
    }
    const pipeline = this.redis.multi();
    for (const token of tokens) {
      pipeline.del(SESSION_KEY_PREFIX + token);
    }
    pipeline.del(setKey);
    await pipeline.exec();
  }
}
