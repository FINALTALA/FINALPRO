import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { BranchOrderQueueService } from './branch-order-queue.service';
import { BranchOrderQueueQueryDto } from './dto/branch-order-queue-query.dto';

/**
 * «إدارة طلبات الفرع v1» (2026-11-22): the branch's operating queue, one
 * order's details and its timeline. Reads only (see the service for the
 * one existing reconciliation the queue keeps). The same boundary as every
 * order action: VendorMembershipGuard refuses an employee of another
 * branch (403), and an order of another vendor or branch is 404 - the
 * service re-reads it against both route params.
 *
 * The owner sees her wider view (totals, prices, refund figures, the «لم
 * يصل» reason, the cancellation reason, every actor's name); an employee
 * the operational one (the amount to collect, never the original total).
 * No store DTO here carries the pickup code - it is only ever checked.
 */
@Controller('vendors/:vendorId/branches/:branchId/order-queue')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class BranchOrderQueueController {
  constructor(private readonly queue: BranchOrderQueueService) {}

  private viewer(req: Request, user: AuthenticatedUser) {
    return { userId: user.id, membership: req.vendorMembership! };
  }

  @Get()
  list(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Query() query: BranchOrderQueueQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.queue.list(
      vendorId,
      branchId,
      this.viewer(req, user),
      {
        tab: query.tab,
        method: query.method,
        late: query.late === 'true',
        q: query.q,
        date: query.date,
        window: query.window,
        branch: undefined,
        sort: query.sort,
        cursor: query.cursor,
        limit: query.limit ? Number(query.limit) : undefined,
      },
      req.correlationId,
    );
  }

  @Get(':branchOrderId')
  detail(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('branchOrderId') branchOrderId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.queue.detail(
      vendorId,
      branchId,
      branchOrderId,
      this.viewer(req, user),
    );
  }

  @Get(':branchOrderId/timeline')
  timeline(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('branchOrderId') branchOrderId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.queue.timeline(
      vendorId,
      branchId,
      branchOrderId,
      this.viewer(req, user),
    );
  }
}

/**
 * The owner's queue of EVERY branch of the store («كل الفروع» in the branch
 * orders board): the same queue, counts and filters, each row with its
 * branch, plus ?branch= to narrow to one. OWNER only - a branch employee
 * gets 403 (the guard, and the service again).
 */
@Controller('vendors/:vendorId/order-queue')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class VendorOrderQueueController {
  constructor(private readonly queue: BranchOrderQueueService) {}

  @Get()
  @RequireVendorRole('OWNER')
  list(
    @Param('vendorId') vendorId: string,
    @Query() query: BranchOrderQueueQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.queue.list(
      vendorId,
      null,
      { userId: user.id, membership: req.vendorMembership! },
      {
        tab: query.tab,
        method: query.method,
        late: query.late === 'true',
        q: query.q,
        date: query.date,
        window: query.window,
        branch: query.branch,
        sort: query.sort,
        cursor: query.cursor,
        limit: query.limit ? Number(query.limit) : undefined,
      },
      req.correlationId,
    );
  }
}
