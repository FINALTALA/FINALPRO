import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ComparisonService, eligibleProductWhere } from './comparison.service';

const MAX_ITEMS = 4;

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/**
 * Sprint 24 (FR-COMP-001/002/007): a saved, shareable comparison set.
 * Every mutation - create's own initial batch, add, remove - locks the
 * owning ComparisonSet row first (`FOR UPDATE`), re-counts under that
 * lock, then decides: add is the only direction with a ceiling (409 at
 * 4); remove has no floor - a set may sit at 0 items until explicitly
 * deleted or added back to. Never auto-deleted by removing its last
 * item.
 */
@Injectable()
export class ComparisonSetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
  ) {}

  private async requireEligibleProduct(
    tx: Prisma.TransactionClient,
    canonicalProductId: string,
  ): Promise<void> {
    const product = await tx.canonicalProduct.findFirst({
      where: { id: canonicalProductId, ...eligibleProductWhere() },
      select: { id: true },
    });
    if (!product) {
      throw new NotFoundException({
        code: 'COMPARISON_ITEM_NOT_FOUND',
        message: 'Product not found',
      });
    }
  }

  /** BOLA-safe: id scoped to userId in the lock query itself - the
   * same 404 whether the set doesn't exist or belongs to someone
   * else. */
  private async lockOwnSet(
    tx: Prisma.TransactionClient,
    userId: string,
    setId: string,
  ): Promise<string> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM comparison_sets WHERE id = ${setId} AND "userId" = ${userId} FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new NotFoundException({
        code: 'COMPARISON_SET_NOT_FOUND',
        message: 'Comparison set not found',
      });
    }
    return rows[0].id;
  }

  async create(userId: string, canonicalProductIds: string[]) {
    return this.prisma.$transaction(async (tx) => {
      for (const id of canonicalProductIds) {
        await this.requireEligibleProduct(tx, id);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const set = await tx.comparisonSet.create({
            data: {
              userId,
              shareSlug: randomUUID(),
              items: {
                create: canonicalProductIds.map((canonicalProductId) => ({
                  canonicalProductId,
                })),
              },
            },
          });
          return { id: set.id, share_slug: set.shareSlug };
        } catch (err) {
          if (isUniqueViolation(err) && attempt < 2) continue;
          throw err;
        }
      }
      throw new Error('unreachable: shareSlug retry exhausted');
    });
  }

  async addItem(userId: string, setId: string, canonicalProductId: string) {
    return this.prisma.$transaction(async (tx) => {
      const id = await this.lockOwnSet(tx, userId, setId);
      await this.requireEligibleProduct(tx, canonicalProductId);
      const count = await tx.comparisonSetItem.count({
        where: { comparisonSetId: id },
      });
      if (count >= MAX_ITEMS) {
        throw new ConflictException({
          code: 'COMPARISON_SET_FULL',
          message: 'A comparison set can hold at most 4 items',
        });
      }
      try {
        await tx.comparisonSetItem.create({
          data: { comparisonSetId: id, canonicalProductId },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'ITEM_ALREADY_IN_SET',
            message: 'This product is already in the comparison set',
          });
        }
        throw err;
      }
      return { id };
    });
  }

  async removeItem(userId: string, setId: string, canonicalProductId: string) {
    return this.prisma.$transaction(async (tx) => {
      const id = await this.lockOwnSet(tx, userId, setId);
      await tx.comparisonSetItem.deleteMany({
        where: { comparisonSetId: id, canonicalProductId },
      });
      return { id };
    });
  }

  /** BOLA-safe: scoped by (id, userId) together, and - review-round
   * fix - a non-existent id and someone else's set id now get the
   * exact same 404, matching every other owned-resource lookup in
   * this service (lockOwnSet's own convention), never a quiet
   * no-op. */
  async delete(userId: string, setId: string): Promise<void> {
    const result = await this.prisma.comparisonSet.deleteMany({
      where: { id: setId, userId },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        code: 'COMPARISON_SET_NOT_FOUND',
        message: 'Comparison set not found',
      });
    }
  }

  async list(userId: string) {
    const sets = await this.prisma.comparisonSet.findMany({
      where: { userId },
      include: { items: { select: { canonicalProductId: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return sets.map((s) => ({
      id: s.id,
      share_slug: s.shareSlug,
      item_count: s.items.length,
      created_at: s.createdAt,
    }));
  }

  /** Owner's own read - BOLA-checked, includes the internal id (needed
   * for subsequent mutate calls) alongside the share slug. */
  async getOwn(userId: string, setId: string) {
    const set = await this.prisma.comparisonSet.findFirst({
      where: { id: setId, userId },
      include: {
        items: { select: { canonicalProductId: true, addedAt: true } },
      },
    });
    if (!set) {
      throw new NotFoundException({
        code: 'COMPARISON_SET_NOT_FOUND',
        message: 'Comparison set not found',
      });
    }
    return {
      id: set.id,
      share_slug: set.shareSlug,
      items: await this.itemsWithEligibility(set.items),
    };
  }

  /** The public, read-only, opaque-token-only view - never accepts or
   * exposes the internal id. Every item is re-checked against the same
   * public-eligibility definition ComparisonService uses, live, every
   * read - a since-unpublished vendor or archived offer never leaks
   * through a saved/shared set. */
  async getShared(shareSlug: string) {
    const set = await this.prisma.comparisonSet.findUnique({
      where: { shareSlug },
      include: {
        items: { select: { canonicalProductId: true, addedAt: true } },
      },
    });
    if (!set) {
      throw new NotFoundException({
        code: 'COMPARISON_SET_NOT_FOUND',
        message: 'Comparison set not found',
      });
    }
    return {
      share_slug: set.shareSlug,
      items: await this.itemsWithEligibility(set.items),
    };
  }

  private async itemsWithEligibility(
    items: { canonicalProductId: string; addedAt: Date }[],
  ) {
    return Promise.all(
      items.map(async (item) => {
        const product = await this.prisma.canonicalProduct.findUnique({
          where: { id: item.canonicalProductId },
          select: {
            id: true,
            canonicalNameAr: true,
            canonicalNameEn: true,
            brand: { select: { name: true } },
            category: { select: { nameAr: true } },
          },
        });
        if (!product) {
          return {
            canonical_product_id: item.canonicalProductId,
            added_at: item.addedAt,
            available: false,
          };
        }
        const eligible = await this.comparison.findEligibleOffers(product.id);
        if (eligible.length === 0) {
          return {
            canonical_product_id: product.id,
            name_ar: product.canonicalNameAr,
            name_en: product.canonicalNameEn,
            added_at: item.addedAt,
            available: false,
          };
        }
        const cheapest = eligible
          .slice()
          .sort(this.comparison.compareOffersByPrice)[0];
        return {
          canonical_product_id: product.id,
          name_ar: product.canonicalNameAr,
          name_en: product.canonicalNameEn,
          brand_name: product.brand?.name ?? null,
          category_name: product.category?.nameAr ?? null,
          // Formatted consistently with comparison.controller.ts's own
          // buildOfferRow() - every price this frontend renders is a
          // fixed "X.XX" string, never a bare number.
          lowest_price: cheapest.price.toFixed(2),
          image_url: cheapest.imageUrl,
          added_at: item.addedAt,
          available: true,
        };
      }),
    );
  }
}
