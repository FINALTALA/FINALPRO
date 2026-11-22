import { ConflictException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditLogService } from '../../audit/audit-log.service';
import { enqueueFavoriteNotification } from '../../favorites/favorite-alerts.util';
import { OutboxEventService } from '../../outbox/outbox-event.service';
import { computeEffectivePrice } from './effective-price.util';
import { priceKey, UnifiedPrice } from './unified-price.util';

/**
 * The ONE price of a whole product, inside the caller's transaction (the
 * offer row already locked by the caller): every variant is rewritten (rows
 * locked in id order), each changed one gets its own PriceHistory row, and
 * an immediate drop notifies favourites and followers through the outbox -
 * written in the SAME transaction, so a rollback leaves no notification and
 * the relay delivers only what was committed. Used by PUT .../price (the
 * quick price screen) and by applying an edit draft - one price path.
 */
export async function applyOfferPrice(
  tx: Prisma.TransactionClient,
  deps: { outbox: OutboxEventService; auditLog: AuditLogService },
  args: {
    vendorId: string;
    offerId: string;
    price: UnifiedPrice;
    userId: string;
    correlationId: string;
  },
) {
  const { vendorId, offerId, price, userId, correlationId } = args;
  await tx.$queryRaw`SELECT id FROM offer_variants WHERE "vendorOfferId" = ${offerId} ORDER BY id FOR UPDATE`;
  const variants = await tx.offerVariant.findMany({
    where: { vendorOfferId: offerId },
    orderBy: { id: 'asc' },
  });
  if (variants.length === 0) {
    throw new ConflictException({
      code: 'NO_VARIANTS_YET',
      message:
        'This product has no combinations yet - send the price with its first combinations',
    });
  }

  const now = new Date();
  let dropped = false;
  for (const v of variants) {
    const updated = await tx.offerVariant.update({
      where: { id: v.id },
      data: price,
    });
    if (priceKey(v) === priceKey(updated)) continue;
    const oldEffective = computeEffectivePrice(v, now);
    const newEffective = computeEffectivePrice(updated, now);
    await tx.priceHistory.create({
      data: {
        vendorId,
        offerVariantId: v.id,
        basePrice: updated.basePrice,
        salePrice: updated.salePrice,
        discountPercent: updated.discountPercent,
        discountStartAt: updated.discountStartAt,
        discountEndAt: updated.discountEndAt,
        effectivePriceAtChange: newEffective,
        reason: 'MANUAL_EDIT',
        changedBy: userId,
        changedAt: now,
      },
    });
    if (newEffective < oldEffective) {
      dropped = true;
      let canonicalProductId: string | undefined;
      if (updated.canonicalVariantId) {
        const cv = await tx.canonicalProductVariant.findUnique({
          where: { id: updated.canonicalVariantId },
          select: { canonicalProductId: true },
        });
        canonicalProductId = cv?.canonicalProductId;
      }
      await enqueueFavoriteNotification(tx, deps.outbox, {
        eventType: 'favorite.price_dropped',
        alertType: 'PRICE_DROP',
        canonicalProductId,
        offerVariantId: v.id,
        payload: { vendor_id: vendorId, offer_variant_id: v.id },
      });
    }
  }
  if (dropped) {
    // One follower notification for the product, not one per
    // combination (same event the per-variant path sends).
    const event = await deps.outbox.enqueue(
      {
        eventType: 'offer.discount_activated_for_followers',
        audience: 'CUSTOMER',
        payload: { vendor_id: vendorId, offer_variant_id: variants[0].id },
      },
      tx,
    );
    await tx.$executeRaw`
      INSERT INTO outbox_delivery_targets (id, "outboxEventId", "recipientUserId")
      SELECT gen_random_uuid()::text, ${event.id}, "userId"
      FROM store_follows WHERE "vendorId" = ${vendorId}
    `;
  }

  const body = offerPriceDto(price, variants.length);
  await deps.auditLog.record(
    {
      actorId: userId,
      correlationId,
      action: 'vendor_offer.price_set',
      entityType: 'VendorOffer',
      entityId: offerId,
      beforeState: { prices: [...new Set(variants.map(priceKey))] },
      afterState: body,
    },
    tx,
  );
  return body;
}

export function offerPriceDto(price: UnifiedPrice, variantCount: number) {
  return {
    base_price: price.basePrice.toFixed(2),
    sale_price: price.salePrice?.toFixed(2) ?? null,
    discount_percent: price.discountPercent,
    discount_start_at: price.discountStartAt?.toISOString() ?? null,
    discount_end_at: price.discountEndAt?.toISOString() ?? null,
    variants_updated: variantCount,
  };
}
