import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { resolveDeliveryFee } from '../checkout/checkout.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';
import {
  ComparisonDiffField,
  computeComparisonDiff,
} from './comparison-diff.util';
import { ComparisonService, EligibleOffer } from './comparison.service';
import { comparisonCardDto } from './dto/comparison-card.dto';
import { isPriceStale } from './price-staleness.util';

const ZONES = ['WEST_BANK', 'JERUSALEM', 'INSIDE'] as const;
type Zone = (typeof ZONES)[number];

function validateZone(zone: string | undefined): Zone | undefined {
  if (zone === undefined) return undefined;
  if (!ZONES.includes(zone as Zone)) {
    throw new BadRequestException({
      code: 'INVALID_ZONE',
      message: `zone must be one of ${ZONES.join(', ')}`,
    });
  }
  return zone as Zone;
}

/**
 * Sprint 24 (FR-COMP-003): per-offer comparison row fields shared by
 * both mode 1 (this controller's own getComparison) and mode 2
 * (getCrossComparison below) - condition, warranty (from the owning
 * canonical product - identical across mode-1 rows, genuinely
 * differs in mode-2), delivery fee (zone-explicit, reusing
 * checkout.service.ts's own resolveDeliveryFee() verbatim - never a
 * new default, never the customer's saved address on this guard-less
 * public route), seller rating, and the price-staleness flag.
 */
async function buildOfferRow(
  prisma: PrismaService,
  reviews: ReviewsService,
  offer: EligibleOffer,
  warranty: { warrantyPeriod: string | null; warrantyType: string | null },
  zone: Zone | undefined,
  deliveryFeeByVendor: Map<string, number | null>,
) {
  const rating = await reviews.getVendorRatingSummary(offer.vendorId);
  return {
    vendor_id: offer.vendorId,
    vendor_slug: offer.vendorSlug,
    display_name: offer.vendorDisplayName,
    logo_url: offer.vendorLogoUrl,
    offer_id: offer.offerId,
    offer_variant_id: offer.offerVariantId,
    canonical_variant_id: offer.canonicalVariantId,
    structural_attributes: offer.structuralAttributes,
    currency: 'ILS' as const,
    price: offer.price.toFixed(2),
    availability: offer.availability,
    image_url: offer.imageUrl,
    condition: offer.condition,
    // Sprint 17b: free text, no structured term model - "غير متوفر"
    // whenever genuinely absent on this product, never guessed.
    warranty_period: warranty.warrantyPeriod ?? 'غير متوفر',
    warranty_type: warranty.warrantyType ?? 'غير متوفر',
    delivery_fee:
      zone === undefined
        ? null
        : (deliveryFeeByVendor.get(offer.vendorId) ?? null),
    delivery_fee_status:
      zone === undefined
        ? 'NO_ZONE_SELECTED'
        : (deliveryFeeByVendor.get(offer.vendorId) ?? null) !== null
          ? 'AVAILABLE'
          : 'NOT_AVAILABLE_IN_ZONE',
    rating: rating.average,
    rating_count: rating.count,
    price_last_confirmed_at: offer.priceLastConfirmedAt,
    is_price_stale: isPriceStale(offer.priceLastConfirmedAt),
  };
}

async function deliveryFeesByVendor(
  prisma: PrismaService,
  vendorIds: string[],
  zone: Zone | undefined,
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (zone === undefined || vendorIds.length === 0) return result;
  const rows = await prisma.vendorDeliveryZone.findMany({
    where: { vendorId: { in: vendorIds }, region: zone },
    select: { vendorId: true, enabled: true, fee: true },
  });
  const byVendor = new Map(rows.map((r) => [r.vendorId, r]));
  for (const vendorId of vendorIds) {
    result.set(vendorId, resolveDeliveryFee(byVendor.get(vendorId) ?? null));
  }
  return result;
}

const DIFF_FIELDS = ['condition', 'warranty_period', 'warranty_type'];

