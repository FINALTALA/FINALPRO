/**
 * Sprint 16 (L-23, FR-VEND-009): the COMPLETE classification of every
 * route under `vendors/:vendorId/*` for a SUSPENDED vendor. Enforced by
 * test/sprint16-vendor-route-classification.e2e-spec.ts, which reads the
 * routes actually registered in the Nest app and fails when:
 *  - a route exists that is in neither list (a new route must be given
 *    an explicit decision here), or
 *  - a DENY route lacks @BlockWhenSuspended(), or an ALLOW route has it.
 *
 * Key format: `<HTTP METHOD> <controller path>/<handler path>`, without
 * the global `/api/v1` prefix.
 *
 * DENY = catalog / offers / media / import / inventory movements /
 * storefront / sections: "catalog editing, new-offer creation, and
 * storefront visibility are blocked" (L-23).
 * ALLOW = everything a suspended store still needs: in-flight order
 * fulfilment, every read, subscription renewal, store configuration,
 * staff, delivery setup, and verification.
 */
export const SUSPENDED_DENY_ROUTES: readonly string[] = [
  'POST vendors/:vendorId/offers',
  'PATCH vendors/:vendorId/offers/:offerId/status',
  'POST vendors/:vendorId/offers/:offerId/variants',
  'POST vendors/:vendorId/offers/:offerId/variants/:variantId/match-confirmation',
  'POST vendors/:vendorId/offers/:offerId/variants/:variantId/media',
  'DELETE vendors/:vendorId/offers/:offerId/variants/:variantId/media/:mediaId',
  'POST vendors/:vendorId/offers/import',
  'POST vendors/:vendorId/offers/:offerId/variants/:variantId/match-review/search',
  'POST vendors/:vendorId/offers/:offerId/variants/:variantId/match-review/candidates/:candidateId/decision',
  'POST vendors/:vendorId/canonical-products/:canonicalProductId/name-change-requests',
  'POST vendors/:vendorId/branches/:branchId/stock/:offerVariantId/movements',
  // Sprint 18a.
  'POST vendors/:vendorId/branches/:branchId/stock/:offerVariantId/confirm-count',
  'PUT vendors/:vendorId/branches/:branchId/stock/:offerVariantId/safety-stock',
  'PUT vendors/:vendorId/storefront',
  'POST vendors/:vendorId/storefront/publish',
  'POST vendors/:vendorId/storefront/unpublish',
  'PUT vendors/:vendorId/applicable-categories',
  'POST vendors/:vendorId/sections',
  'PUT vendors/:vendorId/sections/:sectionId',
  'DELETE vendors/:vendorId/sections/:sectionId',
  'POST vendors/:vendorId/sections/reorder',
  'PUT vendors/:vendorId/sections/:sectionId/offers/:offerId',
  'DELETE vendors/:vendorId/sections/:sectionId/offers/:offerId',
  // Sprint 17: owner catalog editing.
  'PUT vendors/:vendorId/offers/:offerId',
  'POST vendors/:vendorId/offers/:offerId/archive',
  'POST vendors/:vendorId/offers/:offerId/restore',
  'PUT vendors/:vendorId/offers/:offerId/variants/:variantId',
  'PATCH vendors/:vendorId/offers/:offerId/variants/:variantId/media/:mediaId',
  'PUT vendors/:vendorId/offers/:offerId/variants/:variantId/media/reorder',
  // Sprint 18b: adding a branch is new operational footprint while
  // suspended - the same reasoning that already blocks new-offer-
  // creation. Hours/closures/staff stay ALLOW below - see that list's
  // own note.
  'POST vendors/:vendorId/branches',
];

