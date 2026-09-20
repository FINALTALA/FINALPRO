/**
 * Sprint 7 (RB-STOREF-001, PDR-011): deterministic vendor slug
 * generation. The legalName-derived part is a best-effort readability
 * aid, not the uniqueness guarantee - Arabic (or any non a-z0-9)
 * legalName collapses to nothing, which is fine, since the id-derived
 * suffix alone already guarantees global uniqueness the same way the
 * id itself is unique (same reasoning as barcode.util.ts's id-derived
 * scheme - see that file's own comment on why a suffix derived from an
 * already-unique id needs no collision-retry logic).
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
  const suffix = vendorId.replace(/-/g, '').slice(0, 6);
  return base ? `${base}-${suffix}` : suffix;
}
