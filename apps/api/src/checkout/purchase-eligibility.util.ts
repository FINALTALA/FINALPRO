import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { SubscriptionGateService } from '../subscriptions/subscription-gate.service';

export interface EligibilityItem {
  vendorId: string;
  offerVariantId: string;
}

async function loadEligibilityContext(
  tx: Prisma.TransactionClient,
  items: EligibilityItem[],
) {
  // Codex review round 3 on commit 3d81c9b (fix #2): vendorIds sorted
  // canonically BEFORE anything takes a lock on a vendor row (via
  // SubscriptionGateService.refreshStatus's own FOR UPDATE) - a
  // multi-vendor checkout submitted with groups in one order, racing a
  // second multi-vendor checkout whose groups happen to list the same
  // two vendors in the opposite order, would otherwise lock vendor A
  // then B against vendor B then A and deadlock. Sorting here fixes
  // every caller of assertItemsPurchasable/assertItemsPurchasableReadOnly
  // at once (reserve, confirm, cart add-to-cart, quote) without each
  // needing its own ordering logic.
  const vendorIds = [...new Set(items.map((i) => i.vendorId))].sort();
  const variantIds = [...new Set(items.map((i) => i.offerVariantId))];
  const [vendors, variants] = await Promise.all([
    tx.vendor.findMany({ where: { id: { in: vendorIds } } }),
    tx.offerVariant.findMany({
      where: { id: { in: variantIds } },
      include: { vendorOffer: { select: { status: true } } },
    }),
  ]);
  return {
    vendorIds,
    vendorById: new Map(vendors.map((v) => [v.id, v])),
    variantById: new Map(variants.map((v) => [v.id, v])),
  };
}

function assertEligible(
  items: EligibilityItem[],
  vendorById: Map<string, { storefrontPublished: boolean; status: string }>,
  variantById: Map<string, { vendorOffer: { status: string } }>,
  subscriptionStatusByVendor: Map<string, string>,
): void {
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
 *
 * WRITE path: calls SubscriptionGateService.refreshStatus(), which
 * persists the lazy ACTIVE->EXPIRED transition under a FOR UPDATE lock
 * - correct for reserve()/confirm()/cart add-to-cart, which are
 * already real mutations inside a real transaction. quote() must NOT
 * use this - see assertItemsPurchasableReadOnly below.
 */
export async function assertItemsPurchasable(
  tx: Prisma.TransactionClient,
  subscriptionGate: SubscriptionGateService,
  correlationId: string,
  items: EligibilityItem[],
): Promise<void> {
  const { vendorIds, vendorById, variantById } = await loadEligibilityContext(
    tx,
    items,
  );
  const subscriptionStatusByVendor = new Map<string, string>();
  for (const vendorId of vendorIds) {
    const status = await subscriptionGate.refreshStatus(
      tx,
      vendorId,
      correlationId,
    );
    subscriptionStatusByVendor.set(vendorId, status);
  }
  assertEligible(items, vendorById, variantById, subscriptionStatusByVendor);
}

/**
 * Codex review round 3 on commit 3d81c9b (fix #1): quote() is a
 * read-only preview - this variant uses
 * SubscriptionGateService.peekEffectiveStatus() (plain reads, no lock,
 * no write, no AuditLog row) instead of refreshStatus(), so merely
 * previewing a cart can never mutate a Vendor/VendorSubscription row or
 * emit an audit entry just because a trial happened to have lapsed.
 */
export async function assertItemsPurchasableReadOnly(
  tx: Prisma.TransactionClient,
  subscriptionGate: SubscriptionGateService,
  items: EligibilityItem[],
): Promise<void> {
  const { vendorIds, vendorById, variantById } = await loadEligibilityContext(
    tx,
    items,
  );
  const subscriptionStatusByVendor = new Map<string, string>();
  for (const vendorId of vendorIds) {
    subscriptionStatusByVendor.set(
      vendorId,
      await subscriptionGate.peekEffectiveStatus(tx, vendorId),
    );
  }
  assertEligible(items, vendorById, variantById, subscriptionStatusByVendor);
}
