import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import {
  Prisma,
  ProductAudience,
  StoreApplicableCategory,
} from '../../generated/prisma/client';
import { FulfilmentEligibilityService } from '../fulfilment/fulfilment-eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { ComparisonService, eligibleProductWhere } from './comparison.service';
import {
  BROWSE_FILTERS,
  BROWSE_SORTS,
  BrowseFilter,
  BrowseParams,
  BrowseSort,
  DiscoveryBrowseService,
} from './discovery-browse.service';
import {
  clampInt,
  parseBoolean,
  parseEnum,
  parsePrice,
  parseQuery,
  taxonomyOfferFilter,
  textMatch,
} from './discovery-filters';
import { comparisonCardDto } from './dto/comparison-card.dto';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const SEGMENTS: Record<string, StoreApplicableCategory> = {
  women: 'WOMEN',
  men: 'MEN',
  kids: 'KIDS',
  accessories: 'ACCESSORIES',
};

function parseSegment(raw: string | undefined): StoreApplicableCategory | null {
  if (raw === undefined || raw === '' || raw === 'all') return null;
  const segment = SEGMENTS[raw.toLowerCase()];
  if (!segment) {
    throw new BadRequestException({
      code: 'INVALID_SEGMENT',
      message: 'segment must be one of women, men, kids, accessories',
    });
  }
  return segment;
}

