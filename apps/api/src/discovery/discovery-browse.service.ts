import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, ProductAudience } from '../../generated/prisma/client';
import { SalesRankReadService } from '../sales-rank/sales-rank-read.service';
import { FulfilmentEligibilityService } from '../fulfilment/fulfilment-eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { ComparisonCard, ComparisonService } from './comparison.service';
import { comparisonCardDto } from './dto/comparison-card.dto';
import { PUBLIC_OFFER } from '../offers/platform-hold.util';

export type BrowseSort =
  | 'newest'
  | 'price-asc'
  | 'price-desc'
  | 'discounts'
  // PD-5.3: qualified bestsellers first (only while the flag is on).
  | 'bestseller';
export type BrowseFilter = 'trend' | 'discounts';

export const BROWSE_SORTS: BrowseSort[] = [
  'newest',
  'price-asc',
  'price-desc',
  'discounts',
  'bestseller',
];
export const BROWSE_FILTERS: BrowseFilter[] = ['trend', 'discounts'];

export interface BrowseParams {
  /** Every filter applied (eligibility, segment, q, taxonomy). */
  where: Prisma.CanonicalProductWhereInput;
  /**
   * The same filters WITHOUT the category one, plus the confirmed
   * offer-variant condition those other filters put on one offer - what
   * the category counts are computed against (a facet never narrows
   * itself). Absent when no counts were requested.
   */
  facets?: {
    whereWithoutCategory: Prisma.CanonicalProductWhereInput;
    offerWhereWithoutCategory: Prisma.OfferVariantWhereInput;
    /** Only these codes are counted (the page's audience categories). */
    categoryCodes: string[];
  };
  /** Identifies the whole query, so a cursor is never reused across it. */
  queryKey: string;
  pageSize: number;
  sort: BrowseSort;
  filter: BrowseFilter | null;
  minPrice: number | null;
  maxPrice: number | null;
  availableOnly: boolean;
  cursor: string | null;
  /** PD-5.3: the listing's scope for Bestseller marks (its audiences and,
   * when filtered, categories). */
  bestsellerScope: { audiences: ProductAudience[]; categories: string[] };
}

/** Per-product facts the listing sorts and filters on, computed in one
 * aggregate query with exactly the card's own rules (see factsFor()). */
export interface ProductFacts {
  id: string;
  /** When the product's newest eligible store offer was added. */
  addedAt: number;
  /** The card's lowest_price: cheapest in-stock offer, else cheapest. */
  sortPrice: number;
  storeCount: number;
  discountedStoreCount: number;
  /** Eligible offers with live stock (branch stock minus live holds). */
  availableOfferCount: number;
}

export type SortKey = (number | string)[];

export interface CursorPayload {
  /** The query the cursor belongs to - a cursor is never applied to a
   * different filter set, so pages can't mix result sets. */
  q: string;
  k: SortKey;
}

/**
 * Cursor-paginated browsing for the women/men/kids listings
 * (/discovery/all with sort/filter/price/availability/cursor/facets).
 * Which products match is decided by the caller's `where` - the same
 * eligibleProductWhere() predicate, with the product-taxonomy filters on
 * one confirmed offer variant - and cards come from
 * ComparisonService.listCards() unchanged. This service adds price,
 * availability and tab filtering, the order, the cursor and the
 * taxonomy category counts.
 *
 * The cursor is the last item's full sort key (ending in its id), so the
 * order is total and a page boundary never repeats or skips a product.
 */
