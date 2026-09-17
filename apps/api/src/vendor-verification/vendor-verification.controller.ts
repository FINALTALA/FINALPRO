import {
  BadRequestException,
  Body,
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
  ) {}

  // BL-VEND-002 (FR-VEND-002): the vendor's own owner submits (or
  // resubmits, after REJECTED/RESUBMISSION_REQUESTED) evidence for a
  // physical branch. Resubmission is just calling this again - it
  // resets verificationStatus back to PENDING and clears the prior
  // reviewer's decision.
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

    const updated = await this.prisma.storeBranch.update({
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

    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'store_branch.evidence_submitted',
      entityType: 'StoreBranch',
      entityId: branch.id,
      beforeState: branchToDto(branch),
      afterState: branchToDto(updated),
    });

    return branchToDto(updated);
  }

  // BL-VEND-003 (FR-VEND-003): a vendor-verification-reviewer approves,
  // rejects, or requests resubmission of that evidence. An approval
  // that leaves every one of the vendor's physical branches APPROVED
  // also advances the vendor's own lifecycle to APPROVED (FR-VEND-008) -
  // see the row-lock note below for why that check has to happen inside
  // the same transaction as the branch write.
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

    const { updatedBranch, vendorApproved } = await this.prisma.$transaction(
      async (tx) => {
        // Serializes concurrent decisions for the SAME vendor so the
        // "are all physical branches now approved" read below can't
        // race with another reviewer's concurrent approval of a
        // sibling branch (classic lost-update: both read the sibling
        // as still-pending before either commits, so neither promotes
        // the vendor even though both approvals together should have).
        // Different vendors never contend for this lock.
        await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;

        const updated = await tx.storeBranch.update({
          where: { id: branchId },
          data: {
            verificationStatus: nextStatus,
            reviewedBy: user.id,
            reviewedAt: new Date(),
            reviewNote:
              dto.decision === 'approve' ? null : (dto.reason ?? null),
          },
        });

        let approved = false;
        if (dto.decision === 'approve') {
          const vendor = await tx.vendor.findUniqueOrThrow({
            where: { id: vendorId },
          });
          const pendingPhysical = await tx.storeBranch.findFirst({
            where: {
              vendorId,
              isPhysical: true,
              verificationStatus: { not: 'APPROVED' },
            },
            select: { id: true },
          });
          if (
            !pendingPhysical &&
            (vendor.status === 'APPLIED' || vendor.status === 'UNDER_REVIEW')
          ) {
            await tx.vendor.update({
              where: { id: vendorId },
              data: { status: 'APPROVED' },
            });
            approved = true;
          }
        }

        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'store_branch.verification_decided',
            entityType: 'StoreBranch',
            entityId: updated.id,
            beforeState: branchToDto(branch),
            afterState: branchToDto(updated),
          },
          tx,
        );
        if (approved) {
          await this.auditLog.record(
            {
              actorId: user.id,
              correlationId: req.correlationId,
              action: 'vendor.approved',
              entityType: 'Vendor',
              entityId: vendorId,
              afterState: { status: 'APPROVED' },
            },
            tx,
          );
        }

        return { updatedBranch: updated, vendorApproved: approved };
      },
    );

    return { ...branchToDto(updatedBranch), vendor_approved: vendorApproved };
  }
}
