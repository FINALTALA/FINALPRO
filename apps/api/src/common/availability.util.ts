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

/**
 * Codex review round 3 on commit 3d81c9b (fix #4): every public
 * availability surface (storefront listing, offer detail, comparison/
 * discovery) previously summed BranchStock.quantity alone, ignoring
 * units already held by a live checkout reservation - the last unit of
 * a variant could show "Available" publicly while a real 10-minute
 * hold on it was already in progress. Each branch's contribution is
 * clamped at zero (reservedQuantity can transiently exceed quantity
 * for a beat between a sweep's delete and its decrement landing, never
 * negative available stock). The exact quantity itself stays hidden,
 * same as before - only this derived total feeds bucketForStock().
 */
export function totalAvailableStock(
  branchStocks: { quantity: number; reservedQuantity: number }[],
): number {
  return branchStocks.reduce(
    (sum, bs) => sum + Math.max(0, bs.quantity - bs.reservedQuantity),
    0,
  );
}
