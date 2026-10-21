import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ComparisonCard, ComparisonService } from './comparison.service';
import { comparisonCardDto } from './dto/comparison-card.dto';
import {
  WOMEN_CATEGORY_RULES,
  matchesWomenCategory,
  productSearchText,
} from './women-categories';

export type BrowseSort = 'newest' | 'price-asc' | 'price-desc' | 'discounts';
export type BrowseFilter = 'trend' | 'discounts';

export const BROWSE_SORTS: BrowseSort[] = [
  'newest',
  'price-asc',
  'price-desc',
  'discounts',
];
export const BROWSE_FILTERS: BrowseFilter[] = ['trend', 'discounts'];

export interface BrowseParams {
  where: Prisma.CanonicalProductWhereInput;
  pageSize: number;
  sort: BrowseSort;
  filter: BrowseFilter | null;
  category: string | null;
  cursor: string | null;
  withCategoryCounts: boolean;
}

/** Per-product facts the listing sorts and filters on, computed in one
 * aggregate query with exactly the card's own rules (see factsFor()). */
interface ProductFacts {
  id: string;
  createdAt: number;
  searchText: string;
  /** The card's lowest_price: cheapest in-stock offer, else cheapest. */
  sortPrice: number;
  storeCount: number;
  discountedStoreCount: number;
}

type SortKey = (number | string)[];

interface CursorPayload {
  /** The query the cursor belongs to - a cursor is never applied to a
   * different sort/filter/category, so pages can't mix result sets. */
  q: string;
  k: SortKey;
}

/**
 * Cursor-paginated browsing for the women's listing (/discovery/all with
 * sort/filter/category/cursor). Only the requested page's cards are
 * built; everything else is a light id query plus one aggregate SQL
 * query over the matching products' eligible offers.
 *
 * Eligibility is the existing eligibleProductWhere() predicate (passed in
 * as `where`, the same object the classic page/page_size path uses), and
 * cards come from ComparisonService.listCards() unchanged - this service
 * only decides WHICH products and in WHAT order.
 *
 * The cursor is the last item's full sort key (ending in its id), so the
 * order is total and a page boundary never repeats or skips a product,
 * even when products are added between requests.
 */
