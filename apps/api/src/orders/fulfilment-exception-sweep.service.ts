import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BranchOrderStatus, Prisma } from '../../generated/prisma/client';
import { PeriodicTask } from '../common/periodic-task.util';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { BranchOrderCancellationService } from './branch-order-cancellation.service';

const SWEEP_INTERVAL_MS = 60_000;
const BATCH_LIMIT = 200;
const PREP_REMINDER_LEAD_HOURS = 6;
const SLOT_MISSED_TIMEOUT_HOURS = 48;
const DELIVERY_FAILURE_TIMEOUT_HOURS = 48;

// Matches BranchOrderCancellationService's own (unexported) LockedOrder
// shape exactly - `status` typed as the real enum (not a bare string)
// so the row returned by this file's own raw queries below can be
// passed straight into finalizeTimeout() without a cast.
interface LockedOrderRow {
  id: string;
  vendorId: string;
  branchId: string;
  customerOrderId: string;
  status: BranchOrderStatus;
  fulfilmentMethod: string;
  paymentMethod: string;
  deliveryAttemptCount: number;
  deliveryFee: unknown;
  total: unknown;
  paymentTransactionId: string | null;
}

/**
 * Sprint 20a (PDR-025/027, review-round requirement): the three
 * genuinely time-based sweeps this sprint's plan calls for, following
 * the exact same lazy-but-periodic pattern FulfilmentSweepService
 * (Sprint 19) already established - a real `PeriodicTask`, not request-
 * triggered reconciliation, since none of these three have any other
 * natural trigger point (no request from anyone necessarily touches an
 * order in the window between "the slot passed" and "the customer
 * happens to reload their order list").
 *
 * 1. Prep reminder - 6h before a still-unprepared DELIVERY order's own
 *    slot, notifies the BRANCH (owners + this branch's employees).
 *    Dedup key: (deliveryWindowId, scheduledDate) as of the reminder,
 *    not a bare boolean - see BranchOrder.prepReminderSentForWindowId's
 *    own schema comment for why a reschedule must re-arm this.
 * 2. Slot-missed detection (PDR-025) - the first moment a DELIVERY
 *    order is still PLACED/PREPARING past its own slot's start time;
 *    sets slotMissedAt and starts the 48h clock. Notifies the
 *    CUSTOMER (their own action-needed moment: reschedule).
 * 3. Two 48h timeouts, same shape, different trigger field: a
 *    slot-missed order (PDR-025) or a first-failed-delivery order
 *    (PDR-027, deliveryAttemptCount===1) that is STILL not rescheduled
 *    48h later resolves automatically - COD cancels, ONLINE refunds -
 *    via the SAME finalizeTimeout() every other closing action
 *    funnels through (full item/stock/refund-ledger safety, never a
 *    bare status write). Notifies the CUSTOMER only - same convention
 *    as FulfilmentReconciliationService's own 72h auto-confirm, which
 *    nobody but the customer needs to hear about.
 *
 * Every candidate is locked and re-validated under its own transaction
 * (never a batch transaction) - one order's outcome never blocks or
 * depends on another's, matching FulfilmentSweepService's own
 * established convention exactly.
 */
