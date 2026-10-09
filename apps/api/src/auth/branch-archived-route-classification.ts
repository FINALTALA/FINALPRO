/**
 * Sprint 18b (G-ON-07): the COMPLETE classification of every route
 * that carries a `:branchId` path param, for an ARCHIVED branch.
 * Enforced by test/sprint18b-branch-archived-route-classification.e2e-spec.ts,
 * which reads the routes actually registered in the Nest app and fails
 * when:
 *  - a route with a `:branchId` param exists that is in neither list
 *    (a new such route must be given an explicit decision here), or
 *  - a DENY route lacks @BlockWhenBranchArchived(), or an ALLOW route
 *    has it.
 *
 * Key format: `<HTTP METHOD> <controller path>/<handler path>`, same
 * convention as vendor-route-classification.ts - without the global
 * `/api/v1` prefix. A route with no `:branchId` param at all (e.g.
 * `POST vendors/:vendorId/branches`, `POST vendors/:vendorId/staff/
 * :vendorUserId/transfer` - the latter checks its TARGET branch from
 * the request body, not a route param, inline in its own handler) is
 * simply out of scope for this specific guard/classification, never a
 * case to list here.
 *
 * DENY = any operational write on the branch itself: new stock
 * movements, confirm-count, safety-stock, staff invites, verification
 * evidence/decision, delivery-window setup, operating-hours edits,
 * new closures, and archiving an already-archived branch again.
 * ALLOW = every read (stock, orders, verification evidence, delivery
 * windows, hours, closures, the branch itself), and completing an
 * existing order/fulfilment action - archive() itself already
 * guarantees no non-terminal BranchOrder is left by the time it
 * succeeds, so these are unreachable in practice, but classified
 * ALLOW anyway for the same "let what's already running finish"
 * reasoning as everywhere else in this codebase.
 *
 * This guard is a fast, pre-transaction, best-effort check only - see
 * BranchArchivedGuard's own comment for the exact "starts-after vs
 * started-before" semantics it does and does not guarantee.
 */
export const BRANCH_ARCHIVED_DENY_ROUTES: readonly string[] = [
  'POST vendors/:vendorId/branches/:branchId/stock/:offerVariantId/movements',
  'POST vendors/:vendorId/branches/:branchId/stock/:offerVariantId/confirm-count',
  'PUT vendors/:vendorId/branches/:branchId/stock/:offerVariantId/safety-stock',
  'POST vendors/:vendorId/branches/:branchId/staff-invites',
  'POST vendors/:vendorId/branches/:branchId/verification-evidence',
  'POST vendors/:vendorId/branches/:branchId/verification-decision',
  'POST vendors/:vendorId/branches/:branchId/delivery-windows',
  'PUT vendors/:vendorId/branches/:branchId/delivery-windows/:windowId',
  'DELETE vendors/:vendorId/branches/:branchId/delivery-windows/:windowId',
  'POST vendors/:vendorId/branches/:branchId/delivery-windows/:windowId/exceptions',
  'DELETE vendors/:vendorId/branches/:branchId/delivery-windows/:windowId/exceptions/:exceptionId',
  'PUT vendors/:vendorId/branches/:branchId/operating-hours',
  'POST vendors/:vendorId/branches/:branchId/closures',
  'POST vendors/:vendorId/branches/:branchId/archive',
  // Sprint 20b: a branch setting, same reasoning as operating-hours
  // above - pointless (and blocked) once the branch is retired.
  'PUT vendors/:vendorId/branches/:branchId/minimum-order',
];

export const BRANCH_ARCHIVED_ALLOW_ROUTES: readonly string[] = [
  'GET vendors/:vendorId/branches/:branchId',
  'GET vendors/:vendorId/branches/:branchId/stock',
  'GET vendors/:vendorId/branches/:branchId/stock/page',
  'GET vendors/:vendorId/branches/:branchId/stock/lookup',
  'GET vendors/:vendorId/branches/:branchId/stock/:offerVariantId',
  'GET vendors/:vendorId/branches/:branchId/stock/:offerVariantId/movements',
  'GET vendors/:vendorId/branches/:branchId/orders',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/start-preparation',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/mark-sent',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/mark-delivered',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/pickup-handover',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/rerequest-confirmation',
  // Sprint 20a: same "let an existing order finish" reasoning as the
  // fulfilment actions above.
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/cancel',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/items/:itemId/cancel',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/mark-delivery-failed',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/approve-refund',
  'GET vendors/:vendorId/branches/:branchId/verification-evidence',
  'GET vendors/:vendorId/branches/:branchId/delivery-windows',
  'GET vendors/:vendorId/branches/:branchId/operating-hours',
  'GET vendors/:vendorId/branches/:branchId/closures',
  // Sprint 20b: a plain read (same reasoning as operating-hours' own
  // GET above).
  'GET vendors/:vendorId/branches/:branchId/minimum-order',
  // Sprint 20b: editing a note on an EXISTING order - same "let an
  // existing order finish" reasoning as the fulfilment actions above,
  // never new footprint.
  'PATCH vendors/:vendorId/branches/:branchId/orders/:branchOrderId/internal-note',
];
