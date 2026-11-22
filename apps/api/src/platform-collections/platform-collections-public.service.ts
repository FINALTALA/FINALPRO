import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DeliveryZoneRegion,
  Prisma,
  ProductAudience,
} from '../../generated/prisma/client';
import { ComparisonService } from '../discovery/comparison.service';
import { comparisonCardDto } from '../discovery/dto/comparison-card.dto';
import { FulfilmentEligibilityService } from '../fulfilment/fulfilment-eligibility.service';
import { PrismaService } from '../prisma/prisma.service';

/** Collections shown at most, per placement (approved decision 3). */
export const HOME_COLLECTIONS = 2;
export const AUDIENCE_COLLECTIONS = 1;
/** A collection appears in a placement only with at least this many eligible products. */
export const MIN_ELIGIBLE_IN_PLACEMENT = 4;
/** Products a placement previews (the collection page shows all of them). */
export const PLACEMENT_PREVIEW = 4;
/** Placements look at no more than this many live candidates. */
const PLACEMENT_SCAN = 10;
/** A merge chain is followed this far at most (merges are never cyclic). */
const MAX_MERGE_HOPS = 5;

export type CollectionPlacement = 'HOME' | 'AUDIENCE';
export const PLACEMENTS: CollectionPlacement[] = ['HOME', 'AUDIENCE'];

type LiveCollection = {
  id: string;
  slug: string;
  titleAr: string;
  titleEn: string;
  descriptionAr: string | null;
  descriptionEn: string | null;
  audience: ProductAudience | null;
  items: { canonicalProductId: string }[];
};

const liveSelect = {
  id: true,
  slug: true,
  titleAr: true,
  titleEn: true,
  descriptionAr: true,
  descriptionEn: true,
  audience: true,
  items: {
    orderBy: { sortOrder: 'asc' },
    select: { canonicalProductId: true },
  },
} satisfies Prisma.PlatformCollectionSelect;

/**
 * PD-5b.2: the public read of platform collections. A collection is shown
 * only while live (PUBLISHED and inside its window); each product only
 * when it is PUBLISHED (a merged one is read through its survivor, shown
 * once) and has at least one store offer a shopper can buy now for their
 * zone - the shared FulfilmentEligibilityService rule. Cards are the
 * standard discovery card. Nothing operational (status, order, counts,
 * stock, branches) is returned.
 */
