import Decimal from 'decimal.js';
import { roundIls, toDecimal } from '../offers/pricing/effective-price.util';

/**
 * Sprint 21 (PDR-030/031, EPIC-RET). Two pure, DB-free halves of the
 * same mechanism:
 *
 * 1. `buildReturnPolicySnapshot()` - called ONCE, at checkout
 *    confirm() time, from the vendor's CURRENT live policy at that
 *    exact moment. The five fields it returns are written onto the
 *    BranchOrder and never touched again - PDR-030's "policy/fees
 *    disclosed and snapshotted at purchase" taken literally. A later
 *    change to the vendor's live policy must never retroactively
 *    change what an already-placed order is eligible for.
 *
 * 2. `checkReturnEligibility()` - called every time a NEW return is
 *    submitted, checked ONLY against that frozen snapshot plus the
 *    fulfilment-method-specific "did this item actually arrive"
 *    timestamps - never against the vendor's live policy again.
 *
 * A BranchOrder with no snapshot at all (every row confirmed before
 * this migration shipped) is unconditionally ineligible - a return
 * right never disclosed at purchase cannot be granted retroactively
 * just because the vendor later turns returns on.
 */

export interface VendorReturnPolicySource {
  returnsEnabled: boolean;
  returnMode: 'NO_RETURN' | 'REFUND_ONLY' | 'EXCHANGE_ONLY' | 'BOTH';
  returnWindowDays: number | null;
  returnFeeIls: unknown;
  exchangeFeeIls: unknown;
  returnPolicyUpdatedAt: Date | null;
}

export interface ReturnPolicySnapshot {
  returnPolicySnapshotEnabled: boolean;
  returnPolicySnapshotMode:
    'NO_RETURN' | 'REFUND_ONLY' | 'EXCHANGE_ONLY' | 'BOTH';
  returnPolicySnapshotWindowDays: number | null;
  returnPolicySnapshotFeeIls: Decimal | null;
  returnPolicySnapshotExchangeFeeIls: Decimal | null;
  returnPolicySnapshotVersion: Date | null;
}

export function buildReturnPolicySnapshot(
  vendor: VendorReturnPolicySource,
): ReturnPolicySnapshot {
  return {
    returnPolicySnapshotEnabled: vendor.returnsEnabled,
    returnPolicySnapshotMode: vendor.returnMode,
    returnPolicySnapshotWindowDays: vendor.returnWindowDays,
    returnPolicySnapshotFeeIls:
      vendor.returnFeeIls != null ? toDecimal(vendor.returnFeeIls) : null,
    returnPolicySnapshotExchangeFeeIls:
      vendor.exchangeFeeIls != null ? toDecimal(vendor.exchangeFeeIls) : null,
    returnPolicySnapshotVersion: vendor.returnPolicyUpdatedAt,
  };
}

/**
 * Sprint 21b: whether a customer-chosen outcome is even permitted by
 * the ORDER's own snapshotted mode (never the vendor's live policy) -
 * REFUND_ONLY allows only RETURN, EXCHANGE_ONLY allows only EXCHANGE,
 * BOTH allows either. Called at submit() time AND re-checked verbatim
 * under lock inside the approval helper, since the snapshot itself
 * never changes between the two (re-checking here only protects
 * against the pre-lock submit()-time check being bypassed by a direct
 * call, not against a real race - the snapshot is frozen at confirm()
 * time, long before either check runs).
 */
export function isOutcomeAllowedBySnapshot(
  snapshotMode: string | null,
  desiredOutcome: 'RETURN' | 'EXCHANGE',
): boolean {
  if (snapshotMode === 'BOTH') return true;
  if (snapshotMode === 'REFUND_ONLY') return desiredOutcome === 'RETURN';
  if (snapshotMode === 'EXCHANGE_ONLY') return desiredOutcome === 'EXCHANGE';
  return false;
}

export type FulfilmentMethod = 'PICKUP' | 'DELIVERY';
export type BranchOrderPaymentMethod = 'COD' | 'ONLINE';

export interface ReturnEligibilityOrderInput {
  status: string;
  fulfilmentMethod: FulfilmentMethod;
  paymentMethod: BranchOrderPaymentMethod;
  deliveredAt: Date | null;
  pickedUpAt: Date | null;
  codCollectedAt: Date | null;
  returnPolicySnapshotEnabled: boolean | null;
  returnPolicySnapshotMode: string | null;
  returnPolicySnapshotWindowDays: number | null;
}

export interface ReturnEligibilityResult {
  eligible: boolean;
  reasonCode?:
    | 'NO_POLICY_SNAPSHOT'
    | 'RETURNS_DISABLED'
    | 'NOT_YET_ARRIVED'
    | 'COD_NOT_COLLECTED'
    | 'WINDOW_EXPIRED';
  /** The timestamp the window is computed from (deliveredAt/pickedUpAt) - null when not yet eligible for a reason that has no such anchor. */
  windowAnchor?: Date;
  windowExpiresAt?: Date;
}

/**
 * The fulfilment/payment conditions precisely:
 * - DELIVERY: status must have actually reached DELIVERED or
 *   COMPLETED - window always anchored on `deliveredAt`, regardless of
 *   which of those two the order currently sits in.
 * - PICKUP: status must have actually reached PICKED_UP or COMPLETED,
 *   AND `pickedUpAt` must be set.
 * - COD: additionally requires `codCollectedAt` set - confirms money
 *   was actually collected, not just that the item changed hands.
 * - ONLINE: no separate check needed here - structurally guaranteed by
 *   the AwaitingPayment gate (ADR-010), which never lets a BranchOrder
 *   with paymentMethod=ONLINE exist at all before its payment already
 *   succeeded.
 */
