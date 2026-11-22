import { NotificationType } from '../../generated/prisma/client';

/**
 * TB-15: the store-side return notifications. ONE outbox event per
 * transition (payload: `{ return_id }` only - no recipient, no customer
 * data). The relay resolves who receives it when it sends, from the
 * live memberships, so a member suspended or moved to another branch
 * after the transition is not notified.
 */
export const RETURN_STORE_EVENT_TYPES = {
  // ESCALATED -> APPROVED_AWAITING_DROPOFF by a platform administrator.
  'return.platform_approved_for_store': 'RETURN_PLATFORM_APPROVED',
  // ESCALATED -> ADMIN_REJECTED by a platform administrator.
  'return.platform_rejected_for_store': 'RETURN_PLATFORM_REJECTED',
  // REQUESTED -> CANCELLED_BY_CUSTOMER by the customer.
  'return.cancelled_for_store': 'RETURN_CANCELLED_BY_CUSTOMER',
} as const satisfies Record<string, NotificationType>;

export type ReturnStoreEventType = keyof typeof RETURN_STORE_EVENT_TYPES;

export function isReturnStoreEventType(
  eventType: string,
): eventType is ReturnStoreEventType {
  return Object.prototype.hasOwnProperty.call(
    RETURN_STORE_EVENT_TYPES,
    eventType,
  );
}

export interface StoreMemberCandidate {
  userId: string;
  role: 'OWNER' | 'BRANCH_EMPLOYEE';
  status: 'ACTIVE' | 'SUSPENDED';
  branchId: string | null;
  userDeactivated: boolean;
}

/**
 * Who receives a store return notification: every ACTIVE owner, and every
 * ACTIVE employee of the order's own branch - never an employee of another
 * branch, a suspended membership or a deactivated account. When the store
 * itself is SUSPENDED, ACTIVE owners only - no employee at all. The person
 * who made the change is left out. Each user at most once, sorted.
 */
export function storeReturnRecipients(
  members: StoreMemberCandidate[],
  orderBranchId: string,
  actorUserId: string | null,
  storeSuspended: boolean,
): string[] {
  const ids = new Set<string>();
  for (const m of members) {
    if (m.status !== 'ACTIVE' || m.userDeactivated) continue;
    const allowed =
      m.role === 'OWNER' ||
      (!storeSuspended &&
        m.role === 'BRANCH_EMPLOYEE' &&
        m.branchId === orderBranchId);
    if (allowed && m.userId !== actorUserId) ids.add(m.userId);
  }
  return [...ids].sort();
}

/** The only thing a store return notification may carry: for an approval,
 * whether it is a RETURN or an EXCHANGE (a fixed code). Nothing else - no
 * customer data, reason, note, photo, rejection text or amount. */
export function storeReturnSafeData(
  eventType: ReturnStoreEventType,
  desiredOutcome: string,
): Record<string, unknown> {
  if (
    eventType === 'return.platform_approved_for_store' &&
    (desiredOutcome === 'RETURN' || desiredOutcome === 'EXCHANGE')
  ) {
    return { outcome: desiredOutcome };
  }
  return {};
}
