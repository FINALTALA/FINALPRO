import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReviewFit, ReviewTag } from '../../generated/prisma/client';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from '../platform-admin/cursor.util';
import { PrismaService } from '../prisma/prisma.service';
import { computeAggregateRating } from './rating-aggregate.util';
import {
  MIN_SIGNALS_TO_SUMMARISE,
  PUBLIC_REVIEW_SELECT,
  PublicReviewRow,
  publicReviewDto,
  ReviewViewer,
  SellerInfo,
} from './review-presenter';

export type ReviewSort = 'newest' | 'helpful' | 'rating_desc' | 'rating_asc';

export interface ProductReviewQuery {
  cursor?: string;
  limit?: string;
  sort?: ReviewSort;
  has_media?: 'true' | 'false';
  color?: string;
  size?: string;
  rating?: string;
  fit?: ReviewFit;
  /** A store's public slug: only reviews of items bought there. */
  store?: string;
}

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);

/**
 * PD-3 public reads. Two populations, on purpose:
 *  - the LIST (and its filter options) shows every non-HIDDEN,
 *    non-deleted review - a REPORTED one stays public until an
 *    administrator decides (Sprint 23's "innocent until decided");
 *  - the SUMMARY (average, distribution, fit, tags, with-media count)
 *    counts VISIBLE reviews only, like the Sprint 23 aggregate, and
 *    withholds each part below its minimum instead of showing a
 *    misleading figure.
 */
