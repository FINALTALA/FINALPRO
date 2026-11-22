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
import { isLockTimeout } from '../common/sweep-runner.util';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { releaseReservationItemHolds } from './stock-lock.util';

const SWEEP_INTERVAL_MS = 60_000;
/** Approved (TB-8): a hold is swept only once it expired more than this long ago, by the DATABASE clock. */
export const RESERVATION_SWEEP_GRACE_SECONDS = 60;
export const RESERVATION_SWEEP_BATCH_LIMIT = 100;
/** A tick stops starting new reservations after this long; the rest wait for the next tick. */
export const RESERVATION_SWEEP_TICK_BUDGET_MS = 10_000;
/** Approved (TB-8): how long one sweep transaction waits for any one lock. */
const LOCK_TIMEOUT = '3s';
/**
 * TB-8.3: an expired hold older than this still in the table after a tick
 * that released NOTHING means the sweep is stuck (every candidate locked,
 * timing out or failing) - that is the only case worth a WARN. A tick that
 * made progress and left the rest of a large backlog to the next tick (the
 * batch limit) is normal and logs at LOG level only.
 */
const BACKLOG_WARN_MINUTES = 60;

export const RESERVATION_SWEEP_AUDIT_ACTION =
  'checkout.reservation_expired_released';

export interface ReservationSweepResult {
  /** The flag was off - nothing was read or written. */
  disabled: boolean;
  /** Another tick of this same process was still running. */
  overlapped: boolean;
  candidates: number;
  released: number;
  /** Locked by a live reserve/confirm/cancel/POS (SKIP LOCKED), already gone, or a lock wait over LOCK_TIMEOUT. */
  skipped: number;
  failed: number;
  items: number;
  units: number;
  slots: number;
  stoppedByBudget: boolean;
  /** TB-8.3: old expired holds remained and this tick released none - logged as a WARN. */
  backlogWarned: boolean;
}

type ReleaseOutcome =
  | { kind: 'released'; items: number; units: number; slots: number }
  | { kind: 'skipped' };

/**
 * TB-8: the periodic release of expired checkout reservations, so an
 * abandoned hold stops counting in BranchStock.reservedQuantity (the
 * vendor's inventory page, low-stock flags, return-exchange options)
 * even when nothing else ever touches its stock row again. The lazy
 * release paths (reserve/confirm/cancel/POS/restock) are unchanged;
 * this only does the same release on a timer.
 *
 * Safe with any number of API instances and alongside every checkout
 * path, by construction:
 *  - gated by the `reservation_sweep_enabled` flag (off by default);
 *  - candidates are holds whose expiresAt is more than
 *    RESERVATION_SWEEP_GRACE_SECONDS in the past by the database's own
 *    now() - never an app-server clock;
 *  - one transaction per reservation: its row FOR UPDATE SKIP LOCKED
 *    with the expiry condition re-checked in that same statement, so a
 *    reservation a reserve()/confirm()/cancel()/POS sweep holds is
 *    skipped, never waited for, and a live one can never match;
 *  - then the same lock order as cancel() (reservation row, then its
 *    stock rows in canonical order) through the same release primitive
 *    (releaseReservationItemHolds): an item is deleted first and its
 *    quantity given back only if this transaction deleted it, so
 *    nothing is ever released twice, and only checkout items are
 *    touched - a return-exchange hold on the same row never is;
 *  - `lock_timeout` 3s in this transaction only: a long wait on a stock
 *    row rolls back just this reservation, retried next tick;
 *  - an error rolls back just that reservation; the tick goes on.
 * One audit row per released reservation (system actor; counts only -
 * no phone, address, price or stock figure). Not started under tests
 * (PeriodicTask); tests call sweepOnce() directly.
 */
