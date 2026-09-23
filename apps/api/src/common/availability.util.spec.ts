import { bucketForStock, totalAvailableStockLive } from './availability.util';

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

describe('totalAvailableStockLive', () => {
  it('subtracts the live-reserved figure per branch, then sums', () => {
    const liveReservedByKey = new Map([['branchA:variant1', 2]]);
    expect(
      totalAvailableStockLive(
        [
          { branchId: 'branchA', offerVariantId: 'variant1', quantity: 5 },
          { branchId: 'branchB', offerVariantId: 'variant1', quantity: 3 },
        ],
        liveReservedByKey,
      ),
    ).toBe(6);
  });

  it('clamps each branch at zero rather than going negative', () => {
    const liveReservedByKey = new Map([['branchA:variant1', 5]]);
    expect(
      totalAvailableStockLive(
        [{ branchId: 'branchA', offerVariantId: 'variant1', quantity: 2 }],
        liveReservedByKey,
      ),
    ).toBe(0);
  });

  it('the last unit fully reserved (live) reads as zero available', () => {
    const liveReservedByKey = new Map([['branchA:variant1', 1]]);
    expect(
      totalAvailableStockLive(
        [{ branchId: 'branchA', offerVariantId: 'variant1', quantity: 1 }],
        liveReservedByKey,
      ),
    ).toBe(0);
  });

  it('a key with no entry in the map (nothing live-reserved) counts as fully available', () => {
    expect(
      totalAvailableStockLive(
        [{ branchId: 'branchA', offerVariantId: 'variant1', quantity: 4 }],
        new Map(),
      ),
    ).toBe(4);
  });

  it('is zero for no branch stock rows at all', () => {
    expect(totalAvailableStockLive([], new Map())).toBe(0);
  });
});
