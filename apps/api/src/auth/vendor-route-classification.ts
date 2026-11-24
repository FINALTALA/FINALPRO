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
  // Product-entry wizard: drafting and creating products is catalogue editing.
  'POST vendors/:vendorId/offer-drafts',
  'PATCH vendors/:vendorId/offer-drafts/:draftId',
  'DELETE vendors/:vendorId/offer-drafts/:draftId',
  'POST vendors/:vendorId/offer-drafts/:draftId/submit',
  // Phase A+: publishing from the wizard and the product's own measurements.
  'POST vendors/:vendorId/offer-drafts/:draftId/publish',
  // Phase A++: copying one branch's draft quantities to another (catalogue editing).
  'POST vendors/:vendorId/offer-drafts/:draftId/copy-stock',
  // Edit drafts of published products (catalogue editing).
  'POST vendors/:vendorId/offer-drafts/edit-of/:offerId',
  'POST vendors/:vendorId/offer-drafts/:draftId/apply',
  'POST vendors/:vendorId/offer-drafts/:draftId/rebase',
  'PUT vendors/:vendorId/offers/:offerId/measurements',
  // PD-4: catalog configuration - blocked for a suspended store.
  'PUT vendors/:vendorId/offers/:offerId/size-guide',
  'POST vendors/:vendorId/offers/:offerId/size-guide-requests',
  // PD-5.1: product decision - a suspended store can't change its
  // delivery preparation time (unlike the rest of delivery setup).
  'PUT vendors/:vendorId/branches/:branchId/delivery-lead-time',
  // PD-5.4: «نسّقي معه» is catalogue merchandising.
  'PUT vendors/:vendorId/offers/:offerId/pairings',
  'PATCH vendors/:vendorId/offers/:offerId/status',
  'POST vendors/:vendorId/offers/:offerId/variants',
  'POST vendors/:vendorId/offers/:offerId/variants/:variantId/match-confirmation',
  'POST vendors/:vendorId/offers/:offerId/variants/:variantId/media',
  // Sprint 27: product taxonomy writes are catalogue editing.
  'PUT vendors/:vendorId/offers/:offerId/classification',
  'PUT vendors/:vendorId/offers/:offerId/price',
  // Phase A++: the product's model information and shared images (catalogue editing).
  'PUT vendors/:vendorId/offers/:offerId/model',
  'PUT vendors/:vendorId/offers/:offerId/shared-images',
  'POST vendors/:vendorId/offers/:offerId/combinations',
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
  'PUT vendors/:vendorId/storefront/catalogue',
  // The store's home page (2026-11-20): editing it is storefront editing.
  'PUT vendors/:vendorId/storefront/home/draft',
  'POST vendors/:vendorId/storefront/home/publish',
  'POST vendors/:vendorId/storefront/home/discard',
  'POST vendors/:vendorId/sections',
  'PUT vendors/:vendorId/sections/:sectionId',
  'DELETE vendors/:vendorId/sections/:sectionId',
  'POST vendors/:vendorId/sections/reorder',
  'PUT vendors/:vendorId/sections/:sectionId/offers/:offerId',
  'DELETE vendors/:vendorId/sections/:sectionId/offers/:offerId',
  // «مجموعات المتجر» (2026-11-18): editing collections is storefront editing.
  'PATCH vendors/:vendorId/sections/:sectionId',
  'POST vendors/:vendorId/sections/:sectionId/offers',
  'POST vendors/:vendorId/sections/:sectionId/offers/remove',
  'POST vendors/:vendorId/sections/:sectionId/offers/move',
  'PUT vendors/:vendorId/offers/:offerId/sections',
  // The product import (2026-11-18): checking and confirming create catalogue drafts.
  'POST vendors/:vendorId/product-import/check',
  'POST vendors/:vendorId/product-import/:batchId/confirm',
  'PUT vendors/:vendorId/product-import/:batchId/products/:ref/barcode',
  'POST vendors/:vendorId/product-import/:batchId/barcodes/generate',
  // Bulk publishing (2026-11-18): starting a run publishes products.
  'POST vendors/:vendorId/bulk-publish',
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
  // Sprint 26: an image upload only ever feeds the store logo/cover or
  // a product photo - both already DENY above (storefront, media) - so
  // a suspended store cannot stage new images either.
  'POST vendors/:vendorId/uploads',
  // Barcodes and in-store sales (2026-11-20): a product's barcodes are
  // catalogue editing; an in-store sale and its void are stock movements
  // (same bucket as POST .../stock/:offerVariantId/movements above).
  'POST vendors/:vendorId/offers/:offerId/barcodes',
  'POST vendors/:vendorId/offers/:offerId/barcodes/generate',
  'POST vendors/:vendorId/barcodes/reserve',
  'POST vendors/:vendorId/offer-drafts/store-barcodes/generate',
  'PUT vendors/:vendorId/offer-drafts/:draftId/store-barcode',
  'PATCH vendors/:vendorId/offers/:offerId/barcodes/:barcodeId/primary',
  'DELETE vendors/:vendorId/offers/:offerId/barcodes/:barcodeId',
  'POST vendors/:vendorId/branches/:branchId/store-sales',
  'POST vendors/:vendorId/store-sales/:saleId/void',
];

