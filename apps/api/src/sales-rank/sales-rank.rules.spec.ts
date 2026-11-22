import { RankLine, rankLines, windowFor } from './sales-rank.rules';

const t0 = new Date('2026-10-01T10:00:00Z');
const day = (n: number) => new Date(t0.getTime() + n * 86_400_000);

/** `units` lines of 1 unit for `target`, spread over `customers` buyers. */
function sales(
  target: string,
  units: number,
  customers: number,
  first = day(0),
  scope: Pick<RankLine, 'categoryCode' | 'audience'> = {
    categoryCode: 'DRESSES_WOMEN',
    audience: 'WOMEN',
  },
): RankLine[] {
  return Array.from({ length: units }, (_, i) => ({
    targetId: target,
    ...scope,
    quantity: 1,
    customerId: `${target}-c${i % customers}`,
    soldAt: i === 0 ? first : day(1),
  }));
}

const byTarget = (entries: ReturnType<typeof rankLines>) =>
  Object.fromEntries(entries.map((e) => [e.targetId, e]));

describe('PD-5.2 sales rank rules', () => {
  it('the window is the last 30 days', () => {
    const now = new Date('2026-10-28T12:00:00Z');
    expect(windowFor(now).start.toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(windowFor(now).end).toBe(now);
  });

  it('ranks by units, then distinct customers, then first sale, then id', () => {
    const r = byTarget(
      rankLines([
        ...sales('a', 6, 3),
        ...sales('b', 8, 3),
        ...sales('c', 6, 5),
        ...sales('d', 6, 5, day(-1)),
        ...sales('e', 6, 5, day(-1)),
      ]),
    );
    expect(['b', 'd', 'e', 'c', 'a'].map((t) => r[t].rank)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    // quantity counts as units; customers are distinct buyers.
    const q = rankLines([
      {
        targetId: 'x',
        categoryCode: 'JEANS',
        audience: 'MEN',
        quantity: 4,
        customerId: 'k',
        soldAt: t0,
      },
      {
        targetId: 'x',
        categoryCode: 'JEANS',
        audience: 'MEN',
        quantity: 2,
        customerId: 'k',
        soldAt: day(2),
      },
    ])[0];
    expect([q.units, q.customers, q.firstSoldAt]).toEqual([6, 1, t0]);
  });

  it('qualifies only with >= 5 units AND >= 3 customers', () => {
    const r = byTarget(
      rankLines([
        ...sales('ok1', 5, 3),
        ...sales('ok2', 5, 3),
        ...sales('ok3', 5, 3),
        ...sales('ok4', 5, 3),
        ...sales('fewUnits', 4, 4),
        ...sales('oneBuyer', 20, 1),
      ]),
    );
    expect(r.oneBuyer.rank).toBe(1);
    expect(r.oneBuyer.qualified).toBe(false);
    expect(r.fewUnits.qualified).toBe(false);
    expect([r.ok1, r.ok2, r.ok3, r.ok4].every((e) => e.qualified)).toBe(true);
    // qualifiedRank counts only the qualifying entries.
    expect(
      [r.ok1, r.ok2, r.ok3, r.ok4].map((e) => e.qualifiedRank).sort(),
    ).toEqual([1, 2, 3, 4]);
  });

  it('an entry needs 3 OTHER qualifying entries in its scope (4 in total)', () => {
    const three = rankLines([
      ...sales('a', 50, 20),
      ...sales('b', 9, 5),
      ...sales('c', 6, 3),
    ]);
    expect(three.every((e) => !e.qualified && e.qualifiedRank === null)).toBe(
      true,
    );
    expect(three.map((e) => e.rank).sort()).toEqual([1, 2, 3]);
    const four = rankLines([
      ...sales('a', 50, 20),
      ...sales('b', 9, 5),
      ...sales('c', 6, 3),
      ...sales('d', 5, 3),
    ]);
    expect(four.every((e) => e.qualified)).toBe(true);
  });

  it('only the top 10 qualifying entries are marked', () => {
    const lines = Array.from({ length: 12 }, (_, i) =>
      sales(`p${String(i).padStart(2, '0')}`, 30 - i, 3),
    ).flat();
    const r = byTarget(rankLines(lines));
    expect(r.p09.qualifiedRank).toBe(10);
    expect(r.p10.qualified).toBe(false);
    expect(r.p11.qualified).toBe(false);
  });

  it('each category/audience scope is ranked on its own', () => {
    const men = { categoryCode: 'JEANS', audience: 'MEN' as const };
    const women = { categoryCode: 'JEANS', audience: 'WOMEN' as const };
    const r = rankLines([
      ...sales('a', 5, 3, day(0), men),
      ...sales('a', 1, 1, day(0), women),
      ...sales('b', 7, 3, day(0), women),
    ]);
    const find = (t: string, aud: string) =>
      r.find((e) => e.targetId === t && e.audience === aud)!;
    expect(find('a', 'MEN').rank).toBe(1);
    expect(find('a', 'WOMEN').rank).toBe(2);
    expect(find('b', 'WOMEN').rank).toBe(1);
  });
});
