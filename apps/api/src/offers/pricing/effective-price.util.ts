import Decimal from 'decimal.js';

/**
 * Sprint 17 (blocker 1) + review-round fix: the SINGLE place that
 * decides what a variant's current price is - a pure function, no
 * Prisma, no `tx`, no side effect of any kind. Every consumer (cart,
 * checkout quote/reserve/confirm, comparison, the public storefront,
 * PriceHistory) calls this - or one of the other exports below for a
 * discount/sum computation - instead of doing its own Number/Math.round
 * arithmetic, so a GET request can never write to the database, an
 * expiring discount is never "activated" by whichever request happens
 * to observe it first, and every consumer rounds a price exactly the
 * same way.
 *
 * Every calculation here uses decimal.js, not native floating point.
 * `2.30 * (1 - 5/100)` in plain JS numbers can evaluate to
 * 2.1849999999999996 (base-2 floating point cannot represent 2.30 or
 * 0.95 exactly), which Math.round(...*100)/100 then rounds DOWN to
 * 2.18 - the wrong answer; the correct round-half-up result of exactly
 * 2.185 is 2.19. decimal.js does the multiplication in exact base-10
 * arithmetic, so this can never happen.
 *
 * Precedence, matching the plan exactly:
 *   1. An ACTIVE scheduled discount (discountStartAt <= now <
 *      discountEndAt - start inclusive, end exclusive) -
 *      basePrice x (1 - discountPercent/100), rounded.
 *   2. Otherwise a manual salePrice override, if set.
 *   3. Otherwise basePrice.
 *
 * salePrice and the scheduled-discount fields are mutually exclusive
 * by construction (DB CHECK + application code that clears one when
 * the other is set) - this function does not need to arbitrate a
 * conflict between them, only decide whether the discount window is
 * currently open.
 */

// basePrice/salePrice/discountPercent are `unknown` (not `number |
// string`) so a Prisma.Decimal - the runtime type every
// basePrice/salePrice/discountPercent column actually has - is
// accepted without every caller needing its own cast. Same convention
// this codebase already used for these exact columns before this
// sprint (e.g. checkout.service.ts's own pre-Sprint-17 effectivePrice()).
export interface PriceConfig {
  basePrice: unknown;
  salePrice: unknown;
  discountPercent: unknown;
  discountStartAt: Date | null;
  discountEndAt: Date | null;
}

/**
 * Converts a Prisma.Decimal / number / numeric string to a decimal.js
 * Decimal via its string form - safe regardless of which of those
 * three runtime shapes the caller actually holds (a Prisma.Decimal's
 * own toString() is exact; number/string both parse directly).
 */
export function toDecimal(value: unknown): Decimal {
  return new Decimal(String(value));
}

/**
 * Round-half-up to 2 decimal places - the one rounding rule used
 * everywhere a price is computed, so a customer is never charged a
 * value that differs by a cent from what was displayed.
 */
export function roundIls(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function isScheduledDiscountActive(
  cfg: Pick<
    PriceConfig,
    'discountPercent' | 'discountStartAt' | 'discountEndAt'
  >,
  now: Date,
): boolean {
  return (
    cfg.discountPercent !== null &&
    cfg.discountStartAt !== null &&
    cfg.discountEndAt !== null &&
    now >= cfg.discountStartAt &&
    now < cfg.discountEndAt
  );
}

/**
 * basePrice x (1 - discountPercent/100), rounded - the exact same
 * formula used both by the live effective-price computation below AND
 * by the create/update DISCOUNT_RESULTS_IN_ZERO_PRICE validation guard
 * (vendor-offers.controller.ts), so the two can never silently
 * disagree about what a given discount actually resolves to.
 */
export function computeDiscountedPrice(
  basePrice: unknown,
  discountPercent: unknown,
): Decimal {
  const base = toDecimal(basePrice);
  const pct = toDecimal(discountPercent);
  return roundIls(base.times(new Decimal(1).minus(pct.div(100))));
}

export function computeEffectivePrice(
  cfg: PriceConfig,
  now: Date = new Date(),
): number {
  if (isScheduledDiscountActive(cfg, now)) {
    return computeDiscountedPrice(cfg.basePrice, cfg.discountPercent).toNumber();
  }
  if (cfg.salePrice !== null) {
    return roundIls(toDecimal(cfg.salePrice)).toNumber();
  }
  return roundIls(toDecimal(cfg.basePrice)).toNumber();
}

/**
 * Whether the live effective price is currently below basePrice - the
 * one comparison used everywhere a "this offer is discounted" decision
 * is made (the storefront's automatic Discounts section, and the
 * public offer detail's sale_price field), done in exact decimal space
 * rather than comparing two already-rounded JS numbers.
 */
export function isEffectivelyDiscounted(
  cfg: PriceConfig,
  now: Date = new Date(),
): boolean {
  if (isScheduledDiscountActive(cfg, now)) {
    return computeDiscountedPrice(cfg.basePrice, cfg.discountPercent).lessThan(
      toDecimal(cfg.basePrice),
    );
  }
  if (cfg.salePrice !== null) {
    return roundIls(toDecimal(cfg.salePrice)).lessThan(toDecimal(cfg.basePrice));
  }
  return false;
}

/**
 * Decimal-precise sum of unit_price x quantity across many lines,
 * rounded once at the very end (never accumulating native-float
 * rounding error line by line) - checkout's own quote()/reserve()/
 * confirm() subtotal computations all go through this instead of each
 * running its own `items.reduce((sum, i) => sum + i.unit_price *
 * i.quantity, 0)`.
 */
export function sumLineAmounts(
  lines: { amount: unknown; quantity: number }[],
): number {
  return roundIls(
    lines.reduce<Decimal>(
      (sum, l) => sum.plus(toDecimal(l.amount).times(l.quantity)),
      new Decimal(0),
    ),
  ).toNumber();
}

/**
 * Decimal-precise addition of a small set of standalone money amounts
 * (e.g. a subtotal plus a delivery fee) - the same reasoning as
 * sumLineAmounts, for the non-line-item case.
 */
export function addMoney(...amounts: unknown[]): number {
  return roundIls(
    amounts.reduce<Decimal>(
      (sum, a) => sum.plus(toDecimal(a)),
      new Decimal(0),
    ),
  ).toNumber();
}
