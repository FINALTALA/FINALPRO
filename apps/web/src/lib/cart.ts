// Sprint 14: the cart's line state, as pure functions. The server sends
// per-line availability (`availability`, `max_quantity`, `purchasable`);
// this decides what the page shows and whether a line can go to checkout.
// It is presentation only - quote/reserve/confirm still enforce stock and
// eligibility on the server.

export interface CartLineState {
  id: string;
  quantity: number;
  availability: "available" | "low_stock" | "sold_out";
  max_quantity: number;
  purchasable: boolean;
}

export type LineState = "ok" | "unavailable" | "sold_out" | "exceeds_max";

export function lineState(line: CartLineState): LineState {
  if (!line.purchasable) return "unavailable";
  if (line.availability === "sold_out" || line.max_quantity <= 0) return "sold_out";
  if (line.quantity > line.max_quantity) return "exceeds_max";
  return "ok";
}

/** Only fully valid lines can be selected for checkout. */
export function canSelect(line: CartLineState): boolean {
  return lineState(line) === "ok";
}

export type CheckoutBlock = "NOTHING_SELECTED" | "SELECTION_NEEDS_ADJUSTMENT";

export function checkoutBlock(
  lines: CartLineState[],
  selectedIds: Set<string>,
): CheckoutBlock | null {
  const selected = lines.filter((l) => selectedIds.has(l.id));
  if (selected.length === 0) return "NOTHING_SELECTED";
  if (selected.some((l) => !canSelect(l))) return "SELECTION_NEEDS_ADJUSTMENT";
  return null;
}

export function lineMessage(line: CartLineState): string | null {
  switch (lineState(line)) {
    case "unavailable":
      return "لم يعد هذا المنتج متاحاً للشراء - احذفيه من السلة.";
    case "sold_out":
      return "نفدت الكمية - احذفي السطر أو عودي لاحقاً.";
    case "exceeds_max":
      return `الكمية المتاحة حالياً ${line.max_quantity} فقط - عدّلي الكمية للمتابعة.`;
    default:
      return line.availability === "low_stock"
        ? `كمية محدودة: المتاح ${line.max_quantity} فقط.`
        : null;
  }
}