@Injectable()
export class DiscoveryBrowseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
  ) {}

  async browse(params: BrowseParams) {
    const queryKey = [
      params.sort,
      params.filter ?? '',
      params.category ?? '',
    ].join('|');
    const after = params.cursor ? decodeCursor(params.cursor, queryKey) : null;

    const candidates = await this.prisma.canonicalProduct.findMany({
      where: params.where,
      select: { id: true },
    });
    const facts = await this.factsFor(candidates.map((c) => c.id));

    const categoryCounts = params.withCategoryCounts
      ? countCategories(facts)
      : undefined;

    let matching = facts;
    if (params.category) {
      const slug = params.category;
      matching = matching.filter((f) =>
        matchesWomenCategory(f.searchText, slug),
      );
    }
    if (params.filter === 'discounts') {
      matching = matching.filter((f) => f.discountedStoreCount > 0);
    }
    if (params.filter === 'trend') {
      // Sold by more than one store - the only popularity signal the
      // data carries (no views/orders tracking exists).
      matching = matching.filter((f) => f.storeCount > 1);
    }

    const keyOf = (f: ProductFacts) => sortKey(f, params.sort, params.filter);
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
    const items = pageIds
      .map((id) => byId.get(id))
      .filter((card): card is ComparisonCard => card !== undefined)
      .map(comparisonCardDto);

    const last = page[page.length - 1];
    return {
      page_size: params.pageSize,
      total: matching.length,
      items,
      next_cursor:
        hasMore && last ? encodeCursor({ q: queryKey, k: last.key }) : null,
      ...(categoryCounts
        ? { category_counts: categoryCounts, all_count: facts.length }
        : {}),
    };
  }

  /**
   * One aggregate pass over the candidates' eligible offers. The price
   * expression is computeEffectivePrice() in SQL (active scheduled
   * discount, else manual sale price, else base price - all rounded to
   * 2 dp half-up, which Postgres round(numeric) matches for positive
   * values), and "available" is totalAvailableStockLive() (branch stock
   * minus live checkout reservations, floored at 0 per branch), so the
   * sort price and discount counts agree with what the card shows.
   */
  private async factsFor(ids: string[]): Promise<ProductFacts[]> {
    if (ids.length === 0) return [];
    const now = new Date();
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        created_at: Date;
        name_ar: string | null;
        name_en: string | null;
        category_ar: string | null;
        sort_price: number | null;
        store_count: number;
        discounted_store_count: number;
      }[]
    >(Prisma.sql`
      WITH reserved AS (
        SELECT cri."branchId" AS branch_id, cri."offerVariantId" AS offer_variant_id,
               SUM(cri.quantity) AS qty
        FROM checkout_reservation_items cri
        JOIN checkout_reservations cr ON cr.id = cri."reservationId"
        WHERE cr."expiresAt" > ${now}
        GROUP BY 1, 2
      ),
      stock AS (
        SELECT bs."offerVariantId" AS offer_variant_id,
               SUM(GREATEST(0, bs.quantity - COALESCE(r.qty, 0))) AS available
        FROM branch_stock bs
        LEFT JOIN reserved r
          ON r.branch_id = bs."branchId" AND r.offer_variant_id = bs."offerVariantId"
        GROUP BY 1
      ),
      offers AS (
        SELECT cpv."canonicalProductId" AS product_id,
               ov."vendorId" AS vendor_id,
               ov."basePrice" AS base_price,
               CASE
                 WHEN ov."discountPercent" IS NOT NULL
                  AND ov."discountStartAt" IS NOT NULL
                  AND ov."discountEndAt" IS NOT NULL
                  AND ${now} >= ov."discountStartAt"
                  AND ${now} < ov."discountEndAt"
                   THEN round(ov."basePrice" * (1 - ov."discountPercent" / 100), 2)
                 WHEN ov."salePrice" IS NOT NULL THEN round(ov."salePrice", 2)
                 ELSE round(ov."basePrice", 2)
               END AS price,
               COALESCE(s.available, 0) AS available
        FROM offer_variants ov
        JOIN canonical_product_variants cpv ON cpv.id = ov."canonicalVariantId"
        JOIN vendor_offers vo ON vo.id = ov."vendorOfferId"
        JOIN vendors v ON v.id = ov."vendorId"
        LEFT JOIN stock s ON s.offer_variant_id = ov.id
        WHERE cpv."canonicalProductId" = ANY(${ids}::text[])
          AND vo.status = 'ACTIVE'
          AND v."storefrontPublished" = true
          AND v.status = 'ACTIVE'
      ),
      facts AS (
        SELECT product_id,
               COALESCE(MIN(price) FILTER (WHERE available > 0), MIN(price))::float8 AS sort_price,
               COUNT(DISTINCT vendor_id)::int AS store_count,
               COUNT(DISTINCT vendor_id) FILTER (WHERE available > 0 AND price < base_price)::int
                 AS discounted_store_count
        FROM offers
        GROUP BY product_id
      )
      SELECT cp.id, cp."createdAt" AS created_at,
             cp."canonicalNameAr" AS name_ar, cp."canonicalNameEn" AS name_en,
             cat."nameAr" AS category_ar,
             f.sort_price, f.store_count, f.discounted_store_count
      FROM facts f
      JOIN canonical_products cp ON cp.id = f.product_id
      LEFT JOIN categories cat ON cat.id = cp."categoryId"
    `);

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at.getTime(),
      searchText: productSearchText(row.name_ar, row.name_en, row.category_ar),
      sortPrice: row.sort_price ?? 0,
      storeCount: row.store_count,
      discountedStoreCount: row.discounted_store_count,
    }));
  }
}

/** Ascending-compare sort key; every key ends with the product id, so the
 * order is total. Descending fields are negated. */
function sortKey(
  f: ProductFacts,
  sort: BrowseSort,
  filter: BrowseFilter | null,
): SortKey {
  const newest: SortKey = [-f.createdAt];
  const bySort: SortKey =
    sort === 'price-asc'
      ? [f.sortPrice, ...newest]
      : sort === 'price-desc'
        ? [-f.sortPrice, ...newest]
        : sort === 'discounts'
          ? [-f.discountedStoreCount, f.sortPrice, ...newest]
          : newest;
  // "Trend" ranks by store count first and keeps the chosen sort within
  // each tier - the same order the listing showed before pagination.
  const primary: SortKey = filter === 'trend' ? [-f.storeCount] : [];
  return [...primary, ...bySort, f.id];
}

function compareKeys(a: SortKey, b: SortKey): number {
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

function countCategories(facts: ProductFacts[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const rule of WOMEN_CATEGORY_RULES) {
    counts[rule.slug] = facts.filter((f) =>
      matchesWomenCategory(f.searchText, rule.slug),
    ).length;
  }
  return counts;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(raw: string, queryKey: string): SortKey {
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
    message: 'cursor does not belong to this sort/filter/category',
  });
}
