import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { PeriodicTask } from '../common/periodic-task.util';
import {
  logSweepTick,
  runSweepStep,
  SweepBackoff,
  sweepTransaction,
  type SweepStepResult,
} from '../common/sweep-runner.util';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PlatformAlertRecipientsService } from '../platform-alerts/platform-alert-recipients.service';
import { PrismaService } from '../prisma/prisma.service';
import { lockSweepOrCreateStockRow } from '../checkout/stock-lock.util';
import { enqueueReturnEscalationAlert } from './return-escalation-alert';

const SWEEP_INTERVAL_MS = 60_000;
const BATCH_LIMIT = 200;
const VENDOR_REVIEW_SLA_HOURS = 48;
export const ESCALATION_TIMEOUT_HOURS = 72;

/**
 * Sprint 21 (PDR-031): the three genuinely time-based sweeps this
 * sprint needs, same lazy-but-periodic PeriodicTask pattern as
 * FulfilmentExceptionSweepService (Sprint 20a) - none of these three
 * have any other natural trigger point.
 *
 * 1. 48h vendor reminder (REQUESTED, no decision yet, no reminder sent
 *    for THIS request yet) - notifies the branch, does NOT change
 *    status.
 * 2. 72h auto-escalation (REQUESTED, still no decision 72h after
 *    createdAt) - PDR-031's own "delayed notice at 72" read literally
 *    as the escalation trigger itself, not just a second reminder.
 * 3. Two genuinely independent timeouts with the SAME target status
 *    (REJECTED_CLOSED is wrong here - see below) -
 *    a. dispute-window closure: REJECTED whose disputeDeadlineAt has
 *       passed with no dispute filed -> REJECTED_CLOSED (resubmission
 *       allowed).
 *    b. code expiry: APPROVED_AWAITING_DROPOFF whose codeExpiresAt has
 *       passed with no redemption -> EXPIRED (resubmission allowed).
 *
 * Every candidate is locked and re-validated under its own
 * transaction (never a batch transaction) - one return's outcome
 * never blocks or depends on another's.
 */
