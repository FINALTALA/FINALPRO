import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  AvailabilityBucket,
  bucketForStock,
  liveReservedQuantityByKey,
  totalAvailableStockLive,
} from '../common/availability.util';
import { PrismaService } from '../prisma/prisma.service';

export interface EligibleOffer {
  offerVariantId: string;
  offerId: string;
  canonicalVariantId: string;
  structuralAttributes: Prisma.JsonValue;
  vendorId: string;
  vendorSlug: string;
  vendorDisplayName: string;
  vendorLogoUrl: string | null;
  vendorCreatedAt: Date;
  price: number;
  availability: AvailabilityBucket;
  imageUrl: string | null;
}

export interface ComparisonCard {
  canonicalProductId: string;
  canonicalNameAr: string;
  canonicalNameEn: string;
  lowestPrice: number;
  lowestPriceAvailability: AvailabilityBucket;
  imageUrl: string | null;
  brandName: string | null;
  categoryName: string | null;
  storeCount: number;
  colors: string[];
  sizes: string[];
  cheapestOffer: {
    vendorId: string;
    vendorSlug: string;
    offerId: string;
    offerVariantId: string;
  };
  storeLogos: {
    vendorId: string;
    vendorSlug: string;
    displayName: string;
    logoUrl: string | null;
    offerId: string;
    offerVariantId: string;
    price: number;
  }[];
}

const MAX_CARD_LOGOS = 5;

/** PRIMARY media first, else the earliest additional one, else null. */
export function primaryMediaUrl(
  media: { url: string; kind: string }[],
): string | null {
  const primary = media.find((m) => m.kind === 'PRIMARY');
  return (primary ?? media[0])?.url ?? null;
}

/**
 * Sprint 13: colour/size option values shown on cards, read from the
 * canonical variants' own structural attributes (never invented - a
 * product whose variants carry neither key simply shows none).
 */
function distinctAttributeValues(
  offers: { structuralAttributes: Prisma.JsonValue }[],
  keys: string[],
): string[] {
  const values = new Set<string>();
  for (const offer of offers) {
    const attrs = offer.structuralAttributes;
    if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
      continue;
    }
    for (const key of keys) {
      const value = (attrs as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim() !== '') {
        values.add(value.trim());
      }
    }
  }
  return Array.from(values);
}

/**
 * Sprint 13: the one definition of "an eligible offer's vendor" used by
 * every public listing (discovery, search, following feed). A product is
 * listed only if at least one CONFIRMED, ACTIVE offer belongs to a
 * published, ACTIVE store that also satisfies `vendorFilter`.
 */
export function eligibleProductWhere(
  vendorFilter: Prisma.VendorWhereInput = {},
): Prisma.CanonicalProductWhereInput {
  return {
    variants: {
      some: {
        confirmedOfferVariants: {
          some: {
            vendorOffer: { status: 'ACTIVE' },
            vendor: {
              AND: [
                { storefrontPublished: true, status: 'ACTIVE' },
                vendorFilter,
              ],
            },
          },
        },
      },
    },
  };
}

/**
 * Sprint 8 (RB-COMP-001, PDR-015/016/017): the single source of truth
 * for "what counts as a real, buyable offer" across every public
 * surface that needs it (discovery cards, the standalone comparison
 * card, the full comparison page) - kept in one service so the
 * definition can never drift between them.
 *
 * ELIGIBLE = a CONFIRMED match (OfferVariant.canonicalVariantId, never
 * the merely-proposed one - see that field's own schema comment) to a
 * variant of this canonical product, whose parent VendorOffer is ACTIVE
 * and whose vendor has a published, ACTIVE storefront (the same
 * predicate StorefrontPublicController already uses as the single
 * source of truth for store-level availability - reused here, not
 * duplicated as a second competing definition). Eligibility does NOT
 * depend on stock: a sold-out eligible offer still appears in the full
 * comparison list (PDR-016's "every eligible store offer"), it is only
 * excluded from the *lowest available price* figure (see buildCard()).
 */
@Injectable()
export class ComparisonService {
  constructor(private readonly prisma: PrismaService) {}