export function checkReturnEligibility(
  order: ReturnEligibilityOrderInput,
  now: Date,
): ReturnEligibilityResult {
  if (
    order.returnPolicySnapshotEnabled === null ||
    order.returnPolicySnapshotMode === null
  ) {
    return { eligible: false, reasonCode: 'NO_POLICY_SNAPSHOT' };
  }
  if (
    !order.returnPolicySnapshotEnabled ||
    order.returnPolicySnapshotMode === 'NO_RETURN'
  ) {
    return { eligible: false, reasonCode: 'RETURNS_DISABLED' };
  }

  let windowAnchor: Date | null = null;
  if (order.fulfilmentMethod === 'DELIVERY') {
    if (
      !['DELIVERED', 'COMPLETED'].includes(order.status) ||
      order.deliveredAt === null
    ) {
      return { eligible: false, reasonCode: 'NOT_YET_ARRIVED' };
    }
    windowAnchor = order.deliveredAt;
  } else {
    if (
      !['PICKED_UP', 'COMPLETED'].includes(order.status) ||
      order.pickedUpAt === null
    ) {
      return { eligible: false, reasonCode: 'NOT_YET_ARRIVED' };
    }
    windowAnchor = order.pickedUpAt;
  }

  if (order.paymentMethod === 'COD' && order.codCollectedAt === null) {
    return { eligible: false, reasonCode: 'COD_NOT_COLLECTED' };
  }

  if (order.returnPolicySnapshotWindowDays === null) {
    // REFUND_ONLY/BOTH always carries a window per the DTO that wrote
    // this snapshot - null here means the data is malformed, treat as
    // expired (fail closed, never fail open on a missing number).
    return {
      eligible: false,
      reasonCode: 'WINDOW_EXPIRED',
      windowAnchor,
    };
  }
  const windowExpiresAt = new Date(
    windowAnchor.getTime() +
      order.returnPolicySnapshotWindowDays * 24 * 60 * 60 * 1000,
  );
  if (now > windowExpiresAt) {
    return {
      eligible: false,
      reasonCode: 'WINDOW_EXPIRED',
      windowAnchor,
      windowExpiresAt,
    };
  }

  return { eligible: true, windowAnchor, windowExpiresAt };
}

/**
 * max(0, item_total - fee) - never negative, the customer never owes
 * a difference. item_total uses the ORIGINAL snapshotted unitPrice x
 * quantity (full line, no partial-quantity returns this sprint - same
 * documented scope decision as item cancellation). No delivery-fee
 * component at all - a post-delivery return never refunds it (the
 * delivery service was already rendered).
 */
export function computeReturnRefundAmount(
  itemUnitPrice: unknown,
  itemQuantity: number,
  snapshottedFeeIls: unknown,
): Decimal {
  const itemTotal = toDecimal(itemUnitPrice).times(itemQuantity);
  const fee =
    snapshottedFeeIls != null ? toDecimal(snapshottedFeeIls) : new Decimal(0);
  const amount = itemTotal.minus(fee);
  return roundIls(amount.isNegative() ? new Decimal(0) : amount);
}

export interface ExchangeSettlementCalculation {
  originalTotal: Decimal;
  replacementTotal: Decimal;
  netAmount: Decimal;
  direction: 'COLLECT_CASH' | 'REFUND_CASH' | 'NONE';
}

/**
 * Sprint 21b (PDR §3.5, review-round exact formula):
 *   replacement_total = replacement_unit_price_snapshot * quantity
 *   original_total     = original_unit_price_snapshot * quantity
 *   net                 = replacement_total - original_total + exchange_fee_snapshot
 * net > 0 => COLLECT_CASH net; net < 0 => REFUND_CASH abs(net); net = 0 => NONE.
 * All decimal.js, never Number - both totals use the SAME quantity
 * (no partial-quantity exchange, S21b scope decision), and both unit
 * prices are SNAPSHOTS captured at submit() time, never a live price
 * re-read at settlement time.
 */
export function computeExchangeSettlement(
  originalUnitPriceSnapshot: unknown,
  replacementUnitPriceSnapshot: unknown,
  quantity: number,
  exchangeFeeSnapshot: unknown,
): ExchangeSettlementCalculation {
  const originalTotal = roundIls(
    toDecimal(originalUnitPriceSnapshot).times(quantity),
  );
  const replacementTotal = roundIls(
    toDecimal(replacementUnitPriceSnapshot).times(quantity),
  );
  const fee =
    exchangeFeeSnapshot != null
      ? toDecimal(exchangeFeeSnapshot)
      : new Decimal(0);
  const net = roundIls(replacementTotal.minus(originalTotal).plus(fee));

  if (net.isZero()) {
    return {
      originalTotal,
      replacementTotal,
      netAmount: net,
      direction: 'NONE',
    };
  }
  return {
    originalTotal,
    replacementTotal,
    netAmount: net.isNegative() ? net.negated() : net,
    direction: net.isNegative() ? 'REFUND_CASH' : 'COLLECT_CASH',
  };
}
