import { compositionView } from '../offers/composition';
import {
  colorLabel,
  mediaView,
  modelView,
  sizeLabel,
  variantPriceView,
} from '../offers/public-offer-view';
import {
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
import {
  FulfilmentEligibilityService,
  VariantAvailability,
} from '../fulfilment/fulfilment-eligibility.service';
import { primaryMediaUrl } from '../discovery/comparison.service';
import { bucketForStock } from '../common/availability.util';
import { PrismaService } from '../prisma/prisma.service';
import { SizeGuidesService } from '../size-guides/size-guides.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import {
  PriceConfig,
  computeEffectivePrice,
  isEffectivelyDiscounted,
} from '../offers/pricing/effective-price.util';
import { SalesRankReadService } from '../sales-rank/sales-rank-read.service';

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
  variants: (PriceConfig & {
    id: string;
    canonicalVariantId: string | null;
    branchStocks: { branchId: string; quantity: number }[];
    media: { url: string; kind: string }[];
  })[];
}

// PD-2: every availability on this public route comes from
// FulfilmentEligibilityService.availableByVariant() - sellable branches
// only, live checkout holds subtracted (batched once per request), 0 for
// a store that can't take an order right now.
/**
 * A variant's media in display order: the PRIMARY image first, then the
 * owner's sortOrder, then id - a total order, so the gallery never
 * shuffles between requests.
 */
function orderedMedia<
  T extends { id: string; kind: string; sortOrder: number },
