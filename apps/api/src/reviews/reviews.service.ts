import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeAggregateRating } from './rating-aggregate.util';

// Sprint 23 (final decision #4): a review's author is never shown by
// name beyond displayName - no first-name/last-initial derivation (no
// such split exists anywhere in this schema - CustomerProfile.displayName
// is a single optional free-text field).
const VERIFIED_CUSTOMER_FALLBACK = 'عميل موثّق';

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

function authorLabel(displayName: string | null | undefined): string {
  return displayName && displayName.trim() !== ''
    ? displayName
    : VERIFIED_CUSTOMER_FALLBACK;
}

function reviewDto(r: {
  id: string;
  targetType: string;
  canonicalProductId: string | null;
  vendorId: string | null;
  rating: number;
  body: string;
  moderationStatus: string;
  createdAt: Date;
  customer: { displayName: string | null };
}) {
  return {
    id: r.id,
    target_type: r.targetType,
    canonical_product_id: r.canonicalProductId,
    vendor_id: r.vendorId,
    rating: r.rating,
    body: r.body,
    moderation_status: r.moderationStatus,
    author: authorLabel(r.customer.displayName),
    created_at: r.createdAt,
  };
}

/**
 * Sprint 23 (PDR-032, FR-REV-001/002/003/005/006/008/010). D1 (the
 * roadmap's own open question against this sprint) is NOT addressed
 * here or anywhere else this sprint - left MISSING/OPEN, never
 * silently assumed covered. FR-REV-007 (fake-review/anomaly
 * detection) is likewise out of scope - the only anti-abuse measures
 * are purchase eligibility, the one-review-per-type-per-item
 * uniqueness constraint, and customer reports.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Eligibility + target derivation + create, all under one
   * transaction. The target (canonicalProductId or vendorId) is never
   * taken from the client - always derived from the purchased line
   * itself, so there is nothing to spoof. Two concurrent submissions
   * for the same (item, target_type) race on the DB's own
   * reviews_sourceBranchOrderItemId_targetType_key unique index - the
   * loser's P2002 is caught below, never a lock taken ahead of the
   * insert (that would turn the race into a trivial serialization and
   * defeat the point of testing the real constraint).
   */
  async submit(
    customerId: string,
    actorUserId: string,
    dto: {
      source_branch_order_item_id: string;
      target_type: 'PRODUCT' | 'STORE';
      rating: number;
      body: string;
    },
    correlationId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.branchOrderItem.findUnique({
        where: { id: dto.source_branch_order_item_id },
        include: {
          branchOrder: {
            select: {
              status: true,
              customerOrder: { select: { customerId: true } },
            },
          },
          offerVariant: { select: { canonicalVariantId: true } },
        },
      });
      // Same 404 whether the item doesn't exist at all or belongs to
      // someone else - never a distinguishing 403 (BOLA-safe, mirrors
      // CustomerReturnsController/OrdersController's own convention).
      if (!item || item.branchOrder.customerOrder.customerId !== customerId) {
        throw new NotFoundException({
          code: 'BRANCH_ORDER_ITEM_NOT_FOUND',
          message: 'Order item not found',
        });
      }
      if (item.cancelledAt !== null) {
        throw new ConflictException({
          code: 'ITEM_CANCELLED_NOT_REVIEWABLE',
          message:
            'A cancelled item was never delivered or picked up and cannot be reviewed',
        });
      }
      if (item.branchOrder.status !== 'COMPLETED') {
        throw new ConflictException({
          code: 'NOT_ELIGIBLE_FOR_REVIEW',
          message:
            'Only a completed (delivered or picked-up) purchase can be reviewed',
        });
      }

      let canonicalProductId: string | null = null;
      let vendorId: string | null = null;
      if (dto.target_type === 'PRODUCT') {
        if (!item.offerVariant.canonicalVariantId) {
          throw new ConflictException({
            code: 'PRODUCT_NOT_ELIGIBLE_FOR_REVIEW',
            message:
              'This listing is not matched to a canonical product and cannot be reviewed',
          });
        }
        const canonicalVariant = await tx.canonicalProductVariant.findUnique({
          where: { id: item.offerVariant.canonicalVariantId },
          select: { canonicalProductId: true },
        });
        canonicalProductId = canonicalVariant!.canonicalProductId;
      } else {
        vendorId = item.vendorId;
      }

      let created;
      try {
        created = await tx.review.create({
          data: {
            customerId,
            sourceBranchOrderItemId: item.id,
            targetType: dto.target_type,
            canonicalProductId,
            vendorId,
            rating: dto.rating,
            body: dto.body,
          },
          include: { customer: { select: { displayName: true } } },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'REVIEW_ALREADY_SUBMITTED',
            message: 'A review of this type already exists for this purchase',
          });
        }
        throw err;
      }

      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'review.submitted',
          entityType: 'Review',
          entityId: created.id,
          afterState: {
            source_branch_order_item_id: item.id,
            target_type: dto.target_type,
            rating: dto.rating,
          },
        },
        tx,
      );

      return reviewDto(created);
    });
  }

  /**
   * Sprint 23 (PDR-032: "reports may hide them after admin review").
   * Locks the review row first so a report filed the instant a
   * PLATFORM_ADMIN decision lands can never land against a stale
   * (not-yet-HIDDEN) read. The first PENDING report against an
   * otherwise-VISIBLE review moves it to REPORTED (still publicly
   * visible - see vendorReviews()/listForProduct() - but excluded from
   * the aggregate); a review already REPORTED (or already HIDDEN,
   * rejected above) stays exactly as it is - a second reporter's
   * report is additional evidence for the same queue entry, never a
   * second transition.
   */
  async report(
    customerId: string,
    actorUserId: string,
    reviewId: string,
    reason: string,
    correlationId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM reviews WHERE id = ${reviewId} FOR UPDATE`;
      const review = await tx.review.findUnique({ where: { id: reviewId } });
      if (!review) {
        throw new NotFoundException({
          code: 'REVIEW_NOT_FOUND',
          message: 'Review not found',
        });
      }
      if (review.moderationStatus === 'HIDDEN') {
        throw new ConflictException({
          code: 'REVIEW_ALREADY_HIDDEN',
          message: 'This review has already been hidden',
        });
      }
      if (review.customerId === customerId) {
        throw new ConflictException({
          code: 'CANNOT_REPORT_OWN_REVIEW',
          message: 'You cannot report your own review',
        });
      }

      let created;
      try {
        created = await tx.reviewReport.create({
          data: { reviewId, reporterId: customerId, reason },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'REVIEW_ALREADY_REPORTED',
            message: 'You have already reported this review',
          });
        }
        throw err;
      }

      if (review.moderationStatus === 'VISIBLE') {
        await tx.review.update({
          where: { id: reviewId },
          data: { moderationStatus: 'REPORTED' },
        });
      }

      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'review.reported',
          entityType: 'ReviewReport',
          entityId: created.id,
          afterState: { review_id: reviewId },
        },
        tx,
      );

      return { id: created.id, status: created.status };
    });
  }

  /** PLATFORM_ADMIN's moderation queue: every review with at least one PENDING report. */
  async listReported() {
    const rows = await this.prisma.review.findMany({
      where: { reports: { some: { status: 'PENDING' } } },
      include: {
        customer: { select: { displayName: true } },
        reports: {
          where: { status: 'PENDING' },
          select: { id: true, reason: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      ...reviewDto(r),
      pending_reports: r.reports.map((rep) => ({
        id: rep.id,
        reason: rep.reason,
        created_at: rep.createdAt,
      })),
    }));
  }

  /**
   * Resolves every PENDING report against this review at once -
   * never one report at a time while others sit open against an
   * already-decided review.
   */
  async decide(
    adminUserId: string,
    reviewId: string,
    decision: 'dismiss' | 'uphold',
    correlationId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM reviews WHERE id = ${reviewId} FOR UPDATE`;
      const review = await tx.review.findUnique({ where: { id: reviewId } });
      if (!review) {
        throw new NotFoundException({
          code: 'REVIEW_NOT_FOUND',
          message: 'Review not found',
        });
      }
      const pendingCount = await tx.reviewReport.count({
        where: { reviewId, status: 'PENDING' },
      });
      if (pendingCount === 0) {
        throw new ConflictException({
          code: 'NO_PENDING_REPORTS',
          message: 'This review has no pending reports to decide',
        });
      }

      const now = new Date();
      const newReportStatus = decision === 'uphold' ? 'UPHELD' : 'DISMISSED';
      await tx.reviewReport.updateMany({
        where: { reviewId, status: 'PENDING' },
        data: {
          status: newReportStatus,
          decidedByUserId: adminUserId,
          decidedAt: now,
        },
      });

      // Always written explicitly, both directions: dismiss ->
      // REPORTED back to VISIBLE (a later report can move it to
      // REPORTED again); uphold -> HIDDEN, the one terminal state.
      const moderationStatus = decision === 'uphold' ? 'HIDDEN' : 'VISIBLE';
      await tx.review.update({
        where: { id: reviewId },
        data: { moderationStatus },
      });

      await this.auditLog.record(
        {
          actorId: adminUserId,
          correlationId,
          action:
            decision === 'uphold'
              ? 'review.report.upheld'
              : 'review.report.dismissed',
          entityType: 'Review',
          entityId: reviewId,
          afterState: { decision, pending_reports_resolved: pendingCount },
        },
        tx,
      );

      return {
        review_id: reviewId,
        decision,
        moderation_status: moderationStatus,
      };
    });
  }

  async listForProduct(canonicalProductId: string) {
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
    const rows = await this.prisma.review.findMany({
      where: { canonicalProductId, moderationStatus: { not: 'HIDDEN' } },
      include: { customer: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      // Only HIDDEN is excluded from the public list (a REPORTED
      // review stays visible until an admin actually decides) - but
      // the aggregate counts VISIBLE only, per the approved decision
      // (a review under an open report doesn't yet count).
      aggregate: computeAggregateRating(
        rows
          .filter((r) => r.moderationStatus === 'VISIBLE')
          .map((r) => r.rating),
      ),
      reviews: rows.map(reviewDto),
    };
  }

  async listForVendor(vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Store not found',
      });
    }
    return this.vendorReviews(vendor.id);
  }

  /** Same public read as listForVendor(), addressed by the storefront's
   * own public slug instead of the raw vendor id (StorefrontPublicController's
   * own convention - the frontend never needs vendorId at all). */
  async listForVendorSlug(slug: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'STOREFRONT_NOT_FOUND',
        message: 'No store found for this URL',
      });
    }
    return this.vendorReviews(vendor.id);
  }

  private async vendorReviews(vendorId: string) {
    const rows = await this.prisma.review.findMany({
      where: { vendorId, moderationStatus: { not: 'HIDDEN' } },
      include: { customer: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      // Same REPORTED-visible-but-not-aggregated rule as
      // listForProduct() above.
      aggregate: computeAggregateRating(
        rows
          .filter((r) => r.moderationStatus === 'VISIBLE')
          .map((r) => r.rating),
      ),
      reviews: rows.map(reviewDto),
    };
  }

  /**
   * Sprint 24 (FR-COMP-003 "seller rating"): a lightweight,
   * ratings-only lookup for comparison - never fetches the review rows
   * themselves (vendorReviews() above does that, for the real reviews
   * page). Same VISIBLE-only aggregate rule as everywhere else in this
   * file.
   */
  async getVendorRatingSummary(vendorId: string) {
    const rows = await this.prisma.review.findMany({
      where: { vendorId, moderationStatus: 'VISIBLE' },
      select: { rating: true },
    });
    return computeAggregateRating(rows.map((r) => r.rating));
  }
}
