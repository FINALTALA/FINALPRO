import {
  BranchOrderPaymentMethod,
  BranchOrderStatus,
  FulfilmentMethod,
} from '../../generated/prisma/client';

/**
 * Sprint 9 (RB-ORD-001): the BranchOrder transition graph, synthesized
 * from PDR-025 through PDR-029 and FR-FUL-008/009 - no ready-made
 * BranchOrder state enum exists anywhere in the SRS to reuse (the only
 * state machine on record, VendorSuborder's, is explicitly superseded
 * by FR-ORD-009 - see BranchOrderStatus's own schema.prisma comment for
 * the full citation). Pure and DB-free by design, so it can be
 * exhaustively unit-tested without a database - see
 * branch-order.service.ts for the guarded, transactional wrapper that
 * actually applies a transition to a real row.
 *
 * Sprint 20a (PDR-027): extends the graph with DELIVERY_FAILED/
 * REFUND_REQUESTED and a new, optional `deliveryAttemptCount` axis
 * (defaulting to 0, so every pre-Sprint-20a rule/call site is
 * unaffected) - see canTransition()'s own comment for exactly what
 * value to pass and TransitionRule's own comment for how the min/max
 * bounds read it.
 */
interface TransitionRule {
  to: BranchOrderStatus;
  /** null = legal regardless of fulfilment method. */
  fulfilmentMethod: FulfilmentMethod | null;
  /**
   * null = legal regardless of payment method. PDR-025 (Codex review
   * round 1 on commit e12d77a): a financial refund only ever applies to
   * an ONLINE payment - COD was never charged, so there is nothing to
   * refund; a COD order that needs undoing before fulfilment is a plain
   * CANCELLED, never REFUNDED.
   */
  paymentMethod: BranchOrderPaymentMethod | null;
  /**
   * Sprint 20a (PDR-027): undefined = legal regardless of the CURRENT
   * deliveryAttemptCount (read BEFORE this transition is applied - the
   * count that incrementing SENT->DELIVERY_FAILED is about to raise by
   * one, not the value after). minDeliveryAttemptCount/
   * maxDeliveryAttemptCount bound which attempt this rule applies to -
   * see this file's own top comment for the exact attempt-by-attempt
   * table these encode.
   */
  minDeliveryAttemptCount?: number;
  maxDeliveryAttemptCount?: number;
}

const TRANSITIONS: Record<BranchOrderStatus, TransitionRule[]> = {
  PLACED: [
    { to: 'PREPARING', fulfilmentMethod: null, paymentMethod: null },
    // PDR-028: "before preparation: customer cancels item" - modeled at
    // the whole-BranchOrder level this sprint (per-item cancellation is
    // RB-FUL-007, Should, deferred). Legal for either payment method -
    // cancelling is not itself a refund.
    { to: 'CANCELLED', fulfilmentMethod: null, paymentMethod: null },
    // PDR-025: the unprepared-at-slot auto-refund path - ONLINE only
    // (see TransitionRule.paymentMethod's own comment above). Nothing
    // triggers this automatically yet (no scheduled-job infrastructure
    // exists in this codebase - the same honestly-documented gap as
    // every other "would need a cron worker" feature here); the
    // transition is legal so a future sprint's explicit trigger has a
    // correct graph to call into.
    { to: 'REFUNDED', fulfilmentMethod: null, paymentMethod: 'ONLINE' },
  ],
  PREPARING: [
    { to: 'SENT', fulfilmentMethod: 'DELIVERY', paymentMethod: null },
    { to: 'PICKED_UP', fulfilmentMethod: 'PICKUP', paymentMethod: null },
    // PDR-028: "after prep/before Sent: staff cancels after external
    // contact."
    { to: 'CANCELLED', fulfilmentMethod: null, paymentMethod: null },
    { to: 'REFUNDED', fulfilmentMethod: null, paymentMethod: 'ONLINE' },
  ],
  // PDR-028: "once Sent, neither side self-cancels in-app" - SENT
  // deliberately has no plain CANCELLED/REFUNDED entry for a
  // successful delivery; the only way out besides DELIVERED is a
  // reported delivery FAILURE (PDR-027), handled below.
  SENT: [
    { to: 'DELIVERED', fulfilmentMethod: 'DELIVERY', paymentMethod: null },
    // PDR-027, attempt 1 (current count is 0): any payment method
    // rests at DELIVERY_FAILED - COD only diverges starting at
    // attempt 2.
    {
      to: 'DELIVERY_FAILED',
      fulfilmentMethod: 'DELIVERY',
      paymentMethod: null,
      maxDeliveryAttemptCount: 0,
    },
    // PDR-027, attempt 2+ (current count >= 1), ONLINE only: rests at
    // DELIVERY_FAILED again, awaiting the customer's own refund
    // request once count reaches 2 (see DELIVERY_FAILED's own rules
    // below - REFUND_REQUESTED only opens at count>=2).
    {
      to: 'DELIVERY_FAILED',
      fulfilmentMethod: 'DELIVERY',
      paymentMethod: 'ONLINE',
      minDeliveryAttemptCount: 1,
    },
    // PDR-027, attempt 2, COD only: skips DELIVERY_FAILED entirely -
    // one atomic write finalizes count->2 and status->CANCELLED
    // together (nothing was ever charged, so there is nothing to
    // refund and nothing to wait on).
    {
      to: 'CANCELLED',
      fulfilmentMethod: 'DELIVERY',
      paymentMethod: 'COD',
      minDeliveryAttemptCount: 1,
    },
  ],
  // PDR-026: customer confirms, or the (not-yet-built, Sprint 11) 72h
  // auto-confirm fires.
  DELIVERED: [
    { to: 'COMPLETED', fulfilmentMethod: 'DELIVERY', paymentMethod: null },
  ],
  // Pickup handover is itself the confirmation - PDR-026's own explicit
  // customer-confirm step is written for delivery specifically, so
  // PICKED_UP -> COMPLETED is a direct, always-legal transition rather
  // than needing its own separate confirm state.
  PICKED_UP: [
    { to: 'COMPLETED', fulfilmentMethod: 'PICKUP', paymentMethod: null },
  ],
  // Sprint 20a (PDR-027): reached only from SENT (never COD at
  // count>=1, which finalizes straight to CANCELLED above). Which
  // exits are legal depends entirely on the CURRENT count (read before
  // any of these fire):
  //  - count=1 (the first failure): reschedule back to SENT, or the
  //    sweep's own 48h-no-reschedule timeout (COD cancels, ONLINE
  //    auto-refunds directly - no REFUND_REQUESTED stop for a timeout,
  //    only for an ACTUAL second failed attempt).
  //  - count>=2 (ONLINE only - COD never reaches DELIVERY_FAILED at
  //    this count): rescheduling is closed for good; only the
  //    customer's own explicit refund request remains.
  DELIVERY_FAILED: [
    {
      to: 'SENT',
      fulfilmentMethod: 'DELIVERY',
      paymentMethod: null,
      maxDeliveryAttemptCount: 1,
    },
    {
      to: 'CANCELLED',
      fulfilmentMethod: 'DELIVERY',
      paymentMethod: 'COD',
      maxDeliveryAttemptCount: 1,
    },
    {
      to: 'REFUNDED',
      fulfilmentMethod: 'DELIVERY',
      paymentMethod: 'ONLINE',
      maxDeliveryAttemptCount: 1,
    },
    {
      to: 'REFUND_REQUESTED',
      fulfilmentMethod: 'DELIVERY',
      paymentMethod: 'ONLINE',
      minDeliveryAttemptCount: 2,
    },
  ],
  // Sprint 20a (PDR-027): staff/owner approval is the only way out -
  // no rejection path exists this sprint (a known, documented gap, not
  // an oversight - PDR-027 names an approval step but never names a
  // rejection one).
  REFUND_REQUESTED: [
    {
      to: 'REFUNDED',
      fulfilmentMethod: 'DELIVERY',
      paymentMethod: 'ONLINE',
      minDeliveryAttemptCount: 2,
    },
  ],
  COMPLETED: [],
  CANCELLED: [],
  REFUNDED: [],
};

