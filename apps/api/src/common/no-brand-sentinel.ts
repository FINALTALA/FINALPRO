/**
 * Sprint 17 (D3): the platform's single, fixed "No brand / بدون علامة
 * تجارية" Brand row - seeded once, at this exact id, by this sprint's
 * migration (see its own comment for the collision-safety check).
 * Application code references it by this constant id, never by a
 * runtime name lookup - a name-based lookup would be fragile against
 * any future display-name edit, while the id is permanent.
 */
export const NO_BRAND_SENTINEL_ID = 'a0000000-0000-4000-8000-000000000001';

/**
 * Import-only alias list (D3, applied in offers-import.controller.ts's
 * brand_name resolver): a normalize()-independent set of literal
 * spellings that mean "explicitly no brand" in an uploaded file.
 * normalize() alone (trim + lowercase) cannot bridge Arabic/English or
 * hyphen/space variants, so these are matched explicitly, only for the
 * sentinel - every other brand name still resolves the ordinary way,
 * against Brand.normalizedName.
 */
const NO_BRAND_ALIASES = new Set(
  ['بدون علامة تجارية', 'No brand', 'No-brand', 'no-brand', 'nobrand'].map(
    (s) => s.trim().toLowerCase(),
  ),
);

export function isNoBrandAlias(rawBrandName: string): boolean {
  return NO_BRAND_ALIASES.has(rawBrandName.trim().toLowerCase());
}
