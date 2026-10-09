/**
 * Sprint 20b (FR-CART-015, review-round fix): a structured blocker for
 * "this branch's vendor simply does not deliver to the customer's
 * selected zone at all" - no VendorDeliveryZone row for that region,
 * or the zone exists but is disabled. Previously this was only
 * visible as `delivery_fee: null` / `minimum_order_value.delivery:
 * null` on the branch - an implicit signal a client would have to
 * already know to check, not a structured conflict entry like the
 * minimum-order blocker it sits alongside. Carries no zone/fee detail
 * - a customer is told THAT delivery isn't offered there, never WHY
 * (no row vs disabled vs zero fee), matching the minimum-information-
 * disclosure convention already established for `unavailable_items`.
 */
export interface DeliveryNotAvailableBlocker {
  code: 'DELIVERY_NOT_AVAILABLE_IN_ZONE';
  fulfilment_method: 'DELIVERY';
  message: string;
}

export function deliveryNotAvailableBlocker(): DeliveryNotAvailableBlocker {
  return {
    code: 'DELIVERY_NOT_AVAILABLE_IN_ZONE',
    fulfilment_method: 'DELIVERY',
    // Same code AND message as the real reserve()-time rejection
    // (checkout.service.ts's own reserveDeliverySlotAlreadyLocked) -
    // this is a preview of exactly that same check, not a new one.
    message: 'This vendor does not deliver to your zone',
  };
}
