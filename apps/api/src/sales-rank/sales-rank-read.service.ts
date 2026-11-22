import { Injectable, NotFoundException } from '@nestjs/common';
import { ProductAudience } from '../../generated/prisma/client';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';

/** A snapshot older than this is treated as missing (the job stopped). */
const MAX_SNAPSHOT_AGE_MS = 26 * 60 * 60_000;

/** The only thing the public ever learns: "a bestseller in this scope". */
export interface BestsellerMark {
  category_code: string;
  audience: ProductAudience;
}

/** Ordering facts for the «الأكثر مبيعاً» sort - never sent to a client. */
export interface BestsellerOrder {
  mark: BestsellerMark;
  /** Best qualified position (1-10) - used to order, never exposed. */
  position: number;
}

/**
 * PD-5.3: every public read of the sales rank goes through here - from
 * the latest SalesRankSnapshot only (no order is ever scanned), only
 * qualified entries, only while the `bestseller_enabled` flag is on, and
 * only the scope of the mark (never a rank, unit or customer count).
 */
@Injectable()
export class SalesRankReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
  ) {}

  enabled(): Promise<boolean> {
    return this.flags.isEnabled('bestseller_enabled');
  }

  /** 404 FEATURE_DISABLED for the «الأكثر مبيعاً» sort while the flag is off. */
  async assertSortAvailable(): Promise<void> {
    if (!(await this.enabled())) {
      throw new NotFoundException({
        code: 'FEATURE_DISABLED',
        message: 'Sorting by bestseller is not available',
      });
    }
  }

  /** The current run, when the flag is on and the snapshot is fresh. */
  private async liveRunId(): Promise<string | null> {
    if (!(await this.enabled())) return null;
    const run = await this.prisma.salesRankRun.findFirst({
      orderBy: { computedAt: 'desc' },
      select: { id: true, computedAt: true },
    });
    if (!run || Date.now() - run.computedAt.getTime() > MAX_SNAPSHOT_AGE_MS)
      return null;
    return run.id;
  }

  private best<T extends { qualifiedRank: number | null }>(rows: T[]) {
    return [...rows].sort(
      (a, b) => (a.qualifiedRank ?? 99) - (b.qualifiedRank ?? 99),
    )[0];
  }

  /** Product page: this offer's mark (its best qualifying scope), or null. */
  async offerMark(offerId: string): Promise<BestsellerMark | null> {
    const runId = await this.liveRunId();
    if (!runId) return null;
    const rows = await this.prisma.salesRankSnapshot.findMany({
      where: { runId, scope: 'OFFER', vendorOfferId: offerId, qualified: true },
      select: { categoryCode: true, audience: true, qualifiedRank: true },
    });
    const top = this.best(rows);
    return top
      ? { category_code: top.categoryCode, audience: top.audience }
      : null;
  }

  /** Store page sort: the store's qualified offers and their order. */
  async offerOrder(vendorId: string): Promise<Map<string, BestsellerOrder>> {
    return this.order({ scope: 'OFFER', vendorId }, (r) => r.vendorOfferId!);
  }

  /**
   * Discovery: canonical products' marks within the listing's scope - its
   * audiences (and categories, when filtered); any scope when unscoped.
   */
  async canonicalOrder(
    productIds: string[],
    scope: { audiences: ProductAudience[]; categories: string[] },
  ): Promise<Map<string, BestsellerOrder>> {
    if (productIds.length === 0) return new Map();
    return this.order(
      {
        scope: 'CANONICAL',
        canonicalProductId: { in: productIds },
        ...(scope.audiences.length
          ? { audience: { in: scope.audiences } }
          : {}),
        ...(scope.categories.length
          ? { categoryCode: { in: scope.categories } }
          : {}),
      },
      (r) => r.canonicalProductId!,
    );
  }

  private async order(
    where: Record<string, unknown>,
    keyOf: (r: {
      vendorOfferId: string | null;
      canonicalProductId: string | null;
    }) => string,
  ): Promise<Map<string, BestsellerOrder>> {
    const result = new Map<string, BestsellerOrder>();
    const runId = await this.liveRunId();
    if (!runId) return result;
    const rows = await this.prisma.salesRankSnapshot.findMany({
      where: { runId, qualified: true, ...where },
      select: {
        vendorOfferId: true,
        canonicalProductId: true,
        categoryCode: true,
        audience: true,
        qualifiedRank: true,
      },
    });
    for (const r of rows) {
      const key = keyOf(r);
      const current = result.get(key);
      if (!current || r.qualifiedRank! < current.position) {
        result.set(key, {
          mark: { category_code: r.categoryCode, audience: r.audience },
          position: r.qualifiedRank!,
        });
      }
    }
    return result;
  }

  /**
   * The store owner's own offers in the latest run (exact figures are
   * their own sales; the rank among other stores is not shown).
   */
  async ownerView(vendorId: string) {
    const run = await this.prisma.salesRankRun.findFirst({
      orderBy: { computedAt: 'desc' },
    });
    if (!run) return { computed_at: null, window_start: null, entries: [] };
    const rows = await this.prisma.salesRankSnapshot.findMany({
      where: { runId: run.id, scope: 'OFFER', vendorId },
      orderBy: [{ units: 'desc' }, { customers: 'desc' }],
      select: {
        vendorOfferId: true,
        categoryCode: true,
        audience: true,
        units: true,
        customers: true,
        qualified: true,
        vendorOffer: { select: { titleAr: true } },
      },
    });
    return {
      computed_at: run.computedAt.toISOString(),
      window_start: run.windowStart.toISOString(),
      entries: rows.map((r) => ({
        offer_id: r.vendorOfferId,
        title: r.vendorOffer?.titleAr ?? null,
        category_code: r.categoryCode,
        audience: r.audience,
        units: r.units,
        customers: r.customers,
        bestseller: r.qualified,
      })),
    };
  }
}
