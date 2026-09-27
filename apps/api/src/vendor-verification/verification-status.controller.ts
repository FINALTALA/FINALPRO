import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { PrismaService } from '../prisma/prisma.service';

// Sprint 16 (D7): the OWNER's read of their own verification outcome -
// without it, a RESUBMISSION_REQUESTED or REJECTED decision's reason is
// visible to nobody but the reviewer, and the resubmission loop cannot
// work.
//
// Deliberately narrow, built from explicit fields (never spread from a
// row):
//  - per physical branch: status and the reviewer's reason - never
//    lat/lng/photo (the owner entered those themselves, and this view
//    is about the decision, not the evidence);
//  - for the warehouse: the latest snapshot's status/dates/reason -
//    never lat/lng/address_note (PDR-035: the warehouse address is
//    released to the platform reviewer only, inside the verification
//    path), and never the reviewer's identity;
//  - the current suspension (reason_code + reason), owner-only.
// OWNER only: a BRANCH_EMPLOYEE gets VENDOR_ROLE_FORBIDDEN.
@Controller('vendors/:vendorId/verification-status')
@UseGuards(SessionAuthGuard)
export class VerificationStatusController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(VendorMembershipGuard)
  @RequireVendorRole('OWNER')
  async get(@Param('vendorId') vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, legalName: true, storeType: true, status: true },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }

    const [branches, latestWarehouse, openSuspension] = await Promise.all([
      this.prisma.storeBranch.findMany({
        where: { vendorId, isPhysical: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          verificationStatus: true,
          evidenceRevision: true,
          evidenceSubmittedAt: true,
          reviewedAt: true,
          reviewNote: true,
        },
      }),
      this.prisma.warehouseVerificationEvidence.findFirst({
        where: { vendorId },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        select: {
          status: true,
          submittedAt: true,
          reviewedAt: true,
          reviewNote: true,
        },
      }),
      this.prisma.vendorSuspension.findFirst({
        where: { vendorId, reactivatedAt: null },
        select: { reasonCode: true, reason: true, suspendedAt: true },
      }),
    ]);

    return {
      vendor: {
        id: vendor.id,
        legal_name: vendor.legalName,
        store_type: vendor.storeType,
        status: vendor.status,
      },
      branches: branches.map((b) => ({
        id: b.id,
        name: b.name,
        status: b.verificationStatus,
        evidence_submitted: b.evidenceRevision >= 1,
        submitted_at: b.evidenceSubmittedAt?.toISOString() ?? null,
        reviewed_at: b.reviewedAt?.toISOString() ?? null,
        review_note: b.reviewNote,
      })),
      warehouse: latestWarehouse
        ? {
            status: latestWarehouse.status,
            submitted_at: latestWarehouse.submittedAt.toISOString(),
            reviewed_at: latestWarehouse.reviewedAt?.toISOString() ?? null,
            review_note: latestWarehouse.reviewNote,
          }
        : null,
      suspension: openSuspension
        ? {
            reason_code: openSuspension.reasonCode,
            reason: openSuspension.reason,
            suspended_at: openSuspension.suspendedAt.toISOString(),
          }
        : null,
    };
  }
}