@Injectable()
export class ReviewReadsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForProduct(
    canonicalProductId: string,
    q: ProductReviewQuery,
    viewerUserId: string | null,
  ) {
    const product = await this.prisma.canonicalProduct.findUnique({
      where: { id: canonicalProductId },
      select: { id: true },
    });
    if (!product) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });
    }
    const sort: ReviewSort = q.sort ?? 'newest';
    const limit = parseLimit(q.limit, 30);
    const after = decodeCursor(q.cursor, [
      (v) => v === sort,
      isInt,
      isIsoDateString,
      isUuidLike,
    ]);

    const storeVendorId = q.store
      ? ((
          await this.prisma.vendor.findUnique({
            where: { slug: q.store },
            select: { id: true },
          })
        )?.id ?? null)
      : undefined;

    const listable: Prisma.ReviewWhereInput = {
      canonicalProductId,
      targetType: 'PRODUCT',
      deletedAt: null,
      moderationStatus: { not: 'HIDDEN' },
    };
    const filtered: Prisma.ReviewWhereInput = {
      ...listable,
      ...(q.has_media === 'true'
        ? { media: { some: { status: 'VISIBLE' } } }
        : {}),
      ...(q.color ? { purchasedColorCode: q.color } : {}),
      ...(q.size ? { purchasedSizeCode: q.size } : {}),
      ...(q.rating ? { rating: Number(q.rating) } : {}),
      ...(q.fit ? { fitFeedback: q.fit } : {}),
      // An unknown store slug matches nothing - an honest empty list.
      ...(storeVendorId !== undefined
        ? { sourceBranchOrderItem: { vendorId: storeVendorId ?? '' } }
        : {}),
    };

    const [rows, total, summary, filterOptions] = await Promise.all([
      this.prisma.review.findMany({
        where: after
          ? { AND: [filtered, this.keysetAfter(sort, after)] }
          : filtered,
        orderBy: this.orderBy(sort),
        take: limit + 1,
        select: PUBLIC_REVIEW_SELECT,
      }),
      this.prisma.review.count({ where: filtered }),
      this.summary(canonicalProductId),
      this.filterOptions(canonicalProductId),
    ]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const [sellers, viewer] = await Promise.all([
      this.sellers(page),
      this.viewer(viewerUserId, page),
    ]);
    return {
      aggregate: summary.aggregate,
      summary: { ...summary.parts, filter_options: filterOptions },
      total,
      reviews: page.map((r) => publicReviewDto(r, sellers, viewer)),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor([
              sort,
              sort === 'helpful'
                ? last.helpfulCount
                : sort === 'newest'
                  ? 0
                  : last.rating,
              last.createdAt.toISOString(),
              last.id,
            ])
          : null,
    };
  }

  private orderBy(sort: ReviewSort): Prisma.ReviewOrderByWithRelationInput[] {
    const tail: Prisma.ReviewOrderByWithRelationInput[] = [
      { createdAt: 'desc' },
      { id: 'desc' },
    ];
    if (sort === 'helpful') return [{ helpfulCount: 'desc' }, ...tail];
    if (sort === 'rating_desc') return [{ rating: 'desc' }, ...tail];
    if (sort === 'rating_asc') return [{ rating: 'asc' }, ...tail];
    return tail;
  }

  /** Strictly after the cursor row in orderBy()'s total order. */
  private keysetAfter(
    sort: ReviewSort,
    after: unknown[],
  ): Prisma.ReviewWhereInput {
    const key = after[1] as number;
    const createdAt = new Date(after[2] as string);
    const id = after[3] as string;
    const tail: Prisma.ReviewWhereInput[] = [
      { createdAt: { lt: createdAt } },
      { createdAt, id: { lt: id } },
    ];
    if (sort === 'newest') return { OR: tail };
    const field = sort === 'helpful' ? 'helpfulCount' : 'rating';
    const beyond = sort === 'rating_asc' ? { gt: key } : { lt: key };
    return {
      OR: [{ [field]: beyond }, ...tail.map((t) => ({ [field]: key, ...t }))],
    };
  }

  private async summary(canonicalProductId: string) {
    const visible: Prisma.ReviewWhereInput = {
      canonicalProductId,
      targetType: 'PRODUCT',
      deletedAt: null,
      moderationStatus: 'VISIBLE',
    };
    const [byRating, byFit, withMedia, tags] = await Promise.all([
      this.prisma.review.groupBy({
        by: ['rating'],
        where: visible,
        _count: { _all: true },
      }),
      this.prisma.review.groupBy({
        by: ['fitFeedback'],
        where: { ...visible, fitFeedback: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.review.count({
        where: { ...visible, media: { some: { status: 'VISIBLE' } } },
      }),
      this.prisma.$queryRaw<{ tag: ReviewTag; count: number }[]>`
        SELECT t AS tag, count(*)::int AS count
        FROM reviews r, unnest(r.tags) AS t
        WHERE r."canonicalProductId" = ${canonicalProductId}
          AND r."targetType" = 'PRODUCT' AND r."deletedAt" IS NULL
          AND r."moderationStatus" = 'VISIBLE'
        GROUP BY t
        HAVING count(*) >= ${MIN_SIGNALS_TO_SUMMARISE}
        ORDER BY count(*) DESC, t
      `,
    ]);
    const ratings = byRating.flatMap((g) =>
      Array<number>(g._count._all).fill(g.rating),
    );
    const aggregate = computeAggregateRating(ratings);
    const fitCount = (f: ReviewFit) =>
      byFit.find((g) => g.fitFeedback === f)?._count._all ?? 0;
    // NOT_APPLICABLE is an answer, but not a sizing verdict.
    const sized =
      fitCount('SMALL') + fitCount('TRUE_TO_SIZE') + fitCount('LARGE');
    return {
      aggregate,
      parts: {
        distribution:
          aggregate.average === null
            ? null
            : Object.fromEntries(
                [5, 4, 3, 2, 1].map((n) => [
                  n,
                  byRating.find((g) => g.rating === n)?._count._all ?? 0,
                ]),
              ),
        fit:
          sized < MIN_SIGNALS_TO_SUMMARISE
            ? null
            : {
                answered: sized,
                SMALL: fitCount('SMALL'),
                TRUE_TO_SIZE: fitCount('TRUE_TO_SIZE'),
                LARGE: fitCount('LARGE'),
              },
        with_media: withMedia,
        tags,
      },
    };
  }

  /** The colours/sizes/stores present in the listable reviews, with counts. */
  private async filterOptions(canonicalProductId: string) {
    const [colors, sizes, stores] = await Promise.all([
      this.prisma.$queryRaw<{ code: string; label: string; count: number }[]>`
        SELECT r."purchasedColorCode" AS code,
               max(r."purchasedColorLabel") AS label,
               count(*)::int AS count
        FROM reviews r
        LEFT JOIN taxonomy_colors c ON c.code = r."purchasedColorCode"
        WHERE r."canonicalProductId" = ${canonicalProductId}
          AND r."targetType" = 'PRODUCT' AND r."deletedAt" IS NULL
          AND r."moderationStatus" <> 'HIDDEN'
          AND r."purchasedColorCode" IS NOT NULL
        GROUP BY r."purchasedColorCode"
        ORDER BY min(c."sortOrder") NULLS LAST, 2
      `,
      this.prisma.$queryRaw<{ code: string; label: string; count: number }[]>`
        SELECT r."purchasedSizeCode" AS code,
               max(r."purchasedSizeLabel") AS label,
               count(*)::int AS count
        FROM reviews r
        LEFT JOIN taxonomy_sizes s ON s.code = r."purchasedSizeCode"
        WHERE r."canonicalProductId" = ${canonicalProductId}
          AND r."targetType" = 'PRODUCT' AND r."deletedAt" IS NULL
          AND r."moderationStatus" <> 'HIDDEN'
          AND r."purchasedSizeCode" IS NOT NULL
        GROUP BY r."purchasedSizeCode"
        ORDER BY min(s."sortOrder") NULLS LAST, 2
      `,
      this.prisma.$queryRaw<{ slug: string; name: string; count: number }[]>`
        SELECT v.slug, coalesce(v."displayName", v."legalName") AS name,
               count(*)::int AS count
        FROM reviews r
        JOIN branch_order_items i ON i.id = r."sourceBranchOrderItemId"
        JOIN vendors v ON v.id = i."vendorId"
        WHERE r."canonicalProductId" = ${canonicalProductId}
          AND r."targetType" = 'PRODUCT' AND r."deletedAt" IS NULL
          AND r."moderationStatus" <> 'HIDDEN'
          AND v."storefrontPublished" = true
        GROUP BY v.id
        ORDER BY count(*) DESC, 2
      `,
    ]);
    return { colors, sizes, stores };
  }

  /** The store each review's item was bought from - public storefronts only. */
  private async sellers(
    rows: PublicReviewRow[],
  ): Promise<Map<string, SellerInfo>> {
    const ids = [...new Set(rows.map((r) => r.sourceBranchOrderItem.vendorId))];
    if (ids.length === 0) return new Map();
    const vendors = await this.prisma.vendor.findMany({
      where: { id: { in: ids }, storefrontPublished: true },
      select: { id: true, slug: true, displayName: true, legalName: true },
    });
    return new Map(
      vendors.map((v) => [
        v.id,
        { slug: v.slug, name: v.displayName ?? v.legalName },
      ]),
    );
  }

  async viewer(
    userId: string | null,
    rows: { id: string }[],
  ): Promise<ReviewViewer | null> {
    if (!userId) return null;
    const [profile, memberships] = await Promise.all([
      this.prisma.customerProfile.findUnique({
        where: { userId },
        select: { id: true },
      }),
      this.prisma.vendorUser.findMany({
        where: { userId, status: 'ACTIVE' },
        select: { vendorId: true },
      }),
    ]);
    const votes =
      profile && rows.length
        ? await this.prisma.reviewHelpfulVote.findMany({
            where: {
              customerId: profile.id,
              reviewId: { in: rows.map((r) => r.id) },
            },
            select: { reviewId: true },
          })
        : [];
    return {
      customerId: profile?.id ?? null,
      memberVendorIds: new Set(memberships.map((m) => m.vendorId)),
      votedReviewIds: new Set(votes.map((v) => v.reviewId)),
    };
  }
}
