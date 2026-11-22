import { BadRequestException } from '@nestjs/common';
import { priceKey, resolveUnifiedPrice } from './unified-price.util';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadRequestException) {
      return (e.getResponse() as { code: string }).code;
    }
    throw e;
  }
  return undefined;
}

describe('resolveUnifiedPrice', () => {
  it('a plain base price clears any sale price and discount', () => {
    expect(resolveUnifiedPrice({ base_price: 120 })).toEqual({
      basePrice: 120,
      salePrice: null,
      discountPercent: null,
      discountStartAt: null,
      discountEndAt: null,
    });
  });

  it('accepts a manual sale price below the base price', () => {
    expect(
      resolveUnifiedPrice({ base_price: 120, sale_price: 99 }).salePrice,
    ).toBe(99);
  });

  it('accepts a complete discount window', () => {
    const r = resolveUnifiedPrice({
      base_price: 100,
      discount_percent: 20,
      discount_start_at: '2026-11-01T00:00:00.000Z',
      discount_end_at: '2026-11-10T00:00:00.000Z',
    });
    expect(r.discountPercent).toBe(20);
    expect(r.salePrice).toBeNull();
  });

  it.each([
    [{ base_price: 0 }, 'INVALID_BASE_PRICE'],
    [{ base_price: 100, sale_price: 100 }, 'INVALID_SALE_PRICE'],
    [{ base_price: 100, sale_price: -1 }, 'INVALID_SALE_PRICE'],
    [{ base_price: 100, discount_percent: 10 }, 'INCOMPLETE_DISCOUNT_WINDOW'],
    [
      {
        base_price: 100,
        discount_percent: 100,
        discount_start_at: '2026-11-01',
        discount_end_at: '2026-11-02',
      },
      'DISCOUNT_PERCENT_OUT_OF_RANGE',
    ],
    [
      {
        base_price: 100,
        discount_percent: 10,
        discount_start_at: '2026-11-02',
        discount_end_at: '2026-11-01',
      },
      'INVALID_DISCOUNT_WINDOW',
    ],
    [
      {
        base_price: 100,
        sale_price: 50,
        discount_percent: 10,
        discount_start_at: '2026-11-01',
        discount_end_at: '2026-11-02',
      },
      'SALE_AND_DISCOUNT_EXCLUSIVE',
    ],
    [
      {
        base_price: 0.01,
        discount_percent: 99,
        discount_start_at: '2026-11-01',
        discount_end_at: '2026-11-02',
      },
      'DISCOUNT_RESULTS_IN_ZERO_PRICE',
    ],
  ])('rejects %j with %s', (input, code) => {
    expect(codeOf(() => resolveUnifiedPrice(input))).toBe(code);
  });
});

describe('priceKey', () => {
  it('treats the same price written as a number, a string or a Decimal-like value as equal', () => {
    const a = {
      basePrice: 100,
      salePrice: null,
      discountPercent: null,
      discountStartAt: null,
      discountEndAt: null,
    };
    const b = {
      basePrice: '100.00',
      salePrice: null,
      discountPercent: null,
      discountStartAt: null,
      discountEndAt: null,
    };
    expect(priceKey(a)).toBe(priceKey(b));
  });

  it('tells different prices apart', () => {
    const a = {
      basePrice: 100,
      salePrice: 80,
      discountPercent: null,
      discountStartAt: null,
      discountEndAt: null,
    };
    const b = {
      basePrice: 100,
      salePrice: 90,
      discountPercent: null,
      discountStartAt: null,
      discountEndAt: null,
    };
    expect(priceKey(a)).not.toBe(priceKey(b));
  });
});
