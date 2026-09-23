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
} from '@nestjs/common';
import { Request } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { BranchOrderService } from './branch-order.service';
import { ReportNotReceivedDto } from './dto/report-not-received.dto';
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
} as const;

type OrderRow = Prisma.BranchOrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

function orderDto(o: OrderRow) {
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
    items: o.items.map((i) => ({
      offer_variant_id: i.offerVariantId,
      title_ar: i.offerVariant.vendorOffer.titleAr,
      title_en: i.offerVariant.vendorOffer.titleEn,
      seller_sku: i.offerVariant.sellerSku,
      quantity: i.quantity,
      unit_price: Number(i.unitPrice),
    })),
    subtotal: Number(o.subtotal),
    delivery_fee: o.deliveryFee !== null ? Number(o.deliveryFee) : null,
    total: Number(o.total),
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
}