/**
 * PDR-025/PDR-029: an order in any of these three states is done -
 * nothing about it (including which delivery window it was slotted
 * into) changes again. Shared with DeliveryWindowsController's own
 * "a window with active orders can't be edited/deleted" guard, so both
 * call sites agree on exactly what "active" means without duplicating
 * the list.
 */
export const TERMINAL_BRANCH_ORDER_STATUSES: readonly BranchOrderStatus[] = [
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
];

export function isTerminalBranchOrderStatus(
  status: BranchOrderStatus,
): boolean {
  return (TERMINAL_BRANCH_ORDER_STATUSES as BranchOrderStatus[]).includes(
    status,
  );
}

/**
 * Sprint 20a: `deliveryAttemptCount` defaults to 0 - every rule written
 * before this sprint has neither min/max bound, so passing (or
 * omitting) 0 reproduces the exact pre-Sprint-20a behavior unchanged
 * for every existing call site/test. Only the new SENT/
 * DELIVERY_FAILED/REFUND_REQUESTED rules above actually read this
 * value - it is the count BEFORE the transition under consideration
 * would apply, never the value after.
 */
function attemptCountMatches(
  rule: TransitionRule,
  deliveryAttemptCount: number,
): boolean {
  if (
    rule.minDeliveryAttemptCount !== undefined &&
    deliveryAttemptCount < rule.minDeliveryAttemptCount
  ) {
    return false;
  }
  if (
    rule.maxDeliveryAttemptCount !== undefined &&
    deliveryAttemptCount > rule.maxDeliveryAttemptCount
  ) {
    return false;
  }
  return true;
}

export function canTransition(
  from: BranchOrderStatus,
  to: BranchOrderStatus,
  fulfilmentMethod: FulfilmentMethod,
  paymentMethod: BranchOrderPaymentMethod,
  deliveryAttemptCount = 0,
): boolean {
  return TRANSITIONS[from].some(
    (rule) =>
      rule.to === to &&
      (rule.fulfilmentMethod === null ||
        rule.fulfilmentMethod === fulfilmentMethod) &&
      (rule.paymentMethod === null || rule.paymentMethod === paymentMethod) &&
      attemptCountMatches(rule, deliveryAttemptCount),
  );
}

export function allowedNextStates(
  from: BranchOrderStatus,
  fulfilmentMethod: FulfilmentMethod,
  paymentMethod: BranchOrderPaymentMethod,
  deliveryAttemptCount = 0,
): BranchOrderStatus[] {
  return TRANSITIONS[from]
    .filter(
      (rule) =>
        (rule.fulfilmentMethod === null ||
          rule.fulfilmentMethod === fulfilmentMethod) &&
        (rule.paymentMethod === null || rule.paymentMethod === paymentMethod) &&
        attemptCountMatches(rule, deliveryAttemptCount),
    )
    .map((rule) => rule.to);
}
