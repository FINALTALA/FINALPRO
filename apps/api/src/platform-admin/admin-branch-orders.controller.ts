import {
  Body,
  ConflictException,
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
import { AdminCancelBranchOrderDto } from '../orders/dto/admin-cancel-branch-order.dto';

/**
 * Sprint 20a (BR-019, review-round requirement): PLATFORM_ADMIN's
 * "break-glass" override on a BranchOrder - a forced cancel, PLACED or
 * PREPARING only.
 *
 * Review-round fix (2026-10-08): this controller originally also
 * exposed a manual partial-refund endpoint, independent of cancelling
 * anything, capped only at computeRemainingRefundable()'s own
 * "structural ceiling." That ceiling was never actually structural -
 * nothing stopped a LATER cancelSingleItem()/cancelWholeOrder() call
 * on the same order from creating its own item refund rows on top of
 * an already-recorded, unallocated manual refund, pushing the sum past
 * BranchOrder.total. A correct fix needs a real allocation ledger
 * tying a manual refund to specific items/the delivery fee - genuine
 * S21 scope, not S20a - so the endpoint/service method/DTO/admin UI
 * for it are removed outright here rather than patched.
 *
 * Forced cancel itself is narrowed to PLACED/PREPARING for the same
 * underlying reason stock restoration is unsafe past that point: once
 * SENT, the physical goods may already be out of the branch (or, for
 * PICKED_UP/DELIVERED, already in the customer's hands) - incrementing
 * BranchStock.quantity back up without a real, confirmed stock-return
 * event would silently fabricate inventory. DELIVERY_FAILED and
 * REFUND_REQUESTED are excluded for the same reason even though the
 * state machine's own count-gated rules would otherwise permit some of
 * them - this controller enforces its OWN, simpler, unconditional
 * PLACED/PREPARING-only rule rather than relying on those nuances.
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

  // PLACED/PREPARING only (see this controller's own top comment for
  // why SENT and later are excluded, even where the state machine's
  // own count-gated rules would otherwise permit a target). COD closes
  // to CANCELLED with no refund (nothing was ever charged); ONLINE
  // refunds every active item + the delivery fee and closes to
  // REFUNDED, in the SAME transaction - never a bare cancel that
  // leaves an ONLINE customer's money uncredited.
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
      if (order.status !== 'PLACED' && order.status !== 'PREPARING') {
        throw new ConflictException({
          code: 'INVALID_BRANCH_ORDER_TRANSITION',
          message: `This action is not available while the order is ${order.status}`,
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
}
