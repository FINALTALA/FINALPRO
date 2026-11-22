import { ProductAudience, ReturnStatus } from '../../generated/prisma/client';

/**
 * PD-5.2 (PD-FR-005): the sales-rank rules, in one pure place.
 *
 * A unit counts only when: its BranchOrder is COMPLETED; the line isn't
 * cancelled; it has no item refund; it isn't in a return/exchange that
 * is still open or went through (any status except the ones below that
 * end with the item kept); the buyer isn't a member of the selling store;
 * the store isn't suspended; and it was sold (deliveredAt / pickedUpAt)
 * within the last 30 days. The collection query in sales-rank.service.ts
 * applies those filters; this file ranks what survives.
 */
export const SALES_RANK_WINDOW_DAYS = 30;
export const MIN_UNITS = 5;
export const MIN_CUSTOMERS = 3;
export const TOP_N = 10;
/** An entry is marked only when at least this many OTHER entries of its
 * scope also pass the thresholds (it doesn't compete with itself) - so a
 * scope needs 4 qualifying entries in total. */
export const MIN_QUALIFIED_COMPETITORS = 3;

/** Return outcomes after which the customer kept the item (the sale stands). */
export const RETURN_STATUSES_ITEM_KEPT: readonly ReturnStatus[] = [
  'REJECTED',
  'REJECTED_CLOSED',
  'ADMIN_REJECTED',
  'EXPIRED',
  'CANCELLED_BY_CUSTOMER',
];

export interface RankLine {
  /** An offer id (OFFER scope) or a canonical product id (CANONICAL). */
  targetId: string;
  categoryCode: string;
  audience: ProductAudience;
  quantity: number;
  customerId: string;
  soldAt: Date;
}

export interface RankedEntry {
  targetId: string;
  categoryCode: string;
  audience: ProductAudience;
  units: number;
  customers: number;
  firstSoldAt: Date;
  rank: number;
  qualifiedRank: number | null;
  qualified: boolean;
}

export function windowFor(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(now.getTime() - SALES_RANK_WINDOW_DAYS * 86_400_000),
    end: now,
  };
}

/** Units desc, then distinct customers desc, then earliest first sale, then id. */
export function compareEntries(
  a: Pick<RankedEntry, 'units' | 'customers' | 'firstSoldAt' | 'targetId'>,
  b: Pick<RankedEntry, 'units' | 'customers' | 'firstSoldAt' | 'targetId'>,
): number {
  return (
    b.units - a.units ||
    b.customers - a.customers ||
    a.firstSoldAt.getTime() - b.firstSoldAt.getTime() ||
    (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0)
  );
}

export function passesThresholds(e: { units: number; customers: number }) {
  return e.units >= MIN_UNITS && e.customers >= MIN_CUSTOMERS;
}

/** Aggregates the lines per (target, category, audience) and ranks each scope. */
export function rankLines(lines: RankLine[]): RankedEntry[] {
  const groups = new Map<
    string,
    {
      targetId: string;
      categoryCode: string;
      audience: ProductAudience;
      units: number;
      customers: Set<string>;
      firstSoldAt: Date;
    }
  >();
  for (const l of lines) {
    const key = `${l.categoryCode}|${l.audience}|${l.targetId}`;
    const g = groups.get(key) ?? {
      targetId: l.targetId,
      categoryCode: l.categoryCode,
      audience: l.audience,
      units: 0,
      customers: new Set<string>(),
      firstSoldAt: l.soldAt,
    };
    g.units += l.quantity;
    g.customers.add(l.customerId);
    if (l.soldAt < g.firstSoldAt) g.firstSoldAt = l.soldAt;
    groups.set(key, g);
  }

  const byScope = new Map<string, RankedEntry[]>();
  for (const g of groups.values()) {
    if (g.units < 1) continue;
    const scopeKey = `${g.categoryCode}|${g.audience}`;
    const list = byScope.get(scopeKey) ?? [];
    list.push({
      targetId: g.targetId,
      categoryCode: g.categoryCode,
      audience: g.audience,
      units: g.units,
      customers: g.customers.size,
      firstSoldAt: g.firstSoldAt,
      rank: 0,
      qualifiedRank: null,
      qualified: false,
    });
    byScope.set(scopeKey, list);
  }

  const result: RankedEntry[] = [];
  for (const list of byScope.values()) {
    list.sort(compareEntries);
    const passing = list.filter(passesThresholds);
    const scopeQualifies = passing.length - 1 >= MIN_QUALIFIED_COMPETITORS;
    let qualifiedPosition = 0;
    list.forEach((e, i) => {
      e.rank = i + 1;
      if (scopeQualifies && passesThresholds(e)) {
        qualifiedPosition += 1;
        if (qualifiedPosition <= TOP_N) {
          e.qualifiedRank = qualifiedPosition;
          e.qualified = true;
        }
      }
    });
    result.push(...list);
  }
  return result;
}
