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

// ---------------------------------------------------------------------
// Product barcodes (2026-11-20): what a store owner scans, types or
// prints. A PRODUCT-level code (OfferBarcode), deliberately separate from
// the per-variant SIB-... code above, which is never printed again and is
// only read by the cashier as a legacy fallback.
// ---------------------------------------------------------------------

export type ProductBarcodeFormat = 'EAN13' | 'EAN8' | 'UPCA' | 'CODE128';

export type BarcodeProblem =
  /** Nothing usable after trimming. */
  | 'BARCODE_REQUIRED'
  /** Characters outside digits, A-Z and "-", or a length outside 4-32. */
  | 'BARCODE_INVALID'
  /** An EAN-13 / UPC-A / EAN-8 length whose check digit is wrong - a misread or a typo. */
  | 'BARCODE_CHECK_DIGIT'
  /** The platform's own internal codes (SIB-/PPB-) - never a product barcode. */
  | 'BARCODE_RESERVED';

// (the absent members are spelled out as `never` so either branch's fields
// can be read after an `ok` check under this project's non-strict compiler)
export type NormalizedBarcode =
  | { ok: true; code: string; format: ProductBarcodeFormat; problem?: never }
  | { ok: false; problem: BarcodeProblem; code?: never; format?: never };

/** The GS1 check digit (EAN-8, EAN-13, UPC-A in its EAN-13 form) for the digits WITHOUT their check digit. */
export function gs1CheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    // weight 3 for the digit right before the check digit, then alternating
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

function hasValidCheckDigit(digits: string): boolean {
  return (
    gs1CheckDigit(digits.slice(0, -1)) ===
    digits.charCodeAt(digits.length - 1) - 48
  );
}

/** A legacy per-variant code (SIB-<32 hex>), as a scanner or a typist may send it. */
export function legacyVariantBarcode(raw: string): string | null {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  return /^SIB-[0-9A-F]{32}$/.test(s) ? s : null;
}

/**
 * One stored form per real code, whatever the scanner sends: spaces dropped,
 * letters upper-cased; 13 digits = EAN-13, 12 digits = UPC-A kept as
 * "0" + its 12 digits (so the 12- and 13-digit forms of one UPC are the same
 * row), 8 digits = EAN-8 - each only with a correct check digit; any other
 * 4-32 characters of [A-Z0-9-] = Code 128.
 */
export function normalizeBarcode(raw: unknown): NormalizedBarcode {
  if (typeof raw !== 'string')
    return { ok: false, problem: 'BARCODE_REQUIRED' };
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!s) return { ok: false, problem: 'BARCODE_REQUIRED' };
  if (/^(SIB|PPB)-/.test(s)) return { ok: false, problem: 'BARCODE_RESERVED' };
  if (/^[0-9]+$/.test(s)) {
    if (s.length === 13) {
      return hasValidCheckDigit(s)
        ? { ok: true, code: s, format: 'EAN13' }
        : { ok: false, problem: 'BARCODE_CHECK_DIGIT' };
    }
    if (s.length === 12) {
      return hasValidCheckDigit(s)
        ? { ok: true, code: `0${s}`, format: 'UPCA' }
        : { ok: false, problem: 'BARCODE_CHECK_DIGIT' };
    }
    if (s.length === 8) {
      return hasValidCheckDigit(s)
        ? { ok: true, code: s, format: 'EAN8' }
        : { ok: false, problem: 'BARCODE_CHECK_DIGIT' };
    }
  }
  if (/^[A-Z0-9-]{4,32}$/.test(s))
    return { ok: true, code: s, format: 'CODE128' };
  return { ok: false, problem: 'BARCODE_INVALID' };
}

/** The GS1 restricted-circulation prefix every generated code starts with (in-store use only). */
export const GENERATED_BARCODE_PREFIX = '29';
const GENERATED_SEQ_DIGITS = 10;
export const MAX_GENERATED_BARCODE_SEQ = 10 ** GENERATED_SEQ_DIGITS - 1;

/**
 * The store's n-th generated code: "29" + n in 10 digits + the EAN-13 check
 * digit. Unique within the store by its counter; the range is GS1's
 * restricted-circulation one, so it never claims to be a registered GTIN.
 */
export function generatedProductBarcode(seq: number | bigint): string {
  const n = BigInt(seq);
  if (n < 1n || n > BigInt(MAX_GENERATED_BARCODE_SEQ)) {
    throw new RangeError('generated barcode sequence out of range');
  }
  const body = `${GENERATED_BARCODE_PREFIX}${n.toString().padStart(GENERATED_SEQ_DIGITS, '0')}`;
  return `${body}${gs1CheckDigit(body)}`;
}

/** What a label prints for a stored code: a UPC-A without its leading "0". */
export function printableBarcode(
  code: string,
  format: ProductBarcodeFormat,
): string {
  return format === 'UPCA' ? code.slice(1) : code;
}
