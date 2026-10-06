import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import {
  decodeCursor,
  encodeCursor,
  isIsoDateString,
  isUuidLike,
  parseLimit,
} from '../platform-admin/cursor.util';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CanonicalNamingService } from './canonical-naming.service';
import { MatchReviewDecisionDto } from './dto/match-review-decision.dto';
import { RequestNameChangeDto } from './dto/request-name-change.dto';
import { MatchingService } from './matching.service';

const isFiniteNumberLike = (v: unknown): boolean =>
  typeof v === 'number' && Number.isFinite(v);

export function nameChangeRequestDto(r: {
  id: string;
  canonicalProductId: string;
  vendorId: string;
  requestedNameAr: string;
  requestedNameEn: string;
  reason: string | null;
  status: string;
  decidedById: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: r.id,
    canonical_product_id: r.canonicalProductId,
    vendor_id: r.vendorId,
    requested_name_ar: r.requestedNameAr,
    requested_name_en: r.requestedNameEn,
    reason: r.reason,
    status: r.status,
    decided_by_id: r.decidedById,
    decided_at: r.decidedAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  };
}

// Review-round fix (owner matching UI): the owner never needs to know
// which platform staff member decided their rename request -
// decided_by_id is an internal reviewer identity, not something this
// DTO exposes. A deliberately separate function from
// nameChangeRequestDto() above (which stays as the fuller shape used
// nowhere by an owner-facing route) rather than one shape with an
// optional field, so a future field added to the admin-facing DTO
// never silently leaks here too.
function ownerNameChangeRequestDto(r: {
  id: string;
  canonicalProductId: string;
  requestedNameAr: string;
  requestedNameEn: string;
  reason: string | null;
  status: string;
  decidedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: r.id,
    canonical_product_id: r.canonicalProductId,
    requested_name_ar: r.requestedNameAr,
    requested_name_en: r.requestedNameEn,
    reason: r.reason,
    status: r.status,
    decided_at: r.decidedAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  };
}

function candidateDto(c: {
  id: string;
  offerVariantId: string;
  canonicalVariantId: string;
  score: number;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
}) {
  return {
    id: c.id,
    offer_variant_id: c.offerVariantId,
    canonical_variant_id: c.canonicalVariantId,
    score: c.score,
    status: c.status,
    created_at: c.createdAt.toISOString(),
    decided_at: c.decidedAt?.toISOString() ?? null,
  };
}

// Review-round fix (owner matching UI): candidateDto() above is the
// bare shape search()/listCandidates()/decide() already return - each
// of those is called with offerId/variantId already in the URL, so it
// never needed offer/variant/canonical display data. queue() is
// different: it is the one vendor-wide list a review-queue UI would
// actually render cards from, with no other context to draw a link or
// a label from - so it alone gets this richer shape, read via `include`
// on relations that already exist (no schema change).
function queueCandidateDto(c: {
  id: string;
  score: number;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  offerVariant: {
    id: string;
    vendorOfferId: string;
    sellerSku: string;
    colour: string | null;
    size: string | null;
    vendorOffer: { titleAr: string; titleEn: string };
  };
  canonicalVariant: {
    id: string;
    structuralAttributes: Prisma.JsonValue;
    canonicalProduct: { modelName: string; brand: { name: string } };
  };
  source?: string;
  _count?: { matchReports: number };
}) {
  return {
    id: c.id,
    score: c.score,
    status: c.status,
    created_at: c.createdAt.toISOString(),
    decided_at: c.decidedAt?.toISOString() ?? null,
    offer_id: c.offerVariant.vendorOfferId,
    offer_variant_id: c.offerVariant.id,
    offer_title_ar: c.offerVariant.vendorOffer.titleAr,
    offer_title_en: c.offerVariant.vendorOffer.titleEn,
    variant_colour: c.offerVariant.colour,
    variant_size: c.offerVariant.size,
    variant_seller_sku: c.offerVariant.sellerSku,
    canonical_variant_id: c.canonicalVariant.id,
    canonical_model_name: c.canonicalVariant.canonicalProduct.modelName,
    canonical_brand_name: c.canonicalVariant.canonicalProduct.brand.name,
    canonical_structural_attributes: c.canonicalVariant.structuralAttributes,
    // Sprint 17b (FR-MATCH-005): a customer-reported candidate re-enters
    // this same PENDING queue - source distinguishes "normal non-exact
    // review" from "a confirmed exact-identifier match someone flagged
    // as wrong". report_count is an AGGREGATE only - never note
    // content, never reporter identity (MatchReport's own sensitivity
    // rule).
    source: c.source ?? 'NON_EXACT_SCORE',
    report_count: c._count?.matchReports ?? 0,
  };
}

