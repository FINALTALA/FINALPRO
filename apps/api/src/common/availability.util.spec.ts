import { bucketForStock } from './availability.util';

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
