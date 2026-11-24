import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  NotificationAudience,
  NotificationTargetType,
  NotificationType,
  Prisma,
} from '../../generated/prisma/client';
import { PeriodicTask } from '../common/periodic-task.util';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationChannelService } from './notification-channel.service';
import {
  isReturnStoreEventType,
  RETURN_STORE_EVENT_TYPES,
  ReturnStoreEventType,
  storeReturnRecipients,
  storeReturnSafeData,
} from './return-store-events';

const MAX_ATTEMPTS = 5;
const BASE_DELAY_SECONDS = 30;
const MAX_DELAY_SECONDS = 3600;
const LEASE_SECONDS = 120;
const DISPATCH_INTERVAL_MS = 3000;
/**
 * TB-11: one timer tick dispatches up to this many rows, within
 * RELAY_TICK_BUDGET_MS - one row per 3 s capped the relay at ~20 a
 * minute per instance, so a burst from one sweep (e.g. many discount
 * notices) held every other notification back behind it. dispatchOnce()
 * itself is unchanged (still at most one row) for the tests that drive
 * it directly.
 */
export const RELAY_TICK_MAX_EVENTS = 20;
export const RELAY_TICK_BUDGET_MS = 2000;
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

const AUDIENCES: readonly string[] = Object.values(NotificationAudience);
/** TB-26: store notifications about the whole store, not one branch - the
 * only STORE rows allowed without a branch_id (same list as the
 * notifications_store_branch_check constraint). */
const STORE_WIDE_TYPES: readonly NotificationType[] = [
  'VENDOR_SUSPENDED',
  'VENDOR_REACTIVATED',
];

/**
 * TB-26: the audience the SENDER wrote into the event (OutboxEventService
 * requires it at every call site). Never derived from the event or
 * notification type: an event without a valid one is an error (retried,
 * then dead-lettered), not a guess.
 */
