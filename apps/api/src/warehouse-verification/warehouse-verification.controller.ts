import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
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
import { PlatformRole, Prisma } from '../../generated/prisma/client';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { WarehouseVerificationDecisionDto } from './dto/warehouse-verification-decision.dto';

// Sprint 15 (PDR-035, OPEN-011 closed): the ONLINE_ONLY counterpart to
// VendorVerificationController's branch-evidence endpoints, but
// deliberately a separate controller/file rather than an extra method
// there - that controller's class-level route requires a :branchId
// param a warehouse has no equivalent of, and the two evidence models
// are intentionally shaped differently (see
// WarehouseVerificationEvidence's own schema comment: immutable
// snapshot rows here, vs. an in-place mutable status on StoreBranch).
//
// Full response shapes:
//  - submit (owner-facing ack): id, vendor_id, warehouse_id, lat, lng,
//    address_note, status, submitted_at - the owner already knows this
//    data, they just entered it.
//  - GET (reviewer-facing, before a decision): id, vendor_id,
//    warehouse_id, lat, lng, address_note, status, submitted_at only -
//    no reviewedBy/reviewedAt/reviewNote (always null on a PENDING
//    row regardless).
//  - decide (reviewer-facing, after a decision): the full row incl.
//    reviewed_by/reviewed_at/review_note, plus vendor_approved.
// None of these three shapes, and no other endpoint in this codebase,
// ever appears in vendorSummaryDto, the public storefront/discovery
// surface, or any employee-reachable response - see this file's own
// e2e coverage for the explicit negative checks.
function evidenceToDto(evidence: {
  id: string;
  vendorId: string;
  warehouseId: string;
  lat: number;
  lng: number;
  addressNote: string;
  status: string;
  submittedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
}) {
  return {
    id: evidence.id,
    vendor_id: evidence.vendorId,
    warehouse_id: evidence.warehouseId,
    lat: evidence.lat,
    lng: evidence.lng,
    address_note: evidence.addressNote,
    status: evidence.status,
    submitted_at: evidence.submittedAt.toISOString(),
    reviewed_by: evidence.reviewedBy,
    reviewed_at: evidence.reviewedAt?.toISOString() ?? null,
    review_note: evidence.reviewNote,
  };
}

// GET's own DTO is deliberately narrower than evidenceToDto above -
// see this file's class-level comment. Built explicitly rather than
// reusing evidenceToDto with fields stripped, so a future field added
// to evidenceToDto can never leak into the reviewer's pre-decision
// read by accident.
function pendingEvidenceToDto(evidence: {
  id: string;
  vendorId: string;
  warehouseId: string;
  lat: number;
  lng: number;
  addressNote: string;
  status: string;
  submittedAt: Date;
}) {
  return {
    id: evidence.id,
    vendor_id: evidence.vendorId,
    warehouse_id: evidence.warehouseId,
    lat: evidence.lat,
    lng: evidence.lng,
    address_note: evidence.addressNote,
    status: evidence.status,
    submitted_at: evidence.submittedAt.toISOString(),
  };
}

