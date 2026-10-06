import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/**
 * Sprint 17b (FR-MATCH-005, Option A approved): a signed-in customer
 * reports the CURRENT confirmed match on one of their own offer-variant
 * views as wrong. Never accepts a candidate id - the current candidate
 * is always derived server-side from offer_variant_id (see report()
 * below), so BOLA is closed by construction rather than by an added
 * check.
 *
 * Unifies two originating shapes into the SAME underlying mechanism:
 * - non-exact (MatchReviewCandidate already exists, created by
 *   MatchingService.searchNonExactCandidates() and APPROVED via
 *   MatchReviewController.decide())
 * - exact-identifier (no MatchReviewCandidate ever existed - this is
 *   the FIRST report against it, so one is synthesized on the fly,
 *   source=EXACT_IDENTIFIER, score=1.0, reusing the table's own
 *   existing @@unique([offerVariantId, canonicalVariantId]) constraint
 *   for atomicity exactly like MatchingService.searchNonExactCandidates()
 *   already does for the non-exact path)
 *
 * Owner-visible surface is an aggregate count only (see
 * MatchReviewController's own queue read) - note content and reporter
 * identity are never exposed to the owner, same sensitivity class as
 * every other free-text field in this codebase that stays
 * reporter/platform-only.
 */
@Injectable()
export class MatchReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async report(
    userId: string,
    offerVariantId: string,
    note: string | undefined,
    correlationId: string,
  ): Promise<{ id: string; candidate_id: string }> {
    // "Must be a real customer, not just any session" (review-round
    // instruction): every account created via register() or a
    // first-time staff-invite-accept also gets a CustomerProfile in the
    // same transaction (see CustomersController's own comment) - an
    // account that somehow has neither (none exist today, but this is
    // the same defensive check every other /customers/me/* route
    // already performs) is rejected rather than trusted on
    // SessionAuthGuard alone.
    const customer = await this.prisma.customerProfile.findUnique({
      where: { userId },
    });
    if (!customer) {
      throw new ForbiddenException({
        code: 'NOT_A_CUSTOMER',
        message: 'This action requires a customer account',
      });
    }

    const variant = await this.prisma.offerVariant.findUnique({
      where: { id: offerVariantId },
      include: { vendorOffer: { include: { vendor: true } } },
    });
    // Same "don't confirm or deny existence to a non-eligible caller"
    // BOLA convention used throughout this codebase - a hidden/
    // unpublished vendor's offer 404s exactly like a nonexistent one.
    if (
      !variant ||
      !variant.vendorOffer.vendor.storefrontPublished ||
      variant.vendorOffer.vendor.status !== 'ACTIVE'
    ) {
      throw new NotFoundException({
        code: 'OFFER_VARIANT_NOT_FOUND',
        message: 'Offer variant not found',
      });
    }
    if (!variant.canonicalVariantId) {
      throw new ConflictException({
        code: 'OFFER_NOT_MATCHED',
        message: 'This offer is not currently matched to anything',
      });
    }
    const canonicalVariantId = variant.canonicalVariantId;

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.matchReviewCandidate.findUnique({
        where: {
          offerVariantId_canonicalVariantId: {
            offerVariantId,
            canonicalVariantId,
          },
        },
      });

      let candidateId: string;
      if (existing) {
        candidateId = await this.lockAndRequeueIfNeeded(
          tx,
          existing.id,
          userId,
          correlationId,
        );
      } else {
        // No MatchReviewCandidate has ever existed for this pair - only
        // valid if the link came from the exact-identifier path (a
        // non-exact APPROVED link always has a candidate row, since
        // that row is literally what decide() approves and rows are
        // never deleted).
        if (variant.matchProposalStatus !== 'CONFIRMED') {
          throw new ConflictException({
            code: 'MATCH_NOT_REPORTABLE',
            message: 'This match cannot be reported',
          });
        }
        candidateId = await this.getOrCreateExactIdentifierCandidate(
          tx,
          variant.vendorId,
          offerVariantId,
          canonicalVariantId,
          userId,
          correlationId,
        );
      }

      const reportId = await this.createReportIdempotent(
        tx,
        candidateId,
        userId,
        note,
      );
      return { id: reportId, candidate_id: candidateId };
    });
  }

  /** Locks the candidate row, and - only if this is the first report
   * since it was last decided (i.e. it is not already PENDING) -
   * requeues it. Returns the candidate id for convenience. */
  private async lockAndRequeueIfNeeded(
    tx: Prisma.TransactionClient,
    candidateId: string,
    userId: string,
    correlationId: string,
  ): Promise<string> {
    await tx.$queryRaw`SELECT id FROM match_review_candidates WHERE id = ${candidateId} FOR UPDATE`;
    const locked = await tx.matchReviewCandidate.findUniqueOrThrow({
      where: { id: candidateId },
    });
    if (locked.status !== 'PENDING') {
      await tx.matchReviewCandidate.update({
        where: { id: candidateId },
        data: { status: 'PENDING', decidedAt: null },
      });
      await this.auditLog.record(
        {
          actorId: userId,
          correlationId,
          action: 'match_review_candidate.requeued_from_report',
          entityType: 'MatchReviewCandidate',
          entityId: candidateId,
          beforeState: { status: locked.status },
          afterState: { status: 'PENDING' },
        },
        tx,
      );
    }
    return candidateId;
  }

  /** Atomic get-or-create reusing the table's own existing
   * (offerVariantId, canonicalVariantId) unique constraint - SAVEPOINT-
   * protected so a losing concurrent create never poisons the rest of
   * this transaction (same technique OutboxRelayService.createNotification()
   * already established, Sprint 19). */
  private async getOrCreateExactIdentifierCandidate(
    tx: Prisma.TransactionClient,
    vendorId: string,
    offerVariantId: string,
    canonicalVariantId: string,
    userId: string,
    correlationId: string,
  ): Promise<string> {
    await tx.$executeRaw`SAVEPOINT create_exact_candidate`;
    try {
      const created = await tx.matchReviewCandidate.create({
        data: {
          vendorId,
          offerVariantId,
          canonicalVariantId,
          score: 1.0,
          status: 'PENDING',
          source: 'EXACT_IDENTIFIER',
        },
      });
      await tx.$executeRaw`RELEASE SAVEPOINT create_exact_candidate`;
      await this.auditLog.record(
        {
          actorId: userId,
          correlationId,
          action: 'match_review_candidate.created_from_exact_report',
          entityType: 'MatchReviewCandidate',
          entityId: created.id,
          afterState: { source: 'EXACT_IDENTIFIER', status: 'PENDING' },
        },
        tx,
      );
      return created.id;
    } catch (err) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT create_exact_candidate`;
      if (!isUniqueViolation(err)) throw err;
      // Lost the race to another concurrent report on the same pair -
      // the winner's row now exists; lock and reuse it exactly like the
      // "existing" branch above.
      const race = await tx.matchReviewCandidate.findUniqueOrThrow({
        where: {
          offerVariantId_canonicalVariantId: {
            offerVariantId,
            canonicalVariantId,
          },
        },
      });
      return this.lockAndRequeueIfNeeded(tx, race.id, userId, correlationId);
    }
  }

  /** SAVEPOINT-protected idempotent create against
   * @@unique([candidateId, reporterUserId]) - a second report from the
   * same customer on the same candidate is a benign no-op, never a
   * duplicate row, never a raw 500. */
  private async createReportIdempotent(
    tx: Prisma.TransactionClient,
    candidateId: string,
    reporterUserId: string,
    note: string | undefined,
  ): Promise<string> {
    await tx.$executeRaw`SAVEPOINT create_report`;
    try {
      const report = await tx.matchReport.create({
        data: { candidateId, reporterUserId, note },
      });
      await tx.$executeRaw`RELEASE SAVEPOINT create_report`;
      return report.id;
    } catch (err) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT create_report`;
      if (!isUniqueViolation(err)) throw err;
      const existingReport = await tx.matchReport.findUniqueOrThrow({
        where: {
          candidateId_reporterUserId: { candidateId, reporterUserId },
        },
      });
      return existingReport.id;
    }
  }
}