// Sprint 6 (RB-MATCH-002): the non-exact match review queue. Owner-only
// throughout (@RequireVendorRole('OWNER') per method, same reasoning
// and the same per-method-not-class-level requirement documented on
// VendorOffersController) - catalog/matching decisions are the owner's
// domain, same as confirming an exact-identifier match already is.
@Controller('vendors')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class MatchReviewController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: MatchingService,
    private readonly canonicalNaming: CanonicalNamingService,
    private readonly auditLog: AuditLogService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  private async requireVariant(
    vendorId: string,
    offerId: string,
    variantId: string,
  ) {
    const variant = await this.prisma.offerVariant.findUnique({
      where: { id: variantId },
    });
    if (
      !variant ||
      variant.vendorId !== vendorId ||
      variant.vendorOfferId !== offerId
    ) {
      throw new NotFoundException({
        code: 'OFFER_VARIANT_NOT_FOUND',
        message: 'Offer variant not found for this offer',
      });
    }
    return variant;
  }

  // "طلب إعادة البحث" (request re-search, RB-MATCH-002) is simply
  // calling this endpoint again - see MatchingService.
  // searchNonExactCandidates()'s own comment for why that is safe to
  // repeat freely (never resurrects an already-decided candidate).
  @BlockWhenSuspended()
  @Post(':vendorId/offers/:offerId/variants/:variantId/match-review/search')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async search(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
  ) {
    const variant = await this.requireVariant(vendorId, offerId, variantId);
    if (variant.canonicalVariantId) {
      throw new ConflictException({
        code: 'OFFER_VARIANT_ALREADY_MATCHED',
        message: 'This offer variant is already matched to a canonical product',
      });
    }
    const candidates = await this.matching.searchNonExactCandidates(
      vendorId,
      variantId,
    );
    return candidates.map(candidateDto);
  }

  @Get(':vendorId/offers/:offerId/variants/:variantId/match-review/candidates')
  @RequireVendorRole('OWNER')
  async listCandidates(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
  ) {
    await this.requireVariant(vendorId, offerId, variantId);
    // Review-round fix: deterministic tie-break (createdAt, then id) so
    // a genuine score tie - two candidates scored identically - can't
    // leave the list order unstable across repeated reads.
    const candidates = await this.prisma.matchReviewCandidate.findMany({
      where: { vendorId, offerVariantId: variantId },
      orderBy: [{ score: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return candidates.map(candidateDto);
  }

  // Same locking/conflict pattern as VendorOffersController.
  // confirmMatch() (the exact-match flow) - a VendorOffer-row lock so
  // two different variants under the same offer being confirmed to two
  // *different* canonical products concurrently can't both read the
  // offer as unlinked and both "win".
  @BlockWhenSuspended()
  @Post(
    ':vendorId/offers/:offerId/variants/:variantId/match-review/candidates/:candidateId/decision',
  )
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  @RequireVendorRole('OWNER')
  async decide(
    @Param('vendorId') vendorId: string,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @Param('candidateId') candidateId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MatchReviewDecisionDto,
    @Req() req: Request,
  ) {
    await this.requireVariant(vendorId, offerId, variantId);

    // Sprint 7 (RB-MATCH-003): same pre-transaction, non-authoritative
    // lookup as VendorOffersController.confirmMatch() - a candidate's
    // own canonicalVariantId is immutable once created, only its
    // status changes, so this id is stable to look up before the
    // transaction purely to decide lock order (canonical_products
    // before vendor_offers, consistently - see CanonicalNamingService's
    // own comment for why the fixed order matters).
    let targetCanonicalProductId: string | null = null;
    if (dto.decision === 'approve') {
      const candidatePreCheck =
        await this.prisma.matchReviewCandidate.findUnique({
          where: { id: candidateId },
        });
      if (candidatePreCheck) {
        const canonicalVariantPreCheck =
          await this.prisma.canonicalProductVariant.findUnique({
            where: { id: candidatePreCheck.canonicalVariantId },
          });
        targetCanonicalProductId =
          canonicalVariantPreCheck?.canonicalProductId ?? null;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (targetCanonicalProductId) {
        await tx.$queryRaw`SELECT id FROM canonical_products WHERE id = ${targetCanonicalProductId} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${offerId} FOR UPDATE`;

      const candidate = await tx.matchReviewCandidate.findUnique({
        where: { id: candidateId },
      });
      if (
        !candidate ||
        candidate.vendorId !== vendorId ||
        candidate.offerVariantId !== variantId
      ) {
        throw new NotFoundException({
          code: 'MATCH_REVIEW_CANDIDATE_NOT_FOUND',
          message: 'Match review candidate not found for this offer variant',
        });
      }
      if (candidate.status !== 'PENDING') {
        throw new ConflictException({
          code: 'NO_PENDING_MATCH_REVIEW_CANDIDATE',
          message: 'This candidate has already been decided',
        });
      }

      let updated;
      if (dto.decision === 'reject') {
        updated = await tx.matchReviewCandidate.update({
          where: { id: candidateId },
          data: { status: 'REJECTED', decidedAt: new Date() },
        });
      } else {
        const canonicalVariant =
          await tx.canonicalProductVariant.findUniqueOrThrow({
            where: { id: candidate.canonicalVariantId },
          });
        const freshOffer = await tx.vendorOffer.findUniqueOrThrow({
          where: { id: offerId },
        });
        if (
          freshOffer.canonicalProductId &&
          freshOffer.canonicalProductId !== canonicalVariant.canonicalProductId
        ) {
          throw new ConflictException({
            code: 'MATCH_CONFLICTS_WITH_OFFER',
            message:
              'This offer is already linked to a different canonical product via another confirmed variant - reject this candidate or resolve the conflict first',
          });
        }

        await tx.offerVariant.update({
          where: { id: variantId },
          data: { canonicalVariantId: candidate.canonicalVariantId },
        });
        if (!freshOffer.canonicalProductId) {
          await tx.vendorOffer.update({
            where: { id: offerId },
            data: { canonicalProductId: canonicalVariant.canonicalProductId },
          });
        }
        updated = await tx.matchReviewCandidate.update({
          where: { id: candidateId },
          data: { status: 'APPROVED', decidedAt: new Date() },
        });
        // Only one match can stand for a given offer variant - every
        // other still-PENDING candidate for it is now moot.
        await tx.matchReviewCandidate.updateMany({
          where: {
            offerVariantId: variantId,
            status: 'PENDING',
            id: { not: candidateId },
          },
          data: { status: 'REJECTED', decidedAt: new Date() },
        });

        // Sprint 7 (RB-MATCH-003): same first-confirmer/adoption rule
        // as the exact-match flow - see CanonicalNamingService.
        await this.canonicalNaming.applyOnConfirm(
          tx,
          canonicalVariant.canonicalProductId,
          offerId,
          user.id,
          req.correlationId,
        );
      }

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action:
            dto.decision === 'approve'
              ? 'match_review_candidate.approved'
              : 'match_review_candidate.rejected',
          entityType: 'MatchReviewCandidate',
          entityId: candidateId,
          afterState: candidateDto(updated),
        },
        tx,
      );

      const responseBody = candidateDto(updated);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        responseBody,
        200,
      );
      return responseBody;
    });
  }

  // The vendor-wide view a review-queue UI would actually list - every
  // PENDING candidate across every offer variant for this vendor,
  // ranked highest-score first, deterministically tie-broken by
  // (createdAt, id) so a genuine score tie can never leave a candidate
  // to jump position (or be skipped/duplicated across pages) between
  // reads - the same keyset-cursor pattern
  // apps/api/src/platform-admin/admin-vendors.controller.ts already
  // uses, reusing the shared ../platform-admin/cursor.util.ts rather
  // than inventing a second cursor scheme. Sort direction is mixed
  // (score DESC, createdAt/id ASC), so the keyset condition below is
  // spelled out explicitly rather than as a single row-value tuple
  // comparison (that shortcut only works when every column sorts the
  // same direction).
  @Get(':vendorId/match-review/queue')
  @RequireVendorRole('OWNER')
  async queue(
    @Param('vendorId') vendorId: string,
    @Query('cursor') cursorRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = parseLimit(limitRaw);
    const cursor = decodeCursor(cursorRaw, [
      isFiniteNumberLike,
      isIsoDateString,
      isUuidLike,
    ]);

    const where: Prisma.MatchReviewCandidateWhereInput = {
      vendorId,
      status: 'PENDING',
    };
    if (cursor) {
      const [cursorScore, cursorCreatedAtRaw, cursorId] = cursor as [
        number,
        string,
        string,
      ];
      const cursorCreatedAt = new Date(cursorCreatedAtRaw);
      where.OR = [
        { score: { lt: cursorScore } },
        { score: cursorScore, createdAt: { gt: cursorCreatedAt } },
        {
          score: cursorScore,
          createdAt: cursorCreatedAt,
          id: { gt: cursorId },
        },
      ];
    }

    const rows = await this.prisma.matchReviewCandidate.findMany({
      where,
      orderBy: [{ score: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: {
        offerVariant: { include: { vendorOffer: true } },
        canonicalVariant: {
          include: { canonicalProduct: { include: { brand: true } } },
        },
        _count: { select: { matchReports: true } },
      },
    });

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(queueCandidateDto),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor([last.score, last.createdAt.toISOString(), last.id])
          : null,
    };
  }

  // Sprint 7 (RB-MATCH-003, Sec 3.2): "Any matched vendor may request a
  // canonical-name change for admin approve/reject." Owner-only
  // (requesting a rename is a catalog action, same PDR-009 domain as
  // confirming a match). Requires this vendor to actually have a
  // confirmed offer against this CanonicalProduct - a vendor with no
  // stake in the product has no standing to request its name changed.
  // The request itself is only ever *decided* by
  // CanonicalProductsController (PLATFORM_ADMIN) - creating one never
  // changes the name.
  @BlockWhenSuspended()
  @Post(':vendorId/canonical-products/:canonicalProductId/name-change-requests')
  @HttpCode(201)
  @UseInterceptors(IdempotencyInterceptor)
  @RequireVendorRole('OWNER')
  async requestNameChange(
    @Param('vendorId') vendorId: string,
    @Param('canonicalProductId') canonicalProductId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestNameChangeDto,
    @Req() req: Request,
  ) {
    const hasConfirmedMatch = await this.prisma.vendorOffer.findFirst({
      where: { vendorId, canonicalProductId },
    });
    if (!hasConfirmedMatch) {
      throw new ForbiddenException({
        code: 'NOT_A_MATCHED_VENDOR',
        message:
          'Your vendor account has no confirmed offer matched to this canonical product',
      });
    }

    const body = await this.prisma.$transaction(async (tx) => {
      const request = await tx.canonicalNameChangeRequest.create({
        data: {
          canonicalProductId,
          vendorId,
          requestedNameAr: dto.requested_name_ar,
          requestedNameEn: dto.requested_name_en,
          reason: dto.reason,
        },
      });
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'canonical_name_change_request.created',
          entityType: 'CanonicalNameChangeRequest',
          entityId: request.id,
          afterState: nameChangeRequestDto(request),
        },
        tx,
      );
      // The HTTP response goes to the owner who just created this
      // request - ownerNameChangeRequestDto(), never the fuller
      // nameChangeRequestDto() (decided_by_id is always null on a
      // fresh row anyway, but the same DTO the GET below uses is what
      // keeps that guarantee structural, not incidental). The audit
      // log's afterState is an internal record, not an HTTP response -
      // it keeps the fuller shape.
      const responseBody = ownerNameChangeRequestDto(request);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        responseBody,
        201,
      );
      return responseBody;
    });

    return body;
  }

  // Review-round fix (owner matching UI): the owner-scoped read this
  // vendor's own name-change-request(s) for one canonical product -
  // requestNameChange() above only ever returns the ONE row it just
  // created, with nothing to re-fetch a request's current status on a
  // later visit. Filtered by vendorId AND canonicalProductId together
  // (never canonicalProductId alone) - more than one vendor can be
  // confirmed-matched to the same canonical product, and a vendor must
  // never see another vendor's request for it. See
  // ownerNameChangeRequestDto() for why decided_by_id (an internal
  // reviewer identity) is never included here.
  @Get(':vendorId/canonical-products/:canonicalProductId/name-change-requests')
  @RequireVendorRole('OWNER')
  async listMyNameChangeRequests(
    @Param('vendorId') vendorId: string,
    @Param('canonicalProductId') canonicalProductId: string,
  ) {
    const requests = await this.prisma.canonicalNameChangeRequest.findMany({
      where: { vendorId, canonicalProductId },
      orderBy: { createdAt: 'desc' },
    });
    return requests.map(ownerNameChangeRequestDto);
  }
}
