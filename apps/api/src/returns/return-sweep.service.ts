import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PeriodicTask } from '../common/periodic-task.util';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';

const SWEEP_INTERVAL_MS = 60_000;
const BATCH_LIMIT = 200;
const VENDOR_REVIEW_SLA_HOURS = 48;
const ESCALATION_TIMEOUT_HOURS = 72;

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
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxEventService,
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
    const vendorReminders = await this.sweepVendorReminders();
    const autoEscalated = await this.sweepAutoEscalation();
    const disputeWindowsClosed = await this.sweepDisputeWindowClosure();
    const codesExpired = await this.sweepCodeExpiry();
    return {
      vendorReminders,
      autoEscalated,
      disputeWindowsClosed,
      codesExpired,
    };
  }

  private async sweepVendorReminders(): Promise<number> {
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM returns
      WHERE status = 'REQUESTED'
        AND "vendorReminderSentAt" IS NULL
        AND "createdAt" <= now() - make_interval(hours => ${VENDOR_REVIEW_SLA_HOURS})
      ORDER BY "createdAt" ASC
      LIMIT ${BATCH_LIMIT}
    `;
    let count = 0;
    for (const { id } of candidates) {
      const sent = await this.prisma.$transaction((tx) =>
        this.sendVendorReminderOnce(tx, id),
      );
      if (sent) count += 1;
    }
    return count;
  }

  private async sendVendorReminderOnce(
    tx: Prisma.TransactionClient,
    returnId: string,
  ): Promise<boolean> {
    await tx.$queryRaw`SELECT id FROM returns WHERE id = ${returnId} FOR UPDATE`;
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

  private async sweepAutoEscalation(): Promise<number> {
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM returns
      WHERE status = 'REQUESTED'
        AND "createdAt" <= now() - make_interval(hours => ${ESCALATION_TIMEOUT_HOURS})
      ORDER BY "createdAt" ASC
      LIMIT ${BATCH_LIMIT}
    `;
    let count = 0;
    for (const { id } of candidates) {
      const escalated = await this.prisma.$transaction((tx) =>
        this.escalateOnce(tx, id),
      );
      if (escalated) count += 1;
    }
    return count;
  }

  private async escalateOnce(
    tx: Prisma.TransactionClient,
    returnId: string,
  ): Promise<boolean> {
    await tx.$queryRaw`SELECT id FROM returns WHERE id = ${returnId} FOR UPDATE`;
    const r = await tx.return.findUnique({ where: { id: returnId } });
    if (!r || r.status !== 'REQUESTED') {
      return false;
    }
    await tx.return.update({
      where: { id: returnId },
      data: { status: 'ESCALATED', escalatedAt: new Date() },
    });
    await this.notifyAdmins(tx, 'return.auto_escalated', {
      return_id: returnId,
    });
    await this.notifyCustomerForReturn(tx, returnId, 'return.escalated');
    return true;
  }

  private async sweepDisputeWindowClosure(): Promise<number> {
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM returns
      WHERE status = 'REJECTED'
        AND "disputeDeadlineAt" IS NOT NULL
        AND "disputeDeadlineAt" <= now()
      ORDER BY "disputeDeadlineAt" ASC
      LIMIT ${BATCH_LIMIT}
    `;
    let count = 0;
    for (const { id } of candidates) {
      const closed = await this.prisma.$transaction((tx) =>
        this.closeDisputeWindowOnce(tx, id),
      );
      if (closed) count += 1;
    }
    return count;
  }

  private async closeDisputeWindowOnce(
    tx: Prisma.TransactionClient,
    returnId: string,
  ): Promise<boolean> {
    await tx.$queryRaw`SELECT id FROM returns WHERE id = ${returnId} FOR UPDATE`;
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
    return true;
  }

  private async sweepCodeExpiry(): Promise<number> {
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM returns
      WHERE status = 'APPROVED_AWAITING_DROPOFF'
        AND "codeExpiresAt" IS NOT NULL
        AND "codeExpiresAt" <= now()
      ORDER BY "codeExpiresAt" ASC
      LIMIT ${BATCH_LIMIT}
    `;
    let count = 0;
    for (const { id } of candidates) {
      const expired = await this.prisma.$transaction((tx) =>
        this.expireCodeOnce(tx, id),
      );
      if (expired) count += 1;
    }
    return count;
  }

  private async expireCodeOnce(
    tx: Prisma.TransactionClient,
    returnId: string,
  ): Promise<boolean> {
    await tx.$queryRaw`SELECT id FROM returns WHERE id = ${returnId} FOR UPDATE`;
    const r = await tx.return.findUnique({ where: { id: returnId } });
    if (
      !r ||
      r.status !== 'APPROVED_AWAITING_DROPOFF' ||
      !r.codeExpiresAt ||
      r.codeExpiresAt > new Date()
    ) {
      return false;
    }
    await tx.return.update({
      where: { id: returnId },
      data: { status: 'EXPIRED' },
    });
    await this.notifyCustomerForReturn(tx, returnId, 'return.code_expired');
    return true;
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
    for (const r of recipients) {
      await this.outbox.enqueue(
        { eventType, payload: { ...payload, recipient_user_id: r.userId } },
        tx,
      );
    }
  }

  /** No separate support-agent role exists - PLATFORM_ADMIN is the
   * only resolver (see Return's own ESCALATED/ADMIN_REJECTED comment). */
  private async notifyAdmins(
    tx: Prisma.TransactionClient,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const admins = await tx.user.findMany({
      where: { platformRole: 'PLATFORM_ADMIN' },
      select: { id: true },
    });
    for (const a of admins) {
      await this.outbox.enqueue(
        { eventType, payload: { ...payload, recipient_user_id: a.id } },
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