@Injectable()
export class DiscoveryBrowseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
    private readonly fulfilment: FulfilmentEligibilityService,
    private readonly salesRank: SalesRankReadService,
  ) {}

  async browse(params: BrowseParams) {
    // PD-5.3: the Bestseller mark and sort exist only while the flag is on.
    const bestsellerEnabled = await this.salesRank.enabled();
    if (params.sort === 'bestseller')
      await this.salesRank.assertSortAvailable();
    const after = params.cursor
      ? decodeCursor(params.cursor, params.queryKey)
      : null;

    // The facet base set: every filter except the category one.
    const baseIds = await this.ids(
      params.facets?.whereWithoutCategory ?? params.where,
    );
    const baseFacts = this.applyFactFilters(
      await this.factsFor(baseIds),
      params,
    );

    let matching = baseFacts;
    if (params.facets) {
      const inCategory = new Set(await this.ids(params.where));
      matching = baseFacts.filter((f) => inCategory.has(f.id));
    }

    // «الأكثر مبيعاً»: qualified products first, in their best qualified
    // position; the rest keep the newest order. The cursor only ever
    // carries the visible order (an ordinal), never a rank.
    const ordinal = new Map<string, number>();
    if (params.sort === 'bestseller') {
      const marks = await this.salesRank.canonicalOrder(
        matching.map((f) => f.id),
        params.bestsellerScope,
      );
      matching
        .filter((f) => marks.has(f.id))
        .sort(
          (a, b) =>
            marks.get(a.id)!.position - marks.get(b.id)!.position ||
            b.addedAt - a.addedAt ||
            compareKeys([a.id], [b.id]),
        )
        .forEach((f, i) => ordinal.set(f.id, i + 1));
    }
    const keyOf = (f: ProductFacts) =>
      sortKey(f, params.sort, params.filter, ordinal);
    const ordered = matching
      .map((f) => ({ f, key: keyOf(f) }))
      .sort((a, b) => compareKeys(a.key, b.key));
    const start = after
      ? ordered.findIndex((row) => compareKeys(row.key, after) > 0)
      : 0;
    const remaining = start === -1 ? [] : ordered.slice(start);
    const page = remaining.slice(0, params.pageSize);
    const hasMore = remaining.length > page.length;

    const pageIds = page.map((row) => row.f.id);
    const cards: ComparisonCard[] = pageIds.length
      ? (
          await this.comparison.listCards(
            { id: { in: pageIds } },
            1,
            pageIds.length,
          )
        ).cards
      : [];
    const byId = new Map(cards.map((card) => [card.canonicalProductId, card]));
    const marks = bestsellerEnabled
      ? await this.salesRank.canonicalOrder(pageIds, params.bestsellerScope)
      : new Map<string, { mark: unknown }>();
    const items = pageIds
      .map((id) => byId.get(id))
      .filter((card): card is ComparisonCard => card !== undefined)
      .map((card) => ({
        ...comparisonCardDto(card),
        // PD-5.3: the scope of a Bestseller mark, or null - nothing else.
        bestseller: marks.get(card.canonicalProductId)?.mark ?? null,
      }));

    const last = page[page.length - 1];
    return {
      page_size: params.pageSize,
      total: matching.length,
      bestseller_enabled: bestsellerEnabled,
      items,
      next_cursor:
        hasMore && last
          ? encodeCursor({ q: params.queryKey, k: last.key })
          : null,
      ...(params.facets
        ? {
            category_counts: await this.categoryCounts(
              baseFacts.map((f) => f.id),
              params.facets,
            ),
            all_count: baseFacts.length,
          }
        : {}),
    };
  }

  /** The ids of the products matching `where`. */
  async ids(where: Prisma.CanonicalProductWhereInput) {
    const rows = await this.prisma.canonicalProduct.findMany({
      where,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private applyFactFilters(facts: ProductFacts[], params: BrowseParams) {
    return facts.filter(
      (f) =>
        (params.minPrice === null || f.sortPrice >= params.minPrice) &&
        (params.maxPrice === null || f.sortPrice <= params.maxPrice) &&
        (!params.availableOnly || f.availableOfferCount > 0) &&
        (params.filter !== 'discounts' || f.discountedStoreCount > 0) &&
        (params.filter !== 'trend' || f.storeCount > 1),
    );
  }

  /**
   * Products per taxonomy category among `productIds`: a product counts
   * under a category when one of its confirmed, eligible offer variants
   * satisfies the other filters AND that variant's offer is classified
   * in the category - the same one-offer rule the listing filter uses.
   */
  async categoryCounts(
    productIds: string[],
    facets: NonNullable<BrowseParams['facets']>,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = Object.fromEntries(
      facets.categoryCodes.map((code) => [code, 0]),
    );
    if (productIds.length === 0) return counts;
    const rows = await this.prisma.offerVariant.findMany({
      where: {
        AND: [
          {
            canonicalVariant: { canonicalProductId: { in: productIds } },
            vendorOffer: {
              ...PUBLIC_OFFER,
              categories: {
                some: { categoryCode: { in: facets.categoryCodes } },
              },
            },
            vendor: { storefrontPublished: true, status: 'ACTIVE' },
          },
          facets.offerWhereWithoutCategory,
        ],
      },
      select: {
        canonicalVariant: { select: { canonicalProductId: true } },
        vendorOffer: {
          select: { categories: { select: { categoryCode: true } } },
        },
      },
    });
    const productsByCode = new Map<string, Set<string>>();
    for (const row of rows) {
      const productId = row.canonicalVariant?.canonicalProductId;
      if (!productId) continue;
      for (const { categoryCode } of row.vendorOffer.categories) {
        if (!(categoryCode in counts)) continue;
        const set = productsByCode.get(categoryCode) ?? new Set<string>();
        set.add(productId);
        productsByCode.set(categoryCode, set);
      }
    }
    for (const [code, set] of productsByCode) counts[code] = set.size;
    return counts;
  }

  /**
   * The candidates' eligible offers, one row per offer variant: the price
   * is computeEffectivePrice() in SQL (active scheduled discount, else
   * manual sale price, else base price - rounded to 2 dp half-up, which
   * Postgres round(numeric) matches for positive values). PD-2: what is
   * "available" comes from FulfilmentEligibilityService - sellable
   * branches only, live holds subtracted, 0 for a vendor that can't sell
   * now - the same figure every card and checkout use.
   */
  async factsFor(
    ids: string[],
    /** Only these stores' offers count (the following feed); all eligible stores when absent. */
    vendorIds?: string[],
  ): Promise<ProductFacts[]> {
    if (ids.length === 0) return [];
    const now = new Date();
    const rows = await this.prisma.$queryRaw<
      {
        variant_id: string;
        product_id: string;
        vendor_id: string;
        offer_created_at: Date;
        base_price: number;
        price: number;
      }[]
    >(Prisma.sql`
      SELECT ov.id AS variant_id,
             cpv."canonicalProductId" AS product_id,
             ov."vendorId" AS vendor_id,
             vo."createdAt" AS offer_created_at,
             ov."basePrice"::float8 AS base_price,
             (CASE
               WHEN ov."discountPercent" IS NOT NULL
                AND ov."discountStartAt" IS NOT NULL
                AND ov."discountEndAt" IS NOT NULL
                AND ${now} >= ov."discountStartAt"
                AND ${now} < ov."discountEndAt"
                 THEN round(ov."basePrice" * (1 - ov."discountPercent" / 100), 2)
               WHEN ov."salePrice" IS NOT NULL THEN round(ov."salePrice", 2)
               ELSE round(ov."basePrice", 2)
             END)::float8 AS price
      FROM offer_variants ov
      JOIN canonical_product_variants cpv ON cpv.id = ov."canonicalVariantId"
      JOIN vendor_offers vo ON vo.id = ov."vendorOfferId"
      JOIN vendors v ON v.id = ov."vendorId"
      WHERE cpv."canonicalProductId" = ANY(${ids}::text[])
        AND vo.status = 'ACTIVE'
        AND v."storefrontPublished" = true
        AND v.status = 'ACTIVE'
        AND (${vendorIds === undefined} OR ov."vendorId" = ANY(${vendorIds ?? []}::text[]))
    `);
    const available = await this.fulfilment.availableByVariant(
      rows.map((r) => ({ id: r.variant_id, vendorId: r.vendor_id })),
    );

    const byProduct = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byProduct.get(r.product_id) ?? [];
      list.push(r);
      byProduct.set(r.product_id, list);
    }
    return [...byProduct].map(([id, offers]) => {
      const inStock = offers.filter(
        (o) => (available.get(o.variant_id)?.total ?? 0) > 0,
      );
      const prices = (inStock.length ? inStock : offers).map((o) => o.price);
      return {
        id,
        addedAt: Math.max(...offers.map((o) => o.offer_created_at.getTime())),
        // The card's lowest_price: cheapest in-stock offer, else cheapest.
        sortPrice: Math.min(...prices),
        storeCount: new Set(offers.map((o) => o.vendor_id)).size,
        discountedStoreCount: new Set(
          inStock.filter((o) => o.price < o.base_price).map((o) => o.vendor_id),
        ).size,
        availableOfferCount: inStock.length,
      };
    });
  }
}

/** Ascending-compare sort key; every key ends with the product id, so the
 * order is total. Descending fields are negated. */
function sortKey(
  f: ProductFacts,
  sort: BrowseSort,
  filter: BrowseFilter | null,
  bestsellerOrdinal: Map<string, number> = new Map(),
): SortKey {
  const newest: SortKey = [-f.addedAt];
  const bySort: SortKey =
    sort === 'bestseller'
      ? [bestsellerOrdinal.get(f.id) ?? Number.MAX_SAFE_INTEGER, ...newest]
      : sort === 'price-asc'
        ? [f.sortPrice, ...newest]
        : sort === 'price-desc'
          ? [-f.sortPrice, ...newest]
          : sort === 'discounts'
            ? [-f.discountedStoreCount, f.sortPrice, ...newest]
            : newest;
  // "Trend" ranks by store count first and keeps the chosen sort within
  // each tier.
  const primary: SortKey = filter === 'trend' ? [-f.storeCount] : [];
  return [...primary, ...bySort, f.id];
}

export function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    // Ids compare descending (plain code-unit order, locale-independent),
    // matching the classic path's id-desc tiebreak.
    return String(x) < String(y) ? 1 : -1;
  }
  return 0;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string, queryKey: string): SortKey {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as CursorPayload;
    const validKey =
      Array.isArray(parsed.k) &&
      parsed.k.length > 0 &&
      parsed.k.every((v) => typeof v === 'number' || typeof v === 'string');
    if (parsed.q === queryKey && validKey) return parsed.k;
  } catch {
    // fall through
  }
  throw new BadRequestException({
    code: 'INVALID_CURSOR',
    message: 'cursor does not belong to this query',
  });
}
