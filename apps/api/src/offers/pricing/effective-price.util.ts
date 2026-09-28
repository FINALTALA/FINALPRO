/**
 * Sprint 17 (blocker 1): the SINGLE place that decides what a variant's
 * current price is - a pure function, no Prisma, no `tx`, no side
 * effect of any kind. Every consumer (cart, checkout, comparison, the
 * public storefront) calls this instead of reading `salePrice` /
 * `basePrice` itself, so a GET request can never write to the
 * database and an expiring discount is never "activated" by whichever
 * request happens to observe it first.
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
 * Round-half-up to 2 decimal places - the one rounding rule used
 * everywhere an effective price is computed, so a customer is never
 * charged a value that differs by a cent from what was displayed.
 */
export function roundIls(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function isScheduledDiscountActive(
  cfg: Pick<PriceConfig, 'discountPercent' | 'discountStartAt' | 'discountEndAt'>,
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

export function computeEffectivePrice(cfg: PriceConfig, now: Date = new Date()): number {
  const base = Number(cfg.basePrice);
  if (isScheduledDiscountActive(cfg, now)) {
    const pct = Number(cfg.discountPercent);
    return roundIls(base * (1 - pct / 100));
  }
  if (cfg.salePrice !== null) {
    return Number(cfg.salePrice);
  }
  return base;
}