// Sprint 8 (RB-STOREF-004, PDR-013/014): public discovery. Sprint 13
// adds two read-only narrowing filters on the same eligible-product
// rule (never a second competing definition of "eligible"):
//  - `segment` (women|men|kids|accessories): only products with an
//    eligible offer from a store that declared that applicable category
//    (PDR-013: stores choose their types; the All page mixes them).
//  - `q`: case-insensitive match on the canonical name (AR/EN), model,
//    brand or category name.
// Ordering stays newest-first (RB-COMP-002's ranking is still deferred).
// Sprint 27 adds the product-taxonomy filters (audience, category,
// season, color, size - each a comma list: OR inside one, AND across),
// all applied to ONE confirmed offer variant of the product, so a card
// is never assembled from one store's audience and another's colour.
// Only classified offers can satisfy them; colour/size additionally
// need that very combination in stock right now (live reservations
// subtracted, as on every public surface).
// Browse mode (sort/filter/min_price/max_price/available_only/cursor/
// facets) serves the women/men/kids listings, which pass
// audience=WOMEN|MEN|KIDS - the product's own audience; `segment` keeps
// its store-level meaning everywhere.
@Controller('discovery')
export class DiscoveryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
    private readonly taxonomy: TaxonomyService,
    private readonly browse: DiscoveryBrowseService,
    private readonly fulfilment: FulfilmentEligibilityService,
  ) {}

  @Get('all')
  async listAll(
    @Query('page') pageRaw?: string,
    @Query('page_size') pageSizeRaw?: string,
    @Query('segment') segmentRaw?: string,
    @Query('q') qRaw?: string,
    @Query('audience') audience?: string,
    @Query('category') category?: string,
    @Query('season') season?: string,
    @Query('color') color?: string,
    @Query('size') size?: string,
    @Query('sort') sortRaw?: string,
    @Query('filter') filterRaw?: string,
    @Query('min_price') minPriceRaw?: string,
    @Query('max_price') maxPriceRaw?: string,
    @Query('available_only') availableOnlyRaw?: string,
    @Query('cursor') cursorRaw?: string,
    @Query('facets') facetsRaw?: string,
  ) {
    const page = clampInt(pageRaw, 1, 1, 1_000_000);
    const pageSize = clampInt(pageSizeRaw, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const segment = parseSegment(segmentRaw);
    const q = parseQuery(qRaw);
    const codes = await this.taxonomy.parseFilterCodes({
      audience,
      category,
      season,
      color,
      size,
    });

    const vendorFilter: Prisma.VendorWhereInput = segment
      ? { applicableCategories: { some: { category: segment } } }
      : {};
    const productWhere = (
      offerFilter: Prisma.OfferVariantWhereInput,
    ): Prisma.CanonicalProductWhereInput => {
      const base = eligibleProductWhere(vendorFilter, offerFilter);
      return q ? { AND: [base, textMatch(q)] } : base;
    };
    const where = productWhere(
      await taxonomyOfferFilter(
        this.prisma,
        this.fulfilment,
        codes,
        vendorFilter,
      ),
    );

    // Browse mode (the women/men/kids listings): opt-in via any of these
    // params. Server-side price/availability filtering, sort, cursor
    // pagination and taxonomy category counts over the same `where`;
    // without them the classic page/page_size response below is
    // unchanged.
    const browsing = [
      sortRaw,
      filterRaw,
      minPriceRaw,
      maxPriceRaw,
      availableOnlyRaw,
      cursorRaw,
      facetsRaw,
    ].some((v) => v !== undefined && v !== '');
    if (browsing) {
      const sort =
        parseEnum<BrowseSort>(sortRaw, BROWSE_SORTS, 'sort') ?? 'newest';
      const filter = parseEnum<BrowseFilter>(
        filterRaw,
        BROWSE_FILTERS,
        'filter',
      );
      const minPrice = parsePrice(minPriceRaw, 'min_price');
      const maxPrice = parsePrice(maxPriceRaw, 'max_price');
      if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
        throw new BadRequestException({
          code: 'INVALID_PRICE_FILTER',
          message: 'min_price must not exceed max_price',
        });
      }
      const availableOnly = parseBoolean(availableOnlyRaw, 'available_only');
      const withFacets =
        parseEnum(facetsRaw, ['categories'] as const, 'facets') !== null;

      let facets: BrowseParams['facets'];
      if (withFacets) {
        // Counts ignore the category selection itself (a facet never
        // narrows its own options) but honour every other filter.
        const offerFilter = await taxonomyOfferFilter(
          this.prisma,
          this.fulfilment,

          { ...codes, categories: new Set<string>() },
          vendorFilter,
        );
        const t = await this.taxonomy.get();
        facets = {
          whereWithoutCategory: productWhere(offerFilter),
          offerWhereWithoutCategory: {
            AND: [{ vendor: vendorFilter }, offerFilter],
          },
          categoryCodes: [...t.categoryAudiences.entries()]
            .filter(
              ([, audiences]) =>
                codes.audiences.size === 0 ||
                [...audiences].some((a) => codes.audiences.has(a)),
            )
            .map(([code]) => code),
        };
      }

      return this.browse.browse({
        where,
        facets,
        queryKey: JSON.stringify([
          segment,
          q,
          ...[
            codes.audiences,
            codes.categories,
            codes.seasons,
            codes.colors,
            codes.sizes,
          ].map((set) => [...set].sort()),
          sort,
          filter,
          minPrice,
          maxPrice,
          availableOnly,
        ]),
        pageSize,
        sort,
        filter,
        minPrice,
        maxPrice,
        availableOnly,
        cursor: cursorRaw?.trim() || null,
        bestsellerScope: {
          audiences: [...codes.audiences] as ProductAudience[],
          categories: [...codes.categories],
        },
      });
    }

    const { total, cards } = await this.comparison.listCards(
      where,
      page,
      pageSize,
    );

    return {
      page,
      page_size: pageSize,
      total,
      items: cards.map(comparisonCardDto),
    };
  }

  // Sprint 13: public store search/listing - identity fields only, and
  // only stores that are published AND ACTIVE (an unavailable store is
  // still reachable by its own URL, but is never surfaced by discovery).
  @Get('stores')
  async listStores(
    @Query('segment') segmentRaw?: string,
    @Query('q') qRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const segment = parseSegment(segmentRaw);
    const q = parseQuery(qRaw);
    const limit = clampInt(limitRaw, 24, 1, 50);

    const stores = await this.prisma.vendor.findMany({
      where: {
        storefrontPublished: true,
        status: 'ACTIVE',
        ...(segment
          ? { applicableCategories: { some: { category: segment } } }
          : {}),
        ...(q
          ? {
              OR: [
                { displayName: { contains: q, mode: 'insensitive' } },
                { legalName: { contains: q, mode: 'insensitive' } },
                { bio: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        slug: true,
        displayName: true,
        legalName: true,
        logoUrl: true,
        bio: true,
      },
    });

    return {
      items: stores.map((s) => ({
        slug: s.slug,
        display_name: s.displayName ?? s.legalName,
        logo_url: s.logoUrl,
        bio: s.bio,
      })),
    };
  }
}
