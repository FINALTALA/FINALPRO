import { Prisma } from '../../generated/prisma/client';
import { OutboxEventService } from '../outbox/outbox-event.service';

export type FavoriteAlertType = 'PRICE_DROP' | 'BACK_IN_STOCK' | 'NEW_OFFER';

/**
 * Sprint 24 (FR-FAV-003/004/006): the one snapshot-and-enqueue path
 * every favorite-driven alert trigger goes through - mirrors the
 * existing follower-fanout pattern (offer.published_for_followers /
 * offer.discount_activated_for_followers) exactly: one OutboxEvent,
 * one INSERT...SELECT snapshotting recipients into
 * OutboxDeliveryTarget inside the SAME transaction as the triggering
 * write, the existing relay drains it from there (3s poll, unchanged).
 *
 * Recipient dedup within one event (final correction round): a
 * customer who favorited BOTH the canonical product and this exact
 * offer must get exactly one notification, not two. The SELECT
 * dedupes userId FIRST (one subquery, both match conditions OR'd
 * together), THEN joins preferences, THEN a fresh id is generated per
 * resulting row - never SELECT DISTINCT alongside a per-row
 * gen_random_uuid(), which would never actually deduplicate anything.
 * `ON CONFLICT ... DO NOTHING` against OutboxDeliveryTarget's own
 * @@unique([outboxEventId, recipientUserId]) is the structural
 * backstop.
 *
 * NotificationPreference is checked here, at snapshot time, never at
 * relay-delivery time: absence of a row for (userId, alertType) means
 * enabled = true (opt-out, not opt-in).
 */
export async function enqueueFavoriteNotification(
  tx: Prisma.TransactionClient,
  outbox: OutboxEventService,
  params: {
    eventType: string;
    alertType: FavoriteAlertType;
    canonicalProductId?: string;
    offerVariantId?: string;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const outboxEvent = await outbox.enqueue(
    { eventType: params.eventType, payload: params.payload },
    tx,
  );

  const conditions: Prisma.Sql[] = [];
  if (params.canonicalProductId) {
    conditions.push(
      Prisma.sql`f."canonicalProductId" = ${params.canonicalProductId}`,
    );
  }
  if (params.offerVariantId) {
    conditions.push(Prisma.sql`f."offerVariantId" = ${params.offerVariantId}`);
  }
  if (conditions.length === 0) {
    return outboxEvent.id;
  }

  await tx.$executeRaw`
    INSERT INTO outbox_delivery_targets (id, "outboxEventId", "recipientUserId")
    SELECT gen_random_uuid()::text, ${outboxEvent.id}, sub."userId"
    FROM (
      SELECT DISTINCT f."userId" FROM favorites f WHERE ${Prisma.join(conditions, ' OR ')}
    ) sub
    LEFT JOIN notification_preferences np
      ON np."userId" = sub."userId" AND np."alertType" = ${params.alertType}::"FavoriteAlertType"
    WHERE np.id IS NULL OR np.enabled = true
    ON CONFLICT ("outboxEventId", "recipientUserId") DO NOTHING
  `;

  return outboxEvent.id;
}
