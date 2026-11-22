import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, ProductAudience } from '../../generated/prisma/client';
import { FulfilmentEligibilityService } from '../fulfilment/fulfilment-eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  TREND_WEIGHT_FAVORITE,
  TREND_WEIGHT_SOLD,
  TRENDING_WINDOW_DAYS,
} from '../taxonomy/storefront-catalogue';
import {
  SEASONS,
  TaxonomyFilterCodes,
  TaxonomyService,
} from '../taxonomy/taxonomy.service';
import {
  ComparisonCard,
  ComparisonService,
  eligibleProductWhere,
} from './comparison.service';
import {
  DiscoveryBrowseService,
  ProductFacts,
  SortKey,
  compareKeys,
  decodeCursor,
  encodeCursor,
} from './discovery-browse.service';
import {
  clampInt,
  parseBoolean,
  parsePrice,
  parseQuery,
  taxonomyOfferFilter,
  textMatch,
} from './discovery-filters';
import { comparisonCardDto } from './dto/comparison-card.dto';

export const FEED_COLLECTIONS = ['ALL', 'TRENDING', 'NEW', 'DISCOUNT'] as const;
export type FeedCollection = (typeof FEED_COLLECTIONS)[number];
export const FEED_SORTS = [
  'newest',
  'price-asc',
  'price-desc',
  'trending',
] as const;
type FeedSort = (typeof FEED_SORTS)[number];
const DEPARTMENTS: ProductAudience[] = ['WOMEN', 'MEN', 'KIDS'];
/** وصل حديثاً: the product's newest followed-store offer is this recent. */
const NEW_WINDOW_DAYS = 14;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 50;
const MAX_BRANDS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

function bad(code: string, message: string, details: unknown[] = []): never {
  throw new BadRequestException({ code, message, details });
}

function oneOf<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  name: string,
  fallback: T,
): T {
  const value = raw?.trim();
  if (!value) return fallback;
  const match = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
  if (!match) {
    bad(
      `INVALID_${name.toUpperCase()}`,
      `${name} must be one of ${allowed.join(', ')}`,
    );
  }
  return match;
}

/**
 * GET /customers/me/following/feed in browse mode: the products of the
 * stores the SESSION user follows (never a store id from the request),
 * through one server-side pipeline where every selection narrows the
 * previous one -
 *   department (the offer's audience) -> category -> smart collection ->
 *   search -> drawer filters (season/colour/size on one confirmed
 *   offer, brand, price, availability).
 * Eligibility is eligibleProductWhere() restricted to those stores, and
 * the cards, prices, facts and counts all come from the followed stores'
 * offers only - an unfollowed or unpublished store never shows through.
 */
