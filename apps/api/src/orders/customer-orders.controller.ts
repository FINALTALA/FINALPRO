import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { BranchOrderCancellationService } from './branch-order-cancellation.service';
import {
  computeAmountDue,
  computeAmountRefunded,
  computeRemainingRefundable,
} from './branch-order-money.util';
import { BranchOrderRescheduleService } from './branch-order-reschedule.service';
import { BranchOrderService } from './branch-order.service';
import { CancelBranchOrderDto } from './dto/cancel-branch-order.dto';
import { ReportNotReceivedDto } from './dto/report-not-received.dto';
import { RescheduleBranchOrderDto } from './dto/reschedule-branch-order.dto';
import { FulfilmentReconciliationService } from './fulfilment-reconciliation.service';

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

const ORDER_INCLUDE = {
  vendor: { select: { displayName: true, legalName: true, slug: true } },
  branch: { select: { name: true } },
  customerOrder: { select: { customerId: true } },
  address: true,
  deliveryWindow: {
    select: { dayOfWeek: true, startMinute: true, endMinute: true },
  },
  items: {
    include: {
      offerVariant: {
        select: {
          sellerSku: true,
          vendorOffer: { select: { titleAr: true, titleEn: true } },
        },
      },
    },
  },
  refunds: true,
} as const;

type OrderRow = Prisma.BranchOrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

function orderDto(o: OrderRow) {
  const amountRefunded = computeAmountRefunded(o.refunds);
  const hasDeliveryFeeRefund = o.refunds.some((r) => r.reason === 'DELIVERY_FEE');
  return {
    id: o.id,
    vendor_id: o.vendorId,
    vendor_display_name: o.vendor.displayName ?? o.vendor.legalName,
    vendor_slug: o.vendor.slug,
    branch_id: o.branchId,
    branch_name: o.branch.name,
    status: o.status,
    fulfilment_method: o.fulfilmentMethod,
    payment_method: o.paymentMethod,
    delivery_attempt_count: o.deliveryAttemptCount,
    items: o.items.map((i) => ({
      id: i.id,
      offer_variant_id: i.offerVariantId,
      title_ar: i.offerVariant.vendorOffer.titleAr,
      title_en: i.offerVariant.vendorOffer.titleEn,
      seller_sku: i.offerVariant.sellerSku,
      quantity: i.quantity,
      unit_price: Number(i.unitPrice),
      cancelled_at: i.cancelledAt?.toISOString() ?? null,
    })),
    // Sprint 20a (review-round requirement): subtotal/delivery_fee/
    // total are ALWAYS the original, immutable values - never
    // recomputed after a cancellation. amount_due/amount_refunded/
    // amount_refundable_remaining are computed fresh on every read
    // instead (branch-order-money.util.ts).
    subtotal: Number(o.subtotal),
    delivery_fee: o.deliveryFee !== null ? Number(o.deliveryFee) : null,
    total: Number(o.total),
    amount_due:
      o.paymentMethod === 'COD'
        ? computeAmountDue(
            o.total,
            o.items,
            hasDeliveryFeeRefund,
            o.deliveryFee,
          ).toNumber()
        : null,
    amount_refunded: o.paymentMethod === 'ONLINE' ? amountRefunded.toNumber() : null,
    amount_refundable_remaining:
      o.paymentMethod === 'ONLINE'
        ? computeRemainingRefundable(o.total, o.refunds).toNumber()
        : null,
    cancellation_reason: o.cancellationReason,
    delivery_failed_at: o.deliveryFailedAt?.toISOString() ?? null,
    slot_missed_at: o.slotMissedAt?.toISOString() ?? null,
    cod_collected_amount:
      o.codCollectedAmount !== null ? Number(o.codCollectedAmount) : null,
    cod_collected_at: o.codCollectedAt?.toISOString() ?? null,
    scheduled_date: o.scheduledDate
      ? o.scheduledDate.toISOString().slice(0, 10)
      : null,
    delivery_window: o.deliveryWindow
      ? {
          day_of_week: o.deliveryWindow.dayOfWeek,
          start_time: minutesToTime(o.deliveryWindow.startMinute),
          end_time: minutesToTime(o.deliveryWindow.endMinute),
        }
      : null,
    // The customer's own order - their own saved address, never a
    // leak (contrast BranchOrdersStaffController, which never includes
    // this).
    address: o.address
      ? {
          label: o.address.label,
          lat: o.address.lat,
          lng: o.address.lng,
          landmark_note: o.address.landmarkNote,
          phone_number_1: o.address.phoneNumber1,
          phone_number_2: o.address.phoneNumber2,
          zone: o.address.zone,
        }
      : null,
    pickup_code: o.fulfilmentMethod === 'PICKUP' ? o.pickupCode : null,
    delivered_at: o.deliveredAt?.toISOString() ?? null,
    not_received_reported_at: o.notReceivedReportedAt?.toISOString() ?? null,
    not_received_reason: o.notReceivedReason,
    confirm_reminder_sent_at: o.confirmReminderSentAt?.toISOString() ?? null,
    created_at: o.createdAt.toISOString(),
  };
}

