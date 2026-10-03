import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export const BLOCK_WHEN_BRANCH_ARCHIVED_KEY = 'blockWhenBranchArchived';

@Injectable()
export class BranchArchivedGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const blocked =
      this.reflector.get<boolean>(
        BLOCK_WHEN_BRANCH_ARCHIVED_KEY,
        context.getHandler(),
      ) ??
      this.reflector.get<boolean>(
        BLOCK_WHEN_BRANCH_ARCHIVED_KEY,
        context.getClass(),
      );
    if (!blocked) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const branchId = request.params?.branchId as string | undefined;
    if (!branchId) return true;

    // Best-effort at request start, same accepted semantics as
    // VendorSuspendedGuard: this refuses any request that STARTS after
    // the archive already committed. A write already past this guard
    // (in-flight, inside its own transaction) when the archive commits
    // is allowed to complete - the same already-accepted "in-progress
    // completes, every later request is refused" behavior as employee
    // suspension. This is NOT the real guarantee against a genuine
    // race with a concurrently-committing archive - that guarantee is
    // the shared branch-operational-status advisory lock each of
    // submitEvidence/verification-decision/archive itself takes (see
    // branch-operational-lock.util.ts); this guard only ever needed to
    // close that race for THOSE two specific endpoints, since an
    // orphaned pending-evidence row is a structurally worse
    // inconsistency than one extra stock movement slipping through a
    // moment after archival.
    const branch = await this.prisma.storeBranch.findUnique({
      where: { id: branchId },
      select: { archivedAt: true },
    });
    if (branch?.archivedAt !== null && branch?.archivedAt !== undefined) {
      throw new ForbiddenException({
        code: 'BRANCH_ARCHIVED',
        message: 'This branch is archived and cannot make this change',
      });
    }
    return true;
  }
}

/**
 * Sprint 18b (G-ON-07): marks a `:branchId`-scoped route as one an
 * archived branch may NOT call (new stock movements, confirm-count,
 * safety-stock, staff invites, operating-hours edits, closures,
 * delivery-window setup, verification evidence/decision, archive
 * itself). Routes without it stay open - reads, and completing an
 * order/fulfilment action that already exists (there can be none left
 * non-terminal by the time archive succeeds - see archive()'s own
 * rejection checks - but classified ALLOW anyway for the same reason
 * those actions are always ALLOW). The complete deny/allow
 * classification lives in branch-archived-route-classification.ts and
 * is enforced by a test that fails on any unclassified `:branchId`
 * route, mirroring vendor-route-classification.ts exactly.
 */
export const BlockWhenBranchArchived = () =>
  applyDecorators(
    SetMetadata(BLOCK_WHEN_BRANCH_ARCHIVED_KEY, true),
    UseGuards(BranchArchivedGuard),
  );
