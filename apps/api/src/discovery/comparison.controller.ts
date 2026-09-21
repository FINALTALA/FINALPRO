import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { ComparisonService } from './comparison.service';
import { comparisonCardDto } from './dto/comparison-card.dto';
import { PrismaService } from '../prisma/prisma.service';

// Sprint 8 (RB-COMP-001, PDR-015/016). Public, unauthenticated -
// comparison is the platform's core differentiator (post-sprint3-
// replan-2026-09.md's own words), not a logged-in-only feature.
@Controller('canonical-products/:id')
export class ComparisonController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
  ) {}

  private async requireCanonicalProduct(id: string) {
    const product = await this.prisma.canonicalProduct.findUnique({
      where: { id },
    });
    if (!product) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });
    }
    return product;
  }

  // PDR-015's standalone global card - "selecting the card opens the
  // cheapest eligible offer; selecting a logo opens that offer's
  // product detail inside that store."
  @Get('comparison-card')
  async getCard(@Param('id') id: string) {
    const product = await this.requireCanonicalProduct(id);
    const eligible = await this.comparison.findEligibleOffers(id);
    const card = this.comparison.buildCard(product, eligible);
    if (!card) {
      throw new NotFoundException({
        code: 'NO_ELIGIBLE_OFFERS',
        message: 'No eligible offers exist for this product yet',
      });
    }
    return comparisonCardDto(card);
  }

  // PDR-016: "Price comparison lists every eligible store offer from
  // lowest to highest... a chosen colour/size limits results to
  // matching offers." canonical_variant_id filters to exactly that
  // variant's offers - the variant-picker options themselves (`variants`
  // below) are always the FULL unfiltered set of variants that have at
  // least one eligible offer, so filtering down to one never removes
  // the other choices from the picker itself.
  @Get('comparison')
  async getComparison(
    @Param('id') id: string,
    @Query('canonical_variant_id') canonicalVariantId?: string,
  ) {
    const product = await this.requireCanonicalProduct(id);
    const eligible = await this.comparison.findEligibleOffers(id);
    if (eligible.length === 0) {
      throw new NotFoundException({
        code: 'NO_ELIGIBLE_OFFERS',
        message: 'No eligible offers exist for this product yet',
      });
    }

    const variantOptions = new Map<
      string,
      { id: string; structuralAttributes: unknown }
    >();
    for (const offer of eligible) {
      if (!variantOptions.has(offer.canonicalVariantId)) {
        variantOptions.set(offer.canonicalVariantId, {
          id: offer.canonicalVariantId,
          structuralAttributes: offer.structuralAttributes,
        });
      }
    }

    const filtered = canonicalVariantId
      ? eligible.filter((o) => o.canonicalVariantId === canonicalVariantId)
      : eligible;
    const sorted = filtered.slice().sort(this.comparison.compareOffersByPrice);

    return {
      canonical_product_id: product.id,
      canonical_name_ar: product.canonicalNameAr,
      canonical_name_en: product.canonicalNameEn,
      variants: Array.from(variantOptions.values()).map((v) => ({
        id: v.id,
        structural_attributes: v.structuralAttributes,
      })),
      offers: sorted.map((o) => ({
        vendor_id: o.vendorId,
        vendor_slug: o.vendorSlug,
        display_name: o.vendorDisplayName,
        logo_url: o.vendorLogoUrl,
        offer_id: o.offerId,
        offer_variant_id: o.offerVariantId,
        canonical_variant_id: o.canonicalVariantId,
        structural_attributes: o.structuralAttributes,
        currency: 'ILS' as const,
        price: o.price.toFixed(2),
        availability: o.availability,
      })),
    };
  }
}