// Sprint 8 (RB-COMP-001, PDR-015/016). Public, unauthenticated -
// comparison is the platform's core differentiator (post-sprint3-
// replan-2026-09.md's own words), not a logged-in-only feature.
@Controller('canonical-products/:id')
export class ComparisonController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
    private readonly reviews: ReviewsService,
  ) {}

  private async requireCanonicalProduct(id: string) {
    const product = await this.prisma.canonicalProduct.findUnique({
      where: { id },
      include: {
        brand: { select: { name: true } },
        category: { select: { nameAr: true } },
      },
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
    @Query('zone') zoneRaw?: string,
  ) {
    const zone = validateZone(zoneRaw);
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

    const deliveryFees = await deliveryFeesByVendor(
      this.prisma,
      sorted.map((o) => o.vendorId),
      zone,
    );
    const warranty = {
      warrantyPeriod: product.warrantyPeriod,
      warrantyType: product.warrantyType,
    };
    const offers = await Promise.all(
      sorted.map((o) =>
        buildOfferRow(
          this.prisma,
          this.reviews,
          o,
          warranty,
          zone,
          deliveryFees,
        ),
      ),
    );

    // FR-COMP-005: cheapest tag with a plain, honest reason - "best
    // value" is explicitly not built this sprint (decision #1, no
    // approved formula exists).
    if (offers.length > 0) {
      (
        offers[0] as { is_cheapest?: boolean; cheapest_reason?: string }
      ).is_cheapest = true;
      (
        offers[0] as { is_cheapest?: boolean; cheapest_reason?: string }
      ).cheapest_reason = 'أقل سعر بين العروض المؤهلة لهذا المنتج';
    }

    const diff: ComparisonDiffField[] = computeComparisonDiff(
      offers.map((o) => ({
        condition: o.condition,
        warranty_period: o.warranty_period,
        warranty_type: o.warranty_type,
      })),
      DIFF_FIELDS,
    );

    return {
      canonical_product_id: product.id,
      canonical_name_ar: product.canonicalNameAr,
      canonical_name_en: product.canonicalNameEn,
      variants: Array.from(variantOptions.values()).map((v) => ({
        id: v.id,
        structural_attributes: v.structuralAttributes,
      })),
      offers,
      diff,
    };
  }
}

const MIN_CROSS_PRODUCTS = 2;
const MAX_CROSS_PRODUCTS = 4;

/**
 * Sprint 24 (FR-COMP-001/002 mode 2): comparing DIFFERENT, competing
 * canonical products side by side - a separate route tree from the
 * per-product one above (this takes several product ids, not one).
 * Each product's own cheapest eligible offer represents it in the
 * table - comparing whole products, not every individual offer of
 * each.
 */
@Controller('comparison')
export class CrossComparisonController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
    private readonly reviews: ReviewsService,
  ) {}

  @Get('cross')
  async getCrossComparison(
    @Query('products') productsRaw?: string,
    @Query('zone') zoneRaw?: string,
  ) {
    const zone = validateZone(zoneRaw);
    const ids = (productsRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) {
      throw new BadRequestException({
        code: 'DUPLICATE_PRODUCT_ID',
        message: 'products must not contain duplicate ids',
      });
    }
    if (ids.length < MIN_CROSS_PRODUCTS || ids.length > MAX_CROSS_PRODUCTS) {
      throw new BadRequestException({
        code: 'INVALID_PRODUCT_COUNT',
        message: `products must contain between ${MIN_CROSS_PRODUCTS} and ${MAX_CROSS_PRODUCTS} ids`,
      });
    }

    const products = await this.prisma.canonicalProduct.findMany({
      where: { id: { in: ids } },
      include: {
        brand: { select: { name: true } },
        category: { select: { nameAr: true } },
      },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    for (const id of ids) {
      if (!byId.has(id)) {
        throw new NotFoundException({
          code: 'CANONICAL_PRODUCT_NOT_FOUND',
          message: `Product not found: ${id}`,
        });
      }
    }

    const rows = await Promise.all(
      ids.map(async (id) => {
        const product = byId.get(id)!;
        const eligible = await this.comparison.findEligibleOffers(id);
        if (eligible.length === 0) {
          return {
            canonical_product_id: id,
            canonical_name_ar: product.canonicalNameAr,
            canonical_name_en: product.canonicalNameEn,
            brand_name: product.brand?.name ?? null,
            category_name: product.category?.nameAr ?? null,
            available: false,
          };
        }
        const cheapest = eligible
          .slice()
          .sort(this.comparison.compareOffersByPrice)[0];
        const deliveryFees = await deliveryFeesByVendor(
          this.prisma,
          [cheapest.vendorId],
          zone,
        );
        const offerRow = await buildOfferRow(
          this.prisma,
          this.reviews,
          cheapest,
          {
            warrantyPeriod: product.warrantyPeriod,
            warrantyType: product.warrantyType,
          },
          zone,
          deliveryFees,
        );
        return {
          canonical_product_id: id,
          canonical_name_ar: product.canonicalNameAr,
          canonical_name_en: product.canonicalNameEn,
          brand_name: product.brand?.name ?? null,
          category_name: product.category?.nameAr ?? null,
          available: true,
          store_count: new Set(eligible.map((o) => o.vendorId)).size,
          ...offerRow,
        };
      }),
    );

    const available = rows.filter(
      (r): r is typeof r & { available: true; price: string } => r.available,
    );
    if (available.length > 0) {
      const cheapestRow = available
        .slice()
        .sort((a, b) => Number(a.price) - Number(b.price))[0];
      (
        cheapestRow as { is_cheapest?: boolean; cheapest_reason?: string }
      ).is_cheapest = true;
      (
        cheapestRow as { is_cheapest?: boolean; cheapest_reason?: string }
      ).cheapest_reason = 'أقل سعر بين المنتجات المقارَنة';
    }

    const diff: ComparisonDiffField[] = computeComparisonDiff(
      rows.map((r) => ({
        condition: 'condition' in r ? (r.condition as string | null) : null,
        warranty_period:
          'warranty_period' in r ? (r.warranty_period as string | null) : null,
        warranty_type:
          'warranty_type' in r ? (r.warranty_type as string | null) : null,
      })),
      DIFF_FIELDS,
    );

    return { products: rows, diff };
  }
}
