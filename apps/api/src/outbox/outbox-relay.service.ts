import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  NotificationTargetType,
  NotificationType,
  Prisma,
} from '../../generated/prisma/client';
import { PeriodicTask } from '../common/periodic-task.util';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationChannelService } from './notification-channel.service';

const MAX_ATTEMPTS = 5;
const BASE_DELAY_SECONDS = 30;
const MAX_DELAY_SECONDS = 3600;
const LEASE_SECONDS = 120;
const DISPATCH_INTERVAL_MS = 3000;
const FOLLOWER_BATCH_SIZE = 200;
// Review-round fix: a follower-fanout row used to drain every batch in
// one process() call, which could monopolize the relay for as long as
// that row had targets left - a normal event enqueued meanwhile would
// not be touched until the whole fan-out finished. Now exactly one
// batch is processed per claim; if more targets remain, the row is
// released back to PENDING with its availableAt pushed this many
// seconds out, so it is simply not eligible for the next several
// claim() calls and whatever else is actually oldest-and-eligible
// (a normal event, in particular) gets picked instead.
const FOLLOWER_YIELD_SECONDS = 2;

interface NotifyItem {
  recipientUserId: string;
  type: NotificationType;
  targetType: NotificationTargetType;
  targetId: string;
  data: Record<string, unknown>;
}