@Injectable()
export class FulfilmentExceptionSweepService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FulfilmentExceptionSweepService.name);
  private readonly task = new PeriodicTask(
    SWEEP_INTERVAL_MS,
    () => this.sweepOnce().then(() => undefined),
    (err) =>
      this.logger.error(
        'FulfilmentExceptionSweepService tick failed',
        err as Error,
      ),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly cancellation: BranchOrderCancellationService,
    private readonly outbox: OutboxEventService,
  ) {}

  onModuleInit() {
    this.task.start();
  }

  onModuleDestroy() {
    this.task.stop();
  }

  async sweepOnce(): Promise<{
    prepReminders: number;
    slotMissedDetected: number;
    timeoutsResolved: number;
  }> {
    const prepReminders = await this.sweepPrepReminders();
    const slotMissedDetected = await this.sweepSlotMissedDetection();
    const timeoutsResolved = await this.sweepTimeouts();
    return { prepReminders, slotMissedDetected, timeoutsResolved };
  }

  /** PDR-025/027 pre-slot reminder, 6h out - DELIVERY orders not yet
   * SENT, whose (deliveryWindowId, scheduledDate) hasn't already had a
   * reminder sent for THIS exact slot. */
  private async sweepPrepReminders(): Promise<number> {
    const candidates = await this.prisma.$queryRaw<
      { id: string; vendorId: string; branchId: string }[]
    >`
      SELECT bo.id, bo."vendorId", bo."branchId"
      FROM branch_orders bo
      JOIN delivery_windows dw ON dw.id = bo."deliveryWindowId"
      WHERE bo.status IN ('PLACED', 'PREPARING')
        AND bo."fulfilmentMethod" = 'DELIVERY'
        AND bo."scheduledDate" IS NOT NULL
        AND (
          bo."prepReminderSentForWindowId" IS NULL
          OR bo."prepReminderSentForWindowId" != bo."deliveryWindowId"
          OR bo."prepReminderSentForDate" IS NULL
          OR bo."prepReminderSentForDate" != bo."scheduledDate"
        )
        AND (bo."scheduledDate" AT TIME ZONE 'UTC') + (dw."startMinute" || ' minutes')::interval
            <= now() + make_interval(hours => ${PREP_REMINDER_LEAD_HOURS})
        AND (bo."scheduledDate" AT TIME ZONE 'UTC') + (dw."startMinute" || ' minutes')::interval > now()
      ORDER BY bo."createdAt" ASC
      LIMIT ${BATCH_LIMIT}
    `;
    let count = 0;
    for (const candidate of candidates) {
      const sent = await this.prisma.$transaction((tx) =>
        this.sendPrepReminderOnce(tx, candidate.id),
      );
      if (sent) count += 1;
    }
    return count;
  }

  private async sendPrepReminderOnce(
    tx: Prisma.TransactionClient,
    branchOrderId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        vendorId: string;
        branchId: string;
        status: string;
        fulfilmentMethod: string;
        deliveryWindowId: string | null;
        scheduledDate: Date | null;
        prepReminderSentForWindowId: string | null;
        prepReminderSentForDate: Date | null;
      }[]
    >`SELECT id, "vendorId", "branchId", status, "fulfilmentMethod",
        "deliveryWindowId", "scheduledDate", "prepReminderSentForWindowId",
        "prepReminderSentForDate"
      FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
    const order = rows[0];
    if (
      !order ||
      order.status === 'CANCELLED' ||
      order.status === 'REFUNDED' ||
      order.status === 'COMPLETED' ||
      order.fulfilmentMethod !== 'DELIVERY' ||
      !order.deliveryWindowId ||
      !order.scheduledDate
    ) {
      return false;
    }
    const alreadySent =
      order.prepReminderSentForWindowId === order.deliveryWindowId &&
      order.prepReminderSentForDate !== null &&
      order.prepReminderSentForDate.getTime() ===
        order.scheduledDate.getTime();
    if (alreadySent) {
      return false;
    }

    await tx.branchOrder.update({
      where: { id: branchOrderId },
      data: {
        prepReminderSentForWindowId: order.deliveryWindowId,
        prepReminderSentForDate: order.scheduledDate,
      },
    });
    await this.notifyBranch(tx, order.vendorId, order.branchId, 'branch_order.prep_reminder', {
      branch_order_id: branchOrderId,
      vendor_id: order.vendorId,
      branch_id: order.branchId,
    });
    return true;
  }

  /** PDR-025: the first moment a DELIVERY order is found still
   * PLACED/PREPARING past its own slot's start time. Sets
   * slotMissedAt (starting the 48h clock) and notifies the customer. */
  private async sweepSlotMissedDetection(): Promise<number> {
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT bo.id
      FROM branch_orders bo
      JOIN delivery_windows dw ON dw.id = bo."deliveryWindowId"
      WHERE bo.status IN ('PLACED', 'PREPARING')
        AND bo."fulfilmentMethod" = 'DELIVERY'
        AND bo."scheduledDate" IS NOT NULL
        AND bo."slotMissedAt" IS NULL
        AND (bo."scheduledDate" AT TIME ZONE 'UTC') + (dw."startMinute" || ' minutes')::interval <= now()
      ORDER BY bo."createdAt" ASC
      LIMIT ${BATCH_LIMIT}
    `;
    let count = 0;
    for (const { id } of candidates) {
      const detected = await this.prisma.$transaction((tx) =>
        this.markSlotMissedOnce(tx, id),
      );
      if (detected) count += 1;
    }
    return count;
  }

  private async markSlotMissedOnce(
    tx: Prisma.TransactionClient,
    branchOrderId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        vendorId: string;
        branchId: string;
        status: string;
        fulfilmentMethod: string;
        slotMissedAt: Date | null;
      }[]
    >`SELECT id, "vendorId", "branchId", status, "fulfilmentMethod", "slotMissedAt"
      FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
    const order = rows[0];
    if (
      !order ||
      order.slotMissedAt !== null ||
      order.fulfilmentMethod !== 'DELIVERY' ||
      (order.status !== 'PLACED' && order.status !== 'PREPARING')
    ) {
      return false;
    }
    await tx.branchOrder.update({
      where: { id: branchOrderId },
      data: { slotMissedAt: new Date() },
    });
    await this.notifyCustomer(tx, branchOrderId, 'branch_order.slot_missed', {
      branch_order_id: branchOrderId,
      vendor_id: order.vendorId,
      branch_id: order.branchId,
    });
    return true;
  }

  /** PDR-025/027: the 48h-no-reschedule automatic resolution, for
   * either trigger (slot-missed, or a first failed delivery attempt).
   * Both funnel through BranchOrderCancellationService.finalizeTimeout,
   * which performs the full item/stock/refund-ledger-safe close-out and
   * returns the real terminal status. */
  private async sweepTimeouts(): Promise<number> {
    const slotMissedCandidates = await this.prisma.$queryRaw<
      { id: string }[]
    >`
      SELECT id FROM branch_orders
      WHERE status IN ('PLACED', 'PREPARING')
        AND "slotMissedAt" IS NOT NULL
        AND "slotMissedAt" <= now() - make_interval(hours => ${SLOT_MISSED_TIMEOUT_HOURS})
      ORDER BY "slotMissedAt" ASC
      LIMIT ${BATCH_LIMIT}
    `;
    const deliveryFailureCandidates = await this.prisma.$queryRaw<
      { id: string }[]
    >`
      SELECT id FROM branch_orders
      WHERE status = 'DELIVERY_FAILED'
        AND "deliveryAttemptCount" = 1
        AND "deliveryFailedAt" IS NOT NULL
        AND "deliveryFailedAt" <= now() - make_interval(hours => ${DELIVERY_FAILURE_TIMEOUT_HOURS})
      ORDER BY "deliveryFailedAt" ASC
      LIMIT ${BATCH_LIMIT}
    `;

    let count = 0;
    for (const { id } of slotMissedCandidates) {
      const resolved = await this.prisma.$transaction((tx) =>
        this.resolveTimeoutOnce(tx, id, 'SLOT_MISSED', [
          'PLACED',
          'PREPARING',
        ]),
      );
      if (resolved) count += 1;
    }
    for (const { id } of deliveryFailureCandidates) {
      const resolved = await this.prisma.$transaction((tx) =>
        this.resolveTimeoutOnce(tx, id, 'DELIVERY_FAILURE_TIMEOUT', [
          'DELIVERY_FAILED',
        ]),
      );
      if (resolved) count += 1;
    }
    return count;
  }

  private async resolveTimeoutOnce(
    tx: Prisma.TransactionClient,
    branchOrderId: string,
    reason: 'SLOT_MISSED' | 'DELIVERY_FAILURE_TIMEOUT',
    allowedStatuses: string[],
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<
      (LockedOrderRow & {
        slotMissedAt: Date | null;
        deliveryFailedAt: Date | null;
      })[]
    >`SELECT id, "vendorId", "branchId", "customerOrderId", status,
        "fulfilmentMethod", "paymentMethod", "deliveryAttemptCount",
        "deliveryFee", total, "paymentTransactionId", "slotMissedAt",
        "deliveryFailedAt"
      FROM branch_orders WHERE id = ${branchOrderId} FOR UPDATE`;
    const order = rows[0];
    if (!order || !allowedStatuses.includes(order.status)) {
      return false;
    }
    // Re-validate the actual trigger field under lock - a concurrent
    // reschedule racing in between the unlocked discovery query and
    // this lock must never be double-resolved.
    if (reason === 'SLOT_MISSED' && order.slotMissedAt === null) {
      return false;
    }
    if (
      reason === 'DELIVERY_FAILURE_TIMEOUT' &&
      (order.deliveryFailedAt === null || order.deliveryAttemptCount !== 1)
    ) {
      return false;
    }

    const correlationId = randomUUID();
    const result = await this.cancellation.finalizeTimeout(
      tx,
      order,
      reason,
      correlationId,
    );
    const eventType =
      order.paymentMethod === 'ONLINE'
        ? 'branch_order.refund_automatic'
        : 'branch_order.cancelled';
    await this.notifyCustomer(tx, branchOrderId, eventType, {
      branch_order_id: branchOrderId,
      vendor_id: order.vendorId,
      branch_id: order.branchId,
      item_id: null,
    });
    return result.orderClosed;
  }

  /** Branch employees (ACTIVE, this branch) + every OWNER of the
   * vendor - same recipient rule as CustomerOrdersController's own
   * notifyBranch. */
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

  /** The order's own customer - same convention as
   * BranchOrdersStaffController's own notifyCustomer. */
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
}
