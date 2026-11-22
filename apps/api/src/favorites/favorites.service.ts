import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eligibleProductWhere } from '../discovery/comparison.service';
import { optionalName } from '../common/text/optional-name';
import { PrismaService } from '../prisma/prisma.service';

function favoriteDto(r: {
  id: string;
  targetType: string;
  canonicalProductId: string | null;
  offerVariantId: string | null;
  canonicalProduct: {
    canonicalNameAr: string | null;
    canonicalNameEn: string | null;
  } | null;
  offerVariant: {
    vendorOffer: { titleAr: string; titleEn: string; vendorId: string };
    canonicalVariant: { canonicalProductId: string } | null;
  } | null;
  createdAt: Date;
}) {
  return {
    id: r.id,
    target_type: r.targetType,
    // Offer favourites are rendered as their real comparison/product card
    // too, so expose the canonical product behind the confirmed variant.
    canonical_product_id:
      r.canonicalProductId ??
      r.offerVariant?.canonicalVariant?.canonicalProductId ??
      null,
    offer_variant_id: r.offerVariantId,
    name_ar:
      r.canonicalProduct?.canonicalNameAr ??
      r.offerVariant?.vendorOffer.titleAr ??
      null,
    name_en:
      optionalName(r.canonicalProduct?.canonicalNameEn) ??
      optionalName(r.offerVariant?.vendorOffer.titleEn) ??
      null,
    vendor_id: r.offerVariant?.vendorOffer.vendorId ?? null,
    created_at: r.createdAt,
  };
}

/**
 * Sprint 24 (FR-FAV-001, final decision #6): PRODUCT and OFFER
 * favorites only - STORE favoriting stays StoreFollow, never
 * duplicated here (see schema.prisma's own Favorite comment).
 */
