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
