import {
  bucketForStock,
  maxSingleBranchAvailable,
  totalAvailableStockLive,
} from './availability.util';

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

describe('maxSingleBranchAvailable', () => {
  const stock = (branchId: string, quantity: number) => ({
    branchId,
    offerVariantId: 'v',
    quantity,
  });

  it('is the largest single branch, never the sum across branches', () => {
    expect(
      maxSingleBranchAvailable([stock('a', 5), stock('b', 5)], new Map()),
    ).toBe(5);
    expect(
      maxSingleBranchAvailable([stock('a', 2), stock('b', 7)], new Map()),
    ).toBe(7);
  });

  it('subtracts only that branch own live reservations', () => {
    const live = new Map([
      ['a:v', 3],
      ['b:v', 5],
    ]);
    // a: 5-3=2, b: 5-5=0 -> best single branch is a with 2
    expect(maxSingleBranchAvailable([stock('a', 5), stock('b', 5)], live)).toBe(
      2,
    );
  });

  it('is 0 when there is no stock row or every branch is fully held', () => {
    expect(maxSingleBranchAvailable([], new Map())).toBe(0);
    expect(
      maxSingleBranchAvailable([stock('a', 2)], new Map([['a:v', 9]])),
    ).toBe(0);
  });
});
