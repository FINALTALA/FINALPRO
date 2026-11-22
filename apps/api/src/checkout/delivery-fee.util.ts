/**
 * Sprint 10 (RB-ORD-003): a region is actually usable for delivery
 * only when BOTH `enabled` is true (Sprint 5's own lazy-default-true
 * convention - no row at all still counts as enabled) AND `fee` has
 * been explicitly set by the owner (never defaulted or inferred - see
 * VendorDeliveryZone's own schema.prisma comment).
 */
// Sprint 22: exported too - BranchOrderAddressChangeService's own
// zone-support check re-uses this exact same resolution rule, never a
// re-derived copy of it.
export function resolveDeliveryFee(
  row: { enabled: boolean; fee: unknown } | null,
): number | null {
  if (!row) return null;
  if (!row.enabled) return null;
  if (row.fee === null || row.fee === undefined) return null;
  return Number(row.fee);
}
