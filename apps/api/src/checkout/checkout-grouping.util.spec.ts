import {
  BranchAvailability,
  GroupingItem,
  groupByVendorAndBranch,
} from './checkout-grouping.util';

function avail(
  branchId: string,
  availableQuantity: number,
  createdAt = new Date('2026-01-01'),
): BranchAvailability {
  return { branchId, availableQuantity, createdAt };
}

describe('checkout-grouping.util', () => {
  it('forms one unfragmented group when a single branch covers every item of a vendor', () => {
    const items: GroupingItem[] = [
      { cartItemId: 'ci1', vendorId: 'v1', offerVariantId: 'ov1', quantity: 2 },
      { cartItemId: 'ci2', vendorId: 'v1', offerVariantId: 'ov2', quantity: 1 },
    ];
    const availability = new Map([
      ['ov1', [avail('bA', 5), avail('bB', 1)]],
      ['ov2', [avail('bA', 3)]],
    ]);
    const { groups, unavailableItems } = groupByVendorAndBranch(
      items,
      availability,
    );
    expect(unavailableItems).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].fragmented).toBe(false);
    expect(groups[0].cartItemIds.sort()).toEqual(['ci1', 'ci2']);
    // bA covers both, bB only covers ov1 (and not enough for ov2 at all) - only bA is eligible.
    expect(groups[0].eligibleBranchIds).toEqual(['bA']);
  });

  it('lists every branch that individually covers 100% of a vendor selection, suggested first by createdAt', () => {
    const items: GroupingItem[] = [
      { cartItemId: 'ci1', vendorId: 'v1', offerVariantId: 'ov1', quantity: 1 },
    ];
    const availability = new Map([
      [
        'ov1',
        [
          avail('newer', 5, new Date('2026-02-01')),
          avail('older', 5, new Date('2026-01-01')),
        ],
      ],
    ]);
    const { groups } = groupByVendorAndBranch(items, availability);
    expect(groups[0].eligibleBranchIds).toEqual(['older', 'newer']);
  });

  it('splits into fragmented per-branch groups when no single branch covers everything, auto-assigning by highest available quantity', () => {
    const items: GroupingItem[] = [
      { cartItemId: 'ci1', vendorId: 'v1', offerVariantId: 'ov1', quantity: 5 },
      { cartItemId: 'ci2', vendorId: 'v1', offerVariantId: 'ov2', quantity: 5 },
    ];
    // No branch has both at sufficient quantity - bA only covers ov1, bB only covers ov2.
    const availability = new Map([
      ['ov1', [avail('bA', 10), avail('bB', 2)]],
      ['ov2', [avail('bA', 2), avail('bB', 10)]],
    ]);
    const { groups, unavailableItems } = groupByVendorAndBranch(
      items,
      availability,
    );
    expect(unavailableItems).toEqual([]);
    expect(groups).toHaveLength(2);
    const byBranch = new Map(groups.map((g) => [g.eligibleBranchIds[0], g]));
    expect(byBranch.get('bA')!.cartItemIds).toEqual(['ci1']);
    expect(byBranch.get('bA')!.fragmented).toBe(true);
    expect(byBranch.get('bB')!.cartItemIds).toEqual(['ci2']);
    expect(byBranch.get('bB')!.fragmented).toBe(true);
  });

  it('surfaces an item as unavailable (never silently dropped) when no branch has enough stock anywhere', () => {
    const items: GroupingItem[] = [
      {
        cartItemId: 'ci1',
        vendorId: 'v1',
        offerVariantId: 'ov1',
        quantity: 100,
      },
      { cartItemId: 'ci2', vendorId: 'v1', offerVariantId: 'ov2', quantity: 1 },
    ];
    const availability = new Map([
      ['ov1', [avail('bA', 2)]],
      ['ov2', [avail('bA', 5)]],
    ]);
    const { groups, unavailableItems } = groupByVendorAndBranch(
      items,
      availability,
    );
    expect(unavailableItems).toEqual([
      { cartItemId: 'ci1', reason: 'NO_BRANCH_HAS_SUFFICIENT_STOCK' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].cartItemIds).toEqual(['ci2']);
  });

  it('keeps different vendors in entirely separate groups (PDR-004: one BranchOrder is always one vendor)', () => {
    const items: GroupingItem[] = [
      { cartItemId: 'ci1', vendorId: 'v1', offerVariantId: 'ov1', quantity: 1 },
      { cartItemId: 'ci2', vendorId: 'v2', offerVariantId: 'ov2', quantity: 1 },
    ];
    const availability = new Map([
      ['ov1', [avail('bA', 5)]],
      ['ov2', [avail('bC', 5)]],
    ]);
    const { groups } = groupByVendorAndBranch(items, availability);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.vendorId))).toEqual(
      new Set(['v1', 'v2']),
    );
  });

  it('fragmented tie-break: when two branches have EQUAL available quantity for an item, picks the earlier-created branch', () => {
    const items: GroupingItem[] = [
      { cartItemId: 'ci1', vendorId: 'v1', offerVariantId: 'ov1', quantity: 5 },
      { cartItemId: 'ci2', vendorId: 'v1', offerVariantId: 'ov2', quantity: 5 },
    ];
    // No branch covers both ov1 and ov2 at all, forcing fragmentation.
    // ov1 itself has a genuine tie between two branches with equal
    // available quantity.
    const availability = new Map([
      [
        'ov1',
        [
          avail('newer', 10, new Date('2026-02-01')),
          avail('older', 10, new Date('2026-01-01')),
        ],
      ],
      ['ov2', [avail('thirdBranch', 10)]],
    ]);
    const { groups, unavailableItems } = groupByVendorAndBranch(
      items,
      availability,
    );
    expect(unavailableItems).toEqual([]);
    const ov1Group = groups.find((g) => g.cartItemIds.includes('ci1'));
    expect(ov1Group?.eligibleBranchIds).toEqual(['older']);
    const ov2Group = groups.find((g) => g.cartItemIds.includes('ci2'));
    expect(ov2Group?.eligibleBranchIds).toEqual(['thirdBranch']);
  });
});