function payloadAudience(
  payload: Record<string, unknown>,
  eventType: string,
  outboxEventId: string,
): NotificationAudience {
  const a = payload.audience;
  if (typeof a !== 'string' || !AUDIENCES.includes(a)) {
    throw new Error(
      `OutboxRelayService: missing or invalid audience for eventType "${eventType}" (outbox event ${outboxEventId})`,
    );
  }
  return a as NotificationAudience;
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
  'availability_subscription.back_in_stock': {
    type: 'VARIANT_BACK_IN_STOCK',
    targetType: 'OFFER',
    targetIdField: 'offer_variant_id',
  },
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
  // «إدارة طلبات الفرع v2» phase 2 (2026-11-24): to the customer - her
  // PICKUP order is ready / her DELIVERY order was sent. The order id only
  // (no data: buildSafeData's default) - never the pickup code.
  'branch_order.ready_for_pickup': {
    type: 'READY_FOR_PICKUP',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  'branch_order.sent': {
    type: 'ORDER_SENT',
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
  // The staff-approved REFUND_REQUESTED->REFUNDED resolution - a
  // human-approved refund decision from the customer's own point of
  // view. (Review-round fix, 2026-10-08: the PLATFORM_ADMIN manual
  // refund this event type also used to cover was removed from S20a
  // entirely - see admin-branch-orders.controller.ts's own comment.)
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
  // PD-3 (decision 12): the order reached COMPLETED - its customer is
  // invited to review what they bought.
  'branch_order.review_invitation': {
    type: 'REVIEW_INVITATION',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  // PD-3 (decision 12): an administrator upheld a report - the author
  // is told, with the administrator's reason.
  'review.hidden_product': {
    type: 'REVIEW_HIDDEN',
    targetType: 'CANONICAL_PRODUCT',
    targetIdField: 'canonical_product_id',
  },
  'review.hidden_store': {
    type: 'REVIEW_HIDDEN',
    targetType: 'VENDOR',
    targetIdField: 'vendor_id',
  },
  // TB-9: a branch order in a state the order state machine never
  // produces - platform administrators only, once per order.
  'branch_order.integrity_flagged': {
    type: 'ORDER_INTEGRITY_ALERT',
    targetType: 'BRANCH_ORDER',
    targetIdField: 'branch_order_id',
  },
  // TB-14: the returns lifecycle, all targeting the Return. To the
  // branch (owner + that branch's employees):
  'return.requested': {
    type: 'RETURN_REQUESTED',
    targetType: 'RETURN',
    targetIdField: 'return_id',
  },
  'return.vendor_reminder': {
    type: 'RETURN_VENDOR_REMINDER',
    targetType: 'RETURN',
    targetIdField: 'return_id',
  },
  // ...to the customer, about their own return:
  'return.approved': {
    type: 'RETURN_APPROVED',
    targetType: 'RETURN',
    targetIdField: 'return_id',
  },
  'return.rejected': {
    type: 'RETURN_REJECTED',
    targetType: 'RETURN',
    targetIdField: 'return_id',
  },
  'return.admin_rejected': {
    type: 'RETURN_ADMIN_REJECTED',
    targetType: 'RETURN',
    targetIdField: 'return_id',
  },
  'return.escalated': {
    type: 'RETURN_ESCALATED',
    targetType: 'RETURN',
    targetIdField: 'return_id',
  },
  'return.refunded': {
    type: 'RETURN_REFUNDED',
    targetType: 'RETURN',
    targetIdField: 'return_id',
  },
  'return.exchanged': {
    type: 'RETURN_EXCHANGED',
    targetType: 'RETURN',
    targetIdField: 'return_id',
  },
  'return.code_expired': {
    type: 'RETURN_CODE_EXPIRED',
    targetType: 'RETURN',
    targetIdField: 'return_id',
  },
  // ...and to the RETURN_ESCALATION platform-alert recipients.
  'return.escalation_alert': {
    type: 'RETURN_ESCALATION_ALERT',
    targetType: 'RETURN',
    targetIdField: 'return_id',
  },
};

const FOLLOWER_EVENT_TYPE_MAP: Record<
  string,
  {
    type: NotificationType;
    targetIdField: string;
    targetType: NotificationTargetType;
  }
> = {
  'offer.published_for_followers': {
    type: 'FOLLOWED_STORE_NEW_PRODUCT',
    targetIdField: 'offer_id',
    targetType: 'OFFER',
  },
  'offer.discount_activated_for_followers': {
    type: 'FOLLOWED_STORE_DISCOUNT',
    targetIdField: 'offer_variant_id',
    targetType: 'OFFER',
  },
  // Bulk publishing (2026-11-18): ONE summary per run, to the store's
  // followers - the store, and how many products it added.
  'offer.bulk_published_for_followers': {
    type: 'FOLLOWED_STORE_NEW_PRODUCTS',
    targetIdField: 'vendor_id',
    targetType: 'VENDOR',
  },
  // Sprint 24 (FR-FAV-003): fires for both PRODUCT and OFFER favorites
  // of the SAME offer - a price belongs to one specific listing either
  // way, so every recipient gets the same OFFER-scoped deep link
  // regardless of which way they favorited.
  'favorite.price_dropped': {
    type: 'FAVORITE_PRICE_DROP',
    targetIdField: 'offer_variant_id',
    targetType: 'OFFER',
  },
  // Sprint 24 (FR-FAV-004, final decision #4): OFFER favorites only.
  'favorite.back_in_stock': {
    type: 'FAVORITE_BACK_IN_STOCK',
    targetIdField: 'offer_variant_id',
    targetType: 'OFFER',
  },
  // Sprint 24 (FR-FAV-006): PRODUCT favorites only - an OFFER favorite
  // is about one existing listing, never relevant to "a new OTHER
  // listing appeared."
  'favorite.new_offer_matched': {
    type: 'FAVORITE_NEW_OFFER',
    targetIdField: 'canonical_product_id',
    targetType: 'CANONICAL_PRODUCT',
  },
};

/** TB-14: the only values RETURN_ESCALATION_ALERT's `reason` may take. */
export const RETURN_ESCALATION_REASONS = ['SLA_TIMEOUT', 'CUSTOMER_DISPUTE'];

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
    case 'availability_subscription.back_in_stock':
      return {
        offer_id:
          typeof payload.offer_id === 'string' ? payload.offer_id : null,
        vendor_slug:
          typeof payload.vendor_slug === 'string' ? payload.vendor_slug : null,
        color_id:
          typeof payload.color_id === 'string' ? payload.color_id : null,
        color_name_ar:
          typeof payload.color_name_ar === 'string'
            ? payload.color_name_ar
            : '',
        color_name_en:
          typeof payload.color_name_en === 'string'
            ? payload.color_name_en
            : null,
        size_code:
          typeof payload.size_code === 'string' ? payload.size_code : null,
        size_label:
          typeof payload.size_label === 'string' ? payload.size_label : '',
      };
    case 'stock_movement.owner_notification':
      return { reason: payload.reason };
    case 'vendor.suspended':
      return { reason_code: payload.reason_code };
    case 'checkout.low_stock_after_reserve':
      return { remaining_quantity: payload.remaining_quantity };
    // PD-3: the administrator's own decision reason (written for the
    // author) - never a reporter's free text.
    case 'review.hidden_product':
    case 'review.hidden_store':
      return { review_id: payload.review_id, reason: payload.reason };
    // TB-9: the issue code only (a fixed enum, never free text).
    case 'branch_order.integrity_flagged':
      return { issue: payload.issue };
    // Bulk publishing: how many products the store added (a number only).
    case 'offer.bulk_published_for_followers':
      return Number.isInteger(payload.count) ? { count: payload.count } : {};
    // TB-14: why the return was escalated - one of two fixed codes,
    // anything else is dropped. Every other return.* event carries
    // nothing beyond its target (the return id): never the customer's
    // note, a rejection reason, photos or an amount.
    case 'return.escalation_alert':
      return RETURN_ESCALATION_REASONS.includes(payload.reason as string)
        ? { reason: payload.reason }
        : {};
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
    () => this.dispatchTick().then(() => undefined),
    (err) => this.logger.error('OutboxRelayService tick failed', err as Error),
    OutboxRelayService.name,
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
  /** TB-11: what the timer runs - dispatchOnce() repeatedly, up to
   * RELAY_TICK_MAX_EVENTS rows or RELAY_TICK_BUDGET_MS, stopping as soon
   * as nothing is due. Returns how many rows it handled. */
  async dispatchTick(
    maxEvents = RELAY_TICK_MAX_EVENTS,
    budgetMs = RELAY_TICK_BUDGET_MS,
  ): Promise<number> {
    const started = Date.now();
    let handled = 0;
    while (handled < maxEvents && Date.now() - started < budgetMs) {
      if (!(await this.dispatchOnce())) break;
      handled += 1;
    }
    return handled;
  }

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
    const audience = payloadAudience(payload, eventType, outboxEventId);
    const followerMapping = FOLLOWER_EVENT_TYPE_MAP[eventType];
    if (followerMapping) {
      return this.drainFollowerBatch(
        tx,
        outboxEventId,
        eventType,
        followerMapping,
        payload,
        notifyItems,
        audience,
      );
    }

    if (isReturnStoreEventType(eventType)) {
      return this.dispatchReturnStoreEvent(
        tx,
        outboxEventId,
        eventType,
        payload,
        notifyItems,
        audience,
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
      audience,
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
    mapping: {
      type: NotificationType;
      targetIdField: string;
      targetType: NotificationTargetType;
    },
    payload: Record<string, unknown>,
    notifyItems: NotifyItem[],
    audience: NotificationAudience,
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
        mapping.targetType,
        targetId,
        safeData,
        vendorId,
        null,
        audience,
      );
      if (created) {
        notifyItems.push({
          recipientUserId: target.recipientUserId,
          type: mapping.type,
          targetType: mapping.targetType,
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
  /**
   * TB-15: one event per return transition, sent to the store. The
   * recipients are decided HERE, at send time, from the live memberships
   * and the live store status (see storeReturnRecipients): an owner or an
   * employee of the order's branch who is still ACTIVE, on an account that
   * is not deactivated - owners only while the store is SUSPENDED - minus
   * the person who made the change (the customer who cancelled, or
   * the administrator who decided). A retry re-runs this; the
   * (outboxEventId, recipientUserId) unique constraint keeps every
   * recipient at one notification. No recipient left is not an error.
   */
  private async dispatchReturnStoreEvent(
    tx: Prisma.TransactionClient,
    outboxEventId: string,
    eventType: ReturnStoreEventType,
    payload: Record<string, unknown>,
    notifyItems: NotifyItem[],
    audience: NotificationAudience,
  ): Promise<boolean> {
    const returnId = payload.return_id;
    if (typeof returnId !== 'string' || !returnId) {
      throw new Error(
        `OutboxRelayService: missing return_id for eventType "${eventType}" (outbox event ${outboxEventId})`,
      );
    }
    const r = await tx.return.findUniqueOrThrow({
      where: { id: returnId },
      select: {
        vendorId: true,
        desiredOutcome: true,
        escalationResolvedByUserId: true,
        branchOrderItem: {
          select: {
            branchOrder: {
              select: {
                branchId: true,
                customerOrder: {
                  select: { customer: { select: { userId: true } } },
                },
              },
            },
          },
        },
      },
    });
    const branchOrder = r.branchOrderItem.branchOrder;
    const actorUserId =
      eventType === 'return.cancelled_for_store'
        ? branchOrder.customerOrder.customer.userId
        : r.escalationResolvedByUserId;
    const vendor = await tx.vendor.findUniqueOrThrow({
      where: { id: r.vendorId },
      select: { status: true },
    });
    const members = await tx.vendorUser.findMany({
      where: { vendorId: r.vendorId },
      select: {
        userId: true,
        role: true,
        status: true,
        branchId: true,
        user: { select: { deactivatedAt: true } },
      },
    });
    const recipients = storeReturnRecipients(
      members.map((m) => ({
        userId: m.userId,
        role: m.role,
        status: m.status,
        branchId: m.branchId,
        userDeactivated: m.user.deactivatedAt !== null,
      })),
      branchOrder.branchId,
      actorUserId,
      vendor.status === 'SUSPENDED',
    );
    const type = RETURN_STORE_EVENT_TYPES[eventType];
    const data = storeReturnSafeData(eventType, r.desiredOutcome);
    for (const recipientUserId of recipients) {
      const created = await this.createNotification(
        tx,
        outboxEventId,
        recipientUserId,
        type,
        'RETURN',
        returnId,
        data,
        r.vendorId,
        branchOrder.branchId,
        audience,
      );
      if (created) {
        notifyItems.push({
          recipientUserId,
          type,
          targetType: 'RETURN',
          targetId: returnId,
          data,
        });
      }
    }
    return true;
  }

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
    audience: NotificationAudience,
  ): Promise<boolean> {
    // TB-26: a store notification must name its store, and - unless it
    // is a store-wide type - its branch (the database enforces the same
    // with a CHECK constraint; this fails earlier with a clearer error).
    if (
      audience === 'STORE' &&
      (!vendorId || (!branchId && !STORE_WIDE_TYPES.includes(type)))
    ) {
      throw new Error(
        `OutboxRelayService: STORE notification ${type} without ${vendorId ? 'branch_id' : 'vendor_id'} (outbox event ${outboxEventId})`,
      );
    }
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
          audience,
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