@Injectable()
export class FollowingFeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
    private readonly browse: DiscoveryBrowseService,
    private readonly taxonomy: TaxonomyService,
    private readonly fulfilment: FulfilmentEligibilityService,
  ) {}

  async feed(userId: string, query: Record<string, string | undefined>) {
    const t = await this.taxonomy.get();
    const rawDepartment = query.department?.trim().toUpperCase();
    const department =
      !rawDepartment || rawDepartment === 'ALL'
        ? null
        : (DEPARTMENTS.find((d) => d === rawDepartment) ??
          bad(
            'INVALID_DEPARTMENT',
            `department must be one of ALL, ${DEPARTMENTS.join(', ')}`,
          ));
    const codes = await this.taxonomy.parseFilterCodes({
      audience: department ?? undefined,
      category: query.category,
      season: query.season,
      color: query.color,
      size: query.size,
    });
    if (department) {
      const outside = [...codes.categories].filter(
        (c) => !t.categoryAudiences.get(c)?.has(department),
      );
      if (outside.length) {
        bad(
          'CATEGORY_NOT_IN_AUDIENCE',
          `Category ${outside.join(', ')} does not belong to ${department}`,
          outside,
        );
      }
    }
    const collection = oneOf(
      query.collection,
      FEED_COLLECTIONS,
      'collection',
      'ALL',
    );
    const sort = oneOf<FeedSort>(
      query.sort,
      FEED_SORTS,
      'sort',
      collection === 'TRENDING' ? 'trending' : 'newest',
    );
    const q = parseQuery(query.q);
    const brandIds = (query.brand ?? '')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    if (
      brandIds.length > MAX_BRANDS ||
      brandIds.some((b) => !/^[0-9a-zA-Z-]{1,64}$/.test(b))
    ) {
      bad('INVALID_BRAND', 'brand must be a comma list of brand ids');
    }
    const minPrice = parsePrice(query.min_price, 'min_price');
    const maxPrice = parsePrice(query.max_price, 'max_price');
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
      bad('INVALID_PRICE_FILTER', 'min_price must not exceed max_price');
    }
    const availableOnly = parseBoolean(query.available_only, 'available_only');
    const pageSize = clampInt(
      query.page_size,
      DEFAULT_PAGE_SIZE,
      1,
      MAX_PAGE_SIZE,
    );
    const queryKey = JSON.stringify([
      department,
      [...codes.categories].sort(),
      [...codes.seasons].sort(),
      [...codes.colors].sort(),
      [...codes.sizes].sort(),
      collection,
      sort,
      q,
      [...brandIds].sort(),
      minPrice,
      maxPrice,
      availableOnly,
    ]);
    const after = query.cursor?.trim()
      ? decodeCursor(query.cursor.trim(), queryKey)
      : null;

    const follows = await this.prisma.storeFollow.findMany({
      where: {
        userId,
        vendor: { storefrontPublished: true, status: 'ACTIVE' },
      },
      select: { vendorId: true },
    });
    const vendorIds = follows.map((f) => f.vendorId);
    const head = {
      followed_store_count: vendorIds.length,
      department: department ?? 'ALL',
      category: [...codes.categories][0] ?? null,
      collection,
      sort,
      page_size: pageSize,
    };
    if (vendorIds.length === 0) {
      return {
        ...head,
        total: 0,
        items: [],
        next_cursor: null,
        department_counts: { ALL: 0, WOMEN: 0, MEN: 0, KIDS: 0 },
        categories: [],
        collection_counts: { ALL: 0, TRENDING: 0, NEW: 0, DISCOUNT: 0 },
        filter_options: {
          colors: [],
          sizes: [],
          seasons: [],
          brands: [],
          price: null,
        },
      };
    }
    const vendorFilter: Prisma.VendorWhereInput = { id: { in: vendorIds } };

    const none = new Set<string>();
    const scopeCodes = (
      c: Partial<TaxonomyFilterCodes>,
    ): TaxonomyFilterCodes => ({
      ...codes,
      ...c,
    });
    const productWhere = async (
      c: TaxonomyFilterCodes,
      withDrawer: boolean,
    ): Promise<Prisma.CanonicalProductWhereInput> => {
      const offerFilter = await taxonomyOfferFilter(
        this.prisma,
        this.fulfilment,
        c,
        vendorFilter,
      );
      return {
        AND: [
          eligibleProductWhere(vendorFilter, offerFilter),
          ...(q ? [textMatch(q)] : []),
          ...(withDrawer && brandIds.length
            ? [{ brandId: { in: brandIds } }]
            : []),
        ],
      };
    };
    const facts = async (
      where: Prisma.CanonicalProductWhereInput,
      drawer: boolean,
    ) => {
      const all = await this.browse.factsFor(
        await this.browse.ids(where),
        vendorIds,
      );
      return drawer
        ? all.filter(
            (f) =>
              (minPrice === null || f.sortPrice >= minPrice) &&
              (maxPrice === null || f.sortPrice <= maxPrice) &&
              (!availableOnly || f.availableOfferCount > 0),
          )
        : all;
    };

    // full = every filter; noCategory / noDepartment drop only their own
    // dimension (a facet never narrows its own options); scope is the
    // department + category + search the drawer's options come from.
    const noCategoryCodes = scopeCodes({ categories: none });
    const noDepartmentCodes = scopeCodes({ audiences: none, categories: none });
    const scopeOnlyCodes: TaxonomyFilterCodes = {
      audiences: codes.audiences,
      categories: codes.categories,
      seasons: none,
      colors: none,
      sizes: none,
    };
    const [full, noCategory, noDepartment, scope] = await Promise.all([
      productWhere(codes, true).then((w) => facts(w, true)),
      department
        ? productWhere(noCategoryCodes, true).then((w) => facts(w, true))
        : Promise.resolve([] as ProductFacts[]),
      productWhere(noDepartmentCodes, true).then((w) => facts(w, true)),
      productWhere(scopeOnlyCodes, false).then((w) => facts(w, false)),
    ]);

    const now = Date.now();
    const trend = await this.trendScores(
      [...new Set([...noDepartment, ...full].map((f) => f.id))],
      vendorIds,
      new Date(now),
    );
    const inCollection = (f: ProductFacts, c: FeedCollection) =>
      c === 'ALL'
        ? true
        : c === 'NEW'
          ? f.addedAt >= now - NEW_WINDOW_DAYS * DAY_MS
          : c === 'DISCOUNT'
            ? f.discountedStoreCount > 0
            : (trend.get(f.id) ?? 0) > 0;

    const matching = full.filter((f) => inCollection(f, collection));
    const keyOf = (f: ProductFacts): SortKey => {
      const newest: SortKey = [-f.addedAt];
      const primary: SortKey =
        sort === 'price-asc'
          ? [f.sortPrice]
          : sort === 'price-desc'
            ? [-f.sortPrice]
            : sort === 'trending'
              ? [-(trend.get(f.id) ?? 0)]
              : [];
      return [...primary, ...newest, f.id];
    };
    const ordered = matching
      .map((f) => ({ f, key: keyOf(f) }))
      .sort((a, b) => compareKeys(a.key, b.key));
    const start = after
      ? ordered.findIndex((row) => compareKeys(row.key, after) > 0)
      : 0;
    const remaining = start === -1 ? [] : ordered.slice(start);
    const page = remaining.slice(0, pageSize);
    const pageIds = page.map((row) => row.f.id);
    // The card itself is built from the followed stores' offers only.
    const cards: ComparisonCard[] = pageIds.length
      ? (
          await this.comparison.listCards(
            { id: { in: pageIds } },
            1,
            pageIds.length,
            vendorFilter,
          )
        ).cards
      : [];
    const byId = new Map(cards.map((card) => [card.canonicalProductId, card]));
    const last = page[page.length - 1];

    const collectionCounts = Object.fromEntries(
      FEED_COLLECTIONS.map((c) => [
        c,
        full.filter((f) => inCollection(f, c)).length,
      ]),
    ) as Record<FeedCollection, number>;

    return {
      ...head,
      total: matching.length,
      items: pageIds
        .map((id) => byId.get(id))
        .filter((card): card is ComparisonCard => card !== undefined)
        .map(comparisonCardDto),
      next_cursor:
        remaining.length > page.length && last
          ? encodeCursor({ q: queryKey, k: last.key })
          : null,
      department_counts: await this.departmentCounts(
        noDepartment
          .filter((f) => inCollection(f, collection))
          .map((f) => f.id),
        noDepartmentCodes,
        vendorFilter,
      ),
      categories: department
        ? await this.categories(
            department,
            noCategory
              .filter((f) => inCollection(f, collection))
              .map((f) => f.id),
            noCategoryCodes,
            vendorFilter,
            codes.categories,
          )
        : [],
      collection_counts: collectionCounts,
      filter_options: await this.filterOptions(
        scope,
        scopeOnlyCodes,
        vendorFilter,
      ),
    };
  }

  /** Products per department among `ids`, on one confirmed followed-store
   * offer that also meets the other filters (the listing's own rule). */
  private async departmentCounts(
    ids: string[],
    otherCodes: TaxonomyFilterCodes,
    vendorFilter: Prisma.VendorWhereInput,
  ) {
    const counts: Record<'ALL' | ProductAudience, number> = {
      ALL: ids.length,
      WOMEN: 0,
      MEN: 0,
      KIDS: 0,
    };
    if (!ids.length) return counts;
    const offerFilter = await taxonomyOfferFilter(
      this.prisma,
      this.fulfilment,
      otherCodes,
      vendorFilter,
    );
    const rows = await this.prisma.offerVariant.findMany({
      where: {
        AND: [
          {
            canonicalVariant: { canonicalProductId: { in: ids } },
            vendorOffer: { status: 'ACTIVE', audiences: { some: {} } },
            vendor: {
              AND: [
                { storefrontPublished: true, status: 'ACTIVE' },
                vendorFilter,
              ],
            },
          },
          offerFilter,
        ],
      },
      select: {
        canonicalVariant: { select: { canonicalProductId: true } },
        vendorOffer: { select: { audiences: { select: { audience: true } } } },
      },
    });
    const byAudience = new Map<ProductAudience, Set<string>>();
    for (const row of rows) {
      const id = row.canonicalVariant?.canonicalProductId;
      if (!id) continue;
      for (const { audience } of row.vendorOffer.audiences) {
        const set = byAudience.get(audience) ?? new Set<string>();
        set.add(id);
        byAudience.set(audience, set);
      }
    }
    for (const d of DEPARTMENTS) counts[d] = byAudience.get(d)?.size ?? 0;
    return counts;
  }

  /** The department's categories that really have products here (plus
   * the selected one, even at 0, so it can be cleared). */
  private async categories(
    department: ProductAudience,
    ids: string[],
    otherCodes: TaxonomyFilterCodes,
    vendorFilter: Prisma.VendorWhereInput,
    selected: Set<string>,
  ) {
    const t = await this.taxonomy.get();
    const own = t.categories.filter((c) => c.audiences.includes(department));
    const offerFilter = await taxonomyOfferFilter(
      this.prisma,
      this.fulfilment,
      otherCodes,
      vendorFilter,
    );
    const counts = await this.browse.categoryCounts(ids, {
      whereWithoutCategory: {},
      offerWhereWithoutCategory: {
        AND: [{ vendor: vendorFilter }, offerFilter],
      },
      categoryCodes: own.map((c) => c.code),
    });
    return own
      .filter((c) => (counts[c.code] ?? 0) > 0 || selected.has(c.code))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => ({
        code: c.code,
        name_ar: c.nameAr,
        name_en: c.nameEn,
        count: counts[c.code] ?? 0,
      }));
  }

  /** The drawer's choices: only values the followed stores' products in
   * the current department/category/search really have. */
  private async filterOptions(
    scope: ProductFacts[],
    scopeCodes: TaxonomyFilterCodes,
    vendorFilter: Prisma.VendorWhereInput,
  ) {
    const t = await this.taxonomy.get();
    const ids = scope.map((f) => f.id);
    if (!ids.length)
      return { colors: [], sizes: [], seasons: [], brands: [], price: null };
    const offerFilter = await taxonomyOfferFilter(
      this.prisma,
      this.fulfilment,
      scopeCodes,
      vendorFilter,
    );
    const [variants, products] = await Promise.all([
      this.prisma.offerVariant.findMany({
        where: {
          AND: [
            {
              canonicalVariant: { canonicalProductId: { in: ids } },
              vendorOffer: { status: 'ACTIVE' },
              vendor: {
                AND: [
                  { storefrontPublished: true, status: 'ACTIVE' },
                  vendorFilter,
                ],
              },
            },
            offerFilter,
          ],
        },
        select: {
          isCombination: true,
          colorCode: true,
          sizeCode: true,
          branchStocks: { select: { quantity: true } },
          vendorOffer: { select: { season: true } },
        },
      }),
      this.prisma.canonicalProduct.findMany({
        where: { id: { in: ids } },
        select: { brand: { select: { id: true, name: true } } },
      }),
    ]);
    const colors = new Set<string>();
    const sizes = new Set<string>();
    const seasons = new Set<string>();
    for (const v of variants) {
      if (v.vendorOffer.season) seasons.add(v.vendorOffer.season);
      if (!v.isCombination || !v.branchStocks.some((s) => s.quantity > 0))
        continue;
      if (v.colorCode) colors.add(v.colorCode);
      if (v.sizeCode) sizes.add(v.sizeCode);
    }
    const brands = new Map(products.map((p) => [p.brand.id, p.brand.name]));
    const prices = scope.map((f) => f.sortPrice);
    return {
      colors: t.colors
        .filter((c) => colors.has(c.code))
        .map((c) => ({
          code: c.code,
          name_ar: c.nameAr,
          name_en: c.nameEn,
          hex: c.hex,
        })),
      sizes: t.sizes
        .filter((s) => sizes.has(s.code))
        .map((s) => ({ code: s.code, label: s.label, group: s.group })),
      seasons: SEASONS.filter((s) => seasons.has(s.code)).map((s) => ({
        code: s.code,
        name_ar: s.nameAr,
        name_en: s.nameEn,
      })),
      brands: [...brands]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      price: {
        min: Math.floor(Math.min(...prices)),
        max: Math.ceil(Math.max(...prices)),
      },
    };
  }

  /**
   * الترند within the followed stores, per product, over the last 30 days:
   * units sold there (cancelled lines/orders excluded) x3, plus
   * favourites of the product or of one of those stores' offers of it -
   * the same signal and weights as a store page's trending.
   */
  private async trendScores(ids: string[], vendorIds: string[], now: Date) {
    if (!ids.length) return new Map<string, number>();
    const since = new Date(now.getTime() - TRENDING_WINDOW_DAYS * DAY_MS);
    const rows = await this.prisma.$queryRaw<{ id: string; score: number }[]>`
      WITH signals AS (
        SELECT cpv."canonicalProductId" AS id, ${TREND_WEIGHT_SOLD} * SUM(boi.quantity)::float8 AS score
        FROM branch_order_items boi
        JOIN branch_orders bo ON bo.id = boi."branchOrderId"
        JOIN offer_variants ov ON ov.id = boi."offerVariantId"
        JOIN canonical_product_variants cpv ON cpv.id = ov."canonicalVariantId"
        WHERE ov."vendorId" = ANY(${vendorIds}::text[])
          AND cpv."canonicalProductId" = ANY(${ids}::text[])
          AND boi."cancelledAt" IS NULL
          AND boi."createdAt" >= ${since}
          AND bo.status NOT IN ('CANCELLED', 'REFUNDED')
        GROUP BY 1
        UNION ALL
        SELECT f."canonicalProductId", ${TREND_WEIGHT_FAVORITE} * COUNT(*)::float8
        FROM favorites f
        WHERE f."targetType" = 'PRODUCT'
          AND f."canonicalProductId" = ANY(${ids}::text[])
          AND f."createdAt" >= ${since}
        GROUP BY 1
        UNION ALL
        SELECT cpv."canonicalProductId", ${TREND_WEIGHT_FAVORITE} * COUNT(*)::float8
        FROM favorites f
        JOIN offer_variants ov ON ov.id = f."offerVariantId"
        JOIN canonical_product_variants cpv ON cpv.id = ov."canonicalVariantId"
        WHERE f."targetType" = 'OFFER'
          AND ov."vendorId" = ANY(${vendorIds}::text[])
          AND cpv."canonicalProductId" = ANY(${ids}::text[])
          AND f."createdAt" >= ${since}
        GROUP BY 1
      )
      SELECT id, SUM(score)::float8 AS score FROM signals GROUP BY id
    `;
    return new Map(rows.map((r) => [r.id, Number(r.score)]));
  }
}
