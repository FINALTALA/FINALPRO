import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { PlatformRole } from '../../generated/prisma/client';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { BranchVerificationDecisionDto } from './dto/branch-verification-decision.dto';
import { SubmitBranchEvidenceDto } from './dto/submit-branch-evidence.dto';

function branchToDto(branch: {
  id: string;
  vendorId: string;
  name: string;
  isPhysical: boolean;
  lat: number | null;
  lng: number | null;
  verificationPhotoUrl: string | null;
  verificationStatus: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
}) {
  return {
    id: branch.id,
    vendor_id: branch.vendorId,
    name: branch.name,
    is_physical: branch.isPhysical,
    lat: branch.lat,
    lng: branch.lng,
    verification_photo_url: branch.verificationPhotoUrl,
    verification_status: branch.verificationStatus,
    reviewed_by: branch.reviewedBy,
    reviewed_at: branch.reviewedAt?.toISOString() ?? null,
    review_note: branch.reviewNote,
  };
}

@Controller('vendors/:vendorId/branches/:branchId')
@UseGuards(SessionAuthGuard)
export class VendorVerificationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  // BL-VEND-002 (FR-VEND-002): the vendor's own owner submits (or
  // resubmits, after RESUBMISSION_REQUESTED) evidence for a physical
  // branch. Resubmission is just calling this again - it resets
  // verificationStatus back to PENDING and clears the prior reviewer's
  // decision. Only allowed for the two states where re-submission
  // actually makes sense: the vendor's application is still open
  // (APPLIED or UNDER_REVIEW) *and* this specific branch hasn't already
  // been decided (PENDING or RESUBMISSION_REQUESTED). Submitting once
  // the vendor is REJECTED/APPROVED/ACTIVE/... or once this exact
  // branch is already APPROVED/REJECTED is refused outright - this
  // build has no reapplication flow yet (⚠ OPEN-010: whether/how a
  // vendor may submit a new application after a REJECTED decision is
  // still an open product question, deliberately not decided by
  // BR-026), so letting a resubmission silently reset an already-
  // decided branch back to PENDING would leave it stuck (the decision
  // endpoint only acts on a vendor that's UNDER_REVIEW) or would let a
  // vendor un-approve a branch after the vendor itself already advanced
  // past review.
  @Post('verification-evidence')
  @UseInterceptors(IdempotencyInterceptor)
  async submitEvidence(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubmitBranchEvidenceDto,
    @Req() req: Request,
  ) {
    const membership = await this.prisma.vendorUser.findUnique({
      where: { userId_vendorId: { userId: user.id, vendorId } },
    });
    if (!membership) {
      throw new ForbiddenException({
        code: 'NOT_VENDOR_OWNER',
        message: 'You are not a member of this vendor account',
      });
    }

    const branch = await this.prisma.storeBranch.findUnique({
      where: { id: branchId },
    });
    if (!branch || branch.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Branch not found for this vendor',
      });
    }
    if (!branch.isPhysical) {
      throw new BadRequestException({
        code: 'BRANCH_NOT_PHYSICAL',
        message:
          'Verification evidence only applies to branches flagged physical (BR-022)',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Same vendor-row lock as the decision endpoint below - a
      // concurrent decision (which also locks this vendor) must not
      // interleave with the checks or the APPLIED -> UNDER_REVIEW
      // transition below.
      await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;

      // Both reads are fresh, taken under the lock - the vendor's
      // status and this branch's own decision can both have changed
      // since the pre-transaction reads above (a concurrent decision).
      const vendor = await tx.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      if (vendor.status !== 'APPLIED' && vendor.status !== 'UNDER_REVIEW') {
        throw new ConflictException({
          code: 'VENDOR_NOT_REVIEWABLE',
          message:
            'This vendor application has already been decided and this build has no resubmission/reapplication flow yet',
        });
      }

      const freshBranch = await tx.storeBranch.findUniqueOrThrow({
        where: { id: branchId },
      });
      if (
        freshBranch.verificationStatus !== 'PENDING' &&
        freshBranch.verificationStatus !== 'RESUBMISSION_REQUESTED'
      ) {
        throw new ConflictException({
          code: 'BRANCH_ALREADY_DECIDED',
          message:
            'This branch has already been approved or rejected and cannot be resubmitted',
        });
      }

      const updatedBranch = await tx.storeBranch.update({
        where: { id: branchId },
        data: {
          lat: dto.lat,
          lng: dto.lng,
          verificationPhotoUrl: dto.verification_photo_url,
          verificationStatus: 'PENDING',
          reviewedBy: null,
          reviewedAt: null,
          reviewNote: null,
        },
      });

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'store_branch.evidence_submitted',
          entityType: 'StoreBranch',
          entityId: freshBranch.id,
          beforeState: branchToDto(freshBranch),
          afterState: branchToDto(updatedBranch),
        },
        tx,
      );

      // FR-VEND-008: evidence for a branch is what makes a still-Applied
      // vendor become reviewable at all - the first evidence submission
      // advances the vendor's own lifecycle. A vendor already
      // UNDER_REVIEW (a second branch's evidence, or a resubmission)
      // stays as-is.
      if (vendor.status === 'APPLIED') {
        await tx.vendor.update({
          where: { id: vendorId },
          data: { status: 'UNDER_REVIEW' },
        });
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'vendor.under_review',
            entityType: 'Vendor',
            entityId: vendorId,
            beforeState: { status: 'APPLIED' },
            afterState: { status: 'UNDER_REVIEW' },
          },
          tx,
        );
      }

      const body = branchToDto(updatedBranch);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        201,
      );
      return body;
    });

    return updated;
  }

  // BL-VEND-003 (FR-VEND-003): a vendor-verification-reviewer approves,
  // rejects, or requests resubmission of that evidence. Only applies to
  // a branch currently PENDING for a vendor currently UNDER_REVIEW - see
  // the fresh in-lock reads below for why both are re-checked instead of
  // trusted from the pre-transaction reads above. The vendor's own
  // lifecycle (FR-VEND-008) advances from a branch decision as follows:
  // approving the last pending physical branch -> APPROVED; rejecting
  // any physical branch's evidence -> REJECTED (BR-026/BDR-016: no
  // per-branch partial state at the vendor level - a product decision
  // confirmed by the product owner on review of this endpoint,
  // resolving OPEN-005's rejection-criteria half; reviewer assignment,
  // the other half, is still open. Whether/how a REJECTED vendor may
  // submit a new application is a *separate*, still-open question -
  // ⚠ OPEN-010 - this build simply has no such flow yet); requesting
  // resubmission leaves the vendor UNDER_REVIEW so it can be
  // resubmitted and decided again.
  @Post('verification-decision')
  @UseGuards(PlatformRoleGuard)
  @RequirePlatformRole(
    PlatformRole.VERIFICATION_REVIEWER,
    PlatformRole.PLATFORM_ADMIN,
  )
  @UseInterceptors(IdempotencyInterceptor)
  async decide(
    @Param('vendorId') vendorId: string,
    @Param('branchId') branchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BranchVerificationDecisionDto,
    @Req() req: Request,
  ) {
    const branch = await this.prisma.storeBranch.findUnique({
      where: { id: branchId },
    });
    if (!branch || branch.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Branch not found for this vendor',
      });
    }
    if (!branch.isPhysical) {
      throw new BadRequestException({
        code: 'BRANCH_NOT_PHYSICAL',
        message:
          'Verification decisions only apply to branches flagged physical (BR-022)',
      });
    }

    const nextStatus =
      dto.decision === 'approve'
        ? 'APPROVED'
        : dto.decision === 'reject'
          ? 'REJECTED'
          : 'RESUBMISSION_REQUESTED';

    const responseBody = await this.prisma.$transaction(async (tx) => {
      // Serializes concurrent decisions for the SAME vendor so the
      // "are all physical branches now approved" read below can't
      // race with another reviewer's concurrent approval of a
      // sibling branch (classic lost-update: both read the sibling
      // as still-pending before either commits, so neither promotes
      // the vendor even though both approvals together should have).
      // Different vendors never contend for this lock.
      await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;

      // Every check below reads *fresh*, inside the lock - the
      // vendor's review state and this branch's own evidence/status
      // can both have changed since the pre-transaction reads above
      // (another decision, or a concurrent resubmission).
      const vendor = await tx.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      if (vendor.status !== 'UNDER_REVIEW') {
        throw new ConflictException({
          code: 'VENDOR_NOT_UNDER_REVIEW',
          message:
            'This vendor has no branch evidence awaiting review (submit evidence first, or its application has already been decided)',
        });
      }

      const freshBranch = await tx.storeBranch.findUniqueOrThrow({
        where: { id: branchId },
      });
      if (freshBranch.verificationStatus !== 'PENDING') {
        throw new ConflictException({
          code: 'BRANCH_NOT_PENDING',
          message:
            'This branch has already been decided - the vendor must resubmit evidence before it can be decided again',
        });
      }
      // BR-022: a physical branch cannot be approved without an
      // attached geolocation pin and storefront photo. Rejecting or
      // requesting resubmission of *incomplete* evidence is exactly
      // the intended path for evidence that never met this bar -
      // only 'approve' is blocked here.
      if (
        dto.decision === 'approve' &&
        (freshBranch.lat === null ||
          freshBranch.lng === null ||
          !freshBranch.verificationPhotoUrl)
      ) {
        throw new BadRequestException({
          code: 'BRANCH_EVIDENCE_INCOMPLETE',
          message:
            'Cannot approve a branch missing a geolocation pin or storefront photo (BR-022)',
        });
      }

      const updated = await tx.storeBranch.update({
        where: { id: branchId },
        data: {
          verificationStatus: nextStatus,
          reviewedBy: user.id,
          reviewedAt: new Date(),
          reviewNote: dto.decision === 'approve' ? null : (dto.reason ?? null),
        },
      });

      // FR-VEND-008 lifecycle mapping for a branch decision:
      //  - approve, and no physical branch is left pending -> vendor
      //    UNDER_REVIEW -> APPROVED.
      //  - reject -> vendor UNDER_REVIEW -> REJECTED unconditionally
      //    (BR-026/BDR-016 - rejecting evidence for any one physical
      //    branch rejects the whole application; no per-branch partial
      //    state. Reapplication after REJECTED is a separate, still-
      //    open question - ⚠ OPEN-010 - not decided by this rule).
      //  - request_resubmission -> no vendor transition; the vendor
      //    stays UNDER_REVIEW and can resubmit evidence for this
      //    branch (verification-evidence resets it to PENDING).
      let vendorNextStatus: 'APPROVED' | 'REJECTED' | null = null;
      if (dto.decision === 'approve') {
        const pendingPhysical = await tx.storeBranch.findFirst({
          where: {
            vendorId,
            isPhysical: true,
            verificationStatus: { not: 'APPROVED' },
          },
          select: { id: true },
        });
        if (!pendingPhysical) {
          vendorNextStatus = 'APPROVED';
        }
      } else if (dto.decision === 'reject') {
        vendorNextStatus = 'REJECTED';
      }

      if (vendorNextStatus) {
        await tx.vendor.update({
          where: { id: vendorId },
          data: { status: vendorNextStatus },
        });
      }

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'store_branch.verification_decided',
          entityType: 'StoreBranch',
          entityId: updated.id,
          beforeState: branchToDto(freshBranch),
          afterState: branchToDto(updated),
        },
        tx,
      );
      if (vendorNextStatus) {
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action:
              vendorNextStatus === 'APPROVED'
                ? 'vendor.approved'
                : 'vendor.rejected',
            entityType: 'Vendor',
            entityId: vendorId,
            beforeState: { status: 'UNDER_REVIEW' },
            afterState: { status: vendorNextStatus },
          },
          tx,
        );
      }

      const body = {
        ...branchToDto(updated),
        vendor_approved: vendorNextStatus === 'APPROVED',
      };
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        201,
      );
      return body;
    });

    return responseBody;
  }
}
