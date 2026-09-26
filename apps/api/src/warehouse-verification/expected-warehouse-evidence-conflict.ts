import { Prisma } from '../../generated/prisma/client';

// Sprint 15 review-round fix: submitEvidence()'s transaction can raise
// a Prisma P2002 for more than one reason (in principle, any unique
// constraint on any table touched by that transaction) - only the
// partial unique index below is the EXPECTED, recoverable "a second
// PENDING row for this vendor was created concurrently" race the
// controller's catch block is meant to paper over into a clean 409.
// Any other P2002 is a real, unexpected conflict and must propagate
// as a failure, not be silently relabelled WAREHOUSE_EVIDENCE_ALREADY_PENDING.
const EXPECTED_CONSTRAINT_INDEXES = new Set([
  'warehouse_verification_evidence_vendor_pending_key',
]);

/**
 * Same defensive type guard as offers/import/expected-offer-variant-conflict.ts
 * (see that file's own comment for the full rationale) - the actual
 * Postgres constraint name is read from Prisma 7's
 * @prisma/adapter-pg-specific nested error shape
 * (`err.meta.driverAdapterError.cause.constraint.index`) behind a
 * guard at every level. An exact match against a fixed allow-list is
 * required (not a substring match) because a false positive here
 * would silently swallow a real error into a misleading 409 instead
 * of a 500 that would actually get investigated. If the shape is
 * missing or different, or the constraint isn't the one this function
 * knows about, this returns false and the caller must re-throw.
 */
export function isExpectedWarehouseEvidencePendingConflict(
  err: unknown,
): boolean {
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
