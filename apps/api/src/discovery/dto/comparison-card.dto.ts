import { ComparisonCard } from '../comparison.service';

// Shared response shape for the standalone comparison-card endpoint and
// every card embedded in the discovery listing - one place so the two
// can never drift apart in field naming.
export function comparisonCardDto(card: ComparisonCard) {
  return {
    canonical_product_id: card.canonicalProductId,
    canonical_name_ar: card.canonicalNameAr,
    canonical_name_en: card.canonicalNameEn,
    lowest_price: card.lowestPrice.toFixed(2),
    lowest_price_availability: card.lowestPriceAvailability,
    image_url: card.imageUrl,
    brand_name: card.brandName,
    category_name: card.categoryName,
    store_count: card.storeCount,
    colors: card.colors,
    sizes: card.sizes,
    cheapest_offer: {
      vendor_id: card.cheapestOffer.vendorId,
      vendor_slug: card.cheapestOffer.vendorSlug,
      offer_id: card.cheapestOffer.offerId,
      offer_variant_id: card.cheapestOffer.offerVariantId,
    },
    store_logos: card.storeLogos.map((logo) => ({
      vendor_id: logo.vendorId,
      vendor_slug: logo.vendorSlug,
      display_name: logo.displayName,
      logo_url: logo.logoUrl,
      offer_id: logo.offerId,
      offer_variant_id: logo.offerVariantId,
      price: logo.price.toFixed(2),
    })),
  };
}
