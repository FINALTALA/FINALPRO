import { CanonicalProductStatus } from '../../generated/prisma/client';

/**
 * Sprint 17b (FR-CAT-008): DRAFT -> PENDING_REVIEW -> PUBLISHED ->
 * ARCHIVED, explicit and enforced - replaces the free-form `status`
 * Sprint 3 originally accepted on create/PATCH with no workflow of its
 * own. Pure and DB-free by design, same split as
 * branch-order-state-machine.ts - CanonicalProductLifecycleService is
 * the guarded, transactional wrapper that actually applies a
 * transition to a real row.
 *
 * MERGED is deliberately excluded from this table entirely - it is
 * never a transition a status-transition caller can request directly,
 * only a side effect of a successful merge (CanonicalProductMergeService).
 * Any attempted transition INTO or OUT OF MERGED through this table is
 * illegal by construction (MERGED simply never appears as a `to` value,
 * and once a product IS MERGED, TRANSITIONS[MERGED] is empty).
 */
const TRANSITIONS: Record<CanonicalProductStatus, CanonicalProductStatus[]> = {
  DRAFT: ['PENDING_REVIEW', 'ARCHIVED'],
  PENDING_REVIEW: ['PUBLISHED', 'DRAFT'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: ['PUBLISHED'],
  MERGED: [],
};

export function canTransitionCanonicalProduct(
  from: CanonicalProductStatus,
  to: CanonicalProductStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedNextCanonicalProductStatuses(
  from: CanonicalProductStatus,
): CanonicalProductStatus[] {
  return TRANSITIONS[from];
}
