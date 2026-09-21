import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { bucketForStock } from '../common/availability.util';
import { PrismaService } from '../prisma/prisma.service';

// Sprint 8 (RB-STOREF-002, PDR-012 / RB-COMP-001, PDR-015): the public,
// unauthenticated read side of a store's own catalog - deliberately NO
// guard at all (same as StorefrontPublicController). Two needs drive
// this controller's existence:
//  1. PDR-012's sections (fixed All, automatic New arrivals/Discounts,
//     owner-created custom sections) need somewhere public to read from.
//  2. PDR-015: "Selecting a [comparison-card] logo opens that offer's
//     product detail inside that store [page]" - there was no public
//     per-offer detail route anywhere in this codebase before this
//     sprint; :offerId below is it.
// Never includes: warehouse, legalName, subscriptionStatus, storeType,
// exact stock quantities (see bucketForStock) - the same public-
// serialization boundary StorefrontPublicController already established.
//
// "New arrivals" (14 days) and "Discounts" (any variant with a lower
// salePrice than basePrice) are deliberately simple, deterministic
// rules - PDR-012 names the two automatic sections but does not specify
// their exact membership formula, and this sprint does not build
// RB-COMP-002's ranking algorithm; both are documented here rather than
// left implicit.
const NEW_ARRIVALS_WINDOW_DAYS = 14;

interface OfferSummaryRow {
  id: string;
  titleAr: string;
  titleEn: string;
  createdAt: Date;
  variants: {
    basePrice: unknown;
    salePrice: unknown;
    branchStocks: { quantity: number }[];
  }[];
}

function offerSummaryDto(offer: OfferSummaryRow) {
  const prices = offer.variants.map(
    (v) => Number(v.salePrice ?? v.basePrice) as number,
  );
  const totalStock = offer.variants.reduce(
    (sum, v) => sum + v.branchStocks.reduce((s, bs) => s + bs.quantity, 0),
    0,
  );
  return {
    id: offer.id,
    title_ar: offer.titleAr,
    title_en: offer.titleEn,
    // null only when an ACTIVE offer somehow has zero variants yet -
    // defensive, should not normally happen since variants are how an
    // offer becomes sellable at all.
    min_price: prices.length > 0 ? Math.min(...prices).toFixed(2) : null,
    availability: bucketForStock(totalStock),
  };
}

@Controller('storefronts/:slug')
export class StoreOffersPublicController {
  constructor(private readonly prisma: PrismaService) {}

  private async requireAvailableVendor(slug: string) {
    const vendor = await this.prisma.vendor.findUnique({ where: { slug } });
    if (!vendor) {
      throw new NotFoundException({
        code: 'STOREFRONT_NOT_FOUND',
        message: 'No store found for this URL',
      });
    }
    return vendor;
  }

  @Get('sections')
  async getSections(@Param('slug') slug: string) {
    const vendor = await this.requireAvailableVendor(slug);
    const isAvailable =
      vendor.storefrontPublished && vendor.status === 'ACTIVE';
    if (!isAvailable) {
      // Never a 404 (identity is reachable at GET :slug) - but nothing
      // is offered as a purchase option for an unavailable store, so
      // every section reads empty rather than exposing a stale catalog.
      return {
        is_available: false,
        all: [],
        new_arrivals: [],
        discounts: [],
        custom: [],
      };
    }

    const offers = await this.prisma.vendorOffer.findMany({
      where: { vendorId: vendor.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      include: {
        variants: { include: { branchStocks: { select: { quantity: true } } } },
      },
    });

    const newArrivalsCutoff = new Date(
      Date.now() - NEW_ARRIVALS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const newArrivals = offers.filter((o) => o.createdAt >= newArrivalsCutoff);
    const discounts = offers.filter((o) =>
      o.variants.some(
        (v) =>
          v.salePrice !== null && Number(v.salePrice) < Number(v.basePrice),
      ),
    );

    const customSections = await this.prisma.storeSection.findMany({
      where: { vendorId: vendor.id },
      orderBy: { sortOrder: 'asc' },
      include: {
        offers: {
          include: {
            offer: {
              include: {
                variants: {
                  include: { branchStocks: { select: { quantity: true } } },
                },
              },
            },
          },
        },
      },
    });

    return {
      is_available: true,
      all: offers.map(offerSummaryDto),
      new_arrivals: newArrivals.map(offerSummaryDto),
      discounts: discounts.map(offerSummaryDto),
      custom: customSections.map((section) => ({
        id: section.id,
        name: section.name,
        // A custom section can reference an offer that has since gone
        // INACTIVE/DRAFT - the membership row itself is untouched (only
        // an explicit removal deletes it, see StoreSectionsController),
        // but it is filtered out of this PUBLIC read the same as every
        // other non-ACTIVE offer.
        offers: section.offers
          .filter((m) => m.offer.status === 'ACTIVE')
          .map((m) => offerSummaryDto(m.offer)),
      })),
    };
  }

  @Get('offers/:offerId')
  async getOfferDetail(
    @Param('slug') slug: string,
    @Param('offerId') offerId: string,
  ) {
    const vendor = await this.requireAvailableVendor(slug);
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
      include: {
        variants: { include: { branchStocks: { select: { quantity: true } } } },
      },
    });
    const isAvailable =
      vendor.storefrontPublished && vendor.status === 'ACTIVE';
    if (
      !offer ||
      offer.vendorId !== vendor.id ||
      offer.status !== 'ACTIVE' ||
      !isAvailable
    ) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }

    return {
      id: offer.id,
      vendor_slug: vendor.slug,
      vendor_display_name: vendor.displayName ?? vendor.legalName,
      title_ar: offer.titleAr,
      title_en: offer.titleEn,
      variants: offer.variants.map((v) => {
        const totalStock = v.branchStocks.reduce(
          (sum, bs) => sum + bs.quantity,
          0,
        );
        return {
          id: v.id,
          seller_sku: v.sellerSku,
          condition: v.condition,
          currency: 'ILS' as const,
          base_price: v.basePrice.toString(),
          sale_price: v.salePrice?.toString() ?? null,
          specs_text_ar: v.specsTextAr,
          specs_text_en: v.specsTextEn,
          canonical_variant_id: v.canonicalVariantId,
          availability: bucketForStock(totalStock),
        };
      }),
    };
  }
}
