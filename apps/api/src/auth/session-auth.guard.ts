import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from './session.service';

export interface AuthenticatedUser {
  id: string;
  phone: string;
  phoneVerifiedAt: string | null;
}

declare module 'express' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

/**
 * FR-AUTH-004: every protected route requires an authenticated,
 * phone-verified session - no guest access. Reads `Authorization:
 * Bearer <token>`, looks the token up in Redis (SessionService), and
 * attaches `req.user`. This is also what makes IdempotencyInterceptor's
 * per-user `scope` (common/idempotency/idempotency.interceptor.ts) real
 * once a route sits behind this guard, instead of the "anonymous"
 * placeholder every route used in Sprint 1.
 *
 * Every request also re-checks the session's sessionVersion against
 * the user's current one in Postgres (Sprint 2 review fix round 2).
 * Without this, "a password reset invalidates every other session"
 * was only true if revokeAllForUser()'s Redis deletes actually
 * succeeded - a fail-open gap if Redis was briefly unreachable at
 * reset time. The version check makes Postgres, which the password
 * update itself already durably commits to, the real security
 * boundary; Redis deletion is now just an optimization that makes a
 * stale session fail faster; it's no longer what makes it fail at all.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Authorization: Bearer <token> header is required',
      });
    }

    const session = await this.sessions.get(token);
    if (!session) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        message: 'Session is invalid or has expired',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: { sessionVersion: true },
    });
    if (!user || user.sessionVersion !== session.sessionVersion) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        message: 'Session is invalid or has expired',
      });
    }

    request.user = {
      id: session.userId,
      phone: session.phone,
      phoneVerifiedAt: session.phoneVerifiedAt,
    };
    return true;
  }
}
