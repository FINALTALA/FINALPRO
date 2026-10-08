/**
 * Sprint 20b (FR-PRICE-006, FR-CART-003): the minimum-order-value
 * precedence rule, shared by quote() (per eligible branch, both
 * fulfilment methods previewed) and reserve()/the delivery-slot
 * helper (one definite fulfilment method per group). Checked against
 * the ITEMS-ONLY subtotal of a branch-group - never delivery fee,
 * never any future tax/fee (FR-PRICE-005 stays out of scope, OPEN-009).
 *
 * PICKUP always uses the branch's own default only - a delivery
 * region is not even meaningful for a pickup order. DELIVERY uses the
 * destination zone's own override when the owner has set one (null =
 * "no override, fall back to the branch default" - the same lazy-
 * default-null convention as VendorDeliveryZone.fee), else the branch
 * default. Both resolve to `null` ("no minimum") if neither is set.
 *
 * Every function here takes/returns an already-normalized
 * `number | null`, never a raw Prisma Decimal - normalize a raw
 * column value with normalizeMinimumOrderValue() ONCE at the read
 * site (every caller already does this exactly once; passing an
 * already-normalized value back through it would wrongly turn a real
 * `null` into `Number(null) === 0`).
 */
export function normalizeMinimumOrderValue(raw: unknown): number | null {
  return raw != null ? Number(raw) : null;
}

export function resolveDeliveryMinimumOrderValue(
  branchMinimumOrderValue: number | null,
  zoneMinimumOrderValue: number | null,
): number | null {
  return zoneMinimumOrderValue !== null
    ? zoneMinimumOrderValue
    : branchMinimumOrderValue;
}

export interface MinimumOrderBlocker {
  code: 'BELOW_MINIMUM_ORDER_VALUE';
  fulfilment_method: 'PICKUP' | 'DELIVERY';
  required: number;
  current: number;
  message: string;
}

export function minimumOrderBlocker(
  fulfilmentMethod: 'PICKUP' | 'DELIVERY',
  required: number,
  current: number,
): MinimumOrderBlocker {
  return {
    code: 'BELOW_MINIMUM_ORDER_VALUE',
    fulfilment_method: fulfilmentMethod,
    required,
    current,
    message: `This branch requires a minimum order of ${required} ILS for ${fulfilmentMethod === 'PICKUP' ? 'pickup' : 'delivery to this zone'} (currently ${current} ILS)`,
  };
}
