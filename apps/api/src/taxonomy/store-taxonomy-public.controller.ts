import { normalizeColorName } from '../offers/color-name';
import {
  productColorView,
  productOptionChoices,
} from '../offers/public-offer-view';
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { optionalSessionUserId } from '../auth/optional-session';
import { SessionService } from '../auth/session.service';
import { FulfilmentEligibilityService } from '../fulfilment/fulfilment-eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CatalogFilters,
  computeFacets,
  matchesFilters,
} from './store-catalog.util';
import { storeDepartments, trendScores } from './storefront-catalogue';
import { AUDIENCES, SEASONS, TaxonomyService } from './taxonomy.service';
import { SalesRankReadService } from '../sales-rank/sales-rank-read.service';
import { StoreCatalogService } from './store-catalog.service';

const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;
// PD-5.3: 'bestseller' - qualified bestsellers first, only while the flag is on.
/** PD-5.4: «نسّقي معه» shows only with at least this many eligible picks. */
const MIN_PAIRINGS_SHOWN = 2;

const SORTS = [
  'newest',
  'price_asc',
  'price_desc',
  'trending',
  'bestseller',
] as const;
// The smart buttons: one mode at a time, on top of the department /
// category scope (وصل حديثاً = NEW, تخفيضات = DISCOUNT, الترند = TRENDING).
const COLLECTIONS = ['ALL', 'TRENDING', 'NEW', 'DISCOUNT'] as const;
type Collection = (typeof COLLECTIONS)[number];
const MAX_SEARCH_LENGTH = 80;
type Sort = (typeof SORTS)[number];

function price(raw: string | undefined, field: string): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new BadRequestException({
      code: 'INVALID_PRICE_FILTER',
      message: `${field} must be a non-negative number`,
    });
  }
  return n;
}

function flag(raw: string | undefined, name: string): boolean {
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0')
    return false;
  if (raw === 'true' || raw === '1') return true;
  throw new BadRequestException({
    code: `INVALID_${name.toUpperCase()}`,
    message: `${name} must be true or false`,
  });
}

