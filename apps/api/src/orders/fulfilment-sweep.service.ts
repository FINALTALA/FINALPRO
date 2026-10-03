import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PeriodicTask } from '../common/periodic-task.util';
import { FulfilmentReconciliationService } from './fulfilment-reconciliation.service';
import { PrismaService } from '../prisma/prisma.service';

const SWEEP_INTERVAL_MS = 60_000;
const BATCH_LIMIT = 200;

/**
 * Sprint 19 (review-round finding): FulfilmentReconciliationService's
 * own reconcileOne() is - and stays - purely lazy, opportunistic,
 * triggered only when a real request happens to touch a specific
 * DELIVERED order (see its own class comment). That is NOT enough on
 * its own for a genuinely time-based 48h reminder / 72h auto-confirm:
 * an order nobody ever revisits would never get either, no matter how
 * good the Outbox relay is, because no outbox row for it would ever
 * even be CREATED. This service is the missing periodic sweep that
 * finds candidate orders and calls the already-safe reconcileOne() for
 * each - reusing its existing FOR UPDATE + idempotent-write safety
 * entirely as-is; this sweep adds no locking of its own beyond what
 * reconcileOne() already does per order.
 */
@Injectable()
export class FulfilmentSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FulfilmentSweepService.name);
  private readonly task = new PeriodicTask(
    SWEEP_INTERVAL_MS,
    () => this.sweepOnce().then(() => undefined),
    (err) =>
      this.logger.error('FulfilmentSweepService tick failed', err as Error),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: FulfilmentReconciliationService,
  ) {}

  onModuleInit() {
    this.task.start();
  }

  onModuleDestroy() {
    this.task.stop();
  }

  /** Finds every DELIVERED order genuinely due for a reminder or
   * auto-confirm and reconciles each in its own transaction (never one
   * order's outcome blocking another's - same convention this
   * service's own sweep helper already used before this sprint). */
  async sweepOnce(): Promise<number> {
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM branch_orders
      WHERE status = 'DELIVERED'
        AND "notReceivedReportedAt" IS NULL
        AND "deliveredAt" <= now() - interval '48 hours'
        AND (
          "confirmReminderSentAt" IS NULL
          OR "deliveredAt" <= now() - interval '72 hours'
        )
      ORDER BY "deliveredAt" ASC, id ASC
      LIMIT ${BATCH_LIMIT}
    `;
    for (const { id } of candidates) {
      await this.prisma.$transaction((tx) =>
        this.reconciliation.reconcileOne(tx, id, randomUUID()),
      );
    }
    return candidates.length;
  }
}
