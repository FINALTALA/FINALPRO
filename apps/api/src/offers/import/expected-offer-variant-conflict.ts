import { Prisma } from '../../../generated/prisma/client';

// Sprint 7 round 5 review fix: importGroup()'s transaction can raise a
// Prisma P2002 for more than one reason - only these two OfferVariant
// unique constraints are the EXPECTED, recoverable "this exact row was
// already imported concurrently" race the controller's catch block is
// meant to paper over. Any other P2002 (e.g. ImportIdentifierRecord's
// own unique constraint, or any future constraint) is a real,
// unexpected conflict and must propagate as a failure, not a misleading
// 201 with a seller_sku-shaped invalid_rows entry.
const EXPECTED_CONSTRAINT_INDEXES = new Set([
  'offer_variants_vendorId_sellerSku_key',
  'offer_variants_vendorId_storeInventoryBarcode_key',
]);

/**
 * The actual Postgres constraint name is read from Prisma 7's
 * @prisma/adapter-pg-specific nested error shape
 * (`err.meta.driverAdapterError.cause.constraint.index`) behind a
 * defensive type guard at every level - unlike the substring-match
 * against the whole stringified `meta` object used elsewhere in this
 * codebase (see vendor-offers.controller.ts's own comment, where a
 * false positive only picks the wrong message for an exception that
 * gets thrown either way), an EXACT match against a fixed allow-list is
 * required here because a false positive would silently swallow a real
 * error into a successful response instead. If the shape is missing or
 * different (a driver-adapter version change, or a constraint this
 * function doesn't know about), this returns false and the caller must
 * re-throw rather than guess.
 */
export function isExpectedOfferVariantConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  if (err.code !== 'P2002') {
    return false;
  }

  const meta = err.meta;
  if (typeof meta !== 'object' || meta === null) {
    return false;
  }
  const driverAdapterError = (meta as Record<string, unknown>)
    .driverAdapterError;
  if (typeof driverAdapterError !== 'object' || driverAdapterError === null) {
    return false;
  }
  const cause = (driverAdapterError as Record<string, unknown>).cause;
  if (typeof cause !== 'object' || cause === null) {
    return false;
  }
  const constraint = (cause as Record<string, unknown>).constraint;
  if (typeof constraint !== 'object' || constraint === null) {
    return false;
  }
  const index = (constraint as Record<string, unknown>).index;
  if (typeof index !== 'string') {
    return false;
  }

  return EXPECTED_CONSTRAINT_INDEXES.has(index);
}
