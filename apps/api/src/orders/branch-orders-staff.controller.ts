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
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { BranchOrderService } from './branch-order.service';
import { PickupHandoverDto } from './dto/pickup-handover.dto';
import { FulfilmentReconciliationService } from './fulfilment-reconciliation.service';

interface BranchOrderRow {
  id: string;
  status: string;
  fulfilmentMethod: string;
  paymentMethod: string;
  total: unknown;
  createdAt: Date;
  pickupCode: string | null;
  deliveredAt: Date | null;
  notReceivedReportedAt: Date | null;
  notReceivedReason: string | null;
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
function employeeOrderDto(o: BranchOrderRow) {
  return {
    id: o.id,
    status: o.status,
    fulfilment_method: o.fulfilmentMethod,
    customer_name: o.customerOrder.customer.displayName,
    customer_phone: o.customerOrder.customer.user.phone,
    pickup_code: o.fulfilmentMethod === 'PICKUP' ? o.pickupCode : null,
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
    return orders.map(isEmployee ? employeeOrderDto : ownerOrderDto);
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

  // PDR-026: "and Delivered when informed of arrival." Sets
  // deliveredAt atomically with the status write (see
  // BranchOrderService.transition's own extraData param) - this is
  // what starts the 48h-reminder/72h-auto-confirm clock and, in turn,
  // enqueues the customer's own "please confirm receipt" notification.
  @Post('branches/:branchId/orders/:branchOrderId/mark-delivered')
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
      const result = await this.branchOrderService.transition(
        tx,
        id,
        'DELIVERED',
        user.id,
        req.correlationId,
        { deliveredAt },
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
      await this.branchOrderService.transition(
        tx,
        id,
        'PICKED_UP',
        user.id,
        req.correlationId,
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
}