@Injectable()
export class PlatformCollectionsPublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
    private readonly fulfilment: FulfilmentEligibilityService,
  ) {}

  private liveWhere(now: Date): Prisma.PlatformCollectionWhereInput {
    return {
      status: 'PUBLISHED',
      AND: [
        { OR: [{ publishFrom: null }, { publishFrom: { lte: now } }] },
        { OR: [{ publishUntil: null }, { publishUntil: { gt: now } }] },
      ],
    };
  }

  /** Each listed product -> its live identity (survivor of a merge), PUBLISHED only. */
  private async resolveProducts(ids: string[]): Promise<Map<string, string>> {
    const known = new Map<
      string,
      { status: string; mergedIntoId: string | null }
    >();
    let pending = [...new Set(ids)];
    for (let hop = 0; hop <= MAX_MERGE_HOPS && pending.length; hop++) {
      const rows = await this.prisma.canonicalProduct.findMany({
        where: { id: { in: pending } },
        select: { id: true, status: true, mergedIntoId: true },
      });
      for (const r of rows) known.set(r.id, r);
      pending = rows
        .map((r) => r.mergedIntoId)
        .filter((m): m is string => !!m && !known.has(m));
    }
    const result = new Map<string, string>();
    for (const id of new Set(ids)) {
      let current = id;
      for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
        const row = known.get(current);
        if (!row) break;
        if (row.status === 'PUBLISHED') {
          result.set(id, current);
          break;
        }
        if (row.status !== 'MERGED' || !row.mergedIntoId) break;
        current = row.mergedIntoId;
      }
    }
    return result;
  }

  /** The products (of `productIds`) a shopper in `zone` can buy now. */
  private async purchasableProducts(
    productIds: string[],
    zone: DeliveryZoneRegion | null,
  ): Promise<Set<string>> {
    if (productIds.length === 0) return new Set();
    const variants = await this.prisma.offerVariant.findMany({
      where: {
        canonicalVariant: { canonicalProductId: { in: productIds } },
        vendorOffer: { status: 'ACTIVE' },
        vendor: { storefrontPublished: true, status: 'ACTIVE' },
      },
      select: {
        id: true,
        vendorId: true,
        canonicalVariant: { select: { canonicalProductId: true } },
      },
    });
    const reachable = await this.fulfilment.reachableVariantIds(
      variants.map((v) => ({ id: v.id, vendorId: v.vendorId })),
      zone,
    );
    return new Set(
      variants
        .filter((v) => reachable.has(v.id) && v.canonicalVariant)
        .map((v) => v.canonicalVariant!.canonicalProductId),
    );
  }

  /** Collections -> their eligible products in the admin's order (deduplicated). */
  private async eligibleLists(
    collections: LiveCollection[],
    zone: DeliveryZoneRegion | null,
  ): Promise<Map<string, string[]>> {
    const resolved = await this.resolveProducts(
      collections.flatMap((c) => c.items.map((i) => i.canonicalProductId)),
    );
    const buyable = await this.purchasableProducts(
      [...new Set(resolved.values())],
      zone,
    );
    return new Map(
      collections.map((c) => {
        const seen = new Set<string>();
        const list: string[] = [];
        for (const i of c.items) {
          const id = resolved.get(i.canonicalProductId);
          if (!id || seen.has(id) || !buyable.has(id)) continue;
          seen.add(id);
          list.push(id);
        }
        return [c.id, list];
      }),
    );
  }

  /** The standard cards for these products, in this order. */
  private async cards(productIds: string[]) {
    if (productIds.length === 0) return [];
    const { cards } = await this.comparison.listCards(
      { id: { in: productIds } },
      1,
      productIds.length,
    );
    const byId = new Map(cards.map((c) => [c.canonicalProductId, c]));
    return productIds
      .map((id) => byId.get(id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map(comparisonCardDto);
  }

  private publicDto(c: LiveCollection) {
    return {
      slug: c.slug,
      title_ar: c.titleAr,
      title_en: c.titleEn,
      description_ar: c.descriptionAr,
      description_en: c.descriptionEn,
      audience: c.audience,
    };
  }

  /** GET /collections?placement=... - the collections a page shows, previewed. */
  async placement(
    placement: CollectionPlacement,
    audience: ProductAudience | null,
    zone: DeliveryZoneRegion | null,
  ) {
    if (placement === 'AUDIENCE' && !audience) {
      throw new BadRequestException({
        code: 'AUDIENCE_REQUIRED',
        message: 'placement=AUDIENCE needs audience=WOMEN|MEN|KIDS',
      });
    }
    const limit =
      placement === 'HOME' ? HOME_COLLECTIONS : AUDIENCE_COLLECTIONS;
    const candidates = await this.prisma.platformCollection.findMany({
      where: {
        ...this.liveWhere(new Date()),
        ...(placement === 'HOME'
          ? { showOnHome: true }
          : { audience: audience! }),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: PLACEMENT_SCAN,
      select: liveSelect,
    });
    const lists = await this.eligibleLists(candidates, zone);
    const chosen = candidates
      .filter(
        (c) => (lists.get(c.id) ?? []).length >= MIN_ELIGIBLE_IN_PLACEMENT,
      )
      .slice(0, limit);
    const previews = await this.cards([
      ...new Set(
        chosen.flatMap((c) => lists.get(c.id)!.slice(0, PLACEMENT_PREVIEW)),
      ),
    ]);
    const byId = new Map(previews.map((p) => [p.canonical_product_id, p]));
    return {
      items: chosen.map((c) => ({
        ...this.publicDto(c),
        products: lists
          .get(c.id)!
          .slice(0, PLACEMENT_PREVIEW)
          .map((id) => byId.get(id))
          .filter((p): p is NonNullable<typeof p> => !!p),
      })),
    };
  }

  /** GET /collections/:slug - one live collection with every eligible product. */
  async bySlug(slug: string, zone: DeliveryZoneRegion | null) {
    const c = await this.prisma.platformCollection.findFirst({
      where: { slug, ...this.liveWhere(new Date()) },
      select: liveSelect,
    });
    if (!c) {
      throw new NotFoundException({
        code: 'COLLECTION_NOT_FOUND',
        message: 'Collection not found',
      });
    }
    const list = (await this.eligibleLists([c], zone)).get(c.id) ?? [];
    return { ...this.publicDto(c), products: await this.cards(list) };
  }
}