@Injectable()
export class ReturnSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReturnSweepService.name);
  private readonly task = new PeriodicTask(
    SWEEP_INTERVAL_MS,
    () => this.sweepOnce().then(() => undefined),
    (err) => this.logger.error('ReturnSweepService tick failed', err as Error),
    ReturnSweepService.name,
  );
  /** TB-11: one backoff per step - a return failing in one step is not deferred in another. */
  private readonly backoff = {
    vendorReminders: new SweepBackoff(),
    autoEscalation: new SweepBackoff(),
    disputeWindows: new SweepBackoff(),
    codeExpiry: new SweepBackoff(),
  };
  /** TB-11: the last tick's per-step results (tests read it). */
  lastTick: SweepStepResult[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxEventService,
    private readonly auditLog: AuditLogService,
    private readonly alertRecipients: PlatformAlertRecipientsService,
  ) {}

  onModuleInit() {
    this.task.start();
  }

  onModuleDestroy() {
    this.task.stop();
  }

  async sweepOnce(): Promise<{
    vendorReminders: number;
    autoEscalated: number;
    disputeWindowsClosed: number;
    codesExpired: number;
  }> {
    // TB-11: each step isolated (runSweepStep never throws), so a failure
    // in one never stops the next.
    const startedAt = Date.now();
    const steps = [
      await this.sweepVendorReminders(),
      await this.sweepAutoEscalation(),
      await this.sweepDisputeWindowClosure(),
      await this.sweepCodeExpiry(),
    ];
    this.lastTick = steps;
    logSweepTick(this.logger, steps, startedAt);
    const [vendorReminders, autoEscalated, disputeWindowsClosed, codesExpired] =
      steps.map((s) => s.done);
    return {
      vendorReminders,
      autoEscalated,
      disputeWindowsClosed,
      codesExpired,
    };
  }

  private sweepVendorReminders(): Promise<SweepStepResult> {
    return runSweepStep({
      step: 'vendorReminders',
      logger: this.logger,
      backoff: this.backoff.vendorReminders,
      findCandidates: async (excluded) =>
        (
          await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM returns
            WHERE status = 'REQUESTED'
              AND "vendorReminderSentAt" IS NULL
              AND "createdAt" <= now() - make_interval(hours => ${VENDOR_REVIEW_SLA_HOURS})
              AND id <> ALL(${excluded}::text[])
            ORDER BY "createdAt" ASC
            LIMIT ${BATCH_LIMIT}
          `
        ).map((r) => r.id),
      processItem: (id) =>
        sweepTransaction(this.prisma, (tx) =>
          this.sendVendorReminderOnce(tx, id),
        ),
    });
  }

  private async sendVendorReminderOnce(
    tx: Prisma.TransactionClient,
    returnId: string,
  ): Promise<boolean> {
    if (!(await this.lockReturnRow(tx, returnId))) return false;
    const r = await tx.return.findUnique({ where: { id: returnId } });
    if (!r || r.status !== 'REQUESTED' || r.vendorReminderSentAt !== null) {
      return false;
    }
    await tx.return.update({
      where: { id: returnId },
      data: { vendorReminderSentAt: new Date() },
    });
    const item = await tx.branchOrderItem.findUniqueOrThrow({
      where: { id: r.branchOrderItemId },
      include: { branchOrder: true },
    });
    await this.notifyBranch(
      tx,
      r.vendorId,
      item.branchOrder.branchId,
      'return.vendor_reminder',
      { return_id: returnId },
    );
    return true;
  }

  private sweepAutoEscalation(): Promise<SweepStepResult> {
    return runSweepStep({
      step: 'autoEscalation',
      logger: this.logger,
      backoff: this.backoff.autoEscalation,
      findCandidates: async (excluded) =>
        (
          await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM returns
            WHERE status = 'REQUESTED'
              AND "createdAt" <= now() - make_interval(hours => ${ESCALATION_TIMEOUT_HOURS})
              AND id <> ALL(${excluded}::text[])
            ORDER BY "createdAt" ASC
            LIMIT ${BATCH_LIMIT}
          `
        ).map((r) => r.id),
      processItem: (id) =>
        sweepTransaction(this.prisma, (tx) => this.escalateOnce(tx, id)),
    });
  }

  private async escalateOnce(
    tx: Prisma.TransactionClient,
    returnId: string,
  ): Promise<boolean> {
    if (!(await this.lockReturnRow(tx, returnId))) return false;
    const r = await tx.return.findUnique({ where: { id: returnId } });
    if (!r || r.status !== 'REQUESTED') {
      return false;
    }
    await tx.return.update({
      where: { id: returnId },
      data: { status: 'ESCALATED', escalatedAt: new Date() },
    });
    // Review-round requirement: every automatic transition gets its
    // own AuditLog row too, same as every human-triggered one -
    // actorId null (no human actor), a fresh correlationId per sweep
    // tick (same convention as FulfilmentExceptionSweepService's own
    // resolveTimeoutOnce).
    await this.auditLog.record(
      {
        actorId: null,
        correlationId: randomUUID(),
        action: 'return.auto_escalated',
        entityType: 'Return',
        entityId: returnId,
        beforeState: { status: 'REQUESTED' },
        afterState: { status: 'ESCALATED' },
      },
      tx,
    );
    await enqueueReturnEscalationAlert(
      tx,
      this.outbox,
      this.alertRecipients,
      returnId,
      'SLA_TIMEOUT',
    );
    await this.notifyCustomerForReturn(tx, returnId, 'return.escalated');
    return true;
  }

  private sweepDisputeWindowClosure(): Promise<SweepStepResult> {
    return runSweepStep({
      step: 'disputeWindows',
      logger: this.logger,
      backoff: this.backoff.disputeWindows,
      findCandidates: async (excluded) =>
        (
          await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM returns
            WHERE status = 'REJECTED'
              AND "disputeDeadlineAt" IS NOT NULL
              AND "disputeDeadlineAt" <= now()
              AND id <> ALL(${excluded}::text[])
            ORDER BY "disputeDeadlineAt" ASC
            LIMIT ${BATCH_LIMIT}
          `
        ).map((r) => r.id),
      processItem: (id) =>
        sweepTransaction(this.prisma, (tx) =>
          this.closeDisputeWindowOnce(tx, id),
        ),
    });
  }

  private async closeDisputeWindowOnce(
    tx: Prisma.TransactionClient,
    returnId: string,
  ): Promise<boolean> {
    if (!(await this.lockReturnRow(tx, returnId))) return false;
    const r = await tx.return.findUnique({ where: { id: returnId } });
    if (
      !r ||
      r.status !== 'REJECTED' ||
      !r.disputeDeadlineAt ||
      r.disputeDeadlineAt > new Date()
    ) {
      return false;
    }
    await tx.return.update({
      where: { id: returnId },
      data: { status: 'REJECTED_CLOSED' },
    });
    await this.auditLog.record(
      {
        actorId: null,
        correlationId: randomUUID(),
        action: 'return.dispute_window_closed',
        entityType: 'Return',
        entityId: returnId,
        beforeState: { status: 'REJECTED' },
        afterState: { status: 'REJECTED_CLOSED' },
      },
      tx,
    );
    return true;
  }

  private sweepCodeExpiry(): Promise<SweepStepResult> {
    return runSweepStep({
      step: 'codeExpiry',
      logger: this.logger,
      backoff: this.backoff.codeExpiry,
      findCandidates: async (excluded) =>
        (
          await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM returns
            WHERE status = 'APPROVED_AWAITING_DROPOFF'
              AND "codeExpiresAt" IS NOT NULL
              AND "codeExpiresAt" <= now()
              AND id <> ALL(${excluded}::text[])
            ORDER BY "codeExpiresAt" ASC
            LIMIT ${BATCH_LIMIT}
          `
        ).map((r) => r.id),
      processItem: (id) =>
        sweepTransaction(this.prisma, (tx) => this.expireCodeOnce(tx, id)),
    });
  }

  private async expireCodeOnce(
    tx: Prisma.TransactionClient,
    returnId: string,
  ): Promise<boolean> {
    if (!(await this.lockReturnRow(tx, returnId))) return false;
    const r = await tx.return.findUnique({ where: { id: returnId } });
    if (
      !r ||
      r.status !== 'APPROVED_AWAITING_DROPOFF' ||
      !r.codeExpiresAt ||
      r.codeExpiresAt > new Date()
    ) {
      return false;
    }

    // Sprint 21b: an EXCHANGE outcome's 24h hold on the replacement
    // must be released in this SAME transaction as the status flip -
    // whichever of this sweep or a concurrent redeem() commits first
    // (both lock this Return row first) deterministically wins; the
    // other sees the already-transitioned status and exits cleanly
    // (redeem()'s own re-check of status/code already covers that
    // side, same as always).
    if (
      r.desiredOutcome === 'EXCHANGE' &&
      r.replacementBranchId &&
      r.replacementOfferVariantId
    ) {
      const item = await tx.branchOrderItem.findUniqueOrThrow({
        where: { id: r.branchOrderItemId },
        select: { quantity: true },
      });
      const stock = await lockSweepOrCreateStockRow(
        tx,
        r.vendorId,
        r.replacementBranchId,
        r.replacementOfferVariantId,
      );
      await tx.branchStock.update({
        where: { id: stock.id },
        data: { reservedQuantity: { decrement: item.quantity } },
      });
    }

    await tx.return.update({
      where: { id: returnId },
      data: { status: 'EXPIRED' },
    });
    await this.auditLog.record(
      {
        actorId: null,
        correlationId: randomUUID(),
        action: 'return.code_expired',
        entityType: 'Return',
        entityId: returnId,
        beforeState: { status: 'APPROVED_AWAITING_DROPOFF' },
        afterState: { status: 'EXPIRED' },
      },
      tx,
    );
    await this.notifyCustomerForReturn(tx, returnId, 'return.code_expired');
    return true;
  }

  /**
   * TB-11: the return row for one sweep item - SKIP LOCKED, so another
   * API instance (or a customer/staff action) already working on it is
   * left alone instead of waited for; the caller re-checks the state
   * under the lock as before. False when it is held elsewhere or gone.
   */
  private async lockReturnRow(
    tx: Prisma.TransactionClient,
    returnId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM returns WHERE id = ${returnId} FOR UPDATE SKIP LOCKED`;
    return rows.length > 0;
  }

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
    // vendor_id/branch_id put the notification in that store's
    // workspace (and its link on that branch's returns page).
    for (const r of recipients) {
      await this.outbox.enqueue(
        {
          eventType,
          audience: 'STORE',
          payload: {
            ...payload,
            vendor_id: vendorId,
            branch_id: branchId,
            recipient_user_id: r.userId,
          },
        },
        tx,
      );
    }
  }

  private async notifyCustomerForReturn(
    tx: Prisma.TransactionClient,
    returnId: string,
    eventType: string,
  ): Promise<void> {
    const r = await tx.return.findUniqueOrThrow({
      where: { id: returnId },
      include: {
        branchOrderItem: {
          include: {
            branchOrder: {
              include: {
                customerOrder: {
                  select: { customer: { select: { userId: true } } },
                },
              },
            },
          },
        },
      },
    });
    await this.outbox.enqueue(
      {
        eventType,
        audience: 'CUSTOMER',
        payload: {
          return_id: returnId,
          recipient_user_id:
            r.branchOrderItem.branchOrder.customerOrder.customer.userId,
        },
      },
      tx,
    );
  }
}
