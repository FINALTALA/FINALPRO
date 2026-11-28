import { PUBLIC_CANONICAL_PRODUCT } from '../matching/public-canonical-product';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AvailabilityBucket } from '../common/availability.util';
import {
  FulfilmentEligibilityService,
  VariantFulfilment,
  ZONES,
} from '../fulfilment/fulfilment-eligibility.service';
import {
  computeEffectivePrice,
  isEffectivelyDiscounted,
} from '../offers/pricing/effective-price.util';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { primaryMediaUrl } from './comparison.service';
import { parseBoolean, parsePrice } from './discovery-filters';
import { isPriceStale } from './price-staleness.util';
import { PUBLIC_OFFER } from '../offers/platform-hold.util';

export { ZONES };
const FULFILMENTS = ['ALL', 'DELIVERY', 'PICKUP'] as const;

function bad(code: string, message: string): never {
  throw new BadRequestException({ code, message });
}

/** One confirmed offer variant of this product, as matching needs it. */
interface VariantRow {
  id: string;
  offerId: string;
  vendorId: string;
  color: string | null;
  size: string | null;
  price: number;
  basePrice: number;
  discounted: boolean;
  /** PD-2: the shared, quantity-free facts of this variant. */
  facts: VariantFulfilment;
  imageUrl: string | null;
  condition: string;
  priceLastConfirmedAt: Date;
}

