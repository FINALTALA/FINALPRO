import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PeriodicTask } from '../common/periodic-task.util';
import {
  errorTag,
  logSweepTick,
  runSweepStep,
  SweepBackoff,
  sweepTransaction,
  type SweepStepResult,
} from '../common/sweep-runner.util';
import { BranchOrderIntegrityService } from './branch-order-integrity.service';
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
 *
 * TB-9: one order that threw used to end the whole tick - and since
 * candidates are oldest-first, one bad order blocked every other
 * reminder and auto-confirm on every tick. Each order is now isolated
 * (see reconcileMany), only DELIVERY orders are candidates, and a
 * separate integrity pass flags orders in states the state machine
 * never produces, once each.
 *
 * TB-11: the reconciliation step runs through the shared sweep runner
 * (deferral of failing orders, lock_timeout, one summary per tick) with
 * the order row taken FOR UPDATE SKIP LOCKED first, so another API
 * instance working on the same order is left alone; reconcileOne()'s own
 * FOR UPDATE then finds the lock already held by this transaction. The
 * integrity pass is its own step: its failure never stops the reminders.
 */
@Injectable()
export class FulfilmentSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FulfilmentSweepService.name);
  private readonly task = new PeriodicTask(
    SWEEP_INTERVAL_MS,
    () => this.sweepOnce().then(() => undefined),
    (err) =>
      this.logger.error('FulfilmentSweepService tick failed', err as Error),
    FulfilmentSweepService.name,
  );
  private readonly backoff = new SweepBackoff();
  /** TB-11: the last tick's per-step results (tests read it). */
  lastTick: SweepStepResult[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: FulfilmentReconciliationService,
    private readonly integrity: BranchOrderIntegrityService,
  ) {}

  onModuleInit() {
    this.task.start();
  }

  onModuleDestroy() {
    this.task.stop();
  }

  /** Finds every DELIVERY order in DELIVERED genuinely due for a
   * reminder or auto-confirm and reconciles each in its own
   * transaction and try/catch, then runs the integrity pass. Returns
   * the number of due orders found. */
  async sweepOnce(): Promise<number> {
    const correlationId = randomUUID();
    const startedAt = Date.now();
    const reconcile = await runSweepStep({
      step: 'reconcile',
      logger: this.logger,
      backoff: this.backoff,
      findCandidates: async (excluded) =>
        (
          await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM branch_orders
      WHERE status = 'DELIVERED'
        AND "fulfilmentMethod" = 'DELIVERY'
        AND "notReceivedReportedAt" IS NULL
        AND "deliveredAt" <= now() - interval '48 hours'
        AND (
          "confirmReminderSentAt" IS NULL
          OR "deliveredAt" <= now() - interval '72 hours'
        )
        AND id <> ALL(${excluded}::text[])
      ORDER BY "deliveredAt" ASC, id ASC
      LIMIT ${BATCH_LIMIT}
    `
        ).map((r) => r.id),
      processItem: (id) =>
        sweepTransaction(this.prisma, async (tx) => {
          const held = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM branch_orders WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
          if (held.length === 0) return false;
          await this.reconciliation.reconcileOne(tx, id, correlationId);
          return true;
        }),
    });
    // The integrity pass isolates its own orders; this only keeps its
    // failure as a whole from ending the tick.
    const integrity: SweepStepResult = {
      step: 'integrity',
      candidates: 0,
      done: 0,
      notDone: 0,
      lockTimeouts: 0,
      failed: 0,
      newFailures: 0,
      deferred: 0,
      stepFailed: false,
    };
    try {
      const r = await this.integrity.flagInvalidOrders(correlationId);
      integrity.done = r.flagged;
      integrity.failed = r.failed;
      integrity.newFailures = r.failed;
      integrity.candidates = r.flagged + r.failed;
    } catch (err) {
      integrity.stepFailed = true;
      this.logger.error(
        `integrity: pass failed (${errorTag(err)})`,
        (err as Error)?.stack,
      );
    }
    this.lastTick = [reconcile, integrity];
    logSweepTick(this.logger, this.lastTick, startedAt);
    return reconcile.candidates;
  }
}
