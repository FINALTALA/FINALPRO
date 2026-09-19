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
 *
 * Review-round fix: an earlier version of this function truncated to
 * the id's first 10 hex characters (40 bits) before a comment claimed
 * that was "trivially guaranteed unique" - false. Two different UUIDs
 * sharing the same first 10 hex characters (a real, if unlikely,
 * possibility - 40 bits of collision space, not the UUID's full 128)
 * would produce the *same* barcode, breaking either unique index. This
 * now keeps the id's full 32 hex characters (dashes stripped,
 * uppercased) - a lossless, reversible re-encoding of the id itself, so
 * two different ids can never collide here unless they were already
 * equal.
 */
function deriveCode(id: string): string {
  return id.replace(/-/g, '').toUpperCase();
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
