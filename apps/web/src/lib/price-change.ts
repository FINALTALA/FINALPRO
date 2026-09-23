// Sprint 14: reads the structured diff CHECKOUT_PRICE_CHANGED now carries
// in `details` (see CheckoutService.confirm) so the customer sees exactly
// what changed instead of a raw error string.

export interface PriceChange {
  offerVariantId: string;
  oldPrice: number;
  newPrice: number;
}

export interface FeeChange {
  deliveryWindowId: string;
  oldFee: number;
  newFee: number | null;
}

export interface PriceChangeSummary {
  prices: PriceChange[];
  fees: FeeChange[];
}

export function parsePriceChange(details: unknown[]): PriceChangeSummary {
  const prices: PriceChange[] = [];
  const fees: FeeChange[] = [];
  for (const d of details) {
    if (typeof d !== "object" || d === null) continue;
    const row = d as Record<string, unknown>;
    if (
      row.type === "price_change" &&
      typeof row.offer_variant_id === "string" &&
      typeof row.old_price === "number" &&
      typeof row.new_price === "number"
    ) {
      prices.push({
        offerVariantId: row.offer_variant_id,
        oldPrice: row.old_price,
        newPrice: row.new_price,
      });
    } else if (
      row.type === "delivery_fee_change" &&
      typeof row.delivery_window_id === "string" &&
      typeof row.old_fee === "number"
    ) {
      fees.push({
        deliveryWindowId: row.delivery_window_id,
        oldFee: row.old_fee,
        newFee: typeof row.new_fee === "number" ? row.new_fee : null,
      });
    }
  }
  return { prices, fees };
}

export function hasChanges(summary: PriceChangeSummary): boolean {
  return summary.prices.length > 0 || summary.fees.length > 0;
}

/** "+15 ₪" / "-5 ₪" for showing the direction of a change. */
export function formatDelta(oldValue: number, newValue: number): string {
  const delta = Math.round((newValue - oldValue) * 100) / 100;
  return `${delta > 0 ? "+" : ""}${delta} ₪`;
}
