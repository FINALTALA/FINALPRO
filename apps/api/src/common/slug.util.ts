/**
 * Sprint 7 (RB-STOREF-001, PDR-011): deterministic vendor slug
 * generation. The legalName-derived part is a best-effort readability
 * aid, not the uniqueness guarantee - Arabic (or any non a-z0-9)
 * legalName collapses to nothing, which is fine, since the id-derived
 * suffix alone already guarantees global uniqueness the same way the
 * id itself is unique (same reasoning as barcode.util.ts's id-derived
 * scheme).
 *
 * Review-round fix: an earlier version truncated the suffix to the
 * id's first 6 hex characters (24 bits) - the exact same mistake
 * already caught and fixed once for barcode.util.ts, for the exact
 * same reason: 24 bits of collision space is not the id's full 128,
 * so two different vendor ids could in principle produce the same
 * suffix. This now keeps the id's full 32 hex characters (dashes
 * stripped) - a lossless, reversible re-encoding, so two different ids
 * can never collide here unless they were already equal. Migration
 * 20260922100000's own SQL backfill uses the identical formula for
 * every pre-existing vendor - keep the two in sync if this ever
 * changes.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function generateVendorSlug(
  legalName: string,
  vendorId: string,
): string {
  const base = slugify(legalName);
  const suffix = vendorId.replace(/-/g, '');
  return base ? `${base}-${suffix}` : suffix;
}