export const SUSPENDED_ALLOW_ROUTES: readonly string[] = [
  // In-flight order fulfilment (L-23: "No visible disruption to an
  // in-flight order").
  'GET vendors/:vendorId/orders',
  'GET vendors/:vendorId/branches/:branchId/orders',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/start-preparation',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/mark-sent',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/mark-delivered',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/pickup-handover',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/rerequest-confirmation',
  // Sprint 20a: cancellation/refund/delivery-failure resolution on an
  // EXISTING order is still "in-flight order fulfilment" (L-23) -
  // resolving an order a suspended store already took is never new
  // footprint, the same reasoning as every other fulfilment action
  // above.
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/cancel',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/items/:itemId/cancel',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/mark-delivery-failed',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/approve-refund',
  // Sprint 20b: editing a note on an EXISTING order - same reasoning
  // as the fulfilment actions immediately above.
  'PATCH vendors/:vendorId/branches/:branchId/orders/:branchOrderId/internal-note',
  // Reads.
  'GET vendors/:vendorId',
  'GET vendors/:vendorId/branches',
  'GET vendors/:vendorId/branches/:branchId',
  'GET vendors/:vendorId/staff-invites',
  'GET vendors/:vendorId/warehouse',
  'GET vendors/:vendorId/pickup-points',
  'GET vendors/:vendorId/pickup-points/:pickupPointId',
  'GET vendors/:vendorId/delivery-zones',
  'GET vendors/:vendorId/branches/:branchId/delivery-windows',
  'GET vendors/:vendorId/branches/:branchId/stock',
  // Sprint 18a.
  'GET vendors/:vendorId/branches/:branchId/stock/page',
  'GET vendors/:vendorId/branches/:branchId/stock/lookup',
  'GET vendors/:vendorId/branches/:branchId/stock/:offerVariantId',
  'GET vendors/:vendorId/branches/:branchId/stock/:offerVariantId/movements',
  'GET vendors/:vendorId/offers',
  'GET vendors/:vendorId/offers/:offerId',
  'GET vendors/:vendorId/offers/:offerId/variants/:variantId/price-history',
  'GET vendors/:vendorId/offers/import/template',
  'GET vendors/:vendorId/offers/import/batches',
  'GET vendors/:vendorId/offers/:offerId/variants',
  'GET vendors/:vendorId/offers/:offerId/variants/:variantId/media',
  'GET vendors/:vendorId/offers/:offerId/variants/:variantId/match-review/candidates',
  'GET vendors/:vendorId/match-review/queue',
  'GET vendors/:vendorId/canonical-products/:canonicalProductId/name-change-requests',
  'GET vendors/:vendorId/sections',
  'GET vendors/:vendorId/storefront',
  'GET vendors/:vendorId/applicable-categories',
  'GET vendors/:vendorId/subscription',
  'GET vendors/:vendorId/verification-status',
  // Subscription: renewal never changes vendor.status; activation is
  // refused separately because it requires status APPROVED.
  'POST vendors/:vendorId/subscription',
  'POST vendors/:vendorId/subscription/renew',
  // Store configuration, staff and delivery setup (not catalog).
  'PUT vendors/:vendorId/store-type',
  'PUT vendors/:vendorId/warehouse',
  'PUT vendors/:vendorId/delivery-zones/:region',
  // Sprint 20b: minimum-order settings, same "store configuration, not
  // catalog" bucket as the delivery-zone fee/enabled endpoint above.
  'GET vendors/:vendorId/branches/:branchId/minimum-order',
  'PUT vendors/:vendorId/branches/:branchId/minimum-order',
  'GET vendors/:vendorId/delivery-zones/:region/minimum-order',
  'PUT vendors/:vendorId/delivery-zones/:region/minimum-order',
  'POST vendors/:vendorId/pickup-points',
  'POST vendors/:vendorId/branches/:branchId/staff-invites',
  'POST vendors/:vendorId/branches/:branchId/delivery-windows',
  'PUT vendors/:vendorId/branches/:branchId/delivery-windows/:windowId',
  'DELETE vendors/:vendorId/branches/:branchId/delivery-windows/:windowId',
  'POST vendors/:vendorId/branches/:branchId/delivery-windows/:windowId/exceptions',
  'DELETE vendors/:vendorId/branches/:branchId/delivery-windows/:windowId/exceptions/:exceptionId',
  // Verification (already refused by their own status rules while
  // SUSPENDED) and reviewer-only reads/decisions.
  'POST vendors/:vendorId/branches/:branchId/verification-evidence',
  'POST vendors/:vendorId/branches/:branchId/verification-decision',
  'GET vendors/:vendorId/branches/:branchId/verification-evidence',
  'POST vendors/:vendorId/warehouse/verification-evidence',
  'POST vendors/:vendorId/warehouse/verification-decision',
  'GET vendors/:vendorId/warehouse/verification-evidence',
  // Sprint 18b: hours/closures/staff management are operational
  // housekeeping on EXISTING resources (not new footprint, not
  // catalog) - the same ALLOW reasoning as store configuration/staff/
  // delivery setup above. Archiving a branch REDUCES footprint, not
  // expands it, so it's ALLOW too (unlike adding one, DENY above).
  'POST vendors/:vendorId/branches/:branchId/archive',
  'GET vendors/:vendorId/branches/:branchId/operating-hours',
  'PUT vendors/:vendorId/branches/:branchId/operating-hours',
  'GET vendors/:vendorId/branches/:branchId/closures',
  'POST vendors/:vendorId/branches/:branchId/closures',
  'GET vendors/:vendorId/staff',
  'POST vendors/:vendorId/staff/:vendorUserId/transfer',
  'POST vendors/:vendorId/staff/:vendorUserId/suspend',
  'POST vendors/:vendorId/staff/:vendorUserId/reactivate',
  // Sprint 21: return policy is store configuration (same bucket as
  // minimum-order settings above, not catalog). Deciding/redeeming a
  // return is resolving an EXISTING order's exception - same "in-
  // flight order fulfilment" bucket as cancel/approve-refund above,
  // never new footprint.
  'GET vendors/:vendorId/return-policy',
  'PUT vendors/:vendorId/return-policy',
  'GET vendors/:vendorId/branches/:branchId/returns',
  'PATCH vendors/:vendorId/branches/:branchId/returns/:returnId/decision',
  'POST vendors/:vendorId/returns/redeem',
];
