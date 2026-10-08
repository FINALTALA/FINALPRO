import Decimal from 'decimal.js';
import { roundIls, toDecimal } from '../offers/pricing/effective-price.util';

/**
 * Sprint 20a (review-round requirement): BranchOrder.subtotal/
 * deliveryFee/total stay immutable forever - they represent the
 * original order value exactly as charged/expected. Everything a
 * cancellation/refund needs to know - what the customer still owes
 * (COD), what has already been refunded, and how much more CAN still
 * be refunded (ONLINE) - is computed HERE, at read/write time, from
 * those immutable originals plus the live BranchOrderItem.cancelledAt
 * flags and BranchOrderRefund rows. Every computation uses decimal.js
 * throughout (never native JS Number arithmetic) - the final result is
 * converted to a plain number only at the very last step, the same
 * boundary convention every other money field in this codebase already
 * uses (see effective-price.util.ts's own comment).
 */

export interface MoneyItemInput {
  unitPrice: unknown;
  quantity: number;
  cancelledAt: Date | null;
}

export interface MoneyRefundInput {
  amount: unknown;
}

/**
 * The amount still owed by the customer for a COD order, after any
 * item cancellations - original total minus every cancelled item's
 * own price minus the delivery fee IF it has already been refunded
 * (the delivery-fee-refund row only ever exists once the order is
 * fully closing out, at which point this function is moot anyway -
 * included for completeness/symmetry with the ONLINE-side
 * computation below).
 */
export function computeAmountDue(
  total: unknown,
  items: MoneyItemInput[],
  deliveryFeeRefunded: boolean,
  deliveryFee: unknown,
): Decimal {
  const cancelledTotal = items
    .filter((i) => i.cancelledAt !== null)
    .reduce(
      (sum, i) => sum.plus(toDecimal(i.unitPrice).times(i.quantity)),
      new Decimal(0),
    );
  let due = toDecimal(total).minus(cancelledTotal);
  if (deliveryFeeRefunded && deliveryFee !== null) {
    due = due.minus(toDecimal(deliveryFee));
  }
  return roundIls(due);
}

/** Sum of every BranchOrderRefund.amount already recorded for this BranchOrder. */
export function computeAmountRefunded(refunds: MoneyRefundInput[]): Decimal {
  return roundIls(
    refunds.reduce((sum, r) => sum.plus(toDecimal(r.amount)), new Decimal(0)),
  );
}

/**
 * The structural ceiling: total minus whatever has already been
 * refunded for this BranchOrder. This can only stay non-negative by
 * construction as long as EVERY refund-creating code path is tied to
 * closing out a specific item or the one delivery fee (never a
 * freestanding, admin-entered amount) - BranchOrderRefund's own
 * @@unique(branchOrderItemId) and the partial unique index on
 * (branchOrderId) WHERE reason='DELIVERY_FEE' then bound each item/the
 * fee to at most one refund, so the sum can never exceed
 * subtotal+deliveryFee=total. Review-round fix (2026-10-08): this
 * invariant was briefly broken by a manual, unallocated
 * PLATFORM_ADMIN_MANUAL refund that bypassed the item/fee pairing
 * entirely - removed from S20a for exactly that reason (see
 * PLATFORM_ADMIN_MANUAL's own schema comment). Do not reintroduce a
 * refund path that creates a row not tied to a specific item or the
 * delivery fee without a real allocation ledger.
 */
export function computeRemainingRefundable(
  total: unknown,
  refunds: MoneyRefundInput[],
): Decimal {
  const refunded = computeAmountRefunded(refunds);
  return roundIls(toDecimal(total).minus(refunded));
}

export function decimalToNumber(value: Decimal): number {
  return value.toNumber();
}
