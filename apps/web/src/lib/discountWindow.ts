// Phase A++ (item 7): the product discount on the web - the system's two
// existing modes only (the API's resolveUnifiedPrice decides): a sale price,
// immediate and without dates; or a percentage for a window with a start
// and an end. Dates are typed in the browser's local time (a
// datetime-local field) and sent as ISO/UTC with `new Date(local)
// .toISOString()` - exactly what the existing discount screen does.

export type DraftDiscount =
  | { mode: "sale"; sale_price: number | null }
  | { mode: "window"; percent: number | null; start_at: string | null; end_at: string | null };

/** ISO (UTC) -> the value of a datetime-local field, in the browser's own time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value -> ISO (UTC), as the existing discount screen sends it. */
export function fromLocalInput(local: string): string {
  return new Date(local).toISOString();
}

/** The discount as PUT .../price takes it (and the draft's own fields). */
export function discountFields(d: DraftDiscount | null | undefined): {
  sale_price: number | null;
  discount_percent: number | null;
  discount_start_at: string | null;
  discount_end_at: string | null;
} {
  if (!d) return { sale_price: null, discount_percent: null, discount_start_at: null, discount_end_at: null };
  return d.mode === "sale"
    ? { sale_price: d.sale_price, discount_percent: null, discount_start_at: null, discount_end_at: null }
    : { sale_price: null, discount_percent: d.percent, discount_start_at: d.start_at || null, discount_end_at: d.end_at || null };
}

/**
 * The page's own early check (the server's publish check decides): the same
 * codes resolveUnifiedPrice uses, so the list words them the same.
 */
export function discountProblem(price: number | null | undefined, d: DraftDiscount | null | undefined): string | null {
  if (!price || !d) return null;
  if (d.mode === "sale") return d.sale_price !== null && d.sale_price > 0 && d.sale_price < price ? null : "INVALID_SALE_PRICE";
  if (d.percent === null || !d.start_at || !d.end_at) return "INCOMPLETE_DISCOUNT_WINDOW";
  if (!(d.percent > 0 && d.percent < 100)) return "DISCOUNT_PERCENT_OUT_OF_RANGE";
  const start = new Date(d.start_at).getTime();
  const end = new Date(d.end_at).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || !(start < end)) return "INVALID_DISCOUNT_WINDOW";
  return null;
}

/** For display only (the server computes the real effective price): the price after a percentage. */
export function priceAfterPercent(price: number, percent: number): number {
  return Math.round(price * (100 - percent)) / 100;
}
