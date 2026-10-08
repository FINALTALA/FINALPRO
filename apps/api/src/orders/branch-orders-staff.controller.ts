import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
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
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { BranchOrderCancellationService } from './branch-order-cancellation.service';
import { computeAmountDue } from './branch-order-money.util';
import { BranchOrderService } from './branch-order.service';
import { MarkDeliveryFailedDto } from './dto/mark-delivery-failed.dto';
import { PickupHandoverDto } from './dto/pickup-handover.dto';
import { StaffCancelBranchOrderDto } from './dto/staff-cancel-branch-order.dto';
import { UpdateInternalOrderNoteDto } from './dto/update-internal-order-note.dto';
import { FulfilmentReconciliationService } from './fulfilment-reconciliation.service';

interface BranchOrderRow {
  id: string;
  status: string;
  fulfilmentMethod: string;
  paymentMethod: string;
  total: unknown;
  deliveryFee: unknown;
  createdAt: Date;
  pickupCode: string | null;
  deliveredAt: Date | null;
  notReceivedReportedAt: Date | null;
  notReceivedReason: string | null;
  cancellationReason: string | null;
  codCollectedAmount: unknown;
  codCollectedAt: Date | null;
  customerNote: string | null;
  internalStoreNote: string | null;
  items: { unitPrice: unknown; quantity: number; cancelledAt: Date | null }[];
  refunds: { amount: unknown; reason: string }[];
  customerOrder: {
    customer: { displayName: string | null; user: { phone: string } };
  };
}

// Owner-facing DTO - a wider surface within the owner's own authority
// (PDR-009: "the owner controls ... all store inventory/orders").
// Sprint 11 (RB-FUL-002): delivered_at/not_received_* added - the
// owner needs to know a report is pending in order to resolve it
// externally and re-request confirmation (PDR-026). Never added to
// employeeOrderDto below - not part of the agreed minimal employee
// surface.
function ownerOrderDto(o: BranchOrderRow) {
  const hasDeliveryFeeRefund = o.refunds.some(
    (r) => r.reason === 'DELIVERY_FEE',
  );
  return {
    id: o.id,
    status: o.status,
    fulfilment_method: o.fulfilmentMethod,
    payment_method: o.paymentMethod,
    total: Number(o.total),
    created_at: o.createdAt.toISOString(),
    customer_name: o.customerOrder.customer.displayName,
    customer_phone: o.customerOrder.customer.user.phone,
    pickup_code: o.fulfilmentMethod === 'PICKUP' ? o.pickupCode : null,
    delivered_at: o.deliveredAt?.toISOString() ?? null,
    not_received_reported_at: o.notReceivedReportedAt?.toISOString() ?? null,
    not_received_reason: o.notReceivedReason,
    cancellation_reason: o.cancellationReason,
    cod_collected_amount:
      o.codCollectedAmount !== null ? Number(o.codCollectedAmount) : null,
    cod_collected_at: o.codCollectedAt?.toISOString() ?? null,
    amount_due:
      o.paymentMethod === 'COD'
        ? computeAmountDue(
            o.total,
            o.items,
            hasDeliveryFeeRefund,
            o.deliveryFee,
          ).toNumber()
        : null,
    // Sprint 20b (FR-CART-014): both notes are staff-visible - never
    // sent to the customer's own order DTO (customer-orders.controller.ts
    // exposes customer_note only, never internal_store_note).
    customer_note: o.customerNote,
    internal_store_note: o.internalStoreNote,
  };
}

