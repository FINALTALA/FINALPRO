import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BranchOrderIntegrityService,
  branchOrderIntegrityIssue,
} from './branch-order-integrity.service';
import { BranchOrderService } from './branch-order.service';

const CONFIRM_REMINDER_HOURS = 48;
const AUTO_CONFIRM_HOURS = 72;

interface DeliveredOrderRow {
  id: string;
  vendorId: string;
  branchId: string;
  customerOrderId: string;
  fulfilmentMethod: string;
  status: string;
  deliveredAt: Date | null;
  confirmReminderSentAt: Date | null;
  notReceivedReportedAt: Date | null;
}

/**
 * Sprint 11 (RB-FUL-002/003, PDR-026): lazy reconciliation for the
 * Sent -> Delivered -> customer-confirm loop's time-based steps (the
 * 48-hour reminder, the 72-hour auto-confirm). No scheduled-job worker
 * exists anywhere in this codebase - the same honestly-documented gap
 * as every other lazy-expiry mechanism here (CheckoutReservation
 * expiry, SubscriptionGateService's ACTIVE->EXPIRED transition). This
 * runs opportunistically instead, called from every place that reads
 * or acts on a DELIVERED order: the customer's own order list, the
 * staff/owner order list, and every action endpoint on a specific
 * order. `reconcileOne` locks the row FIRST, so two callers racing to
 * reconcile the SAME order serialize on it - the second always sees
 * the first's already-applied outcome (a set confirmReminderSentAt, or
 * a status no longer DELIVERED) instead of double-firing the reminder
 * or the auto-confirm.
 */
@Injectable()
export class FulfilmentReconciliationService {
  private readonly logger = new Logger(FulfilmentReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly branchOrderService: BranchOrderService,
    private readonly outbox: OutboxEventService,
    private readonly integrity: BranchOrderIntegrityService,
  ) {}

  async reconcileOne(
    tx: Prisma.TransactionClient,
    branchOrderId: string,
    correlationId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<DeliveredOrderRow[]>`
      SELECT id, "vendorId", "branchId", "customerOrderId",
        "fulfilmentMethod", status, "deliveredAt", "confirmReminderSentAt",
        "notReceivedReportedAt"
      FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
    const order = rows[0];
    if (!order || order.status !== 'DELIVERED') {
      return;
    }
    // TB-9: the reminder and the auto-confirm are DELIVERY-only - a
    // pickup order is completed at its hand-over and never reaches
    // DELIVERED. One that did anyway (or a DELIVERED order with no
    // deliveredAt) is never moved: it is flagged once for platform
    // administrators and left as it is.
    const issue = branchOrderIntegrityIssue(order);
    if (issue) {
      await this.integrity.flagOnce(tx, order, issue, correlationId);
      return;
    }
    // A pending "not received" report freezes the clock entirely -
    // resumes only once staff resolves it externally and re-requests
    // confirmation (see BranchOrdersStaffController.rerequestConfirmation,
    // which clears this field and restarts deliveredAt).
    if (order.notReceivedReportedAt) {
      return;
    }

    const hoursSinceDelivered =
      (Date.now() - order.deliveredAt.getTime()) / (1000 * 60 * 60);

    if (hoursSinceDelivered >= AUTO_CONFIRM_HOURS) {
      await this.branchOrderService.transition(
        tx,
        branchOrderId,
        'COMPLETED',
        null,
        correlationId,
      );
      await this.enqueueCustomerNotification(
        tx,
        order,
        'branch_order.auto_confirmed_72h',
      );
      return;
    }

    if (
      hoursSinceDelivered >= CONFIRM_REMINDER_HOURS &&
      !order.confirmReminderSentAt
    ) {
      await tx.branchOrder.update({
        where: { id: branchOrderId },
        data: { confirmReminderSentAt: new Date() },
      });
      await this.enqueueCustomerNotification(
        tx,
        order,
        'branch_order.confirm_reminder_48h',
      );
    }
  }

  /**
   * Reconciles a list of candidate order ids (the periodic sweep's due
   * orders, the customer's own DELIVERED orders, or a branch's) - each
   * in its own transaction AND its own try/catch (TB-9), so one order's
   * failure rolls back only that order's writes, is logged with its id,
   * and never stops the rest or fails the caller's request.
   */
  async reconcileMany(
    branchOrderIds: string[],
    correlationId: string,
  ): Promise<{ reconciled: number; failed: number }> {
    let reconciled = 0;
    let failed = 0;
    for (const id of branchOrderIds) {
      try {
        await this.prisma.$transaction((tx) =>
          this.reconcileOne(tx, id, correlationId),
        );
        reconciled += 1;
      } catch (err) {
        failed += 1;
        this.logger.error(
          `Fulfilment reconciliation failed for branch order ${id} (correlation ${correlationId})`,
          (err as Error).stack,
        );
      }
    }
    return { reconciled, failed };
  }

  private async enqueueCustomerNotification(
    tx: Prisma.TransactionClient,
    order: DeliveredOrderRow,
    eventType: string,
  ): Promise<void> {
    const customerOrder = await tx.customerOrder.findUniqueOrThrow({
      where: { id: order.customerOrderId },
      include: { customer: { select: { userId: true } } },
    });
    await this.outbox.enqueue(
      {
        eventType,
        audience: 'CUSTOMER',
        payload: {
          branch_order_id: order.id,
          vendor_id: order.vendorId,
          branch_id: order.branchId,
          recipient_user_id: customerOrder.customer.userId,
        },
      },
      tx,
    );
  }
}
