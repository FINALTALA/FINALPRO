/**
 * Sprint 24 (FR-COMP-006). The threshold itself is already approved
 * (BR-004/NFR-STALE-002: 30 days, admin-configurable) - this is not a
 * new policy. The DATA SOURCE is the one genuinely new piece: this
 * schema has no separate "a human reconfirmed this price without
 * changing it" action, so `priceLastConfirmedAt` (computed by
 * ComparisonService.findEligibleOffers - the latest PriceHistory row's
 * changedAt, or the variant's own createdAt if the price has never
 * changed) is the most honest available proxy, not an invented
 * default.
 */
export const PRICE_STALENESS_DAYS = 30;

export function isPriceStale(
  priceLastConfirmedAt: Date,
  now: Date = new Date(),
): boolean {
  const ageMs = now.getTime() - priceLastConfirmedAt.getTime();
  return ageMs > PRICE_STALENESS_DAYS * 24 * 60 * 60 * 1000;
}