/** A colour/size key: the taxonomy code, else the legacy attribute text. */
function attribute(attrs: Prisma.JsonValue, ...names: string[]): string | null {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return null;
  for (const name of names) {
    const value = (attrs as Record<string, unknown>)[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * GET /canonical-products/:id/store-comparison - this product compared
 * BETWEEN STORES: one row per store (never per colour/size variant),
 * showing that store's best offer for the current filters. Variants are
 * only used inside, for matching - colour and size must be met by ONE
 * variant together (black/M + white/L never matches white/M).
 *
 * Store filters: delivery zone (default: the signed-in customer's
 * default address zone, read from their own account - an explicit
 * `zone`, or zone=ALL, overrides it), fulfilment (delivery/pickup),
 * availability, discount, free delivery, verified store, returns.
 */
@Injectable()
export class StoreComparisonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly reviews: ReviewsService,
    private readonly fulfilment: FulfilmentEligibilityService,
  ) {}

  async compare(
    product: {
      id: string;
      canonicalNameAr: string | null;
      canonicalNameEn: string | null;
      warrantyPeriod: string | null;
      warrantyType: string | null;
    },
    query: Record<string, string | undefined>,
    userId: string | null,
  ) {
    const list = (raw: string | undefined) =>
      (raw ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .slice(0, 30);
    const colors = new Set(list(query.color));
    const sizes = new Set(list(query.size));
    const minPrice = parsePrice(query.min_price, 'min_price');
    const maxPrice = parsePrice(query.max_price, 'max_price');
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
      bad('INVALID_PRICE_FILTER', 'min_price must not exceed max_price');
    }
    const rawFulfilment = query.fulfilment?.trim().toUpperCase() || 'ALL';
    const fulfilment = FULFILMENTS.find((f) => f === rawFulfilment);
    if (!fulfilment)
      bad(
        'INVALID_FULFILMENT',
        `fulfilment must be one of ${FULFILMENTS.join(', ')}`,
      );
    const availableOnly = parseBoolean(query.available_only, 'available_only');
    const discountedOnly = parseBoolean(
      query.discounted_only,
      'discounted_only',
    );
    const freeDeliveryOnly = parseBoolean(
      query.free_delivery_only,
      'free_delivery_only',
    );
    const verifiedOnly = parseBoolean(query.verified_only, 'verified_only');
    const returnsOnly = parseBoolean(query.returns_only, 'returns_only');

    // The zone: an explicit choice wins (ALL = no restriction); otherwise
    // the signed-in customer's own default address (PD-2, shared rule).
    const choice = await this.fulfilment.resolveZone(query.zone, userId);
    const zone = choice.zone;
    const zoneSource = choice.zone_source;
    const defaultZone = choice.default_zone;

    const t = await this.taxonomy.get();
    const rows = await this.prisma.offerVariant.findMany({
      where: {
        canonicalVariantId: { not: null },
        canonicalVariant: {
          canonicalProductId: product.id,
          canonicalProduct: PUBLIC_CANONICAL_PRODUCT,
        },
        vendorOffer: PUBLIC_OFFER,
        vendor: { storefrontPublished: true, status: 'ACTIVE' },
      },
      include: {
        canonicalVariant: { select: { structuralAttributes: true } },
        media: {
          select: { url: true, kind: true },
          orderBy: { createdAt: 'asc' },
        },
        priceHistory: {
          select: { changedAt: true },
          orderBy: { changedAt: 'desc' },
          take: 1,
        },
      },
    });
    if (rows.length === 0) return null;

    // PD-2: delivery/pickup/stock per variant from the shared source
    // checkout uses (sellable branches, live holds, zone fee, slots).
    const factsByVendor = new Map<
      string,
      Awaited<ReturnType<FulfilmentEligibilityService['variantFulfilment']>>
    >();
    for (const vendorId of new Set(rows.map((r) => r.vendorId))) {
      factsByVendor.set(
        vendorId,
        await this.fulfilment.variantFulfilment(
          vendorId,
          rows.filter((r) => r.vendorId === vendorId).map((r) => r.id),
          zone,
        ),
      );
    }

    const colorName = new Map(t.colors.map((c) => [c.code, c]));
    const sizeLabel = new Map(t.sizes.map((s) => [s.code, s.label]));
    const variants: VariantRow[] = rows.map((r) => {
      const attrs = r.canonicalVariant!.structuralAttributes;
      return {
        id: r.id,
        offerId: r.vendorOfferId,
        vendorId: r.vendorId,
        color: r.colorCode ?? attribute(attrs, 'color', 'colour', 'اللون'),
        size: r.sizeCode ?? attribute(attrs, 'size', 'المقاس'),
        price: computeEffectivePrice(r),
        basePrice: Number(String(r.basePrice)),
        discounted: isEffectivelyDiscounted(r),
        facts: factsByVendor.get(r.vendorId)!.variants.get(r.id)!,
        imageUrl: primaryMediaUrl(r.media),
        condition: r.condition,
        priceLastConfirmedAt: r.priceHistory[0]?.changedAt ?? r.createdAt,
      };
    });

    const vendorIds = [...new Set(variants.map((v) => v.vendorId))];
    const [vendors, verified] = await Promise.all([
      this.prisma.vendor.findMany({
        where: { id: { in: vendorIds } },
        select: {
          id: true,
          slug: true,
          displayName: true,
          legalName: true,
          logoUrl: true,
          createdAt: true,
          storeType: true,
          returnsEnabled: true,
          returnMode: true,
          returnWindowDays: true,
        },
      }),
      this.verifiedVendors(vendorIds),
    ]);

    // Filter options: every colour/size this product really has, across
    // every store (sold-out ones included - the result says so).
    const optionColors = [
      ...new Set(variants.map((v) => v.color).filter((c): c is string => !!c)),
    ];
    const optionSizes = [
      ...new Set(variants.map((v) => v.size).filter((s): s is string => !!s)),
    ];
    const sizeOrder = new Map(t.sizes.map((s, i) => [s.code, i]));
    const colorOrder = new Map(t.colors.map((c, i) => [c.code, i]));
    const prices = variants.map((v) => v.price);

    const cheapestFirst = (a: VariantRow, b: VariantRow) =>
      a.price - b.price || (a.id < b.id ? -1 : 1);
    const stores = [];
    for (const vendor of vendors) {
      const zones = factsByVendor.get(vendor.id)?.deliveryZones ?? [];
      const returns =
        vendor.returnsEnabled && vendor.returnMode !== 'NO_RETURN';
      // Store-level filters.
      if (verifiedOnly && !verified.has(vendor.id)) continue;
      if (returnsOnly && !returns) continue;
      // Delivery the way checkout decides it: AVAILABLE for the zone, or
      // deliverable somewhere (NO_ZONE_SELECTED) when no zone is set.
      // A sold-out variant has no branch to decide on, so it counts by the
      // store serving the zone; stock itself is `available_only`'s job.
      const delivers = (v: VariantRow) =>
        v.facts.delivery.status === 'NO_ELIGIBLE_STOCK'
          ? zone
            ? zones.some((z) => z.region === zone)
            : zones.length > 0
          : zone
            ? v.facts.delivery.status === 'AVAILABLE'
            : v.facts.delivery.status === 'NO_ZONE_SELECTED';
      const freeDelivery = (v: VariantRow) =>
        zone
          ? delivers(v) && v.facts.delivery.fee === 0
          : delivers(v) && zones.some((z) => z.fee === 0);
      const inStock = (v: VariantRow) => v.facts.availability !== 'sold_out';
      const canPickUp = (v: VariantRow) =>
        v.facts.pickup.status === 'AVAILABLE';
      // Variant-level: colour AND size on the same variant.
      const own = variants.filter((v) => v.vendorId === vendor.id);
      const matching = own.filter(
        (v) =>
          (colors.size === 0 || (v.color !== null && colors.has(v.color))) &&
          (sizes.size === 0 || (v.size !== null && sizes.has(v.size))) &&
          (minPrice === null || v.price >= minPrice) &&
          (maxPrice === null || v.price <= maxPrice) &&
          (!discountedOnly || v.discounted) &&
          (!availableOnly || inStock(v)) &&
          // Pickup = that very variant in stock in a sellable physical branch.
          (fulfilment !== 'PICKUP' || canPickUp(v)) &&
          (fulfilment !== 'DELIVERY' || delivers(v)) &&
          // A zone restricts to stores delivering there (pickup ignores it).
          (!zone || fulfilment === 'PICKUP' || delivers(v)) &&
          (!freeDeliveryOnly || freeDelivery(v)),
      );
      if (matching.length === 0) continue;
      // The offer to open: the cheapest matching one in stock, else the cheapest.
      const stocked = matching.filter((v) =>
        fulfilment === 'PICKUP' ? canPickUp(v) : inStock(v),
      );
      const best = (stocked.length ? stocked : matching)
        .slice()
        .sort(cheapestFirst)[0];
      const rating = await this.reviews.getVendorRatingSummary(vendor.id);
      stores.push({
        vendor_id: vendor.id,
        vendor_slug: vendor.slug,
        display_name: vendor.displayName ?? vendor.legalName,
        logo_url: vendor.logoUrl,
        is_verified: verified.has(vendor.id),
        offer_id: best.offerId,
        offer_variant_id: best.id,
        color: best.color,
        size: best.size,
        currency: 'ILS' as const,
        price: best.price.toFixed(2),
        original_price: best.discounted ? best.basePrice.toFixed(2) : null,
        is_discounted: best.discounted,
        availability: best.facts.availability as AvailabilityBucket,
        image_url:
          best.imageUrl ?? own.find((v) => v.imageUrl)?.imageUrl ?? null,
        condition: best.condition,
        matching_variant_count: matching.length,
        colors: [
          ...new Set(
            own
              .filter(inStock)
              .map((v) => v.color)
              .filter(Boolean),
          ),
        ],
        sizes: [
          ...new Set(
            own
              .filter(inStock)
              .map((v) => v.size)
              .filter(Boolean),
          ),
        ],
        delivery: {
          zones,
          zone,
          fee: best.facts.delivery.fee,
          // NOT_IN_ZONE keeps its earlier public name.
          status:
            best.facts.delivery.status === 'NOT_IN_ZONE'
              ? 'NOT_AVAILABLE_IN_ZONE'
              : best.facts.delivery.status,
          minimum_order_value: best.facts.delivery.minimum_order_value,
          earliest_slot_date: best.facts.delivery.earliest_slot_date,
          // PD-5.1: the window's hours and the last day with one.
          earliest_slot: best.facts.delivery.earliest_slot,
          latest_slot_date: best.facts.delivery.latest_slot_date,
        },
        pickup: {
          available: canPickUp(best),
          branches: best.facts.pickup.branches.map((b) => b.name),
        },
        returns: returns
          ? { mode: vendor.returnMode, window_days: vendor.returnWindowDays }
          : null,
        warranty_period: product.warrantyPeriod,
        warranty_type: product.warrantyType,
        rating: rating.average,
        rating_count: rating.count,
        is_price_stale: isPriceStale(best.priceLastConfirmedAt),
        vendor_created_at: vendor.createdAt.getTime(),
      });
    }
    stores.sort(
      (a, b) =>
        Number(a.availability === 'sold_out') -
          Number(b.availability === 'sold_out') ||
        Number(a.price) - Number(b.price) ||
        a.vendor_created_at - b.vendor_created_at,
    );
    const cheapest =
      stores.find((s) => s.availability !== 'sold_out') ?? stores[0];

    return {
      canonical_product_id: product.id,
      canonical_name_ar: product.canonicalNameAr,
      canonical_name_en: product.canonicalNameEn,
      store_count: stores.length,
      total_store_count: vendorIds.length,
      lowest_price: cheapest ? cheapest.price : null,
      applied: {
        colors: [...colors],
        sizes: [...sizes],
        min_price: minPrice,
        max_price: maxPrice,
        zone,
        zone_source: zoneSource,
        default_zone: defaultZone,
        fulfilment,
        available_only: availableOnly,
        discounted_only: discountedOnly,
        free_delivery_only: freeDeliveryOnly,
        verified_only: verifiedOnly,
        returns_only: returnsOnly,
      },
      filter_options: {
        colors: optionColors
          .sort(
            (a, b) =>
              (colorOrder.get(a) ?? 999) - (colorOrder.get(b) ?? 999) ||
              a.localeCompare(b),
          )
          .map((code) => ({
            code,
            label: colorName.get(code)?.nameAr ?? code,
            hex: colorName.get(code)?.hex ?? null,
          })),
        sizes: optionSizes
          .sort(
            (a, b) =>
              (sizeOrder.get(a) ?? 999) - (sizeOrder.get(b) ?? 999) ||
              a.localeCompare(b),
          )
          .map((code) => ({ code, label: sizeLabel.get(code) ?? code })),
        price: {
          min: Math.floor(Math.min(...prices)),
          max: Math.ceil(Math.max(...prices)),
        },
        zones: ZONES,
        // Only filters the data can actually answer for these stores.
        has_discount: variants.some((v) => v.discounted),
        has_free_delivery: [...factsByVendor.values()].some((f) =>
          f.deliveryZones.some((z) => z.fee === 0),
        ),
        has_verified: verified.size > 0,
        has_returns: vendors.some(
          (v) => v.returnsEnabled && v.returnMode !== 'NO_RETURN',
        ),
        has_pickup: variants.some((v) => v.facts.pickup.status === 'AVAILABLE'),
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      stores: stores.map(({ vendor_created_at, ...s }) => ({
        ...s,
        is_cheapest: s.vendor_id === cheapest?.vendor_id,
      })),
    };
  }

  /** The same "متجر موثّق" rule as the storefront: every active physical
   * branch approved (physical/hybrid), the latest warehouse evidence
   * approved (online-only/hybrid). */
  private async verifiedVendors(vendorIds: string[]): Promise<Set<string>> {
    const [vendors, branches, evidence] = await Promise.all([
      this.prisma.vendor.findMany({
        where: { id: { in: vendorIds } },
        select: { id: true, storeType: true },
      }),
      this.prisma.storeBranch.findMany({
        where: {
          vendorId: { in: vendorIds },
          isPhysical: true,
          archivedAt: null,
        },
        select: { vendorId: true, verificationStatus: true },
      }),
      this.prisma.warehouseVerificationEvidence.findMany({
        where: { vendorId: { in: vendorIds } },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        select: { vendorId: true, status: true },
      }),
    ]);
    const result = new Set<string>();
    for (const v of vendors) {
      const needsPhysical =
        v.storeType === 'PHYSICAL' || v.storeType === 'HYBRID';
      const needsWarehouse =
        v.storeType === 'ONLINE_ONLY' || v.storeType === 'HYBRID';
      const own = branches.filter((b) => b.vendorId === v.id);
      const physicalOk =
        !needsPhysical ||
        (own.length > 0 &&
          own.every((b) => b.verificationStatus === 'APPROVED'));
      const warehouseOk =
        !needsWarehouse ||
        evidence.find((e) => e.vendorId === v.id)?.status === 'APPROVED';
      if (physicalOk && warehouseOk) result.add(v.id);
    }
    return result;
  }
}
