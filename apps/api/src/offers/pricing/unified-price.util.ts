import { BadRequestException } from '@nestjs/common';
import { computeDiscountedPrice } from './effective-price.util';

// Sprint 27 (product taxonomy): the ONE price configuration every variant
// of a classified offer shares. It is always a full replacement - base
// price plus at most one of a manual sale price or a scheduled discount
// window - validated with the same rules and error codes the per-variant
// path (VendorOffersController.resolveDiscountFields / updateVariant) has
// always used, so an owner sees identical messages either way.

export interface UnifiedPriceInput {
  base_price: number;
  sale_price?: number | null;
  discount_percent?: number | null;
  discount_start_at?: string | null;
  discount_end_at?: string | null;
}

export interface UnifiedPrice {
  basePrice: number;
  salePrice: number | null;
  discountPercent: number | null;
  discountStartAt: Date | null;
  discountEndAt: Date | null;
}

export function resolveUnifiedPrice(input: UnifiedPriceInput): UnifiedPrice {
  if (!(input.base_price > 0)) {
    throw new BadRequestException({
      code: 'INVALID_BASE_PRICE',
      message: 'base_price must be greater than 0',
    });
  }
  const hasDiscount =
    input.discount_percent != null ||
    input.discount_start_at != null ||
    input.discount_end_at != null;
  const hasSale = input.sale_price != null;
  if (hasDiscount && hasSale) {
    throw new BadRequestException({
      code: 'SALE_AND_DISCOUNT_EXCLUSIVE',
      message:
        'Send either sale_price or a discount window (discount_percent/start/end), not both',
    });
  }
  if (hasDiscount) {
    const pct = input.discount_percent;
    const start = input.discount_start_at;
    const end = input.discount_end_at;
    if (pct == null || !start || !end) {
      throw new BadRequestException({
        code: 'INCOMPLETE_DISCOUNT_WINDOW',
        message:
          'discount_percent, discount_start_at and discount_end_at must all be provided together',
      });
    }
    if (!(pct > 0 && pct < 100)) {
      throw new BadRequestException({
        code: 'DISCOUNT_PERCENT_OUT_OF_RANGE',
        message: 'discount_percent must be greater than 0 and less than 100',
      });
    }
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (
      Number.isNaN(startDate.getTime()) ||
      Number.isNaN(endDate.getTime()) ||
      !(startDate < endDate)
    ) {
      throw new BadRequestException({
        code: 'INVALID_DISCOUNT_WINDOW',
        message: 'discount_start_at must be before discount_end_at',
      });
    }
    if (computeDiscountedPrice(input.base_price, pct).lessThanOrEqualTo(0)) {
      throw new BadRequestException({
        code: 'DISCOUNT_RESULTS_IN_ZERO_PRICE',
        message: 'This discount would round the price to zero or less',
      });
    }
    return {
      basePrice: input.base_price,
      salePrice: null,
      discountPercent: pct,
      discountStartAt: startDate,
      discountEndAt: endDate,
    };
  }
  if (hasSale) {
    const sale = input.sale_price as number;
    if (!(sale > 0 && sale < input.base_price)) {
      throw new BadRequestException({
        code: 'INVALID_SALE_PRICE',
        message: 'sale_price must be positive and less than base_price',
      });
    }
    return {
      basePrice: input.base_price,
      salePrice: sale,
      discountPercent: null,
      discountStartAt: null,
      discountEndAt: null,
    };
  }
  return {
    basePrice: input.base_price,
    salePrice: null,
    discountPercent: null,
    discountStartAt: null,
    discountEndAt: null,
  };
}

/** A stable key for "do these variants carry the same price?". */
export function priceKey(v: {
  basePrice: unknown;
  salePrice: unknown;
  discountPercent: unknown;
  discountStartAt: Date | null;
  discountEndAt: Date | null;
}): string {
  const num = (x: unknown) => (x == null ? '' : Number(String(x)).toFixed(2));
  return [
    num(v.basePrice),
    num(v.salePrice),
    num(v.discountPercent),
    v.discountStartAt?.toISOString() ?? '',
    v.discountEndAt?.toISOString() ?? '',
  ].join('|');
}
