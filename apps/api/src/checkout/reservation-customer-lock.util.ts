import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { lockCustomerAccountState } from '../common/customer-account-lock.util';

/**
 * TB-5: a customer holds at most ONE live checkout reservation - a new
 * reserve() atomically releases the previous one (and sweeps the
 * customer's own expired leftovers) instead of refusing the customer.
 */
export const ACTIVE_RESERVATIONS_PER_CUSTOMER = 1;

/** TB-5: the most units (all lines, stores, branches, variants) one reservation may hold. */
export const RESERVATION_UNITS_LIMIT = 30;

export function reservationUnitsLimitExceeded(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'RESERVATION_UNITS_LIMIT_EXCEEDED',
    message: `At most ${RESERVATION_UNITS_LIMIT} items per order`,
    details: [{ limit: RESERVATION_UNITS_LIMIT }],
  });
}

/**
 * TB-5: serialises every path that creates, consumes or releases one
 * customer's checkout reservations - reserve(), confirm() (both of its
 * transactions, including a failed payment's rollback) and
 * cancelReservation() - and is the ONLY way to take the customer's
 * reservation lock. Taken first in the transaction, in this fixed order:
 *
 *   1. the account lock (customer-account-lock.util.ts: the users row,
 *      FOR UPDATE) - the order customer-account-lock.util.ts documents;
 *   2. the customer's reservation advisory lock;
 *   then the existing global order (reservation rows -> vendor rows ->
 *   stock rows -> window rows).
 *
 * Why the account lock comes first in EVERY one of these paths, not only
 * in confirm(): any of them may write a row whose foreign key points at
 * the users row (reserve() records an audit row with actorId when it
 * replaces a live hold), and that write takes FOR KEY SHARE on the users
 * row. With confirm() holding the users row FOR UPDATE and waiting for
 * the reservation lock, a reserve() holding the reservation lock and
 * waiting for that FOR KEY SHARE was a real deadlock (TB-5, reproduced
 * 3/3 on 2026-11-06). Holding the users row first means no path ever
 * waits for it while holding the reservation lock.
 *
 * The lazy expiry sweeps on stock rows (stock-lock.util) deliberately do
 * NOT take it: they only ever finalise reservations that have already
 * expired, they are serialised against all of the above by the
 * reservation-row lock, and taking other customers' locks from inside a
 * transaction that already holds its own would create exactly the
 * cross-customer lock cycle this ordering avoids.
 *
 * Returns the customer's user id (CustomerProfile.userId never changes,
 * so reading it before any lock is safe).
 */
export async function lockCustomerCheckout(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<string> {
  const { userId } = await tx.customerProfile.findUniqueOrThrow({
    where: { id: customerId },
    select: { userId: true },
  });
  await lockCustomerAccountState(tx, userId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`checkout-reservation:${customerId}`}))`;
  return userId;
}