// Sprint 11 (RB-ORD-005, RB-FUL-002): the customer's own cross-store
// Orders experience - PDR-026/§3.4's "customer sees all their
// BranchOrders across stores in one Orders experience," rendered as
// one card per BranchOrder (never merging two branches of the same
// store, matching PDR-026: "different branches never share a
// delivery/fee/status even if they belong to one store"). Every read
// and action below is scoped to THIS customer's own orders only - a
// 404, not a 403, for anything that belongs to someone else, matching
// this codebase's established ownership-check convention (e.g.
// CheckoutController's reservation ownership checks).
@Controller('customers/me/orders')
@UseGuards(SessionAuthGuard)
export class CustomerOrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly branchOrderService: BranchOrderService,
    private readonly cancellation: BranchOrderCancellationService,
    private readonly reschedule: BranchOrderRescheduleService,
    private readonly reconciliation: FulfilmentReconciliationService,
    private readonly outbox: OutboxEventService,
  ) {}

  private async requireCustomerId(user: AuthenticatedUser): Promise<string> {
    const profile = await this.prisma.customerProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });
    return profile.id;
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const customerId = await this.requireCustomerId(user);

    // Sweep any of this customer's DELIVERED orders that are due a
    // reminder/auto-confirm BEFORE building the response, so the list
    // reflects fresh state - see FulfilmentReconciliationService's own
    // comment for why this is lazy, not a real scheduler.
    const candidateIds = (
      await this.prisma.branchOrder.findMany({
        where: {
          customerOrder: { customerId },
          status: 'DELIVERED',
          deliveredAt: { not: null },
        },
        select: { id: true },
      })
    ).map((o) => o.id);
    await this.reconciliation.reconcileMany(candidateIds, req.correlationId);

    const orders = await this.prisma.branchOrder.findMany({
      where: { customerOrder: { customerId } },
      orderBy: { createdAt: 'desc' },
      include: ORDER_INCLUDE,
    });
    return orders.map(orderDto);
  }

  private async requireOwnBranchOrder(
    customerId: string,
    branchOrderId: string,
  ) {
    const order = await this.prisma.branchOrder.findUnique({
      where: { id: branchOrderId },
      include: ORDER_INCLUDE,
    });
    if (!order || order.customerOrder.customerId !== customerId) {
      throw new NotFoundException({
        code: 'BRANCH_ORDER_NOT_FOUND',
        message: 'Branch order not found',
      });
    }
    return order;
  }

  // PDR-026: "The customer then confirms delivery in the Orders UI."
  // DELIVERY only - a PICKUP order's own handover already IS its
  // confirmation (see branch-order-state-machine.ts's own comment on
  // PICKED_UP -> COMPLETED), so there is nothing for the customer to
  // confirm there.
  @Post(':branchOrderId/confirm-received')
  async confirmReceived(
    @CurrentUser() user: AuthenticatedUser,
    @Param('branchOrderId') branchOrderId: string,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    await this.requireOwnBranchOrder(customerId, branchOrderId);
    // Catch up first (e.g. the 72h auto-confirm may already be due) -
    // if that already completes the order, the transition below
    // correctly rejects the now-stale confirm attempt with a clear
    // INVALID_BRANCH_ORDER_TRANSITION rather than silently no-opping.
    await this.reconciliation.reconcileMany([branchOrderId], req.correlationId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await tx.branchOrder.findUniqueOrThrow({
        where: { id: branchOrderId },
      });
      if (order.fulfilmentMethod !== 'DELIVERY') {
        throw new ConflictException({
          code: 'CONFIRM_NOT_APPLICABLE',
          message: 'Only a DELIVERY order can be confirmed as received here',
        });
      }
      return this.branchOrderService.transition(
        tx,
        branchOrderId,
        'COMPLETED',
        user.id,
        req.correlationId,
      );
    });
    return { id: updated.id, status: updated.status };
  }

  // PDR-026: "A 'not received' report requires a reason and directs
  // the customer to external store contact; no in-platform dispute
  // case is created." Idempotent on a pending report: a second call
  // while one is already open simply returns the existing report
  // rather than re-notifying the owner a second time for the same
  // issue.
  @Post(':branchOrderId/report-not-received')
  async reportNotReceived(
    @CurrentUser() user: AuthenticatedUser,
    @Param('branchOrderId') branchOrderId: string,
    @Body() dto: ReportNotReceivedDto,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    await this.requireOwnBranchOrder(customerId, branchOrderId);

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          vendorId: string;
          branchId: string;
          fulfilmentMethod: string;
          status: string;
          notReceivedReportedAt: Date | null;
        }[]
      >`SELECT id, "vendorId", "branchId", "fulfilmentMethod", status, "notReceivedReportedAt"
        FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
      const order = rows[0];
      if (
        !order ||
        order.fulfilmentMethod !== 'DELIVERY' ||
        order.status !== 'DELIVERED'
      ) {
        throw new ConflictException({
          code: 'REPORT_NOT_APPLICABLE',
          message:
            'Only a DELIVERY order currently awaiting confirmation can be reported not received',
        });
      }
      if (order.notReceivedReportedAt) {
        // Already reported and not yet resolved - a benign replay, not
        // a second notification.
        return {
          reported_at: order.notReceivedReportedAt.toISOString(),
          already_reported: true,
        };
      }

      const reportedAt = new Date();
      await tx.branchOrder.update({
        where: { id: branchOrderId },
        data: {
          notReceivedReportedAt: reportedAt,
          notReceivedReason: dto.reason,
        },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'branch_order.not_received_reported',
          entityType: 'BranchOrder',
          entityId: branchOrderId,
          afterState: { reason: dto.reason },
        },
        tx,
      );

      // Notify every OWNER of this vendor - an exception event, per
      // this codebase's own "owner receives exceptions, not every
      // order" convention (§3.5). Independent notification per
      // recipient, never bundled.
      const owners = await tx.vendorUser.findMany({
        where: { vendorId: order.vendorId, role: 'OWNER' },
        select: { userId: true },
      });
      for (const owner of owners) {
        await this.outbox.enqueue(
          {
            eventType: 'branch_order.not_received_reported',
            payload: {
              branch_order_id: branchOrderId,
              vendor_id: order.vendorId,
              branch_id: order.branchId,
              recipient_user_id: owner.userId,
              reason: dto.reason,
            },
          },
          tx,
        );
      }

      return { reported_at: reportedAt.toISOString(), already_reported: false };
    });
  }

  /** Branch employees (ACTIVE, this branch) + every OWNER of the
   * vendor - the "branch" half of this sprint's recipient table
   * (cancellation/reschedule/refund-requested events). */
  private async notifyBranch(
    tx: Prisma.TransactionClient,
    vendorId: string,
    branchId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const recipients = await tx.vendorUser.findMany({
      where: {
        vendorId,
        status: 'ACTIVE',
        OR: [{ role: 'OWNER' }, { role: 'BRANCH_EMPLOYEE', branchId }],
      },
      select: { userId: true },
    });
    for (const r of recipients) {
      await this.outbox.enqueue(
        { eventType, payload: { ...payload, recipient_user_id: r.userId } },
        tx,
      );
    }
  }

  // PDR-028: the customer's own pre-prep self-service cancellation -
  // the WHOLE order (every still-active item + the delivery fee, in
  // one atomic finalize - see BranchOrderCancellationService's own
  // top comment). PLACED only - once preparation starts, only staff
  // can cancel (see BranchOrdersStaffController).
  @Post(':branchOrderId/cancel')
  @UseInterceptors(IdempotencyInterceptor)
  async cancelOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('branchOrderId') branchOrderId: string,
    @Body() dto: CancelBranchOrderDto,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockAndRequireOwnStatus(
        tx,
        customerId,
        branchOrderId,
        ['PLACED'],
      );
      const r = await this.cancellation.cancelWholeOrder(
        tx,
        locked,
        user.id,
        'CUSTOMER_REQUEST',
        dto.reason ?? null,
        req.correlationId,
      );
      await this.notifyBranch(tx, locked.vendorId, locked.branchId, 'branch_order.cancelled', {
        branch_order_id: branchOrderId,
        vendor_id: locked.vendorId,
        branch_id: locked.branchId,
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

  // PDR-028: the customer's own pre-prep cancellation of a SINGLE
  // item. If other items remain active, the order itself is
  // untouched; if this was the last one, the whole order closes (see
  // BranchOrderCancellationService.cancelSingleItem's own comment).
  @Post(':branchOrderId/items/:itemId/cancel')
  @UseInterceptors(IdempotencyInterceptor)
  async cancelItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('branchOrderId') branchOrderId: string,
    @Param('itemId') itemId: string,
    @Body() dto: CancelBranchOrderDto,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockAndRequireOwnStatus(
        tx,
        customerId,
        branchOrderId,
        ['PLACED'],
      );
      const r = await this.cancellation.cancelSingleItem(
        tx,
        locked,
        itemId,
        user.id,
        'CUSTOMER_REQUEST',
        dto.reason ?? null,
        req.correlationId,
      );
      await this.notifyBranch(tx, locked.vendorId, locked.branchId, 'branch_order.cancelled', {
        branch_order_id: branchOrderId,
        vendor_id: locked.vendorId,
        branch_id: locked.branchId,
        item_id: itemId,
      });
      return r;
    });
    return {
      id: branchOrderId,
      item_id: itemId,
      order_closed: result.orderClosed,
      refunded_amount: result.refundedAmount.toNumber(),
    };
  }

  // PDR-025/027: the customer's own reschedule, usable in both
  // triggers - a PLACED/PREPARING order past its slot deadline
  // (slotMissedAt set), or a DELIVERY_FAILED order at its first
  // (only) reschedulable attempt. See BranchOrderRescheduleService's
  // own comment for the full lock/capacity mechanics.
  @Post(':branchOrderId/reschedule')
  @UseInterceptors(IdempotencyInterceptor)
  async rescheduleOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('branchOrderId') branchOrderId: string,
    @Body() dto: RescheduleBranchOrderDto,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockAndRequireOwnStatus(tx, customerId, branchOrderId, [
        'PLACED',
        'PREPARING',
        'DELIVERY_FAILED',
      ]);
      if (
        locked.status !== 'DELIVERY_FAILED' &&
        locked.slotMissedAt === null
      ) {
        throw new ConflictException({
          code: 'RESCHEDULE_NOT_APPLICABLE',
          message: 'This order is not currently eligible for rescheduling',
        });
      }
      if (
        locked.status === 'DELIVERY_FAILED' &&
        locked.deliveryAttemptCount >= 2
      ) {
        throw new ConflictException({
          code: 'RESCHEDULE_WINDOW_CLOSED',
          message:
            'Rescheduling is no longer available after a second failed delivery attempt',
        });
      }
      const outcome = await this.reschedule.reschedule(
        tx,
        locked,
        dto.delivery_window_id,
        dto.scheduled_date,
        user.id,
        req.correlationId,
      );
      await this.notifyBranch(
        tx,
        locked.vendorId,
        locked.branchId,
        'branch_order.rescheduled',
        {
          branch_order_id: branchOrderId,
          vendor_id: locked.vendorId,
          branch_id: locked.branchId,
        },
      );
      return outcome;
    });
    return {
      id: branchOrderId,
      delivery_window_id: result.deliveryWindowId,
      scheduled_date: result.scheduledDate.toISOString().slice(0, 10),
    };
  }

  // PDR-027: after a second failed delivery attempt (ONLINE only),
  // the customer may request a refund - staff/owner approval is the
  // only way out from here (see BranchOrdersStaffController.approveRefund).
  @Post(':branchOrderId/request-refund')
  @UseInterceptors(IdempotencyInterceptor)
  async requestRefund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('branchOrderId') branchOrderId: string,
    @Req() req: Request,
  ) {
    const customerId = await this.requireCustomerId(user);
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockAndRequireOwnStatus(tx, customerId, branchOrderId, [
        'DELIVERY_FAILED',
      ]);
      if (locked.paymentMethod !== 'ONLINE' || locked.deliveryAttemptCount < 2) {
        throw new ConflictException({
          code: 'REFUND_REQUEST_NOT_APPLICABLE',
          message:
            'A refund request is only available for an ONLINE order after a second failed delivery attempt',
        });
      }
      await this.branchOrderService.transition(
        tx,
        branchOrderId,
        'REFUND_REQUESTED',
        user.id,
        req.correlationId,
      );
      await this.notifyBranch(
        tx,
        locked.vendorId,
        locked.branchId,
        'branch_order.refund_requested',
        {
          branch_order_id: branchOrderId,
          vendor_id: locked.vendorId,
          branch_id: locked.branchId,
        },
      );
    });
    return { id: branchOrderId, status: 'REFUND_REQUESTED' };
  }

  /** Shared lock+ownership+status-eligibility check for every write
   * endpoint above - 404 on a non-owned order (BOLA convention), 409
   * INVALID_BRANCH_ORDER_TRANSITION-shaped on an ineligible status
   * (never a silent no-op). */
  private async lockAndRequireOwnStatus(
    tx: Prisma.TransactionClient,
    customerId: string,
    branchOrderId: string,
    allowedStatuses: string[],
  ) {
    await tx.$queryRaw`SELECT id FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
    const order = await tx.branchOrder.findUnique({
      where: { id: branchOrderId },
      include: { customerOrder: { select: { customerId: true } } },
    });
    if (!order || order.customerOrder.customerId !== customerId) {
      throw new NotFoundException({
        code: 'BRANCH_ORDER_NOT_FOUND',
        message: 'Branch order not found',
      });
    }
    if (!allowedStatuses.includes(order.status)) {
      throw new ConflictException({
        code: 'INVALID_BRANCH_ORDER_TRANSITION',
        message: `This action is not available while the order is ${order.status}`,
      });
    }
    return order;
  }
}
