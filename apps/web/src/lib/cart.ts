// Sprint 14: the cart's line state, as pure functions. The server sends
// per-line availability (`availability`, `max_quantity`, `purchasable`,
// TB-1's `purchase_limit`); `max_quantity` is null unless the line asks
// for more than it can get (then it is at most the purchase limit);
// this decides what the page shows and whether a line can go to checkout.
// It is presentation only - quote/reserve/confirm still enforce stock and
// eligibility on the server.

export interface CartLineState {
  id: string;
  quantity: number;
  availability: "available" | "low_stock" | "sold_out";
  /** Only set when the line asks for more than it can get (≤ purchase_limit). */
  max_quantity: number | null;
  /** The public most-of-one-item-per-order (TB-1). */
  purchase_limit: number;
  purchasable: boolean;
}

export type LineState = "ok" | "unavailable" | "sold_out" | "exceeds_max";

export function lineState(line: CartLineState): LineState {
  if (!line.purchasable) return "unavailable";
  if (line.availability === "sold_out") return "sold_out";
  if (line.max_quantity !== null || line.quantity > line.purchase_limit) return "exceeds_max";
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

export function lineMessage(line: CartLineState, lang: "ar" | "en" = "ar"): string | null {
  const en = lang === "en"; // TB-25: English beside the unchanged Arabic.
  switch (lineState(line)) {
    case "unavailable":
      return en ? "This product is no longer available to buy - remove it from your cart." : "لم يعد هذا المنتج متاحاً للشراء - احذفيه من السلة.";
    case "sold_out":
      return en ? "Sold out - remove the line or come back later." : "نفدت الكمية - احذفي السطر أو عودي لاحقاً.";
    case "exceeds_max":
      // Over the public limit with enough stock: say the limit, not stock.
      if (line.quantity > line.purchase_limit && (line.max_quantity ?? line.purchase_limit) >= line.purchase_limit) {
        return en
          ? `At most ${line.purchase_limit} pieces of the same product per order - lower the quantity to continue.`
          : `الحد الأقصى ${line.purchase_limit} قطع من المنتج نفسه في الطلب - خفّضي الكمية للمتابعة.`;
      }
      return en
        ? `Only ${line.max_quantity} available right now - change the quantity to continue.`
        : `الكمية المتاحة حالياً ${line.max_quantity} فقط - عدّلي الكمية للمتابعة.`;
    default:
      return line.availability === "low_stock" ? (en ? "Limited stock." : "كمية محدودة.") : null;
  }
}

/**
 * TB-1: the cart/checkout stock and limit refusals in plain Arabic -
 * the public per-item limit at most, never a branch's quantity.
 */
export function cartQuantityErrorMessage(code: string, details: unknown[] = [], lang: "ar" | "en" = "ar"): string | null {
  const en = lang === "en";
  if (code === "CART_LINE_LIMIT_EXCEEDED") {
    const limit = (details[0] as { limit?: unknown } | undefined)?.limit;
    if (en) return typeof limit === "number" ? `At most ${limit} pieces of the same product per order.` : "You've passed the limit for the same product in one order.";
    return typeof limit === "number"
      ? `الحد الأقصى ${limit} قطع من المنتج نفسه في الطلب.`
      : "تجاوزتِ الحد الأقصى للمنتج نفسه في الطلب.";
  }
  if (code === "INSUFFICIENT_STOCK") {
    return en
      ? "The quantity you asked for isn't available at this branch - change the quantity or choose another branch."
      : "الكمية المطلوبة غير متاحة في هذا الفرع - عدّلي الكمية أو اختاري فرعاً آخر.";
  }
  return null;
}

/**
 * TB-5: the checkout-hold messages - one live hold per account, at most
 * `limit` items per order - in the shopper's language. Never a stock
 * figure or anything about anyone else's holds.
 */
export function reservationMessage(code: string, details: unknown[], lang: "ar" | "en"): string | null {
  const en = lang === "en";
  if (code === "RESERVATION_UNITS_LIMIT_EXCEEDED") {
    const limit = (details[0] as { limit?: unknown } | undefined)?.limit;
    return unitsLimitMessage(typeof limit === "number" ? limit : null, lang);
  }
  if (code === "RESERVATION_NOT_FOUND") {
    // TB-8: "you started another checkout" only when the server says
    // this hold really was replaced by a newer one of this account.
    const replaced = details.some((d) => (d as { reason?: unknown } | null)?.reason === "REPLACED");
    if (replaced) {
      return en
        ? "This checkout hold no longer exists because you started another checkout. Please start again."
        : "هذا الحجز لم يعد قائماً لأنك بدأتِ إتمام طلب آخر - ابدئي من جديد.";
    }
    return en ? "This checkout hold no longer exists. Please start again." : "هذا الحجز لم يعد قائماً - ابدئي من جديد.";
  }
  if (code === "RESERVE_RATE_LIMITED") {
    return en
      ? "Too many checkout attempts - please wait a minute and try again."
      : "محاولات كثيرة لإتمام الطلب - انتظري دقيقة ثم حاولي مجدداً.";
  }
  return null;
}

/** TB-8: the one "your hold ran out" message - RESERVATION_EXPIRED, or a hold the expiry sweep already removed. */
export function expiredReservationMessage(lang: "ar" | "en"): string {
  return lang === "en" ? "This checkout hold has expired. Please start again." : "انتهت مدة الحجز. ابدئي الطلب من جديد.";
}

export function unitsLimitMessage(limit: number | null, lang: "ar" | "en"): string {
  if (lang === "en") {
    return limit === null ? "Too many items in one order - please reduce the quantity." : `At most ${limit} items per order - please reduce the quantity.`;
  }
  return limit === null ? "عدد القطع في الطلب أكبر من المسموح - خفّضي الكمية." : `الحد الأقصى ${limit} قطعة في الطلب الواحد - خفّضي الكمية.`;
}

export function replacedReservationNotice(lang: "ar" | "en"): string {
  return lang === "en"
    ? "Your previous checkout hold was released and replaced by this one."
    : "ألغينا حجزك السابق وبدأنا هذا الحجز.";
}
