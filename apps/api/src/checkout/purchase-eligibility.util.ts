import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';

/**
 * Codex review round 2 on commit d0ea80d: nothing previously re-checked
 * that an offer/vendor is still actually sellable - add-to-cart,
 * quote, reserve, and confirm all only ever looked at price/stock.
 * Reuses the EXACT same eligibility triple already established for
 * public storefront visibility (store-offers-public.controller.ts:
 * `vendor.storefrontPublished && vendor.status === 'ACTIVE' &&
 * offer.status === 'ACTIVE'`), composed with the existing
 * SubscriptionGateService (already used to gate offer *creation* -
 * never wired into checkout before this fix). Called at EVERY stage,
 * not just once, because a vendor can unpublish, an offer can go
 * DRAFT, or a subscription can lapse at any point during a live
 * 10-minute hold.
 */
export async function assertItemsPurchasable(
  tx: Prisma.TransactionClient,
  subscriptionGate: SubscriptionGateService,
  correlationId: string,
  items: { vendorId: string; offerVariantId: string }[],
): Promise<void> {
  const vendorIds = [...new Set(items.map((i) => i.vendorId))];
  const variantIds = [...new Set(items.map((i) => i.offerVariantId))];

  const [vendors, variants] = await Promise.all([
    tx.vendor.findMany({ where: { id: { in: vendorIds } } }),
    tx.offerVariant.findMany({
      where: { id: { in: variantIds } },
      include: { vendorOffer: { select: { status: true } } },
    }),
  ]);
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const subscriptionStatusByVendor = new Map<string, string>();
  for (const vendorId of vendorIds) {
    const status = await subscriptionGate.refreshStatus(
      tx,
      vendorId,
      correlationId,
    );
    subscriptionStatusByVendor.set(vendorId, status);
  }

  for (const item of items) {
    const variant = variantById.get(item.offerVariantId);
    if (!variant) {
      throw new NotFoundException({
        code: 'OFFER_VARIANT_NOT_FOUND',
        message: 'Offer variant not found',
      });
    }
    const vendor = vendorById.get(item.vendorId);
    const isEligible =
      !!vendor &&
      vendor.storefrontPublished &&
      vendor.status === 'ACTIVE' &&
      variant.vendorOffer.status === 'ACTIVE' &&
      subscriptionStatusByVendor.get(item.vendorId) === 'ACTIVE';
    if (!isEligible) {
      throw new ConflictException({
        code: 'ITEM_NOT_PURCHASABLE',
        message: `Offer variant ${item.offerVariantId} is no longer available for purchase`,
      });
    }
  }
}
