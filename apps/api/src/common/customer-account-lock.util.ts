import { Prisma } from '../../generated/prisma/client';

/**
 * Sprint 22 (FR-AUTH-014, PDR-034): the one lock every transaction that
 * either (a) deactivates a customer's account or (b) creates a new
 * BranchOrder for them must take FIRST, before any reservation/stock/
 * window lock - closing the race where checkout's confirm() and
 * `DELETE /customers/me` interleave such that confirm() reads "not yet
 * deactivated" a moment before deactivate() commits, then still
 * creates a BranchOrder for an account that is (by the time anyone
 * reads it again) already deactivated.
 *
 * Taken by: CustomersController.deactivateAccount() (first, before the
 * active-vendor-ownership and active-order checks below), the account
 * reactivation in AuthController, and - through lockCustomerCheckout()
 * (checkout/reservation-customer-lock.util.ts), always before the
 * customer's reservation lock - every checkout path: reserve(),
 * cancelReservation() and both of confirm()'s transactions.
 * TB-5: reserve() and cancelReservation() take it too, not because they
 * create an order, but because a transaction holding the reservation
 * lock must never wait for this row (reserve()'s audit row references
 * it, which needs FOR KEY SHARE on it) - that wait, against confirm()
 * holding this row and waiting for the reservation lock, was a real
 * deadlock.
 */
export async function lockCustomerAccountState(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
}

/**
 * Sprint 22 (FR-AUTH-008, PDR-029): every address-mutating operation
 * for one customer - create, edit, set-default, archive/delete - takes
 * this FIRST, not just the set-default path. Without it, two
 * concurrent `create()` calls for a customer with zero addresses could
 * each decide independently "I am the first address, I become
 * default" and both write isDefault=true (the partial unique index on
 * Address is the last-resort backstop, not the real guarantee - this
 * lock is).
 */
export async function lockCustomerAddressState(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM customer_profiles WHERE id = ${customerId} FOR UPDATE`;
}

/**
 * Sprint 22 (FR-AUTH-014, PDR-034): locks every given Vendor row, one
 * at a time, in a fixed ascending-by-id order - same established
 * pattern as stock-lock.util.ts's own lockReservationRowsSorted(), a
 * loop of single-row locks rather than one multi-row statement, so two
 * callers locking an overlapping-but-not-identical set of vendors can
 * never deadlock against each other.
 *
 * The ONLY current caller is `DELETE /customers/me` (locking every
 * Vendor this user OWNs, to serialize the "is this the last active
 * OWNER" decision against another co-owner's own concurrent
 * deactivation attempt for the SAME vendor - a plain per-user lock
 * cannot do this, since two different users each lock their own,
 * different User row). No ownership-transfer/invite-another-owner
 * feature exists in this codebase today (StaffInvite requires a
 * branchId and can never create or touch an OWNER membership) - but
 * any FUTURE feature that creates, removes, or transfers an OWNER
 * membership for a vendor MUST take this same lock on that vendor
 * first, so the "who is an active owner right now" question always has
 * one consistent, serialized answer.
 */
export async function lockVendorRowsSorted(
  tx: Prisma.TransactionClient,
  vendorIds: string[],
): Promise<void> {
  const sorted = [...new Set(vendorIds)].sort();
  for (const id of sorted) {
    await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${id} FOR UPDATE`;
  }
}
