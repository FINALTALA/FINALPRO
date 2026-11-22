import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { mkdir, rm, unlink, writeFile } from 'fs/promises';
import * as path from 'path';
import {
  Prisma,
  ReviewAuthorDisplay,
  ReviewFit,
  ReviewTag,
} from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from '../platform-admin/cursor.util';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeAggregateRating } from './rating-aggregate.util';
import {
  editableUntil,
  MAX_REVIEW_MEDIA,
  PUBLIC_REVIEW_SELECT,
  PublicReviewRow,
  publicReviewDto,
  SellerInfo,
} from './review-presenter';
import {
  adminReviewMediaUrl,
  processReviewImage,
  reviewMediaDir,
  reviewMediaPath,
  reviewMediaUrl,
} from './review-media.util';

// PD-3 (decision 2): what a deleted review's text becomes. The row is
// kept as a tombstone so the same order item can never be reviewed
// again; the author's words, verdict, tags, images, votes and earlier
// revisions are all removed.
const DELETED_BODY = '[deleted]';

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

const notFound = () =>
  new NotFoundException({
    code: 'REVIEW_NOT_FOUND',
    message: 'Review not found',
  });

/**
 * Sprint 23 (PDR-032, FR-REV-001/002/003/005/006/008/010) + PD-3
 * (PD-FR-002). D1 (the roadmap's own open question against Sprint 23)
 * is NOT addressed here - left MISSING/OPEN, never silently assumed
 * covered. FR-REV-007 (fake-review/anomaly detection) is likewise out
 * of scope - the anti-abuse measures are purchase eligibility, the
 * one-review-per-type-per-item uniqueness constraint (which a deleted
 * tombstone keeps holding), customer reports, and "helpful" votes that
 * neither the author nor the selling store's own members may cast.
 *
 * PD-3 amends PDR-032's immutability (decision 1): the author may edit
 * within REVIEW_EDIT_WINDOW_DAYS (every edit keeps a ReviewRevision and
 * shows "معدّل"), may delete at any time, and the store never edits,
 * deletes or replies.
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly outbox: OutboxEventService,
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
   * defeat the point of testing the real constraint). PD-3: the
   * purchased title/colour/size come from the order item's own
   * snapshot (null for a pre-PD-3 order - never guessed).
   */
  async submit(
    customerId: string,
    actorUserId: string,
    dto: {
      source_branch_order_item_id: string;
      target_type: 'PRODUCT' | 'STORE';
      rating: number;
      body: string;
      fit_feedback?: ReviewFit;
      tags?: ReviewTag[];
      author_display?: ReviewAuthorDisplay;
    },
    correlationId: string,
  ) {
    if (
      dto.target_type === 'STORE' &&
      (dto.fit_feedback !== undefined || (dto.tags?.length ?? 0) > 0)
    ) {
      throw productOnly();
    }
    const id = await this.prisma.$transaction(async (tx) => {
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
      await this.assertNotSellingStoreMember(tx, customerId, item.vendorId);
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
            purchasedTitle: item.titleArSnapshot,
            purchasedColorCode: item.colorCodeSnapshot,
            purchasedColorLabel: item.colorLabelSnapshot,
            purchasedSizeCode: item.sizeCodeSnapshot,
            purchasedSizeLabel: item.sizeLabelSnapshot,
            fitFeedback: dto.fit_feedback ?? null,
            tags: dto.tags ?? [],
            authorDisplay: dto.author_display ?? 'ANONYMOUS',
          },
          select: { id: true },
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
      return created.id;
    });
    return this.presentOwn(id, customerId);
  }

  /**
   * PD-3 (decision 1): the author's edit. Content (rating, text, fit,
   * tags) only within the 30-day window, never while an open report is
   * being decided, never once hidden; every content edit keeps the
   * previous values in ReviewRevision and marks the review edited. A
   * change of author_display alone is a privacy choice, allowed any
   * time, not marked as an edit.
   */
  async edit(
    customerId: string,
    actorUserId: string,
    reviewId: string,
    dto: {
      rating?: number;
      body?: string;
      fit_feedback?: ReviewFit | null;
      tags?: ReviewTag[];
      author_display?: ReviewAuthorDisplay;
    },
    correlationId: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const review = await this.lockOwn(tx, reviewId, customerId);
      if (review.moderationStatus === 'HIDDEN') {
        throw new ConflictException({
          code: 'REVIEW_HIDDEN',
          message: 'A hidden review can no longer be changed',
        });
      }
      await this.assertNotSellingStoreMember(
        tx,
        customerId,
        await this.sellingVendorId(tx, review.sourceBranchOrderItemId),
      );
      const next = {
        rating: dto.rating ?? review.rating,
        body: dto.body ?? review.body,
        fitFeedback:
          dto.fit_feedback === undefined
            ? review.fitFeedback
            : dto.fit_feedback,
        tags: dto.tags ?? review.tags,
      };
      const contentChanged =
        next.rating !== review.rating ||
        next.body !== review.body ||
        next.fitFeedback !== review.fitFeedback ||
        next.tags.join() !== review.tags.join();
      const displayChanged =
        dto.author_display !== undefined &&
        dto.author_display !== review.authorDisplay;
      if (!contentChanged && !displayChanged) return;
      if (contentChanged) {
        if (
          review.targetType === 'STORE' &&
          (next.fitFeedback !== null || next.tags.length > 0)
        ) {
          throw productOnly();
        }
        if (review.moderationStatus === 'REPORTED') {
          throw new ConflictException({
            code: 'REVIEW_UNDER_MODERATION',
            message:
              'This review has an open report - it can be edited again once it is decided',
          });
        }
        if (editableUntil(review.createdAt) <= new Date()) {
          throw new ConflictException({
            code: 'REVIEW_EDIT_WINDOW_CLOSED',
            message: 'A review can only be edited within 30 days of writing it',
          });
        }
        await tx.reviewRevision.create({
          data: {
            reviewId,
            rating: review.rating,
            body: review.body,
            fitFeedback: review.fitFeedback,
            tags: review.tags,
            authorDisplay: review.authorDisplay,
          },
        });
      }
      await tx.review.update({
        where: { id: reviewId },
        data: {
          ...(contentChanged ? { ...next, editedAt: new Date() } : {}),
          ...(displayChanged ? { authorDisplay: dto.author_display } : {}),
        },
      });
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'review.edited',
          entityType: 'Review',
          entityId: reviewId,
          beforeState: {
            rating: review.rating,
            author_display: review.authorDisplay,
          },
          afterState: {
            rating: next.rating,
            author_display: dto.author_display ?? review.authorDisplay,
            content_changed: contentChanged,
          },
        },
        tx,
      );
    });
    return this.presentOwn(reviewId, customerId);
  }

  /**
   * PD-3 (decision 2): the author deletes their review, any time. It
   * leaves the public list and every summary at once; its text,
   * verdict, tags, revisions, votes and images are removed (image files
   * after commit); open reports are closed. The tombstone row keeps the
   * (item, target) unique constraint, so no replacement review can be
   * written for the same purchase.
   */
  async remove(
    customerId: string,
    actorUserId: string,
    reviewId: string,
    correlationId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const review = await this.lockOwn(tx, reviewId, customerId);
      const now = new Date();
      await tx.reviewReport.updateMany({
        where: { reviewId, status: 'PENDING' },
        data: {
          status: 'DISMISSED',
          decidedAt: now,
          decisionReason: 'حذف الكاتب التقييم',
        },
      });
      await tx.reviewMedia.deleteMany({ where: { reviewId } });
      await tx.reviewHelpfulVote.deleteMany({ where: { reviewId } });
      await tx.reviewRevision.deleteMany({ where: { reviewId } });
      await tx.review.update({
        where: { id: reviewId },
        data: {
          deletedAt: now,
          body: DELETED_BODY,
          fitFeedback: null,
          tags: [],
          helpfulCount: 0,
        },
      });
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'review.deleted',
          entityType: 'Review',
          entityId: reviewId,
          beforeState: {
            rating: review.rating,
            moderation_status: review.moderationStatus,
          },
        },
        tx,
      );
    });
    await this.removeFiles(reviewId);
  }

  /**
   * PD-3 (decision 8): one "helpful" per account per review. The review
   * row is locked so helpfulCount always equals the vote rows; a repeat
   * vote is a no-op (skipDuplicates), never an error or a second count.
   */
  async vote(
    customerId: string,
    userId: string,
    reviewId: string,
  ): Promise<{ voted: boolean; helpful_count: number }> {
    return this.prisma.$transaction(async (tx) => {
      const review = await this.lockPublic(tx, reviewId);
      if (review.customerId === customerId) {
        throw new ConflictException({
          code: 'CANNOT_VOTE_OWN_REVIEW',
          message: 'You cannot vote on your own review',
        });
      }
      const seller = await tx.vendorUser.findFirst({
        where: {
          userId,
          status: 'ACTIVE',
          vendorId: review.sourceBranchOrderItem.vendorId,
        },
        select: { id: true },
      });
      if (seller) {
        throw new ConflictException({
          code: 'SELLER_CANNOT_VOTE',
          message: "The selling store's own team cannot vote on its reviews",
        });
      }
      const { count } = await tx.reviewHelpfulVote.createMany({
        data: [{ reviewId, customerId }],
        skipDuplicates: true,
      });
      const updated =
        count > 0
          ? await tx.review.update({
              where: { id: reviewId },
              data: { helpfulCount: { increment: 1 } },
              select: { helpfulCount: true },
            })
          : review;
      return { voted: true, helpful_count: updated.helpfulCount };
    });
  }

  async unvote(
    customerId: string,
    reviewId: string,
  ): Promise<{ voted: boolean; helpful_count: number }> {
    return this.prisma.$transaction(async (tx) => {
      const review = await this.lockPublic(tx, reviewId);
      const { count } = await tx.reviewHelpfulVote.deleteMany({
        where: { reviewId, customerId },
      });
      const updated =
        count > 0
          ? await tx.review.update({
              where: { id: reviewId },
              data: { helpfulCount: { decrement: 1 } },
              select: { helpfulCount: true },
            })
          : review;
      return { voted: false, helpful_count: updated.helpfulCount };
    });
  }

  /**
   * PD-3 (decision 5): attach one image to the author's own PRODUCT
   * review. Same window/moderation rules as a content edit, explicit
   * publication consent, at most MAX_REVIEW_MEDIA images. The file is
   * re-encoded (metadata stripped) and written before the row; if the
   * row can't be written the file is removed again.
   */
  async addMedia(
    customerId: string,
    actorUserId: string,
    reviewId: string,
    input: { buffer: Buffer; altText: string | null; consent: boolean },
    correlationId: string,
  ) {
    if (!input.consent) {
      throw new BadRequestException({
        code: 'MEDIA_CONSENT_REQUIRED',
        message:
          'Confirm that the image may be published and shows no personal data',
      });
    }
    // Validate the review first (cheap), process the image, then insert
    // under the review's lock so the count limit can't be raced past.
    await this.prisma.$transaction((tx) =>
      this.assertCanAddMedia(tx, reviewId, customerId, false),
    );
    const image = await processReviewImage(input.buffer);
    const fileName = `${randomBytes(16).toString('hex')}.webp`;
    const filePath = reviewMediaPath(reviewId, fileName);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, image.buffer, { flag: 'wx' });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const count = await this.assertCanAddMedia(
          tx,
          reviewId,
          customerId,
          true,
        );
        const last = await tx.reviewMedia.findFirst({
          where: { reviewId },
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true },
        });
        const media = await tx.reviewMedia.create({
          data: {
            reviewId,
            customerId,
            fileName,
            mimeType: 'image/webp',
            sizeBytes: image.buffer.length,
            width: image.width,
            height: image.height,
            altText: input.altText,
            sortOrder: (last?.sortOrder ?? -1) + 1,
          },
        });
        await this.auditLog.record(
          {
            actorId: actorUserId,
            correlationId,
            action: 'review.media_added',
            entityType: 'Review',
            entityId: reviewId,
            afterState: {
              media_id: media.id,
              size_bytes: media.sizeBytes,
              images: count + 1,
            },
          },
          tx,
        );
        return {
          id: media.id,
          url: reviewMediaUrl(media.id),
          alt_text: media.altText,
          width: media.width,
          height: media.height,
          sort_order: media.sortOrder,
        };
      });
    } catch (err) {
      await unlink(filePath).catch(() => undefined);
      throw err;
    }
  }

  /** PD-3: the author removes one of their images - any time (privacy). */
  async removeMedia(
    customerId: string,
    actorUserId: string,
    reviewId: string,
    mediaId: string,
    correlationId: string,
  ): Promise<void> {
    const media = await this.prisma.$transaction(async (tx) => {
      await this.lockOwn(tx, reviewId, customerId);
      const row = await tx.reviewMedia.findFirst({
        where: { id: mediaId, reviewId },
      });
      if (!row) {
        throw new NotFoundException({
          code: 'REVIEW_MEDIA_NOT_FOUND',
          message: 'Image not found',
        });
      }
      await tx.reviewMedia.delete({ where: { id: mediaId } });
      await this.auditLog.record(
        {
          actorId: actorUserId,
          correlationId,
          action: 'review.media_removed',
          entityType: 'Review',
          entityId: reviewId,
          beforeState: { media_id: mediaId, status: row.status },
        },
        tx,
      );
      return row;
    });
    await unlink(reviewMediaPath(reviewId, media.fileName)).catch((err) =>
      this.logger.warn(`review image file not removed: ${String(err)}`),
    );
  }

  /** A public image's file, or null when it must not be served. */
  async publicMediaFile(mediaId: string): Promise<string | null> {
    const media = await this.prisma.reviewMedia.findFirst({
      where: {
        id: mediaId,
        status: 'VISIBLE',
        review: { deletedAt: null, moderationStatus: { not: 'HIDDEN' } },
      },
      select: { reviewId: true, fileName: true },
    });
    return media ? reviewMediaPath(media.reviewId, media.fileName) : null;
  }

  /** Any image's file, for an administrator's moderation view. */
  async adminMediaFile(mediaId: string): Promise<string | null> {
    const media = await this.prisma.reviewMedia.findUnique({
      where: { id: mediaId },
      select: { reviewId: true, fileName: true },
    });
    return media ? reviewMediaPath(media.reviewId, media.fileName) : null;
  }

  /**
   * Sprint 23 (PDR-032: "reports may hide them after admin review").
   * Locks the review row first so a report filed the instant a
   * PLATFORM_ADMIN decision lands can never land against a stale
   * (not-yet-HIDDEN) read. The first PENDING report against an
   * otherwise-VISIBLE review moves it to REPORTED (still publicly
   * visible - see vendorReviews()/ReviewReadsService - but excluded from
   * the aggregate); a review already REPORTED (or already HIDDEN,
   * rejected above) stays exactly as it is - a second reporter's
   * report is additional evidence for the same queue entry, never a
   * second transition. PD-3: a report may point at one image.
   */
  async report(
    customerId: string,
    actorUserId: string,
    reviewId: string,
    reason: string,
    correlationId: string,
    mediaId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM reviews WHERE id = ${reviewId} FOR UPDATE`;
      const review = await tx.review.findUnique({ where: { id: reviewId } });
      if (!review || review.deletedAt !== null) throw notFound();
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
      if (
        mediaId &&
        !(await tx.reviewMedia.findFirst({
          where: { id: mediaId, reviewId, status: 'VISIBLE' },
          select: { id: true },
        }))
      ) {
        throw new NotFoundException({
          code: 'REVIEW_MEDIA_NOT_FOUND',
          message: 'Image not found',
        });
      }
      let created;
      try {
        created = await tx.reviewReport.create({
          data: { reviewId, reporterId: customerId, reason, mediaId },
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
          afterState: { review_id: reviewId, media_id: mediaId ?? null },
        },
        tx,
      );
      return { id: created.id, status: created.status };
    });
  }

  /**
   * PLATFORM_ADMIN's moderation queue: every review with at least one
   * PENDING report, with everything needed to decide - its images
   * (hidden ones too, through the admin-only file route), its earlier
   * revisions and each report's reason and image.
   */
  async listReported() {
    const rows = await this.prisma.review.findMany({
      where: { deletedAt: null, reports: { some: { status: 'PENDING' } } },
      select: {
        ...PUBLIC_REVIEW_SELECT,
        media: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            altText: true,
            width: true,
            height: true,
            status: true,
            hiddenReason: true,
          },
        },
        revisions: {
          orderBy: { revisedAt: 'asc' },
          select: { rating: true, body: true, revisedAt: true },
        },
        reports: {
          where: { status: 'PENDING' },
          select: { id: true, reason: true, mediaId: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const sellers = await this.sellers(rows);
    return rows.map((r) => ({
      ...publicReviewDto({ ...r, media: [] }, sellers, null),
      media: r.media.map((m) => ({
        id: m.id,
        url: adminReviewMediaUrl(m.id),
        alt_text: m.altText,
        width: m.width,
        height: m.height,
        status: m.status,
        hidden_reason: m.hiddenReason,
      })),
      revisions: r.revisions.map((v) => ({
        rating: v.rating,
        body: v.body,
        revised_at: v.revisedAt,
      })),
      pending_reports: r.reports.map((rep) => ({
        id: rep.id,
        reason: rep.reason,
        media_id: rep.mediaId,
        created_at: rep.createdAt,
      })),
    }));
  }

  /**
   * Resolves every PENDING report against this review at once -
   * never one report at a time while others sit open against an
   * already-decided review. PD-3: the reason is kept on the reports and
   * in the audit log; an uphold notifies the author (decision 12).
   */
  async decide(
    adminUserId: string,
    reviewId: string,
    decision: 'dismiss' | 'uphold',
    correlationId: string,
    reason?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM reviews WHERE id = ${reviewId} FOR UPDATE`;
      const review = await tx.review.findUnique({
        where: { id: reviewId },
        include: { customer: { select: { userId: true } } },
      });
      if (!review) throw notFound();
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
          decisionReason: reason ?? null,
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
          afterState: {
            decision,
            reason: reason ?? null,
            pending_reports_resolved: pendingCount,
          },
        },
        tx,
      );
      if (decision === 'uphold') {
        const product = review.targetType === 'PRODUCT';
        await this.outbox.enqueue(
          {
            eventType: product
              ? 'review.hidden_product'
              : 'review.hidden_store',
            audience: 'CUSTOMER',
            payload: {
              recipient_user_id: review.customer.userId,
              review_id: reviewId,
              canonical_product_id: review.canonicalProductId,
              vendor_id: review.vendorId,
              reason,
            },
          },
          tx,
        );
      }
      return {
        review_id: reviewId,
        decision,
        moderation_status: moderationStatus,
      };
    });
  }

  /** PD-3: an administrator hides one image (not the whole review). */
  async hideMedia(
    adminUserId: string,
    reviewId: string,
    mediaId: string,
    reason: string,
    correlationId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const media = await tx.reviewMedia.findFirst({
        where: { id: mediaId, reviewId },
      });
      if (!media) {
        throw new NotFoundException({
          code: 'REVIEW_MEDIA_NOT_FOUND',
          message: 'Image not found',
        });
      }
      if (media.status === 'HIDDEN') {
        throw new ConflictException({
          code: 'REVIEW_MEDIA_ALREADY_HIDDEN',
          message: 'This image is already hidden',
        });
      }
      await tx.reviewMedia.update({
        where: { id: mediaId },
        data: {
          status: 'HIDDEN',
          hiddenReason: reason,
          hiddenByUserId: adminUserId,
          hiddenAt: new Date(),
        },
      });
      await this.auditLog.record(
        {
          actorId: adminUserId,
          correlationId,
          action: 'review.media_hidden',
          entityType: 'Review',
          entityId: reviewId,
          afterState: { media_id: mediaId, reason },
        },
        tx,
      );
      return { media_id: mediaId, status: 'HIDDEN' as const };
    });
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
      where: { vendorId, deletedAt: null, moderationStatus: { not: 'HIDDEN' } },
      select: PUBLIC_REVIEW_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    const sellers = await this.sellers(rows);
    return {
      // Same REPORTED-visible-but-not-aggregated rule as the product
      // reviews (ReviewReadsService).
      aggregate: computeAggregateRating(
        rows
          .filter((r) => r.moderationStatus === 'VISIBLE')
          .map((r) => r.rating),
      ),
      reviews: rows.map((r) => publicReviewDto(r, sellers, null)),
    };
  }

  /**
   * PD-3 (decision 11): the store owner's read-only view of every
   * review of what their store sold (PRODUCT reviews of their items)
   * and of the store itself - hidden and deleted ones excluded, newest
   * first, cursor-paginated. No edit, delete or reply exists.
   */
  async ownerReviews(
    vendorId: string,
    q: { cursor?: string; limit?: string; target?: 'PRODUCT' | 'STORE' },
  ) {
    const limit = parseLimit(q.limit, 50);
    const after = decodeCursor(q.cursor, [isIsoDateString, isUuidLike]);
    const where: Prisma.ReviewWhereInput = {
      deletedAt: null,
      moderationStatus: { not: 'HIDDEN' },
      ...(q.target === 'STORE'
        ? { targetType: 'STORE', vendorId }
        : q.target === 'PRODUCT'
          ? { targetType: 'PRODUCT', sourceBranchOrderItem: { vendorId } }
          : {
              OR: [
                { targetType: 'STORE', vendorId },
                { targetType: 'PRODUCT', sourceBranchOrderItem: { vendorId } },
              ],
            }),
    };
    const keyset: Prisma.ReviewWhereInput | null = after
      ? {
          OR: [
            { createdAt: { lt: new Date(after[0] as string) } },
            {
              createdAt: new Date(after[0] as string),
              id: { lt: after[1] as string },
            },
          ],
        }
      : null;
    const [rows, visible] = await Promise.all([
      this.prisma.review.findMany({
        where: keyset ? { AND: [where, keyset] } : where,
        select: {
          ...PUBLIC_REVIEW_SELECT,
          canonicalProduct: {
            select: { canonicalNameAr: true, modelName: true },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.prisma.review.findMany({
        where: { AND: [where, { moderationStatus: 'VISIBLE' }] },
        select: { rating: true },
      }),
    ]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const sellers = await this.sellers(page);
    return {
      aggregate: computeAggregateRating(visible.map((r) => r.rating)),
      reviews: page.map((r) => ({
        ...publicReviewDto(r, sellers, null),
        product_name: r.canonicalProduct
          ? (r.canonicalProduct.canonicalNameAr ?? r.canonicalProduct.modelName)
          : null,
      })),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
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
      where: { vendorId, deletedAt: null, moderationStatus: 'VISIBLE' },
      select: { rating: true },
    });
    return computeAggregateRating(rows.map((r) => r.rating));
  }

  /** The author's own review in full, with their viewer flags. */
  async ownReview(customerId: string, reviewId: string) {
    const exists = await this.prisma.review.findFirst({
      where: { id: reviewId, customerId, deletedAt: null },
      select: { id: true },
    });
    if (!exists) throw notFound();
    return this.presentOwn(reviewId, customerId);
  }

  private async presentOwn(reviewId: string, customerId: string) {
    const row = await this.prisma.review.findUniqueOrThrow({
      where: { id: reviewId },
      select: PUBLIC_REVIEW_SELECT,
    });
    const sellers = await this.sellers([row]);
    return {
      ...publicReviewDto(row, sellers, {
        customerId,
        memberVendorIds: new Set(),
        votedReviewIds: new Set(),
      }),
      editable_until: editableUntil(row.createdAt),
      // The author's own choice, so their edit form can show it.
      author_display: row.authorDisplay,
    };
  }

  private async sellers(
    rows: Pick<PublicReviewRow, 'sourceBranchOrderItem'>[],
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

  /**
   * TB-27: a person who is, or ever was, a member of the store that sold
   * the item (owner or employee, active or suspended - memberships are
   * never deleted) may not write or change a review of that purchase -
   * neither the product review nor the store review. Checked here, in the
   * API, on submit, edit and adding an image; deleting one's own review
   * stays allowed. Reviews written before this rule are left as they are.
   */
  private async assertNotSellingStoreMember(
    tx: Prisma.TransactionClient,
    customerId: string,
    vendorId: string,
  ): Promise<void> {
    const profile = await tx.customerProfile.findUniqueOrThrow({
      where: { id: customerId },
      select: { userId: true },
    });
    const member = await tx.vendorUser.findUnique({
      where: { userId_vendorId: { userId: profile.userId, vendorId } },
      select: { id: true },
    });
    if (member) {
      throw new ForbiddenException({
        code: 'STORE_MEMBER_CANNOT_REVIEW',
        message:
          "A member of the selling store cannot review the store's own products or the store",
      });
    }
  }

  private async sellingVendorId(
    tx: Prisma.TransactionClient,
    branchOrderItemId: string,
  ): Promise<string> {
    const item = await tx.branchOrderItem.findUniqueOrThrow({
      where: { id: branchOrderItemId },
      select: { vendorId: true },
    });
    return item.vendorId;
  }

  /** The author's own, not-deleted review, locked - 404 for anyone else (BOLA-safe). */
  private async lockOwn(
    tx: Prisma.TransactionClient,
    reviewId: string,
    customerId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM reviews WHERE id = ${reviewId} FOR UPDATE`;
    const review = await tx.review.findUnique({ where: { id: reviewId } });
    if (!review || review.customerId !== customerId || review.deletedAt) {
      throw notFound();
    }
    return review;
  }

  /** A publicly listed review, locked - 404 when hidden or deleted. */
  private async lockPublic(tx: Prisma.TransactionClient, reviewId: string) {
    await tx.$queryRaw`SELECT id FROM reviews WHERE id = ${reviewId} FOR UPDATE`;
    const review = await tx.review.findUnique({
      where: { id: reviewId },
      select: {
        customerId: true,
        helpfulCount: true,
        moderationStatus: true,
        deletedAt: true,
        sourceBranchOrderItem: { select: { vendorId: true } },
      },
    });
    if (!review || review.deletedAt || review.moderationStatus === 'HIDDEN') {
      throw notFound();
    }
    return review;
  }

  /** Returns how many images the review already has. */
  private async assertCanAddMedia(
    tx: Prisma.TransactionClient,
    reviewId: string,
    customerId: string,
    lock: boolean,
  ): Promise<number> {
    const review = lock
      ? await this.lockOwn(tx, reviewId, customerId)
      : await tx.review.findUnique({ where: { id: reviewId } });
    if (!review || review.customerId !== customerId || review.deletedAt) {
      throw notFound();
    }
    await this.assertNotSellingStoreMember(
      tx,
      customerId,
      await this.sellingVendorId(tx, review.sourceBranchOrderItemId),
    );
    if (review.targetType !== 'PRODUCT') {
      throw new ConflictException({
        code: 'MEDIA_NOT_ALLOWED_ON_STORE_REVIEW',
        message: 'Images can only be attached to a product review',
      });
    }
    if (review.moderationStatus !== 'VISIBLE') {
      throw new ConflictException({
        code:
          review.moderationStatus === 'HIDDEN'
            ? 'REVIEW_HIDDEN'
            : 'REVIEW_UNDER_MODERATION',
        message: 'Images cannot be added to this review right now',
      });
    }
    if (editableUntil(review.createdAt) <= new Date()) {
      throw new ConflictException({
        code: 'REVIEW_EDIT_WINDOW_CLOSED',
        message:
          'Images can only be added within 30 days of writing the review',
      });
    }
    const count = await tx.reviewMedia.count({ where: { reviewId } });
    if (count >= MAX_REVIEW_MEDIA) {
      throw new ConflictException({
        code: 'REVIEW_MEDIA_LIMIT_REACHED',
        message: `A review can have at most ${MAX_REVIEW_MEDIA} images`,
      });
    }
    return count;
  }

  private async removeFiles(reviewId: string): Promise<void> {
    await rm(path.join(reviewMediaDir(), reviewId), {
      recursive: true,
      force: true,
    }).catch((err) =>
      this.logger.warn(`review image files not removed: ${String(err)}`),
    );
  }
}

function productOnly() {
  return new BadRequestException({
    code: 'FIELD_NOT_APPLICABLE_TO_STORE_REVIEW',
    message: 'Fit and tags belong to product reviews only',
  });
}