>(media: T[]): T[] {
  return [...media].sort(
    (a, b) =>
      Number(b.kind === 'PRIMARY') - Number(a.kind === 'PRIMARY') ||
      a.sortOrder - b.sortOrder ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function offerSummaryDto(
  offer: OfferSummaryRow,
  availability: Map<string, VariantAvailability>,
) {
  // Sprint 17 (blocker 1): shared, read-only computation.
  const prices = offer.variants.map((v) => computeEffectivePrice(v));
  // Sprint 26: the variant a store-page heart favorites. FavoritesService
  // only accepts an OFFER favorite on a canonically-matched variant, so
  // the cheapest matched one is offered (it is the price the card
  // shows whenever that variant is the cheapest) - null when none is
  // matched yet, and the store page then shows no heart at all.
  // Sprint 26: the strike-through price is the base price of the very
  // variant whose effective price is shown, so the card never pairs a
  // sale price with a different variant's original.
  const cheapestIndex =
    prices.length > 0 ? prices.indexOf(Math.min(...prices)) : -1;
  const discount =
    cheapestIndex >= 0 && isEffectivelyDiscounted(offer.variants[cheapestIndex])
      ? {
          price: prices[cheapestIndex],
          original: Number(String(offer.variants[cheapestIndex].basePrice)),
        }
      : null;
  const favoritable = offer.variants
    .map((v, i) => ({ v, price: prices[i] }))
    .filter(({ v }) => v.canonicalVariantId !== null)
    .sort((a, b) => a.price - b.price)[0];
  // PD-2: sellable branches only, 0 for a vendor that can't sell now.
  const totalStock = offer.variants.reduce(
    (sum, v) => sum + (availability.get(v.id)?.total ?? 0),
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
    // Sprint 26: both null unless the shown price is below its base.
    original_price: discount ? discount.original.toFixed(2) : null,
    discount_percent: discount
      ? Math.round((1 - discount.price / discount.original) * 100)
      : null,
    availability: bucketForStock(totalStock),
    // Sprint 13: the offer's card image - the first variant that has
    // one (PRIMARY preferred within a variant), never a placeholder.
    image_url:
      offer.variants
        .map((v) => primaryMediaUrl(v.media))
        .find((url) => url !== null) ?? null,
    // Sprint 26: lets the store page sort any list (custom sections are
    // ordered by the owner, not by date) by "newest" client-side.
    created_at: offer.createdAt.toISOString(),
    favorite_variant_id: favoritable?.v.id ?? null,
  };
}

@Controller('storefronts/:slug')
export class StoreOffersPublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly fulfilment: FulfilmentEligibilityService,
    private readonly sessions: SessionService,
    private readonly sizeGuides: SizeGuidesService,
    private readonly salesRank: SalesRankReadService,
  ) {}

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
        variants: {
          // Product colours: the default (first) colour first - its image is the card's.
          orderBy: [{ offerColor: { sortOrder: 'asc' } }, { createdAt: 'asc' }],
          include: {
            branchStocks: { select: { branchId: true, quantity: true } },
            media: { select: { url: true, kind: true } },
          },
        },
      },
    });

    const newArrivalsCutoff = new Date(
      Date.now() - NEW_ARRIVALS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const newArrivals = offers.filter((o) => o.createdAt >= newArrivalsCutoff);
    // Sprint 17 (blocker 1): "discounted" now means the LIVE effective
    // price (manual override OR an active scheduled discount) is below
    // basePrice - computed the same way, read-only, as everywhere else.
    const discounts = offers.filter((o) =>
      o.variants.some((v) => isEffectivelyDiscounted(v)),
    );

    const customSections = await this.prisma.storeSection.findMany({
      // «مجموعات المتجر»: a hidden collection is never shown to shoppers.
      where: { vendorId: vendor.id, isVisible: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        offers: {
          orderBy: { sortOrder: 'asc' },
          include: {
            offer: {
              include: {
                variants: {
                  orderBy: [
                    { offerColor: { sortOrder: 'asc' } },
                    { createdAt: 'asc' },
                  ],
                  include: {
                    branchStocks: {
                      select: { branchId: true, quantity: true },
                    },
                    media: { select: { url: true, kind: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const customSectionOffers = customSections.flatMap((section) =>
      section.offers
        .filter((m) => m.offer.status === 'ACTIVE')
        .map((m) => m.offer),
    );

    // One batched live-reservation read for the WHOLE response (the
    // "all" list, new arrivals, discounts, and every custom section all
    // share it) - never one query per offer.
    const availability = await this.fulfilment.availableByVariant(
      [...offers, ...customSectionOffers].flatMap((o) =>
        o.variants.map((v) => ({ id: v.id, vendorId: vendor.id })),
      ),
    );

    return {
      is_available: true,
      all: offers.map((o) => offerSummaryDto(o, availability)),
      new_arrivals: newArrivals.map((o) => offerSummaryDto(o, availability)),
      discounts: discounts.map((o) => offerSummaryDto(o, availability)),
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
          .map((m) => offerSummaryDto(m.offer, availability)),
      })),
    };
  }

  @Get('offers/:offerId')
  async getOfferDetail(
    @Param('slug') slug: string,
    @Param('offerId') offerId: string,
    @Query('zone') zoneRaw: string | undefined,
    @Req() req: Request,
  ) {
    const vendor = await this.requireAvailableVendor(slug);
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
      include: {
        sharedMedia: { orderBy: { sortOrder: 'asc' }, select: { url: true } },
        variants: {
          include: {
            branchStocks: { select: { branchId: true, quantity: true } },
            // Product colours: the version's own colour (name, swatch).
            offerColor: true,
            // Keep media attached to its exact sellable variant. The
            // flattened `images` response below remains for legacy clients,
            // while product-detail clients can switch galleries when a
            // shopper changes colour/size.
            media: {
              select: {
                id: true,
                url: true,
                kind: true,
                mediaType: true,
                altTextAr: true,
                altTextEn: true,
                sortOrder: true,
              },
            },
            // Round 4 review fix (RB-COMP-001, PDR-015): the store
            // product page needs to offer a "compare prices" link back
            // to this variant's canonical product WHEN it has a
            // confirmed match - canonicalVariantId alone doesn't carry
            // the canonical_product_id a comparison link needs, and
            // nothing else in this codebase exposes that mapping
            // publicly yet. Only the id is selected - never any other
            // CanonicalProductVariant field (gtin/mpn/
            // platformProductBarcode etc. stay internal).
            canonicalVariant: {
              select: { canonicalProductId: true, structuralAttributes: true },
            },
          },
        },
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

    const t = await this.taxonomy.get();
    // PD-2: delivery/pickup facts from the shared source checkout uses,
    // for the requested zone or the customer's own default address zone.
    const zoneChoice = await this.fulfilment.resolveZone(
      zoneRaw,
      await optionalSessionUserId(this.sessions, this.prisma, req),
    );
    const fulfilment = await this.fulfilment.variantFulfilment(
      vendor.id,
      offer.variants.map((v) => v.id),
      zoneChoice.zone,
    );

    const sizeGuideKind = await this.sizeGuides.visibleKindForOffer(offer.id);
    return {
      id: offer.id,
      // PD-2: can this store take an order right now (published, active,
      // subscription) - the same check the cart and checkout apply.
      purchasable: fulfilment.purchasable,
      // PD-4: a published size guide applies to this offer's sizes - the
      // page shows «دليل المقاسات» only then (never an empty guide).
      size_guide_available: sizeGuideKind !== null,
      // Phase A+: OFFER = the product's own measurements table («جدول المقاسات (سم)»).
      size_guide_kind: sizeGuideKind,
      // PD-5.3: the scope this offer is a qualified bestseller in, or null
      // (always null while the flag is off) - never a rank or a count.
      bestseller: await this.salesRank.offerMark(offer.id),
      fulfilment_context: zoneChoice,
      // The store's deliverable zones (enabled and priced) - fees only.
      delivery_zones: fulfilment.deliveryZones,
      // Sprint 10 (RB-ORD-002): the cart's own "add item" call needs
      // vendor_id (not just the already-public slug) - no more
      // sensitive than vendor_slug/vendor_display_name, already
      // exposed on this same public response.
      vendor_id: vendor.id,
      vendor_slug: vendor.slug,
      vendor_display_name: vendor.displayName ?? vendor.legalName,
      title_ar: offer.titleAr,
      title_en: offer.titleEn,
      // Phase A++ (item 4): the product's specifications (its category
      // template's keys; fit/stretch/occasion/care as codes) - the page words them.
      category_template: offer.categoryTemplate,
      template_attributes: offer.templateAttributes,
      // Phase A++ (item 5): «العارضة طولها … وترتدي …» - one of the product's sizes.
      model: modelView(t, offer.modelHeightCm, offer.modelSize),
      // fabric composition and country of origin - the same view as the draft preview
      ...compositionView(offer.composition, offer.countryOfOrigin),
      // Phase A++ (item 6): images every colour shares - shown after the
      // chosen colour's own images; never a colour's main image.
      shared_images: offer.sharedMedia.map((m) => m.url),
      // Sprint 13: every image of every variant, PRIMARY first, unique.
      // Kept unchanged for existing clients (PD-1: per-variant `media`
      // below is the product page's source now).
      images: Array.from(
        new Set(
          offer.variants.flatMap((v) =>
            orderedMedia(v.media).map((m) => m.url),
          ),
        ),
      ),
      variants: offer.variants.map((v) => {
        const facts = fulfilment.variants.get(v.id)!;
        return {
          id: v.id,
          // the SKU stays internal: never in a shopper's response
          condition: v.condition,
          currency: 'ILS' as const,
          // Phase A++: the same price view as the draft preview.
          ...variantPriceView(v),
          specs_text_ar: v.specsTextAr,
          specs_text_en: v.specsTextEn,
          canonical_variant_id: v.canonicalVariantId,
          // null for an unmatched variant - the frontend's own
          // signal for "no comparison link to show," never guessed
          // from canonical_variant_id's mere presence.
          canonical_product_id: v.canonicalVariant?.canonicalProductId ?? null,
          // Sprint 13: the real option values (colour/size...) of a
          // matched variant; null for an unmatched one.
          structural_attributes:
            v.canonicalVariant?.structuralAttributes ?? null,
          availability: facts.availability,
          // PD-2: quantity-free delivery/pickup facts of this variant.
          fulfilment: facts,
          // PD-1: the variant's own colour/size (classified offers) and its
          // own media - PRIMARY first, then the owner's order, then id
          // (a total order) - so the page shows THIS variant's gallery.
          color_code: v.colorCode,
          // Product colours: the product colour's own name (older versions
          // without one: the family's name, as before).
          color_id: v.offerColorId,
          color_label: v.offerColor?.nameAr ?? colorLabel(t, v.colorCode),
          color_name_en: v.offerColor?.nameEn ?? null,
          color_hex: v.offerColor?.hex ?? null,
          color_swatch_url: v.offerColor?.swatchUrl ?? null,
          size_code: v.sizeCode,
          size_label: sizeLabel(t, v.sizeCode),
          media: orderedMedia(v.media).map(mediaView),
        };
      }),
    };
  }
}