@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Target re-validated against the exact same public-eligibility
   * criteria ComparisonService uses as the single source of truth -
   * PRODUCT via the shared eligibleProductWhere(), OFFER via the same
   * clauses findEligibleOffers() applies (confirmed match + ACTIVE
   * offer + published/ACTIVE vendor), mirrored directly here rather
   * than calling that function (which is scoped to one canonical
   * product at a time - irrelevant narrowing when the exact
   * offerVariantId is already known). Any target that doesn't exist,
   * or exists but fails this check, is the identical 404 either way -
   * BOLA-safe, never a distinguishing error.
   */
  async add(
    userId: string,
    dto: {
      target_type: 'PRODUCT' | 'OFFER';
      canonical_product_id?: string;
      offer_variant_id?: string;
    },
  ) {
    if (dto.target_type === 'PRODUCT') {
      const product = await this.prisma.canonicalProduct.findFirst({
        where: { id: dto.canonical_product_id, ...eligibleProductWhere() },
        select: { id: true },
      });
      if (!product) {
        throw new NotFoundException({
          code: 'FAVORITE_TARGET_NOT_FOUND',
          message: 'Product not found',
        });
      }
      // Idempotent add under concurrency: upsert with update:{} is the
      // same shape StoreFollow.follow() already uses - two concurrent
      // "add the same favorite" requests resolve to exactly one row
      // via Postgres's own ON CONFLICT handling, no application lock
      // needed.
      await this.prisma.favorite.upsert({
        where: {
          userId_canonicalProductId: { userId, canonicalProductId: product.id },
        },
        create: {
          userId,
          targetType: 'PRODUCT',
          canonicalProductId: product.id,
        },
        update: {},
      });
      return { favorited: true };
    }

    const variant = await this.prisma.offerVariant.findFirst({
      where: {
        id: dto.offer_variant_id,
        canonicalVariantId: { not: null },
        vendorOffer: { status: 'ACTIVE' },
        vendor: { storefrontPublished: true, status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!variant) {
      throw new NotFoundException({
        code: 'FAVORITE_TARGET_NOT_FOUND',
        message: 'Offer not found',
      });
    }
    await this.prisma.favorite.upsert({
      where: { userId_offerVariantId: { userId, offerVariantId: variant.id } },
      create: { userId, targetType: 'OFFER', offerVariantId: variant.id },
      update: {},
    });
    return { favorited: true };
  }

  /** BOLA-safe: scoped by (id, userId) together, and - review-round
   * fix - a non-existent id and someone else's id now get the exact
   * same 404, matching the approved plan's own requirement, never a
   * quiet 200 no-op that would let an attacker's own request succeed
   * silently regardless of ownership. */
  async remove(userId: string, favoriteId: string) {
    const result = await this.prisma.favorite.deleteMany({
      where: { id: favoriteId, userId },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        code: 'FAVORITE_NOT_FOUND',
        message: 'Favorite not found',
      });
    }
    return { favorited: false };
  }

  /** Re-filtered live, same eligibility criteria as add() - a target
   * that stops being eligible after being favorited (vendor suspended,
   * offer archived) simply stops appearing, never purged, never a 500,
   * never a leaked partial row. */
  async list(userId: string) {
    const rows = await this.prisma.favorite.findMany({
      where: {
        userId,
        OR: [
          { targetType: 'PRODUCT', canonicalProduct: eligibleProductWhere() },
          {
            targetType: 'OFFER',
            offerVariant: {
              canonicalVariantId: { not: null },
              vendorOffer: { status: 'ACTIVE' },
              vendor: { storefrontPublished: true, status: 'ACTIVE' },
            },
          },
        ],
      },
      include: {
        canonicalProduct: {
          select: { canonicalNameAr: true, canonicalNameEn: true },
        },
        offerVariant: {
          select: {
            vendorOffer: {
              select: { titleAr: true, titleEn: true, vendorId: true },
            },
            canonicalVariant: { select: { canonicalProductId: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(favoriteDto);
  }

  /** FR-FAV-005: every alert type defaults to enabled=true when no row
   * exists yet - the same opt-out default used at snapshot time. */
  async getPreferences(userId: string) {
    const rows = await this.prisma.notificationPreference.findMany({
      where: { userId },
    });
    const byType = new Map(rows.map((r) => [r.alertType, r.enabled]));
    const alertTypes: ('PRICE_DROP' | 'BACK_IN_STOCK' | 'NEW_OFFER')[] = [
      'PRICE_DROP',
      'BACK_IN_STOCK',
      'NEW_OFFER',
    ];
    return alertTypes.map((alertType) => ({
      alert_type: alertType,
      enabled: byType.get(alertType) ?? true,
    }));
  }

  async setPreference(
    userId: string,
    alertType: 'PRICE_DROP' | 'BACK_IN_STOCK' | 'NEW_OFFER',
    enabled: boolean,
  ) {
    await this.prisma.notificationPreference.upsert({
      where: { userId_alertType: { userId, alertType } },
      create: { userId, alertType, enabled },
      update: { enabled },
    });
    return { alert_type: alertType, enabled };
  }

  /** Explicit opt-in for one exact colour x size. Kept separate from
   * favourites, whose old offer-wide alert preference remains unchanged. */
  async subscribeAvailability(userId: string, offerVariantId: string) {
    const variant = await this.prisma.offerVariant.findFirst({
      where: {
        id: offerVariantId,
        vendorOffer: {
          status: 'ACTIVE',
          vendor: { status: 'ACTIVE', storefrontPublished: true },
        },
      },
      select: {
        id: true,
        branchStocks: {
          where: { branch: { isPhysical: true, archivedAt: null } },
          select: { quantity: true, reservedQuantity: true },
        },
      },
    });
    if (!variant) {
      throw new NotFoundException({
        code: 'AVAILABILITY_TARGET_NOT_FOUND',
        message: 'This product option is not available',
      });
    }
    const available = variant.branchStocks.reduce(
      (total, row) => total + Math.max(0, row.quantity - row.reservedQuantity),
      0,
    );
    if (available > 0) {
      throw new ConflictException({
        code: 'VARIANT_AVAILABLE',
        message: 'This product option is already available',
      });
    }
    await this.prisma.variantAvailabilitySubscription.upsert({
      where: { userId_offerVariantId: { userId, offerVariantId } },
      create: { userId, offerVariantId, active: true },
      update: { active: true, notifiedAt: null },
    });
    return { subscribed: true };
  }

  async unsubscribeAvailability(userId: string, offerVariantId: string) {
    await this.prisma.variantAvailabilitySubscription.updateMany({
      where: { userId, offerVariantId, active: true },
      data: { active: false },
    });
    return { subscribed: false };
  }

  async listAvailabilitySubscriptions(userId: string, offerVariantId?: string) {
    const rows = await this.prisma.variantAvailabilitySubscription.findMany({
      where: {
        userId,
        active: true,
        ...(offerVariantId ? { offerVariantId } : {}),
      },
      include: {
        offerVariant: {
          include: {
            media: {
              where: { kind: 'PRIMARY' },
              orderBy: { sortOrder: 'asc' },
              take: 1,
              select: { url: true },
            },
            offerColor: {
              select: {
                id: true,
                nameAr: true,
                nameEn: true,
                hex: true,
                swatchUrl: true,
              },
            },
            sizeOption: { select: { code: true, label: true } },
            vendorOffer: {
              select: {
                id: true,
                titleAr: true,
                titleEn: true,
                vendor: { select: { slug: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      offer_variant_id: row.offerVariantId,
      offer_id: row.offerVariant.vendorOffer.id,
      vendor_slug: row.offerVariant.vendorOffer.vendor.slug,
      title_ar: row.offerVariant.vendorOffer.titleAr,
      title_en: row.offerVariant.vendorOffer.titleEn,
      color_name_ar:
        row.offerVariant.offerColor?.nameAr ??
        row.offerVariant.colour ??
        row.offerVariant.colorCode,
      color_name_en: row.offerVariant.offerColor?.nameEn ?? null,
      color_id: row.offerVariant.offerColor?.id ?? null,
      color_hex: row.offerVariant.offerColor?.hex ?? null,
      color_swatch_url: row.offerVariant.offerColor?.swatchUrl ?? null,
      size_code: row.offerVariant.sizeCode,
      // Taxonomy sizes currently have one display label. It is intentionally
      // returned as the fallback in either interface rather than pretending
      // there are separate Arabic/English database fields.
      size_name_ar:
        row.offerVariant.sizeOption?.label ??
        row.offerVariant.size ??
        row.offerVariant.sizeCode,
      size_name_en: row.offerVariant.sizeOption?.label ?? null,
      image_url: row.offerVariant.media[0]?.url ?? null,
      created_at: row.createdAt,
    }));
  }
}
