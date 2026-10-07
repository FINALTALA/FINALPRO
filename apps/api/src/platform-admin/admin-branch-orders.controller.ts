import {
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { PlatformRole, Prisma } from '../../generated/prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { BranchOrderCancellationService } from '../orders/branch-order-cancellation.service';
import { TERMINAL_BRANCH_ORDER_STATUSES } from '../orders/branch-order-state-machine';
import { AdminCancelBranchOrderDto } from '../orders/dto/admin-cancel-branch-order.dto';
import { AdminRefundBranchOrderDto } from '../orders/dto/admin-refund-branch-order.dto';

/**
 * Sprint 20a (BR-019, review-round requirement): PLATFORM_ADMIN's two
 * "break-glass" overrides on a BranchOrder - a forced cancel (any
 * non-terminal status) and a manual refund (ONLINE only, not tied to
 * cancelling anything). Neither ever accepts a manually-entered
 * amount or bypasses the refund-ledger/stock invariants
 * BranchOrderCancellationService already enforces for every other
 * trigger - the admin is simply an allowed `initiatedBy`/
 * `approvedByUserId`, never a shortcut around them.
 */
@Controller('admin/branch-orders')
@UseGuards(SessionAuthGuard, PlatformRoleGuard)
export class AdminBranchOrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cancellation: BranchOrderCancellationService,
    private readonly outbox: OutboxEventService,
  ) {}

  /** Customer of this BranchOrder, as a notification recipient - same
   * convention as BranchOrdersStaffController's own notifyCustomer. */
  private async notifyCustomer(
    tx: Prisma.TransactionClient,
    branchOrderId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const order = await tx.branchOrder.findUniqueOrThrow({
      where: { id: branchOrderId },
      include: {
        customerOrder: { include: { customer: { select: { userId: true } } } },
      },
    });
    await this.outbox.enqueue(
      {
        eventType,
        payload: {
          ...payload,
          recipient_user_id: order.customerOrder.customer.userId,
        },
      },
      tx,
    );
  }

  private async lockBranchOrder(
    tx: Prisma.TransactionClient,
    branchOrderId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
    const order = await tx.branchOrder.findUnique({
      where: { id: branchOrderId },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'BRANCH_ORDER_NOT_FOUND',
        message: 'Branch order not found',
      });
    }
    return order;
  }

  // Any non-terminal status. COD closes to CANCELLED with no refund
  // (nothing was ever charged); ONLINE refunds every active item + the
  // delivery fee and closes to REFUNDED, in the SAME transaction -
  // never a bare cancel that leaves an ONLINE customer's money
  // uncredited.
  @Post(':id/cancel')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async forceCancel(
    @Param('id') branchOrderId: string,
    @Body() dto: AdminCancelBranchOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockBranchOrder(tx, branchOrderId);
      if (
        (TERMINAL_BRANCH_ORDER_STATUSES as string[]).includes(order.status)
      ) {
        throw new NotFoundException({
          code: 'BRANCH_ORDER_ALREADY_TERMINAL',
          message: 'This branch order has already reached a terminal state',
        });
      }
      const r = await this.cancellation.adminForceCancel(
        tx,
        order,
        user.id,
        dto.reason,
        req.correlationId,
      );
      await this.notifyCustomer(tx, branchOrderId, 'branch_order.cancelled', {
        branch_order_id: branchOrderId,
        vendor_id: order.vendorId,
        branch_id: order.branchId,
        item_id: null,
      });
      return r;
    });
    return {
      id: branchOrderId,
      order_closed: result.orderClosed,
      refunded_amount: result.refundedAmount.toNumber(),
    };
  }

  // ONLINE only - never a COD order (nothing was ever charged online
  // to refund). Amount is always the server-computed remaining
  // refundable figure (total minus already refunded), never an
  // admin-entered one.
  @Post(':id/refund')
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async manualRefund(
    @Param('id') branchOrderId: string,
    @Body() dto: AdminRefundBranchOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockBranchOrder(tx, branchOrderId);
      const r = await this.cancellation.adminManualRefund(
        tx,
        order,
        user.id,
        dto.reason,
        req.correlationId,
      );
      await this.notifyCustomer(tx, branchOrderId, 'branch_order.refund_approved', {
        branch_order_id: branchOrderId,
        vendor_id: order.vendorId,
        branch_id: order.branchId,
      });
      return r;
    });
    return { id: branchOrderId, refunded_amount: result.refundedAmount.toNumber() };
  }
}
