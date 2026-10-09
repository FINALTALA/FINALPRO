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
  returnPolicyUpdatedAt: Date | null;
}

export interface ReturnPolicySnapshot {
  returnPolicySnapshotEnabled: boolean;
  returnPolicySnapshotMode:
    'NO_RETURN' | 'REFUND_ONLY' | 'EXCHANGE_ONLY' | 'BOTH';
  returnPolicySnapshotWindowDays: number | null;
  returnPolicySnapshotFeeIls: Decimal | null;
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
    returnPolicySnapshotVersion: vendor.returnPolicyUpdatedAt,
  };
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
