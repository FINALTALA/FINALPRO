/**
 * Sprint 5 (RB-INV-001, PDR-018): deterministic, id-derived barcode
 * generation shared between application code and the migration that
 * backfills it for pre-existing Sprint 1-4 rows (see that migration's
 * SQL, which computes the exact same value in raw SQL - keep the two in
 * sync if this ever changes).
 *
 * Deriving the barcode from the row's own id (rather than a random
 * value with a uniqueness retry loop) means it is trivially guaranteed
 * unique the same way the id itself already is - no collision handling
 * needed, and the migration's backfill can compute it in a single pass
 * with no application code running at all.
 */
function deriveCode(id: string): string {
  return id.replace(/-/g, '').slice(0, 10).toUpperCase();
}

/** Store-scoped, scanner-facing (OfferVariant.storeInventoryBarcode). */
export function generateStoreInventoryBarcode(offerVariantId: string): string {
  return `SIB-${deriveCode(offerVariantId)}`;
}

/** Internal, platform-wide, never customer-facing (CanonicalProductVariant.platformProductBarcode). */
export function generatePlatformProductBarcode(
  canonicalProductVariantId: string,
): string {
  return `PPB-${deriveCode(canonicalProductVariantId)}`;
}