// Codex review round 2 on commit d0ea80d: RB-ORD-004's own wording is
// explicit - "staff view limited to name/phone/code, no address" - and
// the previous single shared DTO gave a BRANCH_EMPLOYEE the SAME wide
// surface as the owner (status/total/payment_method/created_at), well
// beyond what that requirement names.
//
// Codex review round 4 on commit 95a8430 (fix #3): `id` was removed
// entirely - at the time, this list was read-only, so `id` served no
// purpose beyond a React key, which the frontend can construct another
// way.
//
// Sprint 11 (RB-FUL-002, PDR-009): that reasoning no longer holds -
// PDR-009 grants an employee real authority over "the assigned
// branch's orders," and this sprint gives them actual actions to take
// (start preparation, mark sent, mark delivered, pickup handover).
// None of those actions are possible without a way to target a
// SPECIFIC order, and none can be shown/hidden sensibly without
// knowing its current status and fulfilment method - so `id`, `status`
// and `fulfilment_method` are restored here as a genuine functional
// requirement of this sprint's own scope, not a React-key convenience.
// `total`, `payment_method`, `created_at`, and address stay excluded -
// nothing in this sprint's actions needs them, and PDR-009's "cannot
// edit ... another branch" boundary is unaffected (VendorMembershipGuard
// still scopes every action to the employee's own assigned branch).
//
// Codex review on commit f940a80: the employee's own orders page
// showed a "re-request confirmation" button on every DELIVERED order,
// even though the backend only accepts that action when a "not
// received" report is actually open - confusing, and only discoverable
// by clicking it and getting a 409. `has_open_not_received_report` is
// the minimum operational signal to gate that button correctly - a
// plain boolean, never the report's timestamp or reason text, which
// stay owner-only (not_received_reported_at/not_received_reason above).
// Sprint 20a (review-round requirement): `payment_method` and
// `amount_due` are added here too - excluding `total`/`payment_method`
// made sense when nothing in the employee's own action set needed
// them, but COD collection (now folded into mark-delivered/pickup-
// handover) genuinely cannot happen without the employee knowing it IS
// a COD order and exactly how much to collect. `total` itself (the
// ORIGINAL, pre-cancellation value) stays excluded - amount_due is the
// only money figure exposed here, same minimal-surface principle as
// before, just updated for what this sprint's own actions need.
function employeeOrderDto(o: BranchOrderRow) {
  const hasDeliveryFeeRefund = o.refunds.some(
    (r) => r.reason === 'DELIVERY_FEE',
  );
  return {
    id: o.id,
    status: o.status,
    fulfilment_method: o.fulfilmentMethod,
    payment_method: o.paymentMethod,
    customer_name: o.customerOrder.customer.displayName,
    customer_phone: o.customerOrder.customer.user.phone,
    pickup_code: o.fulfilmentMethod === 'PICKUP' ? o.pickupCode : null,
    has_open_not_received_report: o.notReceivedReportedAt !== null,
    amount_due:
      o.paymentMethod === 'COD'
        ? computeAmountDue(
            o.total,
            o.items,
            hasDeliveryFeeRefund,
            o.deliveryFee,
          ).toNumber()
        : null,
    cod_collected_amount:
      o.codCollectedAmount !== null ? Number(o.codCollectedAmount) : null,
    // Sprint 20b (FR-CART-014): same reasoning as ownerOrderDto's own
    // comment - both notes are operationally necessary for whoever is
    // actually fulfilling the order, not an owner-only extra.
    customer_note: o.customerNote,
    internal_store_note: o.internalStoreNote,
  };
}

const ORDER_INCLUDE = {
  customerOrder: {
    select: {
      customer: {
        select: { displayName: true, user: { select: { phone: true } } },
      },
    },
  },
  items: { select: { unitPrice: true, quantity: true, cancelledAt: true } },
  refunds: { select: { amount: true, reason: true } },
} as const;