export const SUSPENDED_ALLOW_ROUTES: readonly string[] = [
  // In-flight order fulfilment (L-23: "No visible disruption to an
  // in-flight order").
  'GET vendors/:vendorId/orders',
  'GET vendors/:vendorId/branches/:branchId/orders',
  // 2026-11-22: the branch's order queue, one order and its timeline (reads).
  'GET vendors/:vendorId/branches/:branchId/order-queue',
  // the owner's queue of every branch («كل الفروع»)
  'GET vendors/:vendorId/order-queue',
  'GET vendors/:vendorId/branches/:branchId/order-queue/:branchOrderId',
  'GET vendors/:vendorId/branches/:branchId/order-queue/:branchOrderId/timeline',
  // 2026-11-24: the internal prep sheet of one order (read).
  'GET vendors/:vendorId/branches/:branchId/order-queue/:branchOrderId/prep-sheet',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/start-preparation',
  // 2026-11-24 (XII phase 2): the prep checklist and «جاهز» of an in-flight order
  'PATCH vendors/:vendorId/branches/:branchId/orders/:branchOrderId/prep-checklist/:item',
  'POST vendors/:vendorId/branches/:branchId/orders/:branchOrderId/mark-ready',
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
  // «نوافذ التوصيل v1»: the 7-day board (owner + that branch's employee).
  'GET vendors/:vendorId/branches/:branchId/delivery-windows/board',
  // PD-5.1.
  'GET vendors/:vendorId/branches/:branchId/delivery-lead-time',
  // PD-5.3: the owner's own sales in the ranking window (read only).
  'GET vendors/:vendorId/sales-rank',
  // Product-entry wizard: reading drafts and brand requests stays open.
  'GET vendors/:vendorId/offer-drafts',
  'GET vendors/:vendorId/offer-drafts/:draftId',
  'GET vendors/:vendorId/brand-requests',
  'GET vendors/:vendorId/unpublished-products',
  // Phase A+: read-only publish checks and the product's own measurements.
  'GET vendors/:vendorId/offer-drafts/:draftId/publish-check',
  // Phase A++: the shopper-view preview of a draft (a read).
  'GET vendors/:vendorId/offer-drafts/:draftId/preview',
  'GET vendors/:vendorId/offer-drafts/:draftId/review',
  'GET vendors/:vendorId/offers/:offerId/publish-check',
  'GET vendors/:vendorId/offers/:offerId/measurements',
  // TB-26: the store workspace's own notifications - reading and marking
  // read stay available to a suspended store.
  'GET vendors/:vendorId/notifications',
  'GET vendors/:vendorId/notifications/unread-count',
  'POST vendors/:vendorId/notifications/:id/read',
  // PD-5.4 (read only).
  'GET vendors/:vendorId/offers/:offerId/pairings',
  'GET vendors/:vendorId/branches/:branchId/stock',
  // Sprint 18a.
  'GET vendors/:vendorId/branches/:branchId/stock/page',
  // 2026-11-22: the stock board, one line and its log (reads).
  'GET vendors/:vendorId/branches/:branchId/stock/board',
  'GET vendors/:vendorId/branches/:branchId/stock/:offerVariantId/detail',
  'GET vendors/:vendorId/branches/:branchId/stock/:offerVariantId/ledger',
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
  // Sprint 27: product taxonomy reads.
  'GET vendors/:vendorId/offers/:offerId/classification',
  // Phase A++: reads.
  'GET vendors/:vendorId/offers/:offerId/presentation',
  'GET vendors/:vendorId/offers/:offerId/combinations',
  'GET vendors/:vendorId/offers/:offerId/variants/:variantId/match-review/candidates',
  'GET vendors/:vendorId/match-review/queue',
  'GET vendors/:vendorId/canonical-products/:canonicalProductId/name-change-requests',
  'GET vendors/:vendorId/sections',
  // «مجموعات المتجر»: reads.
  'GET vendors/:vendorId/sections/:sectionId',
  'GET vendors/:vendorId/sections/:sectionId/candidates',
  'GET vendors/:vendorId/offers/:offerId/sections',
  // Store notifications: where a version lives (a read).
  'GET vendors/:vendorId/offer-variants/:variantId/locate',
  // The product import: the template and the recent imports (reads).
  'GET vendors/:vendorId/product-import/template',
  'GET vendors/:vendorId/product-import/batches',
  // Images in bulk: one import's drafts, and a staged image's thumbnail while its check is valid (reads).
  'GET vendors/:vendorId/product-import/:batchId',
  'GET vendors/:vendorId/product-import/:batchId/thumbnails/:ref',
  // Bulk publishing: the preflight writes nothing; a run's progress (reads).
  'POST vendors/:vendorId/bulk-publish/preflight',
  'GET vendors/:vendorId/bulk-publish/current',
  'GET vendors/:vendorId/bulk-publish/:runId',
  'GET vendors/:vendorId/storefront',
  'GET vendors/:vendorId/applicable-categories',
  'GET vendors/:vendorId/storefront/catalogue',
  // The store's home page (2026-11-20): the designer and its product picker (reads).
  'GET vendors/:vendorId/storefront/home',
  'GET vendors/:vendorId/storefront/home/products',
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
  // «نوافذ التوصيل v1»: pause / resume, stop new bookings, close a day.
  'POST vendors/:vendorId/branches/:branchId/delivery-windows/:windowId/pause',
  'POST vendors/:vendorId/branches/:branchId/delivery-windows/:windowId/resume',
  'POST vendors/:vendorId/branches/:branchId/delivery-windows/:windowId/stop-booking',
  'POST vendors/:vendorId/branches/:branchId/delivery-windows/:windowId/reopen',
  'POST vendors/:vendorId/branches/:branchId/delivery-windows/days/:date/stop-booking',
  'POST vendors/:vendorId/branches/:branchId/delivery-windows/days/:date/close',
  'POST vendors/:vendorId/branches/:branchId/delivery-windows/days/:date/reopen',
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
  // «ساعات العمل والإغلاقات v1»: cancel / shorten a closure
  'POST vendors/:vendorId/branches/:branchId/closures/:closureId/cancel',
  'POST vendors/:vendorId/branches/:branchId/closures/:closureId/shorten',
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
  // IX-P2 (2026-11-23): the returns board (reads) and the code preview
  // before redeem (a read that writes nothing) - same bucket as the above.
  'GET vendors/:vendorId/branches/:branchId/return-queue',
  'GET vendors/:vendorId/branches/:branchId/return-queue/:returnId',
  'GET vendors/:vendorId/branches/:branchId/return-queue/:returnId/timeline',
  'GET vendors/:vendorId/return-queue',
  'POST vendors/:vendorId/returns/lookup',
  // Sprint 23: a public, unguarded read (ReviewReadsController) - "every
  // read" stays ALLOW, same bucket as every other GET above. A
  // suspended store's past reviews must stay visible either way.
  'GET vendors/:vendorId/reviews',
  // Sprint 25: the vendor's own performance dashboard - a read, same
  // bucket as every other GET above. Feature-flag-gated separately
  // (FEATURE_DISABLED), unrelated to suspension.
  'GET vendors/:vendorId/performance',
  // PD-3: the owner's read-only list of reviews of what the store sold
  // - a read, same bucket as every other GET above.
  'GET vendors/:vendorId/product-reviews',
  // PD-4: reads of an offer's size guide and the store's guide requests.
  'GET vendors/:vendorId/offers/:offerId/size-guide',
  'GET vendors/:vendorId/size-guide-requests',
  // Barcodes and in-store sales (2026-11-20): reads.
  'GET vendors/:vendorId/offers/:offerId/barcodes',
  'GET vendors/:vendorId/barcode-labels',
  'GET vendors/:vendorId/cashier',
  'GET vendors/:vendorId/branches/:branchId/cashier/lookup',
  'GET vendors/:vendorId/store-sales',
  'GET vendors/:vendorId/store-sales/:saleId',
];
