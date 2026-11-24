import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { BranchReturnQueueService } from './branch-return-queue.service';
import { ReturnQueueQueryDto } from './dto/return-queue-query.dto';

function queryOf(q: ReturnQueueQueryDto, withBranch: boolean) {
  return {
    tab: q.tab,
    outcome: q.outcome,
    from: q.from,
    to: q.to,
    q: q.q,
    branch: withBranch ? q.branch : undefined,
    cursor: q.cursor,
    limit: q.limit ? Number(q.limit) : undefined,
  };
}

/**
 * IX-P2 «لوحة إرجاعات الفرع» (2026-11-23): the branch's returns board, one
 * return's details and its timeline - reads only. The same boundary as the
 * decision endpoint: VendorMembershipGuard refuses an employee of another
 * branch (403); a return of another vendor or branch is 404. No answer here
 * carries the raw return code (IX-P1).
 */
@Controller('vendors/:vendorId/branches/:branchId/return-queue')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class BranchReturnQueueController {
  constructor(private readonly queue: BranchReturnQueueService) {}

  private viewer(req: Request, user: AuthenticatedUser) {
    return { userId: user.id, membership: req.vendorMembership! };
  }

  @Get()
  list(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Query() query: ReturnQueueQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.queue.list(
      vendorId,
      branchId,
      this.viewer(req, user),
      queryOf(query, false),
    );
  }

  @Get(':returnId')
  detail(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('returnId') returnId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.queue.detail(
      vendorId,
      branchId,
      returnId,
      this.viewer(req, user),
    );
  }

  @Get(':returnId/timeline')
  timeline(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('returnId') returnId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.queue.timeline(
      vendorId,
      branchId,
      returnId,
      this.viewer(req, user),
    );
  }
}

/**
 * The owner's returns of EVERY branch («كل الفروع»): the same board, each row
 * with its branch, plus ?branch= to narrow to one. OWNER only - a branch
 * employee gets 403 (the guard, and the service again).
 */
@Controller('vendors/:vendorId/return-queue')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class VendorReturnQueueController {
  constructor(private readonly queue: BranchReturnQueueService) {}

  @Get()
  @RequireVendorRole('OWNER')
  list(
    @Param('vendorId') vendorId: string,
    @Query() query: ReturnQueueQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.queue.list(
      vendorId,
      null,
      { userId: user.id, membership: req.vendorMembership! },
      queryOf(query, true),
    );
  }
}
