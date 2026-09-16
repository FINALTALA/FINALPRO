import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
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
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

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

    request.user = {
      id: session.userId,
      phone: session.phone,
      phoneVerifiedAt: session.phoneVerifiedAt,
    };
    return true;
  }
}
