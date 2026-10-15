import { Injectable, NotFoundException } from '@nestjs/common';
import { eligibleProductWhere } from '../discovery/comparison.service';
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
  } | null;
  createdAt: Date;
}) {
  return {
    id: r.id,
    target_type: r.targetType,
    canonical_product_id: r.canonicalProductId,
    offer_variant_id: r.offerVariantId,
    name_ar:
      r.canonicalProduct?.canonicalNameAr ??
      r.offerVariant?.vendorOffer.titleAr ??
      null,
    name_en:
      r.canonicalProduct?.canonicalNameEn ??
      r.offerVariant?.vendorOffer.titleEn ??
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

  async remove(userId: string, favoriteId: string) {
    await this.prisma.favorite.deleteMany({
      where: { id: favoriteId, userId },
    });
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
}