@Injectable()
export class ReservationSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservationSweepService.name);
  private readonly task = new PeriodicTask(
    SWEEP_INTERVAL_MS,
    () => this.sweepOnce().then(() => undefined),
    (err) =>
      this.logger.error('ReservationSweepService tick failed', err as Error),
    ReservationSweepService.name,
  );
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly flags: FeatureFlagsService,
  ) {}

  onModuleInit() {
    this.task.start();
  }

  onModuleDestroy() {
    this.task.stop();
  }

  async sweepOnce(
    options: { limit?: number; budgetMs?: number } = {},
  ): Promise<ReservationSweepResult> {
    const result: ReservationSweepResult = {
      disabled: false,
      overlapped: false,
      candidates: 0,
      released: 0,
      skipped: 0,
      failed: 0,
      items: 0,
      units: 0,
      slots: 0,
      stoppedByBudget: false,
      backlogWarned: false,
    };
    if (this.running) return { ...result, overlapped: true };
    this.running = true;
    try {
      if (!(await this.flags.isEnabled('reservation_sweep_enabled'))) {
        return { ...result, disabled: true };
      }
      const limit = options.limit ?? RESERVATION_SWEEP_BATCH_LIMIT;
      const budgetMs = options.budgetMs ?? RESERVATION_SWEEP_TICK_BUDGET_MS;
      const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM checkout_reservations
        WHERE "expiresAt" < now() - make_interval(secs => ${RESERVATION_SWEEP_GRACE_SECONDS})
        ORDER BY "expiresAt" ASC, id ASC
        LIMIT ${limit}`;
      result.candidates = candidates.length;
      const started = Date.now();
      for (const { id } of candidates) {
        if (Date.now() - started >= budgetMs) {
          result.stoppedByBudget = true;
          break;
        }
        try {
          const outcome = await this.prisma.$transaction((tx) =>
            this.releaseOne(tx, id),
          );
          if (outcome.kind === 'skipped') {
            result.skipped += 1;
            continue;
          }
          result.released += 1;
          result.items += outcome.items;
          result.units += outcome.units;
          result.slots += outcome.slots;
        } catch (err) {
          if (isLockTimeout(err)) {
            result.skipped += 1;
            continue;
          }
          result.failed += 1;
          this.logger.error(
            `ReservationSweepService: reservation ${id} not released (rolled back, retried next tick)`,
            err as Error,
          );
        }
      }
      await this.report(result);
      return result;
    } finally {
      this.running = false;
    }
  }

  /** One reservation, in its own transaction - see the class comment for the lock order. */
  private async releaseOne(
    tx: Prisma.TransactionClient,
    reservationId: string,
  ): Promise<ReleaseOutcome> {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    const rows = await tx.$queryRaw<{ id: string; expiresAt: Date }[]>`
      SELECT id, "expiresAt" FROM checkout_reservations
      WHERE id = ${reservationId}
        AND "expiresAt" < now() - make_interval(secs => ${RESERVATION_SWEEP_GRACE_SECONDS})
      FOR UPDATE SKIP LOCKED`;
    const reservation = rows[0];
    if (!reservation) return { kind: 'skipped' };

    const items = await tx.checkoutReservationItem.findMany({
      where: { reservationId },
      select: {
        id: true,
        vendorId: true,
        branchId: true,
        offerVariantId: true,
        quantity: true,
      },
    });
    const slots = await tx.checkoutReservationSlot.count({
      where: { reservationId },
    });
    const released = await releaseReservationItemHolds(tx, items);
    // Its slots cascade with it; capacity is counted from live holds
    // only, so this changes no window's availability.
    await tx.checkoutReservation.delete({ where: { id: reservationId } });
    await this.auditLog.record(
      {
        actorId: null,
        correlationId: randomUUID(),
        action: RESERVATION_SWEEP_AUDIT_ACTION,
        entityType: 'CheckoutReservation',
        entityId: reservationId,
        beforeState: {
          expires_at: reservation.expiresAt.toISOString(),
          items: released.items,
          units: released.units,
          slots,
        },
      },
      tx,
    );
    return { kind: 'released', ...released, slots };
  }

  private async report(result: ReservationSweepResult): Promise<void> {
    if (result.candidates > 0) {
      const summary = `ReservationSweepService: released ${result.released} expired reservation(s) (${result.items} item(s), ${result.units} unit(s), ${result.slots} slot(s)), skipped ${result.skipped}, failed ${result.failed}${result.stoppedByBudget ? ', stopped by time budget' : ''}`;
      if (result.failed > 0) this.logger.warn(summary);
      else this.logger.log(summary);
    }
    const stale = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM checkout_reservations
      WHERE "expiresAt" < now() - make_interval(mins => ${BACKLOG_WARN_MINUTES})`;
    const staleCount = stale[0]?.n ?? 0;
    if (staleCount > 0 && result.released === 0) {
      result.backlogWarned = true;
      this.logger.warn(
        `ReservationSweepService: ${staleCount} reservation(s) expired more than ${BACKLOG_WARN_MINUTES} minutes ago are still held and this tick released none`,
      );
    }
  }
}
