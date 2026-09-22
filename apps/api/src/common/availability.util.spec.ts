import { bucketForStock, totalAvailableStock } from './availability.util';

describe('availability.util', () => {
  it('is sold_out at zero or negative stock', () => {
    expect(bucketForStock(0)).toBe('sold_out');
    expect(bucketForStock(-1)).toBe('sold_out');
  });

  it('is low_stock for 1 through 3', () => {
    expect(bucketForStock(1)).toBe('low_stock');
    expect(bucketForStock(2)).toBe('low_stock');
    expect(bucketForStock(3)).toBe('low_stock');
  });

  it('is available for 4 and above', () => {
    expect(bucketForStock(4)).toBe('available');
    expect(bucketForStock(1000)).toBe('available');
  });
});

describe('totalAvailableStock', () => {
  it('subtracts reservedQuantity from quantity per branch, then sums', () => {
    expect(
      totalAvailableStock([
        { quantity: 5, reservedQuantity: 2 },
        { quantity: 3, reservedQuantity: 0 },
      ]),
    ).toBe(6);
  });

  it('clamps each branch at zero rather than going negative', () => {
    expect(totalAvailableStock([{ quantity: 2, reservedQuantity: 5 }])).toBe(0);
  });

  it('the last unit fully reserved reads as zero available', () => {
    expect(totalAvailableStock([{ quantity: 1, reservedQuantity: 1 }])).toBe(0);
  });

  it('is zero for no branch stock rows at all', () => {
    expect(totalAvailableStock([])).toBe(0);
  });
});