function backoffSeconds(attemptCount: number): number {
  return Math.min(MAX_DELAY_SECONDS, BASE_DELAY_SECONDS * 2 ** attemptCount);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

interface EventMapping {
  type: NotificationType;
  targetType: NotificationTargetType;
  targetIdField: string;
}

// Every "normal" (single-recipient) event type this relay knows how to
// dispatch - by the time a non-legacy row reaches here,
// payload.recipient_user_id is ALWAYS present (every enqueue call site
// snapshots it at write time; see each controller's own comment - and
// any pre-S19 row that never had one was already moved to DEAD_LETTER
// by this sprint's own migration). The two FOLLOWED_STORE_* types are
// NOT in this map - they fan out via OutboxDeliveryTarget instead (see
// dispatchFollowerBatch below).
const EVENT_TYPE_MAP: Record<string, EventMapping> = {
  'stock_movement.owner_notification': {
    type: 'STOCK_ADJUSTMENT',
    targetType: 'STOCK',
    targetIdField: 'offer_variant_id',
  },
  'branch_order.delivered_confirm_requested': {
    type: 'DELIVERY_CONFIRM_REQUESTED',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  'branch_order.confirm_rerequested': {
    type: 'DELIVERY_CONFIRM_REQUESTED',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  'branch_order.not_received_reported': {
    type: 'NOT_RECEIVED_REPORTED',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  'branch_order.auto_confirmed_72h': {
    type: 'ORDER_AUTO_CONFIRMED',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  'branch_order.confirm_reminder_48h': {
    type: 'DELIVERY_CONFIRM_REMINDER',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  'vendor.suspended': {
    type: 'VENDOR_SUSPENDED',
    targetType: 'VENDOR',
    targetIdField: 'vendor_id',
  },
  'vendor.reactivated': {
    type: 'VENDOR_REACTIVATED',
    targetType: 'VENDOR',
    targetIdField: 'vendor_id',
  },
  'branch_order.new_order_for_employee': {
    type: 'NEW_ORDER_FOR_EMPLOYEE',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  'checkout.low_stock_after_reserve': {
    type: 'LOW_STOCK_AFTER_RESERVE',
    targetType: 'STOCK',
    targetIdField: 'offer_variant_id',
  },
  // Sprint 20a (PDR-025/027/028): fulfilment exceptions/cancellation/
  // refund. 'branch_order.cancelled' covers every cancellation trigger
  // (customer, staff, admin forced, or an automatic 48h timeout that
  // resolves to CANCELLED for a COD order) - the customer/branch-facing
  // message is the same regardless of who/what initiated it.
  'branch_order.cancelled': {
    type: 'ORDER_CANCELLED',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  'branch_order.rescheduled': {
    type: 'ORDER_RESCHEDULED',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  'branch_order.delivery_failed': {
    type: 'DELIVERY_FAILED',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  'branch_order.refund_requested': {
    type: 'REFUND_REQUESTED',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  // Covers both a staff-approved REFUND_REQUESTED->REFUNDED resolution
  // and a PLATFORM_ADMIN manual refund - both are a human-approved
  // refund decision from the customer's own point of view.
  'branch_order.refund_approved': {
    type: 'REFUND_APPROVED',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  // The sweep's own PDR-025/027 48h-timeout outcome when it resolves to
  // REFUNDED (ONLINE) - no human approved this one, so it gets its own
  // type rather than reusing REFUND_APPROVED.
  'branch_order.refund_automatic': {
    type: 'REFUND_AUTOMATIC',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  'branch_order.slot_missed': {
    type: 'SLOT_MISSED',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  'branch_order.prep_reminder': {
    type: 'PREP_REMINDER',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
};

const FOLLOWER_EVENT_TYPE_MAP: Record<
  string,
  { type: NotificationType; targetIdField: string }
> = {
  'offer.published_for_followers': {
    type: 'FOLLOWED_STORE_NEW_PRODUCT',
    targetIdField: 'offer_id',
  },
  'offer.discount_activated_for_followers': {
    type: 'FOLLOWED_STORE_DISCOUNT',
    targetIdField: 'offer_variant_id',
  },
};

// Whitelist-only, per eventType - the single place that decides what,
// if anything, is safe to copy into Notification.data. Deliberately
// never passes the raw payload through: stock_movement.reason_note and
// branch_order.not_received_reported's own `reason` are both free text
// from a user and must never reach here, no matter what the payload
// object happens to contain.
function buildSafeData(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventType) {
    case 'stock_movement.owner_notification':
      return { reason: payload.reason };
    case 'vendor.suspended':
      return { reason_code: payload.reason_code };
    case 'checkout.low_stock_after_reserve':
      return { remaining_quantity: payload.remaining_quantity };
    default:
      return {};
  }
}

/**
 * Sprint 19: the relay half of ADR-006's transactional outbox - see
 * OutboxEvent's own schema.prisma comment for the full two-phase
 * claim/process state machine this implements exactly. "Dispatched"
 * means "a Notification row was durably created" - that commit is what
 * PUBLISHED/FAILED/DEAD_LETTER are about, and NotificationChannelService
 * never gates any of it. It IS called, but only after the transaction
 * that created the Notification row(s) has already committed, and
 * strictly best-effort (see notifyBestEffort below): its failure, or
 * never getting called at all, has no effect on delivery guarantees.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly task = new PeriodicTask(
    DISPATCH_INTERVAL_MS,
    () => this.dispatchOnce().then(() => undefined),
    (err) => this.logger.error('OutboxRelayService tick failed', err as Error),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly channel: NotificationChannelService,
  ) {}

  onModuleInit() {
    this.task.start();
  }

  onModuleDestroy() {
    this.task.stop();
  }

  /** Claims and processes at most one outbox row, doing at most one
   * unit of work on it (a normal single-recipient dispatch, which is
   * always everything that row needs - or exactly one
   * FOLLOWER_BATCH_SIZE-sized batch of a follower fan-out, which may
   * leave more targets for a later call). Returns whether it did any
   * work at all - tests drain a backlog deterministically with `while
   * (await relay.dispatchOnce()) {}` instead of waiting on the real
   * timer; a large follower fan-out now takes several dispatchOnce()
   * calls to fully drain rather than one, by design (see
   * FOLLOWER_YIELD_SECONDS). */
  async dispatchOnce(): Promise<boolean> {
    const claimed = await this.claim();
    if (!claimed) return false;
    if (claimed.immediatelyDeadLettered) return true;
    await this.process(claimed.id, claimed.lockToken!);
    return true;
  }

  private async claim(): Promise<{
    id: string;
    lockToken: string | null;
    immediatelyDeadLettered: boolean;
  } | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; status: string; attemptCount: number }[]
      >`
        SELECT id, status, "attemptCount" FROM outbox_events
        WHERE (status IN ('PENDING', 'FAILED') AND "availableAt" <= now())
           OR (status = 'PROCESSING' AND "lockedAt" < now() - make_interval(secs => ${LEASE_SECONDS}))
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      const row = rows[0];
      if (!row) return null;

      // A PROCESSING row whose lease expired AND is already at the
      // attempt ceiling - the worker(s) that held it before never
      // reached DEAD_LETTER themselves (they crashed before even
      // getting to the failure-handling branch), so this reclaim path
      // is what finally closes the loop, exactly as it must: a row can
      // be claimed at most MAX_ATTEMPTS times total, full stop.
      if (row.status === 'PROCESSING' && row.attemptCount >= MAX_ATTEMPTS) {
        await tx.$executeRaw`
          UPDATE outbox_events
          SET status = 'DEAD_LETTER',
              "lastError" = 'Exceeded max attempts while stuck in PROCESSING (worker crashed before ever reaching failure handling)'
          WHERE id = ${row.id}
        `;
        return { id: row.id, lockToken: null, immediatelyDeadLettered: true };
      }

      const lockToken = randomUUID();
      await tx.$executeRaw`
        UPDATE outbox_events
        SET status = 'PROCESSING', "lockedAt" = now(), "lockToken" = ${lockToken},
            "attemptCount" = "attemptCount" + 1
        WHERE id = ${row.id}
      `;
      return { id: row.id, lockToken, immediatelyDeadLettered: false };
    });
  }

  private async process(id: string, lockToken: string): Promise<void> {
    const notifyItems: NotifyItem[] = [];
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          status: string;
          lockToken: string | null;
          eventType: string;
          payload: Prisma.JsonValue;
          attemptCount: number;
        }[]
      >`SELECT status, "lockToken", "eventType", payload, "attemptCount" FROM outbox_events WHERE id = ${id} FOR UPDATE`;
      const row = rows[0];
      // Not ours any more (a later worker already reclaimed - and
      // maybe even finished - this row while we were stalled past our
      // own lease). Do nothing at all: no Notification, no status
      // write, nothing - exactly the review-round requirement.
      if (!row || row.status !== 'PROCESSING' || row.lockToken !== lockToken) {
        return;
      }

      try {
        const fullyDone = await this.dispatchByEventType(
          tx,
          id,
          row.eventType,
          row.payload as Record<string, unknown>,
          notifyItems,
        );
        if (fullyDone) {
          await tx.$executeRaw`UPDATE outbox_events SET status = 'PUBLISHED', "publishedAt" = now() WHERE id = ${id} AND "lockToken" = ${lockToken}`;
          return;
        }
        // A follower-fanout row with more targets left to drain. This
        // is progress, not a failure - but it is also a full batch's
        // worth of real work, so instead of looping internally (which
        // would let one huge fan-out monopolize the relay, see
        // FOLLOWER_YIELD_SECONDS's own comment), release the row back
        // to PENDING with a short cooldown and let the next claim()
        // decide fairly what to work on next, possibly a different
        // row. attemptCount is decremented by exactly the amount the
        // next claim() is about to re-add, so this voluntary yield
        // never erodes the attempt budget the way a real stall/crash
        // correctly does - a multi-batch drain can take arbitrarily
        // many yields without ever approaching MAX_ATTEMPTS on its
        // own.
        // clock_timestamp(), not now(): now() is frozen at this
        // transaction's START, which for a follower batch can be a full
        // FOLLOWER_BATCH_SIZE's worth of sequential SAVEPOINT round-trips
        // earlier than this actual statement - anchoring the cooldown to
        // now() would silently eat however long that batch just took
        // out of the intended FOLLOWER_YIELD_SECONDS margin.
        await tx.$executeRaw`
          UPDATE outbox_events
          SET status = 'PENDING',
              "lockedAt" = NULL,
              "lockToken" = NULL,
              "attemptCount" = GREATEST("attemptCount" - 1, 0),
              "availableAt" = clock_timestamp() + make_interval(secs => ${FOLLOWER_YIELD_SECONDS})
          WHERE id = ${id} AND "lockToken" = ${lockToken}
        `;
      } catch (err) {
        // Caught, not re-thrown: the failure-state UPDATE below must
        // itself survive and COMMIT, which re-throwing would undo
        // (rollback would erase both this write AND any partial
        // progress already made this attempt - e.g. some, but not
        // all, Notification rows in a batch - that a retry should be
        // able to build on via the unique-constraint-as-checkpoint).
        const message =
          err instanceof Error ? err.message.slice(0, 500) : String(err);
        await tx.$executeRaw`
          UPDATE outbox_events
          SET status = CASE WHEN "attemptCount" >= ${MAX_ATTEMPTS} THEN 'DEAD_LETTER'::"OutboxEventStatus" ELSE 'FAILED'::"OutboxEventStatus" END,
              "availableAt" = clock_timestamp() + make_interval(secs => ${backoffSeconds(row.attemptCount)}),
              "lastError" = ${message}
          WHERE id = ${id} AND "lockToken" = ${lockToken}
        `;
      }
    });

    // Best-effort, after commit, never gating anything above - each
    // item here is a Notification row that is already durably saved
    // regardless of what notifyBestEffort does with it.
    for (const item of notifyItems) {
      await this.notifyBestEffort(item);
    }
  }

  private async notifyBestEffort(item: NotifyItem): Promise<void> {
    try {
      await this.channel.notify(
        item.recipientUserId,
        `type=${item.type} target=${item.targetType}:${item.targetId} data=${JSON.stringify(item.data)}`,
      );
    } catch (err) {
      this.logger.warn(
        `NotificationChannelService.notify failed for recipient ${item.recipientUserId}`,
        err as Error,
      );
    }
  }

  /** Returns whether this outbox row is now fully dispatched (true for
   * every "normal" single-recipient event type, since those are always
   * done in one call; for a follower-fanout type, only once every
   * OutboxDeliveryTarget row has been drained, which may take several
   * separate `process()` invocations - see FOLLOWER_YIELD_SECONDS). */
  private async dispatchByEventType(
    tx: Prisma.TransactionClient,
    outboxEventId: string,
    eventType: string,
    payload: Record<string, unknown>,
    notifyItems: NotifyItem[],
  ): Promise<boolean> {
    const followerMapping = FOLLOWER_EVENT_TYPE_MAP[eventType];
    if (followerMapping) {
      return this.drainFollowerBatch(
        tx,
        outboxEventId,
        eventType,
        followerMapping,
        payload,
        notifyItems,
      );
    }

    const mapping = EVENT_TYPE_MAP[eventType];
    if (!mapping) {
      throw new Error(`OutboxRelayService: unknown eventType "${eventType}"`);
    }
    const recipientUserId = payload.recipient_user_id;
    if (typeof recipientUserId !== 'string' || !recipientUserId) {
      // Should be unreachable - this sprint's own migration dead-letters
      // every legacy row missing this field. A new call site that
      // forgets to snapshot a recipient would hit this instead of
      // silently resolving one at dispatch time, which is the point.
      throw new Error(
        `OutboxRelayService: missing recipient_user_id for eventType "${eventType}" (outbox event ${outboxEventId})`,
      );
    }
    const targetType = mapping.targetType;
    const targetId = String(payload[mapping.targetIdField] ?? '');
    const data = buildSafeData(eventType, payload);
    const created = await this.createNotification(
      tx,
      outboxEventId,
      recipientUserId,
      mapping.type,
      targetType,
      targetId,
      data,
      typeof payload.vendor_id === 'string' ? payload.vendor_id : null,
      typeof payload.branch_id === 'string' ? payload.branch_id : null,
    );
    if (created) {
      notifyItems.push({
        recipientUserId,
        type: mapping.type,
        targetType,
        targetId,
        data,
      });
    }
    return true;
  }

  private async drainFollowerBatch(
    tx: Prisma.TransactionClient,
    outboxEventId: string,
    eventType: string,
    mapping: { type: NotificationType; targetIdField: string },
    payload: Record<string, unknown>,
    notifyItems: NotifyItem[],
  ): Promise<boolean> {
    const targets = await tx.$queryRaw<
      { id: string; recipientUserId: string }[]
    >`
      SELECT id, "recipientUserId" FROM outbox_delivery_targets
      WHERE "outboxEventId" = ${outboxEventId} AND "processedAt" IS NULL
      ORDER BY id
      LIMIT ${FOLLOWER_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `;
    const targetId = String(payload[mapping.targetIdField] ?? '');
    const vendorId =
      typeof payload.vendor_id === 'string' ? payload.vendor_id : null;
    const safeData = buildSafeData(eventType, payload);
    for (const target of targets) {
      const created = await this.createNotification(
        tx,
        outboxEventId,
        target.recipientUserId,
        mapping.type,
        'OFFER',
        targetId,
        safeData,
        vendorId,
        null,
      );
      if (created) {
        notifyItems.push({
          recipientUserId: target.recipientUserId,
          type: mapping.type,
          targetType: 'OFFER',
          targetId,
          data: safeData,
        });
      }
      await tx.$executeRaw`UPDATE outbox_delivery_targets SET "processedAt" = now() WHERE id = ${target.id}`;
    }
    const remaining = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM outbox_delivery_targets
      WHERE "outboxEventId" = ${outboxEventId} AND "processedAt" IS NULL
    `;
    return Number(remaining[0].count) === 0;
  }

  /** Returns whether a NEW Notification row was actually inserted
   * (false for an idempotent retry that hit the unique constraint) -
   * the caller only queues a best-effort channel notify for a genuine
   * new delivery, never for a replay of one that already happened. */
  private async createNotification(
    tx: Prisma.TransactionClient,
    outboxEventId: string,
    recipientUserId: string,
    type: NotificationType,
    targetType: NotificationTargetType,
    targetId: string,
    data: Record<string, unknown>,
    vendorId: string | null,
    branchId: string | null,
  ): Promise<boolean> {
    // A unique-constraint hit here is EXPECTED (an idempotent retry
    // re-creating a Notification that already exists) - but Postgres
    // marks the WHOLE transaction aborted the instant any statement
    // errors, so without a SAVEPOINT, every later statement in this
    // same transaction (including the final PUBLISHED/FAILED UPDATE
    // itself) would fail with 25P02 even though the application-level
    // catch below looks like it handled the error. Same SAVEPOINT/
    // ROLLBACK TO SAVEPOINT technique checkout.service.ts's own
    // createPickupBranchOrderWithRetry() already established for
    // exactly this reason.
    await tx.$executeRaw`SAVEPOINT create_notification`;
    try {
      await tx.notification.create({
        data: {
          outboxEventId,
          recipientUserId,
          type,
          targetType,
          targetId,
          data: data as Prisma.InputJsonValue,
          vendorId,
          branchId,
        },
      });
      await tx.$executeRaw`RELEASE SAVEPOINT create_notification`;
      return true;
    } catch (err) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT create_notification`;
      // Already created by an earlier attempt on this same outbox
      // row/recipient pair (a crash between creating it and marking
      // PUBLISHED) - idempotent no-op, exactly the guarantee the
      // unique constraint exists to provide.
      if (!isUniqueViolation(err)) throw err;
      return false;
    }
  }
}
