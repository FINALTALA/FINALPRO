import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { ActorSnapshot, runWithAuditActor } from '../audit/audit-actor-context';
import { PrismaService } from '../prisma/prisma.service';

/**
 * «إدارة طلبات الفرع v1» (2026-11-22): for every request served by the
 * store's order actions (BranchOrdersStaffController) and the platform's
 * break-glass order actions (AdminBranchOrdersController), records who is
 * acting AS THEY ARE NOW - the membership the guard just read fresh (role
 * + branch) or the platform role, and the display name - so every
 * branch-order audit row this request writes keeps it (see
 * audit-actor-context.ts). It changes nothing else: no response, no
 * decision, no status, stock, money or notification.
 *
 * Runs after the guards (the membership is already on the request) and
 * around the handler, the method-level interceptors (idempotency) inside
 * it. A request without a user is passed through untouched.
 */
@Injectable()
export class OrderActorContextInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.user?.id;
    if (!userId) return next.handle();
    return new Observable((subscriber) => {
      let inner: { unsubscribe: () => void } | null = null;
      let closed = false;
      this.snapshotFor(req, userId)
        .then((snapshot) => {
          if (closed) return;
          const run = () => {
            inner = next.handle().subscribe(subscriber);
          };
          if (snapshot) runWithAuditActor(snapshot, run);
          else run();
        })
        .catch((err: unknown) => subscriber.error(err));
      return () => {
        closed = true;
        inner?.unsubscribe();
      };
    });
  }

  private async snapshotFor(
    req: Request,
    userId: string,
  ): Promise<ActorSnapshot | null> {
    const profile = await this.prisma.customerProfile.findUnique({
      where: { userId },
      select: { displayName: true },
    });
    const displayName = profile?.displayName?.trim() || null;
    const membership = req.vendorMembership;
    if (membership) {
      return {
        v: 1,
        user_id: userId,
        role: membership.role === 'OWNER' ? 'OWNER' : 'BRANCH_EMPLOYEE',
        branch_id: membership.role === 'OWNER' ? null : membership.branchId,
        display_name: displayName,
      };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { platformRole: true },
    });
    if (!user?.platformRole) return null;
    return {
      v: 1,
      user_id: userId,
      role: 'PLATFORM_STAFF',
      branch_id: null,
      display_name: displayName,
    };
  }
}