  async findEligibleOffers(
    canonicalProductId: string,
  ): Promise<EligibleOffer[]> {
    const variants = await this.prisma.offerVariant.findMany({
      where: {
        canonicalVariantId: { not: null },
        canonicalVariant: { canonicalProductId },
        vendorOffer: { status: 'ACTIVE' },
        vendor: { storefrontPublished: true, status: 'ACTIVE' },
      },
      include: {
        vendor: {
          select: {
            id: true,
            slug: true,
            displayName: true,
            legalName: true,
            logoUrl: true,
            createdAt: true,
          },
        },
        canonicalVariant: { select: { id: true, structuralAttributes: true } },
        branchStocks: { select: { branchId: true, quantity: true } },
        media: {
          select: { url: true, kind: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    // Codex review round 4 on commit 95a8430 (fix #2): live-reserved,
    // not the lazily-swept BranchStock.reservedQuantity counter - see
    // liveReservedQuantityByKey's own doc comment. Batched once for
    // every variant this call returns.
    const liveReservedByKey = await liveReservedQuantityByKey(
      this.prisma,
      variants.flatMap((v) =>
        v.branchStocks.map((bs) => ({
          branchId: bs.branchId,
          offerVariantId: v.id,
        })),
      ),
    );

    return variants.map((v) => {
      const totalStock = totalAvailableStockLive(
        v.branchStocks.map((bs) => ({
          branchId: bs.branchId,
          offerVariantId: v.id,
          quantity: bs.quantity,
        })),
        liveReservedByKey,
      );
      return {
        offerVariantId: v.id,
        offerId: v.vendorOfferId,
        // Non-null by construction: the where clause above requires
        // canonicalVariantId (hence canonicalVariant) to be set.
        canonicalVariantId: v.canonicalVariantId!,
        structuralAttributes: v.canonicalVariant!.structuralAttributes,
        vendorId: v.vendor.id,
        vendorSlug: v.vendor.slug,
        vendorDisplayName: v.vendor.displayName ?? v.vendor.legalName,
        vendorLogoUrl: v.vendor.logoUrl,
        vendorCreatedAt: v.vendor.createdAt,
        price: Number(v.salePrice ?? v.basePrice),
        availability: bucketForStock(totalStock),
        imageUrl: primaryMediaUrl(v.media),
      };
    });
  }

  /**
   * Deterministic cheapest-first ordering. PDR-015 calls for ties to
   * break by "higher rating, then permitted location proximity" - this
   * codebase has no rating or geolocation-permission infrastructure at
   * all (checked before writing this sprint's code; see the PR
   * description for this note in full), so guessing at either would be
   * dishonest. The documented, fully deterministic fallback used
   * instead: the longer-established store wins (older vendor.createdAt
   * first), then offerVariantId as a final total-order tiebreak so the
   * result never depends on incidental DB row order.
   */
  compareOffersByPrice = (a: EligibleOffer, b: EligibleOffer): number => {
    if (a.price !== b.price) return a.price - b.price;
    const createdDiff =
      a.vendorCreatedAt.getTime() - b.vendorCreatedAt.getTime();
    if (createdDiff !== 0) return createdDiff;
    return a.offerVariantId < b.offerVariantId ? -1 : 1;
  };

  /**
   * Builds one canonical-product comparison card, or null if the
   * product has no eligible offer at all (nothing to compare - it must
   * not appear on discovery or be linkable as a card).
   */
  buildCard(
    canonicalProduct: {
      id: string;
      canonicalNameAr: string | null;
      canonicalNameEn: string | null;
      brand?: { name: string } | null;
      category?: { nameAr: string } | null;
    },
    eligibleOffers: EligibleOffer[],
  ): ComparisonCard | null {
    if (eligibleOffers.length === 0) return null;
    // Guaranteed non-null: CanonicalNamingService sets both the moment
    // the FIRST confirmed match happens (Sprint 7), and eligibility
    // above requires a confirmed match to exist.
    const nameAr = canonicalProduct.canonicalNameAr!;
    const nameEn = canonicalProduct.canonicalNameEn!;

    const cheapestPerVendor = new Map<string, EligibleOffer>();
    for (const offer of eligibleOffers) {
      const current = cheapestPerVendor.get(offer.vendorId);
      if (!current || this.compareOffersByPrice(offer, current) < 0) {
        cheapestPerVendor.set(offer.vendorId, offer);
      }
    }
    const rankedStores = Array.from(cheapestPerVendor.values()).sort(
      this.compareOffersByPrice,
    );
    const logos = rankedStores.slice(0, MAX_CARD_LOGOS);

    // PDR-015: "shows the lowest AVAILABLE ILS price." Prefer offers
    // that are not sold out; if every eligible offer happens to be sold
    // out, fall back to the lowest price among all of them anyway
    // (informational - PDR-015 does not define this edge case
    // explicitly, so this fallback is documented here and called out in
    // the PR rather than left as an unstated guess).
    const availableOffers = eligibleOffers.filter(
      (o) => o.availability !== 'sold_out',
    );
    const pool = availableOffers.length > 0 ? availableOffers : eligibleOffers;
    const cheapest = pool.slice().sort(this.compareOffersByPrice)[0];

    return {
      canonicalProductId: canonicalProduct.id,
      canonicalNameAr: nameAr,
      canonicalNameEn: nameEn,
      lowestPrice: cheapest.price,
      lowestPriceAvailability: cheapest.availability,
      imageUrl:
        cheapest.imageUrl ??
        rankedStores.find((o) => o.imageUrl !== null)?.imageUrl ??
        null,
      brandName: canonicalProduct.brand?.name ?? null,
      categoryName: canonicalProduct.category?.nameAr ?? null,
      storeCount: cheapestPerVendor.size,
      colors: distinctAttributeValues(eligibleOffers, ['color', 'colour']),
      sizes: distinctAttributeValues(eligibleOffers, ['size']),
      cheapestOffer: {
        vendorId: cheapest.vendorId,
        vendorSlug: cheapest.vendorSlug,
        offerId: cheapest.offerId,
        offerVariantId: cheapest.offerVariantId,
      },
      storeLogos: logos.map((o) => ({
        vendorId: o.vendorId,
        vendorSlug: o.vendorSlug,
        displayName: o.vendorDisplayName,
        logoUrl: o.vendorLogoUrl,
        offerId: o.offerId,
        offerVariantId: o.offerVariantId,
        price: o.price,
      })),
    };
  }

  /**
   * Builds the public global cards for a page of canonical products
   * matching `where` (already restricted to eligible products by the
   * caller via eligibleProductWhere()).
   */
  async listCards(
    where: Prisma.CanonicalProductWhereInput,
    page: number,
    pageSize: number,
  ) {
    const [total, products] = await Promise.all([
      this.prisma.canonicalProduct.count({ where }),
      this.prisma.canonicalProduct.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          brand: { select: { name: true } },
          category: { select: { nameAr: true } },
        },
      }),
    ]);
    const cards = await Promise.all(
      products.map(async (product) => {
        const eligible = await this.findEligibleOffers(product.id);
        return this.buildCard(product, eligible);
      }),
    );
    return {
      total,
      cards: cards.filter((c): c is ComparisonCard => c !== null),
    };
  }
}
