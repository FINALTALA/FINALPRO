import { Injectable } from '@nestjs/common';
import { primaryMediaUrl } from '../discovery/comparison.service';
import { bucketForStock } from '../common/availability.util';
import { FulfilmentEligibilityService } from '../fulfilment/fulfilment-eligibility.service';
import { normalizeColorName } from '../offers/color-name';
import {
  computeEffectivePrice,
  isEffectivelyDiscounted,
} from '../offers/pricing/effective-price.util';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogOffer } from './store-catalog.util';
import { PUBLIC_OFFER } from '../offers/platform-hold.util';

/** Same rule as the store page's «وصل حديثاً» (the products and sections endpoints). */
export const NEW_ARRIVALS_WINDOW_DAYS = 14;

/**
 * The store page's own catalogue: every ACTIVE offer of one store, with
 * live availability per variant (the sellable branches checkout uses), its
 * card, search text, collections, «وصل حديثاً» and «تخفيضات». Moved out of
 * StoreTaxonomyPublicController unchanged (2026-11-20) so the store's home
 * page blocks (store-home/) resolve products exactly as the listing does.
 */
@Injectable()
export class StoreCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfilment: FulfilmentEligibilityService,
  ) {}

  /** Every ACTIVE offer of the store, with live availability per variant. */
  async load(vendorId: string) {
    const offers = await this.prisma.vendorOffer.findMany({
      // VIA phase 2C: PUBLIC_OFFER = ACTIVE and not under a platform hold.
      where: { vendorId, ...PUBLIC_OFFER },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        audiences: { select: { audience: true } },
        categories: { select: { categoryCode: true } },
        sectionMemberships: { select: { sectionId: true, sortOrder: true } },
        // Product colours: names for the store search, order for the card image.
        colors: { select: { nameAr: true, nameEn: true } },
        variants: {
          include: {
            media: { select: { url: true, kind: true } },
            offerColor: { select: { sortOrder: true } },
          },
        },
      },
    });
    // PD-2: the shared sellable-branch availability (what checkout can sell).
    const availability = await this.fulfilment.availableByVariant(
      offers.flatMap((o) => o.variants.map((v) => ({ id: v.id, vendorId }))),
    );
    const now = new Date();
    return offers.map((o) => {
      const variants = o.variants.map((v) => ({
        v,
        price: computeEffectivePrice(v, now),
        available: availability.get(v.id)?.total ?? 0,
      }));
      const cheapest = variants.length
        ? variants.reduce((a, b) => (b.price < a.price ? b : a))
        : null;
      const discounted = cheapest && isEffectivelyDiscounted(cheapest.v, now);
      const original = cheapest ? Number(String(cheapest.v.basePrice)) : null;
      const favoritable = variants
        .filter((x) => x.v.canonicalVariantId !== null)
        .sort((a, b) => a.price - b.price)[0];
      const classified = o.taxonomyVersion !== null;
      const catalog: CatalogOffer = {
        id: o.id,
        createdAt: o.createdAt,
        classified,
        audiences: o.audiences.map((a) => a.audience),
        categories: o.categories.map((c) => c.categoryCode),
        season: o.season,
        minPrice: cheapest ? cheapest.price : null,
        combinations: variants
          .filter((x) => classified && x.v.isCombination)
          .map((x) => ({
            variantId: x.v.id,
            colorCode: x.v.colorCode,
            offerColorId: x.v.offerColorId,
            sizeCode: x.v.sizeCode,
            available: x.available,
          })),
      };
      const total = variants.reduce((n, x) => n + x.available, 0);
      return {
        catalog,
        available: total,
        // the title and - product colours - every colour name, also normalised
        search: [
          o.titleAr,
          o.titleEn,
          ...o.colors.flatMap((c) => [
            c.nameAr,
            c.nameEn ?? '',
            normalizeColorName(c.nameAr),
          ]),
        ]
          .join(' ')
          .toLowerCase(),
        sectionIds: new Set(o.sectionMemberships.map((m) => m.sectionId)),
        /** «مجموعات المتجر»: the owner's position of this product in each collection. */
        sectionOrder: new Map(
          o.sectionMemberships.map((m) => [m.sectionId, m.sortOrder]),
        ),
        isNew:
          o.createdAt.getTime() >=
          now.getTime() - NEW_ARRIVALS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
        isSale: variants.some((x) => isEffectivelyDiscounted(x.v, now)),
        card: {
          id: o.id,
          title_ar: o.titleAr,
          title_en: o.titleEn,
          min_price: cheapest ? cheapest.price.toFixed(2) : null,
          original_price:
            discounted && original !== null ? original.toFixed(2) : null,
          discount_percent:
            discounted && original
              ? Math.round((1 - cheapest!.price / original) * 100)
              : null,
          availability: bucketForStock(total),
          // the default colour's (the seller's first) main image
          image_url:
            [...o.variants]
              .sort(
                (a, b) =>
                  (a.offerColor?.sortOrder ?? 1000) -
                    (b.offerColor?.sortOrder ?? 1000) ||
                  a.createdAt.getTime() - b.createdAt.getTime(),
              )
              .map((v) => primaryMediaUrl(v.media))
              .find((u) => u !== null) ?? null,
          created_at: o.createdAt.toISOString(),
          favorite_variant_id: favoritable?.v.id ?? null,
          classified,
          audiences: catalog.audiences,
          categories: catalog.categories,
          season: o.season,
        },
      };
    });
  }
}

export type StoreCatalogEntry = Awaited<
  ReturnType<StoreCatalogService['load']>
>[number];
