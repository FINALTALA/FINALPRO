/**
 * Sprint 10 (RB-ORD-002, PDR-004): "all selected items fulfilled by the
 * same physical branch travel together... if no single eligible branch
 * has every selected item, the system creates separate BranchOrders."
 * Pure and DB-free by design (same separation this codebase already
 * established for branch-order-state-machine.ts) - the service layer
 * resolves cart items and live branch-stock availability from the DB,
 * this function only decides HOW to group them, so the grouping
 * decision itself is exhaustively unit-testable without a database.
 *
 * Branch ordering ("suggested" branch, and the fallback tie-break) is
 * deliberately NOT distance-based - this codebase has no reliable
 * geo-boundary data to compute real proximity from (OPEN-012 leaves
 * the delivery-zone boundary source undecided, and StoreBranch.lat/lng
 * are display-only map pins, never validated against any real
 * boundary). A documented, deterministic order (branch createdAt
 * ascending, then id) is used instead, and is never presented to the
 * customer as "nearest" - only as a stable default among the ALWAYS-
 * fully-shown eligible list, so the customer can freely pick a
 * different one (PDR-023's "customer can deliberately choose a
 * farther eligible branch" - honestly, a different one, not a farther
 * one, since distance is never actually known).
 */

export interface GroupingItem {
  cartItemId: string;
  vendorId: string;
  offerVariantId: string;
  quantity: number;
}

export interface BranchAvailability {
  branchId: string;
  /** branch.quantity - branch.reservedQuantity, live at read time. */
  availableQuantity: number;
  createdAt: Date;
}

export interface FormedGroup {
  vendorId: string;
  cartItemIds: string[];
  /** true if no single branch covered every item in this vendor's selection. */
  fragmented: boolean;
  /** Eligible branch ids for this exact group, in the deterministic suggested order (first = suggested). */
  eligibleBranchIds: string[];
}

export interface UnavailableItem {
  cartItemId: string;
  reason: 'NO_BRANCH_HAS_SUFFICIENT_STOCK';
}

export interface GroupingResult {
  groups: FormedGroup[];
  unavailableItems: UnavailableItem[];
}

function sortBranchesDeterministically(
  branchIds: string[],
  availabilityByBranch: Map<string, BranchAvailability>,
): string[] {
  return [...branchIds].sort((a, b) => {
    const av = availabilityByBranch.get(a)!;
    const bv = availabilityByBranch.get(b)!;
    const byCreatedAt = av.createdAt.getTime() - bv.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * @param items This vendor's selected cart lines only.
 * @param availability For each offerVariantId in `items`, every branch
 *   (of this same vendor) that stocks it at all, with live available
 *   quantity.
 */
export function groupOneVendor(
  vendorId: string,
  items: GroupingItem[],
  availability: Map<string, BranchAvailability[]>,
): { groups: FormedGroup[]; unavailableItems: UnavailableItem[] } {
  // Step 1: does any single branch cover every item at its requested
  // quantity?
  const branchCoverage = new Map<string, BranchAvailability>();
  for (const item of items) {
    const branches = availability.get(item.offerVariantId) ?? [];
    for (const b of branches) {
      branchCoverage.set(b.branchId, b);
    }
  }
  const fullyCoveringBranches = [...branchCoverage.keys()].filter((branchId) =>
    items.every((item) => {
      const b = (availability.get(item.offerVariantId) ?? []).find(
        (x) => x.branchId === branchId,
      );
      return b && b.availableQuantity >= item.quantity;
    }),
  );

  if (fullyCoveringBranches.length > 0) {
    return {
      groups: [
        {
          vendorId,
          cartItemIds: items.map((i) => i.cartItemId),
          fragmented: false,
          eligibleBranchIds: sortBranchesDeterministically(
            fullyCoveringBranches,
            branchCoverage,
          ),
        },
      ],
      unavailableItems: [],
    };
  }

  // Step 2: fragmented fallback - assign each item independently to
  // the branch with the most available stock for it (deterministic
  // tie-break: earliest createdAt, then id), then group items by their
  // assigned branch. An item with no branch carrying sufficient stock
  // at all is surfaced as unavailable, never silently dropped.
  const unavailableItems: UnavailableItem[] = [];
  const assignedBranchByCartItemId = new Map<string, string>();
  const allAvailabilityByBranch = new Map<string, BranchAvailability>();
  for (const branches of availability.values()) {
    for (const b of branches) allAvailabilityByBranch.set(b.branchId, b);
  }

  for (const item of items) {
    const candidates = (availability.get(item.offerVariantId) ?? []).filter(
      (b) => b.availableQuantity >= item.quantity,
    );
    if (candidates.length === 0) {
      unavailableItems.push({
        cartItemId: item.cartItemId,
        reason: 'NO_BRANCH_HAS_SUFFICIENT_STOCK',
      });
      continue;
    }
    const sorted = [...candidates].sort((a, b) => {
      if (b.availableQuantity !== a.availableQuantity) {
        return b.availableQuantity - a.availableQuantity;
      }
      const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
      if (byCreatedAt !== 0) return byCreatedAt;
      return a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0;
    });
    assignedBranchByCartItemId.set(item.cartItemId, sorted[0].branchId);
  }

  const itemsByBranch = new Map<string, string[]>();
  for (const [cartItemId, branchId] of assignedBranchByCartItemId) {
    const list = itemsByBranch.get(branchId) ?? [];
    list.push(cartItemId);
    itemsByBranch.set(branchId, list);
  }

  const groups: FormedGroup[] = [...itemsByBranch.entries()]
    .sort(([branchIdA], [branchIdB]) => {
      const a = allAvailabilityByBranch.get(branchIdA)!;
      const b = allAvailabilityByBranch.get(branchIdB)!;
      const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
      if (byCreatedAt !== 0) return byCreatedAt;
      return branchIdA < branchIdB ? -1 : 1;
    })
    .map(([branchId, cartItemIds]) => ({
      vendorId,
      cartItemIds,
      fragmented: true,
      eligibleBranchIds: [branchId],
    }));

  return { groups, unavailableItems };
}

export function groupByVendorAndBranch(
  items: GroupingItem[],
  availabilityByVariant: Map<string, BranchAvailability[]>,
): GroupingResult {
  const byVendor = new Map<string, GroupingItem[]>();
  for (const item of items) {
    const list = byVendor.get(item.vendorId) ?? [];
    list.push(item);
    byVendor.set(item.vendorId, list);
  }

  const groups: FormedGroup[] = [];
  const unavailableItems: UnavailableItem[] = [];
  for (const [vendorId, vendorItems] of byVendor) {
    const scopedAvailability = new Map<string, BranchAvailability[]>();
    for (const item of vendorItems) {
      scopedAvailability.set(
        item.offerVariantId,
        availabilityByVariant.get(item.offerVariantId) ?? [],
      );
    }
    const result = groupOneVendor(vendorId, vendorItems, scopedAvailability);
    groups.push(...result.groups);
    unavailableItems.push(...result.unavailableItems);
  }

  return { groups, unavailableItems };
}
