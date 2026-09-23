import { Prisma } from '../../generated/prisma/client';

// Sprint 8 (RB-COMP-001/RB-STOREF-004, PDR-017): "A product is publicly
// available at store level if any branch has the chosen variant. Public
// surfaces show Available, Low stock (1-3), or Sold out - not exact
// quantities." Shared by every public-facing surface that reports
// availability (comparison, discovery, the public store-offers listing/
// detail) so the bucket boundaries never drift apart between them.
export type AvailabilityBucket = 'available' | 'low_stock' | 'sold_out';

export function bucketForStock(totalQuantity: number): AvailabilityBucket {
  if (totalQuantity <= 0) return 'sold_out';
  if (totalQuantity <= 3) return 'low_stock';
  return 'available';
}

export interface BranchStockKey {
  branchId: string;
  offerVariantId: string;
}

/**
 * Codex review round 4 on commit 95a8430 (fix #2): BranchStock.
 * reservedQuantity is a LAZILY-SWEPT counter - it only decreases when
 * something actually touches that exact row (reserve()/POS/cancel()/
 * confirm()'s own sweep). It is never proof of what is held RIGHT NOW;
 * a reservation whose 10-minute hold quietly expired with no further
 * interaction on its stock row would keep reading as reserved
 * indefinitely on any surface that trusted the counter alone - the
 * round-3 fix was insufficient for exactly this reason. Every public
 * availability read must instead compute LIVE holds directly from
 * CheckoutReservationItem (`reservation.expiresAt > now()`), the same
 * read-only computation quote()'s own buildAvailabilityMap uses - this
 * IS that shared computation now, used by both, so there is only ever
 * one implementation of "what's actually held right now" to keep
 * correct.
 */
export async function liveReservedQuantityByKey(
  db: Prisma.TransactionClient,
  keys: BranchStockKey[],
): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();
  const rows = await db.checkoutReservationItem.findMany({
    where: {
      OR: keys.map((k) => ({
        branchId: k.branchId,
        offerVariantId: k.offerVariantId,
      })),
      reservation: { expiresAt: { gt: new Date() } },
    },
    select: { branchId: true, offerVariantId: true, quantity: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.branchId}:${r.offerVariantId}`;
    map.set(key, (map.get(key) ?? 0) + r.quantity);
  }
  return map;
}

/**
 * Sums each branch's contribution as `max(0, quantity - liveReserved)`,
 * looking the live-reserved figure up from a pre-computed map (see
 * liveReservedQuantityByKey above - batched once per request across
 * every branch/variant pair involved, never re-queried per row). The
 * exact quantity itself stays hidden, same as before - only this
 * derived total ever feeds bucketForStock().
 */
export function totalAvailableStockLive(
  branchStocks: {
    branchId: string;
    offerVariantId: string;
    quantity: number;
  }[],
  liveReservedByKey: Map<string, number>,
): number {
  return branchStocks.reduce((sum, bs) => {
    const key = `${bs.branchId}:${bs.offerVariantId}`;
    const reserved = liveReservedByKey.get(key) ?? 0;
    return sum + Math.max(0, bs.quantity - reserved);
  }, 0);
}