// Sprint 10 (RB-ORD-004, PDR-009): a minimal, READ-ONLY order list for
// branch staff/owners.
// Sprint 11 (RB-FUL-002, PDR-009/025/026): now also the branch/owner
// fulfilment-action surface - start preparation, mark sent, mark
// delivered, complete a pickup handover, and re-request confirmation
// after resolving a "not received" report externally. Every action
// below is available to BOTH an OWNER (vendor-wide) and a
// BRANCH_EMPLOYEE (their own assigned branch only, per PDR-009's
// general "an employee controls only the assigned branch's orders") -
// VendorMembershipGuard enforces the branch match from :branchId, and
// every handler additionally re-verifies the SPECIFIC :branchOrderId
// actually belongs to this vendor/branch (the guard only checks the
// route params, never the resource itself - skipping this check would
// be a real BOLA hole: a crafted :branchOrderId for a different
// vendor/branch, called under one's own legitimate vendorId/branchId
// route params, must still 404).
@Controller('vendors/:vendorId')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class BranchOrdersStaffController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly branchOrderService: BranchOrderService,
    private readonly cancellation: BranchOrderCancellationService,
    private readonly reconciliation: FulfilmentReconciliationService,
    private readonly outbox: OutboxEventService,
  ) {}

  // PDR-009: "An employee controls only the assigned branch's orders."
  // VendorMembershipGuard itself already 403s a BRANCH_EMPLOYEE whose
  // own membership.branchId doesn't match this route's :branchId - the
  // same guard behavior every other per-branch route in this codebase
  // already relies on (e.g. DeliveryWindowsController). An OWNER has no
  // such restriction and may view any of their own vendor's branches -
  // and, reaching this same route, still gets the WIDER owner DTO
  // (role-conditional response shape, not a separate endpoint).
  @Get('branches/:branchId/orders')
  async listForBranch(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Req() req: Request,
  ) {
    const branch = await this.prisma.storeBranch.findUnique({
      where: { id: branchId },
    });
    if (!branch || branch.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Branch not found for this vendor',
      });
    }
    await this.sweepDelivered({ vendorId, branchId }, req.correlationId);
    const orders = await this.prisma.branchOrder.findMany({
      where: { vendorId, branchId },
      orderBy: { createdAt: 'desc' },
      include: ORDER_INCLUDE,
    });
    const isEmployee = req.vendorMembership?.role === 'BRANCH_EMPLOYEE';
    // Two genuinely different response shapes now (the employee DTO
    // carries has_open_not_received_report, the owner DTO carries the
    // full timestamp/reason instead) - branching the whole .map() call,
    // rather than selecting between the two functions for one shared
    // .map(), keeps each one's own return type exact instead of
    // TypeScript widening it to their intersection.
    if (isEmployee) {
      return orders.map(employeeOrderDto);
    }
    return orders.map(ownerOrderDto);
  }

  // PDR-009: "The owner controls ... all store inventory/orders."
  // Owner-only, all branches of this vendor at once - a convenience on
  // top of the per-branch endpoint above, not a separate authorization
  // model.
  @Get('orders')
  @RequireVendorRole('OWNER')
  async listForVendor(
    @Param('vendorId') vendorId: string,
    @Req() req: Request,
  ) {
    await this.sweepDelivered({ vendorId }, req.correlationId);
    const orders = await this.prisma.branchOrder.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      include: ORDER_INCLUDE,
    });
    return orders.map(ownerOrderDto);
  }

  private async sweepDelivered(
    where: { vendorId: string; branchId?: string },
    correlationId: string,
  ): Promise<void> {
    const candidates = await this.prisma.branchOrder.findMany({
      where: { ...where, status: 'DELIVERED', deliveredAt: { not: null } },
      select: { id: true },
    });
    await this.reconciliation.reconcileMany(
      candidates.map((c) => c.id),
      correlationId,
    );
  }

  /**
   * Every action handler below re-verifies the branch order actually
   * belongs to THIS vendor/branch before touching it - see the
   * controller's own comment on why this is required beyond what
   * VendorMembershipGuard already checks.
   */
  private async requireBranchOrderInBranch(
    vendorId: string,
    branchId: string,
    branchOrderId: string,
  ): Promise<{ id: string }> {
    const order = await this.prisma.branchOrder.findUnique({
      where: { id: branchOrderId },
      select: { id: true, vendorId: true, branchId: true },
    });
    if (!order || order.vendorId !== vendorId || order.branchId !== branchId) {
      throw new NotFoundException({
        code: 'BRANCH_ORDER_NOT_FOUND',
        message: 'Branch order not found for this branch',
      });
    }
    return { id: order.id };
  }

  // PDR-025: "The branch employee explicitly starts preparation."
  @Post('branches/:branchId/orders/:branchOrderId/start-preparation')
  async startPreparation(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('branchOrderId') branchOrderId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const { id } = await this.requireBranchOrderInBranch(
      vendorId,
      branchId,
      branchOrderId,
    );
    const updated = await this.prisma.$transaction((tx) =>
      this.branchOrderService.transition(
        tx,
        id,
        'PREPARING',
        user.id,
        req.correlationId,
      ),
    );
    return { id: updated.id, status: updated.status };
  }

  // PDR-026: "A branch employee marks Sent at hand-off." DELIVERY
  // only - branch-order-state-machine.ts's own graph already enforces
  // this (PICKUP orders use the pickup-handover endpoint below
  // instead), surfacing as a clear INVALID_BRANCH_ORDER_TRANSITION.
  @Post('branches/:branchId/orders/:branchOrderId/mark-sent')
  async markSent(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('branchOrderId') branchOrderId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const { id } = await this.requireBranchOrderInBranch(
      vendorId,
      branchId,
      branchOrderId,
    );
    const updated = await this.prisma.$transaction((tx) =>
      this.branchOrderService.transition(
        tx,
        id,
        'SENT',
        user.id,
        req.correlationId,
      ),
    );
    return { id: updated.id, status: updated.status };
  }

  /**
   * Sprint 20a (FR-PAY-001/FR-FUL-012, review-round requirement): for
   * a COD order, computes the real amount still due (original total
   * minus any already-cancelled items/delivery fee) and returns the
   * extraData to merge into the SAME atomic transition() write that
   * marks DELIVERED/COMPLETED - never a separate write, never a
   * staff-entered figure. Returns {} for ONLINE (nothing to collect).
   */
  private async computeCodCollectionExtraData(
    tx: Prisma.TransactionClient,
    branchOrderId: string,
  ): Promise<Record<string, unknown>> {
    const order = await tx.branchOrder.findUniqueOrThrow({
      where: { id: branchOrderId },
      include: {
        items: {
          select: { unitPrice: true, quantity: true, cancelledAt: true },
        },
      },
    });
    if (order.paymentMethod !== 'COD') {
      return {};
    }
    const amountDue = computeAmountDue(
      order.total,
      order.items,
      false,
      order.deliveryFee,
    );
    return {
      codCollectedAmount: amountDue.toFixed(2),
      codCollectedAt: new Date(),
    };
  }

  // PDR-026: "and Delivered when informed of arrival." Sets
  // deliveredAt atomically with the status write (see
  // BranchOrderService.transition's own extraData param) - this is
  // what starts the 48h-reminder/72h-auto-confirm clock and, in turn,
  // enqueues the customer's own "please confirm receipt" notification.
  // Sprint 20a: also records the COD collection (if applicable) in the
  // SAME atomic write - see computeCodCollectionExtraData's own
  // comment. Idempotency-Key required (review-round requirement: COD
  // recording is a financial write, never safe to leave un-guarded
  // against a network retry).
  @Post('branches/:branchId/orders/:branchOrderId/mark-delivered')
  @UseInterceptors(IdempotencyInterceptor)
  async markDelivered(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('branchOrderId') branchOrderId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const { id } = await this.requireBranchOrderInBranch(
      vendorId,
      branchId,
      branchOrderId,
    );
    const deliveredAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const codData = await this.computeCodCollectionExtraData(tx, id);
      const result = await this.branchOrderService.transition(
        tx,
        id,
        'DELIVERED',
        user.id,
        req.correlationId,
        { deliveredAt, ...codData },
      );
      const order = await tx.branchOrder.findUniqueOrThrow({
        where: { id },
        include: {
          customerOrder: {
            include: { customer: { select: { userId: true } } },
          },
        },
      });
      await this.outbox.enqueue(
        {
          eventType: 'branch_order.delivered_confirm_requested',
          payload: {
            branch_order_id: id,
            vendor_id: vendorId,
            branch_id: branchId,
            recipient_user_id: order.customerOrder.customer.userId,
          },
        },
        tx,
      );
      return result;
    });
    return { id: updated.id, status: updated.status };
  }

  // Sprint 11 (RB-FUL-002): completes the pickup handover this
  // codebase's own pickup-code design (RB-ORD-004) already anticipated
  // - branch-scoped (requireBranchOrderInBranch above already confirms
  // the order belongs to THIS branch before the code is even compared,
  // so a code for a different branch's order can never match here) and
  // verified against the exact code generated at checkout confirm. No
  // POS, receipt, or new payment feature - purely the handover/
  // confirmation step the state machine's own PICKED_UP -> COMPLETED
  // comment already documented as "handover IS confirmation," so both
  // transitions happen together, atomically, in one request.
  @Post('branches/:branchId/orders/:branchOrderId/pickup-handover')
  @UseInterceptors(IdempotencyInterceptor)
  async pickupHandover(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('branchOrderId') branchOrderId: string,
    @Body() dto: PickupHandoverDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const { id } = await this.requireBranchOrderInBranch(
      vendorId,
      branchId,
      branchOrderId,
    );
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await tx.branchOrder.findUniqueOrThrow({ where: { id } });
      if (order.fulfilmentMethod !== 'PICKUP') {
        throw new ConflictException({
          code: 'PICKUP_HANDOVER_NOT_APPLICABLE',
          message: 'This is not a PICKUP order',
        });
      }
      if (!order.pickupCode || order.pickupCode !== dto.pickup_code) {
        throw new ConflictException({
          code: 'WRONG_PICKUP_CODE',
          message: 'The pickup code does not match this order',
        });
      }
      const codData = await this.computeCodCollectionExtraData(tx, id);
      await this.branchOrderService.transition(
        tx,
        id,
        'PICKED_UP',
        user.id,
        req.correlationId,
        codData,
      );
      return this.branchOrderService.transition(
        tx,
        id,
        'COMPLETED',
        user.id,
        req.correlationId,
      );
    });
    return { id: updated.id, status: updated.status };
  }

  // PDR-026: "Staff may re-send or re-request confirmation after
  // external resolution [of a 'not received' report]." Only legal
  // while a report is actually open - clears it and restarts the
  // 48h/72h clock from now, then re-notifies the customer.
  @Post('branches/:branchId/orders/:branchOrderId/rerequest-confirmation')
  async rerequestConfirmation(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('branchOrderId') branchOrderId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const { id } = await this.requireBranchOrderInBranch(
      vendorId,
      branchId,
      branchOrderId,
    );
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          status: string;
          fulfilmentMethod: string;
          notReceivedReportedAt: Date | null;
        }[]
      >`SELECT id, status, "fulfilmentMethod", "notReceivedReportedAt" FROM branch_orders WHERE id = ${id} FOR UPDATE`;
      const order = rows[0];
      if (
        !order ||
        order.status !== 'DELIVERED' ||
        order.fulfilmentMethod !== 'DELIVERY' ||
        !order.notReceivedReportedAt
      ) {
        throw new ConflictException({
          code: 'NO_PENDING_NOT_RECEIVED_REPORT',
          message: 'There is no open "not received" report to resolve',
        });
      }

      const restartedAt = new Date();
      await tx.branchOrder.update({
        where: { id },
        data: {
          deliveredAt: restartedAt,
          notReceivedReportedAt: null,
          notReceivedReason: null,
          confirmReminderSentAt: null,
        },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'branch_order.confirmation_rerequested',
          entityType: 'BranchOrder',
          entityId: id,
        },
        tx,
      );

      const withCustomer = await tx.branchOrder.findUniqueOrThrow({
        where: { id },
        include: {
          customerOrder: {
            include: { customer: { select: { userId: true } } },
          },
        },
      });
      await this.outbox.enqueue(
        {
          eventType: 'branch_order.confirm_rerequested',
          payload: {
            branch_order_id: id,
            vendor_id: vendorId,
            branch_id: branchId,
            recipient_user_id: withCustomer.customerOrder.customer.userId,
          },
        },
        tx,
      );

      return { id, restarted_at: restartedAt.toISOString() };
    });
  }

  /** Customer of this BranchOrder, as a notification recipient - the
   * staff-side half of this sprint's recipient table (cancellation,
   * delivery-failed, refund-approved events). */
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

  /** Shared lock+branch-ownership+status-eligibility check for every
   * staff write endpoint below. */
  private async lockAndRequireStatus(
    tx: Prisma.TransactionClient,
    vendorId: string,
    branchId: string,
    branchOrderId: string,
    allowedStatuses: string[],
  ) {
    await tx.$queryRaw`SELECT id FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
    const order = await tx.branchOrder.findUnique({
      where: { id: branchOrderId },
    });
    if (!order || order.vendorId !== vendorId || order.branchId !== branchId) {
      throw new NotFoundException({
        code: 'BRANCH_ORDER_NOT_FOUND',
        message: 'Branch order not found for this branch',
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

  // PDR-028: staff/owner cancellation - PLACED (same as the
  // customer's own window, so a staff member can act on a customer's
  // behalf after a phone call) or PREPARING (after prep, before Sent
  // - reason mandatory here, the auditable record of the required
  // external contact). Whole order: every still-active item + the
  // delivery fee, in one atomic finalize.
  @Post('branches/:branchId/orders/:branchOrderId/cancel')
  @UseInterceptors(IdempotencyInterceptor)
  async cancelOrder(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('branchOrderId') branchOrderId: string,
    @Body() dto: StaffCancelBranchOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockAndRequireStatus(
        tx,
        vendorId,
        branchId,
        branchOrderId,
        ['PLACED', 'PREPARING'],
      );
      this.requireReasonIfPreparing(order.status, dto.reason);
      const r = await this.cancellation.cancelWholeOrder(
        tx,
        order,
        user.id,
        'STAFF',
        dto.reason ?? null,
        req.correlationId,
      );
      await this.notifyCustomer(tx, branchOrderId, 'branch_order.cancelled', {
        branch_order_id: branchOrderId,
        vendor_id: vendorId,
        branch_id: branchId,
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

  // PDR-028: staff/owner cancellation of a SINGLE item - same
  // PLACED/PREPARING window and reason rule as the whole-order action
  // above.
  @Post('branches/:branchId/orders/:branchOrderId/items/:itemId/cancel')
  @UseInterceptors(IdempotencyInterceptor)
  async cancelItem(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('branchOrderId') branchOrderId: string,
    @Param('itemId') itemId: string,
    @Body() dto: StaffCancelBranchOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockAndRequireStatus(
        tx,
        vendorId,
        branchId,
        branchOrderId,
        ['PLACED', 'PREPARING'],
      );
      this.requireReasonIfPreparing(order.status, dto.reason);
      const r = await this.cancellation.cancelSingleItem(
        tx,
        order,
        itemId,
        user.id,
        'STAFF',
        dto.reason ?? null,
        req.correlationId,
      );
      await this.notifyCustomer(tx, branchOrderId, 'branch_order.cancelled', {
        branch_order_id: branchOrderId,
        vendor_id: vendorId,
        branch_id: branchId,
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

  /** PDR-028: "after preparation ... staff may cancel ... after
   * external contact" - the reason is this cancellation's own
   * auditable record of that contact, so it is mandatory once
   * preparation has started, optional (matching the customer's own
   * window) while still PLACED. */
  private requireReasonIfPreparing(
    status: string,
    reason: string | undefined,
  ): void {
    if (status === 'PREPARING' && (!reason || reason.trim().length < 10)) {
      throw new ConflictException({
        code: 'CANCELLATION_REASON_REQUIRED',
        message:
          'A reason (10-1000 characters) is required to cancel an order that has already started preparation',
      });
    }
  }

  // PDR-027: staff reports a failed delivery attempt. First failure:
  // rests at DELIVERY_FAILED (reschedulable by the customer). Second
  // failure: COD finalizes straight to CANCELLED in this same call;
  // ONLINE rests at DELIVERY_FAILED again, awaiting the customer's own
  // refund request.
  @Post('branches/:branchId/orders/:branchOrderId/mark-delivery-failed')
  @UseInterceptors(IdempotencyInterceptor)
  async markDeliveryFailed(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('branchOrderId') branchOrderId: string,
    @Body() dto: MarkDeliveryFailedDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockAndRequireStatus(
        tx,
        vendorId,
        branchId,
        branchOrderId,
        ['SENT'],
      );
      if (order.fulfilmentMethod !== 'DELIVERY') {
        throw new ConflictException({
          code: 'DELIVERY_FAILURE_NOT_APPLICABLE',
          message: 'Only a DELIVERY order can have a failed delivery attempt',
        });
      }
      const isSecondFailure = order.deliveryAttemptCount >= 1;

      let status: string;
      if (isSecondFailure && order.paymentMethod === 'COD') {
        // COD, second failure: finalizes straight to CANCELLED -
        // every still-active item cancelled and its stock released
        // (no refund row - nothing was ever charged), via the SAME
        // cancellation primitive every other closing action uses, not
        // a bare status write.
        await this.cancellation.finalizeCodSecondDeliveryFailure(
          tx,
          order,
          user.id,
          req.correlationId,
        );
        status = 'CANCELLED';
      } else {
        // First failure (any payment method), or second failure
        // ONLINE (rests here awaiting the customer's own refund
        // request) - a plain status+counter write, no item/stock
        // change yet.
        const result = await this.branchOrderService.transition(
          tx,
          branchOrderId,
          'DELIVERY_FAILED',
          user.id,
          req.correlationId,
          {
            deliveryAttemptCount: { increment: 1 },
            deliveryFailedAt: new Date(),
            ...(dto.reason !== undefined
              ? { cancellationReason: dto.reason }
              : {}),
          },
        );
        status = result.status;
      }
      await this.notifyCustomer(
        tx,
        branchOrderId,
        'branch_order.delivery_failed',
        {
          branch_order_id: branchOrderId,
          vendor_id: vendorId,
          branch_id: branchId,
        },
      );
      return status;
    });
    return { id: branchOrderId, status: outcome };
  }

  // PDR-027: staff/owner approves a REFUND_REQUESTED order - every
  // still-active item + the delivery fee refunded in one atomic
  // finalize, same as any other full-order resolution.
  @Post('branches/:branchId/orders/:branchOrderId/approve-refund')
  @UseInterceptors(IdempotencyInterceptor)
  async approveRefund(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('branchOrderId') branchOrderId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockAndRequireStatus(
        tx,
        vendorId,
        branchId,
        branchOrderId,
        ['REFUND_REQUESTED'],
      );
      const r = await this.cancellation.approveRequestedRefund(
        tx,
        order,
        user.id,
        req.correlationId,
      );
      await this.notifyCustomer(
        tx,
        branchOrderId,
        'branch_order.refund_approved',
        {
          branch_order_id: branchOrderId,
          vendor_id: vendorId,
          branch_id: branchId,
        },
      );
      return r;
    });
    return {
      id: branchOrderId,
      order_closed: result.orderClosed,
      refunded_amount: result.refundedAmount.toNumber(),
    };
  }

  // Sprint 20b (FR-CART-014): an operational note the branch's own
  // staff/owner attach to this order - visible only to them, never
  // the customer, never surfaced to any Outbox/Notification payload.
  // No status restriction (unlike cancellationReason, written once at
  // closing time) - editable any time while the order exists.
  // Idempotency-Key required; AuditLog records ONLY that it changed
  // and the new length - never the note text itself.
  @Patch('branches/:branchId/orders/:branchOrderId/internal-note')
  @UseInterceptors(IdempotencyInterceptor)
  async updateInternalNote(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @Param('branchOrderId') branchOrderId: string,
    @Body() dto: UpdateInternalOrderNoteDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
      const order = await tx.branchOrder.findUnique({
        where: { id: branchOrderId },
        select: {
          id: true,
          vendorId: true,
          branchId: true,
          internalStoreNote: true,
        },
      });
      if (
        !order ||
        order.vendorId !== vendorId ||
        order.branchId !== branchId
      ) {
        throw new NotFoundException({
          code: 'BRANCH_ORDER_NOT_FOUND',
          message: 'Branch order not found for this branch',
        });
      }
      const changed = order.internalStoreNote !== dto.note;
      if (changed) {
        await tx.branchOrder.update({
          where: { id: branchOrderId },
          data: { internalStoreNote: dto.note },
        });
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'branch_order.internal_note_updated',
            entityType: 'BranchOrder',
            entityId: branchOrderId,
            // Never the note text itself - only that it changed and
            // its new length (review-round requirement).
            afterState: { changed: true, new_length: dto.note.length },
          },
          tx,
        );
      }
      return { id: branchOrderId, internal_store_note: dto.note };
    });
  }
}