@Controller('vendors/:vendorId/warehouse')
@UseGuards(SessionAuthGuard)
export class WarehouseVerificationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  // PDR-035: the owner-only submission step. Requires storeType to
  // already be ONLINE_ONLY (PHYSICAL/HYBRID use the branch-evidence
  // path exclusively - see VendorsController.updateStoreType's
  // invariant for why the two are mutually exclusive by construction)
  // and the operational Warehouse to already have lat/lng/addressNote
  // set via PUT .../warehouse. Copies those three fields into a new
  // immutable snapshot row - never re-reads Warehouse again after this
  // moment for this row's lifetime.
  @Post('verification-evidence')
  @UseGuards(VendorMembershipGuard)
  @RequireVendorRole('OWNER')
  @UseInterceptors(IdempotencyInterceptor)
  async submitEvidence(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }
    if (vendor.storeType !== 'ONLINE_ONLY') {
      throw new BadRequestException({
        code: 'STORE_NOT_ONLINE_ONLY',
        message:
          'Warehouse verification only applies to an ONLINE_ONLY store - a PHYSICAL/HYBRID store verifies via its physical branch(es) (PDR-035)',
      });
    }

    const warehouse = await this.prisma.warehouse.findUnique({
      where: { vendorId },
    });
    if (
      !warehouse ||
      warehouse.lat === null ||
      warehouse.lng === null ||
      !warehouse.addressNote
    ) {
      throw new BadRequestException({
        code: 'WAREHOUSE_EVIDENCE_INCOMPLETE',
        message:
          'Set the warehouse lat/lng/address note via PUT .../warehouse before submitting verification evidence',
      });
    }

    // Fast, friendly, non-authoritative fail-fast - see the fresh
    // re-check under the vendor lock inside the transaction below,
    // which is authoritative, and the partial unique index (migration
    // SQL) which is the actual structural backstop regardless of
    // either check here.
    const existingPending =
      await this.prisma.warehouseVerificationEvidence.findFirst({
        where: { vendorId, status: 'PENDING' },
      });
    if (existingPending) {
      throw new ConflictException({
        code: 'WAREHOUSE_EVIDENCE_ALREADY_PENDING',
        message:
          'This vendor already has warehouse verification evidence awaiting review',
      });
    }

    let body;
    try {
      body = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;

        const freshVendor = await tx.vendor.findUniqueOrThrow({
          where: { id: vendorId },
        });
        if (
          freshVendor.status !== 'APPLIED' &&
          freshVendor.status !== 'UNDER_REVIEW'
        ) {
          throw new ConflictException({
            code: 'VENDOR_NOT_REVIEWABLE',
            message:
              'This vendor application has already been decided - evidence cannot be resubmitted to it. Submit a new, corrected application via POST /vendors instead (PDR-010)',
          });
        }

        const freshPending = await tx.warehouseVerificationEvidence.findFirst({
          where: { vendorId, status: 'PENDING' },
        });
        if (freshPending) {
          throw new ConflictException({
            code: 'WAREHOUSE_EVIDENCE_ALREADY_PENDING',
            message:
              'This vendor already has warehouse verification evidence awaiting review',
          });
        }

        const evidence = await tx.warehouseVerificationEvidence.create({
          data: {
            vendorId,
            warehouseId: warehouse.id,
            lat: warehouse.lat!,
            lng: warehouse.lng!,
            addressNote: warehouse.addressNote!,
          },
        });

        // Deliberately no lat/lng/addressNote in this AuditLog row -
        // see WarehouseVerificationEvidence's schema comment and this
        // file's own header comment. AuditLog is a broader-trust
        // surface than the guards on this controller's own endpoints.
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'warehouse_verification_evidence.submitted',
            entityType: 'WarehouseVerificationEvidence',
            entityId: evidence.id,
            afterState: {
              vendor_id: vendorId,
              warehouse_id: warehouse.id,
              status: 'PENDING',
            },
          },
          tx,
        );

        if (freshVendor.status === 'APPLIED') {
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

        const responseBody = evidenceToDto(evidence);
        await this.idempotencyCompletion.complete(
          tx,
          req.idempotencyClaimId,
          responseBody,
          201,
        );
        return responseBody;
      });
    } catch (err) {
      // Structural backstop: the partial unique index
      // (warehouseId_vendor_pending_key) rejects a second PENDING row
      // even if both application-level checks above raced past each
      // other - translated to the same 409 code a caller would get
      // from either of those checks, never a raw 500.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'WAREHOUSE_EVIDENCE_ALREADY_PENDING',
          message:
            'This vendor already has warehouse verification evidence awaiting review',
        });
      }
      throw err;
    }

    return body;
  }

  // PDR-035: reviewer-only, and the only place this evidence's
  // lat/lng/address_note are ever readable before a decision. No
  // VendorMembershipGuard - a platform reviewer is never a VendorUser
  // of the vendor they're reviewing, so that guard would always
  // (correctly) refuse them; PlatformRoleGuard is the sole gate.
  @Get('verification-evidence')
  @UseGuards(PlatformRoleGuard)
  @RequirePlatformRole(
    PlatformRole.VERIFICATION_REVIEWER,
    PlatformRole.PLATFORM_ADMIN,
  )
  async getPendingEvidence(@Param('vendorId') vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }

    const evidence = await this.prisma.warehouseVerificationEvidence.findFirst({
      where: { vendorId, status: 'PENDING' },
    });
    if (!evidence) {
      throw new NotFoundException({
        code: 'NO_PENDING_WAREHOUSE_EVIDENCE',
        message:
          'This vendor has no warehouse verification evidence awaiting review',
      });
    }
    return pendingEvidenceToDto(evidence);
  }

  // PDR-035: approve/reject/request_resubmission, bound to one exact
  // evidence_id (from the GET above) rather than implicitly "whichever
  // row is PENDING" - see WarehouseVerificationDecisionDto's own
  // comment for why. Vendor-lifecycle mapping: approve -> vendor
  // APPROVED directly (unlike the branch path, there is no "any other
  // pending physical branch?" loop - an ONLINE_ONLY vendor has exactly
  // one verification path); reject -> vendor REJECTED (same BR-026
  // "whole application" consequence as a branch rejection);
  // request_resubmission -> vendor stays UNDER_REVIEW, this row is
  // left RESUBMISSION_REQUESTED forever as a historical record, and a
  // brand-new row is what the owner submits next.
  @Post('verification-decision')
  @UseGuards(PlatformRoleGuard)
  @RequirePlatformRole(
    PlatformRole.VERIFICATION_REVIEWER,
    PlatformRole.PLATFORM_ADMIN,
  )
  @UseInterceptors(IdempotencyInterceptor)
  async decide(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WarehouseVerificationDecisionDto,
    @Req() req: Request,
  ) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }

    const nextStatus =
      dto.decision === 'approve'
        ? 'APPROVED'
        : dto.decision === 'reject'
          ? 'REJECTED'
          : 'RESUBMISSION_REQUESTED';

    const responseBody = await this.prisma.$transaction(async (tx) => {
      // Same vendor-row lock as VendorVerificationController.decide()
      // - serializes concurrent decisions for this vendor so two
      // reviewers can never both act on the same snapshot.
      await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;

      const freshVendor = await tx.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      if (freshVendor.status !== 'UNDER_REVIEW') {
        throw new ConflictException({
          code: 'VENDOR_NOT_UNDER_REVIEW',
          message:
            'This vendor has no warehouse evidence awaiting review (submit evidence first, or its application has already been decided)',
        });
      }

      const evidence = await tx.warehouseVerificationEvidence.findUnique({
        where: { id: dto.evidence_id },
      });
      // Bound to this exact snapshot (WarehouseVerificationDecisionDto's
      // own comment): wrong vendor, already-decided, or simply
      // nonexistent all collapse to the same "this isn't the row you
      // think it is" outcome for the caller.
      if (
        !evidence ||
        evidence.vendorId !== vendorId ||
        evidence.status !== 'PENDING'
      ) {
        throw new ConflictException({
          code: 'WAREHOUSE_EVIDENCE_STALE',
          message:
            'This evidence_id no longer refers to the current pending warehouse evidence for this vendor - re-read GET .../warehouse/verification-evidence',
        });
      }

      const updated = await tx.warehouseVerificationEvidence.update({
        where: { id: evidence.id },
        data: {
          status: nextStatus,
          reviewedBy: user.id,
          reviewedAt: new Date(),
          reviewNote: dto.decision === 'approve' ? null : (dto.reason ?? null),
        },
      });

      // Deliberately no lat/lng/addressNote/reviewNote content in this
      // AuditLog row - see this file's header comment.
      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'warehouse_verification_evidence.decided',
          entityType: 'WarehouseVerificationEvidence',
          entityId: evidence.id,
          beforeState: { status: 'PENDING' },
          afterState: { status: nextStatus, reviewed_by: user.id },
        },
        tx,
      );

      let vendorApproved = false;
      if (dto.decision === 'approve') {
        await tx.vendor.update({
          where: { id: vendorId },
          data: { status: 'APPROVED' },
        });
        vendorApproved = true;
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'vendor.approved',
            entityType: 'Vendor',
            entityId: vendorId,
            beforeState: { status: 'UNDER_REVIEW' },
            afterState: { status: 'APPROVED' },
          },
          tx,
        );
      } else if (dto.decision === 'reject') {
        await tx.vendor.update({
          where: { id: vendorId },
          data: { status: 'REJECTED' },
        });
        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'vendor.rejected',
            entityType: 'Vendor',
            entityId: vendorId,
            beforeState: { status: 'UNDER_REVIEW' },
            afterState: { status: 'REJECTED' },
          },
          tx,
        );
      }
      // request_resubmission: vendor stays UNDER_REVIEW, no vendor
      // audit row - mirrors VendorVerificationController.decide()'s
      // own "no vendor transition" case.

      const body = {
        ...evidenceToDto(updated),
        vendor_approved: vendorApproved,
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