function int(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Sprint 27: the customer's product browsing for one store, filtered by
// the fixed taxonomy - a NEW endpoint beside GET /storefronts/:slug/
// sections, which stays exactly as it is. Store Sections and taxonomy
// combine through ?section= (all | new | sale | <custom section id>).
// Public and unauthenticated, like every other storefronts/:slug read;
// exact stock is never exposed (availability buckets only).
@Controller('storefronts/:slug')
export class StoreTaxonomyPublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly fulfilment: FulfilmentEligibilityService,
    private readonly salesRank: SalesRankReadService,
    private readonly sessions: SessionService,
    private readonly catalog: StoreCatalogService,
  ) {}

  private async requireVendor(slug: string) {
    const vendor = await this.prisma.vendor.findUnique({ where: { slug } });
    if (!vendor) {
      throw new NotFoundException({
        code: 'STOREFRONT_NOT_FOUND',
        message: 'No store found for this URL',
      });
    }
    return {
      vendor,
      isAvailable: vendor.storefrontPublished && vendor.status === 'ACTIVE',
    };
  }

  private async parseFilters(q: Record<string, string | undefined>) {
    const t = await this.taxonomy.get();
    const audience =
      q.audience?.trim().toUpperCase() === 'ALL' ? undefined : q.audience;
    const codes = await this.taxonomy.parseFilterCodes({ ...q, audience });
    // A detailed category never reaches outside the chosen department:
    // MEN + GIRLS_DRESSES is a contradiction, refused rather than
    // silently answered with nothing (or with another department).
    if (codes.audiences.size > 0) {
      const outside = [...codes.categories].filter(
        (c) =>
          ![...codes.audiences].some((a) =>
            t.categoryAudiences.get(c)?.has(a as never),
          ),
      );
      if (outside.length) {
        throw new BadRequestException({
          code: 'CATEGORY_NOT_IN_AUDIENCE',
          message: `Category ${outside.join(', ')} does not belong to ${[...codes.audiences].join(', ')}`,
          details: outside,
        });
      }
    }
    const filters: CatalogFilters = {
      ...codes,
      minPrice: price(q.min_price, 'min_price'),
      maxPrice: price(q.max_price, 'max_price'),
    };
    if (
      filters.minPrice !== null &&
      filters.maxPrice !== null &&
      filters.minPrice > filters.maxPrice
    ) {
      throw new BadRequestException({
        code: 'INVALID_PRICE_FILTER',
        message: 'min_price must not exceed max_price',
      });
    }
    return { filters, t };
  }

  /** Every ACTIVE offer of the store, with live availability per variant (StoreCatalogService). */
  private loadCatalog(vendorId: string) {
    return this.catalog.load(vendorId);
  }

  /**
   * GET /storefronts/:slug/products - the store's ACTIVE products, filtered
   * by section (all/new/sale/<custom section id>) and the taxonomy, with
   * facets of the values still available. Sold-out combinations never
   * count; colour and size are matched on one combination together.
   */
  /**
   * «مجموعات المتجر» - GET /storefronts/:slug/store-collections: the store's
   * own collections a shopper can open, in the owner's order: visible ones
   * with at least one product that can be bought now (published, in stock in
   * a sellable branch). A hidden or empty collection is simply absent.
   */
  @Get('store-collections')
  async storeCollections(@Param('slug') slug: string) {
    const { vendor, isAvailable } = await this.requireVendor(slug);
    if (!isAvailable) return { items: [] };
    const [sections, all] = await Promise.all([
      this.prisma.storeSection.findMany({
        where: { vendorId: vendor.id, isVisible: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, nameEn: true, coverUrl: true },
      }),
      this.loadCatalog(vendor.id),
    ]);
    const counts = new Map<string, number>();
    for (const o of all) {
      if (o.available <= 0) continue;
      for (const id of o.sectionIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return {
      items: sections
        .filter((s) => (counts.get(s.id) ?? 0) > 0)
        .map((s) => ({
          id: s.id,
          name_ar: s.name,
          name_en: s.nameEn,
          cover_url: s.coverUrl,
          count: counts.get(s.id) ?? 0,
        })),
    };
  }

  @Get('products')
  async products(
    @Param('slug') slug: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    const { vendor, isAvailable } = await this.requireVendor(slug);
    const { filters, t } = await this.parseFilters(query);
    const section = query.section?.trim() || 'all';
    const collection = (query.collection?.trim().toUpperCase() ||
      'ALL') as Collection;
    if (!COLLECTIONS.includes(collection)) {
      throw new BadRequestException({
        code: 'INVALID_COLLECTION',
        message: `collection must be one of ${COLLECTIONS.join(', ')}`,
      });
    }
    // Trending products are listed by their trend by default.
    const sort = (query.sort?.trim() ||
      (collection === 'TRENDING' ? 'trending' : 'newest')) as Sort;
    const search = (query.q ?? '')
      .trim()
      .toLowerCase()
      .slice(0, MAX_SEARCH_LENGTH);
    const availableOnly = flag(query.available_only, 'available_only');
    if (!SORTS.includes(sort)) {
      throw new BadRequestException({
        code: 'INVALID_SORT',
        message: `sort must be one of ${SORTS.join(', ')}`,
      });
    }
    // «مجموعات المتجر»: a hidden collection is refused like an unknown one
    // (its existence is not confirmed to shoppers).
    const isCustomSection = !['all', 'new', 'sale'].includes(section);
    if (isCustomSection) {
      const exists = await this.prisma.storeSection.findFirst({
        where: { id: section, vendorId: vendor.id, isVisible: true },
        select: { id: true },
      });
      if (!exists) {
        throw new BadRequestException({
          code: 'UNKNOWN_SECTION',
          message:
            "section must be all, new, sale or one of this store's section ids",
        });
      }
    }
    if (sort === 'bestseller') await this.salesRank.assertSortAvailable();
    const bestsellerEnabled = await this.salesRank.enabled();
    const page = int(query.page, 1, 1, 100_000);
    const pageSize = int(query.page_size, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

    const order = {
      audiences: AUDIENCES.map((a) => a.code),
      categories: t.categories.map((c) => c.code),
      seasons: SEASONS.map((s) => s.code),
      colors: t.colors.map((c) => c.code),
      sizes: t.sizes.map((s) => s.code),
      categoryAudiences: t.categoryAudiences as Map<string, Set<string>>,
    };
    const departments = await storeDepartments(this.prisma, vendor.id, t);
    const emptyCounts = { ALL: 0, TRENDING: 0, NEW: 0, DISCOUNT: 0 };
    if (!isAvailable) {
      return {
        is_available: false,
        section,
        collection,
        total: 0,
        store_total: 0,
        page,
        page_size: pageSize,
        items: [],
        collection_counts: emptyCounts,
        bestseller_enabled: bestsellerEnabled,
        departments,
        facets: computeFacets([], filters, order),
      };
    }

    const [all, trend] = await Promise.all([
      this.loadCatalog(vendor.id),
      trendScores(this.prisma, vendor.id),
    ]);
    const scoreOf = (o: (typeof all)[number]) => trend.get(o.catalog.id) ?? 0;
    const inCollection = (o: (typeof all)[number], c: Collection) =>
      c === 'ALL'
        ? true
        : c === 'NEW'
          ? o.isNew
          : c === 'DISCOUNT'
            ? o.isSale
            : scoreOf(o) > 0;
    // Every selection narrows the previous one (AND): store section,
    // then the search and availability, then the taxonomy filters
    // (department, category, season, colour+size on one combination,
    // price), then the smart collection.
    const inSection = all.filter((o) =>
      section === 'all'
        ? true
        : section === 'new'
          ? o.isNew
          : section === 'sale'
            ? o.isSale
            : o.sectionIds.has(section),
    );
    const scoped = inSection.filter(
      (o) =>
        (!search ||
          o.search.includes(search) ||
          o.search.includes(normalizeColorName(search))) &&
        // in the store's own collection only what can be bought shows (a
        // sold-out product stays linked, it is just not shown)
        (!(availableOnly || isCustomSection) || o.available > 0),
    );
    const filtered = scoped.filter((o) => matchesFilters(o.catalog, filters));
    const matched = filtered.filter((o) => inCollection(o, collection));
    const priceOf = (o: (typeof all)[number]) => o.catalog.minPrice ?? Infinity;
    // the owner's own order inside her collection, unless a sort is asked for
    if (isCustomSection && !query.sort?.trim()) {
      const pos = (o: (typeof all)[number]) =>
        o.sectionOrder.get(section) ?? Number.MAX_SAFE_INTEGER;
      matched.sort((a, b) => pos(a) - pos(b));
    }
    if (sort === 'price_asc') matched.sort((a, b) => priceOf(a) - priceOf(b));
    if (sort === 'price_desc') matched.sort((a, b) => priceOf(b) - priceOf(a));
    // Stable: equal scores keep the newest-first order.
    if (sort === 'trending') matched.sort((a, b) => scoreOf(b) - scoreOf(a));
    // PD-5.3: this store's qualified bestsellers first, by their best
    // qualified position; the rest keep the newest-first order (stable).
    if (sort === 'bestseller') {
      const order = await this.salesRank.offerOrder(vendor.id);
      const pos = (o: (typeof all)[number]) =>
        order.get(o.catalog.id)?.position ?? Number.MAX_SAFE_INTEGER;
      matched.sort((a, b) => pos(a) - pos(b));
    }
    const collectionCounts = Object.fromEntries(
      COLLECTIONS.map((c) => [
        c,
        filtered.filter((o) => inCollection(o, c)).length,
      ]),
    );

    const items = matched
      .slice((page - 1) * pageSize, page * pageSize)
      .map((o) => {
        const inStock = o.catalog.combinations.filter((c) => c.available > 0);
        return {
          ...o.card,
          colors: [...new Set(inStock.map((c) => c.colorCode).filter(Boolean))],
          sizes: [...new Set(inStock.map((c) => c.sizeCode).filter(Boolean))],
        };
      });
    return {
      is_available: true,
      section,
      collection,
      total: matched.length,
      store_total: all.length,
      page,
      page_size: pageSize,
      items,
      collection_counts: collectionCounts,
      bestseller_enabled: bestsellerEnabled,
      departments,
      facets: computeFacets(
        scoped.filter((o) => inCollection(o, collection)).map((o) => o.catalog),
        filters,
        order,
      ),
    };
  }

  /**
   * GET /storefronts/:slug/offers/:offerId/options - what a customer can
   * pick on the product page: the in-stock combinations only (a colour
   * whose every size is sold out is simply absent), each with its
   * availability bucket, and the ONE price that does not change with the
   * choice. A legacy (unclassified) offer answers classified: false with
   * no combinations - the existing offer detail still serves its variants.
   */
  /**
   * PD-5.4 - GET /storefronts/:slug/offers/:offerId/pairings: «نسّقي معه»,
   * the owner's own picks for this offer, re-checked now: each paired
   * offer ACTIVE, the store able to sell (published, active, active
   * subscription), in stock in a sellable branch, and - for the shopper's
   * zone (request, else default address; never GPS) - deliverable there
   * or available for pickup (the same PD-2/PD-5.1 facts checkout uses).
   * Fewer than 2 left -> no items (the page shows no section). Cards are
   * the store page's own card fields; no branch or quantity is exposed.
   */
  @Get('offers/:offerId/pairings')
  async pairings(
    @Param('slug') slug: string,
    @Param('offerId') offerId: string,
    @Query('zone') zoneRaw: string | undefined,
    @Req() req: Request,
  ) {
    const { vendor, isAvailable } = await this.requireVendor(slug);
    const primary = await this.prisma.vendorOffer.findFirst({
      where: { id: offerId, vendorId: vendor.id, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!isAvailable || !primary) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
    const empty = { items: [] as unknown[] };
    const links = await this.prisma.offerPairing.findMany({
      where: { vendorId: vendor.id, offerId },
      orderBy: { sortOrder: 'asc' },
      select: { pairedOfferId: true },
    });
    const ids = links
      .map((l) => l.pairedOfferId)
      .filter((id) => id !== offerId);
    if (ids.length < MIN_PAIRINGS_SHOWN) return empty;
    if (
      !(await this.fulfilment.purchasableVendorIds([vendor.id])).has(vendor.id)
    )
      return empty;

    // The store page's own catalogue (ACTIVE offers, live availability).
    const catalog = new Map(
      (await this.loadCatalog(vendor.id)).map((o) => [o.catalog.id, o]),
    );
    const candidates = ids
      .map((id) => catalog.get(id))
      .filter((o): o is NonNullable<typeof o> => !!o && o.available > 0);
    if (candidates.length < MIN_PAIRINGS_SHOWN) return empty;

    const zone = (
      await this.fulfilment.resolveZone(
        zoneRaw,
        await optionalSessionUserId(this.sessions, this.prisma, req),
      )
    ).zone;
    const variants = await this.prisma.offerVariant.findMany({
      where: { vendorOfferId: { in: candidates.map((o) => o.catalog.id) } },
      select: { id: true, vendorOfferId: true },
    });
    // PD-5b.2: the shared rule (FulfilmentEligibilityService).
    const reachableVariants = await this.fulfilment.reachableVariantIds(
      variants.map((v) => ({ id: v.id, vendorId: vendor.id })),
      zone,
    );
    const reachable = new Set(
      variants
        .filter((v) => reachableVariants.has(v.id))
        .map((v) => v.vendorOfferId),
    );
    const items = candidates
      .filter((o) => reachable.has(o.catalog.id))
      .map((o) => ({
        id: o.card.id,
        title_ar: o.card.title_ar,
        title_en: o.card.title_en,
        min_price: o.card.min_price,
        original_price: o.card.original_price,
        discount_percent: o.card.discount_percent,
        availability: o.card.availability,
        image_url: o.card.image_url,
        favorite_variant_id: o.card.favorite_variant_id,
      }));
    return items.length < MIN_PAIRINGS_SHOWN ? empty : { items };
  }

  @Get('offers/:offerId/options')
  async options(
    @Param('slug') slug: string,
    @Param('offerId') offerId: string,
  ) {
    const { vendor, isAvailable } = await this.requireVendor(slug);
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
      select: { vendorId: true, status: true },
    });
    if (
      !offer ||
      offer.vendorId !== vendor.id ||
      offer.status !== 'ACTIVE' ||
      !isAvailable
    ) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'This product is not available in this store',
      });
    }
    const t = await this.taxonomy.get();
    const entry = (await this.loadCatalog(vendor.id)).find(
      (o) => o.catalog.id === offerId,
    )!;
    // Keep zero-stock versions in this public *option* response. The product
    // itself is still public only while ACTIVE, but a shopper must be able to
    // select an unavailable exact colour × size in order to request a
    // restock alert for it. Cart/checkout retain their own stock checks.
    // Product colours: all product colours in the seller's order, including
    // a colour whose last size is sold out (it may still be subscribed to).
    const productColors = await this.prisma.offerColor.findMany({
      where: { vendorOfferId: offerId },
      orderBy: { sortOrder: 'asc' },
    });
    // the shared builder - the draft preview uses the same one
    const choices = productOptionChoices(
      productColors,
      t.sizes,
      entry.catalog.combinations.map((c) => ({
        variantId: c.variantId,
        colorId: c.offerColorId ?? null,
        colorCode: c.colorCode,
        sizeCode: c.sizeCode,
        available: c.available,
      })),
    );
    return {
      offer_id: offerId,
      classified: entry.catalog.classified,
      audiences: entry.catalog.audiences,
      categories: entry.catalog.categories,
      season: entry.catalog.season,
      price: {
        min_price: entry.card.min_price,
        original_price: entry.card.original_price,
        discount_percent: entry.card.discount_percent,
      },
      colors: choices.colors.map((c) => ({
        ...productColorView(c, t.colors),
        // older clients: the family code
        code: c.familyCode,
      })),
      sizes: choices.sizes,
      combinations: choices.combinations,
    };
  }
}
