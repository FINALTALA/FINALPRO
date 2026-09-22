import {
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
 * actually applies a transition to a real row (nothing calls that
 * service yet either - no HTTP endpoint exists this sprint; checkout/
 * fulfilment actions that will call it are Sprint 10-11).
 */
interface TransitionRule {
  to: BranchOrderStatus;
  /** null = legal regardless of fulfilment method. */
  fulfilmentMethod: FulfilmentMethod | null;
}

const TRANSITIONS: Record<BranchOrderStatus, TransitionRule[]> = {
  PLACED: [
    { to: 'PREPARING', fulfilmentMethod: null },
    // PDR-028: "before preparation: customer cancels item" - modeled at
    // the whole-BranchOrder level this sprint (per-item cancellation is
    // RB-FUL-007, Should, deferred).
    { to: 'CANCELLED', fulfilmentMethod: null },
    // PDR-025: the unprepared-at-slot auto-refund path. Nothing
    // triggers this automatically yet (no scheduled-job infrastructure
    // exists in this codebase - the same honestly-documented gap as
    // every other "would need a cron worker" feature here); the
    // transition is legal so a future sprint's explicit trigger has a
    // correct graph to call into.
    { to: 'REFUNDED', fulfilmentMethod: null },
  ],
  PREPARING: [
    { to: 'SENT', fulfilmentMethod: 'DELIVERY' },
    { to: 'PICKED_UP', fulfilmentMethod: 'PICKUP' },
    // PDR-028: "after prep/before Sent: staff cancels after external
    // contact."
    { to: 'CANCELLED', fulfilmentMethod: null },
    { to: 'REFUNDED', fulfilmentMethod: null },
  ],
  // PDR-028: "once Sent, neither side self-cancels in-app" - SENT
  // deliberately has no CANCELLED/REFUNDED entry below, enforced by the
  // graph itself, not just left to convention.
  SENT: [{ to: 'DELIVERED', fulfilmentMethod: 'DELIVERY' }],
  // PDR-026: customer confirms, or the (not-yet-built, Sprint 11) 72h
  // auto-confirm fires.
  DELIVERED: [{ to: 'COMPLETED', fulfilmentMethod: 'DELIVERY' }],
  // Pickup handover is itself the confirmation - PDR-026's own explicit
  // customer-confirm step is written for delivery specifically, so
  // PICKED_UP -> COMPLETED is a direct, always-legal transition rather
  // than needing its own separate confirm state.
  PICKED_UP: [{ to: 'COMPLETED', fulfilmentMethod: 'PICKUP' }],
  COMPLETED: [],
  CANCELLED: [],
  REFUNDED: [],
};

export function canTransition(
  from: BranchOrderStatus,
  to: BranchOrderStatus,
  fulfilmentMethod: FulfilmentMethod,
): boolean {
  return TRANSITIONS[from].some(
    (rule) =>
      rule.to === to &&
      (rule.fulfilmentMethod === null ||
        rule.fulfilmentMethod === fulfilmentMethod),
  );
}

export function allowedNextStates(
  from: BranchOrderStatus,
  fulfilmentMethod: FulfilmentMethod,
): BranchOrderStatus[] {
  return TRANSITIONS[from]
    .filter(
      (rule) =>
        rule.fulfilmentMethod === null ||
        rule.fulfilmentMethod === fulfilmentMethod,
    )
    .map((rule) => rule.to);
}
