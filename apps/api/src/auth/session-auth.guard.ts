import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PLATFORM_ROLES_KEY } from './platform-role.decorator';
import { PlatformRoleGuard } from './platform-role.guard';
import { SessionService } from './session.service';
import { VendorMembershipGuard } from './vendor-membership.guard';
import {
  readWorkspaceSession,
  sessionHash,
  WORKSPACE_HEADER,
  WORKSPACE_NEUTRAL_KEY,
} from './workspace-session';

export interface AuthenticatedUser {
  id: string;
  phone: string;
  phoneVerifiedAt: string | null;
}

declare module 'express' {
  interface Request {
    user?: AuthenticatedUser;
    /** TB-26: the validated session token, so a workspace token can be
     * checked against the session it was issued under. */
    sessionToken?: string;
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
    private readonly redis: RedisService,
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
      select: { sessionVersion: true, suspendedAt: true },
    });
    if (!user || user.sessionVersion !== session.sessionVersion) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        message: 'Session is invalid or has expired',
      });
    }
    // VIA phase 3: a suspended account is refused on every request, even
    // with a session issued after the suspension by some other sign-in path.
    if (user.suspendedAt) {
      throw new UnauthorizedException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This account is suspended by the platform',
      });
    }

    request.user = {
      id: session.userId,
      phone: session.phone,
      phoneVerifiedAt: session.phoneVerifiedAt,
    };
    request.sessionToken = token;
    await this.refuseWorkspaceOnShoppingRoute(context, request, token);
    return true;
  }

  /**
   * TB-26: SHOPPING_REQUIRED. A request that carries a LIVE workspace
   * token of this session is a store/platform-workspace request; it may
   * reach only workspace routes (VendorMembershipGuard, or
   * PlatformRoleGuard with a required role) and the few routes marked
   * @WorkspaceNeutral() (entering/leaving a workspace, the workspace
   * list, logout). Anything else - cart, checkout, the customer's
   * orders, returns, reviews, favorites, the shopping bell - is shopping
   * and is refused, so a workspace tab can never act as the customer.
   * No token (or one that is not this session's live token) changes
   * nothing: the session alone is shopping. Independent of the
   * workspace_scoping_enabled flag.
   */
  private async refuseWorkspaceOnShoppingRoute(
    context: ExecutionContext,
    request: Request,
    sessionToken: string,
  ): Promise<void> {
    const workspaceToken = request.header(WORKSPACE_HEADER);
    if (!workspaceToken) return;
    const handler = context.getHandler();
    const cls = context.getClass();
    const meta = (key: string) => [
      ...((Reflect.getMetadata(key, handler) as unknown[] | undefined) ?? []),
      ...((Reflect.getMetadata(key, cls) as unknown[] | undefined) ?? []),
    ];
    const guards = meta(GUARDS_METADATA);
    const roles = (Reflect.getMetadata(PLATFORM_ROLES_KEY, handler) ??
      []) as unknown[];
    const workspaceRoute =
      guards.includes(VendorMembershipGuard) ||
      (guards.includes(PlatformRoleGuard) && roles.length > 0);
    const neutral =
      Reflect.getMetadata(WORKSPACE_NEUTRAL_KEY, handler) === true ||
      Reflect.getMetadata(WORKSPACE_NEUTRAL_KEY, cls) === true;
    if (workspaceRoute || neutral) return;
    const ws = await readWorkspaceSession(this.redis, workspaceToken);
    if (
      ws &&
      ws.userId === request.user!.id &&
      ws.sessionHash === sessionHash(sessionToken)
    ) {
      throw new ForbiddenException({
        code: 'SHOPPING_REQUIRED',
        message:
          'This is a shopping action - leave the workspace (or use a shopping tab) to do it',
      });
    }
  }
}
