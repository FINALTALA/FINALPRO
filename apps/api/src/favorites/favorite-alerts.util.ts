import { Prisma } from '../../generated/prisma/client';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PUBLIC_OFFER } from '../offers/platform-hold.util';

export type FavoriteAlertType = 'PRICE_DROP' | 'BACK_IN_STOCK' | 'NEW_OFFER';

/**
 * Explicit availability requests are intentionally not Favorites. A request
 * is for one exact sellable variant (product colour x size) and is consumed
 * only after that variant genuinely crosses from unavailable everywhere to
 * available. `updateMany(active:true)` is the concurrency backstop: two
 * simultaneous restocks can enqueue at most one alert for a subscription.
 */
export async function enqueueVariantAvailabilityNotifications(
  tx: Prisma.TransactionClient,
  outbox: OutboxEventService,
  params: { vendorId: string; offerVariantId: string },
): Promise<void> {
  const variant = await tx.offerVariant.findFirst({
    where: {
      id: params.offerVariantId,
      vendorId: params.vendorId,
      vendorOffer: {
        ...PUBLIC_OFFER,
        vendor: { status: 'ACTIVE', storefrontPublished: true },
      },
    },
    select: {
      id: true,
      colorCode: true,
      colour: true,
      sizeCode: true,
      size: true,
      offerColor: { select: { id: true, nameAr: true, nameEn: true } },
      vendorOffer: { select: { id: true, vendor: { select: { slug: true } } } },
    },
  });
  if (!variant) return;

  const subscriptions = await tx.variantAvailabilitySubscription.findMany({
    where: { offerVariantId: variant.id, active: true },
    select: { id: true, userId: true },
  });
  for (const sub of subscriptions) {
    const claimed = await tx.variantAvailabilitySubscription.updateMany({
      where: { id: sub.id, active: true },
      data: { active: false, notifiedAt: new Date() },
    });
    if (claimed.count !== 1) continue;
    await outbox.enqueue(
      {
        eventType: 'availability_subscription.back_in_stock',
        audience: 'CUSTOMER',
        payload: {
          recipient_user_id: sub.userId,
          vendor_id: params.vendorId,
          offer_variant_id: variant.id,
          offer_id: variant.vendorOffer.id,
          vendor_slug: variant.vendorOffer.vendor.slug,
          color_id: variant.offerColor?.id ?? null,
          color_name_ar:
            variant.offerColor?.nameAr ??
            variant.colour ??
            variant.colorCode ??
            '',
          color_name_en: variant.offerColor?.nameEn ?? null,
          size_code: variant.sizeCode ?? null,
          size_label: variant.size ?? variant.sizeCode ?? '',
        },
      },
      tx,
    );
  }
}

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
): Promise<string | null> {
  // Back in stock: only a product shoppers can buy now. A version of an
  // INACTIVE or ARCHIVED (or DRAFT) product gets no event and no
  // notification - one place for every caller (stock movements, order
  // cancellation, returns).
  if (params.alertType === 'BACK_IN_STOCK' && params.offerVariantId) {
    // VIA phase 2C: nor one under an open platform hold.
    const rows = await tx.$queryRaw<{ status: string; held: boolean }[]>`
      SELECT o.status::text AS status,
             EXISTS (SELECT 1 FROM offer_platform_holds h
                      WHERE h."vendorOfferId" = o.id AND h."releasedAt" IS NULL) AS held
      FROM offer_variants v JOIN vendor_offers o ON o.id = v."vendorOfferId"
      WHERE v.id = ${params.offerVariantId}`;
    if (rows[0]?.status !== 'ACTIVE' || rows[0]?.held) return null;
  }
  const outboxEvent = await outbox.enqueue(
    {
      eventType: params.eventType,
      audience: 'CUSTOMER',
      payload: params.payload,
    },
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
